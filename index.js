/**
 * ==========================================================================
 * Rotevista Dash Configuration & History Plugin (Pro v6.0)
 * ==========================================================================
 * Definisce l'interfaccia di configurazione in Signal K Admin e crea
 * gli endpoint pubblici per la Dashboard, mantenendo lo storico in RAM.
 */

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'rotevista-dash';
  plugin.name = 'Rotevista Dash Configuration';
  plugin.description = 'Configure boat-specific tactical and safety parameters for the Dashboard';

  let currentConfig = {};
  let routeRegistered = false;
  let unsubscribes = [];

    // Database dello storico in RAM sul server (Sintonizzato Pro v6.0)
      let histories = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
      let graphTempBuf = { stw: [], sog: [], depth: [], tws: [], vmg: [], aws: [], twd: [] };
      let lastUpdates = { stw: 0, sog: 0, depth: 0, tws: 0, vmg: 0, aws: 0, twd: 0 };
      let raw = {};
    // Memoria temporale per rilevare la presenza di sensori nativi sul Cerbo
      let lastNativeTwsTime = 0;
      let lastNativeTwdTime = 0;

  /**
   * plugin.start: Inizializza il plugin.
   * Viene chiamato all'avvio e OGNI VOLTA che clicchi "Save" nelle impostazioni.
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

  // 2. Registra le rotte API solo la prima volta (Abilitate per CORS remoto)
      if (!routeRegistered) {
        app.get('/rotevista-config', (req, res) => {
          res.header("Access-Control-Allow-Origin", "*"); // Sblocca la Dashboard locale su Mac
          res.json(currentConfig);
        });
        app.get('/rotevista-history', (req, res) => {
          res.header("Access-Control-Allow-Origin", "*"); // Sblocca la Dashboard locale su Mac
          res.json(histories);
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
        { path: 'navigation.headingTrue' },
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
    if (path === 'navigation.speedThroughWater') {
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
    else if (path === 'environment.wind.speedTrue') {
      lastNativeTwsTime = now; // Rilevato TWS nativo della centralina!
      manageHistory('tws', val * 1.94384);
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

    tempBuf.push({ val: value, time: now });

    // Controllo avanzamento del secchiello temporale (Bucket)
    const bucketReady = (now - lastUpdates[type] > bucketIntervalMs) || histories[type].length === 0;
    if (!bucketReady) return;

    let finalValue = value;

    if (tempBuf.length > 0) {
      // A. VENTO -> SUSTAINED PEAK (EMA Time-Aware)
      if (type === 'tws' || type === 'aws') {
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
      // C. VELOCITÀ -> MEDIA
      else {
        const vals = tempBuf.map(p => p.val).filter(v => isFinite(v));
        if (vals.length > 0) {
          const sum = vals.reduce((a, b) => a + b, 0);
          finalValue = sum / tempBuf.length;
        }
      }
    }

    if (!isFinite(finalValue)) return;
    finalValue = Math.max(0, finalValue);

  // Salvataggio nel ring buffer dello storico principale
      histories[type].push({ val: finalValue, time: now });

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

  return plugin;
};
