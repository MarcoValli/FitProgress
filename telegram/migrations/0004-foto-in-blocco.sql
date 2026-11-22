-- Foto in blocco: una sola risposta per tante foto.
--   npx wrangler d1 execute fitprogress --remote --file migrations/0004-foto-in-blocco.sql
ALTER TABLE users ADD COLUMN burst TEXT;      -- l'ultima foto arrivata (chi risponde)
ALTER TABLE users ADD COLUMN ack_id INTEGER;  -- il messaggio "Ho N foto": si toglie quando ne arriva uno nuovo o salvi
