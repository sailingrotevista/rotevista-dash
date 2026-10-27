# Acquisizione, selezione e derivazione dei sensori

Stato: migrazione della posizione GPS propria collegata il 26 ottobre 2026. SensorDerivedData alimenta WindEngine, quindi AIS, motion tracker e frame condivisi; gli altri sensori mantengono il percorso precedente.

## Confini dei moduli

I tre stadi sono raccolti nella cartella `sensors/`; la logica GPS è in [sensorNormalizer/GpsNormalizer.js](../sensors/sensorNormalizer/GpsNormalizer.js), coordinata da SensorNormalizer; i test restano nella cartella comune `test/`.

```text
Signal K (tutte le sorgenti disponibili, frequenza originale)
  → SignalKReceiver
  → SensorNormalizer
  → snapshot a 1 Hz
  → SensorDerivedData
  → WindEngine (posizione propria) → AIS / motion tracker / frame → GUI
```

- [SignalKReceiver](../sensors/SignalKReceiver.js): adattatore di ingresso. Acquisisce posizione propria e contesto opzionale della stessa sorgente: SOG, COG vero, metodo GNSS, integrità, HDOP e satelliti, alla frequenza originale. Inoltra percorso, valore, identità e metadati della sorgente, timestamp originale e istante di ricezione. Non conserva uno storico, non sceglie sorgenti, non media e non attribuisce “adesso” a un timestamp mancante. Le posizioni degli altri target sono escluse.
- [SensorNormalizer](../sensors/SensorNormalizer.js): conserva lo storico breve per sorgente, valida coordinate e tempi, valuta continuità/cadenza, sceglie una sorgente con lock/failover e produce al massimo uno snapshot ogni secondo. Tutte le scelte sono locali al server e in RAM.
- [SensorDerivedData](../sensors/SensorDerivedData.js): per ora copia lo snapshot GPS senza cambiare valore, validità, sorgente o timestamp. I calcoli e i ripieghi Wind non sono stati trasferiti. Il modulo non invia messaggi Signal K; index trasferisce la sua posizione selezionata allo store Wind.

La connessione di ingresso è in `index.js`; il timer esistente a 1 Hz elabora il ramo parallelo. Gli errori di questo ramo invalidano la posizione operativa, senza interrompere gli altri sensori. Sottoscrizione propria idempotente e rimossa a stop del plugin. Nessun riavvio o modifica alle configurazioni di Signal K per attivare test automatici.

## Contratto in ingresso

```js
{
  path: 'navigation.position',
  value: { latitude, longitude },
  source: 'identità della sorgente',
  sourceInfo: { /* metadati Signal K, se ricevuti */ },
  timestamp: 'timestamp della misura come ricevuto, oppure null',
  receivedAt: 1234567890000
}
```

Preferire `$source`; in sua assenza ricostruire un riferimento da `source.label` e `src` o `talker`, se presenti. Non unire sorgenti sconosciute sotto un identificativo inventato: il Normalizer rifiuta i campioni privi di identità.

L’adattatore chiede `sourcePolicy='all'` tramite il sesto argomento della [subscription manager ufficiale](https://github.com/SignalK/signalk-server/blob/master/src/subscriptionmanager.ts), senza limitare a 1 Hz gli ingressi. Su versioni precedenti del server le priorità a monte possono comunque impedire di ricevere tutte le sorgenti; verificare sull’installazione sulla versione installata.

## Regole GPS — 27 ottobre 2026

Validità fisica, freschezza e selezione restano in GpsNormalizer. SensorDerivedData inoltra lo snapshot senza ricalcolare la politica. L’uscita a 1 Hz non rinnova timestamp, coordinate o identità dell’osservazione.

### Validità del fix

- Coordinate finite, latitudine entro ±90°, longitudine entro ±180°; zero è un valore valido.
- Identità sorgente e timestamp obbligatori, non futuro. Un report già vecchio di almeno 4 minuti all’arrivo non viene acquisito come nuova osservazione utilizzabile.
- Ordinamento separato per sorgente; duplicati e replay non aggiungono osservazioni. Un null allo stesso timestamp revoca il fix e non può essere annullato da un replay.
- Salti della stessa sorgente: tolleranza 25 m più spazio percorribile a 80 kn, per intervalli non oltre 30 secondi. Un salto rifiutato o un reset entra nello storico di affidabilità.
- No GPS, Error o integrità Unsafe recenti della stessa sorgente escludono il candidato. La mancata disponibilità di qualità opzionale non equivale a qualità zero.

### Freschezza e scadenza dinamica

```text
validityMs = min(240000, max(15000, 50 / referenceSpeedMps * 1000))
referenceSpeedMps zero o assente: validityMs = 240000
expiresAt = timestamp originale del fix + validityMs
STALE quando now >= expiresAt
```

La scadenza temporale non è un controllo sulla correttezza delle coordinate. I 50 m sono un riferimento di spostamento possibile, non una certificazione di accuratezza; il minimo di 15 secondi può corrispondere a più di 50 m alle alte velocità.

Si usa la stessa velocità propria prudenziale per tutte le sorgenti: provvisoriamente il massimo delle ultime SOG valide per sorgente, ricevute con timestamp non futuro e vecchie di meno di 15 secondi. Null e valori invalidi non diventano zero. In assenza di SOG recente si usa il limite massimo di 4 minuti, senza dichiarare la barca ferma. Il riferimento sarà sostituibile con l’uscita del futuro normalizzatore della velocità. La finestra è rivalutata ai tick usando il riferimento corrente.

### Tre punteggi

| Componente | Peso | Formula del fattore 0..1 |
| --- | ---: | --- |
| Freschezza | 50 | max(0, min(1, 1 − età / validityMs)) |
| Affidabilità osservata (coherence nel codice) | 30 | fix accettati / osservazioni ordinate ricevute |
| Qualità GNSS dichiarata | 20 | media pesata degli indicatori disponibili della stessa sorgente |

Score = 100 × somma(fattore × peso) / somma dei pesi disponibili. Sorgenti stale/invalide escluse prima del confronto. Tipo GNSS/AIS, frequenza, regolarità e ritardo non assegnano punti separati; tipo e metriche temporali restano diagnostici. Dispersione e confronto con velocità non sono più componenti dello score e non vengono calcolati nel ciclo di selezione; le funzioni sperimentali in gpsQuality rimangono testabili separatamente.

Indicatori GNSS validi per 30 secondi. Metodo e HDOP: peso interno 4; integrità: 2; satelliti: 1. Metodo: GNSS fix 0,6; DGNSS 0,8; precise GNSS/RTK float 0,9; RTK fixed 1; estimated 0,2; manual/simulator 0,1. Integrità safe 1, caution 0,3. HDOP: 1/max(1,HDOP), se positivo. Satelliti: min(1,n/12). Gli indicatori non riconosciuti o assenti sono esclusi.

### Storico e isteresi

Parametri in testa a GpsNormalizer: finestra 15 minuti, massimo 1800 elementi per buffer e sorgente, massimo 16 sorgenti, rimozione sorgenti inattive dopo 30 minuti. Ad altissima frequenza il tetto numerico può ridurre la copertura effettiva; la diagnostica espone conteggi e durata. Gli errori recenti restano fino all’uscita dallo storico o dal limite numerico. Lo stesso timestamp revocato con null sostituisce l’osservazione.

- Prima scelta: migliore candidata utilizzabile, poi timestamp più recente e identità per spareggio deterministico. Nessuna preferenza fissa GPS/AIS a parità di qualità.
- Corrente utilizzabile: vantaggio di almeno 15 punti mantenuto per almeno 5 secondi, almeno 3 fix distinti della candidata estesi su almeno 5 secondi.
- Corrente stale o invalida: failover alla migliore utilizzabile al tick successivo senza attendere la promozione.
- Nessuna riserva: posizione null e stato STALE/INVALID/UNAVAILABLE.
- Nessuna regola aggiuntiva al 50% della validità. I tick ripetuti non maturano fix per promozioni o motion tracker.

### Contratto in uscita e consumatori

Lo snapshot contiene sampledAt e measurements['navigation.position']: value, valid, status, source/sourceType, sourceScore, timestamp originale, receivedAt, ageMs, validityMs, expiresAt, referenceSpeedMps, observationId, isNewObservation, sourceChanged e selectionReason.

- La freschezza progressiva serve allo score interno. I consumatori applicano expiresAt, senza ricostruire la politica di velocità. Alla scadenza il dato non deve restare utilizzabile durante un’interruzione degli aggiornamenti.
- WindEngine rifiuta navigation.position anche dentro processIncomingDelta: applyNormalizedPosition è il solo ingresso operativo GPS. WindEngine conserva la misura e il timestamp, applica la scadenza assoluta e fornisce la stessa scadenza ad AIS e OwnMotionState. Il tracker non riceve una nuova osservazione rileggendo lo stesso fix.
- I frame live/mixed espongono positionMeasurement. La GUI traduce timestamp e scadenza dall’orologio del server a quello locale usando la stessa differenza; null invalida subito. Prua, SOG e gli altri sensori mantengono le proprie scadenze.
- Modalità mista: posizione sintetica mai inventata; il limite GPS è quello del Normalizer, non un ulteriore limite fisso di 30 secondi. Server precedenti senza metadati conservano il ripiego legacy.
- GUI/debug e consumatori senza expiresAt mantengono compatibilità con il limite fisso precedente; la simulazione pura mantiene i propri fix sintetici.
- Nessuna media fra coordinate di sorgenti diverse e nessuna proiezione creata dal Normalizer. Offset fra antenne ignorati per decisione concordata: il cambio sorgente può introdurre una discontinuità.

### Verifiche

[Test della scadenza dinamica](../test/gpsFreshness.test.js): cadenza AIS di tre minuti, estremi 15 s/4 minuti, riferimento comune, velocità assente, failover, tre componenti, memoria limitata, passaggio della scadenza a Wind/tracker/GUI e orologi client differenti.

[Test del flusso](../test/sensorPipeline.test.js) e [migrazione](../test/normalizedPosition.test.js): ricezione, ordinamento, reset, replay, lock, promozione con nuovi fix e blocco degli ingressi GPS diretti. La disponibilità delle sorgenti e il comportamento in navigazione restano da verificare sui dispositivi. Nessuna pubblicazione o riavvio del Cerbo effettuati da questi test.
