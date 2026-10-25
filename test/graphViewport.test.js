const {test}=require('node:test');const assert=require('node:assert/strict');
test('silent sensor history moves left and expires without adding or modifying samples',async()=>{
 const {graphViewport:v}=await import('../src/utils/graphViewport.mjs');
 const data=Object.freeze([Object.freeze({val:4,time:1000}),Object.freeze({val:5,time:2000})]);
 const first=v(data,2000,10000),later=v(data,7000,10000);
 assert.equal(first.points.length,2);assert.equal(later.points.length,2);
 assert.equal((later.points[1].time-later.start)/10000,0.5);
 assert.deepEqual(v(data,12001,10000).points,[]);
 assert.equal(data.length,2);
});
test('viewport sorts, deduplicates and excludes future/invalid samples, retains zero and doubled rest window',async()=>{
 const {graphViewport:v}=await import('../src/utils/graphViewport.mjs');
 const data=[{time:9000,val:0},{time:1000,val:1},{time:9000,val:2},{time:11000,val:3},{time:9500,val:NaN}];
 assert.deepEqual(v(data,10000,5000).points,[{time:9000,val:0}]);
 assert.equal(v(data,10000,10000).points.length,2);
 assert.deepEqual(v([],10000,5000).points,[]);
});
