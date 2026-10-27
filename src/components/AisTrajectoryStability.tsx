import React, { useEffect, useState } from 'react';
import { AisTarget } from '../types';

export function AisTrajectoryStability({target}:{target:AisTarget}) {
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{
    if (!expanded) return;
    const timer=setTimeout(()=>setExpanded(false),8000);
    return ()=>clearTimeout(timer);
  },[expanded]);
  const stability=target.predictionStability;
  const rest=target.restPattern;
  if (!stability && !rest) return null;
  const restFixes = rest && !rest.confirmed ? `${rest.sampleCount}/${rest.requiredFixes ?? 5}` : rest?.sampleCount;
  const restMinutes = rest && !rest.confirmed
    ? `${Math.floor(rest.observedSpanSeconds / 60)}/${(rest.requiredSpanSeconds ?? 300) / 60}`
    : rest ? Math.floor(rest.observedSpanSeconds / 60) : null;
  const perMinute = (value: number) => (value * 60).toFixed(1);
  const label=stability ? {
    INSUFFICIENT_DATA:'', STABLE:'STABLE', VARIABLE:'VARIABLE', MANEUVERING:'CHANGE?',
    NOT_MOVING:rest?.kind==='OSCILLATING'?'AT ANCHOR':'STATIONARY',
  }[stability.state] : '';
  return <button type="button" className="ais-detail-cell cell-wide ais-stability-toggle"
    aria-expanded={expanded} aria-label="Trajectory stability: toggle debug details"
    onClick={()=>setExpanded(value=>!value)}>
    <span className="ais-cell-label">TRAJECTORY STABILITY <span aria-hidden="true">{expanded?'▴':'▾'}</span></span>
    <span className="ais-cell-val">{label}</span>
    {expanded && <span className="ais-stability-debug">
      {rest && <span>
        <span className="ais-cell-label">OBSERVED REST PATTERN</span>
        <span className="ais-cell-val">
          {rest.kind==='UNDETERMINED'?'NOT YET DETERMINED':rest.kind}
          {' · '}{restFixes} fixes · {restMinutes} min
          {rest.radiusMeters!==null && ` · position spread ${Math.round(rest.radiusMeters)} m`}
          {' · '}{rest.returnCount} returns
          {rest.excludedSamples > 0 && ` · ${rest.excludedSamples} excluded fixes`}
        </span>
      </span>}
      {stability && <span>
        <span className="ais-cell-label">POSITION PREDICTION</span>
        <span className="ais-cell-val">
          {stability.state === 'NOT_MOVING' ? 'Target stationary: no movement forecast.' : <>
            {stability.sampleCount} AIS reports · {stability.comparisonCount} prediction {stability.comparisonCount === 1 ? 'check' : 'checks'}
            {stability.state === 'INSUFFICIENT_DATA' ? <><br />More AIS reports needed.</> : <>
              {Number.isFinite(stability.errorRateMps) && <><br />Observed prediction drift: {perMinute(stability.errorRateMps)} m/min</>}
              {Number.isFinite(stability.uncertaintyGrowthMps) && <><br />Estimated uncertainty growth: {perMinute(stability.uncertaintyGrowthMps)} m/min</>}
            </>}
          </>}
        </span>
      </span>}
    </span>}
  </button>;
}
