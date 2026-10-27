const HISTORY_KEYS = ['stw','sog','vmg','depth','tws','aws','twd'];

export function resetDashboardMeasurements(store) {
  store.raw = {};
  store.timestamps = {};
  store.positionExpiresAt = undefined;
  store.gustFilter = {};
  for (const group of [store.histories, store.smoothBuf, store.longBuf, store.graphTempBuf]) {
    for (const key of Object.keys(group)) group[key] = [];
  }
  for (const key of Object.keys(store.lastUpdates)) store.lastUpdates[key] = 0;
  for (const key of ['curAwaRot','curTwaRot','curTrackRot','curWindCompassRot','curBoatCompassRot',
    'smoothedLeeway','lastGybeAlarmTime','emaTwaSin','emaTwaCos','lastTWCompute']) store[key] = 0;
  store.lastGybeSide = null;
  store.firstEmaRun = true;
  store.currentTackLabelMode = 'TACK';
  return historySnapshot(store);
}

export function historySnapshot(store) {
  return Object.fromEntries(HISTORY_KEYS.map(key => [key, [...store.histories[key]]]));
}

export function restoreDashboardHistory(store, history) {
  for (const key of HISTORY_KEYS) {
    if (Array.isArray(history[key])) {
      store.histories[key] = [...history[key]];
      if (store.graphTempBuf) store.graphTempBuf[key] = [];
      if (store.lastUpdates) store.lastUpdates[key] = 0;
      if (store.gustFilter) delete store.gustFilter[key];
    }
  }
  for (const key of ['hdg','cog','twa','awa','twd']) {
    const source = history.rollingAngles?.[key];
    if (Array.isArray(source)) {
      const points = source.filter(p => p && Number.isFinite(p.val) && Number.isFinite(p.time))
        .map(p => ({val:p.val,time:p.time,sin:Math.sin(p.val),cos:Math.cos(p.val)}));
      store.longBuf[key] = points;
      store.smoothBuf[key] = [...points];
    }
  }
  if (Array.isArray(history.twd)) {
    const byTime = new Map((store.longBuf.twd || []).map(p => [p.time, p]));
    for (const p of history.twd) if (p && Number.isFinite(p.val) && Number.isFinite(p.time) && !byTime.has(p.time))
      byTime.set(p.time, {val:p.val,time:p.time,sin:Math.sin(p.val),cos:Math.cos(p.val)});
    store.longBuf.twd = [...byTime.values()].sort((a,b) => a.time-b.time);
  }
  return historySnapshot(store);
}
