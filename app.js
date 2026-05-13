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
    alarms: { depthDanger: 2.5, depthWarning: 3.5 },
    averaging: {
        smoothWindow: 2000,
        longWindow: 30000,
        stabilityTolerance: 2000,
        stabilityThreshold: 0.99,
        minSpeed: 0,
        stabilityBreakout: 15
    },
    graphs: { reef1: 10, reef2: 15, historyMinutes: 10, samples: 60 },
    scales: {
        stw: { stdMax: 8, hercSpan: 4, step: 2 },
        sog: { stdMax: 8, hercSpan: 4, step: 2 },
        tws: { stdMax: 15, hercSpan: 10, step: 5 },
        depth: { stdMax: 8, hercSpan: 5, step: 5 }
    },
    server: { fallbackIp: "192.168.111.240:3000" }
};

const RENDER_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5000;
const SIM_SAMPLE_INTERVAL = 1000;
const DASH_VERSION = "3.0"; // Versione della memoria locale
const sourceLocks = {};


// ==========================================================================
// 2. STATO GLOBALE E RIFERIMENTI UI
// ==========================================================================
let simulationMode = false;
let displayModeSog = 'SOG';
let displayModeTws = 'TWS';
let socket, renderInterval, simInterval;
let lastAvgUIUpdate = 0, audioCtx = null, lastAlarmTime = 0;
let curAwaRot = 0, curTwaRot = 0, curTrackRot = 0, curTwdRoseRot = 0;
let curBoatCompassRot = 0, curWindCompassRot = 0;

let smoothedLeeway = 0, rotationTrend = 0, meteoTrend = 0;
let lastShortAvgVal = null, lastInstantTwa = null;
let lastTrendTime = Date.now(), lastGybeAlarmTime = 0, lastTWCompute = 0;
let twDirty = false, isNavigating = false, reconnectDelay = 1000;

let pressTimer, isFocusActive = false;

let emaTwaSin = 0;
let emaTwaCos = 0;
let firstEmaRun = true;

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
    histories: { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [] },
    // Buffer temporaneo per il calcolo della media dell'intervallo del grafico
    graphTempBuf: { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [] },
    lastUpdates: { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0 }
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
/**
 * Inserimento sicuro nel buffer con trigonometria precaricata e pruning automatico
 */
function safePush(buffer, val, time) {
    // --- PROTEZIONE ANTI-NaN (FONDAMENTALE ALL'AVVIO) ---
    // Se il valore è nullo, non definito o non è un numero, ignoriamo l'inserimento
    if (val === null || val === undefined || isNaN(val)) return;

    buffer.push({
        val: val,
        time: time,
        sin: Math.sin(val),
        cos: Math.cos(val)
    });

    // Teniamo sempre in memoria il DOPPIO della storia impostata (per la modalità ancoraggio)
    // + 1 minuto di margine
    const maxHistoryMs = (CONFIG.graphs.historyMinutes * 60000 * 2) + 60000;

    while (buffer.length > 0 && (time - buffer[0].time) > maxHistoryMs) {
        buffer.shift();
    }

    // Tetto massimo di campioni per sicurezza (circa 2 ore a 5Hz)
    if (buffer.length > 36000) buffer.shift();
}

/**
 * Media Circolare Vettoriale - Versione "Soft Outlier Rejection"
 * Riduce l'impatto degli sbalzi limitando il loro angolo massimo di discostamento.
 */
function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false, now) {
    now = now || Date.now();
    const len = bufferArray.length;
    if (len === 0) return null;

    let sSin = 0, sCos = 0, count = 0;
    let newestTime = 0, oldestTime = 0;

    // 1. MEDIA PILOTA: Guardiamo l'ultima frazione di dati (es. max 15 campioni) per sapere dove punta "ora"
    let pilotSin = 0, pilotCos = 0;
    const pilotSamples = Math.min(len, 15);
    for (let i = len - 1; i >= len - pilotSamples; i--) {
        pilotSin += bufferArray[i].sin;
        pilotCos += bufferArray[i].cos;
    }
    const pilotRad = Math.atan2(pilotSin, pilotCos);

    // Il limite elastico in radianti (basato sul tuo stabilityBreakout in gradi)
    const limitRad = (CONFIG.averaging.stabilityBreakout || 15) * (Math.PI / 180);

    // 2. CALCOLO AMMORTIZZATO
    for (let i = len - 1; i >= 0; i--) {
        const item = bufferArray[i];
        if ((now - item.time) > windowMs) break;

        // Troviamo la differenza angolare (da -Pi a +Pi) tra il dato e la Media Pilota
        let diffRad = Math.atan2(
            Math.sin(item.val - pilotRad),
            Math.cos(item.val - pilotRad)
        );

        let finalSin, finalCos;

        // Se lo scarto è maggiore del limite, "Pattiniamo" (Ammortizzazione)
        if (Math.abs(diffRad) > limitRad) {
            // Tronchiamo la differenza al limite massimo consentito (mantenendo il segno)
            const clampedDiff = Math.sign(diffRad) * limitRad;
            // Ricalcoliamo l'angolo ammortizzato
            const clampedRad = pilotRad + clampedDiff;
            
            finalSin = Math.sin(clampedRad);
            finalCos = Math.cos(clampedRad);
        } else {
            // Il dato è buono, usiamo i valori precalcolati
            finalSin = item.sin;
            finalCos = item.cos;
        }

        sSin += finalSin;
        sCos += finalCos;

        if (count === 0) newestTime = item.time;
        oldestTime = item.time;
        count++;
    }

    if (count === 0) return null;

    const R = Math.hypot(sSin, sCos) / count;
    const avgRad = Math.atan2(sSin, sCos);
    const finalVal = signed ? avgRad : (avgRad + Math.PI * 2) % (Math.PI * 2);
    const historyDuration = (count > 2) ? (newestTime - oldestTime) : 0;
    const safeR = Math.max(R, 1e-9);

    return {
        val: finalVal,
        stable: historyDuration > 10000 && R > CONFIG.averaging.stabilityThreshold,
        dev: (R < 1) ? Math.round(Math.sqrt(-2 * Math.log(safeR)) * (180 / Math.PI)) : 0,
        samples: count
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
            displayModeTws: displayModeTws,
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
            
            // Ripristino TWS/AWS ---
            if (state.displayModeTws) {
                displayModeTws = state.displayModeTws;
                const labelEl = document.getElementById('tws-aws-label');
                if (labelEl) labelEl.textContent = displayModeTws;
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
    // Rimuoviamo sempre le classi prima di riapplicarle
    ui.depth.classList.remove('alarm-warning', 'alarm-danger', 'blink-alarm');
    
    // Logica di confronto dinamica
    if (m < CONFIG.alarms.depthDanger) {
        ui.depth.classList.add('alarm-danger', 'blink-alarm');
        playBingBing(); // Il tuo suono di allarme
    } else if (m < CONFIG.alarms.depthWarning) {
        ui.depth.classList.add('alarm-warning');
    }
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

function processIncomingData(path, val, source) {
    const now = Date.now();

    // --- 1. FILTRO SORGENTE STICKY (Elimina conflitti yacht_device vs Unknown) ---
    if (!sourceLocks[path] || sourceLocks[path].label === source || (now - sourceLocks[path].lastSeen > 2000)) {
        sourceLocks[path] = { label: source, lastSeen: now };
    } else {
        // Se arriva un dato da un'altra sorgente mentre il lock è attivo, lo scartiamo
        return;
    }

    // --- 2. AGGIORNAMENTO DATI (Solo per la sorgente eletta) ---
    store.timestamps[path] = now;
    store.raw[path] = val;

    // Buffer per AWA (Vento Apparente)
    if (path === "environment.wind.angleApparent") {
        safePush(store.smoothBuf.awa, val, now);
        safePush(store.longBuf.awa, val, now);
    }
    
    // Buffer per HDG (Prua)
    if (path === "navigation.headingTrue") {
        safePush(store.smoothBuf.hdg, val, now);
        safePush(store.longBuf.hdg, val, now);
    }

    // Buffer per COG (Rotta Fondo)
    if (path === "navigation.courseOverGroundTrue") {
        safePush(store.smoothBuf.cog, val, now);
        safePush(store.longBuf.cog, val, now);
    }

    // --- 3. TRIGGER CALCOLO VENTO REALE (TWA/TWS/TWD) ---
    const twPaths = [
        "environment.wind.speedApparent",
        "environment.wind.angleApparent",
        "navigation.speedThroughWater",
        "navigation.speedOverGround",
        "navigation.headingTrue",
        "navigation.courseOverGroundTrue"
    ];

    if (twPaths.includes(path)) {
        twDirty = true;
        // Calcolo limitato a 10Hz per non pesare sulla CPU
        if (twDirty && (now - lastTWCompute > 100)) {
            computeTrueWind();
            lastTWCompute = now;
            twDirty = false;
        }
    }
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
    const multiplier = isNavigating ? 1 : 2;
    const strategicWindowMs = CONFIG.graphs.historyMinutes * 60000 * multiplier;
    const twdRef = getCircularAverageFromBuffer(store.longBuf.twd, strategicWindowMs, false);
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

    // --- LOGICA ALLARME STRAMBATA (GYBE) FILTRATA ---
        const instTwaRad = store.raw["environment.wind.angleTrueWater"];
        
        if (instTwaRad !== undefined) {
            // Calcolo Alfa basato sulla Steering Precision (più precisione = filtro più lento e stabile)
            const dynamicAlpha = Math.max(0.05, 1.1 - CONFIG.averaging.stabilityThreshold);

            const currentSin = Math.sin(instTwaRad);
            const currentCos = Math.cos(instTwaRad);

            if (firstEmaRun) {
                emaTwaSin = currentSin;
                emaTwaCos = currentCos;
                firstEmaRun = false;
            } else {
                // Media Esponenziale Vettoriale
                emaTwaSin = (currentSin * dynamicAlpha) + (emaTwaSin * (1 - dynamicAlpha));
                emaTwaCos = (currentCos * dynamicAlpha) + (emaTwaCos * (1 - dynamicAlpha));
            }

            // Angolo risultante filtrato
            const smoothedTwaDeg = radToDeg(Math.atan2(emaTwaSin, emaTwaCos));

            // Verifichiamo il cambio di mure (> 155° e inversione di segno confermata dal filtro)
            if (Math.abs(smoothedTwaDeg) > 155) {
                if (Math.sign(smoothedTwaDeg) !== Math.sign(lastInstantTwa) && lastInstantTwa !== null) {
                    if (isNavigating && (now - lastGybeAlarmTime > 60000)) {
                        lastGybeAlarmTime = now;
                        playGybeAlarm();
                        console.log(`⚠️ GYBE ALARM: TWA ${smoothedTwaDeg.toFixed(1)}°`);
                    }
                }
            }
            lastInstantTwa = smoothedTwaDeg;
        }
}

// ==========================================================================
// 7. RENDERING ENGINE E AGGIORNAMENTO UI
// ==========================================================================
/**
 * refreshGraph: Recupera i dati corretti dallo store e coordina il disegno del grafico.
 * Gestisce lo switch tra TWS/AWS e la mappatura VMG -> SOG.
 *
 * @param {string} t - Il tipo di dato da aggiornare ('stw', 'sog', 'depth', 'tws', 'vmg')
 */
function refreshGraph(t) {
    // 1. Mappatura del box UI: il VMG condivide il riquadro fisico del SOG
    const boxType = (t === 'vmg') ? 'sog' : t;

    // 2. Selezione della sorgente dati corretta
    let data;
    if (t === 'tws' && displayModeTws === 'AWS') {
        // Se siamo nel box vento e la modalità è AWS, carichiamo la storia dell'apparente
        data = store.histories['aws'];
    } else {
        // Altrimenti carichiamo la storia standard (TWS, STW, SOG, Depth, VMG)
        data = store.histories[t];
    }

    // 3. Controllo integrità: se non ci sono dati sufficienti, non disegniamo nulla
    if (!data || data.length < 2) return;

    // 4. Configurazione Scala: recupera la modalità (standard/hercules) e calcola min/max
    const mode = graphModes[boxType];
    const cfg = calculateScale(boxType, data, mode);
    
    // 5. Aggiornamento estetico del Box: aggiunge lo sfondo speciale se in modalità Hercules
    const box = document.querySelector(`.box-${boxType}`);
    if (box) {
        box.classList.toggle('box-hercules', mode === 'hercules');
    }
    
    // 6. Aggiornamento etichette numeriche della scala (Y-axis)
    updateScaleLabels(boxType, cfg.min, cfg.max);

    // 7. Render finale del grafico SVG
    // Il parametro 't === tws' indica a drawGraph di attivare la logica dei colori Reef (Rosso/Arancio)
    drawGraph(
        data,
        boxType + '-graph',
        cfg.min,
        cfg.max,
        t === 'tws',
        mode === 'hercules'
    );
}

/**
 * upUI: Aggiornamento valori digitali con logica anti-ritardo (Istantaneo vs Media)
 */
const upUI = (el, obj, instantRaw, isCompass = false) => {
    if (!obj || obj.val === null || isNaN(obj.val) || instantRaw === undefined) {
            el.innerHTML = "---&deg;"; 
            el.classList.remove('unstable-data');
    } else {
        let valDeg = Math.round(radToDeg(obj.val));
        let mainVal = (isCompass ? ((valDeg + 360) % 360).toString().padStart(3, '0') : valDeg) + "&deg;";
        let dev = (obj.dev > 1 && obj.dev < 90) ? `<span style="font-size: 0.8em; opacity: 0.4; margin-left: 6px;">&plusmn;${obj.dev}</span>` : "";
        el.innerHTML = mainVal + dev;
        
        let diff = Math.abs((radToDeg(instantRaw) - radToDeg(obj.val) + 540) % 360 - 180);
        // Allarme lampeggio solo se in navigazione E (R bassa O deviazione alta O salto istantaneo brusco)
        if (isNavigating && (!obj.stable || obj.dev > CONFIG.averaging.stabilityBreakout || diff > CONFIG.averaging.stabilityBreakout)) el.classList.add('unstable-data');
        else el.classList.remove('unstable-data');
    }
};

/**
 * Loop principale di aggiornamento interfaccia (1Hz)
 * Gestisce la gerarchia di aggiornamento Live (1s), Heavy (2s) e Slow (3s).
 */
function startDisplayLoop() {
    renderInterval = setInterval(() => {
        const now = Date.now();
        const isNight = document.body.classList.contains('night-mode');
        
        // Conversione velocità da m/s a Nodi
        const stwKts = msToKts(store.raw["navigation.speedThroughWater"] || 0);
        const sogKts = msToKts(store.raw["navigation.speedOverGround"] || 0);
        
        // Verifica stato navigazione basato su soglia impostata (minSpeed)
        isNavigating = stwKts > CONFIG.averaging.minSpeed || sogKts > CONFIG.averaging.minSpeed;

        // --- TIER LIVE (1s): CONTROLLO TIMEOUT DATI ---
        // Se un dato non arriva da più di 5 secondi, mostra i trattini
        const watch = {
            "navigation.speedThroughWater": ui.stw,
            "navigation.speedOverGround": ui.sog,
            "navigation.headingTrue": ui.hdg,
            "navigation.courseOverGroundTrue": ui.cog,
            "environment.wind.speedApparent": ui.awsSvg,
            "environment.depth.belowTransducer": ui.depth,
            "environment.wind.speedTrue": ui.tws
        };
        for (let p in watch) {
            if (!store.timestamps[p] || (now - store.timestamps[p] > TIMEOUT_MS)) {
                watch[p].innerText = "---"; delete store.raw[p];
            }
        }

        // --- AGGIORNAMENTO VELOCITÀ SULL'ACQUA (STW) ---
        if (store.raw["navigation.speedThroughWater"] !== undefined) {
            ui.stw.innerText = stwKts.toFixed(1);
            // Colore neutro (ereditato dal tema) perché non ha switch di modalità
            ui.stw.style.color = "";
            manageHistory('stw', stwKts);
        }
        
        // --- LOGICA SOG / VMG (COLORI DINAMICI E FILTRO NAVIGAZIONE) ---
        if (store.raw["navigation.speedOverGround"] !== undefined) {
            // Calcolo VMG istantanea per il display numerico
            const vmg = Math.abs(stwKts * Math.cos(store.raw["environment.wind.angleTrueWater"] || 0));
            
            // Registriamo i dati nelle storie (per i grafici)
            manageHistory('vmg', vmg);
            manageHistory('sog', sogKts);
            
            const labelEl = document.getElementById('sog-vmg-label');
            
            if (displayModeSog === 'VMG') {
                // MODALITÀ VMG: Mostra valore istantaneo, colore Cyan fisso per identificare la modalità
                ui.sog.innerText = vmg.toFixed(1);
                ui.sog.style.setProperty('color', '#00b8d4', 'important');
                if (labelEl) labelEl.textContent = 'VMG';
            } else {
                // MODALITÀ SOG: Mostra valore istantaneo
                ui.sog.innerText = sogKts.toFixed(1);
                if (labelEl) labelEl.textContent = 'SOG';
                
                // --- LOGICA COLORE DINAMICO (Solo se in navigazione reale) ---
                if (isNavigating) {
                    // Usiamo la media dell'ultimo punto del grafico per stabilizzare il colore (anti-onda)
                    const lastAvgSog = store.histories.sog.length > 0 ? store.histories.sog[store.histories.sog.length - 1] : sogKts;
                    const lastAvgStw = store.histories.stw.length > 0 ? store.histories.stw[store.histories.stw.length - 1] : stwKts;
                    const deltaCurrent = lastAvgSog - lastAvgStw;

                    if (deltaCurrent < -0.3) {
                        // CORRENTE CONTRO: Rosso Vivido
                        ui.sog.style.setProperty('color', '#ff3b30', 'important');
                    } else if (deltaCurrent > 0.3) {
                        // CORRENTE A FAVORE: Verde Neon (Feedback Positivo)
                        ui.sog.style.setProperty('color', '#00C851', 'important');
                    } else {
                        // NEUTRO: Amber (Colore base della linea SOG)
                        ui.sog.style.setProperty('color', '#ffbb33', 'important');
                    }
                } else {
                    // NON IN NAVIGAZIONE: Riportiamo il colore al default neutro
                    ui.sog.style.color = "";
                }
            }
        }

        // --- AGGIORNAMENTO PROFONDITÀ (DEPTH) ---
        if (store.raw["environment.depth.belowTransducer"] !== undefined) {
            ui.depth.innerText = store.raw["environment.depth.belowTransducer"].toFixed(1);
            // Il colore neutro/allarme è gestito internamente dalla funzione checkDepthAlarm
            checkDepthAlarm(store.raw["environment.depth.belowTransducer"]);
            manageHistory('depth', store.raw["environment.depth.belowTransducer"]);
        }

        // --- GESTIONE VENTO (TWS / AWS SWITCH CON COLORI COORDINATI) ---
        const twsKts = store.raw["environment.wind.speedTrue"] ? msToKts(store.raw["environment.wind.speedTrue"]) : 0;
        const awsKts = store.raw["environment.wind.speedApparent"] ? msToKts(store.raw["environment.wind.speedApparent"]) : 0;
        
        // Registriamo sempre entrambe le storie per permettere lo switch fluido dei grafici
        if (store.raw["environment.wind.speedTrue"] !== undefined) manageHistory('tws', twsKts);
        if (store.raw["environment.wind.speedApparent"] !== undefined) manageHistory('aws', awsKts);

        if (store.raw["environment.wind.speedTrue"] !== undefined || store.raw["environment.wind.speedApparent"] !== undefined) {
            const labelEl = document.getElementById('tws-aws-label');
            const currentWindValue = (displayModeTws === 'AWS') ? awsKts : twsKts;
            
            ui.tws.innerText = currentWindValue.toFixed(1);
            if (labelEl) labelEl.textContent = displayModeTws;

            // Logica Colore Testo Vento (Priorità ai Reef, poi colore di base modalità)
            if (currentWindValue >= CONFIG.graphs.reef2) {
                ui.tws.style.setProperty('color', '#ff3b30', 'important'); // Rosso Reef 2
            } else if (currentWindValue >= CONFIG.graphs.reef1) {
                ui.tws.style.setProperty('color', '#ff9800', 'important'); // Arancio Reef 1
            } else {
                // Colore di base differenziato per modalità (Indaco per AWS, Navy per TWS)
                if (displayModeTws === 'AWS') {
                    ui.tws.style.setProperty('color', '#5c6bc0', 'important'); // Indigo
                } else {
                    // Per il TWS, schiariamo il Navy in modalità notte per renderlo leggibile
                    const twsColor = isNight ? '#6c8ea0' : '#2c3e50';
                    ui.tws.style.setProperty('color', twsColor, 'important');
                }
            }
        }

        // --- AGGIORNAMENTO NUMERO AWS CENTRALE (Bussola) ---
        if (store.raw["environment.wind.speedApparent"] !== undefined) {
            const awsVal = msToKts(store.raw["environment.wind.speedApparent"]);
            ui.awsSvg.textContent = awsVal.toFixed(1);
        }

        // --- PUNTATORI ANALOGICI (Smoothing 2s) ---
        const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, 2000, true);
        const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, 2000, true);
        if (smAwa) {
            curAwaRot = getShortestRotation(curAwaRot, radToDeg(smAwa.val));
            ui.awa.setAttribute('transform', `rotate(${curAwaRot}, 200, 200)`);
        }
        if (smTwa) {
            curTwaRot = getShortestRotation(curTwaRot, radToDeg(smTwa.val));
            ui.twa.setAttribute('transform', `rotate(${curTwaRot}, 200, 200)`);
        }
        
        // --- CALCOLO LEEWAY E TRACK POINTER ---
        if (store.raw["navigation.courseOverGroundTrue"] !== undefined && store.raw["navigation.headingTrue"] !== undefined) {
            let driftDeg = radToDeg((store.raw["navigation.courseOverGroundTrue"] - store.raw["navigation.headingTrue"] + Math.PI * 3) % (Math.PI * 2) - Math.PI);
            // Filtraggio scarroccio: azzeramento se barca ferma, altrimenti smoothing
            smoothedLeeway = (sogKts < CONFIG.averaging.minSpeed) ? 0 : (smoothedLeeway * 0.9) + (driftDeg * 0.1);
            curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway);
            ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
            ui.leewayVal.style.color = (Math.abs(sogKts - stwKts) > 0.5 && Math.abs(smoothedLeeway) > 7) ? "#ff9800" : "";
            updateLeewayDisplay(Math.max(-20, Math.min(20, smoothedLeeway)));
        }
        
        // Aggiorna i trend meteo/tattici (pallini) e l'allarme strambata
        updateWindTrend();

        // TIER HEAVY (2s) - Aggiornamento Grafici e Salvataggio Stato
        if (lastAvgUIUpdate++ % 2 === 0) {
            ['stw', 'sog', 'depth', 'tws'].forEach(refreshGraph);
            saveDashboardState();
        }

        // TIER SLOW (3s) - Calcolo Medie Lunghe e Tack Strategico
        if (lastAvgUIUpdate % 3 === 0) {
            let hObj = getCircularAverageFromBuffer(store.longBuf.hdg, CONFIG.averaging.longWindow * 2, false);
            let cObj = getCircularAverageFromBuffer(store.longBuf.cog, CONFIG.averaging.longWindow, false);
            let awObj = getCircularAverageFromBuffer(store.longBuf.awa, CONFIG.averaging.longWindow, true);
            let twObj = getCircularAverageFromBuffer(store.longBuf.twa, CONFIG.averaging.longWindow, true);
            let twdObj = getCircularAverageFromBuffer(store.longBuf.twd, CONFIG.averaging.longWindow, false);

            // Aggiornamento interfaccia per i valori mediati (Heading, Cog, Awa, Twa, Twd)
            upUI(ui.hdg, hObj, store.raw["navigation.headingTrue"], true);
            upUI(ui.cog, cObj, store.raw["navigation.courseOverGroundTrue"], true);
            upUI(ui.awaAvg, awObj, store.raw["environment.wind.angleApparent"], false);
            upUI(ui.twaAvg, twObj, store.raw["environment.wind.angleTrueWater"], false);
            upUI(ui.twdAvg, twdObj, store.raw["environment.wind.directionTrue"], true);

            // --- LOGICA TACK STRATEGICA (VETTORIALE) ---
            if (hObj && twdObj) {
                const reflectAngle = (targetRad, axisRad) => {
                    const dS = Math.sin(axisRad - targetRad);
                    const dC = Math.cos(axisRad - targetRad);
                    return Math.atan2(Math.sin(axisRad) * dC + Math.cos(axisRad) * dS,
                                      Math.cos(axisRad) * dC - Math.sin(axisRad) * dS);
                };
                
                const unstableH = !hObj.stable || !twdObj.stable || hObj.dev > CONFIG.averaging.stabilityBreakout;
                
                if (!isNavigating) {
                    ui.tackHdg.innerHTML = "---&deg;";
                } else if (unstableH) {
                    ui.tackHdg.innerHTML = "---&deg;"; ui.tackHdg.classList.add('unstable-data');
                } else {
                    const rH = (radToDeg(reflectAngle(hObj.val, twdObj.val)) + 360) % 360;
                    ui.tackHdg.innerHTML = `${Math.round(rH).toString().padStart(3, '0')}&deg;`;
                    ui.tackHdg.classList.remove('unstable-data');
                }
                
                if (cObj) {
                    const unstableC = !cObj.stable || !twdObj.stable || cObj.dev > CONFIG.averaging.stabilityBreakout;
                    if (!isNavigating) {
                        ui.tackCog.innerHTML = "---&deg;";
                    } else if (unstableC) {
                        ui.tackCog.innerHTML = "---&deg;"; ui.tackCog.classList.add('unstable-data');
                    } else {
                        const rC = (radToDeg(reflectAngle(cObj.val, twdObj.val)) + 360) % 360;
                        ui.tackCog.innerHTML = `${Math.round(rC).toString().padStart(3, '0')}&deg;`;
                        ui.tackCog.classList.remove('unstable-data');
                    }
                }
            }
            
            // Rotazione Mini-Icone nella bussola TWD (Mini-Bussole)
            const smHdgIcons = getCircularAverageFromBuffer(store.smoothBuf.hdg, 2000, false);
            const smTwdIcons = getCircularAverageFromBuffer(store.smoothBuf.twd, 2000, false);
            if (smHdgIcons && smTwdIcons) {
                curWindCompassRot = getShortestRotation(curWindCompassRot, radToDeg(smTwdIcons.val));
                ui.twdArrow.setAttribute('transform', `rotate(${curWindCompassRot}, 20, 20)`);
                curBoatCompassRot = getShortestRotation(curBoatCompassRot, radToDeg(smHdgIcons.val));
                ui.twdBoat.setAttribute('transform', `rotate(${curBoatCompassRot}, 20, 20)`);
            }
        }
    }, RENDER_INTERVAL_MS);
}

// ==========================================================================
// 8. CONFIGURAZIONE E GRAFICI UTILS
// ==========================================================================
/**
 * Recupera la configurazione dal server e applica migrazioni automatiche per le vecchie versioni
 */
async function fetchServerConfig() {
    try {
        const response = await fetch('/rotevista-config');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();

        // Stampa di debug per verificare cosa riceve il client
        console.log("🔍 Configurazione ricevuta dal Server:", data);

        // Merge intelligente dei dati ricevuti
        Object.assign(CONFIG.alarms, data.alarms || {});
        Object.assign(CONFIG.graphs, data.graphs || {});
        Object.assign(CONFIG.averaging, data.averaging || {});
        
        // --- LOGICA DI MIGRAZIONE SILENZIOSA ---
        // Se il valore ricevuto è il vecchio default (0.85) o inferiore, lo portiamo al nuovo standard 0.95.
        // Questo è necessario perché con i nuovi filtri "Soft" lo 0.85 non farebbe quasi mai lampeggiare gli allarmi.
        if (CONFIG.averaging.stabilityThreshold <= 0.85) {
            CONFIG.averaging.stabilityThreshold = 0.95;
            console.log("♻️ Migrazione Silenziosa: Rilevato vecchio parametro stabilità (<= 0.85). Aggiornato a 0.95 per ottimizzazione filtri.");
        }

        // Per le scale, siccome sono nidificate, facciamo un loop di merge profondo
        if (data.scales) {
            for (let key in data.scales) {
                if (CONFIG.scales[key]) Object.assign(CONFIG.scales[key], data.scales[key]);
            }
        }

        console.log("✅ Configurazione applicata. Stabilità attiva:", CONFIG.averaging.stabilityThreshold);
    } catch (err) {
        console.warn("⚠️ Utilizzo default locali. Motivo:", err.message);
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

function updateScaleLabels(t, min, max) {
    const el = document.getElementById(t + '-scale');
    if (el) el.innerHTML = `<span>${Math.round(max)}</span><span>${Math.round((min+max)/2)}</span><span>${Math.round(min)}</span>`;
}

/**
 * ==========================================================================
 * drawGraph: Motore di Rendering SVG "Tactical Precision" (Integrale)
 * ==========================================================================
 * Caratteristiche:
 * - Linea dinamica: 1.0px (base) / 1.5px (allerta).
 * - Area segmentata: colore preciso sotto i picchi (0.15 / 0.45 / 0.85).
 * - Fix Colore Bleeding: Usa 'userSpaceOnUse' per mantenere i colori al loro posto.
 * - Fix Diagonale: Chiusura verticale sull'ultimo punto reale.
 * - Palette Vivid Glass: Colori distinti per ogni modalità.
 */
/**
 * ==========================================================================
 * drawGraph: Motore di Rendering Grafico SVG "Tactical Glass" (Versione Pro)
 * ==========================================================================
 * Questa funzione trasforma un array di dati in una sparkline SVG dinamica.
 *
 * Caratteristiche principali:
 * 1. LINEA CHIRURGICA: Mantiene uno spessore di 1px costante per un look tecnico.
 * 2. AREA DINAMICA: L'area sottesa cambia colore solo sotto i picchi di allerta.
 * 3. ZERO ARTEFATTI:
 *    - Usa LinearGradients con 'userSpaceOnUse' per evitare trascinamenti di colore.
 *    - Elimina le righe verticali di giunzione tra i segmenti.
 *    - Chiude il tracciato verticalmente eliminando la "coda" diagonale finale.
 * 4. MULTI-MODALITÀ: Gestisce switch AWS/TWS, SOG/VMG e allarmi Profondità.
 */
function drawGraph(d, id, min, max, isTws, isHercules) {
    const svg = document.getElementById(id);
    
    // Uscita di sicurezza se l'elemento non esiste o non ci sono abbastanza dati
    if (!svg || d.length < 2) return;

    // --- 1. CONFIGURAZIONE GEOMETRICA E SCALA ---
    const w = 200; // Larghezza fissa del box grafico
    const h = 40;  // Altezza fissa del box grafico
    const range = max - min || 1; // Range dei valori per il calcolo dell'altezza Y
    const isDepth = (id === 'depth-graph'); // Flag specifico per il box profondità
    const samples = CONFIG.graphs.samples;  // Numero di campioni previsti (asse X)

    // --- 2. DEFINIZIONE TAVOLOZZA COLORI "VIVID GLASS" ---
    // Colori di Allerta
    const colDanger  = "#ff3b30"; // Rosso Vivido (Apple/Alert style)
    const colWarning = "#ff9800"; // Arancio Fluo (High visibility)
    
    // Colori Base (Sotto le soglie di allarme)
    const colTws     = "#2c3e50"; // Navy Slate (Vento Reale)
    const colAws     = "#5c6bc0"; // Electric Indigo (Vento Apparente)
    const colDepth   = "#0088cc"; // Ocean Blue (Profondità)
    const colStw     = "#00C851"; // Emerald Neon (Velocità Acqua)
    const colSog     = "#ffbb33"; // Amber (Velocità Fondo)
    const colVmg     = "#00b8d4"; // Cyan Vibrant (VMG)

    /**
     * getColorProps: Funzione interna per determinare lo stile di ogni punto.
     * Restituisce un oggetto con {colore, opacità area, spessore linea}.
     */
    const getColorProps = (val) => {
        // Inizializziamo con i valori di default (Dati Normali)
        let color = colTws;
        let opacity = "0.15";
        let stroke = "1"; // Spessore fisso a 1px richiesto

        // A. LOGICA PER IL VENTO (TWS o AWS)
        if (isTws) {
            // Scegliamo il colore di base a seconda se stiamo guardando Reale o Apparente
            const baseWind = (displayModeTws === 'AWS') ? colAws : colTws;
            
            if (val >= CONFIG.graphs.reef2) {
                color = colDanger; opacity = "0.55"; // Zona Pericolo
            } else if (val >= CONFIG.graphs.reef1) {
                color = colWarning; opacity = "0.45"; // Zona Attenzione
            } else {
                color = baseWind; // Zona Sicura
            }
        }
        // B. LOGICA PER LA PROFONDITÀ (Inversa: allerta se il valore scende)
        else if (isDepth) {
            if (val < CONFIG.alarms.depthDanger) {
                color = colDanger; opacity = "0.55";
            } else if (val < CONFIG.alarms.depthWarning) {
                color = colWarning; opacity = "0.45";
            } else {
                color = colDepth;
            }
        }
        // C. LOGICA PER LE VELOCITÀ (STW, SOG, VMG)
        else {
            if (id === 'stw-graph') {
                color = colStw;
            } else if (id === 'sog-graph') {
                // Il box SOG cambia colore se l'utente switcha in modalità VMG
                color = (displayModeSog === 'VMG') ? colVmg : colSog;
            }
        }
        return { color, opacity, stroke };
    };

    // --- 3. COSTRUZIONE DELLE GRIGLIE DI RIFERIMENTO ---
    let grids = "";
    // Linee orizzontali di livello (25%, 50%, 75%)
    [0.25, 0.5, 0.75].forEach(p => {
        grids += `<line x1="0" y1="${h-(p*h)}" x2="${w}" y2="${h-(p*h)}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5" />`;
    });
    // Linee verticali temporali (dinamiche in base alla storia impostata)
    const gridInterval = (CONFIG.graphs.historyMinutes <= 15) ? 1 : 5;
    for (let m = gridInterval; m < CONFIG.graphs.historyMinutes; m += gridInterval) {
        const x = w - (m / CONFIG.graphs.historyMinutes) * w;
        grids += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(0,0,0,0.08)" stroke-width="0.5" />`;
    }

    // --- 4. CICLO DI ELABORAZIONE DEI DATI ---
    let gradientStops = ""; // Contiene i cambi di colore per l'area
    let lines = "";         // Contiene i segmenti della linea superiore
    let areaPath = `M 0 ${h} `; // Inizio del path del riempimento dal fondo sinistro

    for (let i = 1; i < d.length; i++) {
        // Calcolo delle posizioni percentuali (per il gradiente) e pixel (per il disegno)
        const p1 = ((i - 1) / (samples - 1)) * 100;
        const p2 = (i / (samples - 1)) * 100;
        const x1 = ((i - 1) / (samples - 1)) * w;
        const y1 = h - (Math.max(0, Math.min(1, (d[i - 1] - min) / range)) * h);
        const x2 = (i / (samples - 1)) * w;
        const y2 = h - (Math.max(0, Math.min(1, (d[i] - min) / range)) * h);
        
        // Otteniamo lo stile per questo specifico segmento
        const props = getColorProps(d[i]);

        // AGGIUNTA STOP AL GRADIENTE:
        // Usiamo due stop identici alla stessa percentuale per creare stacchi di colore netti,
        // evitando sfumature tra una zona sicura e una di allarme.
        gradientStops += `<stop offset="${p1}%" stop-color="${props.color}" stop-opacity="${props.opacity}" />`;
        gradientStops += `<stop offset="${p2}%" stop-color="${props.color}" stop-opacity="${props.opacity}" />`;

        // DISEGNO DELLA LINEA SUPERIORE:
        // Usiamo linee individuali per poter gestire spessori e colori diversi (se necessario in futuro)
        lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" 
                 style="stroke: ${props.color}; stroke-width: ${props.stroke}; stroke-linecap: round; shape-rendering: geometricPrecision;" />`;
                 
        // AGGIORNAMENTO DEL PATH DELL'AREA:
        if (i === 1) areaPath += `L ${x1} ${y1} `; // Primo collegamento con la base
        areaPath += `L ${x2} ${y2} `; // Tracciato dei picchi
        
        // --- FIX ARTEFATTO DIAGONALE FINALE ---
        // Se siamo arrivati all'ultimo dato disponibile nel buffer, chiudiamo il path
        // scendendo verticalmente verso l'asse zero (h), poi chiudiamo con 'Z'.
        if (i === d.length - 1) {
            areaPath += `L ${x2} ${h} Z`;
        }
    }

    // --- 5. CREAZIONE DEL GRADIENTE LINEARE DINAMICO ---
    const gradId = `grad-${id}`; // ID unico basato sul box (es: grad-tws-graph)
    
    /**
     * IMPORTANTE: gradientUnits="userSpaceOnUse" fissa il gradiente alle coordinate
     * assolute (0-200px). Questo impedisce al colore di allarme di "allungarsi"
     * erroneamente se il grafico è solo a metà schermo.
     */
    const defs = `
        <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="${w}" y2="0" gradientUnits="userSpaceOnUse">
                ${gradientStops}
            </linearGradient>
        </defs>
    `;

    // --- 6. AGGIORNAMENTO FINALE DEL DOM ---
    // Inseriamo tutto nell'elemento SVG: Defs (Gradienti) -> Griglie -> Area (Fill) -> Linee (Stroke)
    svg.innerHTML = `${defs}${grids}<path d="${areaPath}" fill="url(#${gradId})" stroke="none" />${lines}`;
}

// ==========================================================================
// 9. INTERAZIONI E GESTI
// ==========================================================================
/**
 * toggleFocusMode: Gestisce l'attivazione della modalità Split-Screen (Focus).
 * Ingrandisce un box specifico e mantiene visibile la bussola centrale.
 */
function toggleFocusMode(type, element) {
    const container = document.querySelector('.main-container');
    
    // Identifica se il box appartiene alla colonna sinistra (per il layout CSS)
    const isLeft = ['stw', 'sog', 'hdg', 'cog', 'tack'].includes(type);
    
    // Inverte lo stato del Focus
    isFocusActive = !isFocusActive;

    if (isFocusActive) {
        // Applica le classi per dividere lo schermo e mettere in risalto il box
        container.classList.add('focus-active', isLeft ? 'focus-side-left' : 'focus-side-right');
        element.classList.add('is-focused');
    } else {
        // Rimuove tutte le classi di focus e torna alla griglia standard
        container.classList.remove('focus-active', 'focus-side-left', 'focus-side-right');
        document.querySelectorAll('.data-box').forEach(b => b.classList.remove('is-focused'));
    }
}

/**
 * Inizializzazione Gesti e Interazioni sui box con grafico.
 * Gestisce: Singolo Tap (Switch), Doppio Tap (Zoom), Long Press (Focus).
 */
['stw', 'sog', 'tws', 'depth'].forEach(type => {
    const el = document.getElementById(type + '-graph').closest('.data-box');
    let lastTapTime = 0, tapTimeout, isLongPressActive = false;

    // --- GESTIONE PRESSIONE (Inizio) ---
    el.addEventListener('pointerdown', (e) => {
        isLongPressActive = false;
        // Timer per attivare il Focus Mode dopo 1 secondo di pressione continua
        pressTimer = setTimeout(() => {
            if (!isFocusActive) {
                isLongPressActive = true;
                toggleFocusMode(type, el);
                lastTapTime = 0; // Evita che al rilascio scatti un click
            }
        }, 1000);
    });

    // --- GESTIONE RILASCIO (Fine Gesto) ---
    el.addEventListener('pointerup', (e) => {
        clearTimeout(pressTimer); // Cancella il timer del long press
        if (isLongPressActive) return; // Se è scattato il focus, non fare altro

        const currentTime = new Date().getTime();
        const tapDelay = currentTime - lastTapTime;

        // 1. GESTIONE DOPPIO CLICK (Zoom Hercules)
        if (tapDelay < 300 && tapDelay > 0) {
            clearTimeout(tapTimeout);
            // Switch tra modalità scala Standard e Zoom Hercules
            graphModes[type] = (graphModes[type] === 'standard') ? 'hercules' : 'standard';
            localStorage.setItem('mode_' + type, graphModes[type]);
            refreshGraph(type);
            lastTapTime = 0;
        }
        // 2. GESTIONE SINGOLO CLICK (Switch Dati o Esci dal Focus)
        else {
            lastTapTime = currentTime;
            tapTimeout = setTimeout(() => {
                // Se il box è in focus, il singolo click lo chiude
                if (isFocusActive && el.classList.contains('is-focused')) {
                    toggleFocusMode(type, el);
                }
                // Se siamo in visualizzazione standard, gestiamo gli switch dati
                else if (!isFocusActive) {
                    // Switch SOG <-> VMG
                    if (type === 'sog') {
                        displayModeSog = (displayModeSog === 'SOG') ? 'VMG' : 'SOG';
                    }
                    // Switch TWS <-> AWS (Nuova Logica)
                    else if (type === 'tws') {
                        displayModeTws = (displayModeTws === 'TWS') ? 'AWS' : 'TWS';
                    }
                    
                    // Feedback visivo (lampeggio leggero) dell'avvenuto switch
                    el.style.backgroundColor = "rgba(0, 0, 0, 0.05)";
                    setTimeout(() => el.style.backgroundColor = "", 150);
                }
            }, 250);
        }
    });

    // --- GESTIONE USCITA (Se l'utente trascina il dito fuori) ---
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
        
        socket.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if (d.updates) {
                d.updates.forEach(u => {
                    // 1. Estraiamo il nome del sensore/sorgente (es. "yacht_device" o "Unknown")
                    const sourceLabel = u.source ? (u.source.label || u.source.talker || "Unknown") : "Unknown";
                    
                    // 2. Passiamo il nome della sorgente come TERZO parametro
                    if (u.values) {
                        u.values.forEach(v => processIncomingData(v.path, v.value, sourceLabel));
                    }
                });
            }
        };

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
