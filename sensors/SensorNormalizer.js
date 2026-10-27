'use strict';
const {StwNormalizer}=require('./sensorNormalizer/StwNormalizer');
const {TwsNormalizer}=require('./sensorNormalizer/TwsNormalizer');
const {DepthNormalizer}=require('./sensorNormalizer/DepthNormalizer');
const {AwsNormalizer}=require('./sensorNormalizer/AwsNormalizer');
const {SogNormalizer,SOG_NORMALIZER_CONFIG}=require('./sensorNormalizer/SogNormalizer');

const { GpsNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS } = require('./sensorNormalizer/GpsNormalizer');

// Coordinates category-specific normalizers and exposes their shared snapshot.
// GPS, SOG, AWS, STW, received TWS and depth are migrated. DerivedData feeds the operational engines.
class SensorNormalizer {
    constructor(config = {}, scoreWeights = {}) {
        this.gps = new GpsNormalizer(config, scoreWeights);
        this.sog = new SogNormalizer();
        this.aws = new AwsNormalizer();
        this.stw = new StwNormalizer();
        this.tws = new TwsNormalizer();
        this.depth = new DepthNormalizer();
        this.scalarChannels = {
            'navigation.speedOverGround':this.sog,
            'environment.wind.speedApparent':this.aws,
            'navigation.speedThroughWater':this.stw,
            'environment.wind.speedTrue':this.tws,
            'environment.depth.belowTransducer':this.depth,
        };
    }

    ingest(measurement) {
        const gpsAccepted=this.gps.ingest(measurement);
        const scalarAccepted=this.scalarChannels[measurement?.path]?.ingest(measurement) ?? false;
        return gpsAccepted || scalarAccepted;
    }
    tick(now = Date.now()) {
        const snapshot=this.gps.tick(now);
        if(snapshot)for(const [path,normalizer] of Object.entries(this.scalarChannels))snapshot.measurements[path]=normalizer.tick(now);
        return snapshot;
    }
    getStwSourceDiagnostics(now = Date.now()) { return this.stw.getSourceDiagnostics(now); }
    getTwsSourceDiagnostics(now = Date.now()) { return this.tws.getSourceDiagnostics(now); }
    getDepthSourceDiagnostics(now = Date.now()) { return this.depth.getSourceDiagnostics(now); }
    getAwsSourceDiagnostics(now = Date.now()) { return this.aws.getSourceDiagnostics(now); }
    getSogSourceDiagnostics(now = Date.now()) { return this.sog.getSourceDiagnostics(now); }
    getSourceDiagnostics(now = Date.now()) { return this.gps.getSourceDiagnostics(now); }
}

module.exports = { SOG_NORMALIZER_CONFIG, SensorNormalizer, GPS_NORMALIZER_CONFIG, GPS_SCORE_WEIGHTS };
