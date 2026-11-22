# Bot Telegram di FitProgress

Facoltativo: FitProgress funziona anche senza. Con il bot:

- **Foto dei progressi in chat.** Le mandi al bot (anche come foto normali). Con *fronte*, *lato* o *schiena* nella didascalia la posa è già scelta. Il pulsante **Apri FitProgress** apre la pagina dentro Telegram: prende le foto dalla chat, le allinea e le misura. **Salva** rimanda nella chat il file dei progressi con tutte le foto ridotte, e toglie dalla chat le foto già prese.
- **Diario in chat.** `82,4` · `grasso 18` · `vita 84` · `gambe 60 min` · `allenamento: spinta` · `cena ieri: pizza`. Se il bot non capisce, chiede coi pulsanti. Le voci entrano nel diario della pagina alla prossima apertura.
- **Promemoria.** Ogni 14 giorni alle 8 (ora italiana) ti ricorda le foto, coi numeri della foto di riferimento. I pulsanti sono Fatto, Domani e Pausa. Si cambia con `/ogni 7`, `/ora 19`, `/pausa`, `/riprendi`. Una foto mandata conta come fatto.
- **Altro telefono.** Riaprendo la pagina dalla chat riparti dall'ultimo file dei progressi. Per ripartire da un file vecchio lo inoltri al bot.
- **Su invito.** Chi non è in `ALLOWED_IDS` scrive una volta al bot il codice d'accesso (`ACCESS_CODE`): il bot toglie il messaggio col codice e da lì si è dentro. Lo stesso codice è la password che la pagina chiede a ogni apertura (la controlla il bot) e la chiave del file dei progressi, cifrato sul telefono: lo stesso formato della piattaforma, quindi un file della chat si apre anche lì.
- **Storico.** Ogni salvataggio arriva nella chat col pulsante **📌 Conserva**. Quelli non conservati spariscono dopo 4 ore, tranne l'ultimo (è quello da cui riparte la pagina). Telegram lascia togliere i messaggi solo entro 48 ore.
- `/cancella` toglie tutto quello che il bot sa di te.

## Come è fatto

Un Cloudflare Worker (`src/worker.js`) con un database D1 (`schema.sql`).

- Serve anche la pagina: `npm run build` copia `index.html` e `vendor/` in `public/`. Così la pagina parla col bot sullo stesso indirizzo e la CSP non cambia.
- Nel database ci sono chi è stato ammesso, le impostazioni del promemoria, l'identificativo dell'ultimo file dei progressi nella chat, i salvataggi mandati in chat (per toglierli), le sessioni (solo impronte) e, per 7 giorni, le foto e le voci del diario non ancora prese dalla pagina (testi cifrati). Le foto e i file stanno su Telegram.
- **Da Telegram**: i messaggi arrivano solo col codice segreto del webhook (`WEBHOOK_SECRET`).
- **Dalla pagina**: coi dati firmati da Telegram (validi 12 ore) e la password giusta il bot dà una sessione che scade dopo 2 ore senza usarla, 12 in tutto; la pagina la rifà da sola. Ognuno può chiedere solo le sue foto.
- **Cifratura**: il file dei progressi lo cifra la pagina con la password (formato FPP1: PBKDF2-SHA256 a 600.000 giri, AES-GCM); il Worker rifiuta file che non lo sono. Da `MASTER_KEY` il Worker ricava per ogni utente la chiave dei testi in attesa nel database (e quella dei file della chat della versione di prima).
- **Limiti al giorno**: 300 messaggi, 40 foto, 60 salvataggi, 3000 richieste per utente; 5 tentativi col codice d'accesso; 30 utenti nuovi in tutto. `/setup` funziona una volta sola.
- **Chi può usarlo**: chi ha scritto il codice d'accesso, più gli ID nel secret `ALLOWED_IDS` (sempre dentro; `*` per tutti).

**Privacy:** le chat coi bot non sono cifrate end-to-end. Foto e file dei progressi stanno sui server di Telegram e passano dal Worker (senza restarci). Il file dei progressi nella chat è cifrato. Nel browser di Telegram la pagina non salva niente: a ogni apertura riparte dall'ultimo file della chat.

## Messa in funzione

Serve Node 22. Tutto da questa cartella (`telegram/`).

1. **Il bot.** In Telegram scrivi a [@BotFather](https://t.me/BotFather): `/newbot`, scegli nome e username e copia il token.
2. **Cloudflare.**
   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 create fitprogress   # copia database_id in wrangler.toml
   npm run db:init                      # un database delle versioni di prima: i file in migrations/, in ordine
   ```
3. **Segreti.** Il token di BotFather, la chiave principale (da conservare: senza, nessun file dei progressi si riapre) e un codice inventato per il webhook:
   ```sh
   npx wrangler secret put BOT_TOKEN
   (umask 077; openssl rand -hex 32 > ~/fitprogress-chiave-principale.txt)
   tr -d '\n' < ~/fitprogress-chiave-principale.txt | npx wrangler secret put MASTER_KEY
   openssl rand -hex 32 | tee /dev/tty | npx wrangler secret put WEBHOOK_SECRET   # serve al punto 5
   ```
4. **Pubblica.** `npm run deploy` risponde l'indirizzo, per esempio `https://fitprogress-bot.<tuo-account>.workers.dev`. Dopo il primo deploy: `npx wrangler secret put ACCESS_CODE` (il codice per i tester) e `npx wrangler secret put ALLOWED_IDS` (vuoto per ora).
5. **Collega il bot** (webhook, comandi, pulsante del menu). Funziona una volta sola: per rifarlo, `ALLOW_SETUP = "1"` fra le variabili, deploy, `/setup`, poi di nuovo via.
   ```sh
   curl -X POST https://fitprogress-bot.<tuo-account>.workers.dev/setup -H "X-Setup-Secret: <il codice del punto 3>"
   ```
6. **Entra.** Scrivi al bot il codice d'accesso. Per esserci sempre, anche se cambi il codice: metti il tuo ID Telegram in `ALLOWED_IDS` (`npx wrangler secret put ALLOWED_IDS`).

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
