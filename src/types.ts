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
}

export interface HistoryPoint {
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
  t: number;
}

export interface AisTarget {
  id: string;
  name: string;
  type: number | string;
  lat: number;
  lon: number;
  cog: number;
  sog: number;
  dist: number;
  isAnchored: boolean;
  isMoored?: boolean;
  anchorState?: 'UNDERWAY' | 'POSSIBLE_ANCHOR' | 'ANCHORED' | 'MOORED' | 'ANCHOR_DRAGGING' | 'WEIGHING_ANCHOR';
  swingRadius?: number | null;
  anchorCenter?: { lat: number; lon: number; radius?: number } | null;
  isMoving: boolean;
  risk: 'RED' | 'ORANGE' | 'GREY';
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
  aisClass?: string;
  flag?: string;
  inCluster?: boolean;
  clusterId?: string | null;
  trail?: AisTrailPoint[];
}

export interface HarborCluster {
  id: string;
  lat: number;
  lon: number;
  center?: [number, number];
  dist: number;
  count: number;
  hull: Array<[number, number]>;
  flags?: Record<string, number>;
}

