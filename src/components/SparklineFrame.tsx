import React from 'react';

// Primitive props only: the moving trace's clock and data do not invalidate
// these components. CSS layout still follows the chart container normally.
export const SparklineScale = React.memo(({type, min, max}: {
  type:string; min:number; max:number;
}) => (
  <div className="scale-labels" id={`${type}-scale`}>
    <span>{Math.round(max)}</span>
    <span>{Math.round((min + max) / 2)}</span>
    <span>{Math.round(min)}</span>
  </div>
));

export const SparklineGrid = React.memo(({id, visibleMinutes, dangerY, warningY, isFocused}: {
  id:string; visibleMinutes:number; dangerY:number|null; warningY:number|null; isFocused:boolean;
}) => {
  const w=200,h=40;
  const gridInterval=visibleMinutes<=10?1:visibleMinutes<=30?5:visibleMinutes<=60?10:20;
  const verticalGridX:number[]=[];
  for(let minute=gridInterval;minute<visibleMinutes;minute+=gridInterval)verticalGridX.push(w-(minute/visibleMinutes)*w);
  const alarmStrokeWidth=isFocused?'4.8':'1.8';
  return (
    <svg className="sparkline-grid" id={`${id}-grid`} viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      {[0.25,0.5,0.75].map((part,i)=>(
        <line key={`hg-${i}`} x1="0" y1={h-part*h} x2={w} y2={h-part*h}
          stroke="rgba(0,0,0,0.12)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
      ))}
      {verticalGridX.map((x,i)=>(
        <line key={`vg-${i}`} x1={x} y1="0" x2={x} y2={h}
          stroke="rgba(0,0,0,0.08)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      ))}
      {dangerY!==null && (
        <line x1="4" y1={dangerY} x2={w-4} y2={dangerY} stroke="rgba(255, 59, 48, 0.95)"
          strokeWidth={alarmStrokeWidth} strokeDasharray="12, 6, 2, 6" vectorEffect="non-scaling-stroke" />
      )}
      {warningY!==null && (
        <line x1="4" y1={warningY} x2={w-4} y2={warningY} stroke="rgba(255, 204, 0, 0.95)"
          strokeWidth={alarmStrokeWidth} strokeDasharray="6, 2, 6, 12" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
});
