import React from 'react';
import { AisTarget } from '../types';
import { getAisInfo } from '../utils/aisDetailData.mjs';

export function AisStatusInfo({target}:{target:AisTarget}) {
  const info=getAisInfo(target);
  if (!info.visible) return null;
  return <div className="ais-detail-cell cell-wide">
    <span className="ais-cell-label">AIS STATUS{info.aisClass ? ` (${info.aisClass})` : ''}</span>
    {info.destination && <span className="ais-cell-val cyan">Destination: {info.destination}</span>}
    {info.eta && <span className="ais-cell-val">ETA: {info.eta}</span>}
    {info.status && <span className="ais-cell-val">{info.status}</span>}
  </div>;
}
