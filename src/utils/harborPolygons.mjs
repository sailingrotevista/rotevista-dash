// Keep Leaflet polygons alive across refreshed lists. Non-visual metadata such
// as own distance or vessel count must not invalidate polygon geometry.
export function syncHarborPolygons(registry, group, clusters, isNightMode, createPolygon) {
  const present = new Set();
  for (const cluster of clusters) {
    if (!cluster.hull || cluster.hull.length < 3) continue;
    present.add(cluster.id);
    const color = cluster.kind === 'ANCHORAGE' ? '#f59e0b' : cluster.kind === 'PROVISIONAL' ? '#94a3b8' : '#38bdf8';
    const options = {color, weight:1.2, dashArray:'5, 6', fillColor:color,
      fillOpacity:isNightMode ? 0.12 : 0.08, interactive:false};
    const geometryKey = JSON.stringify(cluster.hull);
    const styleKey = JSON.stringify(options);
    const previous = registry.get(cluster.id);
    if (!previous) {
      const layer = createPolygon(cluster.hull, options);
      group.addLayer(layer);
      registry.set(cluster.id, {layer, geometryKey, styleKey});
    } else {
      if (previous.geometryKey !== geometryKey) {
        previous.layer.setLatLngs(cluster.hull);
        previous.geometryKey = geometryKey;
      }
      if (previous.styleKey !== styleKey) {
        previous.layer.setStyle(options);
        previous.styleKey = styleKey;
      }
    }
  }
  for (const [id, entry] of registry) {
    if (!present.has(id)) {
      group.removeLayer(entry.layer);
      registry.delete(id);
    }
  }
}
