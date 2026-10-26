const {test}=require('node:test');const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
test('server marks a resumed sensor and never averages pre-outage samples into its new bucket',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try{
 const e=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:10}}));
 for(const type of ['stw','sog','depth','tws','aws']) e.manageHistory(type,10);
 now+=1000;for(const type of ['stw','sog','depth','tws','aws'])e.manageHistory(type,20);
 now+=20000;
 for(const type of ['stw','sog','depth','tws','aws']){
 e.manageHistory(type,5);
 const points=e.getHistories()[type];assert.equal(points.length,2);
 assert.equal(points[1].val,5);assert.equal(points[1].gapBefore,true);
 assert.equal(points[1].time-points[0].time,21000);
 }
 }finally{Date.now=original;}
});
test('gap survives server JSON history and client restoration',async()=>{
 const {restoreDashboardHistory}=await import('../src/utils/dashboardMeasurements.mjs');
 const keys=['stw','sog','depth','tws','aws','vmg','twd'];
 const store={histories:Object.fromEntries(keys.map(k=>[k,[]])),longBuf:{},smoothBuf:{}};
 const history=JSON.parse(JSON.stringify({depth:[{val:4,time:1000},{val:5,time:21000,gapBefore:true}]}));
 const restored=restoreDashboardHistory(store,history);
 assert.equal(restored.depth[1].gapBefore,true);
});
