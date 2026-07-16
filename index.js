/**
    * ==========================================================================
    * Rotevista Dash Configuration & History Plugin (Pro v6.0)
    * ==========================================================================
    * Definisce l'interfaccia di configurazione in Signal K Admin e crea
    * gli endpoint pubblici per la Dashboard, mantenendo lo storico in RAM.
    * file index.js
    */
const https = require('https'); // Importazione del modulo HTTPS nativo di Node.js

module.exports = function (app) {
    const plugin = {};
    plugin.id = 'rotevista-dash';
    plugin.name = 'Rotevista Dash Configuration';
    plugin.description = 'Configure boat-specific tactical and safety parameters for the Dashboard';

    let currentConfig = {};
    let routeRegistered = false;
    let unsubscribes = [];
    let pruneInterval = null; // Timer in background per la potatura automatica dei sensori spenti

    // ==========================================================================
    // COSTANTI DI SVILUPPO (DEVELOPER CONFIG)
    // ==========================================================================
    const CALM_THRESHOLD_KTS = 1.5;      // Soglia di calma piatta (anello a 360°)
    const PRESSURE_FILTER_RATIO = 0.40;  // Filtro di pressione dinamico (40% del picco per ignorare i cali)

    // Database dello storico in RAM sul server (Sintonizzato Pro v6.0)
    let histories = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
    let graphTempBuf = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
    let lastUpdates = { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0, twd: 0 };
    let raw = {};
    let lastPathProcessTimes = {}; // Registro dei timestamp per limitazione di frequenza a 1Hz
    
    // Nuovo database dedicato per gli archi storici della bussola (6 ore = 12 slot)
    let windRadarSlots = [];
    
    // Memoria temporale per rilevare la presenza di sensori nativi sul Cerbo
    let lastNativeTwsTime = 0;
    let lastNativeTwdTime = 0;
    
    // Monitoraggio dello scorrere dei blocchi da 30 minuti
    let lastFrozen30mSlot = 0;
    
    // Variabili dedicate al recupero e calcolo previsioni meteo future
    let futureForecast = null;       // Memorizza la previsione futura { timestamp, tws, twd }
    let lastForecast30mSlot = 0;    // Orario dell'ultimo blocco orologio scaricato con successo (es. 15:30)

    /**
        * plugin.start: Inizializza il plugin.
        * Viene chiamato all'avvio e OGNI VOLTA che si salva nella configurazione.
        */
    plugin.start = function (options) {
        // 1. Aggiorna la configurazione in memoria
        currentConfig = options;
        app.debug(`${plugin.name} started/updated with new options`);

        // Rimosso il reset distruttivo per garantire la conservazione dei dati in RAM
        // durante il salvataggio dei parametri o il cambio delle calibrazioni delle scale.
            
        // 2. Registra le rotte API solo la prima volta (Abilitate per CORS remoto)
        if (!routeRegistered) {
            app.get('/rotevista-config', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*"); // Sblocca la Dashboard locale su Mac
                res.json(currentConfig);
            });
            app.get('/rotevista-history', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*"); // Sblocca la Dashboard locale su Mac
                // Costruiamo un pacchetto unificato che unisce i grafici classici, i dati radar e il futuro
                const responseData = {
                    ...histories,
                    windRadarSlots: windRadarSlots,
                    futureForecast: futureForecast,
                    'navigation.position': raw['navigation.position'] // Chirurgico: Espone le coordinate GPS correnti per la diagnostica e il radar
                };
                res.json(responseData);
            });
            routeRegistered = true;
            app.debug('Public API endpoints registered at /rotevista-config and /rotevista-history');
        }

        // 3. Iscrizione ai dati dei sensori di bordo tramite Signal K (Ottimizzata a 1Hz)
        const localSubscription = {
            context: 'vessels.self',
            subscribe: [
                { path: 'navigation.position', minPeriod: 60000 },
                { path: 'navigation.speedThroughWater', minPeriod: 1000 },
                { path: 'navigation.speedOverGround', minPeriod: 1000 },
                { path: 'environment.depth.belowTransducer', minPeriod: 1000 },
                { path: 'environment.wind.speedApparent', minPeriod: 1000 },
                { path: 'environment.wind.angleApparent', minPeriod: 1000 },
                { path: 'environment.wind.speedTrue', minPeriod: 1000 },
                { path: 'environment.wind.directionTrue', minPeriod: 1000 },
                { path: 'navigation.headingTrue', minPeriod: 1000 },
                { path: 'navigation.headingMagnetic', minPeriod: 1000 },
                { path: 'navigation.magneticVariation', minPeriod: 60000 },
                { path: 'navigation.courseOverGroundTrue', minPeriod: 1000 }
            ]
        };

        app.subscriptionmanager.subscribe(
            localSubscription,
            unsubscribes,
            subscriptionError => {
                app.error('Subscription error: ' + subscriptionError);
            },
            delta => {
                if (delta.updates) {
                    delta.updates.forEach(update => {
                        if (update.values) {
                            update.values.forEach(v => {
                                processIncomingDelta(v.path, v.value);
                            });
                        }
                    });
                }
            }
        );

        // Avvia il timer di background per la potatura della RAM ogni 60 secondi
        if (pruneInterval) {
            clearInterval(pruneInterval);
        }
        pruneInterval = setInterval(pruneStaleHistories, 60000);
    };

    /**
        * plugin.stop: Chiamato quando il plugin viene disattivato.
        */
    plugin.stop = function () {
        unsubscribes.forEach(f => f());
        unsubscribes = [];
        if (pruneInterval) {
            clearInterval(pruneInterval);
            pruneInterval = null;
        }
        app.debug(`${plugin.name} stopped`);
    };

    plugin.debug = function(msg) {
        app.debug(msg);
    };

    // Helper per verificare se due valori sono identici (supporta anche oggetti complessi come la posizione lat/lon)
    function isValueEqual(a, b) {
        if (a === b) return true;
        if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
            return a.latitude === b.latitude && a.longitude === b.longitude;
        }
        return false;
    }

    /**
        * processIncomingDelta: Decodifica i dati dei sensori in Knots/Meters ed esegue l'aggregazione
        * Applica un filtro passa-basso continuo a ogni pacchetto e storicizza a 1Hz con dati stabilizzati.
        */
    function processIncomingDelta(path, val) {
        if (val === null || val === undefined) return;

        const now = Date.now();
        const lastVal = raw[path];
        const lastTime = lastPathProcessTimes[path] || 0;

        // FILTRO DEDUPLICAZIONE CON HEARTBEAT DI SICUREZZA A 10 SECONDI:
        // Se il nuovo dato è identico al precedente e sono passati meno di 10 secondi dall'ultimo invio,
        // scartiamo subito l'elaborazione risparmiando cicli di CPU sul server.
        // La soglia dei 10s garantisce la compatibilità con il Gap Detection dei grafici client.
        if (lastVal !== undefined && isValueEqual(val, lastVal) && (now - lastTime < 10000)) {
            return;
        }
        
        // 1. Filtro anti-spike vento (> 100 nodi / 51.44 m/s)
        if ((path === 'environment.wind.speedApparent' || path === 'environment.wind.speedTrue') && val > 51.44) {
            return;
        }

        // 2. Filtro anti-spike velocità barca STW/SOG (> 50 nodi / 25.72 m/s)
        if ((path === 'navigation.speedThroughWater' || path === 'navigation.speedOverGround') && val > 25.72) {
            return;
        }

        // 3. Filtro validità profondità (ignora errori negativi e letture > 500m per lost-echo)
        if (path === 'environment.depth.belowTransducer' && (val < -2.0 || val > 500)) {
            return;
        }
        
        // Rimosso la seconda dichiarazione duplicata di 'now' poiché già dichiarata in cima alla funzione
        const alpha = 1.0; // Passa-tutto istantaneo (i sensori di bordo ST60+ sono già calibrati con damping hardware a 12)

        // FILTRO PASSA-BASSO CONTINUO IN TEMPO REALE (Previene gli Spike prima della storicizzazione)
        if (path === 'navigation.position') {
            raw[path] = val; // Le coordinate GPS non sono soggette a filtri di smorzamento o ritardo
            
            // Chiamata periodica Open-Meteo
            if (val.latitude !== undefined && val.longitude !== undefined) {
                const current30mSlot = Math.floor(now / 1800000) * 1800000;
                if (current30mSlot > lastForecast30mSlot) {
                    fetchOpenMeteoForecast(val, current30mSlot);
                }
            }
            return; // Esce subito
        }

        if (path.includes('angle') || path.includes('heading') || path.includes('course') || path.includes('direction') || path.includes('twd')) {
            // 1. Caso Angolare (Radianti): Calcolo differenziale circolare per gestire l'oltrepasso dello 0/360 gradi
            if (raw[path] !== undefined) {
                let diff = Math.atan2(Math.sin(val - raw[path]), Math.cos(val - raw[path]));
                raw[path] = (raw[path] + diff * alpha + Math.PI * 2) % (Math.PI * 2);
            } else {
                raw[path] = val;
            }
        } else {
            // 2. Caso Lineare (Velocità e Profondità): Smorzamento continuo
            if (raw[path] !== undefined) {
                raw[path] = (val * alpha) + (raw[path] * (1 - alpha));
            } else {
                raw[path] = val;
            }
        }

        // LIMITATORE DI FREQUENZA (RATE LIMITER) A 1HZ PER PERCORSO ATTIVO:
        // La scrittura nello storico e i calcoli derivati vengono eseguiti al massimo una volta al secondo,
        // leggendo il valore "raw[path]" stabilizzato continuamente dal filtro passa-basso superiore.
        if (!lastPathProcessTimes[path]) lastPathProcessTimes[path] = 0;
        if (now - lastPathProcessTimes[path] < 1000) {
            return; // Esce subito risparmiando la CPU se il sensore ha già aggiornato nell'ultimo secondo
        }
        lastPathProcessTimes[path] = now;

        // Da qui in poi, l'esecuzione della storia e del vento reale avviene rigorosamente a 1Hz con dati puliti:
        const smoothedVal = raw[path];

        if (path === 'navigation.speedThroughWater') {
            manageHistory('stw', smoothedVal * 1.94384);
        }
        else if (path === 'navigation.speedOverGround') {
            manageHistory('sog', smoothedVal * 1.94384);
        }
        else if (path === 'environment.depth.belowTransducer') {
            manageHistory('depth', smoothedVal);
        }
        else if (path === 'environment.wind.speedApparent') {
            manageHistory('aws', smoothedVal * 1.94384);
        }
        else if (path === 'environment.wind.angleApparent') {
            // Già gestito e normalizzato dal filtro passa-basso superiore
        }
        else if (path === 'environment.wind.speedTrue') {
            lastNativeTwsTime = now; // Rilevato TWS nativo della centralina!
            manageHistory('tws', smoothedVal * 1.94384);
        }
        // --- DECODIFICA PRUA MAGNETICA SERVER-SIDE ---
        else if (path === 'navigation.headingMagnetic') {
            const hasTrueHdg = raw['navigation.headingTrue'] !== undefined;
            if (!hasTrueHdg) {
                const variation = raw['navigation.magneticVariation'] || 0;
                raw['navigation.headingTrue'] = (smoothedVal + variation + 2 * Math.PI) % (2 * Math.PI);
            }
        }
        else if (path === 'environment.wind.directionTrue') {
            lastNativeTwdTime = now; // Rilevato TWD nativo della centralina!
            manageHistory('twd', smoothedVal);
        }
        else if (path === 'navigation.courseOverGroundTrue') {
            // Se non è installata alcuna bussola fisica sulla rete e la barca è in movimento stabile (> 1.5 nodi),
            // emuliamo l'Heading usando il COG per consentire il calcolo del TWD e della bussola radar.
            const hasCompass = raw['navigation.headingTrue'] !== undefined || raw['navigation.headingMagnetic'] !== undefined;
            const sog = raw['navigation.speedOverGround'] || 0;
            if (!hasCompass && sog > 0.77) { // 0.77 m/s = 1.5 nodi
                raw['navigation.headingTrue'] = smoothedVal;
            }
        }

        // 2. Calcolo combinato di FALLBACK (Si attiva solo se la centralina non invia TWS/TWD nativi)
        const aws = raw["environment.wind.speedApparent"];
        const awa = raw["environment.wind.angleApparent"];
        const stw = raw["navigation.speedThroughWater"];
        const sog = raw["navigation.speedOverGround"] || 0;
        const hdg = raw["navigation.headingTrue"];

        if (aws !== undefined && awa !== undefined) {
            const awsKts = aws * 1.94384;
            
            // RILEVAMENTO "LOG BLOCCATO" SUL SERVER
            const hasStw = lastPathProcessTimes["navigation.speedThroughWater"] && (now - lastPathProcessTimes["navigation.speedThroughWater"] < 15000);
            let speedRef = 0;
            
            if (hasStw && stw !== undefined) {
                if (sog > 0.77 && stw < 0.25) {
                    speedRef = sog; // Log sporco: forza il SOG
                } else {
                    speedRef = stw;
                }
            } else {
                speedRef = sog;
            }
            
            const speedKtsRef = speedRef * 1.94384;

            const tw_water_x = awsKts * Math.cos(awa) - speedKtsRef;
            const tw_water_y = awsKts * Math.sin(awa);

            // Calcolo TWS
            if (now - lastNativeTwsTime > 5000) {
                const tws = Math.sqrt(tw_water_x * tw_water_x + tw_water_y * tw_water_y);
                manageHistory('tws', tws);
            }

            const twa = Math.atan2(tw_water_y, tw_water_x);
            const vmg = Math.abs(speedKtsRef * Math.cos(twa));
            manageHistory('vmg', vmg);

            // Calcolo TWD stabile (Prua + TWA)
            if (hdg !== undefined && (now - lastNativeTwdTime > 5000)) {
                const twd = (hdg + twa + 2 * Math.PI) % (2 * Math.PI);
                manageHistory('twd', twd);
            }
        }
    }
    
    /**
        * manageHistory: Versione Server-side dell'aggregatore matematico tattico
        */
    function manageHistory(type, value) {
        if (value === undefined || value === null || !isFinite(value)) return;

        const now = Date.now();
        const historyMinutes = currentConfig.graphs ? currentConfig.graphs.historyMinutes : 5;
        const samples = 60;
        const bucketIntervalMs = (historyMinutes * 60000) / samples;

        if (!graphTempBuf[type]) graphTempBuf[type] = [];
        if (!histories[type]) histories[type] = [];
            
        // SINTONIZZAZIONE DI FASE LATO SERVER (UTC Snap)
        if (lastUpdates[type] === undefined || lastUpdates[type] === 0) {
            lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
        }

        const tempBuf = graphTempBuf[type];

        // Anti-dropout dinamico sul vento forte
        if ((type === 'tws' || type === 'aws') && value < 0.05 && tempBuf.length > 0) {
            const lastPoint = tempBuf[tempBuf.length - 1];
            const reef1 = currentConfig.graphs ? currentConfig.graphs.reef1 : 15;
            const glitchThreshold = reef1 * 0.5;
            if (lastPoint && lastPoint.val > glitchThreshold) return;
        }

        // Cattura la velocità del vento corrente (in m/s) al momento della lettura
        const currentTws = raw['environment.wind.speedTrue'] || 0;
        tempBuf.push({ val: value, tws: currentTws, time: now });

        // Controllo avanzamento del secchiello temporale (Bucket)
        const bucketReady = (now - lastUpdates[type] > bucketIntervalMs) || histories[type].length === 0;
        if (!bucketReady) return;

        let finalValue = value;
        let isTwdType = (type === 'twd');

        if (tempBuf.length > 0) {
        // ==========================================================================
        // CASO PARTICOLARE: DIREZIONE VENTO (TWD) -> MEDIA PESATA E LIMITI MIN/MAX
        // ==========================================================================
        if (isTwdType) {
            // 1. Identifica il vento massimo del minuto (in m/s) - Loop in-place (0 allocazioni)
            let maxTwsInMinute = 0;
            for (let i = 0; i < tempBuf.length; i++) {
                const tws = tempBuf[i].tws || 0;
                if (tws > maxTwsInMinute) maxTwsInMinute = tws;
            }

            // 2. Calcola la soglia dinamica di pressione
            const calmThresholdMs = CALM_THRESHOLD_KTS / 1.94384;
            const pressureThreshold = Math.max(maxTwsInMinute * PRESSURE_FILTER_RATIO, calmThresholdMs);

            // 3. Determina in un unico passaggio se ci sono punti attivi sopra la soglia (0 allocazioni)
            let hasActivePoints = false;
            for (let i = 0; i < tempBuf.length; i++) {
                if ((tempBuf[i].tws || 0) >= pressureThreshold) {
                    hasActivePoints = true;
                    break;
                }
            }

            // 4. Media Vettoriale Pesata (0 allocazioni di array)
            let sumSin = 0;
            let sumCos = 0;
            let totalWeight = 0;
            for (let i = 0; i < tempBuf.length; i++) {
                const p = tempBuf[i];
                if (hasActivePoints && (p.tws || 0) < pressureThreshold) continue;

                const weight = Math.max(p.tws || 0.1, 0.05);
                sumSin += weight * Math.sin(p.val);
                sumCos += weight * Math.cos(p.val);
                totalWeight += weight;
            }
            const avgAngle = Math.atan2(sumSin, sumCos);
            const finalAvg = (avgAngle + Math.PI * 2) % (Math.PI * 2);

            // 5. Calcolo di Min e Max angolare del minuto (0 allocazioni di array)
            let minDiff = 0;
            let maxDiff = 0;
            let firstDiff = true;
            for (let i = 0; i < tempBuf.length; i++) {
                const p = tempBuf[i];
                if (hasActivePoints && (p.tws || 0) < pressureThreshold) continue;

                const diff = Math.atan2(Math.sin(p.val - finalAvg), Math.cos(p.val - finalAvg));
                if (firstDiff) {
                    minDiff = diff;
                    maxDiff = diff;
                    firstDiff = false;
                } else {
                    if (diff < minDiff) minDiff = diff;
                    if (diff > maxDiff) maxDiff = diff;
                }
            }

            const finalMin = (finalAvg + minDiff + Math.PI * 2) % (Math.PI * 2);
            const finalMax = (finalAvg + maxDiff + Math.PI * 2) % (Math.PI * 2);

            finalValue = {
                val: finalAvg,
                min: finalMin,
                max: finalMax
            };
        }
        // A. VENTO VELOCITÀ -> SUSTAINED PEAK (EMA Time-Aware) (Inalterato per minimizzare le modifiche)
        else if (type === 'tws' || type === 'aws') {
            const tauMs = 2500;
            let ema = tempBuf[0].val;
            let maxSustained = ema;

            for (let i = 1; i < tempBuf.length; i++) {
                const dt = Math.max(1, tempBuf[i].time - tempBuf[i-1].time);
                const alpha = 1 - Math.exp(-dt / tauMs);
                ema = (tempBuf[i].val * alpha) + (ema * (1 - alpha));
                if (isFinite(ema) && ema > maxSustained) maxSustained = ema;
            }
            finalValue = maxSustained;
        }
        // B. PROFONDITÀ -> MINIMO (Ottimizzato a 0 allocazioni)
        else if (type === 'depth') {
            let minVal = Infinity;
            for (let i = 0; i < tempBuf.length; i++) {
                const v = tempBuf[i].val;
                if (isFinite(v) && v < minVal) minVal = v;
            }
            if (minVal !== Infinity) finalValue = minVal;
        }
        // C. VELOCITÀ BARCA / ALTRO -> MEDIA (Ottimizzato a 0 allocazioni)
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
            if (count > 0) finalValue = sum / count;
        }
    }

        // Validazione e clamping di sicurezza (non si applica all'oggetto TWD)
        if (!isTwdType) {
            if (!isFinite(finalValue)) return;
            finalValue = Math.max(0, finalValue);
            histories[type].push({ val: finalValue, time: now });

            // EMISSIONE DEL DELTA: Se abbiamo calcolato il TWS di fallback, lo trasmettiamo a Signal K
            if (type === 'tws' && (now - lastNativeTwsTime > 5000)) {
                emitDelta('environment.wind.speedTrue', finalValue / 1.94384); // Converte nodi in m/s
            }
        } else {
            // Salvataggio specifico del TWD contenente l'oggetto { val, min, max, time }
            histories['twd'].push({
                val: finalValue.val,
                min: finalValue.min,
                max: finalValue.max,
                time: now
            });

            // EMISSIONE DEL DELTA: Se abbiamo calcolato il TWD di fallback, lo trasmettiamo a Signal K
            if (now - lastNativeTwdTime > 5000) {
                // Standard Signal K: trasmettiamo solo il valore medio (float numerico in radianti)
                emitDelta('environment.wind.directionTrue', finalValue.val);
            }

            // --- TRIGGER DI CONGELAMENTO ARCO (Ogni :00 e :30 dell'orologio) ---
            const current30mSlot = Math.floor(now / 1800000) * 1800000;
            if (lastFrozen30mSlot === 0) {
                lastFrozen30mSlot = current30mSlot; // Inizializzazione al primo avvio
            } else if (current30mSlot > lastFrozen30mSlot) {
                // Lo slot da 30 minuti precedente (lastFrozen30mSlot) si è appena concluso!
                // Avviamo la procedura di compressione e congelamento dei dati di quel periodo
                freeze30mSlot(lastFrozen30mSlot);
                lastFrozen30mSlot = current30mSlot;
            }
        }

        // Pruning automatico basato sulle impostazioni di timeline
        // (Forziamo il server a conservare sempre almeno 60 minuti per il TWD!)
        const limitMinutes = (type === 'twd') ? 60 : historyMinutes;
        const maxViewportMinutes = limitMinutes * 2;
        const maxHistoryMs = (maxViewportMinutes * 60000) + 60000;

        while (histories[type].length > 0 && (now - histories[type][0].time) > maxHistoryMs) {
            histories[type].shift();
        }

        graphTempBuf[type] = [];
        // Spostiamo il timer esattamente al confine del secchiello assoluto appena concluso
        lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
    }

    /**
        * plugin.schema: Definisce l'interfaccia grafica in Signal K Admin.
        */
    plugin.schema = {
        type: 'object',
        title: 'Rotevista Dashboard Settings',
        properties: {
            // --- SEZIONE ALLARMI PROFONDITÀ ---
            alarms: {
                type: 'object',
                title: 'Depth Safety Alarms',
                description: "Configure safety thresholds for depth monitoring based on your boat's draft.",
                properties: {
                    depthDanger: {
                        type: 'number',
                        title: 'Emergency Depth (Red + Sound)',
                        description: "Critical depth level. Below this limit, the display turns RED and the audible 'Bing-Bing' alarm starts.",
                        default: 2.5
                    },
                    depthWarning: {
                        type: 'number',
                        title: 'Safety Margin (Yellow)',
                        description: "Shallow water warning. The depth value turns YELLOW below this threshold to alert you to pay attention.",
                        default: 5.0
                    }
                }
            },
            // --- SEZIONE GRAFICI E REEF ---
            graphs: {
                type: 'object',
                title: 'Performance History & Reef Alerts',
                description: "Settings for chart timelines and tactical wind alerts.",
                properties: {
                    reef1: {
                        type: 'number',
                        title: '1st Reef Alert (Orange)',
                        description: "Wind speed at which the graph turns orange. This threshold applies to the active mode: in TWS it indicates weather intensity, in AWS it indicates pressure on sails/rigging.",
                        default: 15.0
                    },
                    reef2: {
                        type: 'number',
                        title: '2nd Reef Alert (Red)',
                        description: "Critical wind speed at which the graph turns red. This threshold applies to the active mode: in TWS it warns of high sea state, in AWS it warns of excessive load on the mast/sails.",
                        default: 20.0
                    },
                    historyMinutes: {
                        type: 'number',
                        title: 'Strategic Timeline (Minutes)',
                        description: "Sets the time duration for all charts. It also defines the comparison window for the Strategic Weather Trend (the dot in the TWD compass) to detect long-term wind shifts.",
                        default: 5,
                        enum: [5, 10, 15, 30, 60]
                    }
                }
            },
            // --- SEZIONE MEDIE E STABILITÀ ---
            averaging: {
                type: 'object',
                title: 'Tactical Brain & Stability',
                description: "Fine-tune how the dashboard reacts to boat movements and maneuvers.",
                properties: {
                    longWindow: {
                        type: 'number',
                        title: 'Decision Stability Window (ms)',
                        description: "The time range used to calculate MEAN values. A longer window (e.g. 30s) provides a solid base for strategy, while a shorter one reacts faster to every oscillation.",
                        default: 30000
                    },
                    smoothWindow: {
                        type: 'number',
                        title: 'Needle Fluidity (ms)',
                        description: "Controls how smoothly pointers move. It filters out sensor 'shaking' without delaying the real-time feel.",
                        default: 2000
                    },
                    minSpeed: {
                        type: 'number',
                        title: 'Harbor Silence (knots)',
                        description: "Minimum speed required to enable orange blinking alerts. This prevents the display from flashing due to GPS noise while docked or at anchor.",
                        default: 0.5
                    },
                    stabilityThreshold: {
                        type: 'number',
                        title: 'Steering Precision (Sensitivity)',
                        description: "How strictly the system judges data coherence (0.0 to 1.0). Due to internal smoothing, 0.97-0.98 requires racing precision; 0.93-0.95 is ideal for cruising in waves. Below this, the display rarely alerts for instability.",
                        default: 0.95
                    },
                    stabilityBreakout: {
                        type: 'number',
                        title: 'Maneuver Detection Limit (degrees)',
                        description: "If the boat or wind shifts more than these degrees, the display blinks orange to warn you that the current average is no longer reliable.",
                        default: 15
                    }
                }
            },
            // --- SEZIONE CALIBRAZIONE SCALE ---
            scales: {
                type: 'object',
                title: 'Chart Scale Calibration',
                description: "Customize how charts adapt to your boat's performance in both Standard and Hercules Zoom modes.",
                properties: {
                    stw: {
                        type: 'object',
                        title: 'STW (Speed Through Water)',
                        properties: {
                            stdMax: { type: 'number', title: 'Standard Max', description: "Default top limit of the graph.", default: 12 },
                            step: { type: 'number', title: 'Scale Jump', description: "Amount the scale increases when you exceed the limit.", default: 2 },
                            hercSpan: {
                                type: 'number',
                                title: 'Hercules Grid Step (Resolution)',
                                description: "Select the multiplier step for the Hercules zoom. The scale boundaries will always snap to multiples of this value.",
                                enum: [0.5, 1.0, 2.0, 3.0],
                                default: 1.0
                            }
                        }
                    },
                    sog: {
                        type: 'object',
                        title: 'SOG (Speed Over Ground)',
                        properties: {
                            stdMax: { type: 'number', title: 'Standard Max', default: 12 },
                            step: { type: 'number', title: 'Scale Jump', default: 2 },
                            hercSpan: {
                                type: 'number',
                                title: 'Hercules Grid Step (Resolution)',
                                description: "Select the multiplier step for the Hercules zoom. The scale boundaries will always snap to multiples of this value.",
                                enum: [0.5, 1.0, 2.0, 3.0],
                                default: 1.0
                            }
                        }
                    },
                    tws: {
                        type: 'object',
                        title: 'TWS (True Wind Speed)',
                        properties: {
                            stdMax: { type: 'number', title: 'Standard Max', default: 25 },
                            step: { type: 'number', title: 'Scale Jump', default: 5 },
                            hercSpan: {
                                type: 'number',
                                title: 'Hercules Grid Step (Resolution)',
                                description: "Select the multiplier step for the Hercules zoom. The scale boundaries will always snap to multiples of this value.",
                                enum: [1, 2, 3, 5, 10],
                                default: 2
                            }
                        }
                    },
                    depth: {
                        type: 'object',
                        title: 'Depth',
                        properties: {
                            stdMax: { type: 'number', title: 'Standard Max', default: 20 },
                            step: { type: 'number', title: 'Scale Jump', default: 10 },
                            hercSpan: {
                                type: 'number',
                                title: 'Hercules Grid Step (Resolution)',
                                description: "Select the multiplier step for the Hercules zoom. The scale boundaries will always snap to multiples of this value.",
                                enum: [1, 2, 3, 5, 10],
                                default: 2
                            }
                        }
                    }
                }
            }
        }
    };
        
    /**
        * freeze30mSlot: Consolida e congela i dati di una specifica mezz'ora.
        * Raccoglie i 30 record da 1 minuto, estrae i picchi, unisce gli angoli
        * e applica la scrematura del percentile al 5% prima di salvare lo slot.
        */
    function freeze30mSlot(slotTimestamp) {
        const startTime = slotTimestamp;
        const endTime = slotTimestamp + 1800000; // 30 minuti in millisecondi

        // 1. Estrae i record storici del TWD e del TWS che ricadono in quella mezz'ora
        const twdPoints = histories['twd'].filter(p => p.time >= startTime && p.time < endTime);
        const twsPoints = histories['tws'].filter(p => p.time >= startTime && p.time < endTime);

        if (twdPoints.length === 0) return; // Se non ci sono dati, salta lo slot

        // 2. Calcola il vento massimo sostenuto (in nodi) registrato nel periodo
        const twsVals = twsPoints.map(p => p.val).filter(v => isFinite(v));
        const maxTws = twsVals.length > 0 ? Math.max(...twsVals) : 0;
        const minTws = twsVals.length > 0 ? Math.min(...twsVals) : 0; // Chirurgico: Calcoliamo il vento minimo del periodo

        // 3. Estrae tutti gli estremi angolari catturati minuto per minuto
        let allAngles = [];
        twdPoints.forEach(p => {
            allAngles.push(p.val);
            allAngles.push(p.min);
            allAngles.push(p.max);
        });

        // 4. Calcola la direzione media vettoriale complessiva della mezz'ora per srotolare gli angoli
        let sumSin = 0;
        let sumCos = 0;
        allAngles.forEach(a => {
            sumSin += Math.sin(a);
            sumCos += Math.cos(a);
        });
        const avgAngle = Math.atan2(sumSin, sumCos);
        const finalAvg = (avgAngle + Math.PI * 2) % (Math.PI * 2);

        // 5. Srotola gli angoli rispetto alla direzione media per gestire l'oltrepasso dello 0/360°
        let diffs = allAngles.map(a => {
            let diff = a - finalAvg;
            return Math.atan2(Math.sin(diff), Math.cos(diff)); // Mappa tra -PI e +PI
        });

        // 6. ORDINA LE DIFFERENZE ED APPLICA IL TAGLIO PERCENTILE DEL 5% PER LATO (TRIM)
        diffs.sort((a, b) => a - b);
        const trimCount = Math.floor(diffs.length * 0.05); // Scarta il 5% dei disturbi a sinistra e a destra
        const activeDiffs = diffs.slice(trimCount, diffs.length - trimCount);

        // Fallback se ci sono pochissimi campioni
        const finalDiffs = activeDiffs.length > 0 ? activeDiffs : diffs;

        const minDiff = Math.min(...finalDiffs);
        const maxDiff = Math.max(...finalDiffs);

        const finalMin = (finalAvg + minDiff + Math.PI * 2) % (Math.PI * 2);
        const finalMax = (finalAvg + maxDiff + Math.PI * 2) % (Math.PI * 2);

        // 7. Salva l'arco compresso e pulito nello store dedicato
        windRadarSlots.push({
            timestamp: startTime,
            twdMin: finalMin,
            twdMax: finalMax,
            twsPeak: maxTws,
            twsMin: minTws // Chirurgico: Salviamo il vento minimo per poter tracciare la variabilità (Gust Factor)
        });

        // Pruning: manteniamo in RAM solo le ultime 6 ore (12 slot)
        while (windRadarSlots.length > 12) {
            windRadarSlots.shift();
        }

        app.debug(`💨 [Wind Radar] Locked 30m slot at ${new Date(startTime).toLocaleTimeString()}: TWD ${Math.round(finalMin * 180 / Math.PI)}°-${Math.round(finalMax * 180 / Math.PI)}°, TWS Peak ${maxTws.toFixed(1)} kts`);
    }

    /**
        * fetchOpenMeteoForecast: Recupera le previsioni orarie accoppiate (Seamless) da Open-Meteo.
        * Utilizza il modello integrato /forecast per evitare zone d'ombra in rada, con tempo forzato in UTC.
        */
    function fetchOpenMeteoForecast(position, current30mSlot) {
        if (!position || position.latitude === undefined || position.longitude === undefined) return;

        const lat = position.latitude;
        const lon = position.longitude;
        
        // Chirurgico: Aggiunto wind_gusts_10m alla chiamata per ottenere l'intensità delle raffiche previste
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=2`;

        lastForecast30mSlot = current30mSlot; // Aggiorna preventivamente lo slot per evitare chiamate simultanee in caso di rallentamento di rete

        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                app.error(`[Open-Meteo] HTTP Error: ${res.statusCode}`);
                res.resume();
                lastForecast30mSlot = 0; // Reset in caso di errore per permettere un tentativo al prossimo pacchetto GPS
                return;
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.hourly || !parsed.hourly.time) {
                        app.error('[Open-Meteo] Invalid API response format');
                        lastForecast30mSlot = 0;
                        return;
                    }

                    const times = parsed.hourly.time;
                    const speeds = parsed.hourly.wind_speed_10m;
                    const directions = parsed.hourly.wind_direction_10m;
                    const gusts = parsed.hourly.wind_gusts_10m || []; // Chirurgico: Catturiamo le raffiche dal payload JSON

                    // Costruiamo la serie storica delle previsioni in formato UTC
                    const forecastList = [];
                    for (let i = 0; i < times.length; i++) {
                        // Forziamo il parsing UTC aggiungendo la dicitura 'Z' alla stringa ISO prodotta da Open-Meteo
                        const epoch = Date.parse(times[i] + "Z");
                        if (isNaN(epoch)) continue;

                        // Convertiamo la direzione del vento da gradi (0-360) a radianti (0-2PI)
                        const twdRad = (directions[i] * Math.PI) / 180;

                        forecastList.push({
                            time: epoch,
                            tws: speeds[i], // Già in nodi grazie ai parametri della chiamata
                            twd: twdRad,
                            gust: gusts[i] !== undefined ? gusts[i] : speeds[i] // Chirurgico: Memorizziamo la raffica oraria (con fallback sulla velocità media)
                        });
                    }

                    // Calcola l'interpolazione per la mezz'ora futura basandosi sullo slot corrente dell'orologio
                    calculateInterpolatedFuture(forecastList);

                } catch (err) {
                    app.error(`[Open-Meteo] Error parsing JSON: ${err.message}`);
                    lastForecast30mSlot = 0;
                }
            });
        }).on('error', (err) => {
            app.error(`[Open-Meteo] Network Error: ${err.message}`);
            lastForecast30mSlot = 0;
        });
    }

    /**
        * calculateInterpolatedFuture: Esegue l'interpolazione lineare e vettoriale circolare
        * per trovare la previsione del vento tra 30 minuti esatti.
        */
    function calculateInterpolatedFuture(forecastList) {
        if (forecastList.length < 2) return;

        const now = Date.now();
        const targetTime = now + 1800000; // Calcoliamo la proiezione a +30 minuti nel futuro

        let s1 = null;
        let s2 = null;

        // Individuiamo i due segmenti orari che racchiudono la nostra mezz'ora futura
        for (let i = 0; i < forecastList.length; i++) {
            const f = forecastList[i];
            if (f.time <= targetTime) {
                s1 = f;
            }
            if (f.time > targetTime) {
                s2 = f;
                break; // Trovato il limite superiore, usciamo
            }
        }

        if (s1 && s2) {
            const ratio = (targetTime - s1.time) / (s2.time - s1.time);

            // 1. Interpolazione Lineare Velocità (TWS)
            const interpolatedTws = s1.tws + (s2.tws - s1.tws) * ratio;

            // 2. Interpolazione Circolare Vettoriale Direzione (TWD) per evitare l'effetto sfasamento a 0/360°
            const diff = Math.atan2(Math.sin(s2.twd - s1.twd), Math.cos(s2.twd - s1.twd));
            const interpolatedTwd = (s1.twd + diff * ratio + Math.PI * 2) % (Math.PI * 2);

            // 3. Interpolazione Lineare Raffiche (Gust)
            const interpolatedGust = s1.gust + (s2.gust - s1.gust) * ratio; // Chirurgico: Calcolo interpolato della raffica futura

            // Salviamo le previsioni future nel server
            futureForecast = {
                timestamp: targetTime,
                tws: interpolatedTws,
                twd: interpolatedTwd,
                gust: interpolatedGust // Chirurgico: Aggiunta la raffica nel pacchetto dati della previsione
            };

            app.debug(`🔮 [Open-Meteo] Target forecast interpolated for ${new Date(targetTime).toLocaleTimeString()}: TWD ${Math.round(interpolatedTwd * 180 / Math.PI)}°, TWS ${interpolatedTws.toFixed(1)} kts (Gust: ${interpolatedGust.toFixed(1)} kts)`);
        } else {
            app.error('[Open-Meteo] Forecast matching slots not found for target time');
        }
    }
    
    /**
        * emitDelta: Scrive ed emette un aggiornamento di rotta direttamente nel
        * server principale di Signal K per renderlo disponibile a tutti i client WebSocket.
        */
    function emitDelta(path, value) {
        if (typeof app.handleMessage === 'function') {
            app.handleMessage(plugin.id, {
                context: 'vessels.self', // BUG RISOLTO: Inserito il contesto Signal K per evitare lo scarto del delta
                updates: [
                    {
                        source: { label: 'rotevista-dash-plugin' },
                        timestamp: new Date().toISOString(),
                        values: [
                            {
                                path: path,
                                value: value
                            }
                        ]
                    }
                ]
            });
        }
    }

    /**
        * pruneStaleHistories: Pota in background i punti storici obsoleti dei sensori spenti.
        * Evita il congelamento dei grafici sul tablet e previene sprechi di RAM sul server.
        */
    function pruneStaleHistories() {
        const now = Date.now();
        const historyMinutes = currentConfig.graphs ? currentConfig.graphs.historyMinutes : 5;
        const maxHistoryMs = (historyMinutes * 2 * 60000) + 60000;

        for (let type in histories) {
            let pruned = false;
            while (histories[type].length > 0 && (now - histories[type][0].time) > maxHistoryMs) {
                histories[type].shift();
                pruned = true;
            }
            if (pruned) {
                app.debug(`🧹 [Server RAM] Pruned stale points for "${type}" due to instrument silence.`);
            }
        }
    }
    
    return plugin;
};
