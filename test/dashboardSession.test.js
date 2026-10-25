const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DashboardSession,registerDashboardRoutes}=require('../dashboardSession');
const input=()=>({raw:{'navigation.position':{latitude:36,longitude:14},'navigation.speedOverGround':2,'navigation.courseOverGroundTrue':1,'navigation.headingTrue':1},
 targets:[{id:'real',name:'REAL',risk:'GREY',lat:36.01,lon:14,dist:1000}],harborClusters:[],config:{}});

test('all clients receive one generated scenario and joining does not reset motion or banner',()=>{
 const session=new DashboardSession({readLive:input,now:1000});session.setMode('simulation',2000);
 const first=structuredClone(session.snapshot());const generation=first.generation;
 session.tick(12000);
 const a=session.snapshot(),b=session.snapshot();
 assert.deepEqual(a,b);assert.equal(a.generation,generation);
 const target=a.targets.find(t=>t.isMoving);
 assert.ok(target.id.startsWith('sim:'));assert.equal(target.isSimulated,true);
 assert.notEqual(target.lat,first.targets.find(t=>t.id===target.id).lat);
 assert.deepEqual(a.sharedAlerts.banner,b.sharedAlerts.banner);
 assert.equal(a.mode,'simulation');
});

test('mixed mode preserves live targets and raw values without evaluating or mutating them',()=>{
 const live=input();Object.freeze(live.targets[0]);const original=JSON.stringify(live);
 const session=new DashboardSession({readLive:()=>live,now:1000});session.setMode('mixed',2000);session.tick(3000);
 const frame=session.snapshot();
 assert.equal(frame.targets.find(t=>t.id==='real'),live.targets[0]);
 assert.equal(JSON.stringify(live),original);assert.deepEqual(frame.raw,live.raw);
 assert.equal(frame.targets.filter(t=>t.isSimulated).length,4);
});

test('dev mode and alert controls never change another environment session',()=>{
 const live=input();const cerbo=new DashboardSession({readLive:()=>live,environment:'signalk',now:1000});
 const dev=new DashboardSession({readLive:()=>live,environment:'dev',now:1000});
 dev.setMode('simulation',2000);
 assert.equal(cerbo.snapshot().mode,'live');assert.equal(dev.snapshot().mode,'simulation');
 assert.notEqual(cerbo.sharedAlerts.controlToken,dev.sharedAlerts.controlToken);
 assert.notEqual(cerbo.sharedAlerts.sessionId,dev.sharedAlerts.sessionId);
 assert.equal(new DashboardSession({readLive:()=>live,now:3000}).snapshot().mode,'live');
 dev.setMode('live',4000);assert.deepEqual(dev.snapshot().targets,live.targets);
});

test('mixed mode waits for a real position rather than inventing one',()=>{
 const session=new DashboardSession({readLive:()=>({targets:[],raw:{}}),now:0});
 const frame=session.setMode('mixed',1000);
 assert.equal(frame.waitingForLivePosition,true);assert.equal(frame.targets.length,0);
});

test('mode changes use protected local routes and reads have no side effects',()=>{
 const session=new DashboardSession({readLive:input,now:1000});const routes=new Map();
 registerDashboardRoutes((method,path,handlers)=>routes.set(`${method} ${path}`,handlers),session);
 const handlers=routes.get('POST /rotevista-dashboard-mode');assert.equal(handlers.length,3);
 const response=()=>({code:200,value:null,status(code){this.code=code;return this;},json(value){this.value=value;return this;},header(){}});
 const bad=response();handlers[2]({body:{mode:'simulation',sessionId:'wrong'}},bad);assert.equal(bad.code,409);
 const ok=response();handlers[2]({body:{mode:'simulation',sessionId:session.sharedAlerts.sessionId}},ok);assert.equal(ok.code,200);
 assert.equal(ok.value.mode,'simulation');
 const revision=session.revision;const res=response();routes.get('GET /rotevista-dashboard')({},res);
 assert.equal(session.revision,revision);assert.equal(res.value.mode,'simulation');
});

test('mixed simulation pauses on stale real GPS and resumes with a fresh scenario',()=>{
 let live={...input(),rawTimes:{'navigation.position':1000}};
 const session=new DashboardSession({readLive:()=>live,now:1000});session.setMode('mixed',1000);
 assert.equal(session.snapshot().targets.filter(t=>t.isSimulated).length,4);
 const old=session.snapshot().targets.find(t=>t.isSimulated).lat;
 session.tick(32000);
 assert.equal(session.snapshot().targets.filter(t=>t.isSimulated).length,0);
 assert.equal(session.snapshot().waitingForLivePosition,true);
 live={...input(),raw:{...input().raw,'navigation.position':{latitude:37,longitude:15}},rawTimes:{'navigation.position':33000}};
 session.tick(33000);
 assert.equal(session.snapshot().targets.filter(t=>t.isSimulated).length,4);
 assert.ok(Math.abs(session.snapshot().targets.find(t=>t.isSimulated).lat-old)>.5);
});

test('server restart discards simulation and snoozes; both reconnecting clients receive fresh Live state',()=>{
 const readLive=()=>({raw:input().raw,harborClusters:[],targets:[{id:'danger',risk:'RED',cpa:10,tcpa:1,dist:300}]});
 const before=new DashboardSession({readLive,now:1000});
 const oldLive=before.sharedAlerts;
 oldLive.action({type:'snooze',targetId:'danger',expectedRisk:'RED',expectedAlertKind:'COLLISION',sessionId:oldLive.sessionId},2000);
 before.setMode('simulation',3000);
 const oldGeneration=before.snapshot().generation;
 const oldSession=before.sharedAlerts.sessionId;
 const oldToken=before.sharedAlerts.controlToken;
 const restarted=new DashboardSession({readLive,now:10000});
 const firstClient=structuredClone(restarted.snapshot());
 const secondClient=structuredClone(restarted.snapshot());
 assert.equal(firstClient.mode,'live');
 assert.deepEqual(firstClient.targets,secondClient.targets);
 assert.deepEqual(firstClient.sharedAlerts.banner,secondClient.sharedAlerts.banner);
 assert.equal(firstClient.sharedAlerts.banner.id,'danger');
 assert.deepEqual(firstClient.sharedAlerts.snoozes,{});
 assert.deepEqual(firstClient.sharedAlerts.acknowledgements,{});
 assert.notEqual(firstClient.generation,oldGeneration);
 assert.notEqual(firstClient.sharedAlerts.sessionId,oldSession);
 assert.notEqual(restarted.sharedAlerts.controlToken,oldToken);
 assert.equal(firstClient.targets.some(t=>t.isSimulated),false);
 assert.throws(()=>restarted.sharedAlerts.action({type:'reopen',sessionId:oldSession},10001),e=>e.status===409);
});

test('restart clears acknowledgements but initial inside-bubble contacts remain visual without a banner',()=>{
 const target={id:'neighbour',lat:36,lon:14,dist:10,currentHullClearanceMeters:0,
  risk:'ORANGE',alertKind:'PROXIMITY',areaProximityOnly:true,isMoving:false,proximityEntryObserved:false};
 const readLive=()=>({raw:input().raw,targets:[target],harborClusters:[]});
 const before=new DashboardSession({readLive,now:0});
 before.sharedAlerts.action({type:'acknowledge',targetId:target.id,expectedRisk:'ORANGE',expectedAlertKind:'PROXIMITY',sessionId:before.sharedAlerts.sessionId},100);
 assert.ok(before.sharedAlerts.snapshot().acknowledgements.neighbour);
 const after=new DashboardSession({readLive,now:1000});
 assert.deepEqual(after.snapshot().sharedAlerts.acknowledgements,{});
 assert.equal(after.snapshot().sharedAlerts.banner,null);
 assert.equal(after.snapshot().targets[0].risk,'ORANGE');
});
