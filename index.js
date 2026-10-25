/**
    * ==========================================================================
    * Rotevista Dash Configuration & History Plugin (v9.3.0-beta.4)
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
const { AisEngine } = require('./aisEngine');
const { prepareCollisionConfig, PLUGIN_BASE_TCPA_MINUTES } = require('./collisionConfig');

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
    let sharedAlertInterval = null;
    let aisInterval = null;   // Timer in background per il motore cinematico AIS (15s)
    const collisionPipeline = new CollisionPipeline();
    const harborDetector = new HarborDetector();
    const windEngine = new WindEngine(app, () => currentConfig);
    const aisEngine = new AisEngine(app, () => currentConfig, windEngine, harborDetector, collisionPipeline);

    const { DashboardSession, registerDashboardRoutes } = require('./dashboardSession');
    const readDashboardLive = () => ({raw:windEngine.getRaw(),rawTimes:windEngine.getRawTimes(),targets:aisEngine.getNearbyVessels(),
        harborClusters:aisEngine.getHarborClusters(),config:currentConfig});
    const dashboardSession = new DashboardSession({readLive:readDashboardLive,liveAlerts:aisEngine.sharedAlerts});

    /**
        * plugin.start: Inizializza il plugin.
        * Viene chiamato all'avvio e OGNI VOLTA che si salva nella configurazione.
        */
    plugin.start = function (options) {
        // Reset legacy thresholds once, then preserve subsequent user edits.
        const prepared = prepareCollisionConfig(options || {});
        currentConfig = prepared.config;
        if (prepared.migrated && typeof app.savePluginOptions === 'function') {
            app.savePluginOptions(currentConfig, error => {
                if (error) app.error(`Could not persist AIS threshold migration: ${error.message || error}`);
                else app.debug('AIS thresholds migrated: red 250/800/400 m; base advance warning 10 min');
            });
        }
        aisEngine.refreshOwnGeometry(Date.now(), true);
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
            registerDashboardRoutes((method,path,handlers) => app[method.toLowerCase()](path,...(Array.isArray(handlers)?handlers:[handlers])),dashboardSession);
            app.get('/rotevista-live-input', (_req,res) => {res.header('Cache-Control','no-store');res.json(readDashboardLive());});
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
                    ais_targets: aisEngine.getNearbyVessels(),
                    ais_top_threat: aisEngine.getTopThreat(),
                    ais_shared_alerts: aisEngine.sharedAlerts.snapshot(),
                    harbor_clusters: aisEngine.getHarborClusters()
                };
                res.json(responseData);
            });
            app.get('/rotevista-ais', (req, res) => {
                res.header("Access-Control-Allow-Origin", "*");
                res.json({
                    targets: aisEngine.getNearbyVessels(),
                    harborClusters: aisEngine.getHarborClusters(),
                    topThreat: aisEngine.getTopThreat(),
                    sharedAlerts: aisEngine.sharedAlerts.snapshot(),
                    diagnostics: aisEngine.getDiagnostics()
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
                { path: 'design.length', minPeriod: 1000 },
                { path: 'design.length.overall', minPeriod: 1000 },
                { path: 'design.beam', minPeriod: 1000 },
                { path: 'sensors.gps.fromBow', minPeriod: 1000 },
                { path: 'sensors.gps.fromCenter', minPeriod: 1000 },
                { path: 'navigation.position', minPeriod: 1000 },
                { path: 'navigation.state', minPeriod: 1000 },
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
                                aisEngine.updateWindEvidence(v.path, v.value, update.timestamp);
                                if (!aisEngine.updateOwnGeometry(v.path, v.value)) {
                                    windEngine.processIncomingDelta(v.path, v.value, update.timestamp);
                                }
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
        if (sharedAlertInterval) clearInterval(sharedAlertInterval);
        sharedAlertInterval = setInterval(() => {
            const now = Date.now();
            windEngine.sampleHistory(now);
            dashboardSession.tick(now);
            // Publish the same Live state to legacy clients without evaluating it again.
            aisEngine.publishSharedAlerts(now, false);
        }, 1000);
        aisInterval = setInterval(() => aisEngine.process(), intervalMs);
        setTimeout(() => aisEngine.process(), 1000); // Primo calcolo a caldo entro 1s
        // Inizializza la cache cartografica locale LRU su disco per Cerbo GX
        initTileCache();
    };

    /**
        * plugin.stop: Chiamato quando il plugin viene disattivato.
        */
    plugin.stop = function () {
        if (sharedAlertInterval) clearInterval(sharedAlertInterval);
        sharedAlertInterval = null;
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
                        description: 'Forward course projection and retained AIS trail duration in minutes. The map displays the most recent third of the trail, or the full retained history for the selected target. History is compressed to a maximum of 60 points per target.',
                        default: 15
                    },
                    criticalProximity: {
                        type: 'number',
                        title: 'Safe Proximity Bubble (Meters)',
                        description: 'Current hull clearance for stationary targets in recognized mooring areas. Visual proximity warning only; acknowledge it for the current local harbor context. Moving targets and stationary targets outside recognized areas retain normal CPA/TCPA alarms.',
                        exclusiveMinimum: 0,
                        default: 45
                    },
                    baseTcpaMinutes: {
                        type: 'number',
                        title: 'Base Advance Warning (Minutes)',
                        description: 'Earlier warnings for targets moving faster than your vessel. Minimum own speed for scaling: 4 kn; maximum lookahead: 30 min. Red and orange share the effective time window. Lower risk must persist for one fifth of this base time before the alarm clears or decreases.',
                        exclusiveMinimum: 0,
                        maximum: 30,
                        default: PLUGIN_BASE_TCPA_MINUTES
                    },
                    thresholdPolicyVersion: {
                        type: 'integer',
                        default: 0,
                        description: 'Internal migration version; preserved when saving configuration.'
                    },
                    pleasureCraft: {
                        type: 'object',
                        title: 'Pleasure Craft',
                        description: 'Reference speed: 7.5 kn. Alarm distance scales up above this speed; warning distance is twice the effective alarm distance.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Base AIS Alarm Distance (Meters)',
                                description: 'Minimum predicted hull clearance at the reference speed. Distance never shrinks below this base value.',
                                exclusiveMinimum: 0,
                                default: 250
                            }
                        }
                    },
                    commercialShips: {
                        type: 'object',
                        title: 'Commercial Ships',
                        description: 'Reference speed: 10 kn. Alarm distance scales up above this speed; warning distance is twice the effective alarm distance.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Base AIS Alarm Distance (Meters)',
                                description: 'Minimum predicted hull clearance at the reference speed. Distance never shrinks below this base value.',
                                exclusiveMinimum: 0,
                                default: 800
                            }
                        }
                    },
                    workboats: {
                        type: 'object',
                        title: 'Fishing & Workboats',
                        description: 'Reference speed: 10 kn. Alarm distance scales up above this speed; warning distance is twice the effective alarm distance.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Base AIS Alarm Distance (Meters)',
                                description: 'Minimum predicted hull clearance at the reference speed. Distance never shrinks below this base value.',
                                exclusiveMinimum: 0,
                                default: 400
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
            'ui:order': ['enabled', 'ignoreOwnTarget', 'vectorMinutes', 'criticalProximity', 'baseTcpaMinutes', 'thresholdPolicyVersion', 'pleasureCraft', 'commercialShips', 'workboats'],
            thresholdPolicyVersion: { 'ui:widget': 'hidden' },
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
    return plugin;
};
