import React, { useCallback } from 'react';
import { useDashboard } from './hooks/useDashboard';
import { DataBox } from './components/DataBox';
import { Sparkline } from './components/Sparkline';
import { AnalogGauge } from './components/AnalogGauge';
import { WeatherRadar } from './components/WeatherRadar';
import { MiniCompass } from './components/MiniCompass';
import { BoxType } from './types';

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
  );
};
export default App;
