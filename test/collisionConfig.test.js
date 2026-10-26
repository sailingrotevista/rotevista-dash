const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareCollisionConfig, THRESHOLD_POLICY_VERSION } = require('../ais/collisionConfig');
const { CollisionPipeline } = require('../ais/collisionPipeline');
const { AisEngine } = require('../ais/aisEngine');

test('legacy migration resets all red limits and live time once without changing unrelated settings', () => {
    const old = { graphs: { historyMinutes: 30 }, aisAlerter: {
        enabled: false, vectorMinutes: 22, ignoreOwnTarget: '123', criticalProximity: 60,
        baseTcpaMinutes: 5,
        pleasureCraft: { redCpa: 42, orangeCpa: 80, maxTcpa: 12 },
        commercialShips: { redCpa: 1234 }, workboats: { redCpa: 500 },
    } };
    const snapshot = structuredClone(old);
    const { config, migrated } = prepareCollisionConfig(old);
    assert.equal(migrated, true);
    assert.equal(config.aisAlerter.baseTcpaMinutes, 10);
    assert.deepEqual(config.aisAlerter.pleasureCraft, { redCpa: 250 });
    assert.deepEqual(config.aisAlerter.commercialShips, { redCpa: 800 });
    assert.deepEqual(config.aisAlerter.workboats, { redCpa: 400 });
    assert.equal(config.aisAlerter.thresholdPolicyVersion, THRESHOLD_POLICY_VERSION);
    for (const key of ['enabled', 'vectorMinutes', 'ignoreOwnTarget', 'criticalProximity']) {
        assert.equal(config.aisAlerter[key], old.aisAlerter[key]);
    }
    assert.deepEqual(config.graphs, old.graphs);
    assert.deepEqual(old, snapshot);
});

test('persisted migration marker preserves subsequent user edits across restarts', () => {
    const { config } = prepareCollisionConfig({});
    config.aisAlerter.pleasureCraft.redCpa = 450;
    config.aisAlerter.baseTcpaMinutes = 12;
    const restarted = prepareCollisionConfig(JSON.parse(JSON.stringify(config)));
    assert.equal(restarted.migrated, false);
    assert.deepEqual(restarted.config, config);
});

test('new installations default to live 10 minutes while simulation uses 5 minutes', () => {
    assert.equal(prepareCollisionConfig().config.aisAlerter.baseTcpaMinutes, 10);
    const sim = new CollisionPipeline({ baseTcpaMinutes: 5 });
    assert.equal(sim._resolveThresholds({ sog: 5 }, 'yacht', { sog: 5 }).horizonTcpa, 5);
});

test('live engine uses 10-minute fallback and respects a later configured value', () => {
    let cfg = {}; let applied;
    const engine = new AisEngine({ getPath: () => ({}), error: message => { throw Error(message); } },
        () => ({ aisAlerter: cfg }),
        { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 } }) },
        { processHarbors: () => [] },
        { updateConfig: value => { applied = value; }, pruneInactive() {}, sortTargets() {}, targetStates: new Map() });
    engine.process();
    assert.equal(applied.baseTcpaMinutes, 10);
    cfg = { baseTcpaMinutes: 8 };
    engine.process();
    assert.equal(applied.baseTcpaMinutes, 8);
});
