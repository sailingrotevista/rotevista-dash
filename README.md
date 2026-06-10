# @sailingrotevista/rotevista-dash

## Sailing Dashboard Pro (v6.0)

A tactical marine dashboard and advanced monitoring system for sailboats, designed to run as a Web App (PWA) fully integrated into the **Signal K** ecosystem. Specifically optimized for precision rendering on boat tablets (such as iPads and Samsung Galaxy Tab Active) and built to run efficiently on low-resource gateways like the **Victron Cerbo GX** (running Venus OS Large) or Raspberry Pi.

---

## Core Features

### 📈 Server-Side RAM-Buffered History
Unlike traditional dashboards that store history in the volatile memory of the client browser (wiping it whenever the screen locks or the browser reloads), this dashboard performs continuous background logging in RAM directly within the Signal K server process. Upon startup, the client instantly loads up to 60 minutes of pre-populated history via a fast JSON API endpoint, ensuring fully drawn, stable charts from the very first second the page is opened.

### 🔋 Extreme Low-Power Architecture (Battery Saver)
Engineered for long-range cruising without overheating your mobile devices or draining the boat's house batteries:
*   **Event-Driven SVG Redraw:** Complex SVG chart elements are not redrawn on a blind timer. Instead, they are redrawn *only* when a new historical data point is appended to the buffer (reducing the browser's active SVG layout and paint cycles by **93%**).
*   **Virtual-DOM Text Protection (`safeSetText`):** Digital text readouts are updated only if their numerical value has actually changed since the previous second, bypassing expensive browser style and layout calculations (*reflow/repaint*).
*   **Zero-Overhead Analog Needles:** Pointers (AWA, TWA, Leeway) snap instantly to their new positions at 1Hz instead of forcing continuous 60fps style interpolations, allowing the tablet's GPU to rest in a low-power idle state.

### 🧭 Weather Compass & True Wind Direction (TWD) Trends
*   **Tactical Trend (Short-term):** Instantly detects lift or header shifts by comparing the 2-second moving average of True Wind Angle (TWA) with the 10-second average.
*   **Strategic Trend (Long-term):** Flashing green (CW) and red (CCW) dots on the TWD mini-compass indicate meteorological wind rotations, comparing the last 1 minute of wind with a stable strategic baseline of **15 minutes** under sail or **60 minutes** at anchor.
*   **Absolute UTC Epoch Snapping:** Time windows on both the server and any connected clients are locked to absolute UTC second boundaries (00, 10, 20, 30, 40, 50). This eliminates phase offsets and ensures identical tactical trends across all devices on the boat.

### 🛡️ Shallow Water Alarms & Geometric Safety Lines
*   Automatically draws high-visibility dashed safety lines across the depth chart background to indicate **Warning (Yellow, e.g. 3.5m)** and **Danger (Red, e.g. 2.5m)** thresholds.
*   **Non-Scaling Vector Effects:** By using `vector-effect="non-scaling-stroke"`, these lines and the active depth curve remain perfectly sharp, thin, and professional regardless of whether the widget is small or zoomed to full screen.
*   **Adaptive 0-Baseline:** In shallow water, the chart minimum is locked to 0 for keel safety; in deep water, the scale floats freely (e.g., 98m to 102m) to reveal the fine contour details of the seabed.

### 🔌 Smart Source Locking (Zero-Config)
An intelligent background algorithm assigns priority scores to active hardware sources on your boat (e.g. Yacht Devices N2K GPS vs a generic USB GPS) and locks onto the highest-quality sensor, switching to a backup only if a signal dropout occurs.

### ⏰ Sleep & Power-Save Watchdog
Detects when the tablet is unlocked or the browser wakes up a tab from *Power Save* mode, automatically closing orphaned WebSockets, reconnecting, and downloading the latest server-logged history in milliseconds to resume fluid, gap-free operation.

### 🎮 Smart Local Development Auto-Detection
The dashboard automatically detects if it is running locally on your Mac/PC via the `file://` protocol or on `localhost`. In this mode, it still connects to your boat's Cerbo GX over Wi-Fi to stream real-time data, but **bypasses the server's configuration, preserving your local `CONFIG` edits** so you can test scales, alarms, and steps instantly.

---

## System Requirements

*   **Server:** Signal K Node Server (v1.20.0 or higher) installed on a Victron Cerbo GX, Raspberry Pi, or onboard PC.
*   **Client:** Any modern PWA-compliant browser supporting ES6 (Safari on iPadOS/iOS, Samsung Internet, Chrome on Android, Chrome/Safari on macOS/Windows).

---

## Signal K Data Requirements

### Required Foundational Paths
To derive, calculate, and display the entire suite of tactical data, the dashboard must receive the following raw paths from your boat's NMEA network:

*   `navigation.speedThroughWater` (STW - Speed through water)
*   `navigation.speedOverGround` (SOG - Speed over ground)
*   `navigation.courseOverGroundTrue` (COG - Course over ground)
*   `navigation.headingTrue` (True Heading - *If missing, the system automatically falls back to Magnetic Heading*)
*   `environment.wind.speedApparent` (AWS - Apparent wind speed)
*   `environment.wind.angleApparent` (AWA - Apparent wind angle)
*   `environment.depth.belowTransducer` (Depth below keel/transducer)
*   `navigation.position` (GPS Latitude and Longitude - used for hemisphere detection and CSV logging)

### Optional / Native Fallback Paths (Surgically Supported)
The dashboard operates on a **"Native First, Fallback Second"** architecture. If any of the following calculated paths are transmitted natively by your boat's instruments, the dashboard will utilize them directly to preserve their calibration. If they are missing, the system silently activates its own local vector formulas:

*   `environment.wind.speedTrue` (**Optional** - Native True Wind Speed in m/s; falls back to local calculation if missing)
*   `environment.wind.directionTrue` (**Optional** - Native True Wind Direction in radians; falls back to local calculation if missing)
*   `navigation.headingMagnetic` (**Optional** - Magnetic Heading; automatically used if True Heading is missing on the network)
*   `navigation.magneticVariation` (**Optional** - Magnetic Variation; used to calibrate the Magnetic Heading fallback to True)

---

## Installation

The dashboard is distributed as a standard Signal K Node Server plugin and Web App.

### Installation via Signal K App Store (Recommended)
1. Access your Signal K admin panel (`http://<boat-ip>:3000`).
2. Navigate to **App Store** -> **Available**.
3. Search for `@sailingrotevista/rotevista-dash` and click **Install**.
4. Go to **Plugins Config**, activate the **Rotevista Dash Configuration** plugin, and configure your boat's safety thresholds (Draft, alarm offsets, and strategic chart timelines).
5. Click **Save**. The Signal K server will restart, apply the configurations, and initiate background history logging in RAM.

### Accessing the Dashboard
Once installed, the dashboard is accessible on your local network by typing into your tablet or computer browser:
```text
http://<boat-ip>:3000/@sailingrotevista/rotevista-dash/
For the best experience in the cockpit, tap your browser's share button and select "Add to Home Screen" to run it as a standalone, distraction-free application.

License
This project is licensed under the MIT License - see the LICENSE file for details.
