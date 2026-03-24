// ==========================================================================
// 1. CONFIGURAZIONE E COSTANTI
// ==========================================================================
const SIGNALK_SERVER_IP = "192.168.111.240:3000"; // Indirizzo IP e porta server SignalK
const ALARM_DANGER_DEPTH = 2.5;                   // Allarme rosso + suono (metri)
const ALARM_WARNING_DEPTH = 5.0;                  // Pre-allarme giallo (metri)

const RENDER_INTERVAL_MS = 1000;                  // Refresh UI (1 sec)
const TIMEOUT_MS = 5000;                          // Watchdog: oscura dato se manca per 5 sec

const SMOOTH_WINDOW_MS = 2000;                    // Media veloce (2 sec) per lancette SVG
const LONG_AVG_WINDOW_MS = 60000;                 // Media lunga (60 sec) per riquadri "MEAN"

const MAX_HISTORY_SAMPLES = 60;                   // Pixel max per sparklines
const REAL_SAMPLE_INTERVAL = 5000;                // Campionamento sparkline reale (5 sec)
const SIM_SAMPLE_INTERVAL = 1000;                 // Campionamento sparkline simulazione (1 sec)

const STABILITY_TIME_TOLERANCE_MS = 2000;         // Tolleranza riempimento buffer (es. 58s su 60s)
const STABILITY_CONFIDENCE_THRESHOLD = 0.90;      // Indice circolare (R) minimo per non lampeggiare
const MIN_SPEED_FOR_STABILITY_KTS = 0.5;          // Sotto questa velocità NON lampeggia nulla (barca ferma)

// ==========================================================================
// 2. VARIABILI GLOBALI E STATO
// ==========================================================================
let simulationMode = false;
let socket;
let renderInterval = null;
let simInterval = null;
let lastAvgUIUpdate = 0;
let audioCtx = null, lastAlarmTime = 0;
let curAwaRot = 0, curTwaRot = 0, curTrackRot = 0, curTwdRoseRot = 0;

const store = {
    raw: {},
    timestamps: {},
    smoothBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [], leeway: [] },
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
    status: document.getElementById('status')
};

// ==========================================================================
// 3. FUNZIONI MATEMATICHE E HELPER
// ==========================================================================
function radToDeg(rad) { return rad * (180 / Math.PI); }
function degToRad(deg) { return deg * (Math.PI / 180); }
function msToKts(ms) { return ms * 1.94384; }
function ktsToMs(kts) { return kts / 1.94384; }

function getShortestRotation(curr, target) {
    let diff = (target - curr) % 360;
    if (diff > 180) diff -= 360; else if (diff < -180) diff += 360;
    return curr + diff;
}

function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false) {
    const now = Date.now();
    const validData = bufferArray.filter(item => (now - item.time) <= windowMs);
    if (validData.length === 0) return null;
    
    let sumSin = 0, sumCos = 0;
    validData.forEach(item => { sumSin += Math.sin(item.val); sumCos += Math.cos(item.val); });
    
    let R = Math.sqrt(sumSin * sumSin + sumCos * sumCos) / validData.length;
    let timeSpan = validData[validData.length - 1].time - validData[0].time;
    let isStable = (timeSpan >= windowMs - STABILITY_TIME_TOLERANCE_MS) && (R > STABILITY_CONFIDENCE_THRESHOLD);
    let avgRad = Math.atan2(sumSin, sumCos);
    let avgDeg = Math.round(radToDeg(avgRad));
    let finalVal = signed ? avgDeg : (avgDeg + 360) % 360;
    
    return { val: finalVal, stable: isStable };
}

function cleanBuffer(bufferArray, windowMs) {
    const now = Date.now();
    while (bufferArray.length > 0 && (now - bufferArray[0].time) > windowMs) bufferArray.shift();
}

// ==========================================================================
// 4. GESTIONE DATI IN INGRESSO (SIGNALK / SIMULATORE)
// ==========================================================================
function processIncomingData(path, val) {
    const now = Date.now();
    store.timestamps[path] = now;
    store.raw[path] = val;

    if (path === "navigation.headingTrue") { store.smoothBuf.hdg.push({ val: val, time: now }); store.longBuf.hdg.push({ val: val, time: now }); }
    if (path === "navigation.courseOverGroundTrue") { store.smoothBuf.cog.push({ val: val, time: now }); store.longBuf.cog.push({ val: val, time: now }); }
    if (path === "environment.wind.angleApparent") { store.smoothBuf.awa.push({ val: val, time: now }); store.longBuf.awa.push({ val: val, time: now }); }
    if (path === "environment.wind.angleTrueWater") { store.smoothBuf.twa.push({ val: val, time: now }); store.longBuf.twa.push({ val: val, time: now }); }

    // Calcolo TWD in locale
    if (path === "environment.wind.angleTrueWater" || path === "navigation.headingTrue") {
        if (store.raw["navigation.headingTrue"] !== undefined && store.raw["environment.wind.angleTrueWater"] !== undefined) {
            let twdRad = (store.raw["navigation.headingTrue"] + store.raw["environment.wind.angleTrueWater"]) % (2 * Math.PI);
            if (twdRad < 0) twdRad += (2 * Math.PI);
            store.raw["environment.wind.directionTrue"] = twdRad;
            store.timestamps["environment.wind.directionTrue"] = now;
        }
    }

    if (store.raw["environment.wind.directionTrue"] !== undefined) {
        store.smoothBuf.twd.push({ val: store.raw["environment.wind.directionTrue"], time: now });
        store.longBuf.twd.push({ val: store.raw["environment.wind.directionTrue"], time: now });
    }

    // Calcolo Leeway in locale
    if (path === "environment.wind.angleTrueWater" || path === "environment.wind.speedTrue" || path === "navigation.speedThroughWater") {
        if (store.raw["environment.wind.angleTrueWater"] !== undefined && store.raw["environment.wind.speedTrue"] !== undefined && store.raw["navigation.speedThroughWater"] !== undefined) {
            const twsKts = msToKts(store.raw["environment.wind.speedTrue"]);
            const stwKts = msToKts(store.raw["navigation.speedThroughWater"]);
            const stwSafe = Math.max(stwKts, 0.1);
            let leewayDeg = - (12 * twsKts / (stwSafe * stwSafe)) * Math.sin(store.raw["environment.wind.angleTrueWater"]);
            leewayDeg = Math.max(-20, Math.min(20, leewayDeg));
            store.raw["navigation.leewayAngle"] = degToRad(leewayDeg);
            store.timestamps["navigation.leewayAngle"] = now;
            store.smoothBuf.leeway.push({ val: degToRad(leewayDeg), time: now });
        }
    } else if (path === "navigation.leewayAngle") {
        store.smoothBuf.leeway.push({ val: val, time: now });
    }
}

// ==========================================================================
// 5. MOTORE DI RENDERING PRINCIPALE (UI LOOP)
// ==========================================================================
function startDisplayLoop() {
    if (renderInterval) clearInterval(renderInterval);
    
    renderInterval = setInterval(() => {
        const now = Date.now();

        // --- WATCHDOG TIMEOUT ---
        const pathsToWatch = {
            "navigation.speedThroughWater": ui.stw, "navigation.speedOverGround": ui.sog,
            "navigation.headingTrue": ui.hdg, "navigation.courseOverGroundTrue": ui.cog,
            "environment.wind.speedApparent": ui.awsSvg,
            "environment.depth.belowTransducer": ui.depth, "environment.wind.speedTrue": ui.tws
        };
        for (let p in pathsToWatch) {
            if (!store.timestamps[p] || (now - store.timestamps[p] > TIMEOUT_MS)) {
                pathsToWatch[p][pathsToWatch[p] === ui.awsSvg ? 'textContent' : 'innerText'] = "---";
                if (p === "environment.depth.belowTransducer") ui.depth.classList.remove('alarm-warning', 'alarm-danger');
                delete store.raw[p];
            }
        }

        // --- RENDER DATI ISTANTANEI ---
        if (store.raw["navigation.speedThroughWater"] !== undefined) {
            const stw = msToKts(store.raw["navigation.speedThroughWater"]); ui.stw.innerText = stw.toFixed(1); manageHistory('stw', stw);
        }
        if (store.raw["navigation.speedOverGround"] !== undefined) {
            const sog = msToKts(store.raw["navigation.speedOverGround"]); ui.sog.innerText = sog.toFixed(1); manageHistory('sog', sog);
        }
        if (store.raw["environment.depth.belowTransducer"] !== undefined) {
            const d = store.raw["environment.depth.belowTransducer"]; ui.depth.innerText = d.toFixed(1); checkDepthAlarm(d); manageHistory('depth', d);
        }
        if (store.raw["environment.wind.speedTrue"] !== undefined) {
            const tws = msToKts(store.raw["environment.wind.speedTrue"]); ui.tws.innerText = tws.toFixed(1); manageHistory('tws', tws);
        }
        if (store.raw["environment.wind.speedApparent"] !== undefined) {
            ui.awsSvg.textContent = msToKts(store.raw["environment.wind.speedApparent"]).toFixed(1);
        }

        // --- RENDER QUADRANTE VENTO (SMOOTHING 2s) ---
        const smoothLeewayObj = getCircularAverageFromBuffer(store.smoothBuf.leeway, SMOOTH_WINDOW_MS, true);
        const smoothLeeway = smoothLeewayObj ? smoothLeewayObj.val : null;
        
        const smoothAwaObj = getCircularAverageFromBuffer(store.smoothBuf.awa, SMOOTH_WINDOW_MS, true);
        if (smoothAwaObj !== null) { curAwaRot = getShortestRotation(curAwaRot, smoothAwaObj.val); ui.awa.setAttribute('transform', `rotate(${curAwaRot}, 200, 200)`); }
        
        const smoothTwaObj = getCircularAverageFromBuffer(store.smoothBuf.twa, SMOOTH_WINDOW_MS, true);
        if (smoothTwaObj !== null) { curTwaRot = getShortestRotation(curTwaRot, smoothTwaObj.val); ui.twa.setAttribute('transform', `rotate(${curTwaRot}, 200, 200)`); }
        
        if (smoothLeeway !== null) {
            updateLeewayDisplay(smoothLeeway);
            curTrackRot = getShortestRotation(curTrackRot, smoothLeeway); ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
        }
        
        // --- RENDER MEDIE LUNGHE E TACK (Ogni 3s su buffer di 60s) ---
        if (now - lastAvgUIUpdate > 3000) {
            let hdgObj = getCircularAverageFromBuffer(store.longBuf.hdg, LONG_AVG_WINDOW_MS, false);
            let cogObj = getCircularAverageFromBuffer(store.longBuf.cog, LONG_AVG_WINDOW_MS, false);
            let awObj = getCircularAverageFromBuffer(store.longBuf.awa, LONG_AVG_WINDOW_MS, true);
            let twObj = getCircularAverageFromBuffer(store.longBuf.twa, LONG_AVG_WINDOW_MS, true);
            let twdObj = getCircularAverageFromBuffer(store.longBuf.twd, LONG_AVG_WINDOW_MS, false);

            // Lettura velocità per soppressione allarmi stabilità all'ormeggio
            let currentSogKts = 0;
            if (store.histories.sog && store.histories.sog.length > 0) {
                currentSogKts = store.histories.sog[store.histories.sog.length - 1];
            } else if (store.raw["navigation.speedOverGround"] !== undefined) {
                currentSogKts = msToKts(store.raw["navigation.speedOverGround"]);
            }

            const updateMeanUI = (el, obj) => {
                if (!obj) {
                    el.innerHTML = `---&deg;`;
                    el.classList.remove('unstable-data');
                } else {
                    el.innerHTML = `${obj.val.toString().padStart(3, '0')}&deg;`;
                    let isEffectivelyStable = obj.stable || (currentSogKts < MIN_SPEED_FOR_STABILITY_KTS);
                    if (isEffectivelyStable) el.classList.remove('unstable-data');
                    else el.classList.add('unstable-data');
                }
            };

            updateMeanUI(ui.hdg, hdgObj);
            updateMeanUI(ui.cog, cogObj);
            updateMeanUI(ui.awaAvg, awObj);
            updateMeanUI(ui.twaAvg, twObj);
            updateMeanUI(ui.twdAvg, twdObj);
            
            // Calcolo TACK (Mure Opposte)
            if (hdgObj && twObj && hdgObj.val !== null && twObj.val !== null) {
                let tackAngleOffset = twObj.val * 2;
                let newHdg = (hdgObj.val - tackAngleOffset + 360) % 360;
                ui.tackHdg.innerHTML = `${Math.round(newHdg).toString().padStart(3, '0')}&deg;`;
                
                if (cogObj && cogObj.val !== null) {
                    let newCog = (cogObj.val - tackAngleOffset + 360) % 360;
                    ui.tackCog.innerHTML = `${Math.round(newCog).toString().padStart(3, '0')}&deg;`;
                } else {
                    ui.tackCog.innerHTML = `---&deg;`;
                }

                // Lampeggio TACK con esenzione per barca ferma applicata
                let tackMathStable = hdgObj.stable && twObj.stable && (!cogObj || cogObj.stable);
                let tackEffectivelyStable = tackMathStable || (currentSogKts < MIN_SPEED_FOR_STABILITY_KTS);
                
                if (tackEffectivelyStable) {
                    ui.tackHdg.classList.remove('unstable-data');
                    ui.tackCog.classList.remove('unstable-data');
                } else {
                    ui.tackHdg.classList.add('unstable-data');
                    ui.tackCog.classList.add('unstable-data');
                }
            } else {
                ui.tackHdg.innerHTML = `---&deg;`;
                ui.tackCog.innerHTML = `---&deg;`;
                ui.tackHdg.classList.remove('unstable-data');
                ui.tackCog.classList.remove('unstable-data');
            }

            if (twdObj !== null) {
                curTwdRoseRot = getShortestRotation(curTwdRoseRot, twdObj.val);
                ui.twdArrow.setAttribute('transform', `rotate(${curTwdRoseRot}, 20, 20)`);
            }
            lastAvgUIUpdate = now;
        }

        // Pulizia ciclica dei buffer per evitare memory leak
        cleanBuffer(store.smoothBuf.hdg, SMOOTH_WINDOW_MS); cleanBuffer(store.smoothBuf.cog, SMOOTH_WINDOW_MS);
        cleanBuffer(store.smoothBuf.awa, SMOOTH_WINDOW_MS); cleanBuffer(store.smoothBuf.twa, SMOOTH_WINDOW_MS);
        cleanBuffer(store.smoothBuf.twd, SMOOTH_WINDOW_MS); cleanBuffer(store.smoothBuf.leeway, SMOOTH_WINDOW_MS);
        cleanBuffer(store.longBuf.awa, LONG_AVG_WINDOW_MS); cleanBuffer(store.longBuf.twa, LONG_AVG_WINDOW_MS);
        cleanBuffer(store.longBuf.twd, LONG_AVG_WINDOW_MS); cleanBuffer(store.longBuf.hdg, LONG_AVG_WINDOW_MS);
        cleanBuffer(store.longBuf.cog, LONG_AVG_WINDOW_MS);

    }, RENDER_INTERVAL_MS);
}

// ==========================================================================
// 6. ALLARMI AUDIO
// ==========================================================================
document.addEventListener('click', () => { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }, { once: true });
function playBingBing() {
    if (!audioCtx) return; const n = Date.now(); if (n - lastAlarmTime < 3000) return; lastAlarmTime = n;
    function b(f, s) {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination); o.frequency.value = f;
        g.gain.setValueAtTime(0.1, s); g.gain.exponentialRampToValueAtTime(0.01, s + 0.4);
        o.start(s); o.stop(s + 0.5);
    }
    b(880, audioCtx.currentTime); b(880, audioCtx.currentTime + 0.6);
}
function checkDepthAlarm(m) {
    ui.depth.classList.remove('alarm-warning', 'alarm-danger');
    if (m < ALARM_DANGER_DEPTH) { ui.depth.classList.add('alarm-danger'); playBingBing(); }
    else if (m < ALARM_WARNING_DEPTH) ui.depth.classList.add('alarm-warning');
}

// ==========================================================================
// 7. CONNESSIONE SIGNALK (SAFARI FRIENDLY)
// ==========================================================================
let isConnecting = false;

function connect() {
    // Se siamo in simulazione o se c'è già un tentativo in corso, ci fermiamo
    if (simulationMode || isConnecting) return;
    
    // Se il socket esiste ed è già aperto o in fase di apertura, non facciamo nulla
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    isConnecting = true;

    try {
        socket = new WebSocket(`ws://${SIGNALK_SERVER_IP}/signalk/v1/stream?subscribe=all`);
        
        socket.onopen = () => {
            isConnecting = false;
            ui.status.className = "online";
            ui.status.innerText = "ONLINE";
        };
        
        socket.onmessage = (e) => {
            if (simulationMode) return;
            const d = JSON.parse(e.data);
            if (d.updates) d.updates.forEach(u => u.values && u.values.forEach(v => processIncomingData(v.path, v.value)));
        };

        socket.onerror = (err) => {
            // Non forziamo la chiusura qui. Lasciamo che Safari gestisca l'errore
            // in modo nativo e faccia scattare onclose da solo.
            isConnecting = false;
        };

        socket.onclose = () => {
            isConnecting = false;
            if (!simulationMode) {
                ui.status.className = "offline";
                ui.status.innerText = "OFFLINE";
                // Attendiamo ben 5 secondi prima di riprovare, per non infastidire Safari
                setTimeout(connect, 5000);
            }
        };
    } catch (e) {
        isConnecting = false;
        setTimeout(connect, 5000);
    }
}


// ==========================================================================
// 8. SIMULATORE / MOTORE FISICO
// ==========================================================================
const physicsEngine = {
    time: 0,
    config: { hdgStart: Math.random() * 360, hdgDir: Math.random() > 0.5 ? 1 : -1, twdBase: Math.random() * 360, rotSpeed: 360 / 600 },
    getPolars: function(twaDeg, twsKts) {
        let eff = 0; const aT = Math.abs(twaDeg);
        if (aT < 30) eff = 0.1; else if (aT < 45) eff = 0.75; else if (aT < 90) eff = 1.0; else if (aT < 150) eff = 0.85; else eff = 0.65;
        return Math.min(Math.sqrt(twsKts) * 2.2 * eff, 11.0);
    },
    step: function() {
        this.time++;
        const hdgDeg = (this.config.hdgStart + (this.time * this.config.rotSpeed * this.config.hdgDir) + 360) % 360;
        const twdDeg = (this.config.twdBase + Math.sin(this.time / 20) * 15 + 360) % 360;
        const twsKts = 14 + Math.sin(this.time / 40) * 6;
        const depthM = 20 + Math.sin(this.time / 25) * 18;
        let twaDeg = (twdDeg - hdgDeg + 360) % 360; if (twaDeg > 180) twaDeg -= 360;
        const stwKts = this.getPolars(twaDeg, twsKts);
        const stwMs = ktsToMs(stwKts), twsMs = ktsToMs(twsKts), twaRad = degToRad(twaDeg);
        const vAx = twsMs * Math.sin(twaRad), vAy = twsMs * Math.cos(twaRad) + stwMs;
        const awsMs = Math.sqrt(vAx*vAx + vAy*vAy), awaRad = Math.atan2(vAx, vAy);

        return {
            "navigation.headingTrue": degToRad(hdgDeg),
            "navigation.courseOverGroundTrue": degToRad((hdgDeg + 4) % 360), // COG fittizio simulato
            "navigation.speedThroughWater": stwMs,
            "navigation.speedOverGround": stwMs * 1.05,
            "environment.wind.speedTrue": twsMs,
            "environment.wind.directionTrue": degToRad(twdDeg),
            "environment.wind.angleTrueWater": twaRad,
            "environment.wind.speedApparent": awsMs,
            "environment.wind.angleApparent": awaRad,
            "environment.depth.belowTransducer": depthM
        };
    }
};

let dC = 0, lC = 0;
ui.depth.closest('.data-box').addEventListener('click', () => {
    const n = Date.now(); if (n - lC < 500) dC++; else dC = 1; lC = n;
    if (dC === 3) {
        simulationMode = !simulationMode;
        if (simulationMode) {
            if (socket) socket.close(); ui.status.innerText = "SIM ATTIVO";
            if(simInterval) clearInterval(simInterval);
            simInterval = setInterval(() => { const simulatedData = physicsEngine.step(); for (let path in simulatedData) processIncomingData(path, simulatedData[path]); }, 200);
        } else location.reload();
        dC = 0;
    }
});

// ==========================================================================
// 9. FUNZIONI UI GRAFICHE (Sparklines, Leeway, Ticks)
// ==========================================================================
function updateLeewayDisplay(deg) {
    const c = 125, px = 125/20; let w = Math.min(Math.abs(deg)*px, 125);
    ui.leewayMask.setAttribute('x', deg >= 0 ? c : c - w); ui.leewayMask.setAttribute('width', w);
    ui.leewayVal.textContent = `LEEWAY: ${deg.toFixed(1)}°`;
}

function manageHistory(t, v) {
    const n = Date.now(), i = simulationMode ? SIM_SAMPLE_INTERVAL : REAL_SAMPLE_INTERVAL;
    if (n - store.lastUpdates[t] > i || store.histories[t].length === 0) {
        store.histories[t].push(v); if (store.histories[t].length > MAX_HISTORY_SAMPLES) store.histories[t].shift(); store.lastUpdates[t] = n;
    }
    const m = Math.max(...store.histories[t], 1); const c = getDynamicScale(t, m);
    updateScaleLabels(t, c.scale); drawGraph(store.histories[t], t + '-graph', c.scale, c.gridLines);
}

function getDynamicScale(t, m) {
    if (t === 'stw' || t === 'sog') return { scale: 12, gridLines: [3, 6, 9] };
    const s = { tws: [10, 25, 45, 60], depth: [10, 20, 50, 200] };
    const av = s[t] || [10, 20, 50]; let sel = av[av.length - 1];
    for (let x of av) if (m <= x) { sel = x; break; }
    return { scale: sel, gridLines: [sel/4, sel/2, (sel/4)*3] };
}

function updateScaleLabels(t, s) { const el = document.getElementById(t + '-scale'); if (el) el.innerHTML = `<span>${s}</span><span>${s/2}</span><span>0</span>`; }

function drawGraph(d, id, s, gl) {
    const svg = document.getElementById(id); if (!svg || d.length < 2) return;
    const w = 200, h = 40; let gH = "";
    gl.forEach(v => { const y = h - (v / s) * h; gH += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="0.5" />`; });
    let p = ""; d.forEach((v, i) => { const x = (i/(MAX_HISTORY_SAMPLES - 1))*w; const y = h - (Math.min(v, s)/s)*h; p += `${i===0?'M':'L'} ${x} ${y} `; });
    const aP = p + ` L ${((d.length-1)/(MAX_HISTORY_SAMPLES - 1))*w} ${h} L 0 ${h} Z`;
    const clrs = { 'stw-graph': { s: '#2ecc71', f: 'rgba(46, 204, 113, 0.15)' }, 'sog-graph': { s: '#f39c12', f: 'rgba(243, 156, 18, 0.15)' }, 'depth-graph': { s: '#3498db', f: 'rgba(52, 152, 219, 0.15)' }, 'tws-graph': { s: '#f1c40f', f: 'rgba(241, 196, 15, 0.15)' } };
    svg.innerHTML = `${gH}<path d="${aP}" fill="${clrs[id].f}" stroke="none" /><path d="${p}" fill="none" stroke="${clrs[id].s}" stroke-width="1.5" />`;
}

function generateTicks() {
    const c = document.getElementById('ticks');
    for (let i = 0; i < 360; i += 10) {
        const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
        const m = i % 30 === 0; l.setAttribute("x1", "200"); l.setAttribute("y1", "40");
        l.setAttribute("x2", "200"); l.setAttribute("y2", (m ? 60 : 50));
        l.setAttribute("stroke", m ? "#fff" : "#666");
        l.setAttribute("stroke-width", m ? "2" : "1");
        l.setAttribute("transform", `rotate(${i}, 200, 200)`);
        c.appendChild(l);
    }
}

// ==========================================================================
// 10. INIZIALIZZAZIONE (Attesa caricamento DOM per Safari)
// ==========================================================================
generateTicks();
startDisplayLoop();

// Attendiamo che il browser abbia finito di renderizzare la grafica
// prima di aprire il socket, evita blocchi su iPad/iPhone.
window.addEventListener('load', () => {
    setTimeout(connect, 500);
});
