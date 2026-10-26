const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
const {awaMaxAgeMs}=require('../shared/windDataPolicy.json');

test('AWA is valid at zero and both sides of the bow, and expires at 5 seconds',async()=>{
 const {freshAwa}=await import('../src/utils/windValidity.mjs');
 for(const value of [0,-1,1]) assert.equal(freshAwa(value,1000,5999,awaMaxAgeMs),value);
 assert.equal(freshAwa(1,1000,6000,awaMaxAgeMs),null);
 for(const value of [null,undefined,NaN,Infinity,10]) assert.equal(freshAwa(value,1000,1000,awaMaxAgeMs),null);
});
test('AWA observations exist without AWS and stale AWA blocks fallback despite fresh AWS',()=>{
 const oldNow=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const engine=new WindEngine({debug(){}},()=>({}));
  const writes=[];engine.manageHistory=(type,val)=>writes.push({type,val});
  engine.processIncomingDelta('environment.wind.angleApparent',0,now);engine.sampleHistory();
  assert.equal(engine.rollingAngles.awa.length,1);
  assert.equal(engine.rollingAngles.awa[0].val,0);
  now+=5000;
  engine.processIncomingDelta('environment.wind.speedApparent',4,now);engine.sampleHistory();
  assert.equal(writes.some(p=>p.type==='tws'),false);
  engine.processIncomingDelta('environment.wind.angleApparent',0.5,now);now+=1000;engine.sampleHistory();
  assert.ok(writes.some(p=>p.type==='tws'));
  const count=engine.rollingAngles.awa.length;
  now+=1000;
  engine.processIncomingDelta('environment.wind.angleApparent',0.5,now-1000);
  assert.equal(engine.rollingAngles.awa.length,count);
  engine.processIncomingDelta('environment.wind.angleApparent',null,now);
  assert.equal(engine.rollingAngles.awa.length,0);
 } finally { Date.now=oldNow; }
});
