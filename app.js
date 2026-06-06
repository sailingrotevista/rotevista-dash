/**
 * ==========================================================================
 * Signal K Wind Dashboard - Pro Version 6.0 (Dynamic Envelope Architecture)
 * ==========================================================================
 * Autore: Sailing Rotevista
 * Motore di calcolo tattico per navigazione e crociera.
 * Gestisce: Medie Vettoriali, Deviazione Standard, Trend Strategico dinamico,
 * Memoria UI persistente, Modalità Hercules, Focus Split Screen e
 * Rendering Grafico basato sul Tempo Reale (Timeline e Gap Handling).
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
        minSpeed: 0.5,
        stabilityBreakout: 15
    },
    graphs: { reef1: 10, reef2: 15, historyMinutes: 10, samples: 60 },
    scales: {
        stw: { stdMax: 4, hercSpan: 2, step: 1 },
        sog: { stdMax: 4, hercSpan: 2, step: 1 },
        tws: { stdMax: 15, hercSpan: 2, step: 1 },
        depth: { stdMax: 8, hercSpan: 1, step: 1 }
    },
    server: { fallbackIp: "192.168.111.240:3000" }
};

const RENDER_INTERVAL_MS = 1000;
const TIMEOUT_MS = 15000;
const SIM_SAMPLE_INTERVAL = 1000;
const DASH_VERSION = "6.0"; // Major Update: Server-Side History RAM Logging (Pro v6.0)

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
// MACCHINA A STATI ALLARME STRAMBATA (Filtro Isteresi Anti-Brandeggio)
let lastGybeSide = null;

const graphModes = {
    stw: 'standard',
    sog: 'standard',
    tws: 'standard',
    depth: 'standard'
};

// GESTIONE SMART LOCK DELLE SORGENTI (Zero-Config)
const sourceLocks = {};

// Database centrale dello store dati
const store = {
    raw: {},
    timestamps: {},
    depthProtectedActive: false, // Memoria per lo stato della protezione profondità
    herculesScales: {},          // Memoria per i limiti attivi della modalità Hercules
    smoothBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [] },
    longBuf: { hdg: [], cog: [], awa: [], twa: [], twd: [] },
    histories: { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [] },
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
// 3. UTILITIES (MATEMATICA, BUFFER E MEMORIA)
// ==========================================================================
function radToDeg(rad) { return rad * (180 / Math.PI); }
function degToRad(deg) { return deg * (Math.PI / 180); }
function msToKts(ms) { return ms * 1.94384; }
function ktsToMs(kts) { return kts / 1.94384; }

function getShortestRotation(curr, target) {
    let diff = (target - curr) % 360;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    return curr + diff;
}

/**
 * Inserimento sicuro nel buffer con trigonometria precaricata e pruning automatico
 */
function safePush(buffer, val, time) {
    if (val === null || val === undefined || isNaN(val)) return;

    buffer.push({
        val: val,
        time: time,
        sin: Math.sin(val),
        cos: Math.cos(val)
    });

    const maxHistoryMs = (CONFIG.graphs.historyMinutes * 60000 * 2) + 60000;
    while (buffer.length > 0 && (time - buffer[0].time) > maxHistoryMs) {
        buffer.shift();
    }
    if (buffer.length > 36000) buffer.shift();
}

/**
 * Media Circolare Vettoriale - Versione "Soft Outlier Rejection"
 */
function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false, now) {
    now = now || Date.now();
    const len = bufferArray.length;
    if (len === 0) return null;

    let sSin = 0, sCos = 0, count = 0;
    let newestTime = 0, oldestTime = 0;

    let pilotSin = 0, pilotCos = 0;
    const pilotSamples = Math.min(len, 15);
    for (let i = len - 1; i >= len - pilotSamples; i--) {
        pilotSin += bufferArray[i].sin;
        pilotCos += bufferArray[i].cos;
    }
    const pilotRad = Math.atan2(pilotSin, pilotCos);
    const limitRad = (CONFIG.averaging.stabilityBreakout || 15) * (Math.PI / 180);

    for (let i = len - 1; i >= 0; i--) {
        const item = bufferArray[i];
        if ((now - item.time) > windowMs) break;

        let diffRad = Math.atan2(Math.sin(item.val - pilotRad), Math.cos(item.val - pilotRad));
        let finalSin, finalCos;

        if (Math.abs(diffRad) > limitRad) {
            const clampedDiff = Math.sign(diffRad) * limitRad;
            const clampedRad = pilotRad + clampedDiff;
            finalSin = Math.sin(clampedRad);
            finalCos = Math.cos(clampedRad);
        } else {
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
            
            if (state.displayModeSog) {
                displayModeSog = state.displayModeSog;
                const labelEl = document.getElementById('sog-vmg-label');
                if (labelEl) labelEl.textContent = displayModeSog;
            }
            if (state.displayModeTws) {
                displayModeTws = state.displayModeTws;
                const labelEl = document.getElementById('tws-aws-label');
                if (labelEl) labelEl.textContent = displayModeTws;
            }
            if (state.isNightMode) document.body.classList.add('night-mode');

            if (state.isFocusActive && state.focusedBoxType) {
                setTimeout(() => {
                    const el = document.querySelector(`.box-${state.focusedBoxType}`);
                    if (el) { isFocusActive = false; toggleFocusMode(state.focusedBoxType, el); }
                }, 200);
            }
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
    ui.depth.classList.remove('alarm-warning', 'alarm-danger', 'blink-alarm');
    if (m < CONFIG.alarms.depthDanger) {
        ui.depth.classList.add('alarm-danger', 'blink-alarm');
        playBingBing();
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

    const tw_water_x = aws * Math.cos(awa) - stw, tw_water_y = aws * Math.sin(awa);
    const tws_water = Math.sqrt(tw_water_x * tw_water_x + tw_water_y * tw_water_y);

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

// ==========================================================================
// GESTIONE SMART LOCK DELLE SORGENTI (Zero-Config)
// ==========================================================================

/**
 * Assegna un punteggio di qualità statico alla sorgente basato sull'hardware.
 * Più alto è il punteggio, maggiore è la priorità del sensore.
 */
function getSourcePriorityScore(sourceName) {
    if (!sourceName) return 0;
    const name = sourceName.toLowerCase();

    // TIER 3: AIS / Trasmissioni lente (es. yacht_device.AI, VDO)
    if (name.includes('.ai') || name.includes('ais') || name.includes('vdo')) {
        return 10;
    }

    // TIER 2: GPS USB del Cerbo GX / Victron / Sistemi locali di servizio
    if (name.includes('venus') || name.includes('victron') || name.includes('ttyacm') || name.includes('ttyusb') || name.includes('system')) {
        return 50;
    }

    // TIER 1: Strumentazione ufficiale di navigazione (NMEA 2000, Yacht Devices GP/YD/AP, Gateway, ecc.)
    if (name.includes('yacht_device') || name.includes('n2k') || name.includes('actisense') || name.includes('can') || name.includes('nmea') || name.includes('raymarine') || name.includes('garmin') || name.includes('simrad') || name.includes('b&g')) {
        return 100;
    }

    return 30; // Punteggio standard per sorgenti sconosciute
}

function processIncomingData(path, val, source) {
    const now = Date.now();
    const score = getSourcePriorityScore(source);

    // Gestione dello Smart Lock
    if (!sourceLocks[path]) {
        // Nessun blocco attivo: aggancia la sorgente corrente
        sourceLocks[path] = { label: source, score: score, lastSeen: now };
    } else {
        const currentLock = sourceLocks[path];
        const isSameSource = (currentLock.label === source);
        const isLockExpired = (now - currentLock.lastSeen > 12000); // Scadenza a 12 secondi per tollerare il GPS dello Yacht Devices
        const hasHigherPriority = (score > currentLock.score);

        if (isSameSource) {
            // Stessa sorgente: aggiorna il timestamp e mantiene il blocco
            currentLock.lastSeen = now;
            currentLock.score = score;
        } else if (isLockExpired || hasHigherPriority) {
            // Ruba il blocco se la sorgente precedente è scaduta o se questa ha priorità superiore
            sourceLocks[path] = { label: source, score: score, lastSeen: now };
            console.log(`🔌 [Smart Lock] Path "${path}" switched to: ${source} (Score: ${score})`);
        } else {
            // Rifiuta i dati da sorgenti a priorità inferiore se quella principale è attiva
            return;
        }
    }

    store.timestamps[path] = now;
    store.raw[path] = val;

    if (path === "environment.wind.angleApparent") {
        safePush(store.smoothBuf.awa, val, now);
        safePush(store.longBuf.awa, val, now);
    }
    if (path === "navigation.headingTrue") {
        safePush(store.smoothBuf.hdg, val, now);
        safePush(store.longBuf.hdg, val, now);
    }
    if (path === "navigation.courseOverGroundTrue") {
        safePush(store.smoothBuf.cog, val, now);
        safePush(store.longBuf.cog, val, now);
    }

    const twPaths = [
        "environment.wind.speedApparent", "environment.wind.angleApparent",
        "navigation.speedThroughWater", "navigation.speedOverGround",
        "navigation.headingTrue", "navigation.courseOverGroundTrue"
    ];

    if (twPaths.includes(path)) {
        twDirty = true;
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

    // --- 6.1 TREND TATTICO (AWA/TWA) ---
    const twaNow = getCircularAverageFromBuffer(store.longBuf.twa, 2000, true);
    const twaRef = getCircularAverageFromBuffer(store.longBuf.twa, 10000, true);
    const gaugeDots = { cw: document.getElementById('trend-gauge-cw'), ccw: document.getElementById('trend-gauge-ccw') };

    // --- 6.2 ALLARME STRAMBATA CON ISTERESI (MACCHINA A STATI ANTI-BRANDEGGIO) ---
    const instTwaRad = store.raw["environment.wind.angleTrueWater"];
    let smoothedTwaDeg = null;

    if (instTwaRad !== undefined) {
        const dynamicAlpha = Math.max(0.05, 1.1 - CONFIG.averaging.stabilityThreshold);
        const currentSin = Math.sin(instTwaRad);
        const currentCos = Math.cos(instTwaRad);

        if (firstEmaRun) {
            emaTwaSin = currentSin; emaTwaCos = currentCos; firstEmaRun = false;
        } else {
            emaTwaSin = (currentSin * dynamicAlpha) + (emaTwaSin * (1 - dynamicAlpha));
            emaTwaCos = (currentCos * dynamicAlpha) + (emaTwaCos * (1 - dynamicAlpha));
        }

        smoothedTwaDeg = radToDeg(Math.atan2(emaTwaSin, emaTwaCos));
        const absTwaDeg = Math.abs(smoothedTwaDeg);

        // Allarme VISIVO: Se siamo in zona di pericolo poppa profonda (> 155°), accendi entrambi i LED di rosso pulsante
        if (absTwaDeg > 155) {
            if (gaugeDots.cw) { gaugeDots.cw.classList.add('is-gybing'); gaugeDots.cw.setAttribute('fill', '#ff3b30'); }
            if (gaugeDots.ccw) { gaugeDots.ccw.classList.add('is-gybing'); gaugeDots.ccw.setAttribute('fill', '#ff3b30'); }

            // LOGICA MACCHINA A STATI CON ISTERESI:
            // Rileviamo le mure solo se siamo fuori dalla zona cieca di poppa secca (> 170°).
            // Se oscilliamo tra -175° e +178° (brandeggio), lastGybeSide NON cambia e l'allarme acustico tace.
            let currentTack = null;
            if (smoothedTwaDeg > 155 && smoothedTwaDeg < 170) {
                currentTack = 'starboard';
            } else if (smoothedTwaDeg < -155 && smoothedTwaDeg > -170) {
                currentTack = 'port';
            }

            if (currentTack !== null) {
                if (lastGybeSide === null) {
                    // Inizializzazione al primo ingresso nella zona di controllo
                    lastGybeSide = currentTack;
                } else if (lastGybeSide !== currentTack) {
                    // Abbiamo eseguito una vera strambata stabile e siamo usciti dalla zona di poppa secca!
                    lastGybeSide = currentTack;

                    // Attivazione allarme acustico con blocco temporale di sicurezza (60 secondi)
                    if (isNavigating && (now - lastGybeAlarmTime > 60000)) {
                        lastGybeAlarmTime = now;
                        playGybeAlarm();
                        console.log(`⚠️ GYBE ALARM TRIGGERED: Tack switched to ${currentTack} (TWA: ${smoothedTwaDeg.toFixed(1)}°)`);
                    }
                }
            }
        } else {
            // Se usciamo dalla poppa profonda (< 155°), disattiva l'allarme visivo e resetta lo stato delle mure
            if (gaugeDots.cw) gaugeDots.cw.classList.remove('is-gybing');
            if (gaugeDots.ccw) gaugeDots.ccw.classList.remove('is-gybing');
            lastGybeSide = null; // Reset per la prossima poppa
        }
        lastInstantTwa = smoothedTwaDeg;
    }

    // Gestione normale dei Trend Tattici (Lifts/Headers) se NON siamo in allarme strambata
    if (twaNow && twaRef && (smoothedTwaDeg === null || Math.abs(smoothedTwaDeg) <= 155)) {
        let deltaTac = radToDeg((twaNow.val - twaRef.val + Math.PI * 3) % (2 * Math.PI) - Math.PI);
        const curTwaDeg = radToDeg(twaNow.val);
        if (Math.abs(deltaTac) > 3.0) {
            let absTwa = Math.abs(curTwaDeg);
            let tacticColor;
            if (absTwa > 75 && absTwa < 105) {
                tacticColor = "#bbb";
            } else {
                let isLift = (curTwaDeg > 0) ? (deltaTac > 0) : (deltaTac < 0);
                if (absTwa >= 90) isLift = !isLift;
                tacticColor = isLift ? "#27ae60" : "#c0392b";
            }
            if (deltaTac > 0) {
                if (gaugeDots.cw) { gaugeDots.cw.classList.add('is-trending'); gaugeDots.cw.setAttribute('fill', tacticColor); }
                if (gaugeDots.ccw) { gaugeDots.ccw.classList.remove('is-trending'); }
            } else {
                if (gaugeDots.ccw) { gaugeDots.ccw.classList.add('is-trending'); gaugeDots.ccw.setAttribute('fill', tacticColor); }
                if (gaugeDots.cw) { gaugeDots.cw.classList.remove('is-trending'); }
            }
        } else {
            [gaugeDots.cw, gaugeDots.ccw].forEach(el => { if(el){ el.classList.remove('is-trending'); el.setAttribute('fill', '#bbb'); }});
        }
    }

    // --- 6.3 TREND METEO STRATEGICO (TWD) ---
    const twdNow = getCircularAverageFromBuffer(store.longBuf.twd, 60000, false);
    const multiplier = isNavigating ? 1 : 2;
    const strategicWindowMs = CONFIG.graphs.historyMinutes * 60000 * multiplier;
    const twdRef = getCircularAverageFromBuffer(store.longBuf.twd, strategicWindowMs, false);
    const compassDots = { cw: document.getElementById('trend-dot-cw'), ccw: document.getElementById('trend-dot-ccw') };

    if (twdNow && twdRef) {
        let deltaMeteo = radToDeg((twdNow.val - twdRef.val + Math.PI * 3) % (Math.PI * 2) - Math.PI);
        if (Math.abs(deltaMeteo) > 6.0) {
            const isSouth = store.raw["navigation.position"]?.latitude < 0;
            let meteoColor = (!isSouth) ? (deltaMeteo < 0 ? "#27ae60" : "#c0392b") : (deltaMeteo > 0 ? "#27ae60" : "#c0392b");
            if (deltaMeteo > 0) {
                if (compassDots.cw) { compassDots.cw.classList.add('is-trending'); compassDots.cw.setAttribute('fill', meteoColor); }
                if (compassDots.ccw) { compassDots.ccw.classList.remove('is-trending'); }
            } else {
                if (compassDots.ccw) { compassDots.ccw.classList.add('is-trending'); compassDots.ccw.setAttribute('fill', meteoColor); }
                if (compassDots.cw) { compassDots.cw.classList.remove('is-trending'); }
            }
        } else {
            [compassDots.cw, compassDots.ccw].forEach(el => { if(el){ el.classList.remove('is-trending'); el.setAttribute('fill', '#bbb'); }});
        }
    }
}

// ==========================================================================
// 7. RENDERING ENGINE E AGGIORNAMENTO UI
// ==========================================================================

/**
 * upUI: Aggiornamento valori digitali
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
        if (isNavigating && (!obj.stable || obj.dev > CONFIG.averaging.stabilityBreakout || diff > CONFIG.averaging.stabilityBreakout)) el.classList.add('unstable-data');
        else el.classList.remove('unstable-data');
    }
};

/**
 * Loop principale di aggiornamento interfaccia (1Hz)
 */
function startDisplayLoop() {
    renderInterval = setInterval(() => {
        const now = Date.now();
        const isNight = document.body.classList.contains('night-mode');
        
        const stwKts = msToKts(store.raw["navigation.speedThroughWater"] || 0);
        const sogKts = msToKts(store.raw["navigation.speedOverGround"] || 0);
        
        isNavigating = stwKts > CONFIG.averaging.minSpeed || sogKts > CONFIG.averaging.minSpeed;

        // --- CALCOLO TREND VENTO & ALLARME STRAMBATA ---
        updateWindTrend();

        // --- AGGIORNAMENTO STATUS CON CONTEGGIO MINUTI REALE ---
        const viewportMinutes = CONFIG.graphs.historyMinutes * (isNavigating ? 1 : 2);
        const requiredMs = viewportMinutes * 60000;
        const oldestStw = store.histories.stw ? store.histories.stw[0] : null;

        if (oldestStw) {
            const availableMs = now - oldestStw.time;
            if (availableMs >= requiredMs) {
                ui.status.innerText = `ONLINE ${viewportMinutes}min`;
            } else {
                const availableMin = Math.max(1, Math.floor(availableMs / 60000));
                ui.status.innerText = `ONLINE ${availableMin}/${viewportMinutes}min`;
            }
        } else {
            ui.status.innerText = `ONLINE`;
        }
        ui.status.className = (socket && socket.readyState === WebSocket.OPEN) ? "online" : "offline";

        // --- WATCHDOG: CONTROLLO TIMEOUT ---
        const watch = {
            "navigation.speedThroughWater": ui.stw, "navigation.speedOverGround": ui.sog,
            "navigation.headingTrue": ui.hdg, "navigation.courseOverGroundTrue": ui.cog,
            "environment.wind.speedApparent": ui.awsSvg, "environment.depth.belowTransducer": ui.depth,
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
            ui.stw.style.color = ""; // Neutro
            manageHistory('stw', stwKts);
        }
        
        // --- LOGICA SOG / VMG ---
        if (store.raw["navigation.speedOverGround"] !== undefined) {
            const vmgVal = Math.abs(stwKts * Math.cos(store.raw["environment.wind.angleTrueWater"] || 0));
            manageHistory('vmg', vmgVal);
            manageHistory('sog', sogKts);
            
            const labelSogVmg = document.getElementById('sog-vmg-label');
            if (displayModeSog === 'VMG') {
                ui.sog.innerText = vmgVal.toFixed(1);
                ui.sog.style.setProperty('color', '#00b8d4', 'important'); // Cyan
                if (labelSogVmg) labelSogVmg.textContent = 'VMG';
            } else {
                ui.sog.innerText = sogKts.toFixed(1);
                if (labelSogVmg) labelSogVmg.textContent = 'SOG';
                
                if (isNavigating) {
                    const lastSog = store.histories.sog.length > 0 ? store.histories.sog[store.histories.sog.length - 1].val : sogKts;
                    const lastStw = store.histories.stw.length > 0 ? store.histories.stw[store.histories.stw.length - 1].val : stwKts;
                    const drift = lastSog - lastStw;

                    if (drift < -0.3) ui.sog.style.setProperty('color', '#ff3b30', 'important'); // Contro
                    else if (drift > 0.3) ui.sog.style.setProperty('color', '#00C851', 'important'); // Favore
                    else ui.sog.style.setProperty('color', '#ffbb33', 'important'); // Neutro SOG
                } else {
                    ui.sog.style.color = "";
                }
            }
        }

        // --- AGGIORNAMENTO PROFONDITÀ (DEPTH) ---
        if (store.raw["environment.depth.belowTransducer"] !== undefined) {
            ui.depth.innerText = store.raw["environment.depth.belowTransducer"].toFixed(1);
            checkDepthAlarm(store.raw["environment.depth.belowTransducer"]);
            manageHistory('depth', store.raw["environment.depth.belowTransducer"]);
        }

        // --- GESTIONE VENTO (TWS / AWS SWITCH) ---
        const twsVal = store.raw["environment.wind.speedTrue"] ? msToKts(store.raw["environment.wind.speedTrue"]) : 0;
        const awsVal = store.raw["environment.wind.speedApparent"] ? msToKts(store.raw["environment.wind.speedApparent"]) : 0;
        
        if (store.raw["environment.wind.speedTrue"] !== undefined) manageHistory('tws', twsVal);
        if (store.raw["environment.wind.speedApparent"] !== undefined) manageHistory('aws', awsVal);

        if (store.raw["environment.wind.speedTrue"] !== undefined || store.raw["environment.wind.speedApparent"] !== undefined) {
            const labelWind = document.getElementById('tws-aws-label');
            const currentWind = (displayModeTws === 'AWS') ? awsVal : twsVal;
            
            ui.tws.innerText = currentWind.toFixed(1);
            if (labelWind) labelWind.textContent = displayModeTws;

            if (currentWind >= CONFIG.graphs.reef2) {
                ui.tws.style.setProperty('color', '#ff3b30', 'important');
            } else if (currentWind >= CONFIG.graphs.reef1) {
                ui.tws.style.setProperty('color', '#ff9800', 'important');
            } else {
                if (displayModeTws === 'AWS') {
                    ui.tws.style.setProperty('color', '#5c6bc0', 'important');
                } else {
                    const navyNight = isNight ? '#6c8ea0' : '#2c3e50';
                    ui.tws.style.setProperty('color', navyNight, 'important');
                }
            }
        }

        if (store.raw["environment.wind.speedApparent"] !== undefined) {
            ui.awsSvg.textContent = awsVal.toFixed(1);
        }

        // --- PUNTATORI ANALOGICI ---
        const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, 2000, true);
        const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, 2000, true);
        if (smAwa) ui.awa.setAttribute('transform', `rotate(${curAwaRot = getShortestRotation(curAwaRot, radToDeg(smAwa.val))}, 200, 200)`);
        if (smTwa) ui.twa.setAttribute('transform', `rotate(${curTwaRot = getShortestRotation(curTwaRot, radToDeg(smTwa.val))}, 200, 200)`);
        
        if (store.raw["navigation.courseOverGroundTrue"] !== undefined && store.raw["navigation.headingTrue"] !== undefined) {
            let driftDeg = radToDeg((store.raw["navigation.courseOverGroundTrue"] - store.raw["navigation.headingTrue"] + Math.PI * 3) % (2 * Math.PI) - Math.PI);
            smoothedLeeway = (sogKts < CONFIG.averaging.minSpeed) ? 0 : (smoothedLeeway * 0.9) + (driftDeg * 0.1);
            curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway);
            ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
            ui.leewayVal.style.color = (Math.abs(sogKts - stwKts) > 0.5 && Math.abs(smoothedLeeway) > 7) ? "#ff9800" : "";
            updateLeewayDisplay(Math.max(-20, Math.min(20, smoothedLeeway)));
        }
        
        // --- HEAVY TIER (2s) E SLOW TIER (3s) ---
        if (lastAvgUIUpdate++ % 2 === 0) {
            ['stw', 'sog', 'depth', 'tws'].forEach(refreshGraph);
            saveDashboardState();
        }

        if (lastAvgUIUpdate % 3 === 0) {
            let hObj = getCircularAverageFromBuffer(store.longBuf.hdg, CONFIG.averaging.longWindow * 2, false);
            let cObj = getCircularAverageFromBuffer(store.longBuf.cog, CONFIG.averaging.longWindow, false);
            let awObj = getCircularAverageFromBuffer(store.longBuf.awa, CONFIG.averaging.longWindow, true);
            let twObj = getCircularAverageFromBuffer(store.longBuf.twa, CONFIG.averaging.longWindow, true);
            let twdObj = getCircularAverageFromBuffer(store.longBuf.twd, CONFIG.averaging.longWindow, false);

            upUI(ui.hdg, hObj, store.raw["navigation.headingTrue"], true);
            upUI(ui.cog, cObj, store.raw["navigation.courseOverGroundTrue"], true);
            upUI(ui.awaAvg, awObj, store.raw["environment.wind.angleApparent"], false);
            upUI(ui.twaAvg, twObj, store.raw["environment.wind.angleTrueWater"], false);
            upUI(ui.twdAvg, twdObj, store.raw["environment.wind.directionTrue"], true);

            if (hObj && twdObj) {
                const reflectAngle = (targetRad, axisRad) => {
                    const dS = Math.sin(axisRad - targetRad);
                    const dC = Math.cos(axisRad - targetRad);
                    return Math.atan2(Math.sin(axisRad) * dC + Math.cos(axisRad) * dS, Math.cos(axisRad) * dC - Math.sin(axisRad) * dS);
                };
                const unstableH = !hObj.stable || !twdObj.stable || hObj.dev > CONFIG.averaging.stabilityBreakout;
                if (!isNavigating) ui.tackHdg.innerHTML = "---&deg;";
                else if (unstableH) { ui.tackHdg.innerHTML = "---&deg;"; ui.tackHdg.classList.add('unstable-data'); }
                else {
                    const rH = (radToDeg(reflectAngle(hObj.val, twdObj.val)) + 360) % 360;
                    ui.tackHdg.innerHTML = `${Math.round(rH).toString().padStart(3, '0')}&deg;`;
                    ui.tackHdg.classList.remove('unstable-data');
                }
                if (cObj) {
                    const unstableC = !cObj.stable || !twdObj.stable || cObj.dev > CONFIG.averaging.stabilityBreakout;
                    if (!isNavigating) ui.tackCog.innerHTML = "---&deg;";
                    else if (unstableC) { ui.tackCog.innerHTML = "---&deg;"; ui.tackCog.classList.add('unstable-data'); }
                    else {
                        const rC = (radToDeg(reflectAngle(cObj.val, twdObj.val)) + 360) % 360;
                        ui.tackCog.innerHTML = `${Math.round(rC).toString().padStart(3, '0')}&deg;`;
                        ui.tackCog.classList.remove('unstable-data');
                    }
                }
            }
            
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
// 8. CONFIGURAZIONE, AGGIORNAMENTO LIVE E GRAFICI UTILS
// ==========================================================================

let currentConfigString = ""; // Memoria per rilevare cambiamenti nei settings

/**
 * Risolve dinamicamente l'URL dell'API del Cerbo GX se siamo in locale su Mac/PC
 */
function getApiUrl(path) {
    if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return `http://${CONFIG.server.fallbackIp}${path}`;
    }
    return path;
}

/**
 * Funzione Helper: Applica fisicamente i dati JSON all'oggetto CONFIG globale
 */
function applyConfigData(data) {
    Object.assign(CONFIG.alarms, data.alarms || {});
    Object.assign(CONFIG.graphs, data.graphs || {});
    Object.assign(CONFIG.averaging, data.averaging || {});
    
    // Migrazione Silenziosa: Rilevato vecchio parametro stabilità (<= 0.85).
    // Aggiornato a 0.95 per ottimizzazione filtri.
    if (CONFIG.averaging.stabilityThreshold <= 0.85) {
        CONFIG.averaging.stabilityThreshold = 0.95;
    }

    if (data.scales) {
        for (let key in data.scales) {
            if (CONFIG.scales[key]) Object.assign(CONFIG.scales[key], data.scales[key]);
        }
    }
}

/**
 * Recupera la configurazione iniziale al caricamento della pagina
 */
async function fetchServerConfig() {
    try {
        const response = await fetch(getApiUrl('/rotevista-config'));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();

        // Salviamo l'impronta digitale della configurazione per i confronti futuri
        currentConfigString = JSON.stringify(data);

        applyConfigData(data);
        console.log("✅ Configurazione iniziale applicata con successo.");
    } catch (err) {
        console.warn("⚠️ Impossibile raggiungere le configurazioni dal server. Utilizzo default.");
    }
}

/**
 * Watchdog: Controlla in background se le impostazioni sul server sono cambiate
 */
async function watchConfigChanges() {
    try {
        const response = await fetch(getApiUrl('/rotevista-config'));
        if (!response.ok) return;
        const data = await response.json();
        
        const newConfigString = JSON.stringify(data);

        // Se l'impronta digitale è diversa, l'utente ha salvato nuovi settings!
        if (newConfigString !== currentConfigString) {
            console.log("🔄 Rilevato cambio impostazioni su Signal K! Aggiornamento in tempo reale...");
            
            // Applichiamo i nuovi settings al volo
            applyConfigData(data);
            
            // Aggiorniamo l'impronta
            currentConfigString = newConfigString;
            
            // FEEDBACK VISIVO: Avvisiamo l'utente dell'aggiornamento
            ui.status.innerText = "CONFIG UPDATED!";
            ui.status.style.color = "#00C851"; // Verde Neon
            setTimeout(() => { ui.status.style.color = ""; }, 4000);
        }
    } catch (err) {
        // Ignoriamo gli errori di rete nel watchdog per non intasare la console in caso di disconnessione
    }
}

/**
 * Recupera lo storico dei grafici pre-popolato dal server Signal K (Pro v6.0)
 */
async function fetchServerHistory() {
    try {
        const response = await fetch(getApiUrl('/rotevista-history'));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        
        if (data && typeof data === 'object') {
            for (let key in data) {
                if (store.histories[key] !== undefined) {
                    store.histories[key] = data[key];
                }
            }
            console.log("📈 Storico dei grafici pre-popolato caricato dal server.");
        }
    } catch (err) {
        console.warn("⚠️ Impossibile caricare lo storico dal server. Utilizzo dati vuoti/simulati.");
        throw err; // Rilancia l'errore per far attivare il fallback nella funzione init()
    }
}

/**
 * manageHistory v3.7 - Aggregazione semantica "Pro-Grade"
 * Integrazioni:
 * 1. Strict undefined check per lastUpdates.
 * 2. Anti-dropout dinamico tarato sul 50% del Reef 1.
 * 3. Clamping di sicurezza (no negativi, no Infinity).
 */
function manageHistory(type, value) {
    // --- 1. VALIDAZIONE INPUT RIGOROSA ---
    if (value === undefined || value === null || !isFinite(value)) return;

    const now = Date.now();
    const historyMinutes = Math.max(1, CONFIG.graphs.historyMinutes || 10);
    const samples = Math.max(2, CONFIG.graphs.samples || 60);
    const bucketIntervalMs = (historyMinutes * 60000) / samples;

    // --- 2. INIT SICURO (Strict Check) ---
    if (!store.graphTempBuf[type]) store.graphTempBuf[type] = [];
    if (!store.histories[type]) store.histories[type] = [];
    if (store.lastUpdates[type] === undefined) store.lastUpdates[type] = 0;

    const tempBuf = store.graphTempBuf[type];

    // --- 3. ANTI-DROPOUT DINAMICO (Auto-scaling) ---
    if ((type === 'tws' || type === 'aws') && value < 0.05 && tempBuf.length > 0) {
        const lastPoint = tempBuf[tempBuf.length - 1];
        const glitchThreshold = (CONFIG.graphs.reef1 || 15) * 0.5;
        if (lastPoint && lastPoint.val > glitchThreshold) return;
    }

    // --- 4. STORAGE TEMPORANEO ---
    tempBuf.push({ val: value, time: now });

    // Controllo finestra temporale
    const bucketReady = (now - store.lastUpdates[type] > bucketIntervalMs) || store.histories[type].length === 0;
    if (!bucketReady) return;

    // --- 5. AGGREGAZIONE SEMANTICA ---
    let finalValue = value;

    if (tempBuf.length > 0) {
        // A. VENTO -> SUSTAINED PEAK (EMA Time-Aware)
        if (type === 'tws' || type === 'aws') {
            const tauMs = 2500;
            let ema = tempBuf[0].val;
            let maxSustained = ema;

            for (let i = 1; i < tempBuf.length; i++) {
                const dt = Math.max(1, tempBuf[i].time - tempBuf[i - 1].time);
                const alpha = 1 - Math.exp(-dt / tauMs);
                ema = (tempBuf[i].val * alpha) + (ema * (1 - alpha));
                if (isFinite(ema) && ema > maxSustained) maxSustained = ema;
            }
            finalValue = maxSustained;
        }
        // B. PROFONDITÀ -> MINIMO
        else if (type === 'depth') {
            const vals = tempBuf.map(p => p.val).filter(v => isFinite(v));
            if (vals.length > 0) finalValue = Math.min(...vals);
        }
        // C. VELOCITÀ -> MEDIA
        else {
            const vals = tempBuf.map(p => p.val).filter(v => isFinite(v));
            if (vals.length > 0) {
                const sum = vals.reduce((a, b) => a + b, 0);
                finalValue = sum / tempBuf.length;
            }
        }
    }

    // --- 6. CLAMPING E VALIDAZIONE FINALE ---
    if (!isFinite(finalValue)) return;
    finalValue = Math.max(0, finalValue);

    // --- 7. STORAGE STORICO ---
    store.histories[type].push({ val: finalValue, time: now });

    // --- 8. PRUNING DINAMICO ---
    const maxViewportMinutes = historyMinutes * 2;
    const maxHistoryMs = (maxViewportMinutes * 60000) + 60000;

    while (store.histories[type].length > 0 && (now - store.histories[type][0].time) > maxHistoryMs) {
        store.histories[type].shift();
    }

    // Reset per il prossimo bucket
    store.graphTempBuf[type] = [];
    store.lastUpdates[type] = now;
}

/**
 * Gestione dinamica delle scale dei grafici (Involucro Elastico Snapped e Safety Zoom)
 * Implementa lo "Snap a Griglia" basato sull'hercSpan senza padding per tutti i sensori.
 */
function calculateScale(type, data, mode) {
    const s = CONFIG.scales[type];
    const currentVal = data[data.length - 1];
    
    // Fallback di emergenza se il buffer è momentaneamente vuoto
    if (currentVal === undefined || currentVal === null) {
        return { min: 0, max: s ? s.stdMax : 10 };
    }

    // Inizializzazione della memoria delle scale nello store se non esiste
    if (!store.herculesScales) store.herculesScales = {};
    if (!store.herculesScales[type]) {
        store.herculesScales[type] = { min: 0, max: s ? s.stdMax : 10 };
    }
    let currentScale = store.herculesScales[type];

    // ==========================================================================
    // 1. SEZIONE PROFONDITÀ (DEDICATA A 2 MINUTI DI SICUREZZA, MINIMO FISSO A 0)
    // ==========================================================================
    if (type === 'depth') {
        const shallowThreshold = Math.max(s.stdMax, 10); // Es. 20m
        if (store.depthProtectedActive === undefined) store.depthProtectedActive = false;

        const now = Date.now();
        const depthSafetyWindowMs = 120000; // 2 minuti fissi per la sicurezza
        
        // Estrazione dati reali degli ultimi 2 minuti con timestamp
        const recentPoints = store.histories.depth.filter(p => (now - p.time) <= depthSafetyWindowMs);
        const recentVals = recentPoints.map(p => p.val);

        const localMax = recentVals.length > 0 ? Math.max(...recentVals) : currentVal;
        const localMin = recentVals.length > 0 ? Math.min(...recentVals) : currentVal;

        // --- 1.1 NORMALE PROFONDITÀ (CON SOGLIA STANDARD E FILTRO 2 MINUTI) ---
        if (mode !== 'hercules') {
            if (!store.depthProtectedActive && currentVal <= shallowThreshold) {
                store.depthProtectedActive = true;
            }
            if (store.depthProtectedActive) {
                if (localMin > shallowThreshold) {
                    store.depthProtectedActive = false;
                }
            }
            if (store.depthProtectedActive) {
                return { min: 0, max: shallowThreshold };
            }
            const maxHistorico = Math.max(...data);
            return { min: 0, max: Math.max(s.stdMax, Math.ceil(maxHistorico / s.step) * s.step) };
        }

        // --- 1.2 HERCULES PROFONDITÀ (0 IN BASSO, SNAP SUL MAX SENZA PADDING) ---
        if (mode === 'hercules') {
            const roundStep = s.hercSpan; // Passo di griglia selezionato dall'utente
            
            let targetMin = 0;
            let targetMax = Math.ceil(localMax / roundStep) * roundStep;

            // Impediamo una scala inferiore a 4 metri per sicurezza visiva
            const absoluteMinSpan = 4;
            if (targetMax < absoluteMinSpan) {
                targetMax = absoluteMinSpan;
            }

            // Regola asimmetrica per il MAX (Espansione istantanea, contrazione a 2 minuti)
            if (currentVal > currentScale.max) {
                currentScale.max = targetMax;
            } else {
                const allStableInTarget = recentVals.every(val => val <= targetMax);
                if (allStableInTarget) {
                    currentScale.max = targetMax;
                }
            }

            currentScale.min = 0;
            return { min: currentScale.min, max: currentScale.max };
        }
    }

    // ==========================================================================
    // 2. ALTRI GRAFICI (STW, SOG, TWS): COMPORTAMENTO ADATTIVO SU TERZO DEL GRAFICO
    // ==========================================================================
    
    // --- 2.1 MODALITÀ NORMALE ---
    if (mode !== 'hercules') {
        const maxHistorico = Math.max(...data);
        return { min: 0, max: Math.max(s.stdMax, Math.ceil(maxHistorico / s.step) * s.step) };
    }

    // --- 2.2 MODALITÀ HERCULES AD ALTO CONTRASTO (SNAP SENZA PADDING) ---
    if (mode === 'hercules') {
        const roundStep = s.hercSpan; // Passo di griglia (ex hercSpan)

        const oneThirdCount = Math.max(1, Math.floor(data.length / 3));
        const recentThirdData = data.slice(-oneThirdCount);

        const localMin = Math.min(...recentThirdData);
        const localMax = Math.max(...recentThirdData);

        // Applichiamo lo snap diretto ai multipli della griglia
        let targetMin = Math.max(0, Math.floor(localMin / roundStep) * roundStep);
        let targetMax = Math.ceil(localMax / roundStep) * roundStep;

        // Se lo span calcolato è nullo (es. velocità costante), forziamo lo span minimo
        if (targetMax - targetMin === 0) {
            targetMax = targetMin + roundStep;
        }

        // APPLICAZIONE REGOLE ASIMMETRICHE ANTI-CLIPPING
        // A. Espansione ISTANTANEA in alto o in basso (sicurezza)
        if (currentVal < currentScale.min || currentVal > currentScale.max) {
            currentScale.min = Math.min(currentScale.min, targetMin);
            currentScale.max = Math.max(currentScale.max, targetMax);
        }
        // B. Contrazione RITARDATA (solo se tutto il terzo recente si è assestato nel target)
        else {
            const allStableInTarget = recentThirdData.every(val => val >= targetMin && val <= targetMax);
            if (allStableInTarget) {
                currentScale.min = targetMin;
                currentScale.max = targetMax;
            }
        }

        return { min: currentScale.min, max: currentScale.max };
    }
}

function updateScaleLabels(t, min, max) {
    const el = document.getElementById(t + '-scale');
    if (el) el.innerHTML = `<span>${Math.round(max)}</span><span>${Math.round((min+max)/2)}</span><span>${Math.round(min)}</span>`;
}

/**
 * refreshGraph: Recupero dati, switch AWS/TWS e passaggio a motore grafico.
 */
function refreshGraph(t) {
    const boxType = (t === 'vmg') ? 'sog' : t;
    let rawData;

    if (t === 'tws' && displayModeTws === 'AWS') {
        rawData = store.histories['aws'];
    } else {
        rawData = store.histories[t];
    }

    if (!rawData || rawData.length < 2) return;

    const values = rawData.map(p => p.val);
    const mode = graphModes[boxType];
    const cfg = calculateScale(boxType, values, mode);

    const box = document.querySelector(`.box-${boxType}`);
    if (box) box.classList.toggle('box-hercules', mode === 'hercules');

    updateScaleLabels(boxType, cfg.min, cfg.max);
    drawGraph(rawData, boxType + '-graph', cfg.min, cfg.max, t === 'tws', mode === 'hercules');
}

/**
 * drawGraph: Motore SVG con Timeline Reale e Gestione GAP
 * Risolve i conflitti di orologio (Clock Drift) tra Cerbo GX e Tablet.
 */
function drawGraph(d, id, min, max, isTws, isHercules) {
    const svg = document.getElementById(id);
    if (!svg || d.length < 2) return;

    const w = 200, h = 40;
    const range = max - min || 1;
    const isDepth = (id === 'depth-graph');
    
    // --- RISOLUZIONE DISALLINEAMENTO ORARIO ---
    // Usiamo il tempo del sensore (l'ultimo dato ricevuto) invece dell'orologio del tablet
    const latestPoint = d[d.length - 1];
    const now = latestPoint ? latestPoint.time : Date.now();

    const visibleMinutes = CONFIG.graphs.historyMinutes * (isNavigating ? 1 : 2);
    const viewportMs = visibleMinutes * 60000;
    const viewportStart = now - viewportMs;

    const visibleData = d.filter(p => p.time >= viewportStart);
    if (visibleData.length < 2) return;

    const colDanger  = "#ff3b30", colWarning = "#ff9800", colTws = "#2c3e50", colAws = "#5c6bc0";
    const colDepth   = "#0088cc", colStw = "#00C851", colSog = "#ffbb33", colVmg = "#00b8d4";

    const getColorProps = (val) => {
        let color = colTws, opacity = "0.15", stroke = "1";
        if (isTws) {
            const baseWind = (displayModeTws === 'AWS') ? colAws : colTws;
            if (val >= CONFIG.graphs.reef2) { color = colDanger; opacity = "0.55"; stroke = "1.2"; }
            else if (val >= CONFIG.graphs.reef1) { color = colWarning; opacity = "0.45"; stroke = "1"; }
            else color = baseWind;
        } else if (isDepth) {
            if (val < CONFIG.alarms.depthDanger) { color = colDanger; opacity = "0.55"; stroke = "1.2"; }
            else if (val < CONFIG.alarms.depthWarning) { color = colWarning; opacity = "0.45"; stroke = "1"; }
            else color = colDepth;
        } else {
            if (id === 'stw-graph') color = colStw;
            else if (id === 'sog-graph') color = (displayModeSog === 'VMG') ? colVmg : colSog;
        }
        return { color, opacity, stroke };
    };

    let grids = "";
    // Una sola linea di griglia centrale al 50%, matematicamente sempre intera e allineata all'etichetta
    [0.5].forEach(p => grids += `<line x1="0" y1="${h-(p*h)}" x2="${w}" y2="${h-(p*h)}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5" />`);

    const gridInterval = (visibleMinutes <= 15) ? 1 : 5;
    for (let m = gridInterval; m < visibleMinutes; m += gridInterval) {
        const x = w - ((m / visibleMinutes) * w);
        grids += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(0,0,0,0.08)" stroke-width="0.5" />`;
    }

    let gradientStops = "", lines = "", areaPath = "";
    let started = false;

    for (let i = 1; i < visibleData.length; i++) {
        const pA = visibleData[i - 1];
        const pB = visibleData[i];

        const x1 = ((pA.time - viewportStart) / viewportMs) * w;
        const x2 = ((pB.time - viewportStart) / viewportMs) * w;
        const y1 = h - (Math.max(0, Math.min(1, (pA.val - min) / range)) * h);
        const y2 = h - (Math.max(0, Math.min(1, (pB.val - min) / range)) * h);

        const props = getColorProps(pB.val);
        const deltaTime = pB.time - pA.time;
        const expectedInterval = viewportMs / CONFIG.graphs.samples;
        const isGap = deltaTime > (expectedInterval * 2.5);

        const offset1 = (x1 / w) * 100, offset2 = (x2 / w) * 100;
        gradientStops += `<stop offset="${offset1}%" stop-color="${props.color}" stop-opacity="${props.opacity}" />`;
        gradientStops += `<stop offset="${offset2}%" stop-color="${props.color}" stop-opacity="${props.opacity}" />`;

        if (isGap) {
            if (started) {
                areaPath += `L ${x1} ${h} `;
                started = false;
            }
        } else {
            lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${props.color}; stroke-width:${props.stroke}; stroke-linecap:round; shape-rendering:geometricPrecision;" />`;
            if (!started) {
                areaPath += `M ${Math.max(0, x1)} ${h} L ${Math.max(0, x1)} ${y1} `;
                started = true;
            }
            areaPath += `L ${x2} ${y2} `;
        }
    }

    if (started) {
        const last = visibleData[visibleData.length - 1];
        const lastX = ((last.time - viewportStart) / viewportMs) * w;
        areaPath += `L ${lastX} ${h} Z`;
    }

    const gradId = `grad-${id}`;
    const defs = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="${w}" y2="0" gradientUnits="userSpaceOnUse">${gradientStops}</linearGradient></defs>`;
    svg.innerHTML = `${defs}${grids}<path d="${areaPath}" fill="url(#${gradId})" stroke="none" />${lines}`;
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

    el.addEventListener('pointerdown', (e) => {
        isLongPressActive = false;
        pressTimer = setTimeout(() => {
            if (!isFocusActive) {
                isLongPressActive = true;
                toggleFocusMode(type, el);
                lastTapTime = 0;
            }
        }, 1000);
    });

    el.addEventListener('pointerup', (e) => {
        clearTimeout(pressTimer);
        if (isLongPressActive) return;

        const currentTime = new Date().getTime();
        const tapDelay = currentTime - lastTapTime;

        if (tapDelay < 300 && tapDelay > 0) {
            clearTimeout(tapTimeout);
            graphModes[type] = (graphModes[type] === 'standard') ? 'hercules' : 'standard';
            localStorage.setItem('mode_' + type, graphModes[type]);
            refreshGraph(type);
            lastTapTime = 0;
        } else {
            lastTapTime = currentTime;
            tapTimeout = setTimeout(() => {
                if (isFocusActive && el.classList.contains('is-focused')) {
                    toggleFocusMode(type, el);
                } else if (!isFocusActive) {
                    if (type === 'sog') {
                        displayModeSog = (displayModeSog === 'SOG') ? 'VMG' : 'SOG';
                    } else if (type === 'tws') {
                        displayModeTws = (displayModeTws === 'TWS') ? 'AWS' : 'TWS';
                    }
                    el.style.backgroundColor = "rgba(0, 0, 0, 0.05)";
                    setTimeout(() => el.style.backgroundColor = "", 150);
                }
            }, 250);
        }
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
        
        socket.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if (d.updates) {
                d.updates.forEach(u => {
                    // ESTRAZIONE AVANZATA DELLA SORGENTE (Gestisce $source e stringhe native)
                    let sourceLabel = "Unknown";
                    if (u.$source) {
                        sourceLabel = u.$source;
                    } else if (u.source) {
                        if (typeof u.source === 'object') {
                            sourceLabel = u.source.label || u.source.talker || u.source.src || "Unknown";
                        } else {
                            sourceLabel = String(u.source);
                        }
                    }

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
    
    // Prova a caricare lo storico reale dal Cerbo GX tramite l'API deviata
    try {
        await fetchServerHistory();
    } catch (err) {
        console.warn("⚠️ Impossibile caricare lo storico dal server.");
    }

    await fetchServerConfig();
    startDisplayLoop();
    connect(); // Si collegherà in tempo reale al WebSocket del Cerbo (usando l'IP di fallback se sei su Mac)
    
    setInterval(watchConfigChanges, 10000);
}

window.addEventListener('load', init);
window.addEventListener('pagehide', saveDashboardState);
