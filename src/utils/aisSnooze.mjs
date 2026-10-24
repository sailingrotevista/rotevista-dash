// A lost contact must not wake a previously acknowledged encounter merely
// because its timer expires. A fresh received position starts normal evaluation.
export function isThreatSnoozed(target, entry, now) {
  if (!entry) return false;
  if (entry.lostPositionTime !== undefined && !target.contactLost) return false;
  if (target.contactLost) {
    return now < entry.until || target.contactLostAt < entry.until ||
      (entry.lostPositionTime !== undefined && entry.lostPositionTime === target.lastPositionTime);
  }
  return now < entry.until && !(entry.initialRisk === 'ORANGE' && target.risk === 'RED');
}

export function reconcileSnooze(target, entry, now) {
  if (!target || (target.risk !== 'RED' && target.risk !== 'ORANGE')) return null;
  if (entry.lostPositionTime !== undefined && !target.contactLost) return null;
  if (target.contactLost) {
    if ((now < entry.until || target.contactLostAt < entry.until) && entry.lostPositionTime !== target.lastPositionTime) {
      return { ...entry, lostPositionTime: target.lastPositionTime };
    }
    return entry;
  }
  if (entry.initialRisk === 'ORANGE' && target.risk === 'RED') return null;
  if (entry.initialRisk === 'RED' && target.risk === 'ORANGE') return { ...entry, initialRisk: 'ORANGE' };
  return entry;
}
