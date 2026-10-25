// Propulsion affects only the gybe sound, not navigation data or AIS alerts.
export function gybeSoundAllowed(mode, twsKnots, sogKnots, absTwaDegrees) {
  if (mode === 'MOTOR' || !Number.isFinite(twsKnots) || !Number.isFinite(sogKnots) || twsKnots <= 7 || sogKnots <= 1) return false;
  const likelyMotoring = absTwaDegrees > 135 && sogKnots > twsKnots * 0.75;
  return mode === 'SAIL' || !likelyMotoring;
}
