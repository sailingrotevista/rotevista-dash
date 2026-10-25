'use strict';
const http=require('http');
const {DashboardSession,registerDashboardRoutes}=require('./dashboardSession');

function getJson(path) {
    return new Promise(resolve=>{
        const req=http.get(`http://venus.local:3000${path}`,{timeout:1800},res=>{
            if (res.statusCode!==200) {res.resume();resolve(null);return;}
            let text='';res.on('data',chunk=>{text+=chunk;if(text.length>8000000)req.destroy();});
            res.on('end',()=>{try{resolve(JSON.parse(text));}catch{resolve(null);}});
            res.on('error',()=>resolve(null));
        });
        req.on('timeout',()=>{req.destroy();resolve(null);});req.on('error',()=>resolve(null));
    });
}
function flatten(node,prefix='',output={},times={}) {
    if (!node || typeof node!=='object') return output;
    if ('value' in node) {output[prefix]=node.value;const t=Date.parse(node.timestamp);if(Number.isFinite(t)) times[prefix]=t;return output;}
    for(const [key,value] of Object.entries(node)) if(!['$source','timestamp','meta','values'].includes(key)) {
        if(value && typeof value==='object') flatten(value,prefix?`${prefix}.${key}`:key,output,times);
    }
    return output;
}
function installDashboardDev(server) {
    let live={},disposed=false,inFlight=false;
    const session=new DashboardSession({readLive:()=>live,environment:'dev'});
    const refresh=async()=>{
        if(inFlight || disposed)return;inFlight=true;
        try {
            const input=await getJson('/rotevista-live-input');
            if(input) live=input;
            else {
                const [ais,self,config]=await Promise.all([getJson('/rotevista-ais'),getJson('/signalk/v1/api/vessels/self'),getJson('/rotevista-config')]);
                const rawTimes={};
                live={raw:flatten(self,'',{},rawTimes),rawTimes,targets:ais?.targets || [],harborClusters:ais?.harborClusters || [],config:config || {}};
            }
        } finally {inFlight=false;}
    };
    const routes=new Map();registerDashboardRoutes((method,path,handlers)=>routes.set(`${method} ${path}`,Array.isArray(handlers)?handlers:[handlers]),session);
    server.middlewares.use((req,res,next)=>{
        const handlers=routes.get(`${req.method} ${String(req.url).split('?')[0]}`);if(!handlers)return next();
        res.header=(name,value)=>{res.setHeader(name,value);return res;};res.status=code=>{res.statusCode=code;return res;};
        res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};
        let i=0;const run=()=>{try{handlers[i++]?.(req,res,run);}catch{res.status(500).json({error:'Dashboard service error.'});}};run();
    });
    void refresh();
    const timer=setInterval(()=>{if(!disposed)session.tick();},1000);
    const refreshTimer=setInterval(()=>{void refresh();},3000);
    const close=()=>{disposed=true;clearInterval(timer);clearInterval(refreshTimer);};
    server.httpServer?.once('close',close);
    return {session,close};
}
module.exports={installDashboardDev,flatten};
