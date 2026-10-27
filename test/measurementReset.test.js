const {feedWindInput}=require('./helpers/feedWindInput');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {WindEngine} = require('../wind/windEngine');
const {DashboardSession} = require('../session/dashboardSession');
const paths = [
 'navigation.speedThroughWater', 'navigation.speedOverGround', 'navigation.headingTrue',
 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue', 'environment.depth.belowTransducer',
 'environment.wind.speedTrue', 'environment.wind.directionTrue', 'environment.wind.angleTrueWater',
 'environment.wind.angleApparent', 'environment.wind.speedApparent',
];
const valueFor = path => path === 'navigation.position' ? {latitude:36,longitude:14} : 1;
function engine() {
 const e = new WindEngine({debug(){}}, () => ({}));
 e.fetchOpenMeteoForecast = () => {};
 return e;
}

test('server rejects delayed resets and replayed measurements across every instrument', () => {
 const now = Date.now();
 for (const path of paths) {
  const e = engine(), value = valueFor(path);
  feedWindInput(e,path, value, now-2000);
  const accepted = e.getRaw()[path];
  feedWindInput(e,path, null, now-3000);
  assert.deepEqual(e.getRaw()[path], accepted, path);
  feedWindInput(e,path, null, now-1000);
  assert.equal(e.getRaw()[path], null, path);
  assert.equal(e.getRawTimes()[path], now-1000, path);
  for (const timestamp of [now-2000, now-1000]) {
   feedWindInput(e,path, value, timestamp);
   assert.equal(e.getRaw()[path], null, path);
   assert.equal(e.getRawTimes()[path], now-1000, path);
  }
  feedWindInput(e,path, value, now);
  assert.deepEqual(e.getRaw()[path], accepted, path);
 }
});

test('polling alone propagates resets, including same-timestamp resets, to browser state', async () => {
 const {handleMeasurementReset, shouldApplySessionMeasurement} = await import('../src/utils/measurementReset.mjs');
 const now = Date.now(), e = engine();
 for (const path of paths) feedWindInput(e,path, valueFor(path), now-1000);
 const session = new DashboardSession({now, readLive:() => ({raw:e.getRaw(),rawTimes:e.getRawTimes(),targets:[]})});
 const store = {raw:{},timestamps:{},smoothBuf:{awa:[],twa:[]},longBuf:{awa:[],twa:[]}};
 const previous = {};
 const poll = () => {
  const frame = JSON.parse(JSON.stringify(session.tick(now)));
  for (const [path,value] of Object.entries(frame.raw)) {
   const time = frame.rawTimes[path];
   if (!shouldApplySessionMeasurement(previous[path], value, time)) continue;
   previous[path] = {time,value:JSON.stringify(value)};
   if (!handleMeasurementReset(store,path,value,time,now)) {
    store.raw[path] = value; store.timestamps[path] = time;
   }
  }
 };
 poll();
 for (const path of paths) {
  assert.notEqual(store.raw[path],null,path);
  feedWindInput(e,path,null,now-1000);
 }
 poll();
 for (const path of paths) {
  assert.equal(store.raw[path],null,path);
  assert.equal(store.timestamps[path],now-1000,path);
  assert.equal(handleMeasurementReset(store,path,valueFor(path),now-1500,now),true,path);
  assert.equal(handleMeasurementReset(store,path,valueFor(path),now-1000,now),true,path);
  assert.equal(shouldApplySessionMeasurement(previous[path],valueFor(path),now-1000),false,path);
  assert.equal(handleMeasurementReset(store,path,valueFor(path),now,now),false,path);
 }
});

test('browser rejects old null without clearing measurements or angular buffers', async () => {
 const {handleMeasurementReset} = await import('../src/utils/measurementReset.mjs');
 for (const path of paths) {
  const value = valueFor(path);
  const store = {raw:{[path]:value},timestamps:{[path]:2000},smoothBuf:{awa:[1],twa:[1]},longBuf:{awa:[1],twa:[1]}};
  const before = structuredClone(store);
  assert.equal(handleMeasurementReset(store,path,null,1000,3000),true);
  assert.deepEqual(store,before,path);
 }
});

test('silence still expires at five seconds while a reset stops sampling immediately', () => {
 const e = engine(), path = 'navigation.speedOverGround', now = Date.now();
 const writes = [];
 e.manageHistory = (channel,value) => {if (channel === 'sog') writes.push(value);};
 feedWindInput(e,path,1,now-4999);
 e.sampleHistory(now);
 assert.equal(writes.length,1);
 e.sampleHistory(now+1000);
 assert.equal(writes.length,1);
 const resetEngine = engine();
 resetEngine.manageHistory = e.manageHistory;
 feedWindInput(resetEngine,path,1,now-1000);
 feedWindInput(resetEngine,path,null,now);
 resetEngine.sampleHistory(now);
 assert.equal(writes.length,1);
 assert.equal(resetEngine.getRawTimes()[path],now);
});
