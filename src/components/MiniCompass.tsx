import React from 'react';

interface MiniCompassProps {
  boatRotDeg: number;
  windRotDeg: number;
  compassCwDot: { active: boolean; color: string; blinking?: boolean };
  compassCcwDot: { active: boolean; color: string; blinking?: boolean };
}

export const MiniCompass: React.FC<MiniCompassProps> = ({
  boatRotDeg,
  windRotDeg,
  compassCwDot,
  compassCcwDot,
}) => {
  return (
    <svg className="mini-compass" viewBox="0 0 60 60">
      <defs>
        <radialGradient id="compass-plate-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="85%" stopColor="#f4f6f8" />
          <stop offset="100%" stopColor="#e2e8f0" />
        </radialGradient>
      </defs>

      {/* Outer Dial Bezel and Inner Card */}
      <circle className="mini-compass-bezel" cx="30" cy="30" r="28.5" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="1.8" />
      <circle className="mini-compass-dial" cx="30" cy="30" r="25.5" fill="url(#compass-plate-grad)" stroke="#94a3b8" strokeWidth="0.8" />

      {/* Graduation Ticks (every 30 degrees) */}
      {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
        const isMajor = deg % 90 === 0;
        return (
          <line
            key={`mini-tick-${deg}`}
            className={`mini-tick ${isMajor ? 'mini-tick-major' : 'mini-tick-minor'}`}
            x1="30"
            y1="5.5"
            x2="30"
            y2={isMajor ? '8.5' : '7.2'}
            stroke={isMajor ? '#475569' : '#94a3b8'}
            strokeWidth={isMajor ? 1.4 : 0.9}
            strokeLinecap="round"
            transform={`rotate(${deg}, 30, 30)`}
          />
        );
      })}

      {/* Cardinal Letters */}
      <text className="mini-cardinal-n" x="30" y="14" fill="#dc2626" fontSize="6.2" textAnchor="middle" fontWeight="900" fontFamily="system-ui, sans-serif">
        N
      </text>
      <text className="mini-cardinal" x="30" y="49" fill="#334155" fontSize="5.2" textAnchor="middle" fontWeight="800" fontFamily="system-ui, sans-serif">
        S
      </text>
      <text className="mini-cardinal" x="47.5" y="32" fill="#64748b" fontSize="5" textAnchor="middle" dominantBaseline="middle" fontWeight="800" fontFamily="system-ui, sans-serif">
        E
      </text>
      <text className="mini-cardinal" x="12.5" y="32" fill="#64748b" fontSize="5" textAnchor="middle" dominantBaseline="middle" fontWeight="800" fontFamily="system-ui, sans-serif">
        W
      </text>

      {/* Boat Heading Silhouette (Sharp nautical yacht hull pointing to HDG) */}
      <g id="twd-boat-wrap" transform={`rotate(${boatRotDeg}, 30, 30)`}>
        {/* Yacht Hull */}
        <path
          className="mini-boat-hull"
          d="M 30,19 C 26.6,24.5 25.5,31.5 26.5,37 C 27.8,38.8 32.2,38.8 33.5,37 C 34.5,31.5 33.4,24.5 30,19 Z"
          fill="#1e293b"
          stroke="#ffffff"
          strokeWidth="0.8"
        />
        {/* Cockpit / Mast Center Point */}
        <circle cx="30" cy="29" r="1.1" fill="#ffffff" />
      </g>

      {/* True Wind Direction Indicator (Bold tactical chevron & arrow pointing inward) */}
      <g id="twd-arrow" transform={`rotate(${windRotDeg}, 30, 30)`}>
        {/* Tactical Wind Chevron */}
        <path
          id="twd-wind-chevron"
          className="mini-wind-chevron"
          d="M 24.5,3.8 L 30,8.8 L 35.5,3.8"
          fill="none"
          stroke="#0284c7"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Wind Inflow Stem */}
        <line
          x1="30"
          y1="8.8"
          x2="30"
          y2="13.2"
          stroke="#0284c7"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        {/* Strategic shift trend dots */}
        <circle
          id="trend-dot-cw"
          cx="37"
          cy="8.5"
          r="1.8"
          fill={compassCwDot.color}
          className={compassCwDot.blinking ? 'is-trending' : compassCwDot.active ? 'is-steady' : ''}
        />
        <circle
          id="trend-dot-ccw"
          cx="23"
          cy="8.5"
          r="1.8"
          fill={compassCcwDot.color}
          className={compassCcwDot.blinking ? 'is-trending' : compassCcwDot.active ? 'is-steady' : ''}
        />
      </g>
    </svg>
  );
};
