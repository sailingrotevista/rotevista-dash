const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TargetMotionTracker } = require('../targetMotionTracker');
const { AisEngine } = require('../aisEngine');
const { HarborDetector } = require('../harborDetector');
const { CollisionPipeline } = require('../collisionPipeline');

function fix(seconds, meters, sog = 0, east = 0) {
    return { t: seconds * 1000, lat: 36 + meters / 111139, lon: 14 + east / (111139 * Math.cos(Math.PI / 5)), sog, cog: 0 };
}
function observe(tracker, p, hints = {}) {
    return tracker.update('boat', p, { now: p.t, historyMs: 1800000, ...hints });
}

test('only new, ordered fixes count; no duplicate or projected observations', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 0));
    observe(tracker, fix(30, 50, 1));
    for (let i = 0; i < 50; i++) observe(tracker, fix(30, 100, 1));
    assert.equal(tracker.targets.get('boat').observations.length, 2);
    assert.equal(tracker.get('boat', 30000, 1800000).motionState, 'POSSIBLE_MOVEMENT');
    observe(tracker, fix(20, 90, 1));
    assert.equal(tracker.targets.get('boat').lastFix.t, 30000);
});

test('a tolerated future source timestamp is still a single received observation', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, { ...fix(0, 0), sourceTime: 30000 });
    observe(tracker, { ...fix(15, 0), sourceTime: 30000 });
    assert.equal(tracker.targets.get('boat').observations.length, 1);
});

test('moored jitter and a speed spike stay stationary; returning outlier clears suspicion', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 0), { moored: true });
    for (let i = 1; i <= 12; i++) {
        assert.equal(observe(tracker, fix(i * 30, i % 2 ? 8 : -8, i === 5 ? 1.2 : 0)).motionState, 'STATIONARY');
    }
    assert.equal(observe(tracker, fix(390, 150, 1.2)).motionState, 'POSSIBLE_MOVEMENT');
    assert.equal(observe(tracker, fix(420, 2)).motionState, 'STATIONARY');
});

test('anchor oscillation stays in its area while a slow departure is confirmed', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 0), { anchored: true });
    for (let i = 1; i <= 6; i++) {
        assert.equal(observe(tracker, fix(i * 30, i % 2 ? 45 : -45, 1), { anchored: true }).isMoving, false);
    }
    assert.equal(observe(tracker, fix(210, 80, 1), { anchored: true }).motionState, 'POSSIBLE_MOVEMENT');
    assert.equal(observe(tracker, fix(240, 96, 1), { anchored: true }).motionState, 'MOVING');
});

test('stationary reference does not drift with a slow departure and stale moored status', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 0), { moored: true });
    for (let i = 1; i <= 5; i++) observe(tracker, fix(i * 30, i * 15, 1), { moored: true });
    assert.equal(tracker.get('boat', 150000, 1800000).isMoving, true);
    assert.equal(tracker.targets.get('boat').area.lat, 36);
});

test('returning anchor swing learns a bounded area without following a departure', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 50), { anchored: true });
    observe(tracker, fix(30, 0), { anchored: true });
    assert.equal(observe(tracker, fix(60, -50), { anchored: true }).motionState, 'POSSIBLE_MOVEMENT');
    observe(tracker, fix(90, 0), { anchored: true });
    const area = tracker.targets.get('boat').area;
    assert.ok(Math.abs((area.lat - 36) * 111139) < 20);
    assert.ok(area.radius <= 80);
    assert.equal(observe(tracker, fix(120, -50), { anchored: true }).isMoving, false);
});

test('late anchor metadata changes context without creating another position observation', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 0));
    observe(tracker, fix(0, 0), { anchored: true });
    assert.equal(tracker.targets.get('boat').observations.length, 1);
    assert.equal(tracker.targets.get('boat').area.radius, 60);
});

test('a confirmed slow target is not discarded by the collision velocity threshold', () => {
    const pipeline = new CollisionPipeline();
    const result = pipeline.evaluateTarget({ lat: 36, lon: 14, sog: 0, cog: 0 }, {
        id: 'slow', lat: 36.0001, lon: 14, sog: 0.6, cog: 180,
        isMoving: true, lastUpdate: Date.now(),
    });
    assert.equal(result.alertState, 'RED');
});

test('a moving target must actually stop for long enough before becoming stationary', () => {
    const tracker = new TargetMotionTracker();
    assert.equal(observe(tracker, fix(0, 0, 5)).isMoving, true);
    assert.equal(observe(tracker, fix(30, 100, 0)).isMoving, true);
    for (let i = 2; i <= 6; i++) observe(tracker, fix(i * 30, 100 + i % 2, 0));
    assert.equal(tracker.get('boat', 180000, 1800000).motionState, 'STATIONARY');
});

test('slow AIS reporting every three minutes can also confirm a stop', () => {
    const tracker = new TargetMotionTracker();
    observe(tracker, fix(0, 0, 2));
    observe(tracker, fix(180, 2, 0));
    assert.equal(observe(tracker, fix(360, 1, 0)).motionState, 'STATIONARY');
});

test('all histories are bounded, stationary history is kept privately and obsolete targets are pruned', () => {
    const tracker = new TargetMotionTracker();
    for (let i = 0; i < 500; i++) observe(tracker, fix(i, i % 2, 0));
    const state = tracker.targets.get('boat');
    assert.ok(state.observations.length <= 120);
    assert.equal(state.trail.length, 60);
    assert.equal(state.trail[0].t, 0);
    assert.equal(state.trail.at(-1).t, 499000);
    tracker.prune(new Set());
    assert.equal(tracker.targets.size, 0);
});

test('engine and harbor keep a moored speed spike fixed but release a genuine departure', () => {
    const start = Date.now();
    const actualNow = Date.now;
    let clock = start;
    let point = fix(0, 0);
    const pipeline = new CollisionPipeline();
    const detector = new HarborDetector();
    const app = { getPath: () => ({ boat: { navigation: {
        position: { value: { latitude: point.lat, longitude: point.lon }, timestamp: new Date(start + point.t).toISOString() },
        speedOverGround: { value: point.sog / 1.94384 }, courseOverGroundTrue: { value: 0 }, state: { value: 'moored' },
    } } }), error: message => { throw Error(message); } };
    const engine = new AisEngine(app, () => ({ aisAlerter: { vectorMinutes: 30 } }),
        { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14.001 } }) }, detector, pipeline);
    Date.now = () => clock;
    const process = p => { point = p; clock = start + p.t; engine.process(); return engine.getNearbyVessels()[0]; };
    try {
        assert.equal(process(fix(0, 0)).isMoored, true);
        const jitter = process(fix(30, 5, 1.2));
        assert.equal(jitter.isMoving, false);
        assert.equal(jitter.isProjected, false);
        assert.equal(jitter.isMoored, true);
        assert.deepEqual(jitter.trail, []);
        clock += 30000;
        engine.process();
        assert.equal(engine.getNearbyVessels()[0].lat, jitter.lat, 'no extrapolation of a speed spike');
        assert.equal(process(fix(90, 45, 1)).motionState, 'POSSIBLE_MOVEMENT');
        clock += 30000;
        engine.process();
        assert.ok(Math.abs(engine.getNearbyVessels()[0].lat - point.lat) < 1e-7, 'unconfirmed movement is not projected');
        const departure = process(fix(120, 61, 1));
        assert.equal(departure.isMoving, true);
        assert.equal(departure.isMoored, false);
        assert.equal(departure.inCluster, false);
        assert.ok(departure.trail.length > 0);
        clock += 14999;
        engine.process();
        assert.ok(Math.abs(engine.getNearbyVessels()[0].lat - departure.lat) < 1e-7, 'hold received position before 15s');
        clock += 1;
        engine.process();
        const projected = engine.getNearbyVessels()[0];
        const expectedLat = point.lat + (1852 * 15 / 3600) / 111139;
        assert.ok(Math.abs(projected.lat - expectedLat) < 1e-7, 'project a confirmed 1kn departure from the received fix');
        assert.equal(projected.lastPositionTime, departure.lastPositionTime);
        assert.equal(projected.age, 15);
        assert.equal(projected.isProjected, true);
        clock += 361000;
        // Remove the vessel from Signal K's tree; both caches must expire together.
        app.getPath = () => ({});
        engine.process();
        assert.equal(engine.getNearbyVessels().length, 0);
        assert.equal(engine.motionTracker.targets.size, 0);
    } finally { Date.now = actualNow; }
});
