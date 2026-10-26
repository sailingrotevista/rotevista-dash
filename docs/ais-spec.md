# Specifiche AIS e collisioni

Stato: revisionata e approvata con l'utente il 25 ottobre 2026.
Verificata sul codice locale il 25 ottobre 2026, versione 9.4.0-beta.0.
La versione installata sul Cerbo può essere diversa.

## Filosofia concordata

- Il rosso rappresenta l'allarme nominale, confrontato con i limiti scelti dall'utente e adattati alla velocità.
- L'arancione anticipa il rosso con una distanza maggiore; può anche segnalare una traiettoria osservata come instabile.
- L'instabilità può aggiungere arancione, ma non trasformare arancione in rosso.
- La presenza di una barca ferma non implica automaticamente assenza di pericolo.
- Le navi ferme fuori dalle aree di sosta riconosciute restano ostacoli da valutare con CPA/TCPA.
- La matrice geografica distingue collisione normale, collisione con soglie ridotte e sola prossimità quando entrambe le barche sono ferme.
- Non inserire suggerimenti COLREG nei banner. La guida COLREG è rinviata.
- Non introdurre suoni AIS in questa fase.

## CPA e TCPA nominali

- Il CPA nominale visualizzato è la minima separazione prevista tra gli inviluppi degli scafi, non la distanza tra i centri o le antenne GPS.
- Il TCPA è il tempo del minimo corrispondente tra gli scafi: distanza e tempo devono riferirsi allo stesso incontro.
- Il calcolo usa le dimensioni e gli offset dell'antenna quando disponibili; altrimenti usa gli ingombri di ripiego previsti dal codice.
- Per una barca in movimento, l'orientamento dell'inviluppo segue il COG.
- Per una barca ferma si usa l'heading valido; in sua assenza si usa un inviluppo quadrato conservativo.
- Un TCPA pari a zero è valido quando il minimo è nel presente. Non usare zero come sostituto di un dato mancante o di un incontro già passato.
- I target divergenti non devono essere presentati come nuovi incroci futuri.
- Il movimento lento confermato dal tracker deve essere considerato nel moto del target, anche sotto 0,8 nodi.

## Soglie di distanza

Valori iniziali della politica attuale:

| Categoria | Distanza rossa base | Velocità di riferimento |
| --- | ---: | ---: |
| Diporto | 250 m | 7,5 kn |
| Commerciale | 800 m | 10 kn |
| Lavoro | 400 m | 10 kn |

La categoria effettiva è risolta dal codice in base alle informazioni disponibili sul target.

```text
fattore distanza = max(1, velocità target / velocità di riferimento)
distanza rossa = distanza rossa base configurata × fattore distanza
distanza arancione = distanza rossa × 2
```

Sotto la velocità di riferimento non ridurre la distanza base.
La geometria degli scafi è già considerata nel CPA: non sottrarre nuovamente una lunghezza o un raggio arbitrario al valore nominale.

## Finestra temporale

- Base predefinita del plugin reale: 10 minuti.
- Base della simulazione: 5 minuti.
- Aumentare l'anticipo quando il target è più veloce della nostra barca.
- Usare 4 kn come minimo della nostra velocità soltanto nel rapporto che determina l'anticipo; non sostituire con 4 kn la velocità cinematica reale.

```text
velocità propria per il rapporto = max(velocità propria, 4 kn)
fattore tempo = 1 + 0,5 × max(0, velocità target / velocità propria per il rapporto − 1)
finestra = min(max(base, limite massimo), base × fattore tempo)
```

Il limite massimo predefinito è 30 minuti. Se viene configurata una base superiore, il limite non deve rendere la finestra inferiore alla base.
Distanza e tempo si verificano insieme, sulla traiettoria nominale.

## Matrice geografica degli avvisi

Il Modulo 4 usa lo stato MOVING/STATIONARY del tracker e l’appartenenza geometrica alle aree riconosciute (PORT, ANCHORAGE o PROVISIONAL).

| Nostra barca | Target | Condizione | Politica |
| --- | --- | --- | --- |
| MOVING | Qualsiasi | Target dentro un’area | Soglie ridotte |
| MOVING | Qualsiasi | Target fuori area | Soglie normali |
| STATIONARY | MOVING | Nostra barca dentro un’area | Soglie ridotte |
| STATIONARY | MOVING | Nostra barca fuori area | Soglie normali |
| STATIONARY | STATIONARY | Ovunque | Solo safe bubble |

La riduzione predefinita è 0,25 sulle distanze rossa e arancione e sulla finestra temporale, una sola volta dopo adattamento alla velocità e limite massimo. Il solo stato AIS anchored non attiva la riduzione geografica. La posizione ricevuta del target, anziché quella proiettata, determina l’appartenenza. Anche un target MOVING può essere dentro il poligono senza contribuire alla formazione del porto.

Quando entrambi sono STATIONARY, CPA e TCPA non sono mostrati e il precedente stato collisione viene rimosso; l’ingresso osservato nella bubble, l’isteresi e gli acknowledge mantengono le proprie regole. Prima comparsa dentro la bubble: nessun warning.

Verifiche: [matrice completa](../test/alertMatrix.test.js), [ingressi bubble](../test/bubbleEntryTracker.test.js).

### Stato osservato della nostra barca

Il riconoscimento automatico usa la stessa istanza di `TargetMotionTracker` usata per i target AIS, con la chiave riservata `self`, alimentata esclusivamente da fix propri ricevuti con timestamp crescente e recente. SOG nulla, riletture e appartenenza a un porto da sole non confermano la sosta.

- All’avvio, SOG fra 0 e 0,5 kn inizializza STATIONARY/STOPPED; SOG superiore o mancante inizializza MOVING/UNDERWAY. La conferma dell’arresto usa almeno 5 fix su almeno 5 minuti con diametro massimo di 50 m.
- Sosta confermata nel poligono di un’area PORT → IN PORT; fuori da un porto confermato → AT ANCHOR, come stato osservato compatibile con ancoraggio, senza aspettare di vedere oscillazioni.
- La nostra barca non entra nell’elenco dei candidati del detector, non forma o estende aree e non incrementa i conteggi dei target.
- La partenza confermata aggiorna MOVING e ricalcola la politica secondo la matrice, anche sotto 0,8 kn. Un’eventuale indicazione `anchored` rimasta sul bus non prevale sul movimento confermato.
- La scadenza del GPS sospende la conferma automatica utilizzabile; dopo una pausa fra fix superiore al massimo comune di 360 secondi ricominciare l’osservazione. Conservare timestamp originali; non alimentare il tracker con posizioni proiettate o sintetizzate dalla frequenza del ciclo.
- Stato e fattore applicato sono calcolati sul server e distribuiti ai client; la simulazione mista usa lo stesso fattore per i target sintetici. La simulazione pura mantiene la propria barca in navigazione. Le isteresi di rientro degli allarmi e la politica bubble restano separate.

Verifiche: [sosta propria e collegamento alle soglie](../test/ownMotionState.test.js).

## Avviso aggiuntivo da instabilità

- Usare i fix reali precedenti per confrontare previsione e spostamento osservato.
- Richiedere evidenza sufficiente: un singolo dato anomalo o una singola virata non devono equivalere automaticamente a instabilità persistente.
- Non far maturare l'instabilità semplicemente rileggendo gli stessi dati.
- Valutare la possibile riduzione della separazione lungo un intervallo di previsione, non soltanto in un punto campionato.
- Per aggiungere arancione, l'incertezza deve penetrare almeno del 10% nella soglia arancione e mantenerne la condizione per almeno 15 secondi previsti.
- Limitare il raggio aggiuntivo al 20% della distanza arancione effettiva.
- Dopo 6 minuti senza una nuova posizione, non generare un nuovo warning basato su questa crescita d'incertezza.
- I vecchi quattro scenari con variazioni ipotetiche di COG/SOG non guidano più gli allarmi. I campi CPA minimo/massimo residui non rappresentano limiti matematicamente garantiti di ogni traiettoria possibile.

## Rientro e priorità

- Aumento di gravità immediato.
- Per scendere di gravità, richiedere una condizione inferiore continuativa per un quinto del tempo base: 2 minuti con base 10, 1 minuto con base 5.
- Scaduto questo intervallo, passare direttamente al livello corrente; non scendere obbligatoriamente un colore alla volta.
- Il ritorno al livello mantenuto interrompe il rientro; oscillazioni fra livelli inferiori non devono riavviare continuamente il conteggio.
- Tra allarmi di collisione, il rosso precede l'arancione. A pari colore la priorità combina distanza e tempo secondo `CPA in metri + 60 × TCPA in minuti`, con spareggi deterministici.
- Il banner condiviso mantiene per 10 secondi un concorrente di pari gravità prima di sostituire il target; un'escalation non aspetta questo intervallo.
- Per la prossimità mostrare un solo rappresentante: il target non riconosciuto con la minima separazione attuale tra gli scafi.

## Safe bubble: presenza iniziale, ingresso e isteresi

Regola aggiornata con l'utente il 25 ottobre 2026 dopo il monitoraggio del riavvio del Cerbo:

- La prima apparizione già dentro la bubble non genera segnalazione: nessun banner, arancione, tag `PROXIMITY` o conteggio warning.
- Il target rimane normalmente visibile e ispezionabile; nei dettagli resta disponibile la separazione tra gli scafi, con presentazione neutra.
- Registrare la presenza relativa prima che il porto sia riconosciuto. L'inclusione successiva nell'area non è un ingresso nella bubble.
- Il solo jitter oltre entrambe le soglie non deve riarmare una presenza riconosciuta ferma. Serve movimento reale confermato dal tracker, oppure uno spostamento della nostra barca.
- Per lo spostamento proprio, il filtro locale della bubble usa almeno 10 m di avanzamento con SOG di almeno 0,8 kn, oppure oltre 35 m dal riferimento. Questo non equivale al riconoscimento automatico della nostra barca all'ancora.
- Con evidenza di movimento, attivare l'ingresso entro la distanza configurata, normalmente 45 m; usare un margine esterno di 10 m per l'uscita, normalmente oltre 55 m.
- Confermare le transizioni con almeno 2 nuove osservazioni ricevute della geometria relativa e almeno 10 secondi fra la prima e l'ultima conferma. Le posizioni possono riguardare il target o la nostra barca; il trascorrere del tempo, le riletture e le proiezioni non contano.
- Il filtro temporale è aggiuntivo: non sostituisce l'evidenza di movimento. Con aggiornamenti lenti la conferma può richiedere più di 10 secondi.
- Una volta attivo, mantenere il warning anche fra 45 e 55 m. Il rientro richiede un'uscita confermata, non una singola lettura fuori soglia.
- Se il target è tornato fermo, le oscillazioni della stessa sosta non devono far cambiare continuamente lo stato del warning già attivo.
- Banner, colore, tag e contatori devono usare lo stesso stato confermato del tracker della bubble; non ricalcolare indipendentemente un warning dal solo confronto con 45 m.
- Non creare acknowledge automatici per nascondere le presenze iniziali: assenza di ingresso osservato e riconoscimento manuale sono condizioni diverse.
- L'acknowledge condiviso resta valido per le presenze riconosciute senza riarmo dovuto alla sola uscita/rientro nella bubble; restano le regole di movimento, contesto e pulizia già definite.
- Queste regole riguardano la prossimità dei target fermi nelle aree riconosciute. Gli allarmi nominali dei target mobili e degli ostacoli fuori area rimangono indipendenti.

Riferimenti: [tracker degli ingressi](../ais/bubbleEntryTracker.js), [politica di prossimità](../ais/collisionPipeline.js), [test degli ingressi e del jitter](../test/bubbleEntryTracker.test.js).

## Dati vecchi e contatti persi

- L'età della posizione deriva dall'ultimo timestamp AIS valido della posizione, non dall'arrivo di nome, dimensioni o altri metadati.
- Le proiezioni non azzerano l'età e non alimentano il tracker come nuove osservazioni.
- Un target confermato mobile viene proiettato a partire da 15 secondi dall'ultimo fix, usando il tempo trascorso dal fix.
- Scadenza ordinaria: 6 minuti per target mobili, 15 minuti per target fermi.
- Un contatto con allarme attivo può essere trattenuto come perso oltre la scadenza ordinaria, fino al rientro dell'incontro secondo le regole del motore.
- Un target perso già silenziato non deve risvegliare l'allarme soltanto perché scadono i 10 minuti; una nuova posizione permette di riprendere la valutazione normale.
- Il banner segnala l'età quando supera un quinto della finestra effettiva, distinguendo posizione prevista e ultima posizione riportata.

## Dati nel popup di ispezione

- Se i dettagli sono aperti e si seleziona un altro target sulla mappa, aggiornare il contenuto mantenendo il popup aperto e la scheda corrente. Il clic sul medesimo target e gli altri comandi mantengono il comportamento precedente.
- Conservare la scheda sintetica Info & dimensions: dimensioni, pescaggio, destinazione/ETA, stato AIS/classe, radio/bandiera e osservazioni già presenti.
- Il blocco unico “AIS STATUS (A/B)” riunisce destinazione, ETA e stato ricevuto. La classe è nel titolo solo se disponibile. Mostrare soltanto righe valorizzate, omettere segnaposto e stato non definito; nascondere il blocco se resterebbe soltanto la classe.
- Mantenere la destinazione come trasmessa, senza dedurre il nome di un porto da un codice. Formattare ETA valide con fuso esplicito come “29 Oct, 12:00 UTC”; non interpretare orari ambigui come locali.
- Lo stato ricevuto appare direttamente sotto il titolo, senza ripetere il prefisso “Status:”, e non viene sostituito con la classificazione del tracker o del porto.
- “RADIO & FLAG” e “OBSERVED STATUS” occupano la stessa riga, rispettivamente a sinistra e a destra, con bandiera sotto il callsign; quest’ultimo mostra la classificazione di Rotevista.
- In “TRAJECTORY STABILITY”, dati insufficienti lasciano il valore vuoto e un cambio da confermare appare come “CHANGE?”. Per target non mobili usare “AT ANCHOR” se il pattern osservato è OSCILLATING, altrimenti “STATIONARY”; non dedurre oscillazione dal solo stato AIS.
- I dettagli diagnostici del pattern di sosta e della stabilità sono nascosti normalmente: un tocco su “TRAJECTORY STABILITY” li mostra per 8 secondi, un secondo tocco li richiude. Cambio target o chiusura della scheda li nascondono; nessun effetto sul motore.
- Non aggiungere alla scheda una griglia diagnostica con coordinate, sorgenti e timestamp di ogni misura.
- I dati originali restano disponibili nel modello separatamente dai valori calcolati.

## Riferimenti di implementazione

- [Motore di collisione](../ais/collisionPipeline.js)
- [Default e migrazione configurazione](../ais/collisionConfig.js)
- [Ingestione e gestione età AIS](../ais/aisEngine.js)
- [Stabilità della previsione](../ais/targetPredictionStability.js)
- [Banner condiviso](../session/aisSharedAlerts.js)

## Verifiche e limiti aperti

- Verificare sul campo partenza lenta, jitter da fermi, perdita/ripresa dei dati e incroci con grandi scafi.
- Non confondere test automatici, replay con posizioni mantenute artificialmente ferme e prove su dati reali in navigazione.
- L'affidabilità della previsione resta limitata dalla qualità e dall'età dei dati AIS disponibili.
