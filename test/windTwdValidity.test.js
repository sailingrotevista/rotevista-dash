const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');
const policy=require('../windDataPolicy.json');
const D='environment.wind.directionTrue',A='environment.wind.angleTrueWater',H='navigation.headingTrue';
test('TWD native fallback, reconstruction without AWS, expiry and normalization',async()=>{
 const {resolveTwd}=await import('../src/utils/windValidity.mjs');
 const raw={[D]:1,[A]:Math.PI/2,[H]:Math.PI*1.75};
 const times={[D]:1000,[A]:6000,[H]:1000};
 assert.equal(resolveTwd(raw,{[D]:1000},5999,policy),1);
 assert.ok(Math.abs(resolveTwd(raw,times,6000,policy)-Math.PI/4)<1e-10);
 assert.equal(raw[D],1);
 assert.equal(resolveTwd(raw,{...times,[A]:16000},16000,policy),null);
 assert.equal(resolveTwd(raw,{...times,[H]:11000},11000,policy),null);
 assert.equal(resolveTwd({[D]:0},{[D]:1000},1000,policy),0);
});
test('server derives TWD from native TWA and heading only; stale heading stops it',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({debug(){}},()=>({}));const writes=[];e.manageHistory=(k,v)=>writes.push([k,v]);
 e.processIncomingDelta(H,1,now);
 e.processIncomingDelta(A,0.5,now);
 assert.ok(writes.some(([k,v])=>k==='twd'&&Math.abs(v-1.5)<1e-10));
 assert.equal(e.getRaw()[D],undefined);
 now+=15000;writes.length=0;e.processIncomingDelta(A,0.6,now);
 assert.equal(writes.filter(([k])=>k==='twd').length,0);
 } finally {Date.now=original;}
});
test('server native TWD keeps source timestamp, ignores duplicate and expires old reports',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({debug(){}},()=>({}));e.manageHistory=()=>{};
 e.processIncomingDelta(D,1,now-1000);
 assert.equal(e.getRawTimes()[D],now-1000);
 assert.equal(e.getRollingAngles().twd.length,1);
 e.processIncomingDelta(D,2,now-1000);
 assert.equal(e.getRaw()[D],1);
 now+=10000;e.processIncomingDelta(D,2,now-6000);
 assert.equal(e.getRollingAngles().twd.length,1);
 e.processIncomingDelta(D,null,now);
 assert.equal(e.getRaw()[D],undefined);
 } finally {Date.now=original;}
});
test('invalidating native TWD retains averages while derived TWD remains valid',async()=>{
 const {resolveTwd}=await import('../src/utils/windValidity.mjs');
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const e=new WindEngine({debug(){}},()=>({}));e.manageHistory=()=>{};
  e.processIncomingDelta(H,1,now);
  e.processIncomingDelta(A,0.5,now);
  const before=structuredClone(e.getRollingAngles().twd);
  assert.ok(before.length>0);
  e.processIncomingDelta(D,null,now);
  assert.deepEqual(e.getRollingAngles().twd,before);
  assert.equal(resolveTwd(e.getRaw(),e.getRawTimes(),now,policy),1.5);
  now+=15000;
  assert.equal(resolveTwd(e.getRaw(),e.getRawTimes(),now,policy),null);
  assert.deepEqual(e.getRollingAngles().twd,before);
 }finally{Date.now=original;}
});
