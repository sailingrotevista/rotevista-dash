'use strict';
const {boatSpeedMaxAgeMs}=require('../../shared/windDataPolicy.json');
const {ReceivedValueNormalizer,RECEIVED_VALUE_SELECTION_CONFIG}=require('./ReceivedValueNormalizer');
// Received values only. Derivation and history filters remain outside this module.
const SOG_NORMALIZER_CONFIG=Object.freeze({
    ...RECEIVED_VALUE_SELECTION_CONFIG,
    maxAgeMs:boatSpeedMaxAgeMs,
    minimumValue:0,
    maximumValue:25.72,
});
class SogNormalizer extends ReceivedValueNormalizer {
    constructor(config={}) { super('navigation.speedOverGround',SOG_NORMALIZER_CONFIG,config); }
}
module.exports={SogNormalizer,SOG_NORMALIZER_CONFIG};
