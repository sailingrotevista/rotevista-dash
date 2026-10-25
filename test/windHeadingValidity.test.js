const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');
const policy=require('../windDataPolicy.json');
const H='navigation.headingTrue',M='navigation.headingMagnetic',C='navigation.courseOverGroundTrue',S='navigation.speedOverGround';
test('COG fallback updates repeatedly, expires with either input and yields to compass',async()=>{
 const {resolveHeading:r}=await import('../src/utils/windValidity.mjs');
 const raw={[C]:1,[S]:2},times={[C]:1000,[S]:1000};
 assert.equal(r(raw,times,1000,policy),1);
 raw[C]=2;times[C]=2000;
 assert.equal(r(raw,times,2000,policy),2);
 assert.equal(raw[H],undefined);
 assert.equal(r(raw,times,16000,policy),null);
 times[S]=17000;
 assert.equal(r(raw,times,17000,policy),null);
 times[C]=17000;raw[H]=0.5;times[H]=17000;
 assert.equal(r(raw,times,17000,policy),0.5);
 raw[M]=1;times[M]=22000;raw['navigation.magneticVariation']=0.1;
 assert.equal(r(raw,times,22000,policy),0.5); // No position/model: retain valid native true heading.
 raw[S]=0.5;delete raw[H];delete raw[M];
 assert.equal(r(raw,times,22000,policy),null);
});
test('server repeatedly updates COG heading and TWD without publishing synthesized native heading',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const e=new WindEngine({debug(){}},()=>({}));let twd;e.manageHistory=(k,v)=>{if(k==='twd')twd=v;};
  e.processIncomingDelta(S,2,now);
  e.processIncomingDelta('environment.wind.angleTrueWater',0.5,now);
  e.processIncomingDelta(C,1,now);
  assert.ok(Math.abs(twd-1.5)<1e-10);
  now+=1000;e.processIncomingDelta(C,2,now);
  assert.ok(Math.abs(twd-2.5)<1e-10);
  assert.equal(e.getRaw()[H],undefined);
  assert.equal(e.getRollingAngles().hdg.at(-1).val,2);
  e.processIncomingDelta(H,0.25,now);
  assert.ok(Math.abs(twd-0.75)<1e-10);
  now+=1000;e.processIncomingDelta(C,3,now);
  assert.equal(e.getRaw()[H],0.25);
  assert.ok(Math.abs(twd-0.75)<1e-10);
  now+=16000;twd=undefined;
  e.processIncomingDelta('environment.wind.angleTrueWater',0.6,now);
  assert.equal(twd,undefined);
 } finally {Date.now=original;}
});
