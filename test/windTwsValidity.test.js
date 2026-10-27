const {feedWindInput}=require('./helpers/feedWindInput');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../shared/windDataPolicy.json');
const {WindEngine}=require('../wind/windEngine');
const AWS='environment.wind.speedApparent',AWA='environment.wind.angleApparent',TWS='environment.wind.speedTrue';

test('native TWS including zero is independent of missing apparent wind',async()=>{
 const {resolveTws}=await import('../src/utils/windValidity.mjs');
 assert.equal(resolveTws({[TWS]:0},{[TWS]:1000},5999,policy),0);
 assert.equal(resolveTws({[TWS]:4},{[TWS]:1000},6000,policy),null);
 assert.equal(resolveTws({}, {},1000,policy),null);
});
test('TWS fallback uses AWS without boat speed and expires with either input',async()=>{
 const {resolveTws}=await import('../src/utils/windValidity.mjs');
 const raw={[AWS]:4,[AWA]:0.5};const times={[AWS]:1000,[AWA]:1000};
 assert.ok(Math.abs(resolveTws(raw,times,1000,policy)-4)<1e-10);
 assert.equal(resolveTws(raw,times,6000,policy),null);
 assert.equal(resolveTws(raw,{...times,[AWS]:6000},6000,policy),null);
 assert.equal(resolveTws(raw,{...times,[AWA]:6000},6000,policy),null);
 assert.ok(Math.abs(resolveTws(raw,{[AWS]:6000,[AWA]:6000},6000,policy)-4)<1e-10);
});
test('native-fallback-native transition preserves received value and consistent m/s units',async()=>{
 const {resolveTws}=await import('../src/utils/windValidity.mjs');
 const raw={[TWS]:8,[AWS]:10,[AWA]:0,'navigation.speedThroughWater':4};
 const times={[TWS]:1000,[AWS]:5000,[AWA]:5000,'navigation.speedThroughWater':5000};
 assert.equal(resolveTws(raw,times,5999,policy),8);
 assert.equal(resolveTws(raw,times,6000,policy),6);
 assert.equal(raw[TWS],8);
 assert.equal(resolveTws(raw,{...times,[TWS]:6001},6001,policy),8);
});
test('server preserves native timestamp and rejects stale native history',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
  const engine=new WindEngine({debug(){}},()=>({}));const writes=[];
  engine.manageHistory=(type,value)=>writes.push({type,value});
  feedWindInput(engine,TWS,8,now-6000);
  assert.equal(writes.length,0);
  assert.equal(engine.getRawTimes()[TWS],null,'the normalizer rejects a report already stale at receipt');
  feedWindInput(engine,AWA,0,now);
  feedWindInput(engine,AWS,4,now);engine.sampleHistory();
  assert.ok(writes.some(p=>p.type==='tws'&&Math.abs(p.value-4*1.94384)<1e-10));
  now+=1000;feedWindInput(engine,TWS,0,now);engine.sampleHistory();
  assert.ok(writes.some(p=>p.type==='tws'&&p.value===0));
  assert.equal(engine.getRawTimes()[TWS],now);
 } finally {Date.now=original;}
});
