const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SignalKReceiver } = require('../sensors/SignalKReceiver');
const { SensorNormalizer } = require('../sensors/SensorNormalizer');
const { SensorDerivedData } = require('../sensors/SensorDerivedData');
const path = 'navigation.position';
const origin = 1800000000000;
const position = { latitude: 36.78096389770508, longitude: 14.545442581176758 };
const reserve = { latitude: 36.780998333333336, longitude: 14.545385 };
function event(source, ms, value = position, receivedMs = ms, sourceInfo = null) {
    return { path, source, timestamp: origin + ms, receivedAt: origin + receivedMs, value, sourceInfo };
}
const gps = (snapshot) => snapshot.measurements[path];
const info = { label: 'receiver', talker: 'GP', sentence: 'RMC' };
const aisInfo = { label: 'yacht_device', talker: 'AI', sentence: 'VDM' };

function delta(source, ms, value = position, extra = {}) {
    return { context: 'vessels.self', updates: [{ $source: source, timestamp: new Date(origin + ms).toISOString(),
        values: [{ path, value }], ...extra }] };
}

test('Receiver forwards every real own GPS update at native cadence without mutating input or manufacturing timestamps', () => {
    const received = [];
    const receiver = new SignalKReceiver({ onMeasurement: sample => received.push(sample), clock: () => origin + 1000, selfContext: 'vessels.own-uuid' });
    for (const ms of [0, 100, 200, 300, 400]) receiver.receive(delta('gps', ms));
    assert.equal(received.length, 5);
    assert.equal(received[0].timestamp, new Date(origin).toISOString());
    assert.equal(received[0].receivedAt, origin + 1000);
    assert.equal(receiver.receive({ ...delta('other', 0), context: 'vessels.another-boat' }), 0);
    assert.equal(receiver.receive({ ...delta('gps', 500), context: 'vessels.own-uuid' }), 1);
    assert.equal(receiver.receive({ ...delta('gps', 500), context: undefined }), 0);
    const input = delta('gps', 700);
    receiver.receive(input);
    received.at(-1).value.latitude = 0;
    assert.deepEqual(input.updates[0].values[0].value, position);
    receiver.receive(delta('gps', 800, null, { timestamp: undefined }));
    assert.equal(received.at(-1).timestamp, null);
    assert.equal(received.at(-1).value, null);
    receiver.receive({ context: 'vessels.self', updates: [{ timestamp: new Date(origin).toISOString(), source: { label:'n2k',src:0 }, values: [{ path, value:position }, { path:'navigation.speedOverGround',value:2 }] }] });
    assert.equal(received.at(-1).source, 'n2k.0');
});

test('Receiver requests raw all-source GPS and owns an idempotent subscription lifecycle', () => {
    let calls = 0, disposed = 0;
    const samples = [];
    const receiver = new SignalKReceiver({ onMeasurement: sample => samples.push(sample), clock: () => origin });
    const app = { selfContext:'vessels.own', subscriptionmanager:{ subscribe(command, unsubscribes, onError, callback, user, sourcePolicy) {
        calls++;
        assert.equal(command.context, 'vessels.self');
        assert.deepEqual(command.subscribe.map(row=>row.path), [path,'navigation.speedOverGround','navigation.courseOverGroundTrue',
            'navigation.gnss.methodQuality','navigation.gnss.integrity','navigation.gnss.horizontalDilution','navigation.gnss.satellites','environment.wind.speedApparent','navigation.speedThroughWater','environment.wind.speedTrue','environment.depth.belowTransducer','environment.wind.angleApparent','environment.wind.angleTrueWater','environment.wind.directionTrue','navigation.headingTrue','navigation.headingMagnetic']);
        assert.ok(command.subscribe.every(row=>row.policy==='instant'&&row.minPeriod===0));
        assert.equal(sourcePolicy, 'all');
        unsubscribes.push(() => disposed++);
        callback({ ...delta('gps', 0),context:'vessels.own' });
    } } };
    receiver.start(app);receiver.start(app);
    assert.equal(calls, 1);assert.equal(samples.length, 1);
    receiver.stop();receiver.stop();assert.equal(disposed, 1);
    receiver.start(app);assert.equal(calls, 2);receiver.stop();assert.equal(disposed, 2);
});

test('Normalizer rejects invalid coordinates, missing provenance, old reports, future times and duplicate observations', () => {
    const normalizer = new SensorNormalizer();
    assert.equal(normalizer.ingest(event('gps', 0)), true);
    for (const sample of [
        event('gps', 0), event('gps', -1), event('backup', 0, position, 240000),
        event('backup', 1, position, 0), { ...event('backup', 0), timestamp:null },
        { ...event('backup', 0), source:null }, { ...event('backup', 0), receivedAt:NaN },
        { ...event('backup', 0), path:'navigation.speedOverGround' },
    ]) assert.equal(normalizer.ingest(sample), false);
    assert.equal(normalizer.gps.sources.get('gps').samples.length, 1);
    assert.equal(gps(normalizer.tick(origin)).source, 'gps');
    assert.equal(normalizer.ingest(event('gps', 1000, { latitude:NaN,longitude:14 })), false);
    assert.equal(gps(normalizer.tick(origin + 1000)).valid, false);
    assert.equal(normalizer.ingest(event('gps', 2000, { latitude:91,longitude:14 })), false);
    assert.equal(normalizer.ingest(event('gps', 3000, { latitude:0,longitude:0 })), false, 'implausible jump is not selected');
    assert.equal(normalizer.ingest(event('gps', 4000, position)), true);
    assert.equal(gps(normalizer.tick(origin + 4000)).valid, true);
    assert.equal(normalizer.ingest(event('gps', 4000, null)), false);
    assert.equal(normalizer.ingest(event('gps', 4000, position)), false, 'replay cannot undo a reset at the same source time');
    assert.equal(gps(normalizer.tick(origin + 5000)).status, 'INVALID');
    const zero = new SensorNormalizer();assert.equal(zero.ingest(event('gps', 0, { latitude:0,longitude:0 })), true);
});

test('snapshot is capped at 1Hz and preserves the latest chosen real fix; repeated ticks never add observations', () => {
    const normalizer = new SensorNormalizer();
    const derived = new SensorDerivedData();
    const receiver = new SignalKReceiver({ onMeasurement: sample => normalizer.ingest(sample) });
    for (const ms of [0,100,200,300,400]) receiver.receive(delta('gps',ms),origin+ms);
    const first = normalizer.tick(origin+500);
    assert.equal(gps(first).timestamp,origin+400);
    assert.equal(gps(first).receivedAt,origin+400);
    assert.equal(gps(first).isNewObservation,true);
    assert.equal(normalizer.tick(origin+1000),null);
    const second = normalizer.tick(origin+1500);
    assert.equal(gps(second).timestamp,origin+400);
    assert.equal(gps(second).isNewObservation,false);
    assert.equal(gps(second).observationId,gps(first).observationId);
    assert.equal(normalizer.gps.sources.get('gps').samples.length,5);
    const result=derived.process(second);
    assert.deepEqual(result.measurements,second.measurements);
    assert.equal(result.sampledAt,second.sampledAt);
    assert.equal(result.derived.vmg.valid,false);
    result.measurements[path].value.longitude=0;
    assert.equal(derived.getSnapshot().measurements[path].value.longitude,position.longitude);
    assert.deepEqual(gps(normalizer.tick(origin+5500)).value,position);
    assert.equal(gps(normalizer.tick(origin+240400)).status,'STALE');
});

test('initial equal-score selection is deterministic without rewarding GNSS type over AIS and never averages positions from different sources', () => {
    const normalizer = new SensorNormalizer();
    normalizer.ingest(event('yacht_device.AI',0,reserve,0,aisInfo));
    normalizer.ingest(event('direct.GP',0,position,0,info));
    const measurement=gps(normalizer.tick(origin));
    assert.equal(measurement.source,'direct.GP');assert.equal(measurement.sourceType,'GNSS');
    assert.deepEqual(measurement.value,position);
    assert.notDeepEqual(measurement.value,{ latitude:(position.latitude+reserve.latitude)/2,longitude:(position.longitude+reserve.longitude)/2 });
});

test('a healthy lock does not alternate between equal GPS sources as their reports interleave', () => {
    const normalizer = new SensorNormalizer();
    normalizer.ingest(event('primary.GP',0,position,0,info));normalizer.tick(origin);
    for (let ms=1000;ms<=10000;ms+=1000) {
        normalizer.ingest(event('primary.GP',ms,position,ms,info));
        normalizer.ingest(event('other.GP',ms+100,reserve,ms+100,info));
        const selected=gps(normalizer.tick(origin+ms+100));
        if (!selected) continue;
        assert.equal(selected.source,'primary.GP');
    }
});

test('failover needs a fresh backup and silent sources do not become fresh at the next tick', () => {
    const normalizer = new SensorNormalizer({maxAgeMs:5000});
    normalizer.ingest(event('primary.GP',0,position,0,info));normalizer.tick(origin);
    normalizer.ingest(event('backup.AI',4000,reserve,4000,aisInfo));
    assert.equal(gps(normalizer.tick(origin+4000)).source,'primary.GP');
    const changed=gps(normalizer.tick(origin+5000));
    assert.equal(changed.source,'backup.AI');assert.equal(changed.selectionReason,'FAILOVER');
    assert.equal(changed.sourceChanged,true);assert.equal(changed.timestamp,origin+4000);
    assert.deepEqual(changed.value,reserve);
    assert.equal(normalizer.ingest(event('primary.GP',0,position,5500,info)),false);
    assert.equal(gps(normalizer.tick(origin+9000)).valid,false);
    assert.equal(normalizer.gps.sources.get('primary.GP').lastTimestamp,origin);
});

test('return to a preferred source requires sustained real fixes rather than repeated snapshots', () => {
    const normalizer = new SensorNormalizer();
    normalizer.ingest(event('backup.AI',0,reserve,0,aisInfo));normalizer.tick(origin);
    for (let second=1;second<=6;second++) {
        normalizer.ingest(event('backup.AI',second*1000,reserve,second*1000,aisInfo));
        normalizer.ingest(event('direct.GP',second*1000,position,second*1000,info));
        normalizer.ingest({...event('backup.AI',second*1000),path:'navigation.gnss.methodQuality',value:'manual input'});
        normalizer.ingest({...event('direct.GP',second*1000),path:'navigation.gnss.methodQuality',value:'rtk fixed integer'});
        const m=gps(normalizer.tick(origin+second*1000));
        assert.equal(m.source,second<6?'backup.AI':'direct.GP');
        if (second===6) assert.equal(m.selectionReason,'PREFERRED_SOURCE');
    }
    const single = new SensorNormalizer({maxAgeMs:20000});
    single.ingest(event('backup.AI',0,reserve,0,aisInfo));single.tick(origin);
    single.ingest(event('direct.GP',1000,position,1000,info));
    for(let second=1;second<=8;second++) {
        single.ingest(event('backup.AI',second*1000,reserve,second*1000,aisInfo));
        assert.equal(gps(single.tick(origin+second*1000)).source,'backup.AI');
    }
    assert.equal(single.gps.sources.get('direct.GP').samples.length,1);
});

test('per-source histories and source registry stay bounded and stale sensors are removed', () => {
    const normalizer = new SensorNormalizer({maxSamplesPerSource:5,maxSources:3,historyWindowMs:1000,sourceRetentionMs:10000});
    for(let ms=0;ms<1000;ms+=10) normalizer.ingest(event('primary',ms));
    assert.equal(normalizer.gps.sources.get('primary').samples.length,5);
    normalizer.tick(origin+1000);
    for(let i=0;i<10;i++)normalizer.ingest(event(`reserve-${i}`,1100+i));
    assert.equal(normalizer.gps.sources.size,3);
    assert.ok(normalizer.gps.sources.has('primary'));
    normalizer.tick(origin+3000);
    assert.ok([...normalizer.gps.sources.values()].every(state=>state.samples.length===0));
    normalizer.tick(origin+12000);
    assert.equal(normalizer.gps.sources.size,0);
    assert.equal(gps(normalizer.tick(origin+13000)).status,'UNAVAILABLE');
});

test('plugin distributes only DerivedData GPS, blocks raw bypass and clears position on normalization failure', () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const nodePath = require('node:path');
    const { createRequire } = require('node:module');
    const localRequire = createRequire(nodePath.join(__dirname, '../index.js'));
    const intervals = new Map(), subscriptions = [], routes = new Map(), published = [];
    const production = { raw: {}, writes: [], samples: 0 };
    let latestNormalizer, latestDerived, subscriptionStops = 0, sessionTicks = 0, nextTimer = 0;
    const overrides = {
        fs: { existsSync: () => true, readdirSync: () => [] },
        './wind/windEngine': { WindEngine: class {
            getRaw() { return production.raw; }
            getRawTimes() { return {}; }
            processIncomingDelta(path, value, time) { production.writes.push({ path, value, time });production.raw[path] = value; }
            applyNormalizedPosition(measurement) { production.writes.push({normalized:true,measurement});production.raw[path] = measurement?.valid ? measurement.value : null; }
            applyDerivedVmg(measurement) { production.vmg=measurement; }
            applyNormalizedAngle(path,measurement) { production.raw[path]=measurement?.valid?measurement.value:null; }
            applyNormalizedStw(measurement) { production.raw['navigation.speedThroughWater']=measurement?.valid?measurement.value:null; }
            applyNormalizedTws(measurement) { production.raw['environment.wind.speedTrue']=measurement?.valid?measurement.value:null; }
            applyNormalizedDepth(measurement) { production.raw['environment.depth.belowTransducer']=measurement?.valid?measurement.value:null; }
            applyNormalizedAws(measurement) { production.raw['environment.wind.speedApparent']=measurement?.valid?measurement.value:null; }
            applyNormalizedSog(measurement) { production.raw['navigation.speedOverGround']=measurement?.valid?measurement.value:null; }
            sampleHistory() { production.samples++; }
        } },
        './ais/aisEngine': { AisEngine: class {
            constructor() { this.sharedAlerts = {}; }
            refreshOwnGeometry() {}
            updateWindEvidence() {}
            updateOwnGeometry() { return false; }
            getNearbyVessels() { return []; }
            getHarborClusters() { return []; }
            getOwnMotion() { return null; }
            publishSharedAlerts() {}
        } },
        './sensors/SensorNormalizer': { SensorNormalizer: class extends SensorNormalizer { constructor() { super();latestNormalizer = this; } } },
        './sensors/SensorDerivedData': { SensorDerivedData: class extends SensorDerivedData { constructor() { super();latestDerived = this; } } },
        './session/dashboardSession': { DashboardSession: class { tick() { sessionTicks++; } }, registerDashboardRoutes() {} },
    };
    const context = { Buffer, module:{ exports:{} }, __dirname:nodePath.join(__dirname, '..'),
        require(name) { return Object.prototype.hasOwnProperty.call(overrides,name) ? overrides[name] : localRequire(name); },
        setInterval(callback, delay) { const id=++nextTimer;intervals.set(id,{callback,delay});return id; },
        clearInterval(id) { intervals.delete(id); }, setTimeout() { return 0; }, clearTimeout() {},
    };
    vm.runInNewContext(fs.readFileSync(nodePath.join(__dirname,'../index.js'),'utf8'), context);
    const app = { selfContext:'vessels.own', debug() {}, error(error) { throw Error(error); },
        get(path,handler) { routes.set(path,handler); },
        handleMessage(_plugin,message) { published.push(message); },
        subscriptionmanager:{ subscribe(command,unsubscribes,error,callback,_user,sourcePolicy) {
            subscriptions.push({command,callback,sourcePolicy});unsubscribes.push(()=>subscriptionStops++);
        } },
    };
    const plugin=context.module.exports(app);
    plugin.start({aisAlerter:{thresholdPolicyVersion:1}});
    const now=Date.now();
    const incoming={context:'vessels.self',updates:[{$source:'gps',timestamp:new Date(now).toISOString(),values:[{path,value:position}]}]};
    const shadow=subscriptions.find(sub=>sub.sourcePolicy==='all');
    const existing=subscriptions.find(sub=>sub.sourcePolicy!== 'all');
    assert.ok(shadow);assert.ok(existing);
    shadow.callback(incoming);
    const normalTick=[...intervals.values()].find(timer=>timer.delay===1000).callback;
    normalTick();
    assert.equal(latestNormalizer.gps.sources.size,1);
    assert.deepEqual(gps(latestDerived.getSnapshot()).value,position);
    assert.equal(production.writes.length,1);
    assert.equal(production.writes[0].normalized,true);
    assert.deepEqual(production.raw[path],position);
    assert.equal(production.samples,1);assert.equal(sessionTicks,1);
    assert.equal(published.length,1,'only the existing configuration announcement was published');
    let frame;
    routes.get('/rotevista-live-input')({}, {header(){},json(value){frame=value;}});
    assert.deepEqual(frame.raw[path],position);
    assert.equal(frame.normalizedPosition,true);
    assert.equal(frame.positionMeasurement.timestamp,now);
    assert.equal(frame.measurements,undefined);
    for (const [sensorPath,name] of [
        ['navigation.speedThroughWater','Stw',2],
        ['environment.wind.speedTrue','Tws',8],
        ['environment.depth.belowTransducer','Depth',4],
    ]) {
        // The actual normalized branch is called by index, and no legacy
        // subscription may overwrite these selected values.
        assert.equal(frame['normalized'+name],true);
        assert.ok(!existing.command.subscribe.some(row=>row.path===sensorPath));
        existing.callback({context:'vessels.self',updates:[{timestamp:new Date(now).toISOString(),values:[{path:sensorPath,value:999}]}]});
        assert.notEqual(production.raw[sensorPath],999);
    }
    existing.callback(incoming);
    assert.equal(production.writes.length,1);assert.deepEqual(production.raw[path],position);
    // Normalization failures invalidate GPS but do not stop the remaining 1Hz work.
    latestNormalizer.tick=()=>{throw Error('test shadow failure');};
    normalTick();assert.equal(production.samples,2);assert.equal(sessionTicks,2);
    assert.equal(production.raw[path],null);
    plugin.stop();assert.equal(intervals.size,0);assert.equal(subscriptionStops,2);
});

test('score exposes independent historical contributions without inventing GNSS accuracy', () => {
    const normalizer = new SensorNormalizer();
    for (let ms=0;ms<=5000;ms+=1000) normalizer.ingest(event('gps.GP',ms,position,ms,info));
    const assessment=normalizer.getSourceDiagnostics(origin+5000)[0];
    assert.equal(assessment.score,100);
    assert.equal(assessment.metrics.typicalIntervalMs,1000);
    assert.equal(assessment.metrics.validFixes,6);
    assert.deepEqual(assessment.declaredGpsQuality,{available:false,value:null});
    assert.ok(Math.abs(Object.values(assessment.components).reduce((sum,component)=>sum+component.points,0)-assessment.score)<1e-9);
    assessment.components.coherence.points=0;
    assert.equal(normalizer.getSourceDiagnostics(origin+5000)[0].components.coherence.factor,1,'diagnostic reads are detached');
    assert.equal(gps(normalizer.tick(origin+5000)).sourceScore,100);
    const later=normalizer.getSourceDiagnostics(origin+6000)[0];
    assert.equal(later.metrics.observationCount,6);
    assert.deepEqual(Object.keys(later.components),['freshness','coherence','declaredQuality']);
    assert.equal(later.components.coherence.factor,1);
    assert.equal(normalizer.getSourceDiagnostics(origin+245000)[0].score,null,'an expired source cannot win on a good historical score');
});

test('a GPS faster than 1Hz gets no extra score compared with an equally regular 1Hz source', () => {
    const normalizer = new SensorNormalizer();
    for(let ms=0;ms<=5000;ms+=100) {
        normalizer.ingest(event('fast.GP',ms,position,ms,info));
        if(ms%1000===0)normalizer.ingest(event('steady.GP',ms,position,ms,info));
    }
    const rows=normalizer.getSourceDiagnostics(origin+5000);
    assert.equal(rows.find(row=>row.source==='fast.GP').score,rows.find(row=>row.source==='steady.GP').score);
    assert.equal(rows[0].components.frequency,undefined);
});

test('regularity remains diagnostic but no longer contributes a separate score', () => {
    const normalizer=new SensorNormalizer();
    for(let ms=0;ms<=10000;ms+=1000) {
        normalizer.ingest(event('steady.GP',ms,position,ms,info));
        if(ms<=4000||ms===10000)normalizer.ingest(event('interrupted.GP',ms,position,ms,info));
    }
    const rows=normalizer.getSourceDiagnostics(origin+10000);
    const regular=rows.find(row=>row.source==='steady.GP');
    const interrupted=rows.find(row=>row.source==='interrupted.GP');
    assert.equal(interrupted.metrics.typicalIntervalMs,1000);
    assert.ok(interrupted.metrics.intervalVariationRatio>0);
    assert.equal(interrupted.components.regularity,undefined);
    assert.equal(regular.score,interrupted.score);
    assert.equal(gps(normalizer.tick(origin+10000)).source,'interrupted.GP');
});

test('fresh recovered positions retain penalties for recent invalid fixes and jumps until history expires', () => {
    const normalizer=new SensorNormalizer();
    for(let ms=0;ms<=5000;ms+=500) {
        if(ms%1000===0) {
            normalizer.ingest(event('steady.GP',ms,position,ms,info));
            normalizer.ingest(event('erratic.GP',ms,position,ms,info));
        } else normalizer.ingest(event('erratic.GP',ms,{latitude:37,longitude:14},ms,info));
    }
    const before=normalizer.getSourceDiagnostics(origin+5000).find(row=>row.source==='erratic.GP');
    assert.equal(before.eligible,true);
    assert.equal(before.metrics.jumpRejections,5);
    assert.equal(before.metrics.rejectedFixes,5);
    assert.ok(before.components.coherence.factor<1);
    assert.equal(gps(normalizer.tick(origin+5000)).source,'steady.GP');
    assert.equal(normalizer.ingest(event('erratic.GP',5000,position,6000,info)),false);
    const replay=normalizer.getSourceDiagnostics(origin+6000).find(row=>row.source==='erratic.GP');
    assert.equal(replay.metrics.observationCount,before.metrics.observationCount);
    assert.equal(replay.components.coherence.points,before.components.coherence.points);
    normalizer.ingest(event('erratic.GP',910000,position,910000,info));
    const recovered=normalizer.getSourceDiagnostics(origin+910000).find(row=>row.source==='erratic.GP');
    assert.equal(recovered.metrics.rejectedFixes,0);
    assert.equal(recovered.components.coherence.factor,1);
});

test('reception delay is diagnostic without duplicating the freshness score', () => {
    const normalizer=new SensorNormalizer();
    const arrivals=[];
    for(let ms=0;ms<=5000;ms+=1000) {
        arrivals.push(event('on-time.GP',ms,position,ms,info));
        arrivals.push(event('delayed.GP',ms,position,ms+2000,info));
    }
    arrivals.sort((a,b)=>a.receivedAt-b.receivedAt).forEach(sample=>normalizer.ingest(sample));
    const rows=normalizer.getSourceDiagnostics(origin+7000);
    const fast=rows.find(row=>row.source==='on-time.GP'),slow=rows.find(row=>row.source==='delayed.GP');
    assert.equal(fast.metrics.ageMs,slow.metrics.ageMs);
    assert.equal(slow.metrics.meanLatencyMs,2000);
    assert.equal(fast.components.latency,undefined);
    assert.equal(fast.score,slow.score);
    assert.equal(gps(normalizer.tick(origin+7000)).source,'delayed.GP');
});

test('score weights can be inspected and tuned without confusing unknown quality with bad quality', () => {
    const weights={freshness:0,coherence:100,declaredQuality:0};
    const normalizer=new SensorNormalizer({},weights);
    normalizer.ingest(event('unknown',0));
    const row=normalizer.getSourceDiagnostics(origin)[0];
    assert.equal(row.score,100);
    assert.equal(row.declaredGpsQuality.available,false);
    assert.equal(row.components.declaredQuality.available,false);
    assert.equal(row.components.declaredQuality.factor,null);
    assert.throws(()=>new SensorNormalizer({},{coherence:-1}));
    assert.throws(()=>new SensorNormalizer({},{unrecognized:10}));
});
