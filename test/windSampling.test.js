const {test}=require('node:test');const assert=require('node:assert/strict');
const {WindEngine}=require('../wind/windEngine');
const AWS='environment.wind.speedApparent',AWA='environment.wind.angleApparent';
const H='navigation.headingTrue',SOG='navigation.speedOverGround';
const start=1000000;
function engine(){return new WindEngine({debug(){}},()=>({graphs:{historyMinutes:1}}));}
test('delta acquisition never writes history; one clock tick samples each valid channel once',()=>{
 const original=Date.now;let now=start;Date.now=()=>now;
 try{
 const e=engine(),writes=[];e.manageHistory=(k,v)=>writes.push({k,v,time:now});
 for(const [p,v] of [[AWS,5],[AWA,1],[H,1],[SOG,2],['environment.depth.belowTransducer',4]])e.processIncomingDelta(p,v,now);
 for(let i=0;i<8;i++){now+=50;e.processIncomingDelta('navigation.attitude',{roll:i*.01},now);e.processIncomingDelta('environment.inside.temperature',290+i,now);}
 assert.equal(writes.length,0);assert.equal(e.getRollingAngles().twd.length,0);
 assert.equal(e.sampleHistory(),true);
 for(const k of ['aws','tws','twd','vmg','sog','depth'])assert.equal(writes.filter(p=>p.k===k).length,1);
 const times=e.getRawTimes();const count=writes.length;
 now+=100;assert.equal(e.sampleHistory(),false);assert.equal(writes.length,count);
 assert.deepEqual(e.getRawTimes(),times); // A sample tick is not a new sensor observation.
 now+=900;assert.equal(e.sampleHistory(),true);assert.equal(writes.length,count*2);
 }finally{Date.now=original;}
});
test('identical genuine reports sustain 1 Hz history, rather than one sample every four seconds',()=>{
 const original=Date.now;let now=start;Date.now=()=>now;
 try{
 const e=engine(),writes=[];e.manageHistory=(k,v)=>{if(k==='aws')writes.push({time:now,val:v});};
 for(let i=0;i<8;i++){
 now=start+i*1000;e.processIncomingDelta(AWS,5,now);e.sampleHistory();
 }
 assert.equal(writes.length,8);
 assert.deepEqual(writes.map(p=>p.time),Array.from({length:8},(_,i)=>start+i*1000));
 assert.equal(e.getRawTimes()[AWS],now);
 }finally{Date.now=original;}
});
test('unrelated rapid messages cannot duplicate an isolated gust or change the filtered peak',()=>{
 const original=Date.now;let now=start;Date.now=()=>now;
 try{
 const e=engine();e.processIncomingDelta(AWA,0,now);e.processIncomingDelta(AWS,10/1.94384,now);e.sampleHistory();
 now+=1000;e.processIncomingDelta(AWS,25/1.94384,now);e.sampleHistory();
 const count=e.graphTempBuf.tws.length;
 for(let i=0;i<8;i++){
 now+=50;e.processIncomingDelta(H,i*.01,now);e.processIncomingDelta('navigation.attitude',{roll:.1},now);
 assert.equal(e.sampleHistory(),false);
 }
 assert.equal(e.graphTempBuf.tws.length,count);
 now=start+2000;e.processIncomingDelta(AWS,10/1.94384,now);e.sampleHistory();
 assert.ok(Math.abs(e.getHistories().tws.at(-1).val-14.94519930946541)<1e-9);
 assert.ok(Math.abs(e.getHistories().aws.at(-1).val-14.94519930946541)<1e-9);
 }finally{Date.now=original;}
});
test('a clock tick stops expired sensors, records no invented zeros, and retains the gap after resumption',()=>{
 const original=Date.now;let now=start;Date.now=()=>now;
 try{
 const e=engine();e.processIncomingDelta(SOG,2,now);e.sampleHistory();
 for(let i=1;i<5;i++){now=start+i*1000;e.sampleHistory();}
 const count=e.getHistories().sog.length;
 now=start+5000;e.sampleHistory();now=start+9000;e.sampleHistory();
 assert.equal(e.getHistories().sog.length,count);assert.equal(e.getRawTimes()[SOG],start);
 now=start+10000;e.processIncomingDelta(SOG,0,now);e.sampleHistory();
 assert.equal(e.getHistories().sog.at(-1).val,0);
 assert.equal(e.getHistories().sog.at(-1).gapBefore,true);
 }finally{Date.now=original;}
});
