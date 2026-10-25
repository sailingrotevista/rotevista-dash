# Istruzioni per lo sviluppo

## Comunicazione e documentazione

- Comunicare con l'utente in italiano; scrivere i nuovi testi della GUI in inglese.
- Procedere un argomento alla volta quando si svolge una revisione insieme.
- Distinguere sempre comportamento implementato, proposta e verifica ancora da fare.
- Aggiornare le specifiche pertinenti quando cambia una decisione concordata.
- Le indicazioni più recenti dell'utente prevalgono sulle istruzioni di questo file.

## Regole del prodotto

- Preservare la distinzione tra rischio di collisione e prossimità nella safe bubble.
- Non trasformare dati proiettati, duplicati o semplici riletture in nuove osservazioni AIS.
- Modalità condivisa, banner, snooze e acknowledge hanno il server come fonte autorevole.
- Ispezione, zoom e layout debug rimangono locali al singolo dispositivo.
- I controlli del dev server non devono modificare modalità o riconoscimenti sul Cerbo.
- Lo stato condiviso di modalità e avvisi resta in RAM: non aggiungere persistenza su disco senza una nuova decisione concordata.
- Non introdurre indicazioni COLREG nei banner: la guida COLREG è rinviata a una versione successiva.

## Modifiche e verifiche

- Leggere il codice e le specifiche pertinenti prima di modificare un comportamento.
- Non considerare una proposta discussa come una funzione già approvata o implementata.
- Per modifiche alla logica, eseguire i test pertinenti; prima di un rilascio eseguire `node --test test/*.test.js`, `npm run lint` e `npm run build`.
- Per modifiche soltanto documentali, verificare contenuto e collegamenti; non servono nuovi test del codice.
- Distinguere i risultati dei test automatici dalle prove effettivamente svolte sui dispositivi.
- Non riavviare il Cerbo o Signal K per eseguire test automatici locali.
- Pubblicare su GitHub o npm soltanto su richiesta dell'utente, rispettando chi deve eseguire la pubblicazione.
- Per le beta usare il tag npm `beta`; non spostare implicitamente il tag `latest`.
