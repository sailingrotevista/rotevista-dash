const { gpsPositionFresh } = require('../shared/gpsPositionValidity');
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
const windDataPolicy = require('../shared/windDataPolicy.json');
const {resolveTws, aggregateTwd, historyRetentionMs} = require('./twdHistory');
const resolveDeclination = require('../shared/magneticDeclination')(require('geomagnetism'));
const { awsMaxAgeMs, awaMaxAgeMs, twsNativeMaxAgeMs, twaNativeMaxAgeMs, trueWindDirectionMinSpeedMps, twdNativeMaxAgeMs, headingMaxAgeMs, boatSpeedMaxAgeMs, gustSmoothingMs, gustResetGapMs, depthMaxAgeMs, historyGapMs } = require('../shared/windDataPolicy.json');

// ==========================================================================
// COSTANTI DI SVILUPPO (DEVELOPER CONFIG)
// ==========================================================================

function resolveHeading(raw, timestamps, now, policy, allowCog = true, normalizedSog) {
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
  const rawSog = raw['navigation.speedOverGround'], time = timestamps['navigation.speedOverGround'];
  const legacySog = Number.isFinite(rawSog) && rawSog >= 0 && rawSog <= 25.72 &&
    Number.isFinite(time) && now-time >= 0 && now-time < policy.boatSpeedMaxAgeMs ? rawSog : null;
  const sog = normalizedSog === undefined ? legacySog : normalizedSog;
  return cog !== null && sog !== null && sog > 0.77 ? cog : null;
}

class WindEngine {
    constructor(app, getConfig) {
        this.app = app;
        this.getConfig = getConfig;

        // Database dello storico in RAM sul server (Sintonizzato Pro v6.0)
        this.histories = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
        this.gustFilter = {};
        this.historyInputTimes = {};
        this.lastHistorySampleTime = null;
        this.graphTempBuf = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
        this.lastUpdates = { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0, twd: 0 };
        this.raw = {};
        this.lastAwsReceivedTime = null;
        this.lastAwaReceivedTime = null;
        this.depthSourceTime = null;
        this.positionSourceTime = null;
        this.speedSourceTimes = {};
        this.lastPathProcessTimes = {}; // Timestamp di ricezione per i percorsi non strumentali

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
        this.lastFrozen30mSlot = null;

        // Variabili dedicate al recupero e calcolo previsioni meteo future
        this.futureForecast = null;       // Memorizza la previsione futura { timestamp, tws, twd }
        this.lastForecast30mSlot = 0;     // Orario dell'ultimo blocco orologio scaricato con successo (es. 15:30)
    }

    // The normalizer owns source ordering; a valid backup may have an older fix.
    // TODO: antenna offsets remain uncompensated when the selected source changes.
    applyNormalizedPosition(measurement, now = Date.now()) {
        this.normalizedPositionManaged = true;
        this.positionMeasurement = measurement ? { ...measurement, value:measurement.value ? {...measurement.value} : null } : null;
        const value = measurement?.value, time = measurement?.timestamp;
        const valid = measurement?.valid === true && gpsPositionFresh(time, now, measurement?.expiresAt, windDataPolicy.positionMaxAgeMs) && value &&
            Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 &&
            Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
        this.raw['navigation.position'] = valid ? { ...value } : null;
        this.positionSourceTime = Number.isFinite(time) ? time : null;
        if (valid) this.updatePositionForecast(value, now);
    }

    // Validity/selection belong to SogNormalizer. Consumers only honour the
    // original deadline so a stopped input clock cannot freeze a usable value.
    applyNormalizedSog(measurement, now = Date.now()) {
        this.normalizedSogManaged = true;
        this.sogMeasurement = measurement ? {...measurement} : null;
        this.raw['navigation.speedOverGround'] = this.getNormalizedSog(now);
        this.speedSourceTimes['navigation.speedOverGround'] = measurement?.timestamp ?? null;
    }

    getNormalizedSog(now = Date.now()) {
        const m = this.sogMeasurement;
        return m?.valid === true && gpsPositionFresh(m.timestamp, now, m.expiresAt, boatSpeedMaxAgeMs) ? m.value : null;
    }

    applyNormalizedAws(measurement, now = Date.now()) {
        this.normalizedAwsManaged = true;
        this.awsMeasurement = measurement ? {...measurement} : null;
        this.raw['environment.wind.speedApparent'] = this.getNormalizedAws(now);
        this.lastAwsReceivedTime = measurement?.timestamp ?? null;
    }

    getNormalizedAws(now = Date.now()) {
        const m = this.awsMeasurement;
        return m?.valid === true && gpsPositionFresh(m.timestamp, now, m.expiresAt, awsMaxAgeMs) ? m.value : null;
    }

    applyNormalizedStw(measurement, now = Date.now()) {
        this.normalizedStwManaged = true;
        this.stwMeasurement = measurement ? {...measurement} : null;
        this.raw['navigation.speedThroughWater'] = this.getNormalizedStw(now);
        this.speedSourceTimes['navigation.speedThroughWater'] = measurement?.timestamp ?? null;
    }

    getNormalizedStw(now = Date.now()) {
        const m = this.stwMeasurement;
        return m?.valid === true && gpsPositionFresh(m.timestamp, now, m.expiresAt, boatSpeedMaxAgeMs) ? m.value : null;
    }

    applyNormalizedTws(measurement, now = Date.now()) {
        this.normalizedTwsManaged = true;
        this.twsMeasurement = measurement ? {...measurement} : null;
        this.raw['environment.wind.speedTrue'] = this.getNormalizedTws(now);
        this.lastNativeTwsTime = measurement?.timestamp ?? null;
    }

    getNormalizedTws(now = Date.now()) {
        const m = this.twsMeasurement;
        return m?.valid === true && gpsPositionFresh(m.timestamp, now, m.expiresAt, twsNativeMaxAgeMs) ? m.value : null;
    }

    applyNormalizedDepth(measurement, now = Date.now()) {
        this.normalizedDepthManaged = true;
        this.depthMeasurement = measurement ? {...measurement} : null;
        this.raw['environment.depth.belowTransducer'] = this.getNormalizedDepth(now);
        this.depthSourceTime = measurement?.timestamp ?? null;
    }

    getNormalizedDepth(now = Date.now()) {
        const m = this.depthMeasurement;
        return m?.valid === true && gpsPositionFresh(m.timestamp, now, m.expiresAt, depthMaxAgeMs) ? m.value : null;
    }

    updatePositionForecast(value, now) {
        const current30mSlot = Math.floor(now / 1800000) * 1800000;
        if (current30mSlot > this.lastForecast30mSlot &&
            (this.lastForecastAttemptTime == null || now-this.lastForecastAttemptTime >= 4000)) {
            this.lastForecastAttemptTime = now;
            this.fetchOpenMeteoForecast(value, current30mSlot);
        }
    }

    getPositionMeasurement() { return this.positionMeasurement ? { ...this.positionMeasurement } : null; }

    getRaw() {
        return this.raw;
    }

    getRawTimes() {
        return { ...this.lastPathProcessTimes, 'navigation.position':this.positionSourceTime, 'environment.depth.belowTransducer': this.depthSourceTime, ...this.speedSourceTimes, ...this.headingInputTimes, 'environment.wind.speedApparent': this.lastAwsReceivedTime, 'environment.wind.angleApparent': this.lastAwaReceivedTime, 'environment.wind.speedTrue': this.lastNativeTwsTime || null, 'environment.wind.angleTrueWater': this.lastNativeTwaTime || null, 'environment.wind.directionTrue': this.lastNativeTwdTime || null, 'navigation.headingTrue': this.headingSourceTime };
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
     * processIncomingDelta: acquisisce valori e timestamp senza alimentare gli storici.
     * sampleHistory esegue il campionamento comune a tutti i canali una volta al secondo.
     */
    processIncomingDelta(path, val, sourceTimestamp) {
        // Own position has one entry point: the measurement emitted by DerivedData.
        if (path === 'navigation.position' || path === 'navigation.speedOverGround' || path === 'environment.wind.speedApparent' || path === 'navigation.speedThroughWater' || path === 'environment.wind.speedTrue' || path === 'environment.depth.belowTransducer') return;
        const sourceFields = {
            'environment.depth.belowTransducer': 'depthSourceTime',
            'environment.wind.speedTrue': 'lastNativeTwsTime',
            'environment.wind.directionTrue': 'lastNativeTwdTime',
            'environment.wind.angleTrueWater': 'lastNativeTwaTime',
            'environment.wind.angleApparent': 'lastAwaReceivedTime',
            'environment.wind.speedApparent': 'lastAwsReceivedTime',
        };
        const boatSpeed = ['navigation.speedThroughWater', 'navigation.speedOverGround'].includes(path);
        const heading = ['navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.courseOverGroundTrue'].includes(path);
        if (sourceFields[path] || boatSpeed || heading) {
            const parsed = typeof sourceTimestamp === 'number' ? sourceTimestamp : Date.parse(sourceTimestamp);
            const now = Date.now();
            const time = Number.isFinite(parsed) ? Math.min(now, parsed) : now;
            const previousTime = this.getRawTimes()[path];
            // At equal timestamps an explicit reset wins; a replay cannot undo it.
            if (Number.isFinite(previousTime) && (time < previousTime ||
                (time === previousTime && (val !== null || this.raw[path] === null)))) return;
            if (val !== null) {
                {
                    if (!Number.isFinite(val)) return;
                    if (path === 'environment.depth.belowTransducer') {
                        if (val < -2 || val > 500) return;
                    } else if (boatSpeed || path === 'environment.wind.speedTrue' || path === 'environment.wind.speedApparent') {
                        if (val < 0 || val > (boatSpeed ? 25.72 : 51.44)) return;
                    } else if (Math.abs(val) > Math.PI * 2) return;
                }
            }
            if (sourceFields[path]) this[sourceFields[path]] = time;
            if (boatSpeed) this.speedSourceTimes[path] = time;
            if (heading) this.headingInputTimes[path] = time;
            if (path === 'navigation.headingTrue') this.headingSourceTime = time;
            if (val === null) {
                // Retain the reset in snapshots, including its ordering timestamp.
                this.raw[path] = null;
                const channel = path === 'environment.wind.angleTrueWater' ? 'twa' :
                    path === 'environment.wind.angleApparent' ? 'awa' : null;
                if (channel) this.rollingAngles[channel] = [];
                return;
            }
        }
        // Navigation status is categorical, including an explicit null reset;
        // never pass it through the numerical smoothing used for instruments.
        if (path === 'navigation.state') {
            this.raw[path] = val;
            return;
        }
        if (val === null || val === undefined) return;

        const raw = this.raw;
        const now = Date.now();
        this.lastPathProcessTimes[path] = now;
        if (typeof val === 'number' && (path.includes('angle') || path.includes('heading') ||
            path.includes('course') || path.includes('direction') || path.includes('twd'))) {
            raw[path] = ((val % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
        } else raw[path] = val;
    }

    // A single clock samples current valid values; unrelated deltas never add
    // repeated samples or change a channel's weight in the history bucket.
    sampleHistory(now = Date.now()) {
        if (!Number.isFinite(now) || (this.lastHistorySampleTime !== null && now-this.lastHistorySampleTime < 1000)) return false;
        this.lastHistorySampleTime = now;
        this.freezeCompletedRadarSlots(now);
        const raw = this.raw, times = this.getRawTimes();
        const fresh = (path, maxAge, valid) => {
            const value=raw[path], time=times[path];
            return Number.isFinite(value) && valid(value) && Number.isFinite(time) && now >= time && now-time < maxAge ? value : null;
        };
        const speed = value => value >= 0 && value <= 25.72;
        const angle = value => Math.abs(value) <= Math.PI*2;
        const stw = this.normalizedStwManaged ? this.getNormalizedStw(now) : fresh('navigation.speedThroughWater',boatSpeedMaxAgeMs,speed);
        const sog = this.normalizedSogManaged ? this.getNormalizedSog(now) : fresh('navigation.speedOverGround',boatSpeedMaxAgeMs,speed);
        const depth = this.normalizedDepthManaged ? this.getNormalizedDepth(now) : fresh('environment.depth.belowTransducer',depthMaxAgeMs,value => value >= -2 && value <= 500);
        const aws = this.normalizedAwsManaged ? this.getNormalizedAws(now) : fresh('environment.wind.speedApparent',awsMaxAgeMs,value => value >= 0 && value <= 51.44);
        const awa = fresh('environment.wind.angleApparent',awaMaxAgeMs,angle);
        const cog = fresh('navigation.courseOverGroundTrue',headingMaxAgeMs,angle);
        const heading = resolveHeading(raw,times,now,windDataPolicy,true,this.normalizedSogManaged ? sog : undefined);
        const measuredSpeed = stw !== null && !(sog !== null && sog > 0.77 && stw < 0.25) ? stw : sog;
        let twa = fresh('environment.wind.angleTrueWater',twaNativeMaxAgeMs,angle);
        if (twa === null && aws !== null && awa !== null) {
            const x = aws*Math.cos(awa)-(measuredSpeed ?? 0), y = aws*Math.sin(awa);
            if (Math.hypot(x,y) > trueWindDirectionMinSpeedMps) twa = Math.atan2(y,x);
        }
        const tws = resolveTws(raw,times,now,windDataPolicy,this.normalizedSogManaged ? sog : undefined,this.normalizedAwsManaged ? aws : undefined,this.normalizedStwManaged ? stw : undefined,this.normalizedTwsManaged ? this.getNormalizedTws(now) : undefined);
        const compass = resolveHeading(raw,times,now,windDataPolicy,false,this.normalizedSogManaged ? sog : undefined);
        const nativeTwd = fresh('environment.wind.directionTrue',twdNativeMaxAgeMs,angle);
        const twd = twa !== null && compass !== null ? compass+twa : nativeTwd !== null ? nativeTwd :
            twa !== null && heading !== null ? heading+twa : null;
        for (const [channel,value] of [['stw',stw],['sog',sog],['depth',depth],['aws',aws],['tws',tws],
            ['vmg',twa !== null && measuredSpeed !== null ? Math.abs(measuredSpeed*Math.cos(twa)) : null]]) {
            if (value !== null) this.manageHistory(channel,channel==='depth' ? value : value*1.94384,now);
        }
        for (const [channel,value] of [['hdg',heading],['cog',cog],['awa',awa],['twa',twa]]) {
            if (value !== null) this.pushRollingAngle(channel,value,now);
        }
        if (twd !== null) {
            const normalized = ((twd % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
            this.manageHistory('twd',normalized,now);
            this.pushRollingAngle('twd',normalized,now);
        }
        return true;
    }

    /**
     * pushRollingAngle: Mantiene un buffer rolling 1Hz degli ultimi 60 secondi
     * per gli angoli di navigazione (HDG, COG, TWA, AWA).
     * Garantisce inserimento O(1) e potatura deterministica (max 65 campioni).
     */
    pushRollingAngle(type, val, time) {
        if (!Number.isFinite(val) || !Number.isFinite(time)) return;
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
    manageHistory(type, value, sampleTime = Date.now()) {
        if (!Number.isFinite(value)) return;

        const currentConfig = this.getConfig() || {};
        const graphTempBuf = this.graphTempBuf;
        const histories = this.histories;
        const lastUpdates = this.lastUpdates;
        const raw = this.raw;

        const now = sampleTime;
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
        if (Number.isFinite(lastInput) && now-lastInput < 1000) return;
        const gapBefore = Number.isFinite(lastInput) && now - lastInput >= historyGapMs;
        this.historyInputTimes[type] = now;
        if (gapBefore) graphTempBuf[type] = [];
        const tempBuf = graphTempBuf[type];

        // Cattura la velocità del vento corrente (in m/s) al momento della lettura
        const currentTws = type === 'twd' ? resolveTws(raw, this.getRawTimes(), now, windDataPolicy,this.normalizedSogManaged ? this.getNormalizedSog(now) : undefined,this.normalizedAwsManaged ? this.getNormalizedAws(now) : undefined,this.normalizedStwManaged ? this.getNormalizedStw(now) : undefined,this.normalizedTwsManaged ? this.getNormalizedTws(now) : undefined) : null;
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
                finalValue = aggregateTwd(tempBuf, windDataPolicy);
                if (finalValue === null) return;
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
                    if (Number.isFinite(v) && v < minVal) minVal = v;
                }
                if (minVal !== Infinity) finalValue = minVal;
            }
            // C. VELOCITÀ BARCA / ALTRO -> MEDIA (Ottimizzato a 0 allocazioni)
            else {
                let sum = 0;
                let count = 0;
                for (let i = 0; i < tempBuf.length; i++) {
                    const v = tempBuf[i].val;
                    if (Number.isFinite(v)) {
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

        }

        const maxHistoryMs = historyRetentionMs(type, historyMinutes, windDataPolicy);

        while (histories[type].length > 0 && (now - histories[type][0].time) > maxHistoryMs) {
            histories[type].shift();
        }

        graphTempBuf[type] = [];
        // Spostiamo il timer esattamente al confine del secchiello assoluto appena concluso
        lastUpdates[type] = Math.floor(now / bucketIntervalMs) * bucketIntervalMs;
    }

    // Finalize on the server clock even if the wind sensor becomes silent.
    // This runs before pruning so a completed interval cannot lose its inputs.
    freezeCompletedRadarSlots(now) {
        const slotMs = 30*60000;
        const currentSlot = Math.floor(now/slotMs)*slotMs;
        if (this.lastFrozen30mSlot === null) { this.lastFrozen30mSlot=currentSlot; return; }
        const first = Math.max(this.lastFrozen30mSlot,currentSlot-12*slotMs);
        for (let slot=first; slot<currentSlot; slot+=slotMs) this.freeze30mSlot(slot);
        if (currentSlot > this.lastFrozen30mSlot) this.lastFrozen30mSlot=currentSlot;
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
        this.freezeCompletedRadarSlots(now);

        for (let type in histories) {
            const maxHistoryMs = historyRetentionMs(type, historyMinutes, windDataPolicy);
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
