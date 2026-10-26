const { test } = require('node:test');
const assert = require('node:assert/strict');
const create = require('../shared/magneticDeclination');
const geomagnetism = require('geomagnetism');
const policy = require('../shared/windDataPolicy.json');
const now = Date.UTC(2026, 9, 25);
const position = { latitude: 36.78, longitude: 14.55 };
test('offline model, cache distance/day, invalid inputs and validity end', () => {
 let calls=0;
 const calc=create({model(date, options){calls++;return geomagnetism.model(date, options);}});
 const raw={'navigation.position': {...position}};
 const value=calc(raw,now);
 assert.ok(Math.abs(value*180/Math.PI-3.95467493)<1e-7);
 calc(raw,now+1000); raw['navigation.position'].latitude+=0.00001;calc(raw,now+2000);
 assert.equal(calls,1);
 raw['navigation.position'].latitude+=0.02;calc(raw,now+3000);assert.equal(calls,2);
 calc(raw,now+86400000);assert.equal(calls,3);
 assert.equal(calc(raw,Date.UTC(2030,0,1)),null);
 assert.equal(calc({},now),null);
 raw['navigation.position'].latitude=NaN;assert.equal(calc(raw,now),null);
});
test('GUI and server ignore instrument variation; magnetic leeway uses model, not COG fallback',async()=>{
 const {resolveHeading,resolveLeeway}=await import('../src/utils/windValidity.mjs');
 const raw={'navigation.position':position,'navigation.headingMagnetic':1,'navigation.magneticVariation':-2,'navigation.courseOverGroundTrue':1.2,'navigation.speedOverGround':2};
 const times=Object.fromEntries(Object.keys(raw).map(k=>[k,now]));
 const expected=1+create(geomagnetism)(raw,now);
 assert.ok(Math.abs(resolveHeading(raw,times,now,policy)-expected)<1e-12);
 assert.ok(Math.abs(resolveLeeway(raw,times,now,policy,1)-(1.2-expected)*180/Math.PI)<1e-10);
 const {WindEngine}=require('../wind/windEngine');
 const original=Date.now;Date.now=()=>now;
 try {
  const e=new WindEngine({debug(){}},()=>({}));e.fetchOpenMeteoForecast=()=>{};
  for(const [p,v] of Object.entries(raw))e.processIncomingDelta(p,v,now);
  e.sampleHistory();
  assert.ok(Math.abs(e.getRollingAngles().hdg.at(-1).val-expected)<0.00051);
 }finally{Date.now=original;}
 delete raw['navigation.headingMagnetic'];
 assert.equal(resolveLeeway(raw,times,now,policy,1),null);
});
test('installation variants: corrected compass, true-only, GPS-only and missing inputs', async()=>{
 const {resolveHeading:h,resolveTwd:d,resolveLeeway:l}=await import('../src/utils/windValidity.mjs');
 const H='navigation.headingTrue',M='navigation.headingMagnetic',C='navigation.courseOverGroundTrue',S='navigation.speedOverGround',D='environment.wind.directionTrue',A='environment.wind.angleTrueWater';
 const raw={'navigation.position':position,[H]:2,[M]:1,[C]:1.5,[S]:2,[D]:4,[A]:0.5};
 const times=Object.fromEntries(Object.keys(raw).map(k=>[k,now]));
 const expected=1+create(geomagnetism)(raw,now);
 assert.ok(Math.abs(h(raw,times,now,policy)-expected)<1e-12);
 assert.ok(Math.abs(d(raw,times,now,policy)-expected-0.5)<1e-12);
 assert.ok(Math.abs(l(raw,times,now,policy,1)-(1.5-expected)*180/Math.PI)<1e-10);
 delete raw[M]; assert.equal(h(raw,times,now,policy),2);
 assert.equal(d(raw,times,now,policy),2.5);
 delete raw[H];assert.equal(h(raw,times,now,policy),1.5);
 assert.equal(l(raw,times,now,policy,1),null);
 assert.equal(d(raw,times,now,policy),4); // Native TWD outranks GPS approximation.
 delete raw[D];assert.equal(d(raw,times,now,policy),2);
 raw[S]=0;assert.equal(h(raw,times,now,policy),null);assert.equal(d(raw,times,now,policy),null);
 raw[H]=2;delete raw[A];assert.equal(d(raw,times,now,policy),null);
 raw[D]=0;assert.equal(d(raw,times,now,policy),0);
 assert.equal(h(raw,times,now+15000,policy),null);
});
test('server reconstructed TWD overrides received TWD without modifying raw data',()=>{
 const {WindEngine}=require('../wind/windEngine'); const original=Date.now;Date.now=()=>now;
 try{
 const e=new WindEngine({debug(){}},()=>({}));e.fetchOpenMeteoForecast=()=>{};
 let last; e.manageHistory=(k,v)=>{if(k==='twd')last=v;};
 for(const [p,v] of Object.entries({'navigation.position':position,'navigation.headingTrue':2,'navigation.headingMagnetic':1,'environment.wind.angleTrueWater':0.5,'environment.wind.directionTrue':4}))e.processIncomingDelta(p,v,now);
 e.sampleHistory();
 assert.ok(Math.abs(last-(1.5+create(geomagnetism)({'navigation.position':position},now)))<1e-10);
 assert.equal(e.getRaw()['environment.wind.directionTrue'],4);
 }finally{Date.now=original;}
});
