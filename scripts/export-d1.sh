#!/usr/bin/env bash
# Esporta i dati reali da Cloudflare D1 in JSON per tabella.
# Va eseguito nel VECCHIO repo (gestionale-marinelli-prova-stampa), dove wrangler
# e il binding DB sono configurati e sei autenticato su Cloudflare.
#
# Uso:
#   cd ../gestionale-marinelli-prova-stampa
#   bash ../GestionaleStefanoMarinelli/scripts/export-d1.sh
#
# Crea la cartella d1-export/ con un file <tabella>.json per tabella.
# Poi copiala nel repo nuovo e lancia import-to-supabase.mjs.
set -euo pipefail

DB_BINDING="${DB_BINDING:-DB}"
OUT_DIR="${OUT_DIR:-d1-export}"
REMOTE="${REMOTE:---remote}"   # metti REMOTE="" per il DB locale miniflare

TABLES=(
  users app_settings customers catalog_products products product_eans inventory
  sales sale_items fiscal_devices fiscal_jobs realtime_sync_jobs gift_cards
  reservations reservation_items transfers transfer_items
  business_documents business_document_items sessions
)

mkdir -p "$OUT_DIR"
for table in "${TABLES[@]}"; do
  echo "export $table ..."
  npx wrangler d1 execute "$DB_BINDING" $REMOTE --json \
    --command "SELECT * FROM $table" > "$OUT_DIR/$table.json" || {
      echo "  (tabella $table assente o vuota, salto)"; echo '[]' > "$OUT_DIR/$table.json";
    }
done
echo "Fatto. Dati in $OUT_DIR/"
