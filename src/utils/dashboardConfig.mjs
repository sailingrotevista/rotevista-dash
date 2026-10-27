// Configuration arrives as JSON over polling and websocket. Key order does not
// indicate a change; retaining identity avoids restarting React timer effects.
function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

export function mergeDashboardConfig(previous, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return previous;
  const next = { ...previous, ...incoming };
  for (const section of ['alarms', 'graphs', 'averaging', 'scales', 'aisAlerter']) {
    next[section] = { ...previous[section], ...(incoming[section] || {}) };
  }
  return sameValue(previous, next) ? previous : next;
}
