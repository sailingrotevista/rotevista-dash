const {feedWindInput}=require('./helpers/feedWindInput');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AwsNormalizer}=require('../sensors/sensorNormalizer/AwsNormalizer');
const {SignalKReceiver}=require('../sensors/SignalKReceiver');
const {SensorNormalizer}=require('../sensors/SensorNormalizer');
const {SensorDerivedData}=require('../sensors/SensorDerivedData');
const {WindEngine}=require('../wind/windEngine');
const {DashboardSession}=require('../session/dashboardSession');
const P='environment.wind.speedApparent',t=1800000000000;
const input=(n,source,ms,value)=>n.ingest({path:P,source,timestamp:t+ms,receivedAt:t+ms,value});

test('AWS keeps measured zero, range and ordering; reset revokes rather than inventing calm',()=>{
 const n=new AwsNormalizer();
 assert.equal(input(n,'a',0,0),true);assert.equal(n.tick(t).value,0);
 assert.equal(input(n,'a',0,8),false);assert.equal(n.tick(t).value,0);
 input(n,'a',0,null);assert.equal(n.tick(t).value,null);
 input(n,'a',0,0);assert.equal(n.tick(t).value,null);
 assert.equal(input(n,'a',1000,40),true);assert.equal(n.tick(t+1000).value,40);
 for(const v of [-1,51.45,NaN,Infinity,'3',undefined]){
  const bad=new AwsNormalizer();input(bad,'a',0,v);assert.equal(bad.tick(t).valid,false);
 }
 const unknown=new AwsNormalizer();
 unknown.ingest({path:P,value:8,source:'a',timestamp:null,receivedAt:t});assert.equal(unknown.tick(t).status,'UNAVAILABLE');
});

test('AWS frequency/freshness selection locks equal sources and promotes only sustained better real reports',()=>{
 const n=new AwsNormalizer();input(n,'slow',0,8);n.tick(t);
 for(let ms=1000;ms<=8000;ms+=1000){
  if(ms%2000===0)input(n,'slow',ms,8);
  input(n,'fast',ms,10+ms/1000);
  const m=n.tick(t+ms);assert.equal(m.source,ms<6000?'slow':'fast');
  if(ms===6000)assert.equal(m.selectionReason,'PREFERRED_SOURCE');
 }
 const equal=new AwsNormalizer();input(equal,'a',0,4);equal.tick(t);
 for(let ms=1000;ms<10000;ms+=1000){input(equal,'a',ms,5);input(equal,'b',ms,6);assert.equal(equal.tick(t+ms).source,'a');}
 const d=equal.getSourceDiagnostics(t+9000);assert.equal(d[0].frequency,1);assert.equal(d[0].score,100);
});

test('AWS fails over to an older usable backup, expires at five seconds and never refreshes timestamps on ticks',()=>{
 const n=new AwsNormalizer();input(n,'a',0,5);n.tick(t);
 input(n,'backup',1000,7);input(n,'a',2000,9);n.tick(t+2000);
 input(n,'a',3000,null);
 const backup=n.tick(t+3000);assert.equal(backup.source,'backup');assert.equal(backup.timestamp,t+1000);
 assert.equal(backup.selectionReason,'FAILOVER');assert.equal(backup.value,7);
 assert.equal(n.tick(t+4000).isNewObservation,false);
 assert.equal(n.tick(t+5999).valid,true);assert.equal(n.tick(t+6000).status,'STALE');
 assert.equal(n.tick(t+6000).value,null);
});

test('native-cadence AWS reaches DerivedData and shared live/mixed frames at 1Hz without changing raw values or timestamps',()=>{
 const normalizer=new SensorNormalizer(),derived=new SensorDerivedData();
 const receiver=new SignalKReceiver({onMeasurement:m=>normalizer.ingest(m)});
 const wind=new WindEngine({debug(){}},()=>({}));
 const receive=(ms,value)=>receiver.receive({context:'vessels.self',updates:[{$source:'wind.1',timestamp:new Date(t+ms).toISOString(),values:[{path:P,value}]}]},t+ms);
 receive(0,8);let snapshot=derived.process(normalizer.tick(t));wind.applyNormalizedAws(snapshot.measurements[P],t);
 for(let ms=100;ms<=900;ms+=100){receive(ms,8+ms/100);assert.equal(normalizer.tick(t+ms),null);}
 snapshot=derived.process(normalizer.tick(t+1000));const m=snapshot.measurements[P];
 assert.equal(m.value,17);assert.equal(m.timestamp,t+900);assert.equal(m.expiresAt,t+5900);
 wind.applyNormalizedAws(m,t+1000);wind.processIncomingDelta(P,50,t+1100);
 assert.equal(wind.getRaw()[P],17);assert.equal(wind.getRawTimes()[P],t+900);
 const live={raw:wind.getRaw(),rawTimes:wind.getRawTimes(),normalizedAws:true,awsMeasurement:m,targets:[],harborClusters:[]};
 const session=new DashboardSession({readLive:()=>live,environment:'dev',now:t+1000});
 const frame=session.tick(t+1000);assert.equal(frame.normalizedAws,true);assert.deepEqual(frame.awsMeasurement,m);assert.equal(frame.raw[P],17);
 session.setMode('mixed',t+1000);assert.equal(session.snapshot().normalizedAws,true);assert.equal(session.snapshot().raw[P],17);
 session.setMode('simulation',t+1000);assert.equal(session.snapshot().normalizedAws,false);assert.equal(session.snapshot().awsMeasurement,null);
 // Polling and a stopped producer cannot extend the last measurement's lifetime.
 assert.equal(wind.getNormalizedAws(t+5899),17);assert.equal(wind.getNormalizedAws(t+5900),null);
 receive(6000,0);snapshot=derived.process(normalizer.tick(t+6000));wind.applyNormalizedAws(snapshot.measurements[P],t+6000);
 assert.equal(wind.getNormalizedAws(t+6000),0);
});

test('Wind uses normalized AWS deadline for fallback and history, with no second independent timeout',()=>{
 const oldNow=Date.now;Date.now=()=>t+6000;
 try {
 const wind=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:5}}));
 wind.applyNormalizedAws({valid:true,value:10,timestamp:t,expiresAt:t+10000},t);
 feedWindInput(wind,'environment.wind.angleApparent',0,t+6000);
 const writes=[];wind.manageHistory=(type,value)=>writes.push({type,value});
 wind.sampleHistory(t+6000);
 assert.ok(writes.some(p=>p.type==='aws'&&p.value===10*1.94384));
 assert.ok(writes.some(p=>p.type==='tws'&&p.value===10*1.94384));
 writes.length=0;wind.sampleHistory(t+10000);assert.equal(writes.some(p=>['aws','tws'].includes(p.type)),false);
 } finally {Date.now=oldNow;}
});
