import { gybeSoundAllowed } from '../utils/gybeSound.mjs';
import windDataPolicy from '../../windDataPolicy.json';
import { freshAws, freshAwa, resolveTws, resolveTwa, resolveTwd, resolveWindBoatSpeed, resolveHeading, resolveVmg, freshBoatSpeed, freshDepth, resolveLeeway, maneuverValidity } from '../utils/windValidity.mjs';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AppConfig,
  HistoryPoint,
  AngleBufferItem,
  WindRadarSlot,
  FutureForecast,
  DisplayModeSog,
  DisplayModeTws,
  ActiveInstrument,
  GraphMode,
  BoxType,
  AppView,
  AisTarget,
  HarborCluster,
  PropulsionMode,
} from '../types';
import {
  radToDeg,
  degToRad,
  msToKts,
  ktsToMs,
  getShortestRotation,
  getCircularAverageFromBuffer,
  playBingBing,
  playGybeAlarm,
} from '../utils/math';
import { MARINA_DI_RAGUSA_SIM_DATA } from '../utils/marinaDiRagusaSimData';
import { generateRandomColregScenario, recalculateArpaForTargets } from '../utils/colregScenarioGenerator';
import { isThreatSnoozed, reconcileSnooze } from '../utils/aisSnooze.mjs';
import { MixedAisSimulation, mergeAisTargets } from '../utils/mixedAisSimulation.mjs';
import { BannerThreatSelector } from '../utils/aisPriority.mjs';
import { proximityAcknowledgementExpired, acknowledgeCurrentBubble, nearestBubblePresence } from '../utils/proximityAcknowledgement.mjs';
import { requestSharedAlertAction } from '../utils/sharedAlertRequest.mjs';
import { resetDashboardMeasurements, restoreDashboardHistory } from '../utils/dashboardMeasurements.mjs';
import { subscribeDashboardRecovery } from '../utils/dashboardRecovery.mjs';
import { isAnchoredNavigationState } from '../utils/navigationState.mjs';

interface SharedAlertSnapshot {
  sessionId: string;
  startedAt: number;
  revision: number;
  serverNow: number;
  banner: AisTarget | null;
  snoozeReadyAt: number | null;
  acknowledgements: Record<string, { id: string; lat: number; lon: number }>;
  snoozes: Record<string, { until: number; initialRisk: string; lostPositionTime?: number }>;
}

// Explicit opt-in keeps the simulator usable even with a reachable Signal K proxy.
const FORCE_SIMULATION = false;
const MIXED_SIMULATION = false;
const REQUIRE_LIVE_DATA = !FORCE_SIMULATION;

const DEFAULT_CONFIG: AppConfig = {
  alarms: { depthDanger: 2.5, depthWarning: 3.5 },
  averaging: {
    smoothWindow: 2000,
    longWindow: 30000,
    stabilityTolerance: 2000,
    stabilityThreshold: 0.95,
    minSpeed: 0.5,
    stabilityBreakout: 15,
  },
  graphs: { reef1: 15.0, reef2: 20.0, historyMinutes: 30, samples: 60 },
  scales: {
    stw: { stdMax: 12, step: 2, hercSpan: 4 },
    sog: { stdMax: 12, step: 2, hercSpan: 4 },
    tws: { stdMax: 25, step: 5, hercSpan: 10 },
    depth: { stdMax: 20, step: 10, hercSpan: 10 },
  },
  server: { fallbackIp: 'venus.local:3000' },
  aisAlerter: { vectorMinutes: 5 },
};

function safePush(buffer: AngleBufferItem[], val: number, time: number, isTwd = false, historyMinutes = 30) {
  if (val === null || val === undefined || isNaN(val)) return;

  buffer.push({
    val,
    time,
    sin: Math.sin(val),
    cos: Math.cos(val),
  });

  const limitMinutes = isTwd ? 60 : historyMinutes;
  const maxHistoryMs = limitMinutes * 60000 * 2 + 60000;

  while (buffer.length > 0 && time - buffer[0].time > maxHistoryMs) {
    buffer.shift();
  }
  if (buffer.length > 36000) buffer.shift();
}

function getInitialSavedDashState() {
  try {
    const saved = localStorage.getItem('rotevista_dash_state');
    if (saved) return JSON.parse(saved);
  } catch (e) {
    // Ignore error
  }
  return null;
}

export function useDashboard() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const savedState = getInitialSavedDashState();

  const [displayModeSog, setDisplayModeSog] = useState<DisplayModeSog>(
    () => savedState?.displayModeSog || 'SOG'
  );
  const [displayModeTws, setDisplayModeTws] = useState<DisplayModeTws>(
    () => savedState?.displayModeTws || 'TWS'
  );
  const [activeInstrument, setActiveInstrument] = useState<ActiveInstrument>(
    () => savedState?.activeInstrument || 'gauge'
  );
  const [isNightMode, setIsNightMode] = useState<boolean>(
    () => savedState?.isNightMode ?? false
  );
  const isNightModeRef = useRef<boolean>(isNightMode);
  isNightModeRef.current = isNightMode;

  const [propulsionMode, setPropulsionModeState] = useState<PropulsionMode>(
    () => 'AUTO'
  );
  const propulsionModeRef = useRef<PropulsionMode>(propulsionMode);
  useEffect(() => {
    propulsionModeRef.current = propulsionMode;
  }, [propulsionMode]);

  const propulsionPendingRef = useRef(false);
  const setPropulsionMode = useCallback(async (mode: PropulsionMode) => {
    if (propulsionPendingRef.current) return false;
    propulsionPendingRef.current = true;
    try {
      const access = await fetch('/rotevista-alert-session', {cache:'no-store', signal:AbortSignal.timeout(4000)});
      if (!access.ok) throw new Error('Propulsion controls unavailable.');
      const session = await access.json();
      const response = await fetch('/rotevista-propulsion-mode', {
        method:'POST', headers:{'Content-Type':'application/json','X-Rotevista-Alert-Key':session.token},
        body:JSON.stringify({mode,sessionId:session.sessionId}), signal:AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error('Could not change propulsion mode. Please try again.');
      // Apply only an authoritative frame; reject older in-flight polling responses.
      const frame = await response.json();
      const previous = sessionFrameRef.current;
      if (!previous || (previous.generation === frame.generation && previous.revision < frame.revision)) {
        propulsionModeRef.current = frame.propulsionMode;
        setPropulsionModeState(frame.propulsionMode);
        // Let the next poll apply the complete frame (including the same revision).
        if (previous) sessionFrameRef.current = {...previous, revision:frame.revision-1};
      }
      return true;
    } catch (error) {
      setAlertActionError(error instanceof Error ? error.message : 'Could not change propulsion mode.');
      return false;
    } finally { propulsionPendingRef.current = false; }
  }, []);
  const [isFocusActive, setIsFocusActive] = useState<boolean>(false);
  const [focusedBox, setFocusedBox] = useState<BoxType | null>(null);
  const [graphModes, setGraphModes] = useState<Record<string, GraphMode>>(
    () => savedState?.graphModes || {
      stw: 'standard',
      sog: 'standard',
      tws: 'standard',
      depth: 'standard',
    }
  );

  const [connectionStatus, setConnectionStatus] = useState<{ text: string; className: string }>({
    text: 'CONNESSIONE...',
    className: 'offline',
  });

  // AIS View & ARPA Collision States
  const [appView, setAppView] = useState<AppView>(
    () => savedState?.appView || 'wind'
  );
  const appViewRef = useRef<AppView>(appView);
  appViewRef.current = appView;

  const [aisTargets, setAisTargets] = useState<AisTarget[]>([]);
  const [harborClusters, setHarborClusters] = useState<HarborCluster[]>([]);
  const [topThreat, setTopThreat] = useState<AisTarget | null>(null);
  const [selectedAisTargetId, setSelectedAisTargetId] = useState<string | null>(null);
  const [dashboardMode, setDashboardMode] = useState<'live' | 'simulation' | 'mixed'>('live');
  const [dashboardEnvironment, setDashboardEnvironment] = useState('signalk');
  const sharedSessionManagedRef = useRef(false);
  const sharedSessionModeRef = useRef('live');
  const sharedEnvironmentRef = useRef('signalk');
  const applyingSessionRef = useRef(false);
  const sessionConnectedRef = useRef(false);
  const sessionRawTimesRef = useRef<Record<string, {time: number; value: string}>>({});
  const sessionFrameRef = useRef<{ generation: string; revision: number } | null>(null);
  const [sharedAlerts, setSharedAlerts] = useState<SharedAlertSnapshot | null>(null);
  const sharedAlertsRef = useRef<SharedAlertSnapshot | null>(null);
  const sharedReadyDeadlineRef = useRef(0);
  const [sharedSnoozeReady, setSharedSnoozeReady] = useState(false);
  const [alertActionError, setAlertActionError] = useState('');
  const [alertActionPending, setAlertActionPending] = useState(false);
  const alertActionPendingRef = useRef(false);
  const receiveSharedAlerts = useCallback((snapshot: SharedAlertSnapshot, fromSession = false) => {
    if (sharedSessionManagedRef.current && !fromSession) return;
    if (FORCE_SIMULATION || MIXED_SIMULATION || !snapshot?.sessionId || !Number.isFinite(snapshot.revision)) return;
    const previous = sharedAlertsRef.current;
    if (previous && (snapshot.startedAt < previous.startedAt ||
        (snapshot.sessionId === previous.sessionId && snapshot.revision <= previous.revision))) return;
    sharedAlertsRef.current = snapshot;
    sharedReadyDeadlineRef.current = Date.now() + Math.max(0, (snapshot.snoozeReadyAt ?? snapshot.serverNow) - snapshot.serverNow);
    setSharedSnoozeReady(snapshot.snoozeReadyAt !== null && snapshot.snoozeReadyAt <= snapshot.serverNow);
    setSharedAlerts(snapshot);
  }, []);
  useEffect(() => {
    if (!sharedAlerts || sharedAlerts.snoozeReadyAt === null) return;
    const timer = setTimeout(() => setSharedSnoozeReady(true), Math.max(0, sharedReadyDeadlineRef.current - Date.now()));
    return () => clearTimeout(timer);
  }, [sharedAlerts]);
  const sharedAction = useCallback(async (type: string, target?: AisTarget) => {
    const state = sharedAlertsRef.current;
    if (!state || alertActionPendingRef.current) return false;
    alertActionPendingRef.current = true;
    setAlertActionPending(true);
    setAlertActionError('');
    try {
      const result = await requestSharedAlertAction({type,target,state});
      if (sharedAlertsRef.current?.sessionId === state.sessionId) receiveSharedAlerts(result, true);
      return true;
    } catch (error) {
      setAlertActionError(error instanceof Error ? error.message : 'Alert action failed.');
      return false;
    } finally {
      alertActionPendingRef.current = false;
      setAlertActionPending(false);
    }
  }, [receiveSharedAlerts]);

  const [snoozedThreats, setSnoozedThreats] = useState<Record<string, { until: number; initialRisk: string; lostPositionTime?: number }>>({});
  const [proximityAcknowledgements, setProximityAcknowledgements] = useState<Record<string, { id: string; lat: number; lon: number }>>({});
  const [ownShipPosition, setOwnShipPosition] = useState<{ lat: number; lon: number }>({ lat: 36.780956, lon: 14.545439 });
  const [ownShipCourse, setOwnShipCourse] = useState<{ hdg: number; cog: number; sog: number }>({ hdg: 45, cog: 45, sog: 0.0 });

  const latestAisRef = useRef<{
    targets: AisTarget[];
    clusters: HarborCluster[];
    pos: { lat: number; lon: number };
    highestRisk: 'RED' | 'ORANGE' | null;
  }>({
    targets: [],
    clusters: [],
    pos: { lat: 36.780956, lon: 14.545439 },
    highestRisk: null,
  });

  useEffect(() => {
    if (appView === 'ais') {
      setOwnShipPosition(latestAisRef.current.pos);
      setAisTargets(latestAisRef.current.targets);
      setHarborClusters(latestAisRef.current.clusters);
    }
  }, [appView]);

  const snoozeThreat = useCallback(async (targetId: string) => {
    const target = latestAisRef.current.targets.find(t => t.id === targetId);
    if (sharedAlertsRef.current) {
      const shown = target || sharedAlertsRef.current.banner;
      if (!shown || shown.id !== targetId) return false;
      return sharedAction(shown.alertKind === 'PROXIMITY' ? 'acknowledge' : 'snooze', shown);
    }
    if (!FORCE_SIMULATION && !MIXED_SIMULATION) {
      setAlertActionError('Shared alert service is not ready. Reconnect or update the server plugin.');
      return false;
    }
    if (target?.alertKind === 'PROXIMITY' && target.areaProximityOnly && !target.isMoving) {
      const current = acknowledgeCurrentBubble(latestAisRef.current.targets);
      setProximityAcknowledgements(prev => ({ ...prev, ...current }));
      return true;
    }
    setTopThreat(currentTop => {
      const initialRisk = target?.risk || (currentTop?.id === targetId ? currentTop.risk : 'ORANGE');
      setSnoozedThreats(prev => ({
        ...prev,
        [targetId]: { until: Date.now() + 10 * 60 * 1000, initialRisk,
          ...(target?.contactLost ? { lostPositionTime: target.lastPositionTime } : {}) },
      }));
      return currentTop;
    });
    return true;
  }, [sharedAction]);

  const unsnoozeThreats = useCallback(() => {
    if (sharedAlertsRef.current) { void sharedAction('reopen'); return; }
    if (!FORCE_SIMULATION && !MIXED_SIMULATION) return;
    setSnoozedThreats({});
    setProximityAcknowledgements({});
  }, [sharedAction]);

  const bannerSelectorRef = useRef(new BannerThreatSelector());
  const [bannerSelectionTick, setBannerSelectionTick] = useState(0);
  const activeThreat = useMemo(() => {
    if (sharedAlerts) return sharedAlerts.banner;
    const candidates: AisTarget[] = [];
    const seen = new Set<string>();
    const isHarborTarget = (t: AisTarget) => Boolean(t.areaProximityOnly && t.alertKind !== 'PROXIMITY');
    if (
      topThreat &&
      (topThreat.risk === 'RED' || topThreat.risk === 'ORANGE') &&
      !isHarborTarget(topThreat)
    ) {
      candidates.push(topThreat);
      seen.add(topThreat.id);
    }
    aisTargets.forEach(t => {
      if (!seen.has(t.id) && (t.risk === 'RED' || t.risk === 'ORANGE') && !isHarborTarget(t)) {
        candidates.push(t);
        seen.add(t.id);
      }
    });
    const now = Date.now();
    const valid = candidates.filter(t => {
      if (t.alertKind === 'PROXIMITY' && (t.proximityEntryObserved === false || proximityAcknowledgements[t.id])) return false;
      return !isThreatSnoozed(t, snoozedThreats[t.id], now);
    });
    const nearest = nearestBubblePresence(valid);
    const bannerCandidates = valid.filter(t => t.alertKind !== 'PROXIMITY' || t.id === nearest?.id);
    return bannerSelectorRef.current.select(bannerCandidates, now);
  }, [topThreat, aisTargets, snoozedThreats, proximityAcknowledgements, bannerSelectionTick, sharedAlerts]);
  const priorityDeadline = bannerSelectorRef.current.pendingDeadline;
  useEffect(() => {
    if (priorityDeadline === null) return;
    const timer = setTimeout(() => setBannerSelectionTick(value => value + 1), Math.max(0, priorityDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [priorityDeadline]);

  useEffect(() => {
    setProximityAcknowledgements(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [id, area] of Object.entries(prev)) {
        const target = latestAisRef.current.targets.find(t => t.id === id);
        const ownPosition = storeRef.current.timestamps['navigation.position'] ? latestAisRef.current.pos : null;
        if (proximityAcknowledgementExpired(area, target, ownPosition)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [aisTargets]);
  const displayedAisTargets = useMemo(() => aisTargets.map(t =>
    t.areaProximityOnly && !t.isMoving && (sharedAlerts ? sharedAlerts.acknowledgements[t.id] : proximityAcknowledgements[t.id])
      ? { ...t, risk: 'GREY' as const, riskMsg: '', proximityAcknowledged: true } : t
  ), [aisTargets, proximityAcknowledgements, sharedAlerts]);

  useEffect(() => {
    setSnoozedThreats(prev => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      const allTargets = latestAisRef.current.targets;

      ids.forEach(id => {
        const entry = next[id];
        const t = (topThreat && topThreat.id === id ? topThreat : null) || allTargets.find(item => item.id === id);
        const updated = reconcileSnooze(t, entry, Date.now());
        if (!updated) {
          delete next[id];
          changed = true;
        } else if (updated !== entry) {
          next[id] = updated;
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [topThreat, aisTargets]);

  // Display values for UI
  const [displayValues, setDisplayValues] = useState({
    stw: '--.-',
    sog: '--.-',
    sogColor: '',
    hdg: '000°',
    hdgUnstable: false,
    cog: '000°',
    cogUnstable: false,
    depth: '--.-',
    depthAlarmClass: '',
    tws: '--.-',
    twsColor: '',
    awsSvg: '--.-',
    twaAvg: '---°',
    twaUnstable: false,
    awaAvg: '---°',
    awaUnstable: false,
    twdAvg: '---°',
    twdUnstable: false,
    tackHdg: '---°',
    tackHdgUnstable: false,
    tackCog: '---°',
    tackCogUnstable: false,
    tackLabel: 'TACK',
    leewayDeg: null as number | null,
    trackRotDeg: 0,
    awaPointerDeg: 0,
    twaPointerDeg: 0,
    windCompassRotDeg: 0,
    boatCompassRotDeg: 0,
    tacticCwDot: { active: false, color: '#bbb', gybing: false },
    tacticCcwDot: { active: false, color: '#bbb', gybing: false },
    compassCwDot: { active: false, color: '#bbb', blinking: false } as { active: boolean; color: string; blinking?: boolean },
    compassCcwDot: { active: false, color: '#bbb', blinking: false } as { active: boolean; color: string; blinking?: boolean },
    twdShiftText: '--',
    twdShiftColor: '#888',
    meteoLed: null as { active: boolean; color: string; angleTarget: number } | null,
    isNavigating: false,
  });

  // Histories for sparklines & radar
  const [historiesState, setHistoriesState] = useState<{
    stw: HistoryPoint[];
    sog: HistoryPoint[];
    vmg: HistoryPoint[];
    depth: HistoryPoint[];
    tws: HistoryPoint[];
    aws: HistoryPoint[];
    twd: HistoryPoint[];
  }>({
    stw: [],
    sog: [],
    vmg: [],
    depth: [],
    tws: [],
    aws: [],
    twd: [],
  });

  const [windRadarSlots, setWindRadarSlots] = useState<WindRadarSlot[]>([]);
  const [futureForecast, setFutureForecast] = useState<FutureForecast | null>(null);

  // Internal mutable store
  const storeRef = useRef({
    raw: {} as Record<string, any>,
    timestamps: {} as Record<string, number>,
    smoothBuf: {
      hdg: [] as AngleBufferItem[],
      cog: [] as AngleBufferItem[],
      awa: [] as AngleBufferItem[],
      twa: [] as AngleBufferItem[],
      twd: [] as AngleBufferItem[],
    },
    longBuf: {
      hdg: [] as AngleBufferItem[],
      cog: [] as AngleBufferItem[],
      awa: [] as AngleBufferItem[],
      twa: [] as AngleBufferItem[],
      twd: [] as AngleBufferItem[],
    },
    histories: {
      stw: [] as HistoryPoint[],
      sog: [] as HistoryPoint[],
      vmg: [] as HistoryPoint[],
      depth: [] as HistoryPoint[],
      tws: [] as HistoryPoint[],
      aws: [] as HistoryPoint[],
      twd: [] as HistoryPoint[],
    },
    gustFilter: {} as Partial<Record<'aws' | 'tws', { val: number; time: number }>>,
    graphTempBuf: {
      stw: [] as Array<{ val: number; time: number }>,
      sog: [] as Array<{ val: number; time: number }>,
      vmg: [] as Array<{ val: number; time: number }>,
      depth: [] as Array<{ val: number; time: number }>,
      tws: [] as Array<{ val: number; time: number }>,
      aws: [] as Array<{ val: number; time: number }>,
      twd: [] as Array<{ val: number; time: number }>,
    },
    lastUpdates: { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0, twd: 0 },
    lastMessageReceivedTime: Date.now(),
    curAwaRot: 0,
    curTwaRot: 0,
    curTrackRot: 0,
    curWindCompassRot: 0,
    curBoatCompassRot: 0,
    smoothedLeeway: 0,
    lastGybeAlarmTime: 0,
    lastGybeSide: null as 'starboard' | 'port' | null,
    emaTwaSin: 0,
    emaTwaCos: 0,
    firstEmaRun: true,
    lastTWCompute: 0,
    currentTackLabelMode: 'TACK',
    isSocketOpen: false,
    isSimulating: false,
    hasEverConnectedToSignalK: false,
  });

  const historyInputTimesRef = useRef<Record<string, number>>({});

  // Manage history insertion
  const manageHistory = useCallback((type: keyof typeof storeRef.current.histories, value: number) => {
    if (value === undefined || value === null || !isFinite(value)) return;
    const store = storeRef.current;
    const now = Date.now();
    const historyMinutes = Math.max(1, configRef.current.graphs.historyMinutes || 10);
    const samples = Math.max(2, configRef.current.graphs.samples || 60);
    const bucketIntervalMs = (historyMinutes * 60000) / samples;

    if (!store.graphTempBuf[type]) store.graphTempBuf[type] = [];
    if (!store.histories[type]) store.histories[type] = [];

    if (store.lastUpdates[type] === undefined || store.lastUpdates[type] === 0) {
      store.lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
    }

    const lastInput = historyInputTimesRef.current[type];
    const gapBefore = Number.isFinite(lastInput) && now - lastInput >= 15000;
    historyInputTimesRef.current[type] = now;
    if (gapBefore) store.graphTempBuf[type] = [];
    const tempBuf = store.graphTempBuf[type];
    tempBuf.push({ val: value, time: now });

    const bucketReady = gapBefore || (now - store.lastUpdates[type] > bucketIntervalMs) || store.histories[type].length === 0;
    if (!bucketReady) return;

    let finalValue = value;
    if (tempBuf.length > 0) {
      if (type === 'tws' || type === 'aws') {
        let state = store.gustFilter[type];
        let maxSustained = -Infinity;
        for (const point of tempBuf) {
          const dt = state ? point.time - state.time : 0;
          if (!state || dt < 0 || dt >= windDataPolicy.gustResetGapMs) {
            state = { val: point.val, time: point.time };
            maxSustained = point.val;
          } else {
            const alpha = 1 - Math.exp(-dt / windDataPolicy.gustSmoothingMs);
            state = { val: state.val + alpha * (point.val - state.val), time: point.time };
          }
          maxSustained = Math.max(maxSustained, state.val);
        }
        store.gustFilter[type] = state;
        finalValue = maxSustained;
      } else if (type === 'depth') {
        let minVal = Infinity;
        for (let i = 0; i < tempBuf.length; i++) {
          if (isFinite(tempBuf[i].val) && tempBuf[i].val < minVal) {
            minVal = tempBuf[i].val;
          }
        }
        if (minVal !== Infinity) finalValue = minVal;
      } else {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < tempBuf.length; i++) {
          if (isFinite(tempBuf[i].val)) {
            sum += tempBuf[i].val;
            count++;
          }
        }
        if (count > 0) finalValue = sum / count;
      }
    }

    if (!isFinite(finalValue)) return;
    finalValue = Math.max(0, finalValue);

    store.histories[type].push({ val: finalValue, time: now, ...(gapBefore ? { gapBefore: true } : {}) });

    const maxViewportMinutes = historyMinutes * 2;
    const maxHistoryMs = maxViewportMinutes * 60000 + 60000;
    while (store.histories[type].length > 0 && now - store.histories[type][0].time > maxHistoryMs) {
      store.histories[type].shift();
    }

    store.graphTempBuf[type] = [];
    store.lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
  }, []);

  // Process incoming data
  const realAisTargetsRef = useRef<AisTarget[]>([]);
  const simulatedAisTargetsRef = useRef<AisTarget[]>([]);
  const processIncomingData = useCallback((path: string, val: any, timeMs?: number) => {
    if (sharedSessionManagedRef.current && !applyingSessionRef.current) {
      if (path.startsWith('environment.ais_') || path === 'environment.harbor_clusters') return;
      if (sharedSessionModeRef.current === 'simulation' && (path.startsWith('navigation.') || path.startsWith('environment.wind.') || path.startsWith('environment.depth.'))) return;
    }
    if (path === 'environment.depth.belowTransducer') {
      if (Number.isFinite(timeMs) && timeMs! < (storeRef.current.timestamps[path] ?? -Infinity)) return;
      if (val === null) {
        delete storeRef.current.raw[path];
        storeRef.current.timestamps[path] = Number.isFinite(timeMs) ? Math.min(Date.now(), timeMs!) : Date.now();
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || val < -2 || val > 500) return;
    }
    if (path === 'navigation.speedThroughWater' || path === 'navigation.speedOverGround') {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 25.72) return;
      if (Number.isFinite(timeMs) && timeMs! <= (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if (['navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue'].includes(path)) {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
      if (Number.isFinite(timeMs) && timeMs! < (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if (path === 'environment.wind.speedTrue') {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 51.44) return;
      if (Number.isFinite(timeMs) && timeMs! < (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if (path === 'environment.wind.directionTrue') {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        // Preserve averages: a valid reconstructed TWD may still be available.
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
      if (Number.isFinite(timeMs) && timeMs! <= (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if (path === 'environment.wind.angleTrueWater') {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        storeRef.current.smoothBuf.twa = [];
        storeRef.current.longBuf.twa = [];
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
      if (Number.isFinite(timeMs) && timeMs! <= (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if (path === 'environment.wind.angleApparent') {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        storeRef.current.smoothBuf.awa = [];
        storeRef.current.longBuf.awa = [];
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
      if (Number.isFinite(timeMs) && timeMs! <= (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if (path === 'environment.wind.speedApparent') {
      if (val === null) {
        delete storeRef.current.raw[path];
        delete storeRef.current.timestamps[path];
        return;
      }
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 51.44) return;
      if (Number.isFinite(timeMs) && timeMs! < (storeRef.current.timestamps[path] ?? -Infinity)) return;
    }
    if ((val === null && path !== 'environment.ais_top_threat' && path !== 'navigation.state') || val === undefined || (typeof val === 'number' && isNaN(val))) return;

    if ((path === 'environment.wind.speedApparent' || path === 'environment.wind.speedTrue') && val > 51.44) return;
    if ((path === 'navigation.speedThroughWater' || path === 'navigation.speedOverGround') && val > 25.72) return;
    if (path === 'environment.depth.belowTransducer' && (val < -2.0 || val > 500)) return;

    const store = storeRef.current;
    const now = Number.isFinite(timeMs) ? timeMs! : Date.now();
    const localNow = Date.now();

    const syntheticUpdate = path === 'simulation.ais_targets';
    if (!syntheticUpdate) {
      store.timestamps[path] = applyingSessionRef.current || path === 'environment.wind.speedApparent' || path === 'environment.wind.angleApparent' || path === 'environment.wind.speedTrue' || path === 'environment.wind.angleTrueWater' || path === 'environment.wind.directionTrue' || path === 'navigation.headingTrue' || path === 'navigation.speedThroughWater' || path === 'navigation.speedOverGround' || path === 'navigation.headingMagnetic' || path === 'navigation.courseOverGroundTrue' || path === 'environment.depth.belowTransducer' ? Math.min(localNow, now) : localNow;
      store.raw[path] = val;
      store.lastMessageReceivedTime = localNow;
    }

    const historyMinutes = configRef.current.graphs.historyMinutes;

    if (path === 'environment.wind.angleTrueWater' && freshAwa(val, now, localNow, windDataPolicy.twaNativeMaxAgeMs) !== null) {
      safePush(store.smoothBuf.twa, val, now, true, historyMinutes);
      safePush(store.longBuf.twa, val, now, true, historyMinutes);
    }

    // AWA samples come only from received AWA, independently of true-wind computation.
    if (path === 'environment.wind.angleApparent' && freshAwa(val, now, localNow, windDataPolicy.awaMaxAgeMs) !== null) {
      safePush(store.smoothBuf.awa, val, now, true, historyMinutes);
      safePush(store.longBuf.awa, val, now, true, historyMinutes);
    }


    if (['navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue'].includes(path)) {
      const heading = resolveHeading(store.raw, store.timestamps, localNow, windDataPolicy);
      if (heading !== null) {
        safePush(store.smoothBuf.hdg, heading, now, false, historyMinutes);
        safePush(store.longBuf.hdg, heading, now, false, historyMinutes);
      }
    }
    if (path === 'navigation.courseOverGroundTrue') {
      safePush(store.smoothBuf.cog, val, now, false, historyMinutes);
      safePush(store.longBuf.cog, val, now, false, historyMinutes);
    }

    // Compute true wind if necessary
    const twPaths = [
      'environment.wind.directionTrue',
      'navigation.position',
      'environment.wind.angleTrueWater',
      'navigation.headingMagnetic',
      'environment.wind.speedApparent',
      'environment.wind.angleApparent',
      'navigation.speedThroughWater',
      'navigation.speedOverGround',
      'navigation.headingTrue',
      'navigation.courseOverGroundTrue',
    ];

    if (twPaths.includes(path)) {
      if (now - store.lastTWCompute > 100) {
        const aws = freshAws(store.raw['environment.wind.speedApparent'], store.timestamps['environment.wind.speedApparent'], localNow, windDataPolicy.awsMaxAgeMs);
        const awa = freshAwa(store.raw['environment.wind.angleApparent'], store.timestamps['environment.wind.angleApparent'], localNow, windDataPolicy.awaMaxAgeMs);

        if (aws !== null && awa !== null) {
          const twa = resolveTwa(store.raw, store.timestamps, localNow, windDataPolicy);
          const hasNativeTwa = freshAwa(store.raw['environment.wind.angleTrueWater'], store.timestamps['environment.wind.angleTrueWater'], localNow, windDataPolicy.twaNativeMaxAgeMs) !== null;
          if (twa !== null && !hasNativeTwa) {
            safePush(store.smoothBuf.twa, twa, now, true, historyMinutes);
            safePush(store.longBuf.twa, twa, now, true, historyMinutes);
          }

        }
        const twd = resolveTwd(store.raw, store.timestamps, localNow, windDataPolicy);
        if (twd !== null) {
          safePush(store.smoothBuf.twd, twd, now, true, historyMinutes);
          safePush(store.longBuf.twd, twd, now, true, historyMinutes);
          const lastTwdPt = store.histories.twd[store.histories.twd.length - 1];
          if (!lastTwdPt || now - lastTwdPt.time >= 10000) store.histories.twd.push({ val: twd, time: now });
          while (store.histories.twd.length && now - store.histories.twd[0].time > 120 * 60000) store.histories.twd.shift();
        }
        store.lastTWCompute = now;
      }
    }

    // Navigation Position & AIS updates
    if (path === 'navigation.position') {
      if (val && typeof val === 'object' && val.latitude !== undefined && val.longitude !== undefined) {
        const lat = parseFloat(val.latitude);
        const lon = parseFloat(val.longitude);
        if (!isNaN(lat) && !isNaN(lon)) {
          const prevPos = latestAisRef.current.pos;
          if (Math.abs(prevPos.lat - lat) > 0.000005 || Math.abs(prevPos.lon - lon) > 0.000005) {
            const nextPos = { lat, lon };
            latestAisRef.current.pos = nextPos;
            if (appViewRef.current === 'ais') {
              setOwnShipPosition(nextPos);
            }
          }
        }
      }
    }

    if (path === 'environment.ais_shared_alerts') { receiveSharedAlerts(val); return; }

    if (path === 'environment.ais_targets' || syntheticUpdate) {
      if (Array.isArray(val)) {
        if (MIXED_SIMULATION) {
          if (syntheticUpdate) simulatedAisTargetsRef.current = val;
          else realAisTargetsRef.current = val;
          val = mergeAisTargets(realAisTargetsRef.current, simulatedAisTargetsRef.current);
        }
        latestAisRef.current.targets = val;
        const nextRisk: 'RED' | 'ORANGE' | null = val.some((t: AisTarget) => t.risk === 'RED')
          ? 'RED'
          : val.some((t: AisTarget) => t.risk === 'ORANGE')
            ? 'ORANGE'
            : null;
        if (nextRisk === null) {
          setTopThreat(prev => (prev !== null ? null : prev));
        }
        if (appViewRef.current === 'ais' || nextRisk !== latestAisRef.current.highestRisk || nextRisk !== null) {
          latestAisRef.current.highestRisk = nextRisk;
          setAisTargets(val);
        }
      }
    }

    if (path === 'environment.ais_top_threat') {
      const nextThreat: AisTarget | null = val || null;
      setTopThreat(prev => {
        if (!prev && !nextThreat) return prev;
        if (
          prev &&
          nextThreat &&
          prev.id === nextThreat.id &&
          prev.risk === nextThreat.risk &&
          prev.cpa === nextThreat.cpa &&
          prev.tcpa === nextThreat.tcpa &&
          prev.dist === nextThreat.dist &&
          prev.sog === nextThreat.sog &&
          prev.age === nextThreat.age &&
          prev.lastPositionTime === nextThreat.lastPositionTime &&
          prev.isProjected === nextThreat.isProjected &&
          prev.contactLost === nextThreat.contactLost &&
          prev.contactLostAt === nextThreat.contactLostAt &&
          prev.motionDataSync?.status === nextThreat.motionDataSync?.status &&
          prev.alertKind === nextThreat.alertKind &&
          prev.areaProximityOnly === nextThreat.areaProximityOnly &&
          prev.currentHullClearanceMeters === nextThreat.currentHullClearanceMeters &&
          prev.effectiveThresholds?.horizonTcpa === nextThreat.effectiveThresholds?.horizonTcpa
        ) {
          return prev;
        }
        return nextThreat;
      });
    }

    if (path === 'environment.harbor_clusters') {
      if (Array.isArray(val)) {
        latestAisRef.current.clusters = val;
        if (appViewRef.current === 'ais') {
          setHarborClusters(val);
        }
      }
    }

    if (path === 'environment.rotevista_config' && val && typeof val === 'object') {
      setConfig(prev => ({
        ...prev,
        ...val,
        alarms: { ...prev.alarms, ...(val.alarms || {}) },
        graphs: { ...prev.graphs, ...(val.graphs || {}) },
        averaging: { ...prev.averaging, ...(val.averaging || {}) },
        scales: { ...prev.scales, ...(val.scales || {}) },
        aisAlerter: { ...prev.aisAlerter, ...(val.aisAlerter || {}) },
      }));
    }
  }, []);

  const fetchConfig = useCallback(() => {
    fetch(FORCE_SIMULATION ? '/settings.json' : '/rotevista-config', { cache: 'no-store' })
      .then(async res => {
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok || !contentType.includes('application/json')) throw new Error('Not available');
        const json = await res.json();
        if (!FORCE_SIMULATION) storeRef.current.hasEverConnectedToSignalK = true;
        return json;
      })
      .catch(() => {
        return fetch('/settings.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
      })
      .then(data => {
        if (data) {
          setConfig(prev => ({
            ...prev,
            ...data,
            alarms: { ...prev.alarms, ...(data.alarms || {}) },
            graphs: { ...prev.graphs, ...(data.graphs || {}) },
            averaging: { ...prev.averaging, ...(data.averaging || {}) },
            scales: { ...prev.scales, ...(data.scales || {}) },
            aisAlerter: { ...prev.aisAlerter, ...(data.aisAlerter || {}) },
          }));
        }
      })
      .catch(() => {});
  }, []);

  // Load configuration from Signal K plugin or settings.json
  useEffect(() => {
    fetchConfig();
    const configInterval = setInterval(fetchConfig, 10000);
    return () => clearInterval(configInterval);
  }, [fetchConfig]);

  // Save layout state to localStorage on changes
  useEffect(() => {
    try {
      const state = {
        displayModeSog,
        displayModeTws,
        activeInstrument,
        graphModes,
        isNightMode,
        appView,
      };
      localStorage.setItem('rotevista_dash_state', JSON.stringify(state));
    } catch (e) {
      // Ignore
    }
  }, [displayModeSog, displayModeTws, activeInstrument, graphModes, isNightMode, appView]);

  // Sync Night Mode class with body
  useEffect(() => {
    if (isNightMode) {
      document.body.classList.add('night-mode');
    } else {
      document.body.classList.remove('night-mode');
    }
  }, [isNightMode]);

  // Helper per la modalità dimostrativa/simulazione (eseguito solo se Signal K è assente)
  const seedDemoHistory = useCallback((now: number, historyMinutes: number) => {
    const store = storeRef.current;
    const stepMs = (historyMinutes * 60000) / 60;
    const baseHdg = 45;
    const baseTws = 12;
    const baseTwd = 90;
    const baseDepth = 12;
    const baseStw = 5.2;

    for (let i = 60; i >= 0; i--) {
      const t = now - i * stepMs;
      const twsNoise = Math.sin(i * 0.45) * 1.8 + Math.cos(i * 0.9) * 0.9 + Math.sin(i * 1.7) * 0.6;
      const twsVal = Math.max(7.0, baseTws + twsNoise);
      const twdShift = Math.sin(i * 0.3) * 5.5 + Math.cos(i * 0.75) * 2.5;
      const twdDegVal = (baseTwd + twdShift + 360) % 360;
      const twdVal = degToRad(twdDegVal);
      const hdgShift = twdShift * 0.7 + Math.sin(i * 1.2) * 1.8;
      const hdgDegVal = (baseHdg + hdgShift + 360) % 360;
      const hdgVal = degToRad(hdgDegVal);
      const twaDegVal = Math.max(38, Math.min(52, (twdDegVal - hdgDegVal + 360) % 360));
      const twaRad = degToRad(twaDegVal);
      const waveChop = Math.sin(i * 1.5) * 0.35 + Math.cos(i * 2.8) * 0.25;
      const windDrive = (twsVal - 12.0) * 0.22;
      const stwVal = Math.max(3.5, baseStw + windDrive + waveChop);
      const sogVal = Math.max(3.8, stwVal + 0.25 + Math.sin(i * 0.8) * 0.15);
      const vmgVal = Math.max(2.2, sogVal * Math.cos(twaRad));
      const tw_x = twsVal * Math.cos(twaRad);
      const tw_y = twsVal * Math.sin(twaRad);
      const aw_x = tw_x + stwVal;
      const aw_y = tw_y;
      const awsVal = Math.sqrt(aw_x * aw_x + aw_y * aw_y);
      const awaVal = Math.atan2(aw_y, aw_x);
      const depthVal = Math.max(4.0, baseDepth + Math.sin(i * 0.25) * 3.5 + Math.cos(i * 0.6) * 1.2);

      store.histories.stw.push({ val: parseFloat(stwVal.toFixed(2)), time: t });
      store.histories.sog.push({ val: parseFloat(sogVal.toFixed(2)), time: t });
      store.histories.vmg.push({ val: parseFloat(vmgVal.toFixed(2)), time: t });
      store.histories.tws.push({ val: parseFloat(twsVal.toFixed(2)), time: t });
      store.histories.aws.push({ val: parseFloat(awsVal.toFixed(2)), time: t });
      store.histories.depth.push({ val: parseFloat(depthVal.toFixed(2)), time: t });
      store.histories.twd.push({ val: twdVal, time: t });

      safePush(store.longBuf.twd, twdVal, t, true, historyMinutes);
      safePush(store.smoothBuf.twd, twdVal, t, true, historyMinutes);
      safePush(store.longBuf.hdg, hdgVal, t, false, historyMinutes);
      const leewayDegSeed = Math.sin(twaRad) * 2.8;
      const cogDegVal = (hdgDegVal - leewayDegSeed + 360) % 360;
      safePush(store.longBuf.cog, degToRad(cogDegVal), t, false, historyMinutes);
      safePush(store.smoothBuf.cog, degToRad(cogDegVal), t, false, historyMinutes);
      safePush(store.longBuf.twa, twaRad, t, true, historyMinutes);
      safePush(store.smoothBuf.twa, twaRad, t, true, historyMinutes);
      safePush(store.longBuf.awa, awaVal, t, true, historyMinutes);
      safePush(store.smoothBuf.awa, awaVal, t, true, historyMinutes);
    }

    setHistoriesState({
      stw: [...store.histories.stw],
      sog: [...store.histories.sog],
      vmg: [...store.histories.vmg],
      depth: [...store.histories.depth],
      tws: [...store.histories.tws],
      aws: [...store.histories.aws],
      twd: [...store.histories.twd],
    });

    const current30mSlot = Math.floor(now / 1800000) * 1800000;
    setWindRadarSlots([
      {
        timestamp: current30mSlot - 1800000,
        twdMin: degToRad(75),
        twdMax: degToRad(105),
        twsPeak: 14.5,
        twsMin: 9.8,
        isCalm: false,
      },
      {
        timestamp: current30mSlot - 3600000,
        twdMin: degToRad(60),
        twdMax: degToRad(95),
        twsPeak: 16.2,
        twsMin: 11.0,
        isCalm: false,
      },
      {
        timestamp: current30mSlot - 5400000,
        twdMin: degToRad(80),
        twdMax: degToRad(110),
        twsPeak: 12.0,
        twsMin: 8.5,
        isCalm: false,
      },
    ]);

    setFutureForecast({
      timestamp: now + 1800000,
      tws: 13.5,
      twd: degToRad(95),
      gust: 18.0,
    });
  }, []);

  // A single environment session supplies the exact same scenario to all clients.
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let resumePending = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (disposed || busy) return;
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 4000);
      try {
        const response = await fetch('/rotevista-dashboard', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Dashboard session unavailable');
        const frame = await response.json();
        if (disposed || resumePending || !frame?.generation || !['live','simulation','mixed'].includes(frame.mode)) return;
        const previous = sessionFrameRef.current;
        if (previous?.generation === frame.generation && previous.revision >= frame.revision) return;
        const changed = (previous && previous.generation !== frame.generation) || (!previous && frame.mode === 'simulation');
        if (changed) {
          sharedAlertsRef.current = null;
          setSharedAlerts(null);
          setAlertActionError('');
          setSelectedAisTargetId(null);
          const store = storeRef.current;
          setHistoriesState(resetDashboardMeasurements(store) as any);
          historyInputTimesRef.current = {};
          sessionRawTimesRef.current = {};
          setWindRadarSlots([]); setFutureForecast(null);
        }
        sessionFrameRef.current = { generation: frame.generation, revision: frame.revision };
        if (['AUTO','SAIL','MOTOR'].includes(frame.propulsionMode)) {
          propulsionModeRef.current = frame.propulsionMode;
          setPropulsionModeState(frame.propulsionMode);
        }
        sharedSessionManagedRef.current = true;
        sharedSessionModeRef.current = frame.mode;
        sessionConnectedRef.current = true;
        setDashboardMode(frame.mode); setDashboardEnvironment(frame.environment);
        sharedEnvironmentRef.current = frame.environment;
        applyingSessionRef.current = true;
        try {
          for (const [path, value] of Object.entries(frame.raw || {})) {
            const sourceTime = frame.rawTimes?.[path];
            const signature = JSON.stringify(value);
            const previousValue = sessionRawTimesRef.current[path];
            const depthReset = path === 'environment.depth.belowTransducer' && value === null && signature !== previousValue?.value;
            if (previousValue && (Number.isFinite(sourceTime) ? sourceTime < previousValue.time || (sourceTime === previousValue.time && !depthReset) : signature === previousValue.value)) continue;
            sessionRawTimesRef.current[path] = {time: Number.isFinite(sourceTime) ? sourceTime : frame.serverNow, value: signature};
            const observedAt = Number.isFinite(sourceTime) ? Date.now() - Math.max(0, frame.serverNow - sourceTime) : Date.now();
            processIncomingData(path, value, observedAt);
          }
          processIncomingData('environment.ais_targets', frame.targets || [], frame.serverNow);
          processIncomingData('environment.harbor_clusters', frame.harborClusters || [], frame.serverNow);
          if (frame.sharedAlerts) receiveSharedAlerts(frame.sharedAlerts, true);
        } finally { applyingSessionRef.current = false; }
        if (changed && frame.mode !== 'simulation') {
          const generation = frame.generation;
          void fetch('/rotevista-history', { cache: 'no-store' })
            .then(result => result.ok ? result.json() : null)
            .then(history => {
              // A response requested before another mode change must not mix
              // real histories into a later simulation, even after a round trip.
              if (!history || disposed || sessionFrameRef.current?.generation !== generation ||
                  sharedSessionModeRef.current === 'simulation') return;
              setHistoriesState(restoreDashboardHistory(storeRef.current, history) as any);
              if (Array.isArray(history.windRadarSlots)) setWindRadarSlots(history.windRadarSlots);
              setFutureForecast(history.futureForecast || null);
            }).catch(() => {});
        }
      } catch {
        if (!disposed && !resumePending) sessionConnectedRef.current = false;
      } finally {
        clearTimeout(timeout); busy = false;
        if (resumePending && !disposed) { resumePending = false; void poll(); }
      }
    };
    const unsubscribeRecovery = subscribeDashboardRecovery(document, window, () => {
      if (busy) { resumePending = true; controller?.abort(); }
      else void poll();
    });
    void poll();
    const timer = setInterval(() => { void poll(); }, 1000);
    return () => { disposed = true; unsubscribeRecovery(); clearInterval(timer); controller?.abort(); };
  }, [processIncomingData, receiveSharedAlerts]);

  // Connessione a Signal K o fallback a simulazione offline
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let simTimer: ReturnType<typeof setInterval> | null = null;
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const startSimulation = () => {
      if (REQUIRE_LIVE_DATA || storeRef.current.hasEverConnectedToSignalK || storeRef.current.isSimulating) return;
      if (handshakeTimeout) {
        clearTimeout(handshakeTimeout);
        handshakeTimeout = null;
      }
      storeRef.current.isSimulating = true;
      const store = storeRef.current;
      const now = Date.now();
      const historyMinutes = configRef.current.graphs.historyMinutes || 30;

      // Popola lo storico dimostrativo solo se i grafici sono ancora vuoti
      if (store.histories.stw.length === 0) {
        seedDemoHistory(now, historyMinutes);
      }

      let sim = {
        hdg: 45,
        tws: 12.5,
        twd: 90,
        depth: 12,
        stw: 5.2,
        startTime: Date.now(),
      };

      // Four dynamic targets, including HORIZON entering warning after ~2 minutes.
      const { targets: dynamicTargets } = generateRandomColregScenario(
        MARINA_DI_RAGUSA_SIM_DATA.myGps,
        45, // hdg
        45, // cog
        5.2 // sog
      );
      let evasiveTargetId = dynamicTargets[2]?.id;

      const staticTargets = MARINA_DI_RAGUSA_SIM_DATA.targets.filter(t => !t.isMoving);
      let simTargets = [...staticTargets, ...dynamicTargets];

      let simMyGps = { lat: MARINA_DI_RAGUSA_SIM_DATA.myGps.lat, lon: MARINA_DI_RAGUSA_SIM_DATA.myGps.lon };

      if (simTimer) clearInterval(simTimer);
      simTimer = setInterval(() => {
        const elapsed = (Date.now() - sim.startTime) / 1000;

        const waveChop = Math.sin(elapsed * 1.5) * 0.35 + Math.cos(elapsed * 2.7) * 0.2 + (Math.random() - 0.5) * 0.15;
        const windGust = Math.sin(elapsed * 0.35) * 1.5 + Math.sin(elapsed * 0.12) * 1.2 + (Math.random() - 0.5) * 0.3;
        sim.tws = Math.max(8.0, 12.5 + windGust);

        const windShift = Math.sin(elapsed * 0.15) * 5.5 + Math.sin(elapsed * 0.5) * 1.8;
        sim.twd = (90 + windShift + 360) % 360;

        const yaw = windShift * 0.7 + Math.sin(elapsed * 0.8) * 1.4 + (Math.random() - 0.5) * 0.4;
        sim.hdg = (45 + yaw + 360) % 360;

        let twaRel = (sim.twd - sim.hdg + 360) % 360;
        if (twaRel > 180) twaRel -= 360;
        const twaRad = degToRad(twaRel);

        const windSurge = (sim.tws - 12.5) * 0.2;
        sim.stw = Math.max(3.8, 5.2 + windSurge + waveChop);
        const sogKts = sim.stw + 0.25 + (Math.random() - 0.5) * 0.08;

        const tw_x = sim.tws * Math.cos(twaRad);
        const tw_y = sim.tws * Math.sin(twaRad);
        const aw_x = tw_x + sim.stw;
        const aw_y = tw_y;
        const awsKts = Math.sqrt(aw_x * aw_x + aw_y * aw_y);
        const awaRad = Math.atan2(aw_y, aw_x);

        const currentDepth = Math.max(4.0, sim.depth + Math.sin(elapsed * 0.08) * 2.5 + (Math.random() - 0.5) * 0.1);

        processIncomingData('navigation.headingTrue', degToRad(sim.hdg));
        processIncomingData('environment.wind.speedTrue', ktsToMs(sim.tws));
        processIncomingData('environment.wind.angleTrueWater', twaRad);
        processIncomingData('environment.wind.directionTrue', degToRad(sim.twd));
        processIncomingData('environment.wind.speedApparent', ktsToMs(awsKts));
        processIncomingData('environment.wind.angleApparent', awaRad);
        processIncomingData('environment.depth.belowTransducer', currentDepth);
        processIncomingData('navigation.speedThroughWater', ktsToMs(sim.stw));
        processIncomingData('navigation.speedOverGround', ktsToMs(sogKts));
        const leewaySimDeg = Math.sin(twaRad) * 2.8 + (Math.random() - 0.5) * 0.15;
        const simCog = (sim.hdg - leewaySimDeg + 360) % 360;
        processIncomingData('navigation.courseOverGroundTrue', degToRad(simCog));

        // Avanzamento cinematico della propria barca
        const myDistStepMeters = (sogKts * 1852) / 3600;
        const myCogRad = degToRad(simCog);
        simMyGps.lat += (myDistStepMeters * Math.cos(myCogRad)) / 111139;
        simMyGps.lon += (myDistStepMeters * Math.sin(myCogRad)) / (111139 * Math.cos(degToRad(simMyGps.lat)));
        processIncomingData('navigation.position', { latitude: simMyGps.lat, longitude: simMyGps.lon });

        // Avanzamento cinematico bersagli AIS in movimento (con virata evasiva COLREG sul 3° target tra 32s e 47s)
        simTargets = simTargets.map(t => {
          if (!t.isMoving || t.sog < 0.3) return t;

          const nextCog =
            t.id === evasiveTargetId && elapsed >= 32 && elapsed <= 47
              ? ((t.cog || 0) + 3 + 360) % 360
              : (t.cog || 0);
          const cogRad = degToRad(nextCog);
          const distStepMeters = (t.sog * 1852) / 3600; // spostamento per 1s
          const dLat = (distStepMeters * Math.cos(cogRad)) / 111139;
          const dLon = (distStepMeters * Math.sin(cogRad)) / (111139 * Math.cos(degToRad(t.lat)));

          const newLat = t.lat + dLat;
          const newLon = t.lon + dLon;

          const currentTrail = t.trail ? [...t.trail] : [];
          const lastPt = currentTrail[currentTrail.length - 1];
          if (!lastPt || now - (lastPt.t || 0) >= 30000) {
            currentTrail.push({ lat: Number(newLat.toFixed(5)), lon: Number(newLon.toFixed(5)), t: now });
            const maxAgeMs = ((config.aisAlerter && config.aisAlerter.vectorMinutes) || 15) * 60 * 1000;
            while (currentTrail.length > 2 && now - (currentTrail[0].t || now) > maxAgeMs) {
              currentTrail.shift();
            }
          }

          return {
            ...t,
            cog: Math.round(nextCog),
            lat: newLat,
            lon: newLon,
            age: 0,
            trail: currentTrail,
          };
        });

        // Se tutti i bersagli in movimento hanno superato il CPA da oltre 30s, rigenera un nuovo scenario
        const hasApproachingDynamic = simTargets.some(t => t.isMoving && (t.tcpa === null || t.tcpa > 0 || elapsed < 60));
        if (!hasApproachingDynamic) {
          sim.startTime = Date.now();
          const nextScenario = generateRandomColregScenario(simMyGps, sim.hdg, simCog, sogKts);
          evasiveTargetId = nextScenario.targets[2]?.id;
          simTargets = [...staticTargets, ...nextScenario.targets];
        }

        // Ricalcolo ARPA e valutazioni rischio real-time per tutti i bersagli
        const arpaRes = recalculateArpaForTargets(
          simMyGps,
          sim.hdg,
          simCog,
          sogKts,
          simTargets,
          propulsionModeRef.current,
          configRef.current.aisAlerter?.criticalProximity ?? 45
        );

        simTargets = arpaRes.targets;
        processIncomingData('environment.ais_targets', [...simTargets]);
        processIncomingData('environment.ais_top_threat', arpaRes.topThreat);
      }, 1000);

      // Popola bersagli AIS e cluster con i bersagli reali di Marina di Ragusa
      processIncomingData('navigation.position', { latitude: simMyGps.lat, longitude: simMyGps.lon });
      const initialArpa = recalculateArpaForTargets(
        simMyGps,
        45,
        45,
        5.2,
        simTargets,
        propulsionModeRef.current,
        configRef.current.aisAlerter?.criticalProximity ?? 45
      );
      processIncomingData('environment.ais_targets', initialArpa.targets);
      processIncomingData('environment.harbor_clusters', MARINA_DI_RAGUSA_SIM_DATA.harborClusters);
      processIncomingData('environment.ais_top_threat', initialArpa.topThreat);
    };

    const fetchAisTargets = () => {
      if (!isDisposed && storeRef.current.hasEverConnectedToSignalK) {
        fetch('/rotevista-ais')
          .then(res => (res.ok ? res.json() : null))
          .then(d => {
            if (d) {
              if (Array.isArray(d.targets)) processIncomingData('environment.ais_targets', d.targets);
              if (Array.isArray(d.harborClusters)) processIncomingData('environment.harbor_clusters', d.harborClusters);
              if (d.topThreat !== undefined) processIncomingData('environment.ais_top_threat', d.topThreat);
              if (d.sharedAlerts) receiveSharedAlerts(d.sharedAlerts);
            }
          })
          .catch(() => {});
      }
    };

    const connectWs = () => {
      if (isDisposed || FORCE_SIMULATION) return;
      const addr = window.location.host;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        ws = new WebSocket(`${protocol}//${addr}/signalk/v1/stream?subscribe=none`);

        ws.onopen = () => {
          storeRef.current.hasEverConnectedToSignalK = true;
          if (handshakeTimeout) {
            clearTimeout(handshakeTimeout);
            handshakeTimeout = null;
          }
          if (simTimer) {
            clearInterval(simTimer);
            simTimer = null;
          }
          storeRef.current.isSimulating = false;
          storeRef.current.isSocketOpen = true;

          const subscriptionPayload = {
            context: 'vessels.self',
            subscribe: [
              { path: 'navigation.position', minPeriod: 5000 },
              { path: 'navigation.state', minPeriod: 1000 },
              { path: 'navigation.magneticVariation', minPeriod: 60000 },
              { path: 'environment.depth.belowTransducer', minPeriod: 1000 },
              { path: 'navigation.speedThroughWater', minPeriod: 333 },
              { path: 'navigation.speedOverGround', minPeriod: 333 },
              { path: 'navigation.courseOverGroundTrue', minPeriod: 333 },
              { path: 'navigation.headingTrue', minPeriod: 333 },
              { path: 'navigation.headingMagnetic', minPeriod: 333 },
              { path: 'environment.wind.speedApparent', minPeriod: 333 },
              { path: 'environment.wind.angleApparent', minPeriod: 333 },
              { path: 'environment.wind.speedTrue', minPeriod: 333 },
              { path: 'environment.wind.angleTrueWater', minPeriod: 333 },
              { path: 'environment.wind.directionTrue', minPeriod: 333 },
              { path: 'environment.ais_targets', minPeriod: 5000 },
              { path: 'environment.ais_top_threat', minPeriod: 5000 },
              { path: 'environment.ais_shared_alerts', minPeriod: 0 },
              { path: 'environment.harbor_clusters', minPeriod: 15000 },
              { path: 'environment.rotevista_config', minPeriod: 1000 },
            ],
          };
          try {
            ws?.send(JSON.stringify(subscriptionPayload));
          } catch (e) {}

          fetchConfig();
          fetchHistory();
          fetchAisTargets();
        };

        const fetchHistory = () => {
          // Recupera lo storico e i buffer rolling mantenuti in RAM dal server Signal K
          fetch('/rotevista-history')
            .then(res => (res.ok ? res.json() : null))
            .then(data => {
              if (sharedSessionModeRef.current === 'simulation') return;
              if (data && !storeRef.current.isSimulating && sharedSessionModeRef.current !== 'simulation') {
                const store = storeRef.current;
                let hasHistory = false;
                (['stw', 'sog', 'vmg', 'depth', 'tws', 'aws', 'twd'] as const).forEach(key => {
                  if (Array.isArray(data[key]) && data[key].length > 0) {
                    store.histories[key] = [...data[key]];
                    hasHistory = true;
                  }
                });
                if (Array.isArray(data.windRadarSlots) && data.windRadarSlots.length > 0) {
                  setWindRadarSlots(data.windRadarSlots);
                }
                if (data.futureForecast) {
                  setFutureForecast(data.futureForecast);
                }

                // AIS targets & threats da storico
                if (Array.isArray(data.ais_targets) && data.ais_targets.length > 0) {
                  processIncomingData('environment.ais_targets', data.ais_targets);
                } else {
                  fetchAisTargets();
                }
                if (data.ais_shared_alerts) receiveSharedAlerts(data.ais_shared_alerts);
                if (data.ais_top_threat !== undefined) {
                  setTopThreat(data.ais_top_threat);
                }
                if (Array.isArray(data.harbor_clusters)) {
                  setHarborClusters(data.harbor_clusters);
                }

                // Idratazione istantanea dei buffer rolling per azzerare il warm-up iniziale
                if (data.rollingAngles) {
                  (['hdg', 'cog', 'twa', 'awa', 'twd'] as const).forEach(key => {
                    const arr = data.rollingAngles[key];
                    if (Array.isArray(arr) && arr.length > 0) {
                      const mapped: AngleBufferItem[] = arr.map((item: any) => ({
                        val: item.val,
                        time: item.time,
                        sin: Math.sin(item.val),
                        cos: Math.cos(item.val),
                      }));
                      store.longBuf[key] = mapped;
                      store.smoothBuf[key] = [...mapped];
                    }
                  });
                }

                // Idratazione dello storico lungo TWD per i pallini di rotazione oraria (°/h)
                if (Array.isArray(data.twd) && data.twd.length > 0) {
                  const recentTimes = new Set((store.longBuf.twd || []).map(p => p.time));
                  const histItems: AngleBufferItem[] = data.twd
                    .filter((p: any) => !recentTimes.has(p.time))
                    .map((p: any) => ({
                      val: p.val,
                      time: p.time,
                      sin: Math.sin(p.val),
                      cos: Math.cos(p.val),
                    }));
                  store.longBuf.twd = [...histItems, ...(store.longBuf.twd || [])].sort((a, b) => a.time - b.time);
                }

                if (hasHistory && sharedSessionModeRef.current !== 'simulation') {
                  setHistoriesState({
                    stw: [...store.histories.stw],
                    sog: [...store.histories.sog],
                    vmg: [...store.histories.vmg],
                    depth: [...store.histories.depth],
                    tws: [...store.histories.tws],
                    aws: [...store.histories.aws],
                    twd: [...store.histories.twd],
                  });
                }
              }
            })
            .catch(() => {});
        };

        ws.onmessage = (e) => {
          storeRef.current.hasEverConnectedToSignalK = true;
          if (storeRef.current.isSimulating) {
            storeRef.current.isSimulating = false;
            if (simTimer) {
              clearInterval(simTimer);
              simTimer = null;
            }
          }
          try {
            const d = JSON.parse(e.data);
            if (d.updates) {
              d.updates.forEach((u: any) => {
                const timeMs = u.timestamp ? new Date(u.timestamp).getTime() : Date.now();
                if (u.values) {
                  u.values.forEach((v: any) => processIncomingData(v.path, v.value, timeMs));
                }
              });
            }
          } catch (err) {}
        };

        ws.onclose = () => {
          if (isDisposed) return;
          storeRef.current.isSocketOpen = false;
          if (!REQUIRE_LIVE_DATA && !storeRef.current.hasEverConnectedToSignalK) {
            if (!storeRef.current.isSimulating) {
              startSimulation();
            }
          } else {
            // Connessione reale interrotta: riprova senza inquinare con simulazione
            reconnectTimeout = setTimeout(connectWs, 3000);
          }
        };

        ws.onerror = () => {
          if (isDisposed) return;
          if (!storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSimulating) {
            if (handshakeTimeout) clearTimeout(handshakeTimeout);
            handshakeTimeout = setTimeout(() => {
              if (!isDisposed && !storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSimulating && !storeRef.current.isSocketOpen) {
                startSimulation();
              }
            }, 3000);
          }
        };
      } catch (err) {
        if (!isDisposed && !storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSimulating) {
          startSimulation();
        }
      }
    };

    // Timeout handshake iniziale: se entro 4000ms Signal K non è raggiungibile e non abbiamo ricevuto segnale, avvia la simulazione
    if (!FORCE_SIMULATION) handshakeTimeout = setTimeout(() => {
      if (!isDisposed && !storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSimulating && !storeRef.current.isSocketOpen) {
        startSimulation();
      }
    }, 4000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !isDisposed && !FORCE_SIMULATION) {
        fetchConfig();
        if (storeRef.current.hasEverConnectedToSignalK) {
          fetch('/rotevista-history')
            .then(res => (res.ok ? res.json() : null))
            .then(data => {
              if (data && !storeRef.current.isSimulating && sharedSessionModeRef.current !== 'simulation') {
                const store = storeRef.current;
                if (data.rollingAngles) {
                  (['hdg', 'cog', 'twa', 'awa', 'twd'] as const).forEach(key => {
                    const arr = data.rollingAngles[key];
                    if (Array.isArray(arr) && arr.length > 0) {
                      const mapped: AngleBufferItem[] = arr.map((item: any) => ({
                        val: item.val,
                        time: item.time,
                        sin: Math.sin(item.val),
                        cos: Math.cos(item.val),
                      }));
                      store.longBuf[key] = mapped;
                      store.smoothBuf[key] = [...mapped];
                    }
                  });
                }
              }
            })
            .catch(() => {});

          if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            connectWs();
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const initialWsTimer = setTimeout(FORCE_SIMULATION ? startSimulation : connectWs, 50);

    return () => {
      isDisposed = true;
      clearTimeout(initialWsTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {}
        }
      }
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      if (simTimer) {
        clearInterval(simTimer);
        storeRef.current.isSimulating = false;
      }
    };
  }, [processIncomingData, seedDemoHistory, fetchConfig]);

  // Mixed mode retains live own-ship navigation and server-evaluated AIS contacts.
  // Only synthetic contacts are advanced and evaluated in the browser.
  useEffect(() => {
    if (!MIXED_SIMULATION) return;
    const simulation = new MixedAisSimulation(generateRandomColregScenario, recalculateArpaForTargets);
    const tick = () => {
      const store = storeRef.current;
      const now = Date.now();
      const position = store.raw['navigation.position'];
      const positionTime = store.timestamps['navigation.position'];
      if (!store.isSocketOpen || !positionTime || now - positionTime > 30000 ||
          !Number.isFinite(position?.latitude) || !Number.isFinite(position?.longitude)) {
        simulation.reset();
        processIncomingData('simulation.ais_targets', []);
        return;
      }
      const cog = radToDeg(store.raw['navigation.courseOverGroundTrue'] ?? store.raw['navigation.headingTrue'] ?? 0);
      const own = { position: { lat: position.latitude, lon: position.longitude }, cog,
        hdg: radToDeg(store.raw['navigation.headingTrue'] ?? degToRad(cog)),
        sog: msToKts(store.raw['navigation.speedOverGround'] ?? 0),
        isAnchored: isAnchoredNavigationState(store.raw['navigation.state']) };
      const targets = simulation.tick(own, now, configRef.current.aisAlerter?.vectorMinutes || 15, propulsionModeRef.current);
      processIncomingData('simulation.ais_targets', targets);
    };
    const timer = setInterval(tick, 1000);
    return () => { clearInterval(timer); simulation.reset(); };
  }, [processIncomingData]);

  // Main 1Hz Tactical Display Loop
  useEffect(() => {
    const tick = () => {
      const store = storeRef.current;
      const now = Date.now();

      const validStw = freshBoatSpeed(store.raw['navigation.speedThroughWater'], store.timestamps['navigation.speedThroughWater'], now, windDataPolicy.boatSpeedMaxAgeMs);
      const stwKts = validStw === null ? 0 : msToKts(validStw);
      const validSog = freshBoatSpeed(store.raw['navigation.speedOverGround'], store.timestamps['navigation.speedOverGround'], now, windDataPolicy.boatSpeedMaxAgeMs);
      const sogKts = validSog === null ? 0 : msToKts(validSog);
      const isNav = stwKts > config.averaging.minSpeed || sogKts > config.averaging.minSpeed;

      // Depth Alarm
      const rawDepth = freshDepth(store.raw['environment.depth.belowTransducer'], store.timestamps['environment.depth.belowTransducer'], now, windDataPolicy.depthMaxAgeMs);
      let depthAlarm = '';
      if (rawDepth !== null) {
        manageHistory('depth', rawDepth);
        if (rawDepth < config.alarms.depthDanger) {
          depthAlarm = 'alarm-danger blink-alarm';
          if (isNav) playBingBing();
        } else if (rawDepth < config.alarms.depthWarning) {
          depthAlarm = 'alarm-warning';
        }
      }

      const currentVmg = resolveVmg(store.raw, store.timestamps, now, windDataPolicy);
      const currentHeading = resolveHeading(store.raw, store.timestamps, now, windDataPolicy);
      const currentTwd = resolveTwd(store.raw, store.timestamps, now, windDataPolicy);
      const currentTwa = resolveTwa(store.raw, store.timestamps, now, windDataPolicy);

      // STW & SOG / VMG histories
      if (validStw !== null) {
        manageHistory('stw', stwKts);
      }
      if (validSog !== null) {
        manageHistory('sog', sogKts);

      }

      if (currentVmg !== null) manageHistory('vmg', msToKts(currentVmg));

      // TWS & AWS histories
      const rawTws = resolveTws(store.raw, store.timestamps, now, windDataPolicy);
      const rawAws = freshAws(store.raw['environment.wind.speedApparent'], store.timestamps['environment.wind.speedApparent'], now, windDataPolicy.awsMaxAgeMs);
      const twsVal = rawTws !== null ? msToKts(rawTws) : null;
      const awsVal = rawAws !== null ? msToKts(rawAws) : null;
      if (twsVal !== null) manageHistory('tws', twsVal);
      if (awsVal !== null) manageHistory('aws', awsVal);

      // Leeway & Track Pointer calculation
      let smoothedLeeway = store.smoothedLeeway;
      let curTrackRot = store.curTrackRot;
      const currentLeeway = resolveLeeway(store.raw, store.timestamps, now, windDataPolicy, config.averaging.minSpeed);
      if (currentLeeway !== null) {
        smoothedLeeway = sogKts < config.averaging.minSpeed ? 0 : smoothedLeeway * 0.9 + currentLeeway * 0.1;
        curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway);
        store.smoothedLeeway = smoothedLeeway;
        store.curTrackRot = curTrackRot;
      } else {
        store.smoothedLeeway = 0;
      }

      // Analog Pointers Rotations
      const smoothWin = config.averaging.smoothWindow || 2000;
      const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, smoothWin, true, now);
      const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, smoothWin, true, now);
      let awaPointerDeg = store.curAwaRot;
      let twaPointerDeg = store.curTwaRot;
      if (smAwa) {
        awaPointerDeg = getShortestRotation(awaPointerDeg, radToDeg(smAwa.val));
        store.curAwaRot = awaPointerDeg;
      }
      if (currentTwa !== null) {
        twaPointerDeg = getShortestRotation(twaPointerDeg, radToDeg(smTwa ? smTwa.val : currentTwa));
        store.curTwaRot = twaPointerDeg;
      }

      // Mini-Compass rotations
      const smHdgIcons = getCircularAverageFromBuffer(store.longBuf.hdg, config.averaging.longWindow * 2, false, now);
      const smTwdIcons = getCircularAverageFromBuffer(store.longBuf.twd, config.averaging.longWindow, false, now);
      const twdAngleRad = currentTwd === null ? undefined : smTwdIcons ? smTwdIcons.val : currentTwd;
      const hdgAngleRad = currentHeading === null ? undefined : smHdgIcons ? smHdgIcons.val : currentHeading;

      let windCompassRotDeg = store.curWindCompassRot;
      let boatCompassRotDeg = store.curBoatCompassRot;
      if (twdAngleRad !== undefined) {
        windCompassRotDeg = getShortestRotation(windCompassRotDeg, radToDeg(twdAngleRad));
        store.curWindCompassRot = windCompassRotDeg;
      }
      if (hdgAngleRad !== undefined) {
        boatCompassRotDeg = getShortestRotation(boatCompassRotDeg, radToDeg(hdgAngleRad));
        store.curBoatCompassRot = boatCompassRotDeg;
      }

      // Wind Trend & Gybe Alarm state machine
      const instTwaRad = currentTwa;
      let smoothedTwaDeg: number | null = null;
      let tacticCw = { active: false, color: '#bbb', gybing: false };
      let tacticCcw = { active: false, color: '#bbb', gybing: false };

      if (instTwaRad === null) {
        store.firstEmaRun = true;
        store.lastGybeSide = null;
      }
      if (instTwaRad !== null) {
        const dynamicAlpha = Math.max(0.05, 1.1 - config.averaging.stabilityThreshold);
        const curSin = Math.sin(instTwaRad);
        const curCos = Math.cos(instTwaRad);

        if (store.firstEmaRun) {
          store.emaTwaSin = curSin;
          store.emaTwaCos = curCos;
          store.firstEmaRun = false;
        } else {
          store.emaTwaSin = curSin * dynamicAlpha + store.emaTwaSin * (1 - dynamicAlpha);
          store.emaTwaCos = curCos * dynamicAlpha + store.emaTwaCos * (1 - dynamicAlpha);
        }

        smoothedTwaDeg = radToDeg(Math.atan2(store.emaTwaSin, store.emaTwaCos));
        const absTwaDeg = Math.abs(smoothedTwaDeg);

        if (absTwaDeg > 155) {
          tacticCw = { active: true, color: '#ff3b30', gybing: true };
          tacticCcw = { active: false, color: '#bbb', gybing: false };

          let currentTack: 'starboard' | 'port' | null = null;
          if (smoothedTwaDeg > 155 && smoothedTwaDeg < 170) {
            currentTack = 'starboard';
          } else if (smoothedTwaDeg < -155 && smoothedTwaDeg > -170) {
            currentTack = 'port';
          }

          if (currentTack !== null) {
            if (store.lastGybeSide === null) {
              store.lastGybeSide = currentTack;
            } else if (store.lastGybeSide !== currentTack) {
              store.lastGybeSide = currentTack;
              const isGybeDangerous = gybeSoundAllowed(propulsionModeRef.current, twsVal, sogKts, absTwaDeg);
              if (isGybeDangerous && now - store.lastGybeAlarmTime > 60000) {
                store.lastGybeAlarmTime = now;
                playGybeAlarm();
              }
            }
          }
        } else {
          store.lastGybeSide = null;
        }
      }

      // Tactical trend dots (lifts / headers)
      const twaNow = getCircularAverageFromBuffer(store.longBuf.twa, 2000, true, now);
      const twaRef = getCircularAverageFromBuffer(store.longBuf.twa, 10000, true, now);
      if (currentTwa !== null && twaNow && twaRef && (smoothedTwaDeg === null || Math.abs(smoothedTwaDeg) <= 155)) {
        const deltaTac = radToDeg(((twaNow.val - twaRef.val + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
        const curTwaDegVal = radToDeg(twaNow.val);
        if (Math.abs(deltaTac) > 3.0) {
          const absTwa = Math.abs(curTwaDegVal);
          let tacticColor = '#bbb';
          if (absTwa <= 75 || absTwa >= 105) {
            let isLift = curTwaDegVal > 0 ? deltaTac > 0 : deltaTac < 0;
            if (absTwa >= 90) isLift = !isLift;
            tacticColor = isLift ? '#27ae60' : '#c0392b';
          }
          if (deltaTac > 0) {
            tacticCw = { active: true, color: tacticColor, gybing: false };
            tacticCcw = { active: false, color: '#bbb', gybing: false };
          } else {
            tacticCcw = { active: true, color: tacticColor, gybing: false };
            tacticCw = { active: false, color: '#bbb', gybing: false };
          }
        }
      }

      // Strategic Weather Trend & Hourly Rotation Rate (°/h)
      const isNight = isNightModeRef.current;
      let twdShiftText = '--';
      let twdShiftColor = isNight ? '#800000' : '#888';
      let compassCw: { active: boolean; color: string; blinking?: boolean } = {
        active: false,
        color: isNight ? '#440000' : '#bbb',
        blinking: false,
      };
      let compassCcw: { active: boolean; color: string; blinking?: boolean } = {
        active: false,
        color: isNight ? '#440000' : '#bbb',
        blinking: false,
      };
      let meteoLedState = null;

      const twdBuf = store.longBuf.twd;
      if (currentTwd !== null && twdBuf.length >= 2) {
        const oldestTime = twdBuf[0].time;
        const availableMs = now - oldestTime;

        if (availableMs >= 600000) { // Almeno 10 minuti di dati per evitare sovrastima iniziale
          const windowMs = Math.min(availableMs, 60 * 60000);
          const twdRecent = getCircularAverageFromBuffer(twdBuf, 180000, false, now);

          const pastStart = now - windowMs;
          const pastEnd = pastStart + 300000;
          let pSin = 0;
          let pCos = 0;
          let pCount = 0;
          let pSumTime = 0;

          for (let i = 0; i < twdBuf.length; i++) {
            const item = twdBuf[i];
            if (item.time >= pastStart && item.time <= pastEnd) {
              pSin += item.sin;
              pCos += item.cos;
              pSumTime += item.time;
              pCount++;
            }
            if (item.time > pastEnd) break;
          }

          if (twdRecent && pCount > 0) {
            const pastAvgRad = (Math.atan2(pSin, pCos) + Math.PI * 2) % (Math.PI * 2);
            const pastAvgTime = pSumTime / pCount;
            const effectiveHours = Math.max(0.1, (now - pastAvgTime) / 3600000);

            const deltaDeg = radToDeg(((twdRecent.val - pastAvgRad + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
            const ratePerHour = Math.round(deltaDeg / effectiveHours);
            const absRate = Math.abs(ratePerHour);

            const isSouth = (store.raw['navigation.position']?.latitude || 0) < 0;

            if (absRate < 8) {
              twdShiftText = '0°/h';
              twdShiftColor = isNight ? '#800000' : '#888';
            } else {
              const isFast = absRate >= 25;
              const isClockwise = ratePerHour > 0;
              const signSymbol = isClockwise ? '↻ +' : '↺ ';
              twdShiftText = `${signSymbol}${isClockwise ? ratePerHour : ratePerHour}°/h`;

              let shiftColor = isClockwise ? '#c0392b' : '#27ae60';
              if (isSouth) shiftColor = isClockwise ? '#27ae60' : '#c0392b';
              if (isNight) shiftColor = '#ff3333';

              twdShiftColor = shiftColor;

              if (isClockwise) {
                compassCw = { active: true, color: shiftColor, blinking: isFast };
              } else {
                compassCcw = { active: true, color: shiftColor, blinking: isFast };
              }

              meteoLedState = {
                active: true,
                color: shiftColor,
                angleTarget: isClockwise ? radToDeg(twdRecent.val) + 15 : radToDeg(twdRecent.val) - 15,
              };
            }
          }
        }
      }

      // Circular averages for digital readouts
      const baseThreshold = config.averaging.stabilityThreshold || 0.95;
      const breakout = config.averaging.stabilityBreakout || 15;
      const windThreshold = Math.max(0.6, baseThreshold - 0.13);

      const hObj = getCircularAverageFromBuffer(store.longBuf.hdg, config.averaging.longWindow * 2, false, now, baseThreshold, breakout);
      const cObj = getCircularAverageFromBuffer(store.longBuf.cog, config.averaging.longWindow, false, now, baseThreshold, breakout);
      const awObj = getCircularAverageFromBuffer(store.longBuf.awa, config.averaging.longWindow, true, now, windThreshold, breakout);
      const twObj = getCircularAverageFromBuffer(store.longBuf.twa, config.averaging.longWindow, true, now, windThreshold, breakout);
      const twdObj = getCircularAverageFromBuffer(store.longBuf.twd, config.averaging.longWindow, false, now, windThreshold, breakout);

      // Tack vs Gybe prediction with 10 degree hysteresis
      let tackLabelMode = store.currentTackLabelMode;
      const curAbsTwa = currentTwa === null ? NaN : Math.abs(radToDeg(currentTwa));
      if (tackLabelMode === 'TACK' && curAbsTwa > 95) {
        tackLabelMode = 'GYBE';
      } else if (tackLabelMode === 'GYBE' && curAbsTwa < 85) {
        tackLabelMode = 'TACK';
      }
      store.currentTackLabelMode = tackLabelMode;

      // Tack Opposite Course Reflection
      let tackHdgStr = '---°';
      let tackHdgUnstable = false;
      let tackCogStr = '---°';
      let tackCogUnstable = false;

      const maneuverValid = maneuverValidity(store.raw, store.timestamps, now, windDataPolicy, config.averaging.minSpeed);
      if (maneuverValid.heading && hObj && twdObj) {
        const reflectAngle = (targetRad: number, axisRad: number) => {
          const dS = Math.sin(axisRad - targetRad);
          const dC = Math.cos(axisRad - targetRad);
          return Math.atan2(Math.sin(axisRad) * dC + Math.cos(axisRad) * dS, Math.cos(axisRad) * dC - Math.sin(axisRad) * dS);
        };

        const unstableH = !hObj.stable || !twdObj.stable || hObj.dev > config.averaging.stabilityBreakout;
        if (!isNav) {
          tackHdgStr = '---°';
        } else if (unstableH) {
          tackHdgStr = '---°';
          tackHdgUnstable = true;
        } else {
          const rH = (radToDeg(reflectAngle(hObj.val, twdObj.val)) + 360) % 360;
          tackHdgStr = `${Math.round(rH).toString().padStart(3, '0')}°`;
        }

        if (maneuverValid.cog && cObj) {
          const unstableC = !cObj.stable || !twdObj.stable || cObj.dev > config.averaging.stabilityBreakout;
          if (!isNav) {
            tackCogStr = '---°';
          } else if (unstableC) {
            tackCogStr = '---°';
            tackCogUnstable = true;
          } else {
            const rC = (radToDeg(reflectAngle(cObj.val, twdObj.val)) + 360) % 360;
            tackCogStr = `${Math.round(rC).toString().padStart(3, '0')}°`;
          }
        }
      }

      // Format digital string values
      const formatCompassDeg = (obj: any, rawVal: number | undefined) => {
        const val = obj?.val !== null && obj?.val !== undefined ? obj.val : rawVal;
        if (val === undefined || isNaN(val)) return { str: '---°', unstable: false };
        const deg = Math.round(radToDeg(val));
        const normalized = ((deg % 360) + 360) % 360;
        const main = `${normalized.toString().padStart(3, '0')}°`;
        const diff = obj && rawVal !== undefined ? Math.abs(((radToDeg(rawVal) - radToDeg(obj.val) + 540) % 360) - 180) : 0;
        const unstable = isNav && obj && (!obj.stable || obj.dev > config.averaging.stabilityBreakout || diff > config.averaging.stabilityBreakout);
        return { str: main, unstable };
      };

      const formatRelativeDeg = (obj: any, rawVal: number | undefined) => {
        const val = obj?.val !== null && obj?.val !== undefined ? obj.val : rawVal;
        if (val === undefined || isNaN(val)) return { str: '---°', unstable: false };
        const deg = Math.round(radToDeg(val));
        const main = `${deg}°`;
        const diff = obj && rawVal !== undefined ? Math.abs(((radToDeg(rawVal) - radToDeg(obj.val) + 540) % 360) - 180) : 0;
        const unstable = isNav && obj && (!obj.stable || obj.dev > config.averaging.stabilityBreakout || diff > config.averaging.stabilityBreakout);
        return { str: main, unstable };
      };

      const hdgFormatted = currentHeading === null ? { str: '—', unstable: false } : formatCompassDeg(hObj, currentHeading);
      const currentCog = freshAwa(store.raw['navigation.courseOverGroundTrue'], store.timestamps['navigation.courseOverGroundTrue'], now, windDataPolicy.headingMaxAgeMs);
      const cogFormatted = currentCog === null ? { str: '---°', unstable: false } : formatCompassDeg(cObj, currentCog);
      const validAwa = freshAwa(store.raw['environment.wind.angleApparent'], store.timestamps['environment.wind.angleApparent'], now, windDataPolicy.awaMaxAgeMs);
      const awaFormatted = validAwa === null ? { str: '—', unstable: false } : formatRelativeDeg(awObj, validAwa);
      const twaFormatted = currentTwa === null ? { str: '—', unstable: false } : formatRelativeDeg(twObj, currentTwa);
      const twdFormatted = currentTwd === null ? { str: '—', unstable: false } : formatCompassDeg(twdObj, currentTwd);

      // SOG Color (cyan if VMG, drift color if SOG)
      let sogColor = '';
      if (displayModeSog === 'VMG') {
        sogColor = '#00b8d4';
      } else if (isNav && validStw !== null && validSog !== null) {
        const drift = sogKts - stwKts;
        if (drift < -0.3) sogColor = '#ff3b30';
        else if (drift > 0.3) sogColor = '#00C851';
        else sogColor = '#ffbb33';
      }

      // TWS Color
      let twsColor = '';
      const currentWindVal = displayModeTws === 'AWS' ? awsVal : twsVal;
      if (currentWindVal !== null && currentWindVal >= config.graphs.reef2) {
        twsColor = '#ff3b30';
      } else if (currentWindVal !== null && currentWindVal >= config.graphs.reef1) {
        twsColor = '#ff9800';
      } else if (displayModeTws === 'AWS') {
        twsColor = isNight ? '' : '#5c6bc0';
      }

      const newStw = validStw === null ? '--.-' : stwKts.toFixed(1);
      const newSog = displayModeSog === 'VMG' ? (currentVmg === null ? '--.-' : msToKts(currentVmg).toFixed(1)) : (validSog === null ? '--.-' : sogKts.toFixed(1));
      const newDepth = rawDepth !== null ? rawDepth.toFixed(1) : '--.-';
      const newTws = currentWindVal === null ? '--.-' : currentWindVal.toFixed(1);
      const newAwsSvg = awsVal === null ? '--.-' : awsVal.toFixed(1);

      const roundedLeeway = currentLeeway === null ? null : Math.round(smoothedLeeway * 10) / 10;
      const roundedTrackRot = Math.round(curTrackRot * 10) / 10;
      const roundedAwaRot = Math.round(awaPointerDeg * 10) / 10;
      const roundedTwaRot = Math.round(twaPointerDeg * 10) / 10;
      const roundedWindCompRot = Math.round(windCompassRotDeg * 10) / 10;
      const roundedBoatCompRot = Math.round(boatCompassRotDeg * 10) / 10;

      setDisplayValues(prev => {
        const sameTacCw =
          prev.tacticCwDot.active === tacticCw.active &&
          prev.tacticCwDot.color === tacticCw.color &&
          prev.tacticCwDot.gybing === tacticCw.gybing;
        const sameTacCcw =
          prev.tacticCcwDot.active === tacticCcw.active &&
          prev.tacticCcwDot.color === tacticCcw.color &&
          prev.tacticCcwDot.gybing === tacticCcw.gybing;
        const sameCompCw =
          prev.compassCwDot.active === compassCw.active &&
          prev.compassCwDot.color === compassCw.color &&
          prev.compassCwDot.blinking === compassCw.blinking;
        const sameCompCcw =
          prev.compassCcwDot.active === compassCcw.active &&
          prev.compassCcwDot.color === compassCcw.color &&
          prev.compassCcwDot.blinking === compassCcw.blinking;
        const sameMeteoLed =
          prev.meteoLed?.active === meteoLedState?.active &&
          prev.meteoLed?.color === meteoLedState?.color &&
          prev.meteoLed?.angleTarget === meteoLedState?.angleTarget;

        if (
          prev.stw === newStw &&
          prev.sog === newSog &&
          prev.sogColor === sogColor &&
          prev.hdg === hdgFormatted.str &&
          prev.hdgUnstable === hdgFormatted.unstable &&
          prev.cog === cogFormatted.str &&
          prev.cogUnstable === cogFormatted.unstable &&
          prev.depth === newDepth &&
          prev.depthAlarmClass === depthAlarm &&
          prev.tws === newTws &&
          prev.twsColor === twsColor &&
          prev.awsSvg === newAwsSvg &&
          prev.twaAvg === twaFormatted.str &&
          prev.twaUnstable === twaFormatted.unstable &&
          prev.awaAvg === awaFormatted.str &&
          prev.awaUnstable === awaFormatted.unstable &&
          prev.twdAvg === twdFormatted.str &&
          prev.twdUnstable === twdFormatted.unstable &&
          prev.tackHdg === tackHdgStr &&
          prev.tackHdgUnstable === tackHdgUnstable &&
          prev.tackCog === tackCogStr &&
          prev.tackCogUnstable === tackCogUnstable &&
          prev.tackLabel === tackLabelMode &&
          prev.leewayDeg === roundedLeeway &&
          prev.trackRotDeg === roundedTrackRot &&
          prev.awaPointerDeg === roundedAwaRot &&
          prev.twaPointerDeg === roundedTwaRot &&
          prev.windCompassRotDeg === roundedWindCompRot &&
          prev.boatCompassRotDeg === roundedBoatCompRot &&
          prev.twdShiftText === twdShiftText &&
          prev.twdShiftColor === twdShiftColor &&
          prev.isNavigating === isNav &&
          sameTacCw &&
          sameTacCcw &&
          sameCompCw &&
          sameCompCcw &&
          sameMeteoLed
        ) {
          return prev;
        }
        return {
          stw: newStw,
          sog: newSog,
          sogColor,
          hdg: hdgFormatted.str,
          hdgUnstable: hdgFormatted.unstable,
          cog: cogFormatted.str,
          cogUnstable: cogFormatted.unstable,
          depth: newDepth,
          depthAlarmClass: depthAlarm,
          tws: newTws,
          twsColor,
          awsSvg: newAwsSvg,
          twaAvg: twaFormatted.str,
          twaUnstable: twaFormatted.unstable,
          awaAvg: awaFormatted.str,
          awaUnstable: awaFormatted.unstable,
          twdAvg: twdFormatted.str,
          twdUnstable: twdFormatted.unstable,
          tackHdg: tackHdgStr,
          tackHdgUnstable,
          tackCog: tackCogStr,
          tackCogUnstable,
          tackLabel: tackLabelMode,
          leewayDeg: roundedLeeway,
          trackRotDeg: roundedTrackRot,
          awaPointerDeg: roundedAwaRot,
          twaPointerDeg: roundedTwaRot,
          windCompassRotDeg: roundedWindCompRot,
          boatCompassRotDeg: roundedBoatCompRot,
          tacticCwDot: sameTacCw ? prev.tacticCwDot : tacticCw,
          tacticCcwDot: sameTacCcw ? prev.tacticCcwDot : tacticCcw,
          compassCwDot: sameCompCw ? prev.compassCwDot : compassCw,
          compassCcwDot: sameCompCcw ? prev.compassCcwDot : compassCcw,
          twdShiftText,
          twdShiftColor,
          meteoLed: sameMeteoLed ? prev.meteoLed : meteoLedState,
          isNavigating: isNav,
        };
      });

      // Update exported histories state for charts (preserving unchanged array references)
      setHistoriesState(prev => {
        const s = store.histories;
        const isSame = (a: HistoryPoint[], b: HistoryPoint[]) =>
          a.length === b.length && (b.length === 0 || a[a.length - 1] === b[b.length - 1]);
        const sameStw = isSame(prev.stw, s.stw);
        const sameSog = isSame(prev.sog, s.sog);
        const sameVmg = isSame(prev.vmg, s.vmg);
        const sameDepth = isSame(prev.depth, s.depth);
        const sameTws = isSame(prev.tws, s.tws);
        const sameAws = isSame(prev.aws, s.aws);
        const sameTwd = isSame(prev.twd, s.twd);
        if (sameStw && sameSog && sameVmg && sameDepth && sameTws && sameAws && sameTwd) {
          return prev;
        }
        return {
          stw: sameStw ? prev.stw : [...s.stw],
          sog: sameSog ? prev.sog : [...s.sog],
          vmg: sameVmg ? prev.vmg : [...s.vmg],
          depth: sameDepth ? prev.depth : [...s.depth],
          tws: sameTws ? prev.tws : [...s.tws],
          aws: sameAws ? prev.aws : [...s.aws],
          twd: sameTwd ? prev.twd : [...s.twd],
        };
      });

      // =========================================================================
      // ONLINE STATUS TEXT: Explains "online 30/60 minuti" logic!
      // =========================================================================
      const viewportMinutes = config.graphs.historyMinutes * (isNav ? 1 : 2);
      const requiredMs = viewportMinutes * 60000;

      // Find the oldest available history sample across all channels
      const oldestTimestamps = [
        store.histories.stw[0]?.time,
        store.histories.sog[0]?.time,
        store.histories.tws[0]?.time,
        store.histories.depth[0]?.time,
      ].filter(Boolean) as number[];

      const oldestTime = oldestTimestamps.length > 0 ? Math.min(...oldestTimestamps) : null;
      const isSocketOpen = store.isSocketOpen || sessionConnectedRef.current;
      const isDataFlowing = now - store.lastMessageReceivedTime < 6000;

      let nextStatusText = 'OFFLINE';
      let nextStatusClass = 'offline';
      if (sharedSessionModeRef.current === 'simulation' || store.isSimulating) {
        nextStatusText = 'SIMULAZIONE';
        nextStatusClass = 'simulating';
      } else if (isSocketOpen && isDataFlowing) {
        nextStatusClass = 'online';
        if (oldestTime) {
          const availableMs = now - oldestTime;
          if (availableMs >= requiredMs) {
            nextStatusText = `ONLINE ${viewportMinutes}min`;
          } else {
            const availableMin = Math.max(1, Math.floor(availableMs / 60000));
            nextStatusText = `ONLINE ${availableMin}/${viewportMinutes}min`;
          }
        } else {
          nextStatusText = 'ONLINE';
        }
      } else {
        nextStatusText = isSocketOpen ? 'ATTESA DATI...' : 'OFFLINE';
        nextStatusClass = 'offline';
      }
      if (sharedSessionModeRef.current === 'mixed') nextStatusText = 'MIXED · LIVE + SIM';
      if (sharedSessionModeRef.current === 'simulation') nextStatusText = 'SIMULATION';
      if (sharedEnvironmentRef.current === 'dev') nextStatusText = `DEV · ${nextStatusText}`;
      setConnectionStatus(prev =>
        prev.text === nextStatusText && prev.className === nextStatusClass
          ? prev
          : { text: nextStatusText, className: nextStatusClass }
      );

      if (appViewRef.current === 'ais') {
        const curHdgDeg = store.raw['navigation.headingTrue'] !== undefined
          ? radToDeg(store.raw['navigation.headingTrue'])
          : (store.raw['navigation.courseOverGroundTrue'] !== undefined ? radToDeg(store.raw['navigation.courseOverGroundTrue']) : 0);
        const curCogDeg = store.raw['navigation.courseOverGroundTrue'] !== undefined
          ? radToDeg(store.raw['navigation.courseOverGroundTrue'])
          : curHdgDeg;
        const nextHdg = Math.round((curHdgDeg + 360) % 360);
        const nextCog = Math.round((curCogDeg + 360) % 360);
        const nextSog = Math.round(sogKts * 10) / 10;
        setOwnShipCourse(prev =>
          prev.hdg === nextHdg && prev.cog === nextCog && prev.sog === nextSog
            ? prev
            : { hdg: nextHdg, cog: nextCog, sog: nextSog }
        );
      }
    };

    tick();
    const interval = setInterval(tick, 1000);

    return () => clearInterval(interval);
  }, [config, displayModeSog, displayModeTws, manageHistory]);

  const toggleFocusMode = useCallback((type: BoxType) => {
    setIsFocusActive(prev => {
      const next = !prev;
      setFocusedBox(next ? type : null);
      return next;
    });
  }, []);

  const toggleGraphMode = useCallback((type: string) => {
    setGraphModes(prev => ({
      ...prev,
      [type]: prev[type] === 'standard' ? 'hercules' : 'standard',
    }));
  }, []);

  return {
    config,
    displayModeSog,
    setDisplayModeSog,
    displayModeTws,
    setDisplayModeTws,
    activeInstrument,
    setActiveInstrument,
    isNightMode,
    setIsNightMode,
    isFocusActive,
    focusedBox,
    graphModes,
    connectionStatus,
    displayValues,
    histories: historiesState,
    windRadarSlots,
    futureForecast,
    toggleFocusMode,
    toggleGraphMode,
    appView,
    setAppView,
    aisTargets: displayedAisTargets,
    harborClusters,
    topThreat: activeThreat,
    sharedSnoozeReady: sharedAlerts ? sharedSnoozeReady : undefined,
    alertActionError,
    alertActionPending,
    dismissAlertActionError: () => setAlertActionError(''),
    snoozeThreat,
    isMixedSimulation: dashboardMode === 'mixed',
    dashboardMode,
    dashboardEnvironment,
    unsnoozeThreats,
    selectedAisTargetId,
    setSelectedAisTargetId,
    ownShipPosition,
    ownShipCourse,
    propulsionMode,
    setPropulsionMode,
  };
}
