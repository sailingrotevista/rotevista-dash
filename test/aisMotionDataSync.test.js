const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMotionDataSync, AisEngine } = require('../ais/aisEngine');
const { CollisionPipeline } = require('../ais/collisionPipeline');

test('coherent reports remain in sync regardless of their absolute age', () => {
    const result = evaluateMotionDataSync(1000000 - 180000, 1000000 - 180000, 1000000 - 180000, 5);
    assert.equal(result.status, 'IN_SYNC');
    assert.equal(result.cogSkewSeconds, 0);
    assert.equal(result.sogSkewSeconds, 0);
});

test('each motion timestamp is compared with position using 20% of the effective window', () => {
    assert.equal(evaluateMotionDataSync(1000000, 940000, 1000000, 5).status, 'IN_SYNC');
    assert.equal(evaluateMotionDataSync(1000000, 939000, 1000000, 5).status, 'OUT_OF_SYNC');
    assert.equal(evaluateMotionDataSync(1000000, 1000000, 819000, 15).status, 'OUT_OF_SYNC');
    assert.equal(evaluateMotionDataSync(1000000, 1000000, 820000, 15).status, 'IN_SYNC');
    assert.equal(evaluateMotionDataSync(1000000, null, 1000000, 5).status, 'UNKNOWN');
    assert.equal(evaluateMotionDataSync(1000000, null, 900000, 5).status, 'OUT_OF_SYNC');
});

test('the engine publishes motion timestamps and diagnostics without changing speed, course or risk', () => {
    const now = Date.now();
    let motionTime = now - 180000;
    const engine = new AisEngine({ getPath: () => ({ boat: { navigation: {
        position: { value: { latitude: 36.005, longitude: 14 }, timestamp: new Date(now).toISOString() },
        speedOverGround: { value: 5 / 1.94384, timestamp: new Date(motionTime).toISOString() },
        courseOverGroundTrue: { value: Math.PI, timestamp: new Date(motionTime).toISOString() },
    } } }), error: message => { throw Error(message); } },
    () => ({ aisAlerter: { baseTcpaMinutes: 5 } }),
    { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 } }) },
    { processHarbors: () => [] }, new CollisionPipeline());
    engine.process();
    const unsynced = engine.getNearbyVessels()[0];
    assert.equal(unsynced.motionDataSync.status, 'OUT_OF_SYNC');
    assert.equal(unsynced.lastCogTime, motionTime);
    assert.equal(unsynced.lastSogTime, motionTime);
    assert.equal(unsynced.risk, 'RED');
    motionTime = now;
    engine.process();
    const synced = engine.getNearbyVessels()[0];
    assert.equal(synced.motionDataSync.status, 'IN_SYNC');
    for (const field of ['cog', 'sog', 'cpa', 'risk']) assert.equal(synced[field], unsynced[field]);
});
