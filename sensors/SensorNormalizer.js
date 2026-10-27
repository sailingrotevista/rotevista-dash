'use strict';
const {AwsNormalizer}=require('./sensorNormalizer/AwsNormalizer');
const {SogNormalizer,SOG_NORMALIZER_CONFIG}=require('./sensorNormalizer/SogNormalizer');

const { GpsNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS } = require('./sensorNormalizer/GpsNormalizer');

// Coordinates category-specific normalizers and exposes their shared snapshot.
// GPS, received own SOG and AWS are migrated. DerivedData feeds the operational engines.
class SensorNormalizer {
    constructor(config = {}, scoreWeights = {}) {
        this.gps = new GpsNormalizer(config, scoreWeights);
        this.sog = new SogNormalizer();
        this.aws = new AwsNormalizer();
    }

    ingest(measurement) {
        const gpsAccepted=this.gps.ingest(measurement);
        const sogAccepted=this.sog.ingest(measurement);
        const awsAccepted=this.aws.ingest(measurement);
        return gpsAccepted || sogAccepted || awsAccepted;
    }
    tick(now = Date.now()) {
        const snapshot=this.gps.tick(now);
        if(snapshot)snapshot.measurements['environment.wind.speedApparent']=this.aws.tick(now);
        if(snapshot)snapshot.measurements['navigation.speedOverGround']=this.sog.tick(now);
        return snapshot;
    }
    getAwsSourceDiagnostics(now = Date.now()) { return this.aws.getSourceDiagnostics(now); }
    getSogSourceDiagnostics(now = Date.now()) { return this.sog.getSourceDiagnostics(now); }
    getSourceDiagnostics(now = Date.now()) { return this.gps.getSourceDiagnostics(now); }
}

module.exports = { SOG_NORMALIZER_CONFIG, SensorNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS };
