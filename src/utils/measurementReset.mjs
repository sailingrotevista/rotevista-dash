const CHANNELS = new Set([
  'navigation.position', 'navigation.speedThroughWater', 'navigation.speedOverGround',
  'navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue',
  'environment.depth.belowTransducer', 'environment.wind.speedTrue',
  'environment.wind.directionTrue', 'environment.wind.angleTrueWater',
  'environment.wind.angleApparent', 'environment.wind.speedApparent',
]);

// True means the update was handled (reset) or rejected (out of order).
export function handleMeasurementReset(store, path, value, sourceTime, now) {
  if (!CHANNELS.has(path)) return false;
  const time = Number.isFinite(sourceTime) ? Math.min(now, sourceTime) : now;
  const previous = store.timestamps[path];
  if (Number.isFinite(previous) && (time < previous ||
      (time === previous && store.raw[path] === null))) return true;
  if (value !== null) return false;
  store.raw[path] = null;
  store.timestamps[path] = time;
  const channel = path === 'environment.wind.angleTrueWater' ? 'twa' :
    path === 'environment.wind.angleApparent' ? 'awa' : null;
  if (channel) {
    store.smoothBuf[channel] = [];
    store.longBuf[channel] = [];
  }
  return true;
}

export function shouldApplySessionMeasurement(previous, value, sourceTime) {
  if (!previous) return true;
  const signature = JSON.stringify(value);
  const explicitReset = value === null && signature !== previous.value;
  return Number.isFinite(sourceTime)
    ? sourceTime > previous.time || (sourceTime === previous.time && explicitReset)
    : signature !== previous.value;
}
