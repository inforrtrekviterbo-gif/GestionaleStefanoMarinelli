# Prenotazioni Fase 2 — Design

Data: 2026-09-18
Stato: approvato dall'utente.

## Obiettivo

Permettere di creare **prenotazioni dalla pagina** (non più solo dalla Cassa),
con articoli prodotto o servizio, acconto opzionale, data di consegna prevista e
**giacenza riservata**. L'incasso di acconto e saldo resta in Cassa (scontrino RT).

Fase 1 (già fatta): split del menu in Prenotazioni / Risuolature / Resi.

## Fuori scope

- Fiscale / RT, resi, buoni: invariati.
- Risuolature: restano create dalla Cassa (operazione esistente). Questa fase
  riguarda solo le **prenotazioni prodotti/servizio**.
- Nessun rimborso automatico dell'acconto (gestione manuale in Cassa).

## Decisioni (dall'utente)

1. Giacenza: **riservata** alla creazione (`inventory.reserved += qtà`), scalata
   davvero solo alla consegna.
2. Saldo/consegna: sia **pulsante in pagina** sia flusso in Cassa.
3. Acconto: **opzionale** (0 ammesso).
4. Alla consegna prodotti: la Cassa **vende gli articoli** (scarico giacenza reale)
   e il cliente paga **totale − acconto già versato**.
5. Giacenza insufficiente alla prenotazione: **permetti comunque** (reserved può
   andare in negativo, ordine da fornitore).
6. Annullo dopo acconto incassato: **libera la merce**, rimborso a mano in Cassa.
7. Acconto/saldo si incassano **in Cassa** (RT); dalla pagina non si muove denaro.

## 1. Modello dati

Tabella `reservations` (modifiche idempotenti in `ensureDatabase` + migrazione):
- `issued_sale_id` → **nullable** (era NOT NULL): la prenotazione nasce senza
  vendita; verrà valorizzata con la vendita dell'acconto.
- Nuova colonna `expected_delivery TEXT` (nullable): data consegna prevista.
- Nuova colonna `deposit_paid INTEGER NOT NULL DEFAULT 0`: 0 = acconto da
  incassare, 1 = acconto incassato.
- `redeemed_sale_id` (già esistente, nullable): vendita di consegna/saldo.

Distinzione tipo:
- **Prodotti**: la prenotazione ha righe in `reservation_items` con `product_id`.
- **Servizio**: nessun `reservation_items` con prodotto; una descrizione + importo
  totale (memorizzato in `total_price`, con una riga descrittiva senza product_id).

`kind` resta `"reservation"` per entrambe (le risuolature usano `"repair"` e non
sono toccate).

## 2. Creazione da pagina — API `createReservation`

Input (JSON): `type` ("product" | "service"), `customerId` oppure
`firstName`/`lastName` (crea il cliente se non esiste, come in Cassa),
`items` (per product: `[{productId, quantity, unitPrice}]`),
`serviceDescription` + `serviceAmount` (per service), `depositAmount` (≥0),
`expectedDelivery` (opz, "YYYY-MM-DD"), `note` (opz), `store`.

Comportamento:
- `total_price` = somma `quantity*unitPrice` (product) oppure `serviceAmount`.
- `deposit_amount` = depositAmount (0 ammesso), `balance_due` = total − deposit,
  `deposit_paid` = 0, `status` = "open", `issued_sale_id` = NULL,
  `expected_delivery` = data (o NULL).
- Codice `idCode("PRE")` (o schema esistente) + PDF con EAN già supportato
  (`type=reservation`).
- Per ogni riga prodotto: `INSERT reservation_items` + **riserva**
  `UPDATE inventory SET reserved = reserved + qtà WHERE product_id=? AND store=?`
  (nessun blocco se insufficiente).
- In modalità TEST: nessuna scrittura (guard globale già presente).
- Solo ruoli abilitati alla pagina (admin + cassieri del proprio negozio).

## 3. Aggancio pagina → Cassa

Stato "azione cassa in sospeso" nello shell (`Gestionale`), simile alla coda
scansioni ma più ricco:

```
pendingCashAction: {
  kind: "reservationDeposit" | "reservationDelivery";
  reservationId: number;
  lines: CartItem[];   // righe da precaricare nel carrello
} | null
```

Il pulsante in pagina imposta `pendingCashAction` e naviga a `page="cash"`.
La Cassa, al mount, drena `pendingCashAction`: imposta il carrello con le righe e
mostra una nota ("Incasso acconto prenotazione PRE-…" / "Consegna prenotazione
PRE-…"). Le righe portano in `metadata` `reservationId` e il ruolo.

## 4. Incasso acconto (Cassa)

Pulsante pagina **"Incassa acconto"** (solo se `deposit_amount > 0` e
`deposit_paid = 0`):
- Precarica in Cassa una riga **bloccata** `itemType: "reservation_deposit"`,
  `unitPrice = deposit_amount`, `metadata.reservationId`.
- Alla `createSale`: quando un item è `reservation_deposit`, dopo aver creato la
  vendita → `UPDATE reservations SET deposit_paid = 1, issued_sale_id = <saleId>
  WHERE id = ?`. **Nessun** movimento di magazzino per questa riga.
- Il pagamento (contanti/carta/…) e lo scontrino RT seguono il flusso normale.

## 5. Consegna / saldo (Cassa)

Pulsante pagina **"Consegna"**:
- Precarica in Cassa:
  - **Prodotti**: una riga per ogni `reservation_items` con `productId`,
    `itemType: "product"`, prezzo dalla prenotazione (o dal prodotto), quantità
    prenotata; `metadata.fromReservationId`.
  - una riga credito **"Acconto già versato"** `itemType: "reservation_credit"`,
    `unitPrice = -(deposit_amount)` (negativa) solo se `deposit_paid = 1`, bloccata,
    `metadata.reservationId`.
  - **Servizio**: una riga servizio (importo) + la riga credito acconto.
- Alla `createSale`:
  - Le righe `product` scaricano la giacenza normalmente (logica esistente).
  - Per la prenotazione collegata: `UPDATE inventory SET reserved = reserved − qtà`
    (rilascia il riservato) per ogni riga prodotto della prenotazione;
    `UPDATE reservations SET status = 'delivered', redeemed_sale_id = <saleId>
    WHERE id = ?`.
  - La riga credito riduce il totale (cliente paga total − acconto).
- Se `deposit_paid = 0` (acconto mai incassato): nessuna riga credito; il cliente
  paga il totale intero alla consegna.

## 6. Annullo (pagina) — API `cancelReservation`

- `UPDATE reservations SET status = 'cancelled' WHERE id = ?` (solo se open).
- Rilascia il riservato: per ogni riga prodotto
  `UPDATE inventory SET reserved = reserved − qtà`.
- Nessun rimborso automatico (nota all'utente: eventuale rimborso acconto in Cassa
  come reso/rimborso).

## 7. UI pagina Prenotazioni

- Pulsante **"Nuova prenotazione"** → modal:
  - Tipo: Prodotti | Servizio.
  - Cliente: campo cerca/crea (nome cognome), come in Cassa.
  - Prodotti: ricerca prodotto + righe (qtà, prezzo). Servizio: descrizione + importo.
  - Acconto (opz), Data consegna (opz), Note, Negozio.
- Tabella: codice, cliente, tipo, articoli/descrizione, totale, acconto
  (badge "da incassare"/"incassato"), saldo, consegna prevista, stato.
- Azioni per riga: **Incassa acconto** (se dovuto), **Consegna**, **Stampa PDF**,
  **Annulla** (admin), Modifica (admin, esistente).
- Ricerca già presente.

## Componenti / file coinvolti

- `lib/runtime-db.ts`: schema reservations (nullable issued_sale_id, nuove colonne)
  + ALTER idempotenti.
- `supabase/migrations/0004_reservations_phase2.sql`.
- `app/api/data/route.ts`: `createReservation`, `cancelReservation`; gestione in
  `createSale` dei nuovi itemType `reservation_deposit` e `reservation_credit` +
  rilascio riservato/aggiornamento stato alla consegna; registrazione azioni.
- `app/gestionale.tsx`: pagina Prenotazioni (modal creazione, tabella, pulsanti);
  stato `pendingCashAction` nello shell + passaggio alla Cassa; tipo `Bootstrap`
  se servono campi extra (expected_delivery, deposit_paid) nel tipo Reservation.
- `app/cash-register.tsx`: drena `pendingCashAction`, precarica carrello, gestisce
  le righe bloccate acconto/credito.

## Criteri di successo

1. Da pagina si crea una prenotazione prodotti o servizio con acconto opz e data
   consegna; la giacenza risulta riservata (reserved aumenta).
2. "Incassa acconto" apre la Cassa con l'importo pronto; completata la vendita,
   l'acconto risulta incassato (badge) e collegato allo scontrino.
3. "Consegna" apre la Cassa coi prodotti; completata la vendita, la giacenza si
   scala, il riservato si libera, la prenotazione è "consegnata" e il cliente ha
   pagato totale − acconto.
4. "Annulla" libera il riservato e chiude la prenotazione.
5. Nessun denaro si muove fuori dalla Cassa (RT).
6. `tsc` e `next build` verdi; TEST mode non scrive.
