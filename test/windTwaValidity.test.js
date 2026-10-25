const {test}=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../windDataPolicy.json');
const {WindEngine}=require('../windEngine');
const TWA='environment.wind.angleTrueWater', AWS='environment.wind.speedApparent', AWA='environment.wind.angleApparent';

test('native TWA is independent, zero valid, expiry falls back without overwriting it',async()=>{
 const {resolveTwa}=await import('../src/utils/windValidity.mjs');
 assert.equal(resolveTwa({[TWA]:0},{[TWA]:1000},5999,policy),0);
 assert.equal(resolveTwa({[TWA]:0},{[TWA]:1000},6000,policy),null);
 const raw={[TWA]:1,[AWS]:4,[AWA]:0.5};
 const times={[TWA]:1000,[AWS]:5000,[AWA]:5000};
 assert.equal(resolveTwa(raw,times,5999,policy),1);
 assert.ok(Math.abs(resolveTwa(raw,times,6000,policy)-0.5)<1e-10);
 assert.equal(raw[TWA],1);
 assert.equal(resolveTwa(raw,times,20000,policy),null);
 assert.equal(resolveTwa(raw,{...times,[TWA]:20000},20000,policy),1);
});
test('calm reconstructed vector has no invented direction even with native TWS',async()=>{
 const {resolveTwa}=await import('../src/utils/windValidity.mjs');
 const raw={[AWS]:4,[AWA]:0,'navigation.speedThroughWater':4,'environment.wind.speedTrue':8};
 const times=Object.fromEntries(Object.keys(raw).map(k=>[k,1000]));
 assert.equal(resolveTwa(raw,times,1000,policy),null);
 raw['navigation.speedThroughWater']=3;
 assert.equal(resolveTwa(raw,times,1000,policy),0);
});
test('server accepts native TWA without AWS and preserves source times and unique observations',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const e=new WindEngine({debug(){}},()=>({}));
  e.processIncomingDelta(TWA,1,now-1000);e.sampleHistory();
  assert.equal(e.getRollingAngles().twa.length,1);
  assert.equal(e.getRawTimes()[TWA],now-1000);
  now+=1000;e.processIncomingDelta(TWA,2,now-2000);
  assert.equal(e.getRaw()[TWA],1);
  assert.equal(e.getRollingAngles().twa.length,1);
  e.processIncomingDelta(TWA,NaN,now);
  assert.equal(e.getRawTimes()[TWA],now-2000);
  e.processIncomingDelta(TWA,null,now);
  assert.equal(e.getRaw()[TWA],null);
  assert.equal(e.getRollingAngles().twa.length,0);
 } finally {Date.now=original;}
});
test('server calm fallback emits no TWA or derived TWD',()=>{
 const original=Date.now;Date.now=()=>1000000;
 try {
  const e=new WindEngine({debug(){}},()=>({}));e.manageHistory=()=>{};
  e.processIncomingDelta('navigation.speedThroughWater',4,Date.now());
  e.processIncomingDelta('navigation.headingTrue',1,Date.now());
  e.processIncomingDelta(AWA,0,Date.now());
  e.processIncomingDelta(AWS,4,Date.now());e.sampleHistory();
  assert.equal(e.getRollingAngles().twa.length,0);
  assert.equal(e.getRollingAngles().twd.length,0);
 } finally {Date.now=original;}
});
