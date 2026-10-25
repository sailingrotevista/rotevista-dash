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
- **Interactive Marine Chart:** Integrated Leaflet map with custom vessel vector icons, heading vectors, and dynamic distance range rings. AIS history follows the configured course-vector duration and is compressed to at most 60 points per target; the map shows the most recent third, or the full retained history when the target is selected for inspection.
- **Kinematic ARPA Engine:** Continuous CPA (Closest Point of Approach) and TCPA (Time to CPA) calculations with color-coded risk levels (Red Collision Warning, Orange Crossing Threat) across map targets, list items, and detail cards.
- **Hull Clearance CPA:** Nominal CPA measures the minimum predicted clearance between rectangular hull envelopes, with TCPA at the same instant (first contact if they intersect). Moving hulls follow COG; stationary hulls use heading, or a conservative square enclosing all antenna-relative orientations when heading is unavailable. Available vessel dimensions and antenna offsets are included; missing values use category defaults.
- **COLREGs-72 Decision Logic:** Dynamic evaluation of maritime rules of the road (give-way / stand-on status adapted to Sail vs Motor propulsion modes).
- **Anchor Drag & Port Monitoring:** Automatic anchor drag alarms and harbor vessel clustering for uncluttered harbor views.
- **Mooring-Area Proximity:** Stationary members of areas already recognized by the harbor detector use current hull clearance against the configured safe bubble (default 45 metres), instead of future CPA/TCPA alarms. The visual orange proximity notice can be acknowledged per vessel without a timer; the vessel stays on the map and crossing the bubble boundary does not rearm it. Acknowledgement belongs to the current browser session and clears when the target starts moving or own ship leaves the detector's current 2 NM local area context. Moving targets anywhere and stationary targets outside recognized areas retain ordinary collision evaluation. AIS alerts remain silent. Area membership follows the progressive rest-area detector described below.
- **Observed Target Motion:** `targetMotionTracker.js` keeps bounded histories of received fixes for moving and stationary targets. It distinguishes stationary, possible departure, and confirmed movement; repeated timestamps and projected positions do not count as observations. Tuning constants are grouped at the top of the module. Stationary histories stay on the server, while the GUI retains its uncluttered dots.
- **Progressive Rest Areas:** `harborDetector.js` now distinguishes `PROVISIONAL`, `PORT` and `ANCHORAGE` areas using stationary tracker observations and actual reported navigation status. Confirmed fixed groups can form and extend ports without requiring a pre-existing inferred moored flag; stationary targets inside a learned polygon inherit membership even when more than 45 metres from individual learned points. Loose observed small-vessel groups can initially form provisional areas and later become anchorages while retaining identity. Different confirmed area types do not merge merely through proximity. Fixed storage groups follow port rules; no land/water chart data is used to certify that vessels are ashore. Initial tuning: fixed links 95 m, port expansion/merge 120 m, small-vessel anchorage links 180 m, learning range 2 NM, base perimeter padding 18 m. Loose/anchorage membership is limited to vessels up to 40 m; large anchored obstacles do not seed or inherit those quiet small-vessel areas. Learned coordinates and remembered member identities are bounded. Tunables are grouped in `HARBOR_DETECTOR_CONFIG`.
- **Observed Rest Pattern:** The same tracker now provides a descriptive rest summary: observed duration, retained sample span/count, occupied-area center/radius, RMS position dispersion and excursion/return count. With at least five real fixes spanning two minutes, a compact cloud can be described as `FIXED`; a wider bounded pattern with repeated returns can be `OSCILLATING`. Otherwise the type remains `UNDETERMINED`. These describe observations, not proof of mooring or anchoring. The center is the occupied-position center, not an estimated physical anchor location. Outlying/pending-departure points cannot enlarge the motion reference. Missing reports do not mature the description, and a gap over six minutes requires fresh evidence. Results are cached per received fix and appear in target details. Harbor classification consumes this summary; movement decisions and alarm thresholds do not directly depend on its descriptive kind.
- **Prediction Stability:** `targetPredictionStability.js` compares consecutive and longer forecasts with received positions, normalizes errors by elapsed time, filters isolated anomalies, and recognizes confirmed changes of course. Observed variable motion can add an orange warning, never a red alarm: its expanding uncertainty envelope must penetrate at least 10% inside the warning distance for at least 15 seconds within the prediction window. The radius used for warnings is capped at 20% of the effective orange distance. Observed instability is retained until target expiry (normally six minutes without a fix for moving targets; active lost-contact alarms retain it until recovery); missing reports alone do not make it stable. A new fix after a long gap restarts the analysis. Stable, insufficient, or maneuver-pending observations do not generate this additional warning.
- **AIS Alarm Settings:** Configure one red clearance per category and a shared base prediction window (plugin default 10 minutes; simulation 5 minutes). Red distances scale by `max(1, target knots / reference knots)`, using references of 7.5 knots for leisure vessels and 10 knots for commercial/work vessels. Orange distance is twice red. Both use `base minutes × (1 + 0.5 × max(0, target knots / max(own knots, 4) − 1))`, capped at 30 minutes. The 4-knot floor affects only warning time, not actual vessel motion. Applied limits appear in the target card. Previous separate orange distances and category time windows are replaced by this policy; on the first start after this migration, red distances reset to 250/800/400 metres and the live base window resets to 10 minutes. A persisted migration version prevents subsequent restarts or saves from resetting user edits. Policy constants are grouped in `COLLISION_THRESHOLD_DEFAULTS` at the top of `collisionPipeline.js`.
- **Top Tactical Alarm Banner:** High-priority ARPA banner with 1-click target inspection and snooze controls. While a target detail popup is open, snooze is available only inside that popup and applies to its target. The banner continues updating and its Inspect action can switch to another threat. Snoozing from the popup closes inspection and restores the banner's snooze control.
- **Target Priority:** The engine, target register and map use one shared comparator: red before orange, then the lowest rounded hull CPA in metres plus TCPA in seconds. Exact ties use CPA, range and a fixed identity order. The banner adds a separate 10-second switching hold: another contact of the same severity must remain top-ranked continuously before replacing the displayed contact. Red overrides orange immediately, and snoozing or clearing the current alarm selects the next contact immediately. Displayed contact metrics continue updating during the hold. This is display hysteresis, separate from alarm recovery.
- **Lost AIS Contacts:** A moving contact that expires while red or orange is retained as `AIS contact lost`, with normal alarm priority. Its last known trajectory continues through the encounter and normal recovery; it is removed when its alarm clears. Contacts without active alarms expire normally. A snooze active at contact loss remains acknowledged even after its timer expires; a fresh received position restores normal evaluation. Snooze acknowledgements belong to the current dashboard session.
- **Motion Data Consistency:** Position, COG and SOG timestamps are retained separately. If either motion timestamp differs from the position timestamp by more than 20% of the target's effective prediction window, the banner and target details show `Motion data out of sync`. Equal timestamps remain consistent even when the whole report is old. Missing timestamps are unknown; this diagnostic does not change motion values or alarm decisions.
- **Own Ship at Anchor:** An explicit anchored `navigation.state` from Signal K applies separate 0.25 factors to effective CPA distances and lookahead, after target-speed scaling and the normal lookahead cap. Low or zero speed alone does not activate this reduction. Without an explicit anchored state, normal limits remain active. The current safe bubble and the recovery delay based on configured base time remain unchanged. The target card identifies the anchored adjustment; tuning factors are grouped in `COLLISION_THRESHOLD_DEFAULTS`. Mixed mode uses live own navigation status for its synthetic contacts as well.
- **Alarm Recovery:** Red and orange escalate immediately. A lower evaluated risk must persist for one fifth of the configured base prediction window (2 minutes with the live 10-minute default; 1 minute in simulation), then the alarm moves directly to the current evaluated level. Changes between lower levels do not restart the timer; a return to the held level cancels recovery. This replaces the former distance deadband and fixed recovery delays. All qualified orange warnings are eligible for the banner; there is no deferred-warning category.

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

The base address (for example `http://localhost:3000/`) joins the current shared dashboard mode. Open `http://localhost:3000/?menu=1` to choose **Live data**, **Simulation**, or **Live + simulated targets** for all devices connected to that server. The optional **Layout debug** checkbox remains local to the current screen. The old `simulate` query parameters no longer select a private client simulator; use the menu.

The server generates one scenario and supplies the same own-ship data, target positions and shared banner to every client through `/rotevista-dashboard`. New clients join the existing scenario without restarting it. Simulation data is clearly marked and stays in dashboard session memory; it is not written to the Signal K navigation data tree. Full simulation uses a synthetic own ship and instruments. Mixed mode retains real own-ship data and real AIS assessments unchanged, adding four centrally evaluated `sim:` contacts with a five-minute simulation base window. It waits for a real own position and removes synthetic contacts when that position becomes stale. Returning to Live removes all synthetic contacts. A server restart resets the mode to Live.

Vite dev/preview has its **own isolated session**, capability and shared alert state. Its backend reads live inputs from the Cerbo using GET requests only, including fallback for an older installed plugin; mode changes, snoozes and acknowledgements are handled locally and never proxied to the Cerbo. Devices connected to the dev server share its mode, while devices connected to Signal K share the installed plugin's separate mode. Restart the dev server after changing the root Node runtime modules.

---

## 📄 License
Licensed under the MIT License.

### Shared AIS alerts

Live dashboards use one in-memory server state for the banner target, the 10-second
priority hold, the 3-second snooze-button delay, proximity acknowledgements and
10-minute collision snoozes. Reconnecting dashboards receive the current state;
inspection and map position remain local. The shared session owns alert controls
in Live, Simulation and Mixed modes; dev controls remain isolated from the Cerbo.

`GET /rotevista-dashboard` carries the authoritative session state and banner;
the older live AIS endpoints remain available. Shared alerts carry a session identifier,
revision and server timing. Alert controls are independent of Signal K admin
settings: any client able to open the dashboard can acknowledge/snooze shared
alerts. The dashboard obtains an in-memory capability from
`GET /rotevista-alert-session` and supplies it in a custom header to
`POST /rotevista-alert-actions`. These endpoints do not grant access to settings.
Browser cross-origin requests are rejected, capability responses are not
CORS-readable or cacheable, and POST payloads must be bounded JSON. This is a
shared dashboard control capability, not per-user authentication: anyone with
network access to the dashboard can use its alert controls. Restrict dashboard
network access accordingly. Failed actions are reported and never silently
replaced by a local-only acknowledgement.

Nothing is written to disk. A restart loses shared acknowledgement/snooze state;
first-discovered contacts already inside the bubble remain visual without a new
entry banner. Acknowledgements are removed after 24 hours without the target,
when it moves, or when own ship leaves the 2 NM context. Lost-contact snooze and
orange-to-red escalation retain the existing collision rules. Update/reload all
clients along with the server plugin to use shared alerts.
