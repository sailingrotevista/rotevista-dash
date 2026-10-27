'use strict';
const {boatSpeedMaxAgeMs}=require('../../shared/windDataPolicy.json');
const {ReceivedSpeedNormalizer}=require('./ReceivedSpeedNormalizer');
const SOG_NORMALIZER_CONFIG=Object.freeze({
    maxAgeMs:boatSpeedMaxAgeMs,
    maximumSpeedMps:25.72,
    maxSources:16,
    sourceRetentionMs:1800000,
    historyWindowMs:60000,
    maxSamplesPerSource:120,
    referencePeriodMs:1000, // Frequency benefit saturates at 1 Hz.
    frequencyWeight:50,
    freshnessWeight:50,
    promotionScoreMargin:15,
    promotionHoldMs:5000,
    promotionMinimumFixes:3,
});

class SogNormalizer extends ReceivedSpeedNormalizer {
    constructor(config={}) { super('navigation.speedOverGround',SOG_NORMALIZER_CONFIG,config); }
}
module.exports={SogNormalizer,SOG_NORMALIZER_CONFIG};
