const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');
const policy=require('../windDataPolicy.json');
const STW='navigation.speedThroughWater',SOG='navigation.speedOverGround';
test('wind speed expires at 15 seconds, keeps STW priority and existing near-zero override',async()=>{
 const {resolveWindBoatSpeed:r}=await import('../src/utils/windValidity.mjs');
 assert.equal(r({[SOG]:4},{[SOG]:1000},15999,policy),4);
 assert.equal(r({[SOG]:4},{[SOG]:1000},16000,policy),0);
 assert.equal(r({[STW]:2,[SOG]:4},{[STW]:1000,[SOG]:1000},1000,policy),2);
 assert.equal(r({[STW]:0,[SOG]:4},{[STW]:1000,[SOG]:1000},1000,policy),4);
 assert.equal(r({[STW]:0,[SOG]:4},{[STW]:16000,[SOG]:1000},16000,policy),0);
 assert.equal(r({[STW]:2,[SOG]:4},{[STW]:1000,[SOG]:16000},16000,policy),4);
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
 now+=14999;
 e.processIncomingDelta('environment.wind.angleApparent',0,now);
 e.processIncomingDelta('environment.wind.speedApparent',10,now);
 assert.ok(Math.abs(tws-6*1.94384)<1e-9);
 now+=1;e.processIncomingDelta('navigation.headingTrue',0,now);
 assert.ok(Math.abs(tws-10*1.94384)<1e-9);
 e.processIncomingDelta(SOG,null,now);
 assert.equal(e.getRaw()[SOG],undefined);
 assert.equal(e.getRawTimes()[SOG],null);
 } finally {Date.now=original;}
});
