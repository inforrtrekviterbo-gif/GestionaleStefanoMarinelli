-- Buoni regalo emettibili anche senza vendita e senza scadenza obbligatoria.
ALTER TABLE gift_cards ALTER COLUMN issued_sale_id DROP NOT NULL;
ALTER TABLE gift_cards ALTER COLUMN expires_at DROP NOT NULL;
