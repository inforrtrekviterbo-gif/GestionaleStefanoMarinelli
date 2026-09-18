# Prenotazioni Fase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creare prenotazioni (prodotti/servizio) direttamente dalla pagina, con acconto opzionale, data di consegna e giacenza riservata; incasso di acconto e saldo in Cassa (scontrino RT), consegna che scala la giacenza.

**Architecture:** La pagina Prenotazioni crea/gestisce le prenotazioni via nuove action API; i movimenti di denaro passano dalla Cassa tramite uno stato "azione cassa in sospeso" (`pendingCashAction`) nello shell che precompila il carrello. La giacenza usa la colonna `inventory.reserved` (riserva alla creazione, rilascio+scarico alla consegna).

**Tech Stack:** Next.js 16, React 19, TypeScript, Postgres via shim `lib/db.ts`, API in `app/api/data/route.ts`.

**Verifica (niente test runner):** ogni task si valida con `npx tsc --noEmit` + `npx next build` (0 errori) + check manuale. Git: `/opt/homebrew/bin/git`. Commit a fine task.

**Spec:** `docs/superpowers/specs/2026-09-18-prenotazioni-fase2-design.md`

**Nota riuso:** in `createSale` (app/api/data/route.ts, loop item ~righe 795-848) esistono già: `deposit`/`repair_deposit` (creano reservation + `reserved += qtà` se open), e `reservation_balance` (chiude per codice: `quantity -= qtà`, `reserved -= qtà`). Riusiamo questi pattern.

---

## File coinvolti

- `lib/runtime-db.ts` — schema `reservations`: `issued_sale_id` nullable, nuove colonne `expected_delivery`, `deposit_paid`; ALTER idempotenti.
- `supabase/migrations/0004_reservations_phase2.sql` — nuova migrazione.
- `app/api/data/route.ts` — `bootstrap()` (SELECT reservations con nuovi campi), nuove action `createReservation` e `cancelReservation`, gestione in `createSale` dei nuovi itemType `reservation_deposit` e `reservation_credit`+chiusura consegna.
- `app/gestionale.tsx` — tipo `Reservation` (nuovi campi), stato `pendingCashAction` nello shell, pagina Prenotazioni (modal creazione + tabella + pulsanti), passaggio a `NewCashRegister`.
- `app/cash-register.tsx` — prop `pendingAction` + drenaggio nel carrello; righe bloccate per i nuovi itemType.

---

## Task 1: Schema reservations (nullable + nuove colonne)

**Files:**
- Modify: `lib/runtime-db.ts` (riga `CREATE TABLE ... reservations` in `schemaStatements`; blocco ALTER in `ensureDatabase`)
- Create: `supabase/migrations/0004_reservations_phase2.sql`

- [ ] **Step 1: CREATE TABLE aggiornata (fresh DB)**

In `lib/runtime-db.ts`, nella riga di `schemaStatements` che crea `reservations`, cambiare `issued_sale_id INTEGER NOT NULL REFERENCES sales(id)` in `issued_sale_id INTEGER REFERENCES sales(id)` e aggiungere in coda alle colonne (prima di `created_at`): `expected_delivery TEXT, deposit_paid INTEGER NOT NULL DEFAULT 0,`. Risultato (colonne): `... balance_due double precision NOT NULL, status TEXT NOT NULL, issued_sale_id INTEGER REFERENCES sales(id), redeemed_sale_id INTEGER REFERENCES sales(id), expected_delivery TEXT, deposit_paid INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL`.

- [ ] **Step 2: ALTER idempotenti (DB esistenti)**

In `ensureDatabase`, subito dopo la riga `try { await db.prepare(\`ALTER TABLE gift_cards ALTER COLUMN expires_at DROP NOT NULL\`).run(); } catch {}`, aggiungere:

```ts
  try { await db.prepare(`ALTER TABLE reservations ALTER COLUMN issued_sale_id DROP NOT NULL`).run(); } catch { /* già nullable */ }
  await db.prepare(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS expected_delivery TEXT`).run();
  await db.prepare(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_paid INTEGER NOT NULL DEFAULT 0`).run();
```

- [ ] **Step 3: Migrazione**

Create `supabase/migrations/0004_reservations_phase2.sql`:

```sql
-- Prenotazioni creabili da pagina, con consegna prevista e stato acconto.
ALTER TABLE reservations ALTER COLUMN issued_sale_id DROP NOT NULL;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS expected_delivery TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_paid INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Verifica**

Run: `npx tsc --noEmit && npx next build` → 0 errori. `npm run dev` avvia senza errori (ensureDatabase applica gli ALTER).

- [ ] **Step 5: Commit**

```bash
/opt/homebrew/bin/git add lib/runtime-db.ts supabase/migrations/0004_reservations_phase2.sql
/opt/homebrew/bin/git commit -m "Prenotazioni: schema (issued_sale_id nullable, expected_delivery, deposit_paid)"
```

---

## Task 2: Bootstrap — nuovi campi reservation

**Files:**
- Modify: `app/api/data/route.ts` (query `reservationRows` in `bootstrap()`, ~riga 181)
- Modify: `app/gestionale.tsx` (tipo `Reservation`, riga 19)

- [ ] **Step 1: SELECT con nuovi campi**

In `app/api/data/route.ts`, nella query `reservationRows` (SELECT da `reservations r`), aggiungere alle colonne selezionate: `r.expected_delivery AS expectedDelivery, r.deposit_paid AS depositPaid`. Inserirle vicino a `r.status`, es. dopo `r.balance_due AS balanceDue,` aggiungere `r.expected_delivery AS expectedDelivery, r.deposit_paid AS depositPaid,`.

- [ ] **Step 2: Tipo Reservation client**

In `app/gestionale.tsx` riga 19, in fondo all'oggetto `type Reservation = { ... }` aggiungere: `expectedDelivery: string | null; depositPaid: number;`.

- [ ] **Step 3: Verifica**

Run: `npx tsc --noEmit && npx next build` → 0 errori.

- [ ] **Step 4: Commit**

```bash
/opt/homebrew/bin/git add app/api/data/route.ts app/gestionale.tsx
/opt/homebrew/bin/git commit -m "Prenotazioni: bootstrap con expectedDelivery e depositPaid"
```

---

## Task 3: API createReservation + cancelReservation

**Files:**
- Modify: `app/api/data/route.ts` (nuove funzioni + registrazione action)

- [ ] **Step 1: Funzione createReservation**

In `app/api/data/route.ts`, vicino alle altre action (es. dopo `createTransfer`), aggiungere. Usa gli helper esistenti `adminOnly` NON va bene (anche i cassieri devono poter prenotare): consenti admin o cassiere del proprio negozio.

```ts
async function createReservation(user: SessionUser, body: JsonMap) {
  const store = validStore(body.store) ? body.store : user.store;
  if (!store) return json({ error: "Seleziona il negozio." }, 400);
  if (user.role !== "admin" && user.store !== store) return json({ error: "Puoi prenotare solo per il tuo negozio." }, 403);
  const type = stringValue(body.type) === "service" ? "service" : "product";
  const note = stringValue(body.note);
  const expectedDelivery = stringValue(body.expectedDelivery).trim();
  if (expectedDelivery && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDelivery)) return json({ error: "Data di consegna non valida." }, 400);
  const deposit = Math.max(0, Math.round(numberValue(body.depositAmount) * 100) / 100);

  // Cliente: id esistente oppure crea da nome/cognome.
  let customerId: number | null = body.customerId != null ? Math.round(numberValue(body.customerId)) : null;
  if (!customerId) {
    const firstName = stringValue(body.firstName).trim();
    const lastName = stringValue(body.lastName).trim();
    if (firstName || lastName) {
      const created = await database().prepare(`INSERT INTO customers (customer_type, first_name, last_name, company_name, vat_number, pec, sdi_code, phone, email, address, postal_code, city, province, tax_code, scope, created_store, created_at) VALUES ('private', ?, ?, '', '', '', '', '', '', '', '', '', '', '', ?, ?, ?)`)
        .bind(firstName, lastName, store, store, new Date().toISOString()).run();
      customerId = Number(created.meta?.last_row_id) || null;
    }
  }

  // Righe e totale.
  const items = type === "product" ? normalizeReservationLines(body.items) : [];
  const description = type === "service" ? (stringValue(body.serviceDescription).trim() || "Servizio") : "Prenotazione prodotti";
  const total = type === "service"
    ? Math.max(0, Math.round(numberValue(body.serviceAmount) * 100) / 100)
    : Math.round(items.reduce((sum, item) => sum + item.quantity * item.unitPrice * (1 - item.discountPercent / 100), 0) * 100) / 100;
  if (total <= 0) return json({ error: "Aggiungi almeno un articolo o un importo." }, 400);
  if (deposit > total) return json({ error: "L'acconto non può superare il totale." }, 400);

  const code = ean13();
  const now = new Date().toISOString();
  const balanceDue = Math.round((total - deposit) * 100) / 100;
  const created = await database().prepare(`INSERT INTO reservations (code, store, customer_id, product_id, description, kind, total_price, deposit_amount, balance_due, status, issued_sale_id, expected_delivery, deposit_paid, created_at) VALUES (?, ?, ?, NULL, ?, 'reservation', ?, ?, ?, 'open', NULL, ?, 0, ?)`)
    .bind(code, store, customerId, description, total, deposit, balanceDue, expectedDelivery || null, now).run();
  const reservationId = Number(created.meta?.last_row_id);
  if (!reservationId) return json({ error: "Prenotazione non registrata." }, 500);
  for (const item of items) {
    if (!item.productId) continue;
    await database().prepare(`INSERT INTO reservation_items (reservation_id, product_id, description, quantity, unit_price, discount_percent) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(reservationId, item.productId, item.description, item.quantity, item.unitPrice, item.discountPercent).run();
    await database().prepare(`UPDATE inventory SET reserved = reserved + ? WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, store).run();
  }
  await logActivity({ user, action: "create", entity: "reservation", entityId: reservationId, detail: `Prenotazione ${code} · ${description}`, store });
  return json({ ok: true, id: reservationId, code });
}
```

> `normalizeReservationLines` esiste già (usato in createSale). `ean13`, `validStore`, `stringValue`, `numberValue`, `logActivity` sono importati. Verificare la firma reale di `logActivity` e adeguare.

- [ ] **Step 2: Funzione cancelReservation**

```ts
async function cancelReservation(user: SessionUser, body: JsonMap) {
  const id = Math.round(numberValue(body.id));
  const reservation = await database().prepare(`SELECT id, store, status FROM reservations WHERE id = ?`).bind(id).first<{ id: number; store: Store; status: string }>();
  if (!reservation) return json({ error: "Prenotazione non trovata." }, 404);
  if (user.role !== "admin" && user.store !== reservation.store) return json({ error: "Operazione non consentita." }, 403);
  if (reservation.status !== "open") return json({ error: "Solo le prenotazioni aperte possono essere annullate." }, 409);
  const items = await all<{ productId: number | null; quantity: number }>(`SELECT product_id AS productId, quantity FROM reservation_items WHERE reservation_id = ?`, id);
  for (const item of items) if (item.productId) await database().prepare(`UPDATE inventory SET reserved = MAX(reserved - ?, 0) WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, reservation.store).run();
  await database().prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?`).bind(id).run();
  await logActivity({ user, action: "cancel", entity: "reservation", entityId: id, store: reservation.store });
  return json({ ok: true });
}
```

- [ ] **Step 3: Registrare le action**

Dove sono mappate le action POST, aggiungere accanto a `createTransfer`:

```ts
  if (action === "createReservation") return createReservation(auth.user, body);
  if (action === "cancelReservation") return cancelReservation(auth.user, body);
```

- [ ] **Step 4: Verifica**

Run: `npx tsc --noEmit && npx next build` → 0 errori.
Manuale (dev, admin): in console browser `fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'createReservation',type:'service',firstName:'Mario',lastName:'Rossi',serviceDescription:'Cerata giacca',serviceAmount:40,depositAmount:10,store:'Viterbo'})}).then(r=>r.json()).then(console.log)` → `{ok:true,...}`. GET /api/data mostra la prenotazione.

- [ ] **Step 5: Commit**

```bash
/opt/homebrew/bin/git add app/api/data/route.ts
/opt/homebrew/bin/git commit -m "Prenotazioni: API createReservation e cancelReservation (riserva/rilascio stock)"
```

---

## Task 4: createSale — incasso acconto e consegna prenotazione

**Files:**
- Modify: `app/api/data/route.ts` (loop item in `createSale`, dopo il blocco `reservation_balance` ~riga 847)

- [ ] **Step 1: Gestire i nuovi itemType**

Nel loop `for (const item of items)` di `createSale`, subito dopo il blocco `if (item.itemType === "reservation_balance") { ... }`, aggiungere:

```ts
    if (item.itemType === "reservation_deposit") {
      const reservationId = Math.round(numberValue(item.metadata.reservationId));
      if (reservationId) await database().prepare(`UPDATE reservations SET deposit_paid = 1, issued_sale_id = ? WHERE id = ? AND status = 'open'`).bind(saleId, reservationId).run();
    }
    if (item.itemType === "reservation_credit") {
      // riga negativa: nessun effetto qui, la chiusura è gestita dal marker sotto.
    }
    if (numberValue(item.metadata.deliverReservationId) > 0) {
      const reservationId = Math.round(numberValue(item.metadata.deliverReservationId));
      const reserved = await all<{ productId: number | null; quantity: number }>(`SELECT product_id AS productId, quantity FROM reservation_items WHERE reservation_id = ?`, reservationId);
      for (const line of reserved) if (line.productId) await database().prepare(`UPDATE inventory SET reserved = MAX(reserved - ?, 0) WHERE product_id = ? AND store = ?`).bind(line.quantity, line.productId, store).run();
      await database().prepare(`UPDATE reservations SET status = 'delivered', redeemed_sale_id = ? WHERE id = ? AND status = 'open'`).bind(saleId, reservationId).run();
    }
```

> Nota: alla consegna le righe prodotto della prenotazione arrivano nel carrello come `itemType: "product"` → la giacenza (`quantity`) viene scalata dal blocco esistente (riga ~799). Il marker `metadata.deliverReservationId` (impostato su una riga del carrello) rilascia il `reserved` e chiude la prenotazione. La riga `reservation_credit` (negativa) riduce il totale dell'acconto già versato senza toccare il magazzino.

- [ ] **Step 2: Verifica**

Run: `npx tsc --noEmit && npx next build` → 0 errori.

- [ ] **Step 3: Commit**

```bash
/opt/homebrew/bin/git add app/api/data/route.ts
/opt/homebrew/bin/git commit -m "Prenotazioni: createSale gestisce incasso acconto e consegna (rilascio stock + chiusura)"
```

---

## Task 5: Shell — stato pendingCashAction + passaggio alla Cassa

**Files:**
- Modify: `app/gestionale.tsx` (componente `Gestionale`, stato + content map)
- Modify: `app/cash-register.tsx` (prop `pendingAction` + drenaggio)

- [ ] **Step 1: Tipo condiviso e stato nello shell**

In `app/cash-register.tsx`, dopo `export type CartItem = {...}`, esportare il tipo azione:

```ts
export type PendingCashAction = { kind: "reservationDeposit" | "reservationDelivery"; reservationId: number; label: string; lines: CartItem[] };
```

In `app/gestionale.tsx`, importarlo nell'import di `./cash-register` (`type PendingCashAction`). Nello stato di `Gestionale`, vicino a `saleQueue`, aggiungere:

```ts
  const [pendingCashAction, setPendingCashAction] = useState<import("./cash-register").PendingCashAction | null>(null);
```

(oppure importare il tipo e usarlo direttamente). 

- [ ] **Step 2: Passare alla Cassa e consumarlo**

Nel `content` map, la voce `cash` diventa:

```tsx
cash: <NewCashRegister data={data} reload={reload} queue={saleQueue} onQueueConsumed={() => setSaleQueue([])} cart={cart} setCart={setCart} pendingAction={pendingCashAction} onPendingConsumed={() => setPendingCashAction(null)} />,
```

- [ ] **Step 3: Cassa accetta e drena pendingAction**

In `app/cash-register.tsx`, firma di `CashRegister`: aggiungere `pendingAction, onPendingConsumed` ai props (tipizzati `pendingAction?: PendingCashAction | null; onPendingConsumed?: () => void`). Dopo l'effetto che drena `queue`, aggiungere:

```ts
  useEffect(() => {
    if (!pendingAction) return;
    setCart(pendingAction.lines);
    setNotice(pendingAction.label);
    onPendingConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction]);
```

- [ ] **Step 4: Righe bloccate per i nuovi itemType**

In `CartRow` (app/cash-register.tsx), nell'array degli itemType non modificabili, aggiungere `"reservation_deposit"` e `"reservation_credit"`. Cioè da:
`!["gift", "deposit", "repair_deposit", "return", "reservation_balance"].includes(item.itemType)`
a:
`!["gift", "deposit", "repair_deposit", "return", "reservation_balance", "reservation_deposit", "reservation_credit"].includes(item.itemType)`

- [ ] **Step 5: Verifica**

Run: `npx tsc --noEmit && npx next build` → 0 errori.

- [ ] **Step 6: Commit**

```bash
/opt/homebrew/bin/git add app/gestionale.tsx app/cash-register.tsx
/opt/homebrew/bin/git commit -m "Cassa: azione in sospeso (acconto/consegna prenotazione) precaricata nel carrello"
```

---

## Task 6: Pagina Prenotazioni — creazione, azioni

**Files:**
- Modify: `app/gestionale.tsx` (componente `ReservationSummary` non-repair: aggiungere creazione + pulsanti; helper per costruire `pendingCashAction`)

Il componente `ReservationSummary` è reso sia per Prenotazioni (repair=false) sia Risuolature (repair=true). Le novità di questo task valgono SOLO per `repair === false`. La pagina ha bisogno di `setPage` e `setPendingCashAction` dallo shell: passarli come props opzionali.

- [ ] **Step 1: Props extra dallo shell**

In `content` map, cambiare la voce `reservations`:

```tsx
reservations: <ReservationSummary data={data} reload={reload} goToCash={(action) => { setPendingCashAction(action); setPage("cash"); }} />,
```

In `ReservationSummary`, firma: aggiungere `goToCash?: (action: import("./cash-register").PendingCashAction) => void`.

- [ ] **Step 2: Stato creazione + costruzione azioni cassa**

Dentro `ReservationSummary`, quando `!repair`, aggiungere stato per il modal e le funzioni. Inserire dopo `const isAdmin = ...`:

```tsx
  const [showNew, setShowNew] = useState(false);
  const keyRes = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  function incassaAcconto(reservation: Reservation) {
    if (!goToCash) return;
    goToCash({ kind: "reservationDeposit", reservationId: reservation.id, label: `Incasso acconto prenotazione ${reservation.code}`, lines: [{ key: keyRes(), productId: null, description: `Acconto prenotazione ${reservation.code}`, quantity: 1, unitPrice: reservation.depositAmount, itemType: "reservation_deposit", locked: true, metadata: { reservationId: reservation.id } }] });
  }
  async function consegna(reservation: Reservation) {
    if (!goToCash) return;
    const detail = await readJson(await fetch(`/api/data?view=reservation&code=${encodeURIComponent(reservation.code)}`, { cache: "no-store" })).catch(() => null);
    const items = (detail?.items ?? []) as { productId: number | null; description: string; quantity: number; unitPrice: number; discountPercent: number }[];
    const lines: import("./cash-register").CartItem[] = items.filter((row) => row.productId).map((row, index) => ({ key: `${keyRes()}-${index}`, productId: row.productId, description: row.description, quantity: row.quantity, unitPrice: row.unitPrice, itemType: "product", metadata: index === 0 ? { deliverReservationId: reservation.id } : {} }));
    if (!lines.length) lines.push({ key: keyRes(), productId: null, description: reservation.description, quantity: 1, unitPrice: reservation.totalPrice, itemType: "service", metadata: { deliverReservationId: reservation.id } });
    if (reservation.depositPaid) lines.push({ key: keyRes(), productId: null, description: `Acconto già versato ${reservation.code}`, quantity: 1, unitPrice: -reservation.depositAmount, itemType: "reservation_credit", locked: true, metadata: { reservationId: reservation.id } });
    goToCash({ kind: "reservationDelivery", reservationId: reservation.id, label: `Consegna prenotazione ${reservation.code}`, lines });
  }
  async function cancel(reservation: Reservation) { if (!confirm(`Annullare la prenotazione ${reservation.code}? La merce riservata verrà liberata.`)) return; setError(""); try { await post("cancelReservation", { id: reservation.id }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
```

> Il tipo `CartItem` (cassa) qui usato: importare `type CartItem as CashCartItem` da `./cash-register` in `app/gestionale.tsx` e usarlo al posto di `import("./cash-register").CartItem`. Verificare la vista API `view=reservation` (esiste già: usata da `editTransfer`? no — controllare che `/api/data?view=reservation&code=` ritorni `{ items }`; in caso contrario usare `view=code` che per un codice prenotazione ritorna `{ kind:"reservation", record, items }`).

- [ ] **Step 3: Bottone "Nuova prenotazione" + modal**

Nella `screen-head` (ramo `!repair`), aggiungere `<div className="head-controls"><button className="primary" onClick={() => setShowNew(true)}><MaterialIcon>add</MaterialIcon> Nuova prenotazione</button></div>`. Prima di `</section>` aggiungere il modal:

```tsx
{!repair && showNew && <Modal title="Nuova prenotazione" wide onClose={() => setShowNew(false)}><ReservationNewForm data={data} reload={reload} onClose={() => setShowNew(false)} /></Modal>}
```

- [ ] **Step 4: Colonne e azioni in tabella (solo !repair)**

Nella tabella, quando `!repair`, aggiungere una colonna "Consegna prevista" (`reservation.expectedDelivery ? new Date(...).toLocaleDateString("it-IT") : "—"`) e nella colonna azioni i pulsanti (oltre a Stampa/Modifica/Rimuovi): 
`{reservation.status === "open" && reservation.depositAmount > 0 && !reservation.depositPaid && <button className="secondary small" onClick={() => incassaAcconto(reservation)}>Incassa acconto</button>}`
`{reservation.status === "open" && <button className="primary small" onClick={() => void consegna(reservation)}>Consegna</button>}`
`{reservation.status === "open" && isAdmin && <button className="text-button negative" onClick={() => void cancel(reservation)}>Annulla</button>}`
Mostrare anche il badge acconto: `{reservation.depositPaid ? <span className="status active">acconto incassato</span> : reservation.depositAmount > 0 ? <span className="status warning">acconto da incassare</span> : null}`.

- [ ] **Step 5: Componente ReservationNewForm**

Aggiungere in `app/gestionale.tsx` (vicino a `ReservationSummary`):

```tsx
function ReservationNewForm({ data, reload, onClose }: { data: Bootstrap; reload: () => Promise<void>; onClose: () => void }) {
  const [type, setType] = useState<"product" | "service">("product");
  const [firstName, setFirstName] = useState(""); const [lastName, setLastName] = useState("");
  const [items, setItems] = useState<{ key: string; productId: number; description: string; quantity: number; unitPrice: number }[]>([]);
  const [serviceDescription, setServiceDescription] = useState(""); const [serviceAmount, setServiceAmount] = useState("");
  const [deposit, setDeposit] = useState(""); const [expectedDelivery, setExpectedDelivery] = useState(""); const [note, setNote] = useState("");
  const [store, setStore] = useState<Store>(data.user.store ?? "Viterbo");
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  function addProduct(product: Product) { if (items.some((i) => i.productId === product.id)) return; setItems((c) => [...c, { key: `${Date.now()}-${product.id}`, productId: product.id, description: `${product.brand ? product.brand + " · " : ""}${product.name} · ${product.color} ${product.size}`, quantity: 1, unitPrice: product.price }]); }
  const total = type === "service" ? Number(serviceAmount) || 0 : items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (isClientTestMode()) { setError("Modalità TEST attiva: prenotazione non salvata."); return; }
    setSaving(true);
    try {
      await post("createReservation", { type, firstName, lastName, items: items.map(({ productId, description, quantity, unitPrice }) => ({ productId, description, quantity, unitPrice })), serviceDescription, serviceAmount: Number(serviceAmount) || 0, depositAmount: Number(deposit) || 0, expectedDelivery, note, store });
      await reload(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
    finally { setSaving(false); }
  }
  return <form className="stack" onSubmit={save}>
    <div className="customer-type-tabs"><button type="button" className={type === "product" ? "active" : ""} onClick={() => setType("product")}>Prodotti</button><button type="button" className={type === "service" ? "active" : ""} onClick={() => setType("service")}>Servizio</button></div>
    <div className="form-grid"><ClearableInput label="Nome cliente" value={firstName} onChange={setFirstName} /><ClearableInput label="Cognome cliente" value={lastName} onChange={setLastName} /></div>
    {type === "product" ? <><ProductSearch compact products={data.products} store={store} onAdd={addProduct} /><div className="cart-list">{items.map((item) => <div className="cart-row" key={item.key}><div className="cart-desc"><strong>{item.description}</strong></div><ClearableInput compact type="number" min="1" value={item.quantity} onChange={(v) => setItems((c) => c.map((r) => r.key === item.key ? { ...r, quantity: Number(v) || 1 } : r))} /><ClearableInput compact type="number" min="0" step="0.01" value={item.unitPrice} onChange={(v) => setItems((c) => c.map((r) => r.key === item.key ? { ...r, unitPrice: Number(v) || 0 } : r))} /><button type="button" className="icon-button" onClick={() => setItems((c) => c.filter((r) => r.key !== item.key))}><MaterialIcon>close</MaterialIcon></button></div>)}{!items.length && <Empty>Aggiungi i prodotti da prenotare.</Empty>}</div></> : <div className="form-grid"><ClearableInput className="full" label="Descrizione servizio" value={serviceDescription} onChange={setServiceDescription} required /><ClearableInput label="Importo servizio" type="number" min="0" step="0.01" value={serviceAmount} onChange={setServiceAmount} required /></div>}
    <div className="form-grid"><ClearableInput label="Acconto (facoltativo)" type="number" min="0" step="0.01" value={deposit} onChange={setDeposit} /><ClearableInput label="Consegna prevista (facoltativa)" type="date" value={expectedDelivery} onChange={setExpectedDelivery} /><label className="field"><span>Negozio</span><select value={store} onChange={(e) => setStore(e.target.value as Store)}><option>Viterbo</option><option>Gran Sasso</option></select></label></div>
    <ClearableInput className="full" label="Note (facoltative)" value={note} onChange={setNote} />
    <div className="total-line"><span>Totale prenotazione</span><b>{money(total)}</b></div>
    {error && <div className="alert danger">{error}</div>}
    <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button className="primary" disabled={saving || total <= 0}>{saving ? "Salvataggio…" : "Crea prenotazione"}</button></div>
  </form>;
}
```

> `ProductSearch`, `ClearableInput`, `Empty`, `money`, `isClientTestMode`, `MaterialIcon`, `Modal`, `Product`, `Store` esistono in `app/gestionale.tsx`. Verificare i nomi esatti.

- [ ] **Step 6: Verifica**

Run: `npx tsc --noEmit && npx next build` → 0 errori.

- [ ] **Step 7: Commit**

```bash
/opt/homebrew/bin/git add app/gestionale.tsx
/opt/homebrew/bin/git commit -m "Prenotazioni: pagina con creazione (prodotti/servizio), incassa acconto, consegna, annulla"
```

---

## Task 7: Verifica end-to-end

- [ ] **Step 1: Build pulito** — Run: `npx tsc --noEmit && npx next build` → 0 errori.

- [ ] **Step 2: Checklist manuale (dev)**

`npm run dev`, admin:
- Crea prenotazione **Prodotti** (2 articoli, acconto 20, consegna tra 7gg) → compare in elenco, badge "acconto da incassare"; in Magazzino la giacenza mostra `reserved` aumentato (Viterbo).
- "Incassa acconto" → apre Cassa con riga acconto 20 bloccata → Completa vendita (contanti) → torna in Prenotazioni: badge "acconto incassato".
- "Consegna" → apre Cassa con i prodotti + riga "Acconto già versato" −20 → totale = totale−20; Completa → prenotazione "delivered"; in Magazzino `quantity` scalata e `reserved` tornato al valore iniziale.
- Crea prenotazione **Servizio** con acconto 0 → "Consegna" apre Cassa con riga servizio, paga intero → chiusa.
- "Annulla" su una aperta → stato cancelled, `reserved` liberato.
- TEST mode: creazione non salva.

- [ ] **Step 3: Commit (se fix)**

```bash
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "Prenotazioni: rifiniture dopo verifica end-to-end"
```

---

## Self-review (coverage spec)

- Schema (issued_sale_id nullable, expected_delivery, deposit_paid) → Task 1. ✓
- Bootstrap nuovi campi → Task 2. ✓
- createReservation (riserva stock, cliente crea, prodotti/servizio, acconto opz) → Task 3. ✓
- cancelReservation (rilascio) → Task 3. ✓
- Incasso acconto (deposit_paid + issued_sale_id) → Task 4 (`reservation_deposit`). ✓
- Consegna (scarico prodotti + rilascio reserved + chiusura + credito acconto) → Task 4 (`deliverReservationId` + `reservation_credit`) + Task 6 (costruzione righe). ✓
- Aggancio pagina→cassa (`pendingCashAction`) → Task 5. ✓
- UI pagina (modal, tabella, pulsanti, consegna prevista, badge) → Task 6. ✓
- Fuori scope invariato; risuolature intatte (ramo repar). ✓

Coerenza tipi: `PendingCashAction`/`CartItem` (export da cash-register), itemType `reservation_deposit`/`reservation_credit`/`deliverReservationId` usati in modo coerente tra Task 4/5/6.
