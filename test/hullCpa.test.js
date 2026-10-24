const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getHullBoundingRadius, computeHullCpa, computeCpaTcpa, resolveHullPose, CollisionPipeline } = require('../collisionPipeline');
const hull = (length, beam, bow = length / 2) => getHullBoundingRadius({
    length, beam, antBow: bow, antStern: length - bow, antPort: beam / 2, antStarboard: beam / 2,
}, 'sailing');
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('40m antenna CPA can intersect the stern of a 120m hull', () => {
    const result = computeHullCpa(hull(10, 4), 90, hull(120, 20, 10), 0,
        { x: 100, y: 40 }, { x: -5, y: 0 });
    near(result.cpaMeters, 0);
    near(result.tcpaSec, 17); // First hull contact, antenna CPA would be at 20 seconds.
    assert.equal(result.isDiverging, false);
});

test('hull CPA and its earliest TCPA refer to the same safe passing distance', () => {
    const result = computeHullCpa(hull(10, 4), 90, hull(120, 20, 10), 0,
        { x: 100, y: 140 }, { x: -5, y: 0 });
    near(result.cpaMeters, 28); // 140m between references minus 110m stern and 2m own half-beam.
    near(result.tcpaSec, 17);
});

test('same velocity, diverging paths and current hull overlap', () => {
    const a = hull(10, 4), b = hull(10, 4);
    const parallel = computeHullCpa(a, 0, b, 0, { x: 100, y: 0 }, { x: 0, y: 0 });
    near(parallel.cpaMeters, 96);
    assert.equal(parallel.tcpaSec, -1);
    const leaving = computeHullCpa(a, 0, b, 0, { x: 100, y: 0 }, { x: 5, y: 0 });
    near(leaving.cpaMeters, 96);
    assert.equal(leaving.isDiverging, true);
    const overlap = computeHullCpa(a, 0, b, 0, { x: 1, y: 0 }, { x: 5, y: 0 });
    assert.deepEqual(overlap, { cpaMeters: 0, tcpaSec: 0, isDiverging: false });
});

test('equivalent centred hulls at 0 and 180 degrees retain the same corners and earliest TCPA', () => {
    const a = hull(10, 4), b = hull(10, 4);
    const first = computeHullCpa(a, 0, b, 0, { x: 303, y: 1548 }, { x: 0, y: -5 });
    const opposite = computeHullCpa(a, 0, b, 180, { x: 303, y: 1548 }, { x: 0, y: -5 });
    near(first.cpaMeters, 299);
    near(first.tcpaSec, (1548 - 10) / 5);
    near(first.cpaMeters, opposite.cpaMeters);
    near(first.tcpaSec, opposite.tcpaSec);
});

test('moving hull orientation uses COG even when the reported heading disagrees', () => {
    const own = { lat: 36, lon: 14, sog: 5, cog: 90, hdg: 0, length: 10, beam: 4 };
    const target = { lat: 36.001, lon: 14.01, sog: 5, cog: 270, hdg: 0, isMoving: true, length: 120, beam: 20 };
    const first = computeCpaTcpa(own, target, null);
    const second = computeCpaTcpa({ ...own, hdg: 270 }, { ...target, hdg: 180 }, null);
    assert.deepEqual(first, second);
    assert.equal(resolveHullPose(target, hull(120, 20)).orientationSource, 'COG');
});

test('stationary hull uses heading; unknown orientation encloses all rotations and antenna offsets', () => {
    const geometry = hull(120, 20, 10);
    const known = resolveHullPose({ sog: 0, cog: 90, hdg: 0 }, geometry);
    assert.equal(known.heading, 0);
    assert.equal(known.orientationSource, 'HEADING');
    const unknown = resolveHullPose({ sog: 0, cog: 90 }, geometry);
    assert.equal(unknown.orientationSource, 'UNKNOWN_SQUARE');
    near(unknown.hull.a, Math.hypot(110, 10));
    near(unknown.hull.a, unknown.hull.b);
    near(unknown.hull.a, unknown.hull.c);
    assert.ok(2 * unknown.hull.a > 120, 'off-centre antenna needs more than a length-wide centred square');
    assert.equal(resolveHullPose({ sog: 1.2, isMoving: false, hdg: 35 }, geometry).orientationSource, 'HEADING');
});

test('sub-three-second TCPA is not rounded to zero before alert classification', () => {
    const own = { lat: 36, lon: 14, sog: 5, cog: 0, length: 10, beam: 4, antBow: 5, antStern: 5 };
    const target = { ...own, id: 'imminent', lat: 36 + 20 / 111139, cog: 180, isMoving: true, lastUpdate: Date.now() };
    const result = new CollisionPipeline().evaluateTarget(own, target);
    assert.ok(result.tcpaSeconds > 0 && result.tcpaSeconds < 3);
    assert.ok(result.tcpaMinutes > 0);
    assert.equal(result.alertState, 'RED');
});

test('actual overlap is considered a current threat with TCPA zero', () => {
    const own = { lat: 36, lon: 14, sog: 5, cog: 0, length: 10, beam: 4, antBow: 5, antStern: 5 };
    const result = new CollisionPipeline().evaluateTarget(own, { ...own, id: 'overlap', lat: 36 + 5 / 111139, cog: 180, isMoving: true });
    assert.equal(result.tcpaSeconds, 0);
    assert.equal(result.cpaNominalMeters, 0);
    assert.equal(result.alertState, 'RED');
});

test('dimensions are applied once; uncertainty remains separate and bounds the nominal clearance', () => {
    const own = { lat: 36, lon: 14, sog: 5, cog: 90, length: 10, beam: 4, antBow: 5, antStern: 5 };
    const target = { id: 'pass', lat: 36 + 40 / 111139, lon: 14 + 100 / (111139 * Math.cos(Math.PI / 5)),
        sog: 0, cog: 0, hdg: 0, isMoving: true, length: 20, beam: 10, antBow: 10, antStern: 10, lastUpdate: Date.now() };
    const raw = computeCpaTcpa(own, target, null);
    near(raw.cpaNominalMeters, 28);
    const result = new CollisionPipeline().evaluateTarget(own, target);
    assert.equal(result.cpaNominalMeters, raw.cpaNominalMeters);
    assert.ok(result.cpaMinMeters <= result.cpaNominalMeters);
    assert.ok(result.cpaMaxMeters >= result.cpaNominalMeters);
});

test('analytic hull CPA agrees with an independent sampled polygon-distance calculation', () => {
    const corners = (h, degrees) => {
        const angle = degrees * Math.PI / 180;
        return [[h.a, -h.c], [h.a, h.d], [-h.b, h.d], [-h.b, -h.c]].map(([f, s]) => ({
            x: f * Math.sin(angle) + s * Math.cos(angle), y: f * Math.cos(angle) - s * Math.sin(angle),
        }));
    };
    const dot = (a, b) => a.x * b.x + a.y * b.y;
    const polygonDistance = (a, b) => {
        const edges = polygon => polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]]);
        const ea = edges(a), eb = edges(b);
        const separated = [...ea, ...eb].some(([p, q]) => {
            const axis = { x: p.y - q.y, y: q.x - p.x };
            const pa = a.map(v => dot(v, axis)), pb = b.map(v => dot(v, axis));
            return Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa);
        });
        if (!separated) return 0;
        const pointEdge = (p, [a, b]) => {
            const dx = b.x - a.x, dy = b.y - a.y;
            const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
        };
        return Math.min(...a.flatMap(p => eb.map(e => pointEdge(p, e))), ...b.flatMap(p => ea.map(e => pointEdge(p, e))));
    };
    for (let i = 0; i < 12; i++) {
        const own = hull(10 + i, 4, 2), target = hull(60 + i * 5, 15, 8);
        const oh = i * 29, th = i * 43;
        const position = { x: 120 + i * 11, y: -80 + i * 17 };
        const velocity = { x: -2 - i / 10, y: 1.5 - i / 5 };
        const actual = computeHullCpa(own, oh, target, th, position, velocity);
        const centreTime = -dot(position, velocity) / dot(velocity, velocity);
        const horizon = Math.max(0, centreTime) + (own.boundingRadius + target.boundingRadius) / Math.hypot(velocity.x, velocity.y) + 1;
        const ownPoints = corners(own, oh), targetPoints = corners(target, th);
        let sampled = Infinity;
        for (let j = 0; j <= 2000; j++) {
            const t = horizon * j / 2000;
            sampled = Math.min(sampled, polygonDistance(ownPoints, targetPoints.map(p => ({
                x: p.x + position.x + velocity.x * t, y: p.y + position.y + velocity.y * t,
            }))));
        }
        near(actual.cpaMeters, sampled, 0.5);
        if (actual.tcpaSec >= 0) {
            const t = actual.tcpaSec;
            near(actual.cpaMeters, polygonDistance(ownPoints, targetPoints.map(p => ({
                x: p.x + position.x + velocity.x * t, y: p.y + position.y + velocity.y * t,
            }))), 1e-6);
        }
    }
});
