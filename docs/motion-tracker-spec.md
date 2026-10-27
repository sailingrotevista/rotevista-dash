# Specifiche di TargetMotionTracker: due stati

Stato: regole concordate il 26 ottobre 2026 e promosse nel [tracker operativo locale](../ais/targetMotionTracker.js). AisEngine e sessione dev usano questa implementazione; la chiave self condivide l’istanza AIS. La modifica richiede ancora pubblicazione/installazione per essere attiva sul Cerbo.

Questa revisione sostituisce il precedente progetto a quattro stati e le prove di partenza con due fix oltre un riferimento, durata minima, progressione, SOG >2 kn o fattori proporzionali. Tali regole non sono più attive.

## Stati principali e prima osservazione

Sono ammessi soltanto MOVING e STATIONARY.

| SOG nella prima osservazione valida | Stato iniziale |
| --- | --- |
| SOG numerica finita fra 0 e 0,5 kn inclusi | STATIONARY |
| SOG maggiore di 0,5 kn | MOVING |
| Mancante o invalida, target AIS | MOVING |
| Mancante o invalida, nostra barca (self) | STATIONARY |

Eccezione di avvio propria: il primo fix valido senza SOG utilizzabile inizializza STATIONARY, senza inventare una SOG zero né confermare una sosta osservata. Un primo fix con SOG valida sopra 0,5 kn inizializza invece MOVING. Non si modifica lo stato dei target AIS, né la successiva regola MOVING → STATIONARY di cinque fix/cinque minuti.

La soglia iniziale è configurata da `initialStationaryMaxSpeedKnots`. Si applica soltanto al primo fix, non alle successive regole di arresto e ripartenza.

Gli indizi AIS di ormeggio/ancoraggio e l’appartenenza a un’area non sostituiscono questa regola. AisEngine distingue ora uno zero realmente ricevuto da una SOG assente o invalida, che rimane null; vengono conservati i timestamp di SOG e COG quando presenti.

## Acquisizione

1. Validare coordinate e tempi; escludere fix futuri o esplicitamente proiettati.
2. Scartare le posizioni fuori ordine e riconoscere i duplicati tramite timestamp sorgente.
3. Registrare osservazioni e scia soltanto con una nuova posizione sorgente. Coordinate uguali con timestamp successivo sono nuove osservazioni di permanenza.
4. Conservare separatamente gli ultimi tre fix reali, non compressi geometricamente, usati per la ripartenza.
5. Aggiornare il buffer prua/vento con i propri timestamp: una nuova prua su una posizione riletta non aggiunge un fix.
6. Leggere il contesto dell'area e valutare lo stato.

SOG e COG mancanti nelle osservazioni rimangono null. Non inventare zeri, timestamp o posizioni intermedie. Nessun filtro a 30 secondi viene introdotto: l’arresto usa durata e numero di fix indicati sotto; la ripartenza usa gli ultimi tre fix per AIS e tre posizioni nello storico di cinque minuti per la nostra barca.

## MOVING → STATIONARY

Occorrono insieme:

- almeno **5 fix reali distinti**;
- almeno **300 secondi (5 minuti)** tra primo e ultimo punto valutato;
- **diametro massimo di 50 m**, inteso come distanza massima fra qualsiasi coppia dei punti valutati.

La sola SOG bassa non conferma l'arresto. Il diametro non è una distanza dal primo punto né una dispersione media.

La verifica usa il più lungo gruppo consecutivo finale delle osservazioni recenti che rispetta il diametro; si interrompe al primo punto precedente incompatibile. Non riutilizza osservazioni di una fase di movimento precedente alla ripartenza appena confermata. Se il gruppo ha abbastanza fix e durata, stabilisce una nuova sosta, ne fissa il riferimento e riavvia la finestra dei fix per la ripartenza. L'arresto è un'unica conferma, non due stati separati.

Le osservazioni recenti restano compresse geometricamente e limitate a 15 minuti / 120 punti; il diametro viene verificato fra tutti i punti mantenuti del gruppo valutato. Un ingresso a 1 Hz può comunque coprire cinque minuti grazie alla conservazione degli estremi temporali, senza richiedere 300 elementi.

## STATIONARY → MOVING

Per i target AIS la verifica ordinaria usa **esattamente gli ultimi 3 fix reali**. Calcola soltanto lo **spostamento netto dal primo al terzo**, non la somma del percorso.

| Contesto della sosta | Spostamento necessario |
| --- | ---: |
| Porto | almeno 50 m |
| Ancoraggio | almeno 150 m |
| Fuori area | almeno 300 m |
| Area provvisoria | ripiego 300 m: valore specifico ancora da concordare |

- Nessun requisito ulteriore di SOG, durata o avanzamento progressivo.
- La finestra scorre: non accumulare la distanza dal primo fix di una candidata lontana nel tempo o dal riferimento originario della sosta.
- Per AIS non sostituire i tre fix reali con punti selezionati dalla compressione della traccia. La nostra barca usa la selezione storica descritta sotto.
- Al raggiungimento della distanza (tolleranza numerica 1e-6 m) passa a MOVING, azzera la conferma della sosta e resetta l'analisi della previsione. La scia disponibile rimane.
- I fix precedenti al nuovo arresto non sono riutilizzati come prova della successiva ripartenza: dopo MOVING → STATIONARY la finestra inizia con l'ultimo fix dell'arresto confermato.

Questo criterio è intenzionalmente conservativo e dipende dalla frequenza di ricezione. A 1 Hz la finestra copre circa due secondi; a un fix ogni tre minuti copre sei minuti. Non adattare implicitamente le distanze o il campionamento per compensare questa differenza. Uno spostamento lento può restare STATIONARY se ogni finestra di tre fix rimane sotto soglia; questa scelta è distinta dal controllo di prossimità, che non è modificato qui.

### Nostra barca: tre posizioni reali nello storico di cinque minuti

La chiave riservata `self`, già usata da OwnMotionState, mantiene lo stesso algoritmo di distanza ma cambia la selezione dei punti di ripartenza:

- Riutilizzare le osservazioni reali già conservate dal tracker, senza creare altri campioni o ridurre la frequenza del GPS.
- Considerare soltanto quelle negli ultimi `ownDepartureHistorySeconds` (300 secondi) e non precedenti all’ultima conferma di arresto.
- Scegliere primo e ultimo punto disponibili nella finestra, più il punto interno temporalmente più vicino alla metà dell’intervallo. I tre timestamp devono essere distinti.
- Se sono disponibili meno di tre posizioni, non confermare la partenza. Non inventare interpolazioni.
- Stesse soglie 50/150/300 m dal primo all’ultimo punto selezionato, senza requisito di SOG o durata minima: è possibile confermare prima dei cinque minuti.
- Nessun accumulo da punti più vecchi della finestra. Un nuovo arresto riavvia la selezione dall’ultimo fix della conferma.
- I target AIS continuano a usare esattamente gli ultimi tre fix non compressi. La selezione storica della nostra barca non modifica gli array di osservazioni e non rinnova i timestamp.

Simulazione rettilinea con GPS a 1 Hz e 2 kn fuori area: la nostra barca supera 300 m e torna MOVING dopo 292 secondi (circa 4 minuti e 52 secondi). Gli stessi dati trattati come target AIS restano sotto 300 m in ogni finestra degli ultimi tre fix: la distinzione è intenzionale. GPS e mappa non vengono limitati dal tracker.

### Nessuna candidatura intermedia

Il tracker espone soltanto MOVING e STATIONARY. `possibleMovement` e l'oggetto `departure` sono stati rimossi perché non servono alla regola: con meno di tre fix o distanza insufficiente il target resta STATIONARY; al soddisfacimento dei requisiti passa direttamente a MOVING. Nessuna candidatura viene accumulata nel tempo.

## Contesto da HarborDetector

Il costruttore accetta `{ harborDetector }` come secondo argomento opzionale. Usa la query di sola lettura `getAreaAtPosition(lat, lon)` dell'ultima elaborazione completata.

- `areaContext` descrive la posizione attuale del target.
- `restAreaContext` descrive il riferimento fisso della sosta e sceglie la soglia. Uscire dal perimetro non cambia automaticamente una soglia di 50/150 m in 300 m.
- Il riferimento della sosta rimane fermo, ma non è un trigger geometrico aggiuntivo di ripartenza: la distanza è sempre fra primo e terzo fix correnti.
- PORT non produce uno stato INPORT; le descrizioni del vento e della sosta non possono modificare lo stato principale.

L'alternativa «uscita reale dall'area + un'altra evidenza» è ancora da definire e non viene eseguita. Una ricostruzione del perimetro non è considerata di per sé movimento del target.

## Storici e dati descrittivi preservati

- Osservazioni recenti: fino a 15 minuti, massimo 120 punti compressi geometricamente.
- Scia: durata configurata dal chiamante, massimo 60 punti.
- Ultimi tre fix: buffer dedicato non compresso, indipendente dagli altri due.
- Buffer prua/vento separato: limiti provvisori ereditati di 15 minuti / 120 elementi, correlazione recente entro 180 secondi e target entro 1 NM dalla nostra misura locale.
- Rest pattern e stabilità della previsione rimangono informazioni descrittive. Il pattern può descrivere un'oscillazione, ma non promuove OSCILLATING né conserva un ulteriore stato principale. Nessun INPORT automatico.
- Tutta la memoria resta in RAM, rimossa quando il target viene eliminato.

## Parti non cambiate o ancora aperte

- La matrice geografica del Modulo 4 è applicata anche alla simulazione: vedere [specifica AIS](ais-spec.md#matrice-geografica-degli-avvisi). La bubble, gli snooze e gli acknowledge mantengono le proprie regole.
- Area provvisoria e percorso alternativo di uscita area sono ancora da definire per le transizioni del tracker.
- Il tracker operativo è collegato ai motori locali: la SOG assente è null, HarborDetector fornisce il contesto e la nostra barca usa lo storico di cinque minuti. Rimane da verificare l’installazione sui dispositivi.
- Il clustering portuale non viene rivisto da questa modifica.

## Verifiche

[Test automatici](../test/experimentalMotionTracker.test.js):

- Ingresso con SOG fra 0 e 0,5 kn inclusi, maggiore di 0,5 kn, mancante e invalida; metadati e area non forzano lo stato.
- Cinque fix/cinque minuti e diametro massimo fra coppie; endpoints a 50 m accettati e oltre 50 m respinti.
- Report a 1 Hz compressi e AIS ogni tre minuti; duplicati non contano.
- Ripartenza esattamente sugli ultimi tre fix, soglie 50/150/300 m, anche con SOG zero e intervalli brevissimi.
- Nessun accumulo dal riferimento remoto, nessuna somma del percorso, buffer non influenzato dalla compressione.
- Contesto della sosta, separazione delle evidenze prua/vento, nuovo arresto seguito da nuova ripartenza.
- Pattern di oscillazione solo descrittivo, con stato principale sempre STATIONARY nel caso simulato.

Test aggiuntivi: selezione storica per self, timestamp originali distinti, finestra mobile, nessuna interpolazione o modifica degli array, partenza a 2 kn entro cinque minuti, partenza anticipata con distanza sufficiente e reset della finestra dopo un nuovo arresto.

Verifiche locali di regole e integrazione: [tracker pubblico e motore](../test/targetMotionTracker.test.js), [nostra barca](../test/ownMotionState.test.js), [sessione dev](../test/dashboardSession.test.js). Nessuna prova sui dispositivi o riavvio del Cerbo eseguito per questa modifica.

## Integrazione e provenienza

- AisEngine istanzia il tracker con il proprio HarborDetector. Non viene più reinserito nel tracker un isMoored dedotto dal detector come prova AIS.
- La sessione installata riusa ownMotion calcolato dall’unica istanza condivisa. Il fallback dev istanzia lo stesso algoritmo e legge i perimetri upstream tramite la funzione pura getAreaAtPositionFromAreas, senza creare un detector o scrivere sul Cerbo.
- Con posizione propria scaduta non si conferma una sosta attuale; dopo un gap GPS oltre 360 secondi OwnMotionState azzera la propria osservazione. Il fattore collisione dipende dalla matrice geografica, non dalla sola conferma di sosta o dal solo stato AIS dichiarato.
- Una SOG assente inizializza MOVING, ma non inventa una velocità: cache e JSON mantengono null e la GUI usa --.- / SPEED UNAVAILABLE. Senza SOG valida non viene proiettata la posizione del target. Le formule di collisione esistenti non sono riscritte da questa integrazione.
- La tolleranza preesistente di 30 secondi per il timestamp sorgente leggermente futuro è conservata: t è limitato al tempo di elaborazione dall’ingresso AIS, sourceTime resta originale per evitare duplicati. Oltre la tolleranza la misura viene scartata.
- Il vecchio stato principale POSSIBLE_MOVEMENT non viene più emesso. La bubble riconosce ancora quel valore per compatibilità con dati precedenti, senza cambiare le sue regole.
- ais/experimental/targetMotionTracker.js è ora un semplice re-export del tracker promosso, non una seconda implementazione.

## Parametri descrittivi prua/vento conservati

Il supporto descrittivo all’ormeggio richiede sosta confermata, almeno tre heading distinti distribuiti su almeno cinque minuti, vento almeno 6 kn, spread prua entro 15 gradi e distanza angolare vento-prua almeno 45 gradi (inclusa la poppa). Una variazione del vento di almeno 30 gradi rafforza l’indizio. La correlazione usa tempi recenti entro 180 secondi e distanza entro 1 NM dalla nostra misura. Non è uno stato principale e non modifica le transizioni MOVING/STATIONARY.
