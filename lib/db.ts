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

type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

export function getSql(): Sql {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL non configurato (stringa Postgres Supabase).");
  sql = postgres(url, {
    // Supabase pooler (transaction mode) non supporta prepared statement lato server.
    prepare: false,
    // Le date nello schema sono TEXT ISO: nessuna conversione automatica.
    types: {},
    max: 5,
    idle_timeout: 20,
  });
  return sql;
}

// Tabelle senza colonna `id` autoincrementale: niente RETURNING id.
const NO_ID_TABLES = new Set(["app_settings", "sessions"]);

/** Traduce una query SQLite nel dialetto Postgres. Ritorna anche i metadati utili. */
export function translateSql(input: string): { text: string; conflictInsert: boolean } {
  let text = input;
  let conflictInsert = false;

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

type Executor = { unsafe: (query: string, params?: unknown[]) => Promise<unknown> };

async function execute(executor: Executor, rawSql: string, values: unknown[]) {
  const { text: translated } = translateSql(rawSql);
  let text = numberPlaceholders(translated);

  const table = insertTable(text);
  const wantsReturning =
    !!table && !NO_ID_TABLES.has(table) && !/RETURNING/i.test(text);
  if (wantsReturning) text = `${text} RETURNING id`;

  const rows = (await executor.unsafe(text, values)) as Array<Record<string, unknown>> & {
    count?: number;
  };
  const lastRowId =
    wantsReturning && rows.length > 0 ? (rows[0].id as number | undefined) : undefined;
  return { rows: Array.from(rows), count: rows.count ?? rows.length, lastRowId };
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

function makeStatement(executor: Executor, rawSql: string, values: unknown[] = []): D1Statement {
  return {
    __sql: rawSql,
    __values: values,
    bind(...next: unknown[]) {
      return makeStatement(executor, rawSql, next);
    },
    async first<T = Record<string, unknown>>(columnName?: string) {
      const { rows } = await execute(executor, rawSql, values);
      const row = rows[0];
      if (!row) return null;
      return (columnName ? (row[columnName] as T) : (row as T)) ?? null;
    },
    async all<T = Record<string, unknown>>() {
      const { rows } = await execute(executor, rawSql, values);
      return { results: rows as T[] };
    },
    async run() {
      const { count, lastRowId } = await execute(executor, rawSql, values);
      return { success: true, meta: { last_row_id: lastRowId, changes: count } };
    },
  };
}

let cachedDb: D1Database | null = null;

/** Oggetto D1-compatibile appoggiato a Postgres. Singleton di modulo. */
export function getDb(): D1Database {
  if (cachedDb) return cachedDb;
  const base = getSql();
  cachedDb = {
    prepare(rawSql: string) {
      return makeStatement(base as unknown as Executor, rawSql);
    },
    async batch(statements: D1Statement[]) {
      return base.begin(async (tx) => {
        const results: D1RunResult[] = [];
        for (const statement of statements) {
          const { count, lastRowId } = await execute(
            tx as unknown as Executor,
            statement.__sql,
            statement.__values,
          );
          results.push({ success: true, meta: { last_row_id: lastRowId, changes: count } });
        }
        return results;
      }) as Promise<D1RunResult[]>;
    },
  };
  return cachedDb;
}
