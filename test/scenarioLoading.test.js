const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../dashboardScenario.js'),'utf8');
const pipeline=require('../collisionPipeline');
const marina=require('../dashboardMarina.json');

for(const commonJs of [false,true]) test(`scenario factory is available to the GUI with CommonJS wrapping ${commonJs}`,()=>{
 const context={};if(commonJs)context.module={exports:{}};
 vm.runInNewContext(source,context);
 assert.equal(typeof context.RotevistaScenario,'function');
 if(commonJs)assert.equal(context.module.exports,context.RotevistaScenario);
 const tools=context.RotevistaScenario(pipeline,marina);
 assert.equal(typeof tools.generateRandomColregScenario,'function');
 const result=tools.generateRandomColregScenario(marina.myGps,45,45,5);
 assert.equal(result.targets.length,4);
});
