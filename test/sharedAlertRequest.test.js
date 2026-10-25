const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AisSharedAlerts}=require('../aisSharedAlerts');
const target={id:'a',risk:'RED',cpa:10,tcpa:1,dist:100};
const response=(body,ok=true)=>({ok,json:async()=>body});
const access=()=>response({sessionId:'s',token:'key'});

test('only a valid server confirmation completes the action; requests bind the displayed identity',async()=>{
 const {requestSharedAlertAction}=await import('../src/utils/sharedAlertRequest.mjs');
 const calls=[];
 const result=await requestSharedAlertAction({type:'snooze',target,state:{sessionId:'s'},fetchImpl:async(url,options)=>{
  calls.push({url,options});return calls.length===1?access():response({sessionId:'s',revision:2,banner:null});
 }});
 assert.equal(result.revision,2);assert.equal(calls[1].options.headers['X-Rotevista-Alert-Key'],'key');
 assert.equal(JSON.parse(calls[1].options.body).targetId,'a');
});

test('a stale server session and a refused action never report success',async()=>{
 const {requestSharedAlertAction}=await import('../src/utils/sharedAlertRequest.mjs');
 let count=0;
 await assert.rejects(requestSharedAlertAction({type:'snooze',target,state:{sessionId:'old'},fetchImpl:async()=>{count++;return access();}}),/Server restarted/);
 assert.equal(count,1);
 await assert.rejects(requestSharedAlertAction({type:'snooze',target,state:{sessionId:'s'},fetchImpl:async url=>url.endsWith('session')?access():response({error:'Alert changed'},false)}),/Alert changed/);
});

test('if the server accepted but its reply is lost, the client reports uncertainty and does not retry',async()=>{
 const {requestSharedAlertAction}=await import('../src/utils/sharedAlertRequest.mjs');
 const server=new AisSharedAlerts({sessionId:'s',now:0});server.update([target],{lat:36,lon:14},0);let posts=0;
 await assert.rejects(requestSharedAlertAction({type:'snooze',target,state:{sessionId:'s'},fetchImpl:async(url,options)=>{
  if(url.endsWith('session'))return access();posts++;
  server.action(JSON.parse(options.body),1000);throw new Error('Reply lost');
 }}),/may have reached the server/);
 assert.equal(posts,1);assert.ok(server.snapshot().snoozes.a);assert.equal(server.snapshot().banner,null);
});

test('unanswered requests time out and malformed success replies are not accepted',async()=>{
 const {requestSharedAlertAction}=await import('../src/utils/sharedAlertRequest.mjs');
 await assert.rejects(requestSharedAlertAction({type:'snooze',target,state:{sessionId:'s'},timeoutMs:5,
 fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout'))))}),/Could not reach/);
 await assert.rejects(requestSharedAlertAction({type:'snooze',target,state:{sessionId:'s'},fetchImpl:async url=>url.endsWith('session')?access():response(null)}),/Action not confirmed/);
});
