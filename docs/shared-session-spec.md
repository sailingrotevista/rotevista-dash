# Specifiche della sessione condivisa

Stato: revisionata e approvata con l'utente il 25 ottobre 2026.
Confrontata con il codice locale della versione 9.4.0-beta.2, incluse le modifiche non ancora pubblicate.
Questa specifica descrive il comportamento attuale; non introduce nuove funzioni.

## Obiettivo e confini

Tutti i dispositivi collegati allo stesso server condividono modalità, scenario e selezione del banner. Snooze e acknowledge eseguiti da un dispositivo valgono per gli altri.

- Il server è la fonte autorevole. I client non scelgono autonomamente il target del banner condiviso.
- Ispezione, target selezionato, posizione/zoom della mappa e layout debug restano locali.
- Un dispositivo può quindi ispezionare una barca mentre un altro ne ispeziona un'altra, pur ricevendo lo stesso banner.
- La sincronizzazione avviene con aggiornamenti periodici, normalmente ogni secondo: non è un aggiornamento simultaneo garantito al millisecondo.
- Uno schermo sospeso o scollegato può mostrare dati precedenti fino alla ripresa della comunicazione.

## Modalità condivise

L'URL normale apre la modalità corrente del server. Il menu speciale `?menu=1` permette di cambiarla per tutti i dispositivi collegati a quel server.

| Modalità | Dati propri | Target |
| --- | --- | --- |
| Live | Reali | Reali |
| Simulation | Simulati | Simulati |
| Live + simulated targets | Reali | Reali più quattro contatti simulati |

- Un nuovo dispositivo si unisce allo scenario già in corso, senza riavviarlo.
- I contatti sintetici hanno identità `sim:` e indicazione di simulazione; non vengono scritti nell'albero di navigazione Signal K.
- In modalità mista le valutazioni dei target reali sono mantenute; i contatti aggiunti usano una finestra base di simulazione di 5 minuti.
- La modalità mista attende una posizione propria reale utilizzabile. Se il timestamp disponibile della posizione supera 30 secondi, rimuove i contatti sintetici e attende dati nuovi.
- Cambiare modalità crea una nuova generazione dello scenario e ricrea lo stato degli avvisi simulati. Scegliere la modalità già corrente non riavvia lo scenario.
- Tornare a Live rimuove i contatti sintetici e riutilizza lo stato degli avvisi reali mantenuto dal server.
- Il layout debug rimane un'opzione locale, anche quando viene aperto dal menu.

## Banner autorevole

- Il server sceglie il banner secondo priorità e isteresi definite nelle [specifiche AIS](ais-spec.md).
- Un concorrente di pari gravità deve mantenere la priorità per 10 secondi prima di sostituire il banner corrente; un'escalation è immediata.
- Se il banner corrente viene silenziato o non è più candidato, la selezione successiva non attende quei 10 secondi.
- Per la prossimità viene scelto il contatto non riconosciuto con la minima separazione attuale fra gli scafi. Il cambio fra rappresentanti di prossimità non usa l'attesa dei concorrenti collisione.
- Le misure del banner continuano ad aggiornarsi durante l'attesa.
- Il comando snooze del banner diventa disponibile dopo 3 secondi dalla comparsa o dal cambio di identità, gravità o tipo dell'avviso.
- Il tempo di disponibilità è fornito dal server, per evitare conteggi indipendenti sui dispositivi.

## Ispezione e comandi

- Inspect apre localmente i dettagli del target indicato dal banner.
- Durante l'ispezione, il comando snooze/acknowledge è nel popup del target; il corrispondente comando del banner è nascosto mantenendone lo spazio.
- Il banner può continuare a cambiare: il comando nel popup resta associato al target ispezionato.
- Inspect su un nuovo banner cambia il target dell'ispezione locale.
- Ogni azione invia identità del target, gravità e tipo di avviso attesi, oltre all'identificativo della sessione.
- Il server rifiuta un'azione se il target o la sessione non corrispondono più. Non trasferire mai un clic al nuovo target del banner.

## Snooze collisione

- Durata ordinaria: 10 minuti, condivisa fra i dispositivi.
- Due richieste concorrenti equivalenti non devono prolungare uno snooze già attivo.
- Una nuova escalation da arancione a rosso interrompe lo snooze dell'arancione.
- Se il rischio rientra o il target viene rimosso, il relativo snooze viene eliminato.
- Se il contatto viene perso mentre era silenziato, la sola scadenza del timer non deve riattivarlo. Alla ricezione di una nuova posizione riprende la valutazione normale.

## Acknowledge prossimità

- Un acknowledge riconosce in un'unica azione le prossimità attualmente presenti, non soltanto il rappresentante nel banner.
- Una nuova barca che genera successivamente un ingresso osservato nella bubble può produrre un nuovo avviso, anche se è più lontana di una barca già riconosciuta.
- Non riarmare una barca riconosciuta per il solo jitter o per uscita/rientro nella stessa sosta.
- Eliminare il riconoscimento quando il target risulta mobile, quando la nostra barca si allontana oltre 2 NM dal riferimento memorizzato o dopo 24 ore senza il target.
- Le presenze iniziali già nella bubble sono gestite dal tracker degli ingressi: non creare acknowledge automatici per nasconderle.
- Il comando di ripristino avvisi cancella snooze e acknowledge condivisi. Non trasforma una presenza iniziale in un nuovo ingresso osservato.

## Memoria e riavvii

- Modalità, scenario, banner, snooze e acknowledge risiedono in RAM; non è prevista persistenza su disco.
- Un riavvio del processo ricrea la sessione, torna in Live e perde i riconoscimenti precedenti.
- Un normale aggiornamento dello stato non equivale a una nuova sessione.
- La pulizia dei riconoscimenti evita di conservare indefinitamente contatti assenti.
- Le azioni riferite a una sessione precedente vengono rifiutate; il client deve prima ricevere quella corrente.

## Connessioni lente, sospensione ed errori

- Alla ripresa della pagina o della connessione, richiedere lo stato corrente e scartare risposte obsolete delle generazioni precedenti.
- Durante una richiesta di controllo impedire clic ripetuti sul comando in attesa.
- Timeout del comando: 5 secondi. Non ritentare automaticamente un'azione senza conferma.
- Se la risposta viene persa dopo l'invio, l'azione potrebbe essere stata applicata: mostrarne l'incertezza e verificare lo stato sincronizzato.
- Non sostituire un errore del server con uno snooze o acknowledge soltanto locale.

## Accesso ai controlli

- Chi può accedere alla dashboard sulla rete può usare i controlli condivisi; non è richiesta la password amministrativa Signal K.
- La dashboard ottiene una chiave temporanea in RAM e la invia con le azioni. Questo non concede accesso alle impostazioni amministrative.
- Le richieste browser provenienti da origini diverse vengono rifiutate; risposte di accesso non memorizzabili in cache e invii JSON limitati proteggono il canale dei controlli.
- Non considerare questa chiave un'autenticazione personale: il confine di accesso resta la rete che espone la dashboard.

## Separazione sviluppo / installazione

- Dev e preview hanno una propria sessione, scenario e riconoscimenti, separati dal plugin installato su Signal K.
- Il backend di sviluppo legge i dati reali dal Cerbo con richieste GET; non inoltra cambi modalità, snooze o acknowledge al Cerbo.
- I dispositivi connessi al dev condividono soltanto la sessione dev; quelli connessi al plugin condividono la sessione installata.
- Le modifiche ai moduli del backend di sviluppo richiedono il riavvio del dev server.

## Riferimenti e verifiche

- [Coordinatore della sessione](../session/dashboardSession.js)
- [Stato degli avvisi e controlli](../session/aisSharedAlerts.js)
- [Backend di sviluppo](../dashboardDevServer.js)
- [Richieste dei comandi dal client](../src/utils/sharedAlertRequest.mjs)
- [Test della sessione](../test/dashboardSession.test.js), [avvisi condivisi](../test/sharedAlerts.test.js), [errori delle richieste](../test/sharedAlertRequest.test.js) e [ripresa dei client](../test/dashboardRecovery.test.js).

Le prove automatiche non sostituiscono la verifica su dispositivi reali con sospensione, perdita di rete e clic concorrenti. Non è garantita identica visualizzazione durante un'interruzione della comunicazione.

## Propulsione condivisa

- `propulsionMode`: AUTO / SAIL / MOTOR, autorevole nella DashboardSession e incluso in ogni frame. Il pulsante cicla AUTO → SAIL → MOTOR → AUTO.
- Modifiche tramite POST `/rotevista-propulsion-mode`, con gli stessi controlli di origine, token e sessione degli avvisi. Valori non ammessi o sessioni scadute vengono rifiutati.
- Tutti i dispositivi ricevono la scelta al successivo polling; nessun aggiornamento ottimistico o ripiego locale in caso di errore. I vecchi valori localStorage non sono utilizzati.
- Stato esclusivamente in RAM, AUTO al riavvio. Cambiare live/simulation/mixed non cambia la selezione. Il dev possiede una sessione indipendente e non scrive sul Cerbo.
- Per ora il nuovo stato controlla il suono di strambata; non cambia gli allarmi AIS o profondità del server.

## Recupero completo Wind dopo una pausa

- Il passaggio fra AIS e Wind mantiene acquisizione e aggregazione attive.
- Il polling confronta `serverNow` dei frame elaborati: con più di 5 secondi senza aggiornamenti, richiede lo storico completo. Lo richiede anche al primo collegamento, al cambio generazione e su visibilità/focus/ritorno rete.
- L'età del singolo sensore non forza download ripetuti: un sensore spento resta non disponibile.
- In Live e Mixed recuperare grafici (inclusi array vuoti e interruzioni), medie angolari, storico lungo TWD, radar e previsione. Simulation non importa lo storico reale.
- Richieste senza cache, timeout 4 secondi; una sola richiesta storico in corso e almeno 10 secondi fra tentativi. Su errore il recupero rimane pendente.
- Applicare la risposta solo alla stessa generazione; risposte di sessioni precedenti non devono sovrascrivere quella attuale.

## Unica istanza degli avvisi Live

- Nel plugin installato `DashboardSession.liveAlerts` usa la stessa istanza di `AisEngine.sharedAlerts`, passata esplicitamente alla creazione della sessione. Non mantenere due stati Live indipendenti.
- Dashboard, comandi, endpoint AIS/storico e delta `environment.ais_shared_alerts` condividono identità di sessione, revisioni, banner, snooze e acknowledge Live. Il timer pubblica il medesimo stato senza una seconda valutazione dedicata al delta.
- Simulation e Mixed usano una propria istanza; tornare in Live recupera quella originale. Gli endpoint precedenti continuano a rappresentare Live anche durante la simulazione.
- Il dev crea e gestisce la propria istanza Live; non acquisisce né modifica l'istanza del Cerbo.

## Sosta propria condivisa

- I frame includono `ownMotion`, calcolato dal motore AIS sul server tramite la voce riservata della nostra barca nell’unico tracker condiviso con i target AIS. La sessione installata riusa questo stato senza istanziare altri tracker. La lettura dei frame può acquisire un nuovo fix sorgente ma non trasformare riletture o proiezioni in nuove osservazioni.
- La modalità mista riusa la sosta Live per le soglie dei target simulati; la modalità di simulazione pura espone movimento simulato e non cambia il tracker Live. Il server dev usa l’informazione Live se disponibile, altrimenti osserva localmente i fix ricevuti senza scrivere sul Cerbo.
