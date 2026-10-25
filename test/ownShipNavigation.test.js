const {test}=require('node:test');const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');const policy=require('../windDataPolicy.json');
const now=Date.UTC(2026,9,25,18);const P='navigation.position',H='navigation.headingTrue',M='navigation.headingMagnetic',C='navigation.courseOverGroundTrue',S='navigation.speedOverGround';
const position={latitude:36.78,longitude:14.55};
test('AIS uses the same magnetic/WMM heading as Wind; 0 degrees and 0 speed remain real values',async()=>{
 const {resolveOwnShipNavigation:r}=await import('../src/utils/ownShipNavigation.mjs');
 const {resolveHeading}=await import('../src/utils/windValidity.mjs');
 const raw={[P]:position,[M]:157*Math.PI/180,[H]:157*Math.PI/180,[C]:0,[S]:0};
 const times=Object.fromEntries(Object.keys(raw).map(k=>[k,now]));
 const result=r(raw,times,now,policy);
 assert.equal(result.course.hdg,Math.round(resolveHeading(raw,times,now,policy)*180/Math.PI)%360);
 assert.equal(result.course.hdg,161);assert.equal(result.course.cog,0);assert.equal(result.course.sog,0);
 assert.deepEqual(result.position,{lat:position.latitude,lon:position.longitude});
 delete raw[M];raw[H]=0;assert.equal(r(raw,times,now,policy).course.hdg,0);
 raw[H]=2*Math.PI-0.001;assert.equal(r(raw,times,now,policy).course.hdg,0);
});
test('AIS inputs expire independently; no missing value becomes zero and GPS needs a fresh real fix',async()=>{
 const {resolveOwnShipNavigation:r}=await import('../src/utils/ownShipNavigation.mjs');
 const raw={[P]:position,[H]:1,[C]:2,[S]:2};const times=Object.fromEntries(Object.keys(raw).map(k=>[k,now]));
 const expired=r(raw,times,now+5000,policy);
 assert.equal(expired.position,null);assert.deepEqual(expired.course,{hdg:null,cog:null,sog:null});
 assert.ok(r(raw,times,now+4999,policy).position);
 const noCompass={...raw};delete noCompass[H];assert.equal(r(noCompass,times,now,policy).course.hdg,115);
 noCompass[S]=0;assert.equal(r(noCompass,times,now,policy).course.hdg,null);
 delete noCompass[C];assert.equal(r(noCompass,times,now,policy).course.cog,null);
 assert.equal(r(raw,{...times,[P]:now-5000},now,policy).position,null);
 assert.equal(r({...raw,[P]:{latitude:91,longitude:14}},times,now,policy).position,null);
 assert.equal(r(raw,{...times,[P]:now+1000},now,policy).position,null);
 assert.equal(r(raw,{...times,[H]:now-5000,[C]:now-5000},now,policy).course.hdg,null);
});
test('GPS timestamps refresh on unchanged fixes before dedup; duplicate/older/invalid fixes never renew them',()=>{
 const original=Date.now;let time=now;Date.now=()=>time;
 try{
 const e=new WindEngine({debug(){}},()=>({}));e.fetchOpenMeteoForecast=()=>{};
 e.processIncomingDelta(P,position,time);assert.equal(e.getRawTimes()[P],time);
 time+=1000;e.processIncomingDelta(P,{...position},time);assert.equal(e.getRawTimes()[P],time);
 e.processIncomingDelta(P,{...position,latitude:37},time-1000);assert.equal(e.getRaw()[P].latitude,position.latitude);
 e.processIncomingDelta(P,{...position,latitude:91},time+100);assert.equal(e.getRawTimes()[P],time);
 time+=1000;e.processIncomingDelta(P,null,time);assert.equal(e.getRaw()[P],null);assert.equal(e.getRawTimes()[P],time);
 e.processIncomingDelta(P,position,time-1000);assert.equal(e.getRaw()[P],null);
 time+=1000;e.processIncomingDelta(P,position,time);assert.deepEqual(e.getRaw()[P],position);
 }finally{Date.now=original;}
});
