# Specifiche Wind

Stato: revisione progressiva con l'utente, iniziata il 25 ottobre 2026.
Solo le decisioni riportate sotto sono state concordate. Gli altri dati Wind devono ancora essere esaminati uno alla volta.

## AWS: velocità del vento apparente

Decisione concordata: scadenza dopo 15 secondi senza un nuovo dato valido.

- Sorgente: `environment.wind.speedApparent` della nostra barca via Signal K, in m/s; visualizzazione in nodi con una cifra decimale.
- Zero è un valore valido esclusivamente quando ricevuto. Un dato mai ricevuto, invalidato o scaduto viene mostrato come `—`, sia nello strumento centrale sia nel riquadro impostato su AWS.
- Accettare solo numeri finiti fra 0 e 51,44 m/s; un valore invalido non rinnova l'età. Un reset esplicito null rende il dato indisponibile.
- Usare il timestamp sorgente quando disponibile; in sua assenza il tempo di ricezione. Un pacchetto precedente non sostituisce un dato più recente.
- Nuove misure uguali alla precedente rinnovano l'età; riletture con lo stesso timestamp non la rinnovano.
- Soglia condivisa fra server e GUI in [windDataPolicy.json](../windDataPolicy.json): `awsMaxAgeMs = 15000`. A 15 secondi il dato è scaduto; la visualizzazione segue il normale ciclo di aggiornamento di un secondo.
- Quando AWS è scaduto, interrompere nuovi calcoli di ripiego di TWS/TWA/TWD che lo richiedono. La validità autonoma dei dati reali ricevuti e la presentazione dei valori derivati saranno approfondite nei rispettivi passaggi della revisione.
- Non aggiungere nuovi campioni allo storico AWS usando il valore scaduto. Conservare lo storico già acquisito.
- Un nuovo AWS valido ripristina la visualizzazione e permette nuovamente i calcoli.

Riferimenti: [motore Wind](../windEngine.js), [GUI](../src/hooks/useDashboard.ts), [test della validità AWS](../test/windAwsValidity.test.js).

## AWA: angolo del vento apparente

- Sorgente: `environment.wind.angleApparent`, in radianti. Visualizzazione in gradi.
- Ogni nuova misura AWA alimenta direttamente le proprie medie, anche quando AWS manca e il vento reale non è calcolabile.
- Aggiornamenti di AWS, prua o velocità non aggiungono campioni AWA duplicati.
- Freccia con media circolare breve, valore MEAN con media lunga configurata; zero ricevuto è valido.
- Scadenza dopo 15 secondi dal timestamp della misura valida: valore `—` e freccia AWA nascosta. Reset null rende il dato indisponibile; dati invalidi o precedenti non rinnovano l'età.
- AWA scaduto non deve alimentare il calcolo di ripiego del vento reale, anche con AWS recente.
- La soglia `awaMaxAgeMs` risiede in [windDataPolicy.json](../windDataPolicy.json).

Verifiche automatiche: [validità e indipendenza AWA](../test/windAwaValidity.test.js).

## TWS: velocità del vento reale

- Preferire `environment.wind.speedTrue` ricevuto, mantenendo la priorità nativa attuale di 5 secondi (`twsNativeMaxAgeMs`). Un TWS nativo recente è utilizzabile anche senza AWS/AWA.
- Tenere separati il valore ricevuto e quello calcolato: il ripiego non deve sovrascrivere una misura associata al timestamp nativo.
- In assenza di TWS nativo recente, calcolare il modulo del vettore vento apparente meno il movimento della barca, con AWS/AWA validi entro 15 secondi.
- Conservare la scelta attuale della velocità: STW recente, altrimenti SOG; se entrambe mancano, assumere velocità zero e ottenere TWS = AWS. Questo ripiego è concordato dall'utente.
- Se non ci sono né TWS nativo recente né ingressi validi per il ripiego, mostrare `—` e non produrre nuovi campioni TWS nello storico. Un valore zero ricevuto o calcolato resta valido.
- Eseguire i calcoli in m/s e convertire in nodi per la visualizzazione. Il numero mostrato è il valore corrente; la modalità di aggregazione del grafico resta distinta e sarà revisionata separatamente.
- Ripresa degli ingressi e ritorno del TWS nativo aggiornano automaticamente il valore mostrato.

Verifiche automatiche: [validità e transizioni TWS](../test/windTwsValidity.test.js).

## TWA: angolo del vento reale

- Preferire il TWA ricevuto da `environment.wind.angleTrueWater` entro 5 secondi (`twaNativeMaxAgeMs`), anche senza AWS. Ogni nuova misura alimenta autonomamente le medie circolari breve e lunga; zero ricevuto è valido.
- Conservare il timestamp sorgente e separare il dato ricevuto dal ripiego calcolato. Duplicati, misure precedenti e valori invalidi non sono nuove osservazioni; null invalida il dato.
- Senza TWA nativo recente, ricostruire l'angolo dal vettore AWS/AWA meno la velocità della barca, con gli stessi ingressi e criteri del TWS. Senza velocità barca, TWA coincide con AWA purché il vettore non sia nullo.
- Se il modulo del vettore ricostruito è al massimo 0,05 m/s (`trueWindDirectionMinSpeedMps`), non inventare una direzione, indipendentemente da un eventuale TWS nativo.
- Senza TWA ricevuto o ricostruibile, mostrare `—` e nascondere freccia e indicatori tattici associati. Non usare un TWA vecchio per nuovi calcoli VMG o suggerimenti tattici.
- Mantenere le finestre delle medie già configurate; il metodo delle medie sarà revisionato separatamente.

Verifiche automatiche: [validità TWA](../test/windTwaValidity.test.js).

## TWD: direzione del vento rispetto al nord vero

- Preferire TWA valido + prua di bussola risolta (magnetica + WMM, altrimenti vera ricevuta). Se non ricostruibile, usare `environment.wind.directionTrue` nativo recente per 5 secondi, senza correzioni ipotetiche.
- Come ultimo ripiego, senza bussola e senza TWD nativo valido, usare TWA + COG valido solo con SOG sopra 0,77 m/s. Normalizzare fra 0 e 360 gradi. Un TWA nativo permette la ricostruzione anche senza AWS/AWA.
- Un TWD nativo null invalida soltanto quella sorgente: conservare i buffer delle medie e lo storico, anche quando resta disponibile il TWD ricostruito. La visualizzazione resta subordinata alla validità corrente.
- Tenere il TWD calcolato separato da quello ricevuto, conservando i timestamp sorgente. Dati invalidi, precedenti o duplicati non rinnovano l'età; null invalida il dato.
- Senza dati validi mostrare `—`, interrompere nuove osservazioni derivate e disattivare gli indicatori di tendenza correnti. Conservare lo storico.
- Non modificare COG, TWA o TWS con differenze di declinazione. Non presumere che tutti i valori veri ricevuti siano stati calcolati da YD con declinazione zero.

Verifiche automatiche: [validità TWD](../test/windTwdValidity.test.js).

## Velocità barca per il vento ricostruito

- STW e SOG scadono entrambi dopo 15 secondi dal timestamp sorgente (`boatSpeedMaxAgeMs`), sia nel motore sia nella GUI.
- Preferire STW recente; conservare la regola concordata: con STW sotto 0,25 m/s e SOG recente sopra 0,77 m/s usare SOG. Per ora non distinguere corrente e log bloccato.
- Senza STW recente usare SOG recente. Se entrambi sono indisponibili usare zero esclusivamente come ripiego nel calcolo vento: TWS = AWS.
- Dati invalidi, duplicati o precedenti non rinnovano l'età; una nuova misura uguale alla precedente sì. Null invalida la misura.
- Applicare la stessa selezione della velocità al VMG derivato. La validità dei riquadri STW/SOG è descritta sotto.

Verifiche: [timeout velocità](../test/windSpeedValidity.test.js).

## Prua ricevuta e ripiego sul COG

- Conservare separatamente i dati ricevuti: una prua derivata da magnetica o COG non viene scritta nel campo nativo `navigation.headingTrue`.
- Preferire prua magnetica valida entro 15 secondi + WMM. Se magnetica o declinazione calcolabile mancano, usare prua vera ricevuta valida entro 15 secondi, senza applicare differenze di declinazione di origine ignota.
- Senza prua valida, usare COG come approssimazione solo con COG e SOG entrambi più recenti di 15 secondi e SOG sopra 0,77 m/s.
- Rivalutare il ripiego a ogni aggiornamento: il primo COG non deve impedire i successivi. Una bussola valida riprende la priorità.
- Server e GUI risolvono la prua a partire dagli ingressi originali; i dispositivi non devono interpretare una stima server come prua ricevuta.
- Nessuna prua valida: niente nuovo TWD derivato e valore HDG indisponibile. Storico conservato.

Verifiche: [priorità e aggiornamento prua](../test/windHeadingValidity.test.js).

## Grafici AWS/TWS: raffica sostenuta

- Conservare lo smorzamento esponenziale continuo fra intervalli del grafico, con costante di tempo `gustSmoothingMs = 2500`.
- Riutilizzare l'ultimo valore smorzato e il suo timestamp, non il massimo né la media dell'intervallo precedente.
- Ogni punto del grafico resta il massimo dei valori smorzati del proprio intervallo. AWS e TWS mantengono stati separati.
- Il primo campione assoluto inizializza il filtro al valore ricevuto. Dopo almeno `gustResetGapMs = 15000` senza campioni, reinizializzare al nuovo valore e non trascinare il massimo precedente all'interruzione.
- Mantenere la stessa logica in motore e GUI. Non modificare le medie circolari né il filtro angolare ±15°, lasciati invariati su richiesta dell'utente.
- Il filtro attenua variazioni brevi; non identifica direttamente il rollio.

Verifiche: [continuità del filtro raffiche](../test/windGust.test.js).

## VMG rispetto al vento

- Calcolare il valore corrente come valore assoluto di velocità × cos(TWA), positivo anche di poppa.
- Richiedere una velocità realmente disponibile entro 15 secondi: STW prioritaria con il ripiego SOG già concordato. Non usare zero come sostituto di una velocità mancante.
- Usare TWA valido, ricevuto o ricostruito. TWA nativo e STW sono sufficienti anche senza AWS/AWA e SOG.
- Il numero mostra la VMG corrente in nodi; il grafico conserva la media per intervallo.
- Senza velocità o TWA validi mostrare `—` e interrompere nuovi campioni VMG, conservando lo storico.
- Uno zero misurato resta valido. Motore e GUI applicano gli stessi criteri.

Verifiche: [validità VMG](../test/windVmgValidity.test.js).

## Visualizzazione STW

- Mostrare `—` quando STW è assente, invalidata o vecchia di almeno 15 secondi; uno zero ricevuto e valido mostra `0.0`.
- Non inserire nuovi punti STW nel grafico usando un valore scaduto. Conservare lo storico esistente e il comportamento attuale della sua visualizzazione.
- Non usare STW scaduta per determinare la navigazione o colorare il confronto SOG/STW.
- Un nuovo dato valido ripristina valore e campionamento; i ripieghi vento e VMG restano invariati.

Verifiche: [validità STW](../test/windStwValidity.test.js).

## Da revisionare

Velocità e prua usate nei calcoli, medie, storico, radar e previsioni. Non considerare ancora questi comportamenti verificati o approvati da questo documento.


## Formato dei valori mancanti in nodi

Usare `--.-` per STW, VMG, TWS e AWS indisponibili, incluso AWS nello strumento centrale. Questa convenzione sostituisce il trattino lungo indicato nelle sezioni precedenti per questi valori. Nessuna modifica ai criteri di validità o ai segnaposto degli angoli.


## Visualizzazione SOG

- Stessa scadenza STW: SOG assente, invalidata o vecchia di almeno 15 secondi mostra `--.-`; zero ricevuto valido mostra `0.0`.
- Nessun nuovo punto nel grafico con SOG scaduta; storico conservato.
- Non usare SOG scaduta per determinare la navigazione o colorare il confronto SOG/STW.
- Nuove misure valide ripristinano visualizzazione e campionamento. Calcoli vento e VMG mantengono i criteri già concordati.

Verifiche: [validità SOG](../test/windSogValidity.test.js).


## DEPTH: validità della misura

- Sorgente invariata: `environment.depth.belowTransducer`, in metri, senza nuovi offset.
- Dato valido per meno di `depthMaxAgeMs = 15000` dal timestamp sorgente; senza dato valido mostrare `--.-`.
- Null invalida subito la misura, anche sui client della sessione condivisa. Valori non finiti, fuori dall'intervallo preesistente −2…500 m o precedenti non rinnovano la validità.
- Alla scadenza interrompere nuovi punti depth e le segnalazioni visive/acustiche basate sulla vecchia lettura; conservare lo storico.
- Nuove letture valide ripristinano il comportamento ordinario. Il grafico mantiene il minimo per intervallo.

Verifiche: [validità DEPTH](../test/windDepthValidity.test.js).


## LEEWAY: validità

- Richiedere prua di bussola risolta, COG e SOG validi entro 15 secondi.
- Senza uno degli ingressi mostrare `LEEWAY: —`, nascondere il puntatore e azzerare il riempimento della barra, senza presentare uno zero misurato.
- Non usare COG come ripiego della prua per questo confronto. Preferire magnetica + WMM, poi vera ricevuta. Senza bussola utilizzabile LEEWAY resta non disponibile anche se HDG usa COG.
- Mantenere limite ±20°, smorzamento 90/10 e azzeramento sotto la velocità minima quando gli ingressi sono validi.
- Alla perdita degli ingressi eliminare la memoria dello smorzamento precedente.

Verifiche: [validità LEEWAY](../test/windLeewayValidity.test.js).

## Declinazione magnetica offline

- Usare sempre WMM2025 per correggere la prua magnetica; ignorare `navigation.magneticVariation` nei calcoli. Il dato ricevuto resta separato e non viene sovrascritto.
- Calcolo identico nel motore e nella GUI, anche in sviluppo, con coefficienti inclusi nel pacchetto: nessuna richiesta Internet.
- Input: ultima posizione geografica valida, data UTC corrente, quota marina zero. Cache in RAM per flusso, ricalcolata dopo almeno 1 km dal punto di calcolo oppure al cambio di giorno UTC.
- Posizione assente/non valida o data fuori dal 2025–2029: declinazione non disponibile, mai zero inventato. Aggiornare il modello per il 2030.
- La magnetica corretta ha priorità sulla prua vera ricevuta; il ripiego COG resta escluso da LEEWAY.
- Il modello stima la declinazione geografica, non corregge deviazioni della bussola dovute alla barca.

Verifiche: [declinazione offline](../test/magneticDeclination.test.js).

## Previsioni TACK/GYBE: validità corrente

- Visualizzare le previsioni solo con STW oppure SOG validi e sopra `averaging.minSpeed`, come già previsto.
- Richiedere TWA, TWD e prua risolta correntemente validi; per la previsione COG richiedere anche COG valido entro 15 secondi.
- Conservare i controlli di stabilità delle medie. Una media ancora presente non rende valido un ingresso scaduto.
- Se gli ingressi non sono validi mostrare `---°`, conservando medie e storico. Riprendere quando tornano validità, movimento e stabilità.

Verifiche: [validità manovre](../test/windManeuverValidity.test.js).

## COG visualizzato

- Il riquadro COG (MEAN) richiede un COG ricevuto valido da meno di 15 secondi, usando il timestamp sorgente.
- Con dato assente, invalido o scaduto mostrare `---°` senza indicazione di instabilità. Non usare la media per aggirare la scadenza.
- Conservare il buffer della media; al ritorno di dati validi riprendere la visualizzazione con la normale finestra temporale. Zero gradi resta un valore valido.
- Questa scadenza non aggiunge una soglia di velocità al riquadro COG.

## Significato dei puntini di tendenza

- TWA: accettare che il segnale relativo possa dipendere anche da una variazione di rotta della barca; comportamento invariato.
- TWD: mantenere per diversi minuti l'indicazione della rotazione osservata nel periodo. Non significa necessariamente che il vento stia ancora ruotando nell'istante corrente; la persistenza dopo un salto seguito da stabilizzazione è voluta.

## Modalità di propulsione e suono di strambata

- Stato AUTO / SAIL / MOTOR condiviso tramite server, in RAM; AUTO al riavvio.
- MOTOR silenzia il suono di strambata, mantenendo indicatori e calcoli.
- SAIL mantiene le condizioni TWS > 7 kn e SOG > 1 kn, senza esclusione per SOG > 75% TWS.
- AUTO mantiene anche la precedente esclusione automatica SOG > 75% TWS al lasco/poppa.
- Invariati smorzamento TWA, fascia 155–170° sul lato opposto per confermare il cambio e pausa di 60 secondi tra avvisi. Il cambio modalità non genera da solo un suono.

## Scorrimento temporale dei grafici

- Il bordo destro dei grafici STW, SOG/VMG, profondità e TWS/AWS rappresenta il tempo corrente, non il timestamp dell'ultimo campione.
- Aggiornare la finestra ogni secondo anche senza nuove misure, e alla ripresa della pagina.
- Senza sensore valido, non aggiungere valori: la traccia esistente scorre verso sinistra e scompare quando esce dalla durata visibile. Escludere campioni futuri dalla finestra.
- Conservare durata configurata, raddoppio da fermi, aggregazione dei campioni, scale e buffer storici.

Verifiche: [finestra temporale grafici](../test/graphViewport.test.js).

### Interruzioni conservate nello storico

- Dopo una pausa di almeno 15 secondi fra campioni elaborati di un canale, server e aggregatore GUI iniziano un nuovo intervallo senza mescolare il buffer incompleto precedente con i dati appena tornati.
- Il primo punto alla ripresa porta `gapBefore: true`, conservato nella risposta dello storico e nel ripristino dopo ricaricamento. Il grafico interrompe sia linea sia riempimento su quel confine anche se la distanza temporale è inferiore alla soglia geometrica ordinaria.
- Nessun punto zero o campione di riempimento viene generato durante il silenzio.

Verifiche: [interruzioni dello storico](../test/windHistoryGaps.test.js).

## Recupero dopo sospensione del browser

- Wind continua ad acquisire mentre si visualizza AIS. Dopo una sospensione o una disconnessione, il recupero dello storico completo segue i timestamp della sessione condivisa e gli eventi di ripresa della pagina.
- Il ripristino include canali vuoti, interruzioni dei grafici, medie, storico TWD, radar e previsione. Svuotare i buffer di aggregazione incompleti e i filtri dei canali ripristinati per non mescolare dati precedenti alla pausa.
- Vedere [recupero della sessione](shared-session-spec.md#recupero-completo-wind-dopo-una-pausa) e [test](../test/dashboardRecovery.test.js).
