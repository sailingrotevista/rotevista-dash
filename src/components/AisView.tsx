import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AisTarget, HarborCluster } from '../types';

interface AisViewProps {
  targets: AisTarget[];
  harborClusters: HarborCluster[];
  ownShipPosition: { lat: number; lon: number };
  ownShipCourse: { hdg: number; cog: number; sog: number };
  isNightMode: boolean;
  onSwitchToWind: () => void;
  onSnoozeThreat: (targetId: string) => void;
  selectedTargetId: string | null;
  onSelectTarget: (targetId: string | null) => void;
}

export const AisView: React.FC<AisViewProps> = ({
  targets,
  harborClusters,
  ownShipPosition,
  ownShipCourse,
  isNightMode,
  onSwitchToWind,
  onSnoozeThreat,
  selectedTargetId,
  onSelectTarget,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const seamarksLayerRef = useRef<L.TileLayer | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const ringsLayerRef = useRef<L.LayerGroup | null>(null);
  const clustersLayerRef = useRef<L.LayerGroup | null>(null);
  const ownShipMarkerRef = useRef<L.Marker | null>(null);

  const [isFollowBoat, setIsFollowBoat] = useState<boolean>(true);
  const [showListDrawer, setShowListDrawer] = useState<boolean>(false);
  const [selectedTarget, setSelectedTarget] = useState<AisTarget | null>(null);

  // Sync selectedTarget with selectedTargetId or targets updates
  useEffect(() => {
    if (selectedTargetId) {
      const found = targets.find(t => t.id === selectedTargetId);
      if (found) setSelectedTarget(found);
    } else {
      setSelectedTarget(null);
    }
  }, [selectedTargetId, targets]);

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [ownShipPosition.lat, ownShipPosition.lon],
      zoom: 13,
      zoomControl: false,
      attributionControl: false,
    });

    const tileUrl = isNightMode
      ? '/rotevista-tile?provider=esri-dark&z={z}&x={x}&y={y}'
      : '/rotevista-tile?provider=esri-light&z={z}&x={x}&y={y}';

    const tiles = L.tileLayer(tileUrl, {
      maxZoom: 20,
      maxNativeZoom: 16,
    }).addTo(map);
    tileLayerRef.current = tiles;

    const seamarks = L.tileLayer('/rotevista-tile?provider=openseamap&z={z}&x={x}&y={y}', {
      maxZoom: 18,
      opacity: isNightMode ? 0.85 : 0.75,
    }).addTo(map);
    seamarksLayerRef.current = seamarks;

    const ringsGroup = L.layerGroup().addTo(map);
    ringsLayerRef.current = ringsGroup;

    const clustersGroup = L.layerGroup().addTo(map);
    clustersLayerRef.current = clustersGroup;

    const markersGroup = L.layerGroup().addTo(map);
    markersLayerRef.current = markersGroup;

    map.on('dragstart', () => {
      setIsFollowBoat(false);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update base tiles on NightMode toggle
  useEffect(() => {
    if (!mapRef.current || !tileLayerRef.current) return;
    const tileUrl = isNightMode
      ? '/rotevista-tile?provider=esri-dark&z={z}&x={x}&y={y}'
      : '/rotevista-tile?provider=esri-light&z={z}&x={x}&y={y}';
    tileLayerRef.current.setUrl(tileUrl);
    if (seamarksLayerRef.current) {
      seamarksLayerRef.current.setOpacity(isNightMode ? 0.85 : 0.75);
    }
  }, [isNightMode]);

  // Follow boat center
  useEffect(() => {
    if (!mapRef.current || !isFollowBoat) return;
    mapRef.current.panTo([ownShipPosition.lat, ownShipPosition.lon], { animate: true });
  }, [ownShipPosition, isFollowBoat]);

  // Render Range Rings (0.5 NM, 1.0 NM, 2.0 NM, 5.0 NM) around own ship
  useEffect(() => {
    if (!ringsLayerRef.current) return;
    ringsLayerRef.current.clearLayers();

    const center: [number, number] = [ownShipPosition.lat, ownShipPosition.lon];
    const ringRanges = [
      { radiusMeters: 926, label: '0.5 NM' },
      { radiusMeters: 1852, label: '1.0 NM' },
      { radiusMeters: 3704, label: '2.0 NM' },
      { radiusMeters: 9260, label: '5.0 NM' },
    ];

    const ringColor = isNightMode ? '#445566' : '#778899';

    ringRanges.forEach(ring => {
      const circle = L.circle(center, {
        radius: ring.radiusMeters,
        color: ringColor,
        weight: 1,
        dashArray: '3, 6',
        fill: false,
        interactive: false,
      });
      ringsLayerRef.current?.addLayer(circle);

      // Distance tag north of own ship
      const latOffset = (ring.radiusMeters / 111139);
      const tagMarker = L.marker([center[0] + latOffset, center[1]], {
        icon: L.divIcon({
          className: 'range-ring-label',
          html: `<span>${ring.label}</span>`,
          iconSize: [60, 16],
          iconAnchor: [30, 8],
        }),
        interactive: false,
      });
      ringsLayerRef.current?.addLayer(tagMarker);
    });
  }, [ownShipPosition, isNightMode]);

  // Render Harbor Clusters Hulls
  useEffect(() => {
    if (!clustersLayerRef.current) return;
    clustersLayerRef.current.clearLayers();

    harborClusters.forEach(cluster => {
      if (cluster.hull && cluster.hull.length >= 3) {
        const polygon = L.polygon(cluster.hull, {
          color: '#00c3ff',
          weight: 1.5,
          dashArray: '4, 4',
          fillColor: '#00c3ff',
          fillOpacity: 0.12,
        });
        polygon.bindTooltip(`Porto (${cluster.count} unità ormeggiate)`, {
          permanent: false,
          direction: 'center',
          className: 'harbor-cluster-tooltip',
        });
        clustersLayerRef.current?.addLayer(polygon);
      }
    });
  }, [harborClusters]);

  // Render Own Ship & AIS Target Markers
  useEffect(() => {
    if (!mapRef.current || !markersLayerRef.current) return;
    markersLayerRef.current.clearLayers();

    // 1. Own Ship Marker
    const ownHeading = ownShipCourse.hdg || ownShipCourse.cog || 0;
    const ownIconHtml = `
      <div class="own-ship-icon-wrapper" style="transform: rotate(${ownHeading}deg);">
        <svg viewBox="0 0 40 40" width="36" height="36">
          <circle cx="20" cy="20" r="16" fill="rgba(0, 195, 255, 0.2)" stroke="#00c3ff" stroke-width="1.5" />
          <path d="M 20,6 L 27,28 L 20,24 L 13,28 Z" fill="#00c3ff" stroke="#ffffff" stroke-width="1.5" />
          <circle cx="20" cy="20" r="3" fill="#ffffff" />
        </svg>
      </div>
    `;

    const ownMarker = L.marker([ownShipPosition.lat, ownShipPosition.lon], {
      icon: L.divIcon({
        className: 'own-ship-marker',
        html: ownIconHtml,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      }),
      zIndexOffset: 1000,
    });
    ownShipMarkerRef.current = ownMarker;
    markersLayerRef.current.addLayer(ownMarker);

    // Own Ship Heading/Speed Vector (6 min projection)
    if (ownShipCourse.sog >= 0.5) {
      const projDist = (ownShipCourse.sog * 1852) * (6 / 60);
      const projLat = ownShipPosition.lat + (projDist * Math.cos((ownHeading * Math.PI) / 180)) / 111139;
      const projLon =
        ownShipPosition.lon +
        (projDist * Math.sin((ownHeading * Math.PI) / 180)) /
          (111139 * Math.cos((ownShipPosition.lat * Math.PI) / 180));

      const headingLine = L.polyline(
        [
          [ownShipPosition.lat, ownShipPosition.lon],
          [projLat, projLon],
        ],
        {
          color: '#00c3ff',
          weight: 2,
          dashArray: '4, 4',
          opacity: 0.9,
          interactive: false,
        }
      );
      markersLayerRef.current.addLayer(headingLine);
    }

    // 2. Targets Markers
    targets.forEach(t => {
      const isRed = t.risk === 'RED';
      const isOrange = t.risk === 'ORANGE';
      const isSelected = selectedTarget?.id === t.id;

      let color = '#94a3b8'; // GREY default
      if (isRed) color = '#ff2d55';
      else if (isOrange) color = '#ff9500';

      const rotation = t.cog || 0;
      const isMoored = Boolean(t.isMoored || t.anchorState === 'MOORED');
      const isDragging = t.anchorState === 'ANCHOR_DRAGGING';
      const isAnchored = Boolean((t.isAnchored || t.anchorState === 'ANCHORED' || isDragging) && !isMoored);

      let iconSvg = '';
      if (isDragging) {
        iconSvg = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ff2d55" stroke-width="2.2">
            <circle cx="12" cy="12" r="9" fill="rgba(255,45,85,0.25)" stroke="#ff2d55" />
            <path d="M12 7v5M12 16h.01" stroke-linecap="round" />
            <path d="M7 17a5 5 0 0 0 10 0" />
          </svg>
        `;
      } else if (isMoored) {
        iconSvg = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="${color}" stroke-width="2">
            <rect x="4" y="6" width="16" height="12" rx="2" fill="rgba(0,0,0,0.4)" />
            <path d="M8 6V4M16 6V4M4 12h16" />
          </svg>
        `;
      } else if (isAnchored) {
        iconSvg = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="${color}" stroke-width="2">
            <circle cx="12" cy="12" r="8" fill="rgba(0,0,0,0.4)" />
            <path d="M12 6v8M8 10h8M6 14a6 6 0 0 0 12 0" />
          </svg>
        `;
      } else {
        // Arrow/Vessel polygon
        iconSvg = `
          <svg viewBox="0 0 30 30" width="26" height="26">
            <path d="M 15,3 L 23,24 L 15,20 L 7,24 Z" fill="${color}" stroke="#000" stroke-width="1.2" />
          </svg>
        `;
      }

      const pulseHtml = isRed ? `<div class="target-radar-pulse"></div>` : '';
      const selectionRing = isSelected ? `<div class="target-selection-ring"></div>` : '';

      const targetDivHtml = `
        <div class="ais-target-icon-wrap ${isRed ? 'is-danger-threat' : ''} ${isOrange ? 'is-warning-threat' : ''}" style="transform: rotate(${rotation}deg);">
          ${pulseHtml}
          ${selectionRing}
          ${iconSvg}
        </div>
        <div class="ais-target-quick-label ${isRed ? 'label-red' : isOrange ? 'label-orange' : ''}">
          <span class="label-name">${t.name.slice(0, 12)}</span>
          <span class="label-sog">${t.sog.toFixed(1)}kn</span>
        </div>
      `;

      const targetMarker = L.marker([t.lat, t.lon], {
        icon: L.divIcon({
          className: 'ais-target-marker',
          html: targetDivHtml,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        zIndexOffset: isRed ? 800 : isOrange ? 600 : 200,
      });

      targetMarker.on('click', () => {
        setSelectedTarget(t);
        onSelectTarget(t.id);
      });

      markersLayerRef.current?.addLayer(targetMarker);

      // Swing Circle & Anchor rode for anchored vessels (solo se in rada, non in banchina)
      if (isAnchored && !isMoored && (t.anchorCenter || t.swingRadius)) {
        const anchorPt: [number, number] = t.anchorCenter
          ? [t.anchorCenter.lat, t.anchorCenter.lon]
          : [t.lat, t.lon];
        const sRadius = t.anchorCenter?.radius || t.swingRadius || 35;

        const swingCircle = L.circle(anchorPt, {
          radius: sRadius,
          color: isSelected ? '#38bdf8' : (isDragging ? '#ff2d55' : (isRed ? '#ff2d55' : isOrange ? '#ff9500' : '#64748b')),
          weight: isSelected || isDragging ? 1.5 : 1,
          dashArray: isDragging ? '2, 3' : '3, 4',
          fillColor: isSelected ? '#38bdf8' : (isDragging ? 'rgba(255,45,85,0.1)' : 'transparent'),
          fillOpacity: isSelected || isDragging ? 0.08 : 0,
          interactive: false,
        });
        markersLayerRef.current?.addLayer(swingCircle);

        if (t.anchorCenter && (t.anchorCenter.lat !== t.lat || t.anchorCenter.lon !== t.lon)) {
          const rodeLine = L.polyline([[t.anchorCenter.lat, t.anchorCenter.lon], [t.lat, t.lon]], {
            color: isDragging ? '#ff2d55' : '#94a3b8',
            weight: isDragging ? 1.8 : 1.2,
            dashArray: '2, 3',
            opacity: 0.8,
            interactive: false,
          });
          markersLayerRef.current?.addLayer(rodeLine);
        }
      }

      // Target Velocity Vector line (or Dragging Vector line)
      if (isDragging && t.sog >= 0.3) {
        const projDist = (t.sog * 1852) * (10 / 60); // Vettore deriva 10 min
        const projLat = t.lat + (projDist * Math.cos((rotation * Math.PI) / 180)) / 111139;
        const projLon =
          t.lon +
          (projDist * Math.sin((rotation * Math.PI) / 180)) /
            (111139 * Math.cos((t.lat * Math.PI) / 180));

        const driftLine = L.polyline(
          [
            [t.lat, t.lon],
            [projLat, projLon],
          ],
          {
            color: '#ff2d55',
            weight: 2,
            dashArray: '3, 3',
            opacity: 0.9,
            interactive: false,
          }
        );
        markersLayerRef.current?.addLayer(driftLine);
      } else if (!isAnchored && !isMoored && t.sog >= 1.0) {
        const projDist = (t.sog * 1852) * (6 / 60);
        const projLat = t.lat + (projDist * Math.cos((rotation * Math.PI) / 180)) / 111139;
        const projLon =
          t.lon +
          (projDist * Math.sin((rotation * Math.PI) / 180)) /
            (111139 * Math.cos((t.lat * Math.PI) / 180));

        const velLine = L.polyline(
          [
            [t.lat, t.lon],
            [projLat, projLon],
          ],
          {
            color: color,
            weight: 1.5,
            opacity: 0.8,
            interactive: false,
          }
        );
        markersLayerRef.current?.addLayer(velLine);
      }

      // Breadcrumb Trail
      if (t.trail && t.trail.length > 1) {
        const trailPts = t.trail.map(pt => [pt.lat, pt.lon] as [number, number]);
        const trailLine = L.polyline(trailPts, {
          color: color,
          weight: 1,
          dashArray: '2, 4',
          opacity: 0.5,
          interactive: false,
        });
        markersLayerRef.current?.addLayer(trailLine);
      }
    });
  }, [targets, ownShipPosition, ownShipCourse, selectedTarget, onSelectTarget]);

  // Center on Target handler
  const handleCenterOnTarget = useCallback((target: AisTarget) => {
    if (!mapRef.current) return;
    setIsFollowBoat(false);
    mapRef.current.panTo([target.lat, target.lon], { animate: true });
  }, []);

  // Center on Own Ship
  const handleCenterOnOwnShip = useCallback(() => {
    if (!mapRef.current) return;
    setIsFollowBoat(true);
    mapRef.current.panTo([ownShipPosition.lat, ownShipPosition.lon], { animate: true });
  }, [ownShipPosition]);

  // Target summary stats
  const stats = useMemo(() => {
    let redCount = 0;
    let orangeCount = 0;
    let anchoredCount = 0;
    targets.forEach(t => {
      if (t.risk === 'RED') redCount++;
      else if (t.risk === 'ORANGE') orangeCount++;
      if (t.isAnchored || t.sog < 0.5) anchoredCount++;
    });
    return {
      total: targets.length,
      red: redCount,
      orange: orangeCount,
      anchored: anchoredCount,
    };
  }, [targets]);

  // Sorted targets for register drawer
  const sortedTargets = useMemo(() => {
    const list = [...targets];
    const weight = { RED: 3, ORANGE: 2, GREY: 1 };
    return list.sort((a, b) => {
      const wDiff = (weight[b.risk] || 1) - (weight[a.risk] || 1);
      if (wDiff !== 0) return wDiff;
      const da = a.cpa !== null ? a.cpa : a.dist;
      const db = b.cpa !== null ? b.cpa : b.dist;
      return da - db;
    });
  }, [targets]);

  return (
    <div className={`ais-view-container ${isNightMode ? 'night-mode' : 'day-mode'}`}>
      {/* MAP VIEWPORT */}
      <div ref={mapContainerRef} className="ais-leaflet-map" />

      {/* TOP TACTICAL CONTROL BAR */}
      <div className="ais-top-bar">
        {/* CORNER HOTSPOT: SWITCH BACK TO WIND DASHBOARD */}
        <button
          type="button"
          className="ais-hotspot-wind-btn"
          onClick={onSwitchToWind}
          title="Torna alla Dashboard Vento (o swipe a 2 dita)"
        >
          <span className="wind-icon-glyph">💨</span>
          <span className="wind-btn-text">VENTO</span>
        </button>

        {/* STATUS COUNTERS */}
        <div className="ais-status-counters">
          <span className="counter-item counter-total">
            <span className="counter-val">{stats.total}</span>
            <span className="counter-lbl">Navi</span>
          </span>

          {stats.red > 0 && (
            <span className="counter-item counter-danger">
              <span className="counter-val">{stats.red}</span>
              <span className="counter-lbl">Collisione</span>
            </span>
          )}

          {stats.orange > 0 && (
            <span className="counter-item counter-warning">
              <span className="counter-val">{stats.orange}</span>
              <span className="counter-lbl">Incrocio</span>
            </span>
          )}

          <span className="counter-item counter-anchored">
            <span className="counter-val">{stats.anchored}</span>
            <span className="counter-lbl">Fonde</span>
          </span>
        </div>

        {/* TOP RIGHT ACTIONS */}
        <div className="ais-top-actions">
          <button
            type="button"
            className={`ais-tool-btn ${isFollowBoat ? 'btn-active' : ''}`}
            onClick={handleCenterOnOwnShip}
            title="Centra sulla barca"
          >
            🎯
          </button>
          <button
            type="button"
            className={`ais-tool-btn ${showListDrawer ? 'btn-active' : ''}`}
            onClick={() => setShowListDrawer(prev => !prev)}
            title="Registro Bersagli"
          >
            📋
          </button>
        </div>
      </div>

      {/* SELECTED TARGET TELEMETRY DRAWER */}
      {selectedTarget && (
        <div className="ais-telemetry-drawer">
          <div className="drawer-header">
            <div className="drawer-title-group">
              <span className="drawer-flag">{selectedTarget.flag || '🚢'}</span>
              <span className="drawer-name">{selectedTarget.name || selectedTarget.id}</span>
              {selectedTarget.callsign && <span className="drawer-callsign">[{selectedTarget.callsign}]</span>}
              <span className={`drawer-risk-badge risk-${selectedTarget.risk.toLowerCase()}`}>
                {selectedTarget.risk === 'RED'
                  ? 'PERICOLO'
                  : selectedTarget.risk === 'ORANGE'
                  ? 'ATTENZIONE'
                  : 'SICURO'}
              </span>
            </div>
            <button
              type="button"
              className="drawer-close-btn"
              onClick={() => {
                setSelectedTarget(null);
                onSelectTarget(null);
              }}
            >
              ✕
            </button>
          </div>

          <div className="drawer-grid">
            <div className="drawer-cell">
              <span className="d-label">CPA</span>
              <span className="d-val highlight">
                {selectedTarget.cpa !== null
                  ? selectedTarget.cpa < 1852
                    ? `${selectedTarget.cpa} m`
                    : `${(selectedTarget.cpa / 1852).toFixed(2)} NM`
                  : '--'}
              </span>
            </div>
            <div className="drawer-cell">
              <span className="d-label">TCPA</span>
              <span className="d-val highlight">
                {selectedTarget.tcpa !== null && selectedTarget.tcpa >= 0
                  ? `${selectedTarget.tcpa.toFixed(1)} min`
                  : '--'}
              </span>
            </div>
            <div className="drawer-cell">
              <span className="d-label">DISTANZA</span>
              <span className="d-val">
                {selectedTarget.dist < 1852
                  ? `${selectedTarget.dist} m`
                  : `${(selectedTarget.dist / 1852).toFixed(2)} NM`}
              </span>
            </div>
            <div className="drawer-cell">
              <span className="d-label">SOG / COG</span>
              <span className="d-val">
                {selectedTarget.sog.toFixed(1)} kn / {selectedTarget.cog}°
              </span>
            </div>
            <div className="drawer-cell drawer-wide">
              <span className="d-label">RILEVAMENTO</span>
              <span className="d-val">{selectedTarget.sightingTxt || '--'}</span>
            </div>
            {selectedTarget.anchorState === 'ANCHOR_DRAGGING' && (
              <div className="drawer-cell drawer-wide bg-red-950/40 border border-red-500/60 rounded p-1.5">
                <span className="d-label text-red-400 font-bold">ALLARME SPEDO ANCORA</span>
                <span className="d-val text-red-200">
                  Bersaglio in scarroccio ({selectedTarget.sog.toFixed(1)} kn rot. {selectedTarget.cog}°)
                </span>
              </div>
            )}
            {selectedTarget.anchorState === 'MOORED' && (
              <div className="drawer-cell drawer-wide bg-blue-950/20 border border-blue-500/30 rounded p-1.5">
                <span className="d-label text-blue-400">ORMEGGIO BANCHINA</span>
                <span className="d-val text-blue-200">
                  Unità ormeggiata in banchina / finger [MOORED]
                </span>
              </div>
            )}
            {selectedTarget.isAnchored && selectedTarget.anchorState !== 'ANCHOR_DRAGGING' && !selectedTarget.isMoored && (
              <div className="drawer-cell drawer-wide bg-amber-950/20 border border-amber-600/30 rounded p-1.5">
                <span className="d-label text-amber-400">BRANDEGGIO ANCORAGGIO</span>
                <span className="d-val text-amber-200">
                  {selectedTarget.swingRadius ? `Raggio: ${selectedTarget.swingRadius} m` : 'All\'ancora'}
                  {selectedTarget.anchorState ? ` • [${selectedTarget.anchorState}]` : ''}
                </span>
              </div>
            )}
            {(selectedTarget.length || selectedTarget.beam) && (
              <div className="drawer-cell drawer-wide">
                <span className="d-label">DIMENSIONI</span>
                <span className="d-val">
                  {selectedTarget.length ? `L: ${selectedTarget.length.toFixed(1)}m ` : ''}
                  {selectedTarget.beam ? `B: ${selectedTarget.beam.toFixed(1)}m ` : ''}
                  {selectedTarget.draft ? `Pesc: ${selectedTarget.draft.toFixed(1)}m` : ''}
                </span>
              </div>
            )}
            {selectedTarget.destination && (
              <div className="drawer-cell drawer-wide">
                <span className="d-label">DESTINAZIONE</span>
                <span className="d-val">
                  {selectedTarget.destination} {selectedTarget.eta ? `(ETA ${selectedTarget.eta})` : ''}
                </span>
              </div>
            )}
          </div>

          {selectedTarget.crossDir && (
            <div className="drawer-colregs-box">
              <span className="colregs-title">COLREGs-72 Valutazione Rotta:</span>
              <span className="colregs-desc">{selectedTarget.crossDir}</span>
            </div>
          )}

          <div className="drawer-actions">
            <button
              type="button"
              className="drawer-btn btn-center"
              onClick={() => handleCenterOnTarget(selectedTarget)}
            >
              CENTRA SUL BERSAGLIO
            </button>
            {(selectedTarget.risk === 'RED' || selectedTarget.risk === 'ORANGE') && (
              <button
                type="button"
                className="drawer-btn btn-snooze"
                onClick={() => onSnoozeThreat(selectedTarget.id)}
              >
                POSTICIPA 10 MIN
              </button>
            )}
          </div>
        </div>
      )}

      {/* TARGETS REGISTER SLIDE-OUT DRAWER */}
      {showListDrawer && (
        <div className="ais-register-drawer">
          <div className="register-header">
            <h3>Registro Bersagli AIS ({sortedTargets.length})</h3>
            <button type="button" className="drawer-close-btn" onClick={() => setShowListDrawer(false)}>
              ✕
            </button>
          </div>
          <div className="register-list">
            {sortedTargets.map(item => (
              <div
                key={item.id}
                className={`register-item ${item.risk === 'RED' ? 'item-danger' : item.risk === 'ORANGE' ? 'item-warning' : ''}`}
                onClick={() => {
                  setSelectedTarget(item);
                  onSelectTarget(item.id);
                  handleCenterOnTarget(item);
                  setShowListDrawer(false);
                }}
              >
                <div className="reg-row-top">
                  <span className="reg-name">{item.name || item.id}</span>
                  <span className="reg-dist">
                    {item.dist < 1852 ? `${item.dist}m` : `${(item.dist / 1852).toFixed(1)}NM`}
                  </span>
                </div>
                <div className="reg-row-bottom">
                  <span className="reg-sog">{item.sog.toFixed(1)}kn</span>
                  {item.cpa !== null && (
                    <span className="reg-cpa">
                      CPA: {item.cpa < 1852 ? `${item.cpa}m` : `${(item.cpa / 1852).toFixed(1)}NM`}
                    </span>
                  )}
                  {item.tcpa !== null && item.tcpa >= 0 && (
                    <span className="reg-tcpa">TCPA: {item.tcpa.toFixed(1)}m</span>
                  )}
                  <span className={`reg-badge badge-${item.risk.toLowerCase()}`}>{item.risk}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
