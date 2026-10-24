const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TargetMotionTracker } = require('../targetMotionTracker');
const { HarborDetector } = require('../harborDetector');
function replay(options = {}) {
    const tracker = new TargetMotionTracker();
    let result;
    for (let i = 0; i <= 10; i++) {
        const t = i * 30000;
        result = tracker.update('boat', { lat: 36, lon: 14, t, sog: 0, cog: 200,
            hdg: i % 2 ? 359 : 1, headingTime: options.repeated ? 0 : t },
        { now: t, historyMs: 900000, wind: options.missing ? null : {
            lat: options.distant ? 37 : 36, lon: 14,
            direction: options.ahead ? 0 : 150 + i * 3, speedKnots: options.calm ? 2 : 10,
            directionTime: options.stale ? -400000 : t, speedTime: t,
        } });
    }
    return { tracker, result };
}
test('stable heading with stern wind supports mooring, including wind shifts and north wrap', () => {
    const { result } = replay();
    assert.equal(result.motionState, 'STATIONARY');
    assert.equal(result.restPattern.windMooring.supported, true);
    assert.equal(result.restPattern.windMooring.strong, true);
});
test('missing, stale, calm, distant or head wind and repeated headings cannot establish evidence', () => {
    for (const option of ['missing', 'stale', 'calm', 'distant', 'ahead', 'repeated']) {
        assert.equal(replay({ [option]: true }).result.restPattern.windMooring.supported, false, option);
    }
});
test('wind evidence expires during polling without changing motion or rest classification', () => {
    const { tracker } = replay();
    const result = tracker.get('boat', 600000, 900000);
    assert.equal(result.restPattern.windMooring.supported, false);
    assert.equal(result.restPattern.confirmed, true);
    assert.equal(result.motionState, 'STATIONARY');
});
test('wind evidence strengthens grouping but does not override explicit anchoring', () => {
    function boats(anchored) {
        return [0, 110].map((m, i) => ({ id: String(i), lat: 36 + m / 111139, lon: 14,
            dist: m, length: 12, sog: 0, motionState: 'STATIONARY', reportedNavigationState: anchored ? 'anchored' : '',
            restPattern: { confirmed: true, kind: 'UNDETERMINED', windMooring: { supported: true } } }));
    }
    for (const anchored of [false, true]) {
        const areas = new HarborDetector().processHarbors(boats(anchored), { lat: 36, lon: 14 }, {}, 0, 300000);
        assert.equal(areas[0].kind, anchored ? 'ANCHORAGE' : 'PORT');
    }
});
