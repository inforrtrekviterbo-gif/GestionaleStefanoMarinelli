/**
 * Mappa email -> profilo gestionale (username, ruolo, negozio).
 *
 * Rimpiazza il vecchio `firebaseLoginProfiles`. Supabase Auth verifica
 * l'identita' (email+password); qui l'email diventa ruolo e negozio.
 * Gli account in Supabase Auth devono usare queste stesse email.
 *
 * Quando l'admin creera' nuovi utenti dall'app, questa mappa lascera' il posto
 * a una lettura dalla tabella `users` (per ora bastano i tre storici).
 */
export type Role = "admin" | "viterbo" | "gran_sasso";
export type Store = "Viterbo" | "Gran Sasso";

export type LoginProfile = {
  username: string;
  email: string;
  role: Role;
  store: Store | null;
  displayName: string;
};

export const loginProfiles: Record<string, LoginProfile> = {
  admin: { username: "admin", email: "admin@gestionale.local", role: "admin", store: null, displayName: "Amministratore" },
  viterbo: { username: "viterbo", email: "viterbo@gestionale.local", role: "viterbo", store: "Viterbo", displayName: "Cassa Viterbo" },
  "gran-sasso": { username: "gran-sasso", email: "gran-sasso@gestionale.local", role: "gran_sasso", store: "Gran Sasso", displayName: "Cassa Gran Sasso" },
};

export function profileFromEmail(email: string | null | undefined): LoginProfile | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  return Object.values(loginProfiles).find((profile) => profile.email === normalized) ?? null;
}

export function emailForUsername(username: string): string | null {
  return loginProfiles[username.trim().toLowerCase()]?.email ?? null;
}
