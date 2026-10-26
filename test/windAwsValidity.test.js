const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
const {awsMaxAgeMs}=require('../shared/windDataPolicy.json');

test('AWS distinguishes zero, missing data, invalid values and the 5-second boundary',async()=>{
 const {freshAws}=await import('../src/utils/windValidity.mjs');
 const t=100000;
 assert.equal(freshAws(0,t,t,awsMaxAgeMs),0);
 assert.equal(freshAws(8,t,t+4999,awsMaxAgeMs),8);
 assert.equal(freshAws(8,t,t+5000,awsMaxAgeMs),null);
 for(const v of [undefined,null,NaN,Infinity,-1,52]) assert.equal(freshAws(v,t,t,awsMaxAgeMs),null);
 assert.equal(freshAws(8,null,t,awsMaxAgeMs),null);
});

test('server stops fallback with stale AWS and resumes on a real update including zero',()=>{
 const oldNow=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const engine=new WindEngine({debug(){}},()=>({}));
  const writes=[];engine.manageHistory=(type,val)=>writes.push({type,val});
  engine.processIncomingDelta('environment.wind.speedApparent',4,now);
  engine.processIncomingDelta('environment.wind.angleApparent',0.5);
  engine.sampleHistory();
  assert.ok(writes.some(p=>p.type==='tws'));
  writes.length=0;now+=awsMaxAgeMs;
  engine.processIncomingDelta('navigation.headingTrue',1);
  engine.sampleHistory();
  assert.equal(writes.some(p=>['tws','vmg','twd'].includes(p.type)),false);
  engine.processIncomingDelta('environment.wind.angleApparent',0.5,now);
  engine.processIncomingDelta('environment.wind.speedApparent',0,now);
  now+=1000;engine.sampleHistory();
  assert.ok(writes.some(p=>p.type==='aws'&&p.val===0));
  assert.ok(writes.some(p=>p.type==='tws'&&p.val===0));
  assert.equal(engine.getRawTimes()['environment.wind.speedApparent'],now-1000);
 } finally {Date.now=oldNow;}
});

test('unchanged new reports refresh AWS age but old reports and invalid values do not',()=>{
 const oldNow=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const engine=new WindEngine({debug(){}},()=>({}));
  engine.processIncomingDelta('environment.wind.speedApparent',4,now);
  now+=1000;engine.processIncomingDelta('environment.wind.speedApparent',4,now);
  assert.equal(engine.lastAwsReceivedTime,now);
  engine.processIncomingDelta('environment.wind.speedApparent',9,now-10000);
  engine.processIncomingDelta('environment.wind.speedApparent',Infinity,now+1000);
  assert.equal(engine.lastAwsReceivedTime,now);
  assert.equal(engine.raw['environment.wind.speedApparent'],4);
  engine.processIncomingDelta('environment.wind.speedApparent',null,now);
  assert.equal(engine.lastAwsReceivedTime,now);
  assert.equal(engine.raw['environment.wind.speedApparent'],null);
 } finally {Date.now=oldNow;}
});
