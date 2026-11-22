-- Le domande del diario puntano alla nota già segnata (si sposta, si lascia o si toglie coi pulsanti).
--   npx wrangler d1 execute fitprogress --remote --file migrations/0005-diario-note.sql
ALTER TABLE asks ADD COLUMN diary_id INTEGER;
