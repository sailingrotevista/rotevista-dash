const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CollisionPipeline, applyHarborProximityPolicy } = require('../collisionPipeline');
const { AisEngine } = require('../aisEngine');

function fixture({ distance = 1000, clustered = false, speed = 0, large = false, bubble = 45 } = {}) {
    const now = Date.now();
    const length = large ? 200 : 12, width = large ? 40 : 4;
    const engine = new AisEngine({ getPath: () => ({ boat: {
        design: { length: { value: { overall: length } }, beam: { value: width } },
        navigation: {
            position: { value: { latitude: 36 + distance / 111139, longitude: 14 }, timestamp: new Date(now).toISOString() },
            speedOverGround: { value: speed / 1.94384 }, courseOverGroundTrue: { value: Math.PI },
            headingTrue: { value: 0 }, state: { value: speed ? 'under way' : 'anchored' },
        },
    } }), error: message => { throw Error(message); } },
    () => ({ aisAlerter: { baseTcpaMinutes: 10, criticalProximity: bubble } }),
    { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 }, 'navigation.speedOverGround': 3 / 1.94384, 'navigation.courseOverGroundTrue': 0 }) },
    { processHarbors: targets => {
        if (!clustered) return [];
        for (const t of targets) { t.inCluster = true; t.clusterId = 'port'; }
        return [{ id: 'port', lat: 36, lon: 14 }];
    } }, new CollisionPipeline());
    engine.process();
    return { target: engine.getNearbyVessels()[0], top: engine.getTopThreat(), engine };
}

test('a 200m anchored ship outside recognized areas remains a collision obstacle at 3kn own speed', () => {
    const { target, top } = fixture({ large: true });
    assert.equal(target.isMoving, false);
    assert.equal(target.risk, 'RED');
    assert.equal(target.cpa, 0);
    assert.equal(top.id, target.id);
    assert.equal(target.areaProximityOnly, undefined);
});

test('a stationary member of an existing area does not warn for a future route intersection', () => {
    const { target, top } = fixture({ clustered: true });
    assert.equal(target.risk, 'GREY');
    assert.equal(target.areaProximityOnly, true);
    assert.equal(target.cpa, null);
    assert.equal(target.tcpa, -1);
    assert.ok(target.currentHullClearanceMeters > 45);
    assert.equal(top, null);
});

test('safe bubble uses present hull clearance, not antenna range or future CPA', () => {
    const { target, top } = fixture({ clustered: true, distance: 50 });
    assert.equal(target.dist, 50);
    assert.ok(target.currentHullClearanceMeters < 45);
    assert.equal(target.risk, 'ORANGE');
    assert.equal(target.alertKind, 'PROXIMITY');
    assert.equal(target.safeBubbleMeters, 45);
    assert.equal(target.cpa, null);
    assert.equal(top, null, 'first discovery inside remains visible without a startup banner');
    assert.equal(target.proximityEntryObserved, false);
    assert.equal(fixture({ clustered: true, distance: 50, bubble: 10 }).target.risk, 'GREY');
});

test('moving targets retain normal collision alarms even if marked inside an area', () => {
    const { target } = fixture({ clustered: true, speed: 1 });
    assert.equal(target.isMoving, true);
    assert.equal(target.risk, 'RED');
    assert.equal(target.alertKind, undefined);
    assert.notEqual(target.cpa, null);
    const inconsistent = { inCluster: true, isMoving: false, motionState: 'MOVING', risk: 'RED', alertKind: 'PROXIMITY', areaProximityOnly: true };
    applyHarborProximityPolicy(inconsistent);
    assert.equal(inconsistent.risk, 'RED');
    assert.equal(inconsistent.areaProximityOnly, undefined);
    assert.equal(inconsistent.alertKind, undefined);
});

test('proximity acknowledgement has no timer and does not rearm after leaving the bubble', async () => {
    const { proximityAcknowledgementExpired } = await import('../src/utils/proximityAcknowledgement.mjs');
    const area = { id: 'port', lat: 36, lon: 14 };
    for (const metres of [0, 100, 20, 1000, 30]) {
        assert.equal(proximityAcknowledgementExpired(area, { isMoving: false, risk: 'GREY' }, { lat: 36 + metres / 111139, lon: 14 }), false);
    }
    assert.equal(proximityAcknowledgementExpired(area, undefined, null), false);
    assert.equal(proximityAcknowledgementExpired(area, { isMoving: true }, { lat: 36, lon: 14 }), true);
    assert.equal(proximityAcknowledgementExpired(area, { isMoving: false }, { lat: 36 + 4000 / 111139, lon: 14 }), true);
});
