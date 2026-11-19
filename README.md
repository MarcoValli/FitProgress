# FitProgress

Confronto delle foto dei progressi in palestra, tutto in una pagina HTML.

Le foto non lasciano mai il dispositivo: si aprono e si analizzano nel browser.

## Cosa fa

- Allinea le foto della stessa posa (di fronte, di lato, di schiena) con 2 o 3 punti: una a mano, le altre in automatico.
- Confronta le foto con cursore, affiancate, sfumate o differenze.
- Misura le larghezze scelte nelle impostazioni (spalle, vita, fianchi…) e la definizione muscolare, con un margine d'errore.
- Propone una foto di riferimento e una guida per rifare le foto sempre uguali.
- Salva e carica i progressi in un file JSON.

## Come si usa

Apri `index.html` con il browser (o la pagina pubblicata) e trascina le foto. Vanno bene JPG, PNG, HEIC e screenshot.

## Cosa si scarica da internet

Solo alla prima volta, e solo il codice delle librerie, mai le foto:

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (Apache 2.0) e il modello Pose Landmarker, per riconoscere la posa;
- [heic-to](https://github.com/hoppergee/heic-to) (LGPL 3.0), per aprire le HEIC fuori da Safari.

Le versioni sono fisse e ogni file viene controllato con la sua impronta SHA-256 prima di usarlo.

## Dove stanno i dati

Punti, misure e impostazioni stanno nel browser (localStorage). Le foto di riferimento stanno in IndexedDB. Per non perderli, o per passarli su un altro dispositivo, usa **Impostazioni › Salva i progressi**.
