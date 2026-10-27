const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SogNormalizer}=require('../sensors/sensorNormalizer/SogNormalizer');
const {SensorNormalizer}=require('../sensors/SensorNormalizer');
const {SensorDerivedData}=require('../sensors/SensorDerivedData');
const {WindEngine}=require('../wind/windEngine');
const {DashboardSession}=require('../session/dashboardSession');
const P='navigation.speedOverGround',start=1800000000000;
const put=(n,source,t,value=1,extra={})=>n.ingest({path:P,source,timestamp:start+t,receivedAt:start+t,value,...extra});
const tick=(n,t)=>n.tick(start+t);
test('SOG validates numbers, provenance and source time; zero is measured and null reset wins at equal time',()=>{
 const n=new SogNormalizer();assert.equal(put(n,'a',0,0),true);assert.equal(tick(n,0).value,0);
 assert.equal(put(n,'a',0,2),false);
 assert.equal(put(n,'a',0,null),false);assert.equal(tick(n,0).status,'INVALID');
 assert.equal(put(n,'a',0,0),false);assert.equal(tick(n,0).value,null);
 assert.equal(put(n,'a',1000,0),true);
 for(const value of [undefined,NaN,Infinity,-1,26,'2']){
  const bad=new SogNormalizer();assert.equal(put(bad,'a',0,value,{value}),false);assert.equal(tick(bad,0).value,null);
 }
 for(const extra of [{timestamp:null},{timestamp:start+1},{source:''},{receivedAt:NaN},{timestamp:start-5000}])
  assert.equal(put(new SogNormalizer(),'a',0,1,extra),false);
});
test('frequency and freshness have equal weight, saturate at 1Hz and retain slow-source diagnostics',()=>{
 const n=new SogNormalizer();
 for(let t=0;t<=10000;t+=100){put(n,'fast',t);if(t%1000===0)put(n,'one-hz',t);if(t%2000===0)put(n,'slow',t);}
 const d=Object.fromEntries(n.getSourceDiagnostics(start+11000).map(r=>[r.source,r]));
 assert.equal(d.fast.score,90);assert.equal(d['one-hz'].score,90);assert.equal(d.slow.score,65);
 assert.equal(d.slow.typicalIntervalMs,2000);assert.equal(d.fast.frequency,1);
 assert.equal(d.fast.freshness,.8);
});
test('a lock survives interleaved equal sources; a better frequency requires 15 points, time and distinct fixes',()=>{
 const n=new SogNormalizer();put(n,'slow',0);tick(n,0);
 for(let t=1000;t<=8000;t+=1000){
  if(t%2000===0)put(n,'slow',t);
  put(n,'fast',t);
  const m=tick(n,t);
  assert.equal(m.source,t<6000?'slow':'fast');
  if(t===6000)assert.equal(m.selectionReason,'PREFERRED_SOURCE');
 }
 const equal=new SogNormalizer();put(equal,'a',0);tick(equal,0);
 for(let t=1000;t<=12000;t+=1000){put(equal,'a',t);put(equal,'b',t+100);assert.equal(tick(equal,t+100).source,'a');}
});
test('polling cannot supply promotion fixes; expiry and invalidation cause immediate failover without fabricating time',()=>{
 const n=new SogNormalizer();put(n,'a',0);tick(n,0);put(n,'b',4000);
 assert.equal(tick(n,4000).source,'a');
 const m=tick(n,5000);assert.equal(m.source,'b');assert.equal(m.selectionReason,'FAILOVER');assert.equal(m.timestamp,start+4000);
 assert.equal(tick(n,9000).status,'STALE');
 put(n,'a',10000);tick(n,10000);put(n,'b',11000);put(n,'a',11000,null);
 assert.equal(tick(n,11000).source,'b');
 const locked=new SogNormalizer({maxAgeMs:20000});put(locked,'current',0);tick(locked,0);put(locked,'new',10000);
 for(let t=10000;t<=18000;t+=1000)assert.equal(tick(locked,t).source,'current');
});
test('real SOG follows Receiver/Normalizer/DerivedData into Wind and authoritative browser frames, raw bypass is closed',async()=>{
 const n=new SensorNormalizer(),derived=new SensorDerivedData(),wind=new WindEngine({debug(){}},()=>({}));
 wind.fetchOpenMeteoForecast=()=>{};
 put(n,'gps',0,0);
 const snapshot=n.tick(start);const result=derived.process(snapshot);const m=result.measurements[P];
 wind.applyNormalizedSog(m,start);assert.equal(wind.getRaw()[P],0);assert.equal(wind.getRawTimes()[P],start);
 wind.processIncomingDelta(P,8,start+1000);assert.equal(wind.getRaw()[P],0);
 assert.equal(n.tick(start+500),null);
 const repeated=derived.process(n.tick(start+1000)).measurements[P];assert.equal(repeated.isNewObservation,false);assert.equal(repeated.timestamp,start);
 wind.applyNormalizedSog(repeated,start+5000);assert.equal(wind.getRaw()[P],null);
 const session=new DashboardSession({now:start,readLive:()=>({raw:wind.getRaw(),rawTimes:wind.getRawTimes(),normalizedSog:true,sogMeasurement:m})});
 assert.equal(session.snapshot().normalizedSog,true);assert.equal(session.snapshot().sogMeasurement.timestamp,start);
 const {applyNormalizedSessionSog}=await import('../src/utils/measurementReset.mjs');
 const store={raw:{},timestamps:{}};
 applyNormalizedSessionSog(store,0,start-2000,start,start+3600000);
 assert.equal(store.raw[P],0);assert.equal(store.timestamps[P],start+3598000);
 applyNormalizedSessionSog(store,null,start,start,start+3600000);assert.equal(store.raw[P],null);
 wind.applyNormalizedSog(null,start+5000);assert.equal(wind.getRaw()[P],null);
});
test('registries and timing histories remain bounded and stale sources are pruned',()=>{
 const n=new SogNormalizer({maxSources:3,maxSamplesPerSource:10,sourceRetentionMs:10000});
 for(let t=0;t<1000;t+=10)put(n,'a',t);
 assert.equal(n.sources.get('a').timestamps.length,10);tick(n,1000);
 for(let i=0;i<10;i++)put(n,'reserve-'+i,1100+i);
 assert.equal(n.sources.size,3);assert.equal(n.sources.has('a'),true);
 assert.equal(tick(n,12000).status,'UNAVAILABLE');assert.equal(n.sources.size,0);
});

test('Wind history, fallback TWS and COG heading honour the supplied SOG deadline rather than another timeout',()=>{
 const wind=new WindEngine({debug(){}},()=>({}));
 const old=Date.now;let now=start;Date.now=()=>now;
 try {
  wind.applyNormalizedAws({valid:true,value:10,timestamp:now,expiresAt:now+5000},now);
  wind.processIncomingDelta('environment.wind.angleApparent',0,now);
  wind.processIncomingDelta('navigation.courseOverGroundTrue',1,now);
  // A custom deadline demonstrates the contract; production remains five seconds.
  wind.applyNormalizedSog({valid:true,value:2,timestamp:start,expiresAt:start+10000},now);
  now=start+6000;
  wind.applyNormalizedAws({valid:true,value:10,timestamp:now,expiresAt:now+5000},now);
  wind.processIncomingDelta('environment.wind.angleApparent',0,now);
  wind.processIncomingDelta('navigation.courseOverGroundTrue',1,now);
  const values={};wind.manageHistory=(key,value)=>{values[key]=value;};wind.sampleHistory(now);
  assert.equal(values.sog,2*1.94384);assert.equal(values.tws,8*1.94384);
  assert.equal(wind.getRollingAngles().hdg.at(-1).val,1);
  now=start+10000;
  wind.applyNormalizedAws({valid:true,value:10,timestamp:now,expiresAt:now+5000},now);
  wind.processIncomingDelta('environment.wind.angleApparent',0,now);
  wind.processIncomingDelta('navigation.courseOverGroundTrue',1,now);
  delete values.sog;wind.sampleHistory(now);
  assert.equal(values.sog,undefined);assert.equal(values.tws,10*1.94384);
  assert.equal(wind.getNormalizedSog(now),null);
 }finally{Date.now=old;}
});
