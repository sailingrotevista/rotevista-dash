const {feedWindInput}=require('./helpers/feedWindInput');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
test('depth expires at 5 seconds, preserves measured zero and rejects invalid inputs',async()=>{
 const {freshDepth:f}=await import('../src/utils/windValidity.mjs');
 assert.equal(f(0,1000,5999,5000),0);
 assert.equal(f(2,1000,6000,5000),null);
 for(const value of [null,undefined,NaN,Infinity,501,-3]) assert.equal(f(value,1000,1000,5000),null);
 assert.equal(f(2,6000,6000,5000),2);
});
test('server preserves depth source time, ignores stale history and publishes null reset',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({},()=>({}));const writes=[];e.manageHistory=(k,v)=>{if(k==='depth')writes.push(v);};
 const path='environment.depth.belowTransducer';
 feedWindInput(e,path,2,now-5000);e.sampleHistory();assert.deepEqual(writes,[]);
 now+=5000;feedWindInput(e,path,2,now);e.sampleHistory();
 assert.equal(e.getRawTimes()[path],now);
 assert.deepEqual(writes,[2]);
 now+=1000;feedWindInput(e,path,2,now);
 assert.equal(e.getRawTimes()[path],now);
 feedWindInput(e,path,1,now-1000);assert.equal(e.getRaw()[path],2);
 feedWindInput(e,path,Infinity,now+100);assert.equal(e.getRawTimes()[path],now);
 feedWindInput(e,path,null,now);assert.equal(e.getRaw()[path],null);
 assert.equal(e.getRawTimes()[path],now);
 now+=1000;feedWindInput(e,path,0,now);e.sampleHistory();
 assert.equal(writes.at(-1),0);
 }finally{Date.now=original;}
});
