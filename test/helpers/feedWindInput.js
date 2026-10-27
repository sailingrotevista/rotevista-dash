// Tests follow the same category-normalizer/DerivedData boundary as production.
const {SogNormalizer}=require('../../sensors/sensorNormalizer/SogNormalizer');
const {AwsNormalizer}=require('../../sensors/sensorNormalizer/AwsNormalizer');
const {StwNormalizer}=require('../../sensors/sensorNormalizer/StwNormalizer');
const {TwsNormalizer}=require('../../sensors/sensorNormalizer/TwsNormalizer');
const {DepthNormalizer}=require('../../sensors/sensorNormalizer/DepthNormalizer');
const {SensorDerivedData}=require('../../sensors/SensorDerivedData');
const categories={
    'navigation.speedOverGround':['Sog',SogNormalizer],
    'environment.wind.speedApparent':['Aws',AwsNormalizer],
    'navigation.speedThroughWater':['Stw',StwNormalizer],
    'environment.wind.speedTrue':['Tws',TwsNormalizer],
    'environment.depth.belowTransducer':['Depth',DepthNormalizer],
};
const inputs=new WeakMap();
function feedWindInput(engine,path,value,timestamp=Date.now()) {
    const category=categories[path];
    if(!category)return engine.processIncomingDelta(path,value,timestamp);
    let channels=inputs.get(engine);
    if(!channels){channels={};inputs.set(engine,channels);}
    const normalizer=channels[path] || (channels[path]=new category[1]());
    const now=Date.now();
    normalizer.ingest({path,value,timestamp,receivedAt:now,source:'test-receiver'});
    const derived=new SensorDerivedData().process({sampledAt:now,measurements:{[path]:normalizer.tick(now)}});
    engine['applyNormalized'+category[0]](derived.measurements[path],now);
}
module.exports={feedWindInput};
