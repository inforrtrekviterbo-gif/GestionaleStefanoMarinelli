/**
 * Crea (o aggiorna) un utente in Supabase Auth via service role key.
 * Alternativa alla dashboard. Email gia' confermata.
 *
 * Uso:
 *   SUPABASE_URL="https://<ref>.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="<service-role>" \
 *   node scripts/create-auth-user.mjs test@gestionale.local test123
 *
 * Le email dei tre account storici (vedi lib/user-profiles.ts):
 *   admin@gestionale.local  viterbo@gestionale.local  gran-sasso@gestionale.local
 */
import { createClient } from "@supabase/supabase-js";

const [email, password] = process.argv.slice(2);
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !password) {
  console.error("Uso: node scripts/create-auth-user.mjs <email> <password>");
  process.exit(1);
}
if (password.length < 6) {
  console.error("Supabase Auth richiede almeno 6 caratteri di password.");
  process.exit(1);
}
if (!url || !serviceKey) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mancanti.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});

if (error) {
  console.error(`Errore: ${error.message}`);
  process.exit(1);
}
console.log(`Utente creato: ${data.user?.email} (id ${data.user?.id})`);
