/**
 * Importa in Supabase Postgres i dati esportati da D1 (cartella d1-export/).
 *
 * Prerequisiti:
 *   1. Schema gia' creato su Supabase: avvia l'app una volta (ensureDatabase lo
 *      crea da solo) oppure esegui le DDL a mano.
 *   2. d1-export/ popolata da scripts/export-d1.sh.
 *   3. DATABASE_URL nell'ambiente (stringa Postgres del progetto Supabase).
 *
 * Uso:
 *   DATABASE_URL="postgres://..." node scripts/import-to-supabase.mjs
 *
 * Idempotente: usa ON CONFLICT DO NOTHING e a fine importazione riallinea le
 * sequenze identity. Rilanciarlo non duplica.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "d1-export";

// Ordine rispettoso delle foreign key.
const TABLES = [
  "users", "app_settings", "customers", "catalog_products", "products",
  "product_eans", "inventory", "sales", "sale_items", "fiscal_devices",
  "fiscal_jobs", "realtime_sync_jobs", "gift_cards", "reservations",
  "reservation_items", "transfers", "transfer_items", "business_documents",
  "business_document_items", "sessions",
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL mancante.");
  process.exit(1);
}
const sql = postgres(url, { prepare: false, max: 1 });

/** Estrae le righe da un file JSON di `wrangler d1 execute --json`. */
async function loadRows(table) {
  const file = path.join(EXPORT_DIR, `${table}.json`);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.results) return parsed.results;
  return [];
}

let total = 0;
for (const table of TABLES) {
  const rows = await loadRows(table);
  if (!rows.length) {
    console.log(`- ${table}: 0 righe`);
    continue;
  }
  // Inserimento a blocchi; ON CONFLICT DO NOTHING per idempotenza.
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await sql`INSERT INTO ${sql(table)} ${sql(chunk)} ON CONFLICT DO NOTHING`;
  }
  total += rows.length;
  console.log(`+ ${table}: ${rows.length} righe`);

  // Riallinea la sequenza identity se la tabella ha una colonna id numerica.
  try {
    await sql`
      SELECT setval(
        pg_get_serial_sequence(${table}, 'id'),
        GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${sql(table)}), 1)
      )`;
  } catch {
    // tabelle senza id numerico (app_settings, sessions, catalog_products): ok
  }
}

console.log(`\nImportate ${total} righe totali.`);
await sql.end();
