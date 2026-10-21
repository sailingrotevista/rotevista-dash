import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AisTarget, HarborCluster, PropulsionMode } from '../types';

interface AisViewProps {
  isActive?: boolean;
  targets: AisTarget[];
  harborClusters: HarborCluster[];
  ownShipPosition: { lat: number; lon: number };
  ownShipCourse: { hdg: number; cog: number; sog: number };
  isNightMode: boolean;
  onSwitchToWind: () => void;
  onSnoozeThreat: (targetId: string) => void;
  selectedTargetId: string | null;
  onSelectTarget: (targetId: string | null) => void;
  ownShipName?: string;
  propulsionMode?: PropulsionMode;
  onSetPropulsionMode?: (mode: PropulsionMode) => void;
  inspectToken?: number;
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
  if (tNum === 36 || n.startsWith('S/Y') || n.includes('SAIL') || n.includes('VELA')) return 'Sailing';
  if (tNum === 30 || n.includes('PESCA') || n.includes('FISH')) return 'Fishing';
  if (tNum >= 70 && tNum <= 79) return 'Cargo';
  if (tNum >= 80 && tNum <= 89) return 'Tanker';
  if (tNum >= 60 && tNum <= 69) return 'Passenger';
  if (tNum === 37 || n.startsWith('M/Y') || n.includes('YACHT')) return 'Yacht / Power';
  return 'Powerboat';
};

const getVesselStatusLabel = (t: AisTarget): string => {
  if (t.anchorState === 'ANCHOR_DRAGGING') return 'DRAGGING ANCHOR';
  if (t.isMoored || t.anchorState === 'MOORED') return 'IN PORT';
  if (t.isAnchored || t.anchorState === 'ANCHORED') return 'AT ANCHOR';
  if (t.sog < 0.5) return 'STOPPED';
  return `${t.sog.toFixed(1)} kn`;
};

const formatDist = (meters: number | null | undefined): string => {
  if (meters === null || meters === undefined) return '--';
  if (meters < 1852) return `${Math.round(meters)}m`;
  return `${(meters / 1852).toFixed(1)} NM`;
};

const formatAge = (seconds: number): string => {
  if (seconds < 10) return 'NOW';
  if (seconds < 60) return `${seconds}S AGO`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}M AGO`;
  const hours = Math.floor(mins / 3600);
  return `${hours}H AGO`;
};

type FollowMode = 'own' | 'target' | 'none';

export const AisView: React.FC<AisViewProps> = React.memo(({
  isActive = true,
  targets,
  harborClusters,
  ownShipPosition,
  ownShipCourse,
  isNightMode,
  onSwitchToWind,
  onSnoozeThreat,
  selectedTargetId,
  onSelectTarget,
  ownShipName = 'MY VESSEL',
  propulsionMode = 'SAIL',
  onSetPropulsionMode,
  inspectToken,
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
  const listBodyRef = useRef<HTMLDivElement | null>(null);
  const listScrollTopRef = useRef<number>(0);
  const cameraSnapshotRef = useRef<{ center: L.LatLng; zoom: number; followMode: FollowMode } | null>(null);
  const onSelectTargetRef = useRef(onSelectTarget);
  useEffect(() => {
    onSelectTargetRef.current = onSelectTarget;
  }, [onSelectTarget]);

  const [followMode, setFollowMode] = useState<FollowMode>('own');
  const [mapZoom, setMapZoom] = useState<number>(16);
  const [showListDrawer, setShowListDrawer] = useState<boolean>(false);
  const [showSupportModal, setShowSupportModal] = useState<boolean>(false);
  const [selectedTarget, setSelectedTarget] = useState<AisTarget | null>(null);
  const [targetDetailTab, setTargetDetailTab] = useState<'telemetry' | 'info'>('telemetry');
  const [copiedMmsi, setCopiedMmsi] = useState<boolean>(false);
  const [ackedLabels, setAckedLabels] = useState<Record<string, string>>({});
  const [propulsionToast, setPropulsionToast] = useState<{ text: string; mode: PropulsionMode } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedTargetRef = useRef<AisTarget | null>(null);
  selectedTargetRef.current = selectedTarget;
  const followModeRef = useRef<FollowMode>('own');
  followModeRef.current = followMode;
  const lastIntendedZoomRef = useRef<number | null>(null);

  // Calcola il centro geografico corretto adattandosi a Desktop (Orizzontale) e Mobile (Verticale)
  const getOffsetCenter = useCallback(
    (latLng: [number, number], zoomOverride?: number): L.LatLng => {
      if (!mapRef.current) return L.latLng(latLng[0], latLng[1]);
      const isCardOpen = showListDrawer || Boolean(selectedTarget);
      if (!isCardOpen) {
        return L.latLng(latLng[0], latLng[1]);
      }

      const zoom = zoomOverride !== undefined ? zoomOverride : mapRef.current.getZoom();
      const rect = cardRef.current?.getBoundingClientRect();
      const isMobilePortrait = window.innerWidth < 640 || window.innerWidth < window.innerHeight;

      let pixelOffsetX = 0;
      let pixelOffsetY = 0;

      if (isMobilePortrait) {
        // Mobile Portrait: la scheda è in alto, posiziona il target al centro della fascia libera inferiore
        const cardBottom = rect ? rect.bottom : 320;
        pixelOffsetY = -Math.max(0, cardBottom / 2);
      } else {
        // Desktop / Landscape: la scheda è a destra, posiziona il target al centro della fascia libera sinistra
        const cardLeft = rect ? rect.left : Math.max(80, window.innerWidth - (360 + 68));
        pixelOffsetX = Math.max(0, (window.innerWidth - cardLeft) / 2);
      }

      const targetPoint = mapRef.current.project(latLng, zoom);
      const offsetCenterPoint = targetPoint.add([pixelOffsetX, pixelOffsetY]);
      return mapRef.current.unproject(offsetCenterPoint, zoom);
    },
    [showListDrawer, Boolean(selectedTarget)]
  );

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
      zoom: 16,
      zoomControl: false,
      attributionControl: false,
    });

    const tileUrl = isNightMode
      ? '/rotevista-tile?provider=esri-dark&z={z}&x={x}&y={y}'
      : '/rotevista-tile?provider=esri-light&z={z}&x={x}&y={y}';

    const tiles = L.tileLayer(tileUrl, { maxZoom: 20, maxNativeZoom: 16 }).addTo(map);
    tileLayerRef.current = tiles;

    const seamarks = L.tileLayer('/rotevista-tile?provider=openseamap&z={z}&x={x}&y={y}', {
      maxZoom: 18,
      opacity: isNightMode ? 0.85 : 0.75,
    }).addTo(map);
    seamarksLayerRef.current = seamarks;

    const getUpstream = (provider: string, c: { z: number; x: number; y: number }) =>
      provider === 'esri-dark'
        ? `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${c.z}/${c.y}/${c.x}`
        : provider === 'esri-light'
          ? `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${c.z}/${c.y}/${c.x}`
          : `https://tiles.openseamap.org/seamark/${c.z}/${c.x}/${c.y}.png`;

    tiles.on('tileerror', (e: any) => {
      const img = e.tile as HTMLImageElement;
      if (img && !img.dataset.fb && e.coords) {
        img.dataset.fb = '1';
        img.src = getUpstream(isNightMode ? 'esri-dark' : 'esri-light', e.coords);
      }
    });

    seamarks.on('tileerror', (e: any) => {
      const img = e.tile as HTMLImageElement;
      if (img && !img.dataset.fb && e.coords) {
        img.dataset.fb = '1';
        img.src = getUpstream('openseamap', e.coords);
      }
    });

    const ringsGroup = L.layerGroup().addTo(map);
    ringsLayerRef.current = ringsGroup;

    const clustersGroup = L.layerGroup().addTo(map);
    clustersLayerRef.current = clustersGroup;

    const markersGroup = L.layerGroup().addTo(map);
    markersLayerRef.current = markersGroup;

    map.on('dragstart', () => {
      lastIntendedZoomRef.current = null;
      setFollowMode('none');
      followModeRef.current = 'none';
    });
    map.on('wheel', () => {
      lastIntendedZoomRef.current = null;
      setFollowMode('none');
      followModeRef.current = 'none';
    });
    map.on('click', () => {
      lastIntendedZoomRef.current = null;
      if (selectedTargetRef.current && followModeRef.current === 'none') {
        setSelectedTarget(null);
        onSelectTargetRef.current(null);
        setShowListDrawer(false);
      } else {
        setFollowMode('none');
        followModeRef.current = 'none';
      }
    });
    map.on('zoomend', () => setMapZoom(Math.round(map.getZoom())));

    const mapEl = mapContainerRef.current;
    const handleTouchInteraction = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        lastIntendedZoomRef.current = null;
        setFollowMode('none');
        followModeRef.current = 'none';
      }
    };
    mapEl?.addEventListener('touchstart', handleTouchInteraction, { passive: true });

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          map.invalidateSize();
        }
      }
    });
    if (mapContainerRef.current) {
      resizeObserver.observe(mapContainerRef.current);
    }

    mapRef.current = map;

    return () => {
      mapEl?.removeEventListener('touchstart', handleTouchInteraction);
      resizeObserver.disconnect();
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

  // Gestione rientro da altra vista e reset dopo 5 minuti di inattività
  const lastLeaveTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    if (isActive) {
      mapRef.current.invalidateSize();
      const now = Date.now();
      const elapsedMs = lastLeaveTimeRef.current ? now - lastLeaveTimeRef.current : 0;

      if (elapsedMs >= 5 * 60 * 1000) {
        // Trascorsi 5 minuti o più: Reset centro barca e zoom contestuale
        setSelectedTarget(null);
        onSelectTarget(null);
        setShowListDrawer(false);
        setFollowMode('own');

        const isInHarbor = harborClusters.some(c => c.dist < 500);
        const isStoppedOrAnchored = ownShipCourse.sog < 1.0 || isInHarbor;
        const standardZoom = isStoppedOrAnchored ? 16 : 13;
        const center = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], standardZoom);
        mapRef.current.setView(center, standardZoom, { animate: false });
      }
      lastLeaveTimeRef.current = null;
    } else if (lastLeaveTimeRef.current === null) {
      lastLeaveTimeRef.current = Date.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Center on Target handler (centrato nella porzione di schermo libera con follow attivo)
  const handleCenterOnTarget = useCallback(
    (target: AisTarget) => {
      if (!mapRef.current) return;
      if (!cameraSnapshotRef.current) {
        cameraSnapshotRef.current = {
          center: mapRef.current.getCenter(),
          zoom: mapRef.current.getZoom(),
          followMode,
        };
      }
      setFollowMode('target');
      const targetCenter = getOffsetCenter([target.lat, target.lon]);
      mapRef.current.panTo(targetCenter, { animate: true });
    },
    [getOffsetCenter, followMode]
  );

  // Smart zoom per inquadrare il triangolo di collisione nello spazio visibile disponibile
  const zoomToCollisionTriangle = useCallback(
    (target: AisTarget) => {
      if (!mapRef.current) return;

      const deg2rad = Math.PI / 180;
      const ownLat = ownShipPosition.lat;
      const ownLon = ownShipPosition.lon;
      const targetLat = target.lat;
      const targetLon = target.lon;

      const pts: [number, number][] = [
        [ownLat, ownLon],
        [targetLat, targetLon],
      ];

      const tcpa = target.tcpa;
      if (tcpa !== null && tcpa !== undefined && tcpa > 0) {
        const ownDistNM = (ownShipCourse.sog * tcpa) / 60;
        const ownCpaLat = ownLat + (ownDistNM * Math.cos(ownShipCourse.cog * deg2rad)) / 60;
        const ownCpaLon =
          ownLon +
          (ownDistNM * Math.sin(ownShipCourse.cog * deg2rad)) / (60 * Math.cos(ownLat * deg2rad));

        const targetDistNM = (target.sog * tcpa) / 60;
        const targetCpaLat = targetLat + (targetDistNM * Math.cos(target.cog * deg2rad)) / 60;
        const targetCpaLon =
          targetLon +
          (targetDistNM * Math.sin(target.cog * deg2rad)) / (60 * Math.cos(targetLat * deg2rad));

        pts.push([ownCpaLat, ownCpaLon]);
        pts.push([targetCpaLat, targetCpaLon]);
      }

      const bounds = L.latLngBounds(pts);
      const isMobilePortrait = window.innerWidth < 640 || window.innerWidth < window.innerHeight;

      let paddingTopLeft: [number, number] = [60, 100];
      let paddingBottomRight: [number, number] = [60, 60];

      if (isMobilePortrait) {
        paddingTopLeft = [40, 260];
        paddingBottomRight = [40, 60];
      } else {
        paddingTopLeft = [60, 100];
        paddingBottomRight = [390, 60];
      }

      setFollowMode('none');
      mapRef.current.fitBounds(bounds, {
        paddingTopLeft,
        paddingBottomRight,
        animate: true,
        maxZoom: 16,
      });
    },
    [ownShipPosition, ownShipCourse]
  );

  // Ripristina inquadratura mappa e posizione scroll lista al ritorno dal dettaglio
  const handleReturnToList = useCallback(() => {
    const prevTargetId = selectedTarget?.id;
    setSelectedTarget(null);
    onSelectTarget(null);
    setShowListDrawer(true);
    if (cameraSnapshotRef.current && mapRef.current) {
      const snap = cameraSnapshotRef.current;
      cameraSnapshotRef.current = null;
      setFollowMode(snap.followMode);
      mapRef.current.setView(snap.center, snap.zoom, { animate: true });
    } else {
      setFollowMode('own');
    }
    requestAnimationFrame(() => {
      if (prevTargetId) {
        const targetEl = document.getElementById(`target-item-${prevTargetId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return;
        }
      }
      if (listBodyRef.current) {
        listBodyRef.current.scrollTop = listScrollTopRef.current;
      }
    });
  }, [selectedTarget, onSelectTarget]);

  // Center on Own Ship & Contextual Standard Zoom
  const handleCenterOnOwnShip = useCallback(() => {
    if (!mapRef.current) return;

    if (selectedTarget) {
      setSelectedTarget(null);
      onSelectTarget(null);
    }

    const map = mapRef.current;
    const isInHarbor = harborClusters.some(c => c.dist < 500);
    const isStoppedOrAnchored = ownShipCourse.sog < 1.0 || isInHarbor;
    const standardZoom = isStoppedOrAnchored ? 16 : 13;
    const alternateZoom = standardZoom === 16 ? 13 : 16;

    if (followModeRef.current !== 'own') {
      // 1° Click: ripristina followMode = 'own' e centra arrotondando lo zoom a intero
      const nextZoom = Math.round(map.getZoom());
      lastIntendedZoomRef.current = nextZoom;
      setFollowMode('own');
      followModeRef.current = 'own';
      lastFollowPosRef.current = { lat: ownShipPosition.lat, lon: ownShipPosition.lon, mode: 'own' };
      const newTargetCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], nextZoom);
      map.setView(newTargetCenter, nextZoom, { animate: true });
    } else {
      // 2° e 3° Click: zoom standard contestuale (16 porto/fermi, 13 navigazione) o toggle tra 13 e 16
      const effectiveZoom = lastIntendedZoomRef.current ?? Math.round(map.getZoom());
      const targetZoom = effectiveZoom === standardZoom ? alternateZoom : standardZoom;
      lastIntendedZoomRef.current = targetZoom;
      setFollowMode('own');
      followModeRef.current = 'own';
      lastFollowPosRef.current = { lat: ownShipPosition.lat, lon: ownShipPosition.lon, mode: 'own' };
      const newTargetCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], targetZoom);
      map.setView(newTargetCenter, targetZoom, { animate: true });
    }
  }, [ownShipPosition, ownShipCourse, harborClusters, getOffsetCenter, selectedTarget, onSelectTarget]);

  // Follow Mode: progressivo con soglia di movimento (~20px) per evitare traslazioni ad ogni refresh
  const lastFollowPosRef = useRef<{ lat: number; lon: number; mode: FollowMode; targetId?: string } | null>(null);

  useEffect(() => {
    if (!isActive || !mapRef.current || followMode === 'none') {
      if (followMode === 'none') lastFollowPosRef.current = null;
      return;
    }

    const pos = followMode === 'own'
      ? [ownShipPosition.lat, ownShipPosition.lon] as [number, number]
      : selectedTarget
        ? [selectedTarget.lat, selectedTarget.lon] as [number, number]
        : null;

    if (!pos) return;

    const map = mapRef.current;
    const targetCenter = getOffsetCenter(pos);
    const modeKey = followMode;
    const currentTargetId = selectedTarget?.id;

    const hasModeChanged =
      !lastFollowPosRef.current ||
      lastFollowPosRef.current.mode !== modeKey ||
      lastFollowPosRef.current.targetId !== currentTargetId;

    if (hasModeChanged) {
      lastFollowPosRef.current = { lat: pos[0], lon: pos[1], mode: modeKey, targetId: currentTargetId };
      map.panTo(targetCenter, { animate: true });
      return;
    }

    // Calcola la distanza in pixel accumulata rispetto all'ultima posizione in cui la mappa è stata centrata
    const lastPt = map.latLngToContainerPoint([lastFollowPosRef.current.lat, lastFollowPosRef.current.lon]);
    const currentPt = map.latLngToContainerPoint(pos);
    const pixelDistance = Math.hypot(currentPt.x - lastPt.x, currentPt.y - lastPt.y);

    // Soglia di movimento sulla mappa (100px): trasla lo sfondo solo quando lo scostamento supera i 100 pixel
    if (pixelDistance > 100) {
      lastFollowPosRef.current = { lat: pos[0], lon: pos[1], mode: modeKey, targetId: currentTargetId };
      map.panTo(targetCenter, { animate: true, duration: 2.0, easeLinearity: 0.25 });
    }
  }, [isActive, ownShipPosition.lat, ownShipPosition.lon, selectedTarget?.lat, selectedTarget?.lon, followMode, selectedTarget?.id, getOffsetCenter]);

  // Seleziona e inquadra con smart zoom il triangolo di collisione quando cambia inspectToken o selectedTargetId dall'esterno
  const prevInspectTokenRef = useRef<number | undefined>(undefined);
  const prevSelectedTargetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const isTokenUpdate = inspectToken !== undefined && inspectToken !== prevInspectTokenRef.current;
    const isTargetChange = selectedTargetId !== null && selectedTargetId !== prevSelectedTargetIdRef.current;

    if (isTokenUpdate || isTargetChange) {
      const found = targets.find(t => t.id === selectedTargetId);
      if (found) {
        setSelectedTarget(found);
        setShowListDrawer(true);
        if (found.risk === 'RED' || found.risk === 'ORANGE' || isTokenUpdate) {
          zoomToCollisionTriangle(found);
        } else {
          handleCenterOnTarget(found);
        }
      }
    }
    prevInspectTokenRef.current = inspectToken;
    prevSelectedTargetIdRef.current = selectedTargetId;
  }, [selectedTargetId, inspectToken, targets, handleCenterOnTarget, zoomToCollisionTriangle]);

  // Deselezione automatica con debounce di 2s se il bersaglio esce dalla mappa visibile e follow non è attivo
  const outOfBoundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!selectedTarget || followMode !== 'none' || !mapRef.current) {
      if (outOfBoundsTimerRef.current) {
        clearTimeout(outOfBoundsTimerRef.current);
        outOfBoundsTimerRef.current = null;
      }
      return;
    }

    const map = mapRef.current;
    const targetPos: [number, number] = [selectedTarget.lat, selectedTarget.lon];

    const checkOutOfBounds = () => {
      if (!mapRef.current) return;
      const bounds = mapRef.current.getBounds();
      const isTargetInBounds = bounds.contains(targetPos);

      if (!isTargetInBounds) {
        // Avvia il timer solo se non è già attivo
        if (!outOfBoundsTimerRef.current) {
          outOfBoundsTimerRef.current = setTimeout(() => {
            outOfBoundsTimerRef.current = null;
            if (!mapRef.current || !selectedTarget) return;
            const currentBounds = mapRef.current.getBounds();
            if (!currentBounds.contains([selectedTarget.lat, selectedTarget.lon])) {
              setSelectedTarget(null);
              onSelectTarget(null);
              setShowListDrawer(false);
            }
          }, 2000);
        }
      } else {
        // Se il bersaglio rientra nei confini visibili, annulla il timer
        if (outOfBoundsTimerRef.current) {
          clearTimeout(outOfBoundsTimerRef.current);
          outOfBoundsTimerRef.current = null;
        }
      }
    };

    checkOutOfBounds();
    map.on('moveend', checkOutOfBounds);

    return () => {
      map.off('moveend', checkOutOfBounds);
    };
  }, [selectedTarget?.id, selectedTarget?.lat, selectedTarget?.lon, followMode, onSelectTarget]);



  // Render Dynamic Range Rings (scaling from 15m at zoom 19+ up to unlimited NM on zoom out)
  useEffect(() => {
    if (!isActive || !ringsLayerRef.current) return;
    ringsLayerRef.current.clearLayers();

    const center: [number, number] = selectedTarget
      ? [selectedTarget.lat, selectedTarget.lon]
      : [ownShipPosition.lat, ownShipPosition.lon];

    let ringRanges: Array<{ radiusMeters: number; label: string }> = [];
    if (mapZoom >= 19) {
      ringRanges = [{ radiusMeters: 15, label: '15m' }, { radiusMeters: 30, label: '30m' }, { radiusMeters: 45, label: '45m' }];
    } else if (mapZoom === 18) {
      ringRanges = [{ radiusMeters: 25, label: '25m' }, { radiusMeters: 50, label: '50m' }, { radiusMeters: 75, label: '75m' }];
    } else if (mapZoom === 17) {
      ringRanges = [{ radiusMeters: 50, label: '50m' }, { radiusMeters: 100, label: '100m' }, { radiusMeters: 150, label: '150m' }];
    } else if (mapZoom === 16) {
      ringRanges = [{ radiusMeters: 100, label: '100m' }, { radiusMeters: 200, label: '200m' }, { radiusMeters: 300, label: '300m' }];
    } else if (mapZoom === 15) {
      ringRanges = [{ radiusMeters: 250, label: '250m' }, { radiusMeters: 500, label: '500m' }, { radiusMeters: 750, label: '750m' }];
    } else if (mapZoom === 14) {
      ringRanges = [{ radiusMeters: 500, label: '500m' }, { radiusMeters: 926, label: '0.5 NM' }, { radiusMeters: 1852, label: '1 NM' }];
    } else if (mapZoom === 13) {
      ringRanges = [{ radiusMeters: 926, label: '0.5 NM' }, { radiusMeters: 1852, label: '1 NM' }, { radiusMeters: 3704, label: '2 NM' }];
    } else if (mapZoom === 12) {
      ringRanges = [{ radiusMeters: 1852, label: '1 NM' }, { radiusMeters: 3704, label: '2 NM' }, { radiusMeters: 9260, label: '5 NM' }];
    } else {
      const baseNm = Math.round(2 * Math.pow(2, 11 - Math.max(2, mapZoom)));
      ringRanges = [baseNm, baseNm * 2, baseNm * 4].map(nm => ({
        radiusMeters: nm * 1852,
        label: `${nm} NM`,
      }));
    }

    const ringColor = selectedTarget ? '#06b6d4' : (isNightMode ? '#38bdf8' : '#0369a1');

    ringRanges.forEach(ring => {
      const circle = L.circle(center, {
        radius: ring.radiusMeters,
        color: ringColor,
        weight: selectedTarget ? 1.6 : 1.2,
        opacity: isNightMode ? 0.65 : 0.75,
        dashArray: selectedTarget ? '6, 6' : '4, 7',
        fill: false,
        interactive: false,
      });
      ringsLayerRef.current?.addLayer(circle);

      const latOffset = ring.radiusMeters / 111139;
      const tagMarker = L.marker([center[0] + latOffset, center[1]], {
        icon: L.divIcon({
          className: 'range-ring-label',
          html: `<span>${ring.label}</span>`,
          iconSize: [64, 16],
          iconAnchor: [32, 8],
        }),
        interactive: false,
      });
      ringsLayerRef.current?.addLayer(tagMarker);
    });
  }, [isActive, ownShipPosition, selectedTarget, mapZoom, isNightMode]);

  // Render Harbor Clusters Hulls
  useEffect(() => {
    if (!isActive || !clustersLayerRef.current) return;
    clustersLayerRef.current.clearLayers();

    harborClusters.forEach(cluster => {
      if (cluster.hull && cluster.hull.length >= 3) {
        const polygon = L.polygon(cluster.hull, {
          color: '#38bdf8',
          weight: 1.2,
          dashArray: '5, 6',
          fillColor: '#0284c7',
          fillOpacity: isNightMode ? 0.12 : 0.08,
          interactive: false,
        });
        clustersLayerRef.current?.addLayer(polygon);

        const centerPt: [number, number] = cluster.center || [cluster.lat, cluster.lon];
        const badgeMarker = L.marker(centerPt, {
          icon: L.divIcon({
            className: 'harbor-cluster-badge-marker',
            html: `<div style="background:rgba(15,23,42,0.88);backdrop-filter:blur(8px);border:1px solid rgba(56,189,248,0.45);border-radius:8px;padding:2px 7px;font-size:9.5px;font-weight:900;font-family:monospace;color:#38bdf8;box-shadow:0 4px 12px rgba(0,0,0,0.6);white-space:nowrap;display:inline-flex;align-items:center;gap:4px;pointer-events:none;text-transform:uppercase;"><span>🏛️</span><span>Port (${cluster.count})</span></div>`,
            iconSize: [96, 22],
            iconAnchor: [48, 11],
          }),
          interactive: false,
        });
        clustersLayerRef.current?.addLayer(badgeMarker);
      }
    });
  }, [isActive, harborClusters, isNightMode]);

  // Render Own Ship & AIS Target Markers
  useEffect(() => {
    if (!isActive || !mapRef.current || !markersLayerRef.current) return;
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

    const isOwnDimmed = Boolean(selectedTarget);
    const ownMarker = L.marker([ownShipPosition.lat, ownShipPosition.lon], {
      opacity: isOwnDimmed ? 0.35 : 1.0,
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
          opacity: isOwnDimmed ? 0.25 : 0.9,
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

      // Colorazione MarineTraffic in base alla tipologia AIS (con sovrascrittura in caso di allarme)
      let mtFill = '#94a3b8';
      let mtStroke = '#334155';

      if (isRed) {
        mtFill = '#ff2d55';
        mtStroke = '#991b1b';
      } else if (isOrange) {
        mtFill = '#ff9500';
        mtStroke = '#c2410c';
      } else {
        const tNum = typeof t.type === 'number' ? t.type : parseInt(String(t.type), 10) || 0;
        const nameUpper = (t.name || '').toUpperCase();
        if ((tNum >= 60 && tNum <= 69) || nameUpper.includes('FERRY') || nameUpper.includes('PASSEGGERI')) {
          mtFill = '#2563eb'; mtStroke = '#1d4ed8'; // Blu Passeggeri
        } else if (tNum >= 70 && tNum <= 79) {
          mtFill = '#22c55e'; mtStroke = '#15803d'; // Verde Cargo
        } else if (tNum >= 80 && tNum <= 89) {
          mtFill = '#ef4444'; mtStroke = '#991b1b'; // Rosso Tanker
        } else if (tNum === 36 || tNum === 37 || nameUpper.startsWith('S/Y') || nameUpper.startsWith('M/Y') || nameUpper.includes('YACHT') || nameUpper.includes('SAIL')) {
          mtFill = '#d946ef'; mtStroke = '#a21caf'; // Magenta/Viola Yacht & Vela
        } else if (tNum === 30 || nameUpper.includes('PESCA') || nameUpper.includes('FISH') || nameUpper.startsWith('M/P')) {
          mtFill = '#f97316'; mtStroke = '#c2410c'; // Arancione Pesca
        } else if (tNum === 31 || tNum === 32 || (tNum >= 50 && tNum <= 59) || nameUpper.includes('TUG') || nameUpper.includes('PILOT')) {
          mtFill = '#06b6d4'; mtStroke = '#0e7490'; // Ciano Rimorchiatori / Servizio
        }
      }

      const color = mtFill;
      const rotation = t.cog || 0;
      const isMoored = Boolean(t.isMoored || t.anchorState === 'MOORED');
      const isDragging = t.anchorState === 'ANCHOR_DRAGGING';
      const isAnchored = Boolean((t.isAnchored || t.anchorState === 'ANCHORED' || isDragging) && !isMoored);
      const isClusterStationary = Boolean(t.inCluster && !t.isMoving && !isDragging);

      let iconSvg = '';
      if (isDragging) {
        iconSvg = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ff2d55" stroke-width="2.2">
            <circle cx="12" cy="12" r="9" fill="rgba(255,45,85,0.25)" stroke="#ff2d55" />
            <path d="M12 7v5M12 16h.01" stroke-linecap="round" />
            <path d="M7 17a5 5 0 0 0 10 0" />
          </svg>
        `;
      } else if (isClusterStationary || isMoored || isAnchored || !t.isMoving) {
        const dotBorder = isSelected ? '2px solid #22d3ee' : `1.5px solid ${mtStroke}`;
        const dotBg = isSelected ? '#22d3ee' : mtFill;
        iconSvg = `<div style="width:10px;height:10px;border-radius:50%;background:${dotBg};border:${dotBorder};box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`;
      } else {
        // Freccia direzionale affilata MarineTraffic
        iconSvg = `
          <svg viewBox="0 0 30 30" width="28" height="28">
            <path d="M 15,2 L 25,25 L 15,19 L 5,25 Z" fill="${mtFill}" stroke="${mtStroke}" stroke-width="1.8" stroke-linejoin="round" />
          </svg>
        `;
      }

      const pulseHtml = isRed ? `<div class="target-radar-pulse"></div>` : '';
      const selectionRing = isSelected ? `<div class="target-selection-ring"></div>` : '';

      const targetDivHtml = `
        <div class="ais-target-icon-wrap ${isRed ? 'is-danger-threat' : ''} ${isOrange ? 'is-warning-threat' : ''}" style="transform: rotate(${isClusterStationary ? 0 : rotation}deg);">
          ${pulseHtml}
          ${selectionRing}
          ${iconSvg}
        </div>
      `;

      const isDimmed = Boolean(selectedTarget && selectedTarget.id !== t.id);

      const targetMarker = L.marker([t.lat, t.lon], {
        opacity: isDimmed ? 0.35 : 1.0,
        icon: L.divIcon({
          className: 'ais-target-marker',
          html: targetDivHtml,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        zIndexOffset: isSelected ? 1000 : isRed ? 800 : isOrange ? 600 : 200,
      });

      targetMarker.on('click', () => {
        setAckedLabels(prev => {
          if (!prev[t.id]) return prev;
          const next = { ...prev };
          delete next[t.id];
          return next;
        });
        setSelectedTarget(t);
        onSelectTarget(t.id);
        setShowListDrawer(true);
        handleCenterOnTarget(t);
      });

      markersLayerRef.current?.addLayer(targetMarker);

      // Etichetta flottante laterale
      const ackedRisk = ackedLabels[t.id];
      const isAcked = Boolean(ackedRisk && !(ackedRisk === 'ORANGE' && isRed));
      const shouldShowFloatingLabel = !isAcked && !(t.inCluster && !t.isMoving && !isSelected) && (isRed || isOrange || isSelected);

      if (shouldShowFloatingLabel) {
        const titleColor = isRed ? '#dc2626' : isOrange ? '#ea580c' : '#0f172a';
        const metricColor = isRed ? '#dc2626' : isOrange ? '#ea580c' : '#0284c7';
        const borderColor = isRed ? 'rgba(220,38,38,0.55)' : isOrange ? 'rgba(234,88,12,0.55)' : 'rgba(2,132,199,0.55)';
        const isTargetMoving = t.isMoving !== undefined ? t.isMoving : (!t.isAnchored && !isMoored && t.sog >= 0.3);
        const statusLine = isTargetMoving ? `${t.sog.toFixed(1)} kn • ${Math.round(t.cog)}°` : (t.inCluster || isMoored ? 'IN PORT' : "AT ANCHOR");
        const tcpaTxt = t.tcpa !== null && t.tcpa !== undefined && t.tcpa >= 0 ? ` in ${Math.round(t.tcpa)} min` : '';
        const cpaOrDistLine = isRed
          ? `🚨 ${t.riskMsg || 'COLLISION!'}${t.cpa !== null && t.cpa !== undefined ? ` • CPA: ${formatDist(t.cpa)}` : ''}${tcpaTxt}`
          : `${isOrange ? '⚠️ ' : ''}${t.cpa !== null && t.cpa !== undefined ? `CPA: ${formatDist(t.cpa)}` : `Dist: ${formatDist(t.dist)}`}${tcpaTxt}`;

        const labelMarker = L.marker([t.lat, t.lon], {
          opacity: isDimmed ? 0.35 : 1.0,
          icon: L.divIcon({
            className: 'ais-threat-floating-label',
            html: `<div style="display:inline-flex;flex-direction:row;align-items:center;gap:6px;background:rgba(255,255,255,0.96);backdrop-filter:blur(6px);border:1.5px solid ${borderColor};border-radius:10px;padding:4px 8px;box-shadow:0 4px 14px rgba(0,0,0,0.22);white-space:nowrap;font-family:monospace;pointer-events:auto;cursor:pointer;" title="Tap to select target"><span style="font-size:18px;line-height:1;">${getVesselTypeIcon(t.type, t.name)}</span><div style="display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;"><span style="font-size:13.5px;font-weight:900;color:${titleColor};text-transform:uppercase;letter-spacing:-0.2px;">${t.name || 'Unknown'}</span><span style="font-size:10px;font-weight:700;color:#475569;margin-top:1px;">${statusLine}</span><span style="font-size:11px;font-weight:900;color:${metricColor};margin-top:1px;">${cpaOrDistLine}</span></div></div>`,
            iconSize: [320, 56],
            iconAnchor: [-14, 28],
          }),
          zIndexOffset: (isSelected ? 1000 : isRed ? 800 : isOrange ? 600 : 200) + 100,
          interactive: true,
        });

        labelMarker.on('click', (ev: L.LeafletMouseEvent) => {
          if (ev.originalEvent) {
            L.DomEvent.stopPropagation(ev.originalEvent);
            L.DomEvent.preventDefault(ev.originalEvent);
          }
          setSelectedTarget(t);
          onSelectTarget(t.id);
          setShowListDrawer(true);
          handleCenterOnTarget(t);
        });

        markersLayerRef.current?.addLayer(labelMarker);
      }

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
          opacity: isDimmed ? 0.25 : 0.8,
          interactive: false,
        });
        markersLayerRef.current?.addLayer(swingCircle);

        if (t.anchorCenter && (t.anchorCenter.lat !== t.lat || t.anchorCenter.lon !== t.lon)) {
          const rodeLine = L.polyline([[t.anchorCenter.lat, t.anchorCenter.lon], [t.lat, t.lon]], {
            color: isDragging ? '#ff2d55' : '#94a3b8',
            weight: isDragging ? 1.8 : 1.2,
            dashArray: '2, 3',
            opacity: isDimmed ? 0.25 : 0.8,
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
            opacity: isDimmed ? 0.3 : 0.9,
            interactive: false,
          }
        );
        markersLayerRef.current?.addLayer(driftLine);
      } else if (!isAnchored && !isMoored && t.sog >= 0.3) {
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
            weight: isSelected ? 2.2 : 1.5,
            opacity: isDimmed ? 0.25 : 0.85,
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
          weight: isSelected ? 1.8 : 1.2,
          dashArray: '2, 4',
          opacity: isDimmed ? 0.15 : 0.55,
          interactive: false,
        });
        markersLayerRef.current?.addLayer(trailLine);
      }
    });
  }, [isActive, targets, ownShipPosition, ownShipCourse, selectedTarget, ackedLabels, onSelectTarget, handleCenterOnTarget]);

  // Zoom handlers (ancorati al bersaglio/propria barca se selezionati, altrimenti al centro dello schermo)
  const handleZoomIn = useCallback(() => {
    if (!mapRef.current) return;
    const currentZoom = mapRef.current.getZoom();
    const newZoom = Math.min(mapRef.current.getMaxZoom() || 18, currentZoom + 1);
    lastIntendedZoomRef.current = newZoom;

    if (selectedTarget) {
      const newCenter = getOffsetCenter([selectedTarget.lat, selectedTarget.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else if (followMode === 'own') {
      const newCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else {
      mapRef.current.zoomIn();
    }
  }, [selectedTarget, followMode, ownShipPosition, getOffsetCenter]);

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current) return;
    const currentZoom = mapRef.current.getZoom();
    const newZoom = Math.max(mapRef.current.getMinZoom() || 3, currentZoom - 1);
    lastIntendedZoomRef.current = newZoom;

    if (selectedTarget) {
      const newCenter = getOffsetCenter([selectedTarget.lat, selectedTarget.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else if (followMode === 'own') {
      const newCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else {
      mapRef.current.zoomOut();
    }
  }, [selectedTarget, followMode, ownShipPosition, getOffsetCenter]);

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
        {/* TOP LEFT GROUP: BETA TAG & STATUS COUNTERS */}
        <div className="ais-top-left-group">
          <div className="ais-beta-tag">Beta</div>
          <div className="ais-status-counters">
            <span className="counter-item counter-total">
              <span className="counter-val">{stats.total}</span>
              <span className="counter-lbl">Vessels</span>
            </span>

            {stats.red > 0 && (
              <span className="counter-item counter-danger">
                <span className="counter-val">{stats.red}</span>
                <span className="counter-lbl">Collision</span>
              </span>
            )}

            {stats.orange > 0 && (
              <span className="counter-item counter-warning">
                <span className="counter-val">{stats.orange}</span>
                <span className="counter-lbl">Crossing</span>
              </span>
            )}

            <span className="counter-item counter-anchored">
              <span className="counter-val">{stats.anchored}</span>
              <span className="counter-lbl">Anchored</span>
            </span>
          </div>
        </div>

        {/* TOP RIGHT ACTIONS */}
        <div className="ais-top-actions">
          <button
            type="button"
            className={`ais-tool-btn ${showListDrawer || selectedTarget ? 'btn-active' : ''}`}
            onClick={() => {
              if (selectedTarget) {
                handleReturnToList();
              } else {
                setShowListDrawer(prev => !prev);
              }
            }}
            title="AIS Target Register"
            aria-label="AIS Target Register"
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

          <div className="propulsion-btn-container">
            {propulsionToast && (
              <div className="propulsion-speech-bubble" key={propulsionToast.mode}>
                <span className="propulsion-speech-text">{propulsionToast.text}</span>
                <div className="propulsion-speech-arrow" />
              </div>
            )}
            <button
              type="button"
              className={`ais-tool-btn ${propulsionMode === 'MOTOR' ? 'btn-active' : ''}`}
              style={{ fontSize: '1.2rem' }}
              onClick={() => {
                if (!onSetPropulsionMode) return;
                const nextMode: PropulsionMode = propulsionMode === 'MOTOR' ? 'SAIL' : 'MOTOR';
                onSetPropulsionMode(nextMode);

                const msgText = nextMode === 'MOTOR'
                  ? 'COLREG: Power-driven vessel rules applied (give-way / stand-on by engine mechanics).'
                  : 'COLREG: Sailing vessel rules applied (port/starboard tack & windward/leeward).';

                setPropulsionToast({ text: msgText, mode: nextMode });

                if (toastTimerRef.current) {
                  clearTimeout(toastTimerRef.current);
                }
                toastTimerRef.current = setTimeout(() => {
                  setPropulsionToast(null);
                }, 3500);
              }}
              title={`Propulsione: ${propulsionMode === 'MOTOR' ? 'MOTORE' : 'VELA (Auto)'}`}
              aria-label="Modalità Propulsione"
            >
              {propulsionMode === 'MOTOR' ? '🚤' : '⛵'}
            </button>
          </div>
        </div>
      </div>

      {/* FLOATING TARGETS DROPDOWN CARD */}
      {(showListDrawer || selectedTarget) && (
        <div
          ref={cardRef}
          className="ais-dropdown-card"
          onWheelCapture={e => e.stopPropagation()}
          onTouchMoveCapture={e => e.stopPropagation()}
        >
          {selectedTarget && (
            /* TARGET DETAIL VIEW */
            <div className="ais-card-detail">
              <div className="ais-detail-header">
                <button
                  type="button"
                  className="btn-back-lista"
                  onClick={handleReturnToList}
                >
                  ← LIST
                </button>
                <div
                  className="detail-header-center"
                  onClick={() =>
                    setTargetDetailTab(prev =>
                      prev === 'telemetry' ? 'info' : 'telemetry'
                    )
                  }
                  style={{ cursor: 'pointer' }}
                  title="Tap to switch tab (Telemetry / Info)"
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
                        ? 'Show Info & Dimensions'
                        : 'Show Kinematic Telemetry'
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
                  title="Close"
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
                  title="Click to copy MMSI"
                >
                  📋 MMSI {selectedTarget.id.split(':').pop()}{' '}
                  {copiedMmsi ? '✓' : ''}
                </button>
                <span>•</span>
                <span
                  onClick={() =>
                    setTargetDetailTab(prev =>
                      prev === 'telemetry' ? 'info' : 'telemetry'
                    )
                  }
                  style={{ cursor: 'pointer' }}
                  title="Tap to switch tab"
                >
                  ⏱️ {formatAge(selectedTarget.age)}
                </span>
              </div>

              {targetDetailTab === 'telemetry' ? (
                /* KINEMATIC TELEMETRY */
                <div className="ais-card-body-detail">
                  <div className="ais-detail-grid">
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">SOG / COG</span>
                      <span className="ais-cell-val">
                        {selectedTarget.sog.toFixed(1)} kn @ {selectedTarget.cog}°
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">DISTANCE</span>
                      <span className="ais-cell-val">
                        {formatDist(selectedTarget.dist)}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">MINIMUM CPA</span>
                      <span className="ais-cell-val cyan">
                        {formatDist(selectedTarget.cpa)}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">TIME TO CPA</span>
                      <span className="ais-cell-val cyan">
                        {selectedTarget.tcpa !== null && selectedTarget.tcpa >= 0
                          ? `${selectedTarget.tcpa.toFixed(1)} min`
                          : '--'}
                      </span>
                    </div>
                  </div>

                  {/* SIGHT / BEARING */}
                  <div className="ais-sight-box">
                    <span>👀</span>
                    <span>SIGHT: {selectedTarget.sightingTxt || '--'}</span>
                  </div>

                  {selectedTarget.anchorState === 'ANCHOR_DRAGGING' && (
                    <div className="ais-detail-alert-box red">
                      <span className="alert-title">ANCHOR DRAG ALARM</span>
                      <span className="alert-desc">
                        Target dragging ({selectedTarget.sog.toFixed(1)} kn cog {selectedTarget.cog}°)
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
                /* STATIC INFO & DIMENSIONS */
                <div className="ais-card-body-detail">
                  <div className="ais-detail-grid">
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">DIMENSIONS (L × W)</span>
                      <span className="ais-cell-val">
                        {selectedTarget.length ? `${selectedTarget.length.toFixed(0)}m` : '--'} ×{' '}
                        {selectedTarget.beam ? `${selectedTarget.beam.toFixed(0)}m` : '--'}
                      </span>
                    </div>
                    <div className="ais-detail-cell">
                      <span className="ais-cell-label">DRAFT</span>
                      <span className="ais-cell-val">
                        {selectedTarget.draft ? `${selectedTarget.draft.toFixed(1)}m` : '--'}
                      </span>
                    </div>
                    <div className="ais-detail-cell cell-wide">
                      <span className="ais-cell-label">DESTINATION & ETA</span>
                      <span className="ais-cell-val cyan">
                        {selectedTarget.destination || 'NOT DECLARED'}{' '}
                        {selectedTarget.eta ? `(ETA ${selectedTarget.eta})` : ''}
                      </span>
                    </div>
                    <div className="ais-detail-cell cell-wide">
                      <span className="ais-cell-label">AIS STATUS (CLASS)</span>
                      <span className="ais-cell-val">
                        {getVesselStatusLabel(selectedTarget)} ({selectedTarget.aisClass || 'B'})
                      </span>
                    </div>
                    <div className="ais-detail-cell cell-wide">
                      <span className="ais-cell-label">RADIO & FLAG</span>
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
                    🌐 View Photo on VesselFinder
                  </a>
                </div>
              )}
            </div>
          )}

          {/* TARGETS LIST VIEW */}
          <div className="ais-card-list" style={{ display: selectedTarget ? 'none' : 'flex' }}>
            <div className="ais-card-header">
              <div className="ais-card-title-group">
                <svg className="ais-card-icon-arrow" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L19 21L12 17L5 21L12 2Z" />
                </svg>
                <span className="ais-card-title">TARGETS ({targets.length})</span>
              </div>
              <button
                type="button"
                className="ais-card-close-btn"
                onClick={() => setShowListDrawer(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div
              ref={listBodyRef}
              className="ais-card-body"
              onScroll={e => {
                listScrollTopRef.current = e.currentTarget.scrollTop;
              }}
            >
                {/* 1. OWN SHIP */}
                <div
                  className="ais-target-item-own"
                  onClick={handleCenterOnOwnShip}
                  title={`Center on ${ownShipName}`}
                >
                  <div className="target-left-group">
                    <span className="target-speaking-icon">⛵</span>
                    <div className="target-text-col">
                      <span className="target-item-name">{ownShipName}</span>
                      <span className="target-item-sub">
                        {ownShipCourse.sog < 0.5 ? 'IN PORT' : 'UNDERWAY'} • HDG: {Math.round(ownShipCourse.hdg)}°
                      </span>
                    </div>
                  </div>
                  <div className="target-right-group">
                    <div className="target-sog-val">{ownShipCourse.sog.toFixed(1)} kn</div>
                    <div className="target-sog-lbl">SOG</div>
                  </div>
                </div>

                {/* 2. OTHER SORTED TARGETS */}
                {sortedTargets.length > 0 ? (
                  sortedTargets.map(item => (
                    <div
                      key={item.id}
                      id={`target-item-${item.id}`}
                      className={`ais-target-item ${item.risk === 'RED' ? 'risk-red' : item.risk === 'ORANGE' ? 'risk-orange' : ''}`}
                      onClick={() => {
                        if (listBodyRef.current) {
                          listScrollTopRef.current = listBodyRef.current.scrollTop;
                        }
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
                    <span className="ais-empty-title">No AIS targets detected</span>
                    <span className="ais-empty-sub">Listening within 20 NM...</span>
                  </div>
                )}
              </div>
            </div>
        </div>
      )}

      {/* MAP CONTROLS DOCK (VERTICAL CENTER RIGHT) */}
      <div className="ais-map-controls-dock">
        <button
          type="button"
          className="ais-map-btn"
          onClick={handleZoomIn}
          title="Zoom In (+)"
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
          title="Zoom Out (-)"
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
          title={followMode === 'own' ? 'Centered on Boat (Click: Standard Zoom)' : 'Recenter on Your Boat'}
          aria-label="Center Map"
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

      {/* FLOATING ACTION BUTTON: SUPPORT / FEEDBACK (BOTTOM LEFT) */}
      <button
        type="button"
        className="ais-floating-support-btn"
        onClick={() => setShowSupportModal(true)}
        title="Support Project & Feedback"
        aria-label="Support Project & Feedback"
      >
        $
      </button>

      {/* FLOATING ACTION BUTTON: SWITCH TO WIND DASHBOARD (BOTTOM RIGHT) */}
      <button
        type="button"
        className="ais-floating-wind-btn"
        onClick={onSwitchToWind}
        title="Return to Wind Dashboard"
        aria-label="Return to Wind Dashboard"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
        </svg>
      </button>

      {/* SUPPORT & FEEDBACK MODAL POPUP */}
      {showSupportModal && (
        <div className="ais-modal-backdrop" onClick={() => setShowSupportModal(false)}>
          <div className="ais-support-modal" onClick={e => e.stopPropagation()}>
            <div className="ais-support-modal-header">
              <span className="ais-support-modal-title">Feedback & Support</span>
              <button
                type="button"
                className="ais-card-close-btn"
                onClick={() => setShowSupportModal(false)}
                title="Close"
              >
                ✕
              </button>
            </div>
            <div className="ais-support-modal-body">
              <p>
                <strong>Your feedback matters most!</strong> I would love to hear your thoughts, feature ideas, or bug reports to make this tactical AIS monitor even better for real-world navigation.
              </p>
              <p>
                I&apos;m personally investing time and resources into building and refining this tool — featuring ARPA CPA/TCPA collision alarms, COLREGs crossing rules, anchor drag alerts, and weather radar overlay.
              </p>
              <p>
                Infrastructure and testing costs have reached <strong>€40</strong> so far. Additional funding allows new features to be added much faster — but even a simple email with your feedback means a lot!
              </p>
              <a
                href="mailto:refuso.chiari.1j@icloud.com?subject=Rotevista%20dash%3A%20Improvement"
                className="ais-support-email-btn"
              >
                ✉️ Contact Developer
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prev, next) => !prev.isActive && !next.isActive);
