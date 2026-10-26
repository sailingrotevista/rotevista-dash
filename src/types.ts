export interface AlarmConfig {
  depthDanger: number;
  depthWarning: number;
}

export interface GraphsConfig {
  reef1: number;
  reef2: number;
  historyMinutes: number;
  samples?: number;
}

export interface AveragingConfig {
  smoothWindow: number;
  longWindow: number;
  stabilityTolerance?: number;
  stabilityThreshold: number;
  minSpeed: number;
  stabilityBreakout: number;
}

export interface ScaleSetting {
  stdMax: number;
  step: number;
  hercSpan: number;
}

export interface ScalesConfig {
  stw: ScaleSetting;
  sog: ScaleSetting;
  tws: ScaleSetting;
  depth: ScaleSetting;
  [key: string]: ScaleSetting;
}

export interface AppConfig {
  alarms: AlarmConfig;
  graphs: GraphsConfig;
  averaging: AveragingConfig;
  scales: ScalesConfig;
  server: {
    fallbackIp: string;
  };
  aisAlerter?: {
    vectorMinutes?: number;
    [key: string]: any;
  };
  vesselName?: string;
  propulsionMode?: PropulsionMode;
}

export type PropulsionMode = 'AUTO' | 'SAIL' | 'MOTOR';

export interface HistoryPoint {
  gapBefore?: boolean;
  val: number;
  time: number;
  tws?: number;
  min?: number;
  max?: number;
}

export interface AngleBufferItem {
  val: number;
  time: number;
  sin: number;
  cos: number;
}

export interface WindRadarSlot {
  timestamp: number;
  twdMin: number;
  twdMax: number;
  twsPeak: number;
  twsMin?: number;
  isCalm?: boolean;
}

export interface FutureForecast {
  timestamp: number;
  tws: number;
  twd: number;
  gust?: number;
}

export interface CircularAverageResult {
  val: number;
  stable: boolean;
  dev: number;
  samples: number;
}

export type DisplayModeSog = 'SOG' | 'VMG';
export type DisplayModeTws = 'TWS' | 'AWS';
export type ActiveInstrument = 'gauge' | 'radar';
export type GraphMode = 'standard' | 'hercules';
export type BoxType = 'stw' | 'sog' | 'hdg' | 'cog' | 'tack' | 'depth' | 'tws' | 'twa' | 'awa' | 'twd';
export type AppView = 'wind' | 'ais';

export interface AisTrailPoint {
  lat: number;
  lon: number;
  t?: number;
}

export interface AisReceivedValue<T> {
  value: T;
  timestamp: number | null;
  source: string | null;
}
export interface AisReceivedData {
  name: AisReceivedValue<string> | null;
  position: AisReceivedValue<{lat: number; lon: number}> | null;
  sog: AisReceivedValue<number> | null;
  cog: AisReceivedValue<number> | null;
  heading: AisReceivedValue<number> | null;
  navigationState: AisReceivedValue<string> | null;
  aisClass: AisReceivedValue<string> | null;
  shipType: AisReceivedValue<{id: number | null; name: string | null}> | null;
  length: AisReceivedValue<number> | null;
  beam: AisReceivedValue<number> | null;
  draft: AisReceivedValue<{metres: number; basis: string}> | null;
  fromBow: AisReceivedValue<number> | null;
  fromCenter: AisReceivedValue<number> | null;
  callsign: AisReceivedValue<string> | null;
  destination: AisReceivedValue<string> | null;
  eta: AisReceivedValue<string> | null;
}

export interface AisTarget {
  id: string;
  isSimulated?: boolean;
  areaProximityOnly?: boolean;
  inRecognizedArea?: boolean;
  alertPolicy?: { mode: 'NORMAL' | 'REDUCED' | 'BUBBLE_ONLY'; reason: string; ownMoving: boolean; targetMoving: boolean; ownInArea: boolean; targetInArea: boolean };
  proximityEntryObserved?: boolean;
  withinSafeBubble?: boolean;
  areaKind?: 'PORT' | 'ANCHORAGE' | 'PROVISIONAL';
  reportedNavigationState?: string;
  reportedAis?: AisReceivedData;
  proximityAcknowledged?: boolean;
  alertKind?: 'PROXIMITY';
  currentHullClearanceMeters?: number;
  safeBubbleMeters?: number;
  proximityArea?: { id: string; lat: number; lon: number };
  name: string;
  type: number | string;
  lat: number;
  lon: number;
  cog: number;
  sog: number | null;
  dist: number;
  isAnchored: boolean;
  isMoored?: boolean;
  anchorState?: 'UNDERWAY' | 'POSSIBLE_ANCHOR' | 'ANCHORED' | 'MOORED' | 'ANCHOR_DRAGGING' | 'WEIGHING_ANCHOR';
  swingRadius?: number | null;
  anchorCenter?: { lat: number; lon: number; radius?: number } | null;
  isMoving: boolean;
  motionState?: 'STATIONARY' | 'MOVING';
  stationarySince?: number | null;
  restPattern?: {
    kind: 'UNDETERMINED' | 'FIXED' | 'OSCILLATING';
    confirmed: boolean;
    since: number;
    observedDurationSeconds: number;
    observedSpanSeconds: number;
    sampleCount: number;
    center: { lat: number; lon: number } | null;
    radiusMeters: number | null;
    dispersionMeters: number | null;
    returnCount: number;
    windMooring?: {
      available: boolean;
      supported: boolean;
      strong: boolean;
      sampleCount: number;
      observedSpanSeconds?: number;
      headingSpreadDegrees?: number;
      windShiftDegrees?: number;
    };
    excludedSamples: number;
    lastFixTime: number;
  } | null;
  lastPositionTime?: number;
  lastCogTime?: number | null;
  lastSogTime?: number | null;
  motionDataSync?: {
    status: 'IN_SYNC' | 'OUT_OF_SYNC' | 'UNKNOWN';
    cogSkewSeconds: number | null;
    sogSkewSeconds: number | null;
    maxSkewSeconds: number | null;
  };
  isProjected?: boolean;
  contactLost?: boolean;
  contactLostAt?: number;
  predictionStability?: {
    state: 'INSUFFICIENT_DATA' | 'STABLE' | 'VARIABLE' | 'MANEUVERING' | 'NOT_MOVING';
    sampleCount: number;
    comparisonCount: number;
    errorRateMps: number | null;
    uncertaintyGrowthMps: number | null;
    lastFixTime: number | null;
  };
  effectiveThresholds?: {
    redCpa: number;
    orangeCpa: number;
    horizonTcpa: number;
    referenceKnots: number;
    distanceFactor: number;
    ownAtAnchor?: boolean;
    reduced?: boolean;
    reductionReason?: string;
    anchoredCpaFactor?: number;
    anchoredTcpaFactor?: number;
  };
  warningBasis?: 'NOMINAL' | 'INSTABILITY' | null;
  instabilityWarning?: {
    possibleCpaMeters: number;
    possibleTcpaSeconds: number;
    entrySeconds: number;
    exitSeconds: number;
    durationSeconds: number;
  } | null;
  risk: 'GREEN' | 'RED' | 'ORANGE' | 'GREY';
  trend?: 'IMPROVING' | 'STABLE' | 'WORSENING';
  riskMsg: string;
  cpa: number | null;
  tcpa: number | null;
  crossDir: string;
  crossOutcome: string;
  crossRule: string;
  sightingTxt: string;
  age: number;
  callsign?: string;
  length?: number | null;
  beam?: number | null;
  draft?: number | null;
  destination?: string;
  eta?: string;
  aisClass?: 'A' | 'B' | null;
  flag?: string;
  inCluster?: boolean;
  clusterId?: string | null;
  trail?: AisTrailPoint[];
}

export interface HarborCluster {
  id: string;
  kind?: 'PORT' | 'ANCHORAGE' | 'PROVISIONAL';
  lat: number;
  lon: number;
  center?: [number, number];
  dist: number;
  count: number;
  hull: Array<[number, number]>;
  flags?: Record<string, number>;
}


export interface OwnShipPosition {
  lat: number;
  lon: number;
  valid: boolean;
  hasFix: boolean;
}

export interface OwnShipCourse {
  hdg: number | null;
  cog: number | null;
  sog: number | null;
}

export interface OwnShipMotion {
  status: 'UNKNOWN' | 'STOPPED' | 'UNDERWAY' | 'IN PORT' | 'AT ANCHOR';
  valid: boolean;
  confirmedRest: boolean;
  relaxedCollision: boolean;
  inPort: boolean;
  motionState: 'UNKNOWN' | 'STATIONARY' | 'MOVING';
  lastFixTime: number | null;
}
