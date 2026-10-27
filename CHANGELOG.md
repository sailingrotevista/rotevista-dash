# Changes

## Unreleased

- Clarify AIS rest diagnostics with fix/time progress, position spread and nonzero excluded-fix counts; simplify prediction descriptions and display moving prediction rates in metres per minute.
- Show STATIONARY instead of speed in alert banners for stationary targets; remove the BETA badge from the live AIS map while preserving dev/simulation indicators.

- Initialize own-ship motion as stationary when the first valid GPS fix arrives before usable SOG. Preserve missing speed, AIS target startup rules and subsequent motion transitions.

- Simplify GPS source selection to freshness (50), accepted-fix reliability (30) and optional declared GNSS quality (20). Use a shared own-speed reference and a 50 m freshness window bounded to 15 seconds–4 minutes; missing speed uses 4 minutes.
- Carry the original fix deadline through DerivedData, Wind, AIS, own-motion tracking, mixed sessions and the GUI; preserve source timestamps and expire during connection loss.
- Add a read-only own GPS debug page with a bounded text log, copy and download; refresh the dev bridge every second.

- Replace the motion tracker with the reviewed two-state model: initial rest up to 0.5 kn, five real fixes over five minutes within a 50 m diameter for stopping, and net displacement across three positions for restarting.
- Use 50/150/300 m restart distances from the detected rest-area context; select own-ship positions across a five-minute history while AIS keeps its latest three reports.
- Preserve missing AIS SOG as null through ingestion, cache and shared frames; display --.- instead of a measured zero and avoid projecting targets without valid speed.
- Share the existing HarborDetector with the tracker and read upstream polygons in dev fallback sessions. Apply the geographic alert matrix in Module 4 and simulation: reduce distance/time limits once to 25% according to own/target area context; use bubble-only evaluation when both vessels are stationary. Preserve observed-entry, acknowledgement and snooze rules.

## 9.6.0-beta.1 — 2026-10-26

- Introduce SignalKReceiver, category-specific GPS normalization and SensorDerivedData as the shared own-position pipeline at 1 Hz. Preserve source timestamps, reject invalid/stale fixes, score available source quality, and use a stable source lock with failover.
- Feed the selected own position to Wind, AIS, motion tracking and dashboard frames. Prevent direct GPS updates and cached AIS fallbacks from overriding it; accept a valid backup with an older source timestamp.
- Evaluate optional same-source GNSS indicators and motion consistency without treating missing quality as zero or regular anchor swing as GPS scatter. Antenna-offset compensation remains deferred.
- Reuse the AIS motion tracker for own-ship rest detection and relaxed collision thresholds after confirmed rest.
- Unify stale AIS appearance across map icons, vectors, trails, selected labels and detail panels; omit unavailable CPA/TCPA from map labels.
- Organize server modules under ais, wind, session, simulation, shared and sensors; document module responsibilities and sensor contracts.
- Add deterministic GPS quality, source-selection and integration simulations. Physical-device validation of the new pipeline is still pending.

## 9.3.0-beta.4 — 2026-10-24

- Calculate nominal CPA as minimum hull clearance, including vessel dimensions and antenna offsets.
- Simplify category alarm limits, speed scaling and a shared prediction window; add bounded warnings from observed trajectory instability.
- Migrate legacy alarm settings once to red distances of 250/800/400 metres and a live base window of 10 minutes. Simulation keeps a 5-minute base window. Later user edits are preserved.
- Track slow departures and stationary jitter, retain compressed trails and project confirmed slow motion.
- Retain lost contacts with active alarms through normal recovery; preserve acknowledgement of contacts lost during snooze.
- Report old position data and motion timestamp inconsistencies without changing nominal risk decisions.
- Share target ordering across the engine and GUI; require 10 seconds of persistent same-colour priority before switching the banner.
- Move snooze into target details during inspection and delay banner snooze by 3 seconds after a target change.
- Improve iPhone viewport, safe-area positioning, target inspection, labels and stale-contact visibility.
- Add a mode menu at `?menu=1`, full simulation and live data combined with clearly labelled local simulated contacts. The base address opens live data directly.
- Translate relative bearings to plain English and hide COLREG guidance from alarm panels.
