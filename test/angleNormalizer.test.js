const {test}=require('node:test');
const assert=require('node:assert/strict');
const paths=require('../shared/angularSensorPaths.json');
const {AngleNormalizer}=require('../sensors/sensorNormalizer/AngleNormalizer');
const {SignalKReceiver}=require('../sensors/SignalKReceiver');
const {SensorNormalizer}=require('../sensors/SensorNormalizer');
const {SensorDerivedData}=require('../sensors/SensorDerivedData');
const {WindEngine}=require('../wind/windEngine');
const {DashboardSession}=require('../session/dashboardSession');
const {feedWindInput}=require('./helpers/feedWindInput');
const base=1800000000000;
const rad=d=>d*Math.PI/180;
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const sample=(path,source,ms,value,extra={})=>({path,source,timestamp:base+ms,receivedAt:base+ms,value,...extra});

for(const path of Object.keys(paths)){
 test(`${path}: selected radians preserve zero and sign, reject invalid data, replay and future/expired time`,()=>{
  const n=new AngleNormalizer(path);
  n.ingest(sample(path,'a',0,0));assert.equal(n.tick(base).value,0);
  n.ingest(sample(path,'a',1000,-1));assert.equal(n.tick(base+1000).value,-1);
  n.ingest(sample(path,'a',1000,2));assert.equal(n.tick(base+1000).value,-1);
  n.ingest(sample(path,'a',1000,null));assert.equal(n.tick(base+1000).value,null);
  n.ingest(sample(path,'a',1000,-1));assert.equal(n.tick(base+1000).status,'INVALID');
  for(const value of [2*Math.PI+.01,-2*Math.PI-.01,NaN,Infinity,'1',undefined]){
   const bad=new AngleNormalizer(path);assert.equal(bad.ingest(sample(path,'a',0,value)),false);assert.equal(bad.tick(base).valid,false);
  }
  for(const extra of [{source:''},{timestamp:null},{timestamp:base+1},{timestamp:base-5000}])assert.equal(new AngleNormalizer(path).ingest(sample(path,'a',0,1,extra)),false);
 });
 test(`${path}: wraparound is not averaged, lock is stable, older backup keeps its timestamp and expires at 5s`,()=>{
  const n=new AngleNormalizer(path);
  n.ingest(sample(path,'a',0,rad(359)));n.tick(base);
  for(let ms=1000;ms<=3000;ms+=1000){n.ingest(sample(path,'a',ms,rad(359)));n.ingest(sample(path,'b',ms,rad(1)));close(n.tick(base+ms).value,rad(359));}
  n.ingest(sample(path,'a',4000,rad(359)));n.tick(base+4000);n.ingest(sample(path,'a',4500,null));
  const backup=n.tick(base+4500);assert.equal(backup.source,'b');close(backup.value,rad(1));assert.equal(backup.timestamp,base+3000);
  assert.equal(backup.selectionReason,'FAILOVER');assert.equal(n.tick(base+5000).isNewObservation,false);
  assert.equal(n.tick(base+7999).valid,true);assert.equal(n.tick(base+8000).status,'STALE');
 });
}

test('all angular inputs are selected at 1Hz and pass metadata unchanged through DerivedData and live/mixed frames',()=>{
 const n=new SensorNormalizer(),derived=new SensorDerivedData();const receiver=new SignalKReceiver({onMeasurement:m=>n.ingest(m)});
 const receive=(ms,value)=>receiver.receive({context:'vessels.self',updates:[{$source:'instruments.1',timestamp:new Date(base+ms).toISOString(),values:Object.keys(paths).map(path=>({path,value}))}]},base+ms);
 receive(0,0);n.tick(base);
 for(let ms=100;ms<1000;ms+=100){receive(ms,-ms/1000);assert.equal(n.tick(base+ms),null);}
 const snap=derived.process(n.tick(base+1000));const wind=new WindEngine({debug(){}},()=>({}));
 for(const path of Object.keys(paths)){
  const m=snap.measurements[path];assert.equal(m.value,-.9);assert.equal(m.timestamp,base+900);assert.equal(m.source,'instruments.1');
  wind.applyNormalizedAngle(path,m,base+1000);wind.processIncomingDelta(path,2,base+1100);
  close(wind.getRaw()[path],2*Math.PI-.9);assert.equal(wind.getRawTimes()[path],base+900);
  assert.equal(wind.getNormalizedAngle(path,base+5900),null);
 }
 const live={raw:wind.getRaw(),rawTimes:wind.getRawTimes(),normalizedAngles:true,angleMeasurements:Object.fromEntries(Object.keys(paths).map(p=>[p,snap.measurements[p]])),targets:[],harborClusters:[]};
 const session=new DashboardSession({readLive:()=>live,environment:'dev',now:base+1000});
 for(const mode of ['live','mixed','simulation']){
  session.setMode(mode,base+1000);const frame=session.snapshot();assert.equal(frame.normalizedAngles,mode!=='simulation');
  assert.deepEqual(frame.angleMeasurements,mode==='simulation'?null:live.angleMeasurements);
 }
 assert.throws(()=>new AngleNormalizer('navigation.position'),/Unsupported/);
});

test('normalized heading retains WMM magnetic priority, then true heading and COG only with valid motion',()=>{
 const wind=new WindEngine({debug(){}},()=>({}));const old=Date.now;let now=base;Date.now=()=>now;
 try{
  wind.updatePositionForecast=()=>{};
  wind.applyNormalizedPosition({valid:true,value:{latitude:36.78,longitude:14.54},timestamp:base,expiresAt:base+240000},now);
  feedWindInput(wind,'navigation.headingTrue',rad(20),now);
  feedWindInput(wind,'navigation.headingMagnetic',rad(156),now);
  const heading=wind.getResolvedHeading(now);assert.ok(heading>rad(156)&&heading<rad(165));
  now+=1000;feedWindInput(wind,'navigation.headingMagnetic',null,now);close(wind.getResolvedHeading(now),rad(20));
  feedWindInput(wind,'navigation.headingTrue',null,now);feedWindInput(wind,'navigation.courseOverGroundTrue',rad(90),now);
  feedWindInput(wind,'navigation.speedOverGround',2,now);close(wind.getResolvedHeading(now),rad(90));
  feedWindInput(wind,'navigation.speedOverGround',null,now);assert.equal(wind.getResolvedHeading(now),null);
  assert.equal(wind.getRaw()['navigation.headingTrue'],null,'COG fallback does not invent a received compass');
 }finally{Date.now=old;}
});

test('history and vector fallback honour normalized angle deadlines rather than an independent timeout',()=>{
 const wind=new WindEngine({debug(){}},()=>({}));const old=Date.now;let now=base;Date.now=()=>now;
 const m=value=>({valid:true,value,timestamp:base,expiresAt:base+10000});
 try{
  for(const path of Object.keys(paths))wind.applyNormalizedAngle(path,null,now);
  wind.applyNormalizedAngle('environment.wind.angleApparent',m(0),now);
  wind.applyNormalizedAngle('navigation.headingTrue',m(1),now);
  wind.applyNormalizedAngle('navigation.courseOverGroundTrue',m(2),now);
  now+=6000;feedWindInput(wind,'environment.wind.speedApparent',4,now);feedWindInput(wind,'navigation.speedThroughWater',1,now);
  const values={};wind.manageHistory=(type,value)=>{values[type]=value;};wind.sampleHistory(now);
  close(values.tws,3*1.94384);close(wind.getRollingAngles().cog.at(-1).val,2);close(wind.getRollingAngles().hdg.at(-1).val,1);
  close(values.twd,1);
  now=base+10000;delete values.tws;delete values.twd;wind.sampleHistory(now);
  assert.equal(values.tws,undefined);assert.equal(values.twd,undefined);
 }finally{Date.now=old;}
});

test('native TWA/TWD invalidation and clock expiry never freeze rolling histories',()=>{
 const wind=new WindEngine({debug(){}},()=>({}));const old=Date.now;let now=base;Date.now=()=>now;
 try{
  feedWindInput(wind,'environment.wind.angleTrueWater',-.5,now);feedWindInput(wind,'environment.wind.directionTrue',2,now);
  wind.sampleHistory(now);assert.equal(wind.getRollingAngles().twa.length,1);
  now+=1000;feedWindInput(wind,'environment.wind.angleTrueWater',null,now);assert.equal(wind.getRollingAngles().twa.length,0);
  const count=wind.getHistories().twd.length;now=base+6000;wind.sampleHistory(now);assert.equal(wind.getHistories().twd.length,count);
 }finally{Date.now=old;}
});
