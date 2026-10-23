/**
 * ==========================================================================
 * Rotevista Dash - Harbor & Mooring Detection Engine
 * ==========================================================================
 * Gestisce l'auto-apprendimento cumulativo dei porti, il rilevamento
 * d'ormeggio da prua/vento, il clustering di banchine/pontili e il calcolo
 * del perimetro Convex Hull con padding ±18m.
 * file harborDetector.js
 */

function distanceMeters(lat1, lon1, lat2, lon2) {
    const latMed = (lat1 + lat2) / 2 * Math.PI / 180;
    const dx = (lon2 - lon1) * 111139 * Math.cos(latMed);
    const dy = (lat2 - lat1) * 111139;
    return Math.sqrt(dx * dx + dy * dy);
}

function computeConvexHull(points) {
    if (!points || points.length < 3) return points;
    let sorted = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
    let cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let lower = [];
    for (let i = 0; i < sorted.length; i++) {
        let p = sorted[i];
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    let upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        let p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

class HarborDetector {
    constructor() {
        this.knownHarbors = {};    // Banchine e porti auto-appresi
        this.vesselStatTimes = {}; // Registro durata stazionamento scafi
        this.vesselHdgHist = {};   // Storico prua bersagli per rilevamento ormeggio
    }

    /**
     * processHarbors: Esegue i passi 7.1 - 7.7 di auto-apprendimento porti e ormeggi.
     * Mantiene intatte tutte le regole, soglie e mutazioni sugli oggetti di nearbyVessels.
     */
    processHarbors(nearbyVessels, myGps, raw, trueWindDir, now) {
        const knownHarbors = this.knownHarbors;
        const vesselStatTimes = this.vesselStatTimes;
        const vesselHdgHist = this.vesselHdgHist;

        // 7. Auto-Apprendimento Cumulativo Porti (Geometria Permanente + Padding 18m)
        // 7.1 Geographic Pruning: elimina porti quando la nostra barca supera 25 NM (46300m)
        for (let hId in knownHarbors) {
            let h = knownHarbors[hId];
            if (distanceMeters(myGps.lat, myGps.lon, h.lat, h.lon) > 46300) {
                delete knownHarbors[hId];
            }
        }

        // 7.2 Tracciamento durata stazionamento scafi e rilevamento ormeggio da Prua e Vento
        let curWindSpeed = 0;
        if (raw['environment.wind.speedTrue'] !== undefined) {
            curWindSpeed = raw['environment.wind.speedTrue'] * 1.94384;
        } else if (raw['environment.wind.speedApparent'] !== undefined) {
            curWindSpeed = raw['environment.wind.speedApparent'] * 1.94384;
        }

        for (let idx = 0; idx < nearbyVessels.length; idx++) {
            let v = nearbyVessels[idx];
            if (v.sog < 0.5) {
                if (!vesselStatTimes[v.id]) vesselStatTimes[v.id] = now;
                if (!vesselHdgHist[v.id]) vesselHdgHist[v.id] = [];
                let hList = vesselHdgHist[v.id];
                hList.push({ t: now, cog: v.cog });

                while (hList.length > 0 && (now - hList[0].t) > 900000) {
                    hList.shift();
                }

                if (hList.length >= 6 && (now - hList[0].t) >= 240000 && curWindSpeed >= 4.0) {
                    let sorted = [];
                    for (let hIdx = 0; hIdx < hList.length; hIdx++) sorted.push(hList[hIdx].cog);
                    sorted.sort((a, b) => a - b);

                    let maxGap = 360 - (sorted[sorted.length - 1] - sorted[0]);
                    for (let g = 0; g < sorted.length - 1; g++) {
                        let gap = sorted[g + 1] - sorted[g];
                        if (gap > maxGap) maxGap = gap;
                    }
                    let deltaCog = 360 - maxGap;

                    let windDev = 0;
                    if (trueWindDir !== undefined && !isNaN(trueWindDir) && v.cog != null) {
                        let diff = Math.abs(v.cog - trueWindDir) % 360;
                        windDev = diff > 180 ? 360 - diff : diff;
                    }

                    if (deltaCog <= 8.0 && windDev >= 35.0) {
                        v.isMoored = true;
                        v.anchorState = 'MOORED';
                    }
                }
            } else {
                delete vesselStatTimes[v.id];
                delete vesselHdgHist[v.id];
            }
        }

        // 7.3 Rilevamento candidati pontile (45m standard, 90m per grandi scafi >= 20m)
        let staticCandidates = nearbyVessels.filter(v => (v.sog < 0.8 || v.isAnchored || v.isMoored) && v.dist <= 3704);
        let visited = new Set();
        let instantClusters = [];

        for (let i = 0; i < staticCandidates.length; i++) {
            let root = staticCandidates[i];
            if (visited.has(root.id)) continue;

            let queue = [root];
            visited.add(root.id);
            let clusterMembers = [];

            while (queue.length > 0) {
                let curr = queue.shift();
                clusterMembers.push(curr);

                for (let j = 0; j < staticCandidates.length; j++) {
                    let neighbor = staticCandidates[j];
                    if (!visited.has(neighbor.id)) {
                        let d = distanceMeters(curr.lat, curr.lon, neighbor.lat, neighbor.lon);
                        let refLen = Math.max(curr.length || 12, neighbor.length || 12);
                        let isLarge = refLen >= 20;
                        let dynamicEpsilon = (isLarge && (curr.isMoored || neighbor.isMoored || curr.sog < 0.3)) ? 90.0 : 45.0;

                        if (d <= dynamicEpsilon) {
                            visited.add(neighbor.id);
                            queue.push(neighbor);
                        }
                    }
                }
            }

            if (clusterMembers.length >= 2) {
                let hasMooredSeed = false;
                let hasPontoonTouchSeed = false;
                let hasRigidQuaySeed = false;

                for (let k = 0; k < clusterMembers.length; k++) {
                    if (clusterMembers[k].isMoored) {
                        hasMooredSeed = true;
                        break;
                    }
                }

                for (let a = 0; a < clusterMembers.length; a++) {
                    for (let b = a + 1; b < clusterMembers.length; b++) {
                        let mA = clusterMembers[a];
                        let mB = clusterMembers[b];
                        let d = distanceMeters(mA.lat, mA.lon, mB.lat, mB.lon);
                        if (d <= 20.0) hasPontoonTouchSeed = true;
                        if (d <= 45.0 && (mA.isMoored || mB.isMoored)) hasRigidQuaySeed = true;
                    }
                    if (hasPontoonTouchSeed || hasRigidQuaySeed) break;
                }

                let isValid = (clusterMembers.length >= 3 && (hasMooredSeed || hasPontoonTouchSeed || hasRigidQuaySeed)) ||
                              (clusterMembers.length >= 2 && (hasPontoonTouchSeed || hasRigidQuaySeed));

                if (isValid) {
                    let sLat = 0, sLon = 0;
                    for (let k = 0; k < clusterMembers.length; k++) {
                        sLat += clusterMembers[k].lat;
                        sLon += clusterMembers[k].lon;
                    }
                    instantClusters.push({
                        cLat: sLat / clusterMembers.length,
                        cLon: sLon / clusterMembers.length,
                        members: clusterMembers
                    });
                }
            }
        }

        // 7.4 Stabilizzazione ID e accumulo posti barca permanenti (berths)
        for (let ic = 0; ic < instantClusters.length; ic++) {
            let grp = instantClusters[ic];
            let matchedId = null;

            for (let hId in knownHarbors) {
                let pBerths = knownHarbors[hId].berths;
                let touchesHarbor = false;

                for (let m = 0; m < grp.members.length; m++) {
                    let mb = grp.members[m];
                    for (let b = 0; b < pBerths.length; b++) {
                        let pb = pBerths[b];
                        if (Math.abs(pb.lat - mb.lat) < 0.0010 && Math.abs(pb.lon - mb.lon) < 0.0012) {
                            if (distanceMeters(pb.lat, pb.lon, mb.lat, mb.lon) <= 95.0) {
                                touchesHarbor = true;
                                break;
                            }
                        }
                    }
                    if (touchesHarbor) break;
                }

                if (touchesHarbor) {
                    matchedId = hId;
                    break;
                }
            }

            if (!matchedId) {
                matchedId = `port_${Math.round(grp.cLat * 1000)}_${Math.round(grp.cLon * 1000)}`;
                knownHarbors[matchedId] = {
                    id: matchedId,
                    lat: grp.cLat,
                    lon: grp.cLon,
                    berths: [],
                    createdAt: now
                };
            }

            let portObj = knownHarbors[matchedId];
            portObj.lastSeen = now;

            for (let m = 0; m < grp.members.length; m++) {
                let mb = grp.members[m];
                let exists = false;
                for (let bIdx = 0; bIdx < portObj.berths.length; bIdx++) {
                    let b = portObj.berths[bIdx];
                    if (Math.abs(b.lat - mb.lat) < 0.00015 && Math.abs(b.lon - mb.lon) < 0.0002) {
                        if (distanceMeters(b.lat, b.lon, mb.lat, mb.lon) < 10.0) {
                            exists = true;
                            break;
                        }
                    }
                }
                if (!exists) {
                    portObj.berths.push({ lat: mb.lat, lon: mb.lon });
                }
            }
        }

        // 7.5 Annessione posti barca ormeggiati nello stesso bacino portuale (<= 95m)
        const ONE_HOUR_MS = 3600000;
        for (let idx = 0; idx < staticCandidates.length; idx++) {
            let sc = staticCandidates[idx];
            let statStart = vesselStatTimes[sc.id] || now;
            if (sc.isMoored && ((now - statStart) >= ONE_HOUR_MS || sc.anchorState === 'MOORED')) {
                for (let hId in knownHarbors) {
                    let pObj = knownHarbors[hId];
                    let isNearPortBerth = false;
                    let alreadyStored = false;

                    for (let bIdx = 0; bIdx < pObj.berths.length; bIdx++) {
                        let b = pObj.berths[bIdx];
                        if (Math.abs(b.lat - sc.lat) < 0.0010 && Math.abs(b.lon - sc.lon) < 0.0012) {
                            let d = distanceMeters(b.lat, b.lon, sc.lat, sc.lon);
                            if (d < 10.0) alreadyStored = true;
                            if (d <= 95.0) isNearPortBerth = true;
                            if (alreadyStored) break;
                        }
                    }

                    if (isNearPortBerth && !alreadyStored) {
                        pObj.berths.push({ lat: sc.lat, lon: sc.lon });
                    }
                }
            }
        }

        // 7.6 Fusione organica tra banchine/pontili contigui dello stesso porto (<= 95m)
        let harborKeys = Object.keys(knownHarbors);
        for (let i = 0; i < harborKeys.length; i++) {
            let idA = harborKeys[i];
            if (!knownHarbors[idA]) continue;

            for (let j = i + 1; j < harborKeys.length; j++) {
                let idB = harborKeys[j];
                if (!knownHarbors[idB]) continue;

                let berthsTouch = false;
                let bA = knownHarbors[idA].berths;
                let bB = knownHarbors[idB].berths;

                for (let a = 0; a < bA.length; a++) {
                    for (let b = 0; b < bB.length; b++) {
                        if (Math.abs(bA[a].lat - bB[b].lat) < 0.0010 && Math.abs(bA[a].lon - bB[b].lon) < 0.0012) {
                            if (distanceMeters(bA[a].lat, bA[a].lon, bB[b].lat, bB[b].lon) <= 95.0) {
                                berthsTouch = true;
                                break;
                            }
                        }
                    }
                    if (berthsTouch) break;
                }

                if (berthsTouch) {
                    for (let b = 0; b < bB.length; b++) {
                        let mb = bB[b];
                        let dup = false;
                        for (let a = 0; a < bA.length; a++) {
                            if (distanceMeters(bA[a].lat, bA[a].lon, mb.lat, mb.lon) < 10.0) {
                                dup = true;
                                break;
                            }
                        }
                        if (!dup) bA.push(mb);
                    }
                    delete knownHarbors[idB];
                }
            }
        }

        // 7.7 Assegnazione appartenenza al porto e calcolo Convex Hull con padding ±18m
        let harborClusters = [];
        for (let hId in knownHarbors) {
            let pObj = knownHarbors[hId];
            let portVessels = [];
            let flagStats = {};

            if (pObj.berths.length > 0) {
                let sLat = 0, sLon = 0;
                for (let bIdx = 0; bIdx < pObj.berths.length; bIdx++) {
                    sLat += pObj.berths[bIdx].lat;
                    sLon += pObj.berths[bIdx].lon;
                }
                pObj.lat = sLat / pObj.berths.length;
                pObj.lon = sLon / pObj.berths.length;
            }

            for (let idx = 0; idx < nearbyVessels.length; idx++) {
                let v = nearbyVessels[idx];
                let isStationary = (v.sog < 0.8 || v.isAnchored || v.isMoored);
                if (!isStationary) continue;

                let isInsidePort = false;
                for (let bIdx = 0; bIdx < pObj.berths.length; bIdx++) {
                    let b = pObj.berths[bIdx];
                    if (Math.abs(b.lat - v.lat) < 0.0006 && Math.abs(b.lon - v.lon) < 0.0008) {
                        if (distanceMeters(b.lat, b.lon, v.lat, v.lon) <= 45.0) {
                            isInsidePort = true;
                            break;
                        }
                    }
                }

                if (isInsidePort) {
                    v.inCluster = true;
                    v.clusterId = hId;
                    if (v.anchorState !== 'ANCHOR_DRAGGING' && v.sog < 0.8) {
                        v.isMoored = true;
                        v.isAnchored = false;
                        v.anchorState = 'MOORED';
                        v.swingRadius = null;
                        v.anchorCenter = null;
                    }
                    portVessels.push(v);
                    let fCode = v.flag ? v.flag.split(' ')[0] : "🏳️";
                    flagStats[fCode] = (flagStats[fCode] || 0) + 1;
                }
            }

            if (pObj.berths.length >= 2 && portVessels.length > 0) {
                let distToPort = distanceMeters(myGps.lat, myGps.lon, pObj.lat, pObj.lon);
                portVessels.sort((a, b) => a.dist - b.dist);

                let paddedPoints = [];
                for (let bIdx = 0; bIdx < pObj.berths.length; bIdx++) {
                    let b = pObj.berths[bIdx];
                    let cosLat = Math.cos(b.lat * Math.PI / 180) || 1;
                    let dLat = 18 / 111139;
                    let dLon = 18 / (111139 * cosLat);
                    paddedPoints.push([b.lat + dLat, b.lon]);
                    paddedPoints.push([b.lat - dLat, b.lon]);
                    paddedPoints.push([b.lat, b.lon + dLon]);
                    paddedPoints.push([b.lat, b.lon - dLon]);
                }
                let permanentHull = computeConvexHull(paddedPoints);

                harborClusters.push({
                    id: hId,
                    lat: pObj.lat,
                    lon: pObj.lon,
                    center: [pObj.lat, pObj.lon],
                    dist: Math.round(distToPort),
                    count: portVessels.length,
                    hull: permanentHull,
                    flags: flagStats
                });
            }
        }

        return harborClusters;
    }
}

module.exports = { HarborDetector, computeConvexHull };
