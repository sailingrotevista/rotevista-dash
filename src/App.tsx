import React, { useCallback, useEffect, useMemo } from 'react';
import { useDashboard } from './hooks/useDashboard';
import { DataBox } from './components/DataBox';
import { Sparkline } from './components/Sparkline';
import { AnalogGauge } from './components/AnalogGauge';
import { WeatherRadar } from './components/WeatherRadar';
import { MiniCompass } from './components/MiniCompass';
import { AisView } from './components/AisView';
import { AisTacticalBanner } from './components/AisTacticalBanner';
import { BoxType, AisTarget } from './types';

export const App: React.FC = () => {
  const {
    config,
    displayModeSog,
    setDisplayModeSog,
    displayModeTws,
    setDisplayModeTws,
    activeInstrument,
    setActiveInstrument,
    isNightMode,
    setIsNightMode,
    isFocusActive,
    focusedBox,
    graphModes,
    connectionStatus,
    displayValues,
    histories,
    windRadarSlots,
    futureForecast,
    toggleFocusMode,
    toggleGraphMode,
    appView,
    setAppView,
    aisTargets,
    harborClusters,
    topThreat,
    snoozeThreat,
    selectedAisTargetId,
    setSelectedAisTargetId,
    ownShipPosition,
    ownShipCourse,
    propulsionMode,
    setPropulsionMode,
  } = useDashboard();

  // Fullscreen toggle on center hotspot tap
  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Night Mode toggle on 1s press of center hotspot
  const handleToggleNightMode = useCallback(() => {
    setIsNightMode(prev => {
      const next = !prev;
      try {
        const saved = localStorage.getItem('rotevista_dash_state');
        const state = saved ? JSON.parse(saved) : {};
        state.isNightMode = next;
        localStorage.setItem('rotevista_dash_state', JSON.stringify(state));
      } catch (e) {}
      return next;
    });
  }, [setIsNightMode]);

  // Handle Box TWD Long Press -> Switch to Weather Radar
  const handleTwdLongPress = useCallback(() => {
    setActiveInstrument('radar');
  }, [setActiveInstrument]);

  // Handle Box TWD Single Tap in Radar Mode -> Switch back to Gauge
  const handleTwdSingleTap = useCallback(() => {
    if (activeInstrument === 'radar') {
      setActiveInstrument('gauge');
    }
  }, [activeInstrument, setActiveInstrument]);

  // Toggle tra Bussola del Vento e Radar Meteo dal pulsante interno alla bussola
  const handleToggleRadar = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveInstrument(prev => (prev === 'radar' ? 'gauge' : 'radar'));
  }, [setActiveInstrument]);

  // Calcolo del rischio AIS prioritario per il badge lampeggiante sul pulsante AIS
  const highestAisRisk = useMemo<'RED' | 'ORANGE' | null>(() => {
    if (aisTargets.some(t => t.risk === 'RED')) return 'RED';
    if (aisTargets.some(t => t.risk === 'ORANGE')) return 'ORANGE';
    return null;
  }, [aisTargets]);

  const [inspectToken, setInspectToken] = React.useState<number>(0);

  // Ispezione bersaglio dal Banner Tattico: apre direttamente la schermata AIS, seleziona il target ed esegue lo zoom intelligente sul triangolo di collisione
  const handleInspectThreat = useCallback(
    (threat: AisTarget) => {
      setSelectedAisTargetId(threat.id);
      setInspectToken(Date.now());
      setAppView('ais');
    },
    [setSelectedAisTargetId, setAppView]
  );

  // Navigazione a gesture: Two-finger horizontal swipe per passare tra Vento e AIS senza interferire con la mappa
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let isTwoFingerTouch = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        isTwoFingerTouch = true;
        startX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        startY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      } else {
        isTwoFingerTouch = false;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!isTwoFingerTouch) return;
      isTwoFingerTouch = false;
      const endX = e.changedTouches[0]?.clientX ?? startX;
      const endY = e.changedTouches[0]?.clientY ?? startY;
      const dx = endX - startX;
      const dy = endY - startY;

      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        setAppView(prev => (prev === 'wind' ? 'ais' : 'wind'));
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [setAppView]);

  const isLeftFocused = focusedBox && ['stw', 'sog', 'hdg', 'cog', 'tack'].includes(focusedBox);
  const containerClasses = [
    'main-container',
    isFocusActive ? 'focus-active' : '',
    isFocusActive && isLeftFocused ? 'focus-side-left' : '',
    isFocusActive && !isLeftFocused ? 'focus-side-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`app-root-wrapper ${isNightMode ? 'night-theme' : ''}`}>
      {/* Banner Allarme Tattico ARPA (Visibile sia in Vento che in AIS) */}
      <AisTacticalBanner
        threat={topThreat}
        onInspect={handleInspectThreat}
        onSnooze={snoozeThreat}
        isNightMode={isNightMode}
      />

      <div style={{ display: appView === 'wind' ? 'block' : 'none', width: '100%', height: '100%' }}>
        <div className={containerClasses}>
      {/* ================= COLONNA SINISTRA ================= */}
      {/* 1. STW */}
      <DataBox
        type="stw"
        label="STW"
        unit="kts"
        value={displayValues.stw}
        isFocused={focusedBox === 'stw'}
        isHercules={graphModes.stw === 'hercules'}
        onLongPress={() => toggleFocusMode('stw')}
        onDoubleTap={() => toggleGraphMode('stw')}
      >
        <div className="graph-wrapper">
          <Sparkline
            id="stw-graph"
            type="stw"
            data={histories.stw}
            config={config}
            mode={graphModes.stw}
            isNavigating={displayValues.isNavigating}
            displayMode="STW"
            isFocused={focusedBox === 'stw'}
          />
        </div>
      </DataBox>

      {/* 2. SOG / VMG */}
      <DataBox
        type="sog"
        label={displayModeSog}
        unit="kts"
        value={displayValues.sog}
        valueColor={displayValues.sogColor}
        isFocused={focusedBox === 'sog'}
        isHercules={graphModes.sog === 'hercules'}
        onLongPress={() => toggleFocusMode('sog')}
        onDoubleTap={() => toggleGraphMode('sog')}
        onSingleTap={() => {
          if (!isFocusActive) {
            setDisplayModeSog(prev => (prev === 'SOG' ? 'VMG' : 'SOG'));
          } else {
            toggleFocusMode('sog');
          }
        }}
      >
        <div className="graph-wrapper">
          <Sparkline
            id="sog-graph"
            type="sog"
            data={displayModeSog === 'VMG' ? histories.vmg : histories.sog}
            config={config}
            mode={graphModes.sog}
            isNavigating={displayValues.isNavigating}
            displayMode={displayModeSog}
            isFocused={focusedBox === 'sog'}
          />
        </div>
      </DataBox>

      {/* 3. HEADING (MEAN) */}
      <DataBox
        type="hdg"
        label="HEADING (MEAN)"
        value={displayValues.hdg}
        isLargeValue
        unstable={displayValues.hdgUnstable}
        isFocused={focusedBox === 'hdg'}
        onLongPress={() => toggleFocusMode('hdg')}
        onSingleTap={() => {
          if (isFocusActive) toggleFocusMode('hdg');
        }}
      />

      {/* 4. COG (MEAN) */}
      <DataBox
        type="cog"
        label="COG (MEAN)"
        value={displayValues.cog}
        isLargeValue
        unstable={displayValues.cogUnstable}
        isFocused={focusedBox === 'cog'}
        onLongPress={() => toggleFocusMode('cog')}
        onSingleTap={() => {
          if (isFocusActive) toggleFocusMode('cog');
        }}
      />

      {/* 5. TACK / GYBE OPPOSITE COURSE */}
      <DataBox
        type="tack"
        label={displayValues.tackLabel}
        isFocused={focusedBox === 'tack'}
        onLongPress={() => toggleFocusMode('tack')}
        onSingleTap={() => {
          if (isFocusActive) toggleFocusMode('tack');
        }}
      >
        <div className="dual-value-container">
          <div className="dual-value-col tack-hdg-col">
            <span className="dual-label">HDG</span>
            <span
              className={`value dual-val ${displayValues.tackHdgUnstable ? 'unstable-data' : ''}`}
              id="tack-hdg"
            >
              {displayValues.tackHdg}
            </span>
          </div>
          <div className="dual-value-col tack-cog-col">
            <span className="dual-label">COG</span>
            <span
              className={`value dual-val ${displayValues.tackCogUnstable ? 'unstable-data' : ''}`}
              id="tack-cog"
            >
              {displayValues.tackCog}
            </span>
          </div>
        </div>
      </DataBox>

      {/* ================= BUSSOLA CENTRALE ================= */}
      <div className="box-gauge">
        {/* STATO CONNESSIONE */}
        <div id="status" className={connectionStatus.className}>
          {connectionStatus.text}
        </div>

        <div className="gauge-viewport-wrapper">
          <div className="gauge-inner-frame">
            {activeInstrument === 'gauge' ? (
              <AnalogGauge
                awsVal={parseFloat(displayValues.awsSvg) || 0}
                awaDeg={displayValues.awaPointerDeg}
                twaDeg={displayValues.twaPointerDeg}
                leewayDeg={displayValues.leewayDeg}
                trackDeg={displayValues.trackRotDeg}
                tacticCwDot={displayValues.tacticCwDot}
                tacticCcwDot={displayValues.tacticCcwDot}
                onCenterHotspotLongPress={handleToggleNightMode}
                onCenterHotspotClick={handleToggleFullscreen}
              />
            ) : (
              <WeatherRadar
                twdHistory={histories.twd}
                twsHistory={histories.tws}
                windRadarSlots={windRadarSlots}
                futureForecast={futureForecast}
                headingTrueDeg={displayValues.boatCompassRotDeg}
                config={config}
                meteoLed={displayValues.meteoLed}
                onSwitchToGauge={() => setActiveInstrument('gauge')}
              />
            )}

            {/* Comando Sinistro: Toggle Radar Meteo / Bussola */}
            <button
              type="button"
              className={`compass-inner-btn compass-btn-left ${activeInstrument === 'radar' ? 'active-radar' : ''}`}
              onClick={handleToggleRadar}
              title={activeInstrument === 'radar' ? 'Torna alla Bussola del Vento' : 'Attiva Radar Meteo'}
              aria-label="Toggle Radar Meteo"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" strokeOpacity="0.75" />
                <circle cx="12" cy="12" r="5" strokeOpacity="0.85" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                <line x1="12" y1="12" x2="18" y2="6" strokeLinecap="round" />
              </svg>
            </button>

            {/* Comando Destro: Mappa Tattica AIS con pallino dinamico Rosso / Arancione */}
            <button
              type="button"
              className="compass-inner-btn compass-btn-right"
              onClick={e => {
                e.stopPropagation();
                setAppView('ais');
              }}
              title="Apri Mappa Tattica AIS e Bersagli"
              aria-label="Mappa Tattica AIS"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L19 21L12 17L5 21L12 2Z" fill="rgba(0,0,0,0.12)" stroke="currentColor" />
              </svg>
              {highestAisRisk && (
                <span
                  className={`ais-threat-badge-pulse ${highestAisRisk === 'RED' ? 'pulse-red' : 'pulse-orange'}`}
                  aria-label={`Allarme collisione AIS: ${highestAisRisk}`}
                />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ================= COLONNA DESTRA ================= */}
      {/* 6. DEPTH */}
      <DataBox
        type="depth"
        label="DEPTH"
        unit="m"
        value={displayValues.depth}
        alarmClass={displayValues.depthAlarmClass}
        isFocused={focusedBox === 'depth'}
        isHercules={graphModes.depth === 'hercules'}
        onLongPress={() => toggleFocusMode('depth')}
        onDoubleTap={() => toggleGraphMode('depth')}
      >
        <div className="graph-wrapper">
          <Sparkline
            id="depth-graph"
            type="depth"
            data={histories.depth}
            config={config}
            mode={graphModes.depth}
            isNavigating={displayValues.isNavigating}
            displayMode="DEPTH"
            isFocused={focusedBox === 'depth'}
            isNightMode={isNightMode}
          />
        </div>
      </DataBox>

      {/* 7. TWS / AWS */}
      <DataBox
        type="tws"
        label={displayModeTws}
        unit="kts"
        value={displayValues.tws}
        valueColor={displayValues.twsColor}
        isFocused={focusedBox === 'tws'}
        isHercules={graphModes.tws === 'hercules'}
        onLongPress={() => toggleFocusMode('tws')}
        onDoubleTap={() => toggleGraphMode('tws')}
        onSingleTap={() => {
          if (!isFocusActive) {
            setDisplayModeTws(prev => (prev === 'TWS' ? 'AWS' : 'TWS'));
          } else {
            toggleFocusMode('tws');
          }
        }}
      >
        <div className="graph-wrapper">
          <Sparkline
            id="tws-graph"
            type="tws"
            data={displayModeTws === 'AWS' ? histories.aws : histories.tws}
            config={config}
            mode={graphModes.tws}
            isNavigating={displayValues.isNavigating}
            displayMode={displayModeTws}
            isFocused={focusedBox === 'tws'}
            isNightMode={isNightMode}
          />
        </div>
      </DataBox>

      {/* 8. TWA (MEAN) */}
      <DataBox
        type="twa"
        label="TWA (MEAN)"
        value={displayValues.twaAvg}
        isLargeValue
        unstable={displayValues.twaUnstable}
        isFocused={focusedBox === 'twa'}
        onLongPress={() => toggleFocusMode('twa')}
        onSingleTap={() => {
          if (isFocusActive) toggleFocusMode('twa');
        }}
      />

      {/* 9. AWA (MEAN) */}
      <DataBox
        type="awa"
        label="AWA (MEAN)"
        value={displayValues.awaAvg}
        isLargeValue
        unstable={displayValues.awaUnstable}
        isFocused={focusedBox === 'awa'}
        onLongPress={() => toggleFocusMode('awa')}
        onSingleTap={() => {
          if (isFocusActive) toggleFocusMode('awa');
        }}
      />

      {/* 10. TWD (MEAN) WITH MINI COMPASS */}
      <DataBox
        type="twd"
        label="TWD (MEAN)"
        isFocused={focusedBox === 'twd'}
        onLongPress={handleTwdLongPress}
        onSingleTap={handleTwdSingleTap}
      >
        <div className="value-with-compass">
          <MiniCompass
            boatRotDeg={displayValues.boatCompassRotDeg}
            windRotDeg={displayValues.windCompassRotDeg}
            compassCwDot={displayValues.compassCwDot}
            compassCcwDot={displayValues.compassCcwDot}
          />
          <span
            className={`value-large ${displayValues.twdUnstable ? 'unstable-data' : ''}`}
            id="twd-avg"
          >
            {displayValues.twdAvg}
          </span>
        </div>
      </DataBox>
    </div>
      </div>

      <div style={{ display: appView === 'ais' ? 'block' : 'none', width: '100%', height: '100%' }}>
        <AisView
          isActive={appView === 'ais'}
          targets={aisTargets}
          harborClusters={harborClusters}
          ownShipPosition={ownShipPosition}
          ownShipCourse={ownShipCourse}
          isNightMode={isNightMode}
          onSwitchToWind={() => setAppView('wind')}
          onSnoozeThreat={snoozeThreat}
          selectedTargetId={selectedAisTargetId}
          onSelectTarget={setSelectedAisTargetId}
          ownShipName={config?.vesselName}
          propulsionMode={propulsionMode}
          onSetPropulsionMode={setPropulsionMode}
          inspectToken={inspectToken}
        />
      </div>
    </div>
  );
};
export default App;
