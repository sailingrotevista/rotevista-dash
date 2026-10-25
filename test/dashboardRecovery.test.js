const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DashboardSession}=require('../dashboardSession');

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
