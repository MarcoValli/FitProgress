-- Primo confronto dal bot: una foto di prima (partenza) e una di adesso.
--   npx wrangler d1 execute fitprogress --remote --file migrations/0006-primo-confronto.sql
ALTER TABLE users ADD COLUMN onboard TEXT;  -- ask, start, date, now: a che punto è il primo confronto
ALTER TABLE photos ADD COLUMN role TEXT;    -- start (la partenza) o now (adesso)
ALTER TABLE photos ADD COLUMN taken TEXT;   -- la data della partenza, se l'hai detta (2026-03-15)
