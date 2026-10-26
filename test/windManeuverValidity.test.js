const {test}=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../shared/windDataPolicy.json');
test('maneuver predictions require movement and fresh wind/heading; COG expires independently',async()=>{
 const {maneuverValidity:v}=await import('../src/utils/windValidity.mjs');
 const H='navigation.headingTrue',C='navigation.courseOverGroundTrue',S='navigation.speedOverGround',A='environment.wind.angleTrueWater',D='environment.wind.directionTrue';
 const now=20000, raw={[H]:1,[C]:1.1,[S]:2,[A]:0.5,[D]:1.5};
 const times=Object.fromEntries(Object.keys(raw).map(k=>[k,now]));
 assert.deepEqual(v(raw,times,now,policy,1.5),{heading:true,cog:true});
 assert.deepEqual(v({...raw,[S]:0},times,now,policy,1.5),{heading:false,cog:false});
 assert.deepEqual(v(raw,{...times,[S]:5000},now,policy,1.5),{heading:false,cog:false});
 assert.deepEqual(v(raw,{...times,[A]:5000},now,policy,1.5),{heading:false,cog:false});
 assert.deepEqual(v(raw,{...times,[C]:5000},now,policy,1.5),{heading:true,cog:false});
 const noCompass={...raw};delete noCompass[H];
 assert.deepEqual(v(noCompass,times,now,policy,1.5),{heading:true,cog:true});
 delete noCompass[C];assert.deepEqual(v(noCompass,times,now,policy,1.5),{heading:false,cog:false});
});
