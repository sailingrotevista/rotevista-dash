const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
const policy=require('../shared/windDataPolicy.json');
const STW='navigation.speedThroughWater',SOG='navigation.speedOverGround';
test('wind speed expires at 5 seconds, keeps STW priority and existing near-zero override',async()=>{
 const {resolveWindBoatSpeed:r}=await import('../src/utils/windValidity.mjs');
 assert.equal(r({[SOG]:4},{[SOG]:1000},5999,policy),4);
 assert.equal(r({[SOG]:4},{[SOG]:1000},6000,policy),0);
 assert.equal(r({[STW]:2,[SOG]:4},{[STW]:1000,[SOG]:1000},1000,policy),2);
 assert.equal(r({[STW]:0,[SOG]:4},{[STW]:1000,[SOG]:1000},1000,policy),4);
 assert.equal(r({[STW]:0,[SOG]:4},{[STW]:6000,[SOG]:1000},6000,policy),0);
 assert.equal(r({[STW]:2,[SOG]:4},{[STW]:1000,[SOG]:6000},6000,policy),4);
});
test('server preserves speed source time through dedup and falls back to AWS after expiry',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({debug(){}},()=>({}));let tws;
 e.manageHistory=(key,value)=>{if(key==='tws')tws=value;};
 e.processIncomingDelta(SOG,4,now);
 now+=1000;e.processIncomingDelta(SOG,4,now);
 assert.equal(e.getRawTimes()[SOG],now);
 e.processIncomingDelta(SOG,8,now-1000);
 e.processIncomingDelta(SOG,NaN,now+100);
 assert.equal(e.getRaw()[SOG],4);
 assert.equal(e.getRawTimes()[SOG],now);
 now+=4999;
 e.processIncomingDelta('environment.wind.angleApparent',0,now);
 e.processIncomingDelta('environment.wind.speedApparent',10,now);e.sampleHistory();
 assert.ok(Math.abs(tws-6*1.94384)<1e-9);
 now+=1000;e.processIncomingDelta('navigation.headingTrue',0,now);e.sampleHistory();
 assert.ok(Math.abs(tws-10*1.94384)<1e-9);
 e.processIncomingDelta(SOG,null,now);
 assert.equal(e.getRaw()[SOG],null);
 assert.equal(e.getRawTimes()[SOG],now);
 } finally {Date.now=original;}
});
