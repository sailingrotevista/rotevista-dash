const {test}=require('node:test');const assert=require('node:assert/strict');
const {DashboardSession,registerDashboardRoutes}=require('../dashboardSession');
const make=()=>new DashboardSession({readLive:()=>({raw:{},targets:[]}),now:1000});
test('propulsion shared in RAM, preserved on mode change, reset on restart and isolated from dev',()=>{
 const server=make(),dev=make();assert.equal(server.snapshot().propulsionMode,'AUTO');
 server.setPropulsionMode('MOTOR',2000);
 assert.equal(server.snapshot().propulsionMode,'MOTOR');assert.equal(server.snapshot().propulsionMode,structuredClone(server.snapshot()).propulsionMode);
 assert.equal(dev.snapshot().propulsionMode,'AUTO');
 server.setMode('mixed',3000);assert.equal(server.snapshot().propulsionMode,'MOTOR');
 assert.equal(make().snapshot().propulsionMode,'AUTO');
 assert.throws(()=>server.setPropulsionMode('invalid'),e=>e.status===400);
});
test('propulsion endpoint rejects stale sessions and accepts valid controls',()=>{
 const s=make(),routes=new Map();registerDashboardRoutes((method,path,handlers)=>routes.set(method+' '+path,handlers),s);
 const handlers=routes.get('POST /rotevista-propulsion-mode');assert.equal(handlers.length,3);
 const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;},header(){},removeHeader(){}};
 let passed=false;handlers[0]({headers:{}},res,()=>passed=true);assert.equal(passed,false);assert.equal(res.code,403);
 const req={headers:{'x-rotevista-alert-key':s.sharedAlerts.controlToken},body:{sessionId:'old',mode:'MOTOR'}};
 handlers[0](req,res,()=>passed=true);assert.equal(passed,true);
 handlers[2](req,res);assert.equal(res.code,409);assert.equal(s.propulsionMode,'AUTO');
 req.body.sessionId=s.sharedAlerts.sessionId;handlers[2](req,res);assert.equal(res.value.propulsionMode,'MOTOR');
});
test('motor mutes, sail removes speed-ratio heuristic, auto retains it',async()=>{
 const {gybeSoundAllowed:g}=await import('../src/utils/gybeSound.mjs');
 assert.equal(g('MOTOR',15,5,165),false);
 assert.equal(g('AUTO',10,8,165),false);assert.equal(g('SAIL',10,8,165),true);
 assert.equal(g('AUTO',10,5,165),true);
 for(const mode of ['AUTO','SAIL','MOTOR']) {
 assert.equal(g(mode,null,5,165),false);assert.equal(g(mode,7,5,165),false);assert.equal(g(mode,15,1,165),false);
 }
});
