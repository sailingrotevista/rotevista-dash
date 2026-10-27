'use strict';
const { GPS_AUXILIARY_PATHS, declaredGpsQuality } = require('./gpsQuality');

// Own GPS policy; its selected fix reaches consumers through SensorDerivedData.
const GPS_NORMALIZER_CONFIG = {
    snapshotPeriodMs: 1000,
    maxAgeMs: 240000,
    minAgeMs: 15000,
    displacementToleranceMeters: 50,
    referenceSpeedMaxAgeMs: 15000,
    historyWindowMs: 900000,
    maxSamplesPerSource: 1800,
    maxSources: 16,
    sourceRetentionMs: 1800000,
    promotionHoldMs: 5000,
    promotionMinimumFixes: 3,
    promotionScoreMargin: 15,
    maximumSpeedKnots: 80,
    jumpAllowanceMeters: 25,
    continuityWindowMs: 30000,
    qualityMaxAgeMs: 30000,
    motionMaximumSkewMs: 2000,
    motionMinimumStepMs: 1000,
    motionMaximumStepMs: 5000,
    motionMinimumSpanMs: 5000,
    motionSpeedSpanMs: 5000,
    motionMinimumComparisons: 3,
    motionNoiseToleranceMeters: 5,
    motionSpeedToleranceFraction: 0.15,
    motionTurnDegrees: 30,
    motionTurnMinimumKnots: 0.8,
};
// Provisional selection weights, not accuracy percentages. Tune after replay/live
// review; missing GNSS quality indicators are not assigned an invented score.
const GPS_SCORE_WEIGHTS = Object.freeze({
    freshness: 50,
    coherence: 30,
    declaredQuality: 20,
});
const GPS_PATH = 'navigation.position';
const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function sourceType(info, reference) {
    const talker = String(info?.talker || '').toUpperCase();
    const sentence = String(info?.sentence || '').toUpperCase();
    if (['VDM', 'VDO'].includes(sentence) || ['AI', 'AB'].includes(talker) || /\.(AI|AB)$/i.test(reference)) return 'AIS';
    if (['GP', 'GN', 'GL', 'GA', 'GB', 'BD'].includes(talker)) return 'GNSS';
    return 'UNKNOWN';
}
function distanceMeters(a, b) {
    const radians = Math.PI / 180;
    const lat1 = a.latitude * radians, lat2 = b.latitude * radians;
    const dlat = lat2 - lat1, dlon = (b.longitude - a.longitude) * radians;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function validPosition(value) {
    return value && !Array.isArray(value) && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 &&
        Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}

class GpsNormalizer {
    constructor(config = {}, scoreWeights = {}) {
        this.config = { ...GPS_NORMALIZER_CONFIG, ...config };
        for (const [name, value] of Object.entries(this.config)) {
            if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Invalid normalizer setting: ${name}`);
        }
        for (const name of ['maxSamplesPerSource', 'maxSources', 'promotionMinimumFixes', 'motionMinimumComparisons']) {
            if (!Number.isInteger(this.config[name])) throw new TypeError(`Invalid normalizer count: ${name}`);
        }
        this.scoreWeights = { ...GPS_SCORE_WEIGHTS, ...scoreWeights };
        for (const [name, value] of Object.entries(this.scoreWeights)) {
            if (!(name in GPS_SCORE_WEIGHTS) || !Number.isFinite(value) || value < 0) throw new TypeError(`Invalid source score weight: ${name}`);
        }
        if (!Object.values(this.scoreWeights).some(value => value > 0)) throw new TypeError('Source score needs a positive weight');
        this.sources = new Map();
        this.selectedSource = null;
        this.challenger = null;
        this.lastSnapshotAt = null;
        this.lastObservationId = null;
        this.referenceSpeedMps = null;
        this.referenceSpeedTime = null;
    }

    prune(now) {
        for (const [id, state] of this.sources) {
            state.samples = state.samples.filter(sample => sample.timestamp >= now - this.config.historyWindowMs)
                .slice(-this.config.maxSamplesPerSource);
            state.observations = state.observations.filter(sample => sample.timestamp >= now - this.config.historyWindowMs)
                .slice(-this.config.maxSamplesPerSource);
            for (const [path, entries] of Object.entries(state.auxiliary)) {
                state.auxiliary[path] = entries.filter(entry => entry.timestamp >= now - this.config.historyWindowMs)
                    .slice(-this.config.maxSamplesPerSource);
            }
            if (now - state.lastReceivedAt > this.config.sourceRetentionMs) this.sources.delete(id);
        }
    }

    ingest(measurement) {
        if (!measurement || (measurement.path !== GPS_PATH && !GPS_AUXILIARY_PATHS.includes(measurement.path)) || typeof measurement.source !== 'string' || !measurement.source.trim() ||
            !Number.isFinite(measurement.receivedAt)) return false;
        const timestamp = typeof measurement.timestamp === 'number' ? measurement.timestamp :
            typeof measurement.timestamp === 'string' ? Date.parse(measurement.timestamp) : NaN;
        const now = measurement.receivedAt;
        // Cached reports, unknown source times and future-dated measurements never
        // become fresh observations merely because they have just been received.
        if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp >= this.config.maxAgeMs) return false;
        this.prune(now);
        const source = measurement.source.trim();
        let state = this.sources.get(source);
        if (!state) {
            if (this.sources.size >= this.config.maxSources) {
                const victim = [...this.sources.values()].filter(candidate => candidate.source !== this.selectedSource)
                    .sort((a, b) => a.lastReceivedAt - b.lastReceivedAt)[0];
                if (!victim) return false;
                this.sources.delete(victim.source);
            }
            state = { source, samples: [], observations: [], auxiliary: {}, type: sourceType(measurement.sourceInfo, source), lastTimestamp: null,
                lastReceivedAt: now, last: null, rejection: null };
            this.sources.set(source, state);
        }
        if (measurement.path !== GPS_PATH) return this.ingestAuxiliary(state, measurement, timestamp);
        if (Number.isFinite(state.lastTimestamp) && (timestamp < state.lastTimestamp || (timestamp === state.lastTimestamp &&
            !(measurement.value === null && state.last?.valid)))) return false;
        state.lastTimestamp = timestamp;
        state.lastReceivedAt = now;
        const observedType = sourceType(measurement.sourceInfo, source);
        if (observedType !== 'UNKNOWN') state.type = observedType;
        let rejection = measurement.value === null ? 'RESET' : validPosition(measurement.value) ? null : 'INVALID_POSITION';
        const previous = state.samples.at(-1);
        if (!rejection && previous) {
            const elapsed = timestamp - previous.timestamp;
            const maximumDistance = this.config.jumpAllowanceMeters + this.config.maximumSpeedKnots * 1852 / 3600000 * elapsed;
            if (elapsed <= this.config.continuityWindowMs && distanceMeters(previous.value, measurement.value) > maximumDistance) rejection = 'POSITION_JUMP';
        }
        state.rejection = rejection;
        state.last = { value: rejection ? null : { ...measurement.value }, timestamp, receivedAt: now, valid: !rejection };
        const observation = { timestamp, receivedAt: now, valid: !rejection, rejection };
        if (state.observations.at(-1)?.timestamp === timestamp) state.observations.pop();
        state.observations.push(observation);
        state.observations = state.observations.slice(-this.config.maxSamplesPerSource);
        if (rejection) {
            // A reset at the same time revokes that fix; it is not another fix.
            state.samples = state.samples.filter(sample => sample.timestamp !== timestamp);
            return false;
        }
        state.samples.push({ ...state.last, value: { ...state.last.value } });
        state.samples = state.samples.slice(-this.config.maxSamplesPerSource);
        return true;
    }

    ingestAuxiliary(state, measurement, timestamp) {
        const path=measurement.path, records=state.auxiliary[path] || [];
        const previous=records.at(-1);
        if (previous && (timestamp<previous.timestamp || (timestamp===previous.timestamp &&
            !(measurement.value===null && previous.value!==null)))) return false;
        const value=measurement.value;
        const valid=value===null || (path==='navigation.speedOverGround'
            ? Number.isFinite(value)&&value>=0&&value<=this.config.maximumSpeedKnots/1.94384
            : path==='navigation.courseOverGroundTrue' ? Number.isFinite(value)&&Math.abs(value)<=Math.PI*2
            : path==='navigation.gnss.horizontalDilution' ? Number.isFinite(value)&&value>0
            : path==='navigation.gnss.satellites' ? Number.isInteger(value)&&value>=0
            : typeof value==='string');
        if(previous?.timestamp===timestamp)records.pop();
        records.push({value:valid ? value : null,timestamp,receivedAt:measurement.receivedAt});
        state.auxiliary[path]=records.slice(-this.config.maxSamplesPerSource);
        state.lastReceivedAt=measurement.receivedAt;
        const type=sourceType(measurement.sourceInfo,state.source);
        if(type!=='UNKNOWN')state.type=type;
        return valid;
    }

    // One prudential own speed shared by ALL position sources. Until a speed
    // normalizer exists, use the maximum of recent, ordered same-source SOGs.
    validityWindow(now) {
        const speeds = [...this.sources.values()].map(state => state.auxiliary['navigation.speedOverGround']?.at(-1))
            .filter(entry => entry && Number.isFinite(entry.value) && entry.value >= 0 && entry.timestamp <= now &&
                now-entry.timestamp < this.config.referenceSpeedMaxAgeMs);
        this.referenceSpeedMps = speeds.length ? Math.max(...speeds.map(entry => entry.value)) : null;
        this.referenceSpeedTime = speeds.length ? Math.max(...speeds.map(entry => entry.timestamp)) : null;
        return this.referenceSpeedMps > 0 ? Math.min(this.config.maxAgeMs,
            Math.max(this.config.minAgeMs, this.config.displacementToleranceMeters / this.referenceSpeedMps * 1000)) : this.config.maxAgeMs;
    }

    usable(state, now) {
        return Boolean(state?.last?.valid && now >= state.last.timestamp && now - state.last.timestamp < this.validityWindow(now) &&
            !declaredGpsQuality(state.auxiliary,now,this.config).rejection);
    }

    assessSource(state, now) {
        const cutoff = now - this.config.historyWindowMs;
        const samples = state.samples.filter(sample => sample.timestamp >= cutoff && sample.timestamp <= now);
        const observations = state.observations.filter(sample => sample.timestamp >= cutoff && sample.timestamp <= now);
        const intervals = samples.slice(1).map((sample, index) => sample.timestamp - samples[index].timestamp);
        const period = median(intervals);
        const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        // A median-only jitter estimate hides isolated long outages. Mean absolute
        // deviation also accounts for those outages until they leave the window.
        const variation = intervals.length >= 2 ? mean(intervals.map(value => Math.abs(value - period))) / period : null;
        const delays = samples.map(sample => sample.receivedAt - sample.timestamp);
        const meanLatencyMs = mean(delays);
        const ageMs = state.last ? now - state.last.timestamp : null;
        const validCount = observations.filter(sample => sample.valid).length;
        const invalidCount = observations.length - validCount;
        const clamp = value => Math.max(0, Math.min(1, value));
        const declaredQuality=declaredGpsQuality(state.auxiliary,now,this.config);
        const validityMs = this.validityWindow(now);
        const factors = {
            freshness: ageMs === null ? null : clamp(1 - ageMs / validityMs),
            coherence: observations.length ? validCount / observations.length : null,
            declaredQuality: declaredQuality.value,
        };
        // Missing optional evidence has no weight. Normalize the available
        // contributions to the same 0..100 scale for every source.
        const availableWeight=Object.entries(factors).reduce((sum,[name,factor])=>sum+(factor===null ? 0 : this.scoreWeights[name]),0);
        const weightedSum=Object.entries(factors).reduce((sum,[name,factor])=>sum+(factor===null ? 0 : factor*this.scoreWeights[name]),0);
        const components = Object.fromEntries(Object.entries(factors).map(([name, factor]) => [name, {
            available: factor !== null, factor, weight: this.scoreWeights[name],
            points: factor === null || !availableWeight ? 0 : factor * this.scoreWeights[name] * 100 / availableWeight,
        }]));
        const eligible = this.usable(state, now);
        return { source: state.source, sourceType: state.type, selected: state.source === this.selectedSource,
            eligible, score: eligible ? availableWeight ? weightedSum*100/availableWeight : 0 : null,
            components, metrics: { validFixes: validCount, rejectedFixes: invalidCount,
                jumpRejections: observations.filter(sample => sample.rejection === 'POSITION_JUMP').length,
                observationCount: observations.length,
                observedSpanMs: samples.length > 1 ? samples.at(-1).timestamp - samples[0].timestamp : 0,
                intervalCount: intervals.length, typicalIntervalMs: period, intervalVariationRatio: variation,
                ageMs, validityMs, expiresAt:state.last ? state.last.timestamp+validityMs : null,
                referenceSpeedMps:this.referenceSpeedMps, meanLatencyMs, medianLatencyMs: median(delays),
                maximumLatencyMs: delays.length ? Math.max(...delays) : null },
            declaredGpsQuality: declaredQuality,
        };
    }

    getSourceDiagnostics(now = Date.now()) {
        return [...this.sources.values()].filter(state => now - state.lastReceivedAt <= this.config.sourceRetentionMs)
            .map(state => this.assessSource(state, now))
            .sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.source.localeCompare(b.source));
    }

    score(state, now) {
        return this.assessSource(state, now).score ?? -Infinity;
    }

    select(now) {
        const candidates = [...this.sources.values()].filter(state => this.usable(state, now));
        const scores = new Map(candidates.map(state => [state.source, this.score(state, now)]));
        candidates.sort((a, b) => scores.get(b.source) - scores.get(a.source) || b.last.timestamp - a.last.timestamp || a.source.localeCompare(b.source));
        const best = candidates[0];
        const current = this.sources.get(this.selectedSource);
        if (!best) { this.challenger = null; return 'NO_VALID_SOURCE'; }
        if (!this.usable(current, now)) {
            const reason = this.selectedSource === null ? 'INITIAL' : 'FAILOVER';
            this.selectedSource = best.source;
            this.challenger = null;
            return reason;
        }
        if (best.source === current.source || scores.get(best.source) - scores.get(current.source) < this.config.promotionScoreMargin) {
            this.challenger = null;
            return 'LOCKED';
        }
        if (this.challenger?.source !== best.source) this.challenger = { source: best.source, since: now, firstTimestamp: best.last.timestamp, fixes: 1, lastTimestamp: best.last.timestamp };
        else if (best.last.timestamp > this.challenger.lastTimestamp) {
            this.challenger.fixes++;
            this.challenger.lastTimestamp = best.last.timestamp;
        }
        const pending = this.challenger;
        if (now - pending.since >= this.config.promotionHoldMs &&
            best.last.timestamp - pending.firstTimestamp >= this.config.promotionHoldMs &&
            pending.fixes >= this.config.promotionMinimumFixes) {
            this.selectedSource = best.source;
            this.challenger = null;
            return 'PREFERRED_SOURCE';
        }
        return 'LOCKED';
    }

    tick(now = Date.now()) {
        if (!Number.isFinite(now) || (this.lastSnapshotAt !== null && now - this.lastSnapshotAt < this.config.snapshotPeriodMs)) return null;
        this.lastSnapshotAt = now;
        this.prune(now);
        const previousSource = this.selectedSource;
        const selectionReason = this.select(now);
        const state = this.sources.get(this.selectedSource);
        const valid = this.usable(state, now);
        const sample = state?.last;
        const observationId = valid ? JSON.stringify([state.source, sample.timestamp]) : null;
        // TODO: compensate offsets between GPS antennas. For now emit the selected
        // real fix unchanged; sourceChanged exposes a possible positional discontinuity.
        const validityMs = this.validityWindow(now);
        const measurement = { validityMs, expiresAt:sample ? sample.timestamp+validityMs : null,
            referenceSpeedMps:this.referenceSpeedMps, value: valid ? { ...sample.value } : null, valid,
            status: valid ? 'VALID' : declaredGpsQuality(state?.auxiliary || {},now,this.config).rejection ? 'INVALID' : sample ? sample.valid ? 'STALE' : 'INVALID' : 'UNAVAILABLE',
            source: state?.source ?? null, sourceType: state?.type ?? null,
            sourceScore: valid ? this.score(state, now) : null,
            timestamp: sample?.timestamp ?? null, receivedAt: sample?.receivedAt ?? null,
            ageMs: sample ? now - sample.timestamp : null, observationId,
            isNewObservation: observationId !== null && observationId !== this.lastObservationId,
            sourceChanged: previousSource !== null && previousSource !== this.selectedSource, selectionReason };
        // An intervening invalid snapshot must not turn the same old fix into a new one.
        if (observationId !== null) this.lastObservationId = observationId;
        return { sampledAt: now, measurements: { [GPS_PATH]: measurement } };
    }
}

module.exports = { GpsNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS };
