import policy from '../../windDataPolicy.json' with { type: 'json' };
// Missing samples never contribute a zero angle or increase the divisor.
export function getCircularAverageFromBuffer(
  bufferArray,
  windowMs,
  signed = false,
  now,
  stabilityThreshold = 0.95,
  stabilityBreakout = 15
) {
  const len = bufferArray.length;
  if (len === 0) return null;

  const currentTime = now ?? Date.now();
  const valid = item => item && Number.isFinite(item.val) && Number.isFinite(item.time) && item.time <= currentTime;
  let newest = len - 1;
  while (newest >= 0 && !valid(bufferArray[newest])) newest--;
  if (newest < 0) return null;
  const newestSampleTime = bufferArray[newest].time;

  // Sensor considered offline at the configured timeout without a valid sample
  if ((currentTime - newestSampleTime) >= policy.headingMaxAgeMs) return null;

  let sSin = 0;
  let sCos = 0;
  let count = 0;

  let pilotSin = 0;
  let pilotCos = 0;
  let pilotSamples = 0;
  for (let i = newest; i >= 0 && pilotSamples < 15; i--) {
    const item = bufferArray[i];
    if (!valid(item)) continue;
    pilotSin += Math.sin(item.val);
    pilotCos += Math.cos(item.val);
    pilotSamples++;
  }
  const pilotRad = Math.atan2(pilotSin, pilotCos);
  const limitRad = stabilityBreakout * (Math.PI / 180);

  for (let i = newest; i >= 0; i--) {
    const item = bufferArray[i];
    if (!valid(item)) continue;
    if ((currentTime - item.time) > windowMs) break;

    const diffRad = Math.atan2(Math.sin(item.val - pilotRad), Math.cos(item.val - pilotRad));
    let finalSin;
    let finalCos;

    if (Math.abs(diffRad) > limitRad) {
      const clampedDiff = Math.sign(diffRad) * limitRad;
      const clampedRad = pilotRad + clampedDiff;
      finalSin = Math.sin(clampedRad);
      finalCos = Math.cos(clampedRad);
    } else {
      finalSin = Math.sin(item.val);
      finalCos = Math.cos(item.val);
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
