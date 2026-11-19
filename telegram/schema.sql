-- Database del bot (Cloudflare D1). Si crea con: npm run db:init
-- Qui non ci sono foto né file dei progressi: quelli stanno nella chat, su Telegram.

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
  created_at INTEGER NOT NULL
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
