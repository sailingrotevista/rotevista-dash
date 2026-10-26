const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AisEngine } = require('../ais/aisEngine');
const { getHullBoundingRadius } = require('../ais/collisionPipeline');

function engine(app = {}, pipeline = {}) {
    return new AisEngine(app, () => ({}), { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 } }) },
        { processHarbors: () => [] }, {
            updateConfig() {}, evaluateTarget() { return null; }, pruneInactive() {}, sortTargets() {}, targetStates: new Map(), ...pipeline,
        });
}

test('initial static lookup is cached once all dimensions and offsets are available', () => {
    const data = { 'design.length': { value: { overall: 14 } }, 'design.beam': { value: 4 },
        'sensors.gps.fromBow': { value: 10 }, 'sensors.gps.fromCenter': { value: 0.5 } };
    let calls = 0;
    const e = engine({ getSelfPath: path => { calls++; return data[path] ?? null; } });
    e.refreshOwnGeometry(0);
    const initialCalls = calls;
    e.refreshOwnGeometry(15000);
    e.refreshOwnGeometry(120000);
    assert.equal(calls, initialCalls);
    assert.deepEqual(e.getOwnGeometry(), { length: 14, beam: 4, antBow: 10, antStern: 4, antPort: 1.5, antStarboard: 2.5 });
});

test('missing data retries only after 60 seconds and accepts late availability', () => {
    let calls = 0; const data = {};
    const e = engine({ getSelfPath: path => { calls++; return data[path]; } });
    e.refreshOwnGeometry(0);
    const first = calls;
    data['design.length'] = { value: { overall: 11 } };
    e.refreshOwnGeometry(59000);
    assert.equal(calls, first);
    e.refreshOwnGeometry(60000);
    assert.equal(e.getOwnGeometry().length, 11);
});

test('live deltas update cached geometry, including zero and negative lateral offsets', () => {
    const e = engine();
    assert.equal(e.updateOwnGeometry('navigation.position', {}), false);
    e.updateOwnGeometry('design.length.overall', 10);
    e.updateOwnGeometry('design.beam', 4);
    e.updateOwnGeometry('sensors.gps.fromBow', 0);
    e.updateOwnGeometry('sensors.gps.fromCenter', -1);
    assert.deepEqual(e.getOwnGeometry(), { length: 10, beam: 4, antBow: 0, antStern: 10, antPort: 3, antStarboard: 1 });
    e.updateOwnGeometry('sensors.gps.fromCenter', 0);
    assert.equal(e.getOwnGeometry().antPort, 2);
    e.updateOwnGeometry('design.length', { overall: 12 });
    assert.equal(e.getOwnGeometry().antStern, 12);
});

test('invalid dimensions and inconsistent offsets do not enter hull calculations', () => {
    const e = engine();
    for (const value of [0, -10, Infinity, NaN, '12']) e.updateOwnGeometry('design.length', value);
    assert.deepEqual(e.getOwnGeometry(), {});
    assert.equal(getHullBoundingRadius(e.getOwnGeometry(), 'sailing').loa, 12);
    e.updateOwnGeometry('design.length', { overall: 10 });
    e.updateOwnGeometry('design.beam', 4);
    e.updateOwnGeometry('sensors.gps.fromBow', 11);
    e.updateOwnGeometry('sensors.gps.fromCenter', 3);
    assert.deepEqual(e.getOwnGeometry(), { length: 10, beam: 4 });
    e.updateOwnGeometry('sensors.gps.fromBow', 8);
    e.updateOwnGeometry('sensors.gps.fromCenter', 0);
    assert.equal(e.getOwnGeometry().antStern, 2);
    e.updateOwnGeometry('design.beam', null);
    assert.equal(e.getOwnGeometry().antPort, undefined);
});

test('fallback reads the real self vessel id and supports nested overall values', () => {
    const e = engine({ selfId: 'urn:self', getPath: path => ({
        'vessels.urn:self.design.length': { overall: { value: 13 } },
        'vessels.urn:self.design.beam': 4.2,
    })[path] });
    e.refreshOwnGeometry(0);
    assert.deepEqual(e.getOwnGeometry(), { length: 13, beam: 4.2 });
});

test('the AIS engine passes own and target dimensions, offsets and target heading into the pipeline', () => {
    let own, target;
    const e = engine({
        getSelfPath: path => ({ 'design.length': { value: { overall: 15 } }, 'design.beam': 5,
            'sensors.gps.fromBow': 11, 'sensors.gps.fromCenter': 0.5 })[path],
        getPath: path => path === 'vessels' ? { target: {
            design: { length: { value: { overall: 120 } }, beam: { value: 20 } },
            sensors: { ais: { fromBow: { value: 110 }, fromCenter: { value: 1 } } },
            navigation: {
            position: { value: { latitude: 36.01, longitude: 14 }, timestamp: new Date().toISOString() },
            speedOverGround: { value: 3 },
            headingTrue: { value: 0 },
        } } } : undefined,
        error: message => { throw Error(message); },
    }, { evaluateTarget: (value, other) => { own = value; target = other; return null; } });
    e.process();
    assert.equal(own.length, 15);
    assert.equal(own.beam, 5);
    assert.equal(own.antBow, 11);
    assert.equal(own.antStern, 4);
    assert.equal(own.antPort, 2);
    assert.equal(own.antStarboard, 3);
    assert.equal(e.getDiagnostics().ownShipGeometry.length, 15);
    assert.equal(target.antBow, 110);
    assert.equal(target.antStern, 10);
    assert.equal(target.antPort, 9);
    assert.equal(target.antStarboard, 11);
    assert.equal(target.hdg, 0);
});
