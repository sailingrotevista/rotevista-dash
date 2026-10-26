const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CollisionPipeline, evaluateInstabilityWarning, COLLISION_THRESHOLD_DEFAULTS } = require('../ais/collisionPipeline');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

function encounter(cpa, seconds, stability) {
    const own = { lat: 36, lon: 14, sog: 5, cog: 0, length: 10, beam: 4, antBow: 5, antStern: 5 };
    const target = { ...own, id: 'target', cog: 180, isMoving: true,
        lat: 36 + (seconds * 10 * .51444444 + 10) / 111139,
        lon: 14 + (cpa + 4) / (111139 * Math.cos(Math.PI / 5)),
        lastUpdate: 1000000, predictionStability: stability };
    return new CollisionPipeline().evaluateTarget(own, target, 1000000);
}

test('distance references and doubled warning apply to all three categories', () => {
    const p = new CollisionPipeline();
    for (const [category, speed, red] of [['sailing', 7.5, 250], ['commercial', 10, 800], ['work', 10, 400]]) {
        const base = p._resolveThresholds({ sog: speed }, category, { sog: 5 });
        near(base.redCpa, red); near(base.orangeCpa, red * 2);
        const fast = p._resolveThresholds({ sog: speed * 2 }, category, { sog: 5 });
        near(fast.redCpa, red * 2); near(fast.orangeCpa, red * 4);
        const slow = p._resolveThresholds({ sog: 1 }, category, { sog: 5 });
        near(slow.redCpa, red);
    }
});

test('lookahead follows the speed ratio with a 4kn own-speed floor and 30min cap', () => {
    const p = new CollisionPipeline();
    near(p._resolveThresholds({ sog: 20 }, 'commercial', { sog: 2 }).horizonTcpa, 15);
    near(p._resolveThresholds({ sog: 20 }, 'commercial', { sog: 4 }).horizonTcpa, 15);
    near(p._resolveThresholds({ sog: 20 }, 'commercial', { sog: 5 }).horizonTcpa, 12.5);
    near(p._resolveThresholds({ sog: 10 }, 'commercial', { sog: 5 }).horizonTcpa, 7.5);
    near(p._resolveThresholds({ sog: 2 }, 'commercial', { sog: 8 }).horizonTcpa, 5);
    near(p._resolveThresholds({ sog: 100 }, 'commercial', { sog: 0 }).horizonTcpa, 30);
});

test('nominal red and orange use exactly the same effective time window', () => {
    assert.equal(encounter(249, 299).alertState, 'RED');
    assert.equal(encounter(450, 299).alertState, 'ORANGE');
    assert.equal(encounter(650, 299).alertState, 'NO_DANGER');
    assert.equal(encounter(249, 301).alertState, 'NO_DANGER');
    assert.equal(encounter(450, 301).alertState, 'NO_DANGER');
});

test('observed instability adds orange outside nominal warning, never red', () => {
    const stability = { state: 'VARIABLE', uncertaintyGrowthMps: 1, lastFixTime: 1000000 };
    const added = encounter(540, 180, stability);
    assert.equal(added.alertState, 'ORANGE');
    assert.equal(added.warningBasis, 'INSTABILITY');
    assert.ok(added.instabilityWarning.durationSeconds >= 15);
    near(added.cpaNominalMeters, 540);
    assert.equal(encounter(450, 180, stability).alertState, 'ORANGE');
    assert.equal(encounter(249, 180, stability).alertState, 'RED');
});

test('stable, unknown, single-change and old data cannot create extra orange', () => {
    for (const state of ['STABLE', 'INSUFFICIENT_DATA', 'MANEUVERING', 'NOT_MOVING']) {
        assert.equal(encounter(650, 180, { state, uncertaintyGrowthMps: 100, lastFixTime: 1000000 }).alertState, 'NO_DANGER');
    }
    assert.equal(encounter(650, 180, { state: 'VARIABLE', uncertaintyGrowthMps: 100, lastFixTime: 0 }).alertState, 'NO_DANGER');
});

const obstacle = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
function prediction(cpa, speed = 1, time = 100) {
    return { hullPrediction: { position: { x: cpa + 1, y: -time * speed }, velocity: { x: 0, y: speed }, obstacle } };
}
test('a small absolute penetration is insufficient for 400m but significant for 100m', () => {
    const model = { state: 'VARIABLE', uncertaintyGrowthMps: .2, lastFixTime: 1000000 };
    const cfg = COLLISION_THRESHOLD_DEFAULTS;
    assert.equal(evaluateInstabilityWarning(prediction(410), model, { orangeCpa: 400, horizonTcpa: 5 }, 1000000, cfg), null);
    const significant = evaluateInstabilityWarning(prediction(109), model, { orangeCpa: 100, horizonTcpa: 5 }, 1000000, cfg);
    assert.ok(significant);
    assert.ok(significant.possibleCpaMeters <= 90);
});

test('a brief intrusion is rejected instead of accepting a single forecast point', () => {
    const model = { state: 'VARIABLE', uncertaintyGrowthMps: 2, lastFixTime: 1000000 };
    const result = evaluateInstabilityWarning(prediction(110, 100, 10), model,
        { orangeCpa: 100, horizonTcpa: 20 / 60 }, 1000000, COLLISION_THRESHOLD_DEFAULTS);
    assert.equal(result, null);
});

test('passenger vessels and high-speed craft use commercial distance references', () => {
    const p = new CollisionPipeline();
    for (const shipType of [40, 60, 70, 80]) assert.equal(p._resolveVesselCategory({ shipType }), 'commercial');
});

test('uncertainty is capped at 20% of warning distance even with extreme instability and old fixes', () => {
    const model = { state: 'VARIABLE', uncertaintyGrowthMps: 100, lastFixTime: 700000 };
    const thresholds = { orangeCpa: 500, horizonTcpa: 5 };
    const warning = evaluateInstabilityWarning(prediction(520), model, thresholds, 1000000, COLLISION_THRESHOLD_DEFAULTS);
    assert.ok(warning);
    near(warning.possibleCpaMeters, 420);
    assert.equal(evaluateInstabilityWarning(prediction(600), model, thresholds, 1000000, COLLISION_THRESHOLD_DEFAULTS), null);
});

test('observed instability stays usable beyond four minutes and expires with moving targets at six minutes', () => {
    const thresholds = { orangeCpa: 500, horizonTcpa: 5 };
    const model = { state: 'VARIABLE', uncertaintyGrowthMps: 1, lastFixTime: 1000000 - 359000 };
    assert.ok(evaluateInstabilityWarning(prediction(520), model, thresholds, 1000000, COLLISION_THRESHOLD_DEFAULTS));
    assert.equal(evaluateInstabilityWarning(prediction(520), { ...model, lastFixTime: 1000000 - 361000 }, thresholds, 1000000, COLLISION_THRESHOLD_DEFAULTS), null);
});
