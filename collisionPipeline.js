/**
 * ============================================================================
 * Collision Avoidance Pipeline (Modules 1 - 4)
 * File: collisionPipeline.js
 * ============================================================================
 * Modulo computazionale puro e macchina a stati per prevenzione collisioni AIS:
 * - Modulo 1: Inviluppo geometrico scafo (LOA, Beam, GPS antenna offset)
 * - Modulo 2: Cono dinamico di incertezza (fix age, jitter pos/vel/cog)
 * - Modulo 3: Cinematica vettoriale ARPA (CPA nominale, CPA min/max nel cono, TCPA)
 * - Modulo 4: Classificazione soglie, qualifica differibilità, trend Delta-CPA,
 *             isteresi asimmetrica (escalation istantanea, hold timer per de-escalation).
 * ============================================================================
 */

'use strict';

// ----------------------------------------------------------------------------
// 1. COSTANTI E UTILITY MATEMATICHE
// ----------------------------------------------------------------------------
const D2R = Math.PI / 180.0;
const R2D = 180.0 / Math.PI;
const MS_TO_KNOTS = 1.94384449;
const KNOTS_TO_MS = 0.51444444;
const METERS_PER_DEG_LAT = 111139.0;

function d2r(deg) {
    return deg * D2R;
}

function r2d(rad) {
    return rad * R2D;
}

function normalizeDegrees(deg) {
    return (deg % 360 + 360) % 360;
}

function angularDiff(degA, degB) {
    let diff = Math.abs(degA - degB) % 360;
    return diff > 180 ? 360 - diff : diff;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
    let phi1 = lat1 * D2R;
    let phi2 = lat2 * D2R;
    let deltaPhi = (lat2 - lat1) * D2R;
    let deltaLambda = (lon2 - lon1) * D2R;
    let a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371000 * c;
}

// ----------------------------------------------------------------------------
// 2. MODULO 1: INVILUPPO GEOMETRICO DELLO SCAFO
// ----------------------------------------------------------------------------
const DEFAULT_DIMENSIONS_BY_TYPE = {
    commercial: { loa: 180, beam: 28, a: 130, b: 50, c: 14, d: 14 },
    work:       { loa: 35,  beam: 9,  a: 20,  b: 15, c: 4.5, d: 4.5 },
    sailing:    { loa: 12,  beam: 3.8, a: 8,   b: 4,  c: 1.9, d: 1.9 },
    pleasure:   { loa: 11,  beam: 3.5, a: 7,   b: 4,  c: 1.75, d: 1.75 },
    default:    { loa: 15,  beam: 4.5, a: 10,  b: 5,  c: 2.25, d: 2.25 }
};

function getHullBoundingRadius(vessel, vesselCategory) {
    let cat = vesselCategory || 'default';
    let fallback = DEFAULT_DIMENSIONS_BY_TYPE[cat] || DEFAULT_DIMENSIONS_BY_TYPE.default;

    let dims = vessel.dimensions || {};
    let loa = vessel.length || (dims && dims.length) || fallback.loa;
    let beam = vessel.beam || (dims && dims.width) || fallback.beam;

    let defaultRatioA = fallback.a / fallback.loa;
    let a = dims.partA !== undefined ? dims.partA : (dims.a !== undefined ? dims.a : (vessel.antBow !== undefined ? vessel.antBow : loa * defaultRatioA));
    let b = dims.partB !== undefined ? dims.partB : (dims.b !== undefined ? dims.b : (vessel.antStern !== undefined ? vessel.antStern : Math.max(1, loa - a)));
    let c = dims.partC !== undefined ? dims.partC : (dims.c !== undefined ? dims.c : (vessel.antPort !== undefined ? vessel.antPort : beam * 0.5));
    let d = dims.partD !== undefined ? dims.partD : (dims.d !== undefined ? dims.d : (vessel.antStarboard !== undefined ? vessel.antStarboard : beam * 0.5));

    let boundingRadius = Math.max(
        Math.sqrt(a * a + c * c),
        Math.sqrt(a * a + d * d),
        Math.sqrt(b * b + c * c),
        Math.sqrt(b * b + d * d)
    );

    return { loa, beam, a, b, c, d, boundingRadius };
}

function getHullEllipticalMargin(hull, vesselHeadingDeg, bearingTowardsOtherDeg) {
    let alphaRad = d2r(bearingTowardsOtherDeg - (vesselHeadingDeg || 0));
    let cosA = Math.cos(alphaRad);
    let sinA = Math.sin(alphaRad);
    let lEff = cosA >= 0 ? hull.a : hull.b;
    let wEff = sinA >= 0 ? hull.d : hull.c;
    return Math.sqrt((lEff * cosA) * (lEff * cosA) + (wEff * sinA) * (wEff * sinA));
}


// ----------------------------------------------------------------------------
// 3. MODULO 2: CONO DINAMICO DI INCERTEZZA
// ----------------------------------------------------------------------------
function calculateUncertaintyCone(target, now) {
    let lastFixTime = target.lastUpdate || target.timestamp || now;
    let fixAgeSec = Math.max(0, (now - lastFixTime) / 1000);
    // Clamp dell'età fix per evitare dispersioni infinite su target persi
    let ageEffective = Math.min(fixAgeSec, 300);

    let isClassB = target.isClassB !== false; // prudenziale
    let sogKnots = Math.max(0, target.sog || 0);

    // Jitter GNSS nominale + deriva su età pacchetto
    let gnssSigmaMeters = isClassB ? 7.5 : 3.0;
    let posUncertaintyMeters = gnssSigmaMeters + (sogKnots * KNOTS_TO_MS * 0.05 * ageEffective);

    // Cono angolare rotta: imbarcazioni lente o datate hanno incertezza angolare maggiore
    let baseAngularConeDeg = isClassB ? 5.0 : 3.0;
    let dynamicAngularConeDeg = baseAngularConeDeg + (20.0 / Math.max(2.0, sogKnots)) * Math.min(1.0, ageEffective / 60.0);
    let halfConeDeg = Math.min(30.0, dynamicAngularConeDeg);

    // Incertezza su velocità SOG
    let sogUncertaintyKnots = Math.min(3.0, 0.4 + sogKnots * 0.06);

    return {
        fixAgeSec,
        posUncertaintyMeters,
        halfConeDeg,
        sogUncertaintyKnots
    };
}

// ----------------------------------------------------------------------------
// 4. MODULO 3: CINEMATICA VETTORIALE E ARPA
// ----------------------------------------------------------------------------
function solveRelativeKinematics(x0, y0, myVx, myVy, targetVx, targetVy) {
    let vx = targetVx - myVx;
    let vy = targetVy - myVy;
    let v2 = vx * vx + vy * vy;

    if (v2 < 1e-6) {
        // Moto relativo nullo (velocità identiche)
        return {
            tcpaSec: -1,
            cpaMeters: Math.sqrt(x0 * x0 + y0 * y0),
            vx,
            vy,
            relSpeedMs: 0
        };
    }

    let tSec = -(x0 * vx + y0 * vy) / v2;
    let cpaX = x0 + vx * tSec;
    let cpaY = y0 + vy * tSec;
    let cpaMeters = Math.sqrt(cpaX * cpaX + cpaY * cpaY);
    let cpaBearingDeg = (cpaMeters > 0.5)
        ? normalizeDegrees(r2d(Math.atan2(cpaX, cpaY)))
        : normalizeDegrees(r2d(Math.atan2(x0, y0)));

    return {
        tcpaSec: tSec,
        cpaMeters,
        cpaBearingDeg,
        vx,
        vy,
        relSpeedMs: Math.sqrt(v2)
    };
}

function computeCpaTcpa(ownShip, target, uncertainty) {
    let myLat = ownShip.lat;
    let myLon = ownShip.lon;
    let targetLat = target.lat;
    let targetLon = target.lon;

    // Coordinate cartesiane piane centrate su OwnShip (metri)
    let x0 = (targetLon - myLon) * METERS_PER_DEG_LAT * Math.cos(d2r(myLat));
    let y0 = (targetLat - myLat) * METERS_PER_DEG_LAT;
    let rangeMeters = Math.sqrt(x0 * x0 + y0 * y0);

    let ownSog = (ownShip.sog || 0) >= 0.8 ? (ownShip.sog || 0) : 0;
    let mySpeedMs = ownSog * KNOTS_TO_MS;
    let myCog = ownShip.cog || 0;
    let myVx = mySpeedMs * Math.sin(d2r(myCog));
    let myVy = mySpeedMs * Math.cos(d2r(myCog));

    let targetSog = (target.sog || 0) >= 0.8 ? (target.sog || 0) : 0;
    let targetCog = target.cog || 0;
    let targetSpeedMs = targetSog * KNOTS_TO_MS;
    let targetVx = targetSpeedMs * Math.sin(d2r(targetCog));
    let targetVy = targetSpeedMs * Math.cos(d2r(targetCog));

    // 1. Cinematica Nominale
    let nominal = solveRelativeKinematics(x0, y0, myVx, myVy, targetVx, targetVy);

    // 2. Dispersione ai bordi del cono d'incertezza (solo se il bersaglio è in movimento)
    let cpaMin = nominal.cpaMeters;
    let cpaMax = nominal.cpaMeters;

    if (targetSog >= 0.8) {
        let halfCone = uncertainty ? uncertainty.halfConeDeg : 0;
        let sogDelta = uncertainty ? uncertainty.sogUncertaintyKnots : 0;

        let testVectors = [
            { cog: targetCog - halfCone, sog: Math.max(0, targetSog - sogDelta) },
            { cog: targetCog - halfCone, sog: targetSog + sogDelta },
            { cog: targetCog + halfCone, sog: Math.max(0, targetSog - sogDelta) },
            { cog: targetCog + halfCone, sog: targetSog + sogDelta }
        ];

        for (let i = 0; i < testVectors.length; i++) {
            let tv = testVectors[i];
            let tvSpeedMs = tv.sog * KNOTS_TO_MS;
            let tvVx = tvSpeedMs * Math.sin(d2r(tv.cog));
            let tvVy = tvSpeedMs * Math.cos(d2r(tv.cog));
            let res = solveRelativeKinematics(x0, y0, myVx, myVy, tvVx, tvVy);

            if (res.tcpaSec > 0) {
                if (res.cpaMeters < cpaMin) cpaMin = res.cpaMeters;
                if (res.cpaMeters > cpaMax) cpaMax = res.cpaMeters;
            }
        }
    }

    // Incorpora incertezza posizione su cpaMin
    if (uncertainty) {
        cpaMin = Math.max(0, cpaMin - uncertainty.posUncertaintyMeters);
        cpaMax = cpaMax + uncertainty.posUncertaintyMeters;
    }

    let tcpaSeconds = nominal.tcpaSec > 0 ? Math.round(nominal.tcpaSec) : -1;
    let tcpaMinutes = nominal.tcpaSec > 0 ? (nominal.tcpaSec / 60.0) : -1;
    let bearingNowDeg = normalizeDegrees(r2d(Math.atan2(x0, y0)));
    let cpaBearingDeg = nominal.cpaBearingDeg !== undefined ? nominal.cpaBearingDeg : bearingNowDeg;

    return {
        rangeMeters: Math.round(rangeMeters),
        rangeNM: rangeMeters / 1852.0,
        bearingNowDeg,
        cpaBearingDeg,
        cpaNominalMeters: Math.round(nominal.cpaMeters),
        cpaMinMeters: Math.round(cpaMin),
        cpaMaxMeters: Math.round(cpaMax),
        tcpaSeconds,
        tcpaMinutes: tcpaMinutes >= 0 ? parseFloat(tcpaMinutes.toFixed(1)) : -1,
        tcpaSec: tcpaSeconds,
        isDiverging: nominal.tcpaSec <= 0
    };
}

// ----------------------------------------------------------------------------
// 5. MODULO 4: SOGLIE, DIFFERIBILITÀ, TREND E STATE MACHINE
// ----------------------------------------------------------------------------
const SEVERITY_LEVELS = {
    NO_DANGER: 0,
    ORANGE: 1,
    RED: 2
};

class CollisionPipeline {
    constructor(userConfig = {}) {
        this.config = Object.assign({
            yachtRedCpaMeters: 300,
            yachtOrangeCpaMeters: 800,
            commercialRedCpaMeters: 750,
            commercialOrangeCpaMeters: 1850,
            workRedCpaMeters: 350,
            workOrangeCpaMeters: 750,
            yachtCritTcpaMin: 6.0,
            yachtHorizonTcpaMin: 15.0,
            commercialCritTcpaMin: 10.0,
            commercialHorizonTcpaMin: 22.0,
            workCritTcpaMin: 8.0,
            workHorizonTcpaMin: 15.0,
            kDefer: 0.6,               // Se TCPA > 60% dell'orizzonte e allarme dovuto solo a cono: differibile
            minRangeDeferMeters: 2500, // Non differibile sotto ~1.35 NM
            deadbandMeters: 80,        // Margine spaziale di rientro
            deescalateHoldTimeMs: 12000, // 12 secondi di stabilità prima di scendere di livello
            maxTargetMemoryMs: 12 * 60 * 1000 // 12 min di ritenzione stato
        }, userConfig);

        this.targetStates = new Map(); // mmsi -> TargetState
    }

    updateConfig(newConfig) {
        Object.assign(this.config, newConfig);
    }

    _resolveVesselCategory(target) {
        let code = target.shipType || target.typeCode || 0;
        let isCommercial = (code >= 70 && code <= 89);
        let isWork = (code >= 30 && code <= 32) || (code >= 50 && code <= 55);
        if (isCommercial) return 'commercial';
        if (isWork) return 'work';
        return 'sailing';
    }

    _resolveThresholds(target, category) {
        let redCpa = this.config.yachtRedCpaMeters;
        let orangeCpa = this.config.yachtOrangeCpaMeters;
        let critTcpa = this.config.yachtCritTcpaMin;
        let horizonTcpa = this.config.yachtHorizonTcpaMin;

        let sog = target.sog || 0;

        if (category === 'commercial') {
            let speedFactor = Math.min(1.75, 1.0 + Math.max(0, sog - 12.0) * 0.035);
            redCpa = Math.round(this.config.commercialRedCpaMeters * speedFactor);
            orangeCpa = Math.round(this.config.commercialOrangeCpaMeters * speedFactor);
            critTcpa = this.config.commercialCritTcpaMin;
            horizonTcpa = this.config.commercialHorizonTcpaMin;
        } else if (category === 'work') {
            redCpa = this.config.workRedCpaMeters;
            orangeCpa = this.config.workOrangeCpaMeters;
            critTcpa = this.config.workCritTcpaMin;
            horizonTcpa = this.config.workHorizonTcpaMin;
        }

        return { redCpa, orangeCpa, critTcpa, horizonTcpa };
    }

    _computeTrend(history) {
        if (!history || history.length < 2) {
            return { trend: 'STABLE', deltaCpaPerMin: 0.0 };
        }

        let first = history[0];
        let last = history[history.length - 1];
        let dtMinutes = (last.t - first.t) / 60000.0;

        if (dtMinutes < 0.15) {
            return { trend: 'STABLE', deltaCpaPerMin: 0.0 };
        }

        let dCpa = last.cpaNominalMeters - first.cpaNominalMeters;
        let deltaPerMin = dCpa / dtMinutes;

        let trend = 'STABLE';
        if (deltaPerMin < -100.0) {
            trend = 'WORSENING'; // Bersaglio sta stringendo rotta o accelerando
        } else if (deltaPerMin > 100.0) {
            trend = 'IMPROVING'; // Bersaglio sta accostando in apertura
        }

        return {
            trend,
            deltaCpaPerMin: Math.round(deltaPerMin)
        };
    }

    evaluateTarget(ownShip, target, now = Date.now()) {
        let targetId = target.mmsi || target.id || target.name;
        if (!targetId) return null;

        let category = this._resolveVesselCategory(target);
        let ownHull = getHullBoundingRadius(ownShip, 'sailing');
        let targetHull = getHullBoundingRadius(target, category);

        let uncertainty = calculateUncertaintyCone(target, now);
        let kinematics = computeCpaTcpa(ownShip, target, uncertainty);

        // Dominio ellittico orientato (A3) lungo la direttrice di CPA
        let ownHdg = (ownShip.hdg !== undefined && ownShip.hdg !== null) ? ownShip.hdg : (ownShip.cog || 0);
        let targetHdg = (target.hdg !== undefined && target.hdg !== null) ? target.hdg : (target.cog || 0);
        let cpaBearingFromOwn = kinematics.cpaBearingDeg;
        let cpaBearingFromTarget = (cpaBearingFromOwn + 180) % 360;
        let ownMargin = getHullEllipticalMargin(ownHull, ownHdg, cpaBearingFromOwn);
        let targetMargin = getHullEllipticalMargin(targetHull, targetHdg, cpaBearingFromTarget);
        let totalHullMargin = Math.round(ownMargin + targetMargin);

        // Calcolo CPA al netto delle dimensioni ellittiche degli scafi (interi in metri)
        let netCpaNominal = Math.round(Math.max(0, kinematics.cpaNominalMeters - totalHullMargin));
        let netCpaMin = Math.round(Math.max(0, kinematics.cpaMinMeters - totalHullMargin));
        let netCpaMax = Math.round(Math.max(0, kinematics.cpaMaxMeters - totalHullMargin));

        let thresholds = this._resolveThresholds(target, category);

        // 1. Valutazione istantanea grezza delle soglie (solo se almeno uno dei due è in movimento)
        let rawState = 'NO_DANGER';
        let rawIsDeferred = false;
        let reason = '';

        let ownIsMoving = (ownShip.sog || 0) >= 0.8;
        let targetIsMoving = (target.sog || 0) >= 0.8;
        let eitherMoving = ownIsMoving || targetIsMoving;

        let tcpa = kinematics.tcpaMinutes;
        let isMovingThreat = eitherMoving && !kinematics.isDiverging && tcpa > 0;

        if (isMovingThreat) {
            if (netCpaNominal <= thresholds.redCpa && tcpa <= thresholds.critTcpa) {
                rawState = 'RED';
                reason = targetIsMoving ? 'RISCHIO COLLISIONE!' : 'ATTENZIONE OSTACOLO';
            } else if (
                (netCpaMin <= thresholds.redCpa && tcpa <= thresholds.critTcpa) ||
                (netCpaNominal <= thresholds.orangeCpa && tcpa <= thresholds.horizonTcpa) ||
                (netCpaMin <= thresholds.orangeCpa && tcpa <= thresholds.horizonTcpa)
            ) {
                rawState = 'ORANGE';
                reason = targetIsMoving ? 'ATTENZIONE INCROCIO' : 'ATTENZIONE OSTACOLO';
            }
        }

        // 2. Qualifica di Differibilità
        if (rawState !== 'NO_DANGER') {
            let thresholdViolated = rawState === 'RED' ? thresholds.redCpa : thresholds.orangeCpa;
            let triggeredOnlyByUncertainty = (netCpaNominal > thresholdViolated) && (netCpaMin <= thresholdViolated);
            let farInTime = tcpa > (this.config.kDefer * thresholds.horizonTcpa);
            let farInDistance = kinematics.rangeMeters > this.config.minRangeDeferMeters;

            if (triggeredOnlyByUncertainty && farInTime && farInDistance) {
                rawIsDeferred = true;
            }
        }

        // 3. Macchina a Stati con Isteresi Asimmetrica e Tracking Storico
        let state = this.targetStates.get(targetId);
        if (!state) {
            state = {
                id: targetId,
                currentState: rawState,
                isDeferred: rawIsDeferred,
                reason: reason,
                history: [],
                deescalateCandidate: null,
                deescalateTimerStartedAt: 0,
                lastSeen: now
            };
            this.targetStates.set(targetId, state);
        }

        state.lastSeen = now;

        // Aggiorna buffer storico con debounce di 5s (compatibile sia con loop 1Hz che 15s)
        let lastHist = state.history[state.history.length - 1];
        if (!lastHist || (now - lastHist.t) >= 5000) {
            state.history.push({
                t: now,
                cpaNominalMeters: netCpaNominal,
                cpaMinMeters: netCpaMin,
                tcpaMinutes: tcpa,
                rangeMeters: kinematics.rangeMeters
            });
            if (state.history.length > 6) {
                state.history.shift();
            }
        }

        let { trend, deltaCpaPerMin } = this._computeTrend(state.history);

        // Se l'allarme era differibile ma il trend mostra un rapido peggioramento, revoca la differibilità
        if (rawIsDeferred && trend === 'WORSENING') {
            rawIsDeferred = false;
        }

        let currSev = SEVERITY_LEVELS[state.currentState];
        let rawSev = SEVERITY_LEVELS[rawState];

        if (rawSev > currSev) {
            // ESCALATION ISTANTANEA (0 secondi di ritardo)
            state.currentState = rawState;
            state.isDeferred = rawIsDeferred;
            state.reason = reason;
            state.deescalateCandidate = null;
            state.deescalateTimerStartedAt = 0;
        } else if (rawSev < currSev) {
            // DE-ESCALATION CON ISTERESI SPAZIALE E TEMPORALE
            let activeThreshold = state.currentState === 'RED' ? thresholds.redCpa : thresholds.orangeCpa;
            let safeDeadbandSatisfied = netCpaNominal > (activeThreshold + this.config.deadbandMeters);
            let minDivergingClearDist = Math.max(35, totalHullMargin + 20);
            let isSafelyDiverging = kinematics.isDiverging && kinematics.rangeMeters > minDivergingClearDist;

            if (safeDeadbandSatisfied || isSafelyDiverging) {
                if (state.deescalateCandidate !== rawState) {
                    state.deescalateCandidate = rawState;
                    state.deescalateTimerStartedAt = now;
                } else {
                    let holdDuration = now - state.deescalateTimerStartedAt;
                    let requiredHold = isSafelyDiverging ? 3000 : (trend === 'IMPROVING' ? 4000 : this.config.deescalateHoldTimeMs);
                    if (holdDuration >= requiredHold) {
                        // Timer scaduto: transizione confermata
                        state.currentState = rawState;
                        state.isDeferred = rawIsDeferred;
                        state.reason = reason;
                        state.deescalateCandidate = null;
                        state.deescalateTimerStartedAt = 0;
                    }
                }
            } else {
                // Condizione di sicurezza non sufficiente (all'interno della banda morta)
                state.deescalateCandidate = null;
                state.deescalateTimerStartedAt = 0;
            }
        } else {
            // Stesso livello di gravità: aggiorna solo il flag differibile e il motivo
            state.isDeferred = rawIsDeferred;
            state.reason = reason;
            state.deescalateCandidate = null;
            state.deescalateTimerStartedAt = 0;
        }

        return {
            targetId,
            mmsi: target.mmsi,
            name: target.name || `MMSI ${target.mmsi || 'N/A'}`,
            category,
            // Stato filtrato dalla macchina a stati
            alertState: state.currentState,
            isDeferred: state.isDeferred,
            trend,
            deltaCpaPerMin,
            // Metriche geometriche e cinematiche (interi in metri e secondi)
            rangeMeters: kinematics.rangeMeters,
            rangeNM: kinematics.rangeNM,
            bearingNowDeg: kinematics.bearingNowDeg,
            cpaNominalMeters: netCpaNominal,
            cpaMinMeters: netCpaMin,
            cpaMaxMeters: netCpaMax,
            tcpaSeconds: kinematics.tcpaSeconds,
            tcpaMinutes: kinematics.tcpaMinutes,
            isDiverging: kinematics.isDiverging,
            // Dettagli diagnostici incertezza e scafo
            hullMarginMeters: totalHullMargin,
            uncertaintyConeDeg: uncertainty.halfConeDeg * 2,
            reason: state.reason || ''
        };
    }

    evaluateBatch(ownShip, targetsList, now = Date.now()) {
        if (!ownShip || !Array.isArray(targetsList)) {
            return { targets: [], topThreat: null, summary: { red: 0, orange: 0, noDanger: 0, total: 0 } };
        }

        let evaluated = [];
        let redCount = 0;
        let orangeCount = 0;
        let noDangerCount = 0;

        for (let i = 0; i < targetsList.length; i++) {
            let res = this.evaluateTarget(ownShip, targetsList[i], now);
            if (!res) continue;
            evaluated.push(res);
            if (res.alertState === 'RED') redCount++;
            else if (res.alertState === 'ORANGE') orangeCount++;
            else noDangerCount++;
        }

        evaluated.sort((a, b) => {
            let sevA = SEVERITY_LEVELS[a.alertState] || 0;
            let sevB = SEVERITY_LEVELS[b.alertState] || 0;
            let nonDefA = (sevA > 0 && !a.isDeferred) ? 1 : 0;
            let nonDefB = (sevB > 0 && !b.isDeferred) ? 1 : 0;
            if (nonDefA !== nonDefB) return nonDefB - nonDefA;
            if (sevA !== sevB) return sevB - sevA;
            if (sevA > 0) {
                let tcpaA = a.tcpaMinutes > 0 ? a.tcpaMinutes : 999;
                let tcpaB = b.tcpaMinutes > 0 ? b.tcpaMinutes : 999;
                let scoreA = a.cpaNominalMeters + (tcpaA * 60);
                let scoreB = b.cpaNominalMeters + (tcpaB * 60);
                if (Math.abs(scoreA - scoreB) > 10) return scoreA - scoreB;
                return a.cpaNominalMeters - b.cpaNominalMeters;
            }
            return a.rangeMeters - b.rangeMeters;
        });

        let topThreat = (evaluated.length > 0 && (SEVERITY_LEVELS[evaluated[0].alertState] || 0) > 0) ? evaluated[0] : null;
        this.pruneInactive(now);

        return {
            targets: evaluated,
            topThreat,
            summary: { red: redCount, orange: orangeCount, noDanger: noDangerCount, total: evaluated.length }
        };
    }

    pruneInactive(now = Date.now()) {
        for (let [id, state] of this.targetStates.entries()) {
            if ((now - state.lastSeen) > this.config.maxTargetMemoryMs) {
                this.targetStates.delete(id);
            }
        }
    }
}

const _pipelineExports = {
    CollisionPipeline,
    getHullBoundingRadius,
    getHullEllipticalMargin,
    calculateUncertaintyCone,
    computeCpaTcpa,
    solveRelativeKinematics
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _pipelineExports;
}
if (typeof globalThis !== 'undefined') {
    globalThis.RotevistaCollisionPipeline = _pipelineExports;
}

