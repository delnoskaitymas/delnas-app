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

## Dovanų kuponai

- Pirkimo puslapis: **https://delnaskaitymas.lt/dovana** (atskiras nuo programėlės — jį galima dėti į reklamas ir Instagram).
- Po apmokėjimo pirkėjas iškart mato dovanų kortelę (su QR kodu, atsisiunčiama PNG/PDF) ir gauna ją el. paštu; administratorius gauna pranešimą „Parduotas dovanų kuponas“.
- Gavėjas atidaro nuorodą `delnaskaitymas.lt/?dovana=KODAS` — programėlė veikia kaip įprastai, tik mokėjimo ekrane rodoma „Dovana nuo … — jau apmokėta“. Kodas vienkartinis, galioja 12 mėn.
- **BŪTINA:** Railway turi būti prijungtas **Volume** ir nustatytas `SHARED_STORAGE_DIR` (pvz. `/data`) — kodai saugomi faile `gift-codes.json`. Be Volume kodai dingtų po kiekvieno deploy'inimo.
- `APP_DOMAIN` turi būti tikrasis domenas (pvz. `delnaskaitymas.lt`) — iš jo sudaromos nuorodos kortelėse ir Stripe grąžinimo adresai.
- **Pinigų grąžinimas už kuponą:** Stripe Dashboard → Payments → Refund. Grąžinus pinigus kuponas automatiškai nebegalioja (tikrinama bandant jį panaudoti).
- Testuoti: Stripe test režimu atidaryk `/dovana`, mokėk kortele `4242 4242 4242 4242`.

---

## Porų suderinamumas

- Puslapis `delnaskaitymas.lt/pora`: abiejų partnerių vardai, užsakovo el. paštas, mokėjimas per Stripe Checkout (19,99 €).
- Po mokėjimo grįžtama į `/?pora=SESSION_ID`: pirmiausia vienas, tada kitas partneris nufotografuoja abu delnus, AI palygina visus 4 delnus.
- Rezultatas (suderinamumo % ir 7 skyriai) rodomas ekrane, PDF išsiunčiamas užsakovui, tau atkeliauja pranešimas „Nauja porų analizė“.
- Tą pačią nuorodą atidarius vėl — rodomas tas pats rezultatas (naujo AI kvietimo nėra).
- Užsakymai saugomi `SHARED_STORAGE_DIR/pora-orders.json` 90 dienų; nuotraukos nesaugomos.
- Kainą galima pakeisti Railway kintamuoju `PORA_PRICE_CENTS` (pvz. `1999` = 19,99 €); atskiro Stripe produkto kurti nereikia.

## Klausk savo delnų

- Blokas asmeninės analizės rezultato ekrane: mokėjimas 4,99 € per Stripe Checkout atsidaro naujame skirtuke (rezultatas lieka).
- Po mokėjimo — puslapis `delnaskaitymas.lt/klausk?s=SESSION_ID`: iki 3 klausimų, AI atsako remdamasis asmenine analize; kiekvienas atsakymas ir el. paštu, tau — pranešimas apie užsakymą.
- Užsakymai (analizės tekstas, klausimai, atsakymai) saugomi `SHARED_STORAGE_DIR/klausk-orders.json`: neapmokėti — 1 d., apmokėti — 90 d.
- Kainą galima pakeisti Railway kintamuoju `KLAUSK_PRICE_CENTS` (pvz. `499` = 4,99 €). Pakeitus kainą, atnaujink ir tekstą rezultato ekrane bei sąlygose.

## Pasiūlymas prie mokėjimo ir draugo nuoroda

- Mokėjimo ekrane langelis „Pridėti 3 asmeninius klausimus — 2,99 €“ (`KLAUSK_BUMP_CENTS`, numatyta 299). Suma visada skaičiuojama serveryje (`/order-quote`), Apple/Google Pay lange atnaujinama.
- Rezultato ekrane, jei priedas apmokėtas — „✓ Tavo 3 klausimai jau apmokėti“ (sukuriamas `kp_…` klausimų užsakymas).
- „Pakviesti draugus išbandyti“ apmokėjusiam klientui dalija asmeninę nuorodą `/?ref=KODAS`: draugas gauna −20 % (`REF_DISCOUNT_PCT`), kvietėjas už kiekvieną apmokėtą draugo pirkimą — 3 klausimus el. paštu (iki 5 kartų).
- Įrašai — `SHARED_STORAGE_DIR/refs.json` (12 mėn.).

## Įvertinimai, atsiliepimai ir statistika

- Po rezultato (asmeninio ir porų) — ⭐1–5 ir neprivalomas atsiliepimas su sutikimu rodyti viešai. Tau atkeliauja laiškas; jei atsiliepimas 4–5 ⭐ ir leista rodyti — mygtukas „✓ Rodyti šį atsiliepimą svetainėje“. Patvirtinti atsiliepimai rodomi mokėjimo ekrane (aukštesniuose telefonuose).
- Statistika be slapukų: `/admin/stats?key=ADMIN_KEY` — kiek kartų per dieną atidaryta, pradėta, pasiektas mokėjimo ekranas, apmokėta, porų/dovanų/klausimų pirkimai, įvertinimai. **Railway nustatyk kintamąjį `ADMIN_KEY`** (bet koks slaptas žodis); tikslią nuorodą rasi ir įvertinimo laiškuose.
- Mokėjimo ekrane — „👁 Pavyzdys“: vieno skyriaus pavyzdys prieš mokėjimą.

## Dovanų siuntimas ir sezonai

- /dovana: „📅 Išsiųsti gavėjui el. paštu nurodytą dieną“ — gavėjo el. paštas ir data; serveris kas valandą tikrina ir siunčia nuo 8 val. Lietuvos laiku (jei data šiandien — iškart). Pirkėjas gauna „✓ Jūsų dovana išsiųsta“.
- Nepanaudotas kuponas po 30 d. — vienas priminimas pirkėjui.
- Sezoninės temos įsijungia pačios: Valentino diena (vasario 1–14, pažymėtas porų kuponas), Motinos diena (balandžio 20 – pirmas gegužės sekmadienis), Kalėdos (gruodžio 1–24). Peržiūra: `/dovana?sezonas=valentinas|mama|kaledos`.

## Daugiau pajamų ir patogumo

- **Nebaigtas mokėjimas:** užsakymo formoje (ir /pora) — eilutė „Jei užsakymo nebaigsi, atsiųsime vieną priminimą. Nesiųsti“ (nuolaida minima tik pačiame laiške) (be varnelės; „Nesiųsti“ — atsisakymas). Jei per ~1 val. neapmokėta, išsiunčiamas vienas laiškas su kodu (galioja 24 val., ne dažniau kaip kartą per 30 d.). Laiko tarpą galima keisti kintamuoju `ABANDON_DELAY_MIN` (numatyta 60), nuolaidą — `BACK_DISCOUNT_PCT` (15).
- **Rinkinys „Asmeninė + porų“:** mokėjimo ekrane — „Pridėti porų suderinamumą“ už `PORA_BUNDLE_CENTS` (numatyta 1299 = 12,99 €). Apmokėjus — porų kuponas el. paštu ir rezultato ekrane. Tą pačią kainą asmeninės analizės pirkėjas mato ir rezultato ekrane („Jums dviem“).
- **Pasiūlymas po analizės:** rezultato ekrane „🎁 Padovanok“ — −30 % (`ONCE_DISCOUNT_PCT`) 24 val. su laikmačiu.
- **Mano analizės (/mano):** „Išsaugoti ir priminti“ rezultato ekrane išsaugo analizę (be nuotraukų, 12 mėn.). Nuoroda į visas analizes siunčiama el. paštu (7 d.), analizę galima ištrinti.
- **Kas pasikeitė per 3 mėn.:** išsaugojusiems priminimo laiške — nuoroda su −30 % (`REPEAT_DISCOUNT_PCT`, 30 d.); naujame rezultate — blokas „Kas pasikeitė“ (palyginimas su ankstesne analize).
- **Kameros užuominos:** fotografuojant rodoma „Per tamsu“, „Per šviesu“, „Laikyk telefoną ramiai“, „Įkelk visą delną“, „Ištiesk pirštus“ (skaičiuojama telefone).
- **Apple Pay / Google Pay:** jau įdiegti. Stripe → Settings → Payment methods įjunk Apple Pay ir Google Pay; Settings → Payment method domains pridėk `www.delnaskaitymas.lt` ir `delnaskaitymas.lt`.

## Pinigų srautas:
Klientas moka kortele/Google Pay/Apple Pay/Revolut Pay → Stripe → banko sąskaita (pagal Stripe atsiskaitymų grafiką, žr. Stripe Dashboard → Payouts)

## Stripe komisija:
Priklauso nuo mokėjimo metodo ir šalies — tikslius tarifus žr. **Stripe Dashboard → Balance → Payouts** arba stripe.com/pricing

---

## Pagalba:
Klausimai? Rašyk: info@delnaskaitymas.lt
