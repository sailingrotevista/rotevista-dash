'use strict';

// Parametri di analisi, NON soglie CPA/TCPA e NON margini di allarme.
const PREDICTION_STABILITY_CONFIG = {
    historySeconds: 900,
    maxSamples: 24,
    minimumSampleSeconds: 5,
    minimumFixes: 5,
    minimumSpanSeconds: 30,
    maximumGapSeconds: 240,
    recentComparisons: 5,
    unstableComparisons: 3,
    positionToleranceMeters: 8,
    minimumErrorMps: 0.15,
    relativeErrorFraction: 0.05,
    turnDegrees: 25,
    speedChangeKnots: 1.5,
    confirmationDegrees: 10,
    confirmationSpeedKnots: 0.5,
    regimeConfirmationFixes: 2,
};
const KNOTS_TO_MS = 1852 / 3600;
const angleDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const velocity = p => ({ x: Math.sin(p.cog * Math.PI / 180) * p.sog * KNOTS_TO_MS,
    y: Math.cos(p.cog * Math.PI / 180) * p.sog * KNOTS_TO_MS });

function predictionError(a, b) {
    const dt = (b.t - a.t) / 1000;
    const v = velocity(a);
    const dx = (b.lon - a.lon) * 111139 * Math.cos((a.lat + b.lat) * Math.PI / 360);
    const dy = (b.lat - a.lat) * 111139;
    return { seconds: dt, meters: Math.hypot(dx - v.x * dt, dy - v.y * dt) };
}

class TargetPredictionStability {
    constructor(config = {}) {
        this.config = { ...PREDICTION_STABILITY_CONFIG, ...config };
        this.samples = [];
        this.pendingRegime = null;
        this.confirmedRegime = false;
        this.lastReceivedTime = null;
        this.estimate = this.emptyEstimate();
    }

    emptyEstimate() {
        return { state: 'INSUFFICIENT_DATA', sampleCount: this.samples?.length || 0,
            comparisonCount: 0, errorRateMps: null, uncertaintyGrowthMps: null };
    }

    update(fix) {
        if (this.lastReceivedTime !== null && fix.t <= this.lastReceivedTime) return;
        if (!Number.isFinite(fix.t) || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
        this.lastReceivedTime = fix.t;
        if (!Number.isFinite(fix.sog) || fix.sog < 0 || !Number.isFinite(fix.cog) || fix.cog < 0 || fix.cog >= 360) {
            this.samples = [];
            this.pendingRegime = null;
            this.confirmedRegime = false;
            this.estimate = this.emptyEstimate();
            return;
        }
        const cfg = this.config;
        let previous = this.samples[this.samples.length - 1];
        if (previous && fix.t - previous.t > cfg.maximumGapSeconds * 1000) {
            this.samples = [];
            this.pendingRegime = null;
            this.confirmedRegime = false;
            previous = null;
        }
        if (previous && fix.t - previous.t < cfg.minimumSampleSeconds * 1000) return;
        this.samples.push({ lat: fix.lat, lon: fix.lon, t: fix.t, cog: fix.cog, sog: fix.sog });
        this.samples = this.samples.filter(p => fix.t - p.t <= cfg.historySeconds * 1000).slice(-cfg.maxSamples);

        // A GPS jump that returns to the prior trajectory, or a single bad COG/SOG,
        // must not produce several independent votes for instability.
        const n = this.samples.length;
        if (n >= 3) {
            const [a, b, c] = this.samples.slice(-3);
            const ab = predictionError(a, b), bc = predictionError(b, c), ac = predictionError(a, c);
            const velocitiesReturn = angleDifference(a.cog, c.cog) <= cfg.confirmationDegrees &&
                Math.abs(a.sog - c.sog) <= cfg.confirmationSpeedKnots;
            const badPosition = ab.meters > cfg.positionToleranceMeters * 2 && bc.meters > cfg.positionToleranceMeters * 2;
            const badVelocity = angleDifference(a.cog, b.cog) >= cfg.turnDegrees || Math.abs(a.sog - b.sog) >= cfg.speedChangeKnots;
            if (velocitiesReturn && ac.meters <= cfg.positionToleranceMeters * 2 && (badPosition || badVelocity)) {
                this.samples.splice(n - 2, 1);
                if (this.pendingRegime?.t === b.t) this.pendingRegime = null;
            }
        }

        const cleanPrevious = this.samples[this.samples.length - 2];
        if (cleanPrevious) {
            const changed = angleDifference(cleanPrevious.cog, fix.cog) >= cfg.turnDegrees ||
                Math.abs(cleanPrevious.sog - fix.sog) >= cfg.speedChangeKnots;
            if (changed) {
                const oldVelocity = velocity(cleanPrevious), newVelocity = velocity(fix);
                this.pendingRegime = { t: fix.t, cog: fix.cog, sog: fix.sog, confirmations: 0,
                    errorRateMps: Math.hypot(oldVelocity.x - newVelocity.x, oldVelocity.y - newVelocity.y) };
            } else if (this.pendingRegime) {
                const error = predictionError(cleanPrevious, fix);
                const tolerance = Math.max(cfg.minimumErrorMps, fix.sog * KNOTS_TO_MS * cfg.relativeErrorFraction);
                const consistent = angleDifference(this.pendingRegime.cog, fix.cog) <= cfg.confirmationDegrees &&
                    Math.abs(this.pendingRegime.sog - fix.sog) <= cfg.confirmationSpeedKnots &&
                    Math.max(0, error.meters - cfg.positionToleranceMeters) / error.seconds <= tolerance;
                this.pendingRegime.confirmations = consistent ? this.pendingRegime.confirmations + 1 : 0;
                if (this.pendingRegime.confirmations >= cfg.regimeConfirmationFixes) {
                    this.samples = this.samples.filter(p => p.t >= this.pendingRegime.t);
                    this.confirmedRegime = true;
                    this.pendingRegime = null;
                }
            }
        }
        this.estimate = this.analyze();
    }

    analyze() {
        const cfg = this.config, points = this.samples;
        const rates = [];
        for (let i = 1; i < points.length; i++) {
            const consecutive = predictionError(points[i - 1], points[i]);
            let rate = Math.max(0, consecutive.meters - cfg.positionToleranceMeters) / consecutive.seconds;
            // Two-interval forecasts catch progressive variations. Each endpoint
            // contributes just one comparison, even when both horizons disagree.
            if (i >= 2) {
                const longer = predictionError(points[i - 2], points[i]);
                rate = Math.max(rate, Math.max(0, longer.meters - cfg.positionToleranceMeters) / longer.seconds);
            }
            rates.push({ value: rate, t: points[i].t,
                limit: Math.max(cfg.minimumErrorMps, points[i - 1].sog * KNOTS_TO_MS * cfg.relativeErrorFraction) });
        }
        const recent = rates.slice(-cfg.recentComparisons);
        // Recent comparisons receive greater weight; a stable old history must
        // not mask current manoeuvring, nor a completed turn pollute it forever.
        const totalWeight = recent.reduce((sum, _, i) => sum + i + 1, 0);
        const errorRateMps = totalWeight ? recent.reduce((sum, r, i) => sum + r.value * (i + 1), 0) / totalWeight : null;
        const result = { sampleCount: points.length, comparisonCount: recent.length, errorRateMps };
        const minimumFixes = this.confirmedRegime ? cfg.regimeConfirmationFixes + 1 : cfg.minimumFixes;
        const enough = points.length >= minimumFixes && points[points.length - 1].t - points[0].t >= cfg.minimumSpanSeconds * 1000;
        if (!enough) return { ...result, state: 'INSUFFICIENT_DATA', uncertaintyGrowthMps: null };
        const significant = recent.filter(r => r.value > r.limit);
        if (significant.length >= cfg.unstableComparisons) {
            const sorted = significant.map(r => r.value).sort((a, b) => a - b);
            return { ...result, state: 'VARIABLE', uncertaintyGrowthMps: sorted[Math.floor((sorted.length - 1) * 0.8)] };
        }
        if (this.pendingRegime || recent[recent.length - 1]?.value > recent[recent.length - 1]?.limit) {
            return { ...result, state: 'MANEUVERING',
                uncertaintyGrowthMps: Math.max(errorRateMps || 0, this.pendingRegime?.errorRateMps || 0, recent[recent.length - 1]?.value || 0) };
        }
        return { ...result, state: 'STABLE', uncertaintyGrowthMps: 0 };
    }

    get(now, isMoving = true) {
        // Missing reports do not prove that observed instability has improved.
        // The owning motion tracker removes this estimate when the target expires;
        // a new fix after a long gap still starts a fresh analysis in update().
        const estimate = this.lastReceivedTime === null ? this.emptyEstimate() : this.estimate;
        return { ...estimate, ...(isMoving ? {} : { state: 'NOT_MOVING', uncertaintyGrowthMps: 0 }), lastFixTime: this.lastReceivedTime };
    }
}

// Radius around the nominal future position. Null means unknown, not zero risk.
// This is a descriptive model only: it does not compare any CPA/TCPA threshold.
function predictionUncertaintyRadius(stability, secondsAhead, now) {
    if (!stability || stability.uncertaintyGrowthMps == null || stability.lastFixTime == null) return null;
    const elapsed = Math.max(0, (now - stability.lastFixTime) / 1000);
    return stability.uncertaintyGrowthMps * (elapsed + Math.max(0, secondsAhead));
}

module.exports = { TargetPredictionStability, PREDICTION_STABILITY_CONFIG, predictionUncertaintyRadius };
