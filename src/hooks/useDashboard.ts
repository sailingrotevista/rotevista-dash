import { useState, useEffect, useRef, useCallback } from 'react';
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

export function useDashboard() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const [displayModeSog, setDisplayModeSog] = useState<DisplayModeSog>('SOG');
  const [displayModeTws, setDisplayModeTws] = useState<DisplayModeTws>('TWS');
  const [activeInstrument, setActiveInstrument] = useState<ActiveInstrument>('gauge');
  const [isNightMode, setIsNightMode] = useState<boolean>(false);
  const [isFocusActive, setIsFocusActive] = useState<boolean>(false);
  const [focusedBox, setFocusedBox] = useState<BoxType | null>(null);
  const [graphModes, setGraphModes] = useState<Record<string, GraphMode>>({
    stw: 'standard',
    sog: 'standard',
    tws: 'standard',
    depth: 'standard',
  });

  const [connectionStatus, setConnectionStatus] = useState<{ text: string; className: string }>({
    text: 'CONNESSIONE...',
    className: 'offline',
  });

  // Display values for UI
  const [displayValues, setDisplayValues] = useState({
    stw: '0.0',
    sog: '0.0',
    sogColor: '',
    hdg: '000°',
    hdgUnstable: false,
    cog: '000°',
    cogUnstable: false,
    depth: '--.-',
    depthAlarmClass: '',
    tws: '0.0',
    twsColor: '',
    awsSvg: '0.0',
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
    leewayDeg: 0,
    trackRotDeg: 0,
    awaPointerDeg: 0,
    twaPointerDeg: 0,
    windCompassRotDeg: 0,
    boatCompassRotDeg: 0,
    tacticCwDot: { active: false, color: '#bbb', gybing: false },
    tacticCcwDot: { active: false, color: '#bbb', gybing: false },
    compassCwDot: { active: false, color: '#bbb' },
    compassCcwDot: { active: false, color: '#bbb' },
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

    const tempBuf = store.graphTempBuf[type];
    tempBuf.push({ val: value, time: now });

    const bucketReady = (now - store.lastUpdates[type] > bucketIntervalMs) || store.histories[type].length === 0;
    if (!bucketReady) return;

    let finalValue = value;
    if (tempBuf.length > 0) {
      if (type === 'tws' || type === 'aws') {
        const tauMs = 2500;
        let ema = tempBuf[0].val;
        let maxSustained = ema;
        for (let i = 1; i < tempBuf.length; i++) {
          const dt = Math.max(1, tempBuf[i].time - tempBuf[i - 1].time);
          const alpha = 1 - Math.exp(-dt / tauMs);
          ema = tempBuf[i].val * alpha + ema * (1 - alpha);
          if (isFinite(ema) && ema > maxSustained) maxSustained = ema;
        }
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

    store.histories[type].push({ val: finalValue, time: now });

    const maxViewportMinutes = historyMinutes * 2;
    const maxHistoryMs = maxViewportMinutes * 60000 + 60000;
    while (store.histories[type].length > 0 && now - store.histories[type][0].time > maxHistoryMs) {
      store.histories[type].shift();
    }

    store.graphTempBuf[type] = [];
    store.lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
  }, []);

  // Process incoming data
  const processIncomingData = useCallback((path: string, val: any, timeMs?: number) => {
    if (val === null || val === undefined || (typeof val === 'number' && isNaN(val))) return;

    if ((path === 'environment.wind.speedApparent' || path === 'environment.wind.speedTrue') && val > 51.44) return;
    if ((path === 'navigation.speedThroughWater' || path === 'navigation.speedOverGround') && val > 25.72) return;
    if (path === 'environment.depth.belowTransducer' && (val < -2.0 || val > 500)) return;

    const store = storeRef.current;
    const now = timeMs || Date.now();
    const localNow = Date.now();

    store.timestamps[path] = localNow;
    store.raw[path] = val;
    store.lastMessageReceivedTime = localNow;

    const historyMinutes = configRef.current.graphs.historyMinutes;

    if (path === 'environment.wind.directionTrue') {
      const directionVal = typeof val === 'object' && val.val !== undefined ? val.val : val;
      safePush(store.smoothBuf.twd, directionVal, now, true, historyMinutes);
      safePush(store.longBuf.twd, directionVal, now, true, historyMinutes);
      // Also push to twd history for radar
      store.histories.twd.push({ val: directionVal, time: now });
      while (store.histories.twd.length > 0 && now - store.histories.twd[0].time > 120 * 60000) {
        store.histories.twd.shift();
      }
    }

    if (path === 'navigation.headingTrue') {
      store.timestamps['navigation.headingTrueNative'] = now;
      safePush(store.smoothBuf.hdg, val, now, false, historyMinutes);
      safePush(store.longBuf.hdg, val, now, false, historyMinutes);
    } else if (path === 'navigation.headingMagnetic') {
      const hasNativeTrueHdg = store.timestamps['navigation.headingTrueNative'] && (now - store.timestamps['navigation.headingTrueNative'] < 5000);
      if (!hasNativeTrueHdg) {
        const variation = store.raw['navigation.magneticVariation'] || 0;
        const calculatedTrueHdg = (val + variation + 2 * Math.PI) % (2 * Math.PI);
        store.raw['navigation.headingTrue'] = calculatedTrueHdg;
        store.timestamps['navigation.headingTrue'] = localNow;
        safePush(store.smoothBuf.hdg, calculatedTrueHdg, now, false, historyMinutes);
        safePush(store.longBuf.hdg, calculatedTrueHdg, now, false, historyMinutes);
      }
    }

    if (path === 'navigation.courseOverGroundTrue') {
      safePush(store.smoothBuf.cog, val, now, false, historyMinutes);
      safePush(store.longBuf.cog, val, now, false, historyMinutes);

      const hasCompass = store.raw['navigation.headingTrue'] !== undefined || store.raw['navigation.headingMagnetic'] !== undefined;
      const sog = store.raw['navigation.speedOverGround'] || 0;
      if (!hasCompass && sog > 0.77) {
        store.raw['navigation.headingTrue'] = val;
        store.timestamps['navigation.headingTrue'] = localNow;
        safePush(store.smoothBuf.hdg, val, now, false, historyMinutes);
        safePush(store.longBuf.hdg, val, now, false, historyMinutes);
      }
    }

    // Compute true wind if necessary
    const twPaths = [
      'environment.wind.speedApparent',
      'environment.wind.angleApparent',
      'navigation.speedThroughWater',
      'navigation.speedOverGround',
      'navigation.headingTrue',
      'navigation.courseOverGroundTrue',
    ];

    if (twPaths.includes(path)) {
      if (now - store.lastTWCompute > 100) {
        const aws = store.raw['environment.wind.speedApparent'];
        const awa = store.raw['environment.wind.angleApparent'];
        const stw = store.raw['navigation.speedThroughWater'];
        const sog = store.raw['navigation.speedOverGround'] || 0;
        const hdg = store.raw['navigation.headingTrue'];

        if (aws !== undefined && awa !== undefined) {
          const hasFreshStw = store.timestamps['navigation.speedThroughWater'] && (now - store.timestamps['navigation.speedThroughWater'] < 15000);
          let speedRef = sog > 0.77 && (stw || 0) < 0.25 ? sog : hasFreshStw && stw !== undefined ? stw : sog;

          const hasNativeTws = store.timestamps['environment.wind.speedTrue'] && (Date.now() - store.timestamps['environment.wind.speedTrue'] < 5000);
          let tws_water = 0;
          if (hasNativeTws) {
            tws_water = store.raw['environment.wind.speedTrue'] ? msToKts(store.raw['environment.wind.speedTrue']) : 0;
          } else {
            tws_water = Math.sqrt(aws * aws + speedRef * speedRef - 2 * aws * speedRef * Math.cos(awa));
            store.raw['environment.wind.speedTrue'] = tws_water;
          }

          let twa = 0;
          const hasNativeTwa = store.timestamps['environment.wind.angleTrueWater'] && (Date.now() - store.timestamps['environment.wind.angleTrueWater'] < 5000);
          if (hasNativeTwa && store.raw['environment.wind.angleTrueWater'] !== undefined) {
            twa = store.raw['environment.wind.angleTrueWater'];
          } else if (tws_water > 0.05) {
            twa = Math.atan2(aws * Math.sin(awa), aws * Math.cos(awa) - speedRef);
            store.raw['environment.wind.angleTrueWater'] = twa;
          }

          if (tws_water > 0.05 || hasNativeTwa) {
            safePush(store.smoothBuf.twa, twa, now, true, config.graphs.historyMinutes);
            safePush(store.longBuf.twa, twa, now, true, config.graphs.historyMinutes);
            if (awa !== undefined) {
              safePush(store.smoothBuf.awa, awa, now, true, config.graphs.historyMinutes);
              safePush(store.longBuf.awa, awa, now, true, config.graphs.historyMinutes);
            }
          }

          const hasNativeTwd = store.timestamps['environment.wind.directionTrue'] && (Date.now() - store.timestamps['environment.wind.directionTrue'] < 5000);
          if (!hasNativeTwd && tws_water > 0.05 && hdg !== undefined) {
            const twd = (hdg + twa + 2 * Math.PI) % (2 * Math.PI);
            store.raw['environment.wind.directionTrue'] = twd;
            safePush(store.smoothBuf.twd, twd, now, true, historyMinutes);
            safePush(store.longBuf.twd, twd, now, true, historyMinutes);
            store.histories.twd.push({ val: twd, time: now });
          }
        }
        store.lastTWCompute = now;
      }
    }
  }, []);

  // Load configuration from Signal K plugin or settings.json
  useEffect(() => {
    fetch('/rotevista-config')
      .then(res => {
        if (!res.ok) throw new Error('Not available');
        storeRef.current.hasEverConnectedToSignalK = true;
        return res.json();
      })
      .catch(() => {
        return fetch('/settings.json').then(r => (r.ok ? r.json() : null));
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
          }));
        }
      })
      .catch(() => {});

    // Load saved dashboard state
    const saved = localStorage.getItem('rotevista_dash_state');
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (state.displayModeSog) setDisplayModeSog(state.displayModeSog);
        if (state.displayModeTws) setDisplayModeTws(state.displayModeTws);
        if (state.graphModes) setGraphModes(state.graphModes);
        if (state.isNightMode) setIsNightMode(state.isNightMode);
      } catch (e) {
        // Ignore
      }
    }
  }, []);

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

  // Connessione a Signal K o fallback a simulazione offline
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let simTimer: ReturnType<typeof setInterval> | null = null;
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const startSimulation = () => {
      if (storeRef.current.hasEverConnectedToSignalK) return;
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
      }, 1000);
    };

    const connectWs = () => {
      if (isDisposed) return;
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
              { path: 'navigation.position', minPeriod: 60000 },
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
            ],
          };
          try {
            ws?.send(JSON.stringify(subscriptionPayload));
          } catch (e) {}

          // Se presente, recupera lo storico reale mantenuto in RAM dal plugin server Signal K
          fetch('/rotevista-history')
            .then(res => (res.ok ? res.json() : null))
            .then(data => {
              if (data && !storeRef.current.isSimulating) {
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
                if (hasHistory) {
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
          storeRef.current.isSocketOpen = false;
          if (!storeRef.current.hasEverConnectedToSignalK) {
            if (!storeRef.current.isSimulating) {
              startSimulation();
            }
          } else {
            // Connessione reale interrotta: riprova senza inquinare con simulazione
            if (!isDisposed) {
              reconnectTimeout = setTimeout(connectWs, 3000);
            }
          }
        };

        ws.onerror = () => {
          if (!storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSimulating) {
            handshakeTimeout = setTimeout(() => {
              if (!storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSimulating && !storeRef.current.isSocketOpen) {
                startSimulation();
              }
            }, 3000);
          }
        };
      } catch (err) {
        if (!storeRef.current.hasEverConnectedToSignalK) {
          startSimulation();
        }
      }
    };

    // Timeout handshake iniziale: se entro 4000ms Signal K non è raggiungibile e non abbiamo ricevuto segnale, avvia la simulazione
    handshakeTimeout = setTimeout(() => {
      if (!storeRef.current.hasEverConnectedToSignalK && !storeRef.current.isSocketOpen) {
        startSimulation();
      }
    }, 4000);

    connectWs();

    return () => {
      isDisposed = true;
      if (ws) ws.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      if (simTimer) clearInterval(simTimer);
    };
  }, [processIncomingData, seedDemoHistory]);

  // Main 1Hz Tactical Display Loop
  useEffect(() => {
    const interval = setInterval(() => {
      const store = storeRef.current;
      const now = Date.now();

      const stwKts = msToKts(store.raw['navigation.speedThroughWater'] || 0);
      const sogKts = msToKts(store.raw['navigation.speedOverGround'] || 0);
      const isNav = stwKts > config.averaging.minSpeed || sogKts > config.averaging.minSpeed;

      // Depth Alarm
      const rawDepth = store.raw['environment.depth.belowTransducer'];
      let depthAlarm = '';
      if (rawDepth !== undefined) {
        manageHistory('depth', rawDepth);
        if (rawDepth < config.alarms.depthDanger) {
          depthAlarm = 'alarm-danger blink-alarm';
          if (isNav) playBingBing();
        } else if (rawDepth < config.alarms.depthWarning) {
          depthAlarm = 'alarm-warning';
        }
      }

      // STW & SOG / VMG histories
      if (store.raw['navigation.speedThroughWater'] !== undefined) {
        manageHistory('stw', stwKts);
      }
      if (store.raw['navigation.speedOverGround'] !== undefined) {
        manageHistory('sog', sogKts);
        const hasFreshStw = store.timestamps['navigation.speedThroughWater'] && (now - store.timestamps['navigation.speedThroughWater'] < 15000);
        const speedRefKts = hasFreshStw && !(sogKts > 1.5 && stwKts < 0.5) ? stwKts : sogKts;
        const vmgVal = Math.abs(speedRefKts * Math.cos(store.raw['environment.wind.angleTrueWater'] || 0));
        manageHistory('vmg', vmgVal);
      }

      // TWS & AWS histories
      const rawTws = store.raw['environment.wind.speedTrue'];
      const rawAws = store.raw['environment.wind.speedApparent'];
      const twsVal = rawTws !== undefined && rawTws !== null ? msToKts(rawTws) : 0;
      const awsVal = rawAws !== undefined && rawAws !== null ? msToKts(rawAws) : 0;
      if (rawTws !== undefined) manageHistory('tws', twsVal);
      if (rawAws !== undefined) manageHistory('aws', awsVal);

      // Leeway & Track Pointer calculation
      let smoothedLeeway = store.smoothedLeeway;
      let curTrackRot = store.curTrackRot;
      if (store.raw['navigation.courseOverGroundTrue'] !== undefined && store.raw['navigation.headingTrue'] !== undefined) {
        const driftDeg = radToDeg(
          ((store.raw['navigation.courseOverGroundTrue'] - store.raw['navigation.headingTrue'] + Math.PI * 3) % (2 * Math.PI)) - Math.PI
        );
        smoothedLeeway = sogKts < config.averaging.minSpeed ? 0 : smoothedLeeway * 0.9 + driftDeg * 0.1;
        curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway);
        store.smoothedLeeway = smoothedLeeway;
        store.curTrackRot = curTrackRot;
      }

      // Analog Pointers Rotations
      const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, 2000, true, now);
      const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, 2000, true, now);
      let awaPointerDeg = store.curAwaRot;
      let twaPointerDeg = store.curTwaRot;
      if (smAwa) {
        awaPointerDeg = getShortestRotation(awaPointerDeg, radToDeg(smAwa.val));
        store.curAwaRot = awaPointerDeg;
      }
      if (smTwa) {
        twaPointerDeg = getShortestRotation(twaPointerDeg, radToDeg(smTwa.val));
        store.curTwaRot = twaPointerDeg;
      }

      // Mini-Compass rotations
      const smHdgIcons = getCircularAverageFromBuffer(store.longBuf.hdg, config.averaging.longWindow * 2, false, now);
      const smTwdIcons = getCircularAverageFromBuffer(store.longBuf.twd, config.averaging.longWindow, false, now);
      const twdAngleRad = smTwdIcons ? smTwdIcons.val : store.raw['environment.wind.directionTrue'];
      const hdgAngleRad = smHdgIcons ? smHdgIcons.val : store.raw['navigation.headingTrue'];

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
      const instTwaRad = store.raw['environment.wind.angleTrueWater'];
      let smoothedTwaDeg: number | null = null;
      let tacticCw = { active: false, color: '#bbb', gybing: false };
      let tacticCcw = { active: false, color: '#bbb', gybing: false };

      if (instTwaRad !== undefined) {
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
              const isMotoringDownwind = absTwaDeg > 135 && sogKts > twsVal * 0.75;
              const isGybeDangerous = twsVal > 7.0 && sogKts > 1.0 && !isMotoringDownwind;
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
      if (twaNow && twaRef && (smoothedTwaDeg === null || Math.abs(smoothedTwaDeg) <= 155)) {
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

      // Strategic Weather Trend (TWD 1m vs 15m/60m)
      const twdNow = getCircularAverageFromBuffer(store.longBuf.twd, 60000, false, now);
      const strategicWindowMs = (isNav ? 15 : 60) * 60000;
      const twdRef = getCircularAverageFromBuffer(store.longBuf.twd, strategicWindowMs, false, now);
      let compassCw = { active: false, color: '#bbb' };
      let compassCcw = { active: false, color: '#bbb' };
      let meteoLedState = null;

      if (twdNow && twdRef) {
        const deltaMeteo = radToDeg(((twdNow.val - twdRef.val + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
        if (Math.abs(deltaMeteo) > 6.0) {
          const isSouth = store.raw['navigation.position']?.latitude < 0;
          const meteoColor = !isSouth ? (deltaMeteo < 0 ? '#27ae60' : '#c0392b') : deltaMeteo > 0 ? '#27ae60' : '#c0392b';
          if (deltaMeteo > 0) {
            compassCw = { active: true, color: meteoColor };
          } else {
            compassCcw = { active: true, color: meteoColor };
          }

          meteoLedState = {
            active: true,
            color: meteoColor,
            angleTarget: deltaMeteo > 0 ? radToDeg(twdNow.val) + 15 : radToDeg(twdNow.val) - 15,
          };
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
      const curAbsTwa = Math.abs(radToDeg(store.raw['environment.wind.angleTrueWater'] || 0));
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

      if (hObj && twdObj) {
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

        if (cObj) {
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

      const hdgFormatted = formatCompassDeg(hObj, store.raw['navigation.headingTrue']);
      const cogFormatted = formatCompassDeg(cObj, store.raw['navigation.courseOverGroundTrue']);
      const awaFormatted = formatRelativeDeg(awObj, store.raw['environment.wind.angleApparent']);
      const twaFormatted = formatRelativeDeg(twObj, store.raw['environment.wind.angleTrueWater']);
      const twdFormatted = formatCompassDeg(twdObj, store.raw['environment.wind.directionTrue']);

      // SOG Color (cyan if VMG, drift color if SOG)
      let sogColor = '';
      if (displayModeSog === 'VMG') {
        sogColor = '#00b8d4';
      } else if (isNav) {
        const drift = sogKts - stwKts;
        if (drift < -0.3) sogColor = '#ff3b30';
        else if (drift > 0.3) sogColor = '#00C851';
        else sogColor = '#ffbb33';
      }

      // TWS Color
      let twsColor = '';
      const currentWindVal = displayModeTws === 'AWS' ? awsVal : twsVal;
      if (currentWindVal >= config.graphs.reef2) {
        twsColor = '#ff3b30';
      } else if (currentWindVal >= config.graphs.reef1) {
        twsColor = '#ff9800';
      } else if (displayModeTws === 'AWS') {
        twsColor = isNightMode ? '' : '#5c6bc0';
      }

      setDisplayValues({
        stw: stwKts.toFixed(1),
        sog: displayModeSog === 'VMG' ? (store.histories.vmg[store.histories.vmg.length - 1]?.val || 0).toFixed(1) : sogKts.toFixed(1),
        sogColor,
        hdg: hdgFormatted.str,
        hdgUnstable: hdgFormatted.unstable,
        cog: cogFormatted.str,
        cogUnstable: cogFormatted.unstable,
        depth: rawDepth !== undefined ? rawDepth.toFixed(1) : '--.-',
        depthAlarmClass: depthAlarm,
        tws: currentWindVal.toFixed(1),
        twsColor,
        awsSvg: awsVal.toFixed(1),
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
        leewayDeg: smoothedLeeway,
        trackRotDeg: curTrackRot,
        awaPointerDeg,
        twaPointerDeg,
        windCompassRotDeg,
        boatCompassRotDeg,
        tacticCwDot: tacticCw,
        tacticCcwDot: tacticCcw,
        compassCwDot: compassCw,
        compassCcwDot: compassCcw,
        meteoLed: meteoLedState,
        isNavigating: isNav,
      });

      // Update exported histories state for charts
      setHistoriesState({
        stw: [...store.histories.stw],
        sog: [...store.histories.sog],
        vmg: [...store.histories.vmg],
        depth: [...store.histories.depth],
        tws: [...store.histories.tws],
        aws: [...store.histories.aws],
        twd: [...store.histories.twd],
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
      const isSocketOpen = store.isSocketOpen;
      const isDataFlowing = now - store.lastMessageReceivedTime < 6000;

      if (store.isSimulating) {
        setConnectionStatus({ text: 'SIMULAZIONE', className: 'simulating' });
      } else if (isSocketOpen && isDataFlowing) {
        if (oldestTime) {
          const availableMs = now - oldestTime;
          if (availableMs >= requiredMs) {
            setConnectionStatus({ text: `ONLINE ${viewportMinutes}min`, className: 'online' });
          } else {
            const availableMin = Math.max(1, Math.floor(availableMs / 60000));
            setConnectionStatus({ text: `ONLINE ${availableMin}/${viewportMinutes}min`, className: 'online' });
          }
        } else {
          setConnectionStatus({ text: 'ONLINE', className: 'online' });
        }
      } else {
        setConnectionStatus({
          text: isSocketOpen ? 'ATTESA DATI...' : 'OFFLINE',
          className: 'offline',
        });
      }
    }, 1000);

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
  };
}
