const {test}=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../windDataPolicy.json');
const H='navigation.headingTrue',C='navigation.courseOverGroundTrue',S='navigation.speedOverGround';
test('leeway requires every recent input and never substitutes COG for heading',async()=>{
 const {resolveLeeway:r}=await import('../src/utils/windValidity.mjs');
 const raw={[H]:359*Math.PI/180,[C]:Math.PI/180,[S]:2};
 const times={[H]:1000,[C]:1000,[S]:1000};
 assert.ok(Math.abs(r(raw,times,15999,policy,1.5)-2)<1e-10);
 assert.equal(r(raw,times,16000,policy,1.5),null);
 for(const key of [H,C,S]){
 assert.equal(r(raw,{...times,[key]:0},15000,policy,1.5),null);
 const absent={...raw};delete absent[key];
 assert.equal(r(absent,times,1000,policy,1.5),null);
 }
 assert.equal(r({...raw,[S]:0},times,1000,policy,1.5),0);
 assert.equal(r({...raw,[H]:null},times,1000,policy,1.5),null);
});
