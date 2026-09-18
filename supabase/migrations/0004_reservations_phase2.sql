-- Prenotazioni creabili da pagina, con consegna prevista e stato acconto.
ALTER TABLE reservations ALTER COLUMN issued_sale_id DROP NOT NULL;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS expected_delivery TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS note TEXT;
