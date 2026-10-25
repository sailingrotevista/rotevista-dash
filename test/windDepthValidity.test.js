const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');
test('depth expires at 15 seconds, preserves measured zero and rejects invalid inputs',async()=>{
 const {freshDepth:f}=await import('../src/utils/windValidity.mjs');
 assert.equal(f(0,1000,15999,15000),0);
 assert.equal(f(2,1000,16000,15000),null);
 for(const value of [null,undefined,NaN,Infinity,501,-3]) assert.equal(f(value,1000,1000,15000),null);
 assert.equal(f(2,16000,16000,15000),2);
});
test('server preserves depth source time, ignores stale history and publishes null reset',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({},()=>({}));const writes=[];e.manageHistory=(k,v)=>{if(k==='depth')writes.push(v);};
 const path='environment.depth.belowTransducer';
 e.processIncomingDelta(path,2,now-15000);assert.deepEqual(writes,[]);
 now+=5000;e.processIncomingDelta(path,2,now);
 assert.equal(e.getRawTimes()[path],now);
 assert.deepEqual(writes,[2]);
 now+=1000;e.processIncomingDelta(path,2,now);
 assert.equal(e.getRawTimes()[path],now);
 e.processIncomingDelta(path,1,now-1000);assert.equal(e.getRaw()[path],2);
 e.processIncomingDelta(path,Infinity,now+100);assert.equal(e.getRawTimes()[path],now);
 e.processIncomingDelta(path,null,now);assert.equal(e.getRaw()[path],null);
 assert.equal(e.getRawTimes()[path],now);
 now+=1000;e.processIncomingDelta(path,0,now);
 assert.equal(writes.at(-1),0);
 }finally{Date.now=original;}
});
