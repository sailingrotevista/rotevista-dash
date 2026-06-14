
/**
 * ==========================================================================
 * Sailing Dashboard Pro - Sparkline Graphics Engine
 * ==========================================================================
 * Gestisce l'adattamento delle scale dei grafici, l'arrotondamento dei limiti
 * (Snap a griglia) e la generazione dinamica delle curve SVG.
 * file charts.js
 */

// --- 1. MOTORE DI CALCOLO DELLE SCALE (Snap a griglia & Protezione Profondità) ---
function calculateScale(type, data, mode) {
    const s = CONFIG.scales[type];
    const currentVal = data[data.length - 1];
    
    if (currentVal === undefined || currentVal === null) {
        return { min: 0, max: s ? s.stdMax : 10 };
    }

    if (!store.herculesScales) store.herculesScales = {};
    if (!store.herculesScales[type]) {
        store.herculesScales[type] = { min: 0, max: s ? s.stdMax : 10 };
    }
    let currentScale = store.herculesScales[type];

    // --- SEZIONE PROFONDITÀ ---
    if (type === 'depth') {
        const shallowThreshold = Math.max(s.stdMax, 10);
        if (store.depthProtectedActive === undefined) store.depthProtectedActive = false;

        const now = Date.now();
        const depthSafetyWindowMs = 120000; // 2 minuti
        
        const recentPoints = store.histories.depth.filter(p => (now - p.time) <= depthSafetyWindowMs);
        const recentVals = recentPoints.map(p => p.val);

        const localMax = recentVals.length > 0 ? Math.max(...recentVals) : currentVal;
        const localMin = recentVals.length > 0 ? Math.min(...recentVals) : currentVal;

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

        if (mode === 'hercules') {
            const roundStep = s.hercSpan;
            let targetMin = 0;
            if (localMin > shallowThreshold) {
                targetMin = Math.max(0, Math.floor(localMin / roundStep) * roundStep);
            }
            let targetMax = Math.ceil(localMax / roundStep) * roundStep;

            if (targetMax - targetMin < 4) {
                targetMax = targetMin + 4;
            }

            if (currentVal < currentScale.min || currentVal > currentScale.max) {
                currentScale.min = Math.min(currentScale.min, targetMin);
                currentScale.max = Math.max(currentScale.max, targetMax);
            } else {
                const allStableInTarget = recentVals.every(val => val >= targetMin && val <= targetMax);
                if (allStableInTarget) {
                    currentScale.min = targetMin;
                    currentScale.max = targetMax;
                }
            }
            return { min: currentScale.min, max: currentScale.max };
        }
    }

    // --- ALTRI GRAFICI (STW, SOG, TWS) ---
    if (mode !== 'hercules') {
        const maxHistorico = Math.max(...data);
        return { min: 0, max: Math.max(s.stdMax, Math.ceil(maxHistorico / s.step) * s.step) };
    }

    if (mode === 'hercules') {
        const roundStep = s.hercSpan;
        const oneThirdCount = Math.max(1, Math.floor(data.length / 3));
        const recentThirdData = data.slice(-oneThirdCount);

        const localMin = Math.min(...recentThirdData);
        const localMax = Math.max(...recentThirdData);

        let targetMin = Math.max(0, Math.floor(localMin / roundStep) * roundStep);
        let targetMax = Math.ceil(localMax / roundStep) * roundStep;

        if (targetMax - targetMin === 0) {
            targetMax = targetMin + roundStep;
        }

        if (currentVal < currentScale.min || currentVal > currentScale.max) {
            currentScale.min = Math.min(currentScale.min, targetMin);
            currentScale.max = Math.max(currentScale.max, targetMax);
        } else {
            const allStableInTarget = recentThirdData.every(val => val >= targetMin && val <= targetMax);
            if (allStableInTarget) {
                currentScale.min = targetMin;
                currentScale.max = targetMax;
            }
        }
        return { min: currentScale.min, max: currentScale.max };
    }
}

// Scrive le etichette delle scale numeriche nei box
function updateScaleLabels(t, min, max) {
    const el = document.getElementById(t + '-scale');
    if (el) el.innerHTML = `<span>${Math.round(max)}</span><span>${Math.round((min+max)/2)}</span><span>${Math.round(min)}</span>`;
}

// Intercetta e instrada il rinfresco dei grafici
function refreshGraph(t) {
    if (t === 'aws') {
        if (displayModeTws !== 'AWS') return;
        t = 'tws';
    }
    if (t === 'vmg') {
        if (displayModeSog !== 'VMG') return;
        t = 'sog';
    }

    const boxType = t;
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

// Genera fisicamente le curve e le aree SVG
function drawGraph(d, id, min, max, isTws, isHercules) {
    const svg = document.getElementById(id);
    if (!svg || d.length < 2) return;

    const w = 200, h = 40;
    const range = max - min || 1;
    const isDepth = (id === 'depth-graph');
    
    const latestPoint = d[d.length - 1];
    const now = latestPoint ? latestPoint.time : Date.now();

    const box = svg.closest('.data-box');
    const isFocused = isFocusActive && box && box.classList.contains('is-focused');

    const visibleMinutes = CONFIG.graphs.historyMinutes * (isNavigating ? 1 : 2);
    const viewportMs = visibleMinutes * 60000;
    const viewportStart = now - viewportMs;

    const visibleData = d.filter(p => p.time >= viewportStart);
    if (visibleData.length < 2) return;

    const colDanger  = "#ff3b30", colWarning = "#ff9800", colTws = "#2c3e50", colAws = "#5c6bc0";
    const colDepth   = "#0088cc", colStw = "#00C851", colSog = "#ffbb33", colVmg = "#00b8d4";

    const getColorProps = (val) => {
    const baseStroke = isFocused ? "4.2" : "1.6";
    const alertStroke = isFocused ? "4.8" : "2.2";
    const warnStroke = isFocused ? "4.4" : "1.8";

    let color = colTws, opacity = "0.15", stroke = baseStroke;
    if (isTws) {
        const baseWind = (displayModeTws === 'AWS') ? colAws : colTws;
        const r1 = CONFIG.graphs.reef1 || 15;
        const r2 = CONFIG.graphs.reef2 || 20;
        const r3 = r2 + (r2 - r1); // Calcolo sintetico del 3° Terzarolo (Storm)

        if (val >= r3) { color = "#9c27b0"; opacity = "0.65"; stroke = alertStroke; } // Viola (Tempesta / 3a Mano)
        else if (val >= r2) { color = colDanger; opacity = "0.55"; stroke = alertStroke; } // Rosso (Pericolo / 2a Mano)
        else if (val >= r1) { color = colWarning; opacity = "0.45"; stroke = warnStroke; } // Arancione (Allerta / 1a Mano)
        else color = baseWind;
    } else if (isDepth) {
        if (val < CONFIG.alarms.depthDanger) { color = colDanger; opacity = "0.55"; stroke = alertStroke; }
        else if (val < CONFIG.alarms.depthWarning) { color = colWarning; opacity = "0.45"; stroke = warnStroke; }
        else color = colDepth;
    } else {
        if (id === 'stw-graph') color = colStw;
        else if (id === 'sog-graph') color = (displayModeSog === 'VMG') ? colVmg : colSog;
    }
    return { color, opacity, stroke };
    };

    let grids = "";
    [0.25, 0.5, 0.75].forEach(p => grids += `<line x1="0" y1="${h-(p*h)}" x2="${w}" y2="${h-(p*h)}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5" vector-effect="non-scaling-stroke" />`);

    const gridInterval = (visibleMinutes <= 15) ? 1 : 5;
    for (let m = gridInterval; m < visibleMinutes; m += gridInterval) {
        const x = w - ((m / visibleMinutes) * w);
        grids += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(0,0,0,0.08)" stroke-width="0.4" vector-effect="non-scaling-stroke" />`;
    }
    
    if (isDepth) {
        const dangerVal = CONFIG.alarms.depthDanger;
        const warningVal = CONFIG.alarms.depthWarning;
        const marginX = 4;
        const alarmStrokeWidth = isFocused ? "4.8" : "1.8";

        if (dangerVal >= min && dangerVal <= max) {
            const p = (dangerVal - min) / range;
            const y = h - (p * h);
            grids += `<line x1="${marginX}" y1="${y}" x2="${w - marginX}" y2="${y}" stroke="rgba(255, 59, 48, 0.95)" stroke-width="${alarmStrokeWidth}" stroke-dasharray="12, 6, 2, 6" vector-effect="non-scaling-stroke" />`;
        }
        if (warningVal >= min && warningVal <= max) {
            const p = (warningVal - min) / range;
            const y = h - (p * h);
            grids += `<line x1="${marginX}" y1="${y}" x2="${w - marginX}" y2="${y}" stroke="rgba(255, 204, 0, 0.95)" stroke-width="${alarmStrokeWidth}" stroke-dasharray="6 , 2, 6, 12" vector-effect="non-scaling-stroke" />`;
        }
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
            lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${props.color}; stroke-width:${props.stroke}; stroke-linecap:round; shape-rendering:geometricPrecision;" vector-effect="non-scaling-stroke" />`;
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
