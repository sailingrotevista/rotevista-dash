'use strict';
const { pointInPolygon } = require('./harborDetector');
const { isAnchoredNavigationState } = require('./collisionPipeline');
const policy = require('../shared/windDataPolicy.json');

// Reserved key in the SAME tracker used for AIS targets. This module only
// translates its result into own-ship context and the relaxed collision policy.
const OWN_MOTION_ID = 'self';
class OwnMotionState {
    constructor(tracker) {
        this.tracker = tracker;
        this.restConfirmed = false;
    }

    update(raw = {}, times = {}, areas = [], now = Date.now()) {
        const position = raw['navigation.position'];
        const time = times['navigation.position'];
        const fresh = (timestamp, maxAge) => Number.isFinite(timestamp) && timestamp <= now && now - timestamp < maxAge;
        const valid = position && Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90 &&
            Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180 && fresh(time, policy.positionMaxAgeMs);
        const last = this.tracker.get(OWN_MOTION_ID, now, 900000);
        if (valid && last && time - last.lastFixTime > this.tracker.config.restMaximumGapSeconds * 1000) {
            this.tracker.remove(OWN_MOTION_ID);
            this.restConfirmed = false;
        }
        const anchored = isAnchoredNavigationState(raw['navigation.state']);
        if (valid) {
            const speed = raw['navigation.speedOverGround'];
            const sog = Number.isFinite(speed) && speed >= 0 && speed <= 25.72 &&
                fresh(times['navigation.speedOverGround'], policy.boatSpeedMaxAgeMs) ? speed * 1.94384 : NaN;
            const course = raw['navigation.courseOverGroundTrue'];
            const cog = Number.isFinite(course) && Math.abs(course) <= Math.PI * 2 &&
                fresh(times['navigation.courseOverGroundTrue'], policy.headingMaxAgeMs) ? (course * 180 / Math.PI + 360) % 360 : NaN;
            this.tracker.update(OWN_MOTION_ID, { lat: position.latitude, lon: position.longitude, t: time, sourceTime: time, sog, cog },
                { now, historyMs: 900000, anchored });
        }
        const motion = this.tracker.get(OWN_MOTION_ID, now, 900000);
        if (motion?.motionState === 'MOVING') this.restConfirmed = false;
        else if (motion?.restPattern?.confirmed) this.restConfirmed = true;
        // A pending departure retains the confirmed rest policy until real movement is confirmed.
        const confirmedRest = Boolean(valid && this.restConfirmed);
        const reportedRest = anchored && motion?.motionState !== 'MOVING';
        const relaxedCollision = confirmedRest || reportedRest;
        const inPort = Boolean(valid && areas.some(area => area.kind === 'PORT' && Array.isArray(area.hull) &&
            area.hull.length >= 3 && pointInPolygon(position.latitude, position.longitude, area.hull)));
        const status = !valid ? 'UNKNOWN' : motion?.isMoving ? 'UNDERWAY' : relaxedCollision
            ? inPort ? 'IN PORT' : 'AT ANCHOR' : 'STOPPED';
        return { status, valid: Boolean(valid), confirmedRest, relaxedCollision, inPort,
            motionState: motion?.motionState ?? 'UNKNOWN', lastFixTime: motion?.lastFixTime ?? null,
            restPattern: motion?.restPattern ?? null };
    }
}
module.exports = { OwnMotionState, OWN_MOTION_ID };
