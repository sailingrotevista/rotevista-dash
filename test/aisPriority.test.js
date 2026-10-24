const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareTargets } = require('../collisionPipeline');
const target = (id, cpa, tcpa, risk = 'RED') => ({ id, cpa, tcpa, risk, dist: 1000 });

test('shared scoring follows the reviewed encounter examples and treats zero TCPA as valid', () => {
  for (const [a, b, winner] of [
    [target('a', 300, 1), target('b', 2, 3), 'b'],
    [target('a', 20, 1), target('b', 2, 3), 'a'],
    [target('a', 100, 1), target('b', 20, 3), 'a'],
    [target('a', 100, 0), target('b', 2, 3), 'a'],
  ]) assert.equal([a, b].sort(compareTargets)[0].id, winner);
  assert.equal([target('orange', 0, 0, 'ORANGE'), target('red', 300, 5)].sort(compareTargets)[0].id, 'red');
});

test('priority is transitive and ties remain deterministic across incoming list orders', () => {
  const targets = [target('a', 100, 1), target('b', 90, 1.3), target('c', 80, 1.6)];
  assert.ok(compareTargets(targets[0], targets[1]) < 0);
  assert.ok(compareTargets(targets[1], targets[2]) < 0);
  assert.ok(compareTargets(targets[0], targets[2]) < 0);
  const tied = [target('b', 100, 2), target('a', 100, 2)];
  assert.equal(tied.sort(compareTargets)[0].id, 'a');
  assert.equal(tied.reverse().sort(compareTargets)[0].id, 'a');
});

test('engine and GUI representations share the same priority function and rounded CPA score', async () => {
  const { compareAisTargets } = await import('../src/utils/aisPriority.mjs');
  assert.equal(compareAisTargets, compareTargets);
  const engineTargets = [{ targetId: 'a', alertState: 'RED', cpaNominalMeters: 100.4, tcpaMinutes: 2 },
    { targetId: 'b', alertState: 'RED', cpaNominalMeters: 100.1, tcpaMinutes: 2 }];
  const uiTargets = engineTargets.map(t => target(t.targetId, Math.round(t.cpaNominalMeters), t.tcpaMinutes));
  assert.deepEqual(engineTargets.sort(compareTargets).map(t => t.targetId), uiTargets.sort(compareAisTargets).map(t => t.id));
});

test('banner needs ten seconds of continuous same-colour priority and retains fresh metrics', async () => {
  const { BannerThreatSelector } = await import('../src/utils/aisPriority.mjs');
  const selector = new BannerThreatSelector();
  const a = target('a', 100, 1), b = target('b', 110, 1);
  assert.equal(selector.select([a, b], 0).id, 'a');
  const improvedB = { ...b, cpa: 90 };
  assert.equal(selector.select([a, improvedB], 1000).id, 'a');
  const freshA = { ...a, age: 2 };
  assert.equal(selector.select([freshA, improvedB], 10999), freshA);
  assert.equal(selector.select([freshA, improvedB], 11000).id, 'b');
});

test('one-second oscillations reset the pending challenger instead of flipping the banner', async () => {
  const { BannerThreatSelector } = await import('../src/utils/aisPriority.mjs');
  const selector = new BannerThreatSelector();
  const a = target('a', 100, 1);
  selector.select([a, target('b', 110, 1)], 0);
  for (let second = 1; second < 30; second++) {
    assert.equal(selector.select([a, target('b', second % 2 ? 90 : 110, 1)], second * 1000).id, 'a');
  }
});

test('red overrides orange immediately; snoozing, removal and clearing skip the switching hold', async () => {
  const { BannerThreatSelector } = await import('../src/utils/aisPriority.mjs');
  const selector = new BannerThreatSelector();
  const orange = target('orange', 10, 1, 'ORANGE'), red = target('red', 100, 3);
  assert.equal(selector.select([orange], 0).id, 'orange');
  assert.equal(selector.select([orange, red], 1).id, 'red');
  assert.equal(selector.select([orange], 2).id, 'orange');
  assert.equal(selector.select([], 3), null);
});
