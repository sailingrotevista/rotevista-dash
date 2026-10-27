const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SensorNormalizer,GPS_SCORE_WEIGHTS}=require('../sensors/SensorNormalizer');
const {WindEngine}=require('../wind/windEngine');
const {OwnMotionState}=require('../ais/ownMotionState');
const {TargetMotionTracker}=require('../ais/targetMotionTracker');
const P='navigation.position', S='navigation.speedOverGround', start=1800000000000;
const pos={latitude:36,longitude:14};
const put=(n,source,t,value=pos,path=P)=>n.ingest({source,path,timestamp:start+t,receivedAt:start+t,value});
const measurement=(n,t)=>n.tick(start+t).measurements[P];
test('three-minute stationary AIS cadence remains usable and replay/ticks never create fixes',()=>{
 const n=new SensorNormalizer();
 put(n,'ais',0);const first=measurement(n,0);
 assert.equal(first.validityMs,240000);assert.equal(first.expiresAt,start+240000);
 assert.equal(measurement(n,179000).valid,true);
 assert.equal(n.gps.sources.get('ais').samples.length,1);
 put(n,'ais',180000);assert.equal(measurement(n,180000).isNewObservation,true);
 assert.equal(measurement(n,239000).timestamp,start+180000);
 assert.equal(measurement(n,240000).isNewObservation,false);
 assert.equal(measurement(n,420000).status,'STALE');
 assert.equal(put(n,'ais',180000),false);
 assert.equal(n.gps.sources.get('ais').samples.length,2);
});
test('50m deadline is shared across sources with 15s floor, 4min cap and missing/zero speed fallback',()=>{
 for(const [knots,seconds] of [[0,240],[.1,240],[1,50/(1852/3600)],[2,50/(2*1852/3600)],[5,50/(5*1852/3600)],[20,15]]) {
  const n=new SensorNormalizer();put(n,'speed',0,knots*1852/3600,S);put(n,'gps',0);put(n,'ais',0);
  const snap=measurement(n,0);assert.ok(Math.abs(snap.validityMs-seconds*1000)<.01);
  const rows=n.getSourceDiagnostics(start);
  assert.equal(rows.find(r=>r.source==='gps').metrics.validityMs,rows.find(r=>r.source==='ais').metrics.validityMs);
 }
 const n=new SensorNormalizer();put(n,'gps',0);assert.equal(measurement(n,0).validityMs,240000);
 put(n,'speed',1000,5,S);assert.equal(measurement(n,1000).validityMs,15000);
 assert.equal(measurement(n,16000).validityMs,240000,'absent recent speed uses maximum without inventing zero');
 assert.equal(n.gps.referenceSpeedMps,null);
});
test('continuous speed evidence expires a fix at its actual dynamic deadline; failover is immediate',()=>{
 const n=new SensorNormalizer();put(n,'speed',0,20*1852/3600,S);put(n,'main',0);measurement(n,0);
 put(n,'backup',14000);put(n,'speed',14000,20*1852/3600,S);
 assert.equal(measurement(n,14000).source,'main');
 const m=measurement(n,15000);assert.equal(m.source,'backup');assert.equal(m.selectionReason,'FAILOVER');
 assert.equal(m.timestamp,start+14000);assert.equal(m.expiresAt,start+29000);
 put(n,'speed',28000,20*1852/3600,S);assert.equal(measurement(n,29000).status,'STALE');
});
test('only freshness, accepted-fix ratio and available GNSS quality affect selection',()=>{
 assert.deepEqual(GPS_SCORE_WEIGHTS,{freshness:50,coherence:30,declaredQuality:20});
 const n=new SensorNormalizer();put(n,'gps',0);measurement(n,0);
 const row=n.getSourceDiagnostics(start+120000).find(r=>r.source==='gps');
 assert.equal(row.components.freshness.factor,.5);assert.equal(row.components.coherence.factor,1);
 assert.equal(row.components.declaredQuality.available,false);
 assert.equal(row.score,68.75); // (50*.5 + 30*1) / 80 * 100
 put(n,'gps',121000,{latitude:91,longitude:14});put(n,'gps',122000);
 const bad=n.getSourceDiagnostics(start+122000).find(r=>r.source==='gps');
 assert.equal(bad.components.coherence.factor,2/3);
 assert.equal(put(n,'gps',122000),false);
 assert.equal(n.getSourceDiagnostics(start+123000).find(r=>r.source==='gps').metrics.observationCount,3);
});
test('15-minute reliability retains old rejections, bounds memory and expires historical evidence',()=>{
 const n=new SensorNormalizer();put(n,'gps',0,{latitude:91,longitude:14});put(n,'gps',1000);
 put(n,'gps',600000);
 assert.equal(n.getSourceDiagnostics(start+600000)[0].metrics.rejectedFixes,1);
 put(n,'gps',901000);
 assert.equal(n.getSourceDiagnostics(start+901000)[0].metrics.rejectedFixes,0);
 const dense=new SensorNormalizer({maxSamplesPerSource:10});
 for(let t=0;t<1000;t+=10)put(dense,'gps',t);
 assert.equal(dense.gps.sources.get('gps').observations.length,10);
});
test('absolute expiry reaches Wind, own tracker and browser with unchanged source timestamp',async()=>{
 const n=new SensorNormalizer();put(n,'gps',0);const m=measurement(n,0);
 const engine=new WindEngine({debug(){}},()=>({}));engine.fetchOpenMeteoForecast=()=>{};
 engine.applyNormalizedPosition(m,start+180000);
 assert.deepEqual(engine.getRaw()[P],pos);assert.equal(engine.getRawTimes()[P],start);
 const own=new OwnMotionState(new TargetMotionTracker());
 assert.equal(own.update(engine.getRaw(),engine.getRawTimes(),[],start+180000,m.expiresAt).valid,true);
 const {applyNormalizedSessionPosition}=await import('../src/utils/measurementReset.mjs');
 const {resolveOwnShipNavigation}=await import('../src/utils/ownShipNavigation.mjs');
 const policy=require('../shared/windDataPolicy.json');
 const store={raw:{},timestamps:{}};
 // A client clock one hour ahead maps both timestamp and deadline consistently.
 applyNormalizedSessionPosition(store,pos,start,start+180000,start+3780000,m.expiresAt);
 assert.equal(store.timestamps[P],start+3600000);
 assert.equal(store.positionExpiresAt,start+3840000);
 assert.ok(resolveOwnShipNavigation(store.raw,store.timestamps,start+3839999,policy,store.positionExpiresAt).position);
 assert.equal(resolveOwnShipNavigation(store.raw,store.timestamps,start+3840000,policy,store.positionExpiresAt).position,null);
 engine.applyNormalizedPosition(m,start+240000);assert.equal(engine.getRaw()[P],null);
 assert.equal(own.update({[P]:pos},{[P]:start},[],start+240000,m.expiresAt).valid,false);
});
