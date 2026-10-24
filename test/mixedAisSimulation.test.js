const { test } = require('node:test');
const assert = require('node:assert/strict');

test('mixed contacts use live own position and a separate identity, without changing real targets', async () => {
  const { MixedAisSimulation, mergeAisTargets } = await import('../src/utils/mixedAisSimulation.mjs');
  const own = { position: { lat: 36, lon: 14 }, cog: 45, hdg: 46, sog: 5 };
  let generatedAt, evaluatedOwn;
  const simulation = new MixedAisSimulation((position, hdg, cog, sog) => {
    generatedAt = { position, hdg, cog, sog };
    return { targets: [{ id: 'real-id', name: 'TEST', lat: 36.01, lon: 14, sog: 6, cog: 90, risk: 'RED', tcpa: 3, trail: [] }] };
  }, (position, hdg, cog, sog, targets) => {
    evaluatedOwn = { position, hdg, cog, sog };
    return { targets };
  });
  const synthetic = simulation.tick(own, 1000);
  assert.deepEqual(generatedAt, own);
  assert.deepEqual(evaluatedOwn, own);
  assert.equal(synthetic[0].id, 'sim:real-id');
  assert.equal(synthetic[0].name, 'SIM · TEST');
  assert.equal(synthetic[0].isSimulated, true);
  const real = Object.freeze({ id: 'real-id', risk: 'ORANGE', cpa: 123, tcpa: 4, contactLost: true, age: 400 });
  const merged = mergeAisTargets([real], synthetic);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], real, 'server risk, age and lost-contact status stay untouched');
  const movedOwn = { ...own, position: { lat: 36.002, lon: 14.002 }, sog: 2 };
  const advanced = simulation.tick(movedOwn, 3000);
  assert.deepEqual(evaluatedOwn, movedOwn);
  assert.ok(advanced[0].lon > synthetic[0].lon);
  const movedMeters = (advanced[0].lon - synthetic[0].lon) * 111139 * Math.cos(36.01 * Math.PI / 180);
  assert.ok(Math.abs(movedMeters - 6 * 1852 / 3600 * 2) < 1e-6, 'elapsed time determines synthetic travel');
});

test('a synthetic refresh cannot remove real contacts and a real refresh cannot remove synthetic contacts', async () => {
  const { mergeAisTargets } = await import('../src/utils/mixedAisSimulation.mjs');
  const real = [{ id: 'live-1' }];
  const synthetic = [{ id: 'sim:1' }];
  assert.deepEqual(mergeAisTargets(real, []), real);
  assert.deepEqual(mergeAisTargets([], synthetic), synthetic);
  assert.deepEqual(mergeAisTargets(real, synthetic).map(t => t.id), ['live-1', 'sim:1']);
});

test('reset generates a new scenario at the latest real location after reconnect', async () => {
  const { MixedAisSimulation } = await import('../src/utils/mixedAisSimulation.mjs');
  const origins = [];
  const simulation = new MixedAisSimulation(position => {
    origins.push(position);
    return { targets: [{ id: 'test', name: 'TEST', ...position, cog: 0, sog: 5, tcpa: 3, trail: [] }] };
  }, (_pos, _hdg, _cog, _sog, targets) => ({ targets }));
  simulation.tick({ position: { lat: 36, lon: 14 }, cog: 0, hdg: 0, sog: 5 }, 0);
  simulation.reset();
  simulation.tick({ position: { lat: 37, lon: 15 }, cog: 90, hdg: 90, sog: 7 }, 60000);
  assert.deepEqual(origins, [{ lat: 36, lon: 14 }, { lat: 37, lon: 15 }]);
});
