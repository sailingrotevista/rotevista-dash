// ==========================================================================
// 1. CONFIGURAZIONE DINAMICA (Default)
// ==========================================================================
let CONFIG = {
    alarms: {
        depthDanger: 2.5,
        depthWarning: 5.0
    },
    averages: {
        smoothWindow: 2000,
        longWindow: 60000,
        stabilityTolerance: 2000,
        stabilityThreshold: 0.90,
        minSpeed: 0.5
    },
    graphs: {
        reef1: 15.0, // Soglia 1° mano (Arancio)
        reef2: 20.0, // Soglia 2° mano (Rosso)
        realInterval: 5000,
        samples: 60
    },
    scales: {
        stw: { stdMax: 6, hercSpan: 4, step: 2 },
        sog: { stdMax: 6, hercSpan: 4, step: 2 },
        tws: { stdMax: 20, hercSpan: 10, step: 5 },
        depth: { stdMax: 10, hercSpan: 10, step: 10 }
    },
    server: {
        fallbackIp: "192.168.111.240:3000"
    }
};

// Costanti tecniche non configurabili
const RENDER_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5000;
const SIM_SAMPLE_INTERVAL = 1000;

// ==========================================================================
// 2. STATO GLOBALE E UI
// ==========================================================================
let simulationMode = false;
let socket, renderInterval, simInterval;
let lastAvgUIUpdate = 0, audioCtx = null, lastAlarmTime = 0;
let curAwaRot = 0, curTwaRot = 0, curTrackRot = 0, curTwdRoseRot = 0;

// Modalità Scale Grafici (Local al tablet)
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
    leewayMask: document.getElementById('leeway-mask-rect'), leewayVal: document.getElementById('leeway-val'),
    tackHdg: document.getElementById('tack-hdg'), tackCog: document.getElementById('tack-cog'),
    status: document.getElementById('status'),
    hotspot: document.getElementById('fullscreen-hotspot')
};

// ==========================================================================
// 3. CARICAMENTO CONFIGURAZIONE DAL SERVER
// ==========================================================================
async function fetchServerConfig() {
    // Cerchiamo di capire se siamo su un server reale o in locale
    const isRemote = window.location.protocol.includes("http");
    
    if (isRemote) {
        try {
            console.log("Dashboard: Recupero impostazioni dal server...");
            // L'URL ufficiale per leggere i settaggi del plugin
            const response = await fetch('/signalk/v1/plugins/rotevista-dash/settings');
            
            if (response.ok) {
                const serverConfig = await response.json();
                
                // Se il server ha dei dati salvati, sovrascriviamo il CONFIG di default
                if (serverConfig && Object.keys(serverConfig).length > 0) {
                    // Merge dei blocchi (Alarms, Graphs, Averages)
                    if (serverConfig.alarms) CONFIG.alarms = { ...CONFIG.alarms, ...serverConfig.alarms };
                    if (serverConfig.graphs) CONFIG.graphs = { ...CONFIG.graphs, ...serverConfig.graphs };
                    if (serverConfig.averages) CONFIG.averages = { ...CONFIG.averages, ...serverConfig.averages };
                    
                    console.log("Dashboard: Configurazione caricata correttamente!", CONFIG);
                }
            } else {
                console.log("Dashboard: Il server non ha ancora impostazioni salvate. Uso i default.");
            }
        } catch (e) {
            console.error("Dashboard: Errore critico nel fetch delle impostazioni:", e);
        }
    }
}

// ==========================================================================
// 4. MATEMATICA E CONVERSIONI
// ==========================================================================
function radToDeg(rad) { return rad * (180 / Math.PI); }
function degToRad(deg) { return deg * (Math.PI / 180); }
function msToKts(ms) { return ms * 1.94384; }
function ktsToMs(kts) { return kts / 1.94384; }
function getShortestRotation(curr, target) { let diff = (target - curr) % 360; if (diff > 180) diff -= 360; else if (diff < -180) diff += 360; return curr + diff; }

function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false) {
    const now = Date.now();
    const validData = bufferArray.filter(item => (now - item.time) <= windowMs);
    if (validData.length === 0) return null;
    let sSin = 0, sCos = 0;
    validData.forEach(item => { sSin += Math.sin(item.val); sCos += Math.cos(item.val); });
    let R = Math.sqrt(sSin * sSin + sCos * sCos) / validData.length;
    let timeSpan = validData[validData.length - 1].time - validData[0].time;
    // Usa le soglie CONFIG
    let isStable = (timeSpan >= windowMs - CONFIG.averages.stabilityTolerance) && (R > CONFIG.averages.stabilityThreshold);
    let avgRad = Math.atan2(sSin, sCos);
    let avgDeg = Math.round(radToDeg(avgRad));
    return { val: signed ? avgDeg : (avgDeg + 360) % 360, stable: isStable };
}

function cleanBuffer(bufferArray, windowMs) {
    const now = Date.now();
    while (bufferArray.length > 0 && (now - bufferArray[0].time) > windowMs) bufferArray.shift();
}

// ==========================================================================
// 5. GESTIONE DATI IN INGRESSO
// ==========================================================================
function processIncomingData(path, val) {
    const now = Date.now();
    store.timestamps[path] = now;
    store.raw[path] = val;

    if (path === "navigation.headingTrue") { store.smoothBuf.hdg.push({ val: val, time: now }); store.longBuf.hdg.push({ val: val, time: now }); }
    if (path === "navigation.courseOverGroundTrue") { store.smoothBuf.cog.push({ val: val, time: now }); store.longBuf.cog.push({ val: val, time: now }); }
    if (path === "environment.wind.angleApparent") { store.smoothBuf.awa.push({ val: val, time: now }); store.longBuf.awa.push({ val: val, time: now }); }
    if (path === "environment.wind.angleTrueWater") { store.smoothBuf.twa.push({ val: val, time: now }); store.longBuf.twa.push({ val: val, time: now }); }
    if (path === "environment.wind.directionTrue") { store.smoothBuf.twd.push({ val: val, time: now }); store.longBuf.twd.push({ val: val, time: now }); }
}

// ==========================================================================
// 6. MOTORE DI RENDERING
// ==========================================================================
function startDisplayLoop() {
    if (renderInterval) clearInterval(renderInterval);
    renderInterval = setInterval(() => {
        const now = Date.now();

        // 6.1 Watchdog
        const pathsToWatch = { "navigation.speedThroughWater": ui.stw, "navigation.speedOverGround": ui.sog, "navigation.headingTrue": ui.hdg, "navigation.courseOverGroundTrue": ui.cog, "environment.wind.speedApparent": ui.awsSvg, "environment.depth.belowTransducer": ui.depth, "environment.wind.speedTrue": ui.tws };
        for (let p in pathsToWatch) { if (!store.timestamps[p] || (now - store.timestamps[p] > TIMEOUT_MS)) { pathsToWatch[p][pathsToWatch[p] === ui.awsSvg ? 'textContent' : 'innerText'] = "---"; delete store.raw[p]; } }

        // 6.2 Render Dati
        if (store.raw["navigation.speedThroughWater"] !== undefined) { const v = msToKts(store.raw["navigation.speedThroughWater"]); ui.stw.innerText = v.toFixed(1); manageHistory('stw', v); }
        let curSog = 0;
        if (store.raw["navigation.speedOverGround"] !== undefined) { curSog = msToKts(store.raw["navigation.speedOverGround"]); ui.sog.innerText = curSog.toFixed(1); manageHistory('sog', curSog); }
        if (store.raw["environment.depth.belowTransducer"] !== undefined) { const d = store.raw["environment.depth.belowTransducer"]; ui.depth.innerText = d.toFixed(1); checkDepthAlarm(d); manageHistory('depth', d); }
        if (store.raw["environment.wind.speedTrue"] !== undefined) { const w = msToKts(store.raw["environment.wind.speedTrue"]); ui.tws.innerText = w.toFixed(1); manageHistory('tws', w); }
        if (store.raw["environment.wind.speedApparent"] !== undefined) ui.awsSvg.textContent = msToKts(store.raw["environment.wind.speedApparent"]).toFixed(1);

        // 6.3 Render Quadrante (AWA, TWA, Drift)
        const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, CONFIG.averages.smoothWindow, true);
        if (smAwa) { curAwaRot = getShortestRotation(curAwaRot, smAwa.val); ui.awa.setAttribute('transform', `rotate(${curAwaRot}, 200, 200)`); }
        const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, CONFIG.averages.smoothWindow, true);
        if (smTwa) { curTwaRot = getShortestRotation(curTwaRot, smTwa.val); ui.twa.setAttribute('transform', `rotate(${curTwaRot}, 200, 200)`); }

        if (store.raw["navigation.courseOverGroundTrue"] && store.raw["navigation.headingTrue"]) {
            let drift = (radToDeg(store.raw["navigation.courseOverGroundTrue"]) - radToDeg(store.raw["navigation.headingTrue"]) + 360) % 360;
            if (curSog < CONFIG.averages.minSpeed) drift = 0;
            curTrackRot = getShortestRotation(curTrackRot, drift);
            ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
            let ds = drift > 180 ? drift - 360 : drift; updateLeewayDisplay(Math.max(-20, Math.min(20, ds)));
        } else updateLeewayDisplay(0);
        
        // 6.4 Render Medie Lunghe (MEAN) e TACK
        if (now - lastAvgUIUpdate > 3000) {
            let hObj = getCircularAverageFromBuffer(store.longBuf.hdg, CONFIG.averages.longWindow, false),
                cObj = getCircularAverageFromBuffer(store.longBuf.cog, CONFIG.averages.longWindow, false),
                awObj = getCircularAverageFromBuffer(store.longBuf.awa, CONFIG.averages.longWindow, true),
                twObj = getCircularAverageFromBuffer(store.longBuf.twa, CONFIG.averages.longWindow, true),
                twdObj = getCircularAverageFromBuffer(store.longBuf.twd, CONFIG.averages.longWindow, false);

            const upUI = (el, obj) => {
                if (!obj) { el.innerHTML = "---&deg;"; el.classList.remove('unstable-data'); }
                else {
                    el.innerHTML = `${obj.val.toString().padStart(3, '0')}&deg;`;
                    if (obj.stable || curSog < CONFIG.averages.minSpeed) el.classList.remove('unstable-data');
                    else el.classList.add('unstable-data');
                }
            };
            upUI(ui.hdg, hObj); upUI(ui.cog, cObj); upUI(ui.awaAvg, awObj); upUI(ui.twaAvg, twObj); upUI(ui.twdAvg, twdObj);
            
            if (hObj && twObj && hObj.val !== null) {
                let tA = twObj.val * 2;
                ui.tackHdg.innerHTML = `${Math.round((hObj.val - tA + 360) % 360).toString().padStart(3, '0')}&deg;`;
                if (cObj) ui.tackCog.innerHTML = `${Math.round((cObj.val - tA + 360) % 360).toString().padStart(3, '0')}&deg;`;
                let tStable = (hObj.stable && twObj.stable) || (curSog < CONFIG.averages.minSpeed);
                if (tStable) { ui.tackHdg.classList.remove('unstable-data'); ui.tackCog.classList.remove('unstable-data'); }
                else { ui.tackHdg.classList.add('unstable-data'); ui.tackCog.classList.add('unstable-data'); }
            }
            if (twdObj) { curTwdRoseRot = getShortestRotation(curTwdRoseRot, twdObj.val); ui.twdArrow.setAttribute('transform', `rotate(${curTwdRoseRot}, 20, 20)`); }
            lastAvgUIUpdate = now;
        }

        for (let b in store.smoothBuf) cleanBuffer(store.smoothBuf[b], CONFIG.averages.smoothWindow);
        for (let b in store.longBuf) cleanBuffer(store.longBuf[b], CONFIG.averages.longWindow);
    }, RENDER_INTERVAL_MS);
}

// ==========================================================================
// 7. CONNESSIONE SIGNALK (subscribe=self)
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

// ==========================================================================
// 8. FUNZIONI GRAFICHE (Hercules Mode)
// ==========================================================================
function updateLeewayDisplay(deg) {
    const c = 125, px = 125/20; let w = Math.min(Math.abs(deg)*px, 125);
    ui.leewayMask.setAttribute('x', deg >= 0 ? c : c - w); ui.leewayMask.setAttribute('width', w);
    ui.leewayVal.textContent = `LEEWAY: ${deg.toFixed(1)}°`;
}

function manageHistory(t, v) {
    const n = Date.now(), i = simulationMode ? SIM_SAMPLE_INTERVAL : CONFIG.graphs.realInterval;
    if (n - store.lastUpdates[t] > i || store.histories[t].length === 0) {
        store.histories[t].push(v); if (store.histories[t].length > CONFIG.graphs.samples) store.histories[t].shift();
        store.lastUpdates[t] = n;
    }
    const mode = graphModes[t];
    const cfg = calculateScale(t, store.histories[t], mode);
    
    const box = document.getElementById(t + '-graph').closest('.data-box');
    if (mode === 'hercules') box.classList.add('box-hercules'); else box.classList.remove('box-hercules');

    updateScaleLabels(t, cfg.min, cfg.max);
    drawGraph(store.histories[t], t + '-graph', cfg.min, cfg.max, t === 'tws', mode === 'hercules');
}

function calculateScale(type, data, mode) {
    const s = CONFIG.scales[type] || { stdMax: 12, hercSpan: 4, step: 2 };
    let aMin = Math.min(...data), aMax = Math.max(...data);

    if (mode === 'hercules') {
        let avg = (aMin + aMax) / 2;
        let span = Math.max(s.hercSpan, Math.ceil(aMax - aMin));
        if (span % 2 !== 0) span += 1;
        let min = Math.max(0, Math.floor(avg - (span / 2)));
        return { min, max: min + span };
    } else {
        let max = Math.max(s.stdMax, Math.ceil(aMax / s.step) * s.step);
        return { min: 0, max: max };
    }
}

function updateScaleLabels(t, min, max) {
    const el = document.getElementById(t + '-scale'); if (!el) return;
    el.innerHTML = `<span>${Math.round(max)}</span><span>${Math.round((min+max)/2)}</span><span>${Math.round(min)}</span>`;
}

function drawGraph(d, id, min, max, isTws, isHercules) {
    const svg = document.getElementById(id); if (!svg || d.length < 2) return;
    const w = 200, h = 40, range = max - min;
    let gH = ""; [0.25, 0.5, 0.75].forEach(p => { gH += `<line x1="0" y1="${h-(p*h)}" x2="${w}" y2="${h-(p*h)}" stroke="rgba(255,255,255,0.08)" stroke-width="0.5" />`; });
    
    let pD = "", cS = "";
    d.forEach((v, i) => {
        const x = (i/(CONFIG.graphs.samples-1))*w, y = h-(Math.max(0,Math.min(1,(v-min)/range))*h);
        pD += `${i===0?'M':'L'} ${x} ${y} `;
        if (isTws && i > 0) {
            const px = ((i-1)/(CONFIG.graphs.samples-1))*w, py = h-(Math.max(0,Math.min(1,(d[i-1]-min)/range))*h);
            let c = "#f1c40f"; if (v >= CONFIG.graphs.reef2) c = "#e74c3c"; else if (v >= CONFIG.graphs.reef1) c = "#e67e22";
            cS += `<line x1="${px}" y1="${py}" x2="${x}" y2="${y}" stroke="${c}" stroke-width="${isHercules?3:2}" class="${isHercules?'line-hercules':''}" />`;
        }
    });

    const areaPath = pD + ` L ${((d.length-1)/(CONFIG.graphs.samples-1))*w} ${h} L 0 ${h} Z`;
    const clrs = { 'stw-graph': '#2ecc71', 'sog-graph': '#f39c12', 'depth-graph': '#3498db', 'tws-graph': '#f1c40f' };
    const lClass = isHercules ? 'line-hercules' : '';

    if (isTws) {
        svg.innerHTML = `${gH}<path d="${areaPath}" fill="rgba(241,196,15,0.12)" stroke="none" />${cS}`;
    } else {
        svg.innerHTML = `${gH}<path d="${areaPath}" fill="${clrs[id]}22" stroke="none" /><path d="${pD}" class="${lClass}" fill="none" stroke="${clrs[id]}" stroke-width="1.5" />`;
    }
}

// ==========================================================================
// 9. EVENTI E INIZIALIZZAZIONE
// ==========================================================================

// Cambio Scala Hercules (Doppio Click)
['stw', 'sog', 'tws', 'depth'].forEach(type => {
    const el = document.getElementById(type + '-graph').closest('.data-box');
    el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        graphModes[type] = graphModes[type] === 'standard' ? 'hercules' : 'standard';
        localStorage.setItem('mode_' + type, graphModes[type]);
        el.style.backgroundColor = "rgba(255,255,255,0.15)"; setTimeout(() => el.style.backgroundColor = "", 200);
    });
});

// Fullscreen (Tocco hotspot)
if (ui.hotspot) {
    ui.hotspot.addEventListener('click', (e) => {
        e.preventDefault();
        const doc = document.documentElement, isF = document.fullscreenElement || document.webkitFullscreenElement;
        if (!isF) { if (doc.requestFullscreen) doc.requestFullscreen(); else if (doc.webkitRequestFullscreen) doc.webkitRequestFullscreen(); }
        else { if (document.exitFullscreen) document.exitFullscreen(); else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); }
    });
}

// Generazione Tacche SVG
(function generateTicks() {
    const c = document.getElementById('ticks');
    if (c) { for (let i = 0; i < 360; i += 10) { const l = document.createElementNS("http://www.w3.org/2000/svg", "line"); const m = i % 30 === 0; l.setAttribute("x1", "200"); l.setAttribute("y1", "40"); l.setAttribute("x2", "200"); l.setAttribute("y2", (m ? 60 : 50)); l.setAttribute("stroke", m ? "#fff" : "#666"); l.setAttribute("stroke-width", m ? "2" : "1"); l.setAttribute("transform", `rotate(${i}, 200, 200)`); c.appendChild(l); } }
})();

// ==========================================================================
// 9. LANCIO APPLICAZIONE (Sincronizzato)
// ==========================================================================
async function init() {
    // 1. Prima scarichiamo la configurazione dal server
    await fetchServerConfig();
    
    // 2. Poi facciamo partire tutto il resto
    startDisplayLoop();
    connect();
}

// Avvio al caricamento della pagina
window.addEventListener('load', init);

function checkDepthAlarm(m) { ui.depth.classList.remove('alarm-warning', 'alarm-danger'); if (m < CONFIG.alarms.depthDanger) { ui.depth.classList.add('alarm-danger'); playBingBing(); } else if (m < CONFIG.alarms.depthWarning) ui.depth.classList.add('alarm-warning'); }
function playBingBing() { if (!audioCtx) return; const n = Date.now(); if (n - lastAlarmTime < 3000) return; lastAlarmTime = n; function b(f, s) { const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.frequency.value = f; g.gain.setValueAtTime(0.1, s); g.gain.exponentialRampToValueAtTime(0.01, s + 0.4); o.start(s); o.stop(s + 0.5); } b(880, audioCtx.currentTime); b(880, audioCtx.currentTime + 0.6); }

// Simulatore (Triple click su Depth)
ui.depth.closest('.data-box').addEventListener('click', (function() {
    let dC = 0, lC = 0;
    return function() {
        const n = Date.now(); if (n - lC < 500) dC++; else dC = 1; lC = n;
        if (dC === 3) {
            simulationMode = !simulationMode;
            if (simulationMode) { if (socket) socket.close(); ui.status.innerText = "SIM ATTIVO"; simInterval = setInterval(() => { const h = Math.random()*360; processIncomingData("navigation.headingTrue", degToRad(h)); processIncomingData("navigation.speedOverGround", ktsToMs(8)); }, 200); }
            else location.reload();
            dC = 0;
        }
    };
})());
