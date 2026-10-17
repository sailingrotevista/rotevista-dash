# Sailing Dashboard Pro (React + TypeScript)

A tactical marine dashboard and advanced monitoring system for sailboats, built with React, TypeScript, and Vite. Designed to run seamlessly as a Progressive Web App (PWA) with Signal K integration, optimized for precision rendering on boat tablets (such as iPads and rugged Android tablets) and running on onboard systems (Victron Cerbo GX, Venus OS, or Raspberry Pi).

---

## Core Features

### 📈 Real-Time & Historical Sparklines
- **Adaptive Scales:** Automatic standard or Hercules zoom mode with snap-to-grid resolution.
- **Dynamic Reef & Danger Thresholds:** Visual warnings (Orange 1st Reef, Red 2nd Reef, Purple storm) and customizable depth safety lines with acoustic alerts.
- **Elastic History Gap Handling:** Smooth data rendering without synthetic gaps.

### 🧭 Dual Central Instruments: Analog Gauge & Weather Radar
- **Analog Wind Gauge:** Real-time Apparent Wind Angle (AWA), True Wind Angle (TWA), Apparent Wind Speed (AWS), Leeway angle, and Ground Track vector.
- **Tactical & Gybe Alarms:** Visual and acoustic alarms for deep downwind gybe danger with hysteresis anti-chatter state machine.
- **Historical Weather Radar:** 8-ring historical true wind direction (TWD) and true wind speed (TWS) radar with Open-Meteo future forecast interpolation and live boat heading alignment.
- **Quick Switch:** 1-second hold on the TWD mini-compass switches to the historical radar; click anywhere on the radar to return to the analog gauge.

### 🌙 Night Mode & Tactical Focus Mode
- **Tactical Red Night Mode:** 1-second press on the central hotspot toggles full tactical red night mode to preserve night vision.
- **Fullscreen Mode:** Tap the central hotspot to toggle browser fullscreen.
- **Tactical Focus Mode:** 1-second press on any data box expands that instrument into high-visibility split-screen mode.

### 📡 Signal K & Simulation Engine
- Automatically connects to Signal K WebSocket (`ws://${host}/signalk/v1/stream`) when running aboard.
- Automatically falls back to an integrated dynamic simulation engine when running standalone or in browser previews, keeping all instruments, graphs, and tactical trends active.

---

## Development

```bash
# Install dependencies
npm install

# Start Vite development server (Port 3000)
npm run dev

# Production build
npm run build
```

---

## License

This project is licensed under the MIT License - see the LICENSE file for details.
