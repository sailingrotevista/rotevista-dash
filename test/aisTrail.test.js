const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactAisTrail, AisEngine } = require('../aisEngine');

test('compression caps the count while preserving the full available time span', () => {
    const points = Array.from({ length: 241 }, (_, i) => ({ t: i * 15000, lat: 36 + i * 0.0001, lon: 14 }));
    const result = compactAisTrail(points, 3600000, 3600000);
    assert.equal(result.length, 60);
    assert.equal(result[0].t, 0);
    assert.equal(result.at(-1).t, 3600000);
    assert.equal(points.length, 241);
    assert.ok(result.every((p, i) => !i || p.t > result[i - 1].t));
});

test('streaming compaction retains old history instead of just the last 60 reports', () => {
    let points = [];
    for (let i = 0; i <= 240; i++) {
        points.push({ t: i * 15000, lat: 36 + i * 0.0001, lon: 14 });
        points = compactAisTrail(points, i * 15000, 3600000);
        assert.ok(points.length <= 60);
    }
    assert.equal(points[0].t, 0);
    assert.equal(points.at(-1).t, 3600000);
});

test('expiry removes every old point, even when fewer than two remain', () => {
    const points = [{ t: 0, lat: 36, lon: 14 }, { t: 1000, lat: 36.001, lon: 14 }];
    assert.deepEqual(compactAisTrail(points, 100000, 10000), []);
    assert.deepEqual(compactAisTrail([{ ...points[0], t: 110000 }], 100000, 10000), []);
});

test('compression preserves a significant turn amongst dense straight points', () => {
    const points = Array.from({ length: 61 }, (_, i) => ({ t: i * 1000, lat: 36 + i * 0.00001, lon: 14 + (i === 30 ? 0.002 : 0) }));
    const result = compactAisTrail(points, 60000, 60000);
    assert.ok(result.some(p => p.t === 30000));
});

test('engine retention reads aisAlerter.vectorMinutes and follows configuration changes', () => {
    const now = Date.now();
    let minutes = 30;
    const e = new AisEngine({ getPath: () => ({}), error: message => { throw Error(message); } },
        () => ({ aisAlerter: { vectorMinutes: minutes } }),
        { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 } }) },
        { processHarbors: () => [] },
        { updateConfig() {}, evaluateTarget() { return null; }, pruneInactive() {}, sortTargets() {}, targetStates: new Map() });
    e.aisPersistentCache.target = {
        id: 'target', lat: 36.001, lon: 14, sog: 5, cog: 0, lastSeen: now,
    };
    for (const age of [20, 10, 1]) {
        const t = now - age * 60000;
        e.motionTracker.update('target', { lat: 36 + (20 - age) * 0.001, lon: 14, t, sog: 5 },
            { now: t, historyMs: 30 * 60000 });
    }
    e.process();
    assert.equal(e.getNearbyVessels()[0].trail.length, 3);
    minutes = 5;
    e.process();
    assert.equal(e.getNearbyVessels()[0].trail.length, 1);
});
