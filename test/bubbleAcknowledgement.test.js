const {test}=require('node:test');
const assert=require('node:assert/strict');
const boat=(id,clearance,dist=clearance+10)=>({id,alertKind:'PROXIMITY',areaProximityOnly:true,isMoving:false,risk:'ORANGE',currentHullClearanceMeters:clearance,dist,lat:36,lon:14});

test('one acknowledgement accepts all current bubble contacts but not later arrivals',async()=>{
 const {acknowledgeCurrentBubble,nearestBubblePresence}=await import('../src/utils/proximityAcknowledgement.mjs');
 const current=[boat('a',2),boat('b',15),{...boat('outside',70),alertKind:undefined}, {...boat('moving',1),isMoving:true}, {id:'collision',risk:'RED'}];
 const ack=acknowledgeCurrentBubble(current);
 assert.deepEqual(Object.keys(ack),['a','b']);
 assert.equal(nearestBubblePresence(current).id,'a');
 const later=[...current,boat('new-farther',35)];
 assert.equal(nearestBubblePresence(later.filter(t=>!ack[t.id])).id,'new-farther');
});

test('bubble banner chooses hull clearance, retaining zero and deterministic ties',async()=>{
 const {nearestBubblePresence}=await import('../src/utils/proximityAcknowledgement.mjs');
 assert.equal(nearestBubblePresence([boat('antenna-near',10,12),boat('hull-near',0,30)]).id,'hull-near');
 assert.equal(nearestBubblePresence([boat('b',0,10),boat('a',0,10)]).id,'a');
 assert.equal(nearestBubblePresence([]),null);
});

test('a new closer proximity replaces the representative immediately; collision escalation remains immediate',async()=>{
 const {BannerThreatSelector}=await import('../src/utils/aisPriority.mjs');
 const selector=new BannerThreatSelector();
 assert.equal(selector.select([boat('a',10)],0).id,'a');
 assert.equal(selector.select([boat('closer',1)],100).id,'closer');
 assert.equal(selector.select([boat('closer',1),{id:'collision',risk:'RED',cpa:1,tcpa:1}],200).id,'collision');
});
