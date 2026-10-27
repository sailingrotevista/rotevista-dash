# Acquisizione, selezione e derivazione dei sensori

Stato: migrazione della posizione GPS propria collegata il 26 ottobre 2026. SensorDerivedData alimenta WindEngine, quindi AIS, motion tracker e frame condivisi; SOG, AWS, STW, TWS ricevuto e profondità seguono lo stesso flusso. Gli angoli e gli altri ingressi non migrati mantengono il percorso precedente.

## Confini dei moduli

I tre stadi sono raccolti nella cartella `sensors/`; la logica GPS è in [sensorNormalizer/GpsNormalizer.js](../sensors/sensorNormalizer/GpsNormalizer.js), coordinata da SensorNormalizer; i test restano nella cartella comune `test/`.

```text
Signal K (tutte le sorgenti disponibili, frequenza originale)
  → SignalKReceiver
  → SensorNormalizer
  → snapshot a 1 Hz
  → SensorDerivedData
  → WindEngine (GPS e scalari normalizzati) → AIS / motion tracker / frame → GUI
```

- [SignalKReceiver](../sensors/SignalKReceiver.js): adattatore di ingresso. Acquisisce AWS, STW, TWS ricevuto, profondità e posizione propria con contesto opzionale della stessa sorgente: SOG, COG vero, metodo GNSS, integrità, HDOP e satelliti, alla frequenza originale. Inoltra percorso, valore, identità e metadati della sorgente, timestamp originale e istante di ricezione. Non conserva uno storico, non sceglie sorgenti, non media e non attribuisce “adesso” a un timestamp mancante. Le posizioni degli altri target sono escluse.
- [SensorNormalizer](../sensors/SensorNormalizer.js): conserva lo storico breve per sorgente, valida coordinate e tempi, valuta continuità/cadenza, sceglie una sorgente con lock/failover e produce al massimo uno snapshot ogni secondo. Tutte le scelte sono locali al server e in RAM.
- [SensorDerivedData](../sensors/SensorDerivedData.js): per ora copia lo snapshot GPS/SOG/AWS/STW/TWS/profondità senza cambiare valore, validità, sorgente o timestamp. I calcoli e i ripieghi Wind non sono stati trasferiti. Il modulo non invia messaggi Signal K; index trasferisce la sua posizione selezionata allo store Wind.

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

## Prima migrazione SOG — 27 ottobre 2026

`SignalKReceiver` acquisisce già navigation.speedOverGround di tutte le sorgenti a frequenza nativa. SensorNormalizer inoltra la SOG sia al contesto GPS sia al nuovo [SogNormalizer](../sensors/sensorNormalizer/SogNormalizer.js). Snapshot comune a 1 Hz e passaggio invariato in SensorDerivedData.

### Controlli e selezione

- Dato ricevuto in m/s, numerico finito fra 0 e 25,72 (limite precedente, circa 50 kn); zero è misurato, null/assenza non diventano zero. Provenienza e timestamp obbligatori, non futuro né già scaduto.
- Ordinamento per sorgente; duplicati/replay non maturano frequenza, lock o nuove osservazioni. Null allo stesso timestamp revoca il valore; un replay non lo ripristina. Un nuovo valore invalido rende non utilizzabile quella sorgente, senza scegliere un valore inventato.
- Scadenza SOG invariata a 5 secondi. Nessuna estensione automatica dal timeout GPS, nessuna stima dagli spostamenti, media, filtro di accelerazione o confronto con altre misure in questa fase.
- Due componenti, pesi configurabili iniziali pari a 50: frequenza e freschezza. Frequenza = min(1,1000/intervallo mediano in ms dei fix distinti validi); beneficio saturato a 1 Hz. Freschezza = max(0,min(1,1−età/5000)). Media pesata normalizzata su 100 delle componenti disponibili; con un solo fix frequenza non disponibile e non inventata.
- Storico degli istanti: 60 secondi, massimo 120 fix per sorgente, massimo 16 sorgenti, eliminazione dopo 30 minuti senza ricezione. Sono parametri in testa a SogNormalizer.
- Lock della sorgente corrente utilizzabile. Promozione: almeno 15 punti di vantaggio per 5 secondi, almeno 3 nuovi fix della candidata estesi su almeno 5 secondi. Se la corrente scade/è invalida, failover immediato al tick successivo alla migliore valida. Spareggio iniziale: timestamp più recente, poi identità deterministica; a parità non forzare cambio del lock.
- Nessuna preferenza automatica per la sorgente scelta dal GPS. Diagnostica tramite getSogSourceDiagnostics: score, frequenza, freschezza, intervallo tipico, età e selezione.

### Distribuzione

WindEngine.applyNormalizedSog riceve il valore da DerivedData tramite index, conserva timestamp e scadenza, espone null se inutilizzabile. Non ripete i controlli fisici del Normalizer: applica il risultato e rispetta expiresAt durante un’interruzione. I calcoli Wind consumano questa stessa SOG risolta, senza un secondo timeout indipendente. WindEngine.processIncomingDelta rifiuta il path SOG; la sottoscrizione legacy del plugin lo esclude e ignora eventuali consegne accidentali. Errori del ramo sensori invalidano sia GPS sia SOG.

AIS legge la SOG propria esclusivamente dallo store Wind alimentato da DerivedData: nessun ripiego su getSelfPath. La selezione SOG dei target AIS esterni non cambia. I frame live/mixed portano normalizedSog e sogMeasurement; la GUI li applica autorevolmente anche quando una riserva ha timestamp meno recente e blocca gli ingressi SOG diretti da websocket dopo l’aggancio alla sessione normalizzata. La simulazione pura resta sintetica; i server precedenti senza flag mantengono il percorso GUI legacy.

Tutti i calcoli Wind, storico SOG, vettori e tracker usano quindi il valore selezionato, mantenendo le attuali scadenze. Il futuro riferimento di SOG calcolata dal GPS e la selezione più potente non sono implementati qui.

Verifiche: [SOG e lock](../test/sogNormalizer.test.js), [storico SOG](../test/windSogValidity.test.js), [integrazione plugin](../test/sensorPipeline.test.js). Nessuna pubblicazione, modifica della modalità del Cerbo o riavvio per queste prove.

## Prima migrazione AWS — 27 ottobre 2026

`environment.wind.speedApparent` segue il medesimo ingresso operativo di GPS e SOG:
SignalKReceiver (tutte le sorgenti, cadenza originale) → SensorNormalizer →
[AwsNormalizer](../sensors/sensorNormalizer/AwsNormalizer.js) → snapshot comune a
1 Hz → SensorDerivedData → WindEngine / frame live e mixed / GUI.

- Valori ricevuti in m/s: numeri finiti fra 0 e 51,44, come il precedente limite AWS.
  Zero è misurato; null, assenza e valori invalidi non diventano bonaccia.
- Scadenza a 5 secondi dal timestamp originale. Riletture e tick a 1 Hz non
  rinnovano il dato. Timestamp mancante, futuro, scaduto e replay sono rifiutati.
- Selezione indipendente da SOG/GPS: frequenza 50 e freschezza 50, con le stesse
  formule e regole di lock/failover della SOG sopra descritte. Storico degli
  istanti 60 secondi / 120 campioni / 16 sorgenti, rimozione dopo 30 minuti.
- La logica comune di selezione è in
  [ReceivedValueNormalizer](../sensors/sensorNormalizer/ReceivedValueNormalizer.js);
  SogNormalizer e AwsNormalizer dichiarano separatamente percorso, limiti e
  configurazione. Nessuna media fra sorgenti, correzione o filtro delle raffiche
  nel normalizer. L'uscita è l'ultimo valore della sorgente selezionata.
- `applyNormalizedAws` è l'unico ingresso AWS in WindEngine: il percorso delta
  diretto e la vecchia sottoscrizione sono esclusi. Il motore conserva la scadenza
  assoluta e la rispetta anche se il produttore si interrompe; AWS risolta alimenta
  anche TWA/TWS di ripiego e la ponderazione dello storico TWD.
- I frame espongono `normalizedAws` e `awsMeasurement`, inclusa sorgente,
  timestamp, età, validità, score e scadenza. In live/mixed la GUI segue la scelta
  server anche se una riserva ha un timestamp precedente; traduce il tempo in
  quello locale senza attribuire freschezza al polling. Il websocket AWS diretto
  non sovrascrive questo ingresso dopo l'aggancio alla sessione normalizzata.
- La simulazione pura resta sintetica; server precedenti senza flag mantengono
  la compatibilità GUI. Il dev bridge usa la misura normalizzata fornita dal
  plugin installato: per provare il selettore nuovo sui sensori reali occorre
  installare questa versione sul server.
- Storico AWS/TWS e filtro delle raffiche sostenute rimangono in WindEngine,
  con campionamento a 1 Hz e formule invariate. Nessun nuovo timestamp AIS.

Verifiche automatiche: [AWS](../test/awsNormalizer.test.js),
[flusso plugin](../test/sensorPipeline.test.js),
[raffiche](../test/windGust.test.js),
[campionamento](../test/windSampling.test.js). La selezione e la variabilità delle
sorgenti di vento reali restano da osservare dopo l'installazione della beta.


## STW, TWS ricevuto e profondità — 27 ottobre 2026

Tre normalizer di categoria riutilizzano ReceivedValueNormalizer, il selettore
comune a SOG e AWS rinominato per includere misure scalari non di velocità.
La configurazione comune di score/lock/memoria è in testa a quel modulo; ogni
categoria dichiara percorso, unità implicita Signal K, limiti e scadenza.

| Categoria | Path | Intervallo valido | Scadenza |
| --- | --- | --- | --- |
| STW | navigation.speedThroughWater | 0–25,72 m/s | 5 s |
| TWS ricevuto | environment.wind.speedTrue | 0–51,44 m/s | 5 s |
| Profondità | environment.depth.belowTransducer | −2–500 m | 5 s |

Valgono gli stessi score frequenza/freschezza 50/50, lock, promozione
15 punti / 5 secondi / 3 osservazioni reali e failover immediato delle altre
misure scalari. Uno snapshot comune a 1 Hz conserva valori e timestamp originali;
null, replay e polling non producono zero né nuova freschezza. In particolare
zero profondità è valido, così come STW/TWS zero. I limiti sono quelli già usati
in Wind: non vengono aggiunti filtri fisici, medie fra sorgenti o correzioni.
La profondità resta riferita al trasduttore: nessuna fusione con depthBelowKeel o
con valori riferiti alla superficie.

Index inoltra esclusivamente le misure da SensorDerivedData tramite
applyNormalizedStw/Tws/Depth. Le sottoscrizioni legacy e processIncomingDelta
non alimentano più questi path. Anche il contesto vento del tracker AIS legge
il TWS ricevuto dal nuovo ingresso, senza un ripiego alla cache Signal K.
I consumatori rispettano expiresAt senza rinnovarlo al campionamento.

I frame live/mixed aggiungono normalizedStw/Tws/Depth e
stwMeasurement/twsMeasurement/depthMeasurement. La GUI accetta la scelta
autorevole anche con riserva più vecchia, converte il timestamp rispetto
all'orologio server ed esclude i delta websocket dei canali normalizzati.
Simulazione pura e compatibilità con server precedenti restano separate.

TWS calcolato: il normalizer tratta solo il valore ricevuto. Priorità TWS nativo
valido, ripiego vettoriale e formula VMG restano negli attuali resolver Wind e
frontend; lo spostamento dei calcoli in SensorDerivedData è un passo successivo.
VMG non è oggi un ingresso strumentale: deriva da velocità utilizzabile e TWA.
Il minimo della profondità nello storico e il filtro delle raffiche TWS/AWS
rimangono invariati in WindEngine. Le altre misure principali ancora da migrare
sono angolari (AWA, TWA, TWD, heading e COG) e l'assetto.

Verifiche: [scalari e distribuzione](../test/scalarSensors.test.js),
[flusso plugin](../test/sensorPipeline.test.js),
[TWS nativo e ripiego](../test/windTwsValidity.test.js),
[VMG](../test/windVmgValidity.test.js),
[profondità](../test/windDepthValidity.test.js). La prova con i sensori reali
richiede l'installazione della versione aggiornata, senza riavvii durante i test.
