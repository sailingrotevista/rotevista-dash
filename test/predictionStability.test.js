const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TargetPredictionStability, predictionUncertaintyRadius } = require('../ais/targetPredictionStability');
const { CollisionPipeline } = require('../ais/collisionPipeline');

function trajectory(courses, interval = 30, speed = 6, actualExtraMps = 0) {
    let lat = 36, lon = 14;
    return courses.map((cog, i) => {
        if (i) {
            const distance = (speed * 1852 / 3600 + actualExtraMps) * interval;
            lat += Math.cos(courses[i - 1] * Math.PI / 180) * distance / 111139;
            lon += Math.sin(courses[i - 1] * Math.PI / 180) * distance / (111139 * Math.cos(lat * Math.PI / 180));
        }
        return { lat, lon, t: i * interval * 1000, cog, sog: speed };
    });
}
function evaluate(points, config) {
    const model = new TargetPredictionStability(config);
    for (const p of points) model.update(p);
    return { model, result: model.get(points.at(-1).t) };
}

test('regular trajectory has no extra radius; lack of history is unknown rather than stable', () => {
    const points = trajectory(Array(8).fill(90));
    const early = evaluate(points.slice(0, 3)).result;
    assert.equal(early.state, 'INSUFFICIENT_DATA');
    assert.equal(predictionUncertaintyRadius(early, 300, points[2].t), null);
    const { result } = evaluate(points);
    assert.equal(result.state, 'STABLE');
    assert.equal(result.uncertaintyGrowthMps, 0);
    assert.equal(predictionUncertaintyRadius(result, 600, points.at(-1).t), 0);
});

test('a single position or course outlier does not become persistent instability', () => {
    for (const variant of ['position', 'course']) {
        const points = trajectory(Array(10).fill(90));
        if (variant === 'position') points[5].lat += 500 / 111139;
        else points[5].cog = 270;
        const { model, result } = evaluate(points);
        assert.equal(result.state, 'STABLE', variant);
        assert.equal(result.uncertaintyGrowthMps, 0);
        assert.equal(model.samples.some(p => p.t === points[5].t), false);
    }
});

test('repeated erratic movement produces a proportional future uncertainty radius', () => {
    const points = trajectory([90, 40, 140, 30, 150, 45, 120, 10]);
    const { model, result } = evaluate(points);
    assert.equal(result.state, 'VARIABLE');
    assert.ok(result.uncertaintyGrowthMps > 0);
    const now = points.at(-1).t;
    const short = predictionUncertaintyRadius(result, 60, now);
    const long = predictionUncertaintyRadius(result, 120, now);
    assert.ok(Math.abs(long - 2 * short) < 1e-8);
    assert.equal(predictionUncertaintyRadius(result, 60, now + 30000), result.uncertaintyGrowthMps * 90);
    const retained = model.get(now + 359000);
    assert.equal(retained.state, 'VARIABLE');
    assert.equal(retained.uncertaintyGrowthMps, result.uncertaintyGrowthMps);
});

test('a decisive turn updates the estimate and then stabilizes on the new regime', () => {
    const points = trajectory([...Array(6).fill(90), ...Array(5).fill(45)]);
    const model = new TargetPredictionStability();
    for (const p of points.slice(0, 7)) model.update(p);
    assert.equal(model.get(points[6].t).state, 'MANEUVERING');
    for (const p of points.slice(7)) model.update(p);
    assert.equal(model.get(points.at(-1).t).state, 'STABLE');
    assert.ok(model.samples.every(p => p.cog === 45));
});

test('longer comparisons detect progressive turns despite perfect consecutive predictions', () => {
    const { result } = evaluate(trajectory([90, 105, 120, 135, 150, 165, 180]));
    assert.equal(result.state, 'VARIABLE');
});

test('prediction errors are normalized by elapsed time', () => {
    const config = { positionToleranceMeters: 0 };
    const a = evaluate(trajectory(Array(8).fill(90), 30, 6, 1), config).result;
    const b = evaluate(trajectory(Array(8).fill(90), 60, 6, 1), config).result;
    assert.ok(Math.abs(a.errorRateMps - b.errorRateMps) < 1e-6);
    assert.ok(Math.abs(a.errorRateMps - 1) < 1e-6);
});

test('three-minute reporting intervals can accumulate sufficient real history', () => {
    const { result } = evaluate(trajectory(Array(6).fill(90), 180, 1.5));
    assert.equal(result.state, 'STABLE');
    assert.equal(result.sampleCount, 6);
});

test('duplicates, stale data, long gaps and memory limits are handled independently of alarms', () => {
    const points = trajectory(Array(100).fill(90), 10);
    const { model, result } = evaluate(points);
    assert.equal(result.state, 'STABLE');
    assert.ok(model.samples.length <= 24);
    const count = model.samples.length;
    model.update(points.at(-1));
    model.update(points[0]);
    assert.equal(model.samples.length, count);
    const stale = model.get(points.at(-1).t + 241000);
    assert.equal(stale.state, 'STABLE');
    assert.equal(stale.uncertaintyGrowthMps, 0);
    model.update({ ...points.at(-1), t: points.at(-1).t + 300000 });
    assert.equal(model.samples.length, 1);
    assert.equal(model.get(points.at(-1).t + 300000, false).state, 'NOT_MOVING');
});

test('stability metadata does not alter an already nominal red alarm', () => {
    const now = Date.now();
    const own = { lat: 36, lon: 14, sog: 5, cog: 0 };
    const target = { id: 'same', lat: 36.01, lon: 14.002, sog: 6, cog: 180, isMoving: true, lastUpdate: now };
    const baseline = new CollisionPipeline().evaluateTarget(own, target, now);
    const additional = new CollisionPipeline().evaluateTarget(own, { ...target,
        predictionStability: { state: 'VARIABLE', uncertaintyGrowthMps: 100, lastFixTime: now } }, now);
    assert.deepEqual(additional, baseline);
});
