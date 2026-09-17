# Redesign schermata Cassa (POS) — Design

Data: 2026-09-17
Stato: approvato dall'utente, pronto per il piano di implementazione.

## Obiettivo

La schermata Cassa (`app/cash-register.tsx`, componente `NewCashRegister`) funziona
bene a livello di logica ma è debole su grafica e usabilità. Questo intervento
rifà **grafica, layout e UX** senza toccare la logica di vendita, lo scarico
magazzino, il blocco RT, la parte fiscale e i PDF.

Aggiunge inoltre due funzionalità nuove:
1. **Scanner globale**: la scansione funziona da qualsiasi punto della pagina, non
   solo con il focus sul campo EAN.
2. **Catalogo servizi ricorrenti**: nuova voce di menu admin "Servizi" con servizi
   (nome + prezzo) ricercabili in cassa.

## Fuori scope (non cambia)

- Logica di completamento vendita, calcolo totali, sconti, resi, cambi.
- Scarico magazzino **solo** alla vendita pagata (`createSale`).
- Blocco "niente scontrino senza vendita registrata".
- Registratore RT / bridge fiscale / job fiscali / documenti / PDF.
- Prenotazioni, acconti, risuolatura multiprodotto (logica invariata; cambia solo
  come si accede — dal menu Operazioni).
- Metodi di pagamento (contanti, carta, misto, buono, bonifico), resto live.

## 1. Layout ("Carrello protagonista")

Struttura desktop a due colonne dentro `.cash-grid`:

- **Barra scan** in alto, a tutta larghezza, con hint "scanner sempre attivo".
  Contiene: campo EAN/ricerca unificato + icona ricerca.
- **Colonna sinistra (larga)** `.cash-main`:
  - Barra sottile: `[👤 cliente inline] [Operazioni ▾]`.
  - **Carrello** grande e leggibile (protagonista).
- **Colonna destra (sticky)** `.checkout`:
  - Riepilogo (subtotale, sconti) → Sconto totale (€/%) → Pagamento →
    pulsante **Completa vendita** → link PDF ultimo scontrino / esito fiscale.

Responsive: sotto ~900px le colonne si impilano (checkout sotto il carrello);
stepper quantità e campi restano toccabili (target ≥40px). Il redesign deve
restare 100% responsive.

## 2. Scanner globale

- Listener globale `keydown` a livello della schermata Cassa.
- Riconoscimento "sparo scanner" tramite **velocità di battitura**: sequenza di
  tasti con intervallo molto breve (soglia ~30–50ms) terminata da `Enter`.
  Quella sequenza viene trattata come codice scansionato e instradata a `scan()`,
  **indipendentemente dall'elemento a fuoco**.
- La digitazione **manuale lenta** (es. nome cliente, ricerca prodotto, campi
  numerici) NON viene intercettata: il buffer globale si azzera se gli intervalli
  superano la soglia, così i tasti restano al campo attivo.
- Codici gestiti come oggi: prodotto (EAN), buono regalo, acconto/prenotazione.
- Il campo EAN in cima resta e continua a funzionare col focus (fallback manuale).
- Feedback: toast/nota "X aggiunto al carrello" (già presente come `notice`).

## 3. Carrello — riga prodotto

Editabilità: **opzione A** — solo Qtà e Sconto modificabili.

Layout riga (leggibile, dark elegante):
`[thumb] Nome (grande) / variante + prezzo unit. (piccolo) · [− Qtà +] · [Sconto] · [Totale grande] · [🗑]`

- **Prezzo unitario bloccato** (mostrato, non input). Lo sconto è il modo per
  abbassare il prezzo.
- **Quantità**: stepper `− N +` (più input numerico diretto per tastiera).
- **Sconto**: campo con **toggle € / %**.
  - Internamente il carrello continua a memorizzare `discountPercent`.
  - Se l'utente sceglie €, l'importo in euro viene convertito in percentuale su
    `quantity * unitPrice` e salvato come `discountPercent` (nessun cambio al
    modello dati né alle API).
  - Vincoli: sconto € non superiore all'imponibile riga; % tra 0 e 100.
- **Totale riga**: calcolato, in grassetto, ben leggibile. Niente più input
  "totale modificabile" per riga né le doppie ✕ di clear.
- Rimozione riga: un solo pulsante cestino.
- Righe speciali (`return`, `reservation_balance`, `gift`, `deposit`,
  `repair_deposit`) restano **bloccate** e mostrano il totale come testo, come oggi.

## 4. Ricerca prodotti / servizi

- Rimossa la griglia prodotti sempre visibile.
- Scrivendo nella barra in alto compare una **lista compatta** di risultati
  (prodotti disponibili nel negozio + servizi attivi del catalogo). Click →
  aggiunge al carrello.
- Match su nome, marca, colore, taglia, SKU, EAN (prodotti) e nome (servizi).
- Carrello vuoto → messaggio guida: "Spara un codice o cerca un prodotto".

## 5. Cliente inline

- Nella barra sottile: campo che **cerca mentre si digita** tra i clienti
  (cognome, nome, telefono).
- Nessun risultato → azione `➕ Crea "<testo>"`:
  - Parsing **"Nome Cognome"**: l'ultimo token è il cognome, il resto è il nome.
    (Un solo token → cognome vuoto, va in nome; il cassiere può completare dopo.)
  - Crea il cliente nel DB (privato) con nome+cognome; resto opzionale, si
    completa in seguito dalla pagina Clienti. Ordinamento DB invariato (cognome,
    nome).
  - In **modalità TEST** non scrive (coerente col resto): mostra avviso.
- Cliente associato mostrato come chip con "Rimuovi".
- **Rimosso** il tasto "Nuovo cliente" dalla striscia operazioni.

## 6. Menu "Operazioni ▾"

Raggruppa le operazioni non frequenti per ridurre il disordine. Voci:

- Buono regalo
- Varie
- Prenotazione
- Reso / Cambio
- Risuolatura (solo Viterbo) / Maglie Gran Sasso (solo Gran Sasso)

Ogni voce apre il modale esistente; la logica dei modali resta invariata.
Il menu si chiude cliccando fuori (come il menu Excel del Magazzino).

## 7. Catalogo servizi + pagina admin

- Nuova voce di menu **solo admin**: "Servizi" (gruppo Amministrazione o
  Anagrafiche).
- Pagina di gestione semplice (come un mini-magazzino senza giacenze):
  elenco servizi con **nome, prezzo, attivo**; crea / modifica / disattiva.
- Storage: nuova tabella `services (id, name, price, active, created_at)` in
  Postgres (migrazione dedicata). Nessuna giacenza, nessun EAN obbligatorio.
- I servizi **attivi** compaiono nella ricerca in cassa e si aggiungono al
  carrello come riga `itemType: "service"` (già supportato dalla vendita).
- All'inizio la lista è **vuota** (l'utente la popola quando vuole).
- **Risuolatura** resta un'operazione separata (multiprodotto, acconto, PDF con
  EAN): non entra nel catalogo servizi.

## Componenti / file coinvolti

- `app/cash-register.tsx`: riscrittura del render di `NewCashRegister` (layout,
  carrello, ricerca, cliente inline, menu Operazioni) + hook scanner globale.
  Estrarre sotto-componenti dove il file cresce troppo: `CartRow`,
  `CustomerInline`, `OperationsMenu`, `CashSearch`.
- `app/globals.css`: nuove sezioni per barra scan, carrello, stepper, chip
  cliente, menu operazioni, lista risultati.
- `app/gestionale.tsx`: nuova voce menu "Servizi" (admin) + pagina `Services`;
  eventuale riuso dei pattern del Magazzino.
- `app/api/...`: endpoint per CRUD servizi + inclusione servizi nei dati bootstrap
  della cassa.
- `supabase/migrations/`: nuova migrazione `services`.
- `lib/runtime-db.ts` / `lib/db.ts`: schema `services`, seed vuoto.

## Criteri di successo

1. Sparando un codice da qualsiasi punto della cassa il prodotto entra in carrello
   senza dover cliccare sul campo EAN.
2. Le righe del carrello sono leggibili; prezzo non modificabile; Qtà e Sconto
   (€/%) modificabili; totale calcolato.
3. Associare/creare un cliente si fa da un solo campo inline; niente tasto
   "Nuovo cliente".
4. La griglia prodotti non è più sempre a schermo; i risultati appaiono solo
   cercando.
5. Le operazioni rare sono sotto "Operazioni ▾".
6. Esiste una pagina admin "Servizi" e i servizi attivi si vendono dalla cassa.
7. Tutta la schermata resta responsive; logica di vendita/fiscale invariata;
   `tsc` e `next build` verdi.
