const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TargetMotionTracker } = require('../ais/targetMotionTracker');

function fix(seconds, north, east = 0) {
    return { t: seconds * 1000, lat: 36 + north / 111139, lon: 14 + east / (111139 * Math.cos(Math.PI / 5)), sog: 0, cog: 0 };
}
function update(tracker, seconds, north, hints = {}) {
    const point = fix(seconds, north);
    return tracker.update('vessel', point, { now: point.t, historyMs: 1800000, ...hints });
}

test('a compact stationary cloud confirms a fixed rest pattern from real fixes', () => {
    const tracker = new TargetMotionTracker();
    let result;
    for (const [i, metres] of [0, 3, -3, 2, -2, 1].entries()) result = update(tracker, i * 75, metres);
    const pattern = result.restPattern;
    assert.equal(pattern.kind, 'FIXED');
    assert.equal(pattern.confirmed, true);
    assert.equal(pattern.observedDurationSeconds, 375);
    assert.equal(pattern.sampleCount, 6);
    assert.ok(pattern.radiusMeters < 5);
    assert.ok(pattern.dispersionMeters <= pattern.radiusMeters);
    assert.ok(Math.abs(pattern.center.lat - 36) * 111139 < 1);
    assert.equal(pattern.returnCount, 0);
});

test('bounded repeated excursions and returns describe oscillation without AIS anchor metadata', () => {
    const tracker = new TargetMotionTracker();
    let result;
    for (const [i, metres] of [0, 28, 0, -28, 0, 28, 0].entries()) result = update(tracker, i * 75, metres);
    assert.equal(result.motionState, 'STATIONARY');
    assert.equal(result.restPattern.kind, 'OSCILLATING');
    assert.equal(result.restPattern.confirmed, true);
    assert.equal(result.restPattern.returnCount, 3);
    assert.ok(result.restPattern.radiusMeters >= 20);
    assert.equal(tracker.targets.get('vessel').area.lat,36,'descriptive centre never moves the rest reference');
});

test('spread without return evidence remains undetermined instead of claiming anchoring', () => {
    const tracker = new TargetMotionTracker();
    let result;
    for (let i = 0; i <= 6; i++) result = update(tracker, i * 75, i * 5);
    assert.equal(result.restPattern.confirmed, true);
    assert.equal(result.restPattern.kind, 'UNDETERMINED');
    assert.equal(result.restPattern.returnCount, 0);
});

test('an isolated jump does not inflate the observed area or become an oscillation', () => {
    const tracker = new TargetMotionTracker();
    let result;
    for (const [i, metres] of [0, 2, -2, 1, 0, 150, 1].entries()) result = update(tracker, i * 75, metres);
    assert.equal(result.restPattern.kind, 'FIXED');
    assert.equal(result.restPattern.excludedSamples, 1);
    assert.ok(result.restPattern.radiusMeters < 5);
    assert.equal(result.restPattern.returnCount, 0);
});

test('polling and duplicate fixes cannot mature a rest classification or extend observed duration', () => {
    const tracker = new TargetMotionTracker();
    let result;
    for (let i = 0; i < 4; i++) result = update(tracker, i * 75, i % 2);
    const before = structuredClone(result.restPattern);
    assert.equal(before.confirmed, false);
    tracker.get('vessel', 600000, 1800000);
    result = tracker.update('vessel', fix(225, 1), { now: 600000, historyMs: 1800000, anchored: true });
    assert.deepEqual(result.restPattern, before);
    assert.equal(update(tracker, 300, 0).restPattern.kind, 'FIXED');
});

test('a long reporting gap requires fresh evidence rather than claiming continuous observed rest', () => {
    const tracker = new TargetMotionTracker();
    for (let i = 0; i <= 5; i++) update(tracker, i * 75, 0);
    const result = update(tracker, 736, 0);
    assert.equal(result.restPattern.kind, 'UNDETERMINED');
    assert.equal(result.restPattern.confirmed, false);
    assert.equal(result.restPattern.sampleCount, 1);
    assert.equal(result.restPattern.observedDurationSeconds, 0);
});

test('descriptive centre cannot move the reference and a confirmed three-fix departure clears rest description',()=>{
 const tracker=new TargetMotionTracker();for(let i=0;i<=5;i++)update(tracker,i*75,0);
 const reference=tracker.targets.get('vessel').area.lat;
 const local=update(tracker,450,45);
 assert.equal(local.motionState,'STATIONARY');assert.equal(tracker.targets.get('vessel').area.lat,reference);
 const moving=update(tracker,525,320);
 assert.equal(moving.motionState,'MOVING');assert.equal(moving.restPattern,null);
 assert.equal(tracker.targets.get('vessel').area.lat,reference);
});
