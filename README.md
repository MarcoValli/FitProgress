# FitProgress

Confronto delle foto dei progressi in palestra, tutto in una pagina HTML.

## Privacy

- **Le foto non lasciano mai il dispositivo.** Si aprono e si analizzano nel browser; nessun server le riceve.
- **Niente tracciamento:** niente account, cookie, statistiche, font o script di terzi.
- **Connessioni bloccate dal browser.** La pagina ha una Content Security Policy che le permette di collegarsi solo al proprio sito. Qualunque altro invio (fetch, beacon, immagini, websocket) viene bloccato.
- **I dati stanno nel browser:** punti, misure, diario e impostazioni in localStorage, foto di riferimento e del confronto in IndexedDB. Il file dei progressi contiene anche queste foto; se supera i 50 MB ti propone di toglierne qualcuna.

## Cosa fa

- Riconosce da solo la posa (di fronte, di lato, di schiena), trova i punti per allineare le foto e prende le misure dalla sagoma della persona. Se qualcosa è fuori posto lo trascini. In manuale scegli quali punti usare e li metti nella prima foto, le altre si allineano da sole.
- Confronta le foto con cursore, affiancate, sfumate o differenze.
- Misura le larghezze scelte nelle impostazioni (spalle, vita, fianchi…) e la definizione muscolare, con un margine d'errore.
- Propone una foto di riferimento e una guida per rifare le foto sempre uguali.
- Quando aggiungi le foto ti propone, per ogni posa, tre foto di partenza fra le più vecchie, o la scegli tu. Nel confronto è il Prima; il Dopo è la foto più recente più adatta alla partenza. Tutte e due restano salvate (anche i Dopo delle volte prima), così riaprendo la pagina il confronto c'è già.
- Nel diario segni peso, massa grassa e circonferenze col metro (collo, spalle, torace, braccio, vita, fianchi, coscia, polpaccio), anche senza foto. Vedi l'ultimo valore, quanto è cambiato e un grafico nel tempo. Il diario entra nel file dei progressi.
- Funziona anche da telefono.


## Librerie in `vendor/`

Versioni fisse; ogni file viene controllato con la sua impronta SHA-256 prima di usarlo.

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 1.2.3 e il modello Pose Landmarker (full, float16): Apache 2.0, vedi `vendor/LICENSE-mediapipe.txt`.
- [heic-to](https://github.com/hoppergee/heic-to) 1.6.7, build `csp`, con libheif: LGPL 3.0, non modificata, vedi `vendor/LICENSE-heic-to.txt`.
