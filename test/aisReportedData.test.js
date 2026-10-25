'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {extractReportedAis}=require('../aisReportedData');
const timestamp='2026-10-25T10:00:00Z';
const node=value=>({value,timestamp,$source:'receiver.AI'});
test('received data preserves zeros, source times and reported position without motion fallbacks',()=>{
 const vessel={navigation:{position:node({latitude:36,longitude:14}),speedOverGround:node(0),headingTrue:node(0)}};
 const data=extractReportedAis(vessel);
 assert.equal(data.sog.value,0);
 assert.equal(data.heading.value,0);
 assert.equal(data.cog,null);
 assert.equal(data.navigationState,null);
 assert.deepEqual(data.position,{value:{lat:36,lon:14},timestamp:Date.parse(timestamp),source:'receiver.AI'});
 assert.equal(data.length,null);
 assert.equal(data.aisClass,null);
 assert.equal(data.shipType,null);
});
test('reported metadata retains parent timestamps, signed offsets and actual dimensions',()=>{
 const data=extractReportedAis({communication:node({callsignVhf:'DC6220'}),design:{length:node({overall:12}),beam:node(4),draft:node({maximum:1.8})},sensors:{ais:{class:node('b'),fromBow:node(0),fromCenter:node(-2)}}});
 assert.equal(data.callsign.value,'DC6220');
 assert.equal(data.callsign.timestamp,Date.parse(timestamp));
 assert.equal(data.length.value,12);
 assert.equal(data.draft.value.basis,'maximum');
 assert.equal(data.aisClass.value,'B');
 assert.equal(data.fromBow.value,0);
 assert.equal(data.fromCenter.value,-2);
});
test('invalid values remain unavailable and bare values do not acquire current timestamps',()=>{
 const data=extractReportedAis({name:'FERRY',navigation:{headingTrue:node(511*Math.PI/180),speedOverGround:node(-1),position:node({latitude:100,longitude:14})},design:{length:node(0)},sensors:{ais:{class:node('unknown')}}});
 assert.equal(data.heading,null);assert.equal(data.sog,null);assert.equal(data.position,null);
 assert.equal(data.length,null);assert.equal(data.aisClass,null);assert.equal(data.shipType,null);
 assert.equal(data.name.timestamp,null);
});
test('labels do not infer missing navigation status or invent freshness',async()=>{
 const {formatReportedNavigationState,receivedAgeLabel}=await import('../src/utils/aisDetailData.mjs');
 assert.equal(formatReportedNavigationState(null),'NOT AVAILABLE');
 assert.equal(formatReportedNavigationState('5'),'MOORED');
 assert.equal(formatReportedNavigationState('anchored'),'ANCHORED');
 assert.equal(receivedAgeLabel({timestamp:null}),'Timestamp not available');
 assert.equal(receivedAgeLabel({timestamp:Date.parse(timestamp)},Date.parse(timestamp)+180000),'3m ago');
});
test('compact AIS information filters placeholders and formats ETA in UTC',async()=>{
 const {getAisInfo,formatAisEta}=await import('../src/utils/aisDetailData.mjs');
 const info=getAisInfo({destination:'TRBDM',eta:'2026-10-29T12:00:00.000Z',reportedNavigationState:'motoring',aisClass:'A'});
 assert.deepEqual(info,{destination:'TRBDM',eta:'29 Oct, 12:00 UTC',status:'MOTORING',aisClass:'A',visible:true});
 assert.equal(getAisInfo({destination:'NOT DECLARED',reportedNavigationState:'15'}).visible,false);
 assert.equal(getAisInfo({aisClass:'B'}).visible,false);
 assert.equal(formatAisEta('2026-10-29T14:00:00+02:00'),'29 Oct, 12:00 UTC');
 assert.equal(formatAisEta('2026-10-29T12:00:00'),null);
 assert.equal(formatAisEta('invalid'),null);
 assert.equal(getAisInfo({reportedAis:{},destination:'OLD',reportedNavigationState:'moored'}).visible,false);
 assert.equal(getAisInfo({destination:'TRBDM@@@'}).destination,'TRBDM');
});

test('AIS age changes from minutes to hours at 3600 seconds',async()=>{
 const {formatAge}=await import('../src/utils/aisDetailData.mjs');
 assert.equal(formatAge(0),'NOW');
 assert.equal(formatAge(30),'30S AGO');
 assert.equal(formatAge(60),'1M AGO');
 assert.equal(formatAge(3599),'59M AGO');
 assert.equal(formatAge(3600),'1H AGO');
 assert.equal(formatAge(7200),'2H AGO');
 assert.equal(formatAge(24*3600),'24H AGO');
});
