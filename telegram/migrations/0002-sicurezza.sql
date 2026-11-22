-- Per un database creato con lo schema della prima versione: password, sessioni, limiti.
--   npx wrangler d1 execute fitprogress --remote --file migrations/0002-sicurezza.sql
ALTER TABLE users ADD COLUMN pw_salt TEXT;
ALTER TABLE users ADD COLUMN pw_verifier TEXT;
ALTER TABLE users ADD COLUMN pw_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pw_locked_until INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, kind)
);

-- I file dei progressi della prima versione erano in chiaro: si riparte dal prossimo salvataggio
UPDATE users SET last_json = NULL;
