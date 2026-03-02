#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Thronos Commerce — Plesk Domain Setup Script
#  Εκτέλεσε αυτό στον Plesk server (SSH root) για κάθε νέο tenant/πελάτη.
#
#  ΧΡΗΣΗ:
#    chmod +x plesk-domain-setup.sh
#    ./plesk-domain-setup.sh myshop.gr info@myshop.gr "MyShop Ε.Ε."
#
#  ΠΑΡΑΜΕΤΡΟΙ:
#    $1 = domain (π.χ. myshop.gr)
#    $2 = κύριο email επικοινωνίας ιδιοκτήτη (για Plesk subscription)
#    $3 = επωνυμία πελάτη (για Plesk subscription)
# ═══════════════════════════════════════════════════════════════════════════════

set -e

DOMAIN="${1}"
OWNER_EMAIL="${2}"
OWNER_NAME="${3:-${DOMAIN} Client}"

# ── Ρυθμίσεις — ΑΛΛΑΞΕ ΑΥΤΑ ─────────────────────────────────────────────────
PLESK_SERVER_IP="YOUR_PLESK_SERVER_IP"      # IP του Plesk server σου
RAILWAY_CNAME="YOUR_APP.up.railway.app"     # CNAME που σου έδωσε το Railway
PLESK_SUBSCRIPTION_PLAN="Default Domain"    # Ονομα Plesk service plan
MAIL_PASS_PREFIX="Thr0n0s!"                 # Πρόθεμα κωδικών email (αλλάζει + domain)

# ── Επαλήθευση ───────────────────────────────────────────────────────────────
if [ -z "$DOMAIN" ] || [ -z "$OWNER_EMAIL" ]; then
  echo "ΧΡΗΣΗ: $0 <domain> <owner_email> [owner_name]"
  echo "π.χ.:  $0 myshop.gr owner@gmail.com 'MyShop ΕΕ'"
  exit 1
fi

# Κωδικός βάσει domain (μοναδικός ανά πελάτη, αλλά εσύ τους δίνεις τον τελικό)
BASE_PASS="${MAIL_PASS_PREFIX}$(echo $DOMAIN | cut -d. -f1 | tr '[:lower:]' '[:upper:]')#24"

echo "════════════════════════════════════════════"
echo "  Thronos Commerce — Plesk Setup"
echo "  Domain:  $DOMAIN"
echo "  Email:   $OWNER_EMAIL"
echo "  Πελάτης: $OWNER_NAME"
echo "════════════════════════════════════════════"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
#  1. Δημιουργία domain στο Plesk
# ═══════════════════════════════════════════════════════════════════════════════
echo "[1/4] Δημιουργία domain $DOMAIN στο Plesk..."

plesk bin domain --create "$DOMAIN" \
  -owner-login admin \
  -hosting true \
  -ip "$PLESK_SERVER_IP" \
  -www-root "httpdocs" \
  2>/dev/null || echo "  ℹ️  Domain ήδη υπάρχει — συνεχίζω."

echo "  ✓ Domain $DOMAIN στο Plesk"

# ═══════════════════════════════════════════════════════════════════════════════
#  2. DNS Records στο Plesk
# ═══════════════════════════════════════════════════════════════════════════════
echo "[2/4] Ρύθμιση DNS records..."

# Καθαρισμός τυχόν παλαιών A records για root
plesk bin dns --del "$DOMAIN" -type A -value "" 2>/dev/null || true

# Root domain → CNAME στο Railway
# (Χρησιμοποιούμε A record αν ο Plesk DNS δεν υποστηρίζει CNAME @ —
#  βάλε εδώ το Railway static IP αν έχεις, αλλιώς χρησιμοποίησε www)
plesk bin dns --add "$DOMAIN" -type A -value "$PLESK_SERVER_IP" 2>/dev/null || true

# www → Railway (CNAME)
plesk bin dns --add "$DOMAIN" -type CNAME -host "www" -value "$RAILWAY_CNAME" 2>/dev/null || true

# mail subdomain → Plesk server IP
plesk bin dns --add "$DOMAIN" -type A -host "mail" -value "$PLESK_SERVER_IP" 2>/dev/null || true

# MX record → mail.domain
plesk bin dns --add "$DOMAIN" -type MX -value "mail.$DOMAIN" -opt "10" 2>/dev/null || true

# SPF record (Plesk mail server)
plesk bin dns --add "$DOMAIN" -type TXT -value "v=spf1 ip4:$PLESK_SERVER_IP mx ~all" 2>/dev/null || true

echo "  ✓ DNS records ρυθμίστηκαν"

# ═══════════════════════════════════════════════════════════════════════════════
#  3. Mail domain + 5 email accounts
# ═══════════════════════════════════════════════════════════════════════════════
echo "[3/4] Δημιουργία 5 email accounts για $DOMAIN..."

# Ενεργοποίηση mail για το domain
plesk bin domain --update "$DOMAIN" -mail true 2>/dev/null || true

# ── Τα 5 λογαριασμοί ──────────────────────────────────────────────────────────
#
#  1. info@       — Γενικό / πελάτες
#  2. orders@     — Ειδοποιήσεις παραγγελιών (αυτό βάζει ο tenant στο admin panel)
#  3. support@    — Εξυπηρέτηση πελατών
#  4. admin@      — Εσωτερικό (ο ιδιοκτήτης)
#  5. noreply@    — Αυτόματα emails του Thronos Commerce (SMTP sender)

declare -A MAILBOXES
MAILBOXES["info"]="Πληροφορίες"
MAILBOXES["orders"]="Παραγγελίες"
MAILBOXES["support"]="Υποστήριξη"
MAILBOXES["admin"]="Διαχειριστής"
MAILBOXES["noreply"]="No Reply (Αυτόματο)"

for LOCAL in "${!MAILBOXES[@]}"; do
  FULLMAIL="${LOCAL}@${DOMAIN}"
  DESC="${MAILBOXES[$LOCAL]}"

  plesk bin mail --create "$FULLMAIL" \
    -passwd "$BASE_PASS" \
    -mailbox true \
    2>/dev/null && echo "  ✓ Δημιουργήθηκε: $FULLMAIL" \
             || echo "  ℹ️  Υπάρχει ήδη:   $FULLMAIL"
done

echo ""
echo "  📬 Τα 5 email accounts:"
echo "     info@$DOMAIN      → Γενικές πληροφορίες"
echo "     orders@$DOMAIN    → Ειδοποιήσεις παραγγελιών"
echo "     support@$DOMAIN   → Εξυπηρέτηση πελατών"
echo "     admin@$DOMAIN     → Ιδιοκτήτης / διαχειριστής"
echo "     noreply@$DOMAIN   → Αυτόματα emails καταστήματος"
echo "     Κωδικός (αρχικός): $BASE_PASS"

# ═══════════════════════════════════════════════════════════════════════════════
#  4. DKIM ενεργοποίηση
# ═══════════════════════════════════════════════════════════════════════════════
echo "[4/4] Ενεργοποίηση DKIM..."

plesk bin domain --update "$DOMAIN" -dkim_signing true 2>/dev/null || \
  echo "  ℹ️  DKIM: ρύθμισε χειροκίνητα από Plesk UI → Mail → Mail Settings → DKIM"

echo ""
echo "════════════════════════════════════════════"
echo "  ✅ ΟΛΟΚΛΗΡΩΘΗΚΕ — $DOMAIN"
echo "════════════════════════════════════════════"
echo ""
echo "  ΕΠΟΜΕΝΑ ΒΗΜΑΤΑ:"
echo ""
echo "  1. PAPAKI DNS — Βάλε αυτά τα records:"
echo "     CNAME  www  →  $RAILWAY_CNAME"
echo "     A      @    →  $PLESK_SERVER_IP  (ή CNAME αν υποστηρίζεται)"
echo "     A      mail →  $PLESK_SERVER_IP"
echo "     MX     @    →  mail.$DOMAIN  (priority 10)"
echo "     TXT    @    →  v=spf1 ip4:$PLESK_SERVER_IP mx ~all"
echo ""
echo "  2. RAILWAY — Πρόσθεσε custom domain:"
echo "     www.$DOMAIN  →  ρυθμίζεται αυτόματα από CNAME"
echo ""
echo "  3. THRONOS ROOT ADMIN:"
echo "     Δημιούργησε tenant με domain: $DOMAIN"
echo ""
echo "  4. ADMIN PANEL του πελάτη ($DOMAIN/admin):"
echo "     Notifications → Email ειδοποιήσεων: orders@$DOMAIN"
echo "     SMTP: mail.$DOMAIN | User: noreply@$DOMAIN | Pass: $BASE_PASS"
echo ""
echo "  5. DKIM record στο DNS (από Plesk UI → Mail Settings → DKIM):"
echo "     Αντέγραψε το TXT record που σου δίνει ο Plesk"
echo ""
