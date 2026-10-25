const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');

test('gust filter continues across buckets and does not carry the old maximum',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({},()=>({graphs:{historyMinutes:1}}));
 e.manageHistory('aws',10);
 now+=1000;e.manageHistory('aws',25);
 now+=1000;e.manageHistory('aws',10);
 const peak=e.getHistories().aws.at(-1).val;
 assert.ok(Math.abs(peak-14.94519930946541)<1e-9);
 now+=1000;e.manageHistory('aws',10);
 now+=1000;e.manageHistory('aws',10);
 assert.ok(e.getHistories().aws.at(-1).val<peak);
 assert.ok(e.gustFilter.aws.val<e.getHistories().aws.at(-1).val);
 e.manageHistory('tws',30);
 assert.equal(e.gustFilter.tws.val,30);
 }finally{Date.now=original;}
});
test('sustained gust rises progressively and restarts after a long data gap',()=>{
 const original=Date.now;let now=1000000;Date.now=()=>now;
 try {
 const e=new WindEngine({},()=>({graphs:{historyMinutes:1}}));
 e.manageHistory('aws',10);
 for(let i=0;i<4;i++){now+=1000;e.manageHistory('aws',25);}
 assert.ok(Math.abs(e.getHistories().aws.at(-1).val-21.97155223008017)<1e-9);
 now+=1000;e.manageHistory('aws',25);
 now+=15000;e.manageHistory('aws',5);
 assert.equal(e.getHistories().aws.at(-1).val,5);
 assert.equal(e.gustFilter.aws.val,5);
 }finally{Date.now=original;}
});
