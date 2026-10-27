const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=()=>import('../src/utils/dashboardConfig.mjs');
const configuration=()=>({alarms:{enabled:true},graphs:{historyMinutes:5,reef1:15},averaging:{smoothWindow:2000},scales:{max:20},aisAlerter:{distance:250},extra:{a:1,b:2}});

test('identical repeated polling and reordered JSON retain configuration identity and do not signal timer dependencies',async()=>{
 const {mergeDashboardConfig}=await load();const previous=configuration();
 for(let i=0;i<20;i++){
  const incoming=JSON.parse(JSON.stringify(previous));incoming.extra={b:2,a:1};
  assert.equal(mergeDashboardConfig(previous,incoming),previous);
 }
 assert.equal(mergeDashboardConfig(previous,{graphs:{historyMinutes:5}}),previous);
 assert.equal(mergeDashboardConfig(previous,{}),previous);
});

test('real configuration changes apply while preserving partial-section defaults and input objects',async()=>{
 const {mergeDashboardConfig}=await load();const previous=configuration(),incoming={graphs:{historyMinutes:10}};
 const next=mergeDashboardConfig(previous,incoming);
 assert.notEqual(next,previous);assert.equal(next.graphs.historyMinutes,10);assert.equal(next.graphs.reef1,15);
 assert.equal(previous.graphs.historyMinutes,5);assert.deepEqual(incoming,{graphs:{historyMinutes:10}});
 assert.equal(mergeDashboardConfig(next,{extra:{a:1,b:3}}).extra.b,3);
 assert.equal(mergeDashboardConfig(previous,null),previous);
});
