const {test}=require('node:test');const assert=require('node:assert/strict');
const {WindEngine}=require('../windEngine');const {historyRetentionMs}=require('../twdHistory');const policy=require('../windDataPolicy.json');
const start=Date.UTC(2026,9,25,18);const MINUTE=60000;
test('short 5/10 minute graphs retain the whole radar interval through periodic pruning and sensor silence',async()=>{
 const {graphViewport}=await import('../src/utils/graphViewport.mjs');
 const original=Date.now;let now=start;Date.now=()=>now;
 try{for(const historyMinutes of [5,10]){
 const e=new WindEngine({debug(){}},()=>({graphs:{historyMinutes}}));
 for(let second=0;second<=1800;second++){
 now=start+second*1000;
 if(second<1780){
 e.processIncomingDelta('environment.wind.speedTrue',(second<600?25:5)/1.94384,now);
 e.processIncomingDelta('environment.wind.directionTrue',second<600?0:1,now);
 }
 e.sampleHistory();
 if(second%60===0)e.pruneStaleHistories();
 }
 const slot=e.getWindRadarSlots().find(s=>s.timestamp===start);
 assert.ok(slot,'slot must close on time despite no new wind messages');
 assert.ok(Math.abs(slot.twsPeak-25)<1e-9,'early strong wind must not be lost');
 assert.ok(Math.abs(slot.twdMin)<1e-9,'early wind direction must not be lost');
 assert.ok(Math.abs(slot.twdMax-1)<1e-9);
 assert.equal(e.getHistories().tws[0].time,start);
 assert.equal(e.getHistories().twd[0].time,start);
 const visible=graphViewport(e.getHistories().tws,now,historyMinutes*2*MINUTE);
 assert.ok(visible.points.every(p=>p.time>=now-historyMinutes*2*MINUTE));
 assert.ok(visible.points.length<e.getHistories().tws.length);
 }}finally{Date.now=original;}
});
test('aggregation and periodic cleanup apply identical bounded per-channel retention',()=>{
 const original=Date.now;const now=start+180*MINUTE;Date.now=()=>now;
 try{
 for(const channel of ['twd','tws','sog','depth']){
 const duration=historyRetentionMs(channel,5,policy);
 const points=[{val:1,time:now-duration-1,min:1,max:1},{val:1,time:now-duration,min:1,max:1},{val:1,time:now-1000,min:1,max:1}];
 const first=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:5}}));
 first.histories[channel]=structuredClone(points);first.lastUpdates[channel]=now-10000;first.manageHistory(channel,1);
 const second=new WindEngine({debug(){}},()=>({graphs:{historyMinutes:5}}));
 second.histories[channel]=structuredClone(points);second.pruneStaleHistories();
 assert.equal(first.histories[channel][0].time,now-duration);
 assert.equal(second.histories[channel][0].time,now-duration);
 assert.ok(first.histories[channel].every(p=>now-p.time<=duration));
 }
 assert.equal(historyRetentionMs('twd',5,policy),121*MINUTE);
 assert.equal(historyRetentionMs('tws',5,policy),31*MINUTE);
 assert.equal(historyRetentionMs('sog',5,policy),11*MINUTE);
 assert.equal(historyRetentionMs('tws',60,policy),121*MINUTE);
 }finally{Date.now=original;}
});
