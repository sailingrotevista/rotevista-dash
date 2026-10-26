const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DashboardSession}=require('../session/dashboardSession');

test('a visible tablet requests immediate recovery on resume, focus and network reconnection',async()=>{
 const {subscribeDashboardRecovery}=await import('../src/utils/dashboardRecovery.mjs');
 const document=new EventTarget(),window=new EventTarget();document.visibilityState='hidden';let count=0;
 const unsubscribe=subscribeDashboardRecovery(document,window,()=>count++);
 window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));assert.equal(count,0);
 document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));assert.equal(count,1);
 window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));assert.equal(count,3);
 unsubscribe();window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));assert.equal(count,3);
});

test('a resumed client receives acknowledgements and snoozes made while it was asleep',()=>{
 const targets=[{id:'collision',risk:'RED',cpa:10,tcpa:1,dist:300},
 {id:'neighbour',risk:'ORANGE',alertKind:'PROXIMITY',areaProximityOnly:true,isMoving:false,proximityEntryObserved:true,lat:36,lon:14,dist:10,currentHullClearanceMeters:0}];
 const session=new DashboardSession({readLive:()=>({targets,raw:{'navigation.position':{latitude:36,longitude:14}}}),now:0});
 const sleeping=structuredClone(session.snapshot());
 const alerts=session.sharedAlerts;
 alerts.action({type:'snooze',targetId:'collision',expectedRisk:'RED',expectedAlertKind:'COLLISION',sessionId:alerts.sessionId},1000);
 alerts.action({type:'acknowledge',targetId:'neighbour',expectedRisk:'ORANGE',expectedAlertKind:'PROXIMITY',sessionId:alerts.sessionId},2000);
 session.tick(3000);const resumed=session.snapshot();
 assert.equal(sleeping.sharedAlerts.banner.id,'collision');assert.equal(resumed.sharedAlerts.banner,null);
 assert.ok(resumed.sharedAlerts.snoozes.collision);assert.ok(resumed.sharedAlerts.acknowledgements.neighbour);
});

test('a resumed client recovers mode changes without replaying its former scenario',()=>{
 const session=new DashboardSession({readLive:()=>({targets:[],raw:{}}),now:0});session.setMode('simulation',1000);
 const sleeping=structuredClone(session.snapshot());
 session.setMode('live',2000);const resumed=session.snapshot();
 assert.notEqual(resumed.generation,sleeping.generation);assert.equal(resumed.mode,'live');
 assert.equal(resumed.targets.some(t=>t.isSimulated),false);assert.equal(resumed.sharedAlerts.banner,null);
});

test('timestamp gap triggers history recovery even without focus events; normal polling does not',async()=>{
 const {historyNeedsRecovery:r}=await import('../src/utils/dashboardRecovery.mjs');
 const before={generation:'a',serverNow:10000};
 assert.equal(r(null,before),true);
 assert.equal(r(before,{generation:'a',serverNow:11000}),false);
 assert.equal(r(before,{generation:'a',serverNow:15000}),false);
 assert.equal(r(before,{generation:'a',serverNow:910000}),true);
 assert.equal(r(before,{generation:'b',serverNow:11000}),true);
});

test('resume restores complete history including empty channels and gap metadata',async()=>{
 const {recoverDashboardHistory:r}=await import('../src/utils/dashboardRecovery.mjs');
 const {restoreDashboardHistory}=await import('../src/utils/dashboardMeasurements.mjs');
 const frame={generation:'a',mode:'live'};
 const store={histories:{stw:[{val:9,time:1}],sog:[],vmg:[],tws:[],aws:[],depth:[],twd:[]},longBuf:{twd:[]},smoothBuf:{},graphTempBuf:{stw:[{val:99,time:2}]},gustFilter:{stw:{val:99}},lastUpdates:{stw:2}};
 const history={stw:[],depth:[{val:4,time:2000,gapBefore:true}],rollingAngles:{hdg:[]},twd:[]};
 assert.equal(await r(frame,async()=>history,()=>frame,h=>restoreDashboardHistory(store,h)),true);
 assert.deepEqual(store.histories.stw,[]);assert.equal(store.histories.depth[0].gapBefore,true);
 assert.deepEqual(store.graphTempBuf.stw,[]);assert.deepEqual(store.longBuf.hdg,[]);
});

test('history arriving after a mode change cannot overwrite a newer session, even after returning to Live',async()=>{
 const {recoverDashboardHistory:r}=await import('../src/utils/dashboardRecovery.mjs');
 let finish;const pending=new Promise(resolve=>finish=resolve);let applied=0;
 let current={generation:'a',mode:'live'};
 const work=r({...current},()=>pending,()=>current,()=>applied++);
 current={generation:'c',mode:'live'};finish({stw:[]});
 assert.equal(await work,false);assert.equal(applied,0);
 let loaded=false;
 assert.equal(await r({generation:'b',mode:'simulation'},async()=>{loaded=true;return {};},()=>current,()=>applied++),false);
 assert.equal(loaded,false);
});
