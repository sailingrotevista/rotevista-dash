/**
 * ==========================================================================
 * Rotevista Dash - Wind, Telemetry & Forecast Engine
 * ==========================================================================
 * Gestisce la decodifica dei delta NMEA/Signal K a 1Hz, il calcolo di fallback
 * del vento reale (TWS/TWD/VMG), i buffer rolling angolari, l'aggregazione
 * storica per i grafici, il congelamento degli slot radar da 30m e Open-Meteo.
 * file windEngine.js
 */
const https = require('https');
const resolveDeclination = require('./magneticDeclination')(require('geomagnetism'));
const { awsMaxAgeMs, awaMaxAgeMs, twsNativeMaxAgeMs, twaNativeMaxAgeMs, trueWindDirectionMinSpeedMps, twdNativeMaxAgeMs, headingMaxAgeMs, boatSpeedMaxAgeMs, gustSmoothingMs, gustResetGapMs, depthMaxAgeMs } = require('./windDataPolicy.json');

// ==========================================================================
// COSTANTI DI SVILUPPO (DEVELOPER CONFIG)
// ==========================================================================
const CALM_THRESHOLD_KTS = 1.5;      // Soglia di calma piatta (anello a 360°)
const PRESSURE_FILTER_RATIO = 0.40;  // Filtro di pressione dinamico (40% del picco per ignorare i cali)

// Helper per verificare se due valori sono identici (supporta anche oggetti complessi come la posizione lat/lon)
function isValueEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
        return a.latitude === b.latitude && a.longitude === b.longitude;
    }
    return false;
}

function resolveHeading(raw, timestamps, now, policy, allowCog = true) {
  const fresh = (path, age) => {
    const value = raw[path], time = timestamps[path];
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Math.PI * 2 &&
      Number.isFinite(time) && now-time >= 0 && now-time < age ? value : null;
  };
  const trueHeading = fresh('navigation.headingTrue', policy.headingMaxAgeMs);
  const magnetic = fresh('navigation.headingMagnetic', policy.headingMaxAgeMs);
  if (magnetic !== null) {
    const variation = resolveDeclination(raw, now);
    if (variation !== null) return (magnetic + variation + Math.PI * 2) % (Math.PI * 2);
  }
  if (trueHeading !== null) return trueHeading;
  if (!allowCog) return null;
  const cog = fresh('navigation.courseOverGroundTrue', policy.headingMaxAgeMs);
  const sog = raw['navigation.speedOverGround'], time = timestamps['navigation.speedOverGround'];
  return cog !== null && Number.isFinite(sog) && sog > 0.77 && sog <= 25.72 &&
    Number.isFinite(time) && now-time >= 0 && now-time < policy.boatSpeedMaxAgeMs ? cog : null;
}

class WindEngine {
    constructor(app, getConfig) {
        this.app = app;
        this.getConfig = getConfig;

        // Database dello storico in RAM sul server (Sintonizzato Pro v6.0)
        this.histories = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
        this.gustFilter = {};
        this.historyInputTimes = {};
        this.graphTempBuf = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
        this.lastUpdates = { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0, twd: 0 };
        this.raw = {};
        this.lastAwsReceivedTime = null;
        this.lastAwaReceivedTime = null;
        this.depthSourceTime = null;
        this.speedSourceTimes = {};
        this.lastPathProcessTimes = {}; // Registro dei timestamp per limitazione di frequenza a 1Hz

        // Nuovo database dedicato per gli archi storici della bussola (6 ore = 12 slot)
        this.windRadarSlots = [];

        // Memoria temporale per rilevare la presenza di sensori nativi sul Cerbo
        this.lastNativeTwsTime = 0;
        this.lastNativeTwdTime = 0;
        this.headingSourceTime = null;
        this.headingInputTimes = {};
        this.lastNativeHeadingTrueTime = 0; // Traccia la presenza di bussola vera nativa
        this.lastNativeTwaTime = 0;         // Traccia la presenza di TWA nativo

        // Buffer rolling ad alta frequenza (1Hz, ultimi 60s) per cold-start rapido dei valori medi
        this.rollingAngles = { hdg: [], cog: [], twa: [], awa: [], twd: [] };

        // Monitoraggio dello scorrere dei blocchi da 30 minuti
        this.lastFrozen30mSlot = 0;

        // Variabili dedicate al recupero e calcolo previsioni meteo future
        this.futureForecast = null;       // Memorizza la previsione futura { timestamp, tws, twd }
        this.lastForecast30mSlot = 0;     // Orario dell'ultimo blocco orologio scaricato con successo (es. 15:30)
    }

    getRaw() {
        return this.raw;
    }

    getRawTimes() {
        return { ...this.lastPathProcessTimes, 'environment.depth.belowTransducer': this.depthSourceTime, ...this.speedSourceTimes, ...this.headingInputTimes, 'environment.wind.speedApparent': this.lastAwsReceivedTime, 'environment.wind.angleApparent': this.lastAwaReceivedTime, 'environment.wind.speedTrue': this.lastNativeTwsTime || null, 'environment.wind.angleTrueWater': this.lastNativeTwaTime || null, 'environment.wind.directionTrue': this.lastNativeTwdTime || null, 'navigation.headingTrue': this.headingSourceTime };
    }

    getHistories() {
        return this.histories;
    }

    getRollingAngles() {
        return this.rollingAngles;
    }

    getWindRadarSlots() {
        return this.windRadarSlots;
    }

    getFutureForecast() {
        return this.futureForecast;
    }

    /**
     * processIncomingDelta: Decodifica i dati dei sensori in Knots/Meters ed esegue l'aggregazione
     * Applica un filtro passa-basso continuo a ogni pacchetto e storicizza a 1Hz con dati stabilizzati.
     */
    processIncomingDelta(path, val, sourceTimestamp) {
        if (path === 'environment.depth.belowTransducer') {
            if (val !== null && (typeof val !== 'number' || !Number.isFinite(val) || val < -2 || val > 500)) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const time = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.depthSourceTime != null && time < this.depthSourceTime) return;
            this.depthSourceTime = time;
            if (val === null) { this.raw[path] = null; return; }
        }

        if (path === 'environment.wind.speedTrue') {
            if (val === null) {
                delete this.raw[path];
                this.lastNativeTwsTime = 0;
                return;
            }
            if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 51.44) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const receivedTime = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (receivedTime < this.lastNativeTwsTime) return;
            this.lastNativeTwsTime = receivedTime;
        }
        if (path === 'environment.wind.directionTrue') {
            if (val === null) {
                delete this.raw[path];
                this.lastNativeTwdTime = null;
                // Keep observations: only the native source is invalidated.
                return;
            }
            if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const receivedTime = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.lastNativeTwdTime != null && receivedTime <= this.lastNativeTwdTime) return;
            this.lastNativeTwdTime = receivedTime;
        }
        if (path === 'environment.wind.angleTrueWater') {
            if (val === null) {
                delete this.raw[path];
                this.lastNativeTwaTime = null;
                this.rollingAngles.twa = [];
                return;
            }
            if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const receivedTime = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.lastNativeTwaTime != null && receivedTime <= this.lastNativeTwaTime) return;
            this.lastNativeTwaTime = receivedTime;
        }
        if (path === 'environment.wind.angleApparent') {
            if (val === null) {
                delete this.raw[path];
                this.lastAwaReceivedTime = null;
                this.rollingAngles.awa = [];
                return;
            }
            if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const receivedTime = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.lastAwaReceivedTime != null && receivedTime <= this.lastAwaReceivedTime) return;
            this.lastAwaReceivedTime = receivedTime;
        }
        if (path === 'environment.wind.speedApparent') {
            if (val === null) {
                delete this.raw[path];
                this.lastAwsReceivedTime = null;
                return;
            }
            if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 51.44) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const receivedTime = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.lastAwsReceivedTime !== null && receivedTime < this.lastAwsReceivedTime) return;
            this.lastAwsReceivedTime = receivedTime;
        }
        if (path === 'navigation.speedThroughWater' || path === 'navigation.speedOverGround') {
            if (val === null) { delete this.raw[path]; this.speedSourceTimes[path] = null; return; }
            if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 25.72) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const time = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.speedSourceTimes[path] != null && time <= this.speedSourceTimes[path]) return;
            this.speedSourceTimes[path] = time;
        }
        if (['navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue'].includes(path)) {
            if (val === null) { delete this.raw[path]; this.headingInputTimes[path] = null; if (path === 'navigation.headingTrue') this.headingSourceTime = null; return; }
            if (typeof val !== 'number' || !Number.isFinite(val) || Math.abs(val) > Math.PI * 2) return;
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const time = Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
            if (this.headingInputTimes[path] != null && time <= this.headingInputTimes[path]) return;
            this.headingInputTimes[path] = time;
            if (path === 'navigation.headingTrue') this.headingSourceTime = time;
        }
        // Navigation status is categorical, including an explicit null reset;
        // never pass it through the numerical smoothing used for instruments.
        if (path === 'navigation.state') {
            this.raw[path] = val;
            return;
        }
        if (val === null || val === undefined) return;

        const raw = this.raw;
        const lastPathProcessTimes = this.lastPathProcessTimes;
        const now = Date.now();
        const lastVal = raw[path];
        const lastTime = lastPathProcessTimes[path] || 0;

        // FILTRO DEDUPLICAZIONE CON HEARTBEAT DI SICUREZZA A 4 SECONDI:
        // Ridotto a 4 secondi per garantire che anche con timeline corte (5 min, secchiello da 5s)
        // il server scriva sempre almeno un punto nei buffer, evitando buchi nello storico.
        if (lastVal !== undefined && isValueEqual(val, lastVal) && (now - lastTime < 4000)) {
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
                if (current30mSlot > this.lastForecast30mSlot) {
                    this.fetchOpenMeteoForecast(val, current30mSlot);
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
            const age = now - this.speedSourceTimes[path];
            if (this.speedSourceTimes[path] != null && age >= 0 && age < boatSpeedMaxAgeMs) this.manageHistory('stw', smoothedVal * 1.94384);
        }
        else if (path === 'navigation.speedOverGround') {
            const age = now - this.speedSourceTimes[path];
            if (this.speedSourceTimes[path] != null && age >= 0 && age < boatSpeedMaxAgeMs) this.manageHistory('sog', smoothedVal * 1.94384);
        }
        else if (path === 'environment.depth.belowTransducer') {
            const age = now - this.depthSourceTime;
            if (this.depthSourceTime != null && age >= 0 && age < depthMaxAgeMs) this.manageHistory('depth', smoothedVal);
        }
        else if (path === 'environment.wind.speedApparent') {
            if (now - this.lastAwsReceivedTime < awsMaxAgeMs) this.manageHistory('aws', smoothedVal * 1.94384);
        }
        else if (path === 'environment.wind.angleApparent') {
            if (now - this.lastAwaReceivedTime < awaMaxAgeMs) this.pushRollingAngle('awa', smoothedVal, this.lastAwaReceivedTime);
        }
        else if (path === 'environment.wind.angleTrueWater') {
            if (now - this.lastNativeTwaTime < twaNativeMaxAgeMs) this.pushRollingAngle('twa', smoothedVal, this.lastNativeTwaTime);
        }
        else if (path === 'environment.wind.speedTrue') {
            if (now - this.lastNativeTwsTime < twsNativeMaxAgeMs) this.manageHistory('tws', smoothedVal * 1.94384);
        }
        else if (path === 'navigation.courseOverGroundTrue') {
            this.pushRollingAngle('cog', smoothedVal, now);
        }
        const headingTimes = this.getRawTimes();
        const heading = resolveHeading(raw, headingTimes, now, { headingMaxAgeMs, boatSpeedMaxAgeMs, gustSmoothingMs, gustResetGapMs, depthMaxAgeMs });
        if (heading !== null && ['navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue'].includes(path)) {
            this.pushRollingAngle('hdg', heading, this.headingInputTimes[path]);
        }

        // 2. Calcolo combinato di FALLBACK (Si attiva solo se la centralina non invia TWS/TWD nativi)
        const aws = raw["environment.wind.speedApparent"];
        const awa = raw["environment.wind.angleApparent"];
        const freshSpeed = path => {
            const time = this.speedSourceTimes[path];
            return time != null && now - time >= 0 && now - time < boatSpeedMaxAgeMs ? raw[path] : undefined;
        };
        const stw = freshSpeed("navigation.speedThroughWater");
        const measuredSog = freshSpeed("navigation.speedOverGround");
        const sog = measuredSog ?? 0;
        const measuredSpeed = stw !== undefined && !(sog > 0.77 && stw < 0.25) ? stw : measuredSog;
        const hdg = heading;
        let resolvedTwa = this.lastNativeTwaTime != null && now - this.lastNativeTwaTime < twaNativeMaxAgeMs ? raw["environment.wind.angleTrueWater"] : undefined;

        if (aws !== undefined && awa !== undefined && this.lastAwsReceivedTime !== null && now - this.lastAwsReceivedTime < awsMaxAgeMs && this.lastAwaReceivedTime != null && now - this.lastAwaReceivedTime < awaMaxAgeMs) {
            const awsKts = aws * 1.94384;
            
            // RILEVAMENTO "LOG BLOCCATO" SUL SERVER
            const hasStw = stw !== undefined;
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
            if (now - this.lastNativeTwsTime >= twsNativeMaxAgeMs) {
                const tws = Math.sqrt(tw_water_x * tw_water_x + tw_water_y * tw_water_y);
                this.manageHistory('tws', tws);
            }

            const hasNativeTwa = this.lastNativeTwaTime != null && now - this.lastNativeTwaTime < twaNativeMaxAgeMs && raw['environment.wind.angleTrueWater'] !== undefined;
            const calmVector = Math.hypot(tw_water_x, tw_water_y) <= trueWindDirectionMinSpeedMps * 1.94384;
            const twa = hasNativeTwa ? raw['environment.wind.angleTrueWater'] : Math.atan2(tw_water_y, tw_water_x);
            resolvedTwa = !hasNativeTwa && calmVector ? undefined : twa;


            if (!hasNativeTwa && !calmVector) {
                this.pushRollingAngle('twa', twa, now);
            }

        }
        if (Number.isFinite(resolvedTwa) && Number.isFinite(measuredSpeed)) {
            this.manageHistory('vmg', Math.abs(measuredSpeed * 1.94384 * Math.cos(resolvedTwa)));
        }
        const compass = resolveHeading(raw, headingTimes, now, { headingMaxAgeMs, boatSpeedMaxAgeMs }, false);
        const nativeTwdValid = this.lastNativeTwdTime != null && now >= this.lastNativeTwdTime &&
            now - this.lastNativeTwdTime < twdNativeMaxAgeMs && Number.isFinite(raw['environment.wind.directionTrue']);
        const canDerive = Number.isFinite(resolvedTwa) && Number.isFinite(compass);
        const twd = canDerive ? compass + resolvedTwa : nativeTwdValid ? raw['environment.wind.directionTrue'] :
            Number.isFinite(resolvedTwa) && Number.isFinite(hdg) ? hdg + resolvedTwa : null;
        if (twd !== null) {
            const normalized = ((twd % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            this.manageHistory('twd', normalized);
            this.pushRollingAngle('twd', normalized, !canDerive && nativeTwdValid ? this.lastNativeTwdTime : now);
        }
    }

    /**
     * pushRollingAngle: Mantiene un buffer rolling 1Hz degli ultimi 60 secondi
     * per gli angoli di navigazione (HDG, COG, TWA, AWA).
     * Garantisce inserimento O(1) e potatura deterministica (max 65 campioni).
     */
    pushRollingAngle(type, val, time) {
        if (val === undefined || val === null || !isFinite(val)) return;
        const rollingAngles = this.rollingAngles;
        const currentConfig = this.getConfig() || {};
        if (!rollingAngles[type]) rollingAngles[type] = [];
        const buf = rollingAngles[type];

        // Limita a max 1Hz per canale (evita duplicati se arrivano più pacchetti ravvicinati)
        if (buf.length > 0 && (time - buf[buf.length - 1].time < 800)) {
            return;
        }

        buf.push({ val: Number(val.toFixed(4)), time: time });

        // Calcola la finestra richiesta in base alle configurazioni tattiche (almeno 60s o il doppio di longWindow)
        const longWindow = (currentConfig.averaging && currentConfig.averaging.longWindow) ? currentConfig.averaging.longWindow : 30000;
        const windowMs = Math.max(60000, longWindow * 2);
        const maxSamples = Math.ceil(windowMs / 1000) + 5;

        // Conserva solo i campioni necessari per la finestra di calcolo ed evita accumuli anomali
        const cutoff = time - windowMs;
        while (buf.length > 0 && (buf[0].time < cutoff || buf.length > maxSamples)) {
            buf.shift();
        }
    }

    /**
     * manageHistory: Versione Server-side dell'aggregatore matematico tattico
     */
    manageHistory(type, value) {
        if (value === undefined || value === null || !isFinite(value)) return;

        const currentConfig = this.getConfig() || {};
        const graphTempBuf = this.graphTempBuf;
        const histories = this.histories;
        const lastUpdates = this.lastUpdates;
        const raw = this.raw;

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

        const lastInput = this.historyInputTimes[type];
        const gapBefore = Number.isFinite(lastInput) && now - lastInput >= 15000;
        this.historyInputTimes[type] = now;
        if (gapBefore) graphTempBuf[type] = [];
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
        const bucketReady = gapBefore || (now - lastUpdates[type] > bucketIntervalMs) || histories[type].length === 0;
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
                let state = this.gustFilter[type];
                let maxSustained = -Infinity;
                for (const point of tempBuf) {
                    const dt = state ? point.time - state.time : 0;
                    if (!state || dt < 0 || dt >= gustResetGapMs) {
                        state = { val: point.val, time: point.time };
                        maxSustained = point.val;
                    } else {
                        const alpha = 1 - Math.exp(-dt / gustSmoothingMs);
                        state = { val: state.val + alpha * (point.val - state.val), time: point.time };
                    }
                    maxSustained = Math.max(maxSustained, state.val);
                }
                this.gustFilter[type] = state;
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
            histories[type].push({ val: finalValue, time: now, ...(gapBefore ? { gapBefore: true } : {}) });
        } else {
            // Salvataggio specifico del TWD contenente l'oggetto { val, min, max, time }
            histories['twd'].push({
                val: finalValue.val,
                min: finalValue.min,
                max: finalValue.max,
                time: now,
                ...(gapBefore ? { gapBefore: true } : {})
            });

            // --- TRIGGER DI CONGELAMENTO ARCO (Ogni :00 e :30 dell'orologio) ---
            const current30mSlot = Math.floor(now / 1800000) * 1800000;
            if (this.lastFrozen30mSlot === 0) {
                this.lastFrozen30mSlot = current30mSlot; // Inizializzazione al primo avvio
            } else if (current30mSlot > this.lastFrozen30mSlot) {
                // Lo slot da 30 minuti precedente (lastFrozen30mSlot) si è appena concluso!
                // Avviamo la procedura di compressione e congelamento dei dati di quel periodo
                this.freeze30mSlot(this.lastFrozen30mSlot);
                this.lastFrozen30mSlot = current30mSlot;
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
     * freeze30mSlot: Consolida e congela i dati di una specifica mezz'ora.
     * Raccoglie i 30 record da 1 minuto, estrae i picchi, unisce gli angoli
     * e applica la scrematura del percentile al 5% prima di salvare lo slot.
     */
    freeze30mSlot(slotTimestamp) {
        const histories = this.histories;
        const windRadarSlots = this.windRadarSlots;
        const app = this.app;

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
    fetchOpenMeteoForecast(position, current30mSlot) {
        if (!position || position.latitude === undefined || position.longitude === undefined) return;

        const app = this.app;
        const lat = position.latitude;
        const lon = position.longitude;
        
        // Chirurgico: Aggiunto wind_gusts_10m alla chiamata per ottenere l'intensità delle raffiche previste
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=2`;

        this.lastForecast30mSlot = current30mSlot; // Aggiorna preventivamente lo slot per evitare chiamate simultanee in caso di rallentamento di rete

        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                app.error(`[Open-Meteo] HTTP Error: ${res.statusCode}`);
                res.resume();
                this.lastForecast30mSlot = 0; // Reset in caso di errore per permettere un tentativo al prossimo pacchetto GPS
                return;
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.hourly || !parsed.hourly.time) {
                        app.error('[Open-Meteo] Invalid API response format');
                        this.lastForecast30mSlot = 0;
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
                    this.calculateInterpolatedFuture(forecastList);

                } catch (err) {
                    app.error(`[Open-Meteo] Error parsing JSON: ${err.message}`);
                    this.lastForecast30mSlot = 0;
                }
            });
        });

        // Timeout di sicurezza a 8 secondi contro cadute di linea 4G/Satellite
        req.setTimeout(8000, () => {
            app.error('[Open-Meteo] Request Timeout (8s)');
            req.abort();
            this.lastForecast30mSlot = 0;
        });

        req.on('error', (err) => {
            app.error(`[Open-Meteo] Network Error: ${err.message}`);
            this.lastForecast30mSlot = 0;
        });
    }

    /**
     * calculateInterpolatedFuture: Esegue l'interpolazione lineare e vettoriale circolare
     * per trovare la previsione del vento tra 30 minuti esatti.
     */
    calculateInterpolatedFuture(forecastList) {
        if (forecastList.length < 2) return;

        const app = this.app;
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
            this.futureForecast = {
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
     * pruneStaleHistories: Pota in background i punti storici obsoleti dei sensori spenti.
     * Evita il congelamento dei grafici sul tablet e previene sprechi di RAM sul server.
     */
    pruneStaleHistories() {
        const app = this.app;
        const currentConfig = this.getConfig() || {};
        const histories = this.histories;
        const rollingAngles = this.rollingAngles;

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

        const longWindow = (currentConfig.averaging && currentConfig.averaging.longWindow) ? currentConfig.averaging.longWindow : 30000;
        const maxRollingMs = Math.max(60000, longWindow * 2);

        for (let type in rollingAngles) {
            while (rollingAngles[type].length > 0 && (now - rollingAngles[type][0].time) > maxRollingMs) {
                rollingAngles[type].shift();
            }
        }
    }
}

module.exports = { WindEngine };
