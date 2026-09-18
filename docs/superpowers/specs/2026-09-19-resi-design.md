# Resi (reso / cambio) — Design

Data: 2026-09-19
Stato: approvato dall'utente.

## Obiettivo

Definire il flusso dei **resi/cambi**: l'articolo reso rientra a magazzino, il valore
si basa sul **prezzo pagato nello scontrino originale**, e il credito a favore del
cliente diventa **sempre un buono** (mai contanti). L'eventuale differenza a carico
del cliente si incassa con **scontrino RT**, con il reso indicato. Massimo **un reso
per scontrino**.

## Decisioni (dall'utente)

1. Valore del reso: **prezzo pagato nello scontrino originale** (non listino attuale).
2. Credito al cliente (reso puro o cambio più economico): **sempre buono**, mai contanti.
3. Intestatario del buono: **facoltativo** (cliente associato o "Buono al portatore").
4. Entrate: **due** — pagina **Resi** ("Nuovo reso") **e** Cassa → Operazioni →
   Reso/Cambio (esistente). Stessa logica.
5. Nel cambio, i **prodotti nuovi** si aggiungono **in Cassa** dopo il reso.
6. Massimo **un reso per scontrino**.

## Fuori scope

- Fiscale / RT: invariato (lo scontrino della differenza usa il flusso esistente).
- Prenotazioni, risuolature, buoni (generazione base): invariati.

## Flusso

### Entrata A — pagina Resi
- Pulsante **"Nuovo reso"** apre un mini-form:
  - Trova l'articolo reso tramite **numero scontrino** o **scan EAN** (stessa ricerca
    dell'attuale `ReturnForm`): recupera la riga e il **prezzo finale pagato**.
  - Mostra prodotto, scontrino, prezzo, quantità restituibile.
- "Procedi in cassa" → apre la **Cassa** con una **riga reso** precaricata
  (`itemType: "return"`, quantità negativa, `unitPrice = finalUnitPrice`, `locked`,
  `metadata` con lo scontrino originale), tramite `pendingCashAction`.

### Entrata B — Cassa → Operazioni → Reso/Cambio
- Resta l'attuale `ReturnForm` (invariata come entrata): stessa riga reso.

### In Cassa (comune)
- Il cassiere può aggiungere **prodotti nuovi** (cambio).
- Alla **Completa vendita**: `net = somma righe`.
  - `net > 0` → **scontrino RT** della differenza; la riga reso resta nelle righe
    (quindi lo scontrino mostra il reso).
  - `net = 0` → nessun incasso; reso registrato.
  - `net < 0` → **buono** di `|net|` (vedi sotto); nessun contante/carta.
- La merce resa **rientra a magazzino** (già gestito: `itemType "return"` fa
  `quantity += qtà` in `createSale`).
- **Un solo reso per scontrino**: la Cassa impedisce di aggiungere una seconda riga
  `return` (in entrambe le entrate).

## Backend — `createSale`

Oggi il buono residuo si genera **solo** se il reso proviene da un pagamento con
buono (`total < 0 && returnGiftCodes.size`). Nuovo comportamento:

- Se `total < -0.001` (qualsiasi reso con credito a favore del cliente):
  genera **sempre** un buono per `|total|`.
  - Se il reso proviene da un **buono** (gift-origin, caso attuale): mantiene il
    comportamento esistente — storna il buono originale e trasferisce il credito
    (saldo residuo + `|total|`) su un nuovo buono intestato allo stesso beneficiario.
  - Altrimenti (reso da contanti/carta): crea un **nuovo buono** di `|total|`,
    intestatario = nome del **cliente associato** alla vendita, oppure
    **"Buono al portatore"** se nessun cliente; **nessuna scadenza**.
- In entrambi i casi: `cash = card = bank = 0`, `giftAmount = total`,
  `giftCodeUsed = <codice nuovo buono>` (nessun rimborso in denaro).
- Il buono creato finisce in `gift_cards` (compare nella pagina **Buoni**), con
  `issued_sale_id` = la vendita del reso.

Vincolo **un reso per scontrino**: se `items` contiene più di una riga
`itemType === "return"`, ritornare errore 409 "Registra un solo reso per scontrino".
(È già di fatto vincolato al singolo scontrino originale; qui si esplicita il limite
di una riga reso.)

Il valore reso resta validato sul prezzo finale pagato (`finalUnitPrice`) come oggi.

## Pagina → Cassa

Riuso di `pendingCashAction` (già introdotto per le prenotazioni): la pagina Resi
costruisce l'azione `{ kind: "return", lines: [rigaReso] }` e naviga in Cassa, che
precarica il carrello e mostra una nota.

## Registro Resi

La pagina **Resi** resta l'elenco dei resi effettuati (già fatta) + il pulsante
**"Nuovo reso"**. Colonna/righe come oggi.

## Componenti / file

- `app/gestionale.tsx`: pagina `Returns` → aggiungere "Nuovo reso" + mini-form
  ricerca (scontrino/EAN) che costruisce la riga reso e chiama `goToCash`; passare
  `goToCash` alla voce `returns`; tipo `PendingCashAction` esteso con `kind: "return"`.
- `app/cash-register.tsx`: drenaggio `pendingAction` (già c'è) accetta anche il reso;
  blocco seconda riga `return`; la riga reso è già `locked` in `CartRow`.
- `app/api/data/route.ts`: `createSale` — generalizzare la generazione del buono
  residuo a tutti i resi con `total<0`; vincolo max 1 riga return; ricerca reso via
  `view` esistente (riuso di quanto usa `ReturnForm`).

## Criteri di successo

1. Dalla pagina Resi: scan/scontrino → prezzo pagato corretto → in Cassa arriva la
   riga reso.
2. Reso puro → completa → **buono** di valore pari al reso (in Buoni), merce rientra
   a magazzino, nessun contante.
3. Cambio con prodotto **più economico** → buono della differenza.
4. Cambio **stesso importo** → nessun incasso, reso registrato.
5. Cambio con prodotto **più caro** → scontrino RT della differenza, reso indicato.
6. Non si possono registrare due resi nello stesso scontrino.
7. Entrata da Cassa (Operazioni) funziona con la stessa logica.
8. `tsc` e `next build` verdi; TEST mode non scrive.
