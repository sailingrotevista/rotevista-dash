# Inseguimento Dinamico AIS (Follow Mode Barca & Bersagli)

Implementazione del sistema unificato di inseguimento dinamico della mappa tattica AIS: supporto al tracciamento in tempo reale sia della propria barca che del bersaglio AIS selezionato, con mantenimento della posizione al centro della porzione visibile di schermo e rilascio automatico al tocco manuale.

## Decisioni Utente Confermate

> [!IMPORTANT]
> - **Interruzione Inseguimento Bersaglio:** qualsiasi trascinamento o pan manuale della mappa (`dragstart`) disattiva immediatamente il follow dinamico (`followMode = 'none'`), lasciando la mappa libera.
> - **Comportamento Pulsante Centra:** quando si sta seguendo un bersaglio AIS (o quando la mappa è libera), un singolo click sul pulsante "Centra" ripristina istantaneamente la centratura e l'inseguimento continuo della propria barca (`followMode = 'own'`).

---

### 1. Panoramica & Concetto Chiave

Attualmente la mappa tattica AIS esegue il follow continuo unicamente per la propria imbarcazione (`isFollowBoat`), mentre la selezione di un bersaglio effettua un singolo `panTo` istantaneo senza aggiornamenti successivi quando il bersaglio si sposta.

Il nuovo sistema introduce uno stato unificato:
`followMode: 'own' | 'target' | 'none'`
- `'own'`: la mappa insegue continuamente la propria barca al variare del GPS.
- `'target'`: la mappa insegue continuamente il bersaglio AIS selezionato a ogni nuovo fix ricevuto o elaborato.
- `'none'`: la mappa rimane fissa alle coordinate impostate dall'utente in seguito a un drag manuale.

In entrambi i casi di inseguimento (`'own'` e `'target'`), la posizione geografica viene proiettata nel centro della porzione di schermo libera calcolata da `getOffsetCenter` per garantire che il bersaglio o la barca non finiscano mai coperti dalla scheda dei dettagli o dalla lista bersagli.

---

### 2. Esperienza Utente & Flussi di Interazione

#### Flusso A: Selezione e Inseguimento Bersaglio
1. L'utente apre la lista bersagli o tocca un marker AIS sulla mappa.
2. La mappa attiva `followMode = 'target'` e centra il bersaglio nella porzione visibile di sinistra.
3. Se il bersaglio naviga o riceve nuovi pacchetti cinematici, la mappa lo segue fluidamente.
4. L'icona del pulsante Centra mostra lo stato attivo o pronto per il ripristino.

#### Flusso B: Ritorno Immediato alla Propria Barca
1. Mentre si segue un bersaglio, l'utente preme il pulsante rotondo "Centra" nel dock laterale destro (oppure la voce "La tua barca" nella testata della lista).
2. La modalità passa a `followMode = 'own'`.
3. La mappa si riallinea istantaneamente sulla propria barca. Se già centrata, il secondo click applica lo zoom standard contestuale alla velocità (16 all'ancora / 13 in navigazione).

#### Flusso C: Esplorazione Manuale Libera
1. L'utente trascina la mappa con il dito o il mouse.
2. L'evento `dragstart` imposta `followMode = 'none'`.
3. La mappa rimane ferma dove l'utente l'ha posizionata. Premendo il pulsante "Centra", si torna al follow della propria barca.

---

### 3. Decisioni Architetturali & Trade-Off

- **Stato Unificato vs Flag Multipli:**
  - *Scelta:* sostituzione di `isFollowBoat: boolean` con `followMode: 'own' | 'target' | 'none'` + tracciamento dell'ID target attivo.
  - *Motivazione:* elimina conflitti di concorrenza tra follow barca e follow bersaglio, garantendo uno stato deterministico e univoco.
- **Centratura Offset con `getOffsetCenter`:**
  - *Scelta:* riutilizzo della funzione di proiezione proattiva che compensa la larghezza occupata dalla card destra (`cardRef`).
  - *Motivazione:* massima coerenza visiva sia per la barca che per i target tracciati.

---

### 4. Architettura Tecnica & Diagramma di Stato

```
                ┌───────────────────────────────────┐
                │          FOLLOW MODE: OWN         │◄──────────┐
                │ (Insegue propria barca su GPS)    │           │
                └─────────────────┬─────────────────┘           │
                                  │                             │
          Selezione Bersaglio     │   Drag manuale mappa        │ Click pulsante
          dalla lista o mappa     │   (evento dragstart)        │ "Centra"
                                  ▼                             │
┌─────────────────────────────────┴─────────────────┐           │
│        FOLLOW MODE: TARGET (AIS Selezionato)      │           │
│ (Insegue target su aggiornamenti telemetria AIS)  │           │
└─────────────────────────────────┬─────────────────┘           │
                                  │                             │
                                  │ Drag manuale mappa          │
                                  ▼                             │
                ┌───────────────────────────────────┐           │
                │         FOLLOW MODE: NONE         │───────────┘
                │   (Mappa libera ad alzo manuale)  │
                └───────────────────────────────────┘
```

#### Mappatura delle Modifiche al Codice:
1. `src/components/AisView.tsx`:
   - Definire tipo `FollowMode = 'own' | 'target' | 'none'`.
   - Sostituire `useState(isFollowBoat)` con `useState<FollowMode>('own')`.
   - Modificare `useEffect` di centratura per reagire sia a `ownShipPosition` (se `'own'`) sia alla posizione del target selezionato (se `'target'`).
   - Aggiornare `handleCenterOnTarget` impostando `followMode = 'target'`.
   - Aggiornare `handleCenterOnOwnShip` impostando `followMode = 'own'`.
   - Connettere l'evidenziazione visiva del pulsante "Centra" a `followMode === 'own'`.
