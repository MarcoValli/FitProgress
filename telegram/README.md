# Bot Telegram di FitProgress

Facoltativo: FitProgress funziona anche senza. Con il bot:

- **Foto dei progressi in chat.** Le mandi al bot (anche come foto normali). Con *fronte*, *lato* o *schiena* nella didascalia la posa è già scelta. Il pulsante **Apri FitProgress** apre la pagina dentro Telegram: prende le foto dalla chat, le allinea e le misura. **Salva** rimanda nella chat il file dei progressi con tutte le foto ridotte, e toglie dalla chat le foto già prese.
- **Diario in chat.** `82,4` · `grasso 18` · `vita 84` · `gambe 60 min` · `allenamento: spinta` · `cena ieri: pizza`. Se il bot non capisce, chiede coi pulsanti. Le voci entrano nel diario della pagina alla prossima apertura.
- **Promemoria.** Ogni 14 giorni alle 8 (ora italiana) ti ricorda le foto, coi numeri della foto di riferimento. I pulsanti sono Fatto, Domani e Pausa. Si cambia con `/ogni 7`, `/ora 19`, `/pausa`, `/riprendi`. Una foto mandata conta come fatto.
- **Altro telefono.** Riaprendo la pagina dalla chat riparti dall'ultimo file dei progressi. Per ripartire da un file vecchio lo inoltri al bot.
- **Password.** La pagina dentro Telegram si apre con una password, scelta la prima volta. Il file dei progressi nella chat è cifrato sul telefono e si apre solo così.
- `/cancella` toglie tutto quello che il bot sa di te.

## Come è fatto

Un Cloudflare Worker (`src/worker.js`) con un database D1 (`schema.sql`).

- Serve anche la pagina: `npm run build` copia `index.html` e `vendor/` in `public/`. Così la pagina parla col bot sullo stesso indirizzo e la CSP non cambia.
- Nel database ci sono le impostazioni del promemoria, l'identificativo dell'ultimo file dei progressi nella chat, l'impronta della password, le sessioni (solo impronte) e, per 7 giorni, le foto e le voci del diario non ancora prese dalla pagina (testi cifrati). Le foto e i file stanno su Telegram.
- **Da Telegram**: i messaggi arrivano solo col codice segreto del webhook (`WEBHOOK_SECRET`).
- **Dalla pagina**: per entrare servono i dati firmati da Telegram e la password (passata per PBKDF2 sul telefono, 600.000 giri; nel database solo un HMAC). Poi una sessione che scade dopo 2 ore senza usarla, 12 in tutto. Cinque password sbagliate bloccano per 15 minuti, poi sempre di più. Ognuno può chiedere solo le sue foto.
- **Cifratura**: da `MASTER_KEY` il Worker ricava per ogni utente la chiave del file (data alla pagina dopo la password: il file la pagina lo cifra e lo decifra da sola) e quella dei testi in attesa nel database. Il Worker rifiuta file non cifrati con la chiave di chi salva.
- **Limiti al giorno**: 300 messaggi, 40 foto, 60 salvataggi, 3000 richieste per utente; 30 utenti nuovi in tutto. `/setup` funziona una volta sola.
- **Chi può usarlo**: il secret `ALLOWED_IDS` contiene gli ID Telegram ammessi, oppure `*` per tutti. Vuoto vuol dire nessuno: a `/start` il bot ti dice il tuo ID.

**Privacy:** le chat coi bot non sono cifrate end-to-end. Foto e file dei progressi stanno sui server di Telegram e passano dal Worker (senza restarci). Il file dei progressi nella chat è cifrato. Nel browser di Telegram la pagina non salva niente: a ogni apertura riparte dall'ultimo file della chat.

## Messa in funzione

Serve Node 22. Tutto da questa cartella (`telegram/`).

1. **Il bot.** In Telegram scrivi a [@BotFather](https://t.me/BotFather): `/newbot`, scegli nome e username e copia il token.
2. **Cloudflare.**
   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 create fitprogress   # copia database_id in wrangler.toml
   npm run db:init                      # un database della prima versione: migrations/0002-sicurezza.sql
   ```
3. **Segreti.** Il token di BotFather, la chiave principale (da conservare: senza, nessun file dei progressi si riapre) e un codice inventato per il webhook:
   ```sh
   npx wrangler secret put BOT_TOKEN
   (umask 077; openssl rand -hex 32 > ~/fitprogress-chiave-principale.txt)
   tr -d '\n' < ~/fitprogress-chiave-principale.txt | npx wrangler secret put MASTER_KEY
   openssl rand -hex 32 | tee /dev/tty | npx wrangler secret put WEBHOOK_SECRET   # serve al punto 5
   ```
4. **Pubblica.** `npm run deploy` risponde l'indirizzo, per esempio `https://fitprogress-bot.<tuo-account>.workers.dev`. Dopo il primo deploy: `npx wrangler secret put ALLOWED_IDS` (vuoto per ora).
5. **Collega il bot** (webhook, comandi, pulsante del menu). Funziona una volta sola: per rifarlo, `ALLOW_SETUP = "1"` fra le variabili, deploy, `/setup`, poi di nuovo via.
   ```sh
   curl -X POST https://fitprogress-bot.<tuo-account>.workers.dev/setup -H "X-Setup-Secret: <il codice del punto 3>"
   ```
6. **Il tuo ID.** Scrivi `/start` al bot: ti risponde col tuo ID. Mettilo in `ALLOWED_IDS` con `npx wrangler secret put ALLOWED_IDS` (più ID separati da virgole, `*` per tutti).

Ogni volta che cambia `index.html`: `npm run deploy` (rifà anche `public/`).

## Prove

- `npm test` prova come il bot capisce il diario, la firma di Telegram, le date nel fuso orario e la cifratura.
- **In locale**, senza Telegram vero:
  ```sh
  cp .dev.vars.example .dev.vars
  npx wrangler d1 execute fitprogress --local --file schema.sql
  node test/fake-telegram.mjs &    # finto Telegram su :8790
  npm run dev                      # Worker e pagina su :8787
  ```
  I messaggi si mandano a mano a `http://127.0.0.1:8787/telegram` (header `X-Telegram-Bot-Api-Secret-Token: prova-locale`). Le risposte del bot si leggono su `http://127.0.0.1:8790/_log`.
