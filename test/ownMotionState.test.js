const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OwnMotionState } = require('../ais/ownMotionState');
const { TargetMotionTracker } = require('../ais/targetMotionTracker');
const { AisEngine } = require('../ais/aisEngine');
const { CollisionPipeline } = require('../ais/collisionPipeline');
const { DashboardSession } = require('../session/dashboardSession');
const start = 1000000;
const port = { id:'port',kind:'PORT',hull:[[35.99,13.99],[35.99,14.01],[36.01,14.01],[36.01,13.99]] };
function measurement(seconds, north = 0, speed = 0) {
 const time=start+seconds*1000;
 const raw={'navigation.position':{latitude:36+north/111139,longitude:14},'navigation.speedOverGround':speed/1.94384,'navigation.courseOverGroundTrue':0};
 return {raw,times:Object.fromEntries(Object.keys(raw).map(path=>[path,time])),now:time};
}
function observe(tracker,seconds,north=0,speed=0,areas=[]) {
 const m=measurement(seconds,north,speed);
 return tracker.update(m.raw,m.times,areas,m.now);
}
test('own rest needs real distinct fixes over time; area membership alone cannot relax limits',()=>{
 const tracker=new OwnMotionState(new TargetMotionTracker());
 assert.equal(observe(tracker,0,0,0,[port]).status,'STOPPED');
 const m=measurement(0);
 for(let second=1;second<200;second++) {
  const state=tracker.update(m.raw,m.times,[port],start+second*1000);
  assert.equal(state.relaxedCollision,false);
 }
 assert.equal(tracker.tracker.targets.get('self').observations.length,1);
 for(const second of [30,60,90]) assert.equal(observe(tracker,second,1,0,[port]).confirmedRest,false);
 const rest=observe(tracker,120,0,0,[port]);
 assert.equal(rest.confirmedRest,true); assert.equal(rest.status,'IN PORT'); assert.equal(rest.relaxedCollision,true);
 assert.equal(rest.restPattern.sampleCount,5);
 const outside=tracker.update(measurement(120).raw,measurement(120).times,[],start+120000);
 assert.equal(outside.status,'AT ANCHOR');
 assert.equal(tracker.update(measurement(120).raw,measurement(120).times,[{...port,kind:'PROVISIONAL'}],start+120000).status,'AT ANCHOR');
});
test('jitter and isolated SOG spikes retain rest; slow confirmed departure restores normal policy',()=>{
 const tracker=new OwnMotionState(new TargetMotionTracker());
 for(const second of [0,30,60,90,120]) observe(tracker,second,second===60?2:0,second===60?1.2:0);
 assert.equal(observe(tracker,150,1,1.2).relaxedCollision,true);
 const pending=observe(tracker,180,50,0.6);
 assert.equal(pending.motionState,'POSSIBLE_MOVEMENT');assert.equal(pending.relaxedCollision,true);
 const departed=observe(tracker,195,65,0.6);
 assert.equal(departed.motionState,'MOVING');assert.equal(departed.relaxedCollision,false);assert.equal(departed.status,'UNDERWAY');
});
test('stale, missing, invalid and replayed GPS cannot establish fresh rest; a long outage restarts observation',()=>{
 const tracker=new OwnMotionState(new TargetMotionTracker());
 for(const second of [0,30,60,90,120]) observe(tracker,second);
 const m=measurement(120);
 const stale=tracker.update(m.raw,m.times,[],m.now+5000);
 assert.equal(stale.valid,false);assert.equal(stale.confirmedRest,false);assert.equal(stale.relaxedCollision,false);
 assert.equal(tracker.update(m.raw,{},[],m.now).relaxedCollision,false);
 assert.equal(tracker.update({...m.raw,'navigation.position':null},m.times,[],m.now).relaxedCollision,false);
 assert.equal(observe(tracker,600).confirmedRest,false);
 assert.equal(tracker.tracker.targets.get('self').observations.length,1);
});
test('moving through a recognized port does not activate relaxed policy',()=>{
 const tracker=new OwnMotionState(new TargetMotionTracker());
 assert.equal(observe(tracker,0,0,3,[port]).status,'UNDERWAY');
 assert.equal(observe(tracker,30,45,3,[port]).relaxedCollision,false);
});
test('engine quarters collision thresholds after observed rest, shares status, and never feeds self into harbor learning',()=>{
 const original=Date.now; let now=start; Date.now=()=>now;
 try {
 let m=measurement(0); const harborInputs=[];
 const engine=new AisEngine({getPath:()=>({boat:{navigation:{
  position:{value:{latitude:36.006,longitude:14.003},timestamp:new Date(now).toISOString()},
  speedOverGround:{value:3.7/1.94384},courseOverGroundTrue:{value:Math.PI},
 }}}),error(message){throw Error(message);}},()=>({aisAlerter:{baseTcpaMinutes:10}}),
 {getRaw:()=>m.raw,getRawTimes:()=>m.times},
 {processHarbors(targets){harborInputs.push(targets.map(t=>t.id));return [port];}},new CollisionPipeline());
 engine.process();
 const initial=engine.getNearbyVessels()[0].effectiveThresholds;
 assert.equal(initial.ownAtAnchor,false);
 const live=()=>({raw:m.raw,rawTimes:m.times,targets:engine.getNearbyVessels(),harborClusters:engine.getHarborClusters(),ownMotion:engine.getOwnMotion(now)});
 const session=new DashboardSession({readLive:live,liveAlerts:engine.sharedAlerts,now});
 for(const second of [30,60,90,120]) {
  m=measurement(second);now=m.now;
  // The shared 1Hz read observes fixes even before the next AIS calculation.
  session.tick(now);engine.process();
 }
 const rested=engine.getNearbyVessels()[0].effectiveThresholds;
 assert.equal(rested.ownAtAnchor,true);assert.equal(rested.redCpa,initial.redCpa*.25);assert.equal(rested.horizonTcpa,initial.horizonTcpa*.25);
 assert.equal(session.tick(now).ownMotion.status,'IN PORT');
 assert.ok(harborInputs.every(ids=>ids.length===1 && ids[0]==='boat'));
 assert.equal(engine.motionTracker.targets.has('self'),true);
 assert.equal(engine.ownMotionState.tracker,engine.motionTracker);
 assert.equal(session.ownMotionState,null,'shared session must not create another tracker');
 assert.equal(engine.motionTracker.get('self',now,900000).restPattern.sampleCount,5,'AIS pruning preserves own observations');
 assert.equal(engine.getNearbyVessels().some(t=>t.id==='self'),false);
 m=measurement(150,50,0.6);now=m.now;engine.process();
 m=measurement(165,65,0.6);now=m.now;engine.process();
 assert.equal(engine.getNearbyVessels()[0].effectiveThresholds.ownAtAnchor,false);
 assert.equal(session.tick(now).ownMotion.status,'UNDERWAY');
 } finally {Date.now=original;}
});
test('mixed simulated targets use the same observed own rest as Live, without mutating upstream state',()=>{
 const m=measurement(120);
 const ownMotion={status:'AT ANCHOR',valid:true,confirmedRest:true,relaxedCollision:true,motionState:'STATIONARY'};
 const live={raw:m.raw,rawTimes:m.times,targets:[],ownMotion};
 const session=new DashboardSession({readLive:()=>live,now:m.now,environment:'dev'});
 session.setMode('mixed',m.now);
 const frame=session.snapshot();
 assert.equal(frame.ownMotion,ownMotion);
 assert.ok(frame.targets.filter(t=>t.isSimulated).every(t=>t.effectiveThresholds.ownAtAnchor));
 session.setMode('simulation',m.now);
 assert.equal(session.snapshot().ownMotion.relaxedCollision,false);
 assert.equal(live.ownMotion,ownMotion);
});
