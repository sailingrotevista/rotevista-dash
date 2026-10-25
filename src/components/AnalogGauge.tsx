import React, { useMemo, useEffect, useRef } from 'react';

interface AnalogGaugeProps {
  awsVal: number | null;
  awaDeg: number;
  awaAvailable: boolean;
  twaDeg: number;
  twaAvailable: boolean;
  leewayDeg: number | null;
  trackDeg: number;
  tacticCwDot: { active: boolean; color: string; gybing?: boolean };
  tacticCcwDot: { active: boolean; color: string; gybing?: boolean };
  onCenterHotspotLongPress: () => void;
  onCenterHotspotClick: () => void;
}

export const AnalogGauge: React.FC<AnalogGaugeProps> = React.memo(({
  awsVal,
  awaDeg,
  awaAvailable,
  twaDeg,
  twaAvailable,
  leewayDeg,
  trackDeg,
  tacticCwDot,
  tacticCcwDot,
  onCenterHotspotLongPress,
  onCenterHotspotClick,
}) => {
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);

  // Generate compass ticks
  const ticks = useMemo(() => {
    const list: React.ReactNode[] = [];
    for (let i = 0; i < 360; i += 10) {
      const isMajor = i % 30 === 0;
      list.push(
        <line
          key={`tick-${i}`}
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

  const clampedLeeway = Math.max(-20, Math.min(20, leewayDeg ?? 0));
  const c = 150;
  const px = 150 / 20;
  const leewayWidth = Math.min(Math.abs(clampedLeeway) * px, 150);
  const leewayX = clampedLeeway >= 0 ? c : c - leewayWidth;

  const handlePointerDown = () => {
    isLongPressRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      onCenterHotspotLongPress();
    }, 1000);
  };

  const handlePointerUp = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (!isLongPressRef.current) {
      onCenterHotspotClick();
    }
    isLongPressRef.current = false;
  };

  const handlePointerLeave = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    isLongPressRef.current = false;
  };

  return (
    <svg id="wind-gauge" viewBox="35 38 330 395" preserveAspectRatio="xMidYMid meet">
      <defs>
        <clipPath id="boat-clip">
          <circle cx="200" cy="200" r="50" />
        </clipPath>
        <linearGradient id="axiom-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
          <stop offset="100%" stopColor="#888888" stopOpacity={1} />
        </linearGradient>
        <linearGradient id="leeway-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#ff0000" stopOpacity={1} />
          <stop offset="25%" stopColor="#ff8800" stopOpacity={1} />
          <stop offset="50%" stopColor="#00ff00" stopOpacity={1} />
          <stop offset="75%" stopColor="#ff8800" stopOpacity={1} />
          <stop offset="100%" stopColor="#ff0000" stopOpacity={1} />
        </linearGradient>
        <linearGradient id="leeway-night-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#ff0000" stopOpacity={1} />
          <stop offset="50%" stopColor="#330000" stopOpacity={1} />
          <stop offset="100%" stopColor="#ff0000" stopOpacity={1} />
        </linearGradient>
        <clipPath id="leeway-clip">
          <rect id="leeway-mask-rect" x={leewayX} y="0" width={leewayWidth} height="12" rx="2" />
        </clipPath>
        <filter id="center-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#aaaaaa" floodOpacity={0.5} />
        </filter>
      </defs>

      {/* Dials */}
      <circle cx="200" cy="200" r="160" fill="#050505" />
      <circle cx="200" cy="200" r="125" fill="#121212" />

      {/* Beating & Running Arcs */}
      <path d="M 82.0 101.0 A 154 154 0 0 1 142.3 57.2" fill="none" stroke="#ff0000" strokeWidth="12" />
      <path d="M 257.7 57.2 A 154 154 0 0 1 318.0 101.0" fill="none" stroke="#00ff00" strokeWidth="12" />
      <path d="M 265.1 339.6 A 154 154 0 0 1 134.9 339.6" fill="none" stroke="#ff8800" strokeWidth="12" />

      {/* Ticks */}
      <g id="ticks">{ticks}</g>

      {/* Tick Labels */}
      <g id="tick-labels" fill="#bbb" textAnchor="middle" dominantBaseline="middle" fontFamily="Arial" fontWeight="bold">
        <text fontSize="16" transform="translate(200, 74)">0</text>
        <text fontSize="16" transform="translate(326, 200) rotate(90)">90</text>
        <text fontSize="16" transform="translate(74, 200) rotate(-90)">90</text>
        <text fontSize="16" transform="translate(200, 326) rotate(180)">180</text>
        <text fontSize="11" transform="translate(262.5, 91.7) rotate(30)">30</text>
        <text fontSize="11" transform="translate(308.3, 137.5) rotate(60)">60</text>
        <text fontSize="11" transform="translate(308.3, 262.5) rotate(120)">120</text>
        <text fontSize="11" transform="translate(262.5, 308.3) rotate(150)">150</text>
        <text fontSize="11" transform="translate(137.5, 91.7) rotate(-30)">30</text>
        <text fontSize="11" transform="translate(91.7, 137.5) rotate(-60)">60</text>
        <text fontSize="11" transform="translate(91.7, 262.5) rotate(-120)">120</text>
        <text fontSize="11" transform="translate(137.5, 308.3) rotate(-150)">150</text>
      </g>

      {/* Track / Leeway Drift Pointer */}
      <g visibility={leewayDeg === null ? "hidden" : undefined} id="track-pointer" transform={`rotate(${trackDeg}, 200, 200)`}>
        <path d="M200,42 L194,58 L206,58 Z" fill="#007aff" stroke="#fff" strokeWidth="0.5" />
      </g>

      {/* Center Interactive Hotspot */}
      <circle
        id="fullscreen-hotspot"
        cx="200"
        cy="200"
        r="55"
        fill="#181818"
        stroke="#333"
        strokeWidth="1"
        filter="url(#center-glow)"
        cursor="pointer"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />

      {/* Boat Silhouette */}
      <path
        id="boat-icon"
        d="M200,150 Q165,185 170,250 Q165,190 200,173 Q235,190 230,250 Q235,185 200,150 Z"
        fill="url(#axiom-grad)"
        transform="translate(0, 5)"
        clipPath="url(#boat-clip)"
        style={{ pointerEvents: 'none' }}
      />

      {/* AWS Center Display */}
      <g id="aws-display-group" transform="translate(200, 265)">
        <text x="0" y="0" fill="#777" fontSize="10" fontWeight="bold" textAnchor="middle" style={{ textTransform: 'uppercase' }}>
          Apparent Wind kts
        </text>
        <text id="aws-val-svg" x="0" y="42" fill="#fff" fontSize="52" fontWeight="bold" textAnchor="middle">
          {awsVal === null ? '--.-' : awsVal.toFixed(1)}
        </text>
      </g>

      {/* AWA Pointer (Orange with 'A') */}
      <g visibility={awaAvailable ? 'visible' : 'hidden'} id="awa-pointer" transform={`rotate(${awaDeg}, 200, 200)`} opacity={0.9}>
        <path d="M 200,70 L 213,95 L 200,145 L 187,95 Z" fill="#ff8c00" stroke="#000" strokeWidth="1" />
        <text x="200" y="90" fill="#000" fontSize="10" fontWeight="900" textAnchor="middle" fontFamily="Arial Black">
          A
        </text>
      </g>

      {/* TWA Pointer (Yellow with 'T') and Tactical Trend Dots */}
      <g visibility={twaAvailable ? undefined : "hidden"} id="twa-pointer" transform={`rotate(${twaDeg}, 200, 200)`} opacity={0.9}>
        <path
          d="M 200,92 A 8,8 0 0 1 208,100 C 208,108 200,128 200,128 C 200,128 192,108 192,100 A 8,8 0 0 1 200,92 Z"
          fill="#ffff00"
          stroke="#000"
          strokeWidth="0.8"
        />
        <text x="200" y="106" fill="#000" fontSize="9" fontWeight="900" textAnchor="middle" fontFamily="Arial Black">
          T
        </text>
        <circle
          id="trend-gauge-cw"
          cx="215"
          cy="110"
          r="4"
          fill={tacticCwDot.color}
          className={`${tacticCwDot.active ? 'is-trending' : ''} ${tacticCwDot.gybing ? 'is-gybing' : ''}`}
        />
        <circle
          id="trend-gauge-ccw"
          cx="185"
          cy="110"
          r="4"
          fill={tacticCcwDot.color}
          className={`${tacticCcwDot.active ? 'is-trending' : ''} ${tacticCcwDot.gybing ? 'is-gybing' : ''}`}
        />
      </g>

      {/* Leeway Bar Indicator */}
      <g transform="translate(50, 395)">
        <text x="150" y="-12" id="leeway-val" fill="#aaa" fontSize="11" textAnchor="middle" fontWeight="bold">
          {leewayDeg === null ? "LEEWAY: —" : `LEEWAY: ${clampedLeeway.toFixed(1)}°`}
        </text>
        <rect x="0" y="0" width="300" height="12" fill="#222" rx="3" />
        <rect x="0" y="0" width="300" height="12" fill="url(#leeway-grad)" clipPath="url(#leeway-clip)" rx="3" />
        <g stroke="#555" strokeWidth="1">
          <line x1="0" y1="-2" x2="0" y2="14" />
          <line x1="75" y1="2" x2="75" y2="10" />
          <line x1="150" y1="-2" x2="150" y2="14" />
          <line x1="225" y1="2" x2="225" y2="10" />
          <line x1="300" y1="-2" x2="300" y2="14" />
        </g>
        <g fill="#555" fontSize="8" textAnchor="middle" fontWeight="bold">
          <text x="0" y="24">-20°</text>
          <text x="75" y="24">-10</text>
          <text x="150" y="24">0°</text>
          <text x="225" y="24">10</text>
          <text x="300" y="24">20°</text>
        </g>
      </g>
    </svg>
  );
});
