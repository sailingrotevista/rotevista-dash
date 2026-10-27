// Wind tests feed SOG and AWS through the same ordered normalizer/DerivedData boundary
// as production; non-migrated instruments still use their ordinary delta input.
const {SogNormalizer}=require('../../sensors/sensorNormalizer/SogNormalizer');
const {AwsNormalizer}=require('../../sensors/sensorNormalizer/AwsNormalizer');
const {SensorDerivedData}=require('../../sensors/SensorDerivedData');
const inputs=new WeakMap();
function feedWindInput(engine,path,value,timestamp=Date.now()) {
    if(!['navigation.speedOverGround','environment.wind.speedApparent'].includes(path))return engine.processIncomingDelta(path,value,timestamp);
    let channels=inputs.get(engine);
    if(!channels){channels={};inputs.set(engine,channels);}
    const normalizer=channels[path] || (channels[path]=path==='navigation.speedOverGround'?new SogNormalizer():new AwsNormalizer());
    const now=Date.now();
    normalizer.ingest({path,value,timestamp,receivedAt:now,source:'test-receiver'});
    const derived=new SensorDerivedData().process({sampledAt:now,measurements:{[path]:normalizer.tick(now)}});
    if(path==='navigation.speedOverGround')engine.applyNormalizedSog(derived.measurements[path],now);
    else engine.applyNormalizedAws(derived.measurements[path],now);
}
module.exports={feedWindInput};
