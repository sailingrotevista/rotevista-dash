# Changes

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
