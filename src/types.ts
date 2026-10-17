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
