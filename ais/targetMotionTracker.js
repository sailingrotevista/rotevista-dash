// Shared operational motion tracker. See docs/motion-tracker-spec.md.
'use strict';
const { TargetPredictionStability } = require('./targetPredictionStability');

const REST_CONFIRMATION_FIXES = 5;
const REST_CONFIRMATION_SECONDS = 300;

// Soglie modificabili: il tracker usa solo fix ricevuti, mai posizioni proiettate.
const MOTION_TRACKER_CONFIG = {
    maxObservationPoints: 120,
    observationMinutes: 15,
    maxTrailPoints: 60,
    initialStationaryMaxSpeedKnots: 0.5,
    sourceTimestampToleranceSeconds: 30,
    settleDiameterMeters: 50,
    settleSeconds: REST_CONFIRMATION_SECONDS,
    minimumSettleFixes: REST_CONFIRMATION_FIXES,
    departureOutsideAreaMeters: 300,
    departureAnchorageMeters: 150,
    departurePortMeters: 50,
    departureFixes: 3,
    ownDepartureHistorySeconds: 300,
    // Inherited limits until the dedicated evidence-window parameters are reviewed.
    // Wind records are bounded separately and never geometrically compressed.
    windEvidenceSeconds: 900,
    maxWindEvidencePoints: 120,
    // Descrizione della sosta: diagnostica, non modifica gli stati di movimento.
    windMooringMinimumSeconds: 300,
    windMooringMinimumSamples: 3,
    windMooringMinimumKnots: 6,
    windMooringHeadingSpreadDegrees: 15,
    windMooringMinimumAngleDegrees: 45,
    windMooringWindShiftDegrees: 30,
    windMooringMaximumAgeSeconds: 180,
    windMooringMaximumRangeMeters: 1852,
    restMinimumFixes: REST_CONFIRMATION_FIXES,
    restMinimumSpanSeconds: REST_CONFIRMATION_SECONDS,
    restMaximumGapSeconds: 360,
    restFixedRadiusMeters: 12,
    restOscillationRadiusMeters: 20,
    restExcursionMeters: 20,
    restReturnToleranceMeters: 10,
    restMinimumReturns: 2,
    restOutlierMinimumMeters: 80,
    restOutlierMedianMultiplier: 3,
};

function distanceMeters(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * 111139 * Math.cos((lat1 + lat2) * Math.PI / 360);
    const dy = (lat2 - lat1) * 111139;
    return Math.hypot(dx, dy);
}

function angleDifference(a, b) {
    return Math.abs(((a - b + 540) % 360) - 180);
}

function describeWindMooring(state, config, confirmed, now = state.lastFix.t) {
    const empty = { available: false, supported: false, strong: false, sampleCount: 0 };
    if (!confirmed) return empty;
    const samples = state.windEvidence.filter(p => p.t >= Math.max(state.area.since, state.restObservationSince));
    if (!samples.length) return empty;
    const last = samples.at(-1).windHeading;
    if (now - last.t > config.windMooringMaximumAgeSeconds * 1000) return empty;
    // Every sample has a distinct AIS heading timestamp; repeated values are fine,
    // repeated reports are not independent evidence.
    const headingSpread = Math.max(...samples.map(p => angleDifference(p.windHeading.heading, samples[0].windHeading.heading)));
    const span = (last.t - samples[0].windHeading.t) / 1000;
    const supported = samples.length >= config.windMooringMinimumSamples && span >= config.windMooringMinimumSeconds &&
        headingSpread <= config.windMooringHeadingSpreadDegrees && samples.every(p =>
            p.windHeading.speedKnots >= config.windMooringMinimumKnots &&
            angleDifference(p.windHeading.heading, p.windHeading.direction) >= config.windMooringMinimumAngleDegrees);
    const windShift = Math.max(...samples.map(p => angleDifference(p.windHeading.direction, samples[0].windHeading.direction)));
    return { available: true, supported, strong: supported && windShift >= config.windMooringWindShiftDegrees,
        sampleCount: samples.length, observedSpanSeconds: span, headingSpreadDegrees: headingSpread, windShiftDegrees: windShift,
        lastHeadingTime: last.t };
}

function describeRest(state, config) {
    if (state.motionState === 'MOVING') return null;
    const since = Math.max(state.area.since, state.restObservationSince);
    const observations = state.observations.filter(p => p.t >= since);
    // Bound the descriptive rest geometry without moving the rest reference.
    // These statistics do not feed the rolling three-fix departure decision.
    let points = observations.filter(p => distanceMeters(state.area.lat, state.area.lon, p.lat, p.lon) <=
        state.departureThresholdMeters);
    const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    if (points.length >= 3) {
        const lat = median(points.map(p => p.lat)), lon = median(points.map(p => p.lon));
        const distances = points.map(p => distanceMeters(lat, lon, p.lat, p.lon));
        const cutoff = Math.max(config.restOutlierMinimumMeters, median(distances) * config.restOutlierMedianMultiplier);
        points = points.filter((_, i) => distances[i] <= cutoff);
    }
    const center = points.length ? {
        lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
        lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
    } : null;
    const distances = center ? points.map(p => distanceMeters(center.lat, center.lon, p.lat, p.lon)) : [];
    const radiusMeters = distances.length ? Math.max(...distances) : null;
    const dispersionMeters = distances.length ? Math.sqrt(distances.reduce((sum, d) => sum + d * d, 0) / distances.length) : null;
    let returnCount = 0, excursion = false;
    if (points.length) {
        const reference = points[0];
        for (const p of points.slice(1)) {
            const distance = distanceMeters(reference.lat, reference.lon, p.lat, p.lon);
            if (distance >= config.restExcursionMeters) excursion = true;
            if (excursion && distance <= config.restReturnToleranceMeters) {
                returnCount++;
                excursion = false;
            }
        }
    }
    const observedSpanSeconds = points.length > 1 ? (points.at(-1).t - points[0].t) / 1000 : 0;
    const confirmed = state.restConfirmed || (points.length >= config.restMinimumFixes &&
        observedSpanSeconds >= config.restMinimumSpanSeconds);
    let kind = 'UNDETERMINED';
    if (confirmed && Number.isFinite(radiusMeters) && radiusMeters <= config.restFixedRadiusMeters) kind = 'FIXED';
    else if (confirmed && radiusMeters >= config.restOscillationRadiusMeters && returnCount >= config.restMinimumReturns) kind = 'OSCILLATING';
    return {
        windMooring: describeWindMooring(state, config, confirmed),
        kind, confirmed, since: state.area.since,
        observedDurationSeconds: Math.max(0, (state.lastFix.t - since) / 1000),
        observedSpanSeconds, sampleCount: points.length,
        requiredFixes: config.restMinimumFixes, requiredSpanSeconds: config.restMinimumSpanSeconds,
        center, radiusMeters, dispersionMeters, returnCount,
        excludedSamples: observations.length - points.length,
        lastFixTime: state.lastFix.t,
    };
}

const MOTION_STATES = Object.freeze({ MOVING: 'MOVING', STATIONARY: 'STATIONARY' });

class TargetMotionTracker {
    constructor(config = {}, { harborDetector = null } = {}) {
        this.config = { ...MOTION_TRACKER_CONFIG, ...config };
        this.targets = new Map();
        this.harborDetector = harborDetector;
    }

    update(id, fix, { now, historyMs, wind = null }) {
        // 1. Validate before touching either position history or state.
        if (!fix || !Number.isFinite(now) || !Number.isFinite(fix.t) ||
            !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) ||
            Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180 || fix.t > now ||
            (fix.sourceTime !== undefined && (!Number.isFinite(fix.sourceTime) || fix.sourceTime > now+this.config.sourceTimestampToleranceSeconds*1000)) ||
            fix.isProjected === true || fix.projected === true) return this.get(id, now, historyMs);
        let state = this.targets.get(id);
        const sourceTime = fix.sourceTime ?? fix.t;
        if (state && sourceTime < (state.lastFix.sourceTime ?? state.lastFix.t)) return this.get(id, now, historyMs);
        const isNewPosition = !state || sourceTime > (state.lastFix.sourceTime ?? state.lastFix.t);
        if (!state) {
            const hasInitialSpeed = Number.isFinite(fix.sog) && fix.sog >= 0;
            const initiallyStationary = hasInitialSpeed
                ? fix.sog <= this.config.initialStationaryMaxSpeedKnots
                : id === 'self';
            state = {
                observations: [], trail: [], recentFixes: [], windEvidence: [], lastFix: { ...fix },
                isOwnShip: id === 'self', departureWindowSince: fix.t,
                // Own startup may receive GPS before SOG: initialize rest without
                // inventing speed. Other AIS targets retain conservative MOVING.
                motionState: initiallyStationary ? 'STATIONARY' : 'MOVING',
                movingSince: fix.t,
                area: { lat: fix.lat, lon: fix.lon, since: fix.t },
                areaContext: null, restAreaContext: null, departureThresholdMeters: this.config.departureOutsideAreaMeters,
                restConfirmed: false,
                restObservationSince: fix.t, restPattern: null,
                prediction: new TargetPredictionStability(),
            };
            this.targets.set(id, state);
        }

        // 2/3. Only a distinct source fix enters position arrays. Equal positions
        // with later source times are genuine evidence that the vessel stayed put.
        let point;
        if (isNewPosition) {
            if (fix.t - state.lastFix.t > this.config.restMaximumGapSeconds * 1000) {
                state.restObservationSince = fix.t;
                state.restConfirmed = false;
            }
            point = { lat: fix.lat, lon: fix.lon, t: fix.t,
                sourceTime, cog: Number.isFinite(fix.cog) ? fix.cog : null,
                sog: Number.isFinite(fix.sog) ? fix.sog : null,
                cogTime: fix.cogTime ?? null, sogTime: fix.sogTime ?? null };
            state.recentFixes.push(point);
            state.recentFixes = state.recentFixes.slice(-this.config.departureFixes);
            state.observations.push(point);
            state.observations = compactAisTrail(state.observations, now,
                this.config.observationMinutes * 60000, this.config.maxObservationPoints);
            state.trail.push({ lat: point.lat, lon: point.lon, t: point.t });
            state.trail = compactAisTrail(state.trail, now, historyMs, this.config.maxTrailPoints);
            state.lastFix = { ...fix };
            state.prediction.update({ ...fix, cog: point.cog, sog: point.sog });
        }

        // 4. Independent heading timestamps may supply wind evidence even when
        // the position is reread. They never add a position fix or settle duration.
        this.recordWindEvidence(state, fix, wind, now);
        if (!isNewPosition) {
            if (state.restPattern) state.restPattern.windMooring = describeWindMooring(state, this.config, state.restConfirmed);
            return this.get(id, now, historyMs);
        }

        // 5. Read the previous completed HarborDetector geometry, without learning
        // or treating geometric membership as an AIS mooring observation.
        this.updateAreaContext(state, fix);
        // 6. Evaluate motion after recording the actual observations and context.
        if (state.motionState === 'MOVING') {
            this.evaluateStop(state, fix);
            if (state.motionState === 'STATIONARY') this.updateAreaContext(state, fix);
        }
        else this.evaluateDeparture(state, point);
        state.restPattern = describeRest(state, this.config);
        if (state.restPattern?.confirmed) state.restConfirmed = true;
        // Rest pattern / wind remain descriptive; neither adds a principal state.
        return this.get(id, now, historyMs);
    }

    recordWindEvidence(state, fix, wind, now) {
        const cfg = this.config, age = cfg.windMooringMaximumAgeSeconds * 1000;
        state.windEvidence = state.windEvidence.filter(p => p.t >= now-cfg.windEvidenceSeconds*1000);
        const angle = value => Number.isFinite(value) && value >= 0 && value < 360;
        const recent = time => Number.isFinite(time) && time <= now && now-time <= age;
        if (!angle(fix.hdg) || !recent(fix.headingTime) || fix.headingTime <= (state.lastWindHeadingTime ?? -Infinity) ||
            !recent(state.lastFix.t) || !wind || !angle(wind.direction) || !Number.isFinite(wind.speedKnots) || wind.speedKnots < 0 ||
            !recent(wind.directionTime) || !recent(wind.speedTime) ||
            Math.abs(fix.headingTime-wind.directionTime) > age || Math.abs(fix.headingTime-wind.speedTime) > age ||
            !Number.isFinite(wind.lat) || !Number.isFinite(wind.lon) ||
            distanceMeters(state.lastFix.lat,state.lastFix.lon,wind.lat,wind.lon) > cfg.windMooringMaximumRangeMeters) return;
        state.windEvidence.push({ t: fix.headingTime, positionTime: state.lastFix.t,
            windHeading: { heading: fix.hdg, t: fix.headingTime, direction: wind.direction, speedKnots: wind.speedKnots,
                directionTime: wind.directionTime, speedTime: wind.speedTime, referenceLat: wind.lat, referenceLon: wind.lon } });
        state.windEvidence = state.windEvidence.slice(-cfg.maxWindEvidencePoints);
        state.lastWindHeadingTime = fix.headingTime;
    }

    evaluateStop(state, fix) {
        const cfg = this.config;
        // Longest recent suffix whose maximum pairwise distance is <= diameter.
        // There is no privileged first/centre point and no arithmetic dispersion
        // that could hide two distant ends of the observed cluster.
        const recent = [];
        for (let i=state.observations.length-1; i>=0; i--) {
            const point = state.observations[i];
            if (point.t < state.movingSince) break;
            if (recent.some(other => distanceMeters(point.lat,point.lon,other.lat,other.lon) > cfg.settleDiameterMeters+1e-6)) break;
            recent.unshift(point);
        }
        const first = recent[0];
        if (recent.length < cfg.minimumSettleFixes || fix.t-first.t < cfg.settleSeconds*1000) return;
        state.motionState = 'STATIONARY';
        state.area = { lat: first.lat, lon: first.lon, since: first.t };
        state.restConfirmed = true;
        state.restObservationSince = first.t;
        // Departure evidence starts at the confirmed stop, not before it.
        state.recentFixes = state.recentFixes.slice(-1);
        state.departureWindowSince = fix.t;
        state.windEvidence = state.windEvidence.filter(p => p.t >= first.t);
    }

    updateAreaContext(state, fix) {
        const read = (lat, lon) => {
            const context = this.harborDetector?.getAreaAtPosition?.(lat, lon);
            return context && ['PORT', 'ANCHORAGE', 'PROVISIONAL'].includes(context.kind)
                ? { id: context.id, kind: context.kind, evaluatedAt: context.evaluatedAt } : null;
        };
        state.areaContext = read(fix.lat, fix.lon);
        // The departure threshold belongs to the fixed rest location. Leaving the
        // polygon must not silently turn a 50/150m threshold into 300m.
        state.restAreaContext = state.area.lat === fix.lat && state.area.lon === fix.lon
            ? state.areaContext && { ...state.areaContext } : read(state.area.lat, state.area.lon);
        const kind = state.restAreaContext?.kind;
        state.departureThresholdMeters = kind === 'PORT' ? this.config.departurePortMeters
            : kind === 'ANCHORAGE' ? this.config.departureAnchorageMeters
            // PROVISIONAL has not yet been assigned an agreed special distance.
            : this.config.departureOutsideAreaMeters;
    }

    selectDepartureFixes(state, point) {
        if (!state.isOwnShip) return state.recentFixes;
        // Reuse real, time-stamped observations already held by this tracker.
        // The full-rate GPS input and recent-fix buffer remain untouched.
        const cutoff = Math.max(state.departureWindowSince,
            point.t-this.config.ownDepartureHistorySeconds*1000);
        const history = state.observations.filter(sample => sample.t >= cutoff);
        if (history.length <= 3) return history;
        const first = history[0], last = history.at(-1), midpoint = (first.t+last.t)/2;
        let middle = history[1];
        for (const sample of history.slice(2,-1)) {
            if (Math.abs(sample.t-midpoint) < Math.abs(middle.t-midpoint)) middle = sample;
        }
        return [first, middle, last];
    }

    evaluateDeparture(state, point) {
        // AIS uses its last three raw fixes. Own ship selects three real fixes
        // across its recent five-minute history; neither accumulates path length.
        const fixes = this.selectDepartureFixes(state, point);
        if (fixes.length < this.config.departureFixes) return;
        const first = fixes[0];
        const net = distanceMeters(first.lat, first.lon, point.lat, point.lon);
        if (net+1e-6 < state.departureThresholdMeters) return;
        state.motionState = 'MOVING';
        state.movingSince = point.t;
        state.restConfirmed = false;
        state.windEvidence = [];
        state.restObservationSince = point.t;
        state.prediction = new TargetPredictionStability();
        state.prediction.update(state.lastFix);
    }

    get(id, now, historyMs) {
        const state = this.targets.get(id);
        if (!state) return null;
        state.trail = compactAisTrail(state.trail,now,historyMs,this.config.maxTrailPoints);
        state.windEvidence = state.windEvidence.filter(p => p.t >= now-this.config.windEvidenceSeconds*1000);
        return {
            motionState: state.motionState,
            isMoving: state.motionState === 'MOVING',
            areaContext: state.areaContext ? { ...state.areaContext } : null,
            restAreaContext: state.restAreaContext ? { ...state.restAreaContext } : null,
            departureThresholdMeters: state.departureThresholdMeters,
            restConfirmed: state.restConfirmed,
            stationarySince: state.motionState === 'MOVING' ? null : state.area.since,
            restPattern: state.restPattern ? { ...state.restPattern,
                windMooring: describeWindMooring(state,this.config,state.restConfirmed,now) } : null,
            lastFixTime: state.lastFix.t,
            predictionStability: state.prediction.get(now,state.motionState === 'MOVING'),
            trail: state.trail.map(p => ({ ...p })),
        };
    }

    remove(id) { this.targets.delete(id); }
    prune(activeIds) { for (const id of this.targets.keys()) if (!activeIds.has(id)) this.remove(id); }
}

// Riduce la densità senza accorciare deliberatamente la finestra temporale.
// Conserva gli estremi e privilegia le virate rispetto ai tratti rettilinei densi.
function compactAisTrail(points, now, maxAgeMs, maxPoints = 60) {
    const trail = points.filter(p => Number.isFinite(p.t) && p.t >= now - maxAgeMs && p.t <= now);
    const limit = Math.max(2, Math.floor(maxPoints));
    while (trail.length > limit) {
        let removeIndex = 1;
        let lowestImportance = Infinity;
        for (let i = 1; i < trail.length - 1; i++) {
            const a = trail[i - 1], b = trail[i], c = trail[i + 1];
            const duration = c.t - a.t;
            const fraction = duration > 0 ? (b.t - a.t) / duration : 0;
            const expectedLat = a.lat + (c.lat - a.lat) * fraction;
            const expectedLon = a.lon + (c.lon - a.lon) * fraction;
            const deviation = distanceMeters(b.lat, b.lon, expectedLat, expectedLon);
            const importance = duration / Math.max(1, maxAgeMs) + deviation / 100;
            if (importance < lowestImportance) {
                lowestImportance = importance;
                removeIndex = i;
            }
        }
        trail.splice(removeIndex, 1);
    }
    return trail;
}

module.exports = { TargetMotionTracker, MOTION_TRACKER_CONFIG, MOTION_STATES, compactAisTrail };
