const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AisSharedAlerts}=require('../aisSharedAlerts');
const own={lat:36,lon:14};
const collision=(id,cpa=100,tcpa=1,risk='RED')=>({id,cpa,tcpa,risk,dist:1000});
const bubble=(id,clearance)=>({id,risk:'ORANGE',alertKind:'PROXIMITY',areaProximityOnly:true,isMoving:false,proximityEntryObserved:true,currentHullClearanceMeters:clearance,dist:clearance+20,lat:36,lon:14});
const action=(server,target,type='snooze')=>({type,targetId:target.id,expectedRisk:target.risk,expectedAlertKind:target.alertKind||'COLLISION',sessionId:server.sessionId});

test('two clients receive identical banners and a snooze switches both to the same next contact',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a',20),b=collision('b',200);
 server.update([a,b],own,0);
 const clientA=structuredClone(server.snapshot(3000)),clientB=structuredClone(server.snapshot(3000));
 assert.deepEqual(clientA,clientB);assert.equal(clientA.snoozeReadyAt,3000);
 const result=server.action(action(server,a),3000);
 assert.equal(result.banner.id,'b');assert.deepEqual(result,server.snapshot(3000));
 assert.equal(result.snoozes.a.until,603000);
 assert.equal(server.update([a,b],own,603001).banner.id,'b');
 assert.equal(server.update([a,b],own,613001).banner.id,'a');
});
test('shared ten second hysteresis cannot be restarted by a late joining client',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a',200),b=collision('b',300);
 server.update([a,b],own,0);b.cpa=10;
 assert.equal(server.update([a,b],own,1000).banner.id,'a');
 assert.equal(server.snapshot(7000).banner.id,'a');
 assert.equal(server.update([a,b],own,10999).banner.id,'a');
 assert.equal(server.update([a,b],own,11000).banner.id,'b');
 assert.equal(server.snapshot(11000).snoozeReadyAt,14000);
});
test('one shared bubble acknowledge covers all present contacts and later arrivals reopen it',()=>{
 const server=new AisSharedAlerts({now:0});const a=bubble('a',0),b=bubble('b',20);
 server.update([a,b],own,0);
 const result=server.action(action(server,a,'acknowledge'),3000);
 assert.equal(result.banner,null);assert.deepEqual(Object.keys(result.acknowledgements),['a','b']);
 assert.equal(server.update([a,b,bubble('new',40)],own,5000).banner.id,'new');
});
test('initial bubble discoveries stay visual; real collisions remain eligible',()=>{
 const server=new AisSharedAlerts({now:0});const a={...bubble('initial',0),proximityEntryObserved:false};
 assert.equal(server.update([a],own,0).banner,null);
 assert.equal(server.update([a,collision('collision')],own,1000).banner.id,'collision');
});
test('stale actions are rejected on restart, missing targets or changed alert severity',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a');server.update([a],own,0);
 assert.throws(()=>server.action({...action(server,a),sessionId:'old'},1),e=>e.status===409);
 const old=action(server,a);server.update([{...a,risk:'ORANGE'}],own,1);
 assert.throws(()=>server.action(old,2),e=>e.status===409);
 server.update([],own,3);assert.throws(()=>server.action(old,4),e=>e.status===409);
});
test('clicking a displayed target never snoozes a different target that has replaced the banner',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a',10),b=collision('b',100);
 server.update([a,b],own,0);const request=action(server,a);
 server.update([a,{...b,cpa:0}],own,1000);server.update([a,{...b,cpa:0}],own,11000);
 assert.equal(server.snapshot().banner.id,'b');
 const result=server.action(request,12000);
 assert.ok(result.snoozes.a);assert.equal(result.snoozes.b,undefined);
});
test('acknowledgements survive a short outage but expire after 24h absence, movement or leaving context',()=>{
 const server=new AisSharedAlerts({now:0});const a=bubble('a',5);server.update([a],own,0);
 server.action(action(server,a,'acknowledge'),3000);
 assert.ok(server.update([],own,10000).acknowledgements.a);
 assert.ok(server.update([a],own,20000).acknowledgements.a);
 assert.equal(server.update([],own,86420001).acknowledgements.a,undefined);
 server.update([a],own,86420002);server.action(action(server,a,'acknowledge'),86420003);
 assert.equal(server.update([{...a,isMoving:true}],own,86420004).acknowledgements.a,undefined);
});
test('lost snoozed contact stays silent past timer and fresh data restores normal evaluation',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a');server.update([a],own,0);server.action(action(server,a),1);
 const lost={...a,contactLost:true,contactLostAt:1000,lastPositionTime:500};
 assert.equal(server.update([lost],own,1000).banner,null);
 assert.equal(server.update([lost],own,700000).banner,null);
 assert.equal(server.update([{...a,lastPositionTime:700001}],own,700002).banner.id,'a');
});
test('orange escalation breaks snooze and repeated state reads never mutate or rearm decisions',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a',10,1,'ORANGE');server.update([a],own,0);server.action(action(server,a),1);
 assert.equal(server.update([{...a,risk:'RED'}],own,100).banner.risk,'RED');
 const revision=server.snapshot(100).revision;
 assert.equal(server.update([{...a,risk:'RED'}],own,101).revision,revision);
});

test('alert writes require bounded JSON and malformed payloads never reach the action',()=>{
 const {EventEmitter}=require('events');const {readAlertAction}=require('../aisSharedAlerts');
 const exercise=(contentType,body)=>{
  const req=new EventEmitter();req.headers={'content-type':contentType};let status=200,called=false;
  const res={status(n){status=n;return this;},json(){return this;}};
  readAlertAction(req,res,()=>{called=true;});
  req.emit('data',Buffer.from(body));req.emit('end');return {status,called};
 };
 assert.deepEqual(exercise('text/plain','{}'),{status:415,called:false});
 assert.deepEqual(exercise('application/json','{bad'),{status:400,called:false});
 assert.deepEqual(exercise('application/json',' '.repeat(4097)),{status:413,called:false});
 assert.deepEqual(exercise('application/json','{}'),{status:200,called:true});
});

test('simultaneous snooze clicks are idempotent and do not extend the shared timer',()=>{
 const server=new AisSharedAlerts({now:0});const a=collision('a');server.update([a],own,0);
 const request=action(server,a);
 assert.equal(server.action(request,3000).snoozes.a.until,603000);
 assert.equal(server.action(request,3500).snoozes.a.until,603000);
});

test('dashboard actions need no admin identity but require the dashboard capability and matching origin',()=>{
 const {createDashboardAlertHandlers}=require('../aisSharedAlerts');
 const sharedAlerts=new AisSharedAlerts({now:0}); const a=collision('a'); sharedAlerts.update([a],own,0);
 const handlers=createDashboardAlertHandlers({sharedAlerts,publishSharedAlerts(){}});
 const response=()=>({code:200,body:null,headers:{},header(k,v){this.headers[k]=v;return this;},removeHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});
 const req={headers:{host:'venus.local:3000','sec-fetch-site':'same-origin'}};
 const session=response(); handlers.session(req,session);
 assert.equal(session.code,200); assert.equal(session.body.token,sharedAlerts.controlToken);
 assert.equal(sharedAlerts.snapshot().token,undefined);
 for (const bad of [
  {...req,headers:{...req.headers,origin:'https://external.example'}},
  {...req,headers:{...req.headers,'sec-fetch-site':'cross-site'}},
 ]) {
  const res=response();handlers.session(bad,res);assert.equal(res.code,403);
 }
 const denied=response();handlers.guard(req,denied,()=>assert.fail('Missing capability must fail'));
 assert.equal(denied.code,403);
 const trusted={headers:{...req.headers,origin:'http://venus.local:3000','x-rotevista-alert-key':session.body.token}};
 let accepted=false; handlers.guard(trusted,response(),()=>{accepted=true;});assert.equal(accepted,true);
 const result=response();handlers.action({...trusted,body:action(sharedAlerts,a)},result);
 assert.equal(result.code,200);assert.ok(result.body.snoozes.a);
 const changedOrigin={headers:{...trusted.headers,origin:'https://other.example'}};
 const rejected=response();handlers.guard(changedOrigin,rejected,()=>assert.fail('External origin must fail even with a token'));
 assert.equal(rejected.code,403);
});
