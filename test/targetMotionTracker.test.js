const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TargetMotionTracker}=require('../ais/targetMotionTracker');
const {AisEngine}=require('../ais/aisEngine');
const {HarborDetector}=require('../ais/harborDetector');
const {CollisionPipeline}=require('../ais/collisionPipeline');
const fix=(seconds,metres,sog=0)=>({t:seconds*1000,lat:36+metres/111139,lon:14,sog,cog:0});
const observe=(tracker,p,options={})=>tracker.update('boat',p,{now:p.t,historyMs:1800000,...options});

test('public tracker and experimental compatibility path expose the same implementation',()=>{
 assert.equal(TargetMotionTracker,require('../ais/experimental/targetMotionTracker').TargetMotionTracker);
});
test('received source timestamps are unique even when a tolerated future source time is clamped',()=>{
 const tracker=new TargetMotionTracker();
 observe(tracker,{...fix(0,0),sourceTime:30000});
 observe(tracker,{...fix(15,0),sourceTime:30000});
 assert.equal(tracker.targets.get('boat').observations.length,1);
 assert.equal(tracker.get('boat',15000,1800000).motionState,'STATIONARY');
});
test('mooring metadata cannot hold a coherent departure stationary or create new fixes',()=>{
 const tracker=new TargetMotionTracker({}, {harborDetector:{getAreaAtPosition(){return{id:'p',kind:'PORT',evaluatedAt:0};}}});
 observe(tracker,fix(0,0),{moored:true});
 observe(tracker,fix(30,30,.6),{moored:true});
 assert.equal(observe(tracker,fix(60,60,.6),{moored:true}).motionState,'MOVING');
 assert.equal(tracker.targets.get('boat').area.lat,36);
});
test('missing speed is conservatively moving while a valid low speed initializes stationary',()=>{
 for(const [sog,state]of [[null,'MOVING'],[NaN,'MOVING'],[0,'STATIONARY'],[.5,'STATIONARY'],[.6,'MOVING']]){
  assert.equal(observe(new TargetMotionTracker(),fix(0,0,sog)).motionState,state);
 }
});
test('a confirmed slow target remains eligible for nominal collision assessment',()=>{
 const result=new CollisionPipeline().evaluateTarget({lat:36,lon:14,sog:0,cog:0},{id:'slow',lat:36.0001,lon:14,sog:.6,cog:180,isMoving:true,lastUpdate:Date.now()});
 assert.equal(result.alertState,'RED');
});
test('histories retain source time span within bounded memory and prune removed targets',()=>{
 const tracker=new TargetMotionTracker();for(let i=0;i<500;i++)observe(tracker,fix(i,i%2));
 const state=tracker.targets.get('boat');
 assert.ok(state.observations.length<=120);assert.equal(state.recentFixes.length,3);assert.equal(state.trail.length,60);
 assert.equal(state.trail[0].t,0);assert.equal(state.trail.at(-1).t,499000);
 tracker.prune(new Set());assert.equal(tracker.targets.size,0);
});

function fixture(){
 const start=Date.now();let current=fix(0,0);let speed=0;
 const app={getPath:()=>({boat:{navigation:{position:{value:{latitude:current.lat,longitude:current.lon},timestamp:new Date(start+current.t).toISOString()},
  ...(speed===undefined?{}:{speedOverGround:{value:speed,timestamp:new Date(start+current.t).toISOString()}}),courseOverGroundTrue:{value:0},state:{value:'moored'}}}}),error(message){throw Error(message);}};
 const detector=new HarborDetector();
 const engine=new AisEngine(app,()=>({aisAlerter:{vectorMinutes:30}}),{getRaw:()=>({'navigation.position':{latitude:36,longitude:14.001}})},detector,new CollisionPipeline());
 return{engine,detector,start,set(seconds,metres,sog){current=fix(seconds,metres);speed=sog===undefined?undefined:sog===null?null:sog/1.94384;},get current(){return current;}};
}
test('engine preserves absent and explicit null SOG through tracker, cache and JSON instead of inventing zero',()=>{
 const original=Date.now;
 try{
  for(const speed of [undefined,null]){
   const f=fixture();Date.now=()=>f.start;f.set(0,0,speed);f.engine.process();
   const target=f.engine.getNearbyVessels()[0];
   assert.equal(target.sog,null);assert.equal(target.motionState,'MOVING');assert.equal(target.isProjected,false);
   assert.equal(f.engine.motionTracker.targets.get('boat').lastFix.sog,null);
   assert.equal(f.engine.aisPersistentCache.boat.sog,null);
   assert.equal(JSON.parse(JSON.stringify(target)).sog,null);
  }
 }finally{Date.now=original;}
});
test('engine connects the real harbor detector, tolerates an isolated speed spike and projects only a confirmed departure',()=>{
 const original=Date.now;const f=fixture();let clock=f.start;
 Date.now=()=>clock;
 const run=(seconds,metres,sog=0)=>{clock=f.start+seconds*1000;f.set(seconds,metres,sog);f.engine.process();return f.engine.getNearbyVessels()[0];};
 try{
  const seed=(id,north)=>({id,lat:36+north/111139,lon:14,dist:north,length:12,sog:0,motionState:'STATIONARY',reportedNavigationState:'',restPattern:{confirmed:true,kind:'FIXED',center:{lat:36+north/111139,lon:14},radiusMeters:1}});
  f.detector.processHarbors([seed('a',0),seed('b',70)],{lat:36,lon:14.001},{},0,clock);
  assert.equal(f.engine.motionTracker.harborDetector,f.detector);
  assert.equal(run(0,0).isMoored,true);
  const jitter=run(30,5,1.2);assert.equal(jitter.isMoving,false);assert.equal(jitter.isProjected,false);
  const departure=run(60,60,.6);
  assert.equal(departure.isMoving,true);assert.equal(departure.isMoored,false);assert.ok(departure.trail.length>0);
  clock+=15000;f.engine.process();const projected=f.engine.getNearbyVessels()[0];
  assert.equal(projected.isProjected,true);assert.equal(projected.lastPositionTime,departure.lastPositionTime);
 }finally{Date.now=original;}
});

test('an invalid first position is rejected without aborting the other AIS targets',()=>{
 const original=Date.now;const f=fixture();Date.now=()=>f.start;
 try{
  const tree=f.engine.app.getPath();tree.invalid={navigation:{position:{value:{latitude:99,longitude:14},timestamp:new Date(f.start).toISOString()}}};
  f.engine.app.getPath=()=>tree;f.engine.process();
  assert.deepEqual(f.engine.getNearbyVessels().map(t=>t.id),['boat']);
 }finally{Date.now=original;}
});

test('valid reported zero is preserved rather than confused with missing SOG',()=>{
 const original=Date.now;const f=fixture();Date.now=()=>f.start;
 try{
  f.set(0,0,0);f.engine.process();
  const target=f.engine.getNearbyVessels()[0];
  assert.equal(target.sog,0);assert.equal(target.motionState,'STATIONARY');
 }finally{Date.now=original;}
});

test('own startup without usable SOG is stationary without changing AIS startup or fabricating speed',()=>{
 for(const sog of [undefined,null,NaN,Infinity,-1,'0',0,.5,.6,5]) {
  const tracker=new TargetMotionTracker();const p=fix(0,0,sog);p.sog=sog;
  const own=tracker.update('self',p,{now:0,historyMs:900000});
  const validSpeed=Number.isFinite(sog)&&sog>=0;
  assert.equal(own.motionState,validSpeed&&sog>.5?'MOVING':'STATIONARY');
  assert.equal(tracker.targets.get('self').lastFix.sog,sog);
  const target=tracker.update('other',p,{now:0,historyMs:900000});
  assert.equal(target.motionState,validSpeed&&sog<=.5?'STATIONARY':'MOVING');
 }
});
test('own initial rest still requires three distinct fixes and area displacement for departure',()=>{
 for(const [kind,threshold] of [['PORT',50],['ANCHORAGE',150],[null,300]]) {
  const tracker=new TargetMotionTracker({}, {harborDetector:{getAreaAtPosition(){return kind?{id:'area',kind}:null;}}});
  const observeOwn=p=>tracker.update('self',p,{now:p.t,historyMs:900000});
  assert.equal(observeOwn({...fix(0,0),sog:null}).motionState,'STATIONARY');
  assert.equal(observeOwn(fix(1,threshold/2,3)).motionState,'STATIONARY');
  // Polling/projection does not supply the missing third real observation.
  observeOwn(fix(1,threshold,3));
  assert.equal(tracker.get('self',1000,900000).motionState,'STATIONARY');
  assert.equal(observeOwn(fix(2,threshold+1,3)).motionState,'MOVING');
 }
});
