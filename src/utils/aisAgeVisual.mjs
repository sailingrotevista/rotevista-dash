export function getAisAgeVisual(t, config, isSelected = false, preserveEmphasis = true) {
  const slowOrMoored = t.sog <= config.movingSpeedKnots || t.isMoored ||
    t.isAnchored || t.inCluster || t.anchorState === 'MOORED' || t.anchorState === 'ANCHORED';
  const thresholds = slowOrMoored ? config.slowOrMoored : config.moving;
  const age = Number.isFinite(t.age) ? Math.max(0, t.age) : 0;
  const stale = config.enabled && age > thresholds.fadeStartSeconds;
  // Inspection must reveal stale data even when the selected target has an alert.
  const protectedTarget = preserveEmphasis && !isSelected && config.preserveAlerts &&
    (t.risk === 'RED' || t.risk === 'ORANGE' || t.anchorState === 'ANCHOR_DRAGGING');
  const duration = Math.max(1, thresholds.fadeEndSeconds - thresholds.fadeStartSeconds);
  const progress = Math.min(1, Math.max(0, (age - thresholds.fadeStartSeconds) / duration));
  const minimum = Math.min(1, Math.max(0, config.minimumOpacity));
  return {
    stale,
    opacity: !config.enabled || protectedTarget ? 1 : 1 - progress * (1 - minimum),
  };
}

