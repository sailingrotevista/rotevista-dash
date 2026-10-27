'use strict';
const {twsNativeMaxAgeMs}=require('../../shared/windDataPolicy.json');
const {ReceivedValueNormalizer,RECEIVED_VALUE_SELECTION_CONFIG}=require('./ReceivedValueNormalizer');
// Received values only. Derivation and history filters remain outside this module.
const TWS_NORMALIZER_CONFIG=Object.freeze({
    ...RECEIVED_VALUE_SELECTION_CONFIG,
    maxAgeMs:twsNativeMaxAgeMs,
    minimumValue:0,
    maximumValue:51.44,
});
class TwsNormalizer extends ReceivedValueNormalizer {
    constructor(config={}) { super('environment.wind.speedTrue',TWS_NORMALIZER_CONFIG,config); }
}
module.exports={TwsNormalizer,TWS_NORMALIZER_CONFIG};
