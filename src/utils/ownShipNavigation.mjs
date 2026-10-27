import { gpsPositionFresh } from './gpsPositionValidity.mjs';
import { freshAwa, freshBoatSpeed, resolveHeading } from './windValidity.mjs';

export function validOwnPosition(value) {
  return value && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 &&
    Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}

export function resolveOwnShipNavigation(raw, times, now, policy, positionExpiresAt) {
  const p = raw['navigation.position'];
  const position = validOwnPosition(p) && gpsPositionFresh(times['navigation.position'],now,positionExpiresAt,policy.positionMaxAgeMs) ? {lat:p.latitude,lon:p.longitude} : null;
  const heading = resolveHeading(raw, times, now, policy);
  const cog = freshAwa(raw['navigation.courseOverGroundTrue'], times['navigation.courseOverGroundTrue'], now, policy.headingMaxAgeMs);
  const sog = freshBoatSpeed(raw['navigation.speedOverGround'], times['navigation.speedOverGround'], now, policy.boatSpeedMaxAgeMs);
  const degrees = angle => angle === null ? null : Math.round(((angle * 180 / Math.PI) % 360 + 360) % 360) % 360;
  return {position, course:{hdg:degrees(heading),cog:degrees(cog),sog:sog === null ? null : Math.round(sog * 1.94384 * 10) / 10}};
}
