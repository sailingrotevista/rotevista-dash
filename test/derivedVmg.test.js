const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SensorDerivedData}=require('../sensors/SensorDerivedData');
const {deriveVmg}=require('../sensors/derivedData/vmg');
const {WindEngine}=require('../wind/windEngine');
const {DashboardSession}=require('../session/dashboardSession');
const policy=require('../shared/windDataPolicy.json');
const base=1800000000000;
const names={stw:'navigation.speedThroughWater',sog:'navigation.speedOverGround',twa:'environment.wind.angleTrueWater',awa:'environment.wind.angleApparent',aws:'environment.wind.speedApparent'};
function snapshot(values,now=base){return {sampledAt:now,measurements:Object.fromEntries(Object.entries(values).map(([name,value])=>[names[name],{value,valid:value!==null,source:name+'.source',timestamp:base,expiresAt:base+5000}]))};}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('VMG preserves the existing native/fallback formula across speed choices, zero, downwind and missing inputs',async()=>{
 const {resolveVmg}=await import('../src/utils/windValidity.mjs');
 for(const values of [
  {stw:3,twa:Math.PI/3}, {stw:3,twa:Math.PI}, {stw:0,twa:0},
  {sog:4,twa:Math.PI/3}, {stw:0,sog:3,twa:1}, {stw:2,sog:3,twa:-1},
  {stw:3,aws:5,awa:1}, {sog:3,aws:5,awa:-1}, {stw:2,aws:2,awa:0},
  {twa:1}, {stw:3}, {aws:5,awa:1}, {},
 ]){
  const s=snapshot(values),raw={},times={};
  for(const [path,m] of Object.entries(s.measurements)){raw[path]=m.value;times[path]=m.timestamp;}
  const expected=resolveVmg(raw,times,base,policy),actual=deriveVmg(s);
  if(expected===null)assert.equal(actual.value,null);else close(actual.value,expected);
  assert.equal(actual.valid,expected!==null);
 }
});

test('VMG expiry and timestamp come from the actual dependencies, with no invented observation on repeated ticks',()=>{
 const s=snapshot({stw:3,twa:1,sog:4});
 s.measurements[names.twa].timestamp=base-1000;s.measurements[names.twa].expiresAt=base+4000;
 const first=deriveVmg(s);assert.equal(first.timestamp,base-1000);assert.equal(first.expiresAt,base+4000);
 assert.deepEqual(first.inputs.map(i=>i.path),[names.stw,names.twa]);
 const repeat=deriveVmg({...s,sampledAt:base+1000});assert.equal(repeat.observationId,first.observationId);assert.equal(repeat.expiresAt,first.expiresAt);
 // At expiry a still-fresh apparent-wind pair can take over.
 s.measurements[names.aws]={value:5,valid:true,source:'aws',timestamp:base+1000,expiresAt:base+6000};
 s.measurements[names.awa]={value:1,valid:true,source:'awa',timestamp:base+1000,expiresAt:base+6000};
 const fallback=deriveVmg({...s,sampledAt:base+4000});assert.equal(fallback.calculation,'APPARENT_WIND');assert.equal(fallback.expiresAt,base+5000);
 assert.equal(deriveVmg({...s,sampledAt:base+5000}).valid,false);
});

test('DerivedData keeps received values separate and copied while adding VMG with isolated provenance',()=>{
 const data=new SensorDerivedData(),input=snapshot({stw:3,twa:1});
 const result=data.process(input);assert.deepEqual(result.measurements,input.measurements);assert.equal(input.derived,undefined);
 assert.equal(result.derived.vmg.source,'DERIVED');close(result.derived.vmg.value,Math.abs(3*Math.cos(1)));
 result.derived.vmg.inputs[0].source='changed';result.measurements[names.stw].value=99;
 assert.equal(data.getSnapshot().derived.vmg.inputs[0].source,'stw.source');assert.equal(data.getSnapshot().measurements[names.stw].value,3);
});

test('Wind consumes derived VMG for history and honours its deadline without recomputing it from raw instruments',()=>{
 const wind=new WindEngine({debug(){}},()=>({}));wind.raw[names.stw]=5;wind.raw[names.twa]=0;
 const writes=[];wind.manageHistory=(channel,value)=>{if(channel==='vmg')writes.push(value);};
 wind.sampleHistory(base);assert.deepEqual(writes,[]);
 wind.applyDerivedVmg({value:2,valid:true,timestamp:base,expiresAt:base+3000});
 wind.sampleHistory(base+1000);assert.deepEqual(writes,[2*1.94384]);
 wind.sampleHistory(base+3000);assert.deepEqual(writes,[2*1.94384]);
 wind.applyDerivedVmg(null);assert.equal(wind.getDerivedVmg(base+3000),null);
});

test('shared live/mixed VMG is identical for clients and pure simulation uses the same derivation',()=>{
 const m=deriveVmg(snapshot({stw:3,twa:1}));
 const live={raw:{},rawTimes:{},targets:[],harborClusters:[],derivedVmg:true,vmgMeasurement:m};
 const session=new DashboardSession({readLive:()=>live,environment:'dev',now:base});
 for(const mode of ['live','mixed']){
  session.setMode(mode,base);const a=session.snapshot(),b=session.snapshot();assert.equal(a.derivedVmg,true);assert.deepEqual(a.vmgMeasurement,b.vmgMeasurement);assert.deepEqual(a.vmgMeasurement,m);
 }
 session.setMode('simulation',base);const frame=session.snapshot();assert.equal(frame.derivedVmg,true);assert.equal(frame.vmgMeasurement.valid,true);
 close(frame.vmgMeasurement.value,Math.abs(frame.raw[names.stw]*Math.cos(frame.raw[names.twa])));
});

test('clients on different clocks display the same derived VMG and neither polling nor missing data renew its deadline',async()=>{
 const {translateDerivedMeasurement,derivedMeasurementValue}=await import('../src/utils/derivedMeasurement.mjs');
 const m=deriveVmg(snapshot({stw:3,twa:1}));
 const a=translateDerivedMeasurement(m,base+2000,10000),b=translateDerivedMeasurement(m,base+2000,100000);
 close(derivedMeasurementValue(a,10000),derivedMeasurementValue(b,100000));
 assert.equal(derivedMeasurementValue(a,13000),null);assert.equal(derivedMeasurementValue(b,103000),null);
 const later=translateDerivedMeasurement(m,base+4000,12000);assert.equal(later.expiresAt,a.expiresAt);
 assert.equal(translateDerivedMeasurement(null,base,10000),null);assert.equal(derivedMeasurementValue(null,10000),null);
 const zero={...m,value:0};assert.equal(derivedMeasurementValue(translateDerivedMeasurement(zero,base,10000),10000),0);
});
