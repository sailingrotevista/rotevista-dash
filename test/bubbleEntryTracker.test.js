const {test}=require('node:test');
const assert=require('node:assert/strict');
const {BubbleEntryTracker}=require('../ais/bubbleEntryTracker');
const {applyHarborProximityPolicy}=require('../ais/collisionPipeline');
const own={lat:36,lon:14,sog:0};
const boat=(distance,seconds,motionState='STATIONARY',options={})=>({id:'a',lat:36+distance/111139,lon:14,
 currentHullClearanceMeters:distance,lastPositionTime:seconds*1000,motionState,isMoving:motionState==='MOVING',
 stationarySince:0,alertPolicy:{mode:'BUBBLE_ONLY'},...options});
const update=(tracker,target,position=own)=>tracker.update(target,position,45,target.lastPositionTime);
function entry(tracker) {
 update(tracker,boat(80,0,'MOVING'));
 assert.equal(update(tracker,boat(40,20,'MOVING')),false);
 assert.equal(update(tracker,boat(39,30)),true);
}

test('first inside presence stays normal through polling, port learning and later stationary fixes',()=>{
 const tracker=new BubbleEntryTracker();
 for(const [i,d] of [20,22,19,21].entries()) {
  const t=boat(d,i*180);t.inCluster=true;t.proximityEntryObserved=update(tracker,t);
  applyHarborProximityPolicy(t);
  assert.equal(t.risk,'GREY');assert.equal(t.alertKind,undefined);assert.equal(t.withinSafeBubble,true);
 }
});
test('PURA VIDA-like jitter across 45m and even beyond 55m cannot invent an entry while stationary',()=>{
 const tracker=new BubbleEntryTracker();
 for(const [i,d] of [44.97,48.95,43.96,45.4,44.3,60,62,43,42].entries())
  assert.equal(update(tracker,boat(d,i*180)),false);
});
test('an outside stationary target also cannot enter merely through jitter or possible movement',()=>{
 const tracker=new BubbleEntryTracker();
 for(const [i,d] of [65,63,42,40,60,61,41,42].entries())
  assert.equal(update(tracker,boat(d,i*180,i<2?'STATIONARY':'POSSIBLE_MOVEMENT')),false);
});
test('a real outside-to-inside arrival is confirmed with two fresh fixes at least ten seconds apart',()=>{
 const tracker=new BubbleEntryTracker();
 update(tracker,boat(80,0,'MOVING'));
 assert.equal(update(tracker,boat(40,20,'MOVING')),false);
 assert.equal(update(tracker,boat(39,25)),false);
 assert.equal(update(tracker,boat(39,30)),true);
});
test('an active warning persists across the 45m border and stationary jitter beyond both edges',()=>{
 const tracker=new BubbleEntryTracker();entry(tracker);
 for(const [i,d] of [46,52,60,62,43].entries()) {
  const t=boat(d,60+i*30);t.inCluster=true;t.proximityEntryObserved=update(tracker,t);
  applyHarborProximityPolicy(t);assert.equal(t.risk,'ORANGE');assert.equal(t.alertKind,'PROXIMITY');
 }
});
test('real departure requires two fresh outside fixes and can later be followed by a new arrival',()=>{
 const tracker=new BubbleEntryTracker();entry(tracker);
 assert.equal(update(tracker,boat(60,60,'MOVING')),true);
 assert.equal(update(tracker,boat(62,70,'MOVING')),false);
 assert.equal(update(tracker,boat(40,90,'MOVING')),false);
 assert.equal(update(tracker,boat(39,100)),true);
});
test('polling, projected positions and repeated timestamps cannot confirm crossings',()=>{
 const tracker=new BubbleEntryTracker();update(tracker,boat(80,0,'MOVING'));
 const t=boat(40,20,'MOVING');assert.equal(update(tracker,t),false);
 for(let i=0;i<5;i++)assert.equal(tracker.update(t,own,45,20000+i*100000),false);
 assert.equal(update(tracker,boat(39,40,'MOVING',{isProjected:true})),false);
 assert.equal(update(tracker,boat(39,50)),true);
});
test('metadata or heading changes at unchanged positions cannot start a crossing',()=>{
 const tracker=new BubbleEntryTracker();update(tracker,boat(80,0,'MOVING'));
 for(const seconds of [30,60,90]) assert.equal(update(tracker,boat(80,seconds,'MOVING',{currentHullClearanceMeters:30})),false);
});
test('own displacement can produce an entry while own stationary GPS jitter cannot',()=>{
 const tracker=new BubbleEntryTracker();update(tracker,boat(80,0));
 const shifted={...own,lat:36+20/111139,sog:3};
 assert.equal(update(tracker,boat(80,20,'STATIONARY',{currentHullClearanceMeters:40}),shifted),false);
 assert.equal(update(tracker,boat(80,30,'STATIONARY',{currentHullClearanceMeters:40}),shifted),true);
 const jitter=new BubbleEntryTracker();update(jitter,boat(40,0));
 for(const [i,d] of [60,62,42,40].entries())assert.equal(update(jitter,boat(d,(i+1)*180),{...own,lat:36+2/111139}),false);
});
test('restart and pruning do not inherit old entry state',()=>{
 const tracker=new BubbleEntryTracker();entry(tracker);
 assert.equal(update(new BubbleEntryTracker(),boat(39,200)),false);
 tracker.prune(new Set());assert.equal(tracker.targets.size,0);
});
