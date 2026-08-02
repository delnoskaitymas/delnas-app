# DELNAS App — Diegimo instrukcija

## Reikia sukurti paskyras (nemokamos):
1. **stripe.com** — mokėjimams
2. **railway.app** — serverio talpinimui
3. **resend.com** — el. laiškų siuntimui

---

## 1 ŽINGSNIS — Stripe paskyra

1. Eik į **stripe.com** → spausk „Start now"
2. Registruokis el. paštu
3. Patvirtink el. paštą
4. Eik į **Settings → Business details** → užpildyk duomenis
5. Eik į **Settings → Bank accounts** → pridėk savo banko sąskaitos duomenis (šio dokumento viešai nedalinama — banko duomenis suvesk tiesiai Stripe skydelyje)
6. Eik į **Developers → API keys**
7. Nukopijuok **Secret key** (prasideda `sk_live_...`) ir **Publishable key** (prasideda `pk_live_...`)

> **Pastaba:** ši sistema mokėjimus patvirtina per client-side patikrą (`/verify-payment-intent`, `/verify-payment`), o ne per Stripe Webhook maršrutą. Webhook middleware kode egzistuoja, bet šiuo metu nenaudojamas — todėl `STRIPE_WEBHOOK_SECRET` kintamojo pridėti nereikia, nebent ateityje nuspręsite pereiti prie webhook patvirtinimo.

---

## 2 ŽINGSNIS — Resend paskyra (el. laiškams)

1. Eik į **resend.com** → registruokis
2. Patvirtink savo domeną (delnaskaitymas.lt) pagal Resend instrukcijas (DNS įrašai)
3. Eik į **API Keys** → sukurk naują raktą
4. Nukopijuok API raktą (prasideda `re_...`)

---

## 3 ŽINGSNIS — Railway diegimas

1. Eik į **railway.app** → „Start a New Project" → prisijunk su GitHub
2. Spausk „Deploy from GitHub repo" → pasirink šį projekto repo
3. Kai įkelta — spausk „Settings" → „Generate Domain" → gausite URL
4. Eik į „Variables" → pridėk kintamuosius:

```
ANTHROPIC_API_KEY = sk-ant-XXXXXXXX
STRIPE_SECRET_KEY = sk_live_XXXXXXXX
STRIPE_PUBLISHABLE_KEY = pk_live_XXXXXXXX
RESEND_API_KEY = re_XXXXXXXX
EMAIL_FROM = info@delnaskaitymas.lt
APP_DOMAIN = https://TAVO-RAILWAY-URL
SHARED_STORAGE_DIR = /data
PORT = 3000
```

> **Saugumo priminimas:** niekada nedėk realių raktų, slaptažodžių ar banko duomenų į README, kodą ar public repo — visi jautrūs duomenys turi būti tik Railway „Variables" skiltyje (arba lokaliame `.env` faile, kuris **neįkeliamas** į Git — patikrink, ar `.env` įtrauktas į `.gitignore`).

5. (Neprivaloma, bet rekomenduojama) Railway projekte pridėk **Volume**, prijungtą prie `SHARED_STORAGE_DIR` kelio — kitaip failai kaip `reminders.json` ir `reminder-blacklist.json` bus ištrinami po kiekvieno naujo deploy'inimo.

---

## 4 ŽINGSNIS — Patikrink

1. Atsidaryk savo Railway URL naršyklėje
2. Bandyk mokėjimą su Stripe testavimo kortele: `4242 4242 4242 4242` (bet kokia ateities data, bet koks CVC)
3. Jei veikia — po sėkmingo mokėjimo turėtų būti rodomas rezultatų ekranas, o PDF analizė atsiųsta nurodytu el. paštu

---

## Pinigų srautas:
Klientas moka kortele/Google Pay/Apple Pay/Revolut Pay → Stripe → banko sąskaita (pagal Stripe atsiskaitymų grafiką, žr. Stripe Dashboard → Payouts)

## Stripe komisija:
Priklauso nuo mokėjimo metodo ir šalies — tikslius tarifus žr. **Stripe Dashboard → Balance → Payouts** arba stripe.com/pricing

---

## Pagalba:
Klausimai? Rašyk: info@delnaskaitymas.lt
