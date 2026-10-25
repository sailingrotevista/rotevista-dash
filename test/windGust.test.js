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

for (const [channel,path] of [['aws','environment.wind.speedApparent'],['tws','environment.wind.speedTrue']]) {
 test(`${channel}: persistent measured zero after wind keeps history advancing and silence still expires`,()=>{
  const original=Date.now;let now=1800000;Date.now=()=>now;
  try {
   const e=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:5,reef1:15}}));
   for(let second=0;second<=120;second++) {
    now=1800000+second*1000;
    e.processIncomingDelta(path,second<2 ? 10/1.94384 : 0,now);
    e.sampleHistory(now);
   }
   const history=e.getHistories()[channel];
   assert.ok(history.length>20);
   assert.ok(now-history.at(-1).time<=5000);
   assert.ok(history.at(-1).val<0.01);
   assert.ok(history.every(p=>!p.gapBefore));
   assert.equal(e.getRawTimes()[path],now);
   now+=5000;e.sampleHistory(now);
   const count=history.length;
   now+=5000;e.sampleHistory(now);
   assert.equal(history.length,count);
  }finally{Date.now=original;}
 });
 test(`${channel}: an isolated zero is smoothed rather than discarded or treated as a gap`,()=>{
  const e=new WindEngine({},()=>({graphs:{historyMinutes:5,reef1:15}}));
  const start=1800000;
  e.manageHistory(channel,10,start);
  e.manageHistory(channel,10,start+1000);
  e.manageHistory(channel,0,start+2000);
  assert.equal(e.graphTempBuf[channel].at(-1).val,0);
  for(let second=3;second<=6;second++) e.manageHistory(channel,10,start+second*1000);
  assert.ok(e.gustFilter[channel].val>6 && e.gustFilter[channel].val<10);
  assert.equal(e.getHistories()[channel].at(-1).val,10);
  assert.equal(e.getHistories()[channel].at(-1).gapBefore,undefined);
 });
}
