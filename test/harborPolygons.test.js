const {test}=require('node:test');
const assert=require('node:assert/strict');
const cluster=()=>({id:'port-1',kind:'PORT',hull:[[36,14],[36.001,14],[36,14.001]],count:10,dist:50,center:[36,14]});
async function setup(){
 const {syncHarborPolygons}=await import('../src/utils/harborPolygons.mjs');
 const registry=new Map(),layers=new Set(),calls={created:0,added:0,removed:0,geometry:0,style:0};
 const group={addLayer(layer){layers.add(layer);calls.added++;},removeLayer(layer){layers.delete(layer);calls.removed++;}};
 const create=(hull,options)=>{calls.created++;return {hull,options,setLatLngs(h){this.hull=h;calls.geometry++;},setStyle(o){this.options=o;calls.style++;}};};
 return {registry,layers,calls,sync:(clusters,night=false)=>syncHarborPolygons(registry,group,clusters,night,create)};
}
test('identical refreshed geometry and changing metadata keep the same Leaflet object without update calls',async()=>{
 const s=await setup();const c=cluster();s.sync([c]);const layer=s.registry.get(c.id).layer;
 for(let i=0;i<20;i++)s.sync([{...c,hull:c.hull.map(p=>[...p]),count:10+i,dist:50+i,center:[36+i*.00001,14]}]);
 assert.equal(s.registry.get(c.id).layer,layer);assert.deepEqual(s.calls,{created:1,added:1,removed:0,geometry:0,style:0});
});
test('real boundary or style changes update the existing polygon in place independently',async()=>{
 const s=await setup(),c=cluster();s.sync([c]);const layer=s.registry.get(c.id).layer;
 const expanded={...c,hull:[[36,14],[36.002,14],[36,14.001]]};s.sync([expanded]);
 assert.equal(s.calls.geometry,1);assert.equal(s.calls.style,0);assert.equal(s.registry.get(c.id).layer,layer);
 s.sync([{...expanded,kind:'ANCHORAGE'}],true);
 assert.equal(s.calls.geometry,1);assert.equal(s.calls.style,1);assert.equal(layer.options.color,'#f59e0b');assert.equal(layer.options.fillOpacity,.12);
 assert.equal(s.calls.created,1);assert.equal(s.calls.removed,0);
});
test('removed and invalid areas release layers; additions and reordered lists preserve unrelated areas',async()=>{
 const s=await setup(),a=cluster(),b={...cluster(),id:'port-2'};s.sync([a,b]);const first=s.registry.get(a.id).layer;
 s.sync([b,a]);assert.equal(s.calls.created,2);assert.equal(s.calls.geometry,0);
 s.sync([a,{...b,hull:[]}]);assert.equal(s.registry.size,1);assert.equal(s.calls.removed,1);assert.equal(s.registry.get(a.id).layer,first);
 s.sync([]);assert.equal(s.layers.size,0);assert.equal(s.registry.size,0);assert.equal(s.calls.removed,2);
 s.sync([a]);assert.equal(s.calls.created,3);
});
