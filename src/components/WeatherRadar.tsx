import React, { useMemo } from 'react';
import { HistoryPoint, WindRadarSlot, FutureForecast, AppConfig } from '../types';
import {
  CALM_THRESHOLD_KTS,
  ringRadii,
  ARC_STROKE_WIDTH,
  BORDER_STROKE_WIDTH,
  polarToCartesian,
  describeArc,
  calculateActive30mRing,
} from '../utils/radarMath';
import { radToDeg } from '../utils/math';

interface WeatherRadarProps {
  twdHistory: HistoryPoint[];
  twsHistory: HistoryPoint[];
  windRadarSlots: WindRadarSlot[];
  futureForecast: FutureForecast | null;
  headingTrueDeg: number;
  config: AppConfig;
  meteoLed: { active: boolean; color: string; angleTarget: number } | null;
  onSwitchToGauge: () => void;
}

export const WeatherRadar: React.FC<WeatherRadarProps> = ({
  twdHistory,
  twsHistory,
  windRadarSlots,
  futureForecast,
  headingTrueDeg,
  config,
  meteoLed,
  onSwitchToGauge,
}) => {
  // Generate radar ticks
  const radarTicks = useMemo(() => {
    const list: React.ReactNode[] = [];
    for (let i = 0; i < 360; i += 10) {
      const isMajor = i % 30 === 0;
      list.push(
        <line
          key={`rtick-${i}`}
          x1="200"
          y1="40"
          x2="200"
          y2={isMajor ? 60 : 50}
          stroke={isMajor ? '#000' : '#bbb'}
          strokeWidth={isMajor ? 2 : 1}
          transform={`rotate(${i}, 200, 200)`}
        />
      );
    }
    return list;
  }, []);

  const getColorForSpeed = (tws: number) => {
    const r1 = config.graphs.reef1 || 15;
    const r2 = config.graphs.reef2 || 20;
    const r3 = r2 + (r2 - r1);
    if (tws < r1 * 0.4) return '#ffffff';
    if (tws < r1 * 0.75) return '#00C851';
    if (tws < r1) return '#ff9800';
    if (tws < r2) return '#ffaa00';
    if (tws < r2 + (r3 - r2) * 0.5) return '#ff3b30';
    return '#9c27b0';
  };

  const radarRings = useMemo(() => {
    const now = Date.now();
    const current30mSlot = Math.floor(now / 1800000) * 1800000;
    const radarDataList: Array<{
      twdMin: number;
      twdMax: number;
      twsPeak: number;
      twsMin?: number;
      isCalm?: boolean;
      isFuture?: boolean;
    } | null> = [];

    // Ring 0: Future Forecast
    if (futureForecast) {
      const twdDeg = Math.round(radToDeg(futureForecast.twd));
      radarDataList.push({
        twdMin: (twdDeg - 20 + 360) % 360,
        twdMax: (twdDeg + 20 + 360) % 360,
        twsPeak: futureForecast.gust || futureForecast.tws,
        twsMin: futureForecast.tws,
        isFuture: true,
        isCalm: false,
      });
    } else {
      radarDataList.push(null);
    }

    // Ring 1: Active Present 30m mobile ring
    const activeRing = calculateActive30mRing(twdHistory, twsHistory);
    radarDataList.push(activeRing);

    // Rings 2-7: Historical consolidated slots
    const slots = windRadarSlots || [];
    for (let i = 1; i <= 6; i++) {
      const targetTimestamp = current30mSlot - i * 1800000;
      const matched = slots.find(s => s.timestamp === targetTimestamp);
      if (matched) {
        radarDataList.push({
          twdMin: Math.round(radToDeg(matched.twdMin)),
          twdMax: Math.round(radToDeg(matched.twdMax)),
          twsPeak: matched.twsPeak,
          twsMin: matched.twsMin !== undefined ? matched.twsMin : matched.twsPeak,
          isCalm: matched.twsPeak < CALM_THRESHOLD_KTS,
          isFuture: false,
        });
      } else {
        radarDataList.push(null);
      }
    }

    const elements: React.ReactNode[] = [];
    const defGradients: React.ReactNode[] = [];

    radarDataList.forEach((data, index) => {
      if (!data) return;
      const radius = ringRadii[index];
      const gradId = `chord-gradient-${index}`;

      if (data.isCalm || data.twsPeak < CALM_THRESHOLD_KTS) {
        elements.push(
          <circle
            key={`calm-ring-${index}`}
            cx="200"
            cy="200"
            r={radius}
            fill="none"
            stroke="#b0bec5"
            strokeWidth="1.2"
            strokeDasharray="4, 4"
          />
        );
        return;
      }

      const baseTws = data.isFuture && futureForecast ? futureForecast.tws : (data.twsMin ?? data.twsPeak);
      const peakTws = data.isFuture && futureForecast ? futureForecast.gust ?? data.twsPeak : data.twsPeak;

      const baseColor = getColorForSpeed(baseTws);
      const peakColor = getColorForSpeed(peakTws);

      let strokeColor = baseColor;

      if (baseColor !== peakColor) {
        const startPt = polarToCartesian(200, 200, radius, data.twdMax);
        const endPt = polarToCartesian(200, 200, radius, data.twdMin);

        defGradients.push(
          <linearGradient
            key={`grad-${index}`}
            id={gradId}
            x1={startPt.x.toFixed(1)}
            y1={startPt.y.toFixed(1)}
            x2={endPt.x.toFixed(1)}
            y2={endPt.y.toFixed(1)}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor={baseColor} />
            <stop offset="50%" stopColor={peakColor} />
            <stop offset="100%" stopColor={baseColor} />
          </linearGradient>
        );
        strokeColor = `url(#${gradId})`;
      }

      const pathData = describeArc(200, 200, radius, data.twdMin, data.twdMax);

      // Border path
      elements.push(
        <path
          key={`border-${index}`}
          d={pathData}
          fill="none"
          stroke={data.isFuture ? '#90a4ae' : '#000000'}
          strokeWidth={BORDER_STROKE_WIDTH}
          strokeLinecap="round"
          opacity={data.isFuture ? 0.6 : 1}
        />
      );

      // Main colored arc
      elements.push(
        <path
          key={`arc-${index}`}
          id={data.isFuture ? undefined : index === 1 ? 'active-present-arc' : undefined}
          d={pathData}
          fill="none"
          stroke={strokeColor}
          strokeWidth={ARC_STROKE_WIDTH}
          strokeLinecap="round"
          opacity={data.isFuture ? 0.7 : 1}
        />
      );
    });

    return { elements, defGradients };
  }, [futureForecast, twdHistory, twsHistory, windRadarSlots, config.graphs]);

  const ledPoint = useMemo(() => {
    if (!meteoLed) return null;
    return polarToCartesian(200, 200, ringRadii[1], meteoLed.angleTarget);
  }, [meteoLed]);

  return (
    <svg
      id="wind-radar"
      viewBox="35 38 330 395"
      preserveAspectRatio="xMidYMid meet"
      onClick={onSwitchToGauge}
      style={{ cursor: 'pointer' }}
    >
      <defs id="radar-gradients">
        <clipPath id="radar-boat-clip">
          <circle cx="200" cy="200" r="50" />
        </clipPath>
        <filter id="radar-center-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#aaaaaa" floodOpacity={0.5} />
        </filter>
        {radarRings.defGradients}
      </defs>

      <circle cx="200" cy="200" r="160" fill="rgb(252, 252, 252)" />
      <circle cx="200" cy="200" r="125" fill="rgb(240, 240, 240)" />

      <g id="radar-ticks">{radarTicks}</g>

      <g id="radar-tick-labels" fill="#000000" textAnchor="middle" dominantBaseline="middle" fontFamily="Arial" fontWeight="bold">
        <text fontSize="16" transform="translate(200, 74)">N</text>
        <text fontSize="16" transform="translate(326, 200) rotate(90)">E</text>
        <text fontSize="16" transform="translate(74, 200) rotate(-90)">W</text>
        <text fontSize="16" transform="translate(200, 326) rotate(180)">S</text>
        <text fontSize="11" transform="translate(262.5, 91.7) rotate(30)">30</text>
        <text fontSize="11" transform="translate(308.3, 137.5) rotate(60)">60</text>
        <text fontSize="11" transform="translate(308.3, 262.5) rotate(120)">120</text>
        <text fontSize="11" transform="translate(262.5, 308.3) rotate(150)">150</text>
        <text fontSize="11" transform="translate(137.5, 91.7) rotate(-30)">330</text>
        <text fontSize="11" transform="translate(91.7, 137.5) rotate(-60)">300</text>
        <text fontSize="11" transform="translate(91.7, 262.5) rotate(-120)">240</text>
        <text fontSize="11" transform="translate(137.5, 308.3) rotate(-150)">210</text>
      </g>

      {/* Orbit ring */}
      <circle id="ora-orbit" cx="200" cy="200" r={ringRadii[1]} fill="none" stroke="#cfd8dc" strokeWidth="1.2" strokeDasharray="4, 4" />

      {/* Rendered historical arcs */}
      <g id="radar-rings">{radarRings.elements}</g>

      {/* Meteo trend pulsing LED on present arc */}
      {ledPoint && meteoLed && (
        <circle
          cx={ledPoint.x.toFixed(1)}
          cy={ledPoint.y.toFixed(1)}
          r="5.5"
          fill={meteoLed.color}
          className="is-trending"
          filter="url(#radar-center-glow)"
        />
      )}

      {/* Center hotspot */}
      <circle id="radar-hotspot" cx="200" cy="200" r="55" fill="rgb(238, 238, 238)" stroke="#e0e0e0" strokeWidth="1" filter="url(#radar-center-glow)" cursor="pointer" />

      {/* Tactical boat silhouette oriented North-Up by True Heading */}
      <path
        id="radar-boat-icon"
        d="M200,150 Q165,185 170,250 Q165,190 200,173 Q235,190 230,250 Q235,185 200,150 Z"
        fill="#000000"
        transform={`rotate(${headingTrueDeg}, 200, 200) translate(0, 5)`}
        clipPath="url(#radar-boat-clip)"
        style={{ pointerEvents: 'none' }}
      />
    </svg>
  );
};
