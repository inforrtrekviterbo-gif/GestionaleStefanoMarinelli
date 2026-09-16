"use client";

/* eslint-disable @next/next/no-img-element -- authenticated R2 images and local file previews are not compatible with the image optimizer */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import NewCashRegister, { localFiscalBridgeRequest } from "./cash-register";
import PwaInstallButton from "./pwa-install";
import { supabaseBrowser } from "../lib/supabase-client";
import { emailForUsername } from "../lib/user-profiles";
import { isClientTestMode } from "./test-mode-banner";

type Store = "Viterbo" | "Gran Sasso";
type User = { id: number; username: string; displayName: string; role: "admin" | "viterbo" | "gran_sasso"; store: Store | null; mustChangePassword: number };
type Product = { id: number; sku: string; name: string; brand: string; category: string; color: string; size: string; price: number; variantGroup: string | null; photoKey: string | null; eans: string; viterboQty: number; viterboReserved: number; viterboReorderLevel: number; granSassoQty: number; granSassoReserved: number; granSassoReorderLevel: number };
type ProductGroup = { key: string; name: string; brand: string; category: string; variants: Product[] };
type Customer = { id: number; customerType: "private" | "company"; firstName: string; lastName: string; companyName: string; vatNumber: string; pec: string; sdiCode: string; phone: string; email: string; address: string; postalCode: string; city: string; province: string; taxCode: string; scope: string; createdStore: Store; createdAt: string };
type Sale = { id: number; receiptNo: string; store: Store; customerId: number | null; customerName: string; type: string; subtotal: number; adjustment: number; total: number; cashAmount: number; cardAmount: number; bankAmount: number; giftAmount: number; fiscalStatus: string; fiscalDocumentType: string; createdAt: string };
type Gift = { id: number; code: string; beneficiary: string; initialValue: number; balance: number; expiresAt: string; store: Store; issuedSaleId: number; status: string; createdAt: string };
type Reservation = { id: number; code: string; store: Store; customerId: number | null; productId: number | null; description: string; kind: string; totalPrice: number; depositAmount: number; balanceDue: number; status: string; issuedSaleId: number; createdAt: string; customerName: string; itemCount: number; itemDescriptions: string };
type Transfer = { id: number; code: string; fromStore: Store; toStore: Store; sender: string; receiver: string; carrier: string; transportReason: string; status: string; note: string | null; completedAt: string | null; createdAt: string; lineCount: number; totalQuantity: number };
type BusinessDocument = { id: number; number: string; type: string; recipient: string; origin: string; paymentMethod: string; saleId: number | null; netTotal: number; taxTotal: number; total: number; createdAt: string };
type SaleItemSummary = { id: number; saleId: number; productId: number | null; description: string; quantity: number; lineTotal: number; itemType: string; store: Store; createdAt: string; brand: string; productName: string; color: string; size: string; variantGroup: string };
type FiscalDevice = { id: number; store: Store; vendor: string; model: string; connector: string; enabled: number; hasToken: number; lastSeenAt: string | null; lastStatus: string; lastError: string | null; updatedAt: string };
type FiscalJob = { id: number; saleId: number; store: Store; jobType: string; status: string; attempts: number; deviceResponse: string | null; createdAt: string; claimedAt: string | null; completedAt: string | null; receiptNo: string };
type Bootstrap = { user: User; products: Product[]; customers: Customer[]; sales: Sale[]; gifts: Gift[]; reservations: Reservation[]; transfers: Transfer[]; documents: BusinessDocument[]; saleItems?: SaleItemSummary[]; fiscalDevices: FiscalDevice[]; fiscalJobs: FiscalJob[]; generatedAt: string };
type CartItem = { key: string; productId: number | null; description: string; quantity: number; unitPrice: number; itemType: string; locked?: boolean; metadata: Record<string, unknown> };

const money = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
const dateTime = (value: string) => new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
const todayPlusYear = () => new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const keyId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const variantCollator = new Intl.Collator("it", { numeric: true, sensitivity: "base" });
const customerLabel = (customer: Customer) => customer.customerType === "company" ? customer.companyName : `${customer.firstName} ${customer.lastName}`.trim();

function groupProducts(products: Product[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const product of products) {
    const fallback = `${product.brand}|${product.name}|${product.category}`.trim().toLocaleLowerCase("it");
    const key = product.variantGroup?.trim() || fallback;
    const group = groups.get(key) ?? { key, name: product.name, brand: product.brand, category: product.category, variants: [] };
    group.variants.push(product);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    variants: group.variants.sort((left, right) => variantCollator.compare(left.color, right.color) || variantCollator.compare(left.size, right.size)),
  })).sort((left, right) => `${left.brand} ${left.name}`.localeCompare(`${right.brand} ${right.name}`, "it"));
}

function searchableProduct(product: Product) {
  return `${product.brand} ${product.name} ${product.category} ${product.sku} ${product.color} ${product.size} ${product.eans}`.toLocaleLowerCase("it");
}

function makeEan13() {
  const base = `29${Date.now().toString().slice(-10)}`.slice(0, 12);
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(base[index]) * (index % 2 === 0 ? 1 : 3);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({ error: "Risposta non valida." }));
  if (!response.ok) throw Object.assign(new Error(data.error ?? "Operazione non riuscita."), { data, status: response.status });
  return data;
}

async function post(action: string, values: Record<string, unknown> = {}) {
  if (isClientTestMode()) throw new Error("Modalità TEST attiva: operazione non salvata (nessuna scrittura).");
  return readJson(await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...values }) }));
}

type ClearableInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & { label?: string; value: string | number; onChange: (value: string) => void; compact?: boolean };
function ClearableInput({ label, value, onChange, compact, className = "", ...props }: ClearableInputProps) {
  return <label className={`field ${compact ? "field-compact" : ""} ${className}`}>{label && <span>{label}</span>}<span className="input-wrap"><input {...props} value={value} onChange={(event) => onChange(event.target.value)} />{String(value).length > 0 && <button type="button" className="clear-input" aria-label={`Cancella ${label ?? "campo"}`} onClick={() => onChange("")}><MaterialIcon>close</MaterialIcon></button>}</span></label>;
}

function Modal({ title, children, onClose, guard = true, wide = false }: { title: string; children: ReactNode; onClose: () => void; guard?: boolean; wide?: boolean }) {
  const [dirty, setDirty] = useState(false);
  const attemptClose = useCallback(() => { if (guard && dirty && !confirm("Ci sono modifiche non salvate. Chiudere senza salvare?")) return; onClose(); }, [guard, dirty, onClose]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") attemptClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [attemptClose]);
  const markDirty = guard ? () => setDirty(true) : undefined;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={attemptClose}><div className={`modal ${wide ? "modal-wide" : ""}`} onClick={(event) => event.stopPropagation()} onInput={markDirty} onChange={markDirty}><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={attemptClose} aria-label="Chiudi"><MaterialIcon>close</MaterialIcon></button></div>{children}</div></div>;
}

function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

function MaterialIcon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`material-symbols-rounded ${className}`} aria-hidden="true">{children}</span>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const email = emailForUsername(username);
      if (!email) throw new Error("Usa uno dei profili autorizzati: viterbo, gran-sasso o admin.");
      const supabase = supabaseBrowser();
      const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError || !signIn.session) throw new Error("Nome utente o password non validi.");
      const response = await readJson(await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "supabase-login", accessToken: signIn.session.access_token }) }));
      setPassword("");
      onLogin(response.user as User);
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "Accesso non riuscito.");
    }
    finally { setLoading(false); }
  }
  async function devLogin() {
    setLoading(true); setError("");
    try {
      const response = await readJson(await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dev-login" }) }));
      onLogin(response.user as User);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Accesso non riuscito."); }
    finally { setLoading(false); }
  }
  const devEnabled = process.env.NEXT_PUBLIC_DEV_LOGIN === "1";
  return <main className="login-page"><section className="login-card"><div className="login-brand-lockup"><div className="brand-mark"><img src="/ms-logo.png" alt="" /></div><img className="login-wordmark" src="/gestionale-wordmark.png" alt="Gestionale Stefano Marinelli" /></div><form onSubmit={submit} className="stack login-form"><ClearableInput label="Nome utente" autoComplete="username" value={username} onChange={setUsername} placeholder="Nome utente" spellCheck={false} required /><ClearableInput label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} placeholder="Password" required />{error && <div className="alert danger">{error}</div>}<button className="primary big" disabled={loading}>{loading ? "Accesso…" : "Accedi"}</button></form>{devEnabled && <button type="button" className="secondary big" style={{ marginTop: 10 }} disabled={loading} onClick={() => void devLogin()}>Entra come admin (DEV)</button>}<PwaInstallButton /></section></main>;
}

function CustomerForm({ store, onSaved, onClose, customer = null }: { store: Store; onSaved: () => Promise<void>; onClose: () => void; customer?: Customer | null }) {
  const [form, setForm] = useState({ customerType: customer?.customerType ?? "private" as "private" | "company", firstName: customer?.firstName ?? "", lastName: customer?.lastName ?? "", companyName: customer?.companyName ?? "", vatNumber: customer?.vatNumber ?? "", pec: customer?.pec ?? "", sdiCode: customer?.sdiCode ?? "", phone: customer?.phone ?? "", email: customer?.email ?? "", address: customer?.address ?? "", postalCode: customer?.postalCode ?? "", city: customer?.city ?? "", province: customer?.province ?? "", taxCode: customer?.taxCode ?? "" });
  const [error, setError] = useState("");
  const set = (name: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: React.FormEvent) { event.preventDefault(); setError(""); try { await post(customer ? "updateCustomer" : "createCustomer", { ...form, store, id: customer?.id }); await onSaved(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <form className="stack" onSubmit={save}><div className="customer-type-tabs"><button type="button" className={form.customerType === "private" ? "active" : ""} onClick={() => setForm((current) => ({ ...current, customerType: "private" }))}>Privato</button><button type="button" className={form.customerType === "company" ? "active" : ""} onClick={() => setForm((current) => ({ ...current, customerType: "company" }))}>Azienda / Società</button></div><div className="form-grid">{form.customerType === "private" ? <><ClearableInput label="Nome" value={form.firstName} onChange={set("firstName")} required /><ClearableInput label="Cognome" value={form.lastName} onChange={set("lastName")} required /><ClearableInput className="full" label="Codice fiscale" value={form.taxCode} onChange={set("taxCode")} /></> : <><ClearableInput className="full" label="Ragione sociale" value={form.companyName} onChange={set("companyName")} required /><ClearableInput label="Partita IVA" value={form.vatNumber} onChange={set("vatNumber")} required /><ClearableInput label="Codice fiscale società" value={form.taxCode} onChange={set("taxCode")} /><ClearableInput label="PEC" type="email" value={form.pec} onChange={set("pec")} /><ClearableInput label="Codice SDI" value={form.sdiCode} onChange={set("sdiCode")} /><ClearableInput label="Nome referente" value={form.firstName} onChange={set("firstName")} /><ClearableInput label="Cognome referente" value={form.lastName} onChange={set("lastName")} /></>}<ClearableInput label="Telefono" value={form.phone} onChange={set("phone")} /><ClearableInput label="Email" type="email" value={form.email} onChange={set("email")} /><ClearableInput className="full" label="Indirizzo" value={form.address} onChange={set("address")} /><ClearableInput label="CAP" value={form.postalCode} onChange={set("postalCode")} /><ClearableInput label="Comune" value={form.city} onChange={set("city")} /><ClearableInput label="Provincia" value={form.province} onChange={set("province")} maxLength={2} />{error && <div className="alert danger full">{error}</div>}<div className="form-actions full"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button className="primary">{customer ? "Salva modifiche" : `Salva ${form.customerType === "company" ? "azienda" : "privato"}`}</button></div></div></form>;
}

function ProductSearch({ products, store, onAdd, compact = false }: { products: Product[]; store: Store; onAdd: (product: Product) => void; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("it");
    if (!normalized && compact) return [];
    return groupProducts(products).filter((group) => !normalized || `${group.brand} ${group.name} ${group.category}`.toLocaleLowerCase("it").includes(normalized) || group.variants.some((variant) => searchableProduct(variant).includes(normalized))).slice(0, 8);
  }, [products, query, compact]);
  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) { if (event.key !== "Enter") return; event.preventDefault(); const exact = products.find((product) => product.eans.split(",").includes(query.trim())); if (exact) { onAdd(exact); setQuery(""); } }
  return <div className="product-search"><ClearableInput label={compact ? undefined : "EAN, marca, prodotto, colore o taglia"} value={query} onChange={setQuery} onKeyDown={onKeyDown} placeholder="Scansiona EAN o cerca prodotto…" autoFocus={!compact} /><div className={`search-results grouped ${compact ? "compact" : ""}`}>{results.map((group) => { const normalized = query.trim().toLocaleLowerCase("it"); const groupMatch = !normalized || `${group.brand} ${group.name} ${group.category}`.toLocaleLowerCase("it").includes(normalized); const visibleVariants = groupMatch ? group.variants : group.variants.filter((variant) => searchableProduct(variant).includes(normalized)); return <article className="product-group-result" key={group.key}><div className="product-group-result-head"><span><strong>{group.brand ? `${group.brand} · ` : ""}{group.name}</strong><small>{group.category || "Senza categoria"}</small></span><span className="count-pill">{group.variants.length} {group.variants.length === 1 ? "variante" : "varianti"}</span></div><div className="variant-choice-list">{visibleVariants.map((variant) => { const available = store === "Viterbo" ? variant.viterboQty - variant.viterboReserved : variant.granSassoQty - variant.granSassoReserved; return <button type="button" className="variant-choice" key={variant.id} onClick={() => { onAdd(variant); setQuery(""); }}><span><strong>{variant.color} · {variant.size}</strong><small>{variant.sku}{variant.eans ? ` · ${variant.eans.split(",").join(" · ")}` : ""}</small></span><span className={available <= 0 ? "stock-zero" : "stock-ok"}>{available} disp.</span><b>{money(variant.price)}</b></button>; })}</div></article>; })}</div></div>;
}

function GiftDraft({ onAdd, onClose }: { onAdd: (item: CartItem) => void; onClose: () => void }) {
  const [beneficiary, setBeneficiary] = useState(""); const [amount, setAmount] = useState(""); const [expiresAt, setExpiresAt] = useState(todayPlusYear());
  return <Modal title="Aggiungi buono regalo al carrello" onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); const value = Number(amount); if (value <= 0) return; onAdd({ key: keyId(), productId: null, description: `Buono regalo · ${beneficiary || "Non indicato"}`, quantity: 1, unitPrice: value, itemType: "gift", metadata: { beneficiary: beneficiary || "Non indicato", expiresAt, code: makeEan13() } }); }}><p className="muted">Il buono sarà creato soltanto quando completi la vendita e scegli il pagamento.</p><ClearableInput label="Persona intestataria" value={beneficiary} onChange={setBeneficiary} placeholder="Facoltativo" /><ClearableInput label="Valore" type="number" step="0.01" value={amount} onChange={setAmount} required /><ClearableInput label="Scadenza" type="date" value={expiresAt} onChange={setExpiresAt} required /><div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button className="primary">Aggiungi al carrello</button></div></form></Modal>;
}

function SimpleDraft({ title, defaultDescription, onAdd, onClose }: { title: string; defaultDescription: string; onAdd: (item: CartItem) => void; onClose: () => void }) {
  const [description, setDescription] = useState(defaultDescription); const [amount, setAmount] = useState("");
  return <Modal title={title} onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); const value = Number(amount); if (!description || value === 0) return; onAdd({ key: keyId(), productId: null, description, quantity: 1, unitPrice: value, itemType: "service", metadata: {} }); }}><ClearableInput label="Descrizione" value={description} onChange={setDescription} required /><ClearableInput label="Importo" type="number" step="0.01" value={amount} onChange={setAmount} required /><div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button className="primary">Aggiungi al carrello</button></div></form></Modal>;
}

function DepositDraft({ title, products, kind, onAdd, onClose }: { title: string; products: Product[]; kind: "product" | "repair"; onAdd: (item: CartItem) => void; onClose: () => void }) {
  const [description, setDescription] = useState(kind === "repair" ? "Risolatura" : ""); const [productId, setProductId] = useState(""); const [total, setTotal] = useState(""); const [deposit, setDeposit] = useState("");
  const product = products.find((item) => item.id === Number(productId));
  return <Modal title={title} onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); const totalPrice = Number(total); const depositValue = Number(deposit); if (!description || totalPrice <= 0 || depositValue < 0 || depositValue > totalPrice) return; const isDeposit = depositValue > 0 && depositValue < totalPrice; onAdd({ key: keyId(), productId: product?.id ?? null, description: isDeposit ? `Acconto ${description}` : description, quantity: 1, unitPrice: isDeposit ? depositValue : totalPrice, itemType: isDeposit ? (kind === "repair" ? "repair_deposit" : "deposit") : "service", metadata: isDeposit ? { totalPrice, productId: product?.id ?? null, code: makeEan13() } : {} }); }}><p className="muted">Se inserisci un acconto inferiore al totale verrà generato un PDF con EAN per il saldo al ritiro.</p>{products.length > 0 && <label className="field"><span>Prodotto da prenotare</span><select value={productId} onChange={(event) => { setProductId(event.target.value); const selected = products.find((item) => item.id === Number(event.target.value)); if (selected) { setDescription(`${selected.name} · ${selected.color} ${selected.size}`); setTotal(String(selected.price)); } }}><option value="">Seleziona prodotto</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.color} {item.size}</option>)}</select></label>}<ClearableInput label="Descrizione" value={description} onChange={setDescription} required /><ClearableInput label="Totale concordato" type="number" step="0.01" value={total} onChange={setTotal} required /><ClearableInput label="Acconto (0 per vendita completa)" type="number" step="0.01" value={deposit} onChange={setDeposit} /><div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button className="primary">Aggiungi al carrello</button></div></form></Modal>;
}

function ReturnDraft({ products, store, onAdd, onClose }: { products: Product[]; store: Store; onAdd: (item: CartItem) => void; onClose: () => void }) {
  const [query, setQuery] = useState(""); const [productId, setProductId] = useState(""); const [amount, setAmount] = useState(""); const [receipt, setReceipt] = useState("");
  const matches = products.filter((product) => `${product.name} ${product.sku} ${product.eans}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const selected = products.find((product) => product.id === Number(productId));
  return <Modal title="Reso o cambio merce" onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); if (!selected || Number(amount) <= 0) return; onAdd({ key: keyId(), productId: selected.id, description: `Reso ${selected.name} · ${selected.color} ${selected.size}`, quantity: -1, unitPrice: Number(amount), itemType: "return", metadata: { originalReceipt: receipt, store } }); }}><p className="muted">Il prodotto rientra in magazzino e il suo importo viene sottratto. Puoi poi aggiungere il prodotto sostitutivo al carrello.</p><ClearableInput label="Scontrino originale" value={receipt} onChange={setReceipt} /><ClearableInput label="Cerca prodotto restituito" value={query} onChange={setQuery} />{matches.length > 0 && <div className="choice-list">{matches.map((item) => <button type="button" className={item.id === Number(productId) ? "selected" : ""} key={item.id} onClick={() => { setProductId(String(item.id)); setAmount(String(item.price)); setQuery(`${item.name} ${item.color} ${item.size}`); }}>{item.name} · {item.color} {item.size}</button>)}</div>}<ClearableInput label="Importo da stornare" type="number" step="0.01" value={amount} onChange={setAmount} required /><div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button className="primary">Aggiungi reso al carrello</button></div></form></Modal>;
}

// Versione storica mantenuta temporaneamente come riferimento per le altre sezioni operative.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CashRegister({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [adminStore, setAdminStore] = useState<Store>("Viterbo");
  const store = data.user.store ?? adminStore;
  const [cart, setCart] = useState<CartItem[]>([]); const [customer, setCustomer] = useState<Customer | null>(null); const [customerQuery, setCustomerQuery] = useState(""); const [modal, setModal] = useState<string | null>(null); const [notice, setNotice] = useState(""); const [error, setError] = useState(""); const [totalOverride, setTotalOverride] = useState(""); const [payment, setPayment] = useState("cash"); const [cashAmount, setCashAmount] = useState(""); const [cardAmount, setCardAmount] = useState(""); const [giftCode, setGiftCode] = useState(""); const [giftAmount, setGiftAmount] = useState(""); const [lastSale, setLastSale] = useState<{ id: number; receiptNo: string } | null>(null);
  const subtotal = useMemo(() => Math.round(cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) * 100) / 100, [cart]);
  const total = totalOverride === "" ? subtotal : Number(totalOverride) || 0;
  const matchingCustomers = useMemo(() => { const q = customerQuery.trim().toLocaleLowerCase("it"); return q ? data.customers.filter((item) => `${customerLabel(item)} ${item.vatNumber}`.toLocaleLowerCase("it").includes(q)).slice(0, 8) : []; }, [data.customers, customerQuery]);
  function addProduct(product: Product) { setCart((current) => { const existing = current.find((item) => item.productId === product.id && item.itemType === "product"); return existing ? current.map((item) => item.key === existing.key ? { ...item, quantity: item.quantity + 1 } : item) : [...current, { key: keyId(), productId: product.id, description: `${product.name} · ${product.color} ${product.size}`, quantity: 1, unitPrice: product.price, itemType: "product", metadata: {} }]; }); setNotice(`${product.name} aggiunto al carrello.`); setTimeout(() => setNotice(""), 2200); }
  function updateItem(key: string, change: Partial<CartItem>) { setCart((current) => current.map((item) => item.key === key ? { ...item, ...change } : item)); setTotalOverride(""); }
  function removeItem(key: string) { setCart((current) => current.filter((item) => item.key !== key)); setTotalOverride(""); }
  async function scanSpecial(code: string) { setError(""); try { const result = await readJson(await fetch(`/api/data?view=code&q=${encodeURIComponent(code)}`)); if (result.kind === "gift") { setGiftCode(result.record.code); setPayment("gift"); setNotice(`Buono riconosciuto: saldo ${money(result.record.balance)}`); } if (result.kind === "reservation") { if (result.record.status !== "open") throw new Error("Questa prenotazione risulta già chiusa."); if (result.record.store !== store) throw new Error(`Prenotazione emessa da ${result.record.store}.`); setCart((current) => [...current, { key: keyId(), productId: null, description: `Saldo: ${result.record.description}`, quantity: 1, unitPrice: result.record.balanceDue, itemType: "reservation_balance", locked: true, metadata: { code: result.record.code } }]); setNotice("Saldo prenotazione aggiunto al carrello."); } } catch (reason) { setError(reason instanceof Error ? reason.message : "Codice non trovato."); } }
  function preparePayments() { if (payment === "cash") return { cashAmount: total, cardAmount: 0, giftAmount: 0, giftCodeUsed: "" }; if (payment === "card") return { cashAmount: 0, cardAmount: total, giftAmount: 0, giftCodeUsed: "" }; if (payment === "mixed") return { cashAmount: Number(cashAmount) || 0, cardAmount: Number(cardAmount) || 0, giftAmount: 0, giftCodeUsed: "" }; const gift = Number(giftAmount) || 0; return { cashAmount: Number(cashAmount) || Math.max(0, total - gift), cardAmount: Number(cardAmount) || 0, giftAmount: gift, giftCodeUsed: giftCode }; }
  async function completeSale() { setError(""); setNotice(""); try { const result = await post("createSale", { store, customerId: customer?.id ?? null, items: cart, total, ...preparePayments() }); setLastSale({ id: result.saleId, receiptNo: result.receiptNo }); setCart([]); setTotalOverride(""); setCashAmount(""); setCardAmount(""); setGiftAmount(""); setGiftCode(""); setCustomer(null); setCustomerQuery(""); setNotice(`Vendita ${result.receiptNo} registrata. Richiesta scontrino pronta.`); await reload(); } catch (reason) { const extended = reason as Error & { data?: { insufficient?: string[] } }; setError(`${extended.message}${extended.data?.insufficient?.length ? `: ${extended.data.insufficient.join(", ")}` : ""}`); } }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">POSTAZIONE OPERATIVA</p><h1>Cassa {store}</h1></div>{data.user.role === "admin" && <label className="field inline"><span>Negozio</span><select value={adminStore} onChange={(event) => setAdminStore(event.target.value as Store)}><option>Viterbo</option><option>Gran Sasso</option></select></label>}</div>{notice && <div className="alert success">{notice}</div>}{error && <div className="alert danger">{error}</div>}<div className="cash-grid"><div className="cash-main"><div className="panel"><div className="panel-title"><div><p className="eyebrow">RICERCA RAPIDA</p><h2>Scansiona o cerca</h2></div><ClearableInput compact label="Codice buono/acconto" value={giftCode} onChange={setGiftCode} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void scanSpecial(giftCode); } }} placeholder="Scansiona EAN documento" /></div><ProductSearch products={data.products} store={store} onAdd={addProduct} /></div><div className="panel"><div className="panel-title"><div><p className="eyebrow">CLIENTE</p><h2>{customer ? customerLabel(customer) : "Associa per nominativo"}</h2></div>{customer && <button className="text-button" onClick={() => setCustomer(null)}>Rimuovi</button>}</div><ClearableInput value={customerQuery} onChange={setCustomerQuery} placeholder="Nome, società o P.IVA…" />{matchingCustomers.length > 0 && <div className="customer-dropdown">{matchingCustomers.map((item) => <button key={item.id} onClick={() => { setCustomer(item); setCustomerQuery(""); }}><strong>{customerLabel(item)}</strong><small>{item.vatNumber || item.city || item.phone || item.scope}</small></button>)}</div>}</div><div className="actions-strip"><button className="action-customer" onClick={() => setModal("customer")}><MaterialIcon>person_add</MaterialIcon><span>Nuovo cliente</span></button><button className="action-gift" onClick={() => setModal("gift")}><MaterialIcon>redeem</MaterialIcon><span>Buono regalo</span></button><button className="action-varie" onClick={() => setModal("varie")}><MaterialIcon>shopping_bag</MaterialIcon><span>Varie</span></button>{store === "Viterbo" ? <button className="action-repair" onClick={() => setModal("repair")}><MaterialIcon>footprint</MaterialIcon><span>Risuolatura</span></button> : <button className="action-shirt" onClick={() => setModal("shirt")}><MaterialIcon>checkroom</MaterialIcon><span>Maglie Gran Sasso</span></button>}<button className="action-reservation" onClick={() => setModal("reservation")}><MaterialIcon>calendar_month</MaterialIcon><span>Prenotazione</span></button><button className="action-return" onClick={() => setModal("return")}><MaterialIcon>sync_alt</MaterialIcon><span>Reso / cambio</span></button></div><div className="panel cart-panel"><div className="panel-title"><div><p className="eyebrow">VENDITA</p><h2>Carrello</h2></div><span className="count-pill">{cart.length} righe</span></div>{!cart.length ? <Empty>Scansiona un EAN oppure usa uno dei pulsanti operativi.</Empty> : <div className="cart-list">{cart.map((item) => <div className={`cart-row ${item.itemType === "return" ? "return-row" : ""}`} key={item.key}><div className="cart-desc"><strong>{item.description}</strong><small>{item.itemType.replaceAll("_", " ")}</small></div><ClearableInput compact aria-label="Quantità" type="number" step="1" value={item.quantity} onChange={(value) => updateItem(item.key, { quantity: Number(value) || 0 })} disabled={item.locked} /><ClearableInput compact aria-label="Prezzo unitario" type="number" step="0.01" value={item.unitPrice} onChange={(value) => updateItem(item.key, { unitPrice: Number(value) || 0 })} disabled={item.locked} /><b>{money(item.quantity * item.unitPrice)}</b><button className="icon-button" onClick={() => removeItem(item.key)} aria-label="Rimuovi"><MaterialIcon>close</MaterialIcon></button></div>)}</div>}</div></div><aside className="checkout"><div><p className="eyebrow">RIEPILOGO</p><div className="total-line"><span>Subtotale</span><b>{money(subtotal)}</b></div><ClearableInput label="Totale vendita modificabile" type="number" step="0.01" value={totalOverride} onChange={setTotalOverride} placeholder={subtotal.toFixed(2)} /><div className="grand-total"><span>Totale</span><strong>{money(total)}</strong></div></div><div><p className="eyebrow">PAGAMENTO</p><div className="payment-tabs">{[["cash","Contanti"],["card","Carta"],["mixed","Misto"],["gift","Buono"]].map(([value,label]) => <button key={value} className={payment === value ? "active" : ""} onClick={() => setPayment(value)}>{label}</button>)}</div>{payment === "mixed" && <div className="split-fields"><ClearableInput label="Contanti" type="number" step="0.01" value={cashAmount} onChange={setCashAmount} /><ClearableInput label="Carta" type="number" step="0.01" value={cardAmount} onChange={setCardAmount} /></div>}{payment === "gift" && <div className="stack compact-stack"><ClearableInput label="Codice EAN buono" value={giftCode} onChange={setGiftCode} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void scanSpecial(giftCode); } }} /><ClearableInput label="Importo da scalare" type="number" step="0.01" value={giftAmount} onChange={setGiftAmount} /><ClearableInput label="Residuo contanti" type="number" step="0.01" value={cashAmount} onChange={setCashAmount} /><ClearableInput label="Residuo carta" type="number" step="0.01" value={cardAmount} onChange={setCardAmount} /></div>}</div><button className="primary checkout-button" disabled={!cart.length} onClick={completeSale}>Completa e stampa scontrino · {money(total)}</button>{lastSale && <div className="last-sale"><strong>Vendita {lastSale.receiptNo}</strong><a className="secondary" href={`/api/pdf?type=courtesy&id=${lastSale.id}`}>Scontrino cortesia PDF</a><a className="text-button" href={`/api/pdf?type=receipt&id=${lastSale.id}`}>Scontrino interno</a></div>}<p className="fine-print">Ogni incasso crea una vendita e una richiesta di scontrino fiscale.</p></aside></div>{modal === "customer" && <Modal title="Nuovo cliente" onClose={() => setModal(null)}><CustomerForm store={store} onSaved={reload} onClose={() => setModal(null)} /></Modal>}{modal === "gift" && <GiftDraft onAdd={(item) => { setCart((current) => [...current, item]); setModal(null); }} onClose={() => setModal(null)} />}{modal === "varie" && <SimpleDraft title="Vendita varie" defaultDescription="Varie" onAdd={(item) => { setCart((current) => [...current, item]); setModal(null); }} onClose={() => setModal(null)} />}{modal === "shirt" && <SimpleDraft title="Maglie Gran Sasso" defaultDescription="Maglie Gran Sasso" onAdd={(item) => { setCart((current) => [...current, item]); setModal(null); }} onClose={() => setModal(null)} />}{modal === "repair" && <DepositDraft title="Risolatura" products={[]} kind="repair" onAdd={(item) => { setCart((current) => [...current, item]); setModal(null); }} onClose={() => setModal(null)} />}{modal === "reservation" && <DepositDraft title="Prenotazione prodotto" products={data.products} kind="product" onAdd={(item) => { setCart((current) => [...current, item]); setModal(null); }} onClose={() => setModal(null)} />}{modal === "return" && <ReturnDraft products={data.products} store={store} onAdd={(item) => { setCart((current) => [...current, item]); setModal(null); }} onClose={() => setModal(null)} />}</section>;
}

function Customers({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [query, setQuery] = useState(""); const [section, setSection] = useState<"private" | "company">("private"); const [selected, setSelected] = useState<Customer | null>(null); const [history, setHistory] = useState<{ sales: Sale[]; items: { saleId: number; description: string; quantity: number; lineTotal: number }[] } | null>(null); const [newOpen, setNewOpen] = useState(false); const [editing, setEditing] = useState(false); const [error, setError] = useState("");
  const isAdmin = data.user.role === "admin";
  const visible = useMemo(() => { const q = query.toLocaleLowerCase("it"); return data.customers.filter((item) => item.customerType === section && (!q || `${customerLabel(item)} ${item.vatNumber} ${item.taxCode} ${item.city}`.toLocaleLowerCase("it").includes(q))); }, [data.customers, query, section]);
  async function openCustomer(customer: Customer) { setSelected(customer); setError(""); const result = await readJson(await fetch(`/api/data?view=customer&id=${customer.id}`)); setHistory(result); }
  async function removeCustomer() { if (!selected || !confirm(`Cancellare ${customerLabel(selected)}?`)) return; setError(""); try { await post("deleteCustomer", { id: selected.id }); setSelected(null); setHistory(null); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">ANAGRAFICHE E STORICO</p><h1>Clienti</h1></div><button className="primary" onClick={() => setNewOpen(true)}><MaterialIcon>person_add</MaterialIcon> Nuovo cliente</button></div><div className="panel"><div className="customer-type-tabs section-tabs"><button className={section === "private" ? "active" : ""} onClick={() => { setSection("private"); setSelected(null); setHistory(null); }}>Privati <b>{data.customers.filter((item) => item.customerType === "private").length}</b></button><button className={section === "company" ? "active" : ""} onClick={() => { setSection("company"); setSelected(null); setHistory(null); }}>Aziende e società <b>{data.customers.filter((item) => item.customerType === "company").length}</b></button></div><ClearableInput label={section === "company" ? "Ricerca ragione sociale, P.IVA o comune" : "Ricerca per nominativo"} value={query} onChange={setQuery} placeholder={section === "company" ? "Ragione sociale o P.IVA…" : "Nome o cognome…"} /><div className="scope-row"><span>Viterbo <b>{visible.filter((item) => item.scope === "Viterbo").length}</b></span><span>Gran Sasso <b>{visible.filter((item) => item.scope === "Gran Sasso").length}</b></span><span>Comuni <b>{visible.filter((item) => item.scope === "Comune").length}</b></span></div></div><div className="two-columns"><div className="panel list-panel">{visible.length ? visible.map((customer) => <button className={`customer-card ${selected?.id === customer.id ? "selected" : ""}`} key={customer.id} onClick={() => void openCustomer(customer)}><span><strong>{customerLabel(customer)}</strong><small>{customer.customerType === "company" ? `P.IVA ${customer.vatNumber || "non indicata"} · ${customer.city || "sede non indicata"}` : customer.city || customer.phone || "Nessun recapito"}</small></span><span className="scope-badge">{customer.scope}</span></button>) : <Empty>Nessuna anagrafica trovata.</Empty>}</div><div className="panel detail-panel">{!selected || !history ? <Empty>Seleziona un cliente per vedere dati e vendite già effettuate.</Empty> : <><div className="panel-title"><div><p className="eyebrow">{selected.customerType === "company" ? "AZIENDA / SOCIETÀ" : "CLIENTE PRIVATO"}</p><h2>{customerLabel(selected)}</h2></div><div className="table-actions">{isAdmin && <><button className="secondary small" onClick={() => setEditing(true)}>Modifica</button><button className="text-button negative" onClick={() => void removeCustomer()}>Rimuovi</button></>}<span className="scope-badge">{selected.scope}</span></div></div>{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}{selected.customerType === "company" && <div className="company-detail"><span><small>Partita IVA</small><strong>{selected.vatNumber || "—"}</strong></span><span><small>PEC</small><strong>{selected.pec || "—"}</strong></span><span><small>Codice SDI</small><strong>{selected.sdiCode || "—"}</strong></span><span><small>Sede</small><strong>{[selected.address, selected.postalCode, selected.city, selected.province].filter(Boolean).join(" · ") || "—"}</strong></span></div>}{history.sales.length ? history.sales.map((sale) => <article className="history-sale" key={sale.id}><div><strong>{sale.receiptNo}</strong><small>{dateTime(sale.createdAt)} · {sale.store}</small></div><b className={sale.total < 0 ? "negative" : ""}>{money(sale.total)}</b><a className="secondary small" href={`/api/pdf?type=receipt&id=${sale.id}`}>Stampa scontrino interno</a><ul>{history.items.filter((item) => item.saleId === sale.id).map((item, index) => <li key={`${sale.id}-${index}`}>{item.quantity} × {item.description} <span>{money(item.lineTotal)}</span></li>)}</ul></article>) : <Empty>Nessuna vendita associata.</Empty>}</>}</div></div>{newOpen && <Modal title="Nuova anagrafica" onClose={() => setNewOpen(false)}><CustomerForm store={data.user.store ?? "Viterbo"} onSaved={reload} onClose={() => setNewOpen(false)} /></Modal>}{editing && selected && <Modal title="Modifica cliente" onClose={() => setEditing(false)}><CustomerForm customer={selected} store={selected.createdStore} onSaved={async () => { await reload(); setSelected(null); setHistory(null); }} onClose={() => setEditing(false)} /></Modal>}</section>;
}

function Inventory({ data }: { data: Bootstrap }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("it");
    return groupProducts(data.products).filter((group) => !normalized || `${group.brand} ${group.name} ${group.category}`.toLocaleLowerCase("it").includes(normalized) || group.variants.some((variant) => searchableProduct(variant).includes(normalized)));
  }, [data.products, query]);
  const totalViterbo = groups.reduce((sum, group) => sum + group.variants.reduce((variantSum, variant) => variantSum + variant.viterboQty - variant.viterboReserved, 0), 0);
  const totalGranSasso = groups.reduce((sum, group) => sum + group.variants.reduce((variantSum, variant) => variantSum + variant.granSassoQty - variant.granSassoReserved, 0), 0);
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">DISPONIBILITÀ DEI DUE NEGOZI</p><h1>Magazzini</h1><p className="muted inventory-intro">Le varianti sono ordinate prima per colore e poi per taglia crescente. La disponibilità di Viterbo e Gran Sasso è sempre affiancata.</p></div></div><div className="panel"><ClearableInput label="Ricerca rapida per marca, prodotto, colore, taglia o EAN" value={query} onChange={setQuery} placeholder="Esempio: Scarpa, nero, 42 o codice EAN…" /><div className="scope-row"><span>Viterbo <b>{totalViterbo}</b></span><span>Gran Sasso <b>{totalGranSasso}</b></span><span>Prodotti <b>{groups.length}</b></span></div></div><div className="panel warehouse-panel inventory-all-stores"><div className="inventory-groups">{groups.length ? groups.map((group) => { const firstPhoto = group.variants.find((variant) => variant.photoKey); const availableViterbo = group.variants.reduce((sum, variant) => sum + variant.viterboQty - variant.viterboReserved, 0); const availableGranSasso = group.variants.reduce((sum, variant) => sum + variant.granSassoQty - variant.granSassoReserved, 0); return <article className="inventory-group" key={group.key}><div className="inventory-group-head dual-store">{firstPhoto?.photoKey ? <img className="product-thumb large" src={`/api/products?key=${encodeURIComponent(firstPhoto.photoKey)}`} alt={`${group.name} ${firstPhoto.color}`} /> : <span className="photo-placeholder large">—</span>}<span className="inventory-group-title"><strong>{group.brand ? `${group.brand} · ` : ""}{group.name}</strong><small>{group.category || "Senza categoria"} · {group.variants.length} {group.variants.length === 1 ? "variante" : "varianti"}</small></span><span className="inventory-store-totals"><b>VT {availableViterbo}</b><b>GS {availableGranSasso}</b></span></div><div className="table-wrap"><table className="variant-table dual-store-table"><thead><tr><th>Foto</th><th>Colore</th><th>Taglia ↑</th><th>SKU</th><th>EAN</th><th>Viterbo</th><th>Gran Sasso</th></tr></thead><tbody>{group.variants.map((variant) => { const viterbo = variant.viterboQty - variant.viterboReserved; const granSasso = variant.granSassoQty - variant.granSassoReserved; return <tr key={variant.id}><td>{variant.photoKey ? <img className="product-thumb" src={`/api/products?key=${encodeURIComponent(variant.photoKey)}`} alt={`${group.name} ${variant.color}`} /> : <span className="photo-placeholder">—</span>}</td><td><strong>{variant.color}</strong></td><td><strong>{variant.size}</strong></td><td>{variant.sku}</td><td>{variant.eans.split(",").join(" · ")}</td><td><span className={viterbo <= 0 ? "store-stock danger" : "store-stock"}>{viterbo} disp.</span></td><td><span className={granSasso <= 0 ? "store-stock danger" : "store-stock"}>{granSasso} disp.</span></td></tr>; })}</tbody></table></div></article>; }) : <Empty>Nessun prodotto trovato.</Empty>}</div></div></section>;
}

function ReorderList({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [detailGroup, setDetailGroup] = useState<string | null>(null);
  type PriorityFilter = "Tutte" | "Esauriti" | "Critici" | "Trasferibili";
  type ReorderRow = { key: string; product: Product; store: Store; available: number; minimum: number; suggested: number; otherStore: Store; otherAvailable: number; transferAmount: number; priority: "urgent" | "critical" | "low" };
  const [store, setStore] = useState<"Tutti" | Store>("Tutti");
  const [priority, setPriority] = useState<PriorityFilter>("Tutte");
  const [brand, setBrand] = useState("Tutte");
  const [category, setCategory] = useState("Tutte");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const brands = useMemo(() => [...new Set(data.products.map((product) => product.brand).filter(Boolean))].sort((a, b) => variantCollator.compare(a, b)), [data.products]);
  const categories = useMemo(() => [...new Set(data.products.map((product) => product.category).filter(Boolean))].sort((a, b) => variantCollator.compare(a, b)), [data.products]);
  const allRows = useMemo<ReorderRow[]>(() => data.products.flatMap((product) => {
    const stores: Store[] = store === "Tutti" ? ["Viterbo", "Gran Sasso"] : [store];
    return stores.flatMap((currentStore) => {
      const viterbo = product.viterboQty - product.viterboReserved;
      const granSasso = product.granSassoQty - product.granSassoReserved;
      const available = currentStore === "Viterbo" ? viterbo : granSasso;
      const minimum = currentStore === "Viterbo" ? product.viterboReorderLevel : product.granSassoReorderLevel;
      if (available > minimum) return [];
      const otherStore: Store = currentStore === "Viterbo" ? "Gran Sasso" : "Viterbo";
      const otherAvailable = currentStore === "Viterbo" ? granSasso : viterbo;
      const otherMinimum = currentStore === "Viterbo" ? product.granSassoReorderLevel : product.viterboReorderLevel;
      const suggested = Math.max(1, minimum + 1 - available);
      const transferAmount = Math.min(suggested, Math.max(0, otherAvailable - otherMinimum));
      const priority: ReorderRow["priority"] = available <= 0 ? "urgent" : available <= Math.max(1, Math.floor(minimum / 2)) ? "critical" : "low";
      return [{ key: `${product.id}-${currentStore}`, product, store: currentStore, available, minimum, suggested, otherStore, otherAvailable, transferAmount, priority }];
    });
  }).sort((left, right) => ({ urgent: 0, critical: 1, low: 2 }[left.priority] - { urgent: 0, critical: 1, low: 2 }[right.priority] || (left.available - left.minimum) - (right.available - right.minimum) || variantCollator.compare(`${left.product.brand} ${left.product.name} ${left.product.color} ${left.product.size}`, `${right.product.brand} ${right.product.name} ${right.product.color} ${right.product.size}`))), [data.products, store]);
  const rows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("it");
    return allRows.filter((row) => (!normalized || searchableProduct(row.product).includes(normalized)) && (brand === "Tutte" || row.product.brand === brand) && (category === "Tutte" || row.product.category === category) && (priority === "Tutte" || priority === "Esauriti" && row.priority === "urgent" || priority === "Critici" && row.priority === "critical" || priority === "Trasferibili" && row.transferAmount > 0));
  }, [allRows, brand, category, priority, query]);
  const visibleKeys = new Set(rows.map((row) => row.key));
  const visibleSelected = rows.filter((row) => selected.has(row.key));
  const allVisibleSelected = rows.length > 0 && rows.every((row) => selected.has(row.key));
  function toggle(key: string) { setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function toggleVisible() { setSelected((current) => { const next = new Set(current); if (allVisibleSelected) visibleKeys.forEach((key) => next.delete(key)); else visibleKeys.forEach((key) => next.add(key)); return next; }); }
  function printList() {
    const printable = visibleSelected.length ? visibleSelected : rows;
    if (!printable.length) return;
    const safe = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
    const popup = window.open("", "_blank", "width=920,height=720");
    if (!popup) { alert("Consenti le finestre popup del browser per stampare la lista."); return; }
    const filters = [store !== "Tutti" ? `Negozio: ${store}` : "Tutti i negozi", priority !== "Tutte" ? priority : null, brand !== "Tutte" ? brand : null, category !== "Tutte" ? category : null, query.trim() ? `"${query.trim()}"` : null].filter(Boolean).join(" · ");
    popup.document.write(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Lista riordino</title><style>body{font:14px Arial,sans-serif;color:#111;margin:28px}header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #12bfe9;padding-bottom:14px;margin-bottom:18px}header img{height:54px}h1{margin:0 0 4px;font-size:22px}header p{color:#555;margin:0;font-size:12px}table{width:100%;border-collapse:collapse}th,td{padding:9px 7px;border-bottom:1px solid #bbb;text-align:left}th{font-size:11px;text-transform:uppercase}.urgent{font-weight:bold;color:#a40000}@media print{body{margin:12mm}}</style></head><body><header><img src="${window.location.origin}/ms-logo.png" alt="" /><div><h1>Articoli da riordinare</h1><p>${safe(new Date().toLocaleString("it-IT"))} · ${safe(filters)} · ${printable.length} articoli</p></div></header><table><thead><tr><th>Prodotto</th><th>Variante</th><th>Negozio</th><th>Disp.</th><th>Min.</th><th>Da ordinare</th><th>Indicazione</th></tr></thead><tbody>${printable.map((row) => `<tr><td>${safe(`${row.product.brand} ${row.product.name}`)}</td><td>${safe(`${row.product.color} · ${row.product.size} · ${row.product.sku}`)}</td><td>${safe(row.store)}</td><td class="${row.priority === "urgent" ? "urgent" : ""}">${row.available}</td><td>${row.minimum}</td><td><strong>${row.suggested}</strong></td><td>${row.transferAmount ? safe(`Trasferibili ${row.transferAmount} da ${row.otherStore}`) : "Ordine fornitore"}</td></tr>`).join("")}</tbody></table><script>window.onload=()=>{const done=()=>{window.print();window.close()};const img=document.images[0];if(img&&!img.complete){img.onload=done;img.onerror=done;setTimeout(done,1500)}else done()}<\/script></body></html>`);
    popup.document.close();
  }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">CONTROLLO SCORTE PER NEGOZIO</p><h1>Articoli da riordinare</h1><p className="muted inventory-intro">Ogni variante viene controllata separatamente a Viterbo e Gran Sasso usando la sua scorta minima.</p></div><button className="primary" onClick={printList} disabled={!rows.length}><MaterialIcon>print</MaterialIcon>{visibleSelected.length ? `Stampa selezionati (${visibleSelected.length})` : `Stampa lista (${rows.length})`}</button></div><div className="metric-grid"><Metric label="Righe da gestire" value={String(allRows.length)} note={store === "Tutti" ? "nei due negozi" : `a ${store}`} /><Metric label="Esauriti" value={String(allRows.filter((row) => row.priority === "urgent").length)} note="disponibilità zero o negativa" /><Metric label="Critici" value={String(allRows.filter((row) => row.priority === "critical").length)} note="sotto metà del minimo" /><Metric label="Trasferibili" value={String(allRows.filter((row) => row.transferAmount > 0).length)} note="senza impoverire l'altro negozio" /></div><div className="panel reorder-panel"><div className="reorder-filters"><ClearableInput label="Cerca prodotto, variante o EAN" value={query} onChange={setQuery} placeholder="Marca, modello, colore, taglia…" /><label className="field"><span>Negozio</span><select value={store} onChange={(event) => { setStore(event.target.value as "Tutti" | Store); setSelected(new Set()); }}><option>Tutti</option><option>Viterbo</option><option>Gran Sasso</option></select></label><label className="field"><span>Priorità</span><select value={priority} onChange={(event) => setPriority(event.target.value as PriorityFilter)}><option>Tutte</option><option>Esauriti</option><option>Critici</option><option>Trasferibili</option></select></label><label className="field"><span>Marca</span><select value={brand} onChange={(event) => setBrand(event.target.value)}><option>Tutte</option>{brands.map((item) => <option key={item}>{item}</option>)}</select></label><label className="field"><span>Categoria</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option>Tutte</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="reorder-toolbar"><button className="secondary small" onClick={toggleVisible} disabled={!rows.length}><MaterialIcon>{allVisibleSelected ? "deselect" : "select_all"}</MaterialIcon>{allVisibleSelected ? "Deseleziona visibili" : "Seleziona visibili"}</button><span>{rows.length} risultati · {visibleSelected.length} selezionati</span></div><div className="table-wrap"><table className="reorder-table"><thead><tr><th className="checkbox-column"><span className="sr-only">Selezione</span></th><th>Prodotto</th><th>Variante</th><th>Negozio</th><th>Disponibili</th><th>Minimo</th><th>Da ordinare</th><th>Azione consigliata</th><th>Priorità</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key} className={row.priority === "urgent" ? "reorder-urgent" : ""}><td><input className="row-checkbox" type="checkbox" checked={selected.has(row.key)} onChange={() => toggle(row.key)} aria-label={`Seleziona ${row.product.name} ${row.store}`} /></td><td><button type="button" className="text-button warehouse-group-name" onClick={() => setDetailGroup(row.product.variantGroup || `single-${row.product.id}`)} title="Apri scheda prodotto"><strong>{row.product.brand ? `${row.product.brand} · ` : ""}{row.product.name}</strong><small>{row.product.sku} · {row.product.eans.split(",").join(" · ")}</small></button></td><td><strong>{row.product.color}</strong><small>Taglia {row.product.size}</small></td><td><span className={`store-chip ${row.store === "Viterbo" ? "viterbo" : "gran-sasso"}`}>{row.store}</span></td><td><b className={row.available <= 0 ? "negative" : ""}>{row.available}</b></td><td>{row.minimum}</td><td><strong className="reorder-quantity">{row.suggested}</strong></td><td>{row.transferAmount > 0 ? <span className="transfer-tip"><MaterialIcon>swap_horiz</MaterialIcon>Trasferisci {row.transferAmount} da {row.otherStore}</span> : <span className="supplier-tip"><MaterialIcon>local_shipping</MaterialIcon>Ordine fornitore</span>}</td><td><span className={`status ${row.priority === "urgent" ? "reorder-now" : row.priority === "critical" ? "reorder-critical" : "reorder-soon"}`}>{row.priority === "urgent" ? "Esaurito" : row.priority === "critical" ? "Critico" : "Scorta bassa"}</span></td></tr>)}</tbody></table></div>{!rows.length && <Empty>Nessun articolo da riordinare con questi filtri.</Empty>}</div>{detailGroup && <Modal title="Scheda prodotto" wide guard={false} onClose={() => setDetailGroup(null)}><ProductDetail data={data} reload={reload} groupKey={detailGroup} onClose={() => setDetailGroup(null)} /></Modal>}</section>;
}

function Transfers({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const isAdmin = data.user.role === "admin";
  const [tab, setTab] = useState<"nuova" | "attesa" | "storico">("nuova");
  const [fromStore, setFromStore] = useState<Store>(data.user.store ?? "Viterbo");
  const [items, setItems] = useState<CartItem[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<{ transfer: Transfer; items: TransferAdminItem[] } | null>(null);
  const toStore: Store = fromStore === "Viterbo" ? "Gran Sasso" : "Viterbo";
  const pending = data.transfers.filter((t) => t.status === "pending");
  const history = data.transfers.filter((t) => t.status !== "pending");
  function add(product: Product) { if (items.some((item) => item.productId === product.id)) return; setItems((current) => [...current, { key: keyId(), productId: product.id, description: `${product.name} · ${product.color} ${product.size}`, quantity: 1, unitPrice: 0, itemType: "transfer", metadata: {} }]); }
  const avail = (productId: number | null) => { const p = data.products.find((row) => row.id === productId); if (!p) return 0; return fromStore === "Viterbo" ? p.viterboQty - p.viterboReserved : p.granSassoQty - p.granSassoReserved; };
  async function submit() {
    setError(""); setMessage("");
    try { const result = await post("createTransfer", { fromStore, items, note }); setItems([]); setNote(""); setMessage(`Richiesta ${result.code} inviata. In attesa di conferma dell'amministratore.`); setTab("attesa"); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
  }
  async function complete(transfer: Transfer) {
    if (!confirm(`Completare il trasferimento ${transfer.code}? La merce verrà spostata da ${transfer.fromStore} a ${transfer.toStore}.`)) return;
    setError(""); setMessage("");
    try { await post("completeTransfer", { id: transfer.id }); setMessage(`Trasferimento ${transfer.code} completato.`); await reload(); }
    catch (reasonValue) { const extended = reasonValue as Error & { data?: { insufficient?: { description: string; available: number }[] } }; setError(`${extended.message}${extended.data?.insufficient?.length ? ` ${extended.data.insufficient.map((row) => `${row.description}: disponibili ${row.available}`).join("; ")}` : ""}`); }
  }
  async function reject(transfer: Transfer) { const motivo = window.prompt("Motivo del rifiuto (facoltativo):") ?? undefined; if (motivo === undefined) return; setError(""); try { await post("rejectTransfer", { id: transfer.id, note: motivo }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  async function editTransfer(transfer: Transfer) { setError(""); try { const detail = await readJson(await fetch(`/api/data?view=transfer&id=${transfer.id}`, { cache: "no-store" })); setEditing({ transfer, items: detail.items as TransferAdminItem[] }); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  async function removeTransfer(transfer: Transfer) { if (!confirm(`Cancellare il trasferimento ${transfer.code}?`)) return; setError(""); try { await post("deleteTransfer", { id: transfer.id }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  const statusBadge = (s: string) => s === "pending" ? <span className="status warning">In attesa</span> : s === "accepted" ? <span className="status active">Completato</span> : <span className="status">Rifiutato</span>;
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">TRASFERIMENTI TRA NEGOZI</p><h1>Trasferimenti</h1><p className="muted inventory-intro">Richiedi lo spostamento di merce; l'amministratore lo completa e la giacenza si aggiorna.</p></div></div>{message && <div className="alert success">{message}</div>}{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}
    <div className="panel"><div className="customer-type-tabs section-tabs"><button className={tab === "nuova" ? "active" : ""} onClick={() => setTab("nuova")}>Nuova richiesta</button><button className={tab === "attesa" ? "active" : ""} onClick={() => setTab("attesa")}>In attesa <b>{pending.length}</b></button><button className={tab === "storico" ? "active" : ""} onClick={() => setTab("storico")}>Storico <b>{history.length}</b></button></div></div>
    {tab === "nuova" && <div className="transfer-grid"><div className="panel"><div className="store-selector">{(["Viterbo", "Gran Sasso"] as const).map((s) => <button key={s} className={fromStore === s ? "active" : ""} disabled={!isAdmin && data.user.store !== s} onClick={() => setFromStore(s)}><span className={`dot ${s === "Viterbo" ? "viterbo" : "gran-sasso"}`} />Da {s}</button>)}</div><p className="muted" style={{ margin: "10px 0" }}>La merce verrà spostata da <strong>{fromStore}</strong> a <strong>{toStore}</strong>.</p><ProductSearch compact products={data.products} store={fromStore} onAdd={add} /><div className="cart-list transfer-lines">{items.map((item) => { const a = avail(item.productId); const danger = item.quantity > a; return <div className={`cart-row ${danger ? "insufficient-row" : ""}`} key={item.key}><div className="cart-desc"><strong>{item.description}</strong><small>Disponibili a {fromStore}: {a}</small></div><ClearableInput compact type="number" min="1" value={item.quantity} onChange={(value) => setItems((current) => current.map((row) => row.key === item.key ? { ...row, quantity: Number(value) || 0 } : row))} /><button className="icon-button" onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}><MaterialIcon>close</MaterialIcon></button></div>; })}{!items.length && <Empty>Aggiungi i prodotti da trasferire.</Empty>}</div></div><aside className="panel"><p className="eyebrow">RICHIESTA</p><h2>Da {fromStore} a {toStore}</h2><div className="stack"><label className="field"><span>Nota (facoltativa)</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Es. Servono per il weekend" style={{ width: "100%", padding: ".8rem 1rem", borderRadius: 14, border: "1px solid #cfe0ea", font: "inherit" }} /></label><button className="primary" disabled={!items.length} onClick={submit}><MaterialIcon>send</MaterialIcon> Invia richiesta</button></div></aside></div>}
    {tab === "attesa" && <div className="panel">{pending.length ? <div className="table-wrap"><table><thead><tr><th>Codice</th><th>Data</th><th>Tratta</th><th>Articoli</th><th>Nota</th><th>Azioni</th></tr></thead><tbody>{pending.map((transfer) => <tr key={transfer.id}><td>{transfer.code}</td><td>{dateTime(transfer.createdAt)}</td><td>{transfer.fromStore} → {transfer.toStore}</td><td>{transfer.totalQuantity} pz · {transfer.lineCount} righe</td><td>{transfer.note || "—"}</td><td><div className="table-actions">{isAdmin ? <><button className="primary small" onClick={() => void complete(transfer)}>Completa</button><button className="text-button negative" onClick={() => void reject(transfer)}>Rifiuta</button></> : <span className="status warning">In attesa</span>}</div></td></tr>)}</tbody></table></div> : <Empty>Nessuna richiesta in attesa.</Empty>}</div>}
    {tab === "storico" && <div className="panel">{history.length ? <div className="table-wrap"><table><thead><tr><th>Codice</th><th>Data</th><th>Tratta</th><th>Qtà</th><th>Stato</th><th>DDT</th>{isAdmin && <th>Azioni</th>}</tr></thead><tbody>{history.map((transfer) => <tr key={transfer.id}><td>{transfer.code}</td><td>{dateTime(transfer.completedAt || transfer.createdAt)}</td><td>{transfer.fromStore} → {transfer.toStore}</td><td>{transfer.totalQuantity}</td><td>{statusBadge(transfer.status)}{transfer.status === "rejected" && transfer.note ? <small>{transfer.note}</small> : null}</td><td>{transfer.status === "accepted" ? <a href={`/api/pdf?type=ddt&id=${transfer.id}`}>PDF</a> : "—"}</td>{isAdmin && <td><div className="table-actions">{transfer.status === "accepted" && <button className="secondary small" onClick={() => void editTransfer(transfer)}>Modifica</button>}<button className="text-button negative" onClick={() => void removeTransfer(transfer)}>Rimuovi</button></div></td>}</tr>)}</tbody></table></div> : <Empty>Nessun trasferimento.</Empty>}</div>}
    {editing && <Modal title="Modifica trasferimento" onClose={() => setEditing(null)}><TransferAdminForm transfer={editing.transfer} items={editing.items} reload={reload} close={() => setEditing(null)} /></Modal>}
  </section>;
}
function EanLoadBar({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [ean, setEan] = useState("");
  const [store, setStore] = useState<Store>(data.user.store ?? "Viterbo");
  const [quantity, setQuantity] = useState("1");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() { setError(""); setMessage(""); try { const result = await post("quickLoad", { ean, store, quantity }); setMessage(`${result.product.name}: +${result.quantity} a ${result.store}`); setEan(""); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <div className="panel"><p className="eyebrow">CARICO RAPIDO</p><h2>Scansione EAN</h2>{message && <div className="alert success">{message}</div>}{error && <div className="alert danger">{error}</div>}<div className="form-grid"><ClearableInput label="EAN riconosciuto" value={ean} onChange={setEan} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(); } }} /><label className="field"><span>Negozio</span><select value={store} disabled={data.user.role !== "admin"} onChange={(event) => setStore(event.target.value as Store)}><option>Viterbo</option><option>Gran Sasso</option></select></label><ClearableInput label="Quantità" type="number" min="1" value={quantity} onChange={setQuantity} /><button className="primary" onClick={load}>Carica giacenza</button></div></div>;
}

function NewProductForm({ data, reload, onCreated }: { data: Bootstrap; reload: () => Promise<void>; onCreated?: () => void }) {
  type VariantDraft = { key: string; sku: string; color: string; size: string; eans: string; viterboQty: string; viterboReorderLevel: string; granSassoQty: string; granSassoReorderLevel: string; photo: File | null; photoPreview: string };
  const emptyVariant = (): VariantDraft => ({ key: keyId(), sku: "", color: "", size: "", eans: "", viterboQty: "0", viterboReorderLevel: "2", granSassoQty: "0", granSassoReorderLevel: "2", photo: null, photoPreview: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", brand: "", category: "", price: "" });
  const [variants, setVariants] = useState<VariantDraft[]>([emptyVariant()]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setError(""); setMessage(""); setSaving(true);
    try {
      if (isClientTestMode()) throw new Error("Modalità TEST attiva: prodotto non salvato (nessuna scrittura).");
      const createdName = form.name;
      const body = new FormData();
      body.append("payload", JSON.stringify({ ...form, variants: variants.map(({ sku, color, size, eans, viterboQty, viterboReorderLevel, granSassoQty, granSassoReorderLevel }) => ({ sku, color, size, eans: eans.split(",").map((value) => value.trim()).filter(Boolean), viterboQty, viterboReorderLevel, granSassoQty, granSassoReorderLevel })) }));
      variants.forEach((variant, index) => { if (variant.photo) body.append(`photo-${index}`, variant.photo); });
      const result = await readJson(await fetch("/api/products", { method: "POST", body }));
      setForm({ name: "", brand: "", category: "", price: "" }); setVariants([emptyVariant()]);
      setMessage(`${createdName}: prodotto creato con ${result.variantCount} ${result.variantCount === 1 ? "variante" : "varianti"} e ${result.photos} foto colore.`); await reload(); onCreated?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
    finally { setSaving(false); }
  }
  const change = (name: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  function changeVariant(key: string, name: keyof Omit<VariantDraft, "key" | "photo" | "photoPreview">, value: string) { setVariants((current) => current.map((variant) => variant.key === key ? { ...variant, [name]: value } : variant)); }
  function choosePhoto(key: string, file: File | null) {
    if (!file) { setVariants((current) => current.map((variant) => variant.key === key ? { ...variant, photo: null, photoPreview: "" } : variant)); return; }
    const reader = new FileReader();
    reader.onload = () => setVariants((current) => current.map((variant) => variant.key === key ? { ...variant, photo: file, photoPreview: String(reader.result ?? "") } : variant));
    reader.readAsDataURL(file);
  }
  return <div className="panel"><div className="panel-title"><div><p className="eyebrow">NUOVO PRODOTTO</p><h2>Un prodotto, tutte le varianti</h2><p className="muted product-group-note">Marca, nome e categoria vengono salvati una sola volta. Colori, taglie, SKU, EAN e giacenze restano separati nelle varianti.</p></div><span className="count-pill">{variants.length} varianti</span></div>{message && <div className="alert success">{message}</div>}{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}<form className="stack" onSubmit={create}><div className="form-grid product-base-fields"><ClearableInput label="Nome prodotto" value={form.name} onChange={change("name")} required /><ClearableInput label="Marca" value={form.brand} onChange={change("brand")} required /><ClearableInput label="Categoria" value={form.category} onChange={change("category")} required /><ClearableInput label="Prezzo di vendita" type="number" min="0" step="0.01" value={form.price} onChange={change("price")} required /></div><div className="variant-builder-head"><div><p className="eyebrow">VARIANTI DEL PRODOTTO</p><p className="muted">Aggiungi qui colori e taglie senza duplicare il prodotto. Ogni variante mantiene i propri EAN e la propria giacenza.</p></div><button type="button" className="secondary" onClick={() => setVariants((current) => [...current, emptyVariant()])}><MaterialIcon>add</MaterialIcon> Aggiungi variante</button></div><div className="variant-list">{variants.map((variant, index) => <article className="variant-card" key={variant.key}><div className="variant-card-head"><strong>Variante {index + 1}</strong>{variants.length > 1 && <button type="button" className="text-button negative" onClick={() => setVariants((current) => current.filter((row) => row.key !== variant.key))}>Rimuovi</button>}</div><div className="variant-fields"><ClearableInput label="Colore" value={variant.color} onChange={(value) => changeVariant(variant.key, "color", value)} required /><ClearableInput label="Taglia" value={variant.size} onChange={(value) => changeVariant(variant.key, "size", value)} required /><ClearableInput label="SKU variante" value={variant.sku} onChange={(value) => changeVariant(variant.key, "sku", value)} required /><ClearableInput className="variant-eans" label="EAN separati da virgola" value={variant.eans} onChange={(value) => changeVariant(variant.key, "eans", value)} required />{(data.user.role === "admin" || data.user.store === "Viterbo") && <><ClearableInput label="Giacenza Viterbo" type="number" min="0" value={variant.viterboQty} onChange={(value) => changeVariant(variant.key, "viterboQty", value)} /><ClearableInput label="Scorta minima Viterbo" type="number" min="0" value={variant.viterboReorderLevel} onChange={(value) => changeVariant(variant.key, "viterboReorderLevel", value)} /></>}{(data.user.role === "admin" || data.user.store === "Gran Sasso") && <><ClearableInput label="Giacenza Gran Sasso" type="number" min="0" value={variant.granSassoQty} onChange={(value) => changeVariant(variant.key, "granSassoQty", value)} /><ClearableInput label="Scorta minima Gran Sasso" type="number" min="0" value={variant.granSassoReorderLevel} onChange={(value) => changeVariant(variant.key, "granSassoReorderLevel", value)} /></>}<label className="field variant-photo-field"><span>Foto della variante colore</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => choosePhoto(variant.key, event.target.files?.[0] ?? null)} /></label>{variant.photoPreview && <div className="variant-photo-preview"><img src={variant.photoPreview} alt={`Anteprima ${variant.color || `variante ${index + 1}`}`} /><button type="button" className="icon-button" aria-label="Rimuovi foto" onClick={() => choosePhoto(variant.key, null)}><MaterialIcon>close</MaterialIcon></button></div>}</div></article>)}</div><button className="primary full-button" disabled={saving}>{saving ? "Caricamento…" : `Salva un prodotto con ${variants.length} ${variants.length === 1 ? "variante" : "varianti"}`}</button></form></div>;
}

function QuickLoad({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">GESTIONE MAGAZZINO</p><h1>Carico prodotti</h1></div></div><div className="product-load-grid"><EanLoadBar data={data} reload={reload} /><NewProductForm data={data} reload={reload} /></div></section>;
}

function ProductDetail({ data, reload, groupKey, onClose }: { data: Bootstrap; reload: () => Promise<void>; groupKey: string; onClose: () => void }) {
  const [editing, setEditing] = useState<Product | null>(null);
  const [variantSource, setVariantSource] = useState<{ product: Product; mode: "variant" | "duplicate" } | null>(null);
  const [error, setError] = useState("");
  const [editMode, setEditMode] = useState(false);
  const isAdmin = data.user.role === "admin";
  const items = data.products.filter((item) => (item.variantGroup || `single-${item.id}`) === groupKey);
  const base = items[0];
  const needsReorder = (item: Product) => (item.viterboQty - item.viterboReserved) <= item.viterboReorderLevel || (item.granSassoQty - item.granSassoReserved) <= item.granSassoReorderLevel;
  const photoKey = items.find((item) => item.photoKey)?.photoKey;
  const totalViterbo = items.reduce((sum, item) => sum + item.viterboQty, 0);
  const totalGranSasso = items.reduce((sum, item) => sum + item.granSassoQty, 0);
  async function remove(item: Product) { if (!confirm(`Cancellare la variante ${item.color} ${item.size}?`)) return; setError(""); try { await post("deleteProduct", { id: item.id }); const remaining = data.products.filter((row) => (row.variantGroup || `single-${row.id}`) === groupKey && row.id !== item.id); await reload(); if (!remaining.length) onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  const [edits, setEdits] = useState<Record<number, { viterbo: number; granSasso: number }>>({});
  const [saving, setSaving] = useState(false);
  const editable = editMode && isAdmin;
  const dirty = items.some((item) => edits[item.id] && (edits[item.id].viterbo !== item.viterboQty || edits[item.id].granSasso !== item.granSassoQty));
  function enterEdit() { setEdits(Object.fromEntries(items.map((item) => [item.id, { viterbo: item.viterboQty, granSasso: item.granSassoQty }]))); setError(""); setEditMode(true); }
  function cancelEdit() { if (dirty && !confirm("Ci sono modifiche non salvate. Annullare le modifiche?")) return; setEdits({}); setEditMode(false); setError(""); }
  function setField(id: number, store: "viterbo" | "granSasso", value: string) { const quantity = Math.max(0, Math.round(Number(value) || 0)); setEdits((current) => ({ ...current, [id]: { ...current[id], [store]: quantity } })); }
  async function saveEdits() {
    setSaving(true); setError("");
    try {
      for (const item of items) {
        const edit = edits[item.id]; if (!edit) continue;
        if (edit.viterbo !== item.viterboQty) await post("setStock", { id: item.id, store: "Viterbo", quantity: edit.viterbo });
        if (edit.granSasso !== item.granSassoQty) await post("setStock", { id: item.id, store: "Gran Sasso", quantity: edit.granSasso });
      }
      await reload(); setEdits({}); setEditMode(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
    finally { setSaving(false); }
  }
  if (!base) return <Empty>Questo prodotto non esiste piu'.</Empty>;
  return <div className="product-detail"><div className="product-detail-top"><div className="panel product-detail-card">{photoKey && <img className="product-detail-photo" src={`/api/products?key=${encodeURIComponent(photoKey)}`} alt={base.name} />}<div className="product-detail-info"><p className="eyebrow">{base.category}</p><h2 className="product-detail-name">{base.brand} · {base.name}</h2><div className="metric-grid"><Metric label="Prezzo di vendita" value={money(base.price)} /><Metric label="Varianti" value={String(items.length)} /><Metric label="Giacenza Viterbo" value={String(totalViterbo)} /><Metric label="Giacenza Gran Sasso" value={String(totalGranSasso)} /></div></div>{isAdmin && !editable && <button className="secondary" onClick={enterEdit}><MaterialIcon>edit</MaterialIcon> Modifica</button>}</div></div>{editable && <div className="alert" style={{ background: "var(--mint)" }}><MaterialIcon>edit</MaterialIcon> Modalità modifica attiva. Cambia le giacenze e premi Salva.</div>}{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}<div className="panel"><div className="panel-title"><h2>Varianti</h2>{editable && base.variantGroup && <button className="primary" onClick={() => setVariantSource({ product: base, mode: "variant" })}><MaterialIcon>add</MaterialIcon> Aggiungi variante</button>}</div><div className="table-wrap"><table><thead><tr><th>Colore · Taglia</th><th>SKU / EAN</th><th>Prezzo</th><th>Viterbo</th><th>Gran Sasso</th>{editable && <th>Azioni</th>}</tr></thead><tbody>{items.map((item) => <tr key={item.id} className={needsReorder(item) ? "warehouse-low" : ""}><td><strong>{item.color} · {item.size}</strong>{needsReorder(item) && <small className="status warning">da riordinare (min VT {item.viterboReorderLevel} · GS {item.granSassoReorderLevel})</small>}</td><td>{item.sku}<small>{item.eans.split(",").join(" · ")}</small></td><td>{money(item.price)}</td><td>{editable ? <input className="stock-input" type="number" min={item.viterboReserved} value={edits[item.id]?.viterbo ?? item.viterboQty} onChange={(event) => setField(item.id, "viterbo", event.target.value)} /> : item.viterboQty}{item.viterboReserved > 0 && <small>{item.viterboReserved} pren.</small>}</td><td>{editable ? <input className="stock-input" type="number" min={item.granSassoReserved} value={edits[item.id]?.granSasso ?? item.granSassoQty} onChange={(event) => setField(item.id, "granSasso", event.target.value)} /> : item.granSassoQty}{item.granSassoReserved > 0 && <small>{item.granSassoReserved} pren.</small>}</td>{editable && <td><div className="table-actions"><button className="secondary small" onClick={() => setEditing(item)}>Modifica</button><button className="secondary small" onClick={() => setVariantSource({ product: item, mode: "duplicate" })}>Duplica</button><button className="text-button negative" onClick={() => void remove(item)}>Rimuovi</button></div></td>}</tr>)}</tbody></table></div></div>{editable && <div className="form-actions product-detail-actions"><button type="button" className="secondary" onClick={cancelEdit}>Annulla</button><button type="button" className="primary" disabled={saving || !dirty} onClick={() => void saveEdits()}>{saving ? "Salvataggio…" : "Salva"}</button></div>}{editing && <Modal title="Modifica variante" onClose={() => setEditing(null)}><ProductAdminForm product={editing} reload={reload} close={() => setEditing(null)} /></Modal>}{variantSource && <Modal title={variantSource.mode === "duplicate" ? "Duplica come variante" : "Aggiungi variante"} onClose={() => setVariantSource(null)}><VariantQuickForm product={variantSource.product} mode={variantSource.mode} reload={reload} close={() => setVariantSource(null)} /></Modal>}</div>;
}

type ImportRow = { nome: string; marca: string; categoria: string; prezzo: string; colore: string; taglia: string; sku: string; ean: string; viterbo: string; granSasso: string; _valid: boolean };
const IMPORT_TEMPLATE = "nome,marca,categoria,prezzo,colore,taglia,sku,ean,viterbo,gran_sasso\nScarpa Trekking Alta,Salewa,Calzature,129.90,Blu,42,SCARP-BLU-42,8051000000013,5,3\nScarpa Trekking Alta,Salewa,Calzature,129.90,Nero,43,SCARP-NER-43,8051000000020,2,1\n";
function parseCsv(text: string): string[][] {
  const delim = (text.split("\n")[0] || "").includes(";") ? ";" : ",";
  const out: string[][] = []; let field = "", row: string[] = [], q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += c; continue; }
    if (c === '"') { q = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i += 1; row.push(field); if (row.some((x) => x.trim() !== "")) out.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x.trim() !== "")) out.push(row); }
  return out;
}
function ProductImport({ reload, onClose }: { reload: () => Promise<void>; onClose: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ created: number; skipped: { sku: string; reason: string }[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const map: Record<string, keyof ImportRow> = { nome: "nome", name: "nome", marca: "marca", brand: "marca", categoria: "categoria", category: "categoria", prezzo: "prezzo", price: "prezzo", colore: "colore", color: "colore", taglia: "taglia", size: "taglia", sku: "sku", ean: "ean", codice: "ean", viterbo: "viterbo", vt: "viterbo", giacenza_viterbo: "viterbo", gran_sasso: "granSasso", gransasso: "granSasso", gs: "granSasso", giacenza_gran_sasso: "granSasso" };
  function onFile(file: File | null) {
    if (!file) return; setError(""); setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const grid = parseCsv(String(reader.result ?? ""));
        if (grid.length < 2) { setError("Il file non contiene righe."); setRows([]); return; }
        const header = grid[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
        const parsed = grid.slice(1).map((cols) => {
          const r = { nome: "", marca: "", categoria: "", prezzo: "", colore: "", taglia: "", sku: "", ean: "", viterbo: "0", granSasso: "0", _valid: false } as ImportRow;
          header.forEach((h, idx) => { const key = map[h]; if (key) (r[key] as string) = (cols[idx] ?? "").trim(); });
          r._valid = !!(r.nome && r.marca && r.categoria && r.colore && r.taglia && r.sku && r.ean && Number(r.prezzo.replace(",", ".")) > 0);
          return r;
        });
        setRows(parsed);
      } catch { setError("File non leggibile."); }
    };
    reader.readAsText(file);
  }
  const valid = rows.filter((r) => r._valid);
  async function confirm() {
    setSaving(true); setError("");
    try {
      const res = await post("importProducts", { rows: valid.map((r) => ({ nome: r.nome, marca: r.marca, categoria: r.categoria, prezzo: Number(r.prezzo.replace(",", ".")), colore: r.colore, taglia: r.taglia, sku: r.sku, ean: r.ean, viterbo: Number(r.viterbo) || 0, granSasso: Number(r.granSasso) || 0 })) });
      setResult(res as { created: number; skipped: { sku: string; reason: string }[] }); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
    finally { setSaving(false); }
  }
  if (result) return <div className="stack"><div className="alert success"><MaterialIcon>check_circle</MaterialIcon> Import completato: <strong>{result.created}</strong> varianti create{result.skipped.length ? `, ${result.skipped.length} saltate` : ""}.</div>{result.skipped.length > 0 && <div className="table-wrap import-preview"><table><thead><tr><th>SKU</th><th>Motivo</th></tr></thead><tbody>{result.skipped.map((s, i) => <tr key={i}><td>{s.sku}</td><td>{s.reason}</td></tr>)}</tbody></table></div>}<div className="form-actions"><button className="primary" onClick={onClose}>Chiudi</button></div></div>;
  return <div className="stack"><div className="import-help">Carica un file <strong>CSV</strong> con colonne: <code>nome, marca, categoria, prezzo, colore, taglia, sku, ean, viterbo, gran_sasso</code>. Righe con lo stesso nome+marca+categoria diventano varianti dello stesso prodotto. <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE)}`} download="modello-prodotti.csv">Scarica il modello</a>.</div><label className="field"><span>File CSV</span><input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0] ?? null)} /></label>{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}{rows.length > 0 && <><div className="import-summary"><span>Righe: {rows.length}</span><span className="stock-ok">Valide: {valid.length}</span>{rows.length - valid.length > 0 && <span className="negative">Da correggere: {rows.length - valid.length}</span>}</div><div className="table-wrap import-preview"><table><thead><tr><th></th><th>Nome</th><th>Marca</th><th>Colore/Taglia</th><th>Prezzo</th><th>SKU</th><th>EAN</th><th>VT</th><th>GS</th></tr></thead><tbody>{rows.slice(0, 100).map((r, i) => <tr key={i} className={r._valid ? "" : "import-row-bad"}><td>{r._valid ? "OK" : "!"}</td><td>{r.nome}</td><td>{r.marca}</td><td>{r.colore} {r.taglia}</td><td>{r.prezzo}</td><td>{r.sku}</td><td>{r.ean}</td><td>{r.viterbo}</td><td>{r.granSasso}</td></tr>)}</tbody></table></div></>}<div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Annulla</button><button type="button" className="primary" disabled={!valid.length || saving} onClick={() => void confirm()}>{saving ? "Importazione…" : `Importa ${valid.length} varianti`}</button></div></div>;
}

function Warehouse({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [store, setStore] = useState<"Tutti" | Store>("Tutti");
  const [view, setView] = useState<"list" | "grid">("list");
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [detailGroup, setDetailGroup] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isAdmin = data.user.role === "admin";
  const normalized = query.trim().toLocaleLowerCase("it");
  const showVt = store !== "Gran Sasso";
  const showGs = store !== "Viterbo";
  const needsReorder = (item: Product) => (item.viterboQty - item.viterboReserved) <= item.viterboReorderLevel || (item.granSassoQty - item.granSassoReserved) <= item.granSassoReorderLevel;
  const filtered = data.products.filter((item) => !normalized || searchableProduct(item).includes(normalized));
  const groups = new Map<string, { key: string; brand: string; name: string; category: string; price: number; variantGroup: string | null; photoKey: string | null; items: Product[] }>();
  for (const item of filtered) {
    const key = item.variantGroup || `single-${item.id}`;
    const group = groups.get(key) ?? { key, brand: item.brand, name: item.name, category: item.category, price: item.price, variantGroup: item.variantGroup, photoKey: null as string | null, items: [] as Product[] };
    if (!group.photoKey && item.photoKey) group.photoKey = item.photoKey;
    group.items.push(item); groups.set(key, group);
  }
  const groupList = [...groups.values()].sort((a, b) => `${a.name} ${a.brand}`.localeCompare(`${b.name} ${b.brand}`, "it"));
  const groupStock = (group: typeof groupList[number]) => ({ vt: group.items.reduce((s, i) => s + i.viterboQty, 0), gs: group.items.reduce((s, i) => s + i.granSassoQty, 0) });
  const groupLow = (group: typeof groupList[number]) => group.items.some(needsReorder);
  const stockText = (group: typeof groupList[number]) => { const s = groupStock(group); return store === "Viterbo" ? `${s.vt} pz` : store === "Gran Sasso" ? `${s.gs} pz` : `VT ${s.vt} · GS ${s.gs}`; };
  const colCount = 3 + (showVt ? 1 : 0) + (showGs ? 1 : 0);
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">GESTIONE MAGAZZINO</p><h1>Magazzino</h1><p className="muted inventory-intro">Sfoglia prodotti e giacenze. Per modificare apri la scheda.</p></div>{isAdmin && <div className="head-controls">{<button className="secondary" onClick={() => setShowImport(true)}><MaterialIcon>upload_file</MaterialIcon> Importa CSV</button>}<button className="primary" onClick={() => setShowNew(true)}><MaterialIcon>add_box</MaterialIcon> Nuovo prodotto</button></div>}</div><div className="panel"><div className="wh-toolbar"><div className="wh-toolbar-left"><div className="store-selector">{(["Tutti", "Viterbo", "Gran Sasso"] as const).map((option) => <button key={option} className={store === option ? "active" : ""} onClick={() => setStore(option)}>{option !== "Tutti" && <span className={`dot ${option === "Viterbo" ? "viterbo" : "gran-sasso"}`} />}{option}</button>)}</div></div><div className="view-toggle"><button className={view === "list" ? "active" : ""} onClick={() => setView("list")} title="Elenco"><MaterialIcon>view_list</MaterialIcon></button><button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} title="Griglia"><MaterialIcon>grid_view</MaterialIcon></button></div></div><div className="search-hero"><MaterialIcon>search</MaterialIcon><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca per nome, marca, colore, taglia, SKU o EAN…" /></div></div><EanLoadBar data={data} reload={reload} />{view === "grid" ? <div className="product-grid">{groupList.map((group) => <button key={group.key} type="button" className={`product-card ${groupLow(group) ? "low" : ""}`} onClick={() => setDetailGroup(group.key)}><div className="thumb" style={group.photoKey ? { backgroundImage: `url(/api/products?key=${encodeURIComponent(group.photoKey)})` } : undefined}>{!group.photoKey && <MaterialIcon>image</MaterialIcon>}</div><div className="body"><span className="p-name">{group.name}</span><span className="p-meta">{group.brand} · {group.category} · {group.items.length} {group.items.length === 1 ? "variante" : "varianti"}</span><div className="p-foot"><span className="p-price">{money(group.price)}</span><span className="p-stock">{stockText(group)}{groupLow(group) && " ⚠"}</span></div></div></button>)}{!groupList.length && <Empty>Nessun prodotto trovato.</Empty>}</div> : <div className="panel"><div className="table-wrap"><table><thead><tr><th>Prodotto / Variante</th><th>SKU / EAN</th><th>Prezzo</th>{showVt && <th>Viterbo</th>}{showGs && <th>Gran Sasso</th>}</tr></thead><tbody>{groupList.map((group) => <Fragment key={group.key}><tr className="warehouse-group-row"><td colSpan={colCount}><button type="button" className="text-button" title="Espandi/comprimi" onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))}><MaterialIcon>{collapsed[group.key] ? "chevron_right" : "expand_more"}</MaterialIcon></button><button type="button" className="text-button warehouse-group-name" onClick={() => setDetailGroup(group.key)} title="Apri scheda prodotto"><strong>{group.name}</strong> <small>{group.brand} · {group.category} · {money(group.price)} · {group.items.length} {group.items.length === 1 ? "variante" : "varianti"}</small></button><button className="secondary small" onClick={() => setDetailGroup(group.key)}>Apri scheda</button></td></tr>{!collapsed[group.key] && group.items.map((item) => <tr key={item.id} className={needsReorder(item) ? "warehouse-low" : ""}><td><strong>{item.color} · {item.size}</strong>{needsReorder(item) && <small className="status warning">da riordinare (min VT {item.viterboReorderLevel} · GS {item.granSassoReorderLevel})</small>}</td><td>{item.sku}<small>{item.eans.split(",").join(" · ")}</small></td><td>{money(item.price)}</td>{showVt && <td>{item.viterboQty}{item.viterboReserved > 0 && <small>{item.viterboReserved} pren.</small>}</td>}{showGs && <td>{item.granSassoQty}{item.granSassoReserved > 0 && <small>{item.granSassoReserved} pren.</small>}</td>}</tr>)}</Fragment>)}</tbody></table></div>{!groupList.length && <Empty>Nessun prodotto trovato.</Empty>}</div>}{showNew && <Modal title="Nuovo prodotto" onClose={() => setShowNew(false)}><NewProductForm data={data} reload={reload} onCreated={() => setShowNew(false)} /></Modal>}{showImport && <Modal title="Importa prodotti da CSV" wide onClose={() => setShowImport(false)}><ProductImport reload={reload} onClose={() => setShowImport(false)} /></Modal>}{detailGroup && <Modal title="Scheda prodotto" wide guard={false} onClose={() => setDetailGroup(null)}><ProductDetail data={data} reload={reload} groupKey={detailGroup} onClose={() => setDetailGroup(null)} /></Modal>}</section>;
}

function GiftSummary({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [query, setQuery] = useState(""); const [editing, setEditing] = useState<Gift | null>(null); const [error, setError] = useState("");
  const isAdmin = data.user.role === "admin";
  const visible = data.gifts.filter((gift) => `${gift.code} ${gift.beneficiary} ${gift.store}`.toLowerCase().includes(query.toLowerCase()));
  async function remove(gift: Gift) { if (!confirm(`Cancellare il buono ${gift.code}?`)) return; setError(""); try { await post("deleteGift", { id: gift.id }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">AMMINISTRAZIONE</p><h1>Riepilogo buoni regalo</h1></div></div>{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}<div className="metric-grid"><Metric label="Valore emesso" value={money(data.gifts.reduce((sum, gift) => sum + gift.initialValue, 0))} /><Metric label="Valore utilizzato" value={money(data.gifts.reduce((sum, gift) => sum + gift.initialValue - gift.balance, 0))} /><Metric label="Saldo residuo" value={money(data.gifts.reduce((sum, gift) => sum + gift.balance, 0))} /></div><div className="panel"><ClearableInput label="Ricerca codice o intestatario" value={query} onChange={setQuery} /><div className="table-wrap"><table><thead><tr><th>Codice</th><th>Intestatario</th><th>Sede</th><th>Emesso</th><th>Residuo</th><th>Scadenza</th><th>Stato</th><th>PDF</th>{isAdmin && <th>Azioni</th>}</tr></thead><tbody>{visible.map((gift) => <tr key={gift.id}><td>{gift.code}</td><td>{gift.beneficiary}</td><td>{gift.store}</td><td>{money(gift.initialValue)}</td><td><b>{money(gift.balance)}</b></td><td>{new Date(gift.expiresAt).toLocaleDateString("it-IT")}</td><td><span className={`status ${gift.status}`}>{gift.status === "reversed" ? "stornato" : gift.status}</span></td><td><a href={`/api/pdf?type=gift&id=${gift.id}`}>Scarica</a></td>{isAdmin && <td><div className="table-actions"><button className="secondary small" onClick={() => setEditing(gift)}>Modifica</button><button className="text-button negative" onClick={() => void remove(gift)}>Rimuovi</button></div></td>}</tr>)}</tbody></table></div></div>{editing && <Modal title="Modifica buono" onClose={() => setEditing(null)}><GiftAdminForm gift={editing} reload={reload} close={() => setEditing(null)} /></Modal>}</section>;
}

function ReservationSummary({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [query, setQuery] = useState(""); const [editing, setEditing] = useState<Reservation | null>(null); const [error, setError] = useState("");
  const isAdmin = data.user.role === "admin";
  const visible = data.reservations.filter((reservation) => (data.user.role === "admin" || reservation.store === data.user.store) && `${reservation.code} ${reservation.description} ${reservation.itemDescriptions} ${reservation.customerName}`.toLowerCase().includes(query.toLowerCase()));
  async function remove(reservation: Reservation) { if (!confirm(`Cancellare la prenotazione ${reservation.code}?`)) return; setError(""); try { await post("deleteReservation", { id: reservation.id }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">ACCONTI E RITIRI</p><h1>Prenotazioni e risuolature</h1></div></div>{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}<div className="panel"><ClearableInput label="Ricerca codice, prodotto o cliente" value={query} onChange={setQuery} /><div className="table-wrap"><table><thead><tr><th>Codice</th><th>Data</th><th>Sede</th><th>Descrizione</th><th>Articoli</th><th>Cliente</th><th>Acconto</th><th>Saldo</th><th>Stato</th><th>PDF EAN</th>{isAdmin && <th>Azioni</th>}</tr></thead><tbody>{visible.map((reservation) => <tr key={reservation.id}><td>{reservation.code}</td><td>{dateTime(reservation.createdAt)}</td><td>{reservation.store}</td><td>{reservation.kind === "repair" ? <><strong>Risuolatura</strong><small>{reservation.itemDescriptions || reservation.description}</small></> : reservation.description}</td><td>{reservation.itemCount || 1}</td><td>{reservation.customerName || "Non associato"}</td><td>{money(reservation.depositAmount)}</td><td><b>{money(reservation.balanceDue)}</b></td><td><span className={`status ${reservation.status === "open" ? "active" : "used"}`}>{reservation.status}</span></td><td><a href={`/api/pdf?type=reservation&id=${reservation.id}`}>Scarica</a></td>{isAdmin && <td><div className="table-actions"><button className="secondary small" onClick={() => setEditing(reservation)}>Modifica</button><button className="text-button negative" onClick={() => void remove(reservation)}>Rimuovi</button></div></td>}</tr>)}</tbody></table></div></div>{editing && <Modal title="Modifica prenotazione" onClose={() => setEditing(null)}><ReservationAdminForm reservation={editing} reload={reload} close={() => setEditing(null)} /></Modal>}</section>;
}

type TransferAdminItem = { productId: number; quantity: number; name: string; brand: string; color: string; size: string };

function ProductAdminForm({ product, reload, close }: { product: Product; reload: () => Promise<void>; close: () => void }) {
  const [form, setForm] = useState({ name: product.name, brand: product.brand, category: product.category, sku: product.sku, color: product.color, size: product.size, price: String(product.price), eans: product.eans, viterboQty: String(product.viterboQty), viterboReorderLevel: String(product.viterboReorderLevel), granSassoQty: String(product.granSassoQty), granSassoReorderLevel: String(product.granSassoReorderLevel) });
  const [error, setError] = useState("");
  const set = (name: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: React.FormEvent) { event.preventDefault(); setError(""); try { await post("updateProduct", { id: product.id, ...form, eans: form.eans.split(",").map((value) => value.trim()).filter(Boolean) }); await reload(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <form className="stack" onSubmit={save}><div className="form-grid"><ClearableInput label="Nome prodotto" value={form.name} onChange={set("name")} required /><ClearableInput label="Marca" value={form.brand} onChange={set("brand")} required /><ClearableInput label="Categoria" value={form.category} onChange={set("category")} required /><ClearableInput label="Prezzo vendita" type="number" min="0.01" step="0.01" value={form.price} onChange={set("price")} required /><ClearableInput label="SKU variante" value={form.sku} onChange={set("sku")} required /><ClearableInput label="Colore" value={form.color} onChange={set("color")} required /><ClearableInput label="Taglia" value={form.size} onChange={set("size")} required /><ClearableInput className="full" label="EAN separati da virgola" value={form.eans} onChange={set("eans")} required /><ClearableInput label={`Giacenza Viterbo · ${product.viterboReserved} prenotati`} type="number" min={product.viterboReserved} value={form.viterboQty} onChange={set("viterboQty")} /><ClearableInput label="Scorta minima Viterbo" type="number" min="0" value={form.viterboReorderLevel} onChange={set("viterboReorderLevel")} /><ClearableInput label={`Giacenza Gran Sasso · ${product.granSassoReserved} prenotati`} type="number" min={product.granSassoReserved} value={form.granSassoQty} onChange={set("granSassoQty")} /><ClearableInput label="Scorta minima Gran Sasso" type="number" min="0" value={form.granSassoReorderLevel} onChange={set("granSassoReorderLevel")} />{error && <div className="alert danger full">{error}</div>}<div className="form-actions full"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Salva modifiche</button></div></div></form>;
}

function VariantQuickForm({ product, mode, reload, close }: { product: Product; mode: "variant" | "duplicate"; reload: () => Promise<void>; close: () => void }) {
  const slugify = (value: string) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12);
  const makeSku = (color: string, size: string) => [product.name, color, size].map(slugify).filter(Boolean).join("-").toUpperCase();
  const startColor = mode === "duplicate" ? product.color : "";
  const startSize = mode === "duplicate" ? product.size : "";
  const [color, setColor] = useState(startColor);
  const [size, setSize] = useState(startSize);
  const [sku, setSku] = useState(makeSku(startColor, startSize));
  const [skuTouched, setSkuTouched] = useState(false);
  const [eans, setEans] = useState("");
  const [viterboQty, setViterboQty] = useState("0");
  const [viterboReorderLevel, setViterboReorderLevel] = useState(String(product.viterboReorderLevel));
  const [granSassoQty, setGranSassoQty] = useState("0");
  const [granSassoReorderLevel, setGranSassoReorderLevel] = useState(String(product.granSassoReorderLevel));
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  function updateColor(value: string) { setColor(value); if (!skuTouched) setSku(makeSku(value, size)); }
  function updateSize(value: string) { setSize(value); if (!skuTouched) setSku(makeSku(color, value)); }
  function choosePhoto(file: File | null) {
    if (!file) { setPhoto(null); setPhotoPreview(""); return; }
    const reader = new FileReader(); reader.onload = () => setPhotoPreview(String(reader.result ?? "")); reader.readAsDataURL(file); setPhoto(file);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      if (isClientTestMode()) throw new Error("Modalità TEST attiva: variante non salvata (nessuna scrittura).");
      const body = new FormData();
      body.append("payload", JSON.stringify({ variantGroup: product.variantGroup, variants: [{ sku, color, size, eans: eans.split(",").map((value) => value.trim()).filter(Boolean), viterboQty, viterboReorderLevel, granSassoQty, granSassoReorderLevel }] }));
      if (photo) body.append("photo-0", photo);
      await readJson(await fetch("/api/products", { method: "POST", body }));
      await reload(); close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
    finally { setSaving(false); }
  }
  return <form className="stack" onSubmit={save}>
    <div className="alert" style={{ background: "var(--surface-2, #eef4f8)" }}>Variante di <strong>{product.brand} · {product.name}</strong> · {product.category} · {money(product.price)}</div>
    <div className="form-grid">
      <ClearableInput label="Colore" value={color} onChange={updateColor} required autoFocus />
      <ClearableInput label="Taglia" value={size} onChange={updateSize} required />
      <label className="field"><span>SKU</span><span className="input-wrap"><input value={sku} onChange={(event) => { setSku(event.target.value); setSkuTouched(true); }} required /><button type="button" className="clear-input" title="Rigenera SKU dal nome" onClick={() => { setSku(makeSku(color, size)); setSkuTouched(false); }}><MaterialIcon>autorenew</MaterialIcon></button></span></label>
      <label className="field"><span>EAN separati da virgola</span><span className="input-wrap"><input value={eans} onChange={(event) => setEans(event.target.value)} required /><button type="button" className="clear-input" title="Genera un EAN" onClick={() => setEans((current) => current ? `${current}, ${makeEan13()}` : makeEan13())}><MaterialIcon>add</MaterialIcon></button></span></label>
      <ClearableInput label="Giacenza Viterbo" type="number" min="0" value={viterboQty} onChange={setViterboQty} />
      <ClearableInput label="Scorta minima Viterbo" type="number" min="0" value={viterboReorderLevel} onChange={setViterboReorderLevel} />
      <ClearableInput label="Giacenza Gran Sasso" type="number" min="0" value={granSassoQty} onChange={setGranSassoQty} />
      <ClearableInput label="Scorta minima Gran Sasso" type="number" min="0" value={granSassoReorderLevel} onChange={setGranSassoReorderLevel} />
      <label className="field variant-photo-field full"><span>Foto colore (opzionale)</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => choosePhoto(event.target.files?.[0] ?? null)} /></label>
      {photoPreview && <div className="variant-photo-preview"><img src={photoPreview} alt="Anteprima variante" /><button type="button" className="icon-button" aria-label="Rimuovi foto" onClick={() => choosePhoto(null)}><MaterialIcon>close</MaterialIcon></button></div>}
      {error && <div className="alert danger full">{error}</div>}
      <div className="form-actions full"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary" disabled={saving}>{saving ? "Salvataggio…" : "Salva variante"}</button></div>
    </div>
  </form>;
}

function GiftAdminForm({ gift, reload, close }: { gift: Gift; reload: () => Promise<void>; close: () => void }) {
  const [beneficiary, setBeneficiary] = useState(gift.beneficiary); const [initialValue, setInitialValue] = useState(String(gift.initialValue)); const [balance, setBalance] = useState(String(gift.balance)); const [expiresAt, setExpiresAt] = useState(gift.expiresAt.slice(0, 10)); const [status, setStatus] = useState(gift.status); const [error, setError] = useState("");
  async function save(event: React.FormEvent) { event.preventDefault(); setError(""); try { await post("updateGift", { id: gift.id, beneficiary, initialValue, balance, expiresAt, status }); await reload(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <form className="stack" onSubmit={save}><ClearableInput label="Intestatario" value={beneficiary} onChange={setBeneficiary} required /><div className="form-grid"><ClearableInput label="Valore emesso" type="number" min="0.01" step="0.01" value={initialValue} onChange={setInitialValue} required /><ClearableInput label="Saldo residuo" type="number" min="0" step="0.01" value={balance} onChange={setBalance} required /><ClearableInput label="Scadenza" type="date" value={expiresAt} onChange={setExpiresAt} required /><label className="field"><span>Stato</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Attivo</option><option value="used">Utilizzato</option><option value="expired">Scaduto</option><option value="reversed">Stornato</option></select></label></div>{error && <div className="alert danger">{error}</div>}<div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Salva modifiche</button></div></form>;
}

function ReservationAdminForm({ reservation, reload, close }: { reservation: Reservation; reload: () => Promise<void>; close: () => void }) {
  const [description, setDescription] = useState(reservation.description); const [totalPrice, setTotalPrice] = useState(String(reservation.totalPrice)); const [depositAmount, setDepositAmount] = useState(String(reservation.depositAmount)); const [status, setStatus] = useState(reservation.status); const [error, setError] = useState("");
  async function save(event: React.FormEvent) { event.preventDefault(); setError(""); try { await post("updateReservation", { id: reservation.id, description, totalPrice, depositAmount, status }); await reload(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <form className="stack" onSubmit={save}><ClearableInput label="Descrizione" value={description} onChange={setDescription} required /><div className="form-grid"><ClearableInput label="Totale concordato" type="number" min="0.01" step="0.01" value={totalPrice} onChange={setTotalPrice} required /><ClearableInput label="Acconto versato" type="number" min="0" step="0.01" value={depositAmount} onChange={setDepositAmount} required /><label className="field full"><span>Stato</span><select value={status} disabled={reservation.status === "completed"} onChange={(event) => setStatus(event.target.value)}><option value="open">Aperta</option><option value="cancelled">Annullata</option>{reservation.status === "completed" && <option value="completed">Completata</option>}</select></label></div>{error && <div className="alert danger">{error}</div>}<div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Salva modifiche</button></div></form>;
}

function TransferAdminForm({ transfer, items, reload, close }: { transfer: Transfer; items: TransferAdminItem[]; reload: () => Promise<void>; close: () => void }) {
  const [sender, setSender] = useState(transfer.sender); const [receiver, setReceiver] = useState(transfer.receiver); const [carrier, setCarrier] = useState(transfer.carrier); const [transportReason, setTransportReason] = useState(transfer.transportReason); const [lines, setLines] = useState(items); const [error, setError] = useState("");
  async function save(event: React.FormEvent) { event.preventDefault(); setError(""); try { await post("updateTransfer", { id: transfer.id, sender, receiver, carrier, transportReason, items: lines.map(({ productId, quantity }) => ({ productId, quantity })) }); await reload(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <form className="stack" onSubmit={save}><div className="form-grid"><ClearableInput label="Mittente" value={sender} onChange={setSender} required /><ClearableInput label="Ricevente" value={receiver} onChange={setReceiver} required /><ClearableInput label="Vettore" value={carrier} onChange={setCarrier} required /><ClearableInput label="Causale" value={transportReason} onChange={setTransportReason} required /></div><div className="cart-list transfer-lines">{lines.map((item) => <div className="cart-row" key={item.productId}><div className="cart-desc"><strong>{item.brand ? `${item.brand} · ` : ""}{item.name}</strong><small>{item.color} · {item.size}</small></div><ClearableInput compact label="Quantità" type="number" min="1" value={item.quantity} onChange={(value) => setLines((current) => current.map((line) => line.productId === item.productId ? { ...line, quantity: Math.max(1, Number(value) || 1) } : line))} /></div>)}</div>{error && <div className="alert danger">{error}</div>}<div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Salva modifiche DDT</button></div></form>;
}


function Metric({ label, value, note }: { label: string; value: string; note?: string }) { return <article className="metric"><small>{label}</small><strong>{value}</strong>{note && <span>{note}</span>}</article>; }

type ReportSale = Pick<Sale, "store" | "total" | "cashAmount" | "cardAmount" | "bankAmount" | "giftAmount" | "createdAt">;
const reportStores: Store[] = ["Viterbo", "Gran Sasso"];

function CashReports({ data }: { data: Bootstrap }) {
  const [mode, setMode] = useState<"daily" | "monthly">("daily");
  const sales: ReportSale[] = data.sales;
  const totalFor = (store?: Store) => sales.filter((sale) => !store || sale.store === store).reduce((sum, sale) => sum + sale.total, 0);
  const grandTotal = totalFor();
  const storeTotals = { Viterbo: totalFor("Viterbo"), "Gran Sasso": totalFor("Gran Sasso") };
  const movementCount = sales.length;
  const averageTicket = movementCount ? grandTotal / movementCount : 0;
  const reportRows = useMemo(() => {
    const rows = new Map<string, { sortKey: string; label: string; viterbo: number; granSasso: number; count: number; returns: number }>();
    for (const sale of sales) {
      const date = new Date(sale.createdAt);
      const sortKey = mode === "daily"
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
        : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const label = mode === "daily"
        ? date.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short" })
        : date.toLocaleDateString("it-IT", { month: "long", year: "numeric" });
      const current = rows.get(sortKey) ?? { sortKey, label, viterbo: 0, granSasso: 0, count: 0, returns: 0 };
      if (sale.store === "Viterbo") current.viterbo += sale.total;
      else current.granSasso += sale.total;
      current.count += 1;
      if (sale.total < 0) current.returns += sale.total;
      rows.set(sortKey, current);
    }
    return [...rows.values()].sort((left, right) => right.sortKey.localeCompare(left.sortKey));
  }, [sales, mode]);
  const maxStoreTotal = Math.max(1, ...reportStores.map((store) => Math.abs(storeTotals[store])));
  const reportTree = useMemo(() => reportStores.map((store) => {
    const storeSales = sales.filter((sale) => sale.store === store);
    const yearMap = new Map<number, Map<number, ReportSale[]>>();
    for (const sale of storeSales) {
      const date = new Date(sale.createdAt);
      const year = date.getFullYear();
      const month = date.getMonth();
      const months = yearMap.get(year) ?? new Map<number, ReportSale[]>();
      months.set(month, [...(months.get(month) ?? []), sale]);
      yearMap.set(year, months);
    }
    const years = [...yearMap.entries()].sort(([left], [right]) => right - left).map(([year, months]) => ({
      year,
      sales: [...months.values()].flat(),
      months: [...months.entries()].sort(([left], [right]) => right - left).map(([month, monthSales]) => ({ month, sales: monthSales })),
    }));
    return { store, sales: storeSales, years };
  }), [sales]);

  function printMonth(store: Store, year: number, month: number, monthSales: ReportSale[]) {
    const popup = window.open("", "_blank", "width=920,height=720");
    if (!popup) return;
    const monthName = new Date(year, month, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
    const dayMap = new Map<string, ReportSale[]>();
    for (const sale of monthSales) {
      const key = new Date(sale.createdAt).toLocaleDateString("it-IT");
      dayMap.set(key, [...(dayMap.get(key) ?? []), sale]);
    }
    const sum = (key: "total" | "cashAmount" | "cardAmount" | "bankAmount" | "giftAmount") => monthSales.reduce((total, sale) => total + sale[key], 0);
    const rows = [...dayMap.entries()].map(([day, daySales]) => `<tr><td>${day}</td><td>${money(daySales.reduce((total, sale) => total + sale.cashAmount, 0))}</td><td>${money(daySales.reduce((total, sale) => total + sale.cardAmount, 0))}</td><td>${money(daySales.reduce((total, sale) => total + sale.bankAmount, 0))}</td><td>${money(daySales.reduce((total, sale) => total + sale.giftAmount, 0))}</td><td><b>${money(daySales.reduce((total, sale) => total + sale.total, 0))}</b></td></tr>`).join("");
    popup.document.write(`<!doctype html><html lang="it"><head><title>Corrispettivi ${store} · ${monthName}</title><style>body{font-family:Arial,sans-serif;margin:36px;color:#111}header{display:flex;justify-content:space-between;align-items:end;border-bottom:3px solid #12bfe9;padding-bottom:16px}h1{margin:0 0 5px;font-size:25px}p{margin:0;color:#555}strong.total{font-size:25px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px 8px;border-bottom:1px solid #ddd;text-align:right}th:first-child,td:first-child{text-align:left}tfoot{font-weight:bold;background:#eefaff}.meta{margin-top:24px;font-size:12px;color:#666}@media print{body{margin:18mm}.meta{display:none}}</style></head><body><header><div><h1>Corrispettivi · ${store}</h1><p>${monthName}</p></div><strong class="total">${money(sum("total"))}</strong></header><table><thead><tr><th>Giorno</th><th>Contanti</th><th>POS</th><th>Bonifici</th><th>Buoni</th><th>Totale</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td>Totale mese</td><td>${money(sum("cashAmount"))}</td><td>${money(sum("cardAmount"))}</td><td>${money(sum("bankAmount"))}</td><td>${money(sum("giftAmount"))}</td><td>${money(sum("total"))}</td></tr></tfoot></table><p class="meta">Gestionale Marinelli Stefano · stampato il ${new Date().toLocaleString("it-IT")}</p><script>window.onload=()=>{window.print()}<\/script></body></html>`);
    popup.document.close();
  }

  return <section className="screen reports-screen">
    <div className="screen-head reports-head">
      <div><p className="eyebrow">CORRISPETTIVI · ENTRAMBI I NEGOZI</p><h1>Quanto stanno facendo i negozi</h1><p className="muted inventory-intro">Incassi, pagamenti e confronto tra Viterbo e Gran Sasso in una sola schermata.</p></div>
      <div className="head-controls report-controls">
        <label className="field inline"><span>Raggruppamento</span><select value={mode} onChange={(event) => setMode(event.target.value as "daily" | "monthly")}><option value="daily">Giornaliero</option><option value="monthly">Mensile</option></select></label>
      </div>
    </div>
    <div className="report-kpis">
      <article className="report-kpi primary-kpi"><MaterialIcon>payments</MaterialIcon><span><small>Totale complessivo</small><strong>{money(grandTotal)}</strong><em>{movementCount} movimenti</em></span></article>
      <article className="report-kpi"><MaterialIcon>storefront</MaterialIcon><span><small>Viterbo</small><strong>{money(storeTotals.Viterbo)}</strong><em>{grandTotal ? (storeTotals.Viterbo / grandTotal * 100).toFixed(1) : "0"}% del totale</em></span></article>
      <article className="report-kpi"><MaterialIcon>landscape</MaterialIcon><span><small>Gran Sasso</small><strong>{money(storeTotals["Gran Sasso"])}</strong><em>{grandTotal ? (storeTotals["Gran Sasso"] / grandTotal * 100).toFixed(1) : "0"}% del totale</em></span></article>
      <article className="report-kpi"><MaterialIcon>receipt_long</MaterialIcon><span><small>Scontrino medio</small><strong>{money(averageTicket)}</strong><em>media dei due negozi</em></span></article>
    </div>
    <div className="report-tree">
      {reportTree.map(({ store, sales: storeSales, years }) => <details className={`report-store-accordion ${store === "Viterbo" ? "viterbo" : "gran-sasso"}`} key={store}>
        <summary>
          <span className="report-chevron"><MaterialIcon>chevron_right</MaterialIcon></span>
          <span className="store-title-icon"><MaterialIcon>{store === "Viterbo" ? "storefront" : "landscape"}</MaterialIcon></span>
          <span className="report-summary-title"><small>PUNTO VENDITA</small><strong>{store}</strong></span>
          <span className="report-summary-meta">{years.length} {years.length === 1 ? "anno" : "anni"} · {storeSales.length} movimenti</span>
          <b>{money(storeTotals[store])}</b>
        </summary>
        <div className="report-store-progress"><i style={{ width: `${Math.max(4, Math.abs(storeTotals[store]) / maxStoreTotal * 100)}%` }} /></div>
        <div className="report-years">
          {years.map(({ year, sales: yearSales, months }) => {
            const yearTotal = yearSales.reduce((sum, sale) => sum + sale.total, 0);
            return <details className="report-year-accordion" key={year}>
              <summary><span className="report-chevron"><MaterialIcon>chevron_right</MaterialIcon></span><MaterialIcon>calendar_month</MaterialIcon><strong>{year}</strong><span>{months.length} {months.length === 1 ? "mese" : "mesi"}</span><b>{money(yearTotal)}</b></summary>
              <div className="report-months">
                {months.map(({ month, sales: monthSales }) => {
                  const monthName = new Date(year, month, 1).toLocaleDateString("it-IT", { month: "long" });
                  const sum = (key: "total" | "cashAmount" | "cardAmount" | "bankAmount" | "giftAmount") => monthSales.reduce((total, sale) => total + sale[key], 0);
                  const dailyRows = new Map<string, ReportSale[]>();
                  for (const sale of monthSales) {
                    const key = new Date(sale.createdAt).toLocaleDateString("it-IT");
                    dailyRows.set(key, [...(dailyRows.get(key) ?? []), sale]);
                  }
                  return <details className="report-month-accordion" key={month}>
                    <summary><span className="report-chevron"><MaterialIcon>chevron_right</MaterialIcon></span><strong>{monthName}</strong><span>{monthSales.length} movimenti</span><b>{money(sum("total"))}</b></summary>
                    <div className="report-month-content">
                      <div className="report-month-toolbar"><div><small>DETTAGLIO DEL MESE</small><strong>{monthName} {year} · {store}</strong></div><button className="primary" onClick={() => printMonth(store, year, month, monthSales)}><MaterialIcon>print</MaterialIcon>Stampa mese</button></div>
                      <div className="report-payment-grid">
                        <span><MaterialIcon>payments</MaterialIcon><small>Contanti</small><b>{money(sum("cashAmount"))}</b></span>
                        <span><MaterialIcon>credit_card</MaterialIcon><small>Carte / POS</small><b>{money(sum("cardAmount"))}</b></span>
                        <span><MaterialIcon>account_balance</MaterialIcon><small>Bonifici</small><b>{money(sum("bankAmount"))}</b></span>
                        <span><MaterialIcon>redeem</MaterialIcon><small>Buoni</small><b>{money(sum("giftAmount"))}</b></span>
                      </div>
                      <div className="table-wrap"><table><thead><tr><th>Giorno</th><th>Contanti</th><th>POS</th><th>Bonifici</th><th>Buoni</th><th>Totale</th></tr></thead><tbody>{[...dailyRows.entries()].map(([day, daySales]) => <tr key={day}><td><strong>{day}</strong></td><td>{money(daySales.reduce((total, sale) => total + sale.cashAmount, 0))}</td><td>{money(daySales.reduce((total, sale) => total + sale.cardAmount, 0))}</td><td>{money(daySales.reduce((total, sale) => total + sale.bankAmount, 0))}</td><td>{money(daySales.reduce((total, sale) => total + sale.giftAmount, 0))}</td><td><b>{money(daySales.reduce((total, sale) => total + sale.total, 0))}</b></td></tr>)}</tbody></table></div>
                    </div>
                  </details>;
                })}
              </div>
            </details>;
          })}
        </div>
      </details>)}
    </div>
    <details className="panel report-comparison">
      <summary className="panel-title"><span className="report-chevron"><MaterialIcon>chevron_right</MaterialIcon></span><div><p className="eyebrow">CONFRONTO DIRETTO</p><h2>{mode === "daily" ? "Incassi giorno per giorno" : "Incassi mese per mese"}</h2></div><div className="chart-legend"><span><i className="viterbo" />Viterbo</span><span><i className="gran-sasso" />Gran Sasso</span></div></summary>
      <div className="table-wrap report-comparison-table"><table><thead><tr><th>Periodo</th><th>Viterbo</th><th>Gran Sasso</th><th>Totale negozi</th><th>Differenza</th><th>Resi</th><th>Movimenti</th></tr></thead><tbody>{reportRows.length ? reportRows.map((row) => {
        const total = row.viterbo + row.granSasso;
        const difference = row.viterbo - row.granSasso;
        return <tr key={row.sortKey}><td><strong>{row.label}</strong></td><td><b className="store-value viterbo">{money(row.viterbo)}</b></td><td><b className="store-value gran-sasso">{money(row.granSasso)}</b></td><td><strong>{money(total)}</strong></td><td className={difference < 0 ? "negative" : ""}>{difference >= 0 ? "+" : ""}{money(difference)}</td><td className="negative">{money(row.returns)}</td><td>{row.count}</td></tr>;
      }) : <tr><td colSpan={7}><Empty>Nessun corrispettivo disponibile.</Empty></td></tr>}</tbody></table></div>
    </details>
  </section>;
}

function Register({ data }: { data: Bootstrap }) {
  const [query, setQuery] = useState(""); const visible = data.sales.filter((sale) => `${sale.receiptNo} ${sale.customerName} ${sale.store}`.toLowerCase().includes(query.toLowerCase()));
  const ownStore = data.user.store;
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">RICERCA PER NOMINATIVO</p><h1>Vendite effettuate{ownStore ? ` · ${ownStore}` : ""}</h1><p className="muted inventory-intro">{ownStore ? `Sono visibili esclusivamente le vendite registrate dal negozio ${ownStore}.` : "L’amministratore può consultare le vendite di entrambi i negozi."}</p></div></div><div className="metric-grid">{data.user.role === "admin" ? <><Metric label="Netto Viterbo" value={money(data.sales.filter((sale) => sale.store === "Viterbo").reduce((sum, sale) => sum + sale.total, 0))} /><Metric label="Netto Gran Sasso" value={money(data.sales.filter((sale) => sale.store === "Gran Sasso").reduce((sum, sale) => sum + sale.total, 0))} /></> : <Metric label={`Netto ${ownStore}`} value={money(data.sales.reduce((sum, sale) => sum + sale.total, 0))} />}<Metric label="Totale visibile" value={money(data.sales.reduce((sum, sale) => sum + sale.total, 0))} note={`${data.sales.length} movimenti`} /></div><div className="panel"><ClearableInput label="Ricerca per nominativo cliente o numero scontrino" value={query} onChange={setQuery} placeholder="Scrivi nome e cognome…" /><div className="table-wrap"><table><thead><tr><th>Data</th><th>Sede</th><th>Scontrino</th><th>Cliente</th><th>Contanti</th><th>Carta</th><th>Bonifico</th><th>Buono</th><th>Totale</th><th>Stampa</th></tr></thead><tbody>{visible.map((sale) => <tr key={sale.id} className={sale.total < 0 ? "return-row" : ""}><td>{dateTime(sale.createdAt)}</td><td>{sale.store}</td><td>{sale.receiptNo}</td><td>{sale.customerName}</td><td>{money(sale.cashAmount)}</td><td>{money(sale.cardAmount)}</td><td>{money(sale.bankAmount)}</td><td>{money(sale.giftAmount)}</td><td className={sale.total < 0 ? "negative" : ""}><b>{money(sale.total)}</b></td><td><a href={`/api/pdf?type=receipt&id=${sale.id}`}>PDF</a></td></tr>)}</tbody></table></div></div></section>;
}

function Documents({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  type DocumentLine = { key: string; productId: number | null; description: string; quantity: number; unitPrice: number; taxRate: number };
  const [type, setType] = useState("quote"); const [origin, setOrigin] = useState("Ordine"); const [paymentMethod, setPaymentMethod] = useState("cash"); const [items, setItems] = useState<DocumentLine[]>([]); const [description, setDescription] = useState(""); const [quantity, setQuantity] = useState("1"); const [price, setPrice] = useState(""); const [taxRate, setTaxRate] = useState("22"); const [customerId, setCustomerId] = useState(""); const [recipient, setRecipient] = useState({ name: "", vatNumber: "", pec: "", sdiCode: "", address: "", postalCode: "", city: "", province: "" }); const [last, setLast] = useState<{ id: number; number: string } | null>(null); const [error, setError] = useState("");
  const companyCustomers = data.customers.filter((customer) => customer.customerType === "company");
  const netTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const taxTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice * item.taxRate / 100, 0);
  function selectCustomer(value: string) { setCustomerId(value); const customer = data.customers.find((item) => item.id === Number(value)); if (customer) setRecipient({ name: customerLabel(customer), vatNumber: customer.vatNumber || customer.taxCode || "", pec: customer.pec || "", sdiCode: customer.sdiCode || "", address: customer.address || "", postalCode: customer.postalCode || "", city: customer.city || "", province: customer.province || "" }); }
  function addProduct(product: Product) { if (items.some((item) => item.productId === product.id)) return; setItems((current) => [...current, { key: keyId(), productId: product.id, description: `${product.brand ? `${product.brand} · ` : ""}${product.name} · ${product.color} ${product.size}`, quantity: 1, unitPrice: product.price, taxRate: 22 }]); }
  function addLine() { if (!description || Number(quantity) <= 0) return; setItems((current) => [...current, { key: keyId(), productId: null, description, quantity: Number(quantity), unitPrice: Number(price) || 0, taxRate: Number(taxRate) || 0 }]); setDescription(""); setQuantity("1"); setPrice(""); }
  function updateLine(key: string, change: Partial<DocumentLine>) { setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item)); }
  async function create() { setError(""); try { const result = await post("createDocument", { documentType: type, customerId: customerId || null, recipient: recipient.name, recipientVatNumber: recipient.vatNumber, recipientPec: recipient.pec, recipientSdiCode: recipient.sdiCode, recipientAddress: recipient.address, recipientPostalCode: recipient.postalCode, recipientCity: recipient.city, recipientProvince: recipient.province, origin, paymentMethod, items }); setLast({ id: result.documentId, number: result.number }); setItems([]); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  const setRecipientField = (name: keyof typeof recipient) => (value: string) => setRecipient((current) => ({ ...current, [name]: value }));
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">DOCUMENTI MULTIPRODOTTO CON IVA</p><h1>Preventivi e fatture</h1><p className="muted inventory-intro">Tutti i prezzi inseriti in questa sezione sono imponibili IVA esclusa.</p></div></div>{error && <div className="alert danger">{error}</div>}<div className="documents-layout"><div className="stack"><div className="panel"><div className="panel-title"><div><p className="eyebrow">DATI DOCUMENTO</p><h2>Destinatario</h2></div></div><div className="form-grid"><label className="field"><span>Tipo documento</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="quote">Preventivo</option><option value="invoice">Fattura</option></select></label><label className="field"><span>Origine merce</span><select value={origin} onChange={(event) => setOrigin(event.target.value)}><option>Ordine</option><option>Viterbo</option><option>Gran Sasso</option></select></label>{type === "invoice" && <label className="field"><span>Pagamento fattura</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="cash">Contanti</option><option value="bank">Bonifico bancario</option><option value="card">Carta</option></select></label>}<label className="field full"><span>Azienda dall&apos;anagrafica</span><select value={customerId} onChange={(event) => selectCustomer(event.target.value)}><option value="">Compilazione manuale</option>{companyCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.companyName} · P.IVA {customer.vatNumber}</option>)}</select></label><ClearableInput className="full" label="Ragione sociale / destinatario" value={recipient.name} onChange={setRecipientField("name")} required /><ClearableInput label="Partita IVA" value={recipient.vatNumber} onChange={setRecipientField("vatNumber")} /><ClearableInput label="PEC" value={recipient.pec} onChange={setRecipientField("pec")} /><ClearableInput label="Codice SDI" value={recipient.sdiCode} onChange={setRecipientField("sdiCode")} /><ClearableInput className="full" label="Indirizzo" value={recipient.address} onChange={setRecipientField("address")} /><ClearableInput label="CAP" value={recipient.postalCode} onChange={setRecipientField("postalCode")} /><ClearableInput label="Comune" value={recipient.city} onChange={setRecipientField("city")} /><ClearableInput label="Provincia" value={recipient.province} onChange={setRecipientField("province")} maxLength={2} /></div></div><div className="panel"><div className="panel-title"><div><p className="eyebrow">ARTICOLI</p><h2>Aggiungi più prodotti</h2></div><span className="count-pill">{items.length} righe</span></div><ProductSearch compact products={data.products} store={origin === "Gran Sasso" ? "Gran Sasso" : "Viterbo"} onAdd={addProduct} /><div className="manual-document-line"><ClearableInput label="Descrizione libera" value={description} onChange={setDescription} /><ClearableInput label="Quantità" type="number" min="1" value={quantity} onChange={setQuantity} /><ClearableInput label="Prezzo unitario IVA esclusa" type="number" min="0" step="0.01" value={price} onChange={setPrice} /><ClearableInput label="Aliquota IVA %" type="number" min="0" step="0.01" value={taxRate} onChange={setTaxRate} /><button type="button" className="secondary align-end" onClick={addLine}><MaterialIcon>add</MaterialIcon> Aggiungi riga</button></div>{items.length > 0 && <><div className="document-lines-head"><span>Articolo</span><span>Qtà</span><span>Prezzo netto</span><span>IVA %</span><span>Imponibile</span><span>Totale</span><span /></div><div className="document-lines">{items.map((item) => { const net = item.quantity * item.unitPrice; const gross = net * (1 + item.taxRate / 100); return <div className="document-line-row" key={item.key}><div className="cart-desc"><strong>{item.description}</strong><small>{item.productId ? "Prodotto di magazzino" : "Riga libera"}</small></div><ClearableInput compact aria-label="Quantità documento" type="number" min="0.01" step="0.01" value={item.quantity} onChange={(value) => updateLine(item.key, { quantity: Number(value) || 0 })} /><ClearableInput compact aria-label="Prezzo unitario netto" type="number" min="0" step="0.01" value={item.unitPrice} onChange={(value) => updateLine(item.key, { unitPrice: Number(value) || 0 })} /><ClearableInput compact aria-label="Aliquota IVA" type="number" min="0" step="0.01" value={item.taxRate} onChange={(value) => updateLine(item.key, { taxRate: Number(value) || 0 })} /><b>{money(net)}</b><b>{money(gross)}</b><button className="icon-button" onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}><MaterialIcon>close</MaterialIcon></button></div>; })}</div></>}</div></div><aside className="panel document-summary"><p className="eyebrow">RIEPILOGO</p><h2>{type === "invoice" ? "Fattura" : "Preventivo"}</h2>{type === "invoice" && <div className="document-payment-chip">Pagamento: {paymentMethod === "bank" ? "Bonifico bancario" : paymentMethod === "card" ? "Carta" : "Contanti"}</div>}<div className="total-line"><span>Imponibile</span><b>{money(netTotal)}</b></div><div className="total-line"><span>IVA</span><b>{money(taxTotal)}</b></div><div className="grand-total document-grand-total"><span>Totale</span><strong>{money(netTotal + taxTotal)}</strong></div><button className="primary full-button" disabled={!items.length || !recipient.name} onClick={create}>Genera {type === "invoice" ? "fattura" : "preventivo"} PDF</button>{last && <a className="secondary center full-button" href={`/api/pdf?type=document&id=${last.id}`}>Scarica {last.number}</a>}<div className="recent-documents"><h3>Documenti recenti</h3>{data.documents.slice(0, 12).map((document) => <div className="document-row" key={document.id}><span><strong>{document.number}</strong><small>{document.type === "invoice" ? "Fattura" : "Preventivo"} · {document.recipient}{document.type === "invoice" ? ` · ${document.paymentMethod === "bank" ? "Bonifico" : document.paymentMethod === "card" ? "Carta" : "Contanti"}` : ""}</small></span><b>{money(document.total)}</b><a href={`/api/pdf?type=document&id=${document.id}`}>PDF</a></div>)}</div></aside></div></section>;
}

function Analytics({ data }: { data: Bootstrap }) {
  const [period, setPeriod] = useState<"week" | "month" | "all">("month");
  const [brand, setBrand] = useState("Tutte");
  const [model, setModel] = useState("");
  const brands = useMemo(() => [...new Set(data.products.map((product) => product.brand).filter(Boolean))].sort((left, right) => variantCollator.compare(left, right)), [data.products]);
  const filtered = useMemo(() => {
    const now = new Date();
    const start = period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : period === "week" ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)) : null;
    const query = model.trim().toLocaleLowerCase("it");
    return (data.saleItems ?? []).filter((item) => item.itemType === "product" && (!start || new Date(item.createdAt) >= start) && (brand === "Tutte" || item.brand === brand) && (!query || `${item.productName} ${item.description}`.toLocaleLowerCase("it").includes(query)));
  }, [data.saleItems, period, brand, model]);
  function ranking(store: Store) {
    const map = new Map<string, { name: string; brand: string; quantity: number; total: number }>();
    for (const item of filtered.filter((row) => row.store === store)) {
      const key = item.variantGroup || `${item.brand}|${item.productName}`;
      const row = map.get(key) ?? { name: item.productName || item.description, brand: item.brand, quantity: 0, total: 0 };
      row.quantity += item.quantity; row.total += item.lineTotal; map.set(key, row);
    }
    return [...map.values()].sort((left, right) => right.quantity - left.quantity).slice(0, 15);
  }
  const rankings = { Viterbo: ranking("Viterbo"), "Gran Sasso": ranking("Gran Sasso") };
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">ANALISI VENDITE</p><h1>Prodotti più venduti per negozio</h1><p className="muted inventory-intro">Confronta subito Viterbo e Gran Sasso, filtrando periodo, marca e modello.</p></div></div><div className="panel analytics-filters"><label className="field"><span>Periodo</span><select value={period} onChange={(event) => setPeriod(event.target.value as "week" | "month" | "all")}><option value="week">Settimana corrente</option><option value="month">Mese corrente</option><option value="all">Tutto lo storico</option></select></label><label className="field"><span>Marca</span><select value={brand} onChange={(event) => setBrand(event.target.value)}><option>Tutte</option>{brands.map((item) => <option key={item}>{item}</option>)}</select></label><ClearableInput label="Modello / prodotto" value={model} onChange={setModel} placeholder="Cerca modello…" /></div><div className="warehouse-grid analytics-stores">{(["Viterbo", "Gran Sasso"] as Store[]).map((store) => { const rows = rankings[store]; const max = Math.max(1, ...rows.map((row) => row.quantity)); return <div className="panel" key={store}><div className="panel-title"><div><p className="eyebrow">CLASSIFICA NEGOZIO</p><h2>{store}</h2></div><span className="count-pill">{rows.reduce((sum, row) => sum + row.quantity, 0)} pezzi</span></div><div className="chart-list">{rows.length ? rows.map((row, index) => <div className="chart-row" key={`${store}-${row.brand}-${row.name}`}><span>{index + 1}</span><div><strong>{row.brand ? `${row.brand} · ` : ""}{row.name}</strong><div className="bar"><i style={{ width: `${Math.max(4, row.quantity / max * 100)}%` }} /></div></div><b>{row.quantity} pz</b><small>{money(row.total)}</small></div>) : <Empty>Nessuna vendita per i filtri selezionati.</Empty>}</div></div>; })}</div></section>;
}

function Dashboard({ data }: { data: Bootstrap }) {
  const today = new Date().toLocaleDateString("it-IT");
  const todaySales = data.sales.filter((sale) => new Date(sale.createdAt).toLocaleDateString("it-IT") === today);
  const totalFor = (sales: Sale[], store: Store) => sales.filter((sale) => sale.store === store).reduce((sum, sale) => sum + sale.total, 0);
  const storeTotals = { Viterbo: totalFor(data.sales, "Viterbo"), "Gran Sasso": totalFor(data.sales, "Gran Sasso") };
  const storeMax = Math.max(1, Math.abs(storeTotals.Viterbo), Math.abs(storeTotals["Gran Sasso"]));
  const trend = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - offset));
    const key = date.toLocaleDateString("it-IT");
    const sales = data.sales.filter((sale) => new Date(sale.createdAt).toLocaleDateString("it-IT") === key);
    return { key, label: date.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit" }), viterbo: totalFor(sales, "Viterbo"), granSasso: totalFor(sales, "Gran Sasso") };
  });
  const trendMax = Math.max(1, ...trend.flatMap((day) => [Math.abs(day.viterbo), Math.abs(day.granSasso)]));
  const soldSince = (days: number) => (data.saleItems ?? []).filter((item) => item.itemType === "product" && new Date(item.createdAt) >= new Date(Date.now() - days * 86400000));
  const last30 = soldSince(30);
  const categoryByGroup = new Map(data.products.map((product) => [product.variantGroup, product.category] as const));
  const topProducts = Object.values(last30.reduce((acc, item) => { const key = item.variantGroup || item.productName; (acc[key] ??= { name: item.productName, brand: item.brand, qty: 0, revenue: 0 }); acc[key].qty += item.quantity; acc[key].revenue += item.lineTotal; return acc; }, {} as Record<string, { name: string; brand: string; qty: number; revenue: number }>)).sort((a, b) => b.revenue - a.revenue).slice(0, 6);
  const topCategories = Object.entries(last30.reduce((acc, item) => { const cat = categoryByGroup.get(item.variantGroup) || "Senza categoria"; acc[cat] = (acc[cat] || 0) + item.lineTotal; return acc; }, {} as Record<string, number>)).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const soldIds90 = new Set(soldSince(90).map((item) => item.productId).filter(Boolean));
  const deadStock = data.products.filter((product) => (product.viterboQty + product.granSassoQty) > 0 && !soldIds90.has(product.id)).slice(0, 8);
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">DASHBOARD GENERALE · TEMPO REALE</p><h1>Buongiorno, {data.user.displayName}</h1><p className="muted inventory-intro">Vendite aggregate e confronto immediato tra Viterbo e Gran Sasso.</p></div><div className="live-chip"><i />Sincronizzazione · {today}</div></div><div className="metric-grid"><Metric label="Totale netto di oggi" value={money(todaySales.reduce((sum, sale) => sum + sale.total, 0))} note={`${todaySales.length} movimenti complessivi`} /><Metric label="Viterbo oggi" value={money(totalFor(todaySales, "Viterbo"))} note={`${todaySales.filter((sale) => sale.store === "Viterbo").length} scontrini`} /><Metric label="Gran Sasso oggi" value={money(totalFor(todaySales, "Gran Sasso"))} note={`${todaySales.filter((sale) => sale.store === "Gran Sasso").length} scontrini`} /><Metric label="Prodotti disponibili" value={String(data.products.reduce((sum, product) => sum + product.viterboQty + product.granSassoQty - product.viterboReserved - product.granSassoReserved, 0))} note="nei due negozi" /></div><div className="dashboard-charts"><div className="panel realtime-comparison"><div className="panel-title"><div><p className="eyebrow">CONFRONTO NEGOZI</p><h2>Vendite nette visibili</h2></div><span className="count-pill">{data.sales.length} movimenti</span></div>{(["Viterbo", "Gran Sasso"] as Store[]).map((store) => <div className="store-bar" key={store}><div><strong>{store}</strong><b>{money(storeTotals[store])}</b></div><div className="store-bar-track"><i className={store === "Viterbo" ? "viterbo" : "gran-sasso"} style={{ width: `${Math.max(3, Math.abs(storeTotals[store]) / storeMax * 100)}%` }} /></div></div>)}</div><div className="panel realtime-trend"><div className="panel-title"><div><p className="eyebrow">ULTIMI 7 GIORNI</p><h2>Andamento per punto vendita</h2></div><div className="chart-legend"><span><i className="viterbo" />Viterbo</span><span><i className="gran-sasso" />Gran Sasso</span></div></div><div className="trend-list">{trend.map((day) => <div className="trend-day" key={day.key}><strong>{day.label}</strong><div><span><i className="viterbo" style={{ width: `${Math.abs(day.viterbo) / trendMax * 100}%` }} /></span><small>{money(day.viterbo)}</small></div><div><span><i className="gran-sasso" style={{ width: `${Math.abs(day.granSasso) / trendMax * 100}%` }} /></span><small>{money(day.granSasso)}</small></div></div>)}</div></div></div><div className="warehouse-grid"><div className="panel"><p className="eyebrow">ULTIMI MOVIMENTI</p><h2>Vendite e resi</h2>{data.sales.slice(0, 7).map((sale) => <div className="document-row" key={sale.id}><span><strong>{sale.receiptNo}</strong><small>{sale.store} · {sale.customerName}</small></span><b className={sale.total < 0 ? "negative" : ""}>{money(sale.total)}</b></div>)}</div><div className="panel"><p className="eyebrow">ATTENZIONE</p><h2>Giacenze basse</h2>{data.products.filter((product) => product.viterboQty - product.viterboReserved <= product.viterboReorderLevel || product.granSassoQty - product.granSassoReserved <= product.granSassoReorderLevel).slice(0, 8).map((product) => <div className="document-row" key={product.id}><span><strong>{product.name}</strong><small>{product.color} · {product.size}</small></span><span className="stock-zero">VT {product.viterboQty - product.viterboReserved} · GS {product.granSassoQty - product.granSassoReserved}</span></div>)}</div></div>{(data.saleItems?.length ?? 0) > 0 && <div className="warehouse-grid dashboard-kpi"><div className="panel"><p className="eyebrow">ULTIMI 30 GIORNI</p><h2>Prodotti più venduti</h2>{topProducts.length ? topProducts.map((product) => <div className="document-row" key={`${product.brand}-${product.name}`}><span><strong>{product.brand} · {product.name}</strong><small>{product.qty} pezzi</small></span><b>{money(product.revenue)}</b></div>) : <Empty>Nessuna vendita nel periodo.</Empty>}</div><div className="panel"><p className="eyebrow">ULTIMI 30 GIORNI</p><h2>Categorie top</h2>{topCategories.length ? topCategories.map(([cat, revenue]) => <div className="document-row" key={cat}><span><strong>{cat}</strong></span><b>{money(revenue)}</b></div>) : <Empty>Nessuna vendita nel periodo.</Empty>}</div><div className="panel"><p className="eyebrow">FERMI DA 90 GIORNI</p><h2>Articoli da smaltire</h2>{deadStock.length ? deadStock.map((product) => <div className="document-row" key={product.id}><span><strong>{product.name}</strong><small>{product.color} · {product.size}</small></span><span className="stock-zero">{product.viterboQty + product.granSassoQty} pz</span></div>) : <Empty>Nessuno, ottimo!</Empty>}</div></div>}</section>;
}

const fiscalStatusLabel: Record<string, string> = {
  not_configured: "Da configurare",
  token_generated: "Chiave generata",
  disabled: "Disabilitato",
  waiting_bridge: "In attesa del ponte Windows",
  online: "Collegato",
  printing: "Stampa in corso",
  network_ready: "Rete RCH verificata",
  error: "Errore",
};

const fiscalJobLabel: Record<string, string> = {
  awaiting_setup: "Attende configurazione",
  queued: "In coda",
  processing: "In stampa",
  printed: "Stampato",
  error: "Errore",
};

function FiscalRegisters({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [revealed, setRevealed] = useState<{ store: Store; token: string } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function generate(store: Store) {
    if (!confirm(`Generare una nuova chiave per ${store}? L'eventuale ponte già configurato smetterà di collegarsi.`)) return;
    setError(""); setMessage("");
    try {
      const result = await post("regenerateFiscalToken", { store });
      setRevealed({ store, token: result.token });
      // Il ponte di questo PC tiene già aperto il canale locale: se è quello del
      // negozio giusto la chiave gli arriva da sola, senza incollarla a mano.
      // Il ponte la verifica prima di salvarla e rifiuta quelle di altri negozi.
      let consegnata = false;
      try {
        await localFiscalBridgeRequest({ action: "setDeviceToken", store, token: result.token }, 20000);
        consegnata = true;
      } catch { consegnata = false; }
      setMessage(consegnata
        ? `Chiave ${store} generata e consegnata al ponte di questo PC. Non serve incollarla da nessuna parte: attendi lo stato COLLEGATO.`
        : `Chiave ${store} generata. Il ponte di ${store} non risponde da questo PC: copiala ora e avvia il file del negozio sul PC della cassa.`);
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
  }
  async function toggle(device: FiscalDevice) {
    setError(""); setMessage("");
    try {
      await post("setFiscalDeviceEnabled", { store: device.store, enabled: !device.enabled });
      setMessage(`${device.store}: registratore ${device.enabled ? "disabilitato" : "abilitato"}.`);
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
  }
  async function retry(job: FiscalJob) {
    if (!confirm(`Rimettere in coda ${job.receiptNo}? Verifica prima che il registratore non abbia già stampato il documento.`)) return;
    setError(""); setMessage("");
    try { await post("retryFiscalJob", { jobId: job.id }); setMessage(`${job.receiptNo} rimesso in coda.`); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
  }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">AMMINISTRAZIONE</p><h1>Registratori telematici</h1><p className="muted inventory-intro">Due collegamenti indipendenti, uno per ogni PC Windows. Le vendite restano nel gestionale anche se il registratore è momentaneamente offline.</p></div></div>{message && <div className="alert success">{message}</div>}{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}{revealed && <div className="panel fiscal-secret"><div><p className="eyebrow">CHIAVE MOSTRATA UNA SOLA VOLTA · {revealed.store}</p><code>{revealed.token}</code><small>Scarica il pacchetto dello stesso negozio: durante l’installazione la chiave verrà verificata e il ponte sarà abilitato automaticamente.</small></div><button className="secondary" onClick={() => void navigator.clipboard.writeText(revealed.token)}>Copia chiave</button></div>}<div className="fiscal-device-grid">{data.fiscalDevices.map((device) => { const now = new Date(data.generatedAt).getTime(); const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0; const recent = Boolean(device.enabled && lastSeen && now - lastSeen < 15000); const online = Boolean(recent && device.lastStatus === "online"); const networkReady = Boolean(recent && device.lastStatus === "network_ready"); const jobs = data.fiscalJobs.filter((job) => job.store === device.store); return <article className="panel fiscal-device" key={device.id}><div className="panel-title"><div><p className="eyebrow">{device.store.toUpperCase()}</p><h2>{device.vendor} {device.model}</h2></div><span className={`fiscal-state ${online || networkReady ? "ready" : device.lastStatus === "error" ? "failed" : "waiting"}`}><i />{online ? "Collegato" : networkReady ? "Rete RCH verificata" : fiscalStatusLabel[device.lastStatus] ?? device.lastStatus}</span></div><dl className="fiscal-details"><div><dt>Collegamento</dt><dd>{device.connector === "epson_fpmate" ? "EpsonFpMate ufficiale" : "RCH Standard · Wi-Fi 192.168.1.210:23"}</dd></div><div><dt>Ultimo contatto</dt><dd>{device.lastSeenAt ? dateTime(device.lastSeenAt) : "Mai"}</dd></div><div><dt>Chiave ponte</dt><dd>{device.hasToken ? "Generata" : "Da generare"}</dd></div><div><dt>Stato</dt><dd>{device.enabled ? "Abilitato" : "Disabilitato"}</dd></div></dl>{device.lastError && <div className="alert danger compact-alert">{device.lastError}</div>}<div className="form-actions fiscal-actions"><button className="secondary" onClick={() => generate(device.store)}>{device.hasToken ? "Rigenera chiave" : "Genera chiave"}</button><button className={device.enabled ? "danger-button" : "primary"} onClick={() => toggle(device)} disabled={!device.hasToken && !device.enabled}>{device.enabled ? "Disabilita" : "Abilita manualmente"}</button></div>{device.connector === "rch_standard_tcp" && <p className="fine-print">Il ponte invia direttamente gli scontrini tramite Protocollo Standard RCH su 192.168.1.210:23, gestisce la chiusura =c con Opzione Fidelity attiva e conferma la stampa solo dopo l’esito positivo del registratore.</p>}{device.connector === "epson_fpmate" && <p className="fine-print">EpsonFpMate deve essere installato e collaudato sul PC Gran Sasso con reparto e pagamenti corretti.</p>}<div className="fiscal-jobs"><h3>Ultime richieste</h3>{jobs.slice(0, 6).length ? jobs.slice(0, 6).map((job) => { const stale = job.status === "processing" && job.claimedAt && now - new Date(job.claimedAt).getTime() > 120000; return <div className="fiscal-job" key={job.id}><span><strong>{job.receiptNo}</strong><small>{dateTime(job.createdAt)} · tentativi {job.attempts}</small></span><span className={`job-status ${job.status}`}>{fiscalJobLabel[job.status] ?? job.status}</span>{(["error", "awaiting_setup"].includes(job.status) || stale) && <button className="text-button" onClick={() => retry(job)}>Rimetti in coda</button>}</div>; }) : <Empty>Nessuna richiesta fiscale.</Empty>}</div></article>; })}</div><div className="panel fiscal-downloads"><div><p className="eyebrow">INSTALLAZIONE UNICA SUI PC WINDOWS</p><h2>Servizio automatico registratore RT</h2><p className="muted">Il nuovo programma verifica la chiave e abilita automaticamente il negozio durante l’installazione. Se la chiave è errata, si ferma prima di avviare il ponte.</p></div><div className="fiscal-download-actions"><a className="primary" href="/rt-bridge/Marinelli-RT-Viterbo.zip" download>Pacchetto Viterbo · RCH Wi-Fi</a><a className="primary" href="/rt-bridge/Marinelli-RT-Gran-Sasso.zip" download>Pacchetto Gran Sasso · Epson</a><a className="text-button" href="/rt-bridge/INSTALLAZIONE.txt" target="_blank" rel="noreferrer">Istruzioni per il tecnico</a></div></div><div className="panel fiscal-install-note"><strong>Installazione iniziale obbligatoria</strong><p>Per sicurezza i registratori non vengono esposti su Internet. Il tecnico installa una sola volta il collegamento locale e configura reparti IVA, pagamenti e driver ufficiali; in seguito non occorre aprire alcun programma.</p></div></section>;
}

type ActivityEntry = { id: number; createdAt: string; username: string; action: string; entity: string; entityId: number | null; detail: string; store: string | null };
const activityActionLabels: Record<string, string> = { create: "Creazione", update: "Modifica", delete: "Eliminazione", stock: "Giacenza", load: "Carico", sale: "Vendita", transfer: "Trasferimento", variant: "Variante" };
const activityEntityLabels: Record<string, string> = { product: "Prodotto", customer: "Cliente", gift: "Buono", reservation: "Prenotazione", transfer: "Trasferimento", sale: "Vendita" };
function ActivityLog() {
  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); setError(""); try { const result = await readJson(await fetch("/api/data?view=activity", { cache: "no-store" })); setRows(result.activity as ActivityEntry[]); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = rows.filter((row) => !filter || row.action === filter);
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">AMMINISTRAZIONE</p><h1>Storico attività</h1><p className="muted inventory-intro">Movimenti di magazzino e operazioni: chi ha fatto cosa e quando.</p></div><button className="secondary" onClick={() => void load()}><MaterialIcon>refresh</MaterialIcon> Aggiorna</button></div>{error && <div className="alert danger visual-alert"><MaterialIcon>warning</MaterialIcon>{error}</div>}<div className="panel"><div className="customer-type-tabs section-tabs">{([["", "Tutto"], ["stock", "Giacenze"], ["load", "Carichi"], ["sale", "Vendite"], ["transfer", "Trasferimenti"], ["delete", "Eliminazioni"]] as const).map(([id, label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div><div className="table-wrap"><table><thead><tr><th>Data e ora</th><th>Utente</th><th>Azione</th><th>Dettaglio</th><th>Negozio</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}>Caricamento…</td></tr> : visible.length ? visible.map((row) => <tr key={row.id}><td>{dateTime(row.createdAt)}</td><td>{row.username || "—"}</td><td><span className={`status ${row.action}`}>{activityActionLabels[row.action] ?? row.action}{activityEntityLabels[row.entity] ? ` · ${activityEntityLabels[row.entity]}` : ""}</span></td><td>{row.detail || "—"}</td><td>{row.store || "—"}</td></tr>) : <tr><td colSpan={5}><Empty>Nessuna attività registrata.</Empty></td></tr>}</tbody></table></div></div></section>;
}

function Settings({ reload }: { reload: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  async function reset() { if (!confirm("Confermi l'eliminazione totale di prodotti, EAN, giacenze, vendite, clienti, buoni, acconti e documenti?")) return; setError(""); try { await post("resetData", { confirmation }); setConfirmation(""); setMessage("Tutti i dati operativi sono stati eliminati. Sono rimasti gli account e le configurazioni dei registratori RT."); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); } }
  return <section className="screen"><div className="screen-head"><div><p className="eyebrow">AMMINISTRAZIONE</p><h1>Impostazioni</h1></div></div>{message && <div className="alert success">{message}</div>}{error && <div className="alert danger">{error}</div>}<div className="two-columns"><div className="panel"><p className="eyebrow">SICUREZZA ACCESSI</p><h2>Accessi e password</h2><p className="muted">Gli accessi autorizzati sono <strong>admin</strong>, <strong>viterbo</strong> e <strong>gran-sasso</strong>. Le password sono gestite da Supabase Auth e non vengono salvate nel codice del gestionale.</p><div className="firebase-account-list"><span><b>admin</b><small>Dashboard globale · entrambi i negozi</small></span><span><b>viterbo</b><small>Cassa e dati del negozio Viterbo</small></span><span><b>gran-sasso</b><small>Cassa e dati del negozio Gran Sasso</small></span></div></div><div className="panel danger-zone"><p className="eyebrow">OPERAZIONE IRREVERSIBILE</p><h2>Elimina tutto</h2><p className="muted">Elimina definitivamente prodotti, varianti EAN, giacenze, vendite, resi, clienti, buoni, prenotazioni, trasferimenti, richieste fiscali e documenti. Conserva gli account e le configurazioni hardware dei registratori RT.</p><ClearableInput label={'Scrivi “AZZERA TUTTO”'} value={confirmation} onChange={setConfirmation} /><button className="danger-button" disabled={confirmation !== "AZZERA TUTTO"} onClick={reset}>Elimina tutti i dati</button></div></div></section>;
}

const adminMenuGroups: { label: string; items: readonly (readonly [string, string, string])[] }[] = [
  { label: "", items: [["dashboard", "dashboard", "Riepilogo"]] },
  { label: "Vendite", items: [["cash", "point_of_sale", "Cassa"], ["register", "list_alt", "Registro casse"], ["reports", "summarize", "Corrispettivi"]] },
  { label: "Magazzino", items: [["warehouse", "inventory_2", "Magazzino"], ["reorder", "warning", "Da riordinare"], ["transfers", "swap_horiz", "Trasferimenti"]] },
  { label: "Anagrafiche", items: [["customers", "group", "Clienti"], ["gifts", "card_giftcard", "Buoni regalo"], ["reservations", "event_note", "Prenotazioni e acconti"]] },
  { label: "Amministrazione", items: [["documents", "receipt_long", "Fatturazione"], ["analytics", "trending_up", "Analisi vendite"], ["storico", "history", "Storico attività"], ["fiscal", "print", "Registratori RT"], ["settings", "settings", "Impostazioni"]] },
];
const cashierMenu = [["cash", "point_of_sale", "Cassa"], ["customers", "group", "Clienti"], ["inventory", "inventory_2", "Ricerca prodotti"], ["load", "add_box", "Carico prodotti"], ["register", "list_alt", "Vendite effettuate"], ["transfers", "swap_horiz", "Trasferimenti"], ["reservations", "event_note", "Acconti e ritiri"]] as const;

function ScanInfo({ data, product, onAdd }: { data: Bootstrap; product: Product; onAdd: (product: Product) => void }) {
  const group = data.products.filter((item) => (item.variantGroup || `single-${item.id}`) === (product.variantGroup || `single-${product.id}`));
  const availability = (item: Product) => ({ vt: item.viterboQty - item.viterboReserved, gs: item.granSassoQty - item.granSassoReserved });
  return <div className="scan-info">{product.photoKey && <img className="product-detail-photo" src={`/api/products?key=${encodeURIComponent(product.photoKey)}`} alt={product.name} />}<div className="scan-info-head"><p className="eyebrow">{product.category}</p><h2 className="product-detail-name">{product.brand} · {product.name}</h2><strong className="scan-info-price">{money(product.price)}</strong></div><div className="table-wrap"><table><thead><tr><th>Variante</th><th>Disponibile</th><th></th></tr></thead><tbody>{group.map((item) => { const avail = availability(item); return <tr key={item.id} className={item.id === product.id ? "scan-info-match" : ""}><td><strong>{item.color} · {item.size}</strong><small>{item.sku}</small></td><td>VT {avail.vt} · GS {avail.gs}</td><td><button className="secondary small" disabled={avail.vt <= 0 && avail.gs <= 0} onClick={() => onAdd(item)}>Aggiungi alla vendita</button></td></tr>; })}</tbody></table></div></div>;
}

function AppSkeleton() {
  return <div className="app-shell skeleton-shell" aria-hidden="true"><aside className="sidebar skel-side"><div className="sk sk-brand" />{Array.from({ length: 9 }).map((_, index) => <div key={index} className="sk sk-nav" />)}</aside><main className="app-main"><div className="sk sk-title" /><div className="sk-grid">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="sk sk-card" />)}</div><div className="sk sk-panel" /></main></div>;
}

export default function Gestionale() {
  const [user, setUser] = useState<User | null>(null); const [data, setData] = useState<Bootstrap | null>(null); const [loading, setLoading] = useState(true); const [page, setPage] = useState("dashboard"); const [menuOpen, setMenuOpen] = useState(false); const [fatal, setFatal] = useState(""); const [syncState, setSyncState] = useState<"online" | "syncing" | "offline">("syncing");
  const [scanned, setScanned] = useState<Product | null>(null); const [saleQueue, setSaleQueue] = useState<number[]>([]); const [scanNotice, setScanNotice] = useState("");
  const refreshInFlight = useRef(false);
  const reload = useCallback(async (background = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!background) setSyncState("syncing");
    try {
      const result = await readJson(await fetch("/api/data?view=bootstrap", { cache: "no-store" }));
      setData(result as Bootstrap);
      setUser((result as Bootstrap).user);
      setFatal("");
      setSyncState("online");
    } catch (reason) {
      if ((reason as { status?: number }).status === 401) {
        setUser(null);
        setData(null);
      } else {
        setSyncState("offline");
        if (!background) setFatal(reason instanceof Error ? reason.message : "Errore di caricamento.");
      }
    } finally {
      refreshInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const supabase = supabaseBrowser();
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          // Sessione Supabase persistente: ristabilisce il cookie server dopo un refresh.
          await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "supabase-login", accessToken: session.access_token }) }).catch(() => undefined);
        }
      } catch {
        // Supabase non configurato: si tenta comunque il cookie esistente.
      }
      if (!active) return;
      await reload();
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [reload]);
  useEffect(() => {
    if (!user?.id) return;
    const refreshWhenActive = () => { if (document.visibilityState === "visible") void reload(true); };
    const interval = window.setInterval(refreshWhenActive, 30000);
    window.addEventListener("focus", refreshWhenActive);
    document.addEventListener("visibilitychange", refreshWhenActive);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenActive);
      document.removeEventListener("visibilitychange", refreshWhenActive);
    };
  }, [user?.id, reload]);
  // Scansione globale: da qualsiasi schermata (tranne la Cassa, che ha il suo
  // scanner) un lettore EAN apre la scheda prodotto con "Aggiungi alla vendita".
  useEffect(() => {
    if (!user || !data || page === "cash") return;
    let buffer = ""; let last = 0;
    const onKey = (event: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const now = Date.now();
      if (now - last > 100) buffer = "";
      last = now;
      if (event.key === "Enter") {
        if (buffer.length >= 6) {
          const code = buffer; buffer = "";
          const found = data.products.find((product) => product.eans.split(",").map((value) => value.trim()).includes(code));
          if (found) { setScanned(found); setScanNotice(""); } else setScanNotice(`EAN ${code} non riconosciuto.`);
        }
        return;
      }
      if (/^[0-9]$/.test(event.key)) buffer += event.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user, data, page]);
  useEffect(() => { if (!scanNotice) return; const timer = window.setTimeout(() => setScanNotice(""), 3500); return () => window.clearTimeout(timer); }, [scanNotice]);
  const addToSale = useCallback((product: Product) => { setSaleQueue((queue) => [...queue, product.id]); setScanned(null); setScanNotice(`${product.name} ${product.color} ${product.size} aggiunto alla vendita. Vai in Cassa per incassare.`); }, []);
  async function logout() { try { await supabaseBrowser().auth.signOut(); } catch { /* Supabase non configurato (dev) */ } await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) }).catch(() => undefined); setUser(null); setData(null); setSyncState("syncing"); }
  if (loading) return <main className="loading-page"><div className="brand-mark"><img src="/ms-logo.png" alt="Logo Marinelli Stefano" /></div><p>Avvio del Gestionale…</p></main>;
  if (!user) return <Login onLogin={(nextUser) => { setUser(nextUser); setPage(nextUser.role === "admin" ? "dashboard" : "cash"); void reload(); }} />;
  if (!data) return fatal ? <main className="loading-page"><p>{fatal}</p><button className="primary" onClick={() => void reload()}>Riprova</button></main> : <AppSkeleton />;
  const navButton = ([id, icon, label]: readonly [string, string, string]) => <button key={id} className={page === id ? "active" : ""} onClick={() => { setPage(id); setMenuOpen(false); }}><MaterialIcon className="nav-icon">{icon}</MaterialIcon>{label}</button>;
  const content: Record<string, ReactNode> = { dashboard: <Dashboard data={data} />, cash: <NewCashRegister data={data} reload={reload} queue={saleQueue} onQueueConsumed={() => setSaleQueue([])} />, customers: <Customers data={data} reload={reload} />, warehouse: <Warehouse data={data} reload={reload} />, inventory: <Inventory data={data} />, reorder: <ReorderList data={data} reload={reload} />, transfers: <Transfers data={data} reload={reload} />, load: <QuickLoad data={data} reload={reload} />, documents: <Documents data={data} reload={reload} />, register: <Register data={data} />, reports: <CashReports data={data} />, gifts: <GiftSummary data={data} reload={reload} />, reservations: <ReservationSummary data={data} reload={reload} />, analytics: <Analytics data={data} />, storico: <ActivityLog />, fiscal: <FiscalRegisters data={data} reload={reload} />, settings: <Settings reload={reload} /> };
  const syncTime = new Date(data.generatedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const syncLabel = syncState === "offline" ? "Connessione assente" : syncState === "syncing" ? "Sincronizzazione…" : "Dati in tempo reale";
  return <div className="app-shell"><button className={`mobile-menu ${menuOpen ? "open" : ""}`} onClick={() => setMenuOpen((value) => !value)} aria-label={menuOpen ? "Chiudi menu" : "Apri menu"} aria-expanded={menuOpen}><MaterialIcon>{menuOpen ? "close" : "menu"}</MaterialIcon></button>{menuOpen && <button className="mobile-menu-backdrop" onClick={() => setMenuOpen(false)} aria-label="Chiudi menu" />}<aside className={`sidebar ${menuOpen ? "open" : ""}`}><div className="sidebar-brand"><div className="brand-mark small-mark"><img src="/ms-logo.png" alt="" /></div><img className="sidebar-wordmark" src="/gestionale-wordmark.png" alt="Gestionale Stefano Marinelli" /></div><nav>{user.role === "admin" ? adminMenuGroups.map((group) => <div className="nav-group" key={group.label || "top"}>{group.label && <p className="nav-group-title">{group.label}</p>}{group.items.map(navButton)}</div>) : cashierMenu.map(navButton)}</nav><button type="button" className={`sidebar-sync ${syncState}`} onClick={() => void reload()} title="Aggiorna ora"><i /><span><strong>{syncLabel}</strong><small>{syncState === "offline" ? "Clicca per riprovare" : `Aggiornato alle ${syncTime}`}</small></span></button><div className="sidebar-user"><div className="avatar">{user.displayName.slice(0, 2).toUpperCase()}</div><span><strong>{user.displayName}</strong><small>{user.store ?? "Amministrazione"}</small></span><button className="icon-button" onClick={logout} title="Esci" aria-label="Esci"><MaterialIcon>logout</MaterialIcon></button></div></aside><main className="app-main">{content[page] ?? content.cash}</main>{scanned && <Modal title="Prodotto scansionato" guard={false} onClose={() => setScanned(null)}><ScanInfo data={data} product={scanned} onAdd={addToSale} /></Modal>}{scanNotice && <div className="scan-toast" role="status">{scanNotice}{saleQueue.length > 0 && page !== "cash" && <button className="secondary small" onClick={() => { setPage("cash"); setScanNotice(""); }}>Vai in Cassa ({saleQueue.length})</button>}</div>}</div>;
}
