'use strict';

const { GpsNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS } = require('./sensorNormalizer/GpsNormalizer');

// Coordinates category-specific normalizers and exposes their shared snapshot.
// GPS is the only category migrated so far. DerivedData feeds the operational engines.
class SensorNormalizer {
    constructor(config = {}, scoreWeights = {}) {
        this.gps = new GpsNormalizer(config, scoreWeights);
    }

    ingest(measurement) { return this.gps.ingest(measurement); }
    tick(now = Date.now()) { return this.gps.tick(now); }
    getSourceDiagnostics(now = Date.now()) { return this.gps.getSourceDiagnostics(now); }
}

module.exports = { SensorNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS };
