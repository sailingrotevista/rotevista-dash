const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DashboardSession}=require('../session/dashboardSession');
const keys=['stw','sog','vmg','depth','tws','aws','twd'];
const buffers=()=>Object.fromEntries(keys.map(k=>[k,[{val:99,time:1000}]]));
function store() {return {raw:{'navigation.speedOverGround':99},timestamps:{old:1000},histories:buffers(),smoothBuf:buffers(),longBuf:buffers(),graphTempBuf:buffers(),lastUpdates:{stw:1000},curAwaRot:123,smoothedLeeway:12,lastGybeSide:'port',firstEmaRun:false};}

test('mode change clears simulated history, smoothing and manoeuvre state immediately',async()=>{
 const {resetDashboardMeasurements}=await import('../src/utils/dashboardMeasurements.mjs');
 const state=store();const visible=resetDashboardMeasurements(state);
 assert.deepEqual(state.raw,{});assert.deepEqual(state.timestamps,{});
 for(const group of [state.histories,state.smoothBuf,state.longBuf,state.graphTempBuf,visible])
  assert.ok(Object.values(group).every(points=>points.length===0));
 assert.equal(state.curAwaRot,0);assert.equal(state.smoothedLeeway,0);assert.equal(state.lastGybeSide,null);
 assert.equal(state.firstEmaRun,true);assert.equal(state.lastUpdates.stw,0);
});

test('Live restores only real history and rolling measurements after clearing simulation',async()=>{
 const {resetDashboardMeasurements,restoreDashboardHistory}=await import('../src/utils/dashboardMeasurements.mjs');
 const state=store();resetDashboardMeasurements(state);
 const history={stw:[{val:3,time:2000}],rollingAngles:{hdg:[{val:1,time:2000}]}};
 const visible=restoreDashboardHistory(state,history);
 assert.deepEqual(visible.stw,[{val:3,time:2000}]);assert.equal(visible.tws.length,0);
 assert.equal(state.smoothBuf.hdg[0].val,1);assert.equal(state.smoothBuf.hdg[0].sin,Math.sin(1));
 assert.equal(state.histories.stw.some(p=>p.val===99),false);
});

test('returning from Simulation or Mixed restores real targets, instruments, areas and live banner',()=>{
 const target={id:'live-danger',risk:'RED',cpa:10,tcpa:1,dist:100};
 const raw={'navigation.position':{latitude:36,longitude:14},'navigation.speedOverGround':2,'environment.wind.speedTrue':8};
 const live={raw,targets:[target],harborClusters:[{id:'real-port'}]};
 for(const mode of ['simulation','mixed']) {
  const session=new DashboardSession({readLive:()=>live,now:0});session.setMode(mode,1000);
  assert.ok(session.snapshot().targets.some(t=>t.isSimulated));
  const frame=session.setMode('live',2000);
  assert.deepEqual(frame.targets,[target]);assert.deepEqual(frame.raw,raw);assert.deepEqual(frame.harborClusters,live.harborClusters);
  assert.equal(frame.sharedAlerts.banner.id,'live-danger');
  assert.equal(frame.targets.some(t=>t.id.startsWith('sim:')),false);
 }
});
