const test = require('node:test');
const assert = require('node:assert/strict');
const config = {enabled:true,movingSpeedKnots:2,moving:{fadeStartSeconds:90,fadeEndSeconds:180},slowOrMoored:{fadeStartSeconds:240,fadeEndSeconds:360},minimumOpacity:0.4,preserveAlerts:true};
test('selected target fades on map and popup even with an alert', async () => {
 const {getAisAgeVisual: visual}=await import('../src/utils/aisAgeVisual.mjs');
 const target={sog:5,age:180,risk:'RED'};
 assert.equal(visual(target,config,false).opacity,1);
 assert.equal(visual(target,config,true).opacity,0.4);
 assert.equal(visual({...target,risk:'NO_DANGER'},config,true).opacity,0.4);
 assert.equal(visual({...target,age:135},config,true).opacity,0.7);
 assert.equal(visual({...target,age:0},config,true).opacity,1);
 assert.equal(visual(target,config,true,false).opacity,0.4);
 assert.equal(visual({...target,age:135},config,true,false).opacity,0.7);
 assert.equal(visual({...target,age:0},config,true,false).opacity,1);
});
test('slow/moored popup uses longer aging window and same opacity floor', async () => {
 const {getAisAgeVisual: visual}=await import('../src/utils/aisAgeVisual.mjs');
 for(const target of [{sog:0},{sog:5,isMoored:true}]) {
  assert.equal(visual({...target,age:240},config,false,false).opacity,1);
  assert.equal(visual({...target,age:300},config,false,false).opacity,0.7);
  assert.equal(visual({...target,age:1000},config,false,false).opacity,0.4);
 }
});

test('unknown speed does not silently select the slow-target aging window',async()=>{
 const {getAisAgeVisual:visual}=await import('../src/utils/aisAgeVisual.mjs');
 assert.equal(visual({sog:null,age:180,risk:'GREY'},config).opacity,.4);
 assert.equal(visual({sog:null,isMoored:true,age:180,risk:'GREY'},config).opacity,1);
});
