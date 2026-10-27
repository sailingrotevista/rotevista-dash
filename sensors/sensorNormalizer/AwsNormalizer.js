'use strict';
const {awsMaxAgeMs}=require('../../shared/windDataPolicy.json');
const {SOG_NORMALIZER_CONFIG}=require('./SogNormalizer');
const {ReceivedSpeedNormalizer}=require('./ReceivedSpeedNormalizer');
// Same source-selection rules as SOG, with the existing AWS range (100 kn).
const AWS_NORMALIZER_CONFIG=Object.freeze({...SOG_NORMALIZER_CONFIG,maxAgeMs:awsMaxAgeMs,maximumSpeedMps:51.44});
class AwsNormalizer extends ReceivedSpeedNormalizer {
    constructor(config={}) { super('environment.wind.speedApparent',AWS_NORMALIZER_CONFIG,config); }
}
module.exports={AwsNormalizer,AWS_NORMALIZER_CONFIG};
