'use strict';
const {depthMaxAgeMs}=require('../../shared/windDataPolicy.json');
const {ReceivedValueNormalizer,RECEIVED_VALUE_SELECTION_CONFIG}=require('./ReceivedValueNormalizer');
// Received values only. Derivation and history filters remain outside this module.
const DEPTH_NORMALIZER_CONFIG=Object.freeze({
    ...RECEIVED_VALUE_SELECTION_CONFIG,
    maxAgeMs:depthMaxAgeMs,
    minimumValue:-2,
    maximumValue:500,
});
class DepthNormalizer extends ReceivedValueNormalizer {
    constructor(config={}) { super('environment.depth.belowTransducer',DEPTH_NORMALIZER_CONFIG,config); }
}
module.exports={DepthNormalizer,DEPTH_NORMALIZER_CONFIG};
