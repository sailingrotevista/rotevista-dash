/**
    * ==========================================================================
    * Signal K Wind Dashboard - Pro Version 6.0 (Dynamic Envelope Architecture)
    * ==========================================================================
    * Autore: Sailing Rotevista
    * Motore di calcolo tattico per navigazione e crociera.
    * Gestisce: Medie Vettoriali, Deviazione Standard, Trend Strategico dinamico,
    * Memoria UI persistente, Modalità Hercules, Focus Split Screen e
    * Rendering Grafico basato sul Tempo Reale (Timeline e Gap Handling).
    * file app.js
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
    graphs: { reef1: 10, reef2: 15, historyMinutes: 5, samples: 60 },
    scales: {
        stw: { stdMax: 4, hercSpan: 2, step: 1 },
        sog: { stdMax: 4, hercSpan: 2, step: 1 },
        tws: { stdMax: 15, hercSpan: 2, step: 1 },
        depth: { stdMax: 5, hercSpan: 2, step: 1 }
    },
    server: { fallbackIp: "venus.local:3000" }
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
let activeInstrument = 'gauge'; // Modalità di default all'avvio: 'gauge' (analogico) o 'radar' (storico)
let socket, renderInterval, simInterval;
let lastAvgUIUpdate = 0; // Chirurgico: Rimosse audioCtx e lastAlarmTime poiché sono già dichiarate in utils.js
const lastPathProcessTimes = {}; // Registro dei timestamp per limitazione di frequenza client-side a 1Hz

let rotationTrend = 0, meteoTrend = 0;
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
    histories: { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] },
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
    status: document.getElementById('status'), hotspot: document.getElementById('fullscreen-hotspot'),
    tackLabel: document.getElementById('tack-label')
};

let currentTackLabelMode = 'TACK'; // Stato dell'etichetta tattica ('TACK' o 'GYBE') con isteresi

// ==========================================================================
// 3. UTILITIES (MATEMATICA, BUFFER E MEMORIA) - [Esportate in utils.js]
// ==========================================================================

/**
    * Inserimento sicuro nel buffer con trigonometria precaricata e pruning automatico
    * Mantiene sempre almeno 60 minuti di memoria locale per il calcolo della bussola meteo.
    */
function safePush(buffer, val, time) {
    if (val === null || val === undefined || isNaN(val)) return;

    buffer.push({
        val: val,
        time: time,
        sin: Math.sin(val),
        cos: Math.cos(val)
    });

    // Se stiamo spingendo nel buffer TWD, conserviamo sempre almeno 60 minuti in memoria locale
    const isTwdBuffer = (buffer === store.longBuf.twd);
    const limitMinutes = isTwdBuffer ? 60 : CONFIG.graphs.historyMinutes;
    const maxHistoryMs = (limitMinutes * 60000 * 2) + 60000;

    while (buffer.length > 0 && (time - buffer[0].time) > maxHistoryMs) {
        buffer.shift();
    }
    if (buffer.length > 36000) buffer.shift();
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
// 4. AUDIO E ALLARMI - [Esportati in utils.js]
// ==========================================================================

function checkDepthAlarm(m) {
    ui.depth.classList.remove('alarm-warning', 'alarm-danger', 'blink-alarm');
    if (m < CONFIG.alarms.depthDanger) {
        ui.depth.classList.add('alarm-danger', 'blink-alarm');
        // Suona solo se siamo attivamente in navigazione (Harbor Silence acustico quando fermi)
        if (isNavigating) {
            playBingBing();
        }
    } else if (m < CONFIG.alarms.depthWarning) {
        ui.depth.classList.add('alarm-warning');
    }
}

/**
 * computeTrueWind: Calcola TWS, TWA e TWD strategico.
 * Gestisce il fallback separato (Split-Fallback) in caso di dati parzialmente nativi di bordo.
 */
function computeTrueWind() {
    const aws = store.raw["environment.wind.speedApparent"], awa = store.raw["environment.wind.angleApparent"];
    const stw = store.raw["navigation.speedThroughWater"], sog = store.raw["navigation.speedOverGround"] || 0;
    const hdg = store.raw["navigation.headingTrue"]; // Rimosso il default a 0 fittizio all'avvio
    if (aws === undefined || awa === undefined) return;

    const now = store.timestamps["environment.wind.speedApparent"] || Date.now();

    // RILEVAMENTO "LOG BLOCCATO" (Fouled Paddlewheel)
    const hasFreshStw = store.timestamps["navigation.speedThroughWater"] && (now - store.timestamps["navigation.speedThroughWater"] < 15000);
    let speedRef = 0;
    
    if (hasFreshStw && stw !== undefined) {
        // Se la barca naviga a GPS (> 1.5 nodi) ma l'elichetta legge quasi zero (< 0.5 nodi), il log è sporco/bloccato.
        if (sog > 0.77 && stw < 0.25) {
            speedRef = sog; // Forza il backup su SOG ignorando lo "0" fittizio del log
        } else {
            speedRef = stw;
        }
    } else {
        speedRef = sog;
    }

    // ==========================================================================
    // 1. GESTIONE TWS (NATIVO vs FALLBACK)
    // ==========================================================================
    const hasNativeTws = store.timestamps["environment.wind.speedTrue"] && (Date.now() - store.timestamps["environment.wind.speedTrue"] < 5000);
    let tws_water = 0;

    if (hasNativeTws) {
        tws_water = store.raw["environment.wind.speedTrue"] ? msToKts(store.raw["environment.wind.speedTrue"]) : 0;
    } else {
        tws_water = Math.sqrt(aws * aws + speedRef * speedRef - 2 * aws * speedRef * Math.cos(awa));
        store.raw["environment.wind.speedTrue"] = tws_water;
    }
    
    let twa = 0;
    // Verifica se riceviamo un TWA nativo valido ed efficiente negli ultimi 5 secondi
    const hasNativeTwa = store.timestamps["environment.wind.angleTrueWater"] && (Date.now() - store.timestamps["environment.wind.angleTrueWater"] < 5000);

    if (hasNativeTwa && store.raw["environment.wind.angleTrueWater"] !== undefined) {
        // "Native First": diamo la precedenza assoluta al valore calcolato dalla centralina
        twa = store.raw["environment.wind.angleTrueWater"];
    } else {
        // "Fallback Second": se manca il dato nativo, eseguiamo il calcolo vettoriale a mano
        if (tws_water > 0.05) {
            twa = Math.atan2(aws * Math.sin(awa), aws * Math.cos(awa) - speedRef);
            store.raw["environment.wind.angleTrueWater"] = twa;
        }
    }

    // Salviamo e allineiamo i buffer delle medie se abbiamo un angolo valido (nativo o calcolato)
    if (tws_water > 0.05 || hasNativeTwa) {
        safePush(store.smoothBuf.twa, twa, now);
        safePush(store.longBuf.twa, twa, now);
        
        // Salviamo l'angolo apparente solo se il relativo sensore fisico è effettivamente attivo
        if (awa !== undefined) {
            safePush(store.smoothBuf.awa, awa, now);
            safePush(store.longBuf.awa, awa, now);
        }
    }

    // ==========================================================================
    // 2. GESTIONE TWD (NATIVO vs FALLBACK MATEMATICO STABILE)
    // ==========================================================================
    const hasNativeTwd = store.timestamps["environment.wind.directionTrue"] && (Date.now() - store.timestamps["environment.wind.directionTrue"] < 5000);

    // Eseguiamo il calcolo del TWD di fallback solo se la Prua (hdg) è realmente disponibile in memoria,
    // evitando di inquinare i buffer all'avvio con lo zero fittizio
    if (!hasNativeTwd && tws_water > 0.05 && hdg !== undefined) {
        // Calcolo TWD stabile e immune dal rollio: Prua + TWA
        let twd = (hdg + twa + 2 * Math.PI) % (2 * Math.PI);
        store.raw["environment.wind.directionTrue"] = twd;
        safePush(store.smoothBuf.twd, twd, now);
        safePush(store.longBuf.twd, twd, now);
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

function processIncomingData(path, val, source, timeMs) {
    // 0. Filtro di validità assoluta: ignora all'istante pacchetti vuoti, null o non numerici
    if (val === null || val === undefined || (typeof val === 'number' && isNaN(val))) {
        return;
    }

    // 1. Filtro anti-spike vento (> 100 nodi / 51.44 m/s)
    if ((path === "environment.wind.speedApparent" || path === "environment.wind.speedTrue") && val > 51.44) {
        return;
    }

    // 2. Filtro anti-spike velocità barca STW/SOG (> 50 nodi / 25.72 m/s)
    if ((path === "navigation.speedThroughWater" || path === "navigation.speedOverGround") && val > 25.72) {
        return;
    }

    // 3. Filtro validità profondità (ignora errori negativi e letture > 500m per lost-echo)
    if (path === "environment.depth.belowTransducer" && (val < -2.0 || val > 500)) {
        return;
    }
    // Usiamo il tempo reale del pacchetto del server per eliminare lo sfasamento
    const now = timeMs || Date.now();
    const score = getSourcePriorityScore(source);

    // Gestione dello Smart Lock
    if (!sourceLocks[path]) {
        // Nessun blocco attivo: aggancia la sorgente corrente
        sourceLocks[path] = { label: source, score: score, lastSeen: now };
    } else {
        const currentLock = sourceLocks[path];
        const isSameSource = (currentLock.label === source);
        // Tolleranza 5s: ignora il GPS Victron durante le micro-pause di Yacht Device per evitare imprecisioni
        const isLockExpired = (now - currentLock.lastSeen > 5000);
        const hasHigherPriority = (score > currentLock.score);
        // Switch immediato tra apparati principali di pari priorità (es. YD e AP) se inattivi da > 1.5s
        const isSamePriorityStale = (score === currentLock.score && (now - currentLock.lastSeen > 1500));

        if (isSameSource) {
            // Stessa sorgente: aggiorna il timestamp e mantiene il blocco
            currentLock.lastSeen = now;
            currentLock.score = score;
        } else if (hasHigherPriority || isLockExpired || isSamePriorityStale) {
            // Passa a sorgenti secondarie (Victron) solo se Yacht Device è spento da > 5s
            sourceLocks[path] = { label: source, score: score, lastSeen: now };
            console.log(`🔌 [Smart Lock] Path "${path}" switched to: ${source} (Score: ${score})`);
        } else {
            // Scarta sorgenti imprecise di servizio mentre Yacht Device è la sorgente principale attiva
            return;
        }
    }

// Aggiorna lo stato raw e sincronizza il timestamp del watchdog sull'orologio locale (Date.now()) per evitare falsi timeout
    const localNow = Date.now();
    store.timestamps[path] = localNow;
    store.raw[path] = val;

    // Converte e aggiorna istantaneamente store.raw["navigation.headingTrue"] per la UI prima del rate limiter
    if (path === "navigation.headingMagnetic") {
        const hasNativeTrueHdg = store.timestamps["navigation.headingTrueNative"] && (localNow - store.timestamps["navigation.headingTrueNative"] < 5000);
        if (!hasNativeTrueHdg) {
            const variation = store.raw["navigation.magneticVariation"] || 0;
            store.raw["navigation.headingTrue"] = (val + variation + 2 * Math.PI) % (2 * Math.PI);
            store.timestamps["navigation.headingTrue"] = localNow;
        }
    }

    // Le coordinate GPS e la posizione non sono soggette alla limitazione a 1Hz
    if (path === "navigation.position") {
        return; // Esce subito
    }

    // LIMITATORE DI FREQUENZA (RATE LIMITER) CLIENT-SIDE A 1HZ PER PERCORSO ATTIVO:
    if (!lastPathProcessTimes[path]) lastPathProcessTimes[path] = 0;
    if (now - lastPathProcessTimes[path] < 800) {
        return; // Esce subito risparmiando cicli di calcolo
    }
    lastPathProcessTimes[path] = now;

    // Da qui in poi, l'inserimento nei buffer fisici avviene rigorosamente a 1Hz:
    //if (path === "environment.wind.angleApparent") {
    //  safePush(store.smoothBuf.awa, val, now);
    //  safePush(store.longBuf.awa, val, now);
    //}

    // BUG RISOLTO: Intercetta il TWD nativo e lo spinge nei buffer della bussola radar
    if (path === "environment.wind.directionTrue") {
        let directionVal = (val && typeof val === 'object' && val.val !== undefined) ? val.val : val;
        safePush(store.smoothBuf.twd, directionVal, now);
        safePush(store.longBuf.twd, directionVal, now);
    }

    // BUG RISOLTO: Intercetta il TWS nativo e lo memorizza in tempo reale
    if (path === "environment.wind.speedTrue") {
        let speedVal = (val && typeof val === 'object' && val.val !== undefined) ? val.val : val;
        store.raw["environment.wind.speedTrue"] = speedVal;
    }

    // INTERCETTAZIONE TWA NATIVO (Angolo Vento Reale pronto all'uso)
    if (path === "environment.wind.angleTrueWater") {
        let angleVal = (val && typeof val === 'object' && val.val !== undefined) ? val.val : val;
        store.raw["environment.wind.angleTrueWater"] = angleVal;
    }
    
    // --- GESTIONE PRUA VERA / MAGNETICA CON AUTODIVIAZIONE ---
    if (path === "navigation.headingTrue") {
        store.timestamps["navigation.headingTrueNative"] = now; // Marca la presenza di un sensore nativo di prua vera
        store.timestamps["navigation.headingTrue"] = now;
        safePush(store.smoothBuf.hdg, val, now);
        safePush(store.longBuf.hdg, val, now);
    }
    else if (path === "navigation.headingMagnetic") {
        // Se non c'è una prua vera NATIVA negli ultimi 5 secondi, converte e registra ad ogni secondo la prua magnetica
        const hasNativeTrueHdg = store.timestamps["navigation.headingTrueNative"] && (now - store.timestamps["navigation.headingTrueNative"] < 5000);
        if (!hasNativeTrueHdg) {
            const variation = store.raw["navigation.magneticVariation"] || 0; // Legge la declinazione magnetica del GPS
            const calculatedTrueHdg = (val + variation + 2 * Math.PI) % (2 * Math.PI);
            
            // Registra il valore calcolato mantenendo attivo il watchdog senza bloccare i successivi pacchetti magnetici
            store.raw["navigation.headingTrue"] = calculatedTrueHdg;
            store.timestamps["navigation.headingTrue"] = now;
            safePush(store.smoothBuf.hdg, calculatedTrueHdg, now);
            safePush(store.longBuf.hdg, calculatedTrueHdg, now);
        }
    }
    
    if (path === "navigation.courseOverGroundTrue") {
        safePush(store.smoothBuf.cog, val, now);
        safePush(store.longBuf.cog, val, now);

        // Se non è installata alcuna bussola fisica sulla rete e la barca è in movimento stabile (> 1.5 nodi),
        // emuliamo la Prua usando il COG per attivare il TWD, il mini-compass e la bussola radar.
        const hasCompass = store.raw["navigation.headingTrue"] !== undefined || store.raw["navigation.headingMagnetic"] !== undefined;
        const sog = store.raw["navigation.speedOverGround"] || 0;
        if (!hasCompass && sog > 0.77) { // 0.77 m/s = 1.5 nodi
            store.raw["navigation.headingTrue"] = val;
            store.timestamps["navigation.headingTrue"] = now; // (AGGIUNTO - RISOLVE IL LOCKOUT COG)
            safePush(store.smoothBuf.hdg, val, now);
            safePush(store.longBuf.hdg, val, now);
        }
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
// Sincronizzato sul tempo reale dei sensori per eliminare i conflitti di orologio.
// ==========================================================================
function updateWindTrend() {
    // --- RISOLUZIONE CLOCK DRIFT SUI PALLINI METEO ---
    // Usiamo il tempo del sensore (l'ultimo dato del TWD in memoria) invece dell'orologio del tablet
    const latestTwdPoint = store.longBuf.twd.length > 0 ? store.longBuf.twd[store.longBuf.twd.length - 1] : null;
    const now = latestTwdPoint ? latestTwdPoint.time : Date.now();

    // --- 6.1 TREND TATTICO (AWA/TWA Sintonizzato) ---
    const twaNow = getCircularAverageFromBuffer(store.longBuf.twa, 2000, true, now);
    const twaRef = getCircularAverageFromBuffer(store.longBuf.twa, 10000, true, now);
    const gaugeDots = { cw: document.getElementById('trend-gauge-cw'), ccw: document.getElementById('trend-gauge-ccw') };

    // --- 6.2 ALLARME STRAMBATA CON ISTERESI (MACCHINA A STATI ANTI-BRANDEGGIO Sintonizzato) ---
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
            if (gaugeDots.ccw) { gaugeDots.ccw.classList.remove('is-gybing'); }

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

                    // Estraggo i dati correnti di vento reale (TWS), velocità (SOG) e l'angolo TWA smorzato
                    const twsKts = store.raw["environment.wind.speedTrue"] ? msToKts(store.raw["environment.wind.speedTrue"]) : 0;
                    const sogKts = msToKts(store.raw["navigation.speedOverGround"] || 0);
                    const twaDeg = Math.abs(smoothedTwaDeg);

                    // RILEVAMENTO AERODINAMICO MOTORE IN POPPA:
                    // Se siamo di poppa (TWA > 135°) e la velocità della barca supera il 75% della velocità del vento reale,
                    // è fisicamente impossibile essere a vela pura. Siamo a motore o in motorsailing.
                    const isMotoringDownwind = (twaDeg > 135) && (sogKts > (twsKts * 0.75));

                    // L'allarme strambata acustico è reale e attivo solo se:
                    // 1. C'è vento significativo (> 7.0 nodi)
                    // 2. La barca è in movimento (> 1.0 nodi)
                    // 3. NON siamo a motore/motorsailing (isMotoringDownwind è falso)
                    const isGybeDangerous = twsKts > 7.0 && sogKts > 1.0 && !isMotoringDownwind;

                    // Attivazione allarme acustico con blocco temporale di sicurezza (60 secondi)
                    if (isGybeDangerous && (now - lastGybeAlarmTime > 60000)) {
                        lastGybeAlarmTime = now;
                        playGybeAlarm();
                        console.log(`⚠️ GYBE ALARM TRIGGERED: Tack switched to ${currentTack} (TWA: ${twaDeg.toFixed(1)}°, TWS: ${twsKts.toFixed(1)}kts, SOG: ${sogKts.toFixed(1)}kts)`);
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
                if (gaugeDots.ccw) { gaugeDots.ccw.classList.remove('is-trending'); gaugeDots.ccw.setAttribute('fill', '#bbb'); } // Resetta l'attributo di riempimento del pallino inattivo
            } else {
                if (gaugeDots.ccw) { gaugeDots.ccw.classList.add('is-trending'); gaugeDots.ccw.setAttribute('fill', tacticColor); }
                if (gaugeDots.cw) { gaugeDots.cw.classList.remove('is-trending'); gaugeDots.cw.setAttribute('fill', '#bbb'); } // Resetta l'attributo di riempimento del pallino inattivo
            }
        } else {
            [gaugeDots.cw, gaugeDots.ccw].forEach(el => { if(el){ el.classList.remove('is-trending'); el.setAttribute('fill', '#bbb'); }});
        }
    }

    // --- 6.3 TREND METEO STRATEGICO (TWD PARAMETRIZZATO E SINTONIZZATO) ---
    const twdNow = getCircularAverageFromBuffer(store.longBuf.twd, 60000, false, now); // 1 minuto fisso

    // Parametrizzazione rigida nel codice: 15 minuti in navigazione, 60 minuti all'ancora
    const fixedTwdMinutes = isNavigating ? 15 : 60;
    const strategicWindowMs = fixedTwdMinutes * 60000;

    const twdRef = getCircularAverageFromBuffer(store.longBuf.twd, strategicWindowMs, false, now);

    const compassDots = { cw: document.getElementById('trend-dot-cw'), ccw: document.getElementById('trend-dot-ccw') };

    if (twdNow && twdRef) {
        let deltaMeteo = radToDeg((twdNow.val - twdRef.val + Math.PI * 3) % (2 * Math.PI) - Math.PI);
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
        const isSocketOpen = socket && socket.readyState === WebSocket.OPEN;
        
        if (isSocketOpen) {
            ui.status.className = "online"; // Colore Verde
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
        } else {
            ui.status.className = "offline"; // Colore Rosso
            ui.status.innerText = "OFFLINE"; // Chirurgico: Forza il testo a OFFLINE se il socket è chiuso, evitando scritte verdi in rosso
        }

        // --- WATCHDOG: CONTROLLO TIMEOUT ---
        const watch = {
            "navigation.speedThroughWater": ui.stw, "navigation.speedOverGround": ui.sog,
            "navigation.headingTrue": ui.hdg, "navigation.courseOverGroundTrue": ui.cog,
            "environment.wind.speedApparent": ui.awsSvg, "environment.depth.belowTransducer": ui.depth,
            "environment.wind.speedTrue": ui.tws
        };
        for (let p in watch) {
            if (!store.timestamps[p] || (now - store.timestamps[p] > TIMEOUT_MS)) {
                safeSetText(watch[p], "---"); // Sostituito innerText con la funzione protetta!
                delete store.raw[p];

                // Forza lo scorrimento dei dati fuori dallo schermo per i sensori in timeout
                if (p === "navigation.speedThroughWater") {
                    refreshGraph('stw');
                } else if (p === "navigation.speedOverGround") {
                    refreshGraph('sog');
                } else if (p === "environment.depth.belowTransducer") {
                    refreshGraph('depth');
                } else if (p === "environment.wind.speedApparent" || p === "environment.wind.speedTrue") {
                    refreshGraph('tws');
                }
            }
        }

        // --- AGGIORNAMENTO VELOCITÀ SULL'ACQUA (STW) ---
        if (store.raw["navigation.speedThroughWater"] !== undefined) {
            safeSetText(ui.stw, stwKts.toFixed(1));
            ui.stw.style.color = ""; // Neutro
            manageHistory('stw', stwKts);
        }
        
        // --- LOGICA SOG / VMG ---
        if (store.raw["navigation.speedOverGround"] !== undefined) {
            // RILEVAMENTO "LOG BLOCCATO" PER IL CALCOLO VMG
            const hasFreshStw = store.timestamps["navigation.speedThroughWater"] && (now - store.timestamps["navigation.speedThroughWater"] < 15000);
            let speedRefKts = sogKts; // Fallback predefinito su GPS
            
            if (hasFreshStw) {
                // Se viaggiamo a più di 1.5 nodi (GPS) ma il log segna meno di 0.5 nodi, usa il SOG come backup
                speedRefKts = (sogKts > 1.5 && stwKts < 0.5) ? sogKts : stwKts;
            }

            const vmgVal = Math.abs(speedRefKts * Math.cos(store.raw["environment.wind.angleTrueWater"] || 0));
            manageHistory('vmg', vmgVal);
            manageHistory('sog', sogKts);
            
            const labelSogVmg = document.getElementById('sog-vmg-label');
            if (displayModeSog === 'VMG') {
                safeSetText(ui.sog, vmgVal.toFixed(1));
                ui.sog.style.setProperty('color', '#00b8d4', 'important'); // Cyan
                if (labelSogVmg) labelSogVmg.textContent = 'VMG';
            } else {
                safeSetText(ui.sog, sogKts.toFixed(1));
                if (labelSogVmg) labelSogVmg.textContent = 'SOG';
                
                if (isNavigating) {
                    const hasFreshStw = store.timestamps["navigation.speedThroughWater"] && (now - store.timestamps["navigation.speedThroughWater"] < 15000);
                    // Rileviamo se il log è plausibilmente sporco o bloccato (SOG in movimento, STW a zero)
                    const isFouledLog = (sogKts > 1.5 && stwKts < 0.5);

                    // Se non abbiamo un log affidabile, è impossibile calcolare la corrente. Evitiamo falsi colori tattici.
                    if (!hasFreshStw || isFouledLog) {
                        ui.sog.style.removeProperty('color');
                    } else {
                        const lastSog = store.histories.sog.length > 0 ? store.histories.sog[store.histories.sog.length - 1].val : sogKts;
                        const lastStw = store.histories.stw.length > 0 ? store.histories.stw[store.histories.stw.length - 1].val : stwKts;
                        const drift = lastSog - lastStw;

                        if (drift < -0.3) ui.sog.style.setProperty('color', '#ff3b30', 'important'); // Contro
                        else if (drift > 0.3) ui.sog.style.setProperty('color', '#00C851', 'important'); // Favore
                        else ui.sog.style.setProperty('color', '#ffbb33', 'important'); // Neutro SOG
                    }
                } else {
                    ui.sog.style.removeProperty('color');
                }
            }
        }

        // --- AGGIORNAMENTO PROFONDITÀ (DEPTH) ---
        if (store.raw["environment.depth.belowTransducer"] !== undefined) {
            safeSetText(ui.depth, store.raw["environment.depth.belowTransducer"].toFixed(1));
            checkDepthAlarm(store.raw["environment.depth.belowTransducer"]);
            manageHistory('depth', store.raw["environment.depth.belowTransducer"]);
        }

        // --- GESTIONE VENTO (TWS / AWS SWITCH & BUSSOLA) ---
                
        // Estrazione dati sicura: controlliamo esplicitamente se il dato esiste, altrimenti 0
        const rawTws = store.raw["environment.wind.speedTrue"];
        const rawAws = store.raw["environment.wind.speedApparent"];
        
        const twsVal = (rawTws !== undefined && rawTws !== null) ? msToKts(rawTws) : 0;
        const awsVal = (rawAws !== undefined && rawAws !== null) ? msToKts(rawAws) : 0;
        
        if (rawTws !== undefined && rawTws !== null) manageHistory('tws', twsVal);
        if (rawAws !== undefined && rawAws !== null) manageHistory('aws', awsVal);

        // Disegno testo casella destra (TWS o AWS)
        if (rawTws !== undefined || rawAws !== undefined) {
            const labelWind = document.getElementById('tws-aws-label');
            const currentWind = (displayModeTws === 'AWS') ? awsVal : twsVal;
            
            safeSetText(ui.tws, currentWind.toFixed(1));
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

        // --- AGGIORNAMENTO DELLA BUSSOLA CENTRALE (BATTERY SAVER A 1Hz) ---
        if (activeInstrument === 'gauge') {
            updateCentralGauge(store, ui, now, isNavigating, sogKts, stwKts, rawAws, awsVal);
        }
        
        // --- SLOW TIER (Salvataggio stato ogni 10 secondi) ---
        if (lastAvgUIUpdate++ % 10 === 0) {
            saveDashboardState();
        }

        // AGGIORNAMENTO FLUIDO MEDIE UI (Esecuzione a 1Hz costante ad ogni secondo)
        const baseThreshold = CONFIG.averaging.stabilityThreshold || 0.95;
        const breakout = CONFIG.averaging.stabilityBreakout || 15;
        
        // CALCOLO DIFFERENZIALE: Tolleranza del vento proporzionale alla sensibilità di base
        const windThreshold = Math.max(0.60, baseThreshold - 0.13);

        let hObj = getCircularAverageFromBuffer(store.longBuf.hdg, CONFIG.averaging.longWindow * 2, false, now, baseThreshold, breakout);
        let cObj = getCircularAverageFromBuffer(store.longBuf.cog, CONFIG.averaging.longWindow, false, now, baseThreshold, breakout);
        
        // Applichiamo la soglia differenziale ottimizzata per i tre dati legati al vento
        let awObj = getCircularAverageFromBuffer(store.longBuf.awa, CONFIG.averaging.longWindow, true, now, windThreshold, breakout);
        let twObj = getCircularAverageFromBuffer(store.longBuf.twa, CONFIG.averaging.longWindow, true, now, windThreshold, breakout);
        let twdObj = getCircularAverageFromBuffer(store.longBuf.twd, CONFIG.averaging.longWindow, false, now, windThreshold, breakout);

        // --- GESTIONE DINAMICA ETICHETTA TACK/GYBE CON ISTERESI DI 10 GRADI ---
        if (ui.tackLabel) {
            const absTwa = Math.abs(radToDeg(store.raw["environment.wind.angleTrueWater"] || 0));
            if (currentTackLabelMode === 'TACK' && absTwa > 95) {
                currentTackLabelMode = 'GYBE';
            } else if (currentTackLabelMode === 'GYBE' && absTwa < 85) {
                currentTackLabelMode = 'TACK';
            }
            safeSetText(ui.tackLabel, currentTackLabelMode);
        }

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
    * Recupera lo storico dei grafici e dei radar pre-popolato dal server Signal K (Pro v6.0)
    */
async function fetchServerHistory() {
    try {
        const response = await fetch(getApiUrl('/rotevista-history'));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        
        if (data && typeof data === 'object') {
            // 1. RILEVAMENTO DEL DELTA DI COERENZA TEMPORALE
            // Troviamo il timestamp più recente in assoluto presente nei dati storici del server
            let maxServerTime = 0;
            for (let key in data) {
                if (store.histories[key] !== undefined && Array.isArray(data[key]) && data[key].length > 0) {
                    const lastPoint = data[key][data[key].length - 1];
                    if (lastPoint && lastPoint.time > maxServerTime) {
                        maxServerTime = lastPoint.time;
                    }
                }
            }

            // Calcoliamo lo sfasamento in millisecondi rispetto all'orologio del client (MacBook/Tablet)
            const nowMac = Date.now();
            const timeDelta = (maxServerTime > 0) ? (nowMac - maxServerTime) : 0;

            if (Math.abs(timeDelta) > 500) {
                console.log(`⏱️ [Clock Sync] Rilevato scostamento di ${(timeDelta/1000).toFixed(1)}s rispetto a einstein. Calibrazione attiva.`);
            }

            // 2. TRASLAZIONE DEI DATI STORICI
            // Spostiamo nel tempo tutti i punti passati per incollarli millimetricamente al "now" del client
            for (let key in data) {
                if (store.histories[key] !== undefined) {
                    if (Array.isArray(data[key])) {
                        store.histories[key] = data[key].map(p => ({
                            val: p.val,
                            time: p.time + timeDelta, // Sposta il punto nel tempo per allinearlo al Mac
                            min: p.min !== undefined ? p.min : undefined,
                            max: p.max !== undefined ? p.max : undefined
                        }));
                    } else {
                        store.histories[key] = data[key];
                    }
                }
            }

            // Sincronizza i dati specifici del radar storici mantendo i timestamp calendarizzati assoluti (0% sfasamento dei perni)
            if (data.windRadarSlots) {
                store.windRadarSlots = data.windRadarSlots; // Mantiene gli orari spaccati al minuto per l'uguaglianza del radar
            }
            if (data.futureForecast) {
                store.futureForecast = {
                    ...data.futureForecast,
                    timestamp: data.futureForecast.timestamp + timeDelta
                };
            }
            if (data.twd) {
                store.twdMinuteBuffer = data.twd.map(p => ({
                    ...p,
                    time: p.time + timeDelta
                }));
            }
            if (data.tws) {
                store.twsMinuteBuffer = data.tws.map(p => ({
                    ...p,
                    time: p.time + timeDelta
                }));
            }
            
            // Sincronizziamo lo storico dei minuti per il radar, ma lasciamo che il buffer rapido 'store.longBuf.twd'
            // parta pulito all'avvio. Si popolerà istantaneamente a 3Hz con i soli dati in tempo reale,
            // garantendo una reattività della direzione del vento (TWD) immediata e priva di sbalzi all'avvio.
            console.log("📈 Storico dei grafici pre-popolato caricato dal server.");
        }
    } catch (err) {
        console.warn("⚠️ Impossibile caricare lo storico dal server. Utilizzo dati vuoti/simulati.");
        throw err;
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

    // --- 2. INIT SICURO (Sintonizzato all'epoca assoluta UTC) ---
    if (!store.graphTempBuf[type]) store.graphTempBuf[type] = [];
    if (!store.histories[type]) store.histories[type] = [];
    
    // SINTONIZZAZIONE DI FASE: Agganciamo il timer iniziale al multiplo UTC più vicino
    if (store.lastUpdates[type] === undefined || store.lastUpdates[type] === 0) {
        store.lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
    }

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

    // --- 5. AGGREGAZIONE SEMANTICA (Ottimizzata a zero-allocazioni di array intermedi) ---
    let finalValue = value;

    if (tempBuf.length > 0) {
        // A. VENTO -> SUSTAINED PEAK (EMA Time-Aware) (0 allocazioni)
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
        // B. PROFONDITÀ -> MINIMO (In-place loop, 0 allocazioni)
        else if (type === 'depth') {
            let minVal = Infinity;
            for (let i = 0; i < tempBuf.length; i++) {
                const v = tempBuf[i].val;
                if (isFinite(v) && v < minVal) {
                    minVal = v;
                }
            }
            if (minVal !== Infinity) {
                finalValue = minVal;
            }
        }
        // C. VELOCITÀ -> MEDIA (In-place loop, 0 allocazioni)
        else {
            let sum = 0;
            let count = 0;
            for (let i = 0; i < tempBuf.length; i++) {
                const v = tempBuf[i].val;
                if (isFinite(v)) {
                    sum += v;
                    count++;
                }
            }
            if (count > 0) {
                finalValue = sum / count;
            }
        }
    }

    // --- 6. CLAMPING E VALIDAZIONE FINALE ---
    if (!isFinite(finalValue)) return;
    finalValue = Math.max(0, finalValue);

    // --- 7. STORAGE STORICO ---
    store.histories[type].push({ val: finalValue, time: now });
    
    // --- TRIGGER STRATEGIA 1 (EVENT-DRIVEN) ---
    // Ridisegnamo lo strumento SOLO nell'esatto istante in cui viene generato un nuovo punto storico!
    refreshGraph(type);

    // --- 8. PRUNING DINAMICO ---
    const maxViewportMinutes = historyMinutes * 2;
    const maxHistoryMs = (maxViewportMinutes * 60000) + 60000;

    while (store.histories[type].length > 0 && (now - store.histories[type][0].time) > maxHistoryMs) {
        store.histories[type].shift();
    }

    // Reset per il prossimo bucket (sincronizzato)
    store.graphTempBuf[type] = [];
    store.lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
}

// ==========================================================================
// 9. INTERAZIONI E GESTI
// ==========================================================================
function toggleFocusMode(type, element) {
    const container = document.querySelector('.main-container');
    const isLeft = ['stw', 'sog', 'hdg', 'cog', 'tack'].includes(type);
    isFocusActive = !isFocusActive;
    if (isFocusActive) {
        container.classList.add('focus-active', isLeft ? 'focus-side-left' : 'focus-side-right');
        element.classList.add('is-focused');
    } else {
        container.classList.remove('focus-active', 'focus-side-left', 'focus-side-right');
        document.querySelectorAll('.data-box').forEach(b => b.classList.remove('is-focused'));
    }
    
    // --- FORZATURA REDRAW IMMEDIATO DUAL SCREEN ---
    // Quando entriamo o usciamo dal Focus, ridisegnamo subito lo strumento
    // interessato per applicare istantaneamente il cambio di spessore della linea!
    if (['stw', 'sog', 'tws', 'depth'].includes(type)) {
        refreshGraph(type);
    }
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
                        refreshGraph('sog'); // --- FORZA RINFRESCO ISTANTANEO AL CAMBIO SOG/VMG ---
                    } else if (type === 'tws') {
                        displayModeTws = (displayModeTws === 'TWS') ? 'AWS' : 'TWS';
                        refreshGraph('tws'); // --- FORZA RINFRESCO ISTANTANEO AL CAMBIO TWS/AWS ---
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
        // Connessione con subscribe=none per impedire a Signal K l'invio automatico di tutto lo stream di bordo
        socket = new WebSocket(`ws://${addr}/signalk/v1/stream?subscribe=none`);
        
        socket.onopen = async () => {
            ui.status.className = "online";
            ui.status.innerText = "ONLINE";
            reconnectDelay = 1000;
            
            // Sottoscrizione selettiva bilanciata: applichiamo un filtro a 3 Hz (333ms) per i dati rapidi,
            // garantendo fluidità matematica senza ritardi e ottimizzando profondità (1s) e GPS (10s)
            const subscriptionPayload = {
                context: "vessels.self",
                subscribe: [
                    { path: "navigation.position", minPeriod: 60000 },             // Posizione GPS lenta (60s)
                    { path: "navigation.magneticVariation", minPeriod: 60000 },    // Declinazione lenta (60s)
                    { path: "environment.depth.belowTransducer", minPeriod: 1000 }, // Profondità di sicurezza (1s)
                    { path: "navigation.speedThroughWater", minPeriod: 333 },       // Velocità barca a 3 Hz (333ms)
                    { path: "navigation.speedOverGround", minPeriod: 333 },          // Velocità GPS a 3 Hz
                    { path: "navigation.courseOverGroundTrue", minPeriod: 333 },    // COG a 3 Hz
                    { path: "navigation.headingTrue", minPeriod: 333 },             // Heading True a 3 Hz
                    { path: "navigation.headingMagnetic", minPeriod: 333 },         // Heading Fallback a 3 Hz
                    { path: "environment.wind.speedApparent", minPeriod: 333 },     // AWS a 3 Hz
                    { path: "environment.wind.angleApparent", minPeriod: 333 },     // AWA a 3 Hz
                    { path: "environment.wind.speedTrue", minPeriod: 333 },         // TWS (Nativo) a 3 Hz
                    { path: "environment.wind.angleTrueWater", minPeriod: 333 },    // TWA (Nativo) a 3 Hz (AGGIUNTO)
                    { path: "environment.wind.directionTrue", minPeriod: 333 }      // TWD (Nativo) a 3 Hz
                ]
            };
            
            // Invio del payload per configurare lo streaming selettivo a 3 Hz
            try {
                socket.send(JSON.stringify(subscriptionPayload));
                console.log("🔌 [WebSocket] Sottoscrizione selettiva a 3 Hz inviata con successo (Latenza azzerata).");
            } catch (err) {
                console.error("❌ [WebSocket] Impossibile inviare il payload di sottoscrizione:", err);
            }
            
            // SINCRONIZZAZIONE AUTOMATICA: Ogni volta che la connessione si apre o si riapre,
            // scarichiamo lo storico fresco dal server e ridisegnamo i grafici
            try {
                await fetchServerHistory();
                ['stw', 'sog', 'depth', 'tws'].forEach(refreshGraph);
            } catch (err) {
                console.warn("⚠️ Sincronizzazione storico fallita alla connessione:", err);
            }
        };
        
        socket.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if (d.updates) {
                d.updates.forEach(u => {
                    // Sincronizzazione dell'orologio sul tempo reale del server (NMEA/GPS)
                    const timeMs = u.timestamp ? new Date(u.timestamp).getTime() : Date.now();
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
                        u.values.forEach(v => processIncomingData(v.path, v.value, sourceLabel, timeMs));
                    }
                });
            }
        };

        socket.onclose = () => {
            if (!simulationMode) {
                ui.status.className = "offline";
                ui.status.innerText = "OFFLINE";
                
                // Tentiamo la riconnessione automatica solo se lo schermo è attivo e visibile,
                // evitando cicli di loop di rete infiniti in background mentre il tablet dorme
                if (document.visibilityState === "visible") {
                    ui.status.innerText = "RECONNECTING...";
                    setTimeout(connect, reconnectDelay);
                    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
                }
            }
        };
    } catch (e) {
        setTimeout(connect, reconnectDelay);
    }
}

// ==========================================================================
// 11. INIT E CICLO DI VITA
// ==========================================================================
window.addEventListener('contextmenu', e => e.preventDefault(), true);

async function init() {
    loadDashboardState();
    
    // Disegna la grafica statica delle tacche di calibrazione di entrambi gli strumenti
    initCompassTicks(); // Tacche del Wind Gauge analogico (gauge.js)
    initRadarTicks();   // Tacche del Wind Radar storico (weather-radar.js)
    
    // 1. COMANDO TATTICO: Gestore Box TWD (Pressione prolungata -> Radar | Tocco rapido in modalità Radar -> Torna a Gauge)
    const twdBox = document.querySelector('.box-twd');
    if (twdBox) {
        let twdPressTimer = null;
        let longPressTriggered = false; // Flag di controllo della pressione prolungata
        
        twdBox.addEventListener('pointerdown', (e) => {
            longPressTriggered = false;
            if (activeInstrument === 'gauge') {
                twdPressTimer = setTimeout(() => {
                    activeInstrument = 'radar';
                    document.getElementById('wind-gauge').style.display = 'none';
                    document.getElementById('wind-radar').style.display = 'block';
                    renderRadar(); // Disegna immediatamente il radar all'attivazione
                    twdPressTimer = null;
                    longPressTriggered = true; // Segnala che la transizione al radar è avvenuta con successo
                }, 1000);
            }
        });
        twdBox.addEventListener('pointerup', () => {
            if (activeInstrument === 'gauge') {
                if (twdPressTimer) {
                    clearTimeout(twdPressTimer);
                    twdPressTimer = null;
                }
            } else if (activeInstrument === 'radar') {
                if (longPressTriggered) {
                    // Se l'evento di rilascio appartiene al tocco prolungato che ha appena attivato il radar, lo ignoriamo
                    longPressTriggered = false;
                } else {
                    // Altrimenti è un tocco rapido indipendente: torna alla bussola analogica
                    activeInstrument = 'gauge';
                    document.getElementById('wind-radar').style.display = 'none';
                    document.getElementById('wind-gauge').style.display = 'block';
                }
            }
        });
        twdBox.addEventListener('pointerleave', () => {
            if (twdPressTimer) {
                clearTimeout(twdPressTimer);
                twdPressTimer = null;
            }
            longPressTriggered = false;
        });
    }

    // 2. COMANDO TATTICO: Click in qualsiasi punto del radar per tornare all'analogico
    const windRadarSvg = document.getElementById('wind-radar');
    if (windRadarSvg) {
        windRadarSvg.addEventListener('pointerup', () => {
            if (activeInstrument === 'radar') {
                activeInstrument = 'gauge';
                windRadarSvg.style.display = 'none';
                document.getElementById('wind-gauge').style.display = 'block';
            }
        });
    }

    // Rileviamo se siamo sul Mac tramite file:// (Ambiente di sviluppo locale)
    const isLocalFile = (window.location.protocol === 'file:');

    // 3. CARICAMENTO STORICO GRAFICI E RADAR REALI DAL CERBO GX
    try {
        await fetchServerHistory();
    } catch (err) {
        console.warn("⚠️ Impossibile caricare lo storico reale dal server.");
    }

    // 4. CARICAMENTO CONFIGURAZIONI REALI (Bypassato su Mac per preservare i tuoi test!)
    if (!isLocalFile) {
        await fetchServerConfig();
    } else {
        console.log("🎮 Esecuzione locale file://: utilizzo delle calibrazioni di CONFIG locali di debug.");
    }
    
    startDisplayLoop();
    connect(); // Si collegherà in tempo reale al WebSocket reale della barca
    
    // 5. POLL LENTO (15 secondi): aggiorna i dati radar in background SOLO se lo strumento attivo è il radar,
    // evitando di sovraccaricare la rete ed eliminando il salto visivo di reset dei grafici a 1Hz
    setInterval(async () => {
        try {
            if (activeInstrument === 'radar') {
                await fetchServerHistory();
                renderRadar();
            }
        } catch (err) {
            console.warn("⚠️ Errore aggiornamento periodico storico:", err);
        }
    }, 15000);

    // Controlla le modifiche di configurazione sul Cerbo solo se non siamo sul Mac via file://
    if (!isLocalFile) {
        setInterval(watchConfigChanges, 10000);
    }
}

// Watchdog attivo per la gestione intelligente dello standby e il massimo risparmio energetico
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        console.log("🔌 [Watchdog] Schermo sbloccato / Tab visibile. Riconnessione immediata e allineamento storico...");
        // Al risveglio stabiliamo una nuova connessione pulita che scaricherà lo storico accumulato in background dal server
        connect();
    } else if (document.visibilityState === 'hidden') {
        console.log("🔌 [Watchdog] Schermo bloccato / Tab in background. Chiusura WebSocket preventiva per salvaguardare la batteria.");
        // Tagliamo attivamente la connessione per congelare all'istante l'attività di rete ed i consumi del browser
        if (socket) {
            socket.close();
        }
    }
});

window.addEventListener('load', init);
window.addEventListener('pagehide', saveDashboardState);
