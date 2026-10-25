# Specifiche di HarborDetector

Stato: revisionata e approvata con l'utente il 25 ottobre 2026.
Verificata sul codice locale il 25 ottobre 2026, versione 9.4.0-beta.1.
Non tutte le installazioni sul Cerbo hanno necessariamente questa versione.

## Significato delle aree

- `PORT`: contesto portuale o gruppo di ormeggi fissi riconosciuto dai target.
- `ANCHORAGE`: gruppo riconosciuto di piccole barche all'ancora o con oscillazione osservata.
- `PROVISIONAL`: area di sosta osservata, con evidenza ancora insufficiente per distinguerne il tipo.

Il perimetro rappresenta un contesto di navigazione, non un confine amministrativo o una certificazione di navigabilità.
Un canale interno e pontili con pochi AIS possono essere compresi nel porto.
Il rilevatore non consulta cartografia terra/acqua: un rimessaggio con target fissi può essere riconosciuto come porto, ma non viene identificato esplicitamente come area a terra.

## Filosofia concordata

- Non generare una sequenza di allarmi di incrocio verso tutte le barche ferme quando ci avviciniamo a un porto o a un ancoraggio riconosciuto.
- Per questi target usare la separazione attuale nella safe bubble, mantenendo la normale valutazione collisione per i target mobili.
- Non applicare questo rilassamento a una rada di grandi navi all'ancora: restano ostacoli individuali.
- Non basare il riconoscimento dell'area sulla nostra velocità.
- Porto e ancoraggio non si fondono per la sola vicinanza. Un'area può essere riclassificata quando nuove evidenze ne giustificano il cambio di tipo.
- La formazione o l'estensione del porto non sono ingressi nella bubble: applicare le regole sulle presenze iniziali e sull'isteresi definite nelle [specifiche AIS](ais-spec.md).

## Evidenze utilizzate

- Stato del movimento e pattern di sosta forniti da TargetMotionTracker.
- Stato AIS effettivamente dichiarato, distinguendolo dalle etichette già dedotte dal rilevatore.
- Indizio di ormeggio rispetto al vento e sua eventuale conferma forte.
- Posizioni relative e densità dei gruppi di barche ferme.

Con motion tracker disponibile, il codice considera candidati i target non `MOVING`, compresi quelli in `POSSIBLE_MOVEMENT`. Senza tracker usa la combinazione di movimento, velocità e stato disponibile.
Se il pattern è confermato, la posizione usata per apprendere l'area è il suo centro; altrimenti è la posizione ricevuta.

L'appartenenza a un porto non deve diventare, da sola, nuova evidenza indipendente di ormeggio: evitare un'espansione circolare basata sulle nostre stesse etichette.

## Formazione dei gruppi: distanze attuali

Sono distanze tra posizioni o centri di sosta osservati, non tra gli scafi. Le regole sono applicate in ordine di evidenza.

| Condizione della coppia | Collegamento |
| --- | ---: |
| Entrambe compatibili con ancoraggio e lunghezza massima non superiore a 40 m | 180 m |
| Una con evidenza di ancoraggio e l'altra senza | Nessun collegamento diretto |
| Entrambe con forte evidenza di ormeggio, senza evidenza di ancoraggio | 120 m |
| Entrambe con indizio di ormeggio dal vento, senza evidenza di ancoraggio | 120 m |
| Entrambe con pattern `FIXED` confermato | 95 m |
| Altrimenti, almeno una lunga almeno 20 m | 90 m |
| Altrimenti | 45 m |

I piccoli target osservati ma non assegnati possono anche formare gruppi più radi entro 180 m, mantenendo separati quelli con evidenza di ancoraggio da quelli senza.
La riduzione a 120 m di questo collegamento provvisorio è stata discussa, ma non è implementata.

### Classificazione del gruppo

La classificazione attuale richiede almeno due membri per creare un gruppo accettato:

- `ANCHORAGE`: almeno 2 membri con stato all'ancora o oscillazione confermata, e almeno il 60% del gruppo con tale evidenza.
- `PORT`: stato AIS di ormeggio presente nel gruppo, oppure gruppo compatto con almeno 2 evidenze fisse/da vento e maggioranza del 60%.
- Un gruppo compatto può diventare `PORT` anche se una coppia di target dista al massimo 20 m: è il riconoscimento rapido di un possibile pontile.
- In assenza delle condizioni precedenti, almeno 3 membri con evidenza osservata di sosta/ancoraggio possono dare `PROVISIONAL`.

Non è quindi obbligatorio passare sempre prima da ancoraggio o area provvisoria per arrivare a porto.

## Estensione con una singola barca

- Un target fisso confermato, dichiarato ormeggiato o con indizio di ormeggio dal vento può estendere un porto esistente.
- Distanza ordinaria dai punti appresi: 120 m.
- Con sosta confermata e stato AIS `moored`, oppure forte indizio dal vento: 180 m.
- Escludere i target dichiarati all'ancora o con oscillazione confermata.
- Non richiedere che la barca sia già etichettata `IN PORT` per poterla usare nell'estensione.

Per l'appartenenza finale, un target fermo e compatibile può essere incluso se è dentro il poligono o vicino ai punti appresi secondo il margine di appartenenza, ordinariamente 45 m. Negli ancoraggi si considera anche il raggio di oscillazione appreso.

Limite attuale: per aggiungere una singola barca esterna si misura la distanza dai punti appresi, non la distanza dal bordo del poligono. Essere visivamente vicino al bordo non garantisce l'inclusione.

## Fusione di aree già riconosciute

- Porti: fondere quando la distanza minima tra i bordi dei poligoni è al massimo 200 m, compresi sovrapposizione e contenimento.
- Ricalcolare l'inviluppo comune: anche lo spazio fra i due blocchi entra nel contesto portuale.
- Ancoraggi: il criterio attuale resta 180 m tra punti appresi, non 200 m tra bordi.
- Aree provvisorie: collegamento tra punti appresi entro 120 m.
- Fondere soltanto aree dello stesso tipo; non fondere direttamente porto e ancoraggio per vicinanza.
- Ripetere le fusioni possibili senza dipendere dall'ordine di inserimento delle aree, rispettando i limiti di memoria.
- La riclassificazione per nuove evidenze è distinta dalla fusione geometrica. Il codice può riutilizzare l'identità di un'area quando il cambiamento è sostenuto dalla maggioranza dei suoi membri appresi.

## Correzione di una precedente classificazione portuale

Se un target viene poi dichiarato all'ancora o sviluppa un pattern `OSCILLATING` confermato:

1. Togliere il suo contributo ai punti appresi del porto e ricalcolare il perimetro.
2. Preservare il contributo delle altre barche che sostengono un punto condiviso.
3. Rimuovere l'etichetta di ormeggio ereditata e trattarlo come all'ancora, quando fermo.
4. Non riassorbirlo nel porto solo perché resta dentro il poligono formato dagli altri ormeggi.

Non sottrarre un cerchio arbitrario dal porto: si rimuove l'evidenza della barca, non una porzione di carta scelta senza osservazioni.
Il poligono può rimanere invariato se il punto rimosso era interno all'inviluppo degli altri punti.
Un singolo salto AIS non deve equivalere a oscillazione confermata.

## Memoria e geometria

- Apprendimento locale entro 2 NM dalla nostra barca.
- Rimozione delle aree oltre 25 NM.
- Massimo 600 punti appresi e identità conservate per area.
- Deduplicazione dei punti vicini entro 10 m e padding geometrico di 18 m.
- Negli ancoraggi, il raggio di oscillazione può contribuire al bordo, con limite di 80 m.
- Conservare in RAM i punti appresi anche se una barca riparte: un posto di ormeggio osservato non sparisce automaticamente con il target.
- La memoria appresa non è salvata su disco; un nuovo processo del server ricostruisce le aree dai dati ricevuti.

## Proposte non implementate

- Due taglie complete di distanze portuali, con soglie dedicate per barche sotto 40 m e navi da 40 m, per esempio il traghetto da 80 m.
- Distanza dal bordo del porto per l'estensione con una singola barca.
- Riduzione del collegamento provvisorio fra piccole barche da 180 m a 120 m.

Le prove indicative ispirate agli screenshot di Preveza non sono una ricostruzione georeferenziata dei suoi target.
Il replay dei target reali di Marina di Ragusa distingue le posizioni catturate dalle conferme di ormeggio e dalle posizioni successive generate artificialmente.

## Riferimenti

- [HarborDetector e parametri](../harborDetector.js)
- [Motion tracker](motion-tracker-spec.md)
- [Politica collisioni e prossimità](ais-spec.md)
- [Test delle aree](../test/harborDetector.test.js)
- [Test della prossimità portuale](../test/harborProximity.test.js)
