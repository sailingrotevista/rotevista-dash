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

## Prime regole GPS implementate

Parametri raccolti in `GPS_NORMALIZER_CONFIG`, all’inizio di GpsNormalizer:

| Parametro | Valore iniziale |
| --- | ---: |
| Periodo snapshot | 1.000 ms |
| Età massima utilizzabile | `positionMaxAgeMs` della politica attuale, 5.000 ms |
| Finestra dello storico per sorgente | 60 secondi |
| Massimo campioni per sorgente | 60 |
| Massimo sorgenti | 16 |
| Rimozione sorgenti inattive | 10 minuti |
| Persistenza per promuovere una sorgente migliore | 5 secondi e almeno 3 fix reali osservati |
| Vantaggio minimo per la promozione | 15 punti di selezione |
| Controllo salti della stessa sorgente | 25 m di tolleranza + spazio a 80 kn nel tempo fra i fix |
| Intervallo massimo per il controllo del salto | 30 secondi |

- Coordinate numeriche finite, latitudine entro ±90°, longitudine entro ±180°; zero è valido.
- Richiedere timestamp valido, non futuro e recente rispetto alla ricezione. Un pacchetto vecchio riletto dalla cache non diventa un fix nuovo.
- Ogni sorgente ha il proprio ordinamento temporale. Duplicati e pacchetti retrodatati non aggiungono campioni né maturano promozioni. Un `null` con lo stesso timestamp può invalidare l’ultimo fix della medesima sorgente; un replay non lo ripristina.
- I controlli di salto si applicano ai fix successivi della stessa sorgente. Un’anomalia rende il candidato non utilizzabile e consente il failover, senza sostituire le coordinate con una stima.
- La scelta iniziale considera tipo di sorgente, frequenza, regolarità, freschezza, ritardo storico e coerenza dei campioni. Il tipo mantiene una preferenza iniziale GNSS diretto / non identificato come AIS / AIS, ma non certifica la precisione. Oltre 1 Hz non c’è ulteriore vantaggio di frequenza. Gli indicatori opzionali partecipano solo quando disponibili.
- Il lock impedisce sostituzioni fra sorgenti equivalenti a ogni messaggio. Una sorgente con un vantaggio persistente può essere promossa solo con nuovi fix distribuiti nel tempo; i tick ripetuti non bastano.
- Se la sorgente scelta scade o diventa invalida, scegliere una riserva fresca al tick successivo. Se manca una riserva, esporre valore nullo e stato STALE/INVALID/UNAVAILABLE: non utilizzare come attuale l’ultimo dato noto.
- Non mediare le coordinate fra GPS diversi né smussare per ora le coordinate di una stessa sorgente. La posizione valida in uscita è l’ultimo fix ricevuto della sorgente scelta.

## Score storico delle sorgenti

Affinamento del 26 ottobre 2026, sempre nel ramo GPS parallelo. Prima escludere sorgenti con campione corrente scaduto o invalido, poi confrontare gli score: nessun ottimo storico rende utilizzabile una posizione scaduta.

Pesi iniziali modificabili in `GPS_SCORE_WEIGHTS` all’inizio di SensorNormalizer, normalizzati su 100 considerando soltanto le componenti disponibili. Sono pesi provvisori di selezione da calibrare, NON percentuali di precisione:

| Componente | Peso | Criterio |
| --- | ---: | --- |
| Tipo sorgente | 30 | GNSS riconosciuto 30, non identificato come AIS 20, AIS 0 |
| Frequenza | 10 | Intervallo mediano dei fix validi, beneficio saturato a 1 Hz |
| Regolarità | 15 | Deviazione assoluta media degli intervalli rispetto alla mediana; comprende anche un’interruzione isolata |
| Freschezza corrente | 15 | Età dell’ultimo timestamp sorgente, rispetto al limite configurato |
| Ritardo storico | 10 | Media delle differenze fra ricezione e timestamp dei fix validi |
| Coerenza osservata | 20 | Frazione di campioni utilizzabili fra gli aggiornamenti ordinati recenti, compresi reset, coordinate invalide e salti scartati |

Ogni componente ha disponibilità, fattore e contributo separati. Regolarità e frequenza senza campioni sufficienti non sono inventate. La qualità assente è esposta come `declaredGpsQuality: { available: false, value: null }` ed esclusa dal punteggio, senza penalità.

- Conservare uno storico limitato anche degli aggiornamenti rifiutati per reset, coordinate o salto, con lo stesso limite temporale e numerico dei fix validi. Lo stesso timestamp revocato con null sostituisce l’osservazione, non ne aggiunge un’altra.
- Duplicati, replay, timestamp assenti, futuri o già scaduti non diventano campioni dello storico né prove per una promozione. I pacchetti con tempi non utilizzabili restano esclusi all’ingresso.
- Dopo una ripresa, gli errori recenti restano nel punteggio finché escono dallo storico o dal limite di campioni; una singola lettura corretta non cancella la cronologia. La finestra è di 60 secondi con massimo 60 elementi per ciascuno dei due buffer per sorgente, quindi ad alta frequenza la copertura temporale effettiva può essere inferiore. Esporre durata e numero dei campioni per renderlo verificabile.
- `getSourceDiagnostics(now)` restituisce una copia calcolata delle valutazioni per sorgente: id, tipo, selezione, eleggibilità, score, contributi, conteggio fix validi/rifiutati/salti, durata osservata, intervallo tipico, variazione degli intervalli, età corrente e latenza media/mediana/massima. La lettura non aggiunge osservazioni e non modifica il lock.
- Nessun nuovo endpoint o contenuto GUI: diagnostica accessibile dal modulo e dai test. La posizione GPS selezionata alimenta gli utilizzatori operativi. I pesi possono essere personalizzati come secondo argomento del costruttore; vietare valori negativi, non finiti o componenti sconosciute.
- Lock, margine di promozione, richiesta di nuovi fix per almeno 5 secondi e failover mantengono la struttura già implementata. L’età massima rimane 5 secondi: il timeout adattivo alla frequenza è ancora una proposta da discutere separatamente.

## Snapshot e nuove osservazioni

Lo snapshot contiene `sampledAt` e `measurements['navigation.position']`: valore, validità, stato, sorgente/tipo e `sourceScore`, timestamp sorgente in millisecondi, ricezione, età, `observationId`, `isNewObservation`, `sourceChanged` e motivo della scelta.

- `sampledAt` misura il tick, non l’età del GPS. Tick intermedi mantengono il timestamp sorgente e lo stesso `observationId`.
- `isNewObservation` indica se il fix differisce da quello dell’ultimo snapshot valido emesso; rileggere uno snapshot non è una nuova osservazione. Gli utilizzatori futuri devono conservare identità e timestamp, non contare i tick.
- Un failover segnala `sourceChanged`. Per decisione attuale gli offset tra antenne sono ignorati: la posizione selezionata resta invariata. Compensare questa discontinuità è un miglioramento futuro, segnalato anche nel codice; il cambio sorgente può introdurre uno spostamento apparente.
- Il modulo restituisce `null` se chiamato prima del periodo minimo; non inventa campioni per recuperare tick persi.

## Verifiche e lavoro successivo

[Test del flusso](../test/sensorPipeline.test.js): acquisizione ad alta frequenza, contesto proprio, provenienza, timestamp mancanti/vecchi/futuri, reset e replay, scelta diretta/AIS, lock, riserva, rientro controllato, nessuna media fra coordinate, saturazione a 1 Hz dello score di frequenza, interruzioni isolate, memoria degli errori, latenza storica, qualità dichiarata non inventata, memoria limitata e collegamento tramite DerivedData e blocco degli ingressi GPS diretti.

Restano da verificare sull’installazione reale la disponibilità di tutte le sorgenti e le soglie di selezione. La posizione GPS propria è ora migrata; gli offset fra antenne restano ignorati per decisione concordata. Le altre misure non sono migrate.

## Qualità opzionale e prove simulate — 26 ottobre 2026

Il supporto [gpsQuality](../sensors/sensorNormalizer/gpsQuality.js) aggiunge pesi da 20 per dispersione residua, coerenza della velocità e qualità dichiarata. Lo score non certifica accuratezza assoluta.

- Indicatori GNSS della stessa sorgente validi per 30 secondi; no GPS, Error e Unsafe recenti escludono il candidato. Null annulla il precedente indicatore. Metodo e HDOP hanno peso interno 4, integrità 2, satelliti 1; HDOP non è convertito in metri.
- Buffer ausiliari limitati a 60 elementi e 60 secondi per percorso. Non rinnovano la posizione né creano fix.
- Dispersione residua rispetto alla traiettoria interpolata, non al centro della sosta: almeno cinque secondi osservati e tre confronti, punti distanziati almeno un secondo, intervalli non oltre cinque secondi.
- Coerenza su finestre di almeno cinque secondi con SOG e COG opzionale della stessa sorgente, abbinati entro due secondi; tolleranza cinque metri più 15% della distanza attesa. Senza velocità la componente resta sconosciuta.
- Manovre confermate da COG con variazione oltre 30 gradi e velocità almeno 0,8 kn escludono i confronti coinvolti. Nessuna media o modifica delle coordinate emesse.

[Test simulati](../test/gpsQuality.test.js): sosta, moto rettilineo, oscillazioni circolari, virata a 90 gradi, jitter, posizione bloccata con velocità dichiarata e qualità opzionale mancante/scaduta. I test del flusso verificano anche perdita sorgente, riserva, rientro e timestamp invariati.

Replay di 210 secondi reali: 210 snapshot validi sul Cerbo, un tick iniziale vuoto, nessun cambio sorgente, età massima 3,128 secondi. Interrompendo gli ingressi dopo 60 secondi, il primo tick non valido arriva cinque secondi dopo il taglio. La registrazione contiene posizioni, senza SOG/COG abbinati o indicatori GNSS: non costituisce una prova in navigazione. Il replay precede il collegamento operativo; i test di integrazione coprono ora anche tale collegamento.

## Collegamento operativo della posizione propria

- Index esclude navigation.position dalla vecchia sottoscrizione e ignora eventuali delta GPS su quel percorso. A ogni tick passa lo snapshot attraverso SensorDerivedData e applica la misura risultante a WindEngine prima del campionamento e del frame condiviso.
- Wind conserva il timestamp originale, anche quando la riserva ha un fix meno recente della sorgente precedente. Dato invalido, scaduto o errore del Normalizer produce posizione null, senza attribuire il tempo del tick a un fix.
- AIS usa esclusivamente questa posizione nel plugin migrato; non recupera la posizione scartata dalla cache Signal K o dall'ultimo GPS valido. La bolla riceve il timestamp sorgente esposto da getRawTimes.
- I frame live/mixed espongono normalizedPosition e positionMeasurement (sorgente, validità e timestamp). La GUI applica la posizione dei frame ordinati anche al cambio sorgente con timestamp meno recente, e ignora gli ingressi GPS diretti una volta gestita dalla sessione server. La modalità simulation mantiene le coordinate sintetiche.
- Il dev server legge la posizione selezionata dall'endpoint live-input del plugin aggiornato. Il ripiego verso installazioni precedenti rimane legacy e non garantisce la selezione di tutte le sorgenti; non scrive sul Cerbo.
- [Test di migrazione](../test/normalizedPosition.test.js): riserva con fix precedente, scadenza nel motore, catena Normalizer/DerivedData/Wind, accettazione GUI del frame autorevole, blocco dei ripieghi GPS di AIS. Test automatici locali; nessun riavvio o prova sui dispositivi effettuato per questa modifica.
