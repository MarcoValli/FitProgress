# FitProgress

Confronto delle foto dei progressi in palestra, tutto in una pagina HTML.

## Privacy

- **Le foto non lasciano mai il dispositivo.** Si aprono e si analizzano nel browser; nessun server le riceve.
- **Niente tracciamento:** niente account, cookie, statistiche, font o script di terzi.
- **Connessioni bloccate dal browser.** La pagina ha una Content Security Policy che le permette di collegarsi solo al proprio sito. Qualunque altro invio (fetch, beacon, immagini, websocket) viene bloccato.
- **Le librerie stanno in `vendor/`.** Pubblicata, la pagina non contatta nessun altro sito. Aperta come file dal computer, il browser non può leggere `vendor/` e le scarica una volta da jsDelivr e Google Storage (solo il codice, mai le foto).
- **I dati stanno nel browser:** punti, misure e impostazioni in localStorage, foto di riferimento in IndexedDB.
- **Il file di salvataggio** (Impostazioni › Salva i progressi) contiene anche le foto di riferimento in base64, se le includi. Resta dove lo salvi tu: su iPhone in File › Sul mio iPhone, non in iCloud Drive.
- `noindex`: i motori di ricerca non la indicizzano.

## Cosa fa

- Allinea le foto della stessa posa (di fronte, di lato, di schiena) con 2 o 3 punti: una a mano, le altre in automatico.
- Confronta le foto con cursore, affiancate, sfumate o differenze.
- Misura le larghezze scelte nelle impostazioni (spalle, vita, fianchi…) e la definizione muscolare, con un margine d'errore.
- Propone una foto di riferimento e una guida per rifare le foto sempre uguali.
- Funziona anche da telefono.

## Come si usa

Apri `index.html` con il browser (o la pagina pubblicata) e aggiungi le foto: JPG, PNG, HEIC e screenshot.

## Librerie in `vendor/`

Versioni fisse; ogni file viene controllato con la sua impronta SHA-256 prima di usarlo.

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 1.2.3 e il modello Pose Landmarker (full, float16): Apache 2.0, vedi `vendor/LICENSE-mediapipe.txt`.
- [heic-to](https://github.com/hoppergee/heic-to) 1.6.7, build `csp`, con libheif: LGPL 3.0, non modificata, vedi `vendor/LICENSE-heic-to.txt`.
