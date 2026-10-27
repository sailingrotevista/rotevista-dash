'use strict';
const policy=require('../../shared/windDataPolicy.json');
const paths=require('../../shared/angularSensorPaths.json');
const {ReceivedValueNormalizer,RECEIVED_VALUE_SELECTION_CONFIG}=require('./ReceivedValueNormalizer');
// Preserve received radians (including signed wind angles). No circular mean,
// unwrapping, rotation filter or derivation: only source selection and validity.
const ANGLE_NORMALIZER_CONFIG=Object.freeze(Object.fromEntries(Object.entries(paths).map(([path,age])=>[path,Object.freeze({
    ...RECEIVED_VALUE_SELECTION_CONFIG,
    maxAgeMs:policy[age],
    minimumValue:-2*Math.PI,
    maximumValue:2*Math.PI,
})])));
class AngleNormalizer extends ReceivedValueNormalizer {
    constructor(path,config={}) {
        if(!Object.prototype.hasOwnProperty.call(ANGLE_NORMALIZER_CONFIG,path))throw new TypeError('Unsupported angle path');
        super(path,ANGLE_NORMALIZER_CONFIG[path],config);
    }
}
module.exports={AngleNormalizer,ANGLE_NORMALIZER_CONFIG};
