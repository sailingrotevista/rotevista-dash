import { displayCpa, formatAisSpeed } from '../utils/aisDetailData.mjs';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AisTarget } from '../types';

const BANNER_SNOOZE_DELAY_MS = 3000;
const AIS_AGE_NOTICE_WINDOW_FRACTION = 0.2;

interface AisTacticalBannerProps {
  threat: AisTarget | null;
  onInspect: (target: AisTarget) => void;
  onSnooze: (targetId: string) => void;
  isNightMode?: boolean;
  isInspecting?: boolean;
  sharedSnoozeReady?: boolean;
  actionPending?: boolean;
}

export const AisTacticalBanner: React.FC<AisTacticalBannerProps> = ({
  threat,
  onInspect,
  onSnooze,
  isNightMode,
  isInspecting = false,
  sharedSnoozeReady,
  actionPending = false,
}) => {
  const bannerRef = useRef<HTMLDivElement>(null);
  const hasBanner = Boolean(threat && threat.risk !== 'GREY');
  useLayoutEffect(() => {
    const banner = bannerRef.current;
    const wrapper = banner?.parentElement;
    if (!banner || !wrapper) return;
    const measure = () => wrapper.style.setProperty('--ais-banner-height', `${banner.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      wrapper.style.removeProperty('--ais-banner-height');
    };
  }, [hasBanner]);
  const snoozeKey = !isInspecting && threat && (threat.risk === 'RED' || threat.risk === 'ORANGE')
    ? `${threat.id}:${threat.risk}:${threat.alertKind || 'COLLISION'}` : null;
  const [readySnoozeKey, setReadySnoozeKey] = useState<string | null>(null);
  useEffect(() => {
    setReadySnoozeKey(null);
    if (!snoozeKey) return;
    const timer = setTimeout(() => setReadySnoozeKey(snoozeKey), BANNER_SNOOZE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [snoozeKey]);
  // Comparing identities also hides the button on the first render of a new
  // target, before the effect runs. Metric updates do not restart the delay.
  const canSnooze = snoozeKey !== null && (sharedSnoozeReady ?? (readySnoozeKey === snoozeKey));

  if (!threat || threat.risk === 'GREY') return null;

  const isCollisionDanger = threat.risk === 'RED';
  const isProximity = threat.alertKind === 'PROXIMITY';
  const stationary = threat.motionState === 'STATIONARY' || (!threat.motionState && threat.isMoving === false);
  const cpa = displayCpa(threat);
  const cpaText = cpa !== null ? (cpa < 1852 ? `${cpa} m` : `${(cpa / 1852).toFixed(2)} NM`) : '--';
  const tcpaText = threat.tcpa !== null && threat.tcpa >= 0 ? `${threat.tcpa.toFixed(1)} min` : '--';
  const horizonMinutes = threat.effectiveThresholds?.horizonTcpa;
  const showAgeNotice = Number.isFinite(threat.age) && Number.isFinite(horizonMinutes) &&
    horizonMinutes > 0 && threat.age > horizonMinutes * 60 * AIS_AGE_NOTICE_WINDOW_FRACTION;
  const ageText = threat.age < 60 ? `${Math.floor(threat.age)} sec` : `${Math.floor(threat.age / 60)} min`;
  const positionText = threat.isProjected === true ? 'Estimated position'
    : threat.isProjected === false ? 'Last reported position' : 'Position data';

  return (
    <div
      ref={bannerRef}
      className={`ais-tactical-banner ${isCollisionDanger ? 'banner-collision-red' : 'banner-warning-orange'} ${
        isNightMode ? 'night-theme' : ''
      }`}
      role="alert"
    >
      <div className="banner-content">
        <div className="banner-header-row">
          <span className="banner-badge">
            {isProximity ? '⚠️ SAFE BUBBLE PROXIMITY' : isCollisionDanger ? '🚨 ARPA COLLISION ALARM' : threat.warningBasis === 'INSTABILITY' ? '⚠️ VARIABLE TRAJECTORY WARNING' : '⚠️ CROSSING WARNING'}
          </span>
          <span className="banner-vessel-name">
            {threat.name || threat.id}
          </span>
          {threat.flag && <span className="banner-callsign">[{threat.flag}]</span>}
          {threat.callsign && <span className="banner-callsign">[{threat.callsign}]</span>}
        </div>

        <div className="banner-metrics-row">
          <div className="banner-metric banner-metric-primary">
            <span className="metric-lbl">{isProximity ? 'CLEARANCE' : 'CPA'}</span>
            <span className="metric-val">{isProximity ? `${Math.round(threat.currentHullClearanceMeters ?? 0)} m` : cpaText}</span>
          </div>
          <div className="banner-metric banner-metric-primary">
            <span className="metric-lbl">{isProximity ? 'SAFE BUBBLE' : 'TCPA'}</span>
            <span className="metric-val">{isProximity ? `${threat.safeBubbleMeters} m` : tcpaText}</span>
          </div>
          <div className="banner-metric">
            {!stationary && <span className="metric-lbl" title="Speed over ground" style={{ display: 'inline-flex', alignItems: 'center' }}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="SOG">
                <path d="M3.34 17a10 10 0 1 1 17.32 0" />
                <path d="m12 14 3.5-3.5" />
              </svg>
            </span>}
            <span className="metric-val">{stationary ? 'STATIONARY' : `${formatAisSpeed(threat.sog)} kn`}</span>
          </div>
          <div className="banner-metric">
            <span className="metric-lbl" title="Distanza attuale" style={{ display: 'inline-flex', alignItems: 'center' }}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Distanza">
                <rect x="2" y="7" width="20" height="10" rx="1.5" />
                <line x1="6" y1="7" x2="6" y2="11" />
                <line x1="10" y1="7" x2="10" y2="13" />
                <line x1="14" y1="7" x2="14" y2="11" />
                <line x1="18" y1="7" x2="18" y2="13" />
              </svg>
            </span>
            <span className="metric-val">
              {threat.dist < 1852 ? `${threat.dist} m` : `${(threat.dist / 1852).toFixed(1)} NM`}
            </span>
          </div>
          <div className="banner-metric banner-sighting">
            <span className="metric-lbl">BEARING</span>
            <span className="metric-val">{threat.sightingTxt || `${threat.dist}m`}</span>
          </div>
        </div>

        {(threat.contactLost || showAgeNotice) && (
          <div className="banner-age-notice">
            {threat.contactLost ? 'AIS contact lost · estimated position' : positionText} · last AIS {ageText} ago
          </div>
        )}
        {threat.motionDataSync?.status === 'OUT_OF_SYNC' && (
          <div className="banner-age-notice">Motion data out of sync</div>
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
          disabled={!canSnooze || actionPending}
          aria-busy={actionPending}
          style={{ visibility: canSnooze ? 'visible' : 'hidden' }}
          onClick={() => { if (canSnooze && !actionPending) onSnooze(threat.id); }}
          title={isProximity ? 'Acknowledge all boats currently inside the safe bubble' : 'Snooze alarm for 10 minutes'}
        >
          {isProximity ? 'ACKNOWLEDGE PROXIMITY' : 'SNOOZE 10M'}
        </button>
      </div>
    </div>
  );
};
