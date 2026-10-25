// A graph's right edge is the current time, including when its sensor is silent.
export function graphViewport(data, now, durationMs) {
  const start = now - durationMs;
  const points = (data || []).filter(p => p && Number.isFinite(p.val) &&
    Number.isFinite(p.time) && p.time >= start && p.time <= now)
    .sort((a, b) => a.time - b.time);
  return { start, points: points.filter((p, i) => i === 0 || p.time > points[i - 1].time) };
}
