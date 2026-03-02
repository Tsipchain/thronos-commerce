# Οδηγός Σύνδεσης Domain — Thronos Commerce
## Για χρήση εσωτερικά (Thronos → Πελάτης)

---

## Αρχιτεκτονική συστήματος

```
Πελάτης πληκτρολογεί myshop.gr
         │
         ▼
   [Papaki DNS]
   CNAME/A → Railway
         │
         ▼
   [Railway]
   Node.js App (Thronos Commerce)
   Host: myshop.gr → φορτώνει tenant "myshop"
         │
         ▼
   [Plesk Server]
   Μόνο για email (MX)
   orders@myshop.gr, info@myshop.gr κτλ.
```

---

## ΒΗΜΑ 1 — Root Admin: Δημιουργία tenant

Πας στο `https://thronoschain.org/root` (ή όπου τρέχει το panel):

```
Tenant ID:      myshop         ← μικρά, χωρίς κενά
Domain:         myshop.gr      ← ακριβώς όπως το αγόρασε
Πακέτο:         MANAGEMENT_START
Admin password: [δυνατός κωδικός που δίνεις στον πελάτη]
```

Αποτέλεσμα: ο server αναγνωρίζει αυτόματα το `myshop.gr` και σερβίρει το κατάστημά του.

---

## ΒΗΜΑ 2 — Railway: Custom Domain

1. Άνοιξε [railway.app](https://railway.app) → Project → Service
2. **Settings → Domains → + Custom Domain**
3. Πρόσθεσε: `myshop.gr` και `www.myshop.gr`
4. Το Railway σου δίνει ένα CNAME target όπως:
   ```
   abc123xyz.up.railway.app
   ```
   **Κράτα αυτό** — θα το βάλεις στο Papaki.

---

## ΒΗΜΑ 3 — Papaki: DNS Records

Πελάτης (ή εσύ για λογαριασμό του) → **papaki.com → Domains → myshop.gr → DNS Management**

### Τα records που βάζεις:

| Τύπος | Host | Τιμή | Προτεραιότητα |
|-------|------|------|---------------|
| `CNAME` | `www` | `abc123xyz.up.railway.app` | — |
| `A` | `@` | `[Railway Static IP]` ή redirect | — |
| `A` | `mail` | `[IP Plesk Server]` | — |
| `MX` | `@` | `mail.myshop.gr` | `10` |
| `TXT` | `@` | `v=spf1 ip4:[Plesk IP] mx ~all` | — |

> **Αν το Papaki δεν επιτρέπει CNAME στο @:**
> Χρησιμοποίησε το Papaki redirect (URL redirect) από `myshop.gr` → `www.myshop.gr`
> ή ζήτα static IP από το Railway (Pro plan).

### Χρόνος διάδοσης DNS:
- Αλλαγές εντός Papaki: **15–60 λεπτά**
- Αλλαγή Nameservers: **24–48 ώρες**

---

## ΒΗΜΑ 4 — Plesk: Εκτέλεση setup script

SSH στον Plesk server και τρέξε:

```bash
cd /root/thronos-scripts
./plesk-domain-setup.sh myshop.gr owner@gmail.com "MyShop ΕΕ"
```

Αυτό δημιουργεί αυτόματα:

### Τα 5 Email Accounts

| Email | Σκοπός |
|-------|--------|
| `info@myshop.gr` | Γενικές πληροφορίες / επικοινωνία πελατών |
| `orders@myshop.gr` | **Ειδοποιήσεις παραγγελιών** (βάλε αυτό στο admin panel) |
| `support@myshop.gr` | Εξυπηρέτηση πελατών |
| `admin@myshop.gr` | Ιδιοκτήτης / εσωτερικό |
| `noreply@myshop.gr` | **SMTP sender** για αυτόματα emails Thronos |

Αρχικός κωδικός: `Thr0n0s!MYSHOP#24` (αλλάζεις μετά)

---

## ΒΗΜΑ 5 — Admin Panel πελάτη: SMTP ρύθμιση

Ο πελάτης μπαίνει στο `myshop.gr/admin` και:

**Tab: Ειδοποιήσεις**
```
Email ειδοποιήσεων παραγγελιών: orders@myshop.gr
```

**SMTP (για αποστολή email)** — βάζεις εσύ στο `.env` ή στο server:
```
THRC_SMTP_HOST=mail.myshop.gr
THRC_SMTP_USER=noreply@myshop.gr
THRC_SMTP_PASS=[κωδικός]
THRC_SMTP_PORT=587
```

---

## ΒΗΜΑ 6 — Επαλήθευση

Μετά από DNS propagation, ελέγχεις:

```bash
# DNS έχει φτάσει;
dig myshop.gr
dig www.myshop.gr
dig MX myshop.gr

# SSL certificate (Railway το βάζει αυτόματα μέσω Let's Encrypt)
curl -I https://www.myshop.gr

# Tenant resolution — το κατάστημα φορτώνει;
curl -H "Host: myshop.gr" https://YOUR_RAILWAY_URL/
```

---

## Checklist παράδοσης

- [ ] Tenant δημιουργήθηκε στο root panel με σωστό domain
- [ ] Railway: custom domain `myshop.gr` + `www.myshop.gr` προστέθηκαν
- [ ] Papaki: CNAME/A + MX + SPF records βάλθηκαν
- [ ] Plesk script εκτελέστηκε → 5 email accounts δημιουργήθηκαν
- [ ] DNS propagation ολοκληρώθηκε (έλεγχος με `dig`)
- [ ] SSL certificate ενεργό (Railway αυτόματο)
- [ ] Admin panel: email ειδοποιήσεων ρυθμίστηκε
- [ ] Test παραγγελία → email έφτασε
- [ ] Κωδικοί email παραδόθηκαν στον πελάτη

---

## Τι βλέπει ο πελάτης στο admin panel (συνδρομή)

Μόλις ενεργοποιηθεί το κατάστημα, ο πελάτης βλέπει:
- Countdown συνδρομής (ημέρες που απομένουν)
- Κουμπί ανανέωσης → Stripe πληρωμή
- Support tab για tickets προς εσάς

---

*Thronos Commerce — Internal Ops Document*
