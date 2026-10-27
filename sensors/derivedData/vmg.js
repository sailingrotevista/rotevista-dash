'use strict';
const {trueWindDirectionMinSpeedMps}=require('../../shared/windDataPolicy.json');
const PATHS={stw:'navigation.speedThroughWater',sog:'navigation.speedOverGround',twa:'environment.wind.angleTrueWater',aws:'environment.wind.speedApparent',awa:'environment.wind.angleApparent'};

// Existing Wind formula: absolute speed component along the true-wind axis.
// Inputs are selected normalized measurements, never raw Signal K caches.
function deriveVmg(snapshot) {
    const now=snapshot.sampledAt,measurements=snapshot.measurements;
    const usable=path=>{
        const m=measurements[path];
        return m?.valid===true && Number.isFinite(m.value) && Number.isFinite(m.timestamp) && m.timestamp<=now &&
            Number.isFinite(m.expiresAt) && now<m.expiresAt ? m : null;
    };
    const stw=usable(PATHS.stw),sog=usable(PATHS.sog);
    const speed=stw && !(sog && sog.value>0.77 && stw.value<0.25) ? stw : sog;
    const speedPath=speed===stw ? PATHS.stw : PATHS.sog;
    const nativeTwa=usable(PATHS.twa),aws=usable(PATHS.aws),awa=usable(PATHS.awa);
    let angle=nativeTwa?.value ?? null;
    let calculation='NATIVE_TWA';
    const dependencies=speed ? [[speedPath,speed]] : [];
    if(nativeTwa)dependencies.push([PATHS.twa,nativeTwa]);
    else if(speed && aws && awa){
        const x=aws.value*Math.cos(awa.value)-speed.value,y=aws.value*Math.sin(awa.value);
        if(Math.hypot(x,y)>trueWindDirectionMinSpeedMps){angle=Math.atan2(y,x);dependencies.push([PATHS.aws,aws],[PATHS.awa,awa]);calculation='APPARENT_WIND';}
    }
    const valid=Boolean(speed && angle!==null);
    const inputs=dependencies.map(([path,m])=>({path,source:m.source ?? null,timestamp:m.timestamp,expiresAt:m.expiresAt}));
    return {
        value:valid?Math.abs(speed.value*Math.cos(angle)):null,
        valid,status:valid?'VALID':'UNAVAILABLE',source:'DERIVED',
        calculation:valid?calculation:null,inputs,
        timestamp:valid?Math.min(...inputs.map(i=>i.timestamp)):null,
        expiresAt:valid?Math.min(...inputs.map(i=>i.expiresAt)):null,
        observationId:valid?JSON.stringify([calculation,...inputs.map(i=>[i.path,i.source,i.timestamp])]):null,
    };
}
module.exports={deriveVmg};
