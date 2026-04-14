// ==========================================================================
// 1. CONFIGURAZIONE E DEFAULT
// ==========================================================================
let CONFIG = {
    alarms: { depthDanger: 2.5, depthWarning: 5.0 },
    averages: { smoothWindow: 2000, longWindow: 60000, stabilityTolerance: 2000, stabilityThreshold: 0.90, minSpeed: 0.5 },
    graphs: { reef1: 15.0, reef2: 20.0, historyMinutes: 5, samples: 60 },
    scales: { stw: { stdMax: 12, hercSpan: 4, step: 2 }, sog: { stdMax: 12, hercSpan: 4, step: 2 }, tws: { stdMax: 25, hercSpan: 10, step: 5 }, depth: { stdMax: 20, hercSpan: 10, step: 10 } },
    server: { fallbackIp: "192.168.111.240:3000" }
};

const RENDER_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5000;
const SIM_SAMPLE_INTERVAL = 1000;

// ==========================================================================
// 2. STATO GLOBALE E RIFERIMENTI UI
// ==========================================================================
let simulationMode = false;
let socket, renderInterval, simInterval;
let lastAvgUIUpdate = 0, audioCtx = null, lastAlarmTime = 0;
let curAwaRot = 0, curTwaRot = 0, curTrackRot = 0, curTwdRoseRot = 0;

// Variabili di stato per filtri e logica tattica
let smoothedLeeway = 0;
let rotationTrend = 0;
let lastShortAvgVal = null;
let lastInstantTwa = null;
let isNavigating = false;

let pressTimer, isFocusActive = false, blockNextClick = false;

const graphModes = {
    stw: localStorage.getItem('mode_stw') || 'standard',
    sog: localStorage.getItem('mode_sog') || 'standard',
    tws: localStorage.getItem('mode_tws') || 'standard',
    depth: localStorage.getItem('mode_depth') || 'standard'
};

const store = {
    raw: {}, timestamps: {},
    smoothBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [] },
    longBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [] },
    histories: { stw: [], sog: [], depth: [], tws: [] },
    lastUpdates: { stw: 0, sog: 0, depth: 0, tws: 0 }
};

const ui = {
    stw: document.getElementById('stw'), sog: document.getElementById('sog'),
    hdg: document.getElementById('hdg'), cog: document.getElementById('cog'),
    awsSvg: document.getElementById('aws-val-svg'), awa: document.getElementById('awa-pointer'),
    twa: document.getElementById('twa-pointer'), track: document.getElementById('track-pointer'),
    tws: document.getElementById('tws'), depth: document.getElementById('depth'),
    twaAvg: document.getElementById('twa-avg'), awaAvg: document.getElementById('awa-avg'),
    twdAvg: document.getElementById('twd-avg'), twdArrow: document.getElementById('twd-arrow'),
    twdBoat: document.getElementById('twd-boat-wrap'),
    twdChevron: document.getElementById('twd-wind-chevron'),
    leewayMask: document.getElementById('leeway-mask-rect'), leewayVal: document.getElementById('leeway-val'),
    tackHdg: document.getElementById('tack-hdg'), tackCog: document.getElementById('tack-cog'),
    status: document.getElementById('status'), hotspot: document.getElementById('fullscreen-hotspot')
};

// ==========================================================================
// 3. MATEMATICA E UTILS
// ==========================================================================
function radToDeg(rad) { return rad * (180 / Math.PI); }
function degToRad(deg) { return deg * (Math.PI / 180); }
function msToKts(ms) { return ms * 1.94384; }
function ktsToMs(kts) { return kts / 1.94384; }
function getShortestRotation(curr, target) { let diff = (target - curr) % 360; if (diff > 180) diff -= 360; else if (diff < -180) diff += 360; return curr + diff; }

function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false) {
    const now = Date.now(); const validData = bufferArray.filter(item => (now - item.time) <= windowMs);
    if (validData.length === 0) return null;
    let sSin = 0, sCos = 0; validData.forEach(item => { sSin += Math.sin(item.val); sCos += Math.cos(item.val); });
    let R = Math.sqrt(sSin * sSin + sCos * sCos) / validData.length;
    let isStable = (validData.length > 2) && (validData[validData.length - 1].time - validData[0].time >= windowMs - CONFIG.averages.stabilityTolerance) && (R > CONFIG.averages.stabilityThreshold);
    let avgDeg = Math.round(radToDeg(Math.atan2(sSin, sCos)));
    return { val: signed ? avgDeg : (avgDeg + 360) % 360, stable: isStable };
}

// ==========================================================================
// 4. LOGICA FISICA (VENTO E SICUREZZA)
// ==========================================================================

function playBingBing() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Date.now(); if (n - lastAlarmTime < 3000) return; lastAlarmTime = n;
    function b(f, s) { const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.frequency.value = f; g.gain.setValueAtTime(0.1, s); g.gain.exponentialRampToValueAtTime(0.01, s + 0.4); o.start(s); o.stop(s + 0.5); }
    b(880, audioCtx.currentTime); b(880, audioCtx.currentTime + 0.6);
}

function playGybeAlarm() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Date.now(); if (n - lastAlarmTime < 2000) return; lastAlarmTime = n;
    function note(f, s, d) { const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.05, s); g.gain.exponentialRampToValueAtTime(0.001, s + d); o.start(s); o.stop(s + d); }
    for (let i = 0; i < 4; i++) { note(1800, audioCtx.currentTime + (i * 0.15), 0.1); note(1200, audioCtx.currentTime + (i * 0.15) + 0.07, 0.1); }
}

function checkDepthAlarm(m) {
    ui.depth.classList.remove('alarm-warning', 'alarm-danger');
    if (m < CONFIG.alarms.depthDanger) { ui.depth.classList.add('alarm-danger'); playBingBing(); }
    else if (m < CONFIG.alarms.depthWarning) ui.depth.classList.add('alarm-warning');
}

function computeTrueWind() {
    const aws = store.raw["environment.wind.speedApparent"];
    const awa = store.raw["environment.wind.angleApparent"];
    const stw = store.raw["navigation.speedThroughWater"] || 0;
    const sog = store.raw["navigation.speedOverGround"] || 0;
    const hdg = store.raw["navigation.headingTrue"] || 0;
    const cog = store.raw["navigation.courseOverGroundTrue"] || 0;
    if (aws === undefined || awa === undefined) return;
    const tw_water_x = aws * Math.cos(awa) - stw;
    const tw_water_y = aws * Math.sin(awa);
    const tws_water = Math.sqrt(tw_water_x * tw_water_x + tw_water_y * tw_water_y);
    const twa_water = Math.atan2(tw_water_y, tw_water_x);
    const drift_angle = cog - hdg;
    const sog_vec_x = sog * Math.cos(drift_angle);
    const sog_vec_y = sog * Math.sin(drift_angle);
    const tw_ground_x = aws * Math.cos(awa) - sog_vec_x;
    const tw_ground_y = aws * Math.sin(awa) - sog_vec_y;
    const twd_ground = (hdg + Math.atan2(tw_ground_y, tw_ground_x) + 2 * Math.PI) % (2 * Math.PI);
    const now = Date.now();
    store.raw["environment.wind.speedTrue"] = tws_water;
    store.raw["environment.wind.angleTrueWater"] = twa_water;
    store.raw["environment.wind.directionTrue"] = twd_ground;
    store.smoothBuf.twa.push({ val: twa_water, time: now });
    store.longBuf.twa.push({ val: twa_water, time: now });
    store.smoothBuf.twd.push({ val: twd_ground, time: now });
    store.longBuf.twd.push({ val: twd_ground, time: now });
}

function updateWindTrend() {
    const twaAvgObj = getCircularAverageFromBuffer(store.longBuf.twa, 60000, true);
    const shortAvg = getCircularAverageFromBuffer(store.longBuf.twd, 5000, false);
    const instantTwaRad = store.raw["environment.wind.angleTrueWater"];
    if (!shortAvg || !twaAvgObj || instantTwaRad === undefined) return;
    const instantTwaDeg = radToDeg(instantTwaRad);
    if (lastShortAvgVal === null) { lastShortAvgVal = shortAvg.val; lastInstantTwa = instantTwaDeg; return; }
    const gybeDetected = (Math.abs(instantTwaDeg) > 150 && Math.abs(lastInstantTwa) > 150 && Math.sign(instantTwaDeg) !== Math.sign(lastInstantTwa));
    lastInstantTwa = instantTwaDeg;
    const compassDots = { cw: document.getElementById('trend-dot-cw'), ccw: document.getElementById('trend-dot-ccw') };
    const gaugeDots = { cw: document.getElementById('trend-gauge-cw'), ccw: document.getElementById('trend-gauge-ccw') };
    if (gybeDetected && isNavigating) {
        playGybeAlarm();
        [compassDots.cw, compassDots.ccw, gaugeDots.cw, gaugeDots.ccw].forEach(el => { if (el) { el.classList.add('is-gybing'); el.classList.remove('is-trending'); el.setAttribute('fill', '#ff0000'); }});
        return;
    }
    let diff = (shortAvg.val - lastShortAvgVal + 540) % 360 - 180;
    lastShortAvgVal = shortAvg.val;
    rotationTrend = (rotationTrend * 0.95) + (diff * 0.05);
    if (Math.abs(rotationTrend) > 1.0) {
        const pos = store.raw["navigation.position"];
        const isSouthernHemisphere = pos && pos.latitude < 0;
        let meteoColor = (!isSouthernHemisphere) ? (rotationTrend < 0 ? "#00ff00" : "#ff0000") : (rotationTrend > 0 ? "#00ff00" : "#ff0000");
        let isLift = (twaAvgObj.val > 0) ? (rotationTrend > 0) : (rotationTrend < 0);
        const tacticColor = isLift ? "#00ff00" : "#ff0000";
        if (rotationTrend > 0) {
            if (compassDots.cw) { compassDots.cw.classList.add('is-trending'); compassDots.cw.setAttribute('fill', meteoColor); }
            if (gaugeDots.cw) { gaugeDots.cw.classList.add('is-trending'); gaugeDots.cw.setAttribute('fill', tacticColor); }
            [compassDots.ccw, gaugeDots.ccw].forEach(el => { if(el) { el.classList.remove('is-trending', 'is-gybing'); el.setAttribute('fill', '#ffffff'); }});
        } else {
            if (compassDots.ccw) { compassDots.ccw.classList.add('is-trending'); compassDots.ccw.setAttribute('fill', meteoColor); }
            if (gaugeDots.ccw) { gaugeDots.ccw.classList.add('is-trending'); gaugeDots.ccw.setAttribute('fill', tacticColor); }
            [compassDots.cw, gaugeDots.cw].forEach(el => { if(el) { el.classList.remove('is-trending', 'is-gybing'); el.setAttribute('fill', '#ffffff'); }});
        }
    } else {
        [compassDots.cw, compassDots.ccw, gaugeDots.cw, gaugeDots.ccw].forEach(el => { if (el) { el.classList.remove('is-trending', 'is-gybing'); el.setAttribute('fill', '#ffffff'); }});
    }
}

// ==========================================================================
// 5. DATA ROUTING
// ==========================================================================
function processIncomingData(path, val) {
    const now = Date.now(); store.timestamps[path] = now; store.raw[path] = val;
    if (path === "navigation.position") store.raw["navigation.position"] = val;
    if (path === "environment.wind.angleApparent") { store.smoothBuf.awa.push({ val: val, time: now }); store.longBuf.awa.push({ val: val, time: now }); }
    if (path === "environment.wind.speedApparent" || path === "environment.wind.angleApparent" || path === "navigation.speedThroughWater") computeTrueWind();
    if (path === "navigation.headingTrue") { store.smoothBuf.hdg.push({ val: val, time: now }); store.longBuf.hdg.push({ val: val, time: now }); }
    if (path === "navigation.courseOverGroundTrue") { store.smoothBuf.cog.push({ val: val, time: now }); store.longBuf.cog.push({ val: val, time: now }); }
}

// ==========================================================================
// 6. MOTORE RENDERING UI
// ==========================================================================
function updateLeewayDisplay(deg) { const c = 125, px = 125/20; let w = Math.min(Math.abs(deg)*px, 125); ui.leewayMask.setAttribute('x', deg >= 0 ? c : c - w); ui.leewayMask.setAttribute('width', w); ui.leewayVal.textContent = `LEEWAY: ${deg.toFixed(1)}°`; }

function startDisplayLoop() {
    renderInterval = setInterval(() => {
        const now = Date.now();
        const pathsToWatch = { "navigation.speedThroughWater": ui.stw, "navigation.speedOverGround": ui.sog, "navigation.headingTrue": ui.hdg, "navigation.courseOverGroundTrue": ui.cog, "environment.wind.speedApparent": ui.awsSvg, "environment.depth.belowTransducer": ui.depth, "environment.wind.speedTrue": ui.tws };
        for (let p in pathsToWatch) { if (!store.timestamps[p] || (now - store.timestamps[p] > TIMEOUT_MS)) { if (pathsToWatch[p] === ui.awsSvg) ui.awsSvg.textContent = "---"; else pathsToWatch[p].innerText = "---"; delete store.raw[p]; } }

        const stwKts = msToKts(store.raw["navigation.speedThroughWater"] || 0);
        const sogKts = msToKts(store.raw["navigation.speedOverGround"] || 0);
        isNavigating = stwKts > CONFIG.averages.minSpeed || sogKts > CONFIG.averages.minSpeed;

        if (store.raw["navigation.speedThroughWater"] !== undefined) { ui.stw.innerText = stwKts.toFixed(1); manageHistory('stw', stwKts); }
        if (store.raw["navigation.speedOverGround"] !== undefined) {
            ui.sog.innerText = sogKts.toFixed(1);
            let sogColor = "#fff"; const currentEffect = sogKts - stwKts;
            if (currentEffect > 0.3) sogColor = "#2ecc71"; else if (currentEffect < -0.3) sogColor = "#e74c3c";
            ui.sog.style.color = sogColor; manageHistory('sog', sogKts);
        }
        if (store.raw["environment.depth.belowTransducer"] !== undefined) { const d = store.raw["environment.depth.belowTransducer"]; ui.depth.innerText = d.toFixed(1); checkDepthAlarm(d); manageHistory('depth', d); }
        if (store.raw["environment.wind.speedTrue"] !== undefined) {
            const twsKts = msToKts(store.raw["environment.wind.speedTrue"]); ui.tws.innerText = twsKts.toFixed(1);
            ui.tws.style.color = (twsKts >= CONFIG.graphs.reef2) ? "#e74c3c" : (twsKts >= CONFIG.graphs.reef1 ? "#e67e22" : "#fff");
            manageHistory('tws', twsKts);
        }
        if (store.raw["environment.wind.speedApparent"] !== undefined) ui.awsSvg.textContent = msToKts(store.raw["environment.wind.speedApparent"]).toFixed(1);

        const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, CONFIG.averages.smoothWindow, true);
        if (smAwa) { curAwaRot = getShortestRotation(curAwaRot, smAwa.val); ui.awa.setAttribute('transform', `rotate(${curAwaRot}, 200, 200)`); }
        const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, CONFIG.averages.smoothWindow, true);
        if (smTwa) { curTwaRot = getShortestRotation(curTwaRot, smTwa.val); ui.twa.setAttribute('transform', `rotate(${curTwaRot}, 200, 200)`); }

        if (store.raw["navigation.courseOverGroundTrue"] !== undefined && store.raw["navigation.headingTrue"] !== undefined) {
            let drift = (radToDeg(store.raw["navigation.courseOverGroundTrue"]) - radToDeg(store.raw["navigation.headingTrue"]) + 540) % 360 - 180;
            if (sogKts < CONFIG.averages.minSpeed) smoothedLeeway = 0; else smoothedLeeway = (smoothedLeeway * 0.9) + (drift * 0.1);
            curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway); ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
            updateLeewayDisplay(Math.max(-20, Math.min(20, smoothedLeeway)));
        } else updateLeewayDisplay(0);

        if (now - lastAvgUIUpdate > 3000) {
            let hObj = getCircularAverageFromBuffer(store.longBuf.hdg, CONFIG.averages.longWindow, false),
                cObj = getCircularAverageFromBuffer(store.longBuf.cog, CONFIG.averages.longWindow, false),
                awObj = getCircularAverageFromBuffer(store.longBuf.awa, CONFIG.averages.longWindow, true),
                twObj = getCircularAverageFromBuffer(store.longBuf.twa, CONFIG.averages.longWindow, true),
                twdObj = getCircularAverageFromBuffer(store.longBuf.twd, CONFIG.averages.longWindow, false);

            const upUI = (el, obj, isCompass = false) => {
                if (!obj || obj.val === null) { el.innerHTML = "---&deg;"; el.classList.remove('unstable-data'); }
                else {
                    let val = Math.round(obj.val); el.innerHTML = (isCompass ? ((val + 360) % 360).toString().padStart(3, '0') : val) + "&deg;";
                    if (obj.stable || !isNavigating) el.classList.remove('unstable-data'); else el.classList.add('unstable-data');
                }
            };
            upUI(ui.hdg, hObj, true); upUI(ui.cog, cObj, true); upUI(ui.awaAvg, awObj, false); upUI(ui.twaAvg, twObj, false); upUI(ui.twdAvg, twdObj, true);
            if (hObj && twObj && hObj.val !== null) {
                const tA = twObj.val * 2;
                ui.tackHdg.innerHTML = `${Math.round((hObj.val - tA + 360) % 360).toString().padStart(3, '0')}&deg;`;
                if (cObj) ui.tackCog.innerHTML = `${Math.round((cObj.val - tA + 360) % 360).toString().padStart(3, '0')}&deg;`;
            }
            if (twdObj && hObj) { updateWindTrend(); curTwdRoseRot = getShortestRotation(curTwdRoseRot, twdObj.val); ui.twdArrow.setAttribute('transform', `rotate(${curTwdRoseRot}, 20, 20)`); ui.twdBoat.setAttribute('transform', `rotate(${hObj.val}, 20, 20)`); }
            lastAvgUIUpdate = now;
        }
        for (let b in store.smoothBuf) { while (store.smoothBuf[b].length > 0 && (now - store.smoothBuf[b][0].time) > CONFIG.averages.smoothWindow) store.smoothBuf[b].shift(); }
        for (let b in store.longBuf) { while (store.longBuf[b].length > 0 && (now - store.longBuf[b][0].time) > CONFIG.averages.longWindow) store.longBuf[b].shift(); }
    }, RENDER_INTERVAL_MS);
}

// ==========================================================================
// 7. CONFIG E GRAFICI
// ==========================================================================
async function fetchServerConfig() {
    if (!window.location.protocol.includes("http")) return;
    const pluginID = 'rotevista-dash';
    const possibleUrls = [`/skServer/plugins/${pluginID}/config`, `/plugins/${pluginID}/config` ];
    for (let url of possibleUrls) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                const actual = data.configuration || data;
                if (actual && typeof actual === 'object') {
                    const parseNumbers = (obj) => { for (let k in obj) { if (typeof obj[k] === 'object') parseNumbers(obj[k]); else if (!isNaN(obj[k]) && obj[k] !== "") obj[k] = parseFloat(obj[k]); } };
                    parseNumbers(actual);
                    if (actual.alarms) CONFIG.alarms = { ...CONFIG.alarms, ...actual.alarms };
                    if (actual.graphs) CONFIG.graphs = { ...CONFIG.graphs, ...actual.graphs };
                    if (actual.averaging) CONFIG.averages = { ...CONFIG.averages, ...actual.averaging };
                    if (actual.scales) { for (let key in actual.scales) { CONFIG.scales[key] = { ...CONFIG.scales[key], ...actual.scales[key] }; } }
                }
            }
        } catch (e) { }
    }
}

function manageHistory(t, v) {
    const n = Date.now(); const interval = simulationMode ? SIM_SAMPLE_INTERVAL : (CONFIG.graphs.historyMinutes * 60000) / CONFIG.graphs.samples;
    if (n - store.lastUpdates[t] > interval || store.histories[t].length === 0) { store.histories[t].push(v); if (store.histories[t].length > CONFIG.graphs.samples) store.histories[t].shift(); store.lastUpdates[t] = n; }
    const mode = graphModes[t], cfg = calculateScale(t, store.histories[t], mode);
    updateScaleLabels(t, cfg.min, cfg.max); drawGraph(store.histories[t], t + '-graph', cfg.min, cfg.max, t === 'tws', mode === 'hercules');
}

function calculateScale(type, data, mode) {
    const s = CONFIG.scales[type] || { stdMax: 12, hercSpan: 4, step: 2 }; let aMin = Math.min(...data), aMax = Math.max(...data);
    if (mode === 'hercules') { let avg = (aMin + aMax) / 2; let span = Math.max(s.hercSpan, Math.ceil(aMax - aMin)); if (span % 2 !== 0) span += 1; let min = Math.max(0, Math.floor(avg - (span / 2))); return { min, max: min + span }; }
    else return { min: 0, max: Math.max(s.stdMax, Math.ceil(aMax / s.step) * s.step) };
}

function updateScaleLabels(t, min, max) { const el = document.getElementById(t + '-scale'); if (el) el.innerHTML = `<span>${Math.round(max)}</span><span>${Math.round((min+max)/2)}</span><span>${Math.round(min)}</span>`; }

function drawGraph(d, id, min, max, isTws, isHercules) {
    const svg = document.getElementById(id); if (!svg || d.length < 2) return;
    const w = 200, h = 40, range = max - min || 1;
    let grids = ""; [0.25, 0.5, 0.75].forEach(p => { grids += `<line x1="0" y1="${h-(p*h)}" x2="${w}" y2="${h-(p*h)}" stroke="rgba(255,255,255,0.08)" stroke-width="0.5" />`; });
    for (let m = 1; m < CONFIG.graphs.historyMinutes; m++) { const x = w - (m / CONFIG.graphs.historyMinutes) * w; grids += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(255,255,255,0.05)" stroke-width="0.5" />`; }
    let pD = ""; let cS = "";
    d.forEach((v, i) => {
        const x = (i/(CONFIG.graphs.samples-1))*w, y = h-(Math.max(0,Math.min(1,(v-min)/range))*h); pD += `${i===0?'M':'L'} ${x} ${y} `;
        if (isTws && i > 0) {
            const px = ((i-1)/(CONFIG.graphs.samples-1))*w, py = h-(Math.max(0,Math.min(1,(d[i-1]-min)/range))*h);
            let c = (v >= CONFIG.graphs.reef2) ? "#e74c3c" : (v >= CONFIG.graphs.reef1 ? "#e67e22" : "#fff");
            cS += `<line x1="${px}" y1="${py}" x2="${x}" y2="${y}" stroke="${c}" class="${isHercules?'line-hercules':''}" />`;
        }
    });
    const clrs = { 'stw-graph': '#2ecc71', 'sog-graph': '#f39c12', 'depth-graph': '#3498db', 'tws-graph': '#ffffff' };
    svg.innerHTML = isTws ? `${grids}<path d="${pD} L ${((d.length-1)/(CONFIG.graphs.samples-1))*w} ${h} L 0 ${h} Z" fill="rgba(255,255,255,0.08)" stroke="none" />${cS}` : `${grids}<path d="${pD} L ${((d.length-1)/(CONFIG.graphs.samples-1))*w} ${h} L 0 ${h} Z" fill="${clrs[id]}22" stroke="none" /><path d="${pD}" class="${isHercules?'line-hercules':''}" fill="none" stroke="${clrs[id]}" />`;
}

// ==========================================================================
// 8. INTERAZIONI
// ==========================================================================
window.addEventListener('contextmenu', e => e.preventDefault(), true);

function toggleFocusMode(type, element) {
    const container = document.querySelector('.main-container'); const parentPanel = element.closest('.side-panel'); const isLeft = parentPanel.classList.contains('left-panel');
    isFocusActive = !isFocusActive;
    if (isFocusActive) { container.classList.add('focus-active', isLeft ? 'focus-side-left' : 'focus-side-right'); parentPanel.classList.add('has-focus'); element.classList.add('is-focused'); }
    else { container.classList.remove('focus-active', 'focus-side-left', 'focus-side-right'); document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('has-focus')); document.querySelectorAll('.data-box').forEach(b => b.classList.remove('is-focused')); }
}

['stw', 'sog', 'tws', 'depth'].forEach(type => {
    const el = document.getElementById(type + '-graph').closest('.data-box'); let lastTapTime = 0, tapTimeout;
    el.addEventListener('pointerdown', (e) => {
        if (e.cancelable) e.preventDefault(); const currentTime = new Date().getTime(); const tapDelay = currentTime - lastTapTime;
        pressTimer = setTimeout(() => { if (!isFocusActive) { toggleFocusMode(type, el); lastTapTime = 0; } }, 1000);
        if (tapDelay < 300 && tapDelay > 0) { clearTimeout(tapTimeout); if (!isFocusActive) { graphModes[type] = graphModes[type] === 'standard' ? 'hercules' : 'standard'; localStorage.setItem('mode_' + type, graphModes[type]); } lastTapTime = 0; }
        else { lastTapTime = currentTime; tapTimeout = setTimeout(() => { if (isFocusActive && el.classList.contains('is-focused')) toggleFocusMode(type, el); }, 350); }
    });
    el.addEventListener('pointerup', () => clearTimeout(pressTimer)); el.addEventListener('pointerleave', () => clearTimeout(pressTimer));
});

if (ui.hotspot) {
    ui.hotspot.addEventListener('pointerdown', (e) => { pressTimer = setTimeout(() => { document.body.classList.toggle('night-mode'); ui.hotspot.style.opacity = "0.5"; setTimeout(() => ui.hotspot.style.opacity = "1", 200); pressTimer = null; }, 1000); });
    ui.hotspot.addEventListener('pointerup', (e) => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; const doc = document.documentElement, isF = document.fullscreenElement || document.webkitFullscreenElement; if (!isF) { if (doc.requestFullscreen) doc.requestFullscreen(); else if (doc.webkitRequestFullscreen) doc.webkitRequestFullscreen(); } else { if (document.exitFullscreen) document.exitFullscreen(); else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); } } });
    ui.hotspot.addEventListener('pointerleave', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
}

// ==========================================================================
// 9. CONNESSIONE E SIMULATORE
// ==========================================================================
function connect() {
    if (simulationMode) return;
    let addr = (window.location.protocol.includes("http")) ? window.location.host : CONFIG.server.fallbackIp;
    try {
        socket = new WebSocket(`ws://${addr}/signalk/v1/stream?subscribe=self`);
        socket.onopen = () => { ui.status.className = "online"; ui.status.innerText = "ONLINE"; };
        socket.onmessage = (e) => { if (simulationMode) return; const d = JSON.parse(e.data); if (d.updates) d.updates.forEach(u => u.values && u.values.forEach(v => processIncomingData(v.path, v.value))); };
        socket.onclose = () => !simulationMode && setTimeout(connect, 5000);
    } catch (e) { setTimeout(connect, 5000); }
}

ui.depth.closest('.data-box').addEventListener('click', (function() { let dC = 0, lC = 0; return function() { const n = Date.now(); if (n - lC < 500) dC++; else dC = 1; lC = n; if (dC === 3) { simulationMode = !simulationMode; if (simulationMode) { if (socket) socket.close(); startDynamicSimulation(); } else location.reload(); dC = 0; } }; })());

function startDynamicSimulation() {
    ui.status.innerText = "SIM ATTIVO";
    let sim = { hdg: 45, tws: 12, twd: 45, depth: 12, stw: 5, leeway: 0, startTime: Date.now() };
    simInterval = setInterval(() => {
        const elapsed = (Date.now() - sim.startTime) / 1000;
        if (elapsed > 120 && elapsed < 121) sim.twd = Math.random() * 360;
        sim.twd = (sim.twd + (Math.sin(elapsed / 20) * 0.5) + 360) % 360;
        const inGust = (elapsed % 40) < 5; const targetTws = (inGust ? 18 : 10) + Math.sin(elapsed / 10) * 2;
        sim.tws += (targetTws - sim.tws) * 0.05; sim.hdg = (sim.hdg + (Math.random() - 0.5) * 1 + 360) % 360;
        let twaRel = (sim.twd - sim.hdg + 360) % 360; if (twaRel > 180) twaRel -= 360;
        let targetStw = 3 + (4 * Math.sin((Math.abs(twaRel) - 45) * Math.PI / 125)); sim.stw += (Math.max(3, Math.min(8, targetStw)) - sim.stw) * 0.05;
        const rawLeeway = Math.sin(degToRad(twaRel)) * 4; sim.leeway += (rawLeeway - sim.leeway) * 0.05;
        const cog = (sim.hdg - sim.leeway + 360) % 360; const twaRad = degToRad(twaRel);
        const aws = Math.sqrt(Math.pow(sim.stw, 2) + Math.pow(sim.tws, 2) + 2 * sim.stw * sim.tws * Math.cos(twaRad));
        const awa = Math.atan2(sim.tws * Math.sin(twaRad), sim.stw + sim.tws * Math.cos(twaRad));
        processIncomingData("environment.wind.speedApparent", ktsToMs(aws)); processIncomingData("environment.wind.angleApparent", awa);
        processIncomingData("environment.depth.belowTransducer", sim.depth); processIncomingData("navigation.headingTrue", degToRad(sim.hdg));
        processIncomingData("navigation.speedThroughWater", ktsToMs(sim.stw)); processIncomingData("navigation.speedOverGround", ktsToMs(sim.stw));
        processIncomingData("navigation.courseOverGroundTrue", degToRad(cog)); processIncomingData("navigation.position", { latitude: 45.0, longitude: 12.0 });
    }, 1000);
}

// ==========================================================================
// 10. INIT
// ==========================================================================
(function genTicks() { const c = document.getElementById('ticks'); if (c) { for (let i = 0; i < 360; i += 10) { const l = document.createElementNS("http://www.w3.org/2000/svg", "line"); const m = i % 30 === 0; l.setAttribute("x1", "200"); l.setAttribute("y1", "40"); l.setAttribute("x2", "200"); l.setAttribute("y2", (m ? 60 : 50)); l.setAttribute("stroke", m ? "#fff" : "#666"); l.setAttribute("stroke-width", m ? "2" : "1"); l.setAttribute("transform", `rotate(${i}, 200, 200)`); c.appendChild(l); } } })();
async function init() { await fetchServerConfig(); startDisplayLoop(); connect(); }
window.addEventListener('load', init);
