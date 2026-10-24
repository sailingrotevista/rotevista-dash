import '../../collisionPipeline.js';

export const compareAisTargets = globalThis.RotevistaCollisionPipeline.compareTargets;
export const BANNER_PRIORITY_HOLD_MS = 10000;

// Risk is still evaluated immediately. Only replacing the displayed contact
// with another contact at the same severity requires a persistent challenger.
export class BannerThreatSelector {
  constructor(holdMs = BANNER_PRIORITY_HOLD_MS) {
    this.holdMs = holdMs;
    this.activeId = null;
    this.pendingId = null;
    this.pendingDeadline = null;
  }

  select(targets, now) {
    const ordered = [...targets].sort(compareAisTargets);
    const best = ordered[0] || null;
    const active = ordered.find(t => t.id === this.activeId);
    const severity = t => t?.risk === 'RED' ? 2 : t?.risk === 'ORANGE' ? 1 : 0;
    const choose = target => {
      this.activeId = target?.id ?? null;
      this.pendingId = null;
      this.pendingDeadline = null;
      return target;
    };
    if (!best || !active || severity(best) > severity(active)) return choose(best);
    if (best.id === active.id) return choose(active);
    if (best.alertKind === 'PROXIMITY' && active.alertKind === 'PROXIMITY') return choose(best);
    if (this.pendingId !== best.id) {
      this.pendingId = best.id;
      this.pendingDeadline = now + this.holdMs;
    }
    if (now >= this.pendingDeadline) return choose(best);
    return active;
  }
}
