# Promozione del motion tracker

Il modello a due stati concordato il 26 ottobre 2026 è ora nel [tracker operativo locale](../ais/targetMotionTracker.js). La [specifica corrente](motion-tracker-spec.md) descrive regole, parametri, integrazione e punti ancora aperti.

Il percorso [experimental](../ais/experimental/targetMotionTracker.js) resta come re-export per compatibilità e test: non contiene un’altra implementazione. AisEngine passa il detector esistente, preserva la SOG mancante come null e condivide il tracker con la nostra barca. Il fallback dev legge i perimetri upstream senza scritture sul Cerbo.

La nuova matrice geografica degli avvisi e un’ulteriore revisione del clustering non sono comprese. Pubblicazione/installazione e verifica fisica sui dispositivi restano successive.
