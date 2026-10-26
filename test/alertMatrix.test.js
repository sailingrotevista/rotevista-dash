const {test}=require('node:test');
const assert=require('node:assert/strict');
const {CollisionPipeline,resolveAlertPolicy,applyProximityPolicy}=require('../ais/collisionPipeline');
for(const ownMoving of [false,true]) for(const targetMoving of [false,true])
for(const ownInArea of [false,true]) for(const targetInArea of [false,true]) {
 test(`matrix own moving=${ownMoving} area=${ownInArea}, target moving=${targetMoving} area=${targetInArea}`,()=>{
  const own={motionState:ownMoving?'MOVING':'STATIONARY',inRecognizedArea:ownInArea,sog:5};
  const target={motionState:targetMoving?'MOVING':'STATIONARY',inRecognizedArea:targetInArea,sog:10};
  const mode=!ownMoving&&!targetMoving?'BUBBLE_ONLY':(ownMoving?targetInArea:ownInArea)?'REDUCED':'NORMAL';
  assert.equal(resolveAlertPolicy(own,target).mode,mode);
  const pipeline=new CollisionPipeline({baseTcpaMinutes:10});
  const limits=pipeline._resolveThresholds(target,'commercial',own);
  const full=pipeline._resolveThresholds({...target,inRecognizedArea:false},'commercial',{...own,inRecognizedArea:false});
  const factor=mode==='REDUCED'?.25:1;
  assert.equal(limits.redCpa,full.redCpa*factor);
  assert.equal(limits.orangeCpa,full.orangeCpa*factor);
  assert.equal(limits.horizonTcpa,full.horizonTcpa*factor);
 });
}
test('both stationary outside areas use bubble only without startup warnings',()=>{
 const pipeline=new CollisionPipeline();
 const own={lat:36,lon:14,sog:0,motionState:'STATIONARY'};
 const target={id:'a',lat:36.0001,lon:14,sog:1.2,motionState:'STATIONARY'};
 pipeline.targetStates.set('a',{alertState:'RED'});
 const result=pipeline.evaluateTarget(own,target);
 assert.equal(result.alertPolicy.mode,'BUBBLE_ONLY');
 assert.equal(result.cpaNominalMeters,null);
 assert.equal(result.tcpaMinutes,-1);
 assert.equal(pipeline.targetStates.has('a'),false);
 const view={alertPolicy:result.alertPolicy,currentHullClearanceMeters:0};
 applyProximityPolicy(view);
 assert.equal(view.risk,'GREY');
 view.proximityEntryObserved=true;applyProximityPolicy(view);
 assert.equal(view.risk,'ORANGE');
});
test('explicit geometry and motion state override stale membership and speed flags',()=>{
 assert.equal(resolveAlertPolicy({motionState:'MOVING'},{motionState:'MOVING',inRecognizedArea:false,inCluster:true}).mode,'NORMAL');
 assert.equal(resolveAlertPolicy({motionState:'STATIONARY',sog:2},{motionState:'STATIONARY',isMoving:true,sog:3}).mode,'BUBBLE_ONLY');
});
