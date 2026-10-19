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

const getVesselTypeIcon = (type: number | string, name?: string): string => {
  const tNum = typeof type === 'number' ? type : parseInt(String(type), 10) || 0;
  const n = (name || '').toUpperCase();
  if (tNum === 36 || n.startsWith('S/Y') || n.includes('SAIL') || n.includes('VELA')) return '⛵';
  if (tNum === 30 || n.includes('PESCA') || n.includes('FISH')) return '🎣';
  if (tNum >= 70 && tNum <= 89) return '🚢';
  if (tNum >= 60 && tNum <= 69) return '⛴️';
  if (tNum === 31 || tNum === 32 || n.includes('TUG')) return '⚓';
  if (tNum === 52 || tNum === 50 || n.includes('PILOT') || n.includes('GUARDIA')) return '🚤';
  if (tNum === 37 || n.startsWith('M/Y') || n.includes('YACHT')) return '🛥️';
  return '🛥️';
};

const getVesselTypeLabel = (type: number | string, name?: string): string => {
  const tNum = typeof type === 'number' ? type : parseInt(String(type), 10) || 0;
  const n = (name || '').toUpperCase();
  if (tNum === 36 || n.startsWith('S/Y') || n.includes('SAIL') || n.includes('VELA')) return 'Vela';
  if (tNum === 30 || n.includes('PESCA') || n.includes('FISH')) return 'Pesca';
  if (tNum >= 70 && tNum <= 79) return 'Cargo';
  if (tNum >= 80 && tNum <= 89) return 'Tanker';
  if (tNum >= 60 && tNum <= 69) return 'Passeggeri';
  if (tNum === 37 || n.startsWith('M/Y') || n.includes('YACHT')) return 'Yacht / Motore';
  return 'Motore';
};

const getVesselStatusLabel = (t: AisTarget): string => {
  if (t.anchorState === 'ANCHOR_DRAGGING') return 'IN SPEDO';
  if (t.isMoored || t.anchorState === 'MOORED') return 'IN PORTO';
  if (t.isAnchored || t.anchorState === 'ANCHORED') return 'ALL\'ANCORA';
  if (t.sog < 0.5) return 'FERMO';
  return `${t.sog.toFixed(1)} kn`;
};

const formatDist = (meters: number | null | undefined): string => {
  if (meters === null || meters === undefined) return '--';
  if (meters < 1852) return `${Math.round(meters)}m`;
  return `${(meters / 1852).toFixed(1)} NM`;
};

const formatAge = (seconds: number): string => {
  if (seconds < 10) return 'ADESSO';
  if (seconds < 60) return `${seconds}S FA`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}M FA`;
  const hours = Math.floor(mins / 3600);
  return `${hours}H FA`;
};

type FollowMode = 'own' | 'target' | 'none';

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
  const cardRef = useRef<HTMLDivElement | null>(null);

  const [followMode, setFollowMode] = useState<FollowMode>('own');
  const [showListDrawer, setShowListDrawer] = useState<boolean>(false);
  const [selectedTarget, setSelectedTarget] = useState<AisTarget | null>(null);
  const [targetDetailTab, setTargetDetailTab] = useState<'telemetry' | 'info'>('telemetry');
  const [copiedMmsi, setCopiedMmsi] = useState<boolean>(false);

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
      setFollowMode('none');
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

  // Calcola il centro geografico corretto per posizionare un punto (lat, lon)
  // esattamente nel centro della porzione di schermo libera a sinistra della card
  const getOffsetCenter = useCallback(
    (latLng: [number, number], zoomOverride?: number): L.LatLng => {
      if (!mapRef.current) return L.latLng(latLng[0], latLng[1]);
      const isCardOpen = showListDrawer || Boolean(selectedTarget);
      if (!isCardOpen) {
        return L.latLng(latLng[0], latLng[1]);
      }

      const zoom = zoomOverride !== undefined ? zoomOverride : mapRef.current.getZoom();
      const rect = cardRef.current?.getBoundingClientRect();
      const cardLeft = rect ? rect.left : Math.max(80, window.innerWidth - (360 + 68));
      // Centro della porzione libera a sinistra: cardLeft / 2
      // Centro dello schermo: window.innerWidth / 2
      // Offset pixel da sommare alle coordinate proiettate per centrare nella zona libera:
      const pixelOffsetX = Math.max(0, (window.innerWidth - cardLeft) / 2);

      const targetPoint = mapRef.current.project(latLng, zoom);
      const offsetCenterPoint = targetPoint.add([pixelOffsetX, 0]);
      return mapRef.current.unproject(offsetCenterPoint, zoom);
    },
    [showListDrawer, Boolean(selectedTarget)]
  );

  // Center on Target handler (centrato nella porzione di schermo libera con follow attivo)
  const handleCenterOnTarget = useCallback(
    (target: AisTarget) => {
      if (!mapRef.current) return;
      setFollowMode('target');
      const targetCenter = getOffsetCenter([target.lat, target.lon]);
      mapRef.current.panTo(targetCenter, { animate: true });
    },
    [getOffsetCenter]
  );

  // Center on Own Ship & Contextual Standard Zoom
  const handleCenterOnOwnShip = useCallback(() => {
    if (!mapRef.current) return;
    const currentCenter = mapRef.current.getCenter();
    const currentZoom = mapRef.current.getZoom();
    const targetCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], currentZoom);
    const dLat = Math.abs(currentCenter.lat - targetCenter.lat);
    const dLon = Math.abs(currentCenter.lng - targetCenter.lng);
    const isAlreadyCentered = followMode === 'own' && dLat < 0.0002 && dLon < 0.0002;

    if (!isAlreadyCentered) {
      // 1° Click: ripristina followMode = 'own' e centra mantenendo lo zoom corrente
      setFollowMode('own');
      mapRef.current.panTo(targetCenter, { animate: true });
    } else {
      // 2° Click: zoom standard contestuale alla velocità (fermi/ancora: 16, navigazione: 13)
      const isStoppedOrAnchored = ownShipCourse.sog < 1.0;
      const standardZoom = isStoppedOrAnchored ? 16 : 13;
      const targetZoom = currentZoom === standardZoom ? (standardZoom === 16 ? 13 : 16) : standardZoom;
      const newTargetCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], targetZoom);
      mapRef.current.setView(newTargetCenter, targetZoom, { animate: true });
    }
  }, [ownShipPosition, ownShipCourse, followMode, getOffsetCenter]);

  // Follow Mode: dinamico per propria barca ('own') o bersaglio attivo ('target')
  useEffect(() => {
    if (!mapRef.current || followMode === 'none') return;
    if (followMode === 'own') {
      const targetCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon]);
      mapRef.current.panTo(targetCenter, { animate: true });
    } else if (followMode === 'target' && selectedTarget) {
      const targetCenter = getOffsetCenter([selectedTarget.lat, selectedTarget.lon]);
      mapRef.current.panTo(targetCenter, { animate: true });
    }
  }, [ownShipPosition, selectedTarget, followMode, getOffsetCenter]);

  // Seleziona e insegue il bersaglio quando viene passato o modificato selectedTargetId dall'esterno
  useEffect(() => {
    if (selectedTargetId) {
      const found = targets.find(t => t.id === selectedTargetId);
      if (found) {
        handleCenterOnTarget(found);
      }
    }
  }, [selectedTargetId, handleCenterOnTarget]);

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
        setShowListDrawer(true);
        handleCenterOnTarget(t);
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
  }, [targets, ownShipPosition, ownShipCourse, selectedTarget, onSelectTarget, handleCenterOnTarget]);

  // Zoom handlers
  const handleZoomIn = useCallback(() => {
    if (!mapRef.current) return;
    mapRef.current.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current) return;
    mapRef.current.zoomOut();
  }, []);

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
            className={`ais-tool-btn ${showListDrawer || selectedTarget ? 'btn-active' : ''}`}
            onClick={() => {
              if (selectedTarget) {
                setSelectedTarget(null);
                onSelectTarget(null);
                setShowListDrawer(true);
                setFollowMode('own');
              } else {
                setShowListDrawer(prev => !prev);
              }
            }}
            title="Registro Bersagli AIS"
            aria-label="Registro Bersagli AIS"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '50%', height: '50%' }}>
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* FLOATING TARGETS DROPDOWN CARD (Screenshot 1, 2, 3) */}
      {(showListDrawer || selectedTarget) && (
        <div ref={cardRef} className="ais-dropdown-card">
          {selectedTarget ? (
            /* TARGET DETAIL VIEW (Screenshot 2 & 3) */
            <div className="ais-card-detail">
              <div className="ais-detail-header">
                <button
                  type="button"
                  className="btn-back-lista"
                  onClick={() => {
                    setSelectedTarget(null);
                    onSelectTarget(null);
                    setShowListDrawer(true);
                    setFollowMode('own');
                  }}
                >
                  ← LISTA
                </button>
                <div
                  className="detail-header-center"
                  onClick={() => handleCenterOnTarget(selectedTarget)}
                  style={{ cursor: 'pointer' }}
                  title="Centra e insegui bersaglio"
                >
                  <span className="detail-vessel-icon">
                    {getVesselTypeIcon(selectedTarget.type, selectedTarget.name)}
                  </span>
                  <span className="detail-vessel-name">
                    {selectedTarget.name || selectedTarget.id}
                  </span>
                  <button
                    type="button"
                    className="btn-detail-tab-toggle"
                    onClick={e => {
                      e.stopPropagation();
                      setTargetDetailTab(prev =>
                        prev === 'telemetry' ? 'info' : 'telemetry'
                      );
                    }}
                    title={
                      targetDetailTab === 'telemetry'
                        ? 'Mostra Info e Dimensioni'
                        : 'Mostra Telemetria Cinematica'
                    }
                  >
                    {targetDetailTab === 'telemetry' ? 'ℹ' : '🧭'}
                  </button>
                </div>
                <button
                  type="button"
                  className="ais-card-close-btn"
                  onClick={() => {
                    setSelectedTarget(null);
                    setShowListDrawer(false);
                    onSelectTarget(null);
                    setFollowMode('own');
                  }}
                  title="Chiudi"
                >
                  ✕
                </button>
              </div>

              <div className="ais-detail-sub">
                <span>
                  {getVesselTypeLabel(
                    selectedTarget.type,
                    selectedTarget.name
                  ).toUpperCase()}
                </span>
                <span>•</span>
                <button
                  type="button"
                  className="mmsi-pill"
                  onClick={() => {
                    const mmsi = selectedTarget.id.split(':').pop() || '';
                    if (navigator.clipboard) {
                      navigator.clipboard.writeText(mmsi);
                      setCopiedMmsi(true);
                      setTimeout(() => setCopiedMmsi(false), 2000);
                    }
                  }}
                  title="Clicca per copiare MMSI"
                >
                  📋 MMSI {selectedTarget.id.split(':').pop()}{' '}
                  {copiedMmsi ? '✓' : ''}
                </button>
                <span>•</span>
                <span>⏱️ {formatAge(selectedTarget.age)}</span>
              </div>

              {targetDetailTab === 'telemetry' ? (
                /* TELEMETRIA CINEMATICA (Screenshot 3) */
                <div className="ais-card-body-detail">
                  <div className="ais-detail-grid">
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">SOG / COG</span>
                      <span className="ais-cell-val">
                        {selectedTarget.sog.toFixed(1)} kn @ {selectedTarget.cog}°
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">DISTANZA</span>
                      <span className="ais-cell-val">
                        {formatDist(selectedTarget.dist)}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">CPA MINIMO</span>
                      <span className="ais-cell-val cyan">
                        {formatDist(selectedTarget.cpa)}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">TEMPO A CPA</span>
                      <span className="ais-cell-val cyan">
                        {selectedTarget.tcpa !== null && selectedTarget.tcpa >= 0
                          ? `${selectedTarget.tcpa.toFixed(1)} min`
                          : '--'}
                      </span>
                    </div>
                  </div>

                  {/* SIGHT / RILEVAMENTO A ORE */}
                  <div className="ais-sight-box">
                    <span>👀</span>
                    <span>VISTA: {selectedTarget.sightingTxt || '--'}</span>
                  </div>

                  {selectedTarget.anchorState === 'ANCHOR_DRAGGING' && (
                    <div className="ais-detail-alert-box red">
                      <span className="alert-title">ALLARME SPEDO ANCORA</span>
                      <span className="alert-desc">
                        Bersaglio in scarroccio ({selectedTarget.sog.toFixed(1)} kn rot. {selectedTarget.cog}°)
                      </span>
                    </div>
                  )}

                  {selectedTarget.crossDir && (
                    <div className="ais-detail-alert-box orange">
                      <span className="alert-title">COLREGs-72:</span>
                      <span className="alert-desc">{selectedTarget.crossDir}</span>
                    </div>
                  )}
                </div>
              ) : (
                /* ANAGRAFICA STATICA & DIMENSIONI (Screenshot 2) */
                <div className="ais-card-body-detail">
                  <div className="ais-detail-grid">
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">DIMENSIONI (L × B)</span>
                      <span className="ais-cell-val">
                        {selectedTarget.length ? `${selectedTarget.length.toFixed(0)}m` : '--'} ×{' '}
                        {selectedTarget.beam ? `${selectedTarget.beam.toFixed(0)}m` : '--'}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">PESCAGGIO (DRAFT)</span>
                      <span className="ais-cell-val">
                        {selectedTarget.draft ? `${selectedTarget.draft.toFixed(1)}m` : '--'}
                      </span>
                    </div>
                    <div className="ais-detail-cell cell-wide">
                      <span className="ais-cell-label">DESTINAZIONE & ETA</span>
                      <span className="ais-cell-val cyan">
                        {selectedTarget.destination || 'NON DICHIARATA'}{' '}
                        {selectedTarget.eta ? `(ETA ${selectedTarget.eta})` : ''}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">STATO AIS (CLASSE)</span>
                      <span className="ais-cell-val">
                        {getVesselStatusLabel(selectedTarget)} ({selectedTarget.aisClass || 'B'})
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">RADIO & BANDIERA</span>
                      <span className="ais-cell-val">
                        📻 {selectedTarget.callsign || '--'} • {selectedTarget.flag || '--'}
                      </span>
                    </div>
                  </div>

                  <a
                    href={`https://www.vesselfinder.com/vessels?name=${selectedTarget.id.split(':').pop()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-vesselfinder"
                  >
                    🌐 Vedi Foto su VesselFinder
                  </a>
                </div>
              )}
            </div>
          ) : (
            /* TARGETS LIST VIEW (Screenshot 1) */
            <div className="ais-card-list">
              <div className="ais-card-header">
                <div className="ais-card-title-group">
                  <svg className="ais-card-icon-arrow" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2L19 21L12 17L5 21L12 2Z" />
                  </svg>
                  <span className="ais-card-title">BERSAGLI ({targets.length})</span>
                </div>
                <button
                  type="button"
                  className="ais-card-close-btn"
                  onClick={() => setShowListDrawer(false)}
                  title="Chiudi"
                >
                  ✕
                </button>
              </div>

              <div className="ais-card-body">
                {/* 1. LA MIA BARCA (Highlight Cyan) */}
                <div
                  className="ais-target-item-own"
                  onClick={handleCenterOnOwnShip}
                  title="Centra su Rotavista"
                >
                  <div className="target-left-group">
                    <span className="target-speaking-icon">⛵</span>
                    <div className="target-text-col">
                      <span className="target-item-name">ROTEVISTA (LA TUA BARCA)</span>
                      <span className="target-item-sub">
                        {ownShipCourse.sog < 0.5 ? 'IN PORTO' : 'IN NAVIGAZIONE'} • HDG: {Math.round(ownShipCourse.hdg)}°
                      </span>
                    </div>
                  </div>
                  <div className="target-right-group">
                    <div className="target-sog-val">{ownShipCourse.sog.toFixed(1)} kn</div>
                    <div className="target-sog-lbl">SOG</div>
                  </div>
                </div>

                {/* 2. ALTRI BERSAGLI ORDINATI */}
                {sortedTargets.length > 0 ? (
                  sortedTargets.map(item => (
                    <div
                      key={item.id}
                      className={`ais-target-item ${item.risk === 'RED' ? 'risk-red' : item.risk === 'ORANGE' ? 'risk-orange' : ''}`}
                      onClick={() => {
                        setSelectedTarget(item);
                        onSelectTarget(item.id);
                        handleCenterOnTarget(item);
                      }}
                    >
                      <div className="target-left-group">
                        <span className="target-speaking-icon">
                          {getVesselTypeIcon(item.type, item.name)}
                        </span>
                        <div className="target-text-col">
                          <span className="target-item-name">{item.name || item.id}</span>
                          <span className="target-item-sub">
                            {getVesselTypeLabel(item.type, item.name)} • {getVesselStatusLabel(item)}
                          </span>
                        </div>
                      </div>
                      <div className="target-right-group">
                        <span className="target-dist-val">{formatDist(item.dist)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="ais-empty-targets">
                    <span className="ais-empty-icon">📡</span>
                    <span className="ais-empty-title">Nessun bersaglio AIS rilevato</span>
                    <span className="ais-empty-sub">In ascolto nel raggio di 20 NM...</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* MAP CONTROLS DOCK (VERTICAL CENTER RIGHT) */}
      <div className="ais-map-controls-dock">
        <button
          type="button"
          className="ais-map-btn"
          onClick={handleZoomIn}
          title="Zoom Avanti (+)"
          aria-label="Zoom In"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          type="button"
          className="ais-map-btn"
          onClick={handleZoomOut}
          title="Zoom Indietro (-)"
          aria-label="Zoom Out"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          type="button"
          className={`ais-map-btn ${followMode === 'own' ? 'active-center' : ''}`}
          onClick={handleCenterOnOwnShip}
          title={followMode === 'own' ? 'Centrato su Barca (Click: Zoom Standard)' : 'Ripristina Centro su Tua Barca'}
          aria-label="Centra Mappa"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </div>

      {/* FLOATING ACTION BUTTON: SWITCH TO WIND DASHBOARD (BOTTOM RIGHT) */}
      <button
        type="button"
        className="ais-floating-wind-btn"
        onClick={onSwitchToWind}
        title="Torna alla Dashboard Vento"
        aria-label="Torna alla Dashboard Vento"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
        </svg>
      </button>
    </div>
  );
};
