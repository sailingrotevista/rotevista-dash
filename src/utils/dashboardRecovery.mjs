// Browser suspension may pause interval timers. Request a fresh snapshot on
// visibility, focus and network recovery instead of waiting for those timers.
export function subscribeDashboardRecovery(documentTarget, windowTarget, recover) {
  const resume = () => {
    if (documentTarget.visibilityState === 'visible') recover();
  };
  documentTarget.addEventListener('visibilitychange', resume);
  windowTarget.addEventListener('focus', resume);
  windowTarget.addEventListener('online', resume);
  return () => {
    documentTarget.removeEventListener('visibilitychange', resume);
    windowTarget.removeEventListener('focus', resume);
    windowTarget.removeEventListener('online', resume);
  };
}

// Compare server clock samples, not sensor age: a stopped sensor is not a missed download.
export function historyNeedsRecovery(previous, next, maxGapMs = 5000) {
  return !previous || previous.generation !== next.generation ||
    (Number.isFinite(previous.serverNow) && Number.isFinite(next.serverNow) &&
      next.serverNow - previous.serverNow > maxGapMs);
}

export async function recoverDashboardHistory(requested, load, current, apply) {
  if (requested.mode === 'simulation') return false;
  const history = await load();
  const latest = current();
  if (!history || !latest || latest.generation !== requested.generation || latest.mode === 'simulation') return false;
  apply(history);
  return true;
}
