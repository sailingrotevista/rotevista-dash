/**
 * ==========================================================================
 * Signal K Wind Radar - Vector Core and Compass Rendering Engine (Modular v6.0)
 * ==========================================================================
 * Autore: Sailing Rotevista
 * Libreria grafica pura per il disegno della bussola radar storica (TWD).
 * Condivide le risorse, lo stato e i flussi di dati generati da app.js.
 */

// --- 1. PARAMETRI DI CALCOLO INTERNI ---
const CALM_THRESHOLD_KTS = 1.5;
const PRESSURE_FILTER_RATIO = 0.40;
const ringRadii = [59.0, 67.2, 75.4, 83.6, 91.8, 100.0, 108.2, 116.4];
const ARC_STROKE_WIDTH = 5.0;
const BORDER_STROKE_WIDTH = ARC_STROKE_WIDTH + 2; // 7px

// --- 2. FUNZIONI GEOMETRICHE DI SUPPORTO ---
function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
    const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
    return {
        x: centerX + (radius * Math.cos(angleInRadians)),
        y: centerY + (radius * Math.sin(angleInRadians))
    };
}

function describeArc(centerX, centerY, radius, startAngle, endAngle) {
    const start = polarToCartesian(centerX, centerY, radius, endAngle);
    const end = polarToCartesian(centerX, centerY, radius, startAngle);

    let arcSweep = endAngle - startAngle;
    if (arcSweep < 0) arcSweep += 360;

    const largeArcFlag = arcSweep <= 180 ? "0" : "1";

    return [
        "M", start.x, start.y,
        "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y
    ].join(" ");
}

// Genera dinamicamente le tacche dei gradi bussola per l'SVG del radar
function initRadarTicks() {
    const c = document.getElementById('radar-ticks');
    if (c) {
        c.innerHTML = "";
        for (let i = 0; i < 360; i += 10) {
            const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
            const m = i % 30 === 0;
            l.setAttribute("x1", "200"); l.setAttribute("y1", "40"); l.setAttribute("x2", "200"); l.setAttribute("y2", (m ? 60 : 50));
            l.setAttribute("stroke", m ? "#000" : "#bbb"); l.setAttribute("stroke-width", m ? "2" : "1");
            l.setAttribute("transform", `rotate(${i}, 200, 200)`);
            c.appendChild(l);
        }
    }
}

// --- 3. MOTORE DI CALCOLO DELL'ANELLO 1 (Presente Mobile) ---
function calculateActive30mRing() {
    const now = Date.now();
    const start30m = now - 1800000;

    const twdRecent = (store.twdMinuteBuffer || []).filter(p => p.time >= start30m);
    const twsRecent = (store.twsMinuteBuffer || []).filter(p => p.time >= start30m);

    if (twdRecent.length === 0) return null;

    const twsVals = twsRecent.map(p => p.val).filter(v => isFinite(v));
    const maxTws = twsVals.length > 0 ? Math.max(...twsVals) : 0;
    const minTws = twsVals.length > 0 ? Math.min(...twsVals) : 0;

    if (maxTws < CALM_THRESHOLD_KTS) {
        return { twsPeak: maxTws, twsMin: minTws, twdMin: 0, twdMax: 360, isCalm: true };
    }

    let allAngles = [];
    twdRecent.forEach(p => {
        allAngles.push(p.val);
        allAngles.push(p.min);
        allAngles.push(p.max);
    });

    let sumSin = 0; let sumCos = 0;
    allAngles.forEach(a => { sumSin += Math.sin(a); sumCos += Math.cos(a); });
    const avgAngle = Math.atan2(sumSin, sumCos);
    const finalAvg = (avgAngle + Math.PI * 2) % (Math.PI * 2);

    let diffs = allAngles.map(a => {
        let diff = a - finalAvg;
        return Math.atan2(Math.sin(diff), Math.cos(diff));
    });

    diffs.sort((a, b) => a - b);
    const trimCount = Math.floor(diffs.length * 0.05);
    const activeDiffs = diffs.slice(trimCount, diffs.length - trimCount);
    const finalDiffs = activeDiffs.length > 0 ? activeDiffs : diffs;

    const minDiff = Math.min(...finalDiffs);
    const maxDiff = Math.max(...finalDiffs);

    const finalMinDeg = Math.round(radToDeg((finalAvg + minDiff + Math.PI * 2) % (Math.PI * 2)));
    const finalMaxDeg = Math.round(radToDeg((finalAvg + maxDiff + Math.PI * 2) % (Math.PI * 2)));

    return {
        twdMin: finalMinDeg,
        twdMax: finalMaxDeg,
        twsPeak: maxTws,
        twsMin: minTws,
        isCalm: false
    };
}

// --- 4. MOTORE GRAFICO DI DISEGNO DEL RADAR ---
function renderRadar() {
    const ringsContainer = document.getElementById('radar-rings');
    const defsContainer = document.getElementById('radar-gradients');
    
    if (!ringsContainer || !defsContainer) return; // Protezione se l'SVG del radar non è presente nel DOM

    defsContainer.innerHTML = `
        <clipPath id="radar-boat-clip"><circle cx="200" cy="200" r="50" /></clipPath>
        <filter id="radar-center-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#aaaaaa" flood-opacity="0.5" />
        </filter>
    `;
    ringsContainer.innerHTML = '';

    const oraOrbit = document.getElementById('ora-orbit');
    if (oraOrbit) oraOrbit.setAttribute("r", ringRadii[1]);

    const now = Date.now();
    const current30mSlot = Math.floor(now / 1800000) * 1800000;

    const radarDataList = [];

    // 1. ANELLO 0: Previsione Futura Open-Meteo
    if (store.futureForecast) {
        const twdDeg = Math.round(radToDeg(store.futureForecast.twd));
        radarDataList.push({
            twdMin: (twdDeg - 20 + 360) % 360,
            twdMax: (twdDeg + 20 + 360) % 360,
            twsPeak: store.futureForecast.tws,
            isFuture: true
        });
    } else {
        radarDataList.push(null);
    }

    // 2. ANELLO 1: Presente Mobile (Real-Time Client-Side)
    const activeRing = calculateActive30mRing();
    radarDataList.push(activeRing);

    // 3. ANELLI 2-7: Storico consolidato dal server
    const slots = store.windRadarSlots || [];
    for (let i = 1; i <= 6; i++) {
        const targetTimestamp = current30mSlot - (i * 1800000);
        const matchedSlot = slots.find(s => s.timestamp === targetTimestamp);
        
        if (matchedSlot) {
            radarDataList.push({
                twdMin: Math.round(radToDeg(matchedSlot.twdMin)),
                twdMax: Math.round(radToDeg(matchedSlot.twdMax)),
                twsPeak: matchedSlot.twsPeak,
                twsMin: matchedSlot.twsMin !== undefined ? matchedSlot.twsMin : matchedSlot.twsPeak,
                isCalm: matchedSlot.twsPeak < CALM_THRESHOLD_KTS
            });
        } else {
            radarDataList.push(null);
        }
    }

    // Disegno degli archi
    radarDataList.forEach((data, index) => {
        if (!data) return;

        const radius = ringRadii[index];
        const gradId = `chord-gradient-${index}`;
        const opacityValue = 1;

        if (data.isCalm || data.twsPeak < CALM_THRESHOLD_KTS) {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", "200");
            circle.setAttribute("cy", "200");
            circle.setAttribute("r", radius);
            circle.setAttribute("fill", "none");
            circle.setAttribute("stroke", document.body.classList.contains('night-mode') ? "#440000" : "#b0bec5");
            circle.setAttribute("stroke-width", "1.2");
            circle.setAttribute("stroke-dasharray", "4, 4");
            ringsContainer.appendChild(circle);
            return;
        }

        let strokeColor = '';
        
        const getColorForSpeed = (tws) => {
            const R1 = CONFIG.graphs.reef1 || 15;
            const R2 = CONFIG.graphs.reef2 || 20;
            const R3 = R2 + (R2 - R1);
            if (tws < R1 * 0.4) return '#ffffff';
            if (tws < R1 * 0.75) return '#00C851';
            if (tws < R1) return '#ff9800';
            if (tws < R2) return '#ffaa00';
            if (tws < R2 + (R3 - R2) * 0.5) return '#ff3b30';
            return '#9c27b0';
        };

        const baseTws = data.isFuture && store.futureForecast ? store.futureForecast.tws : (data.twsMin !== undefined ? data.twsMin : data.twsPeak);
        const peakTws = data.isFuture && store.futureForecast ? store.futureForecast.gust : data.twsPeak;

        const baseColor = getColorForSpeed(baseTws);
        const peakColor = getColorForSpeed(peakTws);

        if (baseColor !== peakColor) {
            const startPt = polarToCartesian(200, 200, radius, data.twdMax);
            const endPt = polarToCartesian(200, 200, radius, data.twdMin);
            
            const xml = `
                <linearGradient id="${gradId}" x1="${startPt.x.toFixed(1)}" y1="${startPt.y.toFixed(1)}" x2="${endPt.x.toFixed(1)}" y2="${endPt.y.toFixed(1)}" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stop-color="${baseColor}" />
                    <stop offset="50%" stop-color="${peakColor}" />
                    <stop offset="100%" stop-color="${baseColor}" />
                </linearGradient>
            `;
            defsContainer.innerHTML += xml;
            strokeColor = `url(#${gradId})`;
        } else {
            strokeColor = baseColor;
        }

        const pathData = describeArc(200, 200, radius, data.twdMin, data.twdMax);

        if (!data.isFuture) {
            const borderPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
            borderPath.setAttribute("d", pathData);
            borderPath.setAttribute("fill", "none");
            borderPath.setAttribute("stroke", "#000000");
            borderPath.setAttribute("stroke-width", BORDER_STROKE_WIDTH);
            borderPath.setAttribute("stroke-linecap", "round");
            borderPath.setAttribute("opacity", opacityValue);
            ringsContainer.appendChild(borderPath);
        }

        const mainPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        mainPath.setAttribute("d", pathData);
        mainPath.setAttribute("fill", "none");
        mainPath.setAttribute("stroke", strokeColor);
        mainPath.setAttribute("stroke-width", ARC_STROKE_WIDTH);
        mainPath.setAttribute("stroke-linecap", "round");
        mainPath.setAttribute("opacity", data.isFuture ? "0.5" : opacityValue);
        mainPath.id = data.isFuture ? "" : (index === 1 ? "active-present-arc" : "");
        ringsContainer.appendChild(mainPath);
    });

    // Disegno del LED lampeggiante del meteo-trend
    if (activeRing && !activeRing.isCalm) {
        const twdNow = getCircularAverageFromBuffer(store.longBuf.twd, 60000, false);
        const strategicWindowMs = (isNavigating ? 15 : 60) * 60000;
        const twdRef = getCircularAverageFromBuffer(store.longBuf.twd, strategicWindowMs, false);

        if (twdNow && twdRef) {
            let deltaMeteo = radToDeg((twdNow.val - twdRef.val + Math.PI * 3) % (Math.PI * 2) - Math.PI);
            
            if (Math.abs(deltaMeteo) > 6.0) {
                const isSouth = store.raw["navigation.position"] && store.raw["navigation.position"].latitude < 0;
                let meteoColor = (!isSouth) ? (deltaMeteo < 0 ? "#00C851" : "#ff3b30") : (deltaMeteo > 0 ? "#00C851" : "#ff3b30");
                
                const radiusAnello1 = ringRadii[1];
                const angleTarget = deltaMeteo > 0 ? activeRing.twdMax : activeRing.twdMin;
                const pt = polarToCartesian(200, 200, radiusAnello1, angleTarget);

                const led = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                led.setAttribute("cx", pt.x.toFixed(1));
                led.setAttribute("cy", pt.y.toFixed(1));
                led.setAttribute("r", "5.5");
                led.setAttribute("fill", meteoColor);
                led.setAttribute("class", "is-trending");
                led.setAttribute("filter", "url(#radar-center-glow)");
                ringsContainer.appendChild(led);
            }
        }
    }
}
