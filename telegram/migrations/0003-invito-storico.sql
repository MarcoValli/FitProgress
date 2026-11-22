-- Codice d'accesso al posto della password personale, storico dei salvataggi nella chat.
--   npx wrangler d1 execute fitprogress --remote --file migrations/0003-invito-storico.sql
-- Le colonne pw_* della 0002 restano (SQLite le toglie male) ma non si usano più.
ALTER TABLE users ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_msg INTEGER;

CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, message_id)
);

UPDATE users SET pw_salt = NULL, pw_verifier = NULL, pw_fails = 0, pw_locked_until = 0;
