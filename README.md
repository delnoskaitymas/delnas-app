# DELNAS App — Diegimo instrukcija

## Reikia sukurti 2 paskyras (nemokamos):
1. **stripe.com** — mokėjimams
2. **railway.app** — serverio talpinimui

---

## 1 ŽINGSNIS — Stripe paskyra

1. Eik į **stripe.com** → spausk „Start now"
2. Registruokis el. paštu
3. Patvirtink el. paštą
4. Eik į **Settings → Business details** → užpildyk duomenis
5. Eik į **Settings → Bank accounts** → pridėk N26 IBAN: `DE17100110012945229229`
6. Eik į **Developers → API keys**
7. Nukopijuok **Secret key** (prasideda `sk_live_...`)
8. Eik į **Developers → Webhooks** → „Add endpoint"
   - URL: `https://TAVO-RAILWAY-URL/webhook` (Railway URL gausite 3 žingsnyje)
   - Events: pasirink `checkout.session.completed`
   - Nukopijuok **Signing secret** (prasideda `whsec_...`)

---

## 2 ŽINGSNIS — Gmail App Password

1. Eik į **myaccount.google.com**
2. Security → 2-Step Verification → įjunk jei dar neįjungta
3. Security → App passwords → sukurk naują → pavadink „DELNAS"
4. Nukopijuok 16 simbolių kodą (pvz. `xxxx xxxx xxxx xxxx`)

---

## 3 ŽINGSNIS — Railway diegimas

1. Eik į **railway.app** → „Start a New Project" → prisijunk su GitHub
2. Spausk „Deploy from GitHub repo" → įkelk šį projektą
   - Arba spausk „Empty project" → „Deploy" → įkelk failus
3. Kai įkelta — spausk „Settings" → „Generate Domain" → gausite URL
4. Eik į „Variables" → pridėk kintamuosius:

```
STRIPE_SECRET_KEY = sk_live_XXXXXXXX
STRIPE_WEBHOOK_SECRET = whsec_XXXXXXXX
APP_URL = https://TAVO-RAILWAY-URL
EMAIL_FROM = jurginajurginastr@gmail.com
EMAIL_PASS = xxxx xxxx xxxx xxxx
```

5. Grįžk į Stripe → Webhooks → įvesk Railway URL su `/webhook`

---

## 4 ŽINGSNIS — Patikrink

1. Atsidaryk savo Railway URL naršyklėje
2. Bandyk mokėjimą su testavimo kortele: `4242 4242 4242 4242`
3. Jei veikia — nuotraukų įkėlimas atsidarys automatiškai po mokėjimo

---

## Pinigų srautas:
Klientas moka kortele → Stripe → N26 (automatiškai kas 2 d.) 💰

## Stripe komisija:
5.00 € → gauni ~4.68 € (komisija ~0.32 €)

---

## Pagalba:
Klausimai? TikTok DM @delnas.lt
