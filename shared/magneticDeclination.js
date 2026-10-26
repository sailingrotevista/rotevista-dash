// Shared offline calculator; inject the bundled WMM library in each environment.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) root.RotevistaDeclination = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDeclinationCalculator(geomagnetism) {
  const RECALCULATE_DISTANCE_METERS = 1000;
  const MODEL_START = Date.UTC(2025, 0, 1);
  const MODEL_END = Date.UTC(2030, 0, 1);
  const cache = new WeakMap();
  const radians = degrees => degrees * Math.PI / 180;
  return function resolveDeclination(raw, now) {
    const p = raw['navigation.position'];
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) ||
        Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180 ||
        !Number.isFinite(now) || now < MODEL_START || now >= MODEL_END) return null;
    const day = Math.floor(now / 86400000);
    const previous = cache.get(raw);
    if (previous && previous.day === day) {
      const a = Math.sin(radians(p.latitude - previous.lat) / 2) ** 2 +
        Math.cos(radians(previous.lat)) * Math.cos(radians(p.latitude)) *
        Math.sin(radians(p.longitude - previous.lon) / 2) ** 2;
      const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
      if (distance < RECALCULATE_DISTANCE_METERS) return previous.value;
    }
    // Explicit WMM2025 validity above avoids extrapolation after 2029.
    // Sea-level altitude is appropriate for this marine application.
    const degrees = geomagnetism.model(new Date(now), { allowOutOfBoundsModel: true })
      .point([p.latitude, p.longitude, 0]).decl;
    const value = Number.isFinite(degrees) ? radians(degrees) : null;
    cache.set(raw, { day, lat: p.latitude, lon: p.longitude, value });
    return value;
  };
});
