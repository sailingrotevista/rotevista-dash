import { AngleBufferItem, CircularAverageResult } from '../types';

export const radToDeg = (rad: number): number => rad * (180 / Math.PI);
export const degToRad = (deg: number): number => deg * (Math.PI / 180);
export const msToKts = (ms: number): number => ms * 1.94384;
export const ktsToMs = (kts: number): number => kts / 1.94384;

export function getShortestRotation(curr: number, target: number): number {
  let diff = (target - curr) % 360;
  if (diff > 180) diff -= 360;
  else if (diff < -180) diff += 360;
  return curr + diff;
}

export function getCircularAverageFromBuffer(
  bufferArray: AngleBufferItem[],
  windowMs: number,
  signed = false,
  now?: number,
  stabilityThreshold = 0.95,
  stabilityBreakout = 15
): CircularAverageResult | null {
  const len = bufferArray.length;
  if (len === 0) return null;

  const currentTime = now || Date.now();
  const newestSampleTime = bufferArray[len - 1].time;

  // Sensor considered offline if silence > 15s
  if ((currentTime - newestSampleTime) > 15000) return null;

  let sSin = 0;
  let sCos = 0;
  let count = 0;

  let pilotSin = 0;
  let pilotCos = 0;
  const pilotSamples = Math.min(len, 15);
  for (let i = len - 1; i >= len - pilotSamples; i--) {
    pilotSin += bufferArray[i].sin;
    pilotCos += bufferArray[i].cos;
  }
  const pilotRad = Math.atan2(pilotSin, pilotCos);
  const limitRad = stabilityBreakout * (Math.PI / 180);

  for (let i = len - 1; i >= 0; i--) {
    const item = bufferArray[i];
    if ((currentTime - item.time) > windowMs) break;

    const diffRad = Math.atan2(Math.sin(item.val - pilotRad), Math.cos(item.val - pilotRad));
    let finalSin: number;
    let finalCos: number;

    if (Math.abs(diffRad) > limitRad) {
      const clampedDiff = Math.sign(diffRad) * limitRad;
      const clampedRad = pilotRad + clampedDiff;
      finalSin = Math.sin(clampedRad);
      finalCos = Math.cos(clampedRad);
    } else {
      finalSin = item.sin;
      finalCos = item.cos;
    }

    sSin += finalSin;
    sCos += finalCos;
    count++;
  }

  if (count === 0) return null;

  const R = Math.hypot(sSin, sCos) / count;
  const avgRad = Math.atan2(sSin, sCos);
  const finalVal = signed ? avgRad : (avgRad + Math.PI * 2) % (Math.PI * 2);
  const safeR = Math.max(R, 1e-9);

  const isStable = (count >= 2) && (R > stabilityThreshold);

  return {
    val: finalVal,
    stable: isStable,
    dev: (R < 1) ? Math.round(Math.sqrt(-2 * Math.log(safeR)) * (180 / Math.PI)) : 0,
    samples: count
  };
}

let audioCtx: AudioContext | null = null;
let lastAlarmTime = 0;
let lastGybeSoundTime = 0;

export function playBingBing(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const n = Date.now();
    if (n - lastAlarmTime < 3000) return;
    lastAlarmTime = n;

    const b = (f: number, s: number) => {
      if (!audioCtx) return;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.frequency.value = f;
      g.gain.setValueAtTime(0.1, s);
      g.gain.exponentialRampToValueAtTime(0.01, s + 0.4);
      o.start(s);
      o.stop(s + 0.5);
    };

    b(880, audioCtx.currentTime);
    b(880, audioCtx.currentTime + 0.6);
  } catch (e) {
    // Audio might be blocked by autoplay policies
  }
}

export function playGybeAlarm(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const n = Date.now();
    if (n - lastGybeSoundTime < 2000) return;
    lastGybeSoundTime = n;

    const note = (f: number, s: number, d: number) => {
      if (!audioCtx) return;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.05, s);
      g.gain.exponentialRampToValueAtTime(0.001, s + d);
      o.start(s);
      o.stop(s + d);
    };

    for (let i = 0; i < 4; i++) {
      note(1800, audioCtx.currentTime + (i * 0.15), 0.1);
      note(1200, audioCtx.currentTime + (i * 0.15) + 0.07, 0.1);
    }
  } catch (e) {
    // Ignore audio policy issues
  }
}
