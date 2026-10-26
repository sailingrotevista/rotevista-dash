'use strict';

const GPS_AUXILIARY_PATHS = Object.freeze([
    'navigation.speedOverGround',
    'navigation.courseOverGroundTrue',
    'navigation.gnss.methodQuality',
    'navigation.gnss.integrity',
    'navigation.gnss.horizontalDilution',
    'navigation.gnss.satellites',
]);
const clamp = value => Math.max(0, Math.min(1, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const rms = values => values.length ? Math.sqrt(mean(values.map(value => value * value))) : null;
const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function latest(auxiliary, path, now, maxAge) {
    const records = auxiliary[path] || [];
    const entry = records.findLast(record => record.timestamp <= now);
    return entry && now - entry.timestamp < maxAge ? entry : null;
}

function declaredGpsQuality(auxiliary, now, config) {
    const fields = {};
    for (const name of ['methodQuality', 'integrity', 'horizontalDilution', 'satellites']) {
        const entry = latest(auxiliary, 'navigation.gnss.' + name, now, config.qualityMaxAgeMs);
        if (entry && entry.value !== null) fields[name] = { value: entry.value, timestamp: entry.timestamp };
    }
    const method = text(fields.methodQuality?.value), integrity = text(fields.integrity?.value);
    const rejected = ['no gps', 'error'].includes(method) ? 'GNSS_NO_FIX' : integrity === 'unsafe' ? 'GNSS_UNSAFE' : null;
    const methodScores = { 'gnss fix':0.6, 'dgnss fix':0.8, 'precise gnss':0.9,
        'rtk fixed integer':1, 'rtk float':0.9, 'estimated (dr) mode':0.2, 'manual input':0.1, 'simulator mode':0.1 };
    const factors = [];
    if (Object.prototype.hasOwnProperty.call(methodScores, method)) factors.push([methodScores[method], 4]);
    if (integrity === 'safe' || integrity === 'caution') factors.push([integrity === 'safe' ? 1 : 0.3, 2]);
    const hdop = fields.horizontalDilution?.value;
    if (Number.isFinite(hdop) && hdop > 0) factors.push([1 / Math.max(1, hdop), 4]);
    const satellites = fields.satellites?.value;
    if (Number.isInteger(satellites) && satellites >= 0) factors.push([clamp(satellites / 12), 1]);
    if (!factors.length && !rejected) return { available:false, value:null };
    return { available:true, value:rejected ? 0 : factors.reduce((sum, [factor, weight]) => sum + factor * weight, 0) /
        factors.reduce((sum, [, weight]) => sum + weight, 0), fields, rejection:rejected };
}

function motionAt(auxiliary, path, time, now, config) {
    const nearest = (auxiliary[path] || []).filter(entry => entry.timestamp <= now &&
        Math.abs(entry.timestamp - time) <= config.motionMaximumSkewMs)
        .sort((a,b) => Math.abs(a.timestamp-time) - Math.abs(b.timestamp-time) || b.timestamp-a.timestamp)[0];
    return nearest?.value ?? null;
}
function deltaLongitude(a, b) { return ((b - a + 540) % 360) - 180; }
function displacement(a, b) {
    const radians = Math.PI / 180;
    return { x:deltaLongitude(a.longitude,b.longitude) * radians * 6371000 * Math.cos((a.latitude+b.latitude)/2*radians),
        y:(b.latitude-a.latitude) * radians * 6371000 };
}
function angleDifference(a,b) { return Math.abs(Math.atan2(Math.sin(b-a),Math.cos(b-a))); }

// Local residual dispersion, not distance from a stationary centroid. A moving
// boat or a slow anchor swing can travel widely while keeping a smooth path.
function observedGpsQuality(rawSamples, auxiliary, now, config) {
    const samples = [];
    for (const sample of rawSamples) {
        if (!samples.length || sample.timestamp-samples.at(-1).timestamp >= config.motionMinimumStepMs) samples.push(sample);
    }
    const unavailable = () => ({ available:false, value:null, comparisons:0, rmsMeters:null });
    if (samples.length < config.motionMinimumComparisons+2 ||
        samples.at(-1).timestamp-samples[0].timestamp < config.motionMinimumSpanMs) {
        return { dispersion:unavailable(), speedConsistency:unavailable(), skippedManeuvers:0 };
    }
    const sog = time => motionAt(auxiliary,'navigation.speedOverGround',time,now,config);
    const cog = time => motionAt(auxiliary,'navigation.courseOverGroundTrue',time,now,config);
    const supportedTurn = (a,b) => {
        const va=sog(a.timestamp),vb=sog(b.timestamp),ca=cog(a.timestamp),cb=cog(b.timestamp);
        return va !== null && vb !== null && Math.max(va,vb)*1.94384 >= config.motionTurnMinimumKnots &&
            ca !== null && cb !== null && angleDifference(ca,cb) > config.motionTurnDegrees*Math.PI/180;
    };
    const residuals=[], ratios=[], speedErrors=[];
    let skippedManeuvers=0;
    for(let i=1;i<samples.length;i++) {
        let first=i-1;
        while(first>0&&samples[i].timestamp-samples[first].timestamp<config.motionSpeedSpanMs)first--;
        if(samples[i].timestamp-samples[first].timestamp<config.motionSpeedSpanMs)continue;
        let expectedDistance=0,expectedX=0,expectedY=0,complete=true,directed=true;
        for(let j=first+1;j<=i;j++) {
            const a=samples[j-1],b=samples[j],seconds=(b.timestamp-a.timestamp)/1000;
            if(seconds*1000>config.motionMaximumStepMs){complete=false;break;}
            if(supportedTurn(a,b)){skippedManeuvers++;complete=false;break;}
            const sa=sog(a.timestamp),sb=sog(b.timestamp);
            if(sa===null||sb===null){complete=false;break;}
            expectedDistance+=(sa+sb)/2*seconds;
            const ca=cog(a.timestamp),cb=cog(b.timestamp);
            if(ca===null||cb===null)directed=false;
            else {
                expectedX+=(sa*Math.sin(ca)+sb*Math.sin(cb))/2*seconds;
                expectedY+=(sa*Math.cos(ca)+sb*Math.cos(cb))/2*seconds;
            }
        }
        if(!complete)continue;
        const actual=displacement(samples[first].value,samples[i].value);
        const error=directed ? Math.hypot(actual.x-expectedX,actual.y-expectedY)
            : Math.abs(Math.hypot(actual.x,actual.y)-expectedDistance);
        speedErrors.push(error);
        ratios.push(error/(config.motionNoiseToleranceMeters+expectedDistance*config.motionSpeedToleranceFraction));
    }
    for(let i=1;i<samples.length-1;i++) {
        const a=samples[i-1],b=samples[i],c=samples[i+1];
        if(b.timestamp-a.timestamp>config.motionMaximumStepMs||c.timestamp-b.timestamp>config.motionMaximumStepMs)continue;
        if(supportedTurn(a,b)||supportedTurn(b,c))continue;
        const toB=displacement(a.value,b.value),toC=displacement(a.value,c.value);
        const fraction=(b.timestamp-a.timestamp)/(c.timestamp-a.timestamp);
        residuals.push(Math.hypot(toB.x-toC.x*fraction,toB.y-toC.y*fraction));
    }
    const dispersionRms=rms(residuals),speedRms=rms(speedErrors),ratioRms=rms(ratios);
    return {
        dispersion:residuals.length>=config.motionMinimumComparisons
            ? {available:true,value:clamp(config.motionNoiseToleranceMeters/Math.max(config.motionNoiseToleranceMeters,dispersionRms)),
                comparisons:residuals.length,rmsMeters:dispersionRms} : unavailable(),
        speedConsistency:ratios.length>=config.motionMinimumComparisons
            ? {available:true,value:clamp(1/Math.max(1,ratioRms)),comparisons:ratios.length,rmsMeters:speedRms} : unavailable(),
        skippedManeuvers,
    };
}

module.exports = { GPS_AUXILIARY_PATHS, declaredGpsQuality, observedGpsQuality };
