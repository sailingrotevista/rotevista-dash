'use strict';
const { TargetPredictionStability } = require('./targetPredictionStability');

// Soglie modificabili: il tracker usa solo fix ricevuti, mai posizioni proiettate.
const MOTION_TRACKER_CONFIG = {
    maxObservationPoints: 120,
    observationMinutes: 15,
    maxTrailPoints: 60,
    initialMovingSpeedKnots: 0.8,
    stationaryRadiusMeters: 25,
    anchoredRadiusMeters: 60,
    maxLearnedStationaryRadiusMeters: 40,
    maxLearnedAnchoredRadiusMeters: 80,
    settleSeconds: 120,
    minimumSettleFixes: 3,
    departureMarginMeters: 10,
    departureProgressMeters: 10,
    departureSeconds: 10,
    departureFixes: 2,
};

function distanceMeters(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * 111139 * Math.cos((lat1 + lat2) * Math.PI / 360);
    const dy = (lat2 - lat1) * 111139;
    return Math.hypot(dx, dy);
}

class TargetMotionTracker {
    constructor(config = {}) {
        this.config = { ...MOTION_TRACKER_CONFIG, ...config };
        this.targets = new Map();
    }

    update(id, fix, { now, historyMs, moored = false, anchored = false }) {
        let state = this.targets.get(id);
        if (!Number.isFinite(fix.t) || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) ||
            Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180 || fix.t > now) {
            return this.get(id, now, historyMs);
        }
        // Lo stato AIS può arrivare separatamente dalla posizione: aggiorna il
        // contesto senza inventare un nuovo campione o una conferma di movimento.
        if (state && anchored && !state.anchored && state.motionState !== 'MOVING') {
            state.anchored = true;
            state.area.radius = Math.max(state.area.radius, this.config.anchoredRadiusMeters);
        }
        if (state && (fix.sourceTime ?? fix.t) <= (state.lastFix.sourceTime ?? state.lastFix.t)) return this.get(id, now, historyMs);
        const point = { lat: fix.lat, lon: fix.lon, t: fix.t, cog: fix.cog, sog: fix.sog };
        if (!state) {
            state = {
                observations: [], trail: [], lastFix: fix,
                motionState: !moored && !anchored && fix.sog >= this.config.initialMovingSpeedKnots ? 'MOVING' : 'STATIONARY',
                area: { lat: fix.lat, lon: fix.lon, radius: anchored ? this.config.anchoredRadiusMeters : this.config.stationaryRadiusMeters, since: fix.t },
                departure: null,
                anchored,
                prediction: new TargetPredictionStability(),
            };
            this.targets.set(id, state);
        }
        state.observations.push(point);
        state.observations = compactAisTrail(state.observations, now,
            this.config.observationMinutes * 60000, this.config.maxObservationPoints);
        state.trail.push({ lat: point.lat, lon: point.lon, t: point.t });
        state.trail = compactAisTrail(state.trail, now, historyMs, this.config.maxTrailPoints);
        state.lastFix = { ...fix };
        state.prediction.update(fix);
        const wasMoving = state.motionState === 'MOVING';

        if (state.motionState === 'MOVING') {
            // Un arresto richiede più fix nuovi distribuiti nel tempo, non una SOG nulla.
            const cutoff = fix.t - this.config.settleSeconds * 1000;
            const start = Math.min(
                Math.max(0, state.observations.findIndex(p => p.t >= cutoff) - 1),
                Math.max(0, state.observations.length - this.config.minimumSettleFixes),
            );
            const recent = state.observations.slice(start);
            const first = recent[0];
            if (recent.length >= this.config.minimumSettleFixes &&
                fix.t - first.t >= this.config.settleSeconds * 1000 &&
                recent.every(p => distanceMeters(first.lat, first.lon, p.lat, p.lon) <= this.config.stationaryRadiusMeters)) {
                state.motionState = 'STATIONARY';
                state.anchored = anchored;
                state.area = { lat: first.lat, lon: first.lon, radius: anchored ? this.config.anchoredRadiusMeters : this.config.stationaryRadiusMeters, since: first.t };
                state.departure = null;
            }
        } else {
            // Il riferimento resta fisso: una partenza lenta non trascina l'area con sé.
            const range = distanceMeters(state.area.lat, state.area.lon, fix.lat, fix.lon);
            const boundary = state.area.radius + this.config.departureMarginMeters;
            if (range <= boundary) {
                // Una traiettoria che esce e poi ritorna può insegnare l'area di
                // oscillazione. Non aggiorniamo il riferimento durante l'uscita.
                if (state.departure) this.learnReturnedArea(state);
                state.motionState = 'STATIONARY';
                state.departure = null;
            } else {
                if (!state.departure) state.departure = { first: point, lastRange: range, fixes: 1 };
                else if (range >= state.departure.lastRange) {
                    state.departure.fixes++;
                    state.departure.lastRange = range;
                } else {
                    // Un ritorno verso l'area non conferma una partenza.
                    state.departure = { first: point, lastRange: range, fixes: 1 };
                }
                state.motionState = 'POSSIBLE_MOVEMENT';
                const candidate = state.departure;
                if (candidate.fixes >= this.config.departureFixes &&
                    fix.t - candidate.first.t >= this.config.departureSeconds * 1000 &&
                    distanceMeters(candidate.first.lat, candidate.first.lon, fix.lat, fix.lon) >= this.config.departureProgressMeters) {
                    state.motionState = 'MOVING';
                    state.departure = null;
                }
            }
        }
        if (!wasMoving && state.motionState === 'MOVING') {
            // Departure starts a new trajectory; stationary jitter is not evidence
            // of irregular navigation after leaving the berth/anchorage.
            state.prediction = new TargetPredictionStability();
            state.prediction.update(fix);
        }
        return this.get(id, now, historyMs);
    }

    learnReturnedArea(state) {
        const points = state.observations.filter(p => p.t >= state.area.since);
        if (points.length < this.config.minimumSettleFixes) return;
        const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
        const lon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
        const radius = Math.max(state.anchored ? this.config.anchoredRadiusMeters : this.config.stationaryRadiusMeters,
            ...points.map(p => distanceMeters(lat, lon, p.lat, p.lon)));
        const maxRadius = state.anchored ? this.config.maxLearnedAnchoredRadiusMeters : this.config.maxLearnedStationaryRadiusMeters;
        // Un singolo salto lontano non deve ingrandire l'area senza limite.
        if (radius <= maxRadius) state.area = { ...state.area, lat, lon, radius };
    }

    get(id, now, historyMs) {
        const state = this.targets.get(id);
        if (!state) return null;
        state.trail = compactAisTrail(state.trail, now, historyMs, this.config.maxTrailPoints);
        return {
            motionState: state.motionState,
            isMoving: state.motionState === 'MOVING',
            stationarySince: state.motionState === 'MOVING' ? null : state.area.since,
            lastFixTime: state.lastFix.t,
            predictionStability: state.prediction.get(now, state.motionState === 'MOVING'),
            trail: state.trail,
        };
    }

    remove(id) { this.targets.delete(id); }

    prune(activeIds) {
        for (const id of this.targets.keys()) if (!activeIds.has(id)) this.remove(id);
    }
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

module.exports = { TargetMotionTracker, MOTION_TRACKER_CONFIG, compactAisTrail };
