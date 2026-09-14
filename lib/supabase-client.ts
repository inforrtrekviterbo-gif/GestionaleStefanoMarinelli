"use client";

/**
 * Client Supabase lato browser (solo Auth). Usa la chiave anon (pubblica).
 * L'identita' viene verificata; ruoli/negozio restano sulla tabella `users`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browser: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (browser) return browser;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY non configurate.");
  }
  browser = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return browser;
}
