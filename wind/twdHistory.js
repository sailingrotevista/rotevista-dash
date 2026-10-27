// Shared server/browser rules for the intensity attached to historical TWD samples.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotevistaTwdHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function resolveTws(raw, timestamps, now, policy, normalizedSog, normalizedAws, normalizedStw, normalizedTws) {
    const fresh = (path, maxAge, valid) => {
      const value = raw[path], time = timestamps[path];
      return Number.isFinite(value) && valid(value) && Number.isFinite(time) &&
        now >= time && now-time < maxAge ? value : null;
    };
    const speed = v => v >= 0 && v <= 51.44;
    const native = normalizedTws === undefined ? fresh('environment.wind.speedTrue', policy.twsNativeMaxAgeMs, speed) : normalizedTws;
    if (native !== null) return native;
    const aws = normalizedAws === undefined ? fresh('environment.wind.speedApparent', policy.awsMaxAgeMs, speed) : normalizedAws;
    const awa = fresh('environment.wind.angleApparent', policy.awaMaxAgeMs, v => Math.abs(v) <= Math.PI*2);
    if (aws === null || awa === null) return null;
    const boatSpeed = v => v >= 0 && v <= 25.72;
    const stw = normalizedStw === undefined ? fresh('navigation.speedThroughWater', policy.boatSpeedMaxAgeMs, boatSpeed) : normalizedStw;
    const sog = normalizedSog === undefined ? fresh('navigation.speedOverGround', policy.boatSpeedMaxAgeMs, boatSpeed) : normalizedSog;
    const velocity = (stw !== null && !(sog !== null && sog > 0.77 && stw < 0.25) ? stw : sog) ?? 0;
    return Math.hypot(aws*Math.cos(awa)-velocity, aws*Math.sin(awa));
  }

  function aggregateTwd(points, policy) {
    const samples = points.filter(p => p && Number.isFinite(p.val));
    if (!samples.length) return null;
    // Do not interpret unknown intensity as calm. An incomplete interval uses
    // equal weights for all directions, without an intensity-based rejection.
    const weighted = samples.every(p => Number.isFinite(p.tws) && p.tws >= 0);
    const peak = weighted ? Math.max(...samples.map(p => p.tws)) : null;
    const threshold = weighted ? Math.max(peak * policy.twdPressureFilterRatio, policy.twdCalmThresholdKnots / 1.94384) : null;
    const hasActive = weighted && samples.some(p => p.tws >= threshold);
    const included = hasActive ? samples.filter(p => p.tws >= threshold) : samples;
    let sin = 0, cos = 0;
    for (const p of included) {
      const weight = weighted ? Math.max(p.tws, 0.05) : 1;
      sin += weight * Math.sin(p.val);
      cos += weight * Math.cos(p.val);
    }
    const wrap = angle => ((angle % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
    const val = wrap(Math.atan2(sin, cos));
    const diffs = included.map(p => Math.atan2(Math.sin(p.val-val),Math.cos(p.val-val)));
    return {val, min:wrap(val+Math.min(...diffs)), max:wrap(val+Math.max(...diffs))};
  }
  function historyRetentionMs(channel, historyMinutes, policy) {
    const configured = Number.isFinite(historyMinutes) && historyMinutes > 0 ? historyMinutes : 5;
    const minimum = channel === 'twd' ? policy.twdHistoryMinMinutes : channel === 'tws' ? policy.twsHistoryMinMinutes : 0;
    return Math.max(configured*2, minimum)*60000 + policy.historyRetentionMarginMs;
  }
  return {resolveTws, aggregateTwd, historyRetentionMs};
});
