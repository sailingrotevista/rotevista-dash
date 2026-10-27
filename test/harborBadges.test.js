const {test}=require('node:test');
const assert=require('node:assert/strict');
const cluster=()=>({id:'port-1',kind:'PORT',hull:[[36,14],[36.001,14],[36,14.001]],count:41,dist:50,center:[36,14]});
async function setup(){
 const {syncHarborBadges}=await import('../src/utils/harborBadges.mjs');
 const registry=new Map(),layers=new Set(),calls={markers:0,icons:0,moved:0,replaced:0,removed:0};
 const group={addLayer(layer){layers.add(layer);},removeLayer(layer){layers.delete(layer);calls.removed++;}};
 const marker=(position,options)=>{calls.markers++;return {position,options,setLatLng(p){this.position=p;calls.moved++;},setIcon(icon){this.options.icon=icon;calls.replaced++;}};};
 const icon=options=>{calls.icons++;return {options};};
 return {registry,layers,calls,sync:clusters=>syncHarborBadges(registry,group,clusters,marker,icon)};
}
test('unchanged harbor labels retain marker and icon across new arrays, distance and hull changes',async()=>{
 const s=await setup(),c=cluster();s.sync([c]);const marker=s.registry.get(c.id).layer,icon=marker.options.icon;
 for(let i=0;i<20;i++)s.sync([{...c,center:[...c.center],dist:50+i,hull:[[36,14],[36.001+i*.00001,14],[36,14.001]]}]);
 assert.equal(s.registry.get(c.id).layer,marker);assert.equal(marker.options.icon,icon);
 assert.deepEqual(s.calls,{markers:1,icons:1,moved:0,replaced:0,removed:0});
 assert.match(icon.options.html,/backdrop-filter:blur\(8px\)/);assert.match(icon.options.html,/Port \(41\)/);
 assert.deepEqual(icon.options.iconAnchor,[48,11]);
});
test('position-only changes preserve the icon; count and type changes preserve the marker',async()=>{
 const s=await setup(),c=cluster();s.sync([c]);const marker=s.registry.get(c.id).layer,icon=marker.options.icon;
 const moved={...c,center:[36.002,14]};s.sync([moved]);assert.equal(s.calls.moved,1);assert.equal(marker.options.icon,icon);assert.equal(s.calls.icons,1);
 s.sync([{...moved,count:42}]);assert.equal(s.calls.replaced,1);assert.match(marker.options.icon.options.html,/Port \(42\)/);assert.equal(s.calls.moved,1);
 s.sync([{...moved,count:42,kind:'ANCHORAGE'}]);assert.match(marker.options.icon.options.html,/Anchorage \(42\)/);assert.match(marker.options.icon.options.html,/#f59e0b/);
 assert.equal(s.registry.get(c.id).layer,marker);assert.equal(s.calls.markers,1);assert.equal(s.calls.removed,0);
});
test('reordered areas stay stable, removed/invalid areas release badges, and fallback centre follows coordinates',async()=>{
 const s=await setup(),a=cluster(),b={...cluster(),id:'port-2',center:undefined,lat:37,lon:15};s.sync([a,b]);const marker=s.registry.get(b.id).layer;
 assert.deepEqual(marker.position,[37,15]);s.sync([b,a]);assert.equal(s.calls.icons,2);
 s.sync([{...b,lat:37.001}]);assert.equal(s.registry.get(b.id).layer,marker);assert.deepEqual(marker.position,[37.001,15]);assert.equal(s.calls.removed,1);
 s.sync([{...b,hull:[]}]);assert.equal(s.registry.size,0);assert.equal(s.layers.size,0);assert.equal(s.calls.removed,2);
});
