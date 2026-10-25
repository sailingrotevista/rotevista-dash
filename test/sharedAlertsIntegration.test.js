const {test}=require('node:test');const assert=require('node:assert/strict');
const {AisEngine}=require('../aisEngine');
const {DashboardSession,registerDashboardRoutes}=require('../dashboardSession');
const own={lat:36,lon:14};
const target={id:'danger',risk:'RED',cpa:10,tcpa:1,dist:300};
const neighbour={id:'neighbour',risk:'ORANGE',alertKind:'PROXIMITY',areaProximityOnly:true,isMoving:false,proximityEntryObserved:true,lat:36,lon:14,dist:10,currentHullClearanceMeters:0};
function setup(now){
 const messages=[];
 const engine=new AisEngine({handleMessage(_id,message){messages.push(message);}},()=>({}),{}, {}, {});
 engine.lastNearbyVessels=[target,neighbour];engine.lastOwnGps={...own,t:now};
 const session=new DashboardSession({now,liveAlerts:engine.sharedAlerts,readLive:()=>({own,raw:{},targets:engine.getNearbyVessels()})});
 return {engine,session,messages};
}
test('live dashboard commands, legacy snapshots and published deltas share snoozes and acknowledgements',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try{
 const {engine,session,messages}=setup(now);
 assert.equal(engine.sharedAlerts,session.liveAlerts);assert.equal(session.sharedAlerts,engine.sharedAlerts);
 const routes=new Map();registerDashboardRoutes((method,path,handlers)=>routes.set(method+' '+path,handlers),session);
 const res={status(c){this.code=c;return this;},json(data){this.body=data;return this;}};
 const action=routes.get('POST /rotevista-alert-actions')[2];
 now+=3000;
 action({body:{type:'snooze',targetId:target.id,sessionId:session.sharedAlerts.sessionId,expectedRisk:'RED',expectedAlertKind:'COLLISION'}},res);
 assert.ok(res.body.snoozes.danger);
 assert.deepEqual(session.snapshot().sharedAlerts,engine.sharedAlerts.snapshot());
 now+=1000;
 action({body:{type:'acknowledge',targetId:neighbour.id,sessionId:session.sharedAlerts.sessionId,expectedRisk:'ORANGE',expectedAlertKind:'PROXIMITY'}},res);
 assert.equal(res.body.banner,null);assert.ok(engine.sharedAlerts.snapshot().acknowledgements.neighbour);
 const published=engine.publishSharedAlerts(now,false);
 assert.deepEqual(published,session.snapshot().sharedAlerts);
 assert.deepEqual(messages.at(-1).updates[0].values[0].value,published);
 // A legacy read/update must not resurrect the acknowledged contacts.
 assert.equal(engine.publishSharedAlerts(now+1000).banner,null);
 assert.ok(session.snapshot().sharedAlerts.snoozes.danger);
 }finally{Date.now=original;}
});
test('simulation alerts remain separate, Live survives round trips and dev does not share it',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try{
 const {engine,session}=setup(now);const live=session.sharedAlerts;
 live.action({type:'snooze',targetId:target.id,sessionId:live.sessionId,expectedRisk:'RED',expectedAlertKind:'COLLISION'},now+3000);
 session.setMode('simulation',now+4000);
 assert.notEqual(session.sharedAlerts,live);assert.equal(session.sharedAlerts.snapshot().snoozes.danger,undefined);
 assert.ok(engine.sharedAlerts.snapshot().snoozes.danger);
 const dev=new DashboardSession({readLive:()=>({raw:{},targets:[target],own}),environment:'dev',now});
 assert.notEqual(dev.liveAlerts,live);assert.equal(dev.snapshot().sharedAlerts.snoozes.danger,undefined);
 session.setMode('live',now+5000);assert.equal(session.sharedAlerts,live);
 assert.ok(session.snapshot().sharedAlerts.snoozes.danger);
 }finally{Date.now=original;}
});
