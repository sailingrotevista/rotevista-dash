import { HistoryPoint } from '../types';
import { radToDeg } from './math';

export const CALM_THRESHOLD_KTS = 1.5;
export const ringRadii = [59.0, 67.2, 75.4, 83.6, 91.8, 100.0, 108.2, 116.4];
export const ARC_STROKE_WIDTH = 5.0;
export const BORDER_STROKE_WIDTH = ARC_STROKE_WIDTH + 2; // 7px

export function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians))
  };
}

export function describeArc(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);

  let arcSweep = endAngle - startAngle;
  if (arcSweep < 0) arcSweep += 360;

  const largeArcFlag = arcSweep <= 180 ? '0' : '1';

  return [
    'M', start.x, start.y,
    'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y
  ].join(' ');
}

export function calculateActive30mRing(twdHistory: HistoryPoint[], twsHistory: HistoryPoint[]) {
  const now = Date.now();
  const start30m = now - 1800000;

  const twdRecent = (twdHistory || []).filter(p => p.time >= start30m);
  const twsRecent = (twsHistory || []).filter(p => p.time >= start30m);

  if (twdRecent.length === 0) return null;

  const twsVals = twsRecent.map(p => p.val).filter(v => isFinite(v));
  const maxTws = twsVals.length > 0 ? Math.max(...twsVals) : 0;
  const minTws = twsVals.length > 0 ? Math.min(...twsVals) : 0;

  if (maxTws < CALM_THRESHOLD_KTS) {
    return { twsPeak: maxTws, twsMin: minTws, twdMin: 0, twdMax: 360, isCalm: true, isFuture: false };
  }

  const allAngles: number[] = [];
  twdRecent.forEach(p => {
    allAngles.push(p.val);
    if (p.min !== undefined) allAngles.push(p.min);
    if (p.max !== undefined) allAngles.push(p.max);
  });

  let sumSin = 0;
  let sumCos = 0;
  allAngles.forEach(a => {
    sumSin += Math.sin(a);
    sumCos += Math.cos(a);
  });
  const avgAngle = Math.atan2(sumSin, sumCos);
  const finalAvg = (avgAngle + Math.PI * 2) % (Math.PI * 2);

  const diffs = allAngles.map(a => {
    const diff = a - finalAvg;
    return Math.atan2(Math.sin(diff), Math.cos(diff));
  });

  diffs.sort((a, b) => a - b);
  const trimCount = Math.floor(diffs.length * 0.05);
  const activeDiffs = diffs.slice(trimCount, diffs.length - trimCount);
  const finalDiffs = activeDiffs.length > 0 ? activeDiffs : diffs;

  const minDiff = Math.min(...finalDiffs);
  const maxDiff = Math.max(...finalDiffs);

  const finalMinDeg = Math.round(radToDeg((finalAvg + minDiff + Math.PI * 2) % (Math.PI * 2)));
  const finalMaxDeg = Math.round(radToDeg((finalAvg + maxDiff + Math.PI * 2) % (Math.PI * 2)));

  return {
    twdMin: finalMinDeg,
    twdMax: finalMaxDeg,
    twsPeak: maxTws,
    twsMin: minTws,
    isCalm: false,
    isFuture: false
  };
}
