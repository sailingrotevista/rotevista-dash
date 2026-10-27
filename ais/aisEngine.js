const { gpsPositionFresh } = require('../shared/gpsPositionValidity');
const { OwnMotionState, OWN_MOTION_ID } = require('./ownMotionState');
const { extractReportedAis } = require('./aisReportedData');
const { AisSharedAlerts } = require('../session/aisSharedAlerts');
const { BubbleEntryTracker } = require('./bubbleEntryTracker');
const { positionMaxAgeMs, boatSpeedMaxAgeMs } = require('../shared/windDataPolicy.json');
const { getAreaAtPositionFromAreas } = require('./harborDetector');
/**
 * ==========================================================================
 * Rotevista Dash - Signal K AIS Ingestion & Threat Orchestrator Engine
 * ==========================================================================
 * Gestisce l'estrazione da Signal K in-memory (app.getPath('vessels')),
 * la cache 20NM con dead-reckoning, la correlazione con CollisionPipeline
 * e HarborDetector, e la notifica WebSocket delta per la Dashboard.
 * file aisEngine.js
 */

const { TargetMotionTracker, compactAisTrail } = require('./targetMotionTracker');
const { PLUGIN_BASE_TCPA_MINUTES } = require('./collisionConfig');
const { COLLISION_THRESHOLD_DEFAULTS, applyProximityPolicy } = require('./collisionPipeline');

const OWN_GEOMETRY_RETRY_MS = 60000;
const MOTION_DATA_MAX_SKEW_FRACTION = 0.2;

function evaluateMotionDataSync(positionTime, cogTime, sogTime, horizonMinutes) {
    const skew = time => Number.isFinite(positionTime) && Number.isFinite(time) ? Math.abs(positionTime - time) / 1000 : null;
    const cogSkewSeconds = skew(cogTime);
    const sogSkewSeconds = skew(sogTime);
    const maxSkewSeconds = Number.isFinite(horizonMinutes) && horizonMinutes > 0
        ? horizonMinutes * 60 * MOTION_DATA_MAX_SKEW_FRACTION : null;
    const outOfSync = maxSkewSeconds !== null && [cogSkewSeconds, sogSkewSeconds].some(value => value !== null && value > maxSkewSeconds);
    return { status: outOfSync ? 'OUT_OF_SYNC' : maxSkewSeconds === null || cogSkewSeconds === null || sogSkewSeconds === null ? 'UNKNOWN' : 'IN_SYNC',
        cogSkewSeconds, sogSkewSeconds, maxSkewSeconds };
}
const OWN_GEOMETRY_PATHS = [
    'design.length', 'design.length.overall', 'design.beam',
    'sensors.gps.fromBow', 'sensors.gps.fromCenter',
];

const MID_MAP = {
    247: "🇮🇹 ITA", 237: "🇬🇷 GRC", 238: "🇭🇷 CRO", 239: "🇬🇷 GRC", 240: "🇬🇷 GRC", 241: "🇬🇷 GRC",
    278: "🇸🇮 SLO", 262: "🇲🇪 MNE", 201: "🇦🇱 ALB", 271: "🇹🇷 TUR", 209: "🇨🇾 CYP", 210: "🇨🇾 CYP",
    212: "🇨🇾 CYP", 214: "🇲🇩 MDA", 215: "🇲🇹 MLT", 248: "🇲🇹 MLT", 249: "🇲🇹 MLT", 256: "🇲🇹 MLT",
    224: "🇪🇸 ESP", 225: "🇪🇸 ESP", 226: "🇫🇷 FRA", 227: "🇫🇷 FRA", 228: "🇫🇷 FRA", 254: "🇲🇨 MCO",
    255: "🇵🇹 POR", 263: "🇵🇹 POR", 268: "🇸🇲 SMR", 232: "🇬🇧 GBR", 233: "🇬🇧 GBR", 234: "🇬🇧 GBR",
    235: "🇬🇧 GBR", 236: "🇬🇮 GIB", 250: "🇮🇪 IRL", 269: "🇨🇭 SUI", 203: "🇦🇹 AUT", 211: "🇩🇪 DEU",
    218: "🇩🇪 DEU", 205: "🇧🇪 BEL", 244: "🇳🇱 NLD", 245: "🇳🇱 NLD", 246: "🇳🇱 NLD", 257: "🇳🇴 NOR",
    258: "🇳🇴 NOR", 259: "🇳🇴 NOR", 219: "🇩🇰 DNK", 220: "🇩🇰 DNK", 265: "🇸🇪 SWE", 266: "🇸🇪 SWE",
    230: "🇫🇮 FIN", 251: "🇮🇸 ISL", 261: "🇵🇱 POL", 272: "🇺🇦 UKR", 273: "🇷🇺 RUS", 264: "🇷🇴 ROU",
    207: "🇧🇬 BGR", 253: "🇱🇺 LUX", 243: "🇭🇺 HUN", 270: "🇨🇿 CZE", 267: "🇸🇰 SVK", 276: "🇪🇪 EST",
    275: "🇱🇻 LVA", 277: "🇱🇹 LTU", 428: "🇮🇱 ISR", 622: "🇪🇬 EGY", 672: "🇹🇳 TUN", 605: "🇩🇿 DZA",
    642: "🇱🇾 LBY", 242: "🇲🇦 MAR", 450: "🇱🇧 LBN", 468: "🇸🇾 SYR", 319: "🇰🇾 CYM", 308: "🇧🇸 BHS",
    309: "🇧🇸 BHS", 311: "🇧🇸 BHS", 378: "🇻🇬 VGB", 310: "🇧🇲 BMU", 375: "🇻🇨 VCT", 376: "🇻🇨 VCT",
    377: "🇻🇨 VCT", 312: "🇧🇿 BLZ", 304: "🇦🇬 ATG", 305: "🇦🇬 ATG", 306: "🇨🇼 CUW", 341: "🇰🇳 KNA",
    325: "🇩🇲 DMA", 330: "🇬🇩 GRD", 351: "🇵🇦 PAN", 352: "🇵🇦 PAN", 353: "🇵🇦 PAN", 354: "🇵🇦 PAN",
    355: "🇵🇦 PAN", 356: "🇵🇦 PAN", 357: "🇵🇦 PAN", 370: "🇵🇦 PAN", 371: "🇵🇦 PAN", 372: "🇵🇦 PAN",
    373: "🇵🇦 PAN", 636: "🇱🇷 LBR", 538: "🇲🇭 MHL", 518: "🇨🇰 COK", 576: "🇻🇺 VUT", 577: "🇻🇺 VUT",
    664: "🇸🇨 SYC", 316: "🇨🇦 CAN", 338: "🇺🇸 USA", 366: "🇺🇸 USA", 367: "🇺🇸 USA", 368: "🇺🇸 USA",
    369: "🇺🇸 USA", 477: "🇭🇰 HKG", 563: "🇸🇬 SGP", 564: "🇸🇬 SGP", 565: "🇸🇬 SGP", 566: "🇸🇬 SGP",
    503: "🇦🇺 AUS", 512: "🇳🇿 NZL", 431: "🇯🇵 JPN", 432: "🇯🇵 JPN", 440: "🇰🇷 KOR", 441: "🇰🇷 KOR",
    412: "🇨🇳 CHN", 413: "🇨🇳 CHN", 414: "🇨🇳 CHN", 470: "🇦🇪 ARE", 403: "🇸🇦 SAU"
};

function getVesselFlag(idStr) {
    if (!idStr) return "";
    let mmsi = String(idStr).split(':').pop();
    if (!mmsi || mmsi.length < 3) return "";
    let mid = parseInt(mmsi.substring(0, 3), 10);
    return MID_MAP[mid] || "";
}

function d2r(d) { return d * Math.PI / 180; }
function r2d(r) { return r * 180 / Math.PI; }

function distanceMeters(lat1, lon1, lat2, lon2) {
    const latMed = (lat1 + lat2) / 2 * Math.PI / 180;
    const dx = (lon2 - lon1) * 111139 * Math.cos(latMed);
    const dy = (lat2 - lat1) * 111139;
    return Math.sqrt(dx * dx + dy * dy);
}

class AisEngine {
    constructor(app, getConfig, windEngine, harborDetector, collisionPipeline) {
        this.app = app;
        this.getConfig = getConfig;
        this.windEngine = windEngine;
        this.harborDetector = harborDetector;
        this.collisionPipeline = collisionPipeline;

        this.aisPersistentCache = {};
        this.motionTracker = new TargetMotionTracker({}, { harborDetector });
        this.ownMotionState = new OwnMotionState(this.motionTracker);
        this.bubbleEntryTracker = new BubbleEntryTracker();
        this.sharedAlerts = new AisSharedAlerts();
        this.lastNearbyVessels = [];
        this.lastHarborClusters = [];
        this.topThreat = null;
        this.lastOwnGps = { lat: null, lon: null, t: 0 };
        this.ownGeometry = {};
        this.windEvidence = {};
        this.lastOwnGeometryProbe = null;
        this.aisDiagnostics = {
            status: 'INITIALIZING',
            myGps: null,
            vesselsCount: 0,
            extractionMethod: 'none',
            lastRun: null
        };
    }

    getNearbyVessels() {
        return this.lastNearbyVessels;
    }

    getHarborClusters() {
        return this.lastHarborClusters;
    }

    getOwnMotion(now = Date.now()) {
        const raw = this.windEngine.getRaw();
        const navigationState = raw['navigation.state'] !== undefined ? raw['navigation.state']
            : typeof this.app.getSelfPath === 'function' ? this.app.getSelfPath('navigation.state') : null;
        return this.ownMotionState.update({ ...raw, 'navigation.state': navigationState },
            this.windEngine.getRawTimes?.() || {}, this.lastHarborClusters, now, this.windEngine.getPositionMeasurement?.()?.expiresAt);
    }

    getTopThreat() {
        return this.topThreat;
    }

    publishSharedAlerts(now = Date.now(), evaluate = true) {
        const state = evaluate
            ? this.sharedAlerts.update(this.lastNearbyVessels, this.lastOwnGps.lat !== null ? this.lastOwnGps : null, now)
            : this.sharedAlerts.snapshot(now);
        if (this.lastPublishedAlertRevision !== state.revision && typeof this.app.handleMessage === 'function') {
            this.lastPublishedAlertRevision = state.revision;
            this.app.handleMessage('rotevista-dash', {
            context: 'vessels.self', updates: [{ values: [{ path: 'environment.ais_shared_alerts', value: state }] }]
            });
        }
        return state;
    }

    getDiagnostics() {
        return {
            ...this.aisDiagnostics,
            ownShipGeometry: this.getOwnGeometry(),
            ownMotion: this.getOwnMotion(),
            cacheCount: Object.keys(this.aisPersistentCache).length,
            nearbyCount: this.lastNearbyVessels.length,
            serverTime: new Date().toISOString()
        };
    }

    getPersistentCache() {
        return this.aisPersistentCache;
    }

    updateWindEvidence(path, value, timestamp) {
        if (!['environment.wind.directionTrue', 'environment.wind.speedTrue'].includes(path)) return;
        if (path === 'environment.wind.speedTrue' && this.windEngine.normalizedTwsManaged) return;
        const t = Date.parse(timestamp);
        if (!Number.isFinite(t)) return;
        if (!this.windEvidence[path] || t >= this.windEvidence[path].t) this.windEvidence[path] = { value, t };
    }

    updateOwnGeometry(path, value) {
        if (!OWN_GEOMETRY_PATHS.includes(path)) return false;
        let val = value && typeof value === 'object' && value.value !== undefined ? value.value : value;
        const field = path.startsWith('design.length') ? 'length'
            : path === 'design.beam' ? 'beam'
            : path.endsWith('fromBow') ? 'fromBow' : 'fromCenter';
        if (field === 'length' && val && typeof val === 'object') {
            val = val.overall;
            if (val && typeof val === 'object') val = val.value;
        }
        if (val === null) delete this.ownGeometry[field];
        else if (typeof val === 'number' && Number.isFinite(val) &&
            (field === 'fromCenter' || (field === 'fromBow' ? val >= 0 : val > 0))) {
            this.ownGeometry[field] = val;
        }
        return true;
    }

    refreshOwnGeometry(now = Date.now(), force = false) {
        const applied = this.getOwnGeometry();
        const complete = ['length', 'beam', 'antBow', 'antPort'].every(key => applied[key] !== undefined);
        if (!force && (complete || (this.lastOwnGeometryProbe !== null && now - this.lastOwnGeometryProbe < OWN_GEOMETRY_RETRY_MS))) return;
        this.lastOwnGeometryProbe = now;
        for (const path of OWN_GEOMETRY_PATHS) {
            try {
                let value = typeof this.app.getSelfPath === 'function' ? this.app.getSelfPath(path) : undefined;
                if (value == null && typeof this.app.getPath === 'function') {
                    value = this.app.getPath(`vessels.${this.app.selfId || 'self'}.${path}`);
                }
                if (value != null) this.updateOwnGeometry(path, value);
            } catch (err) {
                // The startup tree may not yet contain static vessel data; retry later.
            }
        }
    }

    getOwnGeometry() {
        const { length, beam, fromBow, fromCenter } = this.ownGeometry;
        const geometry = {};
        if (length !== undefined) geometry.length = length;
        if (beam !== undefined) geometry.beam = beam;
        if (length !== undefined && fromBow !== undefined && fromBow <= length) {
            geometry.antBow = fromBow;
            geometry.antStern = length - fromBow;
        }
        if (beam !== undefined && fromCenter !== undefined && Math.abs(fromCenter) <= beam / 2) {
            // Signal K convention: fromCenter positive to port, negative to starboard.
            geometry.antPort = beam / 2 - fromCenter;
            geometry.antStarboard = beam / 2 + fromCenter;
        }
        return geometry;
    }

    process() {
        try {
            const now = Date.now();
            this.refreshOwnGeometry(now);
            const raw = this.windEngine.getRaw();
            const app = this.app;
            const currentConfig = this.getConfig() || {};

            // 1. Lettura posizione e cinematica nave propria
            let myGps = null;
            if (raw['navigation.position']) {
                let p = raw['navigation.position'].value || raw['navigation.position'];
                if (p && p.latitude != null && p.longitude != null) {
                    myGps = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude) };
                }
            }
            if (!this.windEngine.normalizedPositionManaged && !myGps && typeof app.getSelfPath === 'function') {
                let pos = app.getSelfPath('navigation.position');
                if (!pos) pos = app.getSelfPath('navigation.position.value');
                let p = (pos && pos.value) ? pos.value : pos;
                if (p && p.latitude != null && p.longitude != null) {
                    myGps = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude) };
                }
            }
            if (!this.windEngine.normalizedPositionManaged && !myGps && typeof app.getPath === 'function') {
                let pos = app.getPath('vessels.self.navigation.position');
                let p = (pos && pos.value) ? pos.value : pos;
                if (p && p.latitude != null && p.longitude != null) {
                    myGps = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude) };
                }
            }
            if (this.windEngine.normalizedPositionManaged) {
                const time = this.windEngine.getRawTimes()['navigation.position'];
                if (!gpsPositionFresh(time,now,this.windEngine.getPositionMeasurement?.()?.expiresAt,positionMaxAgeMs)) myGps = null;
            }
            if (myGps && !isNaN(myGps.lat) && !isNaN(myGps.lon)) {
                this.lastOwnGps = { lat: myGps.lat, lon: myGps.lon, t: now };
            } else if (!this.windEngine.normalizedPositionManaged && this.lastOwnGps.lat !== null && this.lastOwnGps.lon !== null) {
                myGps = { lat: this.lastOwnGps.lat, lon: this.lastOwnGps.lon };
            }

            if (!myGps || isNaN(myGps.lat) || isNaN(myGps.lon)) {
                this.aisDiagnostics = {
                    status: 'WAITING_OWN_GPS',
                    myGps: null,
                    vesselsCount: 0,
                    extractionMethod: 'none',
                    lastRun: new Date(now).toISOString()
                };
                return;
            }
            this.aisDiagnostics.myGps = { lat: myGps.lat, lon: myGps.lon };

            const ownSog = raw['navigation.speedOverGround'];
            const ownSogTime = this.windEngine.getRawTimes?.()['navigation.speedOverGround'];
            // Only the DerivedData-backed store supplies own SOG; never reload a
            // discarded/missing value from the Signal K cache.
            const mySpeedKn = typeof ownSog === 'number' && Number.isFinite(ownSog) && ownSog >= 0 &&
                (!this.windEngine.normalizedSogManaged || (Number.isFinite(ownSogTime) && ownSogTime <= now && now-ownSogTime < boatSpeedMaxAgeMs))
                ? ownSog * 1.94384 : null;

            let myHdg = 0;
            if (raw['navigation.headingTrue'] !== undefined) {
                myHdg = (raw['navigation.headingTrue'] * 180 / Math.PI + 360) % 360;
            } else if (raw['navigation.courseOverGroundTrue'] !== undefined) {
                myHdg = (raw['navigation.courseOverGroundTrue'] * 180 / Math.PI + 360) % 360;
            }

            let myCog = myHdg;
            if (raw['navigation.courseOverGroundTrue'] !== undefined) {
                myCog = (raw['navigation.courseOverGroundTrue'] * 180 / Math.PI + 360) % 360;
            }

            let trueWindDir = myHdg;
            if (raw['environment.wind.directionTrue'] !== undefined) {
                trueWindDir = (raw['environment.wind.directionTrue'] * 180 / Math.PI + 360) % 360;
            }

            // 2. Lettura configurazione attiva con supporto gruppi ad albero e retrocompatibilità
            const cfg = currentConfig.aisAlerter || {};
            const configuredTrailMinutes = Number(cfg.vectorMinutes);
            const maxTrailAgeMs = (Number.isFinite(configuredTrailMinutes) && configuredTrailMinutes > 0
                ? configuredTrailMinutes : 15) * 60 * 1000;
            const ignoreOwnTarget = String(cfg.ignoreOwnTarget !== undefined ? cfg.ignoreOwnTarget : (cfg.ignoreOwnCallsign || "106125")).trim().toLowerCase();
            this.collisionPipeline.updateConfig({
                yachtRedCpaMeters: cfg.pleasureCraft?.redCpa ?? cfg.yachtRedCpa ?? 250,
                commercialRedCpaMeters: cfg.commercialShips?.redCpa ?? cfg.commercialRedCpa ?? 800,
                workRedCpaMeters: cfg.workboats?.redCpa ?? cfg.workRedCpa ?? 400,
                baseTcpaMinutes: cfg.baseTcpaMinutes ?? PLUGIN_BASE_TCPA_MINUTES,
            });

            const ownMotion = this.getOwnMotion(now);
            const ownShipInput = {
                ...this.getOwnGeometry(),
                lat: myGps.lat,
                lon: myGps.lon,
                sog: mySpeedKn,
                cog: myCog,
                hdg: myHdg,
                isAnchored: ownMotion.relaxedCollision,
                ...(['MOVING','STATIONARY'].includes(ownMotion.motionState) ? {motionState:ownMotion.motionState} : {}),
            };

            const MAX_DISTANCE_METERS = 37040; // 20 NM

            // 3. Estrazione albero navi da Signal K (in-memory)
            let vesselsData = {};
            let extractionMethod = 'none';

            if (typeof app.getPath === 'function') {
                try {
                    vesselsData = app.getPath('vessels') || app.getPath('/vessels') || {};
                    if (vesselsData && Object.keys(vesselsData).length > 0) {
                        extractionMethod = 'app.getPath';
                    }
                } catch (e) {}
            }
            if (!vesselsData || Object.keys(vesselsData).length === 0) {
                if (app.signalk && app.signalk.root && app.signalk.root.vessels) {
                    vesselsData = app.signalk.root.vessels;
                    extractionMethod = 'app.signalk.root.vessels';
                } else if (app.signalk && app.signalk.vessels) {
                    vesselsData = app.signalk.vessels;
                    extractionMethod = 'app.signalk.vessels';
                } else if (app.signalk && typeof app.signalk.retrieve === 'function') {
                    try {
                        const skRoot = app.signalk.retrieve();
                        if (skRoot && skRoot.vessels) {
                            vesselsData = skRoot.vessels;
                            extractionMethod = 'app.signalk.retrieve().vessels';
                        }
                    } catch (e) {}
                }
            }
            if (vesselsData && vesselsData.value && typeof vesselsData.value === 'object' && !vesselsData.navigation) {
                vesselsData = vesselsData.value;
                extractionMethod += ' (.value unwrap)';
            }

            this.aisDiagnostics.vesselsCount = vesselsData ? Object.keys(vesselsData).length : 0;
            this.aisDiagnostics.extractionMethod = extractionMethod;
            this.aisDiagnostics.lastRun = new Date(now).toISOString();
            this.aisDiagnostics.status = 'RUNNING';

            const selfId = app.selfId || 'self';

            // 4. Ingestione & Aggiornamento Cache 20 NM
            for (let key in vesselsData) {
                let v = vesselsData[key];
                if (!v) continue;

                let callsign = "";
                if (v.communication) {
                    if (v.communication.callsignVhf !== undefined) {
                        callsign = String(v.communication.callsignVhf);
                    } else if (v.communication.value && v.communication.value.callsignVhf !== undefined) {
                        callsign = String(v.communication.value.callsignVhf);
                    }
                }

                let rawVesselName = (v.name && typeof v.name === 'object' && v.name.value !== undefined) ? v.name.value : v.name;
                let safeVesselName = (typeof rawVesselName === 'string') ? rawVesselName.trim() : "";

                const isOwnVessel = key === "self" || key === selfId ||
                    (ignoreOwnTarget !== "" && (
                        callsign.toLowerCase() === ignoreOwnTarget ||
                        key.toLowerCase().includes(ignoreOwnTarget) ||
                        (safeVesselName && safeVesselName.toLowerCase() === ignoreOwnTarget)
                    ));

                if (isOwnVessel) {
                    delete this.aisPersistentCache[key];
                    continue;
                }

                if (!v.navigation || !v.navigation.position) continue;
                let pos = v.navigation.position.value || v.navigation.position;
                if (!pos || pos.latitude == null || pos.longitude == null) continue;
                let vLat = parseFloat(pos.latitude);
                let vLon = parseFloat(pos.longitude);
                if (!Number.isFinite(vLat) || !Number.isFinite(vLon) || Math.abs(vLat) > 90 || Math.abs(vLon) > 180) continue;

                let dist = distanceMeters(myGps.lat, myGps.lon, vLat, vLon);
                if (dist <= MAX_DISTANCE_METERS) {
                    let cachedName = (this.aisPersistentCache[key] && this.aisPersistentCache[key].name && !this.aisPersistentCache[key].name.startsWith("MMSI ") && this.aisPersistentCache[key].name !== "Barca Sconosciuta") ? this.aisPersistentCache[key].name : "";
                    let name = safeVesselName || cachedName;
                    if (!name && key.includes("mmsi:")) {
                        let mmsiMatch = key.match(/mmsi:(\d+)/);
                        name = mmsiMatch ? "MMSI " + mmsiMatch[1] : "Barca Sconosciuta";
                    } else if (!name) {
                        name = "Barca Sconosciuta";
                    }

                    let cog = 0;
                    let cogNode = (v.navigation.courseOverGroundTrue !== undefined) ? v.navigation.courseOverGroundTrue : v.navigation.headingTrue;
                    let cogVal = (cogNode && typeof cogNode === 'object' && cogNode.value !== undefined) ? cogNode.value : cogNode;
                    if (cogVal !== undefined && cogVal !== null && !isNaN(cogVal)) {
                        cog = r2d(parseFloat(cogVal));
                    }

                    let hdg = null;
                    let hdgNode = v.navigation.headingTrue;
                    let hdgVal = (hdgNode && typeof hdgNode === 'object' && hdgNode.value !== undefined) ? hdgNode.value : hdgNode;
                    if (hdgVal !== undefined && hdgVal !== null && !isNaN(hdgVal)) {
                        hdg = r2d(parseFloat(hdgVal));
                    }

                    let sog = null;
                    let sogNode = v.navigation.speedOverGround;
                    let sogVal = (sogNode && typeof sogNode === 'object' && sogNode.value !== undefined) ? sogNode.value : sogNode;
                    if (typeof sogVal === 'number' && Number.isFinite(sogVal) && sogVal >= 0) {
                        sog = parseFloat(sogVal) * 1.94384;
                    }

                    let navStateRaw = "";
                    if (v.navigation && v.navigation.state) {
                        let val = v.navigation.state.value !== undefined ? v.navigation.state.value : v.navigation.state;
                        navStateRaw = String(val).toLowerCase();
                    }

                    const positionTimestamp = v.navigation.position.timestamp;
                    const parsedTime = positionTimestamp
                        ? Date.parse(positionTimestamp)
                        : NaN;

                    // Senza un timestamp attendibile, non aggiornare la cache.
                    // Tolleriamo fino a 30 secondi di anticipo dell'orologio sorgente.
                    if (!Number.isFinite(parsedTime) || parsedTime > now + 30000) {
                        continue;
                    }

                    const realAisTime = Math.min(parsedTime, now);
                    const motionTimestamp = (node, value) => {
                        if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
                        const timestamp = Date.parse(node?.timestamp);
                        return Number.isFinite(timestamp) && timestamp <= now + 30000 ? timestamp : null;
                    };
                    const lastCogTime = motionTimestamp(cogNode, cogVal);
                    const lastSogTime = motionTimestamp(sogNode, sogVal);

                    const cachedTarget = this.aisPersistentCache[key];
                    if (cachedTarget && realAisTime < cachedTarget.lastSeen) continue;
                    const windSpeedEvidence = this.windEngine.normalizedTwsManaged
                        ? {value:this.windEngine.getNormalizedTws(now),t:this.windEngine.getRawTimes()['environment.wind.speedTrue']}
                        : this.windEvidence['environment.wind.speedTrue'];
                    const motion = this.motionTracker.update(key, {
                        lat: vLat, lon: vLon, t: realAisTime, sourceTime: parsedTime, sog, sogTime:lastSogTime, cog, cogTime:lastCogTime, hdg, headingTime: motionTimestamp(hdgNode, hdgVal),
                    }, { now, historyMs: maxTrailAgeMs,
                        wind: {
                            direction: Number.isFinite(this.windEvidence['environment.wind.directionTrue']?.value) ?
                                (r2d(this.windEvidence['environment.wind.directionTrue'].value) + 360) % 360 : null,
                            directionTime: this.windEvidence['environment.wind.directionTrue']?.t,
                            speedKnots: Number.isFinite(windSpeedEvidence?.value) ?
                                windSpeedEvidence.value * 1.94384 : null,
                            speedTime: windSpeedEvidence?.t,
                            lat: myGps.lat, lon: myGps.lon,
                        } });
                    if (!motion) continue; // A rejected first fix must not abort other targets.

                    let shipType = 0;
                    if (v.design && v.design.aisShipType) {
                        let val = v.design.aisShipType.value !== undefined ? v.design.aisShipType.value : v.design.aisShipType;
                        shipType = (typeof val === 'object' && val !== null) ? parseInt(val.id || val.code) || 0 : parseInt(val) || 0;
                    }
                    if (!shipType && v.designatorType) {
                        let val = v.designatorType.value !== undefined ? v.designatorType.value : v.designatorType;
                        shipType = parseInt(typeof val === 'object' ? val.id : val) || 0;
                    }
                    if (!shipType && name) {
                        let upperName = name.toUpperCase();
                        if (upperName.includes("BULK") || upperName.includes("CARGO") || upperName.includes("CONTAINER")) shipType = 70;
                        else if (upperName.includes("TANKER") || upperName.includes("OIL") || upperName.includes("CHEM")) shipType = 80;
                        else if (upperName.includes("TUG")) shipType = 31;
                        else if (upperName.includes("FERRY") || upperName.includes("EXPRESS")) shipType = 60;
                    }

                    let length = null;
                    if (v.design && v.design.length) {
                        let lVal = v.design.length.value !== undefined ? v.design.length.value : v.design.length;
                        length = (typeof lVal === 'object' && lVal !== null) ? parseFloat(lVal.overall || lVal.value) : parseFloat(lVal);
                    }
                    let beam = null;
                    if (v.design && v.design.beam) {
                        let bVal = v.design.beam.value !== undefined ? v.design.beam.value : v.design.beam;
                        beam = (typeof bVal === 'object' && bVal !== null) ? parseFloat(bVal.value) : parseFloat(bVal);
                    }
                    const readAisOffset = name => {
                        const node = v.sensors && v.sensors.ais && v.sensors.ais[name];
                        const value = node && typeof node === 'object' ? node.value : node;
                        return typeof value === 'number' && Number.isFinite(value) ? value : null;
                    };
                    const previous = this.aisPersistentCache[key];
                    const fromBow = readAisOffset('fromBow') ?? (previous ? previous.fromBow : null);
                    const fromCenter = readAisOffset('fromCenter') ?? (previous ? previous.fromCenter : null);
                    let draft = null;
                    if (v.design && v.design.draft) {
                        let dVal = v.design.draft.value !== undefined ? v.design.draft.value : v.design.draft;
                        draft = (typeof dVal === 'object' && dVal !== null) ? parseFloat(dVal.current || dVal.maximum || dVal.value) : parseFloat(dVal);
                    }

                    let destination = "";
                    if (v.navigation && v.navigation.destination) {
                        let destVal = v.navigation.destination.commonName ? v.navigation.destination.commonName.value : (v.navigation.destination.value || v.navigation.destination);
                        destination = (typeof destVal === 'string') ? destVal.trim() : "";
                    }
                    let eta = "";
                    if (v.navigation && v.navigation.destination && v.navigation.destination.eta) {
                        let etaVal = v.navigation.destination.eta.value !== undefined ? v.navigation.destination.eta.value : v.navigation.destination.eta;
                        eta = (typeof etaVal === 'string') ? etaVal : "";
                    }

                    // La classe del transponder è un dato AIS, non il tipo di scafo.
                    const classNode = v.sensors && v.sensors.ais && v.sensors.ais.class;
                    const classValue = classNode && typeof classNode === 'object'
                        ? classNode.value
                        : classNode;
                    const receivedClass = typeof classValue === 'string'
                        ? classValue.trim().toUpperCase()
                        : '';
                    const cachedClass = this.aisPersistentCache[key] && this.aisPersistentCache[key].aisClass;
                    const aisClass = (receivedClass === 'A' || receivedClass === 'B')
                        ? receivedClass
                        : ((cachedClass === 'A' || cachedClass === 'B') ? cachedClass : null);

                    this.aisPersistentCache[key] = {
                        id: key,
                        reportedAis: extractReportedAis(v),
                        name: name,
                        type: shipType || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].type : 0),
                        lat: vLat,
                        lon: vLon,
                        cog: Math.round((cog + 360) % 360),
                        sog: Number.isFinite(sog) ? parseFloat(sog.toFixed(1)) : null,
                        navStateRaw: navStateRaw || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].navStateRaw : ""),
                        callsign: callsign || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].callsign : ""),
                        length: length || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].length : null),
                        beam: beam || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].beam : null),
                        fromBow,
                        fromCenter,
                        draft: draft || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].draft : null),
                        destination: destination || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].destination : ""),
                        eta: eta || (this.aisPersistentCache[key] ? this.aisPersistentCache[key].eta : ""),
                        aisClass: aisClass,
                        hdg: hdg !== null ? Math.round((hdg + 360) % 360) : (this.aisPersistentCache[key] ? this.aisPersistentCache[key].hdg : null),
                        lastSeen: realAisTime,
                        positionSourceTime: parsedTime,
                        lastCogTime,
                        lastSogTime,
                        contactLost: Boolean(cachedTarget?.contactLost && realAisTime <= cachedTarget.lastSeen),
                        contactLostAt: cachedTarget?.contactLost && realAisTime <= cachedTarget.lastSeen ? cachedTarget.contactLostAt : undefined,
                        motionState: motion.motionState,
                        isMoored: this.aisPersistentCache[key] ? Boolean(this.aisPersistentCache[key].isMoored) : false
                    };
                }
            }

            // 5. Potatura scadenze cache (6 min se in moto, 15 min se fermi)
            for (let key in this.aisPersistentCache) {
                let v = this.aisPersistentCache[key];
                const motion = this.motionTracker.get(key, now, maxTrailAgeMs);
                let age = now - v.lastSeen;
                if (age < -30000) {
                    v.lastSeen = now;
                    age = 0;
                }
                let maxAgeAllowed = (motion ? motion.isMoving : v.sog >= 0.8)
                    ? COLLISION_THRESHOLD_DEFAULTS.movingTargetMaxAgeSeconds * 1000
                    : COLLISION_THRESHOLD_DEFAULTS.stationaryTargetMaxAgeSeconds * 1000;
                if (age > maxAgeAllowed) {
                    const alarm = this.collisionPipeline.targetStates.get(key)?.currentState;
                    if (alarm === 'RED' || alarm === 'ORANGE') {
                        v.contactLost = true;
                        v.contactLostAt = v.lastSeen + maxAgeAllowed;
                    }
                    else delete this.aisPersistentCache[key];
                }
            }

            // Keep the reserved own-ship entry while pruning obsolete AIS targets.
            this.motionTracker.prune(new Set([OWN_MOTION_ID, ...Object.keys(this.aisPersistentCache)]));

            // 6. Elaborazione ARPA, Kinematica & COLREGs
            let nearbyVessels = [];
            const evaluationInputs = new Map();

            for (let key in this.aisPersistentCache) {
                let v = this.aisPersistentCache[key];
                if (key === "self" || key === selfId || (ignoreOwnTarget !== "" && (
                    (v.callsign && v.callsign.toLowerCase() === ignoreOwnTarget) ||
                    key.toLowerCase().includes(ignoreOwnTarget) ||
                    (v.name && v.name.toLowerCase() === ignoreOwnTarget)
                ))) {
                    delete this.aisPersistentCache[key];
                    continue;
                }
                let currentDist = distanceMeters(myGps.lat, myGps.lon, v.lat, v.lon);
                if (currentDist > MAX_DISTANCE_METERS && !v.contactLost) continue;

                const motion = this.motionTracker.get(key, now, maxTrailAgeMs);
                const isMoving = motion ? motion.isMoving : v.sog >= 0.8;
                let navState = v.navStateRaw || '';
                const isExplicitMoored = navState.includes('moored') || navState === '5';
                const isMoored = !isMoving && (isExplicitMoored || Boolean(v.isMoored));
                const isAnchored = !isMoving && !isMoored && (navState.includes('anchor') || navState === '1');
                const anchorState = isMoored ? 'MOORED' : isAnchored ? 'ANCHORED' : 'UNDERWAY';
                v.isMoored = isMoored;
                v.isAnchored = isAnchored;
                let age = now - v.lastSeen;
                let outLat = v.lat;
                let outLon = v.lon;

                // Project real movement recognized by the tracker, including slow
                // departures. Stationary jitter and unconfirmed motion stay fixed.
                const isProjected = isMoving && age >= 15000 && Number.isFinite(v.sog) && v.sog > 0;
                if (isProjected) {
                    let t_hours = age / 3600000;
                    let distProj = (v.sog * 1852) * t_hours;
                    outLat = v.lat + (distProj * Math.cos(d2r(v.cog))) / 111139;
                    outLon = v.lon + (distProj * Math.sin(d2r(v.cog))) / (111139 * Math.cos(d2r(v.lat)));
                }

                let tCode = parseInt(v.type) || 0;

                // Valutazione tramite CollisionPipeline
                const evaluationInput = {
                    id: v.id,
                    mmsi: v.id,
                    name: v.name,
                    lat: outLat,
                    lon: outLon,
                    sog: isMoving ? v.sog : 0,
                    cog: v.cog,
                    hdg: v.hdg,
                    isMoving,
                    contactLost: Boolean(v.contactLost),
                    motionState: motion ? motion.motionState : undefined,
                    predictionStability: motion ? motion.predictionStability : undefined,
                    shipType: tCode,
                    lastUpdate: v.lastSeen,
                    isClassB: v.aisClass !== "A",
                    length: v.length,
                    beam: v.beam,
                    ...(v.length > 0 && v.fromBow != null && v.fromBow >= 0 && v.fromBow <= v.length
                        ? { antBow: v.fromBow, antStern: v.length - v.fromBow } : {}),
                    ...(v.beam > 0 && v.fromCenter != null && Math.abs(v.fromCenter) <= v.beam / 2
                        ? { antPort: v.beam / 2 - v.fromCenter, antStarboard: v.beam / 2 + v.fromCenter } : {}),
                    isMoored: isMoored,
                    anchorState: anchorState
                };
                evaluationInputs.set(v.id,evaluationInput);
                const evalRes = null; // Evaluate once after current area geometry is available.

                let cpa = evalRes ? Math.round(evalRes.cpaNominalMeters) : null;
                let tcpa = (evalRes && evalRes.tcpaMinutes >= 0) ? evalRes.tcpaMinutes : -1;
                let trend = evalRes ? evalRes.trend : 'STABLE';
                let risk = (evalRes && evalRes.alertState !== 'NO_DANGER') ? evalRes.alertState : "GREY";
                let riskMsg = (evalRes && evalRes.alertState !== 'NO_DANGER') ? (evalRes.reason || "") : "";
                let crossDir = evalRes ? evalRes.crossDir : "";
                let crossOutcome = evalRes ? evalRes.crossOutcome : "In Avvicinamento";
                let crossRule = evalRes ? evalRes.crossRule : "";
                let sightingTxt = evalRes ? evalRes.sightingTxt : "";

                nearbyVessels.push({
                    id: v.id,
                    name: v.name,
                    type: v.type,
                    lat: parseFloat(outLat.toFixed(7)),
                    lon: parseFloat(outLon.toFixed(7)),
                    cog: v.cog,
                    sog: v.sog,
                    dist: Math.round(currentDist),
                    isAnchored: isAnchored,
                    isMoored: isMoored,
                    anchorState: anchorState,
                    reportedNavigationState: v.navStateRaw || '',
                    reportedAis: v.reportedAis,
                    swingRadius: null,
                    anchorCenter: null,
                    isMoving,
                    motionState: motion ? motion.motionState : undefined,
                    stationarySince: motion ? motion.stationarySince : null,
                    restPattern: motion ? motion.restPattern : null,
                    lastPositionTime: v.lastSeen,
                    isProjected,
                    contactLost: Boolean(v.contactLost),
                    contactLostAt: v.contactLostAt,
                    predictionStability: motion ? motion.predictionStability : undefined,
                    effectiveThresholds: evalRes?.effectiveThresholds,
                    currentHullClearanceMeters: evalRes?.currentHullClearanceMeters,
                    lastCogTime: v.lastCogTime,
                    lastSogTime: v.lastSogTime,
                    motionDataSync: evaluateMotionDataSync(v.positionSourceTime, v.lastCogTime, v.lastSogTime, evalRes?.effectiveThresholds?.horizonTcpa),
                    warningBasis: evalRes?.warningBasis,
                    instabilityWarning: evalRes?.instabilityWarning,
                    risk: risk,
                    trend: trend,
                    riskMsg: riskMsg,
                    cpa: cpa,
                    tcpa: tcpa,
                    crossDir: crossDir,
                    crossOutcome: crossOutcome,
                    crossRule: crossRule,
                    sightingTxt: sightingTxt,
                    age: Math.max(0, Math.round(age / 1000)),
                    callsign: v.callsign || "",
                    length: v.length || null,
                    beam: v.beam || null,
                    draft: v.draft || null,
                    destination: v.destination || "",
                    eta: v.eta || "",
                    aisClass: v.aisClass || null,
                    flag: getVesselFlag(v.id),
                    inCluster: false,
                    trail: isMoving && motion ? motion.trail : []
                });
            }

            // 7. Auto-Apprendimento Cumulativo Porti (Geometria Permanente + Padding 18m)
            let harborClusters = this.harborDetector.processHarbors(nearbyVessels, myGps, raw, trueWindDir, now);
            const ownArea = getAreaAtPositionFromAreas(myGps.lat,myGps.lon,harborClusters,now);
            ownShipInput.inRecognizedArea = Boolean(ownArea);
            for (let i = 0; i < nearbyVessels.length; i++) {
                let v = nearbyVessels[i];
                const received = this.aisPersistentCache[v.id];
                const targetArea = getAreaAtPositionFromAreas(received.lat,received.lon,harborClusters,now);
                v.inRecognizedArea = Boolean(targetArea) || v.inCluster === true;
                const evalRes = this.collisionPipeline.evaluateTarget(ownShipInput, {
                    ...evaluationInputs.get(v.id), inRecognizedArea:v.inRecognizedArea,
                },now);
                if (v.contactLost && (!evalRes || evalRes.alertState === 'NO_DANGER')) {
                    delete this.aisPersistentCache[v.id];this.motionTracker.remove(v.id);
                    this.collisionPipeline.targetStates.delete(v.id);v.removeAfterEvaluation=true;continue;
                }
                Object.assign(v, {
                    alertPolicy:evalRes?.alertPolicy, effectiveThresholds:evalRes?.effectiveThresholds,
                    currentHullClearanceMeters:evalRes?.currentHullClearanceMeters,
                    cpa:Number.isFinite(evalRes?.cpaNominalMeters) ? Math.round(evalRes.cpaNominalMeters) : null,
                    tcpa:evalRes?.tcpaMinutes >= 0 ? evalRes.tcpaMinutes : -1,
                    risk:evalRes && evalRes.alertState !== 'NO_DANGER' ? evalRes.alertState : 'GREY',
                    riskMsg:evalRes && evalRes.alertState !== 'NO_DANGER' ? evalRes.reason || '' : '',
                    trend:evalRes?.trend || 'STABLE', warningBasis:evalRes?.warningBasis,
                    instabilityWarning:evalRes?.instabilityWarning, crossDir:evalRes?.crossDir || '',
                    crossOutcome:evalRes?.crossOutcome || '', crossRule:evalRes?.crossRule || '',
                    sightingTxt:evalRes?.sightingTxt || '',
                    motionDataSync:evaluateMotionDataSync(received.positionSourceTime,v.lastCogTime,v.lastSogTime,evalRes?.effectiveThresholds?.horizonTcpa),
                });
                v.proximityEntryObserved = this.bubbleEntryTracker.update(v, {
                    ...myGps, sog: mySpeedKn,
                    positionTime: this.windEngine.getRawTimes?.()['navigation.position'],
                }, cfg.criticalProximity, now);
                if (this.aisPersistentCache[v.id]) {
                    this.aisPersistentCache[v.id].isMoored = Boolean(v.isMoored);
                }
                if (v.alertPolicy?.mode === 'BUBBLE_ONLY') {
                    const area = targetArea || ownArea;
                    v.proximityArea = area ? { id:area.id, lat:received.lat, lon:received.lon } : undefined;
                }
                applyProximityPolicy(v,cfg.criticalProximity);
            }

            nearbyVessels = nearbyVessels.filter(v=>!v.removeAfterEvaluation);
            this.bubbleEntryTracker.prune(new Set(Object.keys(this.aisPersistentCache)));

            // 8. Ordinamento Bersagli per Pericolosità (RED > ORANGE > GREY) e Distanza
            this.collisionPipeline.pruneInactive(now);
            this.collisionPipeline.sortTargets(nearbyVessels);

            this.lastNearbyVessels = nearbyVessels;
            this.lastHarborClusters = harborClusters;

            // 9. Individuazione del Top Threat per il Banner
            const redThreat = nearbyVessels.find(v => v.risk === "RED");
            const orangeThreat = nearbyVessels.find(v => v.risk === "ORANGE" &&
                (v.alertKind !== 'PROXIMITY' || v.proximityEntryObserved));
            this.topThreat = redThreat || orangeThreat || null;

            this.sharedAlerts.update(nearbyVessels, myGps, now);

            // 10. Emissione Delta WebSocket verso la Dashboard
            if (typeof app.handleMessage === 'function') {
                app.handleMessage('rotevista-dash', {
                    context: 'vessels.self',
                    updates: [
                        {
                            values: [
                                { path: 'environment.ais_targets', value: this.lastNearbyVessels },
                                { path: 'environment.ais_top_threat', value: this.topThreat },
                                { path: 'environment.harbor_clusters', value: this.lastHarborClusters }
                            ]
                        }
                    ]
                });
            }
            this.aisDiagnostics.lastError = null;
        } catch (err) {
            this.aisDiagnostics.status = 'ERROR';
            this.aisDiagnostics.lastError = err && err.message ? err.message : String(err);
            if (typeof this.app.error === 'function') {
                this.app.error('processAisEngine error: ' + this.aisDiagnostics.lastError);
            }
        }
    }
}

module.exports = {
    AisEngine,
    MID_MAP,
    getVesselFlag,
    d2r,
    r2d,
    distanceMeters,
    compactAisTrail,
    evaluateMotionDataSync,
};
