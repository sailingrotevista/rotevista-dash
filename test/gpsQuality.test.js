'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {observedGpsQuality,declaredGpsQuality}=require('../sensors/sensorNormalizer/gpsQuality');
const {GPS_NORMALIZER_CONFIG:config}=require('../sensors/SensorNormalizer');
const start=1700000000000;
const position=(x,y)=>({latitude:36+y/6371000*180/Math.PI,longitude:14+x/(6371000*Math.cos(36*Math.PI/180))*180/Math.PI});
function scenario(point,velocity,count=40){
    const samples=[],auxiliary={'navigation.speedOverGround':[],'navigation.courseOverGroundTrue':[]};
    for(let i=0;i<count;i++){
        const timestamp=start+i*1000;
        samples.push({timestamp,value:position(...point(i))});
        if(velocity){const [x,y]=velocity(i);auxiliary['navigation.speedOverGround'].push({timestamp,value:Math.hypot(x,y)});auxiliary['navigation.courseOverGroundTrue'].push({timestamp,value:Math.atan2(x,y)});}
    }
    return observedGpsQuality(samples,auxiliary,start+(count-1)*1000,config);
}
test('stationary and straight moving GPS remain coherent with their own motion reports',()=>{
    for(const [point,velocity] of [[()=>[0,0],()=>[0,0]],[i=>[3*i,0],()=>[3,0]]]){
        const q=scenario(point,velocity);
        assert.equal(q.dispersion.value,1);assert.equal(q.speedConsistency.value,1);
    }
});
test('smooth anchor swing is not mistaken for positional scatter',()=>{
    const q=scenario(i=>[20*Math.cos(i*.03),20*Math.sin(i*.03)],i=>[-.6*Math.sin(i*.03),.6*Math.cos(i*.03)]);
    assert.equal(q.dispersion.value,1);assert.equal(q.speedConsistency.value,1);
});
test('a real right-angle maneuver does not lower trajectory quality',()=>{
    const q=scenario(i=>i<=20?[3*i,0]:[60,3*(i-20)],i=>i<20?[3,0]:[0,3]);
    assert.ok(q.skippedManeuvers>0);assert.equal(q.dispersion.value,1);assert.equal(q.speedConsistency.value,1);
});
test('repeated jitter and frozen positions with reported speed lower distinct quality factors',()=>{
    const jitter=scenario(i=>[i%2?12:-12,0],()=>[0,0]);
    assert.ok(jitter.dispersion.value<.5);
    const frozen=scenario(()=>[0,0],()=>[3,0]);
    assert.equal(frozen.dispersion.value,1);assert.ok(frozen.speedConsistency.value<.5);
});
test('missing or temporally unrelated speed cannot manufacture an inconsistency',()=>{
    const q=scenario(i=>[3*i,0]);
    assert.equal(q.dispersion.value,1);assert.equal(q.speedConsistency.available,false);
});
test('optional declared quality expires and explicit no-fix or unsafe rejects it',()=>{
    const aux={'navigation.gnss.methodQuality':[{timestamp:start,value:'no GPS'}]};
    assert.equal(declaredGpsQuality(aux,start,config).rejection,'GNSS_NO_FIX');
    assert.equal(declaredGpsQuality(aux,start+config.qualityMaxAgeMs,config).available,false);
    aux['navigation.gnss.methodQuality'][0].value=null;
    aux['navigation.gnss.integrity']=[{timestamp:start,value:'Unsafe'}];
    assert.equal(declaredGpsQuality(aux,start,config).rejection,'GNSS_UNSAFE');
    assert.equal(declaredGpsQuality({},start,config).available,false);
});
