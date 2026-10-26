const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TargetMotionTracker,MOTION_TRACKER_CONFIG,MOTION_STATES}=require('../ais/experimental/targetMotionTracker');
const origin=1700000000000;
const point=(seconds,east=0,north=0,extra={})=>({lat:36+north/111139,lon:14+east/(111139*Math.cos(Math.PI/5)),
 t:origin+seconds*1000,sourceTime:origin+seconds*1000,...extra});
function observe(tracker,seconds,east=0,sog=0){return tracker.update('boat',point(seconds,east,0,{sog,cog:90}),{now:origin+seconds*1000,historyMs:900000});}
function inArea(kind){return new TargetMotionTracker({}, {harborDetector:{getAreaAtPosition(){return kind?{id:'area',kind,evaluatedAt:origin}:null;}}});}

test('initial SOG up to 0.5kn initializes STATIONARY; higher, missing and invalid SOG initialize MOVING',()=>{
 assert.deepEqual(Object.values(MOTION_STATES).sort(),['MOVING','STATIONARY']);
 for(const sog of [0,.01,.5,.5001,2,undefined,null,NaN,Infinity,-1,'0']){
  const tracker=new TargetMotionTracker();
  const result=tracker.update('boat',point(0,0,0,{sog}),{now:origin,historyMs:900000,moored:true,anchored:true});
  assert.equal(result.motionState,Number.isFinite(sog)&&sog>=0&&sog<=.5?'STATIONARY':'MOVING');
 }
});

test('MOVING stops with five real fixes spanning five minutes and a pairwise diameter no greater than 50m',()=>{
 assert.equal(MOTION_TRACKER_CONFIG.minimumSettleFixes,5);assert.equal(MOTION_TRACKER_CONFIG.settleSeconds,300);
 assert.equal(MOTION_TRACKER_CONFIG.settleDiameterMeters,50);
 const tracker=new TargetMotionTracker();observe(tracker,0,100,4);
 for(const [seconds,x]of [[1,-25],[76,25],[151,-25],[226,25]])assert.equal(observe(tracker,seconds,x).motionState,'MOVING');
 assert.equal(observe(tracker,226,25).motionState,'MOVING','replay cannot supply a fifth fix');
 const stopped=observe(tracker,301,0);
 assert.equal(stopped.motionState,'STATIONARY');assert.equal(stopped.restConfirmed,true);
 assert.equal(stopped.restPattern.confirmed,true);
});

test('five-minute span and five-fix count are independent arrest requirements',()=>{
 const few=new TargetMotionTracker();
 for(const seconds of [0,100,200,300])assert.equal(observe(few,seconds,0,1).motionState,'MOVING');
 assert.equal(observe(few,301,0,1).motionState,'STATIONARY');
 const brief=new TargetMotionTracker();
 for(const seconds of [0,1,2,3,4])assert.equal(observe(brief,seconds,0,1).motionState,'MOVING');
});

test('pairwise diameter rejects a compact-looking average with endpoints more than 50m apart',()=>{
 const tracker=new TargetMotionTracker();observe(tracker,0,100,4);
 let result;
 for(const [seconds,x]of [[1,0],[76,25.1],[151,-25.1],[226,0],[301,0]])result=observe(tracker,seconds,x);
 assert.equal(result.motionState,'MOVING');
});

test('one-hertz genuine reports can establish a five-minute stop despite geometric compression',()=>{
 const tracker=new TargetMotionTracker();let result;
 for(let seconds=0;seconds<=300;seconds++)result=observe(tracker,seconds,0,1);
 assert.equal(result.motionState,'STATIONARY');assert.ok(tracker.targets.get('boat').observations.length<=120);
});

test('slow AIS reports every three minutes confirm a stop on the fifth observed position',()=>{
 const tracker=new TargetMotionTracker();
 for(let i=0;i<5;i++)assert.equal(observe(tracker,i*180,0,1).motionState,i===4?'STATIONARY':'MOVING');
});

test('invalid, projected, duplicate and retrodated positions never add fixes or update the latest-three buffer',()=>{
 const tracker=inArea('PORT');observe(tracker,0,0);
 for(const extra of [{lat:NaN},{t:origin+2000},{sourceTime:origin+32000},{projected:true},{t:origin-1000,sourceTime:origin-1000}]){
  tracker.update('boat',{...point(0),...extra},{now:origin+1000,historyMs:900000});
 }
 observe(tracker,0,30);
 assert.equal(tracker.targets.get('boat').observations.length,1);assert.equal(tracker.targets.get('boat').recentFixes.length,1);
 observe(tracker,1,0);assert.equal(tracker.targets.get('boat').recentFixes.length,2);
});

test('departure uses exactly three distinct raw fixes and net distance, with no SOG or duration condition',()=>{
 for(const [kind,limit]of [['PORT',50],['ANCHORAGE',150],[null,300],['PROVISIONAL',300]]){
  const tracker=inArea(kind);observe(tracker,0,0);
  let result=observe(tracker,.001,limit,0);
  assert.equal(result.motionState,'STATIONARY');
  assert.equal('possibleMovement' in result,false);assert.equal('departure' in result,false);
  observe(tracker,.001,limit,20);
  assert.equal(tracker.targets.get('boat').recentFixes.length,2);
  result=observe(tracker,.002,limit,0);
  assert.equal(result.motionState,'MOVING');
  assert.equal(result.departureThresholdMeters,limit);
 }
});

test('a long slow displacement is never accumulated from an old candidate or compressed trail',()=>{
 const tracker=new TargetMotionTracker({maxObservationPoints:3},{harborDetector:{getAreaAtPosition(){return{id:'p',kind:'PORT',evaluatedAt:origin};}}});
 observe(tracker,0,0);
 for(let i=1;i<=30;i++)assert.equal(observe(tracker,i*60,i*20,0).motionState,'STATIONARY');
 const state=tracker.targets.get('boat');
 assert.equal(state.recentFixes.length,3);assert.equal(state.recentFixes[0].t,origin+28*60000);
 assert.ok(state.observations.length<=3);assert.equal(state.area.lon,14);
});

test('traversed path length cannot substitute net displacement between the first and third fixes',()=>{
 const tracker=inArea('PORT');observe(tracker,0,0);
 assert.equal(observe(tracker,60,40).motionState,'STATIONARY');
 assert.equal(observe(tracker,120,0).motionState,'STATIONARY','80m travelled but zero net displacement');
 assert.equal('possibleMovement' in tracker.get('boat',origin+120000,900000),false);
});

test('area context comes from the fixed rest reference even when the latest positions are outside its polygon',()=>{
 const tracker=new TargetMotionTracker({}, {harborDetector:{getAreaAtPosition(lat,lon){return Math.abs(lon-14)<20/(111139*Math.cos(Math.PI/5))?{id:'p',kind:'PORT',evaluatedAt:origin}:null;}}});
 observe(tracker,0,0);const pending=observe(tracker,30,40);
 assert.equal(pending.areaContext,null);assert.equal(pending.restAreaContext.kind,'PORT');
 assert.equal(observe(tracker,60,60).motionState,'MOVING');
});

test('unknown SOG at first observation must demonstrate a stop rather than becoming stationary from area or metadata',()=>{
 const tracker=inArea('PORT');
 const initial=tracker.update('boat',point(0),{now:origin,historyMs:900000,moored:true});
 assert.equal(initial.motionState,'MOVING');
 for(const seconds of [75,150,225])assert.equal(observe(tracker,seconds,0).motionState,'MOVING');
 assert.equal(observe(tracker,300,0).motionState,'STATIONARY');
});

test('oscillation and mooring remain descriptive and never add principal states',()=>{
 const tracker=inArea('ANCHORAGE');observe(tracker,0,0);
 let result;
 for(let seconds=30;seconds<=720;seconds+=30){
  const angle=Math.PI+2*Math.PI*seconds/300;
  result=tracker.update('boat',point(seconds,60+60*Math.cos(angle),60*Math.sin(angle),{sog:1.5,cog:90}),
   {now:origin+seconds*1000,historyMs:900000});
  assert.equal(result.motionState,'STATIONARY');
 }
 assert.equal(result.restPattern.kind,'OSCILLATING');
});

test('new wind-heading evidence with the same position does not create a motion sample',()=>{
 const tracker=new TargetMotionTracker();observe(tracker,0,0);
 const fix=point(0,0,0,{sog:0,hdg:90,headingTime:origin+1000});
 const options={now:origin+1000,historyMs:900000,wind:{direction:0,speedKnots:10,directionTime:origin+1000,speedTime:origin+1000,lat:36,lon:14}};
 tracker.update('boat',fix,options);tracker.update('boat',fix,options);
 const state=tracker.targets.get('boat');
 assert.equal(state.observations.length,1);assert.equal(state.recentFixes.length,1);assert.equal(state.windEvidence.length,1);
 assert.equal(state.restConfirmed,false);
});

test('wind evidence is bounded separately, expires and cannot manufacture absent motion values',()=>{
 const tracker=new TargetMotionTracker({maxObservationPoints:5,maxWindEvidencePoints:10,windEvidenceSeconds:60});
 for(let i=0;i<20;i++){
  const time=origin+i*1000;
  tracker.update('boat',point(i,0,0,{hdg:90,headingTime:time}),{now:time,historyMs:900000,
   wind:{direction:0,speedKnots:10,directionTime:time,speedTime:time,lat:36,lon:14}});
 }
 const state=tracker.targets.get('boat');
 assert.equal(state.observations.length,5);assert.equal(state.windEvidence.length,10);
 assert.equal(state.observations.at(-1).sog,null);assert.equal(state.observations.at(-1).cog,null);
 tracker.get('boat',origin+80000,900000);assert.equal(state.windEvidence.length,0);
});

test('a new stop clears prior departure samples and a fresh three-fix movement can restart',()=>{
 const tracker=inArea('PORT');observe(tracker,0,0,1);
 for(const seconds of [75,150,225,300])observe(tracker,seconds,0,1);
 assert.equal(tracker.targets.get('boat').recentFixes.length,1);
 assert.equal(observe(tracker,301,30,0).motionState,'STATIONARY');
 assert.equal(observe(tracker,302,60,0).motionState,'MOVING');
 assert.equal(tracker.targets.get('boat').restConfirmed,false);
});

function ownObserve(tracker,seconds,east,sog=0){
 return tracker.update('self',point(seconds,east,0,{sog,cog:90}),{now:origin+seconds*1000,historyMs:900000});
}

test('own ship at 2kn restarts within five minutes outside an area while AIS keeps its raw three-fix rule',()=>{
 const tracker=new TargetMotionTracker();
 ownObserve(tracker,0,0);observe(tracker,0,0);
 let firstOwnMoving=null;
 for(let seconds=1;seconds<=300;seconds++){
  const distance=2*1852/3600*seconds;
  const own=ownObserve(tracker,seconds,distance,2);
  if(own.motionState==='MOVING')firstOwnMoving??=seconds;
  assert.equal(observe(tracker,seconds,distance,2).motionState,'STATIONARY');
 }
 assert.equal(firstOwnMoving,292);
 assert.equal(tracker.targets.get('self').lastFix.t,origin+300000);
 assert.ok(tracker.targets.get('self').observations.length<=120);
});

test('own-ship selection uses three actual distinct timestamps spread over the current five-minute window',()=>{
 const tracker=new TargetMotionTracker();
 for(let seconds=0;seconds<=900;seconds++)ownObserve(tracker,seconds,0);
 const state=tracker.targets.get('self');
 const before=state.observations.length;
 const selected=tracker.selectDepartureFixes(state,{t:origin+900000});
 assert.equal(selected.length,3);
 assert.ok(selected[0].t>=origin+600000);assert.equal(selected[2].t,origin+900000);
 assert.ok(selected[0].t<selected[1].t&&selected[1].t<selected[2].t);
 assert.ok(Math.abs(selected[1].t-(selected[0].t+selected[2].t)/2)<15000);
 assert.ok(selected.every(sample=>state.observations.includes(sample)));
 assert.equal(state.observations.length,before);
});

test('own ship can restart before five minutes when the context distance and three real positions already suffice',()=>{
 for(const [kind,limit]of [['PORT',50],['ANCHORAGE',150],[null,300]]){
  const tracker=inArea(kind);ownObserve(tracker,0,0);
  assert.equal(ownObserve(tracker,1,limit/2,0).motionState,'STATIONARY');
  assert.equal(ownObserve(tracker,2,limit,0).motionState,'MOVING');
 }
});

test('own historical positions before a new confirmed stop do not count towards its next departure',()=>{
 const tracker=inArea('PORT');ownObserve(tracker,0,100,2);
 for(const seconds of [1,76,151,226,301])ownObserve(tracker,seconds,0,0);
 const state=tracker.targets.get('self');
 assert.equal(state.motionState,'STATIONARY');assert.equal(state.departureWindowSince,origin+301000);
 assert.equal(tracker.selectDepartureFixes(state,{t:origin+301000}).length,1);
 assert.equal(ownObserve(tracker,302,30,0).motionState,'STATIONARY');
 assert.equal(ownObserve(tracker,303,60,0).motionState,'MOVING');
});

test('old own-ship history cannot cause departure when its latest five minutes are stationary',()=>{
 const tracker=new TargetMotionTracker();ownObserve(tracker,0,0);
 // No invented intermediate fixes: the position is received again after a gap.
 ownObserve(tracker,600,400);
 assert.equal(ownObserve(tracker,660,400).motionState,'STATIONARY');
 assert.equal(ownObserve(tracker,720,400).motionState,'STATIONARY');
 const state=tracker.targets.get('self');
 const selected=tracker.selectDepartureFixes(state,{t:origin+720000});
 assert.ok(selected.every(sample=>sample.t>=origin+420000));
});
