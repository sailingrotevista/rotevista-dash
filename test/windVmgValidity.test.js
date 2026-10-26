const {test}=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../shared/windDataPolicy.json');
const {WindEngine}=require('../wind/windEngine');
const H='navigation.speedThroughWater',G='navigation.speedOverGround',A='environment.wind.angleTrueWater';
test('VMG uses native TWA and STW without AWS or SOG, positive downwind and real zero',async()=>{
 const {resolveVmg:r}=await import('../src/utils/windValidity.mjs');
 const raw={[H]:3,[A]:Math.PI/3},times={[H]:1000,[A]:1000};
 assert.ok(Math.abs(r(raw,times,1000,policy)-1.5)<1e-9);
 raw[A]=Math.PI;
 assert.equal(r(raw,times,1000,policy),3);
 raw[H]=0;assert.equal(r(raw,times,1000,policy),0);
 delete raw[H];assert.equal(r(raw,times,1000,policy),null);
 raw[G]=4;times[G]=1000;assert.equal(r(raw,times,1000,policy),4);
 assert.equal(r(raw,times,6000,policy),null);
 times[A]=6000;assert.equal(r(raw,times,6000,policy),null);
});
test('server VMG independent of apparent wind and stops when speed expires',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({},()=>({}));const values=[];e.manageHistory=(k,v)=>{if(k==='vmg')values.push(v);};
 e.processIncomingDelta(H,3,now);
 e.processIncomingDelta(A,Math.PI,now);e.sampleHistory();
 assert.ok(Math.abs(values.at(-1)-3*1.94384)<1e-9);
 now+=5000;values.length=0;e.processIncomingDelta(A,Math.PI/2,now);e.sampleHistory();
 assert.equal(values.length,0);
 e.processIncomingDelta(H,0,now);now+=1000;e.sampleHistory();
 assert.equal(values.at(-1),0);
 }finally{Date.now=original;}
});
