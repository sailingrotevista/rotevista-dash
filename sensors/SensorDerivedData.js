'use strict';

// GPS, SOG, AWS, STW, received TWS and depth pass through unchanged. Future derived values
// belong here, keeping received measures and their provenance separate.
class SensorDerivedData {
    constructor() { this.current = null; }

    process(snapshot) {
        if (!snapshot || !Number.isFinite(snapshot.sampledAt) || !snapshot.measurements) throw new TypeError('A normalized sensor snapshot is required');
        this.current = this.copy(snapshot);
        return this.getSnapshot();
    }

    copy(snapshot) {
        return { sampledAt: snapshot.sampledAt, measurements: Object.fromEntries(
            Object.entries(snapshot.measurements).map(([path, measurement]) => [path, { ...measurement,
                value: measurement.value && typeof measurement.value === 'object' ? { ...measurement.value } : measurement.value,
            }]),
        ) };
    }

    getSnapshot() { return this.current ? this.copy(this.current) : null; }
}

module.exports = { SensorDerivedData };
