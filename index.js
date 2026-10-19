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
    let knownHarbors = {};       // Banchine e porti auto-appresi
    let vesselStatTimes = {};    // Registro durata stazionamento scafi
    let vesselHdgHist = {};      // Storico prua bersagli per rilevamento ormeggio
    let lastOwnGps = { lat: null, lon: null, t: 0 }; // Ultimo punto GPS proprio per cinematica

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
    let lastNativeHeadingTrueTime = 0; // Traccia la presenza di bussola vera nativa
    let lastNativeTwaTime = 0;         // Traccia la presenza di TWA nativo
    
    // Buffer rolling ad alta frequenza (1Hz, ultimi 60s) per cold-start rapido dei valori medi
    let rollingAngles = { hdg: [], cog: [], twa: [], awa: [], twd: [] };
    
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
                redCpa: 500,
                maxTcpa: 12
            },
            criticalProximity: 45
        };
        currentConfig = options || {};
        currentConfig.aisAlerter = Object.assign({}, defaultAisConfig, currentConfig.aisAlerter || {});
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
                    rollingAngles: rollingAngles,
                    windRadarSlots: windRadarSlots,
                    futureForecast: futureForecast,
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
                    topThreat: topThreat
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

        // Avvia il timer del motore cinematico AIS (15s)
        if (aisInterval) {
            clearInterval(aisInterval);
            aisInterval = null;
        }
        if (currentConfig.aisAlerter && currentConfig.aisAlerter.enabled !== false) {
            const intervalMs = (currentConfig.aisAlerter.checkIntervalSec || 15) * 1000;
            aisInterval = setInterval(processAisEngine, intervalMs);
            setTimeout(processAisEngine, 2500); // Primo calcolo a caldo
        }
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
            pushRollingAngle('awa', smoothedVal, now);
        }
        else if (path === 'environment.wind.angleTrueWater') {
            lastNativeTwaTime = now;
            pushRollingAngle('twa', smoothedVal, now);
        }
        else if (path === 'environment.wind.speedTrue') {
            lastNativeTwsTime = now; // Rilevato TWS nativo della centralina!
            manageHistory('tws', smoothedVal * 1.94384);
        }
        else if (path === 'navigation.headingTrue') {
            lastNativeHeadingTrueTime = now; // Rilevata prua vera nativa dalla rete NMEA
            pushRollingAngle('hdg', smoothedVal, now);
        }
        // --- DECODIFICA PRUA MAGNETICA SERVER-SIDE ---
        else if (path === 'navigation.headingMagnetic') {
            const hasNativeTrueHdg = (now - lastNativeHeadingTrueTime < 5000);
            if (!hasNativeTrueHdg) {
                const variation = raw['navigation.magneticVariation'] || 0;
                const trueHdg = (smoothedVal + variation + 2 * Math.PI) % (2 * Math.PI);
                raw['navigation.headingTrue'] = trueHdg;
                pushRollingAngle('hdg', trueHdg, now);
            }
        }
        else if (path === 'environment.wind.directionTrue') {
            lastNativeTwdTime = now; // Rilevato TWD nativo della centralina!
            manageHistory('twd', smoothedVal);
            pushRollingAngle('twd', smoothedVal, now);
        }
        else if (path === 'navigation.courseOverGroundTrue') {
            pushRollingAngle('cog', smoothedVal, now);
            // Se non è installata alcuna bussola fisica sulla rete e la barca è in movimento stabile (> 1.5 nodi),
            // emuliamo l'Heading usando il COG per consentire il calcolo del TWD e della bussola radar.
            const hasCompass = raw['navigation.headingTrue'] !== undefined || raw['navigation.headingMagnetic'] !== undefined;
            const sog = raw['navigation.speedOverGround'] || 0;
            if (!hasCompass && sog > 0.77) { // 0.77 m/s = 1.5 nodi
                raw['navigation.headingTrue'] = smoothedVal;
                pushRollingAngle('hdg', smoothedVal, now);
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

            if (now - lastNativeTwaTime > 5000) {
                pushRollingAngle('twa', twa, now);
            }

            // Calcolo TWD stabile (Prua + TWA)
            if (hdg !== undefined && (now - lastNativeTwdTime > 5000)) {
                const twd = (hdg + twa + 2 * Math.PI) % (2 * Math.PI);
                manageHistory('twd', twd);
                pushRollingAngle('twd', twd, now);
            }
        }
    }
    
    /**
     * pushRollingAngle: Mantiene un buffer rolling 1Hz degli ultimi 60 secondi
     * per gli angoli di navigazione (HDG, COG, TWA, AWA).
     * Garantisce inserimento O(1) e potatura deterministica (max 65 campioni).
     */
    function pushRollingAngle(type, val, time) {
        if (val === undefined || val === null || !isFinite(val)) return;
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
                    pleasureCraft: {
                        type: 'object',
                        title: 'Pleasure Craft (Sailboats & Yachts)',
                        description: 'Collision thresholds for pleasure craft (<25m).',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Pleasure Craft Danger CPA (Meters)',
                                description: 'Critical collision distance for sailboats and yachts (<25m). Triggers RED emergency alarm. Automatically halved (50%) on parallel courses (|COG diff| <= 20°) to avoid false alarms when sailing in company.',
                                default: 300
                            },
                            orangeCpa: {
                                type: 'number',
                                title: 'Pleasure Craft Warning CPA (Meters)',
                                description: 'Advisory distance for pleasure craft. Triggers ORANGE tactical banner and COLREGs crossing evaluation. Automatically halved on parallel courses.',
                                default: 700
                            },
                            maxTcpa: {
                                type: 'number',
                                title: 'Pleasure Craft Time Horizon (Minutes)',
                                description: 'Maximum Time-to-CPA window. Targets with TCPA beyond this limit are considered non-threatening.',
                                default: 10
                            }
                        }
                    },
                    commercialShips: {
                        type: 'object',
                        title: 'Commercial Ships (Cargo, Tankers, Ferries)',
                        description: 'Collision thresholds for large commercial vessels.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Commercial Ships Base Danger CPA (Meters)',
                                description: 'Base critical CPA for Cargo, Tankers, Ferries and High-Speed Craft at or below 12 knots. Automatically widens by +3.5% per knot above 12kn (e.g. 1024m at 20kn, 1360m at 32kn) to account for blind spots, slow maneuvers, and severe wake.',
                                default: 800
                            },
                            orangeCpa: {
                                type: 'number',
                                title: 'Commercial Ships Base Warning CPA (Meters)',
                                description: 'Base advisory distance for commercial vessels at 12 knots (default 1.0 NM). Automatically expands up to 3150m for high-speed craft and fast ferries based on target SOG.',
                                default: 1852
                            },
                            maxTcpa: {
                                type: 'number',
                                title: 'Commercial Ships Lookahead (Minutes)',
                                description: 'Time window for commercial traffic, allowing early course adjustments before entering their restricted maneuvering zone.',
                                default: 15
                            }
                        }
                    },
                    workboats: {
                        type: 'object',
                        title: 'Fishing & Workboats (Trawlers, Tugs)',
                        description: 'Collision thresholds for vessels with restricted maneuverability and towed gear.',
                        properties: {
                            redCpa: {
                                type: 'number',
                                title: 'Fishing & Workboats Danger CPA (Meters)',
                                description: 'Critical clearance for trawlers, tugboats, and vessels with restricted maneuverability. Protects against submerged tow cables and wide fishing nets. Warning distance is automatically doubled.',
                                default: 500
                            },
                            maxTcpa: {
                                type: 'number',
                                title: 'Fishing & Workboats Lookahead (Minutes)',
                                description: 'Time window for fishing boats and tugs. Accounts for their slow maneuverability and towed gear.',
                                default: 12
                            }
                        }
                    },
                    criticalProximity: {
                        type: 'number',
                        title: 'Emergency Proximity Bubble (Meters)',
                        description: 'Universal physical proximity bubble. Triggers an alert if any hull enters this radius. Automatically silenced in harbors and marinas for stationary moored vessels.',
                        default: 45
                    }
                }
            }
        }
    };

    /**
     * plugin.uiSchema: Organizza l'interfaccia Signal K Admin con sezioni collassabili ad albero.
     * Signal K Server richiede che uiSchema sia una funzione con 'field: ObjectField'.
     */
    const pluginUiSchema = {
        aisAlerter: {
            pleasureCraft: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group',
                    collapsed: true
                }
            },
            commercialShips: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group',
                    collapsed: true
                }
            },
            workboats: {
                'ui:field': 'collapsible',
                collapse: {
                    field: 'ObjectField',
                    wrapClassName: 'panel-group',
                    collapsed: true
                }
            }
        }
    };

    plugin.uiSchema = function () {
        return pluginUiSchema;
    };
    Object.assign(plugin.uiSchema, pluginUiSchema);
        
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

            const req = https.get(url, (res) => {
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
                    });

                    // Timeout di sicurezza a 8 secondi contro cadute di linea 4G/Satellite
                    req.setTimeout(8000, () => {
                        app.error('[Open-Meteo] Request Timeout (8s)');
                        req.abort();
                        lastForecast30mSlot = 0;
                    });

                    req.on('error', (err) => {
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
     */
    
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

        const longWindow = (currentConfig.averaging && currentConfig.averaging.longWindow) ? currentConfig.averaging.longWindow : 30000;
        const maxRollingMs = Math.max(60000, longWindow * 2);

        for (let type in rollingAngles) {
            while (rollingAngles[type].length > 0 && (now - rollingAngles[type][0].time) > maxRollingMs) {
                rollingAngles[type].shift();
            }
        }
    }

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

    function bearingDeg(lat1, lon1, lat2, lon2) {
        const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
                Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function computeConvexHull(points) {
        if (!points || points.length < 3) return points;
        let sorted = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
        let cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        let lower = [];
        for (let i = 0; i < sorted.length; i++) {
            let p = sorted[i];
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        let upper = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
            let p = sorted[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    /**
     * processAisEngine: Motore ARPA in memoria e calcolo incroci COLREGs a 15s.
     */
    function processAisEngine() {
        const now = Date.now();

        // 1. Lettura posizione e cinematica nave propria
        let myGps = null;
        if (raw['navigation.position'] && raw['navigation.position'].latitude != null && raw['navigation.position'].longitude != null) {
            myGps = {
                lat: parseFloat(raw['navigation.position'].latitude),
                lon: parseFloat(raw['navigation.position'].longitude)
            };
        } else if (typeof app.getSelfPath === 'function') {
            const pos = app.getSelfPath('navigation.position.value');
            if (pos && pos.latitude != null && pos.longitude != null) {
                myGps = { lat: parseFloat(pos.latitude), lon: parseFloat(pos.longitude) };
            }
        }

        if (!myGps || isNaN(myGps.lat) || isNaN(myGps.lon)) {
            return; // In attesa di GPS proprio valido
        }

        let mySpeedKn = 0;
        if (raw['navigation.speedOverGround'] !== undefined) {
            mySpeedKn = raw['navigation.speedOverGround'] * 1.94384;
        } else if (typeof app.getSelfPath === 'function') {
            const sog = app.getSelfPath('navigation.speedOverGround.value');
            if (sog !== undefined && !isNaN(sog)) mySpeedKn = sog * 1.94384;
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

        const isOwnShipAtAnchor = mySpeedKn < 0.8;
        const isOwnShipManeuvering = mySpeedKn < 2.5;

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
        const workRedCpa = wBoats.redCpa !== undefined ? wBoats.redCpa : (cfg.workRedCpa || 500);
        const workOrangeCpa = workRedCpa * 2;
        const workMaxTcpa = wBoats.maxTcpa !== undefined ? wBoats.maxTcpa : (cfg.workMaxTcpa || 12);
        const criticalProximity = cfg.criticalProximity || 45;

        const MAX_DISTANCE_METERS = 37040; // 20 NM

        // 3. Estrazione albero navi da Signal K (in-memory)
        let vesselsData = {};
        if (typeof app.getPath === 'function') {
            vesselsData = app.getPath('vessels') || {};
        } else if (app.signalk && app.signalk.root && app.signalk.root.vessels) {
            vesselsData = app.signalk.root.vessels;
        }

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

            const isOwnVessel = key === "self" || key === selfId ||
                (ignoreOwnTarget !== "" && (
                    callsign.toLowerCase() === ignoreOwnTarget ||
                    key.toLowerCase().includes(ignoreOwnTarget) ||
                    (v.name && v.name.toLowerCase() === ignoreOwnTarget)
                ));

            if (isOwnVessel) {
                delete aisPersistentCache[key];
                continue;
            }

            if (!v.navigation || !v.navigation.position || !v.navigation.position.value) continue;
            let pos = v.navigation.position.value;
            let vLat = parseFloat(pos.latitude);
            let vLon = parseFloat(pos.longitude);
            if (isNaN(vLat) || isNaN(vLon)) continue;

            let dist = distanceMeters(myGps.lat, myGps.lon, vLat, vLon);
            if (dist <= MAX_DISTANCE_METERS) {
                let cachedName = (aisPersistentCache[key] && aisPersistentCache[key].name && !aisPersistentCache[key].name.startsWith("MMSI ") && aisPersistentCache[key].name !== "Barca Sconosciuta") ? aisPersistentCache[key].name : "";
                let name = v.name || cachedName;
                if (!name && key.includes("mmsi:")) {
                    let mmsiMatch = key.match(/mmsi:(\d+)/);
                    name = mmsiMatch ? "MMSI " + mmsiMatch[1] : "Barca Sconosciuta";
                } else if (!name) {
                    name = "Barca Sconosciuta";
                }

                let cog = 0;
                if (v.navigation.courseOverGroundTrue && v.navigation.courseOverGroundTrue.value !== undefined) {
                    cog = r2d(parseFloat(v.navigation.courseOverGroundTrue.value));
                } else if (v.navigation.headingTrue && v.navigation.headingTrue.value !== undefined) {
                    cog = r2d(parseFloat(v.navigation.headingTrue.value));
                }

                let sog = 0;
                if (v.navigation.speedOverGround && v.navigation.speedOverGround.value !== undefined) {
                    sog = parseFloat(v.navigation.speedOverGround.value) * 1.94384;
                }

                let navStateRaw = "";
                if (v.navigation && v.navigation.state) {
                    let val = v.navigation.state.value !== undefined ? v.navigation.state.value : v.navigation.state;
                    navStateRaw = String(val).toLowerCase();
                }

                let trail = aisPersistentCache[key] ? (aisPersistentCache[key].trail || []) : [];
                let lastTrailPt = trail[trail.length - 1];
                let shouldAddTrail = !lastTrailPt || distanceMeters(lastTrailPt.lat, lastTrailPt.lon, vLat, vLon) > 5.0 || (now - lastTrailPt.t > 45000);
                if (shouldAddTrail) {
                    trail.push({ lat: vLat, lon: vLon, t: now });
                    if (trail.length > 12) trail.shift();
                }

                let realAisTime = now;
                if (v.navigation.position.timestamp) {
                    let parsedTime = Date.parse(v.navigation.position.timestamp);
                    if (!isNaN(parsedTime)) realAisTime = parsedTime;
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
                    trail: trail,
                    lastSeen: realAisTime,
                    isAnchored: aisPersistentCache[key] ? aisPersistentCache[key].isAnchored : false,
                    anchorCenter: aisPersistentCache[key] ? aisPersistentCache[key].anchorCenter : null
                };
            }
        }

        // 5. Potatura scadenze cache (6 min se in moto, 15 min se fermi)
        for (let key in aisPersistentCache) {
            let v = aisPersistentCache[key];
            let age = now - v.lastSeen;
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
            let isExplicitAnchor = navState.includes("anchor") || isExplicitMoored || navState === "1";

            let isAnchored = false;
            if (v.isAnchored) {
                if (v.sog >= 1.8) {
                    isAnchored = false;
                } else {
                    isAnchored = true;
                }
            } else {
                if (isExplicitAnchor || v.sog < 0.4) {
                    isAnchored = true;
                }
            }
            v.isAnchored = isAnchored;

            let isTargetStationary = (v.sog < 0.8) || isAnchored;
            let tCode = parseInt(v.type) || 0;

            // Selezione soglie dinamiche con moltiplicatore velocità per navi commerciali
            let baseRedCpa = yachtRedCpa;
            let baseOrangeCpa = yachtOrangeCpa;
            let maxTcpaWindow = yachtMaxTcpa;

            const isCommercial = (tCode >= 70 && tCode <= 89) || (tCode >= 40 && tCode <= 49) || (tCode >= 60 && tCode <= 69) || (v.length && v.length >= 40);
            const isWork = (tCode >= 30 && tCode <= 32) || (tCode >= 50 && tCode <= 59);

            if (isCommercial) {
                // Moltiplicatore dinamico di velocità: +3.5% per nodo sopra 12kn (clamp a 1.75x)
                let speedFactor = Math.min(1.75, 1.0 + Math.max(0, v.sog - 12.0) * 0.035);
                baseRedCpa = Math.round(commercialRedCpa * speedFactor);
                baseOrangeCpa = Math.round(commercialOrangeCpa * speedFactor);
                maxTcpaWindow = commercialMaxTcpa;
            } else if (isWork) {
                baseRedCpa = workRedCpa;
                baseOrangeCpa = workOrangeCpa;
                maxTcpaWindow = workMaxTcpa;
            }

            // Calcolo vettoriale cinematico ARPA
            let cpa = null;
            let tcpa = null;
            let crossDir = "";
            let crossOutcome = "";
            let crossRule = "";
            let risk = "GREY";
            let riskMsg = "";

            // Calcolo vettori moto relativo
            let t_v_ms = v.sog * 0.514444;
            let tvx = t_v_ms * Math.sin(d2r(v.cog));
            let tvy = t_v_ms * Math.cos(d2r(v.cog));

            let myvx = mySpeedMs * Math.sin(d2r(myCog));
            let myvy = mySpeedMs * Math.cos(d2r(myCog));

            let vx = tvx - myvx;
            let vy = tvy - myvy;

            let x0 = (outLon - myGps.lon) * 111139 * Math.cos(d2r(myGps.lat));
            let y0 = (outLat - myGps.lat) * 111139;

            let v2 = (vx * vx + vy * vy);
            if (v2 < 0.000001) v2 = 0.000001;

            let t_sec = -(x0 * vx + y0 * vy) / v2;
            let rawCpa = Math.sqrt((x0 + vx * t_sec) * (x0 + vx * t_sec) + (y0 + vy * t_sec) * (y0 + vy * t_sec));

            let bearingNow = (r2d(Math.atan2(x0, y0)) + 360) % 360;
            let relBearingNow = (bearingNow - myHdg + 360) % 360;

            let rawCogDiff = Math.abs(myCog - v.cog) % 360;
            let cogAngularDiff = rawCogDiff > 180 ? 360 - rawCogDiff : rawCogDiff;

            // Dimezzamento (50%) per rotte parallele SOLO per diporto
            let isParallelCourse = (cogAngularDiff <= 20.0 && !isCommercial && !isWork);
            let effectiveRedCpa = isParallelCourse ? Math.round(baseRedCpa * 0.5) : baseRedCpa;
            let effectiveOrangeCpa = isParallelCourse ? Math.round(baseOrangeCpa * 0.5) : baseOrangeCpa;

            if (t_sec < 0) {
                tcpa = -1;
                cpa = null; // Punto di incrocio nel passato
            } else if (rawCpa > (effectiveOrangeCpa * 1.5) || (t_sec / 60.0) > maxTcpaWindow) {
                tcpa = -1;
                cpa = Math.round(rawCpa);
            } else {
                tcpa = t_sec / 60.0;
                cpa = Math.round(rawCpa);
            }

            let isTcpaThreat = (tcpa >= 0 && cpa !== null);

            // Valutazione rischio collisione
            if (isTargetStationary) {
                // Bersaglio fermo: preavviso TCPA solo se navighiamo in crociera (>2.5kn); silenziato in manovra/porto
                if (!isOwnShipManeuvering && isTcpaThreat && cpa < 60 && tcpa <= 3.0) {
                    risk = "RED";
                    riskMsg = "BERSAGLIO FERMO IN ROTTA!";
                } else if (currentDist < criticalProximity) {
                    // Silenziamento selettivo: nessun allarme prossimità su bersagli fermi se siamo all'ancora o in manovra/porto
                    if (!isOwnShipAtAnchor && !isOwnShipManeuvering) {
                        risk = "RED";
                        riskMsg = "PROSSIMITA CRITICA!";
                    }
                }
            } else {
                // Bersaglio in moto: valutazione ARPA
                if (isTcpaThreat && tcpa <= maxTcpaWindow) {
                    if (cpa <= effectiveRedCpa && tcpa <= (maxTcpaWindow * 0.6)) {
                        risk = "RED";
                        riskMsg = "RISCHIO COLLISIONE!";
                    } else if (cpa <= effectiveOrangeCpa) {
                        risk = "ORANGE";
                        riskMsg = "ATTENZIONE INCROCIO";
                    }
                }
            }

            // Analisi COLREGs 72
            let bearingCpa = (r2d(Math.atan2(x0 + vx * t_sec, y0 + vy * t_sec)) + 360) % 360;
            let relBearingCpa = (bearingCpa - myHdg + 360) % 360;
            let passSector = Math.floor(((relBearingCpa + 45) % 360) / 90);
            let passSide = (passSector === 1) ? "Dritta" : (passSector === 3 ? "Sinistra" : (relBearingCpa < 180 ? "Dritta" : "Sinistra"));

            let bearingTargetToMe = (bearingNow + 180) % 360;
            let relBearingTargetToMe = (bearingTargetToMe - v.cog + 360) % 360;
            let crossesBow = (relBearingNow < 180 && relBearingCpa >= 180) || (relBearingNow >= 180 && relBearingCpa < 180);
            let isReciprocalCourse = Math.abs(cogAngularDiff - 180) <= 25.0;

            if (t_sec < 0) {
                crossOutcome = "In Allontanamento";
                crossRule = "";
            } else if (isTargetStationary) {
                crossOutcome = `Ostacolo a ${passSide}`;
                crossRule = "AGGIORNA ROTTA (Bersaglio fermo)";
            } else if (relBearingTargetToMe > 112.5 && relBearingTargetToMe < 247.5 && mySpeedKn > (v.sog + 0.3)) {
                crossOutcome = `Sorpasso a ${passSide}`;
                crossRule = "LASCIA ROTTA LIBERA (Unità che sorpassa)";
            } else if (relBearingNow > 112.5 && relBearingNow < 247.5 && v.sog > (mySpeedKn + 0.3)) {
                crossOutcome = `Ti Sorpassa a ${passSide}`;
                crossRule = "MANTIENI ROTTA (Nave sorpassata)";
            } else if (tCode === 30) {
                crossOutcome = crossesBow ? "Passa a Prua" : `Sfila a ${passSide}`;
                crossRule = "DAI PRECEDENZA (Peschereccio in pesca)";
            } else if (isCommercial) {
                crossOutcome = crossesBow ? "Passa a Prua" : `Sfila a ${passSide}`;
                crossRule = "ATTENZIONE NAVE COMMERCIALE (Canale / Pescaggio)";
            } else if (tCode === 36) {
                crossOutcome = crossesBow ? "Passa a Prua" : `Sfila a ${passSide}`;
                crossRule = isMyStarboardTack ? "MANTIENI ROTTA (Mure a Dritta)" : "DAI PRECEDENZA (Mure a Sinistra)";
            } else if (isReciprocalCourse && (relBearingNow >= 350 || relBearingNow <= 10) && cpa < 300) {
                crossOutcome = "Rotta Frontale";
                crossRule = "ACCOSTA A DRITTA";
            } else {
                crossOutcome = crossesBow ? "Passa a Prua" : `Sfila a ${passSide}`;
                if (relBearingNow > 0 && relBearingNow <= 112.5) {
                    crossRule = "DAI PRECEDENZA (Nave da dritta)";
                } else {
                    crossRule = "MANTIENI ROTTA (Monitora)";
                }
            }

            crossDir = crossRule ? `${crossOutcome}\n👉 ${crossRule}` : crossOutcome;

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
                isAnchored: isAnchored,
                isMoving: v.sog >= 0.8 && !isAnchored,
                risk: risk,
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

        // 7. Riconoscimento Cluster Portuali (Monotone Chain Convex Hull)
        let staticCandidates = nearbyVessels.filter(v => (v.sog < 0.8 || v.isAnchored) && v.dist <= 3704);
        let visited = new Set();
        let instantClusters = [];

        for (let i = 0; i < staticCandidates.length; i++) {
            let root = staticCandidates[i];
            if (visited.has(root.id)) continue;
            let queue = [root];
            visited.add(root.id);
            let members = [];
            while (queue.length > 0) {
                let curr = queue.shift();
                members.push(curr);
                for (let j = 0; j < staticCandidates.length; j++) {
                    let n = staticCandidates[j];
                    if (!visited.has(n.id)) {
                        let d = distanceMeters(curr.lat, curr.lon, n.lat, n.lon);
                        if (d <= 50.0) {
                            visited.add(n.id);
                            queue.push(n);
                        }
                    }
                }
            }
            if (members.length >= 3) {
                let sLat = 0, sLon = 0;
                for (let m = 0; m < members.length; m++) { sLat += members[m].lat; sLon += members[m].lon; }
                instantClusters.push({
                    cLat: sLat / members.length,
                    cLon: sLon / members.length,
                    members: members
                });
            }
        }

        let harborClusters = [];
        for (let k = 0; k < instantClusters.length; k++) {
            let cl = instantClusters[k];
            let pts = cl.members.map(m => [m.lat, m.lon]);
            let hull = computeConvexHull(pts);
            cl.members.forEach(m => { m.inCluster = true; });
            harborClusters.push({
                id: `port_${Math.round(cl.cLat * 1000)}_${Math.round(cl.cLon * 1000)}`,
                lat: cl.cLat,
                lon: cl.cLon,
                dist: Math.round(distanceMeters(myGps.lat, myGps.lon, cl.cLat, cl.cLon)),
                count: cl.members.length,
                hull: hull
            });
        }

        // 8. Ordinamento Bersagli per Pericolosità (RED > ORANGE > GREY) e Distanza
        nearbyVessels.sort((a, b) => {
            const riskWeight = { RED: 3, ORANGE: 2, GREY: 1 };
            const wA = riskWeight[a.risk] || 1;
            const wB = riskWeight[b.risk] || 1;
            if (wA !== wB) return wB - wA;
            const dA = (a.cpa !== null && a.cpa >= 0) ? a.cpa : a.dist;
            const dB = (b.cpa !== null && b.cpa >= 0) ? b.cpa : b.dist;
            return dA - dB;
        });

        lastNearbyVessels = nearbyVessels;
        lastHarborClusters = harborClusters;

        // 9. Individuazione del Top Threat per il Banner della Dashboard
        const redThreat = nearbyVessels.find(v => v.risk === "RED");
        const orangeThreat = nearbyVessels.find(v => v.risk === "ORANGE");
        topThreat = redThreat || orangeThreat || null;

        // 10. Emissione Delta WebSocket verso la Dashboard
        if (typeof app.handleMessage === 'function') {
            app.handleMessage(plugin.id, {
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
    }

    return plugin;
};
