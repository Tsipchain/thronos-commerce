# Thronos Commerce

Multi-tenant Node/Express e‑commerce demo για ThronosChain, χωρίς WordPress / WooCommerce.

## Τι περιλαμβάνει

- Multi-tenant αρχιτεκτονική με `tenants.json`
- Per-tenant φάκελοι (`data/tenants/<tenantId>/config.json`, `products.json`, `categories.json`, `media/`)
- Responsive storefront σε EJS
- Checkout με:
  - shipping & payment options ανά κατάστημα
  - υπολογισμό μεταφορικών / αντικαταβολής / gateway fee
- Admin panel:
  - Ρυθμίσεις theme (χρώματα, fonts, hero text, logo, web3 domain)
  - CRUD κατηγοριών
  - JSON editor για προϊόντα
  - Upload εικόνων (per-tenant) και έτοιμο URL για χρήση στα προϊόντα
- Hook προς ThronosChain:
  - `THRONOS_NODE_URL` + `THRONOS_COMMERCE_API_KEY`
  - κάθε παραγγελία δημιουργεί `sha256` hash και (αν υπάρχει node URL) στέλνει `POST /api/commerce/attest`

## Γρήγορη εκκίνηση (local)

```bash
npm install
npm start
```

Άνοιξε: `http://localhost:3000/`

Χρησιμοποιεί από προεπιλογή το `./data` μέσα στο project.

### Admin

- URL: `http://localhost:3000/admin`
- Κωδικός διαχειριστή (και για τους 2 tenants στο demo): **password**

Το hash είναι αποθηκευμένο στο `data/tenants.json` (`adminPasswordHash`).

## Δομή δεδομένων

- `data/tenants.json` – λίστα tenants

Παράδειγμα:

```json
[
  {
    "id": "demo",
    "domain": "demo.thronoscommerce.local",
    "supportTier": "MANAGEMENT_START",
    "adminPasswordHash": "...",
    "active": true
  }
]
```

- `data/tenants/<id>/config.json`
- `data/tenants/<id>/products.json`
- `data/tenants/<id>/categories.json`
- `data/tenants/<id>/media/` – αποθηκεύονται τα uploads

Για local dev ό,τι host και να χρησιμοποιήσεις (π.χ. `localhost`) πέφτει στον `demo` tenant.

Για production, βάλε το σωστό domain κάθε πελάτη στο `tenants.json` και κάνε point το DNS στο Railway app.

## Περιβάλλον / μεταβλητές

Προαιρετικά:

- `THRC_DATA_ROOT` – αν θες **εξωτερικό volume** (π.χ. `/data/thronos-commerce` στο Railway).  
  Αν ΔΕΝ οριστεί, χρησιμοποιείται το `./data` του project.
- `THRONOS_NODE_URL` – base URL του ThronosChain node (π.χ. `https://thronos-chain.up.railway.app`)
- `THRONOS_COMMERCE_API_KEY` – key που θα ελέγχει ο node στο `/api/commerce/attest`

Αν δεν ορίσεις `THRONOS_NODE_URL`, η παραγγελία **δεν** αποστέλλεται στο node, αλλά ο `sha256` hash εμφανίζεται στο log και στη thank-you σελίδα.

## Deployment σε Railway (απλό)

1. Σύνδεσε το repo.
2. `npm install` & `npm start` (κανονικό Node service).
3. (Προαιρετικά) πρόσθεσε volume:
   - π.χ. mount: `/data/thronos-commerce`
   - και env: `THRC_DATA_ROOT=/data/thronos-commerce`
4. Αν θες να κρατήσεις τα αρχικά demo δεδομένα στο volume, αντέγραψέ τα μία φορά μέσα στο volume (ίδια δομή με `./data`).

Μετά μπορείς να:

- χρησιμοποιήσεις `/admin` για αλλαγές theme, κατηγοριών, προϊόντων, uploads εικόνων
- δείξεις στον πελάτη το landing `/thronos-commerce` ή το ίδιο το demo shop `/`

## Tenants που περιλαμβάνονται

- `demo`
  - generic demo store για local / testing
- `fashionmm`
  - παράδειγμα setup για το fashionmm.gr με ξεχωριστό config, shipping, payment, products

Για να «κουμπώσεις» πραγματικό domain (π.χ. `fashionmm.gr`):

1. Άστο όπως είναι στο `tenants.json` (ή άλλαξέ το σε ότι domain έχεις).
2. Ρύθμισε DNS → Railway custom domain.
3. Τα requests που έρχονται με `Host: fashionmm.gr` θα παίρνουν αυτόματα τον `fashionmm` tenant.
