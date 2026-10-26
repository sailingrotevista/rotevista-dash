import geomagnetism from 'geomagnetism';
import '../../shared/magneticDeclination.js';
const resolveDeclination = globalThis.RotevistaDeclination(geomagnetism);

// Zero is a measurement; an absent, invalid or expired sample is not.
export function freshAws(value, timestamp, now, maxAgeMs) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 51.44 &&
    Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp < maxAgeMs ? value : null;
}

export function freshAwa(value, timestamp, now, maxAgeMs) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Math.PI * 2 &&
    Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp < maxAgeMs ? value : null;
}

// The same validated TWS resolver is used by the server for historical weights.
export { resolveTws } from './twdHistory.mjs';

function apparentWindVector(raw, timestamps, now, policy) {
  const aws=freshAws(raw['environment.wind.speedApparent'], timestamps['environment.wind.speedApparent'], now, policy.awsMaxAgeMs);
  const awa=freshAwa(raw['environment.wind.angleApparent'], timestamps['environment.wind.angleApparent'], now, policy.awaMaxAgeMs);
  if (aws === null || awa === null) return null;
  const speed=resolveWindBoatSpeed(raw, timestamps, now, policy);
  return { x: aws*Math.cos(awa)-speed, y: aws*Math.sin(awa) };
}


export function resolveTwa(raw, timestamps, now, policy) {
  const native = freshAwa(raw['environment.wind.angleTrueWater'], timestamps['environment.wind.angleTrueWater'], now, policy.twaNativeMaxAgeMs);
  if (native !== null) return native;
  const vector = apparentWindVector(raw, timestamps, now, policy);
  if (vector === null || Math.hypot(vector.x, vector.y) <= policy.trueWindDirectionMinSpeedMps) return null;
  return Math.atan2(vector.y, vector.x);
}

export function resolveTwd(raw, timestamps, now, policy) {
  const twa = resolveTwa(raw, timestamps, now, policy);
  const compass = resolveHeading(raw, timestamps, now, policy, false);
  const wrap = value => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (compass !== null && twa !== null) return wrap(compass + twa);
  const native = freshAwa(raw['environment.wind.directionTrue'], timestamps['environment.wind.directionTrue'], now, policy.twdNativeMaxAgeMs);
  if (native !== null) return wrap(native);
  const heading = resolveHeading(raw, timestamps, now, policy);
  return heading === null || twa === null ? null : wrap(heading + twa);
}


export function resolveWindBoatSpeed(raw, timestamps, now, policy) {
  return resolveMeasuredBoatSpeed(raw, timestamps, now, policy) ?? 0;
}

export function resolveMeasuredBoatSpeed(raw, timestamps, now, policy) {
  const fresh = path => freshBoatSpeed(raw[path], timestamps[path], now, policy.boatSpeedMaxAgeMs);
  const stw = fresh('navigation.speedThroughWater');
  const sog = fresh('navigation.speedOverGround');
  return stw !== null && !(sog !== null && sog > 0.77 && stw < 0.25) ? stw : sog;
}

export function resolveHeading(raw, timestamps, now, policy, allowCog = true) {
  const fresh = (path, age) => {
    const value = raw[path], time = timestamps[path];
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Math.PI * 2 &&
      Number.isFinite(time) && now-time >= 0 && now-time < age ? value : null;
  };
  const trueHeading = fresh('navigation.headingTrue', policy.headingMaxAgeMs);
  const magnetic = fresh('navigation.headingMagnetic', policy.headingMaxAgeMs);
  if (magnetic !== null) {
    const variation = resolveDeclination(raw, now);
    if (variation !== null) return (magnetic + variation + Math.PI * 2) % (Math.PI * 2);
  }
  if (trueHeading !== null) return trueHeading;
  if (!allowCog) return null;
  const cog = fresh('navigation.courseOverGroundTrue', policy.headingMaxAgeMs);
  const sog = raw['navigation.speedOverGround'], time = timestamps['navigation.speedOverGround'];
  return cog !== null && Number.isFinite(sog) && sog > 0.77 && sog <= 25.72 &&
    Number.isFinite(time) && now-time >= 0 && now-time < policy.boatSpeedMaxAgeMs ? cog : null;
}


export function resolveVmg(raw, timestamps, now, policy) {
  const speed = resolveMeasuredBoatSpeed(raw, timestamps, now, policy);
  const twa = resolveTwa(raw, timestamps, now, policy);
  return speed === null || twa === null ? null : Math.abs(speed * Math.cos(twa));
}


export function freshBoatSpeed(value, time, now, maxAgeMs) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 25.72 &&
    Number.isFinite(time) && now-time >= 0 && now-time < maxAgeMs ? value : null;
}

export function freshDepth(value, time, now, maxAgeMs) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -2 && value <= 500 &&
    Number.isFinite(time) && now-time >= 0 && now-time < maxAgeMs ? value : null;
}

// Compass only: true heading or magnetic corrected by WMM; never COG.
export function resolveLeeway(raw, timestamps, now, policy, minSpeedKnots) {
  const heading = resolveHeading(raw, timestamps, now, policy, false);
  const cog = freshAwa(raw['navigation.courseOverGroundTrue'], timestamps['navigation.courseOverGroundTrue'], now, policy.headingMaxAgeMs);
  const sog = freshBoatSpeed(raw['navigation.speedOverGround'], timestamps['navigation.speedOverGround'], now, policy.boatSpeedMaxAgeMs);
  if (heading === null || cog === null || sog === null) return null;
  if (sog * 1.94384 < minSpeedKnots) return 0;
  return Math.atan2(Math.sin(cog-heading), Math.cos(cog-heading)) * 180 / Math.PI;
}

// Maneuver predictions require live inputs, even while their averages still exist.
export function maneuverValidity(raw, timestamps, now, policy, minSpeedKnots) {
  const moving = ['navigation.speedThroughWater', 'navigation.speedOverGround'].some(path => {
    const speed = freshBoatSpeed(raw[path], timestamps[path], now, policy.boatSpeedMaxAgeMs);
    return speed !== null && speed * 1.94384 > minSpeedKnots;
  });
  const windValid = resolveTwa(raw, timestamps, now, policy) !== null && resolveTwd(raw, timestamps, now, policy) !== null;
  const heading = moving && windValid && resolveHeading(raw, timestamps, now, policy) !== null;
  const cog = heading && freshAwa(raw['navigation.courseOverGroundTrue'], timestamps['navigation.courseOverGroundTrue'], now, policy.headingMaxAgeMs) !== null;
  return { heading, cog };
}
