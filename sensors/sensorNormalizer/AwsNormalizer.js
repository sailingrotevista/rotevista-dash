'use strict';
const {awsMaxAgeMs}=require('../../shared/windDataPolicy.json');
const {ReceivedValueNormalizer,RECEIVED_VALUE_SELECTION_CONFIG}=require('./ReceivedValueNormalizer');
// Received values only. Derivation and history filters remain outside this module.
const AWS_NORMALIZER_CONFIG=Object.freeze({
    ...RECEIVED_VALUE_SELECTION_CONFIG,
    maxAgeMs:awsMaxAgeMs,
    minimumValue:0,
    maximumValue:51.44,
});
class AwsNormalizer extends ReceivedValueNormalizer {
    constructor(config={}) { super('environment.wind.speedApparent',AWS_NORMALIZER_CONFIG,config); }
}
module.exports={AwsNormalizer,AWS_NORMALIZER_CONFIG};
