import React from 'react';
import { AisTarget } from '../types';

interface AisTacticalBannerProps {
  threat: AisTarget | null;
  onInspect: (target: AisTarget) => void;
  onSnooze: (targetId: string) => void;
  isNightMode?: boolean;
}

export const AisTacticalBanner: React.FC<AisTacticalBannerProps> = ({
  threat,
  onInspect,
  onSnooze,
  isNightMode,
}) => {
  if (!threat || threat.risk === 'GREY') return null;

  const isCollisionDanger = threat.risk === 'RED';
  const cpaText = threat.cpa !== null ? (threat.cpa < 1852 ? `${threat.cpa} m` : `${(threat.cpa / 1852).toFixed(2)} NM`) : '--';
  const tcpaText = threat.tcpa !== null && threat.tcpa >= 0 ? `${threat.tcpa.toFixed(1)} min` : '--';

  return (
    <div
      className={`ais-tactical-banner ${isCollisionDanger ? 'banner-collision-red' : 'banner-warning-orange'} ${
        isNightMode ? 'night-theme' : ''
      }`}
      role="alert"
    >
      <div className="banner-pulse-indicator" />
      <div className="banner-content">
        <div className="banner-header-row">
          <span className="banner-badge">
            {isCollisionDanger ? '🚨 ARPA COLLISION ALARM' : '⚠️ CROSSING WARNING'}
          </span>
          <span className="banner-vessel-name">
            {threat.flag ? `${threat.flag} ` : ''}
            {threat.name || threat.id}
          </span>
          {threat.callsign && <span className="banner-callsign">[{threat.callsign}]</span>}
        </div>

        <div className="banner-metrics-row">
          <div className="banner-metric">
            <span className="metric-lbl">CPA</span>
            <span className="metric-val">{cpaText}</span>
          </div>
          <div className="banner-metric">
            <span className="metric-lbl">TCPA</span>
            <span className="metric-val">{tcpaText}</span>
          </div>
          <div className="banner-metric">
            <span className="metric-lbl">DIST</span>
            <span className="metric-val">
              {threat.dist < 1852 ? `${threat.dist} m` : `${(threat.dist / 1852).toFixed(1)} NM`}
            </span>
          </div>
          <div className="banner-metric">
            <span className="metric-lbl">SOG</span>
            <span className="metric-val">{threat.sog.toFixed(1)} kn</span>
          </div>
          <div className="banner-metric banner-sighting">
            <span className="metric-lbl">BEARING</span>
            <span className="metric-val">{threat.sightingTxt || `${threat.dist}m`}</span>
          </div>
        </div>

        {threat.crossDir && (
          <div className="banner-colregs-row">
            <span className="colregs-label">COLREGs:</span>
            <span className="colregs-text">{threat.crossDir.replace('\n', ' ')}</span>
          </div>
        )}
      </div>

      <div className="banner-actions">
        <button
          type="button"
          className="banner-btn btn-inspect"
          onClick={() => onInspect(threat)}
          title="Open AIS Tactical Map"
        >
          INSPECT
        </button>
        <button
          type="button"
          className="banner-btn btn-snooze"
          onClick={() => onSnooze(threat.id)}
          title="Snooze alarm for 10 minutes"
        >
          SNOOZE 10M
        </button>
      </div>
    </div>
  );
};
