/**
 * ==========================================================================
 * Rotevista Dash Configuration & History Plugin (Pro v6.0)
 * ==========================================================================
 * Definisce l'interfaccia di configurazione in Signal K Admin e crea
 * gli endpoint pubblici per la Dashboard, mantenendo lo storico in RAM.
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

    // Reset dello storico al riavvio del plugin per evitare incoerenze (Sintonizzato Pro v6.0)
    histories = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
    graphTempBuf = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
    lastUpdates = { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0, twd: 0 };
    raw = {};
    windRadarSlots = [];        // Reset degli archi storici della bussola
    lastFrozen30mSlot = 0;      // Reset del monitor temporale della bussola
    futureForecast = null;      // Reset della previsione meteo futura
    lastForecast30mSlot = 0;    // Reset del monitor temporale di scaricamento meteo
      
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
          futureForecast: futureForecast
        };
        res.json(responseData);
      });
      routeRegistered = true;
      app.debug('Public API endpoints registered at /rotevista-config and /rotevista-history');
    }

    // 3. Iscrizione ai dati dei sensori di bordo tramite Signal K
    const localSubscription = {
      context: 'vessels.self',
      subscribe: [
        { path: 'navigation.speedThroughWater' },
        { path: 'navigation.speedOverGround' },
        { path: 'environment.depth.belowTransducer' },
        { path: 'environment.wind.speedApparent' },
        { path: 'environment.wind.angleApparent' },
        { path: 'environment.wind.speedTrue' },      // Aggiunto chirurgicamente
        { path: 'environment.wind.directionTrue' },  // Aggiunto chirurgicamente
        { path: 'navigation.headingTrue' },
        { path: 'navigation.headingMagnetic' },
        { path: 'navigation.magneticVariation' },
        { path: 'navigation.courseOverGroundTrue' }
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
  };

  /**
   * plugin.stop: Chiamato quando il plugin viene disattivato.
   */
  plugin.stop = function () {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    app.debug(`${plugin.name} stopped`);
  };

  plugin.debug = function(msg) {
    app.debug(msg);
  };

  /**
   * processIncomingDelta: Decodifica i dati dei sensori in Knots/Meters ed esegue l'aggregazione
   * Gestisce l'architettura "Nativo Prima, Fallback Dopo" per il vento reale.
   */
  function processIncomingDelta(path, val) {
    if (val === null || val === undefined) return;
    raw[path] = val;

    const now = Date.now();

    // 1. Cattura dei dati nativi (Se presenti, li scrive direttamente nello storico)
    if (path === 'navigation.position') {
      // Trigger allineato all'orologio: calcoliamo il confine della mezz'ora corrente dell'orologio
      if (val && val.latitude !== undefined && val.longitude !== undefined) {
        const current30mSlot = Math.floor(Date.now() / 1800000) * 1800000;
        // Se siamo entrati in una nuova mezz'ora di orologio dall'ultimo download, avviamo il fetch
        if (current30mSlot > lastForecast30mSlot) {
          fetchOpenMeteoForecast(val, current30mSlot);
        }
      }
    }
    else if (path === 'navigation.speedThroughWater') {
      manageHistory('stw', val * 1.94384);
    }
    else if (path === 'navigation.speedOverGround') {
      manageHistory('sog', val * 1.94384);
    }
    else if (path === 'environment.depth.belowTransducer') {
      manageHistory('depth', val);
    }
    else if (path === 'environment.wind.speedApparent') {
      manageHistory('aws', val * 1.94384);
    }
    else if (path === 'environment.wind.angleApparent') {
      raw[path] = val; // BUG RISOLTO: Acquisizione dell'AWA mancante inserita!
    }
    else if (path === 'environment.wind.speedTrue') {
      lastNativeTwsTime = now; // Rilevato TWS nativo della centralina!
      manageHistory('tws', val * 1.94384);
    }
    // --- DECODIFICA PRUA MAGNETICA SERVER-SIDE ---
    else if (path === 'navigation.headingMagnetic') {
      const hasTrueHdg = raw['navigation.headingTrue'] !== undefined;
      if (!hasTrueHdg) {
        const variation = raw['navigation.magneticVariation'] || 0;
        raw['navigation.headingTrue'] = (val + variation + 2 * Math.PI) % (2 * Math.PI);
      }
    }
    else if (path === 'environment.wind.directionTrue') {
      lastNativeTwdTime = now; // Rilevato TWD nativo della centralina!
      manageHistory('twd', val);
    }

    // 2. Calcolo combinato di FALLBACK (Si attiva solo se la centralina non invia TWS/TWD nativi)
    const aws = raw["environment.wind.speedApparent"];
    const awa = raw["environment.wind.angleApparent"];
    const stw = raw["navigation.speedThroughWater"] || 0;
    const sog = raw["navigation.speedOverGround"] || 0;
    const hdg = raw["navigation.headingTrue"] || 0;
    const cog = raw["navigation.courseOverGroundTrue"] || 0;

    if (aws !== undefined && awa !== undefined) {
      const awsKts = aws * 1.94384;
      const stwKts = stw * 1.94384;
      const tw_water_x = awsKts * Math.cos(awa) - stwKts;
      const tw_water_y = awsKts * Math.sin(awa);

      // Calcoliamo il TWS di fallback solo se non abbiamo visto dati nativi negli ultimi 5 secondi
      if (now - lastNativeTwsTime > 5000) {
        const tws = Math.sqrt(tw_water_x * tw_water_x + tw_water_y * tw_water_y);
        manageHistory('tws', tws);
      }

      const twa = Math.atan2(tw_water_y, tw_water_x);
      
      // La VMG viene sempre calcolata a livello server poiché raramente è nativa
      const vmg = Math.abs(stwKts * Math.cos(twa));
      manageHistory('vmg', vmg);

      // Calcoliamo il TWD di fallback solo se non abbiamo visto dati nativi negli ultimi 5 secondi
      if (hdg !== undefined && (now - lastNativeTwdTime > 5000)) {
        const twd = (hdg + twa + 2 * Math.PI) % (2 * Math.PI);
        twd = (twd + 2 * Math.PI) % (2 * Math.PI); // Sicurezza extra
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
        // 1. Identifica il vento massimo del minuto (in m/s)
        const twsVals = tempBuf.map(p => p.tws || 0);
        const maxTwsInMinute = Math.max(...twsVals, 0);

        // 2. Calcola la soglia dinamica di pressione: max tra 40% del picco e soglia di calma piatta (in m/s)
        const calmThresholdMs = CALM_THRESHOLD_KTS / 1.94384;
        const pressureThreshold = Math.max(maxTwsInMinute * PRESSURE_FILTER_RATIO, calmThresholdMs);

        // 3. Esclude le direzioni registrate quando il vento era debole (sotto la soglia di pressione)
        const activePoints = tempBuf.filter(p => (p.tws || 0) >= pressureThreshold);
        const pointsToUse = activePoints.length > 0 ? activePoints : tempBuf; // Fallback se tutto è calma piatta

        // 4. Media Vettoriale Pesata (TWS * sin, TWS * cos)
        let sumSin = 0;
        let sumCos = 0;
        let totalWeight = 0;
        pointsToUse.forEach(p => {
          const weight = Math.max(p.tws || 0.1, 0.05); // Evita pesi a zero
          sumSin += weight * Math.sin(p.val);
          sumCos += weight * Math.cos(p.val);
          totalWeight += weight;
        });
        const avgAngle = Math.atan2(sumSin, sumCos);
        const finalAvg = (avgAngle + Math.PI * 2) % (Math.PI * 2);

        // 5. Calcolo di Min e Max angolare del minuto (rispetto alla media per gestire l'oltrepasso di 0/360°)
        let diffs = pointsToUse.map(p => {
          let diff = p.val - finalAvg;
          return Math.atan2(Math.sin(diff), Math.cos(diff)); // Srotolamento tra -PI e +PI
        });

        const minDiff = Math.min(...diffs);
        const maxDiff = Math.max(...diffs);

        const finalMin = (finalAvg + minDiff + Math.PI * 2) % (Math.PI * 2);
        const finalMax = (finalAvg + maxDiff + Math.PI * 2) % (Math.PI * 2);

        finalValue = {
          val: finalAvg,
          min: finalMin,
          max: finalMax
        };
      }
      // A. VENTO VELOCITÀ -> SUSTAINED PEAK (EMA Time-Aware)
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
      // B. PROFONDITÀ -> MINIMO
      else if (type === 'depth') {
        const vals = tempBuf.map(p => p.val).filter(v => isFinite(v));
        if (vals.length > 0) finalValue = Math.min(...vals);
      }
      // C. VELOCITÀ BARCA / ALTRO -> MEDIA
      else {
        const vals = tempBuf.map(p => p.val).filter(v => isFinite(v));
        if (vals.length > 0) {
          const sum = vals.reduce((a, b) => a + b, 0);
          finalValue = sum / tempBuf.length;
        }
      }
    }

    // Validazione e clamping di sicurezza (non si applica all'oggetto TWD)
    if (!isTwdType) {
      if (!isFinite(finalValue)) return;
      finalValue = Math.max(0, finalValue);
      histories[type].push({ val: finalValue, time: now });
    } else {
      // Salvataggio specifico del TWD contenente l'oggetto { val, min, max, time }
      histories['twd'].push({
        val: finalValue.val,
        min: finalValue.min,
        max: finalValue.max,
        time: now
      });

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
      twsPeak: maxTws
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
    
    // Modello accoppiato Seamless basato su forecast, con vento espresso in nodi e orario in UTC (GMT)
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=2`;

    lastForecast30mSlot = current30mSlot; // Aggiorna preventivamente lo slot per evitare chiamate simultanee in caso di rallentamento di rete

    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        app.error(`[Open-Meteo] HTTP Error: ${res.statusCode}`);
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
              twd: twdRad
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

      // Salviamo le previsioni future nel server
      futureForecast = {
        timestamp: targetTime,
        tws: interpolatedTws,
        twd: interpolatedTwd
      };

      app.debug(`🔮 [Open-Meteo] Target forecast interpolated for ${new Date(targetTime).toLocaleTimeString()}: TWD ${Math.round(interpolatedTwd * 180 / Math.PI)}°, TWS ${interpolatedTws.toFixed(1)} kts`);
    } else {
      app.error('[Open-Meteo] Forecast matching slots not found for target time');
    }
  }
    
  return plugin;
};
