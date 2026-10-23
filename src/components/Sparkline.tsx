import React, { useMemo } from 'react';
import { HistoryPoint, AppConfig, GraphMode } from '../types';

interface SparklineProps {
  id: string;
  type: 'stw' | 'sog' | 'depth' | 'tws';
  data: HistoryPoint[];
  config: AppConfig;
  mode: GraphMode;
  isNavigating: boolean;
  displayMode: string;
  isFocused: boolean;
  isNightMode?: boolean;
  onScaleChange?: (min: number, max: number) => void;
}

export const Sparkline: React.FC<SparklineProps> = React.memo(({
  id,
  type,
  data,
  config,
  mode,
  isNavigating,
  displayMode,
  isFocused,
  isNightMode = false,
}) => {
  const w = 200;
  const h = 40;

  const visibleMinutes = (config.graphs.historyMinutes || 5) * (isNavigating ? 1 : 2);
  const viewportMs = visibleMinutes * 60000;
  const latestTime = data && data.length > 0 ? data[data.length - 1].time : 0;
  const viewportStart = latestTime - viewportMs;

  // 1. FILTER, SORT AND DEDUPLICATE STRICTLY BY TIME
  const visibleData = useMemo(() => {
    if (!data || data.length === 0) return [];

    // Filter points in viewport
    const inRange = data.filter(p => p && isFinite(p.val) && typeof p.time === 'number' && p.time >= viewportStart);

    // Sort ascending by time
    inRange.sort((a, b) => a.time - b.time);

    // Strictly ensure time increases monotonically (no duplicates, no backward steps)
    const sanitized: HistoryPoint[] = [];
    for (let i = 0; i < inRange.length; i++) {
      const pt = inRange[i];
      if (sanitized.length === 0 || pt.time > sanitized[sanitized.length - 1].time) {
        sanitized.push(pt);
      }
    }
    return sanitized;
  }, [data, viewportStart]);

  // 2. SCALE CALCULATION (Exact match with original charts.js calculateScale)
  const { min, max } = useMemo(() => {
    const s = config.scales[type] || { stdMax: 10, step: 2, hercSpan: 2 };
    if (!visibleData || visibleData.length === 0) {
      return { min: 0, max: s.stdMax };
    }

    const values = visibleData.map(p => p.val);
    const currentVal = values[values.length - 1];

    if (type === 'depth') {
      const shallowThreshold = Math.max(s.stdMax, 10);
      if (mode !== 'hercules') {
        const maxHistorico = Math.max(...values);
        if (currentVal <= shallowThreshold) {
          return { min: 0, max: shallowThreshold };
        }
        return { min: 0, max: Math.max(s.stdMax, Math.ceil(maxHistorico / s.step) * s.step) };
      } else {
        const roundStep = s.hercSpan;
        const localMin = Math.min(...values);
        const localMax = Math.max(...values);
        let targetMin = 0;
        if (localMin > shallowThreshold) {
          targetMin = Math.max(0, Math.floor(localMin / roundStep) * roundStep);
        }
        let targetMax = Math.ceil(localMax / roundStep) * roundStep;
        if (targetMax - targetMin < 4) {
          targetMax = targetMin + 4;
        }
        return { min: targetMin, max: targetMax };
      }
    }

    // STW, SOG, TWS
    if (mode !== 'hercules') {
      const maxHistorico = Math.max(...values);
      return { min: 0, max: Math.max(s.stdMax, Math.ceil(maxHistorico / s.step) * s.step) };
    } else {
      const roundStep = s.hercSpan;
      const oneThirdCount = Math.max(1, Math.floor(values.length / 3));
      const recentThirdData = values.slice(-oneThirdCount);
      const localMin = Math.min(...recentThirdData);
      const localMax = Math.max(...recentThirdData);

      let targetMin = Math.max(0, Math.floor(localMin / roundStep) * roundStep);
      let targetMax = Math.ceil(localMax / roundStep) * roundStep;
      if (targetMax - targetMin === 0) {
        targetMax = targetMin + roundStep;
      }
      return { min: targetMin, max: targetMax };
    }
  }, [visibleData, config.scales, type, mode]);

  const range = Math.max(0.1, max - min);
  const isDepth = type === 'depth';
  const isTws = type === 'tws';

  const colDanger = '#ff3b30';
  const colWarning = '#ff9800';
  const colTws = isNightMode ? '#8cb4cc' : '#2c3e50';
  const colAws = '#5c6bc0';
  const colDepth = isNightMode ? '#33aadd' : '#0088cc';
  const colStw = '#00C851';
  const colSog = '#ffbb33';
  const colVmg = '#00b8d4';

  const getColorProps = (val: number) => {
    const baseStroke = isFocused ? '4.2' : '1.6';
    const alertStroke = isFocused ? '4.8' : '2.2';
    const warnStroke = isFocused ? '4.4' : '1.8';

    let color = colTws;
    let opacity = '0.15';
    let stroke = baseStroke;

    if (isTws) {
      const baseWind = displayMode === 'AWS' ? colAws : colTws;
      const r1 = config.graphs.reef1 || 15;
      const r2 = config.graphs.reef2 || 20;
      const r3 = r2 + (r2 - r1);

      if (val >= r3) {
        color = '#9c27b0';
        opacity = '0.65';
        stroke = alertStroke;
      } else if (val >= r2) {
        color = colDanger;
        opacity = '0.55';
        stroke = alertStroke;
      } else if (val >= r1) {
        color = colWarning;
        opacity = '0.45';
        stroke = warnStroke;
      } else {
        color = baseWind;
      }
    } else if (isDepth) {
      if (val < config.alarms.depthDanger) {
        color = colDanger;
        opacity = '0.55';
        stroke = alertStroke;
      } else if (val < config.alarms.depthWarning) {
        color = colWarning;
        opacity = '0.45';
        stroke = warnStroke;
      } else {
        color = colDepth;
      }
    } else {
      if (id.includes('stw')) color = colStw;
      else if (id.includes('sog')) color = displayMode === 'VMG' ? colVmg : colSog;
    }
    return { color, opacity, stroke };
  };

  // Horizontal gridlines
  const horizontalGridY = [0.25, 0.5, 0.75].map(p => h - p * h);

  // Vertical time gridlines (passo divisibile proporzionale alla durata totale)
  const gridInterval =
    visibleMinutes <= 10 ? 1 : visibleMinutes <= 30 ? 5 : visibleMinutes <= 60 ? 10 : 20;
  const verticalGridX: number[] = [];
  for (let m = gridInterval; m < visibleMinutes; m += gridInterval) {
    verticalGridX.push(w - (m / visibleMinutes) * w);
  }

  // Depth warning and danger lines
  const dangerY =
    isDepth && config.alarms.depthDanger >= min && config.alarms.depthDanger <= max
      ? h - ((config.alarms.depthDanger - min) / range) * h
      : null;
  const warningY =
    isDepth && config.alarms.depthWarning >= min && config.alarms.depthWarning <= max
      ? h - ((config.alarms.depthWarning - min) / range) * h
      : null;
  const alarmStrokeWidth = isFocused ? '4.8' : '1.8';

  // 3. CURVE AND AREA GEOMETRY GENERATION
  const { lineElements, areaPath, gradientStops } = useMemo(() => {
    if (visibleData.length < 2) {
      return { lineElements: [], areaPath: '', gradientStops: [] };
    }

    const lines: React.ReactNode[] = [];
    let path = '';
    const stops: Array<{ offset: number; color: string; opacity: string }> = [];
    let started = false;

    const expectedInterval = viewportMs / (config.graphs.samples || 60);
    const maxAllowedGap = Math.max(expectedInterval * 2.5, 90000);

    for (let i = 1; i < visibleData.length; i++) {
      const pA = visibleData[i - 1];
      const pB = visibleData[i];

      const x1 = Math.max(0, Math.min(w, ((pA.time - viewportStart) / viewportMs) * w));
      const x2 = Math.max(0, Math.min(w, ((pB.time - viewportStart) / viewportMs) * w));
      const y1 = h - Math.max(0, Math.min(1, (pA.val - min) / range)) * h;
      const y2 = h - Math.max(0, Math.min(1, (pB.val - min) / range)) * h;

      const deltaTime = pB.time - pA.time;
      const isHistoryGap = deltaTime <= 0 || deltaTime > maxAllowedGap;

      const props = getColorProps(pB.val);
      const offset1 = Math.max(0, Math.min(100, (x1 / w) * 100));
      const offset2 = Math.max(0, Math.min(100, (x2 / w) * 100));

      stops.push({ offset: offset1, color: props.color, opacity: props.opacity });
      stops.push({ offset: offset2, color: props.color, opacity: props.opacity });

      if (isHistoryGap) {
        if (started) {
          path += `L ${x1} ${h} `;
          started = false;
        }
      } else {
        lines.push(
          <line
            key={`seg-${i}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={props.color}
            strokeWidth={props.stroke}
            strokeLinecap="round"
            shapeRendering="geometricPrecision"
            vectorEffect="non-scaling-stroke"
          />
        );

        if (!started) {
          path += `M ${x1} ${h} L ${x1} ${y1} `;
          started = true;
        }
        path += `L ${x2} ${y2} `;
      }
    }

    if (started && visibleData.length > 0) {
      const last = visibleData[visibleData.length - 1];
      const lastX = Math.max(0, Math.min(w, ((last.time - viewportStart) / viewportMs) * w));
      path += `L ${lastX} ${h} Z`;
    }

    return { lineElements: lines, areaPath: path, gradientStops: stops };
  }, [visibleData, viewportStart, viewportMs, min, range, isFocused, displayMode, isNightMode, config.graphs, config.alarms]);

  const gradId = `grad-${id}`;

  return (
    <>
      <div className="scale-labels" id={`${type}-scale`}>
        <span>{Math.round(max)}</span>
        <span>{Math.round((min + max) / 2)}</span>
        <span>{Math.round(min)}</span>
      </div>
      <svg className="sparkline" id={id} viewBox="0 0 200 40" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2={w} y2="0" gradientUnits="userSpaceOnUse">
            {gradientStops.map((stop, idx) => (
              <stop key={idx} offset={`${stop.offset}%`} stopColor={stop.color} stopOpacity={stop.opacity} />
            ))}
          </linearGradient>
        </defs>

        {/* Horizontal gridlines */}
        {horizontalGridY.map((y, i) => (
          <line
            key={`hg-${i}`}
            x1="0"
            y1={y}
            x2={w}
            y2={y}
            stroke="rgba(0,0,0,0.12)"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Vertical time gridlines */}
        {verticalGridX.map((x, i) => (
          <line
            key={`vg-${i}`}
            x1={x}
            y1="0"
            x2={x}
            y2={h}
            stroke="rgba(0,0,0,0.08)"
            strokeWidth="0.4"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Depth warning and danger lines */}
        {dangerY !== null && (
          <line
            x1="4"
            y1={dangerY}
            x2={w - 4}
            y2={dangerY}
            stroke="rgba(255, 59, 48, 0.95)"
            strokeWidth={alarmStrokeWidth}
            strokeDasharray="12, 6, 2, 6"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {warningY !== null && (
          <line
            x1="4"
            y1={warningY}
            x2={w - 4}
            y2={warningY}
            stroke="rgba(255, 204, 0, 0.95)"
            strokeWidth={alarmStrokeWidth}
            strokeDasharray="6, 2, 6, 12"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Gradient fill area */}
        {areaPath && <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />}

        {/* Sparkline segments */}
        {lineElements}
      </svg>
    </>
  );
});
