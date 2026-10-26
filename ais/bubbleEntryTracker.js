'use strict';

const BUBBLE_ENTRY_CONFIG = {
    exitMarginMeters: 10,
    confirmationFixes: 2,
    confirmationSeconds: 10,
    ownMovingSpeedKnots: 0.8,
    ownMovingProgressMeters: 10,
    ownStationaryRadiusMeters: 35,
};
const distanceMeters = (a,b) => Math.hypot((a.lat-b.lat)*111139,
    (a.lon-b.lon)*111139*Math.cos((a.lat+b.lat)*Math.PI/360));
const moving = target => target.isMoving === true || target.motionState === 'MOVING';
const stationary = target => ['STATIONARY','POSSIBLE_MOVEMENT'].includes(target.motionState) || (!moving(target) && target.restPattern?.confirmed === true);

// First discovery and area learning are not entries. Track relative geometry
// independently of harbor membership, using only fresh received observations.
class BubbleEntryTracker {
    constructor(config = {}) {
        this.config = { ...BUBBLE_ENTRY_CONFIG, ...config };
        this.targets = new Map();
    }

    update(target, ownPosition, bubbleMeters = 45, now = Date.now()) {
        const bubble = Number.isFinite(bubbleMeters) && bubbleMeters > 0 ? bubbleMeters : 45;
        const distance = target.currentHullClearanceMeters;
        let state = this.targets.get(target.id);
        // Motion status itself comes from the real-fix tracker, even if the
        // displayed position has since been projected.
        if (state && moving(target)) state.motionObserved = true;
        if (!Number.isFinite(distance) || target.isProjected || target.contactLost ||
            !Number.isFinite(ownPosition?.lat) || !Number.isFinite(ownPosition?.lon)) return state?.entered === true;
        const targetTime = Number.isFinite(target.lastPositionTime) ? target.lastPositionTime : null;
        const ownTime = Number.isFinite(ownPosition.positionTime) ? ownPosition.positionTime : null;
        const signature = [target.lat,target.lon,ownPosition.lat,ownPosition.lon].join(':');
        const observationTime = Math.min(now, Math.max(targetTime ?? -Infinity, ownTime ?? -Infinity));
        const t = Number.isFinite(observationTime) ? observationTime : now;
        if (!state || state.bubble !== bubble) {
            state = { bubble, signature, targetTime, ownTime, outside:distance> bubble+this.config.exitMarginMeters,
                entered:false, motionObserved:moving(target), ownReference:{...ownPosition}, pending:null };
            this.targets.set(target.id,state);
            return false;
        }
        const timestamped = targetTime !== null || ownTime !== null;
        const fresh = timestamped
            ? (targetTime !== null && targetTime > (state.targetTime ?? -Infinity)) || (ownTime !== null && ownTime > (state.ownTime ?? -Infinity))
            : signature !== state.signature;
        if (!fresh) return state.entered;
        const geometryChanged = signature !== state.signature;
        state.targetTime = Math.max(state.targetTime ?? -Infinity,targetTime ?? -Infinity);
        state.ownTime = Math.max(state.ownTime ?? -Infinity,ownTime ?? -Infinity);
        state.signature = signature;
        const ownProgress = distanceMeters(ownPosition,state.ownReference);
        const ownMoved = ownProgress > this.config.ownStationaryRadiusMeters ||
            (ownPosition.sog >= this.config.ownMovingSpeedKnots && ownProgress >= this.config.ownMovingProgressMeters);
        if (ownMoved) state.motionObserved = true;
        // Stationary jitter, including jumps across both bubble boundaries,
        // cannot rearm the same stationary presence. A real departure or own
        // displacement must first authorize a transition.
        if (stationary(target) && !state.motionObserved) { state.pending=null; return state.entered; }
        const zone = distance <= bubble ? 'inside' : distance > bubble+this.config.exitMarginMeters ? 'outside' : null;
        const desired = state.entered ? 'outside' : state.outside ? 'inside' : 'outside';
        if (zone !== desired) { state.pending=null; return state.entered; }
        if (!state.pending) {
            // A hull/heading/metadata change at unchanged positions must not
            // start a crossing. Further real fixes may confirm a stopped arrival.
            if (!geometryChanged) return state.entered;
            state.pending={zone,firstTime:t,lastTime:t,fixes:1};
        } else if (t > state.pending.lastTime) {
            state.pending.lastTime=t;state.pending.fixes++;
        }
        if (state.pending.fixes < this.config.confirmationFixes ||
            t-state.pending.firstTime < this.config.confirmationSeconds*1000) return state.entered;
        state.entered=zone==='inside';state.outside=zone==='outside';state.pending=null;
        state.motionObserved=moving(target);state.ownReference={...ownPosition};
        return state.entered;
    }

    prune(activeIds) {
        for (const id of this.targets.keys()) if (!activeIds.has(id)) this.targets.delete(id);
    }
}
module.exports={BubbleEntryTracker,BUBBLE_ENTRY_CONFIG};
