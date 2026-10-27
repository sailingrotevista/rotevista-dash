'use strict';

const { GPS_AUXILIARY_PATHS } = require('./sensorNormalizer/gpsQuality');
const angularPaths=require('../shared/angularSensorPaths.json');
const GPS_PATH = 'navigation.position';
const SENSOR_INPUT_PATHS = Object.freeze([...new Set([GPS_PATH, ...GPS_AUXILIARY_PATHS, 'environment.wind.speedApparent',
    'navigation.speedThroughWater','environment.wind.speedTrue','environment.depth.belowTransducer',...Object.keys(angularPaths)])]);

function sourceReference(update) {
    if (typeof update.$source === 'string' && update.$source.trim()) return update.$source.trim();
    if (typeof update.source === 'string' && update.source.trim()) return update.source.trim();
    const source = update.source;
    if (!source || typeof source.label !== 'string' || !source.label.trim()) return null;
    const suffix = source.src ?? source.talker;
    return source.label.trim() + (suffix !== undefined && suffix !== '' ? `.${suffix}` : '');
}

// Transport only: no source selection, history, smoothing or invented timestamps.
class SignalKReceiver {
    constructor({ onMeasurement, onError = () => {}, clock = Date.now, selfContext = 'vessels.self' } = {}) {
        if (typeof onMeasurement !== 'function') throw new TypeError('onMeasurement is required');
        this.onMeasurement = onMeasurement;
        this.onError = onError;
        this.clock = clock;
        this.selfContext = selfContext;
        this.unsubscribes = [];
        this.started = false;
    }

    receive(delta, receivedAt = this.clock()) {
        if (!delta || !['vessels.self', 'self', this.selfContext].includes(delta.context) || !Array.isArray(delta.updates)) return 0;
        let count = 0;
        for (const update of delta.updates) {
            if (!update || !Array.isArray(update.values)) continue;
            for (const item of update.values) {
                if (!item || !SENSOR_INPUT_PATHS.includes(item.path) || !Object.prototype.hasOwnProperty.call(item, 'value')) continue;
                const value = Array.isArray(item.value) ? item.value.slice() : item.value && typeof item.value === 'object' ? { ...item.value } : item.value;
                const measurement = { path: item.path, value, source: sourceReference(update),
                    sourceInfo: update.source && typeof update.source === 'object' ? { ...update.source } : null,
                    timestamp: update.timestamp ?? null, receivedAt };
                try { this.onMeasurement(measurement); count++; }
                catch (error) { this.onError(error); }
            }
        }
        return count;
    }

    start(app) {
        if (this.started) return;
        if (typeof app?.subscriptionmanager?.subscribe !== 'function') throw new TypeError('Signal K subscription manager is required');
        if (typeof app.selfContext === 'string') this.selfContext = app.selfContext;
        this.started = true;
        try {
            // minPeriod=0 preserves source cadence. Newer servers expose all source
            // deltas through the sixth argument; older servers may filter upstream.
            app.subscriptionmanager.subscribe({ context: 'vessels.self', subscribe: SENSOR_INPUT_PATHS.map(path => ({ path, policy: 'instant', minPeriod: 0 })) }, this.unsubscribes, this.onError, delta => this.receive(delta), undefined, 'all');
        } catch (error) {
            this.stop();
            throw error;
        }
    }

    stop() {
        const subscriptions = this.unsubscribes.splice(0);
        this.started = false;
        for (const unsubscribe of subscriptions) {
            try { unsubscribe(); } catch (error) { this.onError(error); }
        }
    }
}

module.exports = { SignalKReceiver };
