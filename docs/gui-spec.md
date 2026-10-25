# Specifiche della GUI

Stato: revisionata e approvata con l'utente il 25 ottobre 2026.
Confrontata con il codice locale della versione 9.4.0-beta.2, incluse le modifiche al popup non ancora pubblicate.
Il documento descrive presentazione e interazioni; le regole del motore restano nelle specifiche dedicate.

## Principi

- Testi nuovi dell'interfaccia in inglese.
- Presentazione compatta: dati operativi subito visibili, dettagli diagnostici accessibili su richiesta.
- Distinguere dati AIS ricevuti, risultati osservati e posizioni previste, senza presentare un valore mancante come una misura reale.
- Non aggiungere guida COLREG ai banner.
- Ispezione, scheda aperta e inquadratura sono locali al dispositivo; modalità e avvisi sono descritti nella [sessione condivisa](shared-session-spec.md).

## Spazio disponibile e dispositivi

- Nel browser adattare la dashboard alla porzione di schermo effettivamente visibile, considerando barre mobili e cambi di orientamento.
- Usare `visualViewport` quando disponibile, con ripiego su `innerHeight`; aggiornare dimensioni e spostamenti al ridimensionamento e alla ripresa della pagina.
- In standalone/fullscreen usare il ramo dedicato a tutta l'area dell'app: il codice attuale imposta altezza `100vh`, larghezza `100%` e origine zero.
- Rispettare le safe area nei controlli e nei contenuti. Lo sfondo può estendersi sotto le aree di sistema, ma i comandi devono restare raggiungibili.
- Il layout Wind deve adattare strumenti e blocchi allo spazio disponibile, evitando il taglio dell'ultima riga e riserve inferiori superflue.
- Fullscreen browser e webapp installata sono modalità distinte. La richiesta fullscreen usa le API del browser; la disponibilità effettiva dipende dal dispositivo.
- In AIS il banner usa la safe area superiore; pannelli e controlli devono tener conto della sua altezza effettiva.
- Il pannello dettagli deve poter scorrere internamente se il contenuto supera lo spazio disponibile.
- Negli schermi bassi in orizzontale compattare i pulsanti e distribuire i controlli verticali senza sovrapporli. Nel ritratto stretto limitare l'altezza del pannello AIS al 60% del contenitore, lasciando mappa visibile.

Questi sono obiettivi del layout e comportamenti implementati, non una garanzia già verificata per ogni combinazione di browser, dimensioni e barre di sistema.

## Navigazione principale

- La dashboard comprende vista Wind e vista AIS.
- Lo swipe orizzontale a due dita passa da Wind ad AIS. In AIS non deve interferire con il pinch della mappa; il ritorno a Wind usa il pulsante dedicato.
- Tocco sull'hotspot centrale Wind: richiesta di ingresso/uscita fullscreen.
- Pressione prolungata di un secondo sull'hotspot: modalità notturna.
- Gli strumenti Wind mantengono le proprie interazioni di selezione e focus; le regole dei valori e dello storico saranno descritte nella specifica Wind.

## Selezione e inquadratura AIS

- Selezionare dalla lista apre i dettagli e inquadra il target nello spazio residuo della mappa.
- Calcolare il centro utile misurando mappa e pannello reali; non scegliere un centro fisso soltanto dall'orientamento.
- Considerare gli ingombri dei controlli laterali, delle informazioni superiori e dei comandi inferiori.
- Gli incontri pericolosi possono essere inquadrati con il triangolo di collisione; gli altri target usano la centratura prevista dal comando.
- Se il popup dettagli è già aperto, il clic su un target diverso ne cambia il contenuto mantenendolo aperto e conservando la scheda corrente.
- Il clic sul target già selezionato mantiene il comportamento di apertura/chiusura esistente. Non estendere la regola precedente a tutti i clic sulla mappa.
- Inspect dal banner apre l'ispezione del target indicato, senza bloccare gli aggiornamenti del banner condiviso.

## Presentazione dei target

- I target fermi nei gruppi riconosciuti sono normalmente pallini, per ridurre l'affollamento visivo.
- Il target selezionato resta riconoscibile e ispezionabile.
- La scia ordinaria mostra un terzo della finestra configurata; il target selezionato mostra l'intera traccia disponibile per l'ispezione.
- L'attenuazione per dati vecchi si applica anche alla lista secondo la politica comune di età; non modifica il livello di rischio calcolato.
- Etichette e posizionamento cercano di ridurre interferenze con vettori e altre etichette; non è garantita l'assenza di sovrapposizioni con molti target.
- Il bearing usa espressioni inglesi con right/left e riferimento a ore, evitando port/starboard.

## Popup Info & dimensions

Conservare l'identità della scheda sintetica, senza trasformarla in una pagina diagnostica permanente.

- Prima riga: dimensioni a sinistra, pescaggio a destra.
- Blocco unico `AIS STATUS (A/B)` per destinazione, ETA e stato trasmesso. Classe nel titolo soltanto se nota.
- Mostrare soltanto le righe utili: omettere campi vuoti, segnaposto e stato non definito. Se resterebbe soltanto la classe, nascondere il blocco.
- Destinazione come ricevuta: non inventare il nome di un porto partendo dal codice.
- ETA con data e ora leggibili in UTC, per esempio `29 Oct, 12:00 UTC`; non interpretare come locali orari privi di fuso.
- Stato ricevuto senza ripetere il prefisso `Status:` sotto il titolo AIS STATUS.
- Riga successiva: `RADIO & FLAG` a sinistra, callsign sopra e bandiera sotto; `OBSERVED STATUS` a destra.
- Lo stato osservato deriva dal motore e non sostituisce lo stato trasmesso.
- Il collegamento VesselFinder resta disponibile per i contatti reali.

## Stabilità e diagnostica temporanea

Il blocco `TRAJECTORY STABILITY` mostra:

| Condizione | Testo |
| --- | --- |
| Movimento coerente | STABLE |
| Variazioni ripetute osservate | VARIABLE |
| Cambio da confermare | CHANGE? |
| Target non mobile con pattern OSCILLATING | AT ANCHOR |
| Altro target non mobile | STATIONARY |
| Dati insufficienti | Valore vuoto |

- La stabilità descrive il movimento osservato, non il livello di pericolo.
- Non dedurre oscillazione dal solo stato AIS anchored.
- Un tocco espande i dettagli diagnostici per 8 secondi; un altro tocco li richiude subito.
- I dettagli includono pattern di sosta, fix, intervallo osservato, raggio e ritorni quando disponibili; l'analisi della previsione mostra campioni, confronti, errore e crescita d'incertezza disponibili.
- Cambiando target o smontando la scheda, i dettagli tornano nascosti e il timer viene eliminato.
- La visualizzazione diagnostica non modifica osservazioni, soglie o allarmi.

## Banner e pulsanti di riconoscimento

- Conservare gli spazi dei pulsanti mentre la logica ne cambia la visibilità, per evitare spostamenti durante un tocco.
- Durante l'ispezione il comando di riconoscimento agisce dal popup sul target selezionato; nel banner resta Inspect.
- Il comando nel popup occupa la larghezza disponibile.
- La logica temporale di snooze, acknowledge e scelta del banner è definita nella [sessione condivisa](shared-session-spec.md).

## Menu, debug e supporto

- L'URL normale apre la dashboard, senza imporre un menu al primo accesso.
- `?menu=1` apre il menu speciale di modalità; il cambiamento di modalità è condiviso sul relativo server.
- `?layoutDebug=1` abilita la diagnostica del layout sul dispositivo interessato.
- Il pulsante `$` apre Feedback & Support.
- Il popup di supporto si apre automaticamente una volta per versione e per memoria locale del browser. Un altro dispositivo o la cancellazione dello storage possono farlo riapparire.
- Se lo storage locale non è disponibile, evitare riaperture automatiche continue e mantenere l'accesso manuale.

## Riferimenti e verifiche ancora da fare

- [Gestione del viewport](../src/hooks/useViewportHeight.ts)
- [Vista AIS e interazioni](../src/components/AisView.tsx)
- [Area residua della mappa](../src/utils/mapViewport.mjs)
- [Blocco AIS compatto](../src/components/AisStatusInfo.tsx)
- [Stabilità e timer diagnostico](../src/components/AisTrajectoryStability.tsx)
- [Stili adattivi](../src/style.css)
- [Test area mappa](../test/mapViewport.test.js), [posizionamento etichette](../test/aisLabelPlacement.test.js) e [dati ricevuti/formattazione](../test/aisReportedData.test.js).

Prima del prossimo rilascio verificare visivamente le ultime modifiche al popup su telefono e tablet, in entrambe le orientazioni: cambio target, righe mancanti, testo lungo, scroll e richiusura dopo 8 secondi. Riprovare Safari con barre visibili e webapp standalone. TypeScript e build riusciti non equivalgono a una prova su questi dispositivi.

## Dati della propria barca nella vista AIS

- Risolvere la prua come Wind: magnetica + WMM, poi vera ricevuta, infine COG con SOG sufficiente. Non leggere direttamente la sola prua vera. Preservare 0° come misura valida.
- Posizione, prua, COG e SOG scadono indipendentemente dopo 5 secondi dal rispettivo timestamp sorgente; nessun dato mancante diventa zero. STW non sostituisce SOG nel vettore geografico.
- Prima di un fix GPS non disegnare un'icona della propria barca alle coordinate iniziali della mappa. La posizione iniziale è solo un centro di presentazione.
- Alla scadenza GPS conservare l'ultima posizione nota come punto grigio con indicazione GPS stale, senza vettori, ghost o cerchi centrati sulla propria barca. Sospendere inseguimento e triangolo di collisione basati su quella posizione; resta possibile ispezionare un target.
- Con posizione valida ma prua non disponibile usare un punto senza orientamento. I vettori richiedono posizione, COG e SOG validi.
- Lo scafo segue la prua; il vettore geografico e lo spostamento della ghost seguono il COG, con distanze calcolate dalla SOG. La ghost conserva l’orientamento di prua dello scafo. Le rotazioni restano indipendenti anche attraversando 0°/360°.
- Nella lista usare `---°` per prua assente, `--.-` per velocità assente e indicare GPS non disponibile/scaduto invece di mostrare una barca ferma per mancanza del dato.

Verifiche: [navigazione della propria barca](../test/ownShipNavigation.test.js).

## Età AIS in ore

- Per età da un'ora in su, convertire minuti in ore dividendo per 60: 3600 secondi → `1H AGO`, 7200 → `2H AGO`. Condividere il formato fra scheda target, etichette e lista.
