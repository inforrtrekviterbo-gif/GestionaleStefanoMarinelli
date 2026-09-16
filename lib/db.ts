/**
 * Ponte D1 -> Postgres (Supabase).
 *
 * L'app e' nata su Cloudflare D1 (SQLite) e usa dappertutto l'interfaccia
 * `db.prepare(sql).bind(...).first()/all()/run()` con SQL scritto a mano nel
 * dialetto SQLite. Per non riscrivere migliaia di righe di query, questo modulo
 * espone lo STESSO oggetto (`D1Database`-like) ma lo esegue su Postgres via
 * postgres.js, traducendo al volo le differenze di dialetto:
 *
 *   - segnaposto `?`            -> `$1, $2, ...`
 *   - alias camelCase `AS xNome`-> `AS "xNome"` (Postgres altrimenti li abbassa)
 *   - `INSERT OR IGNORE`        -> `INSERT ... ON CONFLICT DO NOTHING`
 *   - `INSERT OR REPLACE`       -> `INSERT ... ON CONFLICT (<1a col>) DO UPDATE`
 *   - `UPDATE OR IGNORE`        -> `UPDATE`
 *   - `.run()` su INSERT        -> aggiunge `RETURNING id` per `meta.last_row_id`
 *
 * Cosi' `lib/runtime-db.ts` e le api route continuano a funzionare invariate.
 */
import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

// Scope per-richiesta: se sandbox=true le query vanno sullo schema `sandbox`
// (dati finti isolati dell'account test); altrimenti sullo schema reale.
export const dbScope = new AsyncLocalStorage<{ sandbox: boolean }>();
export function withDbScope<T>(fn: () => Promise<T>): Promise<T> {
  return dbScope.run({ sandbox: false }, fn);
}
export function useSandbox() {
  const store = dbScope.getStore();
  if (store) store.sandbox = true;
}
function inSandbox(): boolean {
  return dbScope.getStore()?.sandbox === true;
}

/**
 * Due backend:
 *  - PRODUZIONE / Supabase: se c'e' DATABASE_URL usa postgres.js.
 *  - SVILUPPO senza configurazione: se DATABASE_URL manca usa pglite, un
 *    Postgres in-process (WASM) persistito su file locale. Cosi' `npm run dev`
 *    funziona subito, senza server ne' Supabase.
 */
type QueryResult = { rows: Record<string, unknown>[]; count: number };
type Backend = {
  query: (text: string, params: unknown[]) => Promise<QueryResult>;
  begin: <T>(fn: (tx: Backend) => Promise<T>) => Promise<T>;
};

export function isDevDb(): boolean {
  return !process.env.DATABASE_URL;
}

let mainPromise: Promise<Backend> | null = null;
let sandboxPromise: Promise<Backend> | null = null;

async function createBackend(mode: "main" | "sandbox"): Promise<Backend> {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Sandbox: pooler in session-mode (5432) con search_path sandbox,public
    // (le tabelle dati stanno in sandbox; users/sessions/app_settings solo in public).
    const connUrl = mode === "sandbox" ? url.replace(":6543", ":5432") : url;
    const options: Record<string, unknown> = { prepare: false, types: {}, max: mode === "sandbox" ? 3 : 5, idle_timeout: 20 };
    if (mode === "sandbox") options.connection = { search_path: "sandbox, public" };
    const sql = postgres(connUrl, options);
    const wrap = (executor: ReturnType<typeof postgres>): Backend => ({
      async query(text, params) {
        const result = await executor.unsafe(text, params as never[]);
        const rows = Array.from(result) as Record<string, unknown>[];
        return { rows, count: (result as { count?: number }).count ?? rows.length };
      },
      begin(fn) {
        return sql.begin((tx) => fn(wrap(tx as unknown as ReturnType<typeof postgres>))) as Promise<never>;
      },
    });
    return wrap(sql);
  }
  // pglite (dev). Import dinamico: non entra nel bundle di produzione.
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(process.env.PGLITE_PATH ?? ".pglite");
  await pg.waitReady;
  const wrap = (executor: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Backend => ({
    async query(text, params) {
      const result = await executor.query(text, params);
      const rows = result.rows as Record<string, unknown>[];
      return { rows, count: result.affectedRows ?? rows.length };
    },
    begin(fn) {
      return pg.transaction(async (tx) => fn(wrap(tx))) as Promise<never>;
    },
  });
  return wrap(pg);
}

function getBackend(): Promise<Backend> {
  if (inSandbox() && process.env.DATABASE_URL) {
    if (!sandboxPromise) sandboxPromise = createBackend("sandbox");
    return sandboxPromise;
  }
  if (!mainPromise) mainPromise = createBackend("main");
  return mainPromise;
}

// Tabelle senza colonna `id` autoincrementale: niente RETURNING id.
const NO_ID_TABLES = new Set(["app_settings", "sessions"]);

/** Traduce una query SQLite nel dialetto Postgres. Ritorna anche i metadati utili. */
export function translateSql(input: string): { text: string; conflictInsert: boolean } {
  let text = input;
  let conflictInsert = false;

  // 0) GROUP_CONCAT (SQLite) -> string_agg (Postgres)
  text = text.replace(
    /GROUP_CONCAT\(\s*(DISTINCT\s+)?([^,()]+?)(?:\s*,\s*([^()]+?))?\s*\)/gi,
    (_whole, distinct: string | undefined, expr: string, sep: string | undefined) =>
      `string_agg(${distinct ? "DISTINCT " : ""}${expr.trim()}, ${sep ? sep.trim() : "','"})`,
  );

  // 1) alias camelCase -> quotati (salta i cast ALLCAPS come `AS INTEGER`)
  text = text.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g, (whole, alias: string) => {
    const hasUpper = /[A-Z]/.test(alias);
    const hasLower = /[a-z]/.test(alias);
    return hasUpper && hasLower ? `AS "${alias}"` : whole;
  });

  // 2) INSERT OR REPLACE INTO t (c1, c2, ...) -> upsert su prima colonna
  text = text.replace(
    /INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/i,
    (_whole, table: string, cols: string) => {
      const columns = cols.split(",").map((c) => c.trim());
      const key = columns[0];
      const updates = columns
        .slice(1)
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      conflictInsert = true;
      const suffix = updates
        ? `ON CONFLICT (${key}) DO UPDATE SET ${updates}`
        : `ON CONFLICT (${key}) DO NOTHING`;
      // Il marcatore viene chiuso piu' avanti (dopo eventuale VALUES/SELECT).
      return `INSERT INTO ${table} (${cols}) /*__UPSERT__ ${suffix} */`;
    },
  );

  // 3) INSERT OR IGNORE -> ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE/i.test(text)) {
    text = text.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    text = `${text} ON CONFLICT DO NOTHING`;
    conflictInsert = true;
  }

  // chiude l'upsert di INSERT OR REPLACE spostando la clausola in coda
  const upsertMatch = text.match(/\/\*__UPSERT__ (.*?) \*\//);
  if (upsertMatch) {
    text = text.replace(/\s*\/\*__UPSERT__ .*? \*\//, "");
    text = `${text} ${upsertMatch[1]}`;
  }

  // 4) UPDATE OR IGNORE -> UPDATE
  text = text.replace(/UPDATE\s+OR\s+IGNORE/i, "UPDATE");

  return { text, conflictInsert };
}

/** `?` posizionali -> `$1, $2, ...` (l'app non usa `?` dentro stringhe letterali). */
function numberPlaceholders(text: string): string {
  let index = 0;
  return text.replace(/\?/g, () => `$${(index += 1)}`);
}

function insertTable(text: string): string | null {
  const match = text.match(/^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return match ? match[1].toLowerCase() : null;
}

async function execute(backend: Backend, rawSql: string, values: unknown[]) {
  const { text: translated } = translateSql(rawSql);
  let text = numberPlaceholders(translated);

  const table = insertTable(text);
  const wantsReturning =
    !!table && !NO_ID_TABLES.has(table) && !/RETURNING/i.test(text);
  if (wantsReturning) text = `${text} RETURNING id`;

  const { rows, count } = await backend.query(text, values);
  const lastRowId =
    wantsReturning && rows.length > 0 ? (rows[0].id as number | undefined) : undefined;
  return { rows, count, lastRowId };
}

export type D1RunResult = { success: boolean; meta: { last_row_id?: number; changes: number } };
export type D1AllResult<T> = { results: T[] };

export type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T = Record<string, unknown>>(columnName?: string) => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<D1AllResult<T>>;
  run: () => Promise<D1RunResult>;
  __sql: string;
  __values: unknown[];
};

export type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1RunResult[]>;
};

function makeStatement(rawSql: string, values: unknown[] = []): D1Statement {
  return {
    __sql: rawSql,
    __values: values,
    bind(...next: unknown[]) {
      return makeStatement(rawSql, next);
    },
    async first<T = Record<string, unknown>>(columnName?: string) {
      const { rows } = await execute(await getBackend(), rawSql, values);
      const row = rows[0];
      if (!row) return null;
      return (columnName ? (row[columnName] as T) : (row as T)) ?? null;
    },
    async all<T = Record<string, unknown>>() {
      const { rows } = await execute(await getBackend(), rawSql, values);
      return { results: rows as T[] };
    },
    async run() {
      const { count, lastRowId } = await execute(await getBackend(), rawSql, values);
      return { success: true, meta: { last_row_id: lastRowId, changes: count } };
    },
  };
}

let cachedDb: D1Database | null = null;

/** Oggetto D1-compatibile appoggiato al backend attivo (Postgres o pglite). */
export function getDb(): D1Database {
  if (cachedDb) return cachedDb;
  cachedDb = {
    prepare(rawSql: string) {
      return makeStatement(rawSql);
    },
    async batch(statements: D1Statement[]) {
      const backend = await getBackend();
      return backend.begin(async (tx) => {
        const results: D1RunResult[] = [];
        for (const statement of statements) {
          const { count, lastRowId } = await execute(tx, statement.__sql, statement.__values);
          results.push({ success: true, meta: { last_row_id: lastRowId, changes: count } });
        }
        return results;
      });
    },
  };
  return cachedDb;
}
