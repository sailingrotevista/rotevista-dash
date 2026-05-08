/**
 * ==========================================================================
 * Signal K Wind Dashboard - Pro Version 2.4 (Definitive)
 * ==========================================================================
 * Autore: Sailing Rotevista
 * Motore di calcolo tattico per navigazione e crociera.
 * Gestisce: Medie Vettoriali, Deviazione Standard, Trend Strategico a 15min,
 * Memoria UI persistente, Modalità Hercules e Focus Split Screen.
 */

// ==========================================================================
// 1. CONFIGURAZIONE E DEFAULT
// ==========================================================================
let CONFIG = {
    alarms: {
        depthDanger: 2.5,
        depthWarning: 5.0
    },
    // Gestione parametri di stabilità e medie
    averages: {
        smoothWindow: 2000,         // Smoothing puntatori (2s)
        longWindow: 30000,          // Finestra per i valori MEAN (30s)
        stabilityTolerance: 2000,   // Millisecondi per considerare il buffer "pieno"
        stabilityThreshold: 0.85,   // Soglia coerenza R per il lampeggio (0.7 - 0.98)
        minSpeed: 0,               // Nodi minimi per attivare gli allarmi di instabilità
        stabilityBreakout: 15
    },
    // Parametri per i grafici sparkline
    graphs: {
        reef1: 15.0,                // Soglia primo reef (Orange)
        reef2: 20.0,                // Soglia secondo reef (Red)
        historyMinutes: 5,          // Finestra temporale visualizzata
        samples: 60                 // Numero di punti di campionamento
    },
    // Configurazioni scale automatiche
    scales: {
        stw: { stdMax: 12, hercSpan: 4, step: 2 },
        sog: { stdMax: 12, hercSpan: 4, step: 2 },
        tws: { stdMax: 25, hercSpan: 10, step: 5 },
        depth: { stdMax: 20, hercSpan: 10, step: 10 }
    },
    server: {
        fallbackIp: "192.168.111.240:3000"
    }
};

const RENDER_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5000;
const SIM_SAMPLE_INTERVAL = 1000;
const DASH_VERSION = "2.4"; // Versione per la gestione della memoria locale

// ==========================================================================
// 2. STATO GLOBALE E RIFERIMENTI UI
// ==========================================================================
let simulationMode = false;
let displayModeSog = 'SOG'; // Può essere 'SOG' o 'VMG'
let socket, renderInterval, simInterval;
let lastAvgUIUpdate = 0, audioCtx = null, lastAlarmTime = 0;
let curAwaRot = 0, curTwaRot = 0, curTrackRot = 0, curTwdRoseRot = 0;
let curBoatCompassRot = 0, curWindCompassRot = 0;

let smoothedLeeway = 0, rotationTrend = 0, meteoTrend = 0;
let lastShortAvgVal = null, lastInstantTwa = null;
let lastTrendTime = Date.now(), lastGybeAlarmTime = 0, lastTWCompute = 0;
let twDirty = false, isNavigating = false, reconnectDelay = 1000;

let pressTimer, isFocusActive = false;

// Stato dei singoli grafici (Standard vs Hercules Zoom)
const graphModes = {
    stw: 'standard',
    sog: 'standard',
    tws: 'standard',
    depth: 'standard'
};

// Database centrale dello store dati
const store = {
    raw: {},
    timestamps: {},
    smoothBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [] },
    longBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [] },
    histories: { stw: [], sog: [], depth: [], tws: [], vmg: [] },
    // Buffer temporaneo per il calcolo della media dell'intervallo del grafico
    graphTempBuf: { stw: [], sog: [], depth: [], tws: [], vmg: [] },
    lastUpdates: { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0 }
};

// Riferimenti agli elementi DOM mappati all'avvio
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
// 3. UTILITIES (MATEMATICA, BUFFER, AUDIO, MEMORIA)
// ==========================================================================
function radToDeg(rad) { return rad * (180 / Math.PI); }
function degToRad(deg) { return deg * (Math.PI / 180); }
function msToKts(ms) { return ms * 1.94384; }
function ktsToMs(kts) { return kts / 1.94384; }

/**
 * Calcola il percorso più breve per la rotazione di un puntatore (evita giri di 360°)
 */
function getShortestRotation(curr, target) {
    let diff = (target - curr) % 360;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    return curr + diff;
}

/**
 * Inserisce un dato nel buffer circolare limitandolo a 2000 campioni (30 min)
 */
function safePush(buffer, val, time, maxLen = 2000) {
    buffer.push({ val: val, time: time });
    if (buffer.length > maxLen) { buffer.shift(); }
}

/**
 * Media Circolare Vettoriale: Calcola angolo medio, stabilità R e deviazione standard (±)
 */
function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false) {
    const now = Date.now();
    const validData = bufferArray.filter(item => (now - item.time) <= windowMs);
    if (validData.length === 0) return null;
    
    let sSin = 0, sCos = 0;
    validData.forEach(item => {
        sSin += Math.sin(item.val);
        sCos += Math.cos(item.val);
    });
    
    let R = Math.sqrt(sSin * sSin + sCos * sCos) / validData.length;
    let historyDuration = (validData.length > 2) ? (validData[validData.length - 1].time - validData[0].time) : 0;
    
    // Un dato è stabile se abbiamo abbastanza storia e la coerenza vettoriale R è alta
    let isStable = (historyDuration > 10000) && (R > CONFIG.averages.stabilityThreshold);
    let avgRad = Math.atan2(sSin, sCos);

    // Calcolo della Deviazione Standard Circolare (±) in gradi
    let deviation = (R < 1 && R > 0) ? Math.round(Math.sqrt(-2 * Math.log(R)) * (180 / Math.PI)) : 0;

    return {
        val: signed ? avgRad : (avgRad + 2 * Math.PI) % (2 * Math.PI),
        stable: isStable,
        dev: deviation
    };
}

/**
 * Salva lo stato attuale della dashboard (dati e preferenze UI) nel browser
 */
function saveDashboardState() {
    try {
        const focusedBox = document.querySelector('.data-box.is-focused');
        let focusedType = null;
        if (focusedBox) {
            const match = focusedBox.className.match(/box-([a-z]+)/);
            if (match) focusedType = match[1];
        }

        const state = {
            version: DASH_VERSION,
            histories: store.histories,
            longBuf: store.longBuf,
            displayModeSog: displayModeSog,
            graphModes: graphModes,
            isNightMode: document.body.classList.contains('night-mode'),
            isFocusActive: isFocusActive,
            focusedBoxType: focusedType,
            timestamp: Date.now()
        };
        localStorage.setItem('rotevista_dash_state', JSON.stringify(state));
    } catch (e) { console.error("Save error:", e); }
}

/**
 * Carica e ripristina lo stato salvato (entro i 20 minuti di vecchiaia)
 */
function loadDashboardState() {
    const saved = localStorage.getItem('rotevista_dash_state');
    if (!saved) return;
    try {
        const state = JSON.parse(saved);
        if (state.version !== DASH_VERSION) { localStorage.removeItem('rotevista_dash_state'); return; }
        
        if ((Date.now() - state.timestamp) / 60000 < 20) {
            if (state.histories) Object.assign(store.histories, state.histories);
            if (state.longBuf) Object.assign(store.longBuf, state.longBuf);
            if (state.graphModes) Object.assign(graphModes, state.graphModes);
            
            // Ripristino SOG/VMG
            if (state.displayModeSog) {
                displayModeSog = state.displayModeSog;
                const labelEl = document.getElementById('sog-vmg-label');
                if (labelEl) labelEl.textContent = displayModeSog;
            }

            // Ripristino Tema Notte
            if (state.isNightMode) document.body.classList.add('night-mode');

            // Ripristino Focus (Dual Screen)
            if (state.isFocusActive && state.focusedBoxType) {
                setTimeout(() => {
                    const el = document.querySelector(`.box-${state.focusedBoxType}`);
                    if (el) { isFocusActive = false; toggleFocusMode(state.focusedBoxType, el); }
                }, 200);
            }
            console.log("Stato ripristinato con successo dalla cache.");
        }
    } catch (e) { localStorage.removeItem('rotevista_dash_state'); }
}

// ==========================================================================
// 4. AUDIO E ALLARMI
// ==========================================================================
function playBingBing() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Date.now(); if (n - lastAlarmTime < 3000) return; lastAlarmTime = n;
    function b(f, s) {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination); o.frequency.value = f;
        g.gain.setValueAtTime(0.1, s); g.gain.exponentialRampToValueAtTime(0.01, s + 0.4);
        o.start(s); o.stop(s + 0.5);
    }
    b(880, audioCtx.currentTime); b(880, audioCtx.currentTime + 0.6);
}

function playGybeAlarm() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Date.now(); if (n - lastAlarmTime < 2000) return; lastAlarmTime = n;
    function note(f, s, d) {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination); o.type = 'square';
        o.frequency.value = f; g.gain.setValueAtTime(0.05, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + d); o.start(s); o.stop(s + d);
    }
    for (let i = 0; i < 4; i++) {
        note(1800, audioCtx.currentTime + (i * 0.15), 0.1);
        note(1200, audioCtx.currentTime + (i * 0.15) + 0.07, 0.1);
    }
}

function checkDepthAlarm(m) {
    ui.depth.classList.remove('alarm-warning', 'alarm-danger');
    if (m < CONFIG.alarms.depthDanger) { ui.depth.classList.add('alarm-danger'); playBingBing(); }
    else if (m < CONFIG.alarms.depthWarning) ui.depth.classList.add('alarm-warning');
}

function updateLeewayDisplay(deg) {
    const c = 125, px = 125/20; let w = Math.min(Math.abs(deg)*px, 125);
    ui.leewayMask.setAttribute('x', deg >= 0 ? c : c - w); ui.leewayMask.setAttribute('width', w);
    ui.leewayVal.textContent = `LEEWAY: ${deg.toFixed(1)}°`;
}

// ==========================================================================
// 5. MOTORE DI CALCOLO VENTO E DATA ROUTING
// ==========================================================================
function computeTrueWind() {
    const aws = store.raw["environment.wind.speedApparent"], awa = store.raw["environment.wind.angleApparent"];
    const stw = store.raw["navigation.speedThroughWater"] || 0, sog = store.raw["navigation.speedOverGround"] || 0;
    const hdg = store.raw["navigation.headingTrue"] || 0, cog = store.raw["navigation.courseOverGroundTrue"] || 0;
    if (aws === undefined || awa === undefined) return;

    // Vento Reale Rispetto all'acqua (TWA/TWS Water)
    const tw_water_x = aws * Math.cos(awa) - stw, tw_water_y = aws * Math.sin(awa);
    const tws_water = Math.sqrt(tw_water_x * tw_water_x + tw_water_y * tw_water_y);

    // Vento Reale Rispetto al fondo (TWD Ground)
    const drift = (cog - hdg + Math.PI * 3) % (2 * Math.PI) - Math.PI;
    const tw_ground_x = aws * Math.cos(awa) - sog * Math.cos(drift), tw_ground_y = aws * Math.sin(awa) - sog * Math.sin(drift);
    const tws_ground = Math.sqrt(tw_ground_x * tw_ground_x + tw_ground_y * tw_ground_y);

    const now = Date.now();
    store.raw["environment.wind.speedTrue"] = tws_water;
    if (tws_water > 0.05) {
        const twa = Math.atan2(tw_water_y, tw_water_x);
        store.raw["environment.wind.angleTrueWater"] = twa;
        safePush(store.smoothBuf.twa, twa, now); safePush(store.longBuf.twa, twa, now);
    }
    if (tws_ground > 0.05) {
        let twd = (hdg + Math.atan2(tw_ground_y, tw_ground_x) + 2 * Math.PI) % (2 * Math.PI);
        store.raw["environment.wind.directionTrue"] = twd;
        safePush(store.smoothBuf.twd, twd, now); safePush(store.longBuf.twd, twd, now);
    }
}

function processIncomingData(path, val) {
    const now = Date.now(); store.timestamps[path] = now; store.raw[path] = val;
    if (path === "environment.wind.angleApparent") { safePush(store.smoothBuf.awa, val, now); safePush(store.longBuf.awa, val, now); }
    const twPaths = ["environment.wind.speedApparent", "environment.wind.angleApparent", "navigation.speedThroughWater", "navigation.speedOverGround", "navigation.headingTrue", "navigation.courseOverGroundTrue"];
    if (twPaths.includes(path)) twDirty = true;
    if (twDirty && (now - lastTWCompute > 100)) { computeTrueWind(); lastTWCompute = now; twDirty = false; }
    if (path === "navigation.headingTrue") { safePush(store.smoothBuf.hdg, val, now); safePush(store.longBuf.hdg, val, now); }
    if (path === "navigation.courseOverGroundTrue") { safePush(store.smoothBuf.cog, val, now); safePush(store.longBuf.cog, val, now); }
}

// ==========================================================================
// 6. TREND VENTO (Tattico 2s vs 10s | Strategico 1m vs 10m)
// ==========================================================================
function updateWindTrend() {
    const now = Date.now();
    // TATTICA (Lancetta): 2s vs 10s (reazione rapida per trim)
    const twaNow = getCircularAverageFromBuffer(store.longBuf.twa, 2000, true);
    const twaRef = getCircularAverageFromBuffer(store.longBuf.twa, 10000, true);
    
    // STRATEGIA (Bussola TWD): 1 min vs 30 minuti (tendenza meteo profonda)
    const twdNow = getCircularAverageFromBuffer(store.longBuf.twd, 60000, false);
    const twdRef = getCircularAverageFromBuffer(store.longBuf.twd, 1800000, false); // 1.800.000 ms = 30 min
    
    if (!twaNow || !twaRef || !twdNow || !twdRef) return;
    const compassDots = { cw: document.getElementById('trend-dot-cw'), ccw: document.getElementById('trend-dot-ccw') };
    const gaugeDots = { cw: document.getElementById('trend-gauge-cw'), ccw: document.getElementById('trend-gauge-ccw') };

    // TREND METEO (Bussola Centrale TWD)
    let deltaMeteo = radToDeg((twdNow.val - twdRef.val + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    if (Math.abs(deltaMeteo) > 6.0) {
        const isSouth = store.raw["navigation.position"]?.latitude < 0;
        let meteoColor = (!isSouth) ? (deltaMeteo < 0 ? "#27ae60" : "#c0392b") : (deltaMeteo > 0 ? "#27ae60" : "#c0392b");
        if (deltaMeteo > 0) {
            compassDots.cw.classList.add('is-trending'); compassDots.cw.setAttribute('fill', meteoColor);
            compassDots.ccw.classList.remove('is-trending');
        } else {
            compassDots.ccw.classList.add('is-trending'); compassDots.ccw.setAttribute('fill', meteoColor);
            compassDots.cw.classList.remove('is-trending');
        }
    } else { [compassDots.cw, compassDots.ccw].forEach(el => { if(el){ el.classList.remove('is-trending'); el.setAttribute('fill', '#bbb'); }}); }

    // TREND TATTICO (Lancetta Arancione)
    let deltaTac = radToDeg((twaNow.val - twaRef.val + Math.PI * 3) % (2 * Math.PI) - Math.PI);
    const curTwaDeg = radToDeg(twaNow.val);
    if (Math.abs(deltaTac) > 3.0) {
        // Calcolo logica tattica: LIFT (Verde), HEADER (Rosso) o NEUTRO (Grigio)
        let absTwa = Math.abs(curTwaDeg);
        let tacticColor;

        // Se siamo tra 75° e 105° (Traverso), il cambio è considerato neutro
        if (absTwa > 75 && absTwa < 105) {
            tacticColor = "#bbb"; // Grigio/Bianco sporco neutro
        } else {
            let isLift = (curTwaDeg > 0) ? (deltaTac > 0) : (deltaTac < 0);
            if (absTwa >= 90) isLift = !isLift; // Inversione logica per andature portanti
            tacticColor = isLift ? "#27ae60" : "#c0392b";
        }
        if (deltaTac > 0) {
            gaugeDots.cw.classList.add('is-trending'); gaugeDots.cw.setAttribute('fill', tacticColor);
            gaugeDots.ccw.classList.remove('is-trending');
        } else {
            gaugeDots.ccw.classList.add('is-trending'); gaugeDots.ccw.setAttribute('fill', tacticColor);
            gaugeDots.cw.classList.remove('is-trending');
        }
    } else { [gaugeDots.cw, gaugeDots.ccw].forEach(el => { if(el){ el.classList.remove('is-trending'); el.setAttribute('fill', '#bbb'); }}); }

    // ALLARME STRAMBATA (GYBE)
    const instTwa = radToDeg(store.raw["environment.wind.angleTrueWater"] || 0);
    if (Math.abs(instTwa) > 155 && Math.sign(instTwa) !== Math.sign(lastInstantTwa)) {
        if (isNavigating && (now - lastGybeAlarmTime > 5000)) { lastGybeAlarmTime = now; playGybeAlarm(); }
    }
    lastInstantTwa = instTwa;
}

// ==========================================================================
// 7. RENDERING ENGINE E AGGIORNAMENTO UI
// ==========================================================================
function refreshGraph(t) {
    const type = (t === 'vmg') ? 'sog' : t;
    const data = store.histories[t]; if (!data || data.length < 2) return;
    const mode = graphModes[type], cfg = calculateScale(type, data, mode);
    
    // Gestione visualizzazione Hercules Zoom (sfondo rosso)
    const box = document.querySelector(`.box-${type}`);
    if (box) box.classList.toggle('box-hercules', mode === 'hercules');
    
    updateScaleLabels(type, cfg.min, cfg.max);
    drawGraph(data, type + '-graph', cfg.min, cfg.max, t === 'tws', mode === 'hercules');
}

/**
 * upUI: Aggiornamento valori digitali con logica anti-ritardo (Istantaneo vs Media)
 */
const upUI = (el, obj, instantRaw, isCompass = false) => {
    if (!obj || obj.val === null || instantRaw === undefined) {
        el.innerHTML = "---&deg;"; el.classList.remove('unstable-data');
    } else {
        let valDeg = Math.round(radToDeg(obj.val));
        let mainVal = (isCompass ? ((valDeg + 360) % 360).toString().padStart(3, '0') : valDeg) + "&deg;";
        let dev = (obj.dev > 1 && obj.dev < 90) ? `<span style="font-size: 0.35em; opacity: 0.5; margin-left: 4px; vertical-align: middle;">&plusmn;${obj.dev}</span>` : "";
        el.innerHTML = mainVal + dev;
        
        let diff = Math.abs((radToDeg(instantRaw) - radToDeg(obj.val) + 540) % 360 - 180);
        // Allarme lampeggio solo se in navigazione E (R bassa O deviazione alta O salto istantaneo brusco)
        if (isNavigating && (!obj.stable || obj.dev > CONFIG.averages.stabilityBreakout || diff > CONFIG.averages.stabilityBreakout)) el.classList.add('unstable-data');
        else el.classList.remove('unstable-data');
    }
};

/**
 * Loop principale di aggiornamento interfaccia (1Hz)
 */
/**
 * Loop principale di aggiornamento interfaccia (1Hz)
 * Gestisce la gerarchia di aggiornamento Live (1s), Heavy (2s) e Slow (3s).
 */
function startDisplayLoop() {
    renderInterval = setInterval(() => {
        const now = Date.now();
        const stwKts = msToKts(store.raw["navigation.speedThroughWater"] || 0);
        const sogKts = msToKts(store.raw["navigation.speedOverGround"] || 0);
        
        // Verifica stato navigazione basato su soglia impostata
        isNavigating = stwKts > CONFIG.averages.minSpeed || sogKts > CONFIG.averages.minSpeed;

        // --- TIER LIVE (1s): CONTROLLO TIMEOUT DATI ---
        const watch = { "navigation.speedThroughWater": ui.stw, "navigation.speedOverGround": ui.sog, "navigation.headingTrue": ui.hdg, "navigation.courseOverGroundTrue": ui.cog, "environment.wind.speedApparent": ui.awsSvg, "environment.depth.belowTransducer": ui.depth, "environment.wind.speedTrue": ui.tws };
        for (let p in watch) {
            if (!store.timestamps[p] || (now - store.timestamps[p] > TIMEOUT_MS)) {
                watch[p].innerText = "---"; delete store.raw[p];
            }
        }

        // --- AGGIORNAMENTO DATI ISTANTANEI ---
        if (store.raw["navigation.speedThroughWater"] !== undefined) {
            ui.stw.innerText = stwKts.toFixed(1); manageHistory('stw', stwKts);
        }
        
        // --- LOGICA SOG / VMG E COLORI DINAMICI ---
        if (store.raw["navigation.speedOverGround"] !== undefined) {
            const vmg = Math.abs(stwKts * Math.cos(store.raw["environment.wind.angleTrueWater"] || 0));
            manageHistory('vmg', vmg); manageHistory('sog', sogKts);
            
            const labelEl = document.getElementById('sog-vmg-label');
            if (displayModeSog === 'VMG') {
                ui.sog.innerText = vmg.toFixed(1);
                ui.sog.style.setProperty('color', '#16a085', 'important'); // Verde Petrolio
                if (labelEl) labelEl.textContent = 'VMG';
            } else {
                ui.sog.innerText = sogKts.toFixed(1);
                if (labelEl) labelEl.textContent = 'SOG';
                
                // Colore Corrente: se neutro usiamo "", così il CSS Night Mode può agire
                if (sogKts - stwKts > 0.3) ui.sog.style.setProperty('color', '#27ae60', 'important');
                else if (sogKts - stwKts < -0.3) ui.sog.style.setProperty('color', '#c0392b', 'important');
                else ui.sog.style.color = "";
            }
        }
        
        if (store.raw["environment.depth.belowTransducer"] !== undefined) {
            ui.depth.innerText = store.raw["environment.depth.belowTransducer"].toFixed(1);
            checkDepthAlarm(store.raw["environment.depth.belowTransducer"]);
            manageHistory('depth', store.raw["environment.depth.belowTransducer"]);
        }

        if (store.raw["environment.wind.speedTrue"] !== undefined) {
            const twsKts = msToKts(store.raw["environment.wind.speedTrue"]);
            ui.tws.innerText = twsKts.toFixed(1);
            
            // Colore Reef: se normale usiamo "", il CSS metterà Nero (giorno) o Rosso (notte)
            if (twsKts >= CONFIG.graphs.reef2) ui.tws.style.setProperty('color', '#e74c3c', 'important');
            else if (twsKts >= CONFIG.graphs.reef1) ui.tws.style.setProperty('color', '#e67e22', 'important');
            else ui.tws.style.color = "";

            manageHistory('tws', twsKts);
        }

        if (store.raw["environment.wind.speedApparent"] !== undefined) {
            ui.awsSvg.textContent = msToKts(store.raw["environment.wind.speedApparent"]).toFixed(1);
        }

        // --- PUNTATORI ANALOGICI (Smoothing 2s) ---
        const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, 2000, true);
        const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, 2000, true);
        if (smAwa) { curAwaRot = getShortestRotation(curAwaRot, radToDeg(smAwa.val)); ui.awa.setAttribute('transform', `rotate(${curAwaRot}, 200, 200)`); }
        if (smTwa) { curTwaRot = getShortestRotation(curTwaRot, radToDeg(smTwa.val)); ui.twa.setAttribute('transform', `rotate(${curTwaRot}, 200, 200)`); }
        
        // --- CALCOLO LEEWAY E TRACK POINTER ---
        if (store.raw["navigation.courseOverGroundTrue"] !== undefined && store.raw["navigation.headingTrue"] !== undefined) {
            let driftDeg = radToDeg((store.raw["navigation.courseOverGroundTrue"] - store.raw["navigation.headingTrue"] + Math.PI * 3) % (Math.PI * 2) - Math.PI);
            // Azzeramento sotto soglia minima impostata
            smoothedLeeway = (sogKts < CONFIG.averages.minSpeed) ? 0 : (smoothedLeeway * 0.9) + (driftDeg * 0.1);
            curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway); ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
            ui.leewayVal.style.color = (Math.abs(sogKts - stwKts) > 0.5 && Math.abs(smoothedLeeway) > 7) ? "#e67e22" : "";
            updateLeewayDisplay(Math.max(-20, Math.min(20, smoothedLeeway)));
        }
        
        updateWindTrend();

        // TIER HEAVY (2s) - Grafici e Persistenza Browser
        if (lastAvgUIUpdate++ % 2 === 0) {
            ['stw', 'sog', 'depth', 'tws'].forEach(refreshGraph);
            saveDashboardState();
        }

        // TIER SLOW (3s) - Medie Lunghe e Calcolo TACK
        if (lastAvgUIUpdate % 3 === 0) {
            let hObj = getCircularAverageFromBuffer(store.longBuf.hdg, CONFIG.averages.longWindow * 2, false);
            let cObj = getCircularAverageFromBuffer(store.longBuf.cog, CONFIG.averages.longWindow, false);
            let awObj = getCircularAverageFromBuffer(store.longBuf.awa, CONFIG.averages.longWindow, true);
            let twObj = getCircularAverageFromBuffer(store.longBuf.twa, CONFIG.averages.longWindow, true);
            let twdObj = getCircularAverageFromBuffer(store.longBuf.twd, CONFIG.averages.longWindow, false);

            upUI(ui.hdg, hObj, store.raw["navigation.headingTrue"], true);
            upUI(ui.cog, cObj, store.raw["navigation.courseOverGroundTrue"], true);
            upUI(ui.awaAvg, awObj, store.raw["environment.wind.angleApparent"], false);
            upUI(ui.twaAvg, twObj, store.raw["environment.wind.angleTrueWater"], false);
            upUI(ui.twdAvg, twdObj, store.raw["environment.wind.directionTrue"], true);

            // --- LOGICA TACK STRATEGICA (Riflessione geometrica su TWD) ---
            if (hObj && twdObj) {
                const tH = radToDeg((2 * twdObj.val - hObj.val + Math.PI * 2) % (Math.PI * 2));
                const unstableH = !hObj.stable || !twdObj.stable || hObj.dev > CONFIG.averages.stabilityBreakout || twdObj.dev > CONFIG.averages.stabilityBreakout;

                if (!isNavigating) {
                    ui.tackHdg.innerHTML = "---&deg;"; ui.tackHdg.classList.remove('unstable-data');
                } else if (unstableH) {
                    ui.tackHdg.innerHTML = "---&deg;"; ui.tackHdg.classList.add('unstable-data');
                } else {
                    ui.tackHdg.innerHTML = `${Math.round((tH + 360) % 360).toString().padStart(3, '0')}&deg;`;
                    ui.tackHdg.classList.remove('unstable-data');
                }

                if (cObj) {
                    const tC = radToDeg((2 * twdObj.val - cObj.val + Math.PI * 2) % (Math.PI * 2));
                    const unstableC = !cObj.stable || !twdObj.stable || cObj.dev > CONFIG.averages.stabilityBreakout || twdObj.dev > CONFIG.averages.stabilityBreakout;
                    
                    if (!isNavigating) {
                        ui.tackCog.innerHTML = "---&deg;"; ui.tackCog.classList.remove('unstable-data');
                    } else if (unstableC) {
                        ui.tackCog.innerHTML = "---&deg;"; ui.tackCog.classList.add('unstable-data');
                    } else {
                        ui.tackCog.innerHTML = `${Math.round((tC + 360) % 360).toString().padStart(3, '0')}&deg;`;
                        ui.tackCog.classList.remove('unstable-data');
                    }
                }
            }
            
            // Rotazione Mini-Bussole
            const smHdgIcons = getCircularAverageFromBuffer(store.smoothBuf.hdg, 2000, false);
            const smTwdIcons = getCircularAverageFromBuffer(store.smoothBuf.twd, 2000, false);
            if (smHdgIcons && smTwdIcons) {
                curWindCompassRot = getShortestRotation(curWindCompassRot, radToDeg(smTwdIcons.val)); ui.twdArrow.setAttribute('transform', `rotate(${curWindCompassRot}, 20, 20)`);
                curBoatCompassRot = getShortestRotation(curBoatCompassRot, radToDeg(smHdgIcons.val)); ui.twdBoat.setAttribute('transform', `rotate(${curBoatCompassRot}, 20, 20)`);
            }
        }
    }, RENDER_INTERVAL_MS);
}

// ==========================================================================
// 8. CONFIGURAZIONE E GRAFICI UTILS
// ==========================================================================
/**
 * Recupera la configurazione tramite le API ufficiali di Signal K.
 * Sovrascrive i default locali con i parametri impostati nel server.
 */
async function fetchServerConfig() {
    // Evita di cercare il server se siamo in locale (file://)
    if (!window.location.protocol.includes("http")) return;
    
    // Percorsi API ufficiali di Signal K per i plugin
    const urls = [
        '/signalk/v1/api/plugins/rotevista-dash',
        '/signalk/v1/api/plugins/@sailingrotevista%2frotevista-dash'
    ];

    for (let url of urls) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                
                // Nelle API SK, i dati utente sono spesso in 'data.enabled' o 'data.settings'
                // Noi cerchiamo l'oggetto che contiene le nostre chiavi (alarms, averaging, ecc.)
                const actual = data.settings || data.configuration || data.options || data;
                
                if (actual && (actual.alarms || actual.averaging || actual.graphs)) {
                    // FUNZIONE DI PARSING: Trasforma eventuali testi "12.5" in numeri 12.5 reali
                    const parseNumbers = (obj) => {
                        for (let k in obj) {
                            if (typeof obj[k] === 'object') parseNumbers(obj[k]);
                            else if (!isNaN(obj[k]) && obj[k] !== "" && typeof obj[k] === 'string') {
                                obj[k] = parseFloat(obj[k]);
                            }
                        }
                    };
                    parseNumbers(actual);

                    // MAPPATURA DEI PARAMETRI NEL CONFIG LOCALE
                    if (actual.alarms) CONFIG.alarms = { ...CONFIG.alarms, ...actual.alarms };
                    if (actual.graphs) CONFIG.graphs = { ...CONFIG.graphs, ...actual.graphs };
                    if (actual.averaging) CONFIG.averages = { ...CONFIG.averages, ...actual.averaging };
                    if (actual.scales) {
                        for (let k in actual.scales) {
                            CONFIG.scales[k] = { ...CONFIG.scales[k], ...actual.scales[k] };
                        }
                    }
                    console.log("✅ Configurazione caricata correttamente da:", url);
                    return; // Successo: usciamo dal ciclo dei tentativi
                }
            } else if (response.status === 401) {
                console.error("❌ Errore 401: Accesso negato. Abilita 'Anonymous Read' in Signal K Security.");
            }
        } catch (e) {
            console.warn(`⚠️ Tentativo fallito su ${url}:`, e.message);
        }
    }
}

function manageHistory(t, v) {
    const n = Date.now(), interval = (CONFIG.graphs.historyMinutes * 60000) / CONFIG.graphs.samples;
    if (!store.graphTempBuf[t]) store.graphTempBuf[t] = [];
    store.graphTempBuf[t].push(v);
    if (n - store.lastUpdates[t] > interval || store.histories[t].length === 0) {
        const avg = store.graphTempBuf[t].reduce((a, b) => a + b, 0) / store.graphTempBuf[t].length;
        store.histories[t].push(avg);
        if (store.histories[t].length > CONFIG.graphs.samples) store.histories[t].shift();
        store.graphTempBuf[t] = []; store.lastUpdates[t] = n;
    }
}

function calculateScale(type, data, mode) {
    const s = CONFIG.scales[type]; let aMin = Math.min(...data), aMax = Math.max(...data);
    if (mode === 'hercules') {
        let avg = (aMin + aMax) / 2; let span = Math.max(s.hercSpan, Math.ceil(aMax - aMin));
        if (span % 2 !== 0) span += 1; let min = Math.max(0, Math.floor(avg - (span / 2)));
        return { min, max: min + span };
    }
    return { min: 0, max: Math.max(s.stdMax, Math.ceil(aMax / s.step) * s.step) };
}

function updateScaleLabels(t, min, max) { const el = document.getElementById(t + '-scale'); if (el) el.innerHTML = `<span>${Math.round(max)}</span><span>${Math.round((min+max)/2)}</span><span>${Math.round(min)}</span>`; }

function drawGraph(d, id, min, max, isTws, isHercules) {
    const svg = document.getElementById(id); if (!svg || d.length < 2) return;
    const w = 200, h = 40, range = max - min || 1;
    let grids = ""; [0.25, 0.5, 0.75].forEach(p => { grids += `<line x1="0" y1="${h-(p*h)}" x2="${w}" y2="${h-(p*h)}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5" />`; });
    /**
     * Griglia Temporale Intelligente:
     * - Storia <= 15 min: linee ogni 1 minuto.
     * - Storia > 15 min: linee ogni 5 minuti.
     */
    const gridInterval = (CONFIG.graphs.historyMinutes <= 15) ? 1 : 5;

    for (let m = gridInterval; m < CONFIG.graphs.historyMinutes; m += gridInterval) {
        const x = w - (m / CONFIG.graphs.historyMinutes) * w;
        grids += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(0,0,0,0.08)" stroke-width="0.5" />`;
    }
    let pD = ""; let cS = "";
    d.forEach((v, i) => {
        const x = (i/(CONFIG.graphs.samples-1))*w, y = h-(Math.max(0,Math.min(1,(v-min)/range))*h); pD += `${i===0?'M':'L'} ${x} ${y} `;
        if (isTws && i > 0) {
            const px = ((i-1)/(CONFIG.graphs.samples-1))*w, py = h-(Math.max(0,Math.min(1,(d[i-1]-min)/range))*h);
            let c = (v >= CONFIG.graphs.reef2) ? "#e74c3c" : (v >= CONFIG.graphs.reef1 ? "#e67e22" : "#000");
            cS += `<line x1="${px}" y1="${py}" x2="${x}" y2="${y}" stroke="${c}" class="tws-reef-line ${isHercules?'line-hercules':''}" />`;
        }
    });
    const clrs = { 'stw-graph': '#2ecc71', 'sog-graph': '#f39c12', 'depth-graph': '#3498db', 'tws-graph': '#000' };
    const colorKey = id === 'sog-graph' && displayModeSog === 'VMG' ? '#16a085' : clrs[id];
    svg.innerHTML = isTws ? `${grids}<path d="${pD} L ${((d.length-1)/(CONFIG.graphs.samples-1))*w} ${h} L 0 ${h} Z" fill="rgba(0,0,0,0.05)" stroke="none" />${cS}` : `${grids}<path d="${pD} L ${((d.length-1)/(CONFIG.graphs.samples-1))*w} ${h} L 0 ${h} Z" fill="${colorKey}22" stroke="none" /><path d="${pD}" class="${isHercules?'line-hercules':''}" fill="none" stroke="${colorKey}" />`;
}

// ==========================================================================
// 9. INTERAZIONI E GESTI
// ==========================================================================
function toggleFocusMode(type, element) {
    const container = document.querySelector('.main-container');
    const isLeft = ['stw', 'sog', 'hdg', 'cog', 'tack'].includes(type);
    isFocusActive = !isFocusActive;
    if (isFocusActive) { container.classList.add('focus-active', isLeft ? 'focus-side-left' : 'focus-side-right'); element.classList.add('is-focused'); }
    else { container.classList.remove('focus-active', 'focus-side-left', 'focus-side-right'); document.querySelectorAll('.data-box').forEach(b => b.classList.remove('is-focused')); }
}

['stw', 'sog', 'tws', 'depth'].forEach(type => {
    const el = document.getElementById(type + '-graph').closest('.data-box');
    let lastTapTime = 0, tapTimeout, isLongPressActive = false;
    el.addEventListener('pointerdown', (e) => { isLongPressActive = false; pressTimer = setTimeout(() => { if (!isFocusActive) { isLongPressActive = true; toggleFocusMode(type, el); lastTapTime = 0; } }, 1000); });
    el.addEventListener('pointerup', (e) => {
        clearTimeout(pressTimer); if (isLongPressActive) return;
        const currentTime = new Date().getTime(), tapDelay = currentTime - lastTapTime;
        if (tapDelay < 300 && tapDelay > 0) { clearTimeout(tapTimeout); graphModes[type] = (graphModes[type] === 'standard') ? 'hercules' : 'standard'; localStorage.setItem('mode_' + type, graphModes[type]); refreshGraph(type); lastTapTime = 0; }
        else { lastTapTime = currentTime; tapTimeout = setTimeout(() => { if (isFocusActive && el.classList.contains('is-focused')) toggleFocusMode(type, el); else if (!isFocusActive && type === 'sog') { displayModeSog = (displayModeSog === 'SOG') ? 'VMG' : 'SOG'; el.style.backgroundColor = "rgba(0, 0, 0, 0.05)"; setTimeout(() => el.style.backgroundColor = "", 150); } }, 250); }
    });
    el.addEventListener('pointerleave', () => clearTimeout(pressTimer));
});

if (ui.hotspot) {
    ui.hotspot.addEventListener('pointerdown', (e) => { pressTimer = setTimeout(() => { document.body.classList.toggle('night-mode'); ui.hotspot.style.opacity = "0.5"; setTimeout(() => ui.hotspot.style.opacity = "1", 200); pressTimer = null; }, 1000); });
    ui.hotspot.addEventListener('pointerup', (e) => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; const doc = document.documentElement; if (document.fullscreenElement) document.exitFullscreen(); else doc.requestFullscreen(); } });
    ui.hotspot.addEventListener('pointerleave', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
}

// ==========================================================================
// 10. SIMULAZIONE E RETE
// ==========================================================================
function startDynamicSimulation() {
    ui.status.innerText = "SIM ATTIVO";
    let sim = { hdg: 45, tws: 12, twd: 90, depth: 12, stw: 5, startTime: Date.now() };
    simInterval = setInterval(() => {
        const elapsed = (Date.now() - sim.startTime) / 1000;
        sim.twd = (sim.twd + (Math.sin(elapsed / 20) * 0.5) + 360) % 360;
        const targetTws = 10 + Math.sin(elapsed / 10) * 2;
        sim.tws += (targetTws - sim.tws) * 0.05; sim.hdg = (sim.hdg + (Math.random() - 0.5) * 1 + 360) % 360;
        let twaRel = (sim.twd - sim.hdg + 360) % 360; if (twaRel > 180) twaRel -= 360;
        let targetStw = 5; sim.stw += (targetStw - sim.stw) * 0.05;
        processIncomingData("navigation.headingTrue", degToRad(sim.hdg));
        processIncomingData("environment.wind.speedApparent", ktsToMs(sim.stw + 2));
        processIncomingData("environment.wind.angleApparent", degToRad(twaRel + 5));
        processIncomingData("environment.depth.belowTransducer", sim.depth);
        processIncomingData("navigation.speedThroughWater", ktsToMs(sim.stw));
        processIncomingData("navigation.speedOverGround", ktsToMs(sim.stw));
        processIncomingData("navigation.courseOverGroundTrue", degToRad(sim.hdg));
    }, 1000);
}

function connect() {
    if (simulationMode) return;
    let addr = window.location.host || CONFIG.server.fallbackIp;
    try {
        socket = new WebSocket(`ws://${addr}/signalk/v1/stream?subscribe=self`);
        socket.onopen = () => { ui.status.className = "online"; ui.status.innerText = "ONLINE"; reconnectDelay = 1000; };
        socket.onmessage = (e) => { const d = JSON.parse(e.data); if (d.updates) d.updates.forEach(u => u.values && u.values.forEach(v => processIncomingData(v.path, v.value))); };
        socket.onclose = () => { if (!simulationMode) { ui.status.className = "offline"; ui.status.innerText = "RECONNECTING..."; setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 1.5, 10000); } };
    } catch (e) { setTimeout(connect, reconnectDelay); }
}

// ==========================================================================
// 11. INIT E CICLO DI VITA
// ==========================================================================
window.addEventListener('contextmenu', e => e.preventDefault(), true);
(function genTicks() {
    const c = document.getElementById('ticks');
    if (c) {
        for (let i = 0; i < 360; i += 10) {
            const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
            const m = i % 30 === 0;
            l.setAttribute("x1", "200"); l.setAttribute("y1", "40"); l.setAttribute("x2", "200"); l.setAttribute("y2", (m ? 60 : 50));
            l.setAttribute("stroke", m ? "#000" : "#bbb"); l.setAttribute("stroke-width", m ? "2" : "1");
            l.setAttribute("transform", `rotate(${i}, 200, 200)`); c.appendChild(l);
        }
    }
})();

async function init() {
    loadDashboardState();
    await fetchServerConfig();
    startDisplayLoop();
    connect();
}

window.addEventListener('load', init);
window.addEventListener('pagehide', saveDashboardState);
