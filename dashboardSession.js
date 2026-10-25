'use strict';
const { randomUUID } = require('crypto');
const { AisSharedAlerts, createDashboardAlertHandlers, readAlertAction } = require('./aisSharedAlerts');
const pipeline = require('./collisionPipeline');
const marina = require('./dashboardMarina.json');
const createTools = require('./dashboardScenario');
const {BubbleEntryTracker} = require('./bubbleEntryTracker');
const VALID_MODES = ['live','simulation','mixed'];
const rad = degrees => degrees*Math.PI/180;
function advance(v, seconds) {
    const distance=v.sog*1852/3600*seconds;
    return {...v,lat:v.lat+distance*Math.cos(rad(v.cog))/111139,
        lon:v.lon+distance*Math.sin(rad(v.cog))/(111139*Math.cos(rad(v.lat)))};
}
class DashboardSession {
    constructor({ readLive, environment='signalk', now=Date.now() }) {
        this.readLive=readLive;
        this.environment=environment;
        this.mode='live'; this.generation=randomUUID(); this.changedAt=now; this.revision=0;
        this.liveAlerts=new AisSharedAlerts({now}); this.simAlerts=new AisSharedAlerts({now});
        this.lastTick=now; this.startedAt=now; this.dynamic=[]; this.simOwn={...marina.myGps,sog:5.2,cog:45,hdg:45};
        this.tools=createTools(pipeline,marina);
        this.bubbleEntries=new BubbleEntryTracker();
        this.tick(now);
    }
    get sharedAlerts() { return this.mode==='live' ? this.liveAlerts : this.simAlerts; }
    setMode(mode,now=Date.now()) {
        if (!VALID_MODES.includes(mode)) throw Object.assign(new Error('Invalid dashboard mode.'),{status:400});
        if (mode===this.mode) return this.snapshot();
        this.mode=mode;this.generation=randomUUID();this.changedAt=now;this.startedAt=now;this.lastTick=now;
        this.dynamic=[];this.simOwn={...marina.myGps,sog:5.2,cog:45,hdg:45};
        this.tools=createTools(pipeline,marina);
        this.bubbleEntries=new BubbleEntryTracker();
        this.simAlerts=new AisSharedAlerts({now});
        this.tick(now);return this.snapshot();
    }
    tick(now=Date.now()) {
        const live=this.readLive() || {};
        const raw=live.raw || {};
        const p=raw['navigation.position']?.value || raw['navigation.position'];
        const liveOwn=live.own || (p ? {lat:p.latitude,lon:p.longitude,
            sog:(raw['navigation.speedOverGround'] || 0)*1.94384,
            cog:(raw['navigation.courseOverGroundTrue'] || 0)*180/Math.PI,
            hdg:(raw['navigation.headingTrue'] ?? raw['navigation.courseOverGroundTrue'] ?? 0)*180/Math.PI} : null);
        this.liveAlerts.update(live.targets || [],liveOwn,now);
        let targets=live.targets || [],clusters=live.harborClusters || [],outRaw={...raw};
        let own=liveOwn;
        if (this.mode==='mixed' && Number.isFinite(live.rawTimes?.['navigation.position']) && now-live.rawTimes['navigation.position']>30000) own=null;
        const dt=Math.max(0,(now-this.lastTick)/1000); this.lastTick=now;
        if (this.mode!=='live') {
            if (this.mode==='simulation') {
                this.simOwn=advance(this.simOwn,dt);own=this.simOwn;
                const elapsed=(now-this.startedAt)/1000;
                const speed=12.5+Math.sin(elapsed*.12)*1.2, direction=90+Math.sin(elapsed*.15)*5.5;
                const angle=rad(direction-own.hdg), wx=speed*Math.cos(angle)+own.sog,wy=speed*Math.sin(angle);
                outRaw={
                    'navigation.position':{latitude:own.lat,longitude:own.lon},
                    'navigation.speedOverGround':own.sog/1.94384,'navigation.speedThroughWater':own.sog/1.94384,
                    'navigation.headingTrue':rad(own.hdg),'navigation.courseOverGroundTrue':rad(own.cog),
                    'environment.wind.speedTrue':speed/1.94384,'environment.wind.directionTrue':rad(direction),
                    'environment.wind.angleTrueWater':angle,'environment.wind.speedApparent':Math.hypot(wx,wy)/1.94384,
                    'environment.wind.angleApparent':Math.atan2(wy,wx),'environment.depth.belowTransducer':12+Math.sin(elapsed*.08)*2.5,
                };
                targets=marina.targets.filter(t=>!t.isMoving).map(t=>({...t,id:`sim:${t.id}`,name:`SIM · ${t.name}`,isSimulated:true}));
                clusters=marina.harborClusters;
            }
            if (own && Number.isFinite(own.lat) && Number.isFinite(own.lon)) {
                if (!this.dynamic.length) {
                    this.dynamic=this.tools.generateRandomColregScenario(own,own.hdg,own.cog,own.sog).targets.map(t=>({
                        ...t,id:`sim:${t.id}`,name:`SIM · ${t.name}`,isSimulated:true,trail:[],
                    }));
                    this.scenarioStartedAt=now;
                } else {
                    const before=(now-dt*1000-this.scenarioStartedAt)/1000,elapsed=(now-this.scenarioStartedAt)/1000;
                    this.dynamic=this.dynamic.map((t,i)=>{
                        const turn=i===2 ? Math.max(0,Math.min(elapsed,47)-Math.max(before,32))*3 : 0;
                        const next=advance({...t,cog:(t.cog+turn)%360},dt);
                        const trail=(t.trail || []).filter(p=>p.t>=now-900000);
                        if (!trail.length || now-trail.at(-1).t>=30000) trail.push({lat:next.lat,lon:next.lon,t:now});
                        return {...next,trail:trail.slice(-60),age:0,isProjected:false};
                    });
                }
                const synth=this.mode==='simulation' ? [...targets,...this.dynamic] : this.dynamic;
                const result=this.tools.recalculateArpaForTargets(own,own.hdg,own.cog,own.sog,synth,'AUTO',live.config?.aisAlerter?.criticalProximity ?? 45,
                    String(raw['navigation.state'] || '').includes('anchor') && this.mode==='mixed');
                this.dynamic=result.targets.filter(t=>t.isMoving);
                targets=this.mode==='mixed' ? [...targets,...result.targets] : result.targets;
                for (const t of targets) if (t.isSimulated) t.proximityEntryObserved=this.bubbleEntries.update(t,own,live.config?.aisAlerter?.criticalProximity);
                this.bubbleEntries.prune(new Set(targets.filter(t=>t.isSimulated).map(t=>t.id)));
                this.simAlerts.update(targets,own,now);
                if (now-this.scenarioStartedAt>60000 && this.dynamic.every(t=>t.tcpa<0 && !['RED','ORANGE'].includes(t.risk))) this.dynamic=[];
            } else {
                this.dynamic=[];
                this.simAlerts.update(targets,null,now);
            }
        }
        this.revision++;
        this.current={mode:this.mode,generation:this.generation,environment:this.environment,changedAt:this.changedAt,
            revision:this.revision,serverNow:now,raw:outRaw,rawTimes:this.mode==='simulation' ? Object.fromEntries(Object.keys(outRaw).map(path=>[path,now])) : (live.rawTimes || {}),own,targets,harborClusters:clusters,
            sharedAlerts:this.sharedAlerts.snapshot(now),waitingForLivePosition:this.mode==='mixed'&&!own};
        return this.current;
    }
    snapshot() {
        return {...this.current,sharedAlerts:this.sharedAlerts.snapshot()};
    }
    publishSharedAlerts() { this.tick(); }
}

// Same dashboard-scoped capability as snooze/acknowledge. No upstream writes.
function registerDashboardRoutes(register,session) {
    const handlers=createDashboardAlertHandlers(session);
    register('GET','/rotevista-dashboard',(_req,res)=>{res.header('Cache-Control','no-store');res.json(session.snapshot());});
    register('GET','/rotevista-alert-session',handlers.session);
    register('POST','/rotevista-alert-actions',[handlers.guard,readAlertAction,handlers.action]);
    register('POST','/rotevista-dashboard-mode',[handlers.guard,readAlertAction,(req,res)=>{
        if(req.body?.sessionId!==session.sharedAlerts.sessionId) return res.status(409).json({error:'Dashboard session changed. Try again.'});
        try {res.json(session.setMode(req.body?.mode));}catch(error){res.status(error.status || 500).json({error:error.message});}
    }]);
}
module.exports={DashboardSession,registerDashboardRoutes};
