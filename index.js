/**
    * ==========================================================================
    * Rotevista Dash Configuration & History Plugin (Pro v6.0)
    * ==========================================================================
    * Definisce l'interfaccia di configurazione in Signal K Admin e crea
    * gli endpoint pubblici per la Dashboard, mantenendo lo storico in RAM.
    * file index.js
    */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { CollisionPipeline } = require('./collisionPipeline');
const { HarborDetector } = require('./harborDetector');
const { WindEngine } = require('./windEngine');

// ==========================================================================
// CONFIGURAZIONE PARAMETRICA CACHE TILE CARTOGRAFICHE (Cerbo GX / Venus OS)
// Modificare questi parametri per personalizzare limiti di spazio e TTL
// ==========================================================================
const TILE_CACHE_CONFIG = {
    enabled: true,
    storageDir: 'tile-cache', // Cartella di salvataggio (relativa o assoluta)
    hardCapMb: 50,           // Hard Cap massimo assoluto su disco (MB)
    lowWatermarkMb: 40,      // Soglia di rientro pulizia forzata LRU (MB)
    tiers: {
        macro: { maxZoom: 11, ttlHours: 30 * 24 }, // Zoom <= 11: 30 giorni (Mare aperto / Panoramica)
        tactical: { maxZoom: 14, ttlHours: 72 },    // Zoom 12..14: 72 ore (Canali / Approcci)
        micro: { maxZoom: 20, ttlHours: 8 }         // Zoom >= 15: 8 ore (Rada / Ormeggio)
    },
    pruneIntervalMs: 15 * 60 * 1000 // Frequenza controllo pulizia periodica (15 min)
};

module.exports = function (app) {
    const plugin = {};
    plugin.id = 'rotevista-dash';
    plugin.name = 'Rotevista Dash Configuration';
    plugin.description = 'Configure boat-specific tactical and safety parameters for the Dashboard';

    // Gestione interna della cache cartografica su disco (LRU a due soglie)
    let tileCacheIndex = new Map(); // key -> { filePath, size, zoom, lastUsed, createdAt }
    let tileCacheTotalBytes = 0;
    let tileCachePruneTimer = null;
    let tileCacheDirResolved = null;

    let currentConfig = {};
    let routeRegistered = false;
    let unsubscribes = [];
    let pruneInterval = null; // Timer in background per la potatura automatica dei sensori spenti
    let aisInterval = null;   // Timer in background per il motore cinematico AIS (15s)
    let aisPersistentCache = {}; // Cache persistenze 20NM
    let lastNearbyVessels = [];  // Bersagli AIS calcolati (ordinati per rischio)
    let lastHarborClusters = []; // Cluster portuali calcolati (Monotone Chain)
    let topThreat = null;        // Bersaglio a massimo rischio per banner dash
    let lastOwnGps = { lat: null, lon: null, t: 0 }; // Ultimo punto GPS proprio per cinematica
    let aisDiagnostics = { status: 'INITIALIZING', myGps: null, vesselsCount: 0, extractionMethod: 'none', lastRun: null };
    const collisionPipeline = new CollisionPipeline();
    const harborDetector = new HarborDetector();
    const windEngine = new WindEngine(app, () => currentConfig);

    /**
        * plugin.start: Inizializza il plugin.
        * Viene chiamato all'avvio e OGNI VOLTA che si salva nella configurazione.
        */
    plugin.start = function (options) {
        // 1. Aggiorna la configurazione in memoria con fallback per aisAlerter
        const defaultAisConfig = {
            enabled: true,
            ignoreOwnTarget: "106125",
            pleasureCraft: {
                redCpa: 300,
                orangeCpa: 700,
                maxTcpa: 10
            },
            commercialShips: {
                redCpa: 800,
                orangeCpa: 1852,
                maxTcpa: 15
            },
            workboats: {
                redCpa: 350,
                orangeCpa: 750,
                maxTcpa: 12
            },
            vectorMinutes: 15,
            criticalProximity: 45
        };
        currentConfig = options || {};
        currentConfig.aisAlerter = Object.assign({}, defaultAisConfig, currentConfig.aisAlerter || {});
        app.debug(`${plugin.name} started/updated with new options`);
        if (typeof app.handleMessage === 'function') {
            app.handleMessage(plugin.id, {
                context: 'vessels.self',
                updates: [{ values: [{ path: 'environment.rotevista_config', value: currentConfig }] }]
            });
        }

        // Rimosso il reset distruttivo per garantire la conservazione dei dati in RAM
        // durante il salvataggio dei parametri o il cambio delle calibrazioni delle scale.
            
        // 2. Registra le rotte API solo la prima volta (Abilitate per CORS remoto)
        if (!routeRegistered) {
            app.get('/rotevista-config', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*"); // Sblocca la Dashboard locale su Mac
                res.header("Cache-Control", "no-store, no-cache, must-revalidate");
                res.json(currentConfig);
            });
            app.get('/rotevista-history', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*"); // Sblocca la Dashboard locale su Mac
                // Costruiamo un pacchetto unificato che unisce i grafici classici, i dati radar e il futuro
                const raw = windEngine.getRaw();
                const responseData = {
                    ...windEngine.getHistories(),
                    rollingAngles: windEngine.getRollingAngles(),
                    windRadarSlots: windEngine.getWindRadarSlots(),
                    futureForecast: windEngine.getFutureForecast(),
                    'navigation.position': raw['navigation.position'], // Chirurgico: Espone le coordinate GPS correnti per la diagnostica e il radar
                    ais_targets: lastNearbyVessels,
                    ais_top_threat: topThreat,
                    harbor_clusters: lastHarborClusters
                };
                res.json(responseData);
            });
            app.get('/rotevista-ais', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*");
                res.json({
                    targets: lastNearbyVessels,
                    harborClusters: lastHarborClusters,
                    topThreat: topThreat,
                    diagnostics: {
                        ...aisDiagnostics,
                        cacheCount: Object.keys(aisPersistentCache).length,
                        nearbyCount: lastNearbyVessels.length,
                        serverTime: new Date().toISOString()
                    }
                });
            });
            app.get('/rotevista-tile', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*");
                const { provider, z, x, y } = req.query;
                const zoom = parseInt(z, 10);
                const tileX = parseInt(x, 10);
                const tileY = parseInt(y, 10);

                if (!provider || isNaN(zoom) || isNaN(tileX) || isNaN(tileY)) {
                    return res.status(400).send("Parametri tile non validi");
                }

                serveCachedOrFetchTile(provider, zoom, tileX, tileY, res);
            });

            // Fallback static mount per Signal K per garantire che /rotevista-dash serva sempre la cartella public
            try {
                const path = require('path');
                const express = require('express');
                const publicPath = path.join(__dirname, 'public');
                if (typeof app.use === 'function') {
                    app.use('/rotevista-dash', express.static(publicPath));
                    app.use('/@sailingrotevista/rotevista-dash', express.static(publicPath));
                }
            } catch (err) {
                app.debug(`[rotevista-dash] Notice on static fallback: ${err.message}`);
            }

            routeRegistered = true;
            app.debug('Public API endpoints registered at /rotevista-config, /rotevista-history, and /rotevista-ais');
        }

        // 3. Iscrizione ai dati dei sensori di bordo tramite Signal K (Ottimizzata a 1Hz)
        const localSubscription = {
            context: 'vessels.self',
            subscribe: [
                { path: 'navigation.position', minPeriod: 1000 },
                { path: 'navigation.speedThroughWater', minPeriod: 1000 },
                { path: 'navigation.speedOverGround', minPeriod: 1000 },
                { path: 'environment.depth.belowTransducer', minPeriod: 1000 },
                { path: 'environment.wind.speedApparent', minPeriod: 1000 },
                { path: 'environment.wind.angleApparent', minPeriod: 1000 },
                { path: 'environment.wind.speedTrue', minPeriod: 1000 },
                { path: 'environment.wind.angleTrueWater', minPeriod: 1000 },
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
                                windEngine.processIncomingDelta(v.path, v.value);
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
        pruneInterval = setInterval(() => windEngine.pruneStaleHistories(), 60000);

        // Avvia il timer del motore cinematico AIS (15s)
        if (aisInterval) {
            clearInterval(aisInterval);
            aisInterval = null;
        }
        const intervalMs = ((currentConfig.aisAlerter && currentConfig.aisAlerter.checkIntervalSec) || 15) * 1000;
        aisInterval = setInterval(processAisEngine, intervalMs);
        setTimeout(processAisEngine, 1000); // Primo calcolo a caldo entro 1s
        // Inizializza la cache cartografica locale LRU su disco per Cerbo GX
        initTileCache();
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
        if (aisInterval) {
            clearInterval(aisInterval);
            aisInterval = null;
        }
        if (tileCachePruneTimer) {
            clearInterval(tileCachePruneTimer);
            tileCachePruneTimer = null;
        }
        app.debug(`${plugin.name} stopped`);
    };

    // ==========================================================================
    // MOTORE CACHE CARTOGRAFICA TIERED NAUTICAL LRU (Cerbo GX)
    // ==========================================================================
    function getTileTtlMs(zoom) {
        if (zoom <= TILE_CACHE_CONFIG.tiers.macro.maxZoom) {
            return TILE_CACHE_CONFIG.tiers.macro.ttlHours * 3600 * 1000;
        }
        if (zoom <= TILE_CACHE_CONFIG.tiers.tactical.maxZoom) {
            return TILE_CACHE_CONFIG.tiers.tactical.ttlHours * 3600 * 1000;
        }
        return TILE_CACHE_CONFIG.tiers.micro.ttlHours * 3600 * 1000;
    }

    function initTileCache() {
        if (!TILE_CACHE_CONFIG.enabled) return;
        try {
            tileCacheDirResolved = path.isAbsolute(TILE_CACHE_CONFIG.storageDir)
                ? TILE_CACHE_CONFIG.storageDir
                : path.join(__dirname, TILE_CACHE_CONFIG.storageDir);

            if (!fs.existsSync(tileCacheDirResolved)) {
                fs.mkdirSync(tileCacheDirResolved, { recursive: true });
            }

            // Scansione iniziale singola all'avvio per popolare l'indice in RAM senza I/O continuo
            tileCacheIndex.clear();
            tileCacheTotalBytes = 0;
            const files = fs.readdirSync(tileCacheDirResolved);
            for (const file of files) {
                if (!file.endsWith('.png')) continue;
                const fullPath = path.join(tileCacheDirResolved, file);
                try {
                    const stat = fs.statSync(fullPath);
                    const parts = file.replace('.png', '').split('_');
                    const zoom = parts.length >= 4 ? parseInt(parts[1], 10) : 10;
                    tileCacheIndex.set(file, {
                        filePath: fullPath,
                        size: stat.size,
                        zoom: isNaN(zoom) ? 10 : zoom,
                        lastUsed: stat.mtimeMs || Date.now(),
                        createdAt: stat.ctimeMs || Date.now()
                    });
                    tileCacheTotalBytes += stat.size;
                } catch (e) {}
            }

            if (tileCachePruneTimer) clearInterval(tileCachePruneTimer);
            tileCachePruneTimer = setInterval(pruneTileCache, TILE_CACHE_CONFIG.pruneIntervalMs);
            app.debug(`[rotevista-dash] Tile cache avviata: ${tileCacheIndex.size} tile (${(tileCacheTotalBytes / (1024 * 1024)).toFixed(2)} MB)`);
        } catch (err) {
            app.error(`[rotevista-dash] Errore avvio tile cache: ${err.message}`);
        }
    }

    function pruneTileCache() {
        if (!tileCacheDirResolved || !TILE_CACHE_CONFIG.enabled) return;
        const now = Date.now();
        const lowWatermarkBytes = TILE_CACHE_CONFIG.lowWatermarkMb * 1024 * 1024;

        // Fase 1: Cancellazione delle sole tile scadute secondo il rispettivo tier TTL
        for (const [key, entry] of tileCacheIndex.entries()) {
            const ttlMs = getTileTtlMs(entry.zoom);
            if (now - entry.createdAt > ttlMs) {
                try {
                    if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
                } catch (e) {}
                tileCacheTotalBytes -= entry.size;
                tileCacheIndex.delete(key);
            }
        }

        // Fase 2: Se la dimensione totale eccede il Low Watermark, sfronda con politica LRU
        if (tileCacheTotalBytes > lowWatermarkBytes) {
            const entries = Array.from(tileCacheIndex.entries());
            // Ordina prima per zoom decrescente (elimina prima micro-zoom z>=15), poi per LRU (meno recente)
            entries.sort((a, b) => {
                if (b[1].zoom !== a[1].zoom) {
                    return b[1].zoom - a[1].zoom; // Micro zoom rimossi per primi
                }
                return a[1].lastUsed - b[1].lastUsed; // Più vecchi di accesso rimossi per primi
            });

            for (const [key, entry] of entries) {
                if (tileCacheTotalBytes <= lowWatermarkBytes) break;
                try {
                    if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
                } catch (e) {}
                tileCacheTotalBytes -= entry.size;
                tileCacheIndex.delete(key);
            }
        }
    }

    function getUpstreamTileUrl(provider, z, x, y) {
        if (provider === 'esri-dark') {
            return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
        }
        if (provider === 'esri-light') {
            return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
        }
        if (provider === 'openseamap') {
            return `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`;
        }
        return null;
    }

    const TRANSPARENT_1X1_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

    function serveCachedOrFetchTile(provider, zoom, tileX, tileY, res) {
        const fileKey = `${provider}_${zoom}_${tileX}_${tileY}.png`;
        const now = Date.now();
        const entry = tileCacheIndex.get(fileKey);

        if (entry && fs.existsSync(entry.filePath)) {
            const ttlMs = getTileTtlMs(zoom);
            const isFresh = (now - entry.createdAt) <= ttlMs;
            if (isFresh) {
                entry.lastUsed = now;
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                res.setHeader('X-Tile-Cache', 'HIT');
                return fs.createReadStream(entry.filePath).pipe(res);
            }
        }

        // Se non è in cache o è scaduta, proviamo a scaricarla dal server upstream
        const upstreamUrl = getUpstreamTileUrl(provider, zoom, tileX, tileY);
        if (!upstreamUrl) {
            return res.status(404).send('Provider non supportato');
        }

        const clientReq = https.get(upstreamUrl, { timeout: 4500 }, (upRes) => {
            if (upRes.statusCode === 200) {
                const chunks = [];
                upRes.on('data', chunk => chunks.push(chunk));
                upRes.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    res.setHeader('Content-Type', 'image/png');
                    res.setHeader('Cache-Control', 'public, max-age=86400');
                    res.setHeader('X-Tile-Cache', 'MISS');
                    res.end(buffer);

                    if (TILE_CACHE_CONFIG.enabled && tileCacheDirResolved) {
                        const targetPath = path.join(tileCacheDirResolved, fileKey);
                        fs.writeFile(targetPath, buffer, err => {
                            if (!err) {
                                tileCacheIndex.set(fileKey, {
                                    filePath: targetPath,
                                    size: buffer.length,
                                    zoom: zoom,
                                    lastUsed: Date.now(),
                                    createdAt: Date.now()
                                });
                                tileCacheTotalBytes += buffer.length;
                                if (tileCacheTotalBytes > TILE_CACHE_CONFIG.hardCapMb * 1024 * 1024) {
                                    pruneTileCache();
                                }
                            }
                        });
                    }
                });
            } else {
                // Se upstream fallisce ma abbiamo una copia scaduta, usiamo Stale-While-Revalidate
                if (entry && fs.existsSync(entry.filePath)) {
                    entry.lastUsed = now;
                    res.setHeader('Content-Type', 'image/png');
                    res.setHeader('X-Tile-Cache', 'STALE');
                    return fs.createReadStream(entry.filePath).pipe(res);
                }
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('X-Tile-Cache', 'EMPTY');
                res.end(TRANSPARENT_1X1_PNG);
            }
        });

        clientReq.on('timeout', () => {
            clientReq.destroy();
        });

        clientReq.on('error', () => {
            // Se offline in mare aperto, serviamo la copia locale scaduta se disponibile
            if (entry && fs.existsSync(entry.filePath)) {
                entry.lastUsed = now;
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('X-Tile-Cache', 'STALE-OFFLINE');
                return fs.createReadStream(entry.filePath).pipe(res);
            }
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('X-Tile-Cache', 'OFFLINE');
            res.end(TRANSPARENT_1X1_PNG);
        });
    }

    plugin.debug = function(msg) {
        app.debug(msg);
    };

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
            },
            // --- SEZIONE MONITORAGGIO INCROCI ED EMERGENZA AIS ---
            aisAlerter: {
                type: 'object',
                title: 'AIS Collision & Crossing Monitor (ARPA)',
                description: 'Real-time tactical collision avoidance, COLREGs-72 crossing advisor, and smart anchoring guard.',
                properties: {
                    enabled: {
                        type: 'boolean',
                        title: 'Enable AIS Collision Alerter',
                        description: 'Activate real-time ARPA collision calculations, crossing advisor, and dashboard tactical alert banners.',
                        default: true
                    },
                    ignoreOwnTarget: {
                        type: 'string',
                        title: 'Ignore Own AIS Target (MMSI or Callsign)',
                        description: 'Your own vessel MMSI, Callsign, or Name to ignore from incoming AIS targets, preventing self-collision false alarms.',
                        default: '106125'
                    },
                    vectorMinutes: {
                        type: 'number',
                        title: 'Course Vector Length (Minutes)',
                        description: 'Projection time in minutes for own ship and AIS targets course vectors on the tactical map.',
                        default: 15
                    },
                    criticalProximity: {
                        type: 'number',
                        title: 'Emergency Proximity Bubble (Meters)',
                        description: 'Physical proximity bubble (e.g. 45m). Triggers alert if any hull enters this radius. Silenced when anchored/moored.',
                        default: 45
                    },
                    pleasureCraft: {
                        type: 'object',
                        title: 'Pleasure Craft (Sailboats & Yachts)',
                        description: 'Thresholds for pleasure craft (<25m). Halved automatically on parallel courses.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Danger CPA (Meters)',
                                description: 'Critical collision distance. Triggers RED emergency alarm.',
                                default: 300
                            },
                            orangeCpa: {
                                type: 'number',
                                title: 'Warning CPA (Meters)',
                                description: 'Advisory distance. Triggers ORANGE tactical banner and COLREGs crossing calculation.',
                                default: 700
                            },
                            maxTcpa: {
                                type: 'number',
                                title: 'Time Horizon (Minutes)',
                                description: 'Maximum Time-to-CPA window to consider target.',
                                default: 10
                            }
                        }
                    },
                    commercialShips: {
                        type: 'object',
                        title: 'Commercial Ships (Cargo, Tankers, Ferries)',
                        description: 'Thresholds for large vessels. Danger CPA automatically widens with target SOG above 12kn.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Base Danger CPA (Meters)',
                                description: 'Base critical CPA at 12 knots (scales up to 1360m at 32kn).',
                                default: 800
                            },
                            orangeCpa: {
                                type: 'number',
                                title: 'Base Warning CPA (Meters)',
                                description: 'Base advisory distance at 12 knots (scales up to 3150m for fast ferries).',
                                default: 1852
                            },
                            maxTcpa: {
                                type: 'number',
                                title: 'Lookahead Horizon (Minutes)',
                                description: 'Time window for commercial traffic early maneuver warning.',
                                default: 15
                            }
                        }
                    },
                    workboats: {
                        type: 'object',
                        title: 'Fishing & Workboats (Trawlers, Tugs)',
                        description: 'Thresholds for vessels with restricted maneuverability and towed nets/cables.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Danger CPA (Meters)',
                                description: 'Critical clearance for workboats and tugs.',
                                default: 350
                            },
                            orangeCpa: {
                                type: 'number',
                                title: 'Warning CPA (Meters)',
                                description: 'Advisory clearance for workboats and tugs.',
                                default: 750
                            },
                            maxTcpa: {
                                type: 'number',
                                title: 'Lookahead Horizon (Minutes)',
                                description: 'Time window for fishing boats and tugs.',
                                default: 12
                            }
                        }
                    }
                }
            }
        }
    };

    /**
     * plugin.uiSchema: Schema UI per ordinamento dei campi e sezioni collassabili in Signal K Admin.
     */
    plugin.uiSchema = {
        alarms: {
            'ui:field': 'collapsible',
            collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
            }
        },
        graphs: {
            'ui:field': 'collapsible',
            collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
            }
        },
        averaging: {
            'ui:field': 'collapsible',
            collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
            }
        },
        scales: {
            'ui:field': 'collapsible',
            collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
            },
            stw: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            },
            sog: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            },
            tws: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            },
            depth: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            }
        },
        aisAlerter: {
            'ui:field': 'collapsible',
            collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
            },
            'ui:order': ['enabled', 'ignoreOwnTarget', 'vectorMinutes', 'criticalProximity', 'pleasureCraft', 'commercialShips', 'workboats'],
            pleasureCraft: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            },
            commercialShips: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            },
            workboats: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group'
                }
            }
        }
    };
    // ==========================================================================
    // AIS ARPA & COLLISION ENGINE (PORTING SIGNAL K NATequation)
    // ==========================================================================

    const MID_MAP = {
        247: "🇮🇹 ITA", 237: "🇬🇷 GRC", 238: "🇭🇷 CRO", 239: "🇬🇷 GRC", 240: "🇬🇷 GRC", 241: "🇬🇷 GRC",
        278: "🇸🇮 SLO", 262: "🇲🇪 MNE", 201: "🇦🇱 ALB", 271: "🇹🇷 TUR", 209: "🇨🇾 CYP", 210: "🇨🇾 CYP",
        212: "🇨🇾 CYP", 214: "🇲🇩 MDA", 215: "🇲🇹 MLT", 248: "🇲🇹 MLT", 249: "🇲🇹 MLT", 256: "🇲🇹 MLT",
        224: "🇪🇸 ESP", 225: "🇪🇸 ESP", 226: "🇫🇷 FRA", 227: "🇫🇷 FRA", 228: "🇫🇷 FRA", 254: "🇲🇨 MCO",
        255: "🇵🇹 POR", 263: "🇵🇹 POR", 268: "🇸🇲 SMR", 232: "🇬🇧 GBR", 233: "🇬🇧 GBR", 234: "🇬🇧 GBR",
        235: "🇬🇧 GBR", 236: "🇬🇮 GIB", 250: "🇮🇪 IRL", 269: "🇨🇭 SUI", 203: "🇦🇹 AUT", 211: "🇩🇪 DEU",
        218: "🇩🇪 DEU", 205: "🇧🇪 BEL", 244: "🇳🇱 NLD", 245: "🇳🇱 NLD", 246: "🇳🇱 NLD", 257: "🇳🇴 NOR",
        258: "🇳🇴 NOR", 259: "🇳🇴 NOR", 219: "🇩🇰 DNK", 220: "🇩🇰 DNK", 265: "🇸🇪 SWE", 266: "🇸🇪 SWE",
        230: "🇫🇮 FIN", 251: "🇮🇸 ISL", 261: "🇵🇱 POL", 272: "🇺🇦 UKR", 273: "🇷🇺 RUS", 264: "🇷🇴 ROU",
        207: "🇧🇬 BGR", 253: "🇱🇺 LUX", 243: "🇭🇺 HUN", 270: "🇨🇿 CZE", 267: "🇸🇰 SVK", 276: "🇪🇪 EST",
        275: "🇱🇻 LVA", 277: "🇱🇹 LTU", 428: "🇮🇱 ISR", 622: "🇪🇬 EGY", 672: "🇹🇳 TUN", 605: "🇩🇿 DZA",
        642: "🇱🇾 LBY", 242: "🇲🇦 MAR", 450: "🇱🇧 LBN", 468: "🇸🇾 SYR", 319: "🇰🇾 CYM", 308: "🇧🇸 BHS",
        309: "🇧🇸 BHS", 311: "🇧🇸 BHS", 378: "🇻🇬 VGB", 310: "🇧🇲 BMU", 375: "🇻🇨 VCT", 376: "🇻🇨 VCT",
        377: "🇻🇨 VCT", 312: "🇧🇿 BLZ", 304: "🇦🇬 ATG", 305: "🇦🇬 ATG", 306: "🇨🇼 CUW", 341: "🇰🇳 KNA",
        325: "🇩🇲 DMA", 330: "🇬🇩 GRD", 351: "🇵🇦 PAN", 352: "🇵🇦 PAN", 353: "🇵🇦 PAN", 354: "🇵🇦 PAN",
        355: "🇵🇦 PAN", 356: "🇵🇦 PAN", 357: "🇵🇦 PAN", 370: "🇵🇦 PAN", 371: "🇵🇦 PAN", 372: "🇵🇦 PAN",
        373: "🇵🇦 PAN", 636: "🇱🇷 LBR", 538: "🇲🇭 MHL", 518: "🇨🇰 COK", 576: "🇻🇺 VUT", 577: "🇻🇺 VUT",
        664: "🇸🇨 SYC", 316: "🇨🇦 CAN", 338: "🇺🇸 USA", 366: "🇺🇸 USA", 367: "🇺🇸 USA", 368: "🇺🇸 USA",
        369: "🇺🇸 USA", 477: "🇭🇰 HKG", 563: "🇸🇬 SGP", 564: "🇸🇬 SGP", 565: "🇸🇬 SGP", 566: "🇸🇬 SGP",
        503: "🇦🇺 AUS", 512: "🇳🇿 NZL", 431: "🇯🇵 JPN", 432: "🇯🇵 JPN", 440: "🇰🇷 KOR", 441: "🇰🇷 KOR",
        412: "🇨🇳 CHN", 413: "🇨🇳 CHN", 414: "🇨🇳 CHN", 470: "🇦🇪 ARE", 403: "🇸🇦 SAU"
    };

    function getVesselFlag(idStr) {
        if (!idStr) return "";
        let mmsi = String(idStr).split(':').pop();
        if (!mmsi || mmsi.length < 3) return "";
        let mid = parseInt(mmsi.substring(0, 3), 10);
        return MID_MAP[mid] || "";
    }

    function d2r(d) { return d * Math.PI / 180; }
    function r2d(r) { return r * 180 / Math.PI; }

    function distanceMeters(lat1, lon1, lat2, lon2) {
        const latMed = (lat1 + lat2) / 2 * Math.PI / 180;
        const dx = (lon2 - lon1) * 111139 * Math.cos(latMed);
        const dy = (lat2 - lat1) * 111139;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * processAisEngine: Motore ARPA in memoria e calcolo incroci COLREGs a 15s.
     */
    function processAisEngine() {
        try {
        const now = Date.now();
        const raw = windEngine.getRaw();

        // 1. Lettura posizione e cinematica nave propria
        let myGps = null;
        if (raw['navigation.position']) {
            let p = raw['navigation.position'].value || raw['navigation.position'];
            if (p && p.latitude != null && p.longitude != null) {
                myGps = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude) };
            }
        }
        if (!myGps && typeof app.getSelfPath === 'function') {
            let pos = app.getSelfPath('navigation.position');
            if (!pos) pos = app.getSelfPath('navigation.position.value');
            let p = (pos && pos.value) ? pos.value : pos;
            if (p && p.latitude != null && p.longitude != null) {
                myGps = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude) };
            }
        }
        if (!myGps && typeof app.getPath === 'function') {
            let pos = app.getPath('vessels.self.navigation.position');
            let p = (pos && pos.value) ? pos.value : pos;
            if (p && p.latitude != null && p.longitude != null) {
                myGps = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude) };
            }
        }
        if (myGps && !isNaN(myGps.lat) && !isNaN(myGps.lon)) {
            lastOwnGps = { lat: myGps.lat, lon: myGps.lon, t: now };
        } else if (lastOwnGps.lat !== null && lastOwnGps.lon !== null) {
            myGps = { lat: lastOwnGps.lat, lon: lastOwnGps.lon };
        }

        if (!myGps || isNaN(myGps.lat) || isNaN(myGps.lon)) {
            aisDiagnostics = {
                status: 'WAITING_OWN_GPS',
                myGps: null,
                vesselsCount: 0,
                extractionMethod: 'none',
                lastRun: new Date(now).toISOString()
            };
            return; // In attesa di GPS proprio valido
        }
        aisDiagnostics.myGps = { lat: myGps.lat, lon: myGps.lon };

        let mySpeedKn = 0;
        if (raw['navigation.speedOverGround'] !== undefined) {
            mySpeedKn = raw['navigation.speedOverGround'] * 1.94384;
        } else if (typeof app.getSelfPath === 'function') {
            const sog = app.getSelfPath('navigation.speedOverGround');
            const sogVal = (sog && sog.value !== undefined) ? sog.value : sog;
            if (sogVal !== undefined && !isNaN(sogVal)) mySpeedKn = parseFloat(sogVal) * 1.94384;
        }
        const mySpeedMs = mySpeedKn / 1.94384;

        let myHdg = 0;
        if (raw['navigation.headingTrue'] !== undefined) {
            myHdg = (raw['navigation.headingTrue'] * 180 / Math.PI + 360) % 360;
        } else if (raw['navigation.courseOverGroundTrue'] !== undefined) {
            myHdg = (raw['navigation.courseOverGroundTrue'] * 180 / Math.PI + 360) % 360;
        }

        let myCog = myHdg;
        if (raw['navigation.courseOverGroundTrue'] !== undefined) {
            myCog = (raw['navigation.courseOverGroundTrue'] * 180 / Math.PI + 360) % 360;
        }

        let trueWindDir = myHdg;
        if (raw['environment.wind.directionTrue'] !== undefined) {
            trueWindDir = (raw['environment.wind.directionTrue'] * 180 / Math.PI + 360) % 360;
        }

        let relWindAngle = 0;
        if (raw['environment.wind.angleApparent'] !== undefined) {
            relWindAngle = (raw['environment.wind.angleApparent'] * 180 / Math.PI + 360) % 360;
        }
        const isMyStarboardTack = (relWindAngle > 0 && relWindAngle < 180);

        let myDepth = 0;
        if (raw['environment.depth.belowTransducer'] !== undefined) {
            myDepth = raw['environment.depth.belowTransducer'];
        } else if (raw['environment.depth.belowKeel'] !== undefined) {
            myDepth = raw['environment.depth.belowKeel'];
        } else if (raw['environment.depth.belowSurface'] !== undefined) {
            myDepth = raw['environment.depth.belowSurface'];
        } else if (typeof app.getSelfPath === 'function') {
            const dVal = app.getSelfPath('environment.depth.belowTransducer.value');
            if (dVal !== undefined && !isNaN(dVal)) myDepth = parseFloat(dVal);
        }

        // 2. Lettura configurazione attiva con supporto gruppi ad albero e retrocompatibilità
        const cfg = currentConfig.aisAlerter || {};
        const ignoreOwnTarget = String(cfg.ignoreOwnTarget !== undefined ? cfg.ignoreOwnTarget : (cfg.ignoreOwnCallsign || "106125")).trim().toLowerCase();
        const pCraft = cfg.pleasureCraft || {};
        const yachtRedCpa = pCraft.redCpa !== undefined ? pCraft.redCpa : (cfg.yachtRedCpa || 300);
        const yachtOrangeCpa = pCraft.orangeCpa !== undefined ? pCraft.orangeCpa : (cfg.yachtOrangeCpa || 700);
        const yachtMaxTcpa = pCraft.maxTcpa !== undefined ? pCraft.maxTcpa : (cfg.yachtMaxTcpa || 10);
        const cShips = cfg.commercialShips || {};
        const commercialRedCpa = cShips.redCpa !== undefined ? cShips.redCpa : (cfg.commercialRedCpa || 800);
        const commercialOrangeCpa = cShips.orangeCpa !== undefined ? cShips.orangeCpa : (cfg.commercialOrangeCpa || 1852);
        const commercialMaxTcpa = cShips.maxTcpa !== undefined ? cShips.maxTcpa : (cfg.commercialMaxTcpa || 15);
        const wBoats = cfg.workboats || {};
        const workRedCpa = wBoats.redCpa !== undefined ? wBoats.redCpa : (cfg.workRedCpa || 350);
        const workOrangeCpa = wBoats.orangeCpa !== undefined ? wBoats.orangeCpa : Math.round(workRedCpa * 2.15);
        const workMaxTcpa = wBoats.maxTcpa !== undefined ? wBoats.maxTcpa : (cfg.workMaxTcpa || 12);
        collisionPipeline.updateConfig({
            yachtRedCpaMeters: yachtRedCpa,
            yachtOrangeCpaMeters: yachtOrangeCpa,
            yachtHorizonTcpaMin: yachtMaxTcpa,
            commercialRedCpaMeters: commercialRedCpa,
            commercialOrangeCpaMeters: commercialOrangeCpa,
            commercialHorizonTcpaMin: commercialMaxTcpa,
            workRedCpaMeters: workRedCpa,
            workOrangeCpaMeters: workOrangeCpa,
            workHorizonTcpaMin: workMaxTcpa
        });

        const ownShipInput = {
            lat: myGps.lat,
            lon: myGps.lon,
            sog: mySpeedKn,
            cog: myCog,
            hdg: myHdg
        };

        const MAX_DISTANCE_METERS = 37040; // 20 NM

        // 3. Estrazione albero navi da Signal K (in-memory)
        let vesselsData = {};
        let extractionMethod = 'none';

        if (typeof app.getPath === 'function') {
            try {
                vesselsData = app.getPath('vessels') || app.getPath('/vessels') || {};
                if (vesselsData && Object.keys(vesselsData).length > 0) {
                    extractionMethod = 'app.getPath';
                }
            } catch (e) {}
        }
        if (!vesselsData || Object.keys(vesselsData).length === 0) {
            if (app.signalk && app.signalk.root && app.signalk.root.vessels) {
                vesselsData = app.signalk.root.vessels;
                extractionMethod = 'app.signalk.root.vessels';
            } else if (app.signalk && app.signalk.vessels) {
                vesselsData = app.signalk.vessels;
                extractionMethod = 'app.signalk.vessels';
            } else if (app.signalk && typeof app.signalk.retrieve === 'function') {
                try {
                    const skRoot = app.signalk.retrieve();
                    if (skRoot && skRoot.vessels) {
                        vesselsData = skRoot.vessels;
                        extractionMethod = 'app.signalk.retrieve().vessels';
                    }
                } catch (e) {}
            }
        }
        if (vesselsData && vesselsData.value && typeof vesselsData.value === 'object' && !vesselsData.navigation) {
            vesselsData = vesselsData.value;
            extractionMethod += ' (.value unwrap)';
        }

        aisDiagnostics.vesselsCount = vesselsData ? Object.keys(vesselsData).length : 0;
        aisDiagnostics.extractionMethod = extractionMethod;
        aisDiagnostics.lastRun = new Date(now).toISOString();
        aisDiagnostics.status = 'RUNNING';

        const selfId = app.selfId || 'self';

        // 4. Ingestione & Aggiornamento Cache 20 NM
        for (let key in vesselsData) {
            let v = vesselsData[key];
            if (!v) continue;

            let callsign = "";
            if (v.communication) {
                if (v.communication.callsignVhf !== undefined) {
                    callsign = String(v.communication.callsignVhf);
                } else if (v.communication.value && v.communication.value.callsignVhf !== undefined) {
                    callsign = String(v.communication.value.callsignVhf);
                }
            }

            let rawVesselName = (v.name && typeof v.name === 'object' && v.name.value !== undefined) ? v.name.value : v.name;
            let safeVesselName = (typeof rawVesselName === 'string') ? rawVesselName.trim() : "";

            const isOwnVessel = key === "self" || key === selfId ||
                (ignoreOwnTarget !== "" && (
                    callsign.toLowerCase() === ignoreOwnTarget ||
                    key.toLowerCase().includes(ignoreOwnTarget) ||
                    (safeVesselName && safeVesselName.toLowerCase() === ignoreOwnTarget)
                ));

            if (isOwnVessel) {
                delete aisPersistentCache[key];
                continue;
            }

            if (!v.navigation || !v.navigation.position) continue;
            let pos = v.navigation.position.value || v.navigation.position;
            if (!pos || pos.latitude == null || pos.longitude == null) continue;
            let vLat = parseFloat(pos.latitude);
            let vLon = parseFloat(pos.longitude);
            if (isNaN(vLat) || isNaN(vLon)) continue;

            let dist = distanceMeters(myGps.lat, myGps.lon, vLat, vLon);
            if (dist <= MAX_DISTANCE_METERS) {
                let cachedName = (aisPersistentCache[key] && aisPersistentCache[key].name && !aisPersistentCache[key].name.startsWith("MMSI ") && aisPersistentCache[key].name !== "Barca Sconosciuta") ? aisPersistentCache[key].name : "";
                let name = safeVesselName || cachedName;
                if (!name && key.includes("mmsi:")) {
                    let mmsiMatch = key.match(/mmsi:(\d+)/);
                    name = mmsiMatch ? "MMSI " + mmsiMatch[1] : "Barca Sconosciuta";
                } else if (!name) {
                    name = "Barca Sconosciuta";
                }

                let cog = 0;
                let cogNode = (v.navigation.courseOverGroundTrue !== undefined) ? v.navigation.courseOverGroundTrue : v.navigation.headingTrue;
                let cogVal = (cogNode && typeof cogNode === 'object' && cogNode.value !== undefined) ? cogNode.value : cogNode;
                if (cogVal !== undefined && cogVal !== null && !isNaN(cogVal)) {
                    cog = r2d(parseFloat(cogVal));
                }

                let hdg = null;
                let hdgNode = v.navigation.headingTrue;
                let hdgVal = (hdgNode && typeof hdgNode === 'object' && hdgNode.value !== undefined) ? hdgNode.value : hdgNode;
                if (hdgVal !== undefined && hdgVal !== null && !isNaN(hdgVal)) {
                    hdg = r2d(parseFloat(hdgVal));
                }

                let sog = 0;
                let sogNode = v.navigation.speedOverGround;
                let sogVal = (sogNode && typeof sogNode === 'object' && sogNode.value !== undefined) ? sogNode.value : sogNode;
                if (sogVal !== undefined && sogVal !== null && !isNaN(sogVal)) {
                    sog = parseFloat(sogVal) * 1.94384;
                }

                let navStateRaw = "";
                if (v.navigation && v.navigation.state) {
                    let val = v.navigation.state.value !== undefined ? v.navigation.state.value : v.navigation.state;
                    navStateRaw = String(val).toLowerCase();
                }

                let realAisTime = now;
                if (v.navigation.position.timestamp) {
                    let parsedTime = Date.parse(v.navigation.position.timestamp);
                    if (!isNaN(parsedTime)) {
                        realAisTime = Math.abs(now - parsedTime) < 300000 ? parsedTime : now;
                    }
                }

                let trail = aisPersistentCache[key] ? (aisPersistentCache[key].trail || []) : [];
                if (sog < 0.8) {
                    trail = [];
                } else {
                    let lastPt = trail[trail.length - 1];
                    let moved = !lastPt || (distanceMeters(lastPt.lat, lastPt.lon, vLat, vLon) > 10.0 && (realAisTime - (lastPt.t || 0) >= 25000));
                    if (moved) {
                        trail.push({ lat: Number(vLat.toFixed(5)), lon: Number(vLon.toFixed(5)), t: realAisTime });
                    }
                    let maxTrailAgeMs = ((currentConfig.vectorMinutes || 15) * 60 * 1000);
                    while (trail.length > 2 && ((now - (trail[0].t || now)) > maxTrailAgeMs || trail.length > 60)) {
                        trail.shift();
                    }
                }

                let shipType = 0;
                if (v.design && v.design.aisShipType) {
                    let val = v.design.aisShipType.value !== undefined ? v.design.aisShipType.value : v.design.aisShipType;
                    shipType = (typeof val === 'object' && val !== null) ? parseInt(val.id || val.code) || 0 : parseInt(val) || 0;
                }
                if (!shipType && v.designatorType) {
                    let val = v.designatorType.value !== undefined ? v.designatorType.value : v.designatorType;
                    shipType = parseInt(typeof val === 'object' ? val.id : val) || 0;
                }
                if (!shipType && name) {
                    let upperName = name.toUpperCase();
                    if (upperName.includes("BULK") || upperName.includes("CARGO") || upperName.includes("CONTAINER")) shipType = 70;
                    else if (upperName.includes("TANKER") || upperName.includes("OIL") || upperName.includes("CHEM")) shipType = 80;
                    else if (upperName.includes("TUG")) shipType = 31;
                    else if (upperName.includes("FERRY") || upperName.includes("EXPRESS")) shipType = 60;
                }

                let length = null;
                if (v.design && v.design.length) {
                    let lVal = v.design.length.value !== undefined ? v.design.length.value : v.design.length;
                    length = (typeof lVal === 'object' && lVal !== null) ? parseFloat(lVal.overall || lVal.value) : parseFloat(lVal);
                }
                let beam = null;
                if (v.design && v.design.beam) {
                    let bVal = v.design.beam.value !== undefined ? v.design.beam.value : v.design.beam;
                    beam = (typeof bVal === 'object' && bVal !== null) ? parseFloat(bVal.value) : parseFloat(bVal);
                }
                let draft = null;
                if (v.design && v.design.draft) {
                    let dVal = v.design.draft.value !== undefined ? v.design.draft.value : v.design.draft;
                    draft = (typeof dVal === 'object' && dVal !== null) ? parseFloat(dVal.current || dVal.maximum || dVal.value) : parseFloat(dVal);
                }

                let destination = "";
                if (v.navigation && v.navigation.destination) {
                    let destVal = v.navigation.destination.commonName ? v.navigation.destination.commonName.value : (v.navigation.destination.value || v.navigation.destination);
                    destination = (typeof destVal === 'string') ? destVal.trim() : "";
                }
                let eta = "";
                if (v.navigation && v.navigation.destination && v.navigation.destination.eta) {
                    let etaVal = v.navigation.destination.eta.value !== undefined ? v.navigation.destination.eta.value : v.navigation.destination.eta;
                    eta = (typeof etaVal === 'string') ? etaVal : "";
                }

                let aisClass = (shipType >= 70 || shipType === 60 || (length && length > 35) || (draft && draft > 3.0)) ? "A" : "B";

                aisPersistentCache[key] = {
                    id: key,
                    name: name,
                    type: shipType || (aisPersistentCache[key] ? aisPersistentCache[key].type : 0),
                    lat: vLat,
                    lon: vLon,
                    cog: Math.round((cog + 360) % 360),
                    sog: parseFloat(sog.toFixed(1)),
                    navStateRaw: navStateRaw || (aisPersistentCache[key] ? aisPersistentCache[key].navStateRaw : ""),
                    callsign: callsign || (aisPersistentCache[key] ? aisPersistentCache[key].callsign : ""),
                    length: length || (aisPersistentCache[key] ? aisPersistentCache[key].length : null),
                    beam: beam || (aisPersistentCache[key] ? aisPersistentCache[key].beam : null),
                    draft: draft || (aisPersistentCache[key] ? aisPersistentCache[key].draft : null),
                    destination: destination || (aisPersistentCache[key] ? aisPersistentCache[key].destination : ""),
                    eta: eta || (aisPersistentCache[key] ? aisPersistentCache[key].eta : ""),
                    aisClass: aisClass,
                    hdg: hdg !== null ? Math.round((hdg + 360) % 360) : (aisPersistentCache[key] ? aisPersistentCache[key].hdg : null),
                    trail: trail,
                    lastSeen: realAisTime,
                    isMoored: aisPersistentCache[key] ? Boolean(aisPersistentCache[key].isMoored) : false
                };
            }
        }

        // 5. Potatura scadenze cache (6 min se in moto, 15 min se fermi)
        for (let key in aisPersistentCache) {
            let v = aisPersistentCache[key];
            let age = now - v.lastSeen;
            if (age < -30000) {
                // Orologio di sistema andato indietro, risincronizza con now
                v.lastSeen = now;
                age = 0;
            }
            let maxAgeAllowed = (v.sog >= 0.8) ? 360000 : 900000;
            if (age > maxAgeAllowed) {
                delete aisPersistentCache[key];
            }
        }

        // 6. Elaborazione ARPA, Kinematica & COLREGs
        let nearbyVessels = [];

        for (let key in aisPersistentCache) {
            let v = aisPersistentCache[key];
            if (key === "self" || key === selfId || (ignoreOwnTarget !== "" && (
                (v.callsign && v.callsign.toLowerCase() === ignoreOwnTarget) ||
                key.toLowerCase().includes(ignoreOwnTarget) ||
                (v.name && v.name.toLowerCase() === ignoreOwnTarget)
            ))) {
                delete aisPersistentCache[key];
                continue;
            }
            let currentDist = distanceMeters(myGps.lat, myGps.lon, v.lat, v.lon);
            if (currentDist > MAX_DISTANCE_METERS) continue;

            let age = now - v.lastSeen;
            let isEstimated = false;
            let outLat = v.lat;
            let outLon = v.lon;

            // Dead-reckoning se stale > 45s e SOG >= 1.5 kn
            if (age > 45000 && v.sog >= 1.5) {
                let t_hours = age / 3600000;
                let distProj = (v.sog * 1852) * t_hours;
                outLat = v.lat + (distProj * Math.cos(d2r(v.cog))) / 111139;
                outLon = v.lon + (distProj * Math.sin(d2r(v.cog))) / (111139 * Math.cos(d2r(v.lat)));
                isEstimated = true;
            }

            let navState = v.navStateRaw || "";
            let isExplicitMoored = navState.includes("moored") || navState === "5";
            let isMoored = isExplicitMoored || (Boolean(v.isMoored) && v.sog < 0.8);
            let isAnchored = false;
            let anchorState = isMoored ? 'MOORED' : 'UNDERWAY';
            v.isAnchored = false;
            v.isMoored = isMoored;
            let tCode = parseInt(v.type) || 0;

            // Valutazione tramite CollisionPipeline (Moduli 1-4)
            let evalRes = collisionPipeline.evaluateTarget(ownShipInput, {
                id: v.id,
                mmsi: v.id,
                name: v.name,
                lat: outLat,
                lon: outLon,
                sog: isMoored ? 0 : v.sog,
                cog: v.cog,
                shipType: tCode,
                lastUpdate: v.lastSeen,
                isClassB: v.aisClass !== "A",
                length: v.length,
                beam: v.beam
            }, now);

            let bearingNow = evalRes ? evalRes.bearingNowDeg : 0;
            let relBearingNow = (bearingNow - myHdg + 360) % 360;
            let cpa = (evalRes && !evalRes.isDiverging) ? evalRes.cpaNominalMeters : null;
            let tcpa = (evalRes && !evalRes.isDiverging && evalRes.tcpaMinutes >= 0) ? evalRes.tcpaMinutes : -1;
            let isDeferred = evalRes ? Boolean(evalRes.isDeferred) : false;
            let trend = evalRes ? evalRes.trend : 'STABLE';
            let risk = (evalRes && evalRes.alertState !== 'NO_DANGER') ? evalRes.alertState : "GREY";
            let riskMsg = (evalRes && evalRes.alertState !== 'NO_DANGER') ? (evalRes.reason || "") : "";
            let crossDir = "";
            let crossOutcome = (evalRes && evalRes.isDiverging) ? "In Allontanamento" : "In Avvicinamento";
            let crossRule = "";

            // Calcolo rilevamento a orologio
            let clockHour = Math.round(relBearingNow / 30) % 12;
            if (clockHour === 0) clockHour = 12;

            let sightAngleTxt = "";
            if (relBearingNow <= 10 || relBearingNow >= 350) sightAngleTxt = "Dritto di Prua";
            else if (relBearingNow >= 80 && relBearingNow <= 100) sightAngleTxt = "Al Traverso di Dritta";
            else if (relBearingNow >= 260 && relBearingNow <= 280) sightAngleTxt = "Al Traverso di Sinistra";
            else if (relBearingNow >= 170 && relBearingNow <= 190) sightAngleTxt = "Dritto di Poppa";
            else if (relBearingNow < 180) sightAngleTxt = `${Math.round(relBearingNow)}° a Dritta`;
            else sightAngleTxt = `${Math.round(360 - relBearingNow)}° a Sinistra`;

            let sightingTxt = `${sightAngleTxt} (ore ${clockHour})`;

            nearbyVessels.push({
                id: v.id,
                name: v.name,
                type: v.type,
                lat: parseFloat(outLat.toFixed(7)),
                lon: parseFloat(outLon.toFixed(7)),
                cog: v.cog,
                sog: v.sog,
                dist: Math.round(currentDist),
                isAnchored: false,
                isMoored: isMoored,
                anchorState: anchorState,
                swingRadius: null,
                anchorCenter: null,
                isMoving: v.sog >= 0.8 && !isMoored,
                risk: risk,
                isDeferred: isDeferred,
                trend: trend,
                riskMsg: riskMsg,
                cpa: cpa,
                tcpa: tcpa,
                crossDir: crossDir,
                crossOutcome: crossOutcome,
                crossRule: crossRule,
                sightingTxt: sightingTxt,
                age: Math.max(0, Math.round(age / 1000)),
                callsign: v.callsign || "",
                length: v.length || null,
                beam: v.beam || null,
                draft: v.draft || null,
                destination: v.destination || "",
                eta: v.eta || "",
                aisClass: v.aisClass || "B",
                flag: getVesselFlag(v.id),
                inCluster: false,
                trail: v.trail || []
            });
        }

        // 7. Auto-Apprendimento Cumulativo Porti (Geometria Permanente + Padding 18m)
        let harborClusters = harborDetector.processHarbors(nearbyVessels, myGps, raw, trueWindDir, now);

        // 8. Ordinamento Bersagli per Pericolosità (Immediati > Differiti, RED > ORANGE > GREY) e Distanza
        collisionPipeline.pruneInactive(now);
        nearbyVessels.sort((a, b) => {
            const riskWeight = { RED: 3, ORANGE: 2, GREY: 1 };
            const wA = riskWeight[a.risk] || 1;
            const wB = riskWeight[b.risk] || 1;
            const nonDefA = (wA > 1 && !a.isDeferred) ? 1 : 0;
            const nonDefB = (wB > 1 && !b.isDeferred) ? 1 : 0;
            if (nonDefA !== nonDefB) return nonDefB - nonDefA;
            if (wA !== wB) return wB - wA;
            if (wA > 1) {
                const cpaA = (a.cpa !== null && a.cpa >= 0) ? a.cpa : a.dist;
                const cpaB = (b.cpa !== null && b.cpa >= 0) ? b.cpa : b.dist;
                const tcpaA = (a.tcpa !== null && a.tcpa > 0) ? a.tcpa : 999;
                const tcpaB = (b.tcpa !== null && b.tcpa > 0) ? b.tcpa : 999;
                return (cpaA + tcpaA * 60) - (cpaB + tcpaB * 60);
            }
            return a.dist - b.dist;
        });

        lastNearbyVessels = nearbyVessels;
        lastHarborClusters = harborClusters;

        // 9. Individuazione del Top Threat per il Banner (esclude gli allarmi differibili)
        const redThreat = nearbyVessels.find(v => v.risk === "RED" && !v.isDeferred);
        const orangeThreat = nearbyVessels.find(v => v.risk === "ORANGE" && !v.isDeferred);
        topThreat = redThreat || orangeThreat || null;

        // 10. Emissione Delta WebSocket verso la Dashboard
        if (typeof app.handleMessage === 'function') {
            app.handleMessage(plugin.id, {
                context: 'vessels.self',
                updates: [
                    {
                        values: [
                            { path: 'environment.ais_targets', value: nearbyVessels },
                            { path: 'environment.ais_top_threat', value: topThreat },
                            { path: 'environment.harbor_clusters', value: harborClusters }
                        ]
                    }
                ]
            });
        }
        aisDiagnostics.lastError = null;
        } catch (err) {
            aisDiagnostics.status = 'ERROR';
            aisDiagnostics.lastError = err && err.message ? err.message : String(err);
            if (typeof app.error === 'function') {
                app.error('processAisEngine error: ' + aisDiagnostics.lastError);
            }
        }
    }

    return plugin;
};
