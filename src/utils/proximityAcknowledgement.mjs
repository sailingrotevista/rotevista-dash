// Match the current detector's 2 NM local harbor-learning context. This is not
// bubble rearming: leaving/re-entering the bubble never clears acknowledgement.
export const PROXIMITY_CONTEXT_DISTANCE_METERS = 3704;

export function proximityAcknowledgementExpired(entry, target, ownPosition) {
  if (target?.isMoving || target?.motionState === 'MOVING') return true;
  if (!ownPosition || !Number.isFinite(ownPosition.lat) || !Number.isFinite(ownPosition.lon)) return false;
  const dy = (entry.lat - ownPosition.lat) * 111139;
  const dx = (entry.lon - ownPosition.lon) * 111139 * Math.cos((entry.lat + ownPosition.lat) * Math.PI / 360);
  return Math.hypot(dx, dy) > PROXIMITY_CONTEXT_DISTANCE_METERS;
}
