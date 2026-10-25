const {test}=require('node:test');
const assert=require('node:assert/strict');
const {BubbleEntryTracker}=require('../bubbleEntryTracker');
const own={lat:36,lon:14};
const boat=(distance,sequence=distance)=>({id:'a',lat:36+sequence/111139,lon:14,currentHullClearanceMeters:distance});
test('initial inside presence never alerts through polling or harbor learning',()=>{
 const tracker=new BubbleEntryTracker();
 assert.equal(tracker.update(boat(20),own),false);
 assert.equal(tracker.update({...boat(20),inCluster:true,alertKind:'PROXIMITY'},own),false);
 assert.equal(tracker.update(boat(15),own),false);
});
test('observed outside to inside entry alerts even when first outside observation predates harbor detection',()=>{
 const tracker=new BubbleEntryTracker();
 assert.equal(tracker.update(boat(80),own),false);
 assert.equal(tracker.update(boat(40),own),true);
 assert.equal(tracker.update(boat(35),own),true);
});
test('boundary jitter does not arm an initial insider; genuine exit and reentry does',()=>{
 const tracker=new BubbleEntryTracker();
 for(const d of [40,46,50,44,54,42]) assert.equal(tracker.update(boat(d),own),false);
 assert.equal(tracker.update(boat(60),own),false);
 assert.equal(tracker.update(boat(40),own),true);
});
test('metadata-only hull changes and projected positions do not establish entry',()=>{
 const tracker=new BubbleEntryTracker();
 tracker.update(boat(80,1),own);
 assert.equal(tracker.update(boat(20,1),own),false);
 assert.equal(tracker.update({...boat(20,2),isProjected:true},own),false);
 assert.equal(tracker.update(boat(20,3),own),true);
});
test('own movement can establish entry and restart starts afresh',()=>{
 const tracker=new BubbleEntryTracker();
 tracker.update(boat(80,1),own);
 assert.equal(tracker.update(boat(30,1),{...own,lat:36.0002}),true);
 assert.equal(new BubbleEntryTracker().update(boat(30,1),own),false);
 tracker.prune(new Set());
 assert.equal(tracker.targets.size,0);
});
