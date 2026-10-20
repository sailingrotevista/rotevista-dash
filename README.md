# Rotevista Tactical Marine Dashboard & AIS Monitor

A tactical marine dashboard and real-time ARPA AIS monitoring system for sailboats and power vessels. Built with React, TypeScript, Leaflet, and Vite. Designed to run seamlessly as a Progressive Web App (PWA) with Signal K integration on onboard displays (iPads, rugged Android tablets, Victron Cerbo GX / Venus OS, or Raspberry Pi).

## 🚀 Key Features

### 📈 Real-Time & Historical Sparklines
- **Adaptive Scales:** Automatic standard or Hercules zoom mode with snap-to-grid resolution (**double-tap** on any data box graph to toggle).
- **Dynamic Reef & Danger Thresholds:** Visual warnings (Orange 1st Reef, Red 2nd Reef, Purple storm) and customizable depth safety lines with acoustic alerts.
- **Instantaneous Metric Switching:** Tapping metric graphs instantly updates both chart curves and digital readouts without latency (e.g., SOG ↔ VMG, TWS ↔ AWS).

### 🧭 Dual Central Instruments: Analog Gauge & Weather Radar
- **Analog Wind Gauge:** Real-time Apparent Wind Angle (AWA), True Wind Angle (TWA), Apparent Wind Speed (AWS), Leeway angle, and Ground Track vector.
- **Tactical & Gybe Alarms:** Visual and acoustic alarms for deep downwind gybe danger with hysteresis anti-chatter state machine.
- **Historical Weather Radar:** 8-ring historical true wind direction (TWD) and true wind speed (TWS) radar with Open-Meteo future forecast interpolation and live boat heading alignment.

### 📡 Tactical AIS & ARPA Collision Prevention
- **Interactive Marine Chart:** Integrated Leaflet map with custom vessel vector icons, heading vectors, and dynamic distance range rings.
- **Kinematic ARPA Engine:** Continuous CPA (Closest Point of Approach) and TCPA (Time to CPA) calculations with color-coded risk levels (Red Collision Warning, Orange Crossing Threat).
- **COLREGs-72 Decision Logic:** Dynamic evaluation of maritime rules of the road (give-way / stand-on status adapted to Sail vs Motor propulsion modes).
- **Anchor Drag & Port Monitoring:** Automatic anchor drag alarms and harbor vessel clustering for uncluttered harbor views.
- **Top Tactical Alarm Banner:** High-priority ARPA banner with 1-click target inspection and snooze controls.

### 🌙 Night Mode & Tactical Focus Mode
- **Tactical Red Night Mode:** 1-second press on the central hotspot toggles full tactical red night mode to preserve night vision.
- **Fullscreen & Focus Mode:** Tap central hotspot for browser fullscreen; 1-second press on any data box expands that instrument into split-screen focus mode.

---

## 🖐️ User Gestures & Controls Guide

| Action / Gesture | Target / Element | Effect |
| :--- | :--- | :--- |
| **Double Tap** | Any Data Box Graph | Toggles graph zoom mode between **Standard** and **Hercules** adaptive mode |
| **1-Second Long Press** | Any Data Box | Activates **Tactical Focus Mode** (expands instrument into high-visibility split screen) |
| **Single Tap** | SOG Data Box | Toggles metric readout between **SOG** and **VMG** |
| **Single Tap** | TWS Data Box | Toggles metric readout between **TWS** and **AWS** |
| **1-Second Long Press** | TWD Box | Switches central instrument from **Analog Gauge** to **Historical Weather Radar** |
| **Single Tap** | TWD Box (in Radar Mode) | Switches central instrument back to **Analog Gauge** |
| **Single Tap** | Central Hotspot | Toggles browser **Fullscreen Mode** |
| **1-Second Long Press** | Central Hotspot | Toggles **Tactical Red Night Mode** |
| **Two-Finger Horizontal Swipe** | Anywhere on screen | Swipes between **Wind Dashboard** and **AIS Tactical Chart** |
| **Single Tap** | AIS Target / Banner Threat | Inspects threat on chart with smart zoom on CPA collision triangle |
| **Single Tap** | Bottom-Left `$` Button | Opens **Feedback & Support** modal popup |

---

### 🔌 Signal K Native
- **Signal K Stream:** Automatically connects to onboard Signal K WebSockets (`ws://${host}/signalk/v1/stream`).

### 💬 Community, Feedback & Support
- **Beta Feedback Modal:** Direct in-app support modal (via bottom-left `$` button) to contact the developer for bug reports, feature suggestions, or support contributions.

---

## 🛠️ Development
```bash
# Install dependencies
npm install

# Start Vite development server (Port 3000)
npm run dev

# Production build
npm run build
```
---

## 📄 License
Licensed under the MIT License.
