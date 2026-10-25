const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');
test('SOG distinguishes zero from missing and expires exactly at 15 seconds',async()=>{
 const {freshBoatSpeed}=await import('../src/utils/windValidity.mjs');
 assert.equal(freshBoatSpeed(0,1000,15999,15000),0);
 assert.equal(freshBoatSpeed(4,1000,16000,15000),null);
 for(const v of [undefined,null,NaN,Infinity,-1,26]) assert.equal(freshBoatSpeed(v,1000,1000,15000),null);
 assert.equal(freshBoatSpeed(4,16000,16000,15000),4);
});
test('server does not write stale SOG history and resumes with measured zero',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({},()=>({}));const writes=[];e.manageHistory=(k,v)=>{if(k==='sog')writes.push(v);};
 const path='navigation.speedOverGround';
 e.processIncomingDelta(path,4,now-15000);
 assert.deepEqual(writes,[]);
 now+=1000;e.processIncomingDelta(path,0,now);
 assert.deepEqual(writes,[0]);
 now+=1000;e.processIncomingDelta(path,5,now-16000);
 assert.deepEqual(writes,[0]);
 e.processIncomingDelta(path,null,now);
 assert.equal(e.getRaw()[path],undefined);
 assert.deepEqual(writes,[0]);
 }finally{Date.now=original;}
});
