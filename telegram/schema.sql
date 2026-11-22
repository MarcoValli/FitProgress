-- Database del bot (Cloudflare D1). Si crea con: npm run db:init (un database che c'era già: migrations/)
-- Qui non ci sono foto né file dei progressi: quelli stanno nella chat, su Telegram.
-- I testi in attesa (voci del diario, didascalie, domande, guida del promemoria) sono cifrati ("e1:…").

-- Un utente per ID Telegram (chat privata col bot)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  every_days INTEGER NOT NULL DEFAULT 14,  -- promemoria ogni quanti giorni
  hour INTEGER NOT NULL DEFAULT 8,         -- a che ora (TIME_ZONE)
  paused INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,                         -- prossimo promemoria, millisecondi
  last_json TEXT,                          -- file_id dell'ultimo file dei progressi mandato nella chat
  guide TEXT,                              -- righe di "Come rifare la foto" per il promemoria (JSON)
  last_group TEXT,                         -- ultimo album di foto ricevuto (si risponde una volta sola)
  created_at INTEGER NOT NULL,
  admitted INTEGER NOT NULL DEFAULT 0,     -- 1: ha scritto il codice d'accesso
  last_msg INTEGER                         -- il messaggio nella chat con l'ultimo file (non si toglie mai)
);

-- Salvataggi mandati nella chat: quelli non conservati (kept = 0) si tolgono dopo 4 ore, tranne l'ultimo
CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, message_id)
);

-- Sessioni della pagina: solo l'impronta del codice, scadono dopo 2 ore senza usarle o 12 in tutto
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Quante azioni al giorno (limiti per utente, anche i tentativi col codice d'accesso; user_id 0: utenti nuovi in tutto)
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, kind)
);

-- Foto mandate in chat e non ancora prese dalla pagina
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,  -- il messaggio con la foto: si toglie dalla chat dopo il salvataggio
  reply_id INTEGER,             -- la risposta "Foto ricevuta", idem
  sent_at INTEGER NOT NULL,     -- secondi, come Telegram
  caption TEXT
);
CREATE INDEX IF NOT EXISTS photos_user ON photos (user_id);

-- Voci del diario scritte al bot e non ancora prese dalla pagina
CREATE TABLE IF NOT EXISTS diary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,     -- 2026-11-19
  field TEXT NOT NULL,    -- weight, fat, waist…, workout, meal
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS diary_user ON diary (user_id);

-- Messaggi che il bot non ha capito: aspettano la risposta coi pulsanti (allenamento, pasto, lascia stare)
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Indirizzo della pagina (lo scrive /setup): serve ai promemoria, che non arrivano da una richiesta
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
