# Bot Telegram di FitProgress

Facoltativo: FitProgress funziona anche senza. Con il bot:

- **Foto dei progressi in chat.** Le mandi al bot (anche come foto normali). Con *fronte*, *lato* o *schiena* nella didascalia la posa è già scelta. Il pulsante **Apri FitProgress** apre la pagina dentro Telegram: prende le foto dalla chat, le allinea e le misura. **Salva** rimanda nella chat il file dei progressi con tutte le foto ridotte, e toglie dalla chat le foto già prese.
- **Diario in chat.** `82,4` · `grasso 18` · `vita 84` · `gambe 60 min` · `allenamento: spinta` · `cena ieri: pizza`. Se il bot non capisce, chiede coi pulsanti. Le voci entrano nel diario della pagina alla prossima apertura.
- **Promemoria.** Ogni 14 giorni alle 8 (ora italiana) ti ricorda le foto, coi numeri della foto di riferimento. I pulsanti sono Fatto, Domani e Pausa. Si cambia con `/ogni 7`, `/ora 19`, `/pausa`, `/riprendi`. Una foto mandata conta come fatto.
- **Altro telefono.** Riaprendo la pagina dalla chat riparti dall'ultimo file dei progressi.

## Come è fatto

Un Cloudflare Worker (`src/worker.js`) con un database D1 (`schema.sql`).

- Serve anche la pagina: `npm run build` copia `index.html` e `vendor/` in `public/`. Così la pagina parla col bot sullo stesso indirizzo e la CSP non cambia.
- Nel database ci sono solo le impostazioni del promemoria, l'identificativo dell'ultimo file dei progressi nella chat e le foto e le voci del diario non ancora prese dalla pagina. Le foto e i file stanno su Telegram.
- **Da Telegram**: i messaggi arrivano solo col codice segreto del webhook (`WEBHOOK_SECRET`).
- **Dalla pagina**: le richieste valgono solo coi dati firmati da Telegram, controllati col token del bot e validi 24 ore. Ognuno può chiedere solo le sue foto.
- **Chi può usarlo**: `ALLOWED_IDS` in `wrangler.toml` contiene gli ID Telegram ammessi, oppure `*` per tutti. Vuoto vuol dire nessuno: a `/start` il bot ti dice il tuo ID da mettere lì.

**Privacy:** le chat coi bot non sono cifrate end-to-end. Foto e file dei progressi stanno sui server di Telegram e passano dal Worker (senza restarci). Il file dei progressi nella chat per ora è in chiaro. Nel browser di Telegram la pagina non salva niente: a ogni apertura riparte dall'ultimo file della chat.

## Messa in funzione

Serve Node 22. Tutto da questa cartella (`telegram/`).

1. **Il bot.** In Telegram scrivi a [@BotFather](https://t.me/BotFather): `/newbot`, scegli nome e username e copia il token.
2. **Cloudflare.**
   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 create fitprogress   # copia database_id in wrangler.toml
   npm run db:init
   ```
3. **Segreti.** Il token di BotFather e un codice inventato per il webhook:
   ```sh
   npx wrangler secret put BOT_TOKEN
   openssl rand -hex 32 | tee /dev/tty | npx wrangler secret put WEBHOOK_SECRET   # tienilo, serve al punto 5
   ```
4. **Pubblica.** `npm run deploy` risponde l'indirizzo, per esempio `https://fitprogress-bot.<tuo-account>.workers.dev`.
5. **Collega il bot** (webhook, comandi, pulsante del menu):
   ```sh
   curl -X POST https://fitprogress-bot.<tuo-account>.workers.dev/setup -H "X-Setup-Secret: <il codice del punto 3>"
   ```
6. **Il tuo ID.** Scrivi `/start` al bot: ti risponde col tuo ID. Mettilo in `ALLOWED_IDS` in `wrangler.toml` e rifai `npm run deploy`.

Ogni volta che cambia `index.html`: `npm run deploy` (rifà anche `public/`).

## Prove

- `npm test` prova come il bot capisce il diario, la firma di Telegram e le date nel fuso orario.
- **In locale**, senza Telegram vero:
  ```sh
  cp .dev.vars.example .dev.vars
  npx wrangler d1 execute fitprogress --local --file schema.sql
  node test/fake-telegram.mjs &    # finto Telegram su :8790
  npm run dev                      # Worker e pagina su :8787
  ```
  I messaggi si mandano a mano a `http://127.0.0.1:8787/telegram` (header `X-Telegram-Bot-Api-Secret-Token: prova-locale`). Le risposte del bot si leggono su `http://127.0.0.1:8790/_log`.
