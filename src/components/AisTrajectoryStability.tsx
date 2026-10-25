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
          {' · '}{rest.sampleCount} fixes · {Math.floor(rest.observedSpanSeconds/60)} min span
          {rest.radiusMeters!==null && ` · radius ${Math.round(rest.radiusMeters)} m`}
          {' · '}{rest.returnCount} returns · {rest.excludedSamples} excluded fixes
        </span>
      </span>}
      {stability && <span>
        <span className="ais-cell-label">PREDICTION ANALYSIS</span>
        <span className="ais-cell-val">{stability.sampleCount} fixes · {stability.comparisonCount} comparisons
          {stability.errorRateMps!==null && ` · error ${stability.errorRateMps.toFixed(2)} m/s`}
          {stability.uncertaintyGrowthMps!==null && ` · uncertainty growth ${stability.uncertaintyGrowthMps.toFixed(2)} m/s`}
        </span>
      </span>}
    </span>}
  </button>;
}
