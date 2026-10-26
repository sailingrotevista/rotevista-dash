const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CollisionPipeline, isAnchoredNavigationState, applyHarborProximityPolicy } = require('../ais/collisionPipeline');
const { AisEngine } = require('../ais/aisEngine');
const { WindEngine } = require('../wind/windEngine');

test('confirmed own anchoring quarters effective distances and lookahead after speed scaling and cap', () => {
    const pipeline = new CollisionPipeline({ baseTcpaMinutes: 10 });
    for (const category of ['sailing', 'commercial', 'work']) {
        for (const sog of [1, 5, 10, 20, 100]) {
            const normal = pipeline._resolveThresholds({ sog }, category, { sog: 0 });
            const anchored = pipeline._resolveThresholds({ sog }, category, { sog: 0, isAnchored: true });
            assert.equal(anchored.redCpa, normal.redCpa * .25);
            assert.equal(anchored.orangeCpa, normal.orangeCpa * .25);
            assert.equal(anchored.horizonTcpa, normal.horizonTcpa * .25);
            assert.equal(anchored.baseTcpaMinutes, 10, 'existing recovery uses the configured base time');
            assert.equal(anchored.ownAtAnchor, true);
            assert.equal(normal.ownAtAnchor, false, 'zero speed alone does not confirm anchoring');
        }
    }
});

test('anchoring reduces alerts while a 10kn target at 500m on a collision course still alarms', () => {
    const own = { lat: 36, lon: 14, sog: 0, cog: 0, hdg: 0, length: 10, beam: 4, antBow: 5, antStern: 5 };
    const target = { ...own, id: 'incoming', lat: 36 + (120 * 5 * .51444444 + 10) / 111139,
        lon: 14 + 104 / (111139 * Math.cos(Math.PI / 5)), cog: 180, sog: 5, isMoving: true };
    const evaluate = (ship, contact) => new CollisionPipeline({ baseTcpaMinutes: 10 }).evaluateTarget(ship, contact);
    const normal = evaluate(own, target);
    const anchored = evaluate({ ...own, isAnchored: true }, target);
    assert.equal(normal.alertState, 'RED');
    assert.equal(anchored.alertState, 'ORANGE');
    assert.equal(anchored.cpaNominalMeters, normal.cpaNominalMeters);
    assert.equal(anchored.tcpaSeconds, normal.tcpaSeconds);
    const fast = evaluate({ ...own, isAnchored: true }, { ...target, lat: 36 + 500 / 111139, lon: 14, sog: 10 });
    assert.equal(fast.alertState, 'RED');
    assert.ok(fast.tcpaMinutes < 1.7);
    const proximity = { inCluster: true, isMoving: false, currentHullClearanceMeters: 40 };
    applyHarborProximityPolicy(proximity, 45);
    assert.equal(proximity.safeBubbleMeters, 45);
    assert.equal(proximity.risk, 'GREY');
    proximity.proximityEntryObserved = true;
    applyHarborProximityPolicy(proximity, 45);
    assert.equal(proximity.risk, 'ORANGE');
});

test('navigation state is categorical, updates live, and an explicit reset clears anchoring', () => {
    for (const state of ['anchored', 'at anchor', 'at_anchor', 1, { value: 'anchored' }]) assert.equal(isAnchoredNavigationState(state), true);
    for (const state of [null, undefined, 0, 'under way using engine', 'moored']) assert.equal(isAnchoredNavigationState(state), false);
    const wind = new WindEngine({}, () => ({}));
    wind.processIncomingDelta('navigation.state', 'anchored');
    wind.processIncomingDelta('navigation.state', 'anchored');
    assert.equal(wind.getRaw()['navigation.state'], 'anchored');
    wind.processIncomingDelta('navigation.state', 'under way using engine');
    assert.equal(isAnchoredNavigationState(wind.getRaw()['navigation.state']), false);
    wind.processIncomingDelta('navigation.state', 'anchored');
    wind.processIncomingDelta('navigation.state', null);
    assert.equal(isAnchoredNavigationState(wind.getRaw()['navigation.state']), false);
});

test('AIS engine reads own status from Signal K and returns to normal limits when state changes', () => {
    let state = 'anchored';
    const now = Date.now();
    const engine = new AisEngine({
        getSelfPath: path => path === 'navigation.state' ? { value: state } : undefined,
        getPath: () => ({ boat: { navigation: {
            position: { value: { latitude: 36.005, longitude: 14 }, timestamp: new Date(now).toISOString() },
            speedOverGround: { value: 5 / 1.94384 }, courseOverGroundTrue: { value: Math.PI },
        } } }), error: message => { throw Error(message); },
    }, () => ({ aisAlerter: { baseTcpaMinutes: 10 } }),
    { getRaw: () => ({ 'navigation.position': { latitude: 36, longitude: 14 } }) },
    { processHarbors: () => [] }, new CollisionPipeline());
    engine.process();
    const anchored = engine.getNearbyVessels()[0].effectiveThresholds;
    assert.equal(anchored.ownAtAnchor, true);
    state = 'under way using engine';
    engine.process();
    const underway = engine.getNearbyVessels()[0].effectiveThresholds;
    assert.equal(underway.ownAtAnchor, false);
    assert.equal(underway.redCpa, anchored.redCpa * 4);
});
