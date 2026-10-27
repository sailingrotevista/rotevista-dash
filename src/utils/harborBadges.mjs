// Keep the marker and its DOM icon across refreshes. Position and visible
// content are independent: distance and hull changes alone need no badge update.
export function syncHarborBadges(registry, group, clusters, createMarker, createIcon) {
  const present = new Set();
  for (const cluster of clusters) {
    if (!cluster.hull || cluster.hull.length < 3) continue;
    present.add(cluster.id);
    const isAnchorage = cluster.kind === 'ANCHORAGE';
    const isProvisional = cluster.kind === 'PROVISIONAL';
    const label = isAnchorage ? 'Anchorage' : isProvisional ? 'Rest area' : 'Port';
    const color = isAnchorage ? '#f59e0b' : isProvisional ? '#94a3b8' : '#38bdf8';
    const position = cluster.center || [cluster.lat, cluster.lon];
    const positionKey = JSON.stringify(position);
    const html = `<div style="background:rgba(15,23,42,0.88);backdrop-filter:blur(8px);border:1px solid rgba(56,189,248,0.45);border-radius:8px;padding:2px 7px;font-size:9.5px;font-weight:900;font-family:monospace;color:${color};box-shadow:0 4px 12px rgba(0,0,0,0.6);white-space:nowrap;display:inline-flex;align-items:center;gap:4px;pointer-events:none;text-transform:uppercase;"><span>${isAnchorage ? '⚓' : isProvisional ? '◌' : '🏛️'}</span><span>${label} (${cluster.count})</span></div>`;
    const iconOptions = {className:'harbor-cluster-badge-marker', html, iconSize:[96,22], iconAnchor:[48,11]};
    const previous = registry.get(cluster.id);
    if (!previous) {
      const layer = createMarker(position, {icon:createIcon(iconOptions), interactive:false});
      group.addLayer(layer);
      registry.set(cluster.id, {layer, positionKey, contentKey:html});
    } else {
      if (previous.positionKey !== positionKey) {
        previous.layer.setLatLng(position);
        previous.positionKey = positionKey;
      }
      if (previous.contentKey !== html) {
        previous.layer.setIcon(createIcon(iconOptions));
        previous.contentKey = html;
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
