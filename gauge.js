/**
 * ==========================================================================
 * Sailing Dashboard Pro - Central Compass & Wind Gauge Engine
 * ==========================================================================
 * Gestisce l'aggiornamento grafico dei puntatori analogici (AWA, TWA),
 * dello scarroccio (Leeway), della rotta (Track) e dei trend della bussola.
 * file gauge.js
 */

// 1. VARIABILI DI STATO DELLE ROTAZIONI (Estratte da app.js)
let curAwaRot = 0, curTwaRot = 0, curTrackRot = 0, curTwdRoseRot = 0;
let curBoatCompassRot = 0, curWindCompassRot = 0;
let smoothedLeeway = 0;

/**
 * Aggiorna la visualizzazione grafica dello scarroccio (Leeway Slider)
 */
function updateLeewayDisplay(deg) {
    const c = 125, px = 125/20; let w = Math.min(Math.abs(deg)*px, 125);
    ui.leewayMask.setAttribute('x', deg >= 0 ? c : c - w); ui.leewayMask.setAttribute('width', w);
    ui.leewayVal.textContent = `LEEWAY: ${deg.toFixed(1)}°`;
}

/**
 * Genera dinamicamente i ticks sul quadrante della bussola centrale (ex genTicks)
 */
function initCompassTicks() {
    const c = document.getElementById('ticks');
    if (c) {
        c.innerHTML = ""; // Pulisce i tick esistenti prima del disegno
        for (let i = 0; i < 360; i += 10) {
            const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
            const m = i % 30 === 0;
            l.setAttribute("x1", "200"); l.setAttribute("y1", "40"); l.setAttribute("x2", "200"); l.setAttribute("y2", (m ? 60 : 50));
            l.setAttribute("stroke", m ? "#000" : "#bbb"); l.setAttribute("stroke-width", m ? "2" : "1");
            l.setAttribute("transform", `rotate(${i}, 200, 200)`); c.appendChild(l);
        }
    }
}

/**
 * Aggiorna tutti gli elementi analogici della Bussola Centrale e del Mini Compass
 */
function updateCentralGauge(store, ui, now, isNavigating, sogKts, stwKts, rawAws, awsVal) {
    
    // A. Visualizzazione Testuale dell'Apparent Wind (AWS) al centro della bussola
    if (rawAws !== undefined && rawAws !== null && !isNaN(awsVal)) {
        const strVal = awsVal.toFixed(1);
        let awsSvgEl = document.getElementById('aws-val-svg');
        if (awsSvgEl) {
            if (awsSvgEl.textContent !== strVal) {
                awsSvgEl.textContent = strVal;
            }
        }
    }

    // B. Rotazione dei puntatori analogici di AWA (Apparent) e TWA (True) con passaggio di timestamp "now"
    const smAwa = getCircularAverageFromBuffer(store.smoothBuf.awa, 2000, true, now);
    const smTwa = getCircularAverageFromBuffer(store.smoothBuf.twa, 2000, true, now);
    if (smAwa) ui.awa.setAttribute('transform', `rotate(${curAwaRot = getShortestRotation(curAwaRot, radToDeg(smAwa.val))}, 200, 200)`);
    if (smTwa) ui.twa.setAttribute('transform', `rotate(${curTwaRot = getShortestRotation(curTwaRot, radToDeg(smTwa.val))}, 200, 200)`);
    
        // C. Calcolo dello Scarroccio (Leeway) e orientamento del vettore Track
        if (store.raw["navigation.courseOverGroundTrue"] !== undefined && store.raw["navigation.headingTrue"] !== undefined) {
            let driftDeg = radToDeg((store.raw["navigation.courseOverGroundTrue"] - store.raw["navigation.headingTrue"] + Math.PI * 3) % (2 * Math.PI) - Math.PI);
            smoothedLeeway = (sogKts < CONFIG.averaging.minSpeed) ? 0 : (smoothedLeeway * 0.9) + (driftDeg * 0.1);
            curTrackRot = getShortestRotation(curTrackRot, smoothedLeeway);
            ui.track.setAttribute('transform', `rotate(${curTrackRot}, 200, 200)`);
            ui.leewayVal.style.color = (Math.abs(sogKts - stwKts) > 0.5 && Math.abs(smoothedLeeway) > 7) ? "#ff9800" : "";
            updateLeewayDisplay(Math.max(-20, Math.min(20, smoothedLeeway)));
        }

        // D. Orientamento delle icone della barca e del vento nel Mini-Compass (TWD) con passaggio di timestamp "now"
        const smHdgIcons = getCircularAverageFromBuffer(store.smoothBuf.hdg, 2000, false, now);
        const smTwdIcons = getCircularAverageFromBuffer(store.smoothBuf.twd, 2000, false, now);
        if (smHdgIcons && smTwdIcons) {
        curWindCompassRot = getShortestRotation(curWindCompassRot, radToDeg(smTwdIcons.val));
        ui.twdArrow.setAttribute('transform', `rotate(${curWindCompassRot}, 20, 20)`);
        curBoatCompassRot = getShortestRotation(curBoatCompassRot, radToDeg(smHdgIcons.val));
        ui.twdBoat.setAttribute('transform', `rotate(${curBoatCompassRot}, 20, 20)`);
    }
}
