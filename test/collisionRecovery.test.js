const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CollisionPipeline, compareTargets } = require('../collisionPipeline');

function fixture(base = 10, targetSpeed = 5) {
    const pipeline = new CollisionPipeline({ baseTcpaMinutes: base });
    const own = { lat: 36, lon: 14, sog: 5, cog: 0, length: 10, beam: 4, antBow: 5, antStern: 5 };
    return (cpa, timeMs, seconds = 180, stability) => pipeline.evaluateTarget(own, {
        ...own, id: 'target', sog: targetSpeed, cog: 180, isMoving: true,
        lat: 36 + (seconds * (5 + targetSpeed) * .51444444 + 10) / 111139,
        lon: 14 + (cpa + 4) / (111139 * Math.cos(Math.PI / 5)),
        predictionStability: stability,
    }, timeMs);
}

test('red cancels directly after two minutes outside the time window despite low CPA', () => {
    const evaluate = fixture();
    assert.equal(evaluate(200, 0).alertState, 'RED');
    assert.equal(evaluate(200, 1000, 660).alertState, 'RED');
    assert.equal(evaluate(200, 120999, 660).alertState, 'RED');
    assert.equal(evaluate(200, 121000, 660).alertState, 'NO_DANGER');
});

test('recovery follows the current lower level without restarting when that lower level changes', () => {
    const evaluate = fixture();
    assert.equal(evaluate(200, 0).alertState, 'RED');
    assert.equal(evaluate(400, 1000).alertState, 'RED');
    assert.equal(evaluate(700, 61000).alertState, 'RED');
    assert.equal(evaluate(400, 121000).alertState, 'ORANGE');
    assert.equal(evaluate(700, 122000).alertState, 'ORANGE');
    assert.equal(evaluate(700, 242000).alertState, 'NO_DANGER');
});

test('returning to the held level resets recovery and escalation remains immediate', () => {
    const evaluate = fixture();
    assert.equal(evaluate(200, 0).alertState, 'RED');
    evaluate(700, 1000);
    assert.equal(evaluate(200, 61000).alertState, 'RED');
    evaluate(700, 121000);
    assert.equal(evaluate(700, 181000).alertState, 'RED');
    assert.equal(evaluate(700, 241000).alertState, 'NO_DANGER');
    assert.equal(evaluate(400, 242000).alertState, 'ORANGE');
    assert.equal(evaluate(200, 242001).alertState, 'RED');
});

test('simulation recovers after one minute even within the former 80m distance deadband', () => {
    const evaluate = fixture(5);
    assert.equal(evaluate(200, 0).alertState, 'RED');
    evaluate(260, 1000);
    assert.equal(evaluate(260, 60999).alertState, 'RED');
    assert.equal(evaluate(260, 61000).alertState, 'ORANGE');
});

test('speed-expanded lookahead does not extend the base recovery delay', () => {
    const evaluate = fixture(10, 20);
    const red = evaluate(200, 0);
    assert.equal(red.effectiveThresholds.horizonTcpa, 25);
    evaluate(200, 1000, 1800);
    assert.equal(evaluate(200, 121000, 1800).alertState, 'NO_DANGER');
});

test('an instability warning recovers when observations stabilize', () => {
    const evaluate = fixture(5);
    const warning = evaluate(540, 1000000, 180, { state: 'VARIABLE', uncertaintyGrowthMps: 1, lastFixTime: 1000000 });
    assert.equal(warning.alertState, 'ORANGE');
    assert.equal(warning.warningBasis, 'INSTABILITY');
    assert.equal('isDeferred' in warning, false);
    evaluate(540, 1001000);
    assert.equal(evaluate(540, 1061000).alertState, 'NO_DANGER');
});

test('legacy deferred flags cannot demote a red target below orange in sorting', () => {
    assert.ok(compareTargets({ risk: 'RED', isDeferred: true }, { risk: 'ORANGE', isDeferred: false }) < 0);
});
