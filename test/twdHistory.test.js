const {test}=require('node:test');const assert=require('node:assert/strict');
const {resolveTws,aggregateTwd}=require('../wind/twdHistory');const policy=require('../shared/windDataPolicy.json');
const {WindEngine}=require('../wind/windEngine');
const N='environment.wind.speedTrue',AWS='environment.wind.speedApparent',AWA='environment.wind.angleApparent';
test('TWD weight uses reconstructed strong wind and ignores expired native speed',()=>{
 const now=1000000,raw={[AWS]:25/1.94384,[AWA]:Math.PI/2,[N]:1};
 const times={[AWS]:now,[AWA]:now,[N]:now-5000};
 assert.ok(Math.abs(resolveTws(raw,times,now,policy)-25/1.94384)<1e-12);
 assert.equal(resolveTws(raw,{...times,[N]:now},now,policy),1);
 delete raw[N];assert.ok(resolveTws(raw,times,now,policy)>12);
 assert.equal(resolveTws(raw,{...times,[AWA]:now-5000},now,policy),null);
 raw[N]=0;times[N]=now;assert.equal(resolveTws(raw,times,now,policy),0);
});
test('weighted circular history and extrema reject known weak-wind deviations',()=>{
 const points=[{val:0,tws:10},{val:Math.PI/2,tws:20}];
 const result=aggregateTwd(points,policy);
 assert.ok(Math.abs(result.val-Math.atan2(20,10))<1e-12);
 assert.equal(result.min,0);assert.equal(result.max,Math.PI/2);
 const filtered=aggregateTwd([...points,{val:Math.PI,tws:1}],policy);
 assert.deepEqual(filtered,result);
});
test('unknown intensity produces equal weights, preserves directions and differs from a real zero',()=>{
 const result=aggregateTwd([{val:0,tws:null},{val:Math.PI/2,tws:20}],policy);
 assert.ok(Math.abs(result.val-Math.PI/4)<1e-12);
 const knownZero=aggregateTwd([{val:0,tws:0},{val:Math.PI/2,tws:20}],policy);
 assert.ok(Math.abs(knownZero.val-Math.PI/2)<1e-12);
 assert.equal(aggregateTwd([{val:null,tws:20}],policy),null);
 const north=aggregateTwd([{val:359*Math.PI/180,tws:10},{val:Math.PI/180,tws:10}],policy);
 assert.ok(Math.abs(Math.sin(north.val))<1e-12);
});
test('server stores the TWS at each fix and browser uses the same resolver and aggregator',async()=>{
 const browser=await import('../src/utils/twdHistory.mjs');
 const {resolveTws:displayTws}=await import('../src/utils/windValidity.mjs');
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try{
 const e=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:1}}));
 const setSpeed=value=>{e.raw[AWS]=value;e.raw[AWA]=Math.PI/2;e.lastAwsReceivedTime=now;e.lastAwaReceivedTime=now;};
 setSpeed(10);e.manageHistory('twd',0);
 now+=1000;setSpeed(10);e.manageHistory('twd',0);
 assert.equal(e.graphTempBuf.twd[0].tws,10);
 assert.equal(displayTws(e.raw,e.getRawTimes(),now,policy),10);
 now+=1000;setSpeed(20);e.manageHistory('twd',Math.PI/2);
 const expected=browser.aggregateTwd([{val:0,tws:10},{val:Math.PI/2,tws:20}],policy);
 const actual=e.getHistories().twd.at(-1);
 assert.equal(actual.val,expected.val);assert.equal(actual.min,expected.min);assert.equal(actual.max,expected.max);
 now+=1000;e.raw[N]=50;e.lastNativeTwsTime=now-5000;setSpeed(25);
 e.manageHistory('twd',1);assert.equal(e.graphTempBuf.twd.at(-1).tws,25);
 now+=5000;e.manageHistory('twd',2);assert.equal(browser.resolveTws(e.raw,e.getRawTimes(),now,policy),null);
 assert.equal(e.getHistories().twd.at(-1).val,2);
 }finally{Date.now=original;}
});
