/**
 * ==========================================================================
 * Sailing Dashboard Pro - Math, Conversions & Audio Utilities
 * ==========================================================================
 * Raccoglie le funzioni pure di calcolo vettoriale e sintesi sonora.
 */

// --- 1. CONVERSIONI STANDARD ---
const radToDeg = (rad) => rad * (180 / Math.PI);
const degToRad = (deg) => deg * (Math.PI / 180);
const msToKts = (ms) => ms * 1.94384;
const ktsToMs = (kts) => kts / 1.94384;

// Calcola la rotta di rotazione più breve tra due angoli (evita scatti a 360°)
function getShortestRotation(curr, target) {
    let diff = (target - curr) % 360;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    return curr + diff;
}

// Scrive testo in sicurezza evitando reflow inutili nel DOM/SVG
function safeSetText(el, text) {
    if (!el) return;
    const isSVG = el instanceof SVGElement;
    if (isSVG) {
        if (el.textContent !== text) el.textContent = text;
    } else {
        if (el.innerHTML !== text) el.innerHTML = text;
    }
}

// --- 2. MOTORE MATEMATICO: MEDIA CIRCOLARE VETTORIALE ---
function getCircularAverageFromBuffer(bufferArray, windowMs, signed = false, now, stabilityThreshold = 0.95, stabilityBreakout = 15) {
    now = now || Date.now();
    const len = bufferArray.length;
    if (len === 0) return null;

    let sSin = 0, sCos = 0, count = 0;
    let newestTime = 0, oldestTime = 0;

    let pilotSin = 0, pilotCos = 0;
    const pilotSamples = Math.min(len, 15);
    for (let i = len - 1; i >= len - pilotSamples; i--) {
        pilotSin += bufferArray[i].sin;
        pilotCos += bufferArray[i].cos;
    }
    const pilotRad = Math.atan2(pilotSin, pilotCos);
    const limitRad = stabilityBreakout * (Math.PI / 180);

    for (let i = len - 1; i >= 0; i--) {
        const item = bufferArray[i];
        if ((now - item.time) > windowMs) break;

        let diffRad = Math.atan2(Math.sin(item.val - pilotRad), Math.cos(item.val - pilotRad));
        let finalSin, finalCos;

        if (Math.abs(diffRad) > limitRad) {
            const clampedDiff = Math.sign(diffRad) * limitRad;
            const clampedRad = pilotRad + clampedDiff;
            finalSin = Math.sin(clampedRad);
            finalCos = Math.cos(clampedRad);
        } else {
            finalSin = item.sin;
            finalCos = item.cos;
        }

        sSin += finalSin;
        sCos += finalCos;

        if (count === 0) newestTime = item.time;
        oldestTime = item.time;
        count++;
    }

    if (count === 0) return null;

    const R = Math.hypot(sSin, sCos) / count;
    const avgRad = Math.atan2(sSin, sCos);
    const finalVal = signed ? avgRad : (avgRad + Math.PI * 2) % (Math.PI * 2);
    const historyDuration = (count > 2) ? (newestTime - oldestTime) : 0;
    const safeR = Math.max(R, 1e-9);

    return {
        val: finalVal,
        stable: historyDuration > 10000 && R > stabilityThreshold,
        dev: (R < 1) ? Math.round(Math.sqrt(-2 * Math.log(safeR)) * (180 / Math.PI)) : 0,
        samples: count
    };
}

// --- 3. SINTESI AUDIO WEB AUDIO API (ALLARMI ACUSTICI) ---
let audioCtx = null;
let lastAlarmTime = 0;

function playBingBing() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Date.now();
    if (n - lastAlarmTime < 3000) return;
    lastAlarmTime = n;
    
    function b(f, s) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g);
        g.connect(audioCtx.destination);
        o.frequency.value = f;
        g.gain.setValueAtTime(0.1, s);
        g.gain.exponentialRampToValueAtTime(0.01, s + 0.4);
        o.start(s);
        o.stop(s + 0.5);
    }
    b(880, audioCtx.currentTime);
    b(880, audioCtx.currentTime + 0.6);
}

function playGybeAlarm() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Date.now();
    if (n - lastAlarmTime < 2000) return;
    lastAlarmTime = n;
    
    function note(f, s, d) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g);
        g.connect(audioCtx.destination);
        o.type = 'square';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.05, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + d);
        o.start(s);
        o.stop(s + d);
    }
    for (let i = 0; i < 4; i++) {
        note(1800, audioCtx.currentTime + (i * 0.15), 0.1);
        note(1200, audioCtx.currentTime + (i * 0.15) + 0.07, 0.1);
    }
}
