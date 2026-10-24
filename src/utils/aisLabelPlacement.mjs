const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

function segmentHitsRect(segment, rect) {
  let start = 0, end = 1;
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
  const p = [-dx, dx, -dy, dy];
  const q = [segment.from.x - rect.left, rect.right - segment.from.x,
    segment.from.y - rect.top, rect.bottom - segment.from.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) start = Math.max(start, t);
      else end = Math.min(end, t);
      if (start > end) return false;
    }
  }
  return true;
}

export function chooseAisLabelPlacement({ anchor, width, height, viewport, obstacles = [], segments = [],
  preferredSide = 'right', previousSide, gap = 18 }) {
  const x = anchor.x, y = anchor.y;
  const positions = [
    ['right', x + gap, y - height / 2], ['left', x - gap - width, y - height / 2],
    ['top', x - width / 2, y - gap - height], ['bottom', x - width / 2, y + gap],
    ['top-right', x + gap, y - gap - height], ['top-left', x - gap - width, y - gap - height],
    ['bottom-right', x + gap, y + gap], ['bottom-left', x - gap - width, y + gap],
  ];
  let best;
  for (const [side, left, top] of positions) {
    const rect = { left, top, right: left + width, bottom: top + height };
    const outsideArea = width * height - overlapArea(rect, viewport);
    let score = outsideArea * 30 + (side === preferredSide ? 0 : 25) +
      (previousSide && side !== previousSide ? 80 : 0);
    for (const obstacle of obstacles) score += overlapArea(rect, obstacle.rect) * (obstacle.weight ?? 1);
    const protectedRect = { left: left - 4, right: rect.right + 4, top: top - 4, bottom: rect.bottom + 4 };
    for (const segment of segments) if (segmentHitsRect(segment, protectedRect)) score += 5000;
    if (!best || score < best.score) best = { side, dx: left - x, dy: top - y, rect, score };
  }
  return best;
}

export function escapeAisLabelText(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
