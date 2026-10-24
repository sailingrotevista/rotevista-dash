import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AisTarget, HarborCluster, PropulsionMode } from '../types';
import { getAvailableMapArea, getMapCenterOffset } from '../utils/mapViewport.mjs';
import { chooseAisLabelPlacement, escapeAisLabelText } from '../utils/aisLabelPlacement.mjs';
import { openDashboardMenu } from '../utils/dashboardModes.mjs';
import { compareAisTargets } from '../utils/aisPriority.mjs';

// PARAMETRI VISIVI ETÀ AIS — tempi in secondi, opacità da 0 a 1.
// L'età è quella dell'ultimo fix ricevuto: le proiezioni non la azzerano.
const AIS_AGE_VISUAL_CONFIG = {
  enabled: true,
  movingSpeedKnots: 2,
  moving: { fadeStartSeconds: 90, fadeEndSeconds: 180 },
  slowOrMoored: { fadeStartSeconds: 240, fadeEndSeconds: 360 },
  minimumOpacity: 0.5,
  preserveSelected: true,
  preserveAlerts: true,
};

function getTargetAgeVisual(t: AisTarget, isSelected = false) {
  const config = AIS_AGE_VISUAL_CONFIG;
  const slowOrMoored = t.sog <= config.movingSpeedKnots || t.isMoored ||
    t.isAnchored || t.inCluster || t.anchorState === 'MOORED' || t.anchorState === 'ANCHORED';
  const thresholds = slowOrMoored ? config.slowOrMoored : config.moving;
  const age = Number.isFinite(t.age) ? Math.max(0, t.age) : 0;
  const stale = config.enabled && age > thresholds.fadeStartSeconds;
  const protectedTarget = (config.preserveSelected && isSelected) ||
    (config.preserveAlerts && (t.risk === 'RED' || t.risk === 'ORANGE' || t.anchorState === 'ANCHOR_DRAGGING'));
  const duration = Math.max(1, thresholds.fadeEndSeconds - thresholds.fadeStartSeconds);
  const progress = Math.min(1, Math.max(0, (age - thresholds.fadeStartSeconds) / duration));
  const minimum = Math.min(1, Math.max(0, config.minimumOpacity));
  return {
    stale,
    opacity: !config.enabled || protectedTarget ? 1 : 1 - progress * (1 - minimum),
  };
}

interface AisViewProps {
  isActive?: boolean;
  targets: AisTarget[];
  harborClusters: HarborCluster[];
  ownShipPosition: { lat: number; lon: number };
  ownShipCourse: { hdg: number; cog: number; sog: number };
  isNightMode: boolean;
  onSwitchToWind: () => void;
  onSnoozeThreat: (targetId: string) => void;
  onInspectionChange?: (isInspecting: boolean) => void;
  mixedSimulation?: boolean;
  onReopenTopThreat?: () => void;
  selectedTargetId: string | null;
  onSelectTarget: (targetId: string | null) => void;
  ownShipName?: string;
  propulsionMode?: PropulsionMode;
  onSetPropulsionMode?: (mode: PropulsionMode) => void;
  inspectToken?: number;
  vectorMinutes?: number;
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
  if (t.motionState === 'POSSIBLE_MOVEMENT') return 'POSSIBLE MOVEMENT';
  if (t.motionState === 'STATIONARY') return 'STOPPED';
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

type FollowMode = 'own' | 'target' | 'intersection' | 'none';

export const AisView: React.FC<AisViewProps> = React.memo(({
  isActive = true,
  targets,
  harborClusters,
  ownShipPosition,
  ownShipCourse,
  isNightMode,
  onSwitchToWind,
  onSnoozeThreat,
  onInspectionChange,
  mixedSimulation = false,
  onReopenTopThreat,
  selectedTargetId,
  onSelectTarget,
  ownShipName = 'MY VESSEL',
  propulsionMode = 'SAIL',
  onSetPropulsionMode,
  inspectToken,
  vectorMinutes = 5,
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
  const cameraSnapshotRef = useRef<{
    center: L.LatLng;
    zoom: number;
    followMode: FollowMode;
    followedTargetId: string | null;
  } | null>(null);
  const onSelectTargetRef = useRef(onSelectTarget);
  useEffect(() => {
    onSelectTargetRef.current = onSelectTarget;
  }, [onSelectTarget]);

  const [followMode, setFollowMode] = useState<FollowMode>('own');
  const [followedTargetId, setFollowedTargetId] = useState<string | null>(null);
  const followedTargetIdRef = useRef<string | null>(null);
  followedTargetIdRef.current = followedTargetId;
  const [mapZoom, setMapZoom] = useState<number>(16);
  const [showListDrawer, setShowListDrawer] = useState<boolean>(false);
  const [showSupportModal, setShowSupportModal] = useState<boolean>(false);
  const [selectedTarget, setSelectedTarget] = useState<AisTarget | null>(null);
  useEffect(() => {
    onInspectionChange?.(Boolean(isActive && showListDrawer && selectedTarget));
  }, [isActive, showListDrawer, selectedTarget?.id, onInspectionChange]);
  const [targetDetailTab, setTargetDetailTab] = useState<'telemetry' | 'info'>('info');
  const [copiedMmsi, setCopiedMmsi] = useState<boolean>(false);
  const [ackedLabels, setAckedLabels] = useState<Record<string, string>>({});
  const [propulsionToast, setPropulsionToast] = useState<{ text: string; mode: PropulsionMode } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedTargetRef = useRef<AisTarget | null>(null);
  selectedTargetRef.current = selectedTarget;
  const showListDrawerRef = useRef<boolean>(false);
  showListDrawerRef.current = showListDrawer;
  const followModeRef = useRef<FollowMode>('own');
  followModeRef.current = followMode;
  const lastIntendedZoomRef = useRef<number | null>(null);
  const userFollowZoomRef = useRef<number>(16);
  const ownShipPositionRef = useRef(ownShipPosition);
  ownShipPositionRef.current = ownShipPosition;
  const targetsRef = useRef<AisTarget[]>(targets);
  targetsRef.current = targets;
  const smoothMarkersRef = useRef<Record<string, L.Marker>>({});
  const labelSidesRef = useRef<Record<string, string>>({});
  const labelSizesRef = useRef(new Map<string, { width: number; height: number }>());
  const isZoomingRef = useRef<boolean>(false);
  const interactingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [zoomSyncTick, setZoomSyncTick] = useState<number>(0);

  const releaseMapTransitions = useCallback((delayMs = 90) => {
    if (interactingTimerRef.current) {
      clearTimeout(interactingTimerRef.current);
    }
    interactingTimerRef.current = setTimeout(() => {
      interactingTimerRef.current = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!isZoomingRef.current && !(mapRef.current as any)?._animatingZoom) {
            mapContainerRef.current?.classList.remove('map-interacting');
          }
        });
      });
    }, delayMs);
  }, []);

  const suspendMapTransitions = useCallback((fallbackReleaseMs = 220) => {
    mapContainerRef.current?.classList.add('map-interacting');
    releaseMapTransitions(fallbackReleaseMs);
  }, [releaseMapTransitions]);

  // Measure the actual map and panel, independently of device orientation.
  const getVisibleMapArea = useCallback(() => {
    const map = mapRef.current;
    const element = mapContainerRef.current;
    if (!map || !element) return null;
    const bounds = element.getBoundingClientRect();
    const size = map.getSize();
    const panel = showListDrawerRef.current ? cardRef.current?.getBoundingClientRect() : null;
    const controls = element.parentElement?.querySelector('.ais-map-controls-dock')?.getBoundingClientRect();
    const topBar = element.parentElement?.querySelector('.ais-top-left-group')?.getBoundingClientRect();
    return getAvailableMapArea(size.x, size.y, panel ? {
      left: panel.left - bounds.left, right: panel.right - bounds.left,
      top: panel.top - bounds.top, bottom: panel.bottom - bounds.top,
    } : null, {
      left: 16,
      right: controls ? Math.max(16, bounds.right - controls.left + 12) : 16,
      top: topBar ? Math.max(16, topBar.bottom - bounds.top + 12) : 16,
      bottom: 72,
    });
  }, []);

  const getOffsetCenter = useCallback(
    (latLng: [number, number], zoomOverride?: number): L.LatLng => {
      const map = mapRef.current;
      if (!map || !showListDrawerRef.current) return L.latLng(latLng[0], latLng[1]);
      const area = getVisibleMapArea();
      if (!area) return L.latLng(latLng[0], latLng[1]);
      const size = map.getSize();
      const offset = getMapCenterOffset(size.x, size.y, area);
      const zoom = zoomOverride ?? map.getZoom();
      return map.unproject(map.project(latLng, zoom).add(offset), zoom);
    }, [getVisibleMapArea]
  );

  // Sync selectedTarget and ackedLabels with targets risk transitions
  useEffect(() => {
    if (selectedTargetId) {
      const found = targets.find(t => t.id === selectedTargetId);
      if (found) {
        setSelectedTarget(found);
      } else {
        setSelectedTarget(null);
        onSelectTargetRef.current(null);
      }
    } else {
      if (selectedTargetRef.current && cameraSnapshotRef.current && mapRef.current) {
        suspendMapTransitions();
        const snap = cameraSnapshotRef.current;
        cameraSnapshotRef.current = null;
        setFollowMode(snap.followMode);
        followModeRef.current = snap.followMode;
        setFollowedTargetId(snap.followedTargetId);
        followedTargetIdRef.current = snap.followedTargetId;
        setShowListDrawer(false);
        let restoreCenter = snap.center;
        if (snap.followMode === 'own') {
          const pos = ownShipPositionRef.current;
          restoreCenter = L.latLng(pos.lat, pos.lon);
          lastFollowPosRef.current = { lat: pos.lat, lon: pos.lon, mode: 'own' };
        } else if (snap.followMode === 'target' && snap.followedTargetId) {
          const ft = targetsRef.current.find(t => t.id === snap.followedTargetId);
          if (ft) {
            restoreCenter = L.latLng(ft.lat, ft.lon);
            lastFollowPosRef.current = { lat: ft.lat, lon: ft.lon, mode: 'target', targetId: ft.id };
          }
        } else {
          lastFollowPosRef.current = null;
        }
        mapRef.current.setView(restoreCenter, snap.zoom, { animate: true });
        releaseMapTransitions();
      }
      setSelectedTarget(null);
    }

    setAckedLabels(prev => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      let changed = false;
      const next = { ...prev };

      ids.forEach(id => {
        const ackedRisk = next[id];
        const t = targets.find(item => item.id === id);
        if (!t || (t.risk !== 'RED' && t.risk !== 'ORANGE')) {
          delete next[id];
          changed = true;
        } else if (ackedRisk === 'ORANGE' && t.risk === 'RED') {
          delete next[id];
          changed = true;
        } else if (ackedRisk === 'RED' && t.risk === 'ORANGE') {
          next[id] = 'ORANGE';
          changed = true;
        }
      });

      return changed ? next : prev;
    });
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

    map.on('movestart dragstart viewreset', () => {
      suspendMapTransitions();
    });
    map.on('zoomstart', () => {
      isZoomingRef.current = true;
      suspendMapTransitions();
    });
    map.on('moveend dragend', () => {
      releaseMapTransitions();
      setZoomSyncTick(value => value + 1);
    });

    map.on('dragstart', () => {
      lastIntendedZoomRef.current = null;
      setFollowMode('none');
      followModeRef.current = 'none';
    });
    map.on('wheel', () => {
      suspendMapTransitions();
      lastIntendedZoomRef.current = null;
      setFollowMode('none');
      followModeRef.current = 'none';
    });
    map.on('click', () => {
      lastIntendedZoomRef.current = null;
      if (selectedTargetRef.current || showListDrawerRef.current) {
        suspendMapTransitions();
        setSelectedTarget(null);
        onSelectTargetRef.current(null);
        setShowListDrawer(false);
        if (cameraSnapshotRef.current && mapRef.current) {
          const snap = cameraSnapshotRef.current;
          cameraSnapshotRef.current = null;
          setFollowMode(snap.followMode);
          followModeRef.current = snap.followMode;
          setFollowedTargetId(snap.followedTargetId);
          followedTargetIdRef.current = snap.followedTargetId;
          let restoreCenter = snap.center;
          if (snap.followMode === 'own') {
            const pos = ownShipPositionRef.current;
            restoreCenter = L.latLng(pos.lat, pos.lon);
            lastFollowPosRef.current = { lat: pos.lat, lon: pos.lon, mode: 'own' };
          } else if (snap.followMode === 'target' && snap.followedTargetId) {
            const ft = targetsRef.current.find(t => t.id === snap.followedTargetId);
            if (ft) {
              restoreCenter = L.latLng(ft.lat, ft.lon);
              lastFollowPosRef.current = { lat: ft.lat, lon: ft.lon, mode: 'target', targetId: ft.id };
            }
          } else {
            lastFollowPosRef.current = null;
          }
          mapRef.current.setView(restoreCenter, snap.zoom, { animate: true });
        }
        releaseMapTransitions();
      }
    });
    const scaleMarkerSubElements = (targetZoom: number) => {
      Object.values(smoothMarkersRef.current).forEach(m => {
        const el = m.getElement();
        if (!el || !el.dataset.baseZoom) return;
        const scale = Math.pow(2, targetZoom - parseFloat(el.dataset.baseZoom));
        if (el.dataset.vecLen) el.style.setProperty('--vec-len', `${(parseFloat(el.dataset.vecLen) * scale).toFixed(1)}px`);
        if (el.dataset.cpaLen) el.style.setProperty('--cpa-len', `${(parseFloat(el.dataset.cpaLen) * scale).toFixed(1)}px`);
        if (el.dataset.ghostDist) el.style.setProperty('--ghost-dist', `${(parseFloat(el.dataset.ghostDist) * scale).toFixed(1)}px`);
        if (el.dataset.isRings) el.style.setProperty('--ring-scale', scale.toFixed(4));
      });
    };

    map.on('zoomanim', (e: L.ZoomAnimEvent) => {
      isZoomingRef.current = true;
      suspendMapTransitions(350);
      scaleMarkerSubElements(e.zoom);
    });
    map.on('zoom', () => {
      suspendMapTransitions(220);
      if (!(map as any)._animatingZoom) {
        scaleMarkerSubElements(map.getZoom());
      }
    });
    map.on('move', () => {
      suspendMapTransitions(220);
    });
    map.on('zoomend', () => {
      isZoomingRef.current = false;
      suspendMapTransitions(90);
      setMapZoom(Math.round(map.getZoom()));
      setZoomSyncTick(t => t + 1);
      releaseMapTransitions(90);
    });

    const mapEl = mapContainerRef.current;
    const handleTouchInteraction = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        suspendMapTransitions(250);
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
      if (interactingTimerRef.current) clearTimeout(interactingTimerRef.current);
      mapEl?.removeEventListener('touchstart', handleTouchInteraction);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      smoothMarkersRef.current = {};
    };
  }, [suspendMapTransitions, releaseMapTransitions]);

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

  const restoreCameraSnapshot = useCallback((drawerVisible = false) => {
    suspendMapTransitions();
    if (cameraSnapshotRef.current && mapRef.current) {
      const snap = cameraSnapshotRef.current;
      cameraSnapshotRef.current = null;
      setFollowMode(snap.followMode);
      followModeRef.current = snap.followMode;
      setFollowedTargetId(snap.followedTargetId);
      followedTargetIdRef.current = snap.followedTargetId;
      let restoreCenter = snap.center;
      if (snap.followMode === 'own') {
        const pos: [number, number] = [ownShipPositionRef.current.lat, ownShipPositionRef.current.lon];
        restoreCenter = drawerVisible ? getOffsetCenter(pos, snap.zoom) : L.latLng(pos[0], pos[1]);
        lastFollowPosRef.current = { lat: pos[0], lon: pos[1], mode: 'own' };
      } else if (snap.followMode === 'target' && snap.followedTargetId) {
        const ft = targetsRef.current.find(t => t.id === snap.followedTargetId);
        if (ft) {
          restoreCenter = drawerVisible ? getOffsetCenter([ft.lat, ft.lon], snap.zoom) : L.latLng(ft.lat, ft.lon);
          lastFollowPosRef.current = { lat: ft.lat, lon: ft.lon, mode: 'target', targetId: ft.id };
        }
      } else {
        lastFollowPosRef.current = null;
      }
      mapRef.current.setView(restoreCenter, snap.zoom, { animate: true });
      releaseMapTransitions();
      return true;
    }
    releaseMapTransitions();
    return false;
  }, [getOffsetCenter, suspendMapTransitions, releaseMapTransitions]);

  // Center on Target handler (distingue tra follow persistente da mappa e browsing temporaneo da lista)
  const handleCenterOnTarget = useCallback(
    (target: AisTarget, openDrawer?: boolean, isTemporaryBrowsing = false) => {
      if (!mapRef.current) return;
      suspendMapTransitions();
      if (isTemporaryBrowsing) {
        if (!cameraSnapshotRef.current) {
          cameraSnapshotRef.current = {
            center: mapRef.current.getCenter(),
            zoom: mapRef.current.getZoom(),
            followMode: followModeRef.current,
            followedTargetId: followedTargetIdRef.current,
          };
        }
      } else {
        cameraSnapshotRef.current = null;
        userFollowZoomRef.current = Math.round(mapRef.current.getZoom());
      }
      setFollowedTargetId(target.id);
      followedTargetIdRef.current = target.id;
      setFollowMode('target');
      followModeRef.current = 'target';
      lastFollowPosRef.current = { lat: target.lat, lon: target.lon, mode: 'target', targetId: target.id };
      const isDrawerVisible = openDrawer !== undefined ? openDrawer : showListDrawerRef.current;
      // React must replace the list with target details before measuring the panel.
      requestAnimationFrame(() => {
        if (!mapRef.current) return;
        const targetCenter = isDrawerVisible
          ? getOffsetCenter([target.lat, target.lon])
          : L.latLng(target.lat, target.lon);
        mapRef.current.panTo(targetCenter, { animate: true });
        releaseMapTransitions();
      });
    },
    [getOffsetCenter, suspendMapTransitions, releaseMapTransitions]
  );

  // Smart zoom per inquadrare e seguire il triangolo di collisione nello spazio visibile disponibile
  const zoomToCollisionTriangle = useCallback(
    (target: AisTarget, isTemporaryInspect = false) => {
      if (!mapRef.current) return;

      if (followModeRef.current !== 'intersection') {
        userFollowZoomRef.current = Math.round(mapRef.current.getZoom());
      }

      if (isTemporaryInspect) {
        if (!cameraSnapshotRef.current) {
          cameraSnapshotRef.current = {
            center: mapRef.current.getCenter(),
            zoom: mapRef.current.getZoom(),
            followMode: followModeRef.current,
            followedTargetId: followedTargetIdRef.current,
          };
        }
      } else {
        cameraSnapshotRef.current = null;
      }

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
      const size = mapRef.current.getSize();
      const area = getVisibleMapArea();
      const paddingTopLeft: [number, number] = area ? [area.left, area.top] : [40, 40];
      const paddingBottomRight: [number, number] = area ? [size.x - area.right, size.y - area.bottom] : [40, 40];

      suspendMapTransitions();
      setFollowedTargetId(target.id);
      followedTargetIdRef.current = target.id;
      setFollowMode('intersection');
      followModeRef.current = 'intersection';
      lastFollowPosRef.current = {
        lat: (ownLat + targetLat) / 2,
        lon: (ownLon + targetLon) / 2,
        mode: 'intersection',
        targetId: target.id,
      };
      mapRef.current.fitBounds(bounds, {
        paddingTopLeft,
        paddingBottomRight,
        animate: true,
        maxZoom: 16,
      });
      releaseMapTransitions();
    },
    [ownShipPosition, ownShipCourse, getVisibleMapArea, suspendMapTransitions, releaseMapTransitions]
  );

  // Ripristina inquadratura mappa e posizione scroll lista al ritorno dal dettaglio
  const handleReturnToList = useCallback(() => {
    const prevTargetId = selectedTarget?.id;
    setSelectedTarget(null);
    onSelectTarget(null);
    setShowListDrawer(true);
    restoreCameraSnapshot(true);
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
  }, [selectedTarget, onSelectTarget, restoreCameraSnapshot]);

  // Center on Own Ship & Contextual Standard Zoom
  const handleCenterOnOwnShip = useCallback(() => {
    if (!mapRef.current) return;

    suspendMapTransitions();
    cameraSnapshotRef.current = null;
    if (selectedTarget) {
      setSelectedTarget(null);
      onSelectTarget(null);
    }
    setFollowedTargetId(null);
    followedTargetIdRef.current = null;
    setShowListDrawer(false);

    const map = mapRef.current;
    const isInHarbor = harborClusters.some(c => c.dist < 500);
    const isStoppedOrAnchored = ownShipCourse.sog < 1.0 || isInHarbor;
    const standardZoom = isStoppedOrAnchored ? 16 : 13;
    const alternateZoom = standardZoom === 16 ? 13 : 16;

    if (followModeRef.current !== 'own') {
      // 1° Click: ripristina followMode = 'own' e centra arrotondando lo zoom a intero
      const nextZoom = Math.round(map.getZoom());
      lastIntendedZoomRef.current = nextZoom;
      userFollowZoomRef.current = nextZoom;
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
      userFollowZoomRef.current = targetZoom;
      setFollowMode('own');
      followModeRef.current = 'own';
      lastFollowPosRef.current = { lat: ownShipPosition.lat, lon: ownShipPosition.lon, mode: 'own' };
      const newTargetCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], targetZoom);
      map.setView(newTargetCenter, targetZoom, { animate: true });
    }
    releaseMapTransitions();
  }, [ownShipPosition, ownShipCourse, harborClusters, getOffsetCenter, selectedTarget, onSelectTarget, suspendMapTransitions, releaseMapTransitions]);

  // Follow Mode: progressivo con soglia di movimento (~20px) per evitare traslazioni ad ogni refresh
  const lastFollowPosRef = useRef<{ lat: number; lon: number; mode: FollowMode; targetId?: string } | null>(null);
  const followedTarget = useMemo(
    () => (followedTargetId ? targets.find(t => t.id === followedTargetId) || null : selectedTarget),
    [followedTargetId, targets, selectedTarget]
  );

  useEffect(() => {
    if (!isActive || !mapRef.current || followMode === 'none') {
      if (followMode === 'none') lastFollowPosRef.current = null;
      return;
    }

    const map = mapRef.current;

    if (followMode === 'intersection') {
      const isThreatActive =
        followedTarget &&
        (followedTarget.risk === 'RED' || followedTarget.risk === 'ORANGE') &&
        (followedTarget.tcpa === null || followedTarget.tcpa === undefined || followedTarget.tcpa >= 0);

      if (!isThreatActive) {
        cameraSnapshotRef.current = null;
        setFollowedTargetId(null);
        followedTargetIdRef.current = null;
        setFollowMode('own');
        followModeRef.current = 'own';
        const targetZoom = userFollowZoomRef.current ?? Math.round(map.getZoom());
        const ownCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], targetZoom);
        lastFollowPosRef.current = { lat: ownShipPosition.lat, lon: ownShipPosition.lon, mode: 'own' };
        map.setView(ownCenter, targetZoom, { animate: true });
        return;
      }

      const midPos: [number, number] = [
        (ownShipPosition.lat + followedTarget.lat) / 2,
        (ownShipPosition.lon + followedTarget.lon) / 2,
      ];
      if (!lastFollowPosRef.current || lastFollowPosRef.current.mode !== 'intersection' || lastFollowPosRef.current.targetId !== followedTarget.id) {
        lastFollowPosRef.current = { lat: midPos[0], lon: midPos[1], mode: 'intersection', targetId: followedTarget.id };
        return;
      }
      const lastPt = map.latLngToContainerPoint([lastFollowPosRef.current.lat, lastFollowPosRef.current.lon]);
      const currentPt = map.latLngToContainerPoint(midPos);
      if (Math.hypot(currentPt.x - lastPt.x, currentPt.y - lastPt.y) > 100) {
        lastFollowPosRef.current = { lat: midPos[0], lon: midPos[1], mode: 'intersection', targetId: followedTarget.id };
        map.panTo(getOffsetCenter(midPos), { animate: true, duration: 2.0, easeLinearity: 0.25 });
      }
      return;
    }

    const pos = followMode === 'own'
      ? [ownShipPosition.lat, ownShipPosition.lon] as [number, number]
      : followedTarget
        ? [followedTarget.lat, followedTarget.lon] as [number, number]
        : null;

    if (!pos) return;

    const targetCenter = getOffsetCenter(pos);
    const modeKey = followMode;
    const currentTargetId = followedTarget?.id;

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
  }, [isActive, ownShipPosition.lat, ownShipPosition.lon, followedTarget?.lat, followedTarget?.lon, followedTarget?.risk, followedTarget?.tcpa, followMode, followedTarget?.id, getOffsetCenter]);

  const collisionLayoutRef = useRef(zoomToCollisionTriangle);
  collisionLayoutRef.current = zoomToCollisionTriangle;

  // Panel content, tabs and viewport changes can alter the free map area.
  useEffect(() => {
    if (!isActive || !mapRef.current) return;
    let frame = 0;
    const recenter = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const map = mapRef.current;
        if (!map || followModeRef.current === 'none') return;
        const target = targetsRef.current.find(t => t.id === followedTargetIdRef.current);
        if (followModeRef.current === 'intersection' && target) {
          collisionLayoutRef.current(target, Boolean(cameraSnapshotRef.current));
        } else {
          const pos = followModeRef.current === 'own' ? ownShipPositionRef.current : target;
          if (pos) map.panTo(getOffsetCenter([pos.lat, pos.lon]), { animate: true });
        }
      });
    };
    const observer = new ResizeObserver(recenter);
    const panel = cardRef.current;
    const panelAnimationEnded = (event: Event) => {
      if (event.target === panel) recenter();
    };
    if (panel) {
      observer.observe(panel);
      panel.addEventListener('animationend', panelAnimationEnded);
      panel.addEventListener('transitionend', panelAnimationEnded);
    }
    if (mapContainerRef.current) observer.observe(mapContainerRef.current);
    recenter();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      panel?.removeEventListener('animationend', panelAnimationEnded);
      panel?.removeEventListener('transitionend', panelAnimationEnded);
    };
  }, [isActive, showListDrawer, selectedTarget?.id, targetDetailTab, getOffsetCenter]);

  // Seleziona e inquadra con smart zoom il triangolo di collisione quando cambia inspectToken o selectedTargetId dall'esterno
  const prevInspectTokenRef = useRef<number | undefined>(undefined);
  const prevSelectedTargetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const isTokenUpdate =
      inspectToken !== undefined &&
      inspectToken > 0 &&
      inspectToken !== prevInspectTokenRef.current;
    const isExternalTargetChange =
      selectedTargetId !== null &&
      selectedTargetId !== prevSelectedTargetIdRef.current &&
      selectedTargetRef.current?.id !== selectedTargetId;

    if (isTokenUpdate || isExternalTargetChange) {
      const found = targets.find(t => t.id === selectedTargetId);
      if (found) {
        setSelectedTarget(found);
        setTargetDetailTab('info');
        setShowListDrawer(true);
        if (found.risk === 'RED' || found.risk === 'ORANGE' || isTokenUpdate) {
          zoomToCollisionTriangle(found, true);
        } else {
          handleCenterOnTarget(found, true, true);
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



  // Clean up legacy rings layer if present
  useEffect(() => {
    ringsLayerRef.current?.clearLayers();
  }, [isActive]);

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
    if (isZoomingRef.current || (mapRef.current as any)._animatingZoom) return;
    markersLayerRef.current.clearLayers();
    const activeKeys = new Set<string>();

    const upsertSmoothMarker = (
      key: string,
      latLng: [number, number],
      className: string,
      html: string,
      size: [number, number],
      anchor: [number, number],
      zIndex: number,
      opacity = 1.0,
      interactive = false,
      onClick?: () => void,
      cssVars?: { rot?: number; vecLen?: number; cpaLen?: number; ghostDist?: number; isRings?: boolean }
    ) => {
      activeKeys.add(key);
      const map = mapRef.current;
      let m = smoothMarkersRef.current[key];
      if (!m && map) {
        m = L.marker(latLng, {
          opacity,
          icon: L.divIcon({ className, html, iconSize: size, iconAnchor: anchor }),
          zIndexOffset: zIndex,
          interactive,
        }).addTo(map);
        smoothMarkersRef.current[key] = m;
        const initEl = m.getElement();
        if (initEl) initEl.dataset.tpl = html;
      } else if (m) {
        const curPos = m.getLatLng();
        if (curPos.lat !== latLng[0] || curPos.lng !== latLng[1]) {
          m.setLatLng(latLng);
        }
        if (m.options.opacity !== opacity) {
          m.setOpacity(opacity);
        }
        if (m.options.zIndexOffset !== zIndex) {
          m.setZIndexOffset(zIndex);
        }
        const el = m.getElement();
        if (el && el.dataset.tpl !== html) {
          el.innerHTML = html;
          el.dataset.tpl = html;
        }
      }
      const el = m?.getElement();
      if (el && map && !isZoomingRef.current) {
        const currentZoom = map.getZoom();
        el.dataset.baseZoom = String(currentZoom);
        if (cssVars?.rot !== undefined) {
          const prevRot = el.dataset.rot !== undefined ? parseFloat(el.dataset.rot) : cssVars.rot;
          const delta = ((cssVars.rot - prevRot + 540) % 360) - 180;
          const nextRot = prevRot + delta;
          el.dataset.rot = String(nextRot);
          el.style.setProperty('--vessel-rot', `${nextRot.toFixed(2)}deg`);
        }
        if (cssVars?.vecLen !== undefined) {
          el.dataset.vecLen = String(cssVars.vecLen);
          el.style.setProperty('--vec-len', `${cssVars.vecLen.toFixed(1)}px`);
        }
        if (cssVars?.cpaLen !== undefined) {
          el.dataset.cpaLen = String(cssVars.cpaLen);
          el.style.setProperty('--cpa-len', `${cssVars.cpaLen.toFixed(1)}px`);
        }
        if (cssVars?.ghostDist !== undefined) {
          el.dataset.ghostDist = String(cssVars.ghostDist);
          el.style.setProperty('--ghost-dist', `${cssVars.ghostDist.toFixed(1)}px`);
        }
        if (cssVars?.isRings) {
          el.dataset.isRings = '1';
          el.style.setProperty('--ring-scale', '1');
        }
      }
      if (m && onClick) {
        m.off('click');
        m.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          onClick();
        });
      }
      return m;
    };

    // Determina la minaccia primaria in assoluto e il bersaglio attivo per le Ghost Ships
    const primaryThreatId = (() => {
      const threats = targets.filter(
        t => (t.risk === 'RED' || t.risk === 'ORANGE') && t.sog >= 0.5 && t.tcpa !== null && t.tcpa !== undefined && t.tcpa >= 0
      );
      if (threats.length === 0) return null;
      threats.sort(compareAisTargets);
      return threats[0].id;
    })();
    const activeGhostTargetId = selectedTarget ? selectedTarget.id : primaryThreatId;
    const activeGhostTarget = activeGhostTargetId ? targets.find(t => t.id === activeGhostTargetId) || null : null;

    // 1. Own Ship Marker, Integrated 6-min Course Vector & Own Ghost Ship
    const mPerPx =
      (40075016.686 * Math.abs(Math.cos((ownShipPosition.lat * Math.PI) / 180))) /
      Math.pow(2, (mapRef.current.getZoom() || mapZoom) + 8);
    const vecMins = vectorMinutes > 0 ? vectorMinutes : 5;
    const ownHeading = ownShipCourse.hdg || ownShipCourse.cog || 0;
    const ownVecPx = ownShipCourse.sog >= 0.5 ? ((ownShipCourse.sog * 1852) * (vecMins / 60)) / mPerPx : 0;
    const ownGhostPx =
      activeGhostTarget && activeGhostTarget.sog >= 0.5 && activeGhostTarget.tcpa && activeGhostTarget.tcpa > 0 && ownShipCourse.sog >= 0.5
        ? ((ownShipCourse.sog * 1852) * (activeGhostTarget.tcpa / 60)) / mPerPx
        : 0;
    const ownVecHtml = ownVecPx > 0
      ? `<div class="vessel-course-vector" style="border-left:2px dashed #00c3ff;opacity:0.9;"></div>`
      : '';
    const ownGhostHtml = ownGhostPx >= 45 && activeGhostTarget
      ? `<div class="cpa-ghost-vessel" data-ghost-id="${activeGhostTarget.id}"><svg viewBox="0 0 30 30" width="30" height="30"><path d="M 15,2 L 25,25 L 15,19 L 5,25 Z" fill="#00c3ff" stroke="#0369a1" stroke-width="1.8" stroke-linejoin="round" /></svg></div>`
      : '';
    const ownIconHtml = `
      <div class="own-ship-icon-wrapper" style="filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.35));">
        ${ownVecHtml}
        ${ownGhostHtml}
        <svg viewBox="0 0 30 30" width="30" height="30">
          <path d="M 15,2 L 25,25 L 15,19 L 5,25 Z" fill="#00c3ff" stroke="#0369a1" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
      </div>
    `;

    ownShipMarkerRef.current = upsertSmoothMarker(
      'own',
      [ownShipPosition.lat, ownShipPosition.lon],
      'own-ship-marker',
      ownIconHtml,
      [30, 30],
      [15, 15],
      1000,
      1.0,
      true,
      handleCenterOnOwnShip,
      { rot: ownHeading, vecLen: ownVecPx, ghostDist: ownGhostPx }
    ) || null;

    // 1b. Dynamic Coaxial Range Rings & Labels (traslano con translate3d insieme alla barca/target)
    const ringCenter: [number, number] = selectedTarget
      ? [selectedTarget.lat, selectedTarget.lon]
      : [ownShipPosition.lat, ownShipPosition.lon];
    const ringTargetKey = selectedTarget ? `rings:${selectedTarget.id}` : 'rings:own';
    const ringMPerPx =
      (40075016.686 * Math.abs(Math.cos((ringCenter[0] * Math.PI) / 180))) /
      Math.pow(2, (mapRef.current.getZoom() || mapZoom) + 8);

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
    const ringWeight = selectedTarget ? 1.6 : 1.2;
    const ringOpacity = isNightMode ? 0.65 : 0.75;
    const ringDash = selectedTarget ? '6, 6' : '4, 7';
    const maxRingPx = Math.ceil(ringRanges[ringRanges.length - 1].radiusMeters / ringMPerPx) + 4;
    const svgDim = maxRingPx * 2;

    const circlesSvgHtml = ringRanges
      .map(r => {
        const rPx = r.radiusMeters / ringMPerPx;
        return `<circle cx="${maxRingPx}" cy="${maxRingPx}" r="${rPx.toFixed(1)}" fill="none" stroke="${ringColor}" stroke-width="${ringWeight}" stroke-opacity="${ringOpacity}" stroke-dasharray="${ringDash}" />`;
      })
      .join('');

    const labelsHtml = ringRanges
      .map(r => {
        const rPx = r.radiusMeters / ringMPerPx;
        return `<div class="range-ring-label-item" style="--r-px:${rPx.toFixed(1)}px;"><span>${r.label}</span></div>`;
      })
      .join('');

    const ringsHtml = `<svg class="range-rings-svg" width="${svgDim}" height="${svgDim}" viewBox="0 0 ${svgDim} ${svgDim}">${circlesSvgHtml}</svg>${labelsHtml}`;

    upsertSmoothMarker(
      ringTargetKey,
      ringCenter,
      'range-rings-marker',
      ringsHtml,
      [0, 0],
      [0, 0],
      -500,
      1.0,
      false,
      undefined,
      { isRings: true }
    );

    // Selected labels get first choice, then threats in their existing priority order.
    const map = mapRef.current;
    const mapSize = map.getSize();
    const mapRect = mapContainerRef.current!.getBoundingClientRect();
    const labelViewport = { left: 8, top: 8, right: mapSize.x - 8, bottom: mapSize.y - 8 };
    const labelObstacles: { rect: { left: number; right: number; top: number; bottom: number }; weight: number }[] = [];
    const root = mapContainerRef.current?.parentElement;
    root?.querySelectorAll('.ais-dropdown-card, .ais-top-actions, .ais-top-left-group, .ais-map-controls-dock, .ais-floating-wind-btn, .ais-floating-support-btn').forEach(element => {
      const r = element.getBoundingClientRect();
      labelObstacles.push({ rect: { left: r.left - mapRect.left, right: r.right - mapRect.left,
        top: r.top - mapRect.top, bottom: r.bottom - mapRect.top }, weight: 20 });
    });
    const ownPixel = map.latLngToContainerPoint([ownShipPosition.lat, ownShipPosition.lon]);
    labelObstacles.push({ rect: { left: ownPixel.x - 18, right: ownPixel.x + 18, top: ownPixel.y - 18, bottom: ownPixel.y + 18 }, weight: 8 });
    const targetPixels = new Map(targets.map(t => [t.id, map.latLngToContainerPoint([t.lat, t.lon])]));
    const renderTargets = [...targets].sort((a, b) => Number(b.id === selectedTarget?.id) - Number(a.id === selectedTarget?.id));
    renderTargets.forEach(t => {
      const isRed = t.risk === 'RED';
      const isOrange = t.risk === 'ORANGE';
      const isSelected = selectedTarget?.id === t.id;
      const ageVisual = getTargetAgeVisual(t, isSelected);

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
      const isDimmed = Boolean(selectedTarget && selectedTarget.id !== t.id);

      let targetVecHtml = '';
      let targetGhostHtml = '';
      let targetVecPx = 0;
      let targetCpaPx = 0;
      let targetGhostPx = 0;
      if (isDragging && t.sog >= 0.3) {
        targetVecPx = ((t.sog * 1852) * (10 / 60)) / mPerPx;
        targetVecHtml = `<div class="vessel-course-vector" style="border-left:2px dashed #ff2d55;opacity:0.9;"></div>`;
      } else if (t.isMoving && !isAnchored && !isMoored && t.sog >= 0.3) {
        targetVecPx = ((t.sog * 1852) * (vecMins / 60)) / mPerPx;
        const vecWidth = isSelected ? 2.2 : 1.5;
        let cpaExtHtml = '';
        if (t.id === activeGhostTargetId && t.sog >= 0.5 && t.tcpa !== null && t.tcpa !== undefined && t.tcpa > 0) {
          targetGhostPx = ((t.sog * 1852) * (t.tcpa / 60)) / mPerPx;
          if (t.tcpa > vecMins) {
            targetCpaPx = targetGhostPx;
            const cpaColor = isRed ? '#ff2d55' : isOrange ? '#ff9500' : color;
            cpaExtHtml = `<div class="vessel-cpa-vector" style="border-left:${isSelected ? 1.8 : 1.2}px dashed ${cpaColor};opacity:0.6;"></div>`;
          }
          if (targetGhostPx >= 45) {
            targetGhostHtml = `<div class="cpa-ghost-vessel"><svg viewBox="0 0 30 30" width="28" height="28"><path d="M 15,2 L 25,25 L 15,19 L 5,25 Z" fill="${mtFill}" stroke="${mtStroke}" stroke-width="1.8" stroke-linejoin="round" /></svg></div>`;
          }
        }
        targetVecHtml = `${cpaExtHtml}<div class="vessel-course-vector" style="width:${vecWidth}px;background:${color};opacity:0.85;"></div>`;
      }

      const targetDivHtml = `
        <div class="ais-target-icon-wrap ${isRed ? 'is-danger-threat' : ''} ${isOrange ? 'is-warning-threat' : ''}">
          ${targetVecHtml}
          ${targetGhostHtml}
          ${pulseHtml}
          ${selectionRing}
          ${iconSvg}
        </div>
      `;

      const isPrimaryThreat = t.id === primaryThreatId;
      const isExtendedLabel = isSelected || isPrimaryThreat;
      const handleTargetInteract = () => {
        setAckedLabels(prev => {
          if (!prev[t.id]) return prev;
          const next = { ...prev };
          delete next[t.id];
          return next;
        });
        const isThreat = isRed || isOrange;
        if (!isSelected) {
          const openMenuImmediately = isPrimaryThreat;
          setSelectedTarget(t);
          onSelectTarget(t.id);
          if (openMenuImmediately) {
            setTargetDetailTab('info');
            setShowListDrawer(true);
          } else {
            setShowListDrawer(false);
          }
          if (isThreat) {
            zoomToCollisionTriangle(t, false);
          } else {
            handleCenterOnTarget(t, openMenuImmediately, false);
          }
        } else if (!showListDrawerRef.current) {
          setTargetDetailTab('info');
          setShowListDrawer(true);
          if (isThreat) {
            zoomToCollisionTriangle(t, false);
          } else {
            handleCenterOnTarget(t, true, false);
          }
        } else {
          setShowListDrawer(false);
          if (isThreat) {
            zoomToCollisionTriangle(t, false);
          } else {
            handleCenterOnTarget(t, false, false);
          }
        }
      };

      upsertSmoothMarker(
        `t:${t.id}`,
        [t.lat, t.lon],
        'ais-target-marker',
        targetDivHtml,
        [28, 28],
        [14, 14],
        isSelected ? 1000 : isRed ? 800 : isOrange ? 600 : 200,
        (isDimmed ? 0.35 : 1.0) * ageVisual.opacity,
        true,
        handleTargetInteract,
        { rot: isClusterStationary ? 0 : rotation, vecLen: targetVecPx, cpaLen: targetCpaPx, ghostDist: targetGhostPx }
      );

      // Etichetta flottante laterale (sincronizzata via upsertSmoothMarker)
      const ackedRisk = ackedLabels[t.id];
      const isAcked = Boolean(ackedRisk && !(ackedRisk === 'ORANGE' && isRed));
      const shouldShowFloatingLabel = !isAcked && !(t.inCluster && !t.isMoving && !isSelected) && (isRed || isOrange || isExtendedLabel);

      if (shouldShowFloatingLabel) {
        const titleColor = isRed ? '#dc2626' : isOrange ? '#ea580c' : '#0f172a';
        const metricColor = isRed ? '#dc2626' : isOrange ? '#ea580c' : '#0284c7';
        const borderColor = isRed ? 'rgba(220,38,38,0.55)' : isOrange ? 'rgba(234,88,12,0.55)' : 'rgba(2,132,199,0.55)';
        const isTargetMoving = t.isMoving !== undefined ? t.isMoving : (!t.isAnchored && !isMoored && t.sog >= 0.3);
        const placeLeft = isTargetMoving && t.cog >= 20 && t.cog <= 160;
        const offsetTransform = 'translate(0px, 0px)';
        const statusLine = (isTargetMoving ? `${t.sog.toFixed(1)} kn • ${Math.round(t.cog)}°` : getVesselStatusLabel(t)) +
          (t.contactLost ? ` • AIS CONTACT LOST · ${formatAge(t.age)}` : ageVisual.stale ? ` • AIS ${formatAge(t.age)}` : '');
        const tcpaTxt = t.tcpa !== null && t.tcpa !== undefined && t.tcpa >= 0 ? ` in ${Math.round(t.tcpa)} min` : '';
        const cpaOrDistLine = isRed
          ? `🚨 ${t.riskMsg || 'COLLISION!'}${t.cpa !== null && t.cpa !== undefined ? ` • CPA: ${formatDist(t.cpa)}` : ''}${tcpaTxt}`
          : `${isOrange ? '⚠️ ' : ''}${t.cpa !== null && t.cpa !== undefined ? `CPA: ${formatDist(t.cpa)}` : `Dist: ${formatDist(t.dist)}`}${tcpaTxt}`;
        const compactMetrics = `${t.cpa !== null && t.cpa !== undefined ? `CPA ${formatDist(t.cpa)}` : formatDist(t.dist)}${t.tcpa !== null && t.tcpa !== undefined && t.tcpa >= 0 ? ` • ${Math.round(t.tcpa)}m` : ''}`;
        let labelHtml = isExtendedLabel
          ? `<div style="transform:${offsetTransform};display:inline-flex;flex-direction:row;align-items:center;gap:6px;background:rgba(255,255,255,0.96);border:1.5px solid ${borderColor};border-radius:10px;padding:4px 8px;box-shadow:0 4px 14px rgba(0,0,0,0.22);white-space:nowrap;font-family:monospace;pointer-events:auto;cursor:pointer;" title="Tap to inspect target"><span style="font-size:18px;line-height:1;">${getVesselTypeIcon(t.type, t.name)}</span><div style="display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;"><span style="font-size:13.5px;font-weight:900;color:${titleColor};text-transform:uppercase;letter-spacing:-0.2px;">${escapeAisLabelText(t.name || 'Unknown')}</span><span style="font-size:10px;font-weight:700;color:#475569;margin-top:1px;">${statusLine}</span><span style="font-size:11px;font-weight:900;color:${metricColor};margin-top:1px;">${escapeAisLabelText(cpaOrDistLine)}</span></div></div>`
          : `<div style="transform:${offsetTransform};display:inline-flex;flex-direction:row;align-items:center;gap:4px;background:rgba(255,255,255,0.78);border:1.5px solid ${borderColor};border-radius:8px;padding:2px 6px;box-shadow:0 2px 6px rgba(0,0,0,0.14);white-space:nowrap;font-family:monospace;pointer-events:auto;cursor:pointer;" title="Tap to select target"><span style="font-size:12px;line-height:1;">${isRed ? '🚨' : '⚠️'}</span><span style="font-size:11px;font-weight:900;color:${metricColor};letter-spacing:-0.3px;">${compactMetrics}</span></div>`;

        // Measure actual HTML dimensions (cached), so font size and long names count.
        const maxLabelWidth = Math.max(40, mapSize.x - 16);
        labelHtml = labelHtml.replace('display:inline-flex;', `max-width:${maxLabelWidth}px;box-sizing:border-box;overflow:hidden;display:inline-flex;`);
        let labelSize = labelSizesRef.current.get(labelHtml);
        if (!labelSize) {
          const measure = document.createElement('div');
          measure.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;';
          measure.innerHTML = labelHtml;
          mapContainerRef.current!.appendChild(measure);
          const rect = measure.firstElementChild!.getBoundingClientRect();
          labelSize = { width: rect.width, height: rect.height };
          measure.remove();
          if (labelSizesRef.current.size >= 100) labelSizesRef.current.delete(labelSizesRef.current.keys().next().value!);
          labelSizesRef.current.set(labelHtml, labelSize);
        }
        const anchor = targetPixels.get(t.id)!;
        const otherSymbols = [...targetPixels.entries()].filter(([id]) => id !== t.id).map(([, pt]) => ({
          rect: { left: pt.x - 16, right: pt.x + 16, top: pt.y - 16, bottom: pt.y + 16 }, weight: 8,
        }));
        const segments: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
        const routeLength = Math.max(targetVecPx, targetGhostPx);
        if (routeLength > 0) {
          const radians = t.cog * Math.PI / 180;
          segments.push({ from: anchor, to: { x: anchor.x + Math.sin(radians) * routeLength, y: anchor.y - Math.cos(radians) * routeLength } });
        }
        const trailCutoff = Date.now() - vecMins * (isSelected ? 1 : 1 / 3) * 60000;
        const trailPixels = (t.trail || []).filter(pt => Number.isFinite(pt.t) && pt.t! >= trailCutoff)
          .map(pt => map.latLngToContainerPoint([pt.lat, pt.lon]));
        trailPixels.push(anchor);
        for (let i = 1; i < trailPixels.length; i++) segments.push({ from: trailPixels[i - 1], to: trailPixels[i] });
        const placement = chooseAisLabelPlacement({ anchor, ...labelSize, viewport: labelViewport,
          obstacles: [...labelObstacles, ...otherSymbols], segments,
          preferredSide: placeLeft ? 'left' : 'right', previousSide: labelSidesRef.current[t.id] });
        labelSidesRef.current[t.id] = placement.side;
        labelObstacles.push({ rect: placement.rect, weight: 12 });
        labelHtml = labelHtml.replace(offsetTransform, `translate(${placement.dx.toFixed(1)}px, ${placement.dy.toFixed(1)}px)`);

        upsertSmoothMarker(
          `lbl:${t.id}`,
          [t.lat, t.lon],
          'ais-threat-floating-label',
          labelHtml,
          [0, 0],
          [0, 0],
          isSelected ? 1100 : (t.id === activeGhostTargetId ? 900 : 50),
          (isExtendedLabel ? (isDimmed ? 0.35 : 1.0) : (isDimmed ? 0.35 : 0.82)) * ageVisual.opacity,
          true,
          handleTargetInteract
        );
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

      // In ispezione mostra l'intero storico configurato; per gli altri target un terzo.
      if (t.isMoving && t.trail && t.trail.length > 0) {
        const refTime = Date.now();
        const maxAgeMs = vecMins * (isSelected ? 1 : 1 / 3) * 60 * 1000;
        const visibleTrail = t.trail.filter(pt => Number.isFinite(pt.t) && pt.t <= refTime && refTime - pt.t <= maxAgeMs);
        const trailPts = visibleTrail.map(pt => [pt.lat, pt.lon] as [number, number]);
        trailPts.push([t.lat, t.lon]);
        if (trailPts.length > 1) {
          const trailLine = L.polyline(trailPts, {
            color: color,
            weight: isSelected ? 1.8 : 1.2,
            dashArray: '2, 4',
            opacity: (isDimmed ? 0.15 : isSelected ? 0.75 : 0.5) * ageVisual.opacity,
            interactive: false,
          });
          markersLayerRef.current?.addLayer(trailLine);
        }
      }
    });

    Object.keys(labelSidesRef.current).forEach(id => {
      if (!activeKeys.has(`lbl:${id}`)) delete labelSidesRef.current[id];
    });
    Object.keys(smoothMarkersRef.current).forEach(k => {
      if (!activeKeys.has(k)) {
        smoothMarkersRef.current[k].remove();
        delete smoothMarkersRef.current[k];
      }
    });
  }, [isActive, targets, ownShipPosition, ownShipCourse, selectedTarget, ackedLabels, mapZoom, zoomSyncTick, isNightMode, onSelectTarget, handleCenterOnTarget, handleCenterOnOwnShip, vectorMinutes, showListDrawer, targetDetailTab]);

  // Zoom handlers (ancorati al bersaglio/propria barca se selezionati, altrimenti al centro dello schermo)
  const handleZoomIn = useCallback(() => {
    if (!mapRef.current) return;
    suspendMapTransitions();
    const currentZoom = mapRef.current.getZoom();
    const newZoom = Math.min(mapRef.current.getMaxZoom() || 18, currentZoom + 1);
    lastIntendedZoomRef.current = newZoom;
    if (followMode !== 'intersection') userFollowZoomRef.current = newZoom;

    if (followMode === 'target' && followedTarget) {
      const newCenter = getOffsetCenter([followedTarget.lat, followedTarget.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else if (selectedTarget) {
      const newCenter = getOffsetCenter([selectedTarget.lat, selectedTarget.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else if (followMode === 'own') {
      const newCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else {
      mapRef.current.zoomIn();
    }
    releaseMapTransitions();
  }, [selectedTarget, followedTarget, followMode, ownShipPosition, getOffsetCenter, suspendMapTransitions, releaseMapTransitions]);

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current) return;
    suspendMapTransitions();
    const currentZoom = mapRef.current.getZoom();
    const newZoom = Math.max(mapRef.current.getMinZoom() || 3, currentZoom - 1);
    lastIntendedZoomRef.current = newZoom;
    if (followMode !== 'intersection') userFollowZoomRef.current = newZoom;

    if (followMode === 'target' && followedTarget) {
      const newCenter = getOffsetCenter([followedTarget.lat, followedTarget.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else if (selectedTarget) {
      const newCenter = getOffsetCenter([selectedTarget.lat, selectedTarget.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else if (followMode === 'own') {
      const newCenter = getOffsetCenter([ownShipPosition.lat, ownShipPosition.lon], newZoom);
      mapRef.current.setView(newCenter, newZoom, { animate: true });
    } else {
      mapRef.current.zoomOut();
    }
    releaseMapTransitions();
  }, [selectedTarget, followedTarget, followMode, ownShipPosition, getOffsetCenter, suspendMapTransitions, releaseMapTransitions]);

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

  // Shared instantaneous priority; the banner separately applies a switching hold.
  const sortedTargets = useMemo(() => [...targets].sort(compareAisTargets), [targets]);

  return (
    <div className={`ais-view-container ${isNightMode ? 'night-mode' : 'day-mode'}`}>
      {/* MAP VIEWPORT */}
      <div ref={mapContainerRef} className="ais-leaflet-map" />

      {/* TOP TACTICAL CONTROL BAR */}
      <div className="ais-top-bar">
        {/* TOP LEFT GROUP: BETA TAG & STATUS COUNTERS */}
        <div className="ais-top-left-group">
          <button type="button" className="ais-beta-tag" title="Open dashboard menu" aria-label="Open dashboard menu" onClick={openDashboardMenu}>
            {mixedSimulation ? 'LIVE + SIM' : 'Beta 2'}
          </button>
          <div
            className="ais-status-counters"
            onClick={onReopenTopThreat}
            title="Tocca per ripristinare il banner d'allarme silenziato"
            role="button"
            tabIndex={0}
          >
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
            className={`ais-tool-btn ${showListDrawer ? 'btn-active' : ''}`}
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
      {showListDrawer && (
        <div
          ref={cardRef}
          className={`ais-dropdown-card ${
            selectedTarget?.risk === 'RED'
              ? 'risk-red'
              : selectedTarget?.risk === 'ORANGE'
                ? 'risk-orange'
                : ''
          }`}
          onWheelCapture={e => e.stopPropagation()}
          onTouchMoveCapture={e => e.stopPropagation()}
        >
          {selectedTarget && (
            /* TARGET DETAIL VIEW */
            <div
              className={`ais-card-detail ${
                selectedTarget.risk === 'RED'
                  ? 'risk-red'
                  : selectedTarget.risk === 'ORANGE'
                    ? 'risk-orange'
                    : ''
              }`}
            >
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
                    restoreCameraSnapshot();
                  }}
                  title="Close"
                >
                  ✕
                </button>
              </div>

              {(selectedTarget.risk === 'RED' || selectedTarget.risk === 'ORANGE') && (
                <button
                  type="button"
                  className="banner-btn ais-detail-snooze"
                  aria-label={`Snooze ${selectedTarget.name || selectedTarget.id} for 10 minutes`}
                  onClick={() => {
                    onSnoozeThreat(selectedTarget.id);
                    setSelectedTarget(null);
                    setShowListDrawer(false);
                  }}
                >
                  SNOOZE 10M
                </button>
              )}

              {selectedTarget.motionDataSync?.status === 'OUT_OF_SYNC' && (
                <div className="ais-detail-alert-box orange">
                  <span className="alert-title">Motion data out of sync</span>
                  <span className="alert-desc">
                    Position, course and speed timestamps differ by more than 20% of the prediction window.
                  </span>
                </div>
              )}
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
                  ⏱️ {selectedTarget.contactLost ? 'AIS CONTACT LOST · ' : ''}{formatAge(selectedTarget.age)}
                </span>
              </div>

              {targetDetailTab === 'telemetry' ? (
                /* KINEMATIC TELEMETRY */
                <div className="ais-card-body-detail">
                  <div className="ais-detail-grid">
                    {selectedTarget.effectiveThresholds && (
                      <div className="ais-detail-cell cell-wide">
                        <span className="ais-cell-label">APPLIED AIS LIMITS</span>
                        <span className="ais-cell-val" style={{ fontSize: '0.85rem' }}>
                          ALARM {formatDist(selectedTarget.effectiveThresholds.redCpa)} • WARNING {formatDist(selectedTarget.effectiveThresholds.orangeCpa)}
                          {' • '}{selectedTarget.effectiveThresholds.horizonTcpa.toFixed(1)} min
                        </span>
                      </div>
                    )}
                    {selectedTarget.warningBasis === 'INSTABILITY' && (
                      <div className="ais-detail-cell cell-wide">
                        <span className="ais-cell-label">ADDITIONAL WARNING</span>
                        <span className="ais-cell-val" style={{ fontSize: '0.85rem' }}>Possible close approach: variable trajectory</span>
                      </div>
                    )}
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
                        {getVesselStatusLabel(selectedTarget)} ({selectedTarget.aisClass ? `AIS ${selectedTarget.aisClass}` : 'AIS CLASS UNKNOWN'})
                      </span>
                    </div>
                    <div className="ais-detail-cell cell-wide">
                      <span className="ais-cell-label">RADIO & FLAG</span>
                      <span className="ais-cell-val">
                        📻 {selectedTarget.callsign || '--'} • {selectedTarget.flag || '--'}
                      </span>
                    </div>
                    {selectedTarget.predictionStability && (
                      <div className="ais-detail-cell cell-wide">
                        <span className="ais-cell-label">TRAJECTORY STABILITY</span>
                        <span className="ais-cell-val">
                          {{ INSUFFICIENT_DATA: 'INSUFFICIENT DATA', STABLE: 'STABLE',
                            VARIABLE: 'VARIABLE', MANEUVERING: 'CHANGE TO CONFIRM', NOT_MOVING: 'STATIONARY' }[selectedTarget.predictionStability.state]}
                        </span>
                      </div>
                    )}
                  </div>

                  {!selectedTarget.isSimulated && <a
                    href={`https://www.vesselfinder.com/vessels?name=${selectedTarget.id.split(':').pop()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-vesselfinder"
                  >
                    🌐 View Photo on VesselFinder
                  </a>}
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
                      style={{ opacity: getTargetAgeVisual(item).opacity }}
                      onClick={() => {
                        if (listBodyRef.current) {
                          listScrollTopRef.current = listBodyRef.current.scrollTop;
                        }
                        setSelectedTarget(item);
                        onSelectTarget(item.id);
                        setTargetDetailTab('info');
                        handleCenterOnTarget(item, true, true);
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
                            {item.contactLost ? ` • AIS CONTACT LOST · ${formatAge(item.age)}` : getTargetAgeVisual(item).stale && ` • AIS ${formatAge(item.age)}`}
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
