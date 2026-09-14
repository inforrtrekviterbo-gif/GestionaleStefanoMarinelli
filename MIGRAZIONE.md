# Migrazione a Vercel + Supabase

Questo repo e' il clone del gestionale portato da **Cloudflare (D1 + R2 + vinext)**
a **Next standard su Vercel + Supabase (Postgres + Storage)**.

Il vecchio repo `gestionale-marinelli-prova-stampa` resta intatto come rollback.

## Cosa e' gia' stato fatto (scaffold)

- **Stack**: rimossi vinext, worker Cloudflare, vite, plugin `@cloudflare`, script
  OpenAI Sites. `package.json` ora usa `next dev` / `next build` / `next start`.
- **Database**: `lib/db.ts` e' un ponte D1 -> Postgres. Imita l'interfaccia
  `prepare/bind/first/all/run/batch` che l'app usa dappertutto e traduce il
  dialetto SQLite -> Postgres al volo (segnaposto `?`, alias camelCase,
  `INSERT OR IGNORE/REPLACE`, `RETURNING id`). Cosi' le api route (incluse le
  1076 righe di `data/route.ts`) non sono state riscritte.
- `lib/runtime-db.ts`: `database()` ora torna il ponte Postgres; schema DDL
  convertito a Postgres (`GENERATED AS IDENTITY`, `double precision`); tolti i
  `PRAGMA` a favore di `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- **Storage foto**: `lib/storage.ts` sostituisce il binding R2 `BUCKET` con
  Supabase Storage, stesso contratto `get/put/delete`.
- `next build` passa (compile + TypeScript OK).

## Da fare (prossimi passi)

1. **Creare i progetti Supabase**: uno `dev` e uno `prod` (separati). Copiare
   `.env.example` in `.env.local` e riempire `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, creare il bucket `product-photos`.
2. **Provisioning schema**: al primo avvio l'app crea le tabelle da sola
   (`ensureDatabase`). Da verificare tabella per tabella contro Postgres.
3. **Migrazione dati reale** D1 -> Postgres (dati di ora): export D1
   (`wrangler d1 export`), adattare il dump, importare in Supabase. Foto R2 ->
   bucket Supabase.
4. **Utenti**: l'admin deve poter creare nuovi utenti (nuovi negozi /
   dipendenti), con dati propri + dati condivisi. Da progettare sul modello
   `users`/`sessions` gia' esistente (vedi sotto).
5. **Auth**: valutare se togliere Firebase e passare a Supabase Auth.
6. **Ponte cassa RT**: nuovo dominio Vercel rompe il controllo `Origin` sui PC
   di cassa (vedi `NOTE-PROGETTO.md`). Intervento fisico o lista domini.

## Nota tecnica sul ponte DB

Il ponte in `lib/db.ts` copre i casi presenti nel codice attuale. Le query nuove
devono restare compatibili o usare SQL Postgres diretto. Punti delicati gia'
gestiti: alias camelCase quotati, `INSERT OR REPLACE` (upsert sulla prima
colonna), tabelle senza `id` (`app_settings`, `sessions`) escluse dal
`RETURNING id`.

## Modello utenti / dati condivisi (da decidere)

Base gia' presente: tabella `users` (ruolo `admin` / `viterbo` / `gran_sasso`,
campo `store`), `sessions`, password con hash+salt. Serve decidere quali entita'
sono **private per utente** e quali **condivise** (per negozio / globali) e
aggiungere dove serve `owner_user_id` + un campo `visibility`.
