const {test}=require('node:test');const assert=require('node:assert/strict');
const point=(degrees,time=10000)=>({val:degrees*Math.PI/180,time,sin:Math.sin(degrees*Math.PI/180),cos:Math.cos(degrees*Math.PI/180)});
test('missing samples do not pull heading average towards zero or change sample count',async()=>{
 const {getCircularAverageFromBuffer:avg}=await import('../src/utils/circularAverage.mjs');
 const samples=[point(160,9000),point(162,10000)];
 const missing={val:null,time:11000,sin:0,cos:1};
 const clean=avg(samples,30000,false,11000);
 const mixed=avg([samples[0],undefined,{val:NaN,time:10000},samples[1],missing,{val:'0',time:11000}],30000,false,11000);
 assert.ok(Math.abs(clean.val-161*Math.PI/180)<1e-10);
 assert.deepEqual(mixed,clean);assert.equal(mixed.samples,2);
 assert.equal(avg([missing],30000,false,11000),null);
});
test('real zero stays valid; 359/1 degrees average around north, invalid cached vectors do not count as zero',async()=>{
 const {getCircularAverageFromBuffer:avg}=await import('../src/utils/circularAverage.mjs');
 assert.equal(avg([point(0)],30000,false,10000).val,0);
 const north=avg([point(359,9000),point(1)],30000,false,10000);
 assert.ok(Math.abs(Math.sin(north.val))<1e-10);
 const result=avg([{val:1,time:10000,sin:null,cos:null}],30000,false,10000);
 assert.ok(Math.abs(result.val-1)<1e-10);
});
test('missing/future values do not refresh the age of old real observations',async()=>{
 const {getCircularAverageFromBuffer:avg}=await import('../src/utils/circularAverage.mjs');
 assert.equal(avg([point(160,1000),{val:null,time:6000},point(0,20000)],30000,false,6000),null);
 assert.equal(avg([point(0,0)],30000,false,0).val,0);
});
test('history restore rejects null angles and server accumulation rejects missing scalar and angular values',async()=>{
 const {restoreDashboardHistory}=await import('../src/utils/dashboardMeasurements.mjs');
 const keys=['stw','sog','vmg','depth','tws','aws','twd'];
 const store={histories:Object.fromEntries(keys.map(k=>[k,[]])),smoothBuf:{},longBuf:{}};
 restoreDashboardHistory(store,{rollingAngles:{hdg:[null,{val:null,time:10000},{val:1,time:10000}]},twd:[null,{val:null,time:10000}]});
 assert.equal(store.longBuf.hdg.length,1);assert.equal(store.longBuf.twd.length,0);
 const {WindEngine}=require('../wind/windEngine');const e=new WindEngine({debug(){}},()=>({}));
 for(const value of [null,undefined,NaN,'0',false]) {e.manageHistory('stw',value);e.pushRollingAngle('hdg',value,10000);}
 assert.equal(e.getHistories().stw.length,0);assert.equal(e.getRollingAngles().hdg.length,0);
 e.manageHistory('stw',0);e.pushRollingAngle('hdg',0,10000);
 assert.equal(e.getHistories().stw[0].val,0);assert.equal(e.getRollingAngles().hdg[0].val,0);
});
