# Specifiche del motion tracker

Stato: revisionata e approvata con l'utente il 25 ottobre 2026.
Verificata sul codice locale il 25 ottobre 2026, versione 9.4.0-beta.0.

## Scopo

Distinguere uno spostamento reale da jitter AIS e movimenti confinati in una zona di sosta, anche quando la velocità riportata ha picchi occasionali.

Il tracker descrive il movimento e la sosta di ogni target. Non assegna direttamente l'etichetta di porto: HarborDetector combina queste evidenze con quelle degli altri target e con lo stato AIS dichiarato.

## Quali dati possono diventare osservazioni

- Usare soltanto posizioni ricevute, valide e ordinate temporalmente.
- Non usare posizioni proiettate come nuovi fix.
- Non contare più volte la stessa posizione sorgente quando il server la rilegge.
- Un nuovo nome, una dimensione o uno stato AIS non costituiscono una nuova posizione.
- Non aumentare il numero di campioni o la durata osservata soltanto perché passa il tempo.
- Conservare separatamente il timestamp sorgente, anche quando un timestamp leggermente futuro viene limitato per l'elaborazione.

## Stato del movimento

| Stato interno | Significato |
| --- | --- |
| `STATIONARY` | Posizione confinata nell'area di riferimento |
| `POSSIBLE_MOVEMENT` | Uscita dall'area ancora da confermare |
| `MOVING` | Movimento reale riconosciuto |

Alla prima osservazione, senza indicazioni di ormeggio o ancoraggio, la soglia iniziale di movimento è 0,8 kn. Le osservazioni successive possono riconoscere una partenza anche a velocità inferiori: non classificare definitivamente una barca come ferma in base alla sola SOG.

### Riconoscimento della sosta

- Per passare da movimento a sosta, richiedere almeno 3 fix nuovi distribuiti su almeno 120 secondi e confinati entro 25 m dal riferimento usato dal tracker.
- Il raggio iniziale è 25 m; con indicazione di ancoraggio è 60 m.
- Un picco di velocità senza spostamento coerente non deve far partire una barca virtualmente.

### Riconoscimento della partenza

- Mantenere fermo il riferimento: non trascinarlo dietro a una barca che si allontana lentamente.
- Oltre il raggio di riferimento più 10 m, passare a possibile movimento.
- Confermare la partenza con almeno 2 fix progressivi, almeno 10 secondi e almeno 10 m di avanzamento tra i fix della partenza candidata.
- Un ritorno verso l'area non conferma una partenza.
- Una vera partenza azzera l'evidenza di instabilità accumulata dal jitter durante la sosta.
- Le escursioni che rientrano possono insegnare un'area confinata: massimo appreso 40 m senza indicazione di ancoraggio e 80 m con indicazione di ancoraggio.

## Descrizione della sosta: `restPattern`

Questa descrizione è distinta dallo stato di movimento. Una barca può essere `STATIONARY` ma non avere ancora un pattern di sosta confermato.

Per confermare il pattern servono almeno 5 fix validi distribuiti su almeno 120 secondi. Un'interruzione fra posizioni superiore a 360 secondi fa ripartire la raccolta dell'evidenza di sosta, senza dichiarare automaticamente una partenza.

| Pattern | Regola attuale |
| --- | --- |
| `UNDETERMINED` | Evidenza insufficiente oppure geometria non ancora classificabile |
| `FIXED` | Pattern confermato con raggio massimo di 12 m attorno al centro osservato |
| `OSCILLATING` | Pattern confermato con raggio di almeno 20 m e almeno 2 ritorni dopo escursioni |

Per contare un ritorno, la sequenza deve allontanarsi almeno 20 m dal primo punto utile e rientrare entro 10 m da quel riferimento.

- Il centro è il centro delle posizioni osservate, non la posizione fisica dell'ancora.
- Escludere dalla descrizione le posizioni esterne all'area di riferimento oltre il margine di partenza e limitare l'effetto degli outlier.
- La descrizione della sosta non deve ampliare da sola l'area usata per riconoscere il movimento.
- `FIXED` è compatibile con ormeggio, ma non ne è una prova individuale assoluta.
- `OSCILLATING` è un'evidenza utilizzabile da HarborDetector per riconoscere ancoraggio e correggere un precedente contributo all'area portuale.
- Un tempo osservato lungo con soli 4 fix non soddisfa il requisito dei 5 fix.

## Indizio di ormeggio dal vento: `windMooring`

Usare posizione ferma e prua stabile rispetto a vento misurato per rafforzare l'ipotesi di ormeggio. Non sostituire con questo indizio il riconoscimento del movimento.

| Parametro | Valore iniziale |
| --- | ---: |
| Pattern di sosta confermato | Obbligatorio |
| Intervallo osservato fra heading utili | Almeno 5 minuti |
| Heading AIS distinti per timestamp | Almeno 3 |
| Vento vero minimo | 6 kn |
| Scostamento heading dal primo heading utile | Entro 15° |
| Distanza angolare vento-prua | Almeno 45°, inclusa la poppa |
| Variazione del vento che rafforza l'indizio | Almeno 30° |
| Età massima delle misure correlate | 180 secondi |
| Distanza massima del target dalla nostra misura del vento | 1 NM |

- Usare heading AIS valido, non COG.
- Trattare gli angoli in modo circolare: 359° e 1° sono vicini.
- Non contare più volte lo stesso timestamp dell'heading.
- Heading e misure di vento devono essere recenti e compatibili con il fix; non usare misure future rispetto al fix.
- Non usare come vento il ripiego sulla nostra prua quando manca la misura.
- L'indizio diventa forte se la prua resta stabile mentre il vento cambia di almeno 30°.
- In assenza di nuove misure l'indizio non matura; quando le misure diventano vecchie non deve continuare a essere presentato come disponibile.
- Corrente, cima a terra, doppia ancora, vento locale diverso e heading errato limitano l'affidabilità dell'indizio. Non rappresenta una certificazione di ormeggio.

## Storico privato e scia visualizzata

- Il tracker conserva osservazioni anche dei target fermi, necessarie a descrivere la sosta; non mostrare automaticamente tutte queste tracce sulla mappa.
- Storico privato delle osservazioni: finestra di 15 minuti, massimo 120 punti.
- Scia: durata impostata dalla configurazione del plugin, massimo 60 punti.
- Comprimere gli aggiornamenti troppo frequenti senza limitarsi a conservare gli ultimi 60 fix: preservare gli estremi temporali e privilegiare i cambiamenti della traiettoria.
- Nella GUI mostrare normalmente un terzo della finestra configurata; quando il target è selezionato, mostrare tutta la scia disponibile nella finestra.
- Una finestra richiesta non garantisce copertura completa se i dati non sono stati ricevuti.
- Eliminare lo stato dei target rimossi dalla cache del motore.

## Limiti e sviluppi non ancora implementati

- Il riconoscimento automatico della nostra barca all'ancora non è ancora collegato al tracker dei target.
- Non trasformare questi pattern in un sistema di sorveglianza dell'ancoraggio con riarmi automatici: non è l'obiettivo concordato.
- Le soglie sono parametri iniziali modificabili all'inizio di `ais/targetMotionTracker.js`; nuovi valori richiedono verifica e aggiornamento della specifica.

## Riferimenti

- [Tracker](../ais/targetMotionTracker.js)
- [Stabilità della previsione](../ais/targetPredictionStability.js)
- [Integrazione AIS](../ais/aisEngine.js)
- [Visualizzazione dei target e delle scie](../src/components/AisView.tsx)
- [Specifiche AIS e collisioni](ais-spec.md)

## Movimento della nostra barca

- Riutilizzare `TargetMotionTracker` tramite [OwnMotionState](../ais/ownMotionState.js), con un’unica istanza condivisa: ogni identificativo mantiene il proprio storico. La chiave riservata `self` contiene la nostra barca; il modulo OwnMotionState interpreta soltanto il risultato, senza creare un altro tracker.
- I fix provengono dalla posizione propria con timestamp sorgente originale; le letture duplicate nei cicli della sessione e del motore non aggiungono osservazioni. Richiedere coordinate valide e posizione recente secondo `positionMaxAgeMs`.
- La sosta confermata abilita la politica collisione al 25%; la sola prima classificazione STATIONARY non basta. Mantenere la conferma durante POSSIBLE_MOVEMENT e revocarla con MOVING confermato. La distinzione FIXED/OSCILLATING non è un prerequisito della riduzione.
- Il contesto PORT viene soltanto letto dai poligoni già appresi dagli altri target: la nostra barca non alimenta HarborDetector. Nessuna persistenza su disco.
- Usare le soglie comuni, senza introdurre un nuovo algoritmo di classificazione. Per GPS scaduto non usare la sosta osservata come conferma attuale; dopo una lunga interruzione ripartire dall’osservazione iniziale.

Verifiche: [tracker proprio](../test/ownMotionState.test.js).
