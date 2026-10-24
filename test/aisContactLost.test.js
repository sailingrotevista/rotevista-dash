const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AisEngine } = require('../aisEngine');
const { CollisionPipeline } = require('../collisionPipeline');

function encounter(run, cpa = 0) {
    const originalNow = Date.now;
    const epoch = originalNow();
    let clock = epoch;
    let fixTime = epoch;
    let latitude = 36 + (700 * 10 * .51444444) / 111139;
    const pipeline = new CollisionPipeline();
    const engine = new AisEngine({ getPath: () => ({ boat: { navigation: {
        position: { value: { latitude, longitude: 14 + cpa / (111139 * Math.cos(Math.PI / 5)) }, timestamp: new Date(fixTime).toISOString() },
        speedOverGround: { value: 10 / 1.94384 }, courseOverGroundTrue: { value: Math.PI },
    } } }), error: message => { throw Error(message); } },
    () => ({ aisAlerter: { baseTcpaMinutes: 10 } }),
    { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 } }) },
    { processHarbors: () => [] }, pipeline);
    Date.now = () => clock;
    try {
        run({
            engine, pipeline,
            at: seconds => { clock = epoch + seconds * 1000; engine.process(); return engine.getNearbyVessels()[0]; },
            receive: seconds => { fixTime = epoch + seconds * 1000; latitude = 36.02; },
        });
    } finally { Date.now = originalNow; }
}

test('a lost alarm keeps its trajectory and normal priority until post-encounter recovery completes', () => {
    encounter(({ at, engine }) => {
        assert.equal(at(0).risk, 'RED');
        const lost = at(361);
        assert.equal(lost.contactLost, true);
        assert.equal(lost.risk, 'RED');
        assert.equal(engine.getTopThreat().id, lost.id);
        const later = at(400);
        assert.ok(later.lat < lost.lat, 'last known trajectory continues advancing');
        assert.ok(later.tcpa < lost.tcpa);
        assert.equal(at(750).risk, 'RED', 'passing starts recovery, not instant cancellation');
        assert.equal(at(869).risk, 'RED');
        assert.equal(at(870), undefined);
        assert.equal(engine.getTopThreat(), null);
        assert.equal(at(900), undefined, 'old data still in Signal K cannot revive the expired encounter');
    });
});

test('a new real fix restores normal contact status and timestamp', () => {
    encounter(({ at, receive }) => {
        at(0);
        const lost = at(361);
        assert.equal(lost.contactLost, true);
        receive(400);
        const fresh = at(400);
        assert.equal(fresh.contactLost, false);
        assert.equal(fresh.age, 0);
        assert.ok(fresh.lastPositionTime > lost.lastPositionTime);
    });
});

test('expired contacts without an active alarm are removed normally', () => {
    encounter(({ at }) => {
        assert.equal(at(0).risk, 'GREY');
        assert.equal(at(361), undefined);
    }, 5000);
});

test('lost contacts retain a snooze beyond its timer, but a fresh position releases that acknowledgement', async () => {
    const { isThreatSnoozed, reconcileSnooze } = await import('../src/utils/aisSnooze.mjs');
    const lost = { risk: 'RED', contactLost: true, lastPositionTime: 123 };
    const snooze = { until: 10000, initialRisk: 'ORANGE' };
    assert.equal(isThreatSnoozed(lost, snooze, 9000), true);
    const acknowledged = reconcileSnooze(lost, snooze, 9000);
    assert.equal(acknowledged.lostPositionTime, 123);
    assert.equal(isThreatSnoozed(lost, acknowledged, 20000), true);
    assert.equal(isThreatSnoozed(lost, snooze, 20000), false, 'an already expired snooze does not acknowledge loss retroactively');
    const receivedLate = { ...lost, contactLostAt: 9500 };
    const acknowledgedLate = reconcileSnooze(receivedLate, snooze, 20000);
    assert.equal(isThreatSnoozed(receivedLate, acknowledgedLate, 20000), true, 'a background tab respects snooze active at the actual loss time');
    const fresh = { ...lost, contactLost: false, lastPositionTime: 456 };
    assert.equal(isThreatSnoozed(fresh, acknowledged, 9500), false);
    assert.equal(reconcileSnooze(fresh, acknowledged, 9500), null);
    assert.equal(isThreatSnoozed({ risk: 'RED' }, snooze, 9000), false, 'fresh escalation still overrides orange snooze');
});
