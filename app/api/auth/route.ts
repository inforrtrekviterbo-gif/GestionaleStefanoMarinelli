import { cookieSecure, createSession, currentUser, database, ensureDatabase, json, removeSession, type SessionUser } from "../../../lib/runtime-db";
import { isDevDb } from "../../../lib/db";
import { verifySupabaseToken } from "../../../lib/supabase-server";
import { profileFromEmail } from "../../../lib/user-profiles";

type LoginBody = { action?: string; accessToken?: string };

async function applicationUserForEmail(email: string) {
  const profile = profileFromEmail(email);
  if (!profile) return null;
  let user = await database().prepare(`SELECT id, username, display_name AS displayName, role, store, must_change_password AS mustChangePassword FROM users WHERE username = ?`)
    .bind(profile.username).first<SessionUser>();
  if (!user) {
    await database().prepare(`INSERT OR IGNORE INTO users (username, display_name, role, store, password_salt, password_hash, password_iterations, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, 100000, 0, ?)`)
      .bind(profile.username, profile.displayName, profile.role, profile.store, crypto.randomUUID(), crypto.randomUUID(), new Date().toISOString()).run();
    user = await database().prepare(`SELECT id, username, display_name AS displayName, role, store, must_change_password AS mustChangePassword FROM users WHERE username = ?`)
      .bind(profile.username).first<SessionUser>();
  }
  return user ? { ...user, mustChangePassword: 0 } : null;
}

export async function GET(request: Request) {
  return json({ user: await currentUser(request) }, 200, { "Cache-Control": "private, no-store, max-age=0" });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json().catch(() => ({}))) as LoginBody;
  if (body.action === "logout") {
    await removeSession(request);
    return json({ ok: true }, 200, { "Set-Cookie": `gestionale_session=; Path=/; HttpOnly${cookieSecure()}; SameSite=Strict; Max-Age=0` });
  }
  if (body.action === "dev-login") {
    if (process.env.DEV_LOGIN !== "1" && !isDevDb()) return json({ error: "Accesso di sviluppo non abilitato." }, 403);
    const user = await applicationUserForEmail("admin@gestionale.local");
    if (!user) return json({ error: "Profilo admin non disponibile." }, 500);
    const session = await createSession(user.id, 8 * 60 * 60);
    return json({ user }, 200, { "Set-Cookie": session.cookie });
  }
  if (body.action !== "supabase-login" || !body.accessToken) return json({ error: "Accesso Supabase richiesto." }, 400);

  const identity = await verifySupabaseToken(body.accessToken);
  if (!identity) return json({ error: "Credenziali Supabase non valide o scadute." }, 401);
  const user = await applicationUserForEmail(identity.email);
  if (!user) return json({ error: "Profilo gestionale non autorizzato per questa email." }, 403);

  const session = await createSession(user.id, 12 * 60 * 60);
  return json({ user }, 200, { "Set-Cookie": session.cookie });
}
