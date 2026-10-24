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

export function isBubblePresence(target) {
  return target?.alertKind === 'PROXIMITY' && target.areaProximityOnly &&
    !target.isMoving && target.motionState !== 'MOVING';
}

// Snapshot the currently known invasions, never a radius or a future contact.
export function acknowledgeCurrentBubble(targets) {
  return Object.fromEntries(targets.filter(isBubblePresence).map(target => [target.id,
    target.proximityArea || { id: target.clusterId || target.id, lat: target.lat, lon: target.lon }]));
}

export function nearestBubblePresence(targets) {
  const clearance = target => Number.isFinite(target.currentHullClearanceMeters)
    ? target.currentHullClearanceMeters : Number.isFinite(target.dist) ? target.dist : Infinity;
  return targets.filter(isBubblePresence).sort((a, b) => clearance(a) - clearance(b) ||
    (a.dist ?? Infinity) - (b.dist ?? Infinity) || String(a.id).localeCompare(String(b.id)))[0] || null;
}
