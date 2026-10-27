# Rotevista Tactical Marine Dashboard & AIS Monitor

A marine instrument dashboard and AIS encounter monitor for sailboats and power vessels. Connects to an onboard Signal K server and runs in a browser or as a home-screen web app on tablets, phones and onboard displays. The Signal K plugin can run on Victron Cerbo GX / Venus OS or Raspberry Pi.

Built with React, TypeScript, Leaflet and Vite.

## Wind & navigation instruments

- **Analog wind gauge:** Apparent and true wind angles and speeds, heading, ground track and leeway when the required inputs are available.
- **Historical graphs:** STW, SOG/VMG, depth and TWS/AWS, with adaptive scales, sustained-gust filtering, reef thresholds and depth warning lines.
- **Wind reconstruction:** Uses available measurements and defined fallbacks for missing inputs. Expired readings become unavailable rather than remaining frozen or becoming an invented zero.
- **Offline magnetic declination:** Bundled WMM2025 coefficients correct magnetic heading using position and date. No Internet connection is needed for this calculation. The current model covers 2025–2029.
- **Wind averages & trends:** Circular angle averages, relative wind-change indicators and a persistent TWD rotation indication that describes the change observed over the recent period.
- **Gybe warning:** Smoothed wind-angle tracking, a neutral zone around dead downwind and a minimum interval between sounds. Shared **AUTO / SAIL / MOTOR** selection controls the gybe sound: automatic filtering, sailing warning or motor mute.
- **Weather radar:** Historical wind direction and strength with an Open-Meteo forecast when available. Forecast retrieval and online map tiles require a network connection.
- **Tack/gybe course estimates:** Displayed while moving, with valid inputs and sufficiently stable averages. Leeway requires a usable compass; a COG heading fallback does not produce an artificial zero leeway.

## AIS encounters & nearby vessels

- **Interactive chart:** Vessel symbols, motion vectors, range rings and target inspection. Stationary vessels in recognized rest areas appear as dots to reduce clutter.
- **Hull-clearance CPA & TCPA:** Predicts the minimum clearance between hull envelopes and the corresponding time. Uses available vessel dimensions and antenna offsets, with category defaults for missing dimensions. Moving hulls follow COG; stationary hulls use heading or a conservative envelope when heading is unavailable.
- **Configurable collision limits:** Red clearance by vessel category, an orange warning distance twice the red distance, and a shared base prediction window. Limits adapt to target speed; the live default window is 10 minutes and simulation uses 5 minutes. Applied limits are shown in target details.
- **Observed motion & prediction stability:** Tracks real received positions to distinguish rest, possible departure and movement. Observed erratic motion can add an orange warning when the uncertainty enters the warning limits; it does not create an additional red alarm.
- **Progressive port & anchorage detection:** Learns groups of stationary vessels and distinguishes ports, anchorages and provisional areas as observations accumulate. These are inferred AIS rest areas, not chart-certified harbor boundaries.
- **Safe-bubble proximity:** Stationary targets in recognized rest areas use current hull clearance against the configured bubble instead of ordinary future collision alerts. Contacts first discovered already inside the bubble do not generate a new entry warning. Observed entries use hysteresis to reduce jitter-induced notifications.
- **Shared proximity acknowledgement:** One action acknowledges the current nearby presences across connected displays. A newly observed entry can raise another notice. Moving vessels and stationary obstacles outside recognized areas retain collision evaluation.
- **Target trails:** History follows the configured vector duration and is compressed to at most 60 points per target. The chart shows the most recent third normally, or the full available trail for a selected target.
- **Age & lost-contact information:** Older contacts fade on the chart and in the list. Details distinguish received AIS information from observed status and predicted positions. A moving contact lost during an active collision alarm can remain visible through the encounter and alarm recovery.
- **Shared alert banner:** All displays connected to the same server share the selected threat, snoozes and proximity acknowledgements. A switching hold reduces rapid changes between competing threats. Inspect opens local target details; during inspection the snooze or acknowledge command is attached to the inspected target.

AIS alerts are currently visual and silent. COLREG guidance is reserved for a future version.

## Displays & controls

The layout adapts to the visible browser area and device orientation, including mobile browser bars and safe areas. Browser fullscreen support depends on the device; a home-screen web app uses its own display mode.

| Action | Element | Effect |
| :--- | :--- | :--- |
| Double tap | Data-box graph | Toggle Standard / Hercules graph scale |
| Hold for 1 second | Data box | Open instrument focus view |
| Tap | SOG box | Switch SOG / VMG |
| Tap | TWS box | Switch TWS / AWS |
| Hold for 1 second | TWD box | Open historical weather radar |
| Tap in radar mode | TWD box | Return to analog gauge |
| Tap | Central hotspot | Request browser fullscreen |
| Hold for 1 second | Central hotspot | Toggle red night mode |
| Two-finger horizontal swipe | Wind view | Open AIS chart |
| Tap | Wind button on AIS chart | Return to Wind view |
| Tap | AIS target or list item | Select and inspect the target |
| Tap Inspect | Alert banner | Inspect the indicated encounter |
| Tap | Propulsion button | Cycle AUTO → SAIL → MOTOR for all connected displays |
| Tap | Bottom-left `$` button | Open Feedback & Support |

Target inspection, map position, focus and layout debug remain local to each display.

## Shared server state

Dashboards connected to one server share its Live / Simulation / Mixed mode, simulated scenario, banner, propulsion selection and alert acknowledgements. A newly opened display joins the current session.

State is kept **in RAM**. A server restart returns to Live and AUTO and clears snoozes and acknowledgements. Proximity acknowledgements are also cleaned up when contacts move, leave the local context or remain absent long enough. No shared session state is written to disk.

Dashboard controls use a dedicated session capability, separate from Signal K administrative settings. Clients with access to the dashboard can change these shared controls. Cross-origin browser actions are rejected. Failed actions are shown as errors rather than silently applied to one display only.

Update and reload clients together with the server plugin to use newly added controls. After updating server code, restart the plugin or Signal K to load its new endpoints.

## Development & simulation

```bash
npm install
npm run dev -- --host
```

Open the server's base address, for example `http://localhost:3000/`, to join its current mode. Open `http://localhost:3000/?menu=1` for the shared mode menu:

- **Live data:** Real own-ship instruments and AIS contacts.
- **Simulation:** Synthetic own ship, instruments and AIS encounters.
- **Live + simulated targets:** Real own-ship data and real AIS assessments, with additional simulated contacts. Requires a current real own-ship position.

Layout debug is local to the display. Simulation data stays in the dashboard session and is not written to the Signal K navigation data tree.

The development server has an **independent session**. It reads live inputs from the Cerbo using GET requests; its mode changes, propulsion selection, snoozes and acknowledgements affect only displays connected to the dev server. Restart the dev server after changing root Node runtime modules.

For verification and a production build:

```bash
node --test test/*.test.js
npm run lint
npm run build
```

Beta releases use `npm publish --tag beta`; stable production releases use `npm publish --tag latest`.

## Specifications

Implementation details and agreed behavior are documented separately:

- [Project structure and module responsibilities](docs/project-structure.md)

- [Sensor pipeline: source selection, normalization and derived values](docs/sensor-pipeline-spec.md)
- [Wind calculations, validity and history](docs/wind-spec.md)
- [AIS collision evaluation and alerts](docs/ais-spec.md)
- [Target motion tracking](docs/motion-tracker-spec.md)
- [Port and anchorage detection](docs/harbor-spec.md)
- [Shared sessions and controls](docs/shared-session-spec.md)
- [GUI and interaction](docs/gui-spec.md)

## Community, feedback & support

Use the in-app `$` button for bug reports, feature suggestions and support contributions.

## License

MIT.
