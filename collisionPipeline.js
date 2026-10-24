/**
 * ============================================================================
 * Collision Avoidance Pipeline (Modules 1 - 4)
 * File: collisionPipeline.js
 * ============================================================================
 * Modulo computazionale puro e macchina a stati per prevenzione collisioni AIS:
 * - Modulo 1: Inviluppo geometrico scafo (LOA, Beam, GPS antenna offset)
 * - Modulo 2: Incertezza proporzionale all'instabilità osservata dei fix reali
 * - Modulo 3: Cinematica vettoriale ARPA (CPA tra scafi e TCPA nominali)
 * - Modulo 4: Classificazione soglie, trend Delta-CPA,
 *             isteresi asimmetrica (escalation istantanea, hold timer per de-escalation).
 * ============================================================================
 */

'use strict';

// ----------------------------------------------------------------------------
// 1. COSTANTI E UTILITY MATEMATICHE
// ----------------------------------------------------------------------------
const D2R = Math.PI / 180.0;
const R2D = 180.0 / Math.PI;
const MS_TO_KNOTS = 1.94384449;
const KNOTS_TO_MS = 0.51444444;
const METERS_PER_DEG_LAT = 111139.0;

// Alarm policy. Shared defaults for live AIS and simulation.
const COLLISION_THRESHOLD_DEFAULTS = {
    yachtRedCpaMeters: 250,
    commercialRedCpaMeters: 800,
    workRedCpaMeters: 400,
    yachtReferenceKnots: 7.5,
    commercialReferenceKnots: 10,
    workReferenceKnots: 10,
    warningDistanceRatio: 2,
    baseTcpaMinutes: 5,
    minimumOwnSpeedKnots: 4,
    lookaheadSpeedCoefficient: 0.5,
    maximumLookaheadMinutes: 30,
    instabilityPenetrationFraction: 0.1,
    instabilityMinimumDurationSeconds: 15,
    instabilityMaximumRadiusFraction: 0.2,
    movingTargetMaxAgeSeconds: 360,
    stationaryTargetMaxAgeSeconds: 900,
    deescalationBaseTimeFraction: 0.2,
};

function d2r(deg) {
    return deg * D2R;
}

function r2d(rad) {
    return rad * R2D;
}

function normalizeDegrees(deg) {
    return (deg % 360 + 360) % 360;
}

function angularDiff(degA, degB) {
    let diff = Math.abs(degA - degB) % 360;
    return diff > 180 ? 360 - diff : diff;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
    let phi1 = lat1 * D2R;
    let phi2 = lat2 * D2R;
    let deltaPhi = (lat2 - lat1) * D2R;
    let deltaLambda = (lon2 - lon1) * D2R;
    let a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371000 * c;
}

// ----------------------------------------------------------------------------
// 2. MODULO 1: INVILUPPO GEOMETRICO DELLO SCAFO
// ----------------------------------------------------------------------------
const DEFAULT_DIMENSIONS_BY_TYPE = {
    commercial: { loa: 180, beam: 28, a: 130, b: 50, c: 14, d: 14 },
    work:       { loa: 35,  beam: 9,  a: 20,  b: 15, c: 4.5, d: 4.5 },
    sailing:    { loa: 12,  beam: 3.8, a: 8,   b: 4,  c: 1.9, d: 1.9 },
    pleasure:   { loa: 11,  beam: 3.5, a: 7,   b: 4,  c: 1.75, d: 1.75 },
    default:    { loa: 15,  beam: 4.5, a: 10,  b: 5,  c: 2.25, d: 2.25 }
};

function getHullBoundingRadius(vessel, vesselCategory) {
    let cat = vesselCategory || 'default';
    let fallback = DEFAULT_DIMENSIONS_BY_TYPE[cat] || DEFAULT_DIMENSIONS_BY_TYPE.default;

    let dims = vessel.dimensions || {};
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
    let loa = positive(vessel.length) ? vessel.length : positive(dims.length) ? dims.length : fallback.loa;
    let beam = positive(vessel.beam) ? vessel.beam : positive(dims.width) ? dims.width : fallback.beam;

    let defaultRatioA = fallback.a / fallback.loa;
    const offset = (value, size, alternative) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= size ? value : alternative;
    let a = dims.partA !== undefined ? dims.partA : (dims.a !== undefined ? dims.a : (vessel.antBow !== undefined ? vessel.antBow : loa * defaultRatioA));
    a = offset(a, loa, loa * defaultRatioA);
    let b = dims.partB !== undefined ? dims.partB : (dims.b !== undefined ? dims.b : (vessel.antStern !== undefined ? vessel.antStern : Math.max(1, loa - a)));
    let c = dims.partC !== undefined ? dims.partC : (dims.c !== undefined ? dims.c : (vessel.antPort !== undefined ? vessel.antPort : beam * 0.5));
    let d = dims.partD !== undefined ? dims.partD : (dims.d !== undefined ? dims.d : (vessel.antStarboard !== undefined ? vessel.antStarboard : beam * 0.5));
    b = offset(b, loa, loa - a);
    c = offset(c, beam, beam / 2);
    d = offset(d, beam, beam / 2);

    let boundingRadius = Math.max(
        Math.sqrt(a * a + c * c),
        Math.sqrt(a * a + d * d),
        Math.sqrt(b * b + c * c),
        Math.sqrt(b * b + d * d)
    );

    return { loa, beam, a, b, c, d, boundingRadius };
}

function getHullEllipticalMargin(hull, vesselHeadingDeg, bearingTowardsOtherDeg) {
    let alphaRad = d2r(bearingTowardsOtherDeg - (vesselHeadingDeg || 0));
    let cosA = Math.cos(alphaRad);
    let sinA = Math.sin(alphaRad);
    let lEff = cosA >= 0 ? hull.a : hull.b;
    let wEff = sinA >= 0 ? hull.d : hull.c;
    return Math.sqrt((lEff * cosA) * (lEff * cosA) + (wEff * sinA) * (wEff * sinA));
}

function resolveVesselCategory(target) {
    const code = target.shipType || target.typeCode || 0;
    if ((code >= 40 && code <= 49) || (code >= 60 && code <= 89)) return 'commercial';
    if ((code >= 30 && code <= 32) || (code >= 50 && code <= 55)) return 'work';
    return 'sailing';
}

function hullCorners(hull, heading) {
    const h = d2r(heading);
    return [[hull.a, -hull.c], [hull.a, hull.d], [-hull.b, hull.d], [-hull.b, -hull.c]]
        .map(([forward, right]) => ({ x: forward * Math.sin(h) + right * Math.cos(h), y: forward * Math.cos(h) - right * Math.sin(h) }));
}

function resolveHullPose(vessel, hull) {
    const validAngle = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360;
    const moving = vessel.isMoving === true || (vessel.isMoving !== false && (vessel.sog || 0) >= 0.8);
    if (moving && validAngle(vessel.cog)) return { hull, heading: vessel.cog, orientationSource: 'COG' };
    if (!moving && validAngle(vessel.hdg)) return { hull, heading: vessel.hdg, orientationSource: 'HEADING' };
    // Unknown orientation: contain every possible rotation about the antenna,
    // including an off-centre antenna. A length-wide centred box is insufficient.
    const radius = hull.boundingRadius;
    return { hull: { ...hull, a: radius, b: radius, c: radius, d: radius }, heading: 0, orientationSource: 'UNKNOWN_SQUARE' };
}

const cross2 = (a, b) => a.x * b.y - a.y * b.x;
const subtract2 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

function convexHull(points) {
    // Equivalent right-angle rotations must sort identically despite sin(180°)
    // residue; otherwise the hull scan can incorrectly discard a real corner.
    const sorted = points.map(p => ({ x: Math.round(p.x * 1e9) / 1e9, y: Math.round(p.y * 1e9) / 1e9 }))
        .sort((a, b) => a.x - b.x || a.y - b.y)
        .filter((p, i, list) => i === 0 || p.x !== list[i - 1].x || p.y !== list[i - 1].y);
    const half = list => {
        const result = [];
        for (const p of list) {
            while (result.length >= 2 && cross2(subtract2(result.at(-1), result.at(-2)), subtract2(p, result.at(-1))) <= 1e-9) result.pop();
            result.push(p);
        }
        return result;
    };
    return half(sorted).slice(0, -1).concat(half(sorted.slice().reverse()).slice(0, -1));
}

// The separation of two translating rectangles equals the distance of their
// relative antenna position to the Minkowski difference of the hulls.
// Test the ray origin, edge intersections and vertex projections analytically;
// no sampling interval or arbitrary prediction horizon is needed.
function buildHullObstacle(ownHull, ownHeading, targetHull, targetHeading) {
    const ownCorners = hullCorners(ownHull, ownHeading);
    const targetCorners = hullCorners(targetHull, targetHeading);
    return convexHull(ownCorners.flatMap(a => targetCorners.map(b => subtract2(a, b))));
}

function clearanceToObstacle(position, obstacle) {
    if (obstacle.every((a, i) => cross2(subtract2(obstacle[(i + 1) % obstacle.length], a), subtract2(position, a)) >= -1e-7)) return 0;
    let distance = Infinity;
    for (let i = 0; i < obstacle.length; i++) {
        const a = obstacle[i], b = obstacle[(i + 1) % obstacle.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const length2 = dx * dx + dy * dy;
        const u = length2 ? Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.y - a.y) * dy) / length2)) : 0;
        distance = Math.min(distance, Math.hypot(position.x - a.x - u * dx, position.y - a.y - u * dy));
    }
    return distance;
}

function computeHullCpa(ownHull, ownHeading, targetHull, targetHeading, position, velocity, cachedObstacle) {
    const obstacle = cachedObstacle || buildHullObstacle(ownHull, ownHeading, targetHull, targetHeading);
    const v2 = velocity.x ** 2 + velocity.y ** 2;
    const inside = obstacle.every((a, i) => cross2(subtract2(obstacle[(i + 1) % obstacle.length], a), subtract2(position, a)) >= -1e-7);
    let bestDistance = Infinity, bestTime = 0;
    const consider = (distance, time) => {
        if (distance < bestDistance - 1e-7 || (Math.abs(distance - bestDistance) <= 1e-7 && time < bestTime)) {
            bestDistance = distance;
            bestTime = time;
        }
    };
    if (inside) return { cpaMeters: 0, tcpaSec: 0, isDiverging: false };
    for (let i = 0; i < obstacle.length; i++) {
        const a = obstacle[i], b = obstacle[(i + 1) % obstacle.length];
        const edge = subtract2(b, a), relative = subtract2(a, position);
        const edge2 = edge.x ** 2 + edge.y ** 2;
        const u = edge2 > 0 ? Math.max(0, Math.min(1, ((position.x - a.x) * edge.x + (position.y - a.y) * edge.y) / edge2)) : 0;
        consider(Math.hypot(position.x - a.x - u * edge.x, position.y - a.y - u * edge.y), 0);
        if (v2 < 1e-6) continue;
        const time = Math.max(0, (relative.x * velocity.x + relative.y * velocity.y) / v2);
        consider(Math.hypot(position.x + velocity.x * time - a.x, position.y + velocity.y * time - a.y), time);
        const denominator = cross2(velocity, edge);
        if (Math.abs(denominator) > 1e-9) {
            const t = cross2(relative, edge) / denominator;
            const s = cross2(relative, velocity) / denominator;
            if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9) consider(0, t);
        }
    }
    const approaching = v2 >= 1e-6 && bestTime > 1e-7;
    return { cpaMeters: bestDistance, tcpaSec: approaching ? bestTime : -1, isDiverging: !approaching };
}


// ----------------------------------------------------------------------------
// 3. MODULO 2: CONO DINAMICO DI INCERTEZZA
// ----------------------------------------------------------------------------
function calculateUncertaintyCone(target, now) {
    let lastFixTime = target.lastUpdate || target.timestamp || now;
    let fixAgeSec = Math.max(0, (now - lastFixTime) / 1000);
    // Clamp dell'età fix per evitare dispersioni infinite su target persi
    let ageEffective = Math.min(fixAgeSec, 300);

    let isClassB = target.isClassB !== false; // prudenziale
    let sogKnots = Math.max(0, target.sog || 0);

    // Jitter GNSS nominale + deriva su età pacchetto
    let gnssSigmaMeters = isClassB ? 7.5 : 3.0;
    let posUncertaintyMeters = gnssSigmaMeters + (sogKnots * KNOTS_TO_MS * 0.05 * ageEffective);

    // Cono angolare rotta: imbarcazioni lente o datate hanno incertezza angolare maggiore
    let baseAngularConeDeg = isClassB ? 5.0 : 3.0;
    let dynamicAngularConeDeg = baseAngularConeDeg + (20.0 / Math.max(2.0, sogKnots)) * Math.min(1.0, ageEffective / 60.0);
    let halfConeDeg = Math.min(30.0, dynamicAngularConeDeg);

    // Incertezza su velocità SOG
    let sogUncertaintyKnots = Math.min(3.0, 0.4 + sogKnots * 0.06);

    return {
        fixAgeSec,
        posUncertaintyMeters,
        halfConeDeg,
        sogUncertaintyKnots
    };
}

// ----------------------------------------------------------------------------
// 4. MODULO 3: CINEMATICA VETTORIALE E ARPA
// ----------------------------------------------------------------------------
function solveRelativeKinematics(x0, y0, myVx, myVy, targetVx, targetVy) {
    let vx = targetVx - myVx;
    let vy = targetVy - myVy;
    let v2 = vx * vx + vy * vy;

    if (v2 < 1e-6) {
        // Moto relativo nullo (velocità identiche)
        return {
            tcpaSec: -1,
            cpaMeters: Math.sqrt(x0 * x0 + y0 * y0),
            vx,
            vy,
            relSpeedMs: 0
        };
    }

    let tSec = -(x0 * vx + y0 * vy) / v2;
    let cpaX = x0 + vx * tSec;
    let cpaY = y0 + vy * tSec;
    let cpaMeters = Math.sqrt(cpaX * cpaX + cpaY * cpaY);
    let cpaBearingDeg = (cpaMeters > 0.5)
        ? normalizeDegrees(r2d(Math.atan2(cpaX, cpaY)))
        : normalizeDegrees(r2d(Math.atan2(x0, y0)));

    return {
        tcpaSec: tSec,
        cpaMeters,
        cpaBearingDeg,
        vx,
        vy,
        relSpeedMs: Math.sqrt(v2)
    };
}

function computeCpaTcpa(ownShip, target, uncertainty, hulls) {
    let myLat = ownShip.lat;
    let myLon = ownShip.lon;
    let targetLat = target.lat;
    let targetLon = target.lon;

    // Coordinate cartesiane piane centrate su OwnShip (metri)
    let x0 = (targetLon - myLon) * METERS_PER_DEG_LAT * Math.cos(d2r(myLat));
    let y0 = (targetLat - myLat) * METERS_PER_DEG_LAT;
    let rangeMeters = Math.sqrt(x0 * x0 + y0 * y0);

    let ownSog = (ownShip.sog || 0) >= 0.8 ? (ownShip.sog || 0) : 0;
    let mySpeedMs = ownSog * KNOTS_TO_MS;
    let myCog = ownShip.cog || 0;
    let myVx = mySpeedMs * Math.sin(d2r(myCog));
    let myVy = mySpeedMs * Math.cos(d2r(myCog));

    let targetSog = target.isMoving === true || (target.sog || 0) >= 0.8 ? (target.sog || 0) : 0;
    let targetCog = target.cog || 0;
    let targetSpeedMs = targetSog * KNOTS_TO_MS;
    let targetVx = targetSpeedMs * Math.sin(d2r(targetCog));
    let targetVy = targetSpeedMs * Math.cos(d2r(targetCog));

    // 1. Cinematica Nominale
    const ownHull = hulls ? hulls.ownHull : getHullBoundingRadius(ownShip, 'sailing');
    const targetHull = hulls ? hulls.targetHull : getHullBoundingRadius(target, resolveVesselCategory(target));
    const ownPose = resolveHullPose(ownShip, ownHull);
    const targetPose = resolveHullPose(target, targetHull);
    const obstacle = buildHullObstacle(ownPose.hull, ownPose.heading, targetPose.hull, targetPose.heading);
    const antennaNominal = solveRelativeKinematics(x0, y0, myVx, myVy, targetVx, targetVy);
    const solveHulls = (vx, vy) => computeHullCpa(ownPose.hull, ownPose.heading, targetPose.hull, targetPose.heading,
        { x: x0, y: y0 }, { x: vx - myVx, y: vy - myVy }, obstacle);
    const nominal = solveHulls(targetVx, targetVy);

    // 2. Dispersione ai bordi del cono d'incertezza (solo se il bersaglio è in movimento)
    let cpaMin = nominal.cpaMeters;
    let cpaMax = nominal.cpaMeters;

    if (uncertainty && targetSog >= 0.8) {
        let halfCone = uncertainty ? uncertainty.halfConeDeg : 0;
        let sogDelta = uncertainty ? uncertainty.sogUncertaintyKnots : 0;

        let testVectors = [
            { cog: targetCog - halfCone, sog: Math.max(0, targetSog - sogDelta) },
            { cog: targetCog - halfCone, sog: targetSog + sogDelta },
            { cog: targetCog + halfCone, sog: Math.max(0, targetSog - sogDelta) },
            { cog: targetCog + halfCone, sog: targetSog + sogDelta }
        ];

        for (let i = 0; i < testVectors.length; i++) {
            let tv = testVectors[i];
            let tvSpeedMs = tv.sog * KNOTS_TO_MS;
            let tvVx = tvSpeedMs * Math.sin(d2r(tv.cog));
            let tvVy = tvSpeedMs * Math.cos(d2r(tv.cog));
            let res = solveHulls(tvVx, tvVy);

            if (res.tcpaSec >= 0) {
                if (res.cpaMeters < cpaMin) cpaMin = res.cpaMeters;
                if (res.cpaMeters > cpaMax) cpaMax = res.cpaMeters;
            }
        }
    }

    // Incorpora incertezza posizione su cpaMin
    if (uncertainty) {
        cpaMin = Math.max(0, cpaMin - uncertainty.posUncertaintyMeters);
        cpaMax = cpaMax + uncertainty.posUncertaintyMeters;
    }

    let tcpaSeconds = nominal.tcpaSec;
    let tcpaMinutes = nominal.tcpaSec >= 0 ? (nominal.tcpaSec / 60.0) : -1;
    let bearingNowDeg = normalizeDegrees(r2d(Math.atan2(x0, y0)));
    const hullTime = Math.max(0, nominal.tcpaSec);
    const cpaX = x0 + (targetVx - myVx) * hullTime;
    const cpaY = y0 + (targetVy - myVy) * hullTime;
    const cpaBearingDeg = Math.hypot(cpaX, cpaY) > 0.5 ? normalizeDegrees(r2d(Math.atan2(cpaX, cpaY))) : bearingNowDeg;

    return {
        rangeMeters: Math.round(rangeMeters),
        rangeNM: rangeMeters / 1852.0,
        bearingNowDeg,
        cpaBearingDeg,
        cpaNominalMeters: nominal.cpaMeters,
        cpaMinMeters: cpaMin,
        cpaMaxMeters: cpaMax,
        tcpaSeconds,
        tcpaMinutes,
        tcpaSec: tcpaSeconds,
        isDiverging: nominal.isDiverging,
        antennaCpaMeters: antennaNominal.cpaMeters,
        antennaTcpaSeconds: antennaNominal.tcpaSec,
        hullMarginMeters: Math.max(0, Math.hypot(cpaX, cpaY) - nominal.cpaMeters),
        hullPrediction: { position: { x: x0, y: y0 }, velocity: { x: targetVx - myVx, y: targetVy - myVy }, obstacle }
    };
}

function evaluateInstabilityWarning(kinematics, stability, thresholds, now, config) {
    if (!stability || stability.state !== 'VARIABLE' || !Number.isFinite(stability.uncertaintyGrowthMps) ||
        stability.uncertaintyGrowthMps <= 0 || !Number.isFinite(stability.lastFixTime)) return null;
    const age = Math.max(0, (now - stability.lastFixTime) / 1000);
    if (age > config.movingTargetMaxAgeSeconds) return null;
    const { position, velocity, obstacle } = kinematics.hullPrediction;
    const horizon = thresholds.horizonTcpa * 60;
    const limit = thresholds.orangeCpa * (1 - config.instabilityPenetrationFraction);
    const fraction = Number.isFinite(config.instabilityMaximumRadiusFraction) && config.instabilityMaximumRadiusFraction >= 0
        ? config.instabilityMaximumRadiusFraction : 0.2;
    const maxRadius = thresholds.orangeCpa * fraction;
    const gap = t => clearanceToObstacle({ x: position.x + velocity.x * t, y: position.y + velocity.y * t }, obstacle)
        - Math.min(maxRadius, stability.uncertaintyGrowthMps * (age + t));
    // Subtracting a capped linear radius preserves convexity. Locate the minimum
    // and both threshold crossings without relying on isolated samples.
    let left = 0, right = horizon;
    for (let i = 0; i < 55; i++) {
        const a = left + (right - left) / 3, b = right - (right - left) / 3;
        if (gap(a) <= gap(b)) right = b;
        else left = a;
    }
    let minimumTime = (left + right) / 2;
    if (gap(0) < gap(minimumTime)) minimumTime = 0;
    if (gap(horizon) < gap(minimumTime)) minimumTime = horizon;
    if (gap(minimumTime) > limit) return null;
    const crossing = (a, b, entering) => {
        for (let i = 0; i < 45; i++) {
            const t = (a + b) / 2;
            if ((gap(t) <= limit) === entering) b = t;
            else a = t;
        }
        return (a + b) / 2;
    };
    const entrySeconds = gap(0) <= limit ? 0 : crossing(0, minimumTime, true);
    const exitSeconds = gap(horizon) <= limit ? horizon : crossing(minimumTime, horizon, false);
    if (exitSeconds - entrySeconds < config.instabilityMinimumDurationSeconds) return null;
    return { possibleCpaMeters: Math.max(0, gap(minimumTime)), possibleTcpaSeconds: minimumTime,
        entrySeconds, exitSeconds, durationSeconds: exitSeconds - entrySeconds };
}

function computeSighting(relBearingDeg) {
    let rel = normalizeDegrees(relBearingDeg);
    let clockHour = Math.round(rel / 30) % 12;
    if (clockHour === 0) clockHour = 12;

    let sightAngleTxt = "";
    if (rel <= 10 || rel >= 350) sightAngleTxt = "Straight ahead";
    else if (rel >= 80 && rel <= 100) sightAngleTxt = "To the right";
    else if (rel >= 260 && rel <= 280) sightAngleTxt = "To the left";
    else if (rel >= 170 && rel <= 190) sightAngleTxt = "Directly behind";
    else if (rel < 180) sightAngleTxt = `${Math.round(rel)}° right`;
    else sightAngleTxt = `${Math.round(360 - rel)}° left`;

    return `${sightAngleTxt} (${clockHour} o'clock)`;
}

function evaluateColreg(ownShip, target, kinematics, alertState, category) {
    let ownHdg = (ownShip.hdg !== undefined && ownShip.hdg !== null) ? ownShip.hdg : (ownShip.cog || 0);
    let relBearingDeg = normalizeDegrees(kinematics.bearingNowDeg - ownHdg);
    let sightingTxt = computeSighting(relBearingDeg);
    let crossOutcome = kinematics.isDiverging ? "In Allontanamento" : "In Avvicinamento";

    if (alertState === 'NO_DANGER' || (target.sog || 0) < 0.5) {
        return { relBearingDeg, sightingTxt, crossOutcome, crossDir: '', crossRule: '' };
    }

    let passTxt = '';
    if (kinematics.tcpaSec > 0) {
        let mySpeedMs = (ownShip.sog || 0) * KNOTS_TO_MS;
        let myVx = mySpeedMs * Math.sin(d2r(ownShip.cog || 0));
        let myVy = mySpeedMs * Math.cos(d2r(ownShip.cog || 0));
        let tgtSpeedMs = (target.sog || 0) * KNOTS_TO_MS;
        let tgtVx = tgtSpeedMs * Math.sin(d2r(target.cog || 0));
        let tgtVy = tgtSpeedMs * Math.cos(d2r(target.cog || 0));

        let tSec = kinematics.tcpaSec;
        let x0 = (target.lon - ownShip.lon) * METERS_PER_DEG_LAT * Math.cos(d2r(ownShip.lat));
        let y0 = (target.lat - ownShip.lat) * METERS_PER_DEG_LAT;
        let relX_cpa = x0 + (tgtVx - myVx) * tSec;
        let relY_cpa = y0 + (tgtVy - myVy) * tSec;

        let bowDist = relX_cpa * Math.sin(d2r(ownHdg)) + relY_cpa * Math.cos(d2r(ownHdg));
        let distStr = Math.abs(bowDist) >= 1852 ? `${(Math.abs(bowDist) / 1852).toFixed(1)} NM` : `${Math.round(Math.abs(bowDist))} m`;
        passTxt = bowDist >= 0 ? `Passa a prora a ${distStr}` : `Passa a poppa a ${distStr}`;
    }

    let crossRule = '';
    let crossDir = '';
    let targetCog = target.cog || 0;
    let ownCog = ownShip.cog || 0;
    let cogDiff = Math.abs(normalizeDegrees(targetCog - ownCog) - 180);

    if (category === 'work') {
        crossRule = "R.18: Dare precedenza (nave con manovrabilità limitata o pesca)";
        crossDir = passTxt ? `${passTxt} | R.18 DARE PRECEDENZA` : "R.18 DARE PRECEDENZA";
    } else if (cogDiff <= 25 && (relBearingDeg <= 15 || relBearingDeg >= 345)) {
        crossRule = "R.14: Rotte opposte di prua (accostare a dritta)";
        crossDir = passTxt ? `${passTxt} | R.14 ROTTE OPPOSTE` : "R.14 ROTTE OPPOSTE (accosta a dritta)";
    } else if (relBearingDeg > 112.5 && relBearingDeg < 247.5 && (target.sog || 0) > (ownShip.sog || 0)) {
        crossRule = "R.13: Bersaglio in sorpasso da poppa";
        crossDir = passTxt ? `${passTxt} | R.13 BERSAGLIO IN SORPASSO` : "R.13 BERSAGLIO IN SORPASSO";
    } else if (relBearingDeg > 15 && relBearingDeg <= 112.5) {
        crossRule = "R.15: Bersaglio a dritta (DARE PRECEDENZA)";
        crossDir = passTxt ? `${passTxt} | R.15 DARE PRECEDENZA` : "R.15 DARE PRECEDENZA (bersaglio a dritta)";
    } else if (relBearingDeg >= 247.5 && relBearingDeg < 345) {
        crossRule = "R.15: Bersaglio a sinistra (MANTIENI ROTTA)";
        crossDir = passTxt ? `${passTxt} | R.15 MANTIENI ROTTA` : "R.15 MANTIENI ROTTA (bersaglio a sinistra)";
    } else {
        crossRule = "COLREG-72";
        crossDir = passTxt || "Attenzione incrocio";
    }

    return { relBearingDeg, sightingTxt, crossOutcome, crossDir, crossRule };
}

// ----------------------------------------------------------------------------
// 5. MODULO 4: SOGLIE, TREND E STATE MACHINE
// ----------------------------------------------------------------------------
const SEVERITY_LEVELS = {
    NO_DANGER: 0,
    ORANGE: 1,
    RED: 2
};

function compareTargets(a, b) {
    const levels = { RED: 2, ORANGE: 1, GREEN: 0, GREY: 0, NO_DANGER: 0 };
    const severity = t => levels[t.alertState ?? t.risk] || 0;
    const firstValid = (...values) => values.find(v => Number.isFinite(v) && v >= 0);
    const range = t => firstValid(t.rangeMeters, t.dist) ?? Number.MAX_SAFE_INTEGER;
    const cpa = t => Math.round(firstValid(t.cpaNominalMeters, t.cpa) ?? range(t));
    const time = t => firstValid(t.tcpaMinutes, t.tcpa) ?? 999;
    const sevA = severity(a), sevB = severity(b);
    if (sevA !== sevB) return sevB - sevA;
    if (sevA > 0) {
        const scoreA = cpa(a) + time(a) * 60;
        const scoreB = cpa(b) + time(b) * 60;
        if (scoreA !== scoreB) return scoreA - scoreB;
        if (cpa(a) !== cpa(b)) return cpa(a) - cpa(b);
    }
    if (range(a) !== range(b)) return range(a) - range(b);
    const idA = String(a.targetId ?? a.id ?? a.mmsi ?? a.name ?? '');
    const idB = String(b.targetId ?? b.id ?? b.mmsi ?? b.name ?? '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
}

class CollisionPipeline {
    constructor(userConfig = {}) {
        this.config = Object.assign({
            ...COLLISION_THRESHOLD_DEFAULTS,
            maxTargetMemoryMs: 12 * 60 * 1000 // 12 min di ritenzione stato
        }, userConfig);

        this.targetStates = new Map(); // mmsi -> TargetState
    }

    updateConfig(newConfig) {
        Object.assign(this.config, newConfig);
    }

    _resolveVesselCategory(target) {
        return resolveVesselCategory(target);
    }

    _resolveThresholds(target, category, ownShip = {}) {
        const cfg = this.config;
        const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
        const prefix = category === 'commercial' ? 'commercial' : category === 'work' ? 'work' : 'yacht';
        const baseRed = positive(cfg[`${prefix}RedCpaMeters`], COLLISION_THRESHOLD_DEFAULTS[`${prefix}RedCpaMeters`]);
        const referenceKnots = positive(cfg[`${prefix}ReferenceKnots`], COLLISION_THRESHOLD_DEFAULTS[`${prefix}ReferenceKnots`]);
        const targetKnots = Number.isFinite(target.sog) ? Math.max(0, target.sog) : 0;
        const ownKnots = Math.max(positive(cfg.minimumOwnSpeedKnots, 4), Number.isFinite(ownShip.sog) ? ownShip.sog : 0);
        const distanceFactor = Math.max(1, targetKnots / referenceKnots);
        const redCpa = baseRed * distanceFactor;
        const orangeCpa = redCpa * positive(cfg.warningDistanceRatio, 2);
        const baseMinutes = positive(cfg.baseTcpaMinutes, 5);
        const coefficient = Number.isFinite(cfg.lookaheadSpeedCoefficient) && cfg.lookaheadSpeedCoefficient >= 0 ? cfg.lookaheadSpeedCoefficient : 0.5;
        const horizonTcpa = Math.min(Math.max(baseMinutes, positive(cfg.maximumLookaheadMinutes, 30)),
            baseMinutes * (1 + coefficient * Math.max(0, targetKnots / ownKnots - 1)));
        return { redCpa, orangeCpa, critTcpa: horizonTcpa, horizonTcpa, baseRedCpa: baseRed,
            referenceKnots, distanceFactor, baseTcpaMinutes: baseMinutes };
    }

    _computeTrend(history) {
        if (!history || history.length < 2) {
            return { trend: 'STABLE', deltaCpaPerMin: 0.0 };
        }

        let first = history[0];
        let last = history[history.length - 1];
        let dtMinutes = (last.t - first.t) / 60000.0;

        if (dtMinutes < 0.15) {
            return { trend: 'STABLE', deltaCpaPerMin: 0.0 };
        }

        let dCpa = last.cpaNominalMeters - first.cpaNominalMeters;
        let deltaPerMin = dCpa / dtMinutes;

        let trend = 'STABLE';
        if (deltaPerMin < -100.0) {
            trend = 'WORSENING'; // Bersaglio sta stringendo rotta o accelerando
        } else if (deltaPerMin > 100.0) {
            trend = 'IMPROVING'; // Bersaglio sta accostando in apertura
        }

        return {
            trend,
            deltaCpaPerMin: Math.round(deltaPerMin)
        };
    }

    evaluateTarget(ownShip, target, now = Date.now()) {
        let targetId = target.mmsi || target.id || target.name;
        if (!targetId) return null;

        let isMoored = Boolean(target.isMoored || target.inCluster || target.anchorState === 'MOORED' || (target.sog !== undefined && target.sog < 0.3 && !target.isMoving));
        if (isMoored) {
            this.targetStates.delete(targetId);
            let kinematics = computeCpaTcpa(ownShip, target, null);
            let ownHdg = (ownShip.hdg !== undefined && ownShip.hdg !== null) ? ownShip.hdg : (ownShip.cog || 0);
            let rel = normalizeDegrees(kinematics.bearingNowDeg - ownHdg);
            return {
                targetId,
                mmsi: target.mmsi,
                name: target.name || `MMSI ${target.mmsi || 'N/A'}`,
                category: this._resolveVesselCategory(target),
                alertState: 'NO_DANGER',
                trend: 'STABLE',
                deltaCpaPerMin: 0,
                rangeMeters: kinematics.rangeMeters,
                rangeNM: kinematics.rangeNM,
                bearingNowDeg: kinematics.bearingNowDeg,
                relBearingDeg: rel,
                cpaNominalMeters: null,
                cpaMinMeters: null,
                cpaMaxMeters: null,
                tcpaSeconds: -1,
                tcpaMinutes: -1,
                isDiverging: kinematics.isDiverging,
                hullMarginMeters: 0,
                uncertaintyConeDeg: 0,
                reason: '',
                crossDir: '',
                crossOutcome: kinematics.isDiverging ? 'In Allontanamento' : 'In Avvicinamento',
                crossRule: '',
                sightingTxt: computeSighting(rel)
            };
        }

        let category = this._resolveVesselCategory(target);
        let ownHull = getHullBoundingRadius(ownShip, 'sailing');
        let targetHull = getHullBoundingRadius(target, category);

        const uncertainty = null; // Fixed hypothetical cones no longer drive alerts.
        let kinematics = computeCpaTcpa(ownShip, target, uncertainty, { ownHull, targetHull });

        // CPA values already represent hull-to-hull clearances: do not subtract
        // another geometric margin. The uncertainty layer remains separate.
        let totalHullMargin = Math.round(kinematics.hullMarginMeters);
        let netCpaNominal = kinematics.cpaNominalMeters;
        let netCpaMin = kinematics.cpaMinMeters;
        let netCpaMax = kinematics.cpaMaxMeters;

        let thresholds = this._resolveThresholds(target, category, ownShip);

        // Nominal alarms use the user's speed-adjusted limits and one time window.
        let rawState = 'NO_DANGER';
        let reason = '';
        let rawBasis = null;
        let instabilityWarning = null;
        const ownIsMoving = (ownShip.sog || 0) >= 0.8;
        const targetIsMoving = target.isMoving === true || (target.sog || 0) >= 0.8;
        const eitherMoving = ownIsMoving || targetIsMoving;
        const tcpa = kinematics.tcpaMinutes;
        if (eitherMoving && !kinematics.isDiverging && tcpa >= 0 && tcpa <= thresholds.horizonTcpa) {
            if (netCpaNominal <= thresholds.redCpa) {
                rawState = 'RED';
                rawBasis = 'NOMINAL';
                reason = targetIsMoving ? 'RISCHIO COLLISIONE!' : 'ATTENZIONE OSTACOLO';
            } else if (netCpaNominal <= thresholds.orangeCpa) {
                rawState = 'ORANGE';
                rawBasis = 'NOMINAL';
                reason = targetIsMoving ? 'ATTENZIONE INCROCIO' : 'ATTENZIONE OSTACOLO';
            }
        }
        // Observed instability can add orange only; it cannot upgrade orange to red.
        if (rawState === 'NO_DANGER' && eitherMoving) {
            instabilityWarning = evaluateInstabilityWarning(kinematics, target.predictionStability, thresholds, now,
                target.contactLost ? { ...this.config, movingTargetMaxAgeSeconds: Infinity } : this.config);
            if (instabilityWarning) {
                rawState = 'ORANGE';
                rawBasis = 'INSTABILITY';
                reason = 'POSSIBILE AVVICINAMENTO: TRAIETTORIA VARIABILE';
                netCpaMin = Math.min(netCpaNominal, instabilityWarning.possibleCpaMeters);

            }
        }

        // 3. Macchina a Stati con Isteresi Asimmetrica e Tracking Storico
        let state = this.targetStates.get(targetId);
        if (!state) {
            state = {
                id: targetId,
                currentState: rawState,
                reason: reason,
                warningBasis: rawBasis,
                history: [],
                deescalateTimerStartedAt: null,
                lastSeen: now
            };
            this.targetStates.set(targetId, state);
        }

        state.lastSeen = now;

        // Aggiorna buffer storico con debounce di 5s (compatibile sia con loop 1Hz che 15s)
        let lastHist = state.history[state.history.length - 1];
        if (!lastHist || (now - lastHist.t) >= 5000) {
            state.history.push({
                t: now,
                cpaNominalMeters: netCpaNominal,
                cpaMinMeters: netCpaMin,
                tcpaMinutes: tcpa,
                rangeMeters: kinematics.rangeMeters
            });
            if (state.history.length > 6) {
                state.history.shift();
            }
        }

        let { trend, deltaCpaPerMin } = this._computeTrend(state.history);

        let currSev = SEVERITY_LEVELS[state.currentState];
        let rawSev = SEVERITY_LEVELS[rawState];

        if (rawSev >= currSev) {
            // Escalation is immediate; returning to the held level cancels recovery.
            state.currentState = rawState;
            state.reason = reason;
            state.warningBasis = rawBasis;
            state.deescalateTimerStartedAt = null;
        } else {
            // Any continuously lower risk qualifies, even if its level changes.
            // Use the configured base time, not the speed-expanded horizon.
            if (state.deescalateTimerStartedAt === null) state.deescalateTimerStartedAt = now;
            const fraction = Number.isFinite(this.config.deescalationBaseTimeFraction) && this.config.deescalationBaseTimeFraction > 0
                ? this.config.deescalationBaseTimeFraction : 0.2;
            const requiredHoldMs = thresholds.baseTcpaMinutes * 60000 * fraction;
            if (now - state.deescalateTimerStartedAt >= requiredHoldMs) {
                state.currentState = rawState;
                state.reason = reason;
                state.warningBasis = rawBasis;
                state.deescalateTimerStartedAt = null;
            }
        }

        let colreg = evaluateColreg(ownShip, target, kinematics, state.currentState, category);

        return {
            targetId,
            mmsi: target.mmsi,
            name: target.name || `MMSI ${target.mmsi || 'N/A'}`,
            category,
            // Stato filtrato dalla macchina a stati
            alertState: state.currentState,
            trend,
            deltaCpaPerMin,
            // Metriche geometriche e cinematiche (precisione piena per le decisioni)
            rangeMeters: kinematics.rangeMeters,
            rangeNM: kinematics.rangeNM,
            bearingNowDeg: kinematics.bearingNowDeg,
            cpaNominalMeters: netCpaNominal,
            cpaMinMeters: netCpaMin,
            cpaMaxMeters: netCpaMax,
            tcpaSeconds: kinematics.tcpaSeconds,
            tcpaMinutes: kinematics.tcpaMinutes,
            isDiverging: kinematics.isDiverging,
            // Dettagli diagnostici incertezza e scafo
            hullMarginMeters: totalHullMargin,
            antennaCpaMeters: kinematics.antennaCpaMeters,
            antennaTcpaSeconds: kinematics.antennaTcpaSeconds,
            uncertaintyConeDeg: 0,
            effectiveThresholds: thresholds,
            warningBasis: state.warningBasis,
            instabilityWarning,
            reason: state.reason || '',
            // Valutazione incrocio COLREGs e rilevamento
            crossDir: colreg.crossDir,
            crossRule: colreg.crossRule,
            crossOutcome: colreg.crossOutcome,
            sightingTxt: colreg.sightingTxt,
            relBearingDeg: colreg.relBearingDeg
        };
    }

    evaluateBatch(ownShip, targetsList, now = Date.now()) {
        if (!ownShip || !Array.isArray(targetsList)) {
            return { targets: [], topThreat: null, summary: { red: 0, orange: 0, noDanger: 0, total: 0 } };
        }

        let evaluated = [];
        let redCount = 0;
        let orangeCount = 0;
        let noDangerCount = 0;

        for (let i = 0; i < targetsList.length; i++) {
            let res = this.evaluateTarget(ownShip, targetsList[i], now);
            if (!res) continue;
            evaluated.push(res);
            if (res.alertState === 'RED') redCount++;
            else if (res.alertState === 'ORANGE') orangeCount++;
            else noDangerCount++;
        }

        evaluated.sort(compareTargets);

        let topThreat = (evaluated.length > 0 && (SEVERITY_LEVELS[evaluated[0].alertState] || 0) > 0) ? evaluated[0] : null;
        this.pruneInactive(now);

        return {
            targets: evaluated,
            topThreat,
            summary: { red: redCount, orange: orangeCount, noDanger: noDangerCount, total: evaluated.length }
        };
    }

    pruneInactive(now = Date.now()) {
        for (let [id, state] of this.targetStates.entries()) {
            if ((now - state.lastSeen) > this.config.maxTargetMemoryMs) {
                this.targetStates.delete(id);
            }
        }
    }

    sortTargets(targetsList) {
        if (!Array.isArray(targetsList)) return targetsList;
        return targetsList.sort(compareTargets);
    }

    compareTargets(a, b) {
        return compareTargets(a, b);
    }
}

const _pipelineExports = {
    CollisionPipeline,
    getHullBoundingRadius,
    getHullEllipticalMargin,
    resolveHullPose,
    calculateUncertaintyCone,
    computeCpaTcpa,
    solveRelativeKinematics,
    computeHullCpa,
    evaluateInstabilityWarning,
    COLLISION_THRESHOLD_DEFAULTS,
    computeSighting,
    evaluateColreg,
    compareTargets
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _pipelineExports;
}
if (typeof globalThis !== 'undefined') {
    globalThis.RotevistaCollisionPipeline = _pipelineExports;
}

