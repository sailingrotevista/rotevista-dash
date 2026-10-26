/**
 * ==========================================================================
 * Rotevista Dash - Harbor & Mooring Detection Engine
 * ==========================================================================
 * Aree locali di sosta provvisoria, porto e ancoraggio dai fix osservati.
 * Usa i pattern del tracker, conserva punti appresi con memoria limitata
 * e costruisce i perimetri senza consultare dati geografici terra/acqua.
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

// All distances are metres. Keep area learning independent of own-ship speed.
const HARBOR_DETECTOR_CONFIG = {
    learningRangeMeters: 3704,
    pruneRangeMeters: 46300,
    ordinaryLinkMeters: 45,
    fixedLinkMeters: 95,
    largeLinkMeters: 90,
    pontoonTouchMeters: 20,
    portExpansionMeters: 120,
    portMergeBoundaryMeters: 200,
    // Strong independent mooring evidence; never increased recursively by membership.
    confidentPortLinkMeters: 120,
    confidentPortExpansionMeters: 180,
    anchorageLinkMeters: 180,
    anchorageMaxVesselLengthMeters: 40,
    minimumProvisionalMembers: 3,
    minimumPatternMembers: 2,
    patternMajority: 0.6,
    berthDeduplicationMeters: 10,
    hullPaddingMeters: 18,
    maximumObservedSwingMeters: 80,
    maximumLearnedPoints: 600,
};

function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// Local metric projection: shortest distance between convex area boundaries.
function polygonDistanceMeters(a, b) {
    if (!a.length || !b.length) return Infinity;
    if (pointInPolygon(...a[0], b) || pointInPolygon(...b[0], a)) return 0;
    const lat = a[0][0], lon = a[0][1], cos = Math.cos(lat * Math.PI / 180);
    const project = p => [(p[1] - lon) * 111139 * cos, (p[0] - lat) * 111139];
    const aa = a.map(project), bb = b.map(project);
    const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const pointSegment = (p,a,b) => {
        const dx=b[0]-a[0], dy=b[1]-a[1], den=dx*dx+dy*dy;
        const t=den ? Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)) : 0;
        return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
    };
    let best=Infinity;
    for (let i=0;i<aa.length;i++) for(let j=0;j<bb.length;j++) {
        const p=aa[i],q=aa[(i+1)%aa.length],r=bb[j],t=bb[(j+1)%bb.length];
        const distance=Math.min(pointSegment(p,r,t),pointSegment(q,r,t),pointSegment(r,p,q),pointSegment(t,p,q));
        if (distance < 1e-7 || (cross(p,q,r)*cross(p,q,t)<0 && cross(r,t,p)*cross(r,t,q)<0)) return 0;
        best=Math.min(best,distance);
    }
    return best;
}

// Shared read-only lookup for the detector and dev sessions consuming its polygons.
function getAreaAtPositionFromAreas(lat, lon, areas = [], evaluatedAt = null) {
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    const matches = areas.filter(area => Array.isArray(area?.hull) && area.hull.length >= 3 &&
        area.hull.every(point => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite)) &&
        (pointInPolygon(lat, lon, area.hull) || polygonDistanceMeters([[lat, lon]], area.hull) <= 1e-7));
    // Overlap does not imply a preference for PORT: choose the nearest area
    // centre, then its id for a deterministic tie. Edges count as inside.
    matches.sort((a, b) => distanceMeters(lat, lon, a.lat, a.lon) - distanceMeters(lat, lon, b.lat, b.lon) ||
        a.id.localeCompare(b.id));
    const area = matches[0];
    return area ? { id: area.id, kind: area.kind, evaluatedAt: area.evaluatedAt ?? evaluatedAt } : null;
}

class HarborDetector {
    constructor(config = {}) {
        this.config = { ...HARBOR_DETECTOR_CONFIG, ...config };
        this.knownHarbors = {};
        this.vesselStatTimes = {};
        this.nextAreaId = 1;
        this.areaLookupSnapshot = [];
    }

    // Read only the polygons from the last completed detection pass. This query
    // never learns, expands, prunes or changes a vessel's classification.
    getAreaAtPosition(lat, lon) {
        return getAreaAtPositionFromAreas(lat, lon, this.areaLookupSnapshot);
    }

    isStationary(v) {
        return v.motionState ? v.motionState !== 'MOVING' : !v.isMoving && (v.sog < 0.8 || v.isAnchored || v.isMoored);
    }

    evidence(v) {
        // Prefer actual reported status over flags assigned by a previous area.
        const reported = v.reportedNavigationState;
        const text = String(reported ?? '').toLowerCase();
        const anchored = reported !== undefined ? text.includes('anchor') || text === '1' : Boolean(v.isAnchored);
        const moored = reported !== undefined ? text.includes('moored') || text === '5' : Boolean(v.isMoored);
        return {
            confirmed: Boolean(v.restPattern?.confirmed),
            fixed: v.restPattern?.confirmed && v.restPattern.kind === 'FIXED',
            oscillating: v.restPattern?.confirmed && v.restPattern.kind === 'OSCILLATING',
            anchored, moored,
            windMoored: Boolean(v.restPattern?.confirmed && v.restPattern?.windMooring?.supported),
            confidentMoored: Boolean(v.restPattern?.confirmed &&
                ((reported !== undefined && moored) || v.restPattern?.windMooring?.strong)),
        };
    }

    location(v) {
        const center = v.restPattern?.confirmed && v.restPattern.center;
        return center && Number.isFinite(center.lat) && Number.isFinite(center.lon) ? center : v;
    }

    compatible(kind, v) {
        const e = this.evidence(v);
        if (kind !== 'PORT' && (v.length || 12) > this.config.anchorageMaxVesselLengthMeters) return false;
        return kind !== 'PORT' || !(e.oscillating || e.anchored);
    }

    classify(members, compact) {
        const cfg = this.config;
        const evidence = members.map(v => this.evidence(v));
        const count = predicate => evidence.filter(predicate).length;
        const anchors = count(e => e.anchored || e.oscillating);
        const fixed = count(e => e.fixed || e.windMoored);
        if (anchors >= cfg.minimumPatternMembers && anchors / members.length >= cfg.patternMajority) return 'ANCHORAGE';
        if (count(e => e.moored) > 0 ||
            (compact && fixed >= cfg.minimumPatternMembers && fixed / members.length >= cfg.patternMajority)) return 'PORT';
        if (compact) {
            for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
                if (distanceMeters(members[i].lat, members[i].lon, members[j].lat, members[j].lon) <= cfg.pontoonTouchMeters) return 'PORT';
            }
        }
        if (members.length >= cfg.minimumProvisionalMembers && count(e => e.confirmed || e.anchored) >= cfg.minimumProvisionalMembers) return 'PROVISIONAL';
        return null;
    }

    groups(candidates, linkDistance) {
        const visited = new Set(), groups = [];
        for (const root of candidates) {
            if (visited.has(root.id)) continue;
            const queue = [root], members = [];
            visited.add(root.id);
            for (let head = 0; head < queue.length; head++) {
                const current = queue[head];
                members.push(current);
                const a = this.location(current);
                for (const neighbor of candidates) {
                    if (visited.has(neighbor.id)) continue;
                    const b = this.location(neighbor);
                    if (distanceMeters(a.lat, a.lon, b.lat, b.lon) <= linkDistance(current, neighbor)) {
                        visited.add(neighbor.id);
                        queue.push(neighbor);
                    }
                }
            }
            groups.push(members);
        }
        return groups;
    }

    addPoint(area, vessel) {
        const cfg = this.config, p = this.location(vessel);
        const radius = Math.min(cfg.maximumObservedSwingMeters, Math.max(0, vessel.restPattern?.radiusMeters || 0));
        if (!area.memberIds.has(vessel.id) && area.memberIds.size >= cfg.maximumLearnedPoints) return;
        const existing = area.berths.find(b => distanceMeters(b.lat, b.lon, p.lat, p.lon) < cfg.berthDeduplicationMeters);
        if (existing) {
            existing.sources.set(vessel.id, radius);
            existing.radius = Math.max(...existing.sources.values());
        } else if (area.berths.length < cfg.maximumLearnedPoints) {
            area.berths.push({ lat: p.lat, lon: p.lon, radius, sources: new Map([[vessel.id, radius]]) });
        } else return;
        area.memberIds.add(vessel.id);
    }

    removeContribution(area, id) {
        for (const berth of area.berths) {
            berth.sources.delete(id);
            berth.radius = berth.sources.size ? Math.max(...berth.sources.values()) : 0;
        }
        area.berths = area.berths.filter(b => b.sources.size);
        area.memberIds.delete(id);
    }

    hull(area) {
        const cfg = this.config, points = [];
        for (const p of area.berths) {
            const radius = cfg.hullPaddingMeters + (area.kind === 'ANCHORAGE' ? p.radius || 0 : 0);
            const cos = Math.cos(p.lat * Math.PI / 180) || 1;
            for (let i = 0; i < 8; i++) {
                const angle = i * Math.PI / 4;
                points.push([p.lat + radius * Math.cos(angle) / 111139, p.lon + radius * Math.sin(angle) / (111139 * cos)]);
            }
        }
        return computeConvexHull(points);
    }

    processHarbors(nearbyVessels, myGps, raw, trueWindDir, now) {
        const cfg = this.config, areas = this.knownHarbors;
        for (const [id, area] of Object.entries(areas)) {
            if (distanceMeters(myGps.lat, myGps.lon, area.lat, area.lon) > cfg.pruneRangeMeters) delete areas[id];
        }
        const activeIds = new Set(nearbyVessels.map(v => v.id));
        for (const id of Object.keys(this.vesselStatTimes)) if (!activeIds.has(id)) delete this.vesselStatTimes[id];
        for (const v of nearbyVessels) {
            v.inCluster = false;
            v.clusterId = null;
            delete v.areaKind;
            const evidence = this.evidence(v);
            if (evidence.anchored || evidence.oscillating) {
                v.isMoored = false;
                v.isAnchored = !v.isMoving;
                if (!v.isMoving && v.anchorState !== 'ANCHOR_DRAGGING') v.anchorState = 'ANCHORED';
                // Retract only this vessel's learned support; shared berths survive.
                for (const area of Object.values(areas)) if (area.kind === 'PORT') this.removeContribution(area, v.id);
            }
            if (this.isStationary(v)) this.vesselStatTimes[v.id] ??= v.stationarySince ?? v.lastPositionTime ?? now;
            else delete this.vesselStatTimes[v.id];
        }
        for (const [id, area] of Object.entries(areas)) if (!area.berths.length || area.memberIds.size < 2) delete areas[id];
        const candidates = nearbyVessels.filter(v => this.isStationary(v) && v.dist <= cfg.learningRangeMeters &&
            Number.isFinite(v.lat) && Number.isFinite(v.lon));
        // A roadstead of large anchored ships must not become a quiet yacht
        // anchorage merely through grouping. Actual fixed quays can still form ports.
        const learningCandidates = candidates.filter(v => {
            const e = this.evidence(v);
            return !((v.length || 12) > cfg.anchorageMaxVesselLengthMeters && (e.anchored || e.oscillating));
        });
        const compactGroups = this.groups(learningCandidates, (a, b) => {
            const ea = this.evidence(a), eb = this.evidence(b);
            const anchorA = ea.anchored || ea.oscillating, anchorB = eb.anchored || eb.oscillating;
            const small = Math.max(a.length || 12, b.length || 12) <= cfg.anchorageMaxVesselLengthMeters;
            if (small && anchorA && anchorB) return cfg.anchorageLinkMeters;
            if (anchorA !== anchorB) return -1;
            if (ea.confidentMoored && eb.confidentMoored && !anchorA && !anchorB) return cfg.confidentPortLinkMeters;
            if (ea.windMoored && eb.windMoored && !anchorA && !anchorB) return cfg.portExpansionMeters;
            if (ea.fixed && eb.fixed) return cfg.fixedLinkMeters;
            return Math.max(a.length || 12, b.length || 12) >= 20 ? cfg.largeLinkMeters : cfg.ordinaryLinkMeters;
        }).map(members => ({ members, kind: this.classify(members, true) })).filter(g => g.kind && g.members.length >= 2);
        const assigned = new Set(compactGroups.flatMap(g => g.members.map(v => v.id)));
        // Loose, observed small-vessel groups can be recognized provisionally
        // without demanding a moored status or a completed swing cycle.
        const loose = learningCandidates.filter(v => !assigned.has(v.id) && (v.length || 12) <= cfg.anchorageMaxVesselLengthMeters &&
            (this.evidence(v).confirmed || this.evidence(v).anchored));
        const groups = [...compactGroups, ...this.groups(loose, (a, b) => {
            const ea = this.evidence(a), eb = this.evidence(b);
            return Boolean(ea.anchored || ea.oscillating) === Boolean(eb.anchored || eb.oscillating) ? cfg.anchorageLinkMeters : -1;
        })
            .map(members => ({ members, kind: this.classify(members, false) })).filter(g => g.kind && g.members.length >= 2)];
        for (const group of groups) {
            const locations = group.members.map(v => this.location(v));
            let area = Object.values(areas).find(h => group.members.some(v => h.memberIds.has(v.id)) &&
                (h.kind === group.kind || h.kind === 'PROVISIONAL' || group.kind === 'PROVISIONAL' ||
                 group.members.filter(v => h.memberIds.has(v.id)).length / h.memberIds.size > 0.5));
            if (!area) area = Object.values(areas).find(h =>
                (h.kind === group.kind || h.kind === 'PROVISIONAL' || group.kind === 'PROVISIONAL') &&
                locations.some(p => h.berths.some(b => distanceMeters(p.lat, p.lon, b.lat, b.lon) <=
                    (h.kind === 'ANCHORAGE' && group.kind === 'ANCHORAGE' ? cfg.anchorageLinkMeters : cfg.portExpansionMeters))));
            if (!area) {
                const lat = locations.reduce((s, p) => s + p.lat, 0) / locations.length;
                const lon = locations.reduce((s, p) => s + p.lon, 0) / locations.length;
                const id = `port_${Math.round(lat * 1000)}_${Math.round(lon * 1000)}_${this.nextAreaId++}`;
                area = areas[id] = { id, lat, lon, kind: group.kind, berths: [], memberIds: new Set(), createdAt: now };
            }
            if (group.kind !== 'PROVISIONAL') area.kind = group.kind;
            area.lastSeen = now;
            for (const v of group.members) this.addPoint(area, v);
        }
        // Confirmed fixed observations can extend a port without first needing
        // to have been classified as moored by that very same port.
        for (const v of candidates) {
            const e = this.evidence(v);
            if ((!e.fixed && !e.moored && !e.windMoored) || e.anchored || e.oscillating) continue;
            const p = this.location(v);
            const expansion = e.confidentMoored ? cfg.confidentPortExpansionMeters : cfg.portExpansionMeters;
            const eligible = Object.values(areas).filter(h => h.kind === 'PORT' && h.berths.some(b => distanceMeters(p.lat, p.lon, b.lat, b.lon) <= expansion));
            eligible.sort((a, b) => Math.min(...a.berths.map(q => distanceMeters(p.lat, p.lon, q.lat, q.lon))) - Math.min(...b.berths.map(q => distanceMeters(p.lat, p.lon, q.lat, q.lon))));
            if (eligible[0]) this.addPoint(eligible[0], v);
        }
        // Merge confirmed ports by polygon gap, including internal channels.
        // Repeat to convergence so results do not depend on area insertion order.
        let merged;
        do {
            merged = false;
            const keys = Object.keys(areas);
            outer: for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
                const a = areas[keys[i]], b = areas[keys[j]];
                if (a.kind !== b.kind) continue;
                const touching = a.kind === 'PORT'
                    ? polygonDistanceMeters(this.hull(a), this.hull(b)) <= cfg.portMergeBoundaryMeters
                    : a.berths.some(p => b.berths.some(q => distanceMeters(p.lat, p.lon, q.lat, q.lon) <=
                        (a.kind === 'ANCHORAGE' ? cfg.anchorageLinkMeters : cfg.portExpansionMeters)));
                if (!touching) continue;
                // Preserve every contribution when merging deduplicated berths.
                if (a.berths.length + b.berths.length > cfg.maximumLearnedPoints ||
                    new Set([...a.memberIds, ...b.memberIds]).size > cfg.maximumLearnedPoints) continue;
                for (const p of b.berths) {
                    const existing = a.berths.find(q => distanceMeters(p.lat,p.lon,q.lat,q.lon) < cfg.berthDeduplicationMeters);
                    if (existing) {
                        for (const [id, radius] of p.sources) existing.sources.set(id, Math.max(existing.sources.get(id) || 0, radius));
                        existing.radius = Math.max(...existing.sources.values());
                    } else a.berths.push(p);
                }
                for (const id of b.memberIds) a.memberIds.add(id);
                delete areas[b.id];
                merged = true;
                break outer;
            }
        } while (merged);
        const geometries = Object.values(areas).map(area => {
            area.lat = area.berths.reduce((s, p) => s + p.lat, 0) / area.berths.length;
            area.lon = area.berths.reduce((s, p) => s + p.lon, 0) / area.berths.length;
            return { area, hull: this.hull(area), members: [] };
        });
        for (const v of candidates) {
            const p = this.location(v);
            const matches = geometries.filter(({ area, hull }) => this.compatible(area.kind, v) &&
                (pointInPolygon(v.lat, v.lon, hull) || area.berths.some(b => distanceMeters(p.lat, p.lon, b.lat, b.lon) <= cfg.ordinaryLinkMeters + (area.kind === 'ANCHORAGE' ? b.radius || 0 : 0))));
            matches.sort((a, b) => Math.min(...a.area.berths.map(q => distanceMeters(p.lat, p.lon, q.lat, q.lon))) - Math.min(...b.area.berths.map(q => distanceMeters(p.lat, p.lon, q.lat, q.lon))));
            if (!matches.length) continue;
            const match = matches[0], area = match.area;
            v.inCluster = true;
            v.clusterId = area.id;
            v.areaKind = area.kind;
            if (v.anchorState !== 'ANCHOR_DRAGGING') {
                if (area.kind === 'PORT') { v.isMoored = true; v.isAnchored = false; v.anchorState = 'MOORED'; }
                else if (area.kind === 'ANCHORAGE') { v.isMoored = false; v.isAnchored = true; v.anchorState = 'ANCHORED'; }
            }
            match.members.push(v);
        }
        const clusters = geometries.filter(g => g.area.memberIds.size >= 2 && g.members.length).map(({ area, hull, members }) => {
            const flags = {};
            for (const v of members) { const flag = v.flag ? v.flag.split(' ')[0] : '🏳️'; flags[flag] = (flags[flag] || 0) + 1; }
            return { id: area.id, kind: area.kind, lat: area.lat, lon: area.lon, center: [area.lat, area.lon],
                dist: Math.round(distanceMeters(myGps.lat, myGps.lon, area.lat, area.lon)), count: members.length, hull, flags };
        });
        this.areaLookupSnapshot = clusters.map(area => ({ id: area.id, kind: area.kind, lat: area.lat, lon: area.lon,
            evaluatedAt: now, hull: area.hull.map(point => [...point]) }));
        return clusters;
    }
}

module.exports = { HarborDetector, HARBOR_DETECTOR_CONFIG, computeConvexHull, pointInPolygon, polygonDistanceMeters, getAreaAtPositionFromAreas };
