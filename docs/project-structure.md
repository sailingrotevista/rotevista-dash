# Organizzazione del progetto

Riordino concordato il 26 ottobre 2026. Le cartelle raggruppano le responsabilità esistenti; lo spostamento non introduce nuovi calcoli o nuove istanze dei motori.

## Moduli del plugin

```text
index.js                         ingresso e ciclo di vita del plugin Signal K
sensors/                         acquisizione e selezione GPS propria collegata ai motori
  SignalKReceiver.js
  SensorNormalizer.js            coordinatore
  sensorNormalizer/
    GpsNormalizer.js             selezione e validazione GPS
    gpsQuality.js               qualità dichiarata e osservata
  SensorDerivedData.js
ais/                             movimento, collisioni e aree di sosta
  aisEngine.js
  aisReportedData.js
  collisionPipeline.js
  collisionConfig.js
  targetMotionTracker.js
  targetPredictionStability.js
  ownMotionState.js
  harborDetector.js
  bubbleEntryTracker.js
wind/                            elaborazione e storico del vento
  windEngine.js
  twdHistory.js
session/                         stato condiviso e azioni sugli avvisi
  dashboardSession.js
  aisSharedAlerts.js
simulation/                      scenari e dati di esempio
  dashboardScenario.js
  dashboardMarina.json
shared/                          politiche e strumenti condivisi
  magneticDeclination.js
  windDataPolicy.json
```

- [index.js](../index.js) resta il `main` del pacchetto npm e coordina gli stessi moduli.
- [sensors/](../sensors/) contiene il nuovo ramo GPS parallelo, documentato nelle [specifiche sensori](sensor-pipeline-spec.md). Il riordino non lo collega al percorso operativo.
- [ais/](../ais/) contiene un unico `TargetMotionTracker` nel motore installato, con storici distinti per target e una voce riservata per noi. OwnMotionState traduce lo stato proprio; non replica l’algoritmo. La nostra barca non diventa un membro dei porti.
- [wind/](../wind/) mantiene i calcoli e lo storico attuali; l’eventuale trasferimento dei calcoli a SensorDerivedData è un intervento successivo.
- [session/](../session/) conserva l’autorità del server su modalità, banner, snooze e acknowledge; stato solo in RAM.
- [simulation/](../simulation/) contiene la stessa implementazione degli scenari utilizzata da server e GUI.
- [shared/](../shared/) evita copie dei coefficienti magnetici e della politica delle misure. Il nome storico windDataPolicy.json resta invariato, anche dove il file è usato per validità GPS o navigazione.

## Frontend e strumenti

- `src/components/`, `src/hooks/` e `src/utils/` mantengono la loro struttura. Gli adattatori del frontend importano i moduli condivisi nelle nuove posizioni, senza duplicarne il codice.
- `test/` mantiene la suite comune. `docs/` mantiene le specifiche per comportamento.
- [dashboardDevServer.js](../dashboardDevServer.js), `vite.config.mts` e `index.html` restano in radice come strumenti di avvio del frontend. La separazione dev/Cerbo rimane invariata.
- `public/` resta la destinazione della build; percorsi pubblici, manifest e icone non cambiano.

## Distribuzione e verifiche

[package.json](../package.json) include le sei cartelle dei moduli nel campo `files`, insieme a index.js e alle risorse pubbliche. Non aggiungere copie o moduli ponte in radice per mantenere i vecchi percorsi interni.

Dopo il riordino verificare la suite completa, TypeScript, la build e i file effettivamente inclusi nel pacchetto npm. I test di caricamento dei moduli condivisi con il browser e di isolamento della pipeline sensori devono usare i nuovi percorsi. Verifiche automatiche locali non equivalgono a una prova sul Cerbo.
