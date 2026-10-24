const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HarborDetector, pointInPolygon } = require('../harborDetector');
const own = { lat: 36, lon: 14 };

function vessel(id, north, east, kind = 'FIXED', options = {}) {
    const lat = own.lat + north / 111139, lon = own.lon + east / (111139 * Math.cos(Math.PI / 5));
    return { id, lat, lon, dist: Math.hypot(north, east), sog: 0, length: 12,
        isMoving: false, motionState: 'STATIONARY', isMoored: false, isAnchored: false,
        anchorState: 'UNDERWAY', reportedNavigationState: '', stationarySince: 0,
        restPattern: { confirmed: true, kind, center: { lat, lon }, radiusMeters: kind === 'OSCILLATING' ? 30 : 3 },
        ...options };
}
const process = (detector, vessels, time = 180000) => detector.processHarbors(vessels, own, {}, 0, time);

test('confirmed fixed groups form ports without AIS moored status or a pair closer than 20m', () => {
    const detector = new HarborDetector();
    const boats = [vessel('a', 0, 0), vessel('b', 0, 70), vessel('c', 70, 70), vessel('d', 70, 0)];
    const areas = process(detector, boats);
    assert.equal(areas.length, 1);
    assert.equal(areas[0].kind, 'PORT');
    assert.equal(areas[0].count, 4);
    assert.ok(boats.every(v => v.inCluster && v.isMoored));
});

test('stationary targets inside the learned polygon join even beyond 45m from learned points', () => {
    const detector = new HarborDetector();
    const corners = [vessel('a', 0, 0), vessel('b', 0, 90), vessel('c', 90, 90), vessel('d', 90, 0)];
    const first = process(detector, corners)[0];
    const interior = vessel('new', 45, 45, 'UNDETERMINED', { restPattern: { confirmed: false, kind: 'UNDETERMINED' } });
    const areas = process(detector, [...corners, interior], 195000);
    assert.equal(interior.clusterId, first.id);
    assert.equal(interior.inCluster, true);
    assert.equal(areas[0].count, 5);
    assert.equal(pointInPolygon(interior.lat, interior.lon, areas[0].hull), true);
});

test('a new confirmed fixed target extends a learned port without circular moored prerequisites', () => {
    const detector = new HarborDetector();
    const base = [vessel('a', 0, 0), vessel('b', 0, 70)];
    const id = process(detector, base)[0].id;
    const additional = vessel('new', 0, 180);
    const areas = process(detector, [...base, additional], 195000);
    assert.equal(areas.length, 1);
    assert.equal(areas[0].id, id);
    assert.equal(additional.clusterId, id);
    assert.equal(areas[0].count, 3);
});

test('a loose observed rest area can become an anchorage without changing its identity', () => {
    const detector = new HarborDetector();
    let boats = [vessel('a', 0, 0), vessel('b', 0, 140), vessel('c', 0, 280)];
    const provisional = process(detector, boats)[0];
    assert.equal(provisional.kind, 'PROVISIONAL');
    boats = [vessel('a', 0, 0, 'OSCILLATING'), vessel('b', 0, 140, 'OSCILLATING'), vessel('c', 0, 280, 'OSCILLATING')];
    const anchorage = process(detector, boats, 600000)[0];
    assert.equal(anchorage.id, provisional.id);
    assert.equal(anchorage.kind, 'ANCHORAGE');
    assert.ok(boats.every(v => v.isAnchored && !v.isMoored && v.anchorState === 'ANCHORED'));
    assert.ok(anchorage.hull.length >= 4);
});

test('port, anchorage and a separate fixed storage group remain distinct areas', () => {
    const detector = new HarborDetector();
    const port = [vessel('p1', 0, 0), vessel('p2', 0, 50), vessel('p3', 50, 0)];
    const anchored = [vessel('a1', 0, 600, 'OSCILLATING'), vessel('a2', 0, 740, 'OSCILLATING'), vessel('a3', 0, 880, 'OSCILLATING')];
    // AIS alone does not identify land: a fixed storage group follows port rules.
    const yard = [vessel('y1', 800, 0), vessel('y2', 800, 40), vessel('y3', 840, 0)];
    const areas = process(detector, [...port, ...anchored, ...yard]);
    assert.equal(areas.length, 3);
    assert.deepEqual(areas.map(a => a.kind).sort(), ['ANCHORAGE', 'PORT', 'PORT']);
    assert.ok(port.every(v => v.clusterId === port[0].clusterId));
    assert.ok(yard.every(v => v.clusterId === yard[0].clusterId));
    assert.notEqual(port[0].clusterId, yard[0].clusterId);
});

test('isolated large anchored ships and moving targets are not swallowed by rest areas', () => {
    const detector = new HarborDetector();
    const ships = [vessel('s1', 0, 0), vessel('s2', 0, 500), vessel('s3', 0, 1000)].map(v => ({
        ...v, length: 200, reportedNavigationState: 'anchored', isAnchored: true,
    }));
    assert.equal(process(detector, ships).length, 0);
    const fixed = [vessel('p1', 0, 0), vessel('p2', 0, 50), vessel('p3', 50, 0)];
    const moving = vessel('moving', 10, 10, 'FIXED', { motionState: 'MOVING', isMoving: true, sog: 1 });
    process(detector, [...fixed, moving]);
    assert.equal(moving.inCluster, false);
    const yachtAnchorage = [vessel('a1', 0, 0, 'OSCILLATING'), vessel('a2', 0, 100, 'OSCILLATING'), vessel('a3', 100, 0, 'OSCILLATING')];
    const large = vessel('large', 20, 20, 'OSCILLATING', { length: 200, reportedNavigationState: 'anchored', isAnchored: true });
    process(new HarborDetector(), [...yachtAnchorage, large]);
    assert.equal(large.inCluster, false, 'large anchored obstacles do not inherit a small-vessel quiet area');
});

test('unknown sparse observations alone do not create an area and inferred mooring flags do not force port type', () => {
    const detector = new HarborDetector();
    const sparse = [0, 70, 140].map((east, i) => vessel(String(i), 0, east, 'UNDETERMINED', { restPattern: { confirmed: false, kind: 'UNDETERMINED' } }));
    assert.equal(process(detector, sparse).length, 0);
    const anchored = [0, 140, 280].map((east, i) => vessel(String(i), 0, east, 'OSCILLATING', { isMoored: true, reportedNavigationState: '' }));
    assert.equal(process(detector, anchored)[0].kind, 'ANCHORAGE');
});

test('learned coordinates and remembered identities are bounded', () => {
    const detector = new HarborDetector({ maximumLearnedPoints: 10 });
    for (let i = 0; i < 40; i++) process(detector, [vessel('a', 0, 0), vessel('b', 0, 30), vessel('new' + i, 20 + i % 10 * 10, 20)]);
    for (const area of Object.values(detector.knownHarbors)) {
        assert.ok(area.berths.length <= 10);
        assert.ok(area.memberIds.size <= 10);
    }
});

test('confirmed reported mooring links at 120m while ordinary fixed targets keep 95m', () => {
    for (const confident of [false, true]) {
        const boats = [vessel('a', 0, 0), vessel('b', 0, 110)];
        if (confident) boats.forEach(v => { v.reportedNavigationState = 'moored'; });
        const areas = process(new HarborDetector(), boats);
        assert.equal(areas.length, confident ? 1 : 0);
    }
});

test('only independent confident mooring extends a port to 180m', () => {
    for (const evidence of ['reported', 'wind', 'inferred']) {
        const detector = new HarborDetector();
        process(detector, [vessel('a', 0, 0), vessel('b', 0, 30)]);
        const extra = vessel('extra', 0, 190);
        if (evidence === 'reported') extra.reportedNavigationState = 'moored';
        if (evidence === 'wind') extra.restPattern.windMooring = { supported: true, strong: true };
        if (evidence === 'inferred') extra.isMoored = true;
        process(detector, [extra]);
        assert.equal(extra.inCluster, evidence !== 'inferred', evidence);
    }
});

test('ports merge by a 200m polygon gap rather than distance between fixes', () => {
    for (const gap of [230, 250]) {
        const areas = process(new HarborDetector(), [vessel('a', 0, 0), vessel('b', 20, 0),
            vessel('c', 0, gap), vessel('d', 20, gap)]);
        assert.equal(areas.length, gap === 230 ? 1 : 2);
    }
});

test('confirmed oscillation retracts learned port support and clears inherited mooring', () => {
    const detector = new HarborDetector();
    process(detector, [vessel('a', 0, 0), vessel('b', 20, 0), vessel('tip', 0, 110)]);
    const before = Object.values(detector.knownHarbors)[0];
    assert.equal(before.memberIds.has('tip'), true);
    const tip = vessel('tip', 0, 110, 'OSCILLATING', { isMoored: true, anchorState: 'MOORED' });
    const areas = process(detector, [vessel('a', 0, 0), vessel('b', 20, 0), tip], 300000);
    assert.equal(tip.inCluster, false);
    assert.equal(tip.isMoored, false);
    assert.equal(tip.isAnchored, true);
    assert.equal(tip.anchorState, 'ANCHORED');
    const port = Object.values(detector.knownHarbors).find(a => a.kind === 'PORT');
    assert.equal(port.memberIds.has('tip'), false);
    assert.equal(pointInPolygon(tip.lat, tip.lon, areas[0].hull), false);
});

test('removing an anchored contributor preserves shared berths and excludes anchors inside hull', () => {
    const detector = new HarborDetector();
    const fixed = [vessel('a', 0, 0), vessel('b', 0, 80), vessel('c', 80, 0), vessel('d', 80, 80)];
    process(detector, [...fixed, vessel('shared', 1, 1), vessel('inside', 40, 40)]);
    const shared = vessel('shared', 1, 1, 'OSCILLATING');
    const inside = vessel('inside', 40, 40, 'OSCILLATING');
    process(detector, [...fixed, shared, inside], 300000);
    const port = Object.values(detector.knownHarbors).find(a => a.kind === 'PORT');
    assert.ok(port.berths.some(b => b.sources.has('a')));
    assert.ok(port.berths.every(b => !b.sources.has('shared') && !b.sources.has('inside')));
    assert.notEqual(inside.areaKind, 'PORT');
    assert.equal(inside.isMoored, false);
});

test('nearby port and anchorage never merge solely because their polygons overlap', () => {
    const boats = [vessel('a',0,0),vessel('b',20,0),vessel('x',0,30,'OSCILLATING'),vessel('y',20,30,'OSCILLATING')];
    const areas = process(new HarborDetector(),boats);
    assert.deepEqual(areas.map(a=>a.kind).sort(),['ANCHORAGE','PORT']);
    assert.equal(boats[2].areaKind,'ANCHORAGE');
});

test('polygon distance detects containment, crossing edges and segment gaps', () => {
    const { polygonDistanceMeters } = require('../harborDetector');
    const rect = (x,y,w,h) => [[y,x],[y,x+w],[y+h,x+w],[y+h,x]];
    assert.equal(polygonDistanceMeters(rect(0,0,.003,.001),rect(.001,-.001,.001,.003)),0);
    assert.equal(polygonDistanceMeters(rect(0,0,.003,.003),rect(.001,.001,.001,.001)),0);
    assert.ok(Math.abs(polygonDistanceMeters(rect(0,0,.001,.001),rect(.002,0,.001,.001))-111.139)<.01);
});
