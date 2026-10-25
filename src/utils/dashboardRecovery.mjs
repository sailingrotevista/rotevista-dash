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
