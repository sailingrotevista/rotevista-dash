const {feedWindInput}=require('./helpers/feedWindInput');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {StwNormalizer}=require('../sensors/sensorNormalizer/StwNormalizer');
const {TwsNormalizer}=require('../sensors/sensorNormalizer/TwsNormalizer');
const {DepthNormalizer}=require('../sensors/sensorNormalizer/DepthNormalizer');
const {SignalKReceiver}=require('../sensors/SignalKReceiver');
const {SensorNormalizer}=require('../sensors/SensorNormalizer');
const {SensorDerivedData}=require('../sensors/SensorDerivedData');
const {WindEngine}=require('../wind/windEngine');
const {DashboardSession}=require('../session/dashboardSession');
const base=1800000000000;
const categories=[
 {name:'Stw',path:'navigation.speedThroughWater',Ctor:StwNormalizer,min:0,max:25.72},
 {name:'Tws',path:'environment.wind.speedTrue',Ctor:TwsNormalizer,min:0,max:51.44},
 {name:'Depth',path:'environment.depth.belowTransducer',Ctor:DepthNormalizer,min:-2,max:500},
];
const event=(path,source,ms,value,extra={})=>({path,source,timestamp:base+ms,receivedAt:base+ms,value,...extra});

for(const c of categories){
 test(`${c.name}: preserve range and zero, reject missing time/provenance/replays, and revoke with null`,()=>{
  const n=new c.Ctor();assert.equal(n.ingest(event(c.path,'a',0,c.min)),true);assert.equal(n.tick(base).value,c.min);
  n.ingest(event(c.path,'a',1000,c.max));assert.equal(n.tick(base+1000).value,c.max);
  n.ingest(event(c.path,'a',2000,0));assert.equal(n.tick(base+2000).value,0);
  n.ingest(event(c.path,'a',2000,null));assert.equal(n.tick(base+2000).status,'INVALID');
  n.ingest(event(c.path,'a',2000,0));assert.equal(n.tick(base+2000).value,null);
  for(const value of [c.min-.01,c.max+.01,NaN,Infinity,undefined,'2']){
   const invalid=new c.Ctor();assert.equal(invalid.ingest(event(c.path,'a',0,value)),false);assert.equal(invalid.tick(base).valid,false);
  }
  for(const extra of [{source:null},{timestamp:null},{timestamp:base+1},{timestamp:base-5000}]){
   const invalid=new c.Ctor();assert.equal(invalid.ingest(event(c.path,'a',0,2,extra)),false);
  }
 });
 test(`${c.name}: stable source lock, immediate failover to older valid backup and unchanged 5s expiry`,()=>{
  const n=new c.Ctor();n.ingest(event(c.path,'a',0,2));n.tick(base);
  for(let ms=1000;ms<=3000;ms+=1000){n.ingest(event(c.path,'a',ms,3));n.ingest(event(c.path,'b',ms,4));assert.equal(n.tick(base+ms).source,'a');}
  n.ingest(event(c.path,'a',4000,5));n.tick(base+4000);n.ingest(event(c.path,'a',4500,null));
  const backup=n.tick(base+4500);assert.equal(backup.source,'b');assert.equal(backup.timestamp,base+3000);assert.equal(backup.selectionReason,'FAILOVER');
  assert.equal(n.tick(base+5000).isNewObservation,false);assert.equal(n.tick(base+7999).value,4);
  assert.equal(n.tick(base+8000).value,null);assert.equal(n.tick(base+8000).status,'STALE');
 });
}

test('STW/TWS/depth run through receiver and 1Hz snapshots, preserve metadata into frames and close raw bypasses',()=>{
 const n=new SensorNormalizer(),derived=new SensorDerivedData(),wind=new WindEngine({debug(){}},()=>({}));
 const receiver=new SignalKReceiver({onMeasurement:m=>n.ingest(m)});
 const receive=(ms,offset)=>receiver.receive({context:'vessels.self',updates:[{$source:'sensors.1',timestamp:new Date(base+ms).toISOString(),values:categories.map((c,i)=>({path:c.path,value:i+offset}))}]},base+ms);
 receive(0,1);derived.process(n.tick(base));
 for(let ms=100;ms<1000;ms+=100){receive(ms,ms/100);assert.equal(n.tick(base+ms),null);}
 const snapshot=derived.process(n.tick(base+1000));
 const live={raw:wind.getRaw(),rawTimes:null,targets:[],harborClusters:[]};
 for(const [i,c] of categories.entries()){
  const m=snapshot.measurements[c.path];assert.equal(m.value,i+9);assert.equal(m.timestamp,base+900);assert.equal(m.expiresAt,base+5900);
  wind['applyNormalized'+c.name](m,base+1000);wind.processIncomingDelta(c.path,999,base+1100);
  assert.equal(wind.getRaw()[c.path],i+9);assert.equal(wind.getRawTimes()[c.path],base+900);
  assert.equal(wind['getNormalized'+c.name](base+5900),null);
  live['normalized'+c.name]=true;live[c.name.toLowerCase()+'Measurement']=m;
 }
 live.rawTimes=wind.getRawTimes();
 const session=new DashboardSession({readLive:()=>live,environment:'dev',now:base+1000});
 for(const mode of ['live','mixed','simulation']){
  session.setMode(mode,base+1000);const frame=session.snapshot();
  for(const c of categories){assert.equal(frame['normalized'+c.name],mode!=='simulation');assert.deepEqual(frame[c.name.toLowerCase()+'Measurement'],mode==='simulation'?null:live[c.name.toLowerCase()+'Measurement']);}
 }
});

test('native TWS has priority; expiry falls back to normalized AWS/STW and no usable speeds falls back to AWS',()=>{
 const wind=new WindEngine({debug(){}},()=>({}));const original=Date.now;let now=base;Date.now=()=>now;
 const m=(value,life=5000)=>({valid:true,value,timestamp:base,expiresAt:base+life});
 try{
  wind.applyNormalizedAws(m(10,10000),now);wind.applyNormalizedStw(m(2,10000),now);wind.applyNormalizedTws(m(15),now);
  feedWindInput(wind,'environment.wind.angleApparent',0,now);
  const values={};wind.manageHistory=(channel,value)=>{values[channel]=value;};wind.sampleHistory(now);
  assert.equal(values.tws,15*1.94384);assert.equal(values.stw,2*1.94384);
  now=base+6000;feedWindInput(wind,'environment.wind.angleApparent',0,now);wind.sampleHistory(now);
  assert.equal(values.tws,8*1.94384);assert.equal(values.stw,2*1.94384,'supplied expiry is authoritative');
  wind.applyNormalizedStw(null,now);now+=1000;wind.sampleHistory(now);assert.equal(values.tws,10*1.94384);
  wind.applyNormalizedTws({...m(0),timestamp:now,expiresAt:now+5000},now);now+=1000;wind.sampleHistory(now);assert.equal(values.tws,0);
 }finally{Date.now=original;}
});

test('depth history keeps the minimum of valid selected samples, leaves a gap after expiry and resumes with real zero',()=>{
 const wind=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:5}}));
 const apply=(ms,value)=>{wind.applyNormalizedDepth({valid:true,value,timestamp:base+ms,expiresAt:base+ms+5000},base+ms);wind.sampleHistory(base+ms);};
 apply(0,8);apply(1000,3);apply(2000,6);apply(6000,7);
 assert.ok(wind.getHistories().depth.some(p=>p.val===3));
 const count=wind.getHistories().depth.length;wind.sampleHistory(base+11000);assert.equal(wind.getHistories().depth.length,count);
 apply(12000,0);assert.equal(wind.getHistories().depth.at(-1).val,0);assert.equal(wind.getHistories().depth.at(-1).gapBefore,true);
});
