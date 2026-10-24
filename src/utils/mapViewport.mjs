// Largest unobstructed rectangle inside the map, in container pixels.
export function getAvailableMapArea(width, height, overlay, padding = {}, gap = 12) {
  const left = Math.min(width / 2, Math.max(0, padding.left ?? 16));
  const right = Math.max(left, width - Math.max(0, padding.right ?? 16));
  const top = Math.min(height / 2, Math.max(0, padding.top ?? 16));
  const bottom = Math.max(top, height - Math.max(0, padding.bottom ?? 16));
  const area = { left, right, top, bottom };
  if (!overlay || overlay.right <= left || overlay.left >= right || overlay.bottom <= top || overlay.top >= bottom) return area;
  const candidates = [
    { ...area, right: Math.max(left, Math.min(right, overlay.left - gap)) },
    { ...area, left: Math.min(right, Math.max(left, overlay.right + gap)) },
    { ...area, bottom: Math.max(top, Math.min(bottom, overlay.top - gap)) },
    { ...area, top: Math.min(bottom, Math.max(top, overlay.bottom + gap)) },
  ];
  return candidates.reduce((best, next) =>
    (next.right - next.left) * (next.bottom - next.top) > (best.right - best.left) * (best.bottom - best.top) ? next : best);
}

export function getMapCenterOffset(width, height, area) {
  return [width / 2 - (area.left + area.right) / 2, height / 2 - (area.top + area.bottom) / 2];
}
