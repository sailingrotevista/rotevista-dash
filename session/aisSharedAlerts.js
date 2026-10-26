'use strict';
const { randomUUID } = require('crypto');
const { compareTargets } = require('../ais/collisionPipeline');
const HOLD_MS = 10000, SNOOZE_MS = 600000, READY_MS = 3000, ABSENCE_MS = 86400000;
const isBubble = t => t.alertKind === 'PROXIMITY' && t.areaProximityOnly && !t.isMoving && t.motionState !== 'MOVING';
const key = t => t ? `${t.id}:${t.risk}:${t.alertKind || 'COLLISION'}` : null;

class AisSharedAlerts {
    constructor({ now = Date.now(), sessionId = randomUUID() } = {}) {
        this.sessionId = sessionId;
        this.controlToken = randomUUID();
        this.startedAt = now;
        this.revision = 0;
        this.acknowledgements = new Map();
        this.snoozes = new Map();
        this.targets = [];
        this.ownPosition = null;
        this.activeId = null;
        this.pendingId = null;
        this.pendingSince = null;
        this.bannerKey = null;
        this.readyAt = null;
        this.banner = null;
        this.serialized = '';
        this.update([], null, now);
    }

    update(targets, ownPosition, now = Date.now()) {
        this.targets = targets;
        if (ownPosition && Number.isFinite(ownPosition.lat) && Number.isFinite(ownPosition.lon)) this.ownPosition = ownPosition;
        const byId = new Map(targets.map(t => [t.id, t]));
        for (const [id, entry] of this.acknowledgements) {
            const t = byId.get(id);
            if (t) entry.lastPresent = now;
            const p = this.ownPosition;
            const distance = p ? Math.hypot((p.lat-entry.lat)*111139,
                (p.lon-entry.lon)*111139*Math.cos((p.lat+entry.lat)*Math.PI/360)) : 0;
            if (t?.isMoving || t?.motionState === 'MOVING' || distance > 3704 || now-entry.lastPresent >= ABSENCE_MS) this.acknowledgements.delete(id);
        }
        for (const [id, entry] of this.snoozes) {
            const t = byId.get(id);
            if (!t || !['RED','ORANGE'].includes(t.risk) || (entry.lostPositionTime !== undefined && !t.contactLost) ||
                (entry.initialRisk === 'ORANGE' && t.risk === 'RED')) {
                this.snoozes.delete(id);
                continue;
            }
            if (t.contactLost) {
                if (now < entry.until || t.contactLostAt < entry.until) entry.lostPositionTime = t.lastPositionTime;
            } else {
                if (now >= entry.until) { this.snoozes.delete(id); continue; }
                if (entry.initialRisk === 'RED' && t.risk === 'ORANGE') entry.initialRisk = 'ORANGE';
            }
        }
        const candidates = targets.filter(t => {
            if (!['RED','ORANGE'].includes(t.risk)) return false;
            if (t.areaProximityOnly && !isBubble(t)) return false;
            if (isBubble(t) && (t.proximityEntryObserved === false || this.acknowledgements.has(t.id))) return false;
            const entry = this.snoozes.get(t.id);
            if (!entry) return true;
            return !(now < entry.until || (t.contactLost && (t.contactLostAt < entry.until || entry.lostPositionTime === t.lastPositionTime)));
        });
        const bubbles = candidates.filter(isBubble).sort((a,b) =>
            (a.currentHullClearanceMeters ?? a.dist ?? Infinity)-(b.currentHullClearanceMeters ?? b.dist ?? Infinity) ||
            (a.dist ?? Infinity)-(b.dist ?? Infinity) || String(a.id).localeCompare(String(b.id)));
        const ordered = candidates.filter(t => !isBubble(t) || t.id === bubbles[0]?.id).sort(compareTargets);
        const best = ordered[0] || null;
        const active = ordered.find(t => t.id === this.activeId);
        const severity = t => t?.risk === 'RED' ? 2 : t?.risk === 'ORANGE' ? 1 : 0;
        let chosen = active;
        if (!best || !active || best.id === active.id || severity(best)>severity(active) || (isBubble(best)&&isBubble(active))) {
            chosen = best; this.pendingId = null; this.pendingSince = null;
        } else {
            if (this.pendingId !== best.id) { this.pendingId=best.id; this.pendingSince=now; }
            if (now-this.pendingSince >= HOLD_MS) { chosen=best; this.pendingId=null; this.pendingSince=null; }
        }
        this.activeId = chosen?.id ?? null;
        const nextKey = key(chosen);
        if (nextKey !== this.bannerKey) { this.bannerKey=nextKey; this.readyAt=chosen ? now+READY_MS : null; }
        this.banner = chosen || null;
        const state = this.state();
        const serialized = JSON.stringify(state);
        if (serialized !== this.serialized) { this.revision++; this.serialized=serialized; }
        return this.snapshot(now);
    }

    action({ type, targetId, expectedRisk, expectedAlertKind, sessionId }, now = Date.now()) {
        if (sessionId !== this.sessionId) throw Object.assign(new Error('Server restarted. Refresh alert state and try again.'), { status:409 });
        if (type === 'reopen') {
            this.acknowledgements.clear(); this.snoozes.clear();
        } else {
            const target = this.targets.find(t => t.id === targetId);
            if (!target || target.risk !== expectedRisk || (target.alertKind || 'COLLISION') !== expectedAlertKind) {
                throw Object.assign(new Error('This alert changed. Review the current target before acknowledging.'), { status:409 });
            }
            if (type === 'acknowledge' && isBubble(target)) {
                for (const t of this.targets.filter(isBubble)) {
                    const area=t.proximityArea || {id:t.clusterId || t.id,lat:t.lat,lon:t.lon};
                    this.acknowledgements.set(t.id, {...area,lastPresent:now});
                }
            } else if (type === 'snooze' && !isBubble(target) && ['RED','ORANGE'].includes(target.risk)) {
                const existing = this.snoozes.get(target.id);
                if (existing && now < existing.until && existing.initialRisk === target.risk) return this.snapshot(now);
                this.snoozes.set(target.id, {until:now+SNOOZE_MS,initialRisk:target.risk,
                    ...(target.contactLost ? {lostPositionTime:target.lastPositionTime} : {})});
            } else throw Object.assign(new Error('Invalid alert action.'), {status:400});
        }
        return this.update(this.targets,this.ownPosition,now);
    }

    state() {
        return {banner:this.banner, snoozeReadyAt:this.readyAt,
            acknowledgements:Object.fromEntries([...this.acknowledgements].map(([id,entry]) => [id,{id:entry.id,lat:entry.lat,lon:entry.lon}])),snoozes:Object.fromEntries(this.snoozes)};
    }
    snapshot(now=Date.now()) {
        return {sessionId:this.sessionId,startedAt:this.startedAt,revision:this.revision,serverNow:now,...this.state()};
    }
}
module.exports={AisSharedAlerts};

// Avoid a new Express dependency: Signal K may already have parsed the body.
function readAlertAction(req, res, next) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({error:'JSON request required.'});
    if (req.body !== undefined) return next();
    let size=0, chunks=[], finished=false;
    req.on('data', chunk => {
        if (finished) return;
        const bytes=Buffer.from(chunk); size+=bytes.length;
        if (size>4096) { finished=true; chunks=[]; res.status(413).json({error:'Request too large.'}); return; }
        chunks.push(bytes);
    });
    req.on('end', () => {
        if (finished) return;
        finished=true;
        try { req.body=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return res.status(400).json({error:'Invalid JSON request.'}); }
        next();
    });
    req.on('error', () => {
        if (!finished) { finished=true; res.status(400).json({error:'Incomplete request.'}); }
    });
}
module.exports.readAlertAction=readAlertAction;


// Dashboard-scoped capability, deliberately independent of administrative login.
// Readers of the same dashboard origin can obtain it; external browser pages
// cannot read the capability or submit a valid action.
function dashboardRequestAllowed(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
    } catch { return false; }
}

function createDashboardAlertHandlers(engine) {
    const noCache = res => {
        res.removeHeader('Access-Control-Allow-Origin');
        res.header('Cache-Control', 'no-store');
        res.header('Vary', 'Origin, Sec-Fetch-Site');
    };
    return {
        session(req,res) {
            noCache(res);
            if (!dashboardRequestAllowed(req)) return res.status(403).json({error:'Open alert controls from the dashboard.'});
            res.json({token:engine.sharedAlerts.controlToken,sessionId:engine.sharedAlerts.sessionId});
        },
        guard(req,res,next) {
            noCache(res);
            if (!dashboardRequestAllowed(req) || req.headers['x-rotevista-alert-key'] !== engine.sharedAlerts.controlToken) {
                return res.status(403).json({error:'Dashboard alert session is invalid. Reload the dashboard and try again.'});
            }
            next();
        },
        action(req,res) {
            const body=req.body;
            if (!body || !['acknowledge','snooze','reopen'].includes(body.type) ||
                (body.type !== 'reopen' && (typeof body.targetId !== 'string' || body.targetId.length>160))) {
                return res.status(400).json({error:'Invalid alert action.'});
            }
            try {
                const state=engine.sharedAlerts.action(body);
                engine.publishSharedAlerts();
                res.json(state);
            } catch(error) { res.status(error.status || 500).json({error:error.message}); }
        },
    };
}
module.exports.dashboardRequestAllowed=dashboardRequestAllowed;
module.exports.createDashboardAlertHandlers=createDashboardAlertHandlers;
