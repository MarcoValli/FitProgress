# FitProgress

Confronto delle foto dei progressi in palestra, tutto in una pagina HTML.

## Privacy

- **Le foto non lasciano mai il dispositivo.** Si aprono e si analizzano nel browser; nessun server le riceve.
- **Niente tracciamento:** niente account, cookie, statistiche, font o script di terzi.
- **Connessioni limitate dal browser.** La Content Security Policy permette di collegarsi solo al proprio sito e ai file esatti delle librerie sui CDN (il ripiego quando `vendor/` non si legge). Fetch, beacon, immagini e websocket verso altri indirizzi vengono bloccati. Non copre la navigazione verso un'altra pagina: la CSP non la può bloccare.
- **Parte solo lo script della pagina.** Niente `'unsafe-inline'`: la CSP riconosce lo script dalla sua impronta SHA-256. Dopo ogni modifica allo script l'impronta va ricalcolata, se no la pagina non parte: a ogni push lo fa la GitHub Action `Impronta CSP`, che la rimette nel ramo con un commit. Per provare la pagina sul computer prima del push: `node tools/csp-hash.mjs` (con `--check` controlla soltanto).
- **Nel browser non resta niente.** Niente localStorage, IndexedDB o cookie: punti, misure, diario, impostazioni e foto stanno in memoria finché la pagina è aperta, e chiudendola spariscono. L'unico posto dove restano è il **file dei progressi**: lo salvi con Salva e la volta dopo lo carichi. Finché c'è qualcosa da salvare, Salva ha un pallino e il browser chiede conferma prima di chiudere la pagina.
- **Il file dei progressi** ha anche le foto di riferimento e del confronto; se supera i 50 MB ti propone di toglierne qualcuna. Non è cifrato: tienilo in un posto sicuro.
- **Dati delle versioni di prima.** Se nel browser c'è ancora qualcosa salvato da una versione precedente, all'apertura lo riprendo e lo tolgo dal browser: va salvato nel file.
- **Con il bot Telegram (facoltativo) è diverso:** foto e file dei progressi stanno nella chat col bot, sui server di Telegram. Vedi [`telegram/README.md`](telegram/README.md).

## Cosa fa

- Riconosce da solo la posa (di fronte, di lato, di schiena), trova i punti per allineare le foto e prende le misure dalla sagoma della persona. Se qualcosa è fuori posto lo trascini. In manuale scegli quali punti usare e li metti nella prima foto, le altre si allineano da sole.
- Confronta le foto con cursore, affiancate, sfumate o differenze. Il Dopo si riallinea sul Prima ogni volta che cambi foto, confrontando le due immagini.
- Ritocco a mano a tutto schermo: Prima e Dopo sovrapposti, strumenti in basso (sposta, dimensione, rotazione, luce, contrasto), il risultato si vede subito e OK salva.
- Misura le larghezze scelte nelle impostazioni (spalle, vita, fianchi…) e la definizione muscolare, con un margine d'errore.
- Propone una foto di riferimento e una guida per rifare le foto sempre uguali.
- Quando aggiungi le foto ti propone, per ogni posa, tre foto di partenza fra le più vecchie, o la scegli tu. Nel confronto è il Prima; il Dopo è la foto più recente più adatta alla partenza. Tutte e due finiscono nel file dei progressi (anche i Dopo delle volte prima), così caricandolo il confronto c'è già.
- Nel diario segni peso, massa grassa e circonferenze col metro (collo, spalle, torace, braccio, vita, fianchi, coscia, polpaccio), l'allenamento e i pasti, anche senza foto. Vedi l'ultimo valore, quanto è cambiato e un grafico nel tempo. Il diario entra nel file dei progressi.
- Con il [bot Telegram](telegram/README.md): foto e diario mandati in chat, promemoria per le foto, la pagina dentro Telegram.
- Funziona anche da telefono.


## Librerie in `vendor/`

Versioni fisse; ogni file viene controllato con la sua impronta SHA-256 prima di usarlo.

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 1.2.3 e il modello Pose Landmarker (full, float16): Apache 2.0, vedi `vendor/LICENSE-mediapipe.txt`.
- [heic-to](https://github.com/hoppergee/heic-to) 1.6.7, build `csp`, con libheif: LGPL 3.0, non modificata, vedi `vendor/LICENSE-heic-to.txt`.
