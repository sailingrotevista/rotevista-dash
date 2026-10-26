const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
const {SensorNormalizer}=require('../sensors/SensorNormalizer');
const {SensorDerivedData}=require('../sensors/SensorDerivedData');
const path='navigation.position',now=1700000000000;
function engine(){const e=new WindEngine({debug(){}},()=>({}));e.fetchOpenMeteoForecast=()=>{};return e;}
test('selected backup replaces a newer source fix without inventing its timestamp',()=>{
 const e=engine();e.applyNormalizedPosition({valid:true,value:{latitude:36,longitude:14},timestamp:now},now);
 e.applyNormalizedPosition({valid:true,value:{latitude:36.001,longitude:14},timestamp:now-2000},now);
 assert.equal(e.getRaw()[path].latitude,36.001);assert.equal(e.getRawTimes()[path],now-2000);
 e.applyNormalizedPosition({valid:true,value:{latitude:36.001,longitude:14},timestamp:now-2000},now+3000);
 assert.equal(e.getRaw()[path],null);assert.equal(e.getRawTimes()[path],now-2000);
});
test('receiver-normalizer-derived GPS reaches Wind once per tick and expires without fresh fixes',()=>{
 const n=new SensorNormalizer(),d=new SensorDerivedData(),e=engine();
 n.ingest({path,value:{latitude:36,longitude:14},source:'gps',timestamp:now,receivedAt:now});
 const apply=t=>{const snapshot=n.tick(t);if(snapshot)e.applyNormalizedPosition(d.process(snapshot).measurements[path],t);};
 apply(now);assert.deepEqual(e.getRaw()[path],{latitude:36,longitude:14});
 apply(now+1000);assert.equal(e.getRawTimes()[path],now);
 apply(now+5000);assert.equal(e.getRaw()[path],null);assert.equal(e.getRawTimes()[path],now);
});
test('browser applies authoritative backup and null reset even with an older GPS timestamp',async()=>{
 const {applyNormalizedSessionPosition}=await import('../src/utils/measurementReset.mjs');
 const store={raw:{[path]:{latitude:36,longitude:14}},timestamps:{[path]:now}};
 applyNormalizedSessionPosition(store,{latitude:37,longitude:15},now-2000,now,now+100);
 assert.equal(store.raw[path].latitude,37);assert.equal(store.timestamps[path],now-1900);
 applyNormalizedSessionPosition(store,null,now-2000,now+5000,now+5100);
 assert.equal(store.raw[path],null);assert.equal(store.timestamps[path],now-1900);
});
test('AIS cannot revive rejected or expired own GPS through Signal K cache',()=>{
 const {AisEngine}=require('../ais/aisEngine');
 const e=engine();e.normalizedPositionManaged=true;
 e.raw[path]=null;
 const app={debug(){},getSelfPath(key){if(key.includes('position'))throw Error('GPS cache bypass');return null;},getPath(){throw Error('GPS cache bypass');}};
 const ais=new AisEngine(app,()=>({}),e,{processHarbors(){throw Error('must wait for own GPS');}},{});
 ais.refreshOwnGeometry=()=>{};
 ais.lastOwnGps={lat:36,lon:14,t:now};
 ais.process();assert.equal(ais.aisDiagnostics.status,'WAITING_OWN_GPS');
 e.raw[path]={latitude:36,longitude:14};e.positionSourceTime=1;
 ais.process();assert.equal(ais.aisDiagnostics.status,'WAITING_OWN_GPS');
});
