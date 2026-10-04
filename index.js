// v25 — švariai perrašyta
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Laiko limitas (timeout) serverio pusės užklausoms į Claude API.
// PATAISYMAS (2026-09-26): anksčiau šie fetch() kvietimai NETURĖJO jokio
// laiko limito — jei Anthropic API atsakymas "pakimba" (užstringa dėl
// tinklo ar serverio problemos), await fetch() laukdavo AMŽINAI, niekada
// nemesdamas klaidos. Dėl to fono analizė likdavo įstrigusi statuse
// 'step2' visam laikui (klientas amžinai gaudavo "dar ruošiama"), ypač
// pasikartotinai paleidus analizę po serverio persikrovimo
// (restoreAnalysisSessionsOnStartup). Dabar kiekviena užklausa automatiškai
// nutraukiama po nurodyto laiko, kad esamas pakartotinio bandymo (retry)
// ciklas galėtų suveikti, o ne kaboti be galo.
function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Paleidimo diagnostika: jei ANTHROPIC_API_KEY nenustatytas arba akivaizdžiai
// neteisingo formato, KIEKVIENA analizė nuosekliai (ne atsitiktinai)
// žlugtų su "Tuščias Claude atsakymas" — o priežastis (blogas/trūkstamas
// raktas) liktų nematoma, kol kažkas neatidarytų Deploy Logs ir neieškotų
// giliai. Šis įrašas iškart parodo, ar raktas apskritai yra, PALEIDIMO metu.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[STARTUP KLAIDA] ANTHROPIC_API_KEY NĖRA NUSTATYTAS — VISOS delno analizės žlugs. Patikrinkite Railway aplinkos kintamuosius.');
} else if (!process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
  console.error(`[STARTUP ĮSPĖJIMAS] ANTHROPIC_API_KEY nustatytas, bet neatrodo teisingo formato (turėtų prasidėti "sk-ant-"). Ilgis: ${process.env.ANTHROPIC_API_KEY.length}`);
} else {
  console.log(`[STARTUP] ANTHROPIC_API_KEY nustatytas (${process.env.ANTHROPIC_API_KEY.slice(0,10)}...${process.env.ANTHROPIC_API_KEY.slice(-4)})`);
}

const app = express();

// --- Stripe Price ID'ai (Product catalog: "Delno skaitymo asmeninė analizė") ---
// LIVE ir TEST rėžimai Stripe'e turi VISIŠKAI ATSKIRUS Price ID'us — test
// raktu (sk_test_...) negalima pasiekti live Price objekto, ir atvirkščiai.
// Todėl Price ID'ai dabar imami iš aplinkos kintamųjų (su live reikšmėmis
// kaip numatytuoju atveju), kad testinį/gyvą režimą būtų galima perjungti
// vien per Railway "Variables", nekeičiant kodo.
//
// TEST REŽIMUI ĮJUNGTI (Railway → Variables):
//   STRIPE_SECRET_KEY       = sk_test_...
//   STRIPE_PUBLISHABLE_KEY  = pk_test_...
//   STRIPE_PRICE_ID_PROMO   = price_... (test režimo Price ID, akcinė kaina)
//   STRIPE_PRICE_ID_REGULAR = price_... (test režimo Price ID, įprasta kaina)
// (Test Price ID'us gausite Stripe Dashboard, perjungę viršuje "Test mode",
// tada Product catalog → sukurkite/pasižiūrėkite tuos pačius produktus.)
//
// GRĮŽTI Į LIVE: tiesiog ištrinkite šiuos 4 kintamuosius iš Railway
// Variables (arba įrašykite atgal sk_live_/pk_live_ ir live Price ID'us) —
// kodas automatiškai naudos numatytąsias (live) reikšmes žemiau.
const STRIPE_PRICE_ID_PROMO = process.env.STRIPE_PRICE_ID_PROMO || 'price_1TzgxjFqSjrMSpekQiJKn48d';    // atsarginė (fallback) reikšmė — TIKRINKITE, ar atitinka dabartinę akcinę kainą
const STRIPE_PRICE_ID_REGULAR = process.env.STRIPE_PRICE_ID_REGULAR || 'price_1TzgxjFqSjrMSpekJ8BSCRda'; // atsarginė (fallback) reikšmė — TIKRINKITE, ar atitinka dabartinę įprastą kainą
// ACTIVE_PRICE_ID nurodo, kuri kaina ŠIUO METU realiai taikoma checkout metu.
// Kol akcinė kaina dar nebuvo realiai taikyta bent tam tikrą laikotarpį,
// parduodame už TIKRĄ, įprastą kainą — kad vėliau, jei norėsite
// paleisti akciją su perbrauktu senesniu įprastu kainos žymėjimu, tai turėtų teisėtą, realiai
// taikytos kainos pagrindą (ES Omnibus direktyvos reikalavimas dėl nuolaidų
// atskaitos taško). Kai būsite pasiruošę pradėti akciją, pakeiskite šią
// konstantą į STRIPE_PRICE_ID_PROMO.
const ACTIVE_PRICE_ID = STRIPE_PRICE_ID_REGULAR;

// Paleidimo diagnostika: įspėja, jei Stripe rakto rėžimas (test/live)
// neatitinka to, kas įprastai tikimasi — padeda greitai pastebėti būtent
// tokią klaidą, kokią matėte anksčiau ("test mode key" vs "live" Price).
if (process.env.STRIPE_SECRET_KEY) {
  const stripeMode = process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TEST' :
                      process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'NEŽINOMAS';
  console.log(`[STARTUP] Stripe raktas nustatytas rėžimu: ${stripeMode}. Naudojami Price ID'ai: PROMO=${STRIPE_PRICE_ID_PROMO}, REGULAR=${STRIPE_PRICE_ID_REGULAR}`);
  if (stripeMode === 'TEST' && (STRIPE_PRICE_ID_PROMO.startsWith('price_1Tzgxj') || STRIPE_PRICE_ID_REGULAR.startsWith('price_1Tzgxj'))) {
    console.error('[STARTUP ĮSPĖJIMAS] STRIPE_SECRET_KEY yra TEST rėžimo, bet naudojami numatytieji (LIVE) Price ID\'ai — mokėjimai žlugs. Nustatykite STRIPE_PRICE_ID_PROMO ir STRIPE_PRICE_ID_REGULAR aplinkos kintamuosius su TEST rėžimo Price ID\'ais.');
  }
}

// Railway (kaip ir dauguma hostingų) veikia už reverse proxy, kuris prideda
// X-Forwarded-For antraštę. Be šio nustatymo, express-rate-limit meta klaidą
// "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR" ir negali teisingai atpažinti IP.
app.set('trust proxy', 1);
app.use(cors());
// --- Saugumo HTTP antraštės ---
// PASTABA: contentSecurityPolicy/crossOriginEmbedderPolicy/crossOriginResourcePolicy
// SĄMONINGAI išjungti, kad nesulaužytų esamo puslapio (jis naudoja daug inline
// <script>/<style>, bei kviečia išorinius CDN resursus — Stripe.js, cdnjs,
// MediaPipe WASM/modelį, Google Fonts). Visos KITOS helmet saugumo antraštės
// (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security ir kt.)
// lieka įjungtos ir nekeičia jokios esamos funkcijos.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));

// --- Užklausų dažnio ribojimas (Rate Limiting) jautriems endpoint'ams ---
// Apsaugo nuo botų/piktnaudžiavimo ant mokėjimo, analizės ir registracijos
// endpoint'ų. Neveikia paprasto puslapio naršymo ar statinių failų.
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min.
  max: parseInt(process.env.SENSITIVE_LIMIT || '60', 10), // iki 60 užklausų per 15 min. iš vieno IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Per daug užklausų. Bandykite dar kartą po kelių minučių.' }
});

// --- Įvedimo duomenų validavimo pagalbinės funkcijos ---
function isValidEmail(email) {
  return typeof email === 'string' && email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 100;
}
function isValidOrderNumber(orderNumber) {
  return typeof orderNumber === 'string' && /^DLN-\d{6}$/.test(orderNumber);
}
function isValidPhotosArray(photos) {
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > 4) return false;
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  return photos.every(p => p && typeof p.data === 'string' && p.data.length > 0 && p.data.length < 12_000_000 &&
    (!p.type || allowedTypes.includes(p.type)));
}
// Apsaugo nuo HTML/turinio įterpimo (injection), kai vartotojo įvestas vardas
// ar el. paštas patenka į siunčiamų el. laiškų HTML šabloną.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// SAUGUMAS: express.static žemiau pateikia VISĄ projekto aplanką. Jei
// SHARED_STORAGE_DIR nenustatytas, duomenų failai (payment-tokens.json,
// gift-codes.json, analysis-sessions/ su nuotraukomis ir kt.) guli TAME
// PAČIAME aplanke — be šio filtro juos būtų galima tiesiog atsisiųsti
// naršykle. Leidžiamas tik manifest.json (PWA).
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path || '').toLowerCase();
  if ((p.endsWith('.json') && p !== '/manifest.json') || p.startsWith('/analysis-sessions')) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(path.join(__dirname, '.'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
// PASTABA: anksčiau čia buvo "app.use('/webhook', express.raw(...))" —
// bet joks realus Stripe webhook handler'is (app.post('/webhook', ...))
// šiame faile NIEKADA nebuvo registruotas, tad ši eilutė buvo neveikiantis,
// klaidinantis "mirusio kodo" likutis. Pašalinta (2026-08). Apmokėjimo
// patvirtinimas šiuo metu vyksta per /verify-payment-intent ir
// /verify-payment, kuriuos klientas iškviečia grįžęs po apmokėjimo.
app.use(express.json({ limit: '50mb' }));

// --- Patvari saugykla (Railway Volume, jei sumontuotas) ---
// Jei SHARED_STORAGE_DIR aplinkos kintamasis nenustatytas, failai saugomi
// TIESIOG konteinerio faile ("ephemeral" Railway failų sistemoje) —
// kiekvieną kartą, kai programa iš naujo deploy'inama, šie failai
// IŠTRINAMI (reminders.json, reminder-blacklist.json).
// Kad duomenys išliktų TARP deploy'ų, Railway projekte reikia pridėti
// nuolatinį Volume (Settings → Volumes), sumontuoti jį, pvz., į "/data",
// ir nustatyti aplinkos kintamąjį SHARED_STORAGE_DIR=/data.
const SHARED_STORAGE_DIR = process.env.SHARED_STORAGE_DIR || __dirname;
// Paleidimo diagnostika: iš karto Deploy Logs parodo, ar SHARED_STORAGE_DIR
// realiai naudojamas (t.y. Railway Volume prijungtas ir kintamasis
// nustatytas), ar naudojama numatytoji (efemerinė) __dirname reikšmė.
if (process.env.SHARED_STORAGE_DIR) {
  try {
    fs.accessSync(SHARED_STORAGE_DIR, fs.constants.W_OK);
    console.log(`[STARTUP] SHARED_STORAGE_DIR nustatytas ir PASIEKIAMAS RAŠYMUI: ${SHARED_STORAGE_DIR} (Volume veikia teisingai — reminders.json, reminder-blacklist.json bus patvarūs)`);
  } catch (e) {
    console.error(`[STARTUP KLAIDA] SHARED_STORAGE_DIR nustatytas (${SHARED_STORAGE_DIR}), BET NEPASIEKIAMAS rašymui: ${e.message} — patikrinkite, ar Volume Mount Path Railway'uje tiksliai sutampa su šia reikšme.`);
  }
} else {
  console.warn(`[STARTUP ĮSPĖJIMAS] SHARED_STORAGE_DIR NENUSTATYTAS — naudojama efemerinė __dirname saugykla (${SHARED_STORAGE_DIR}). reminders.json/reminder-blacklist.json BUS IŠTRINTI kito deploy'inimo metu. Nustatykite SHARED_STORAGE_DIR aplinkos kintamąjį Railway Variables skiltyje.`);
}

// --- Priminimų saugykla ---
const REMINDERS_FILE = path.join(SHARED_STORAGE_DIR, 'reminders.json');

function loadReminders() {
  try {
    if (fs.existsSync(REMINDERS_FILE)) return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function saveReminders(reminders) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2)); } catch(e) {}
}

// --- Panaudotų užsakymo numerių saugykla (patvari, ne tik atmintyje) ---
// ANKSČIAU susidūrimo patikra generateOrderNumber() viduje tikrindavo TIK
// šiuo metu aktyvius (pendingOrders) užsakymus atmintyje — po serverio
// perkrovimo ar užsakymo užbaigimo tas pats 6 skaitmenų numeris teoriškai
// galėjo vėl pasitaikyti kitam klientui. Dabar VISI kada nors sugeneruoti
// numeriai saugomi ČIA, patvariai (Railway Volume, jei sukonfigūruota),
// tad numeris NIEKADA nebus pakartotinai priskirtas, net po daug metų ar
// daugybės serverio perkrovimų.
const USED_ORDER_NUMBERS_FILE = path.join(SHARED_STORAGE_DIR, 'used-order-numbers.json');

function loadUsedOrderNumbers() {
  try {
    if (fs.existsSync(USED_ORDER_NUMBERS_FILE)) return new Set(JSON.parse(fs.readFileSync(USED_ORDER_NUMBERS_FILE, 'utf8')));
  } catch(e) {}
  return new Set();
}

function saveUsedOrderNumbers(set) {
  try { fs.writeFileSync(USED_ORDER_NUMBERS_FILE, JSON.stringify([...set])); } catch(e) {}
}

const usedOrderNumbers = loadUsedOrderNumbers();

// --- Priminimų "nebenoriu gauti" (unsubscribe) saugykla ---
// Reikalinga pagal ES ePrivacy direktyvą (perkelta į LT Elektroninių ryšių
// įstatymą) — kiekvienas tiesioginės rinkodaros el. laiškas privalo turėti
// paprastą, nemokamą būdą atsisakyti tolimesnių tokių laiškų.
const REMINDER_BLACKLIST_FILE = path.join(SHARED_STORAGE_DIR, 'reminder-blacklist.json');

function loadReminderBlacklist() {
  try {
    if (fs.existsSync(REMINDER_BLACKLIST_FILE)) return JSON.parse(fs.readFileSync(REMINDER_BLACKLIST_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function saveReminderBlacklist(list) {
  try { fs.writeFileSync(REMINDER_BLACKLIST_FILE, JSON.stringify(list, null, 2)); } catch(e) {}
}


function isReminderBlacklisted(email) {
  const list = loadReminderBlacklist();
  return list.includes((email || '').toLowerCase());
}


// Priminimo laiškas po 3 mėn. Jei analizė buvo išsaugota — kvietimas pasidaryti naują su palyginimu ir −30 %.
function buildReminderMail(r) {
  const site = `https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}`;
  const saved = r.savedId && typeof loadSaved === 'function' ? loadSaved().items[r.savedId] : null;
  let link = site, btn = 'Nauja delnų analizė →', subtitle = 'Praėjo 3 mėnesiai nuo tavo delnų analizės';
  let body = 'Delnų linijos keičiasi kartu su tavimi. Per 3 mėnesius tavo gyvenimas pasikeitė — o su juo ir tai, ką pasakoja tavo delnai.';
  if (saved) {
    const p = createPromo({ kind: 'repeat', product: 'asmenine', pct: REPEAT_PCT, ttlMs: 30 * DAY_MS, email: r.email, key: 'repeat:' + r.savedId, meta: { savedId: r.savedId } });
    link = `${site}/?kartoti=${p.code}`;
    btn = `Pažiūrėti, kas pasikeitė — −${p.pct} % →`;
    body = `Delnų linijos keičiasi kartu su tavimi. Nufotografuok delnus iš naujo — parodysime, <b style="color:#f0d58a">kas pasikeitė</b> nuo ankstesnės analizės: jausmuose, mąstyme ir kasdienybėje. Pakartotinei analizei — <b style="color:#f0d58a">−${p.pct} %</b> (galioja 30 dienų).`;
  }
  return {
    subject: `${r.name ? ltPhrase(r.name, 'voc') + ', l' : 'L'}aikas naujam delnų skaitymui ✦`,
    html: `<div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:24px"><div style="font-size:28px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:22px;font-weight:700;color:#d4a843;margin-bottom:8px">${r.name ? escapeHtml(ltPhrase(r.name, 'voc')) + ', atėjo laikas' : 'Atėjo laikas'}</div><div style="font-size:14px;color:rgba(245,238,216,.6)">${subtitle}</div></div><div style="background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.2);border-radius:12px;padding:20px;margin-bottom:24px;font-size:14px;line-height:1.8;color:rgba(245,238,216,.85)">${body}</div><div style="text-align:center;margin-bottom:20px"><a href="${link}" style="background:linear-gradient(125deg,#fff0c4 0%,#f5d061 22%,#e0a930 45%,#c98a1f 68%,#8a5a0f 100%);color:#000000;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:800;font-size:15px;letter-spacing:.02em;display:inline-block;box-shadow:0 4px 20px rgba(212,168,67,.4)">${btn}</a></div>${saved ? `<div style="text-align:center;margin-bottom:18px;font-size:12px"><a href="${site}/mano" style="color:#d4a843">Mano analizės</a></div>` : ''}<div style="text-align:center;padding-top:16px;border-top:1px solid rgba(212,168,67,.15)"><a href="${site}/unsubscribe-reminder?email=${encodeURIComponent(r.email)}" style="color:rgba(245,238,216,.4);text-decoration:underline;font-size:11px">Nebenoriu gauti šių priminimų</a></div>${EMAIL_FOOTER_HTML}</div>`
  };
}

setInterval(async () => {
  const reminders = loadReminders();
  const now = Date.now();
  const remaining = [];
  for (const r of reminders) {
    if (now >= r.sendAt) {
      if (isReminderBlacklisted(r.email)) {
        console.log(`Priminimas praleistas (unsubscribe): ${r.email}`);
        continue; // pašalinamas iš sąrašo, laiškas nesiunčiamas
      }
      try {
        await mailer.sendMail({
          from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
          to: r.email,
          ...buildReminderMail(r)
        });
        console.log(`Priminimas išsiųstas: ${r.email}`);
      } catch(e) {
        console.error(`Priminimo klaida ${r.email}:`, e.message);
        remaining.push(r);
      }
    } else {
      remaining.push(r);
    }
  }
  if (remaining.length !== reminders.length) saveReminders(remaining);
}, 60 * 60 * 1000);

// --- Token sistema ---
const validTokens = new Map();
// Apsauga nuo pakartotinio PDF laiško siuntimo TAM PAČIAM užsakymui —
// papildomas saugiklis PRIE kliento pusės apsaugos (žr. index.html
// sendResultPdfEmail()), kuris atmintyje veikia tik kol serverio procesas
// gyvas (t.y. iki kito deploy'inimo — tai priimtina, nes šis langas
// aktualus tik trumpam, TOS PAČIOS UŽSAKYMO sesijos metu).
const sentPdfEmailsForOrder = new Set();

// --- Apmokėjimo → tokeno atitikmenų PATVARI saugykla ---
// SVARBU (saugumo/kaštų taisymas): ANKSČIAU /verify-payment-intent ir
// /verify-payment KIEKVIENĄ KARTĄ, kai buvo iškviečiami TAM PAČIAM
// paymentIntentId/session_id, sukurdavo VISIŠKAI NAUJĄ, papildomą galiojantį
// tokeną — nebuvo jokios apsaugos, kad tas pats, VIENAS apmokėjimas
// negalėtų "pagimdyti" kelių tokenų. Kadangi kiekvienas tokenas leidžia
// vieną pilną, brangią AI analizę (~11500 Claude tokenų), pakartotinis šio
// endpoint'o iškvietimas (netyčia dėl naršyklės "atgal"/perkrovimo, ar
// tyčia) reiškė nemokamą papildomą analizę už tą patį apmokėjimą.
// DABAR: kiekvienam paymentIntentId/session_id sukuriamas TIK VIENAS
// tokenas — jis įrašomas ČIA, patvarioje saugykloje (Railway Volume, jei
// sukonfigūruota), ir jei tas pats ID vėl užklausiamas, grąžinamas TAS
// PATS jau sukurtas tokenas, o ne naujas. Tai taip pat padeda, jei
// serveris persikrauna tarp apmokėjimo ir analizės — tokenas atkuriamas iš
// šios saugyklos, o ne prarandamas kartu su tik-atminties Map'u.
const PAYMENT_TOKENS_FILE = path.join(SHARED_STORAGE_DIR, 'payment-tokens.json');

function loadPaymentTokens() {
  try {
    if (fs.existsSync(PAYMENT_TOKENS_FILE)) return JSON.parse(fs.readFileSync(PAYMENT_TOKENS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function savePaymentTokens(map) {
  try { fs.writeFileSync(PAYMENT_TOKENS_FILE, JSON.stringify(map, null, 2)); } catch(e) {}
}

// Paleidimo metu išvalome pasenusius (>2h) įrašus — jų galiojimas jau
// būtų pasibaigęs, tad NEBEATKURIAME jų validTokens Map'e.
(function cleanupPaymentTokensOnStartup() {
  const map = loadPaymentTokens();
  const now = Date.now();
  let changed = false;
  for (const [id, entry] of Object.entries(map)) {
    if (now - entry.createdAt > 2 * 60 * 60 * 1000) { delete map[id]; changed = true; }
  }
  if (changed) savePaymentTokens(map);
})();

function createToken(name, email) {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.set(token, { name, email, used: false, createdAt: Date.now() });
  setTimeout(() => validTokens.delete(token), 2 * 60 * 60 * 1000);
  return token;
}

// Grąžina TĄ PATĮ tokeną, jei šis paymentId (paymentIntentId arba Checkout
// session_id) jau kartą buvo apdorotas — kitaip sukuria naują ir įrašo jį
// patvariai. `paymentId` PRIVALO būti unikalus konkrečiam apmokėjimui
// (Stripe pats garantuoja PaymentIntent/Session ID unikalumą).
function getOrCreateTokenForPayment(paymentId, name, email) {
  const map = loadPaymentTokens();
  const existing = map[paymentId];
  if (existing) {
    const remaining = (existing.createdAt + 2 * 60 * 60 * 1000) - Date.now();
    if (remaining <= 0) {
      // Retas atvejis: šis įrašas sukurtas prieš >2h (pvz. serveris veikia
      // ilgai be persikrovimo, tad paleidimo valymas jo nepagavo) — senas
      // tokenas jau būtų nebegaliojantis. Išduodame NAUJĄ, kad klientas
      // negautų "paid: true", bet realiai nenaudojamo tokeno.
      const freshToken = createToken(name, email);
      map[paymentId] = { token: freshToken, name, email, used: false, createdAt: Date.now() };
      savePaymentTokens(map);
      console.log(`[getOrCreateTokenForPayment] paymentId=${paymentId} senas tokenas pasibaigęs — išduotas NAUJAS`);
      return freshToken;
    }
    // Jei tokenas jau kadaise sukurtas šiam apmokėjimui, bet serveris
    // tarpe persikrovė (validTokens Map atsistatė tuščias) — atkuriame jį
    // atmintyje, kad /analyze-palm jį vėl pripažintų galiojančiu.
    if (!validTokens.has(existing.token)) {
      validTokens.set(existing.token, { name: existing.name, email: existing.email, used: existing.used || false, createdAt: existing.createdAt });
      setTimeout(() => validTokens.delete(existing.token), remaining);
    }
    console.log(`[getOrCreateTokenForPayment] paymentId=${paymentId} JAU TURI tokeną — grąžinamas TAS PATS (be naujo AI kvietimo galimybės padvigubinti)`);
    return existing.token;
  }
  const token = createToken(name, email);
  map[paymentId] = { token, name, email, used: false, createdAt: Date.now() };
  savePaymentTokens(map);
  console.log(`[getOrCreateTokenForPayment] paymentId=${paymentId} -> NAUJAS tokenas sukurtas ir įrašytas patvariai`);
  return token;
}

// Pažymi tokeną kaip panaudotą IR patvarioje saugykloje (ne tik atmintyje),
// kad serverio persikrovimas po analizės nepadarytų tokeno vėl "nepanaudotu".
function markPaymentTokenUsedPersistently(token) {
  const map = loadPaymentTokens();
  for (const entry of Object.values(map)) {
    if (entry.token === token) { entry.used = true; savePaymentTokens(map); return; }
  }
}

// --- Foninės analizės cache ---
// PATVARUMAS (2026-08 taisymas): anksčiau šis Map'as buvo TIK atmintyje —
// jei serveris persikraudavo TIKSLIAI tarp apmokėjimo ir analizės pabaigos,
// ta konkreti (jau APMOKĖTA) analizė būdavo negrįžtamai prarasta: klientas
// gaudavo klaidą, o serveris "užmiršdavo", kad analizė apskritai buvo
// pradėta. Dabar kiekviena sesija saugoma SAVO faile (nes gali turėti
// didelius base64 nuotraukų duomenis — atskiri failai efektyvesni už vieną
// bendrą JSON, kurį reikėtų perrašyti kaskart). Paleidimo metu VISOS dar
// negalutinės (status='pending'/'step2') sesijos automatiškai PALEIDŽIAMOS
// IŠ NAUJO — jos serverio persikrovimo metu buvo "užšalusios" pusiaukelėje
// (originalus fetch()'as į Claude API nutrūko kartu su procesu), tad vienintelis
// būdas jas užbaigti yra pradėti dar kartą.
const ANALYSIS_SESSIONS_DIR = path.join(SHARED_STORAGE_DIR, 'analysis-sessions');

function ensureAnalysisSessionsDir() {
  try { if (!fs.existsSync(ANALYSIS_SESSIONS_DIR)) fs.mkdirSync(ANALYSIS_SESSIONS_DIR, { recursive: true }); } catch(e) {}
}

function analysisSessionFilePath(sessionId) {
  // sessionId ateina iš crypto.randomUUID() arba Math.random() bazės
  // kliento pusėje — bet vis tiek saugiai išvalome bet kokius simbolius,
  // kurie netiktų failo varde (apsauga nuo path traversal).
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '');
  return path.join(ANALYSIS_SESSIONS_DIR, `${safeId}.json`);
}

function saveAnalysisSessionToDisk(sessionId, entry) {
  try {
    ensureAnalysisSessionsDir();
    fs.writeFileSync(analysisSessionFilePath(sessionId), JSON.stringify(entry));
  } catch(e) {
    console.error(`[saveAnalysisSessionToDisk] sessionId=${sessionId} klaida:`, e.message);
  }
}

function deleteAnalysisSessionFromDisk(sessionId) {
  try {
    const fp = analysisSessionFilePath(sessionId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch(e) {}
}

const analysisCache = new Map();

// Paleidimo metu: įkeliame visas dar negaliojusias (<3h) sesijas atgal į
// atmintį. Jei kuri nors buvo pusiaukelėje ('pending' arba 'step2'), tai
// reiškia, kad ANKSTESNIS procesas mirė jos NEUŽBAIGĘS — paleidžiame ją IŠ
// NAUJO fone, TIKSLIAI TAIP PAT, kaip /start-analysis endpoint'as tai daro.
(function restoreAnalysisSessionsOnStartup() {
  try {
    ensureAnalysisSessionsDir();
    const files = fs.readdirSync(ANALYSIS_SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const now = Date.now();
    let restoredCount = 0, resumedCount = 0;
    for (const file of files) {
      const sessionId = file.replace(/\.json$/, '');
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(ANALYSIS_SESSIONS_DIR, file), 'utf8'));
        if (now - entry.createdAt > 3 * 60 * 60 * 1000) {
          fs.unlinkSync(path.join(ANALYSIS_SESSIONS_DIR, file));
          continue;
        }
        analysisCache.set(sessionId, entry);
        restoredCount++;
        if (entry.status === 'pending' || entry.status === 'step2') {
          resumedCount++;
          console.log(`[restoreAnalysisSessionsOnStartup] sessionId=${sessionId} buvo statuso '${entry.status}' — PALEIDŽIAMA IŠ NAUJO fone (ankstesnis procesas mirė jos neužbaigęs)`);
          // Grąžiname statusą į 'pending' (net jei buvo 'step2') — nauja
          // runPalmAnalysis eiga pati vėl pažymės 'step2', kai iki jo
          // prieis. Fiksuojame naują sessionId lauką pačiam entry, kad
          // sekantis saveAnalysisSessionToDisk() jį rastų.
          entry.status = 'pending';
          entry.error = null;
          saveAnalysisSessionToDisk(sessionId, entry);
          runPalmAnalysis(entry.photos, entry.name || '', sessionId)
            .then(result => {
              const e = analysisCache.get(sessionId);
              if (e) { e.status = 'done'; e.result = result; saveAnalysisSessionToDisk(sessionId, e); }
            })
            .catch(err => {
              const e = analysisCache.get(sessionId);
              if (e) { e.status = 'error'; e.error = err.message; saveAnalysisSessionToDisk(sessionId, e); }
              console.log(`[restoreAnalysisSessionsOnStartup] sessionId=${sessionId} pakartotinė analizė NEPAVYKO: ${err.message}`);
            });
        }
      } catch(e) {
        console.error(`[restoreAnalysisSessionsOnStartup] sessionId=${sessionId} klaida įkeliant:`, e.message);
      }
    }
    if (restoredCount > 0) console.log(`[restoreAnalysisSessionsOnStartup] atkurta ${restoredCount} sesijų, iš jų pakartotinai paleista ${resumedCount}`);
  } catch(e) {
    console.error('[restoreAnalysisSessionsOnStartup] bendra klaida:', e.message);
  }
})();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of analysisCache.entries()) {
    if (now - entry.createdAt > 3 * 60 * 60 * 1000) { analysisCache.delete(id); deleteAnalysisSessionFromDisk(id); }
  }
}, 60 * 60 * 1000);

// --- Užsakymo numerių sistema ---
// Kai vartotojas įveda vardą + el. paštą (dar PRIEŠ mokėjimą), sugeneruojame
// vienetinį užsakymo numerį ir laikinai išsaugome vardą+el.paštą+numerį.
// Šie duomenys naudojami TIK tam, kad:
//   1) užsakymo numeris būtų parodytas rezultato ekrane;
//   2) atidarius rezultato ekraną, į info@delnaskaitymas.lt būtų
//      išsiųstas pranešimas su šio kliento vardu, el. paštu ir numeriu.
// Po to, kai šis pranešimas sėkmingai išsiunčiamas, įrašas IŠ KARTO
// ištrinamas — jo ilgiau saugoti nereikia (žr. /notify-order-complete).
// PATVARUMAS (2026-08 taisymas): anksčiau šis Map'as buvo TIK atmintyje —
// jei serveris persikraudavo TIKSLIAI tarp apmokėjimo ir rezultato ekrano
// atidarymo, įrašas dingdavo. Tai neblokuodavo paties administracinio
// laiško (sendPaymentSuccessEmails turi savo, iš Stripe metadata gautą
// atsarginį vardą/el.paštą), bet vis tiek — duomenys saugomi patvariai,
// kaip ir kitos šio failo saugyklos (priminimai, tokenai).
const PENDING_ORDERS_FILE = path.join(SHARED_STORAGE_DIR, 'pending-orders.json');

function loadPendingOrdersFromDisk() {
  try {
    if (fs.existsSync(PENDING_ORDERS_FILE)) return new Map(Object.entries(JSON.parse(fs.readFileSync(PENDING_ORDERS_FILE, 'utf8'))));
  } catch(e) {}
  return new Map();
}

function savePendingOrdersToDisk(map) {
  try { fs.writeFileSync(PENDING_ORDERS_FILE, JSON.stringify(Object.fromEntries(map), null, 2)); } catch(e) {}
}

const pendingOrders = loadPendingOrdersFromDisk();
// Paleidimo metu iškart išvalome pasenusius (>6h) įrašus, kad atkurtame
// Map'e neliktų nieko, kas jau būtų turėję būti išvalyta.
(function cleanupPendingOrdersOnStartup() {
  const now = Date.now();
  let changed = false;
  for (const [num, entry] of pendingOrders.entries()) {
    if (now - entry.createdAt > 6 * 60 * 60 * 1000) { pendingOrders.delete(num); changed = true; }
  }
  if (changed) savePendingOrdersToDisk(pendingOrders);
})();

function generateOrderNumber() {
  let num;
  do {
    num = 'DLN-' + Math.floor(100000 + Math.random() * 900000);
  } while (pendingOrders.has(num) || usedOrderNumbers.has(num));
  usedOrderNumbers.add(num);
  saveUsedOrderNumbers(usedOrderNumbers);
  return num;
}

// Iškviečiama IŠ KARTO, kai mokėjimas patvirtinamas sėkmingu (žr.
// /verify-payment-intent ir /verify-payment). SVARBU (pakeitimas): čia
// KLIENTUI laiškas NEBESIUNČIAMAS — anksčiau vartotojas gaudavo DU
// atskirus laiškus (šį, iš karto po mokėjimo, ir antrą su PDF, kai
// atsidaro rezultatų ekranas), o tekste jam net būdavo pasakoma "lauk
// antro laiško". Tai kūrė nereikalingą trintį, "email fatigue" jausmą ir
// riziką, kad vienas iš dviejų laiškų patenka į Spam. Dabar KLIENTAS gauna
// TIK VIENĄ laišką — su užsakymo patvirtinimu IR PDF failu KARTU — žr.
// /email-result-pdf žemiau, kuris išsiunčiamas, kai PDF jau paruoštas
// (atidarius rezultatų ekraną).
// Administratoriui (info@) pranešimas apie naują mokėjimą IŠLIEKA čia,
// nes tai vidinis, ne kliento gaunamas laiškas.
async function sendPaymentSuccessEmails(orderNumber, fallbackName, fallbackEmail) {
  try {
    let entry = orderNumber ? pendingOrders.get(orderNumber) : null;
    const name = (entry && entry.name) || fallbackName || '';
    const email = (entry && entry.email) || fallbackEmail || '';
    console.log(`[sendPaymentSuccessEmails] iškviesta orderNumber=${orderNumber||'(nėra)'} entryRastas=${!!entry} email=${email||'(nėra)'}`);
    if (!email) { console.log('[sendPaymentSuccessEmails] nėra el. pašto, praleidžiama'); return; }
    if (entry && entry.orderConfirmed) { console.log('[sendPaymentSuccessEmails] jau išsiųsta anksčiau, praleidžiama'); return; }
    if (entry) { entry.orderConfirmed = true; savePendingOrdersToDisk(pendingOrders); }

    const displayOrderNumber = orderNumber || '(nėra numerio)';

    // Suma gaunama TIESIOGIAI iš Stripe (ne hardcoded skaičius), kad
    // pasikeitus ACTIVE_PRICE_ID (pvz. pakeitus kainą), šis administracinis
    // laiškas VISADA rodytų teisingą, faktiškai taikomą sumą.
    let amountDisplay = 'žr. Stripe';
    try {
      const activePrice = await stripe.prices.retrieve(ACTIVE_PRICE_ID);
      amountDisplay = (activePrice.unit_amount / 100).toFixed(2).replace('.', ',') + ' €';
    } catch (priceErr) {
      console.error('[sendPaymentSuccessEmails] nepavyko gauti kainos iš Stripe:', priceErr.message);
    }

    // Administratoriui (info@) — pranešimas apie naują mokėjimą. TAI
    // VIENINTELIS administracinis laiškas apie šį užsakymą —
    // /notify-order-complete (žr. žemiau) daugiau ANTRO tokio laiško
    // NEBESIUNČIA.
    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `Naujas užsakymas #${displayOrderNumber}`,
      html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Naujas sėkmingas mokėjimas</h2><p><strong>Užsakymo numeris:</strong> ${escapeHtml(displayOrderNumber)}</p><p><strong>Klientas:</strong> ${escapeHtml(name)}</p><p><strong>El. paštas:</strong> ${escapeHtml(email)}</p><p><strong>Paslauga:</strong> Delno skaitymo asmeninė analizė</p><p><strong>Suma:</strong> ${escapeHtml(amountDisplay)}</p></div>`
    }).then(() => console.log(`[sendPaymentSuccessEmails] administratoriui išsiųsta į ${ADMIN_EMAIL}`))
      .catch(e => console.error('[sendPaymentSuccessEmails] klaida siunčiant administratoriui:', e.message));
  } catch (e) {
    console.error('[sendPaymentSuccessEmails] bendra klaida:', e.message);
  }
}

// PATAISYMAS (2026-09-26): jei APMOKĖJĘS klientas galiausiai NEGAUNA
// savo rezultato (analizė galutinai nepavyko po visų pakartotinių
// bandymų — pvz. dėl serverio gedimo, Anthropic API klaidos ar laiko
// limito), administratoriui (info@) IŠKART automatiškai išsiunčiamas
// el. laiškas su [KLAIDA] žyme temoje — kad jį būtų lengva atskirti nuo
// įprastų užsakymų patvirtinimų ir, panorėjus, susirinkti į atskirą
// pašto aplanką/filtrą pagal šią žymę.
// Atpažįsta, ar klaidos priežastis yra baigęsi/išsekę Anthropic API
// kreditai arba negaliojantis/pasibaigęs API raktas — abu atvejai KRITIŠKAI
// svarbūs, nes jie sustabdo VISŲ (ne tik vieno) klientų analizes, kol
// nepataisyta. Tokiu atveju administratoriui pateikiamas KONKRETUS,
// tikslinis sprendimas vietoj bendro "grąžink pinigus" patarimo.
function diagnozuotiKlaida(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  if (msg.includes('credit balance') || msg.includes('insufficient') || msg.includes('billing') || msg.includes('quota')) {
    return {
      pavadinimas: 'BAIGĖSI ANTHROPIC API KREDITAI',
      sprendimas: 'Eik į https://console.anthropic.com/settings/billing ir papildyk kreditus (balansą). Kol kreditų nėra, NĖ VIENAS klientas negalės gauti analizės — tai SKUBI problema.'
    };
  }
  if (msg.includes('invalid_request_error') || msg.includes('authentication_error') || msg.includes('permission_error') || msg.includes('api key') || msg.includes('api-key')) {
    return {
      pavadinimas: 'NEGALIOJANTIS ARBA NETEISINGAS API RAKTAS',
      sprendimas: 'Railway → Variables patikrink ANTHROPIC_API_KEY reikšmę — ji gali būti pasibaigusi, ištrinta ar neteisingai nukopijuota. Sugeneruok naują raktą https://console.anthropic.com/settings/keys ir įrašyk jį iš naujo.'
    };
  }
  if (msg.includes('rate_limit') || msg.includes('overloaded')) {
    return {
      pavadinimas: 'LAIKINAS ANTHROPIC API PERKROVIMAS',
      sprendimas: 'Tai paprastai laikina (Anthropic serverių apkrova) — sistema jau bandė pakartotinai automatiškai. Jei kartojasi dažnai, verta pasitikrinti API naudojimo limitus (rate limits) Anthropic Console.'
    };
  }
  return null; // nežinoma/kita priežastis — rodomas tik bendras tekstas
}

function logAnalysisFailure({ name, email, sessionId, orderNumber, errorMessage }) {
  try {
    const displayName = name ? ltPhrase(name, 'voc') : 'kliente';
    const diagnoze = diagnozuotiKlaida(errorMessage);
    // Paruoštas, kopijuoti-įklijuoti tinkantis atsiprašymo laiško juodraštis
    // klientui — kad admin neturėtų kaskart galvoti, ką parašyti.
    const apologyDraft = `Sveiki, ${displayName},

Atsiprašome — bandant paruošti jūsų asmeninę delnų analizę, mūsų sistemoje įvyko techninė klaida, ir rezultatas nebuvo sėkmingai sugeneruotas.

Jau grąžinome jums sumokėtą sumą (12,99 €) — ji turėtų pasirodyti jūsų sąskaitoje per kelias darbo dienas, priklausomai nuo jūsų banko.

Labai atsiprašome už nepatogumus. Jei norėtumėte pabandyti dar kartą, mielai jums padėsime.

Pagarbiai,
DELNAS komanda`;

    mailer.sendMail({
      from: `"Delno Skaitymas — Sistema" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: diagnoze ? `[KLAIDA] ${diagnoze.pavadinimas}` : `[KLAIDA] Klientas apmokėjo, bet negavo analizės`,
      html: `<div style="font-family:Georgia,serif;padding:20px">
        <h2 style="color:#b00020">Analizė galutinai nepavyko apmokėjusiam klientui</h2>
        <p><strong>Vardas:</strong> ${escapeHtml(name || '(nežinoma)')}</p>
        <p><strong>El. paštas:</strong> ${escapeHtml(email || '(nežinomas)')}</p>
        <p><strong>Užsakymo numeris:</strong> ${escapeHtml(orderNumber || '(nėra)')}</p>
        <p><strong>Klaidos pranešimas:</strong> ${escapeHtml(errorMessage || '(nežinoma)')}</p>
        ${diagnoze ? `<div style="background:#fff3f3;border:1px solid #f0b8b8;border-radius:8px;padding:14px 16px;margin:16px 0"><strong style="color:#b00020">Tikėtina priežastis: ${escapeHtml(diagnoze.pavadinimas)}</strong><p style="margin:8px 0 0">${escapeHtml(diagnoze.sprendimas)}</p></div>` : ''}
        <hr style="margin:20px 0;border:none;border-top:1px solid #ddd">
        <h3 style="color:#333">Ką daryti su ŠIUO klientu (2 žingsniai):</h3>
        <p><strong>1.</strong> Stripe Dashboard'e susirask šį mokėjimą (pagal el. paštą <strong>${escapeHtml(email || '')}</strong> arba apytikslį laiką) ir grąžink klientui <strong>12,99 €</strong>.</p>
        <p><strong>2.</strong> Nusiųsk klientui (${escapeHtml(email || '')}) atsiprašymo laišką — paruoštas juodraštis žemiau, gali kopijuoti ir įklijuoti tiesiai:</p>
        <div style="background:#f7f7f7;border:1px solid #ddd;border-radius:8px;padding:16px;margin-top:8px;white-space:pre-wrap;font-family:Georgia,serif;font-size:14px;color:#222">${escapeHtml(apologyDraft)}</div>
      </div>`
    }).then(() => console.log(`[logAnalysisFailure] klaidos laiškas išsiųstas į ${ADMIN_EMAIL} (orderNumber=${orderNumber||'?'}, sessionId=${sessionId||'?'})`))
      .catch(e => console.error('[logAnalysisFailure] klaida siunčiant klaidos laišką:', e.message));
  } catch (e) {
    console.error('[logAnalysisFailure] bendra klaida:', e.message);
  }
}

// Apsauginis išvalymas — jei dėl kokios nors priežasties (vartotojas
// nebaigė proceso, tinklo klaida ir pan.) /notify-order-complete niekada
// nebuvo iškviestas, įrašas vis tiek nelieka amžinai atmintyje.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [num, entry] of pendingOrders.entries()) {
    if (now - entry.createdAt > 6 * 60 * 60 * 1000) { pendingOrders.delete(num); changed = true; }
  }
  if (changed) savePendingOrdersToDisk(pendingOrders);
}, 60 * 60 * 1000);

// --- El. pašto adresų paskirtis ---
// AUTENTIFIKACIJA (prisijungimas prie SMTP serverio): info@delnaskaitymas.lt
//   — tai pagrindinė paskyra, prie kurios pririštas slaptažodis (EMAIL_USER).
//   Jei EMAIL_USER kintamasis nenustatytas, atgalinis suderinamumas su
//   senesne konfigūracija — naudojamas EMAIL_FROM.
// SIUNTĖJAS klientams (užsakymų patvirtinimai, PDF rezultatai):
//   info@delnaskaitymas.lt (EMAIL_FROM). PASTABA: anksčiau čia buvo
//   uzsakymai@delnaskaitymas.lt, bet ta pašto dėžutė buvo ištrinta Zoho
//   sistemoje — dabar viskas nukreipta į vienintelį veikiantį adresą.
// GAVĖJAS administraciniams pranešimams apie naujus mokėjimus:
//   info@delnaskaitymas.lt (ADMIN_EMAIL).
const CLIENT_EMAIL_FROM = process.env.EMAIL_FROM || 'info@delnaskaitymas.lt';
const ADMIN_EMAIL = 'info@delnaskaitymas.lt';

// Vientisas prekės ženklo įvaizdis (brand identity) — ta pati subtili
// auksinė nuoroda į svetainę pridedama VISŲ klientui siunčiamų laiškų
// apačioje, kad el. laiškas ir PDF failas jaustųsi kaip viena visuma
// (žr. buildResultPdfDoc() kliento pusėje — ten naudojama TA PATI
// auksinė spalva #d4a843 ir tas pats "delnaskaitymas.lt" paminėjimas).
const EMAIL_FOOTER_HTML = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(212,168,67,.2);text-align:center"><a href="https://www.delnaskaitymas.lt" style="color:#d4a843;text-decoration:none;font-size:12px;letter-spacing:.04em">www.delnaskaitymas.lt</a></div>`;

// ═══════════════════════════════════════════════════════════════════════
// EL. LAIŠKŲ SIUNTIMAS PER RESEND HTTP API (nebe SMTP/nodemailer)
// ═══════════════════════════════════════════════════════════════════════
// PRIEŽASTIS PAKEISTI: patikrinome realiais bandymais — visi laiškai per
// SMTP (smtp.zoho.eu, tiek 465, tiek 587 portai) KABĖDAVO be jokio
// atsakymo, kol suveikdavo laiko limitas. Tai reiškia, kad hostingas
// (Railway) blokuoja arba numeta išeinantį SMTP srautą — dažna debesijos
// platformų praktika prieš šlamštą. HTTP užklausimai (per 443 portą, kaip
// ir visi kiti šios app'os kvietimai į Stripe/Anthropic) NĖRA blokuojami,
// todėl Resend (siunčia laiškus per HTTPS API, ne SMTP) yra patikimas
// sprendimas šioje aplinkoje.
//
// BŪTINAS ŽINGSNIS PRIEŠ NAUDOJANT: Railway aplinkos kintamuosiuose turi
// būti nustatytas RESEND_API_KEY (gaunamas resend.com paskyroje), o
// domenas delnaskaitymas.lt turi būti PATVIRTINTAS (verified) Resend
// panelėje (Domains → Add Domain → pridėti jų nurodytus DNS įrašus), kad
// būtų galima siųsti iš uzsakymai@/info@delnaskaitymas.lt adresų.
async function sendEmail({ from, to, subject, html, attachments }) {
  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  };
  if (attachments && attachments.length) {
    payload.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }));
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Resend API klaida (${resp.status}): ${errText}`);
  }
  return resp.json();
}
// Suderinamumo sluoksnis — kad NEREIKĖTŲ perrašinėti kiekvieno
// mailer.sendMail({...}) iškvietimo žemiau, "mailer" objektas paliekamas
// su ta pačia .sendMail() sąsaja, bet viduje naudoja sendEmail() (Resend).
const mailer = { sendMail: (opts) => sendEmail(opts) };

// --- BENDRAS SAUGIKLIS (2026-09-26): jei serveryje įvyktų BET KOKIA kita,
// nenumatyta klaida (ne tik delnų analizėje — bet kur visame serveryje),
// kurios niekas kitas "nepagavo" — administratorius APIE TAI TAIP PAT
// sužino automatiškai, el. laišku. Be šio saugiklio, tokia klaida
// paprasčiausiai atsispindėtų tik Railway Deploy Logs, kurių niekas
// nuolat nestebi, ir administratorius apie rimtą gedimą sužinotų tik
// tada, kai (jei) kažkas parašytų skundą.
let _lastCrashEmailAt = 0;
function pranesApieServerioKlaida(pobudis, err) {
  try {
    const now = Date.now();
    // Apsauga nuo "laiškų lavinos": jei klaidos kartojasi paeiliui (pvz.
    // ciklas), siunčiame ne dažniau kaip kartą per 5 minutes.
    if (now - _lastCrashEmailAt < 5 * 60 * 1000) {
      console.error(`[pranesApieServerioKlaida] praleidžiama (per dažnai) — ${pobudis}:`, err && err.message);
      return;
    }
    _lastCrashEmailAt = now;
    const stack = (err && err.stack) ? err.stack : String(err);
    mailer.sendMail({
      from: `"Delno Skaitymas — Sistema" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `[KLAIDA] Serverio gedimas (${pobudis})`,
      html: `<div style="font-family:Georgia,serif;padding:20px">
        <h2 style="color:#b00020">Serveryje įvyko nenumatyta klaida</h2>
        <p><strong>Pobūdis:</strong> ${escapeHtml(pobudis)}</p>
        <p>Tai reiškia, kad serveryje kažkas neveikia taip, kaip turėtų — GALI paveikti visus vartotojus, ne tik vieną konkretų klientą. Rekomenduojama kuo greičiau patikrinti Railway Deploy Logs, kad įsitikintum, jog aplikacija toliau veikia normaliai.</p>
        <div style="background:#f7f7f7;border:1px solid #ddd;border-radius:8px;padding:16px;margin-top:8px;white-space:pre-wrap;font-family:monospace;font-size:12px;color:#333;max-height:400px;overflow:auto">${escapeHtml(stack).slice(0, 4000)}</div>
      </div>`
    }).catch(e => console.error('[pranesApieServerioKlaida] klaida siunčiant laišką:', e.message));
  } catch (e) {
    console.error('[pranesApieServerioKlaida] bendra klaida:', e.message);
  }
}
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  pranesApieServerioKlaida('uncaughtException — nepagauta klaida kode', err);
  // PASTABA: NEBAIGIAME proceso (process.exit) — Railway automatiškai
  // perkrautų serverį pačiu blogiausiu metu (per kliento analizę), o
  // dauguma uncaughtException atvejų šiame kode yra iš pavienių async
  // callback'ų, ne visos aplikacijos būsenos sugadinimo.
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  pranesApieServerioKlaida('unhandledRejection — nepagautas Promise atmetimas', reason instanceof Error ? reason : new Error(String(reason)));
});

// --- JSON taisymo pagalbinė funkcija ---
// PRIEŽASTIS: AI modelis generuoja JSON, kuriame ilgi laisvo teksto laukai
// (7-9 sakinių pastraipos) kartais turi NEAPSAUGOTĄ kabutės ženklą (") —
// pvz. kai tekstas cituoja frazę kabutėse — kuris sugadina JSON sintaksę
// (parseris tą kabutę palaiko eilutės PABAIGA, o po jos einantis tekstas
// tampa "netikėtu"). Tai buvo realiai stebėta gamybos serverio kluadoje:
// "Expected ',' or '}' after property value in JSON at position X".
// SPRENDIMAS: einame per simbolius po vieną, sekame ar esame JSON eilutės
// (string) viduje; radę kabutę TOS eilutės viduje, PAŽIŪRIME, kas eina po
// jos (praleidus tarpus) — jei tai NĖRA JSON struktūrinis simbolis
// (, } ] : arba teksto pabaiga), reiškia ši kabutė yra TURINIO dalis, o
// ne tikra eilutės pabaiga — tokiu atveju ją PAKEIČIAME į \" (apsaugotą).
// Taip pat apsaugome neapsaugotus naujos eilutės simbolius eilučių viduje
// (irgi negalimi grynajame JSON). Naudojama TIK kaip atsarginis variantas,
// jei įprastas JSON.parse() nepavyksta iš karto.
function repairJsonString(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        // Jau apsaugotas simbolis — kopijuojame abu kaip yra
        out += ch + (text[i + 1] || '');
        i++;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        const isRealEnd = next === ',' || next === '}' || next === ']' || next === ':' || j >= text.length;
        if (isRealEnd) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// SCHEMOS PAGRINDU VEIKIANTIS JSON TAISYMAS (patikimesnis nei aukščiau
// esantis repairJsonString)
// ═══════════════════════════════════════════════════════════════════════
// PRIEŽASTIS: repairJsonString sprendžia "ar ši kabutė yra TIKRA eilutės
// pabaiga?" pagal tai, ar po jos (praleidus tarpus) eina , } ] ar : — bet
// šis spėjimas KLYSTA, kai AI teksto VIDUJE pacituoja frazę kabutėse
// (pvz. „pasiruošę") ir po tos citatos SAKINYJE natūraliai eina kablelis
// — tai atrodo LYGIAI TAIP PAT, kaip tikra JSON eilutės pabaiga su
// kableliu po jos, todėl algoritmas KLAIDINGAI uždaro eilutę per anksti.
//
// Kadangi ŽINOME TIKSLŲ šio JSON objekto raktų sąrašą (jis visada tas
// pats, apibrėžtas prompt'e), GALIME PATIKIMIAU: surasti VISŲ žinomų
// raktų pozicijas tekste, ir VISKĄ tarp vieno rakto reikšmės pradžios ir
// kito rakto pradžios laikyti VIENU reikšmės lauku — apsaugant JAME
// esančias kabutes VISAS, nesvarbu, kas po jų eina.
const ANALYSIS_JSON_SCHEMA = [
  ['prigimtines_stiprybes', 'string'], ['prigimtines_insights', 'array'],
  ['gyvenimo_tikslas', 'string'], ['gyvenimo_insights', 'array'],
  ['santykiai', 'string'], ['santykiai_insights', 'array'],
  ['finansai', 'string'], ['finansai_insights', 'array'],
  ['pokyciai', 'string'], ['pokyciai_insights', 'array'],
  ['galimybes', 'string'], ['galimybes_insights', 'array'],
  ['stiprybes_sarasas', 'array'],
  ['klutys', 'string'], ['klutys_insights', 'array'],
  ['delnai_greta', 'object']
];

function _escapeAllQuotesInside(str) {
  // Pirma "atrišame" jau galimai apsaugotas kabutes, kad neuždvigubintume,
  // tada apsaugome VISAS — tai saugu, nes šis segmentas TURI būti vientisas
  // teksto laukas, o ne JSON struktūra.
  return str.replace(/\\"/g, '"').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function repairJsonBySchema(text) {
  const positions = [];
  for (const [key] of ANALYSIS_JSON_SCHEMA) {
    const re = new RegExp('"' + key + '"\\s*:', 'g');
    const m = re.exec(text);
    if (m) positions.push({ key, matchEnd: m.index + m[0].length });
  }
  if (positions.length === 0) return null; // nė vieno žinomo rakto nerasta — negalime taisyti šiuo būdu
  positions.sort((a, b) => a.matchEnd - b.matchEnd);

  const typeByKey = Object.fromEntries(ANALYSIS_JSON_SCHEMA);
  let result = '{';
  for (let idx = 0; idx < positions.length; idx++) {
    const cur = positions[idx];
    const segmentEnd = idx + 1 < positions.length ? text.lastIndexOf('"' + positions[idx + 1].key + '"', positions[idx + 1].matchEnd) : text.length;
    let raw = text.slice(cur.matchEnd, segmentEnd).trim();
    raw = raw.replace(/,\s*$/, ''); // nuimame galinį kablelį, pridėsime patys

    let fixedValue;
    if (typeByKey[cur.key] === 'array') {
      // Masyvo elementai — trumpos frazės, žymiai mažesnė rizika, kad
      // viduje bus pašalinių kabučių, todėl saugu naudoti paprastesnį
      // (char-by-char) taisymą TIK šiam segmentui.
      let arrInner = raw;
      if (!arrInner.startsWith('[')) arrInner = '[' + arrInner;
      if (!arrInner.trim().endsWith(']')) arrInner = arrInner + ']';
      try {
        fixedValue = JSON.stringify(JSON.parse(arrInner));
      } catch (e) {
        try {
          fixedValue = JSON.stringify(JSON.parse(repairJsonString(arrInner)));
        } catch (e2) {
          fixedValue = '[]';
        }
      }
    } else if (typeByKey[cur.key] === 'object') {
      // Objektas (pvz. delnai_greta) — jei jis paskutinis, segmente lieka ir
      // viso JSON uždaromasis „}“, todėl bandome ir be jo.
      const cands = [raw, raw.replace(/\}\s*$/, '')];
      let val = null;
      for (const c of cands) { if (val) break; try { val = JSON.parse(c); } catch (e) {} }
      for (const c of cands) { if (val) break; try { val = JSON.parse(repairJsonString(c)); } catch (e) {} }
      fixedValue = val && typeof val === 'object' && !Array.isArray(val) ? JSON.stringify(val) : 'null';
    } else {
      // String laukas — PIRMA ir PASKUTINĖ kabutė šiame segmente yra
      // TIKROS ribos (nes segmentas apibrėžtas pagal ŽINOMĄ kito rakto
      // poziciją, o ne pagal spėjimą) — VISKAS tarp jų yra vieno teksto
      // lauko turinys, nesvarbu, kiek kabučių jame yra.
      let inner = raw;
      if (inner.startsWith('"')) inner = inner.slice(1);
      if (inner.endsWith('"')) inner = inner.slice(0, -1);
      fixedValue = '"' + _escapeAllQuotesInside(inner) + '"';
    }
    result += '"' + cur.key + '":' + fixedValue + (idx + 1 < positions.length ? ',' : '');
  }
  result += '}';
  return result;
}

// Bando JSON.parse() įprastai; jei nepavyksta — bando schemos pagrindu
// pataisytą versiją (patikimiausia); jei ir tai nepavyksta — bando senesnį
// bendrą taisymą kaip paskutinę atsarginę priemonę.
// Jei NIEKAS nepavyksta, meta ORIGINALIĄ klaidą (informatyvesnė log'ams).
// ═══════════════════════════════════════════════════════════════════
function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch (originalErr) {
    try {
      const schemaFixed = repairJsonBySchema(text);
      if (schemaFixed) return JSON.parse(schemaFixed);
    } catch (schemaErr) {
      console.error('[parseJsonLenient] schemos taisymas nepavyko:', schemaErr.message);
    }
    try {
      return JSON.parse(repairJsonString(text));
    } catch (repairErr) {
      console.error('[parseJsonLenient] bendras taisymas irgi nepavyko:', repairErr.message);
      throw originalErr;
    }
  }
}

// ŽINOMŲ, PASIKARTOJANČIŲ KLAIDINGŲ ŽODŽIŲ SĄRAŠAS (2026-09 papildymas)
// Priežastis: pastebėta, kad AI korektūros žingsnis (žingsnis 3) KARTAIS
// pats sukuria NAUJĄ, netaisyklingą žodžio formą, bandydamas ištaisyti
// kitą klaidą (pvz. "neieškosi" (ateities laikas) ištaiso į "neieškoi"
// (apskritai neegzistuojantis žodis) vietoj teisingo "neieškai"). Kadangi
// AI pagrįstas taisymas negali garantuoti 100% patikimumo, ČIA — paprastas,
// DETERMINISTINIS (ne AI, tiesioginis teksto pakeitimas) saugiklis
// jau PASTEBĖTOMS, PASIKARTOJANČIOMS klaidoms. Kiekvienas įrašas —
// tiksliai žinomas klaidingas žodis, kuris VISADA pakeičiamas teisingu,
// nepriklausomai nuo AI atsakymo. Sąrašą galima papildyti ateityje,
// radus naujų pasikartojančių klaidų.
// ═══════════════════════════════════════════════════════════════════
const KNOWN_GRAMMAR_FIXES = [
  ['neieškoi', 'neieškai'],
  ['neieškoji', 'neieškai'],
  ['praleidžiai', 'praleidi'],
  ['nepakenčiuosi', 'nepakenti'],
  ['atsitraukiesi', 'atsitrauki'],
  ['priešinsiesi', 'priešiniesi'],
  ['neatleidžiuosi', 'neatleidi'],
  ['nesuklestėsi', 'nesuklesti'],
  ['nesišauki pagalbos', 'nesišaukiesi pagalbos'],
  ['aiškią galvą', 'aiškų protą'],
  ['nuolatinių kišimosi', 'nuolatinio kišimosi'],
  ['nesijauti priklausomas nuo', 'nepriklausai nuo'],
  ['pats nustato', 'nustatai'],
  ['jaustis laisvam', 'jaustis laisvai'],
  ['tai tai, kad', 'tai, kad'],
  ['neieškojo pats', 'neieškojai'],
  ['neieškojo', 'neieškojai'],
  [', laukdamas tobulų sąlygų, kurios niekada neateis.', ', nes lauki tobulų sąlygų, kurios niekada neateis.'],
  ['Kasdien įpratęs viską kontroliuoti ir planuoti, todėl praleidi galimybes', 'Kasdien stengiesi viską kontroliuoti ir planuoti, todėl praleidi galimybes'],
  ['o laukei, kol protas atvėsta', 'o lauki, kol protas atvėsta'],
  ['o užsidari ir sprendei problemą pats', 'o užsidari ir sprendi problemą savarankiškai'],
  ['tu išlieki ramus ir susikaupęs', 'tu išlaikai ramybę ir susikaupimą'],
  ['Labiausiai efektyvus esi tada', 'Labiausiai efektyviai veiki tada'],
  ['Veiki greičiau, kai esi vienas', 'Veiki greičiau, kai dirbi savarankiškai'],
  ['pripažinti, kad vienas negali visko', 'pripažinti, kad negali visko'],
  ['tik tu vienas žinai', 'tik tu žinai'],
  ['užtruki ilgiau', 'užtrunki ilgiau'],
  ['analizuoji situaciją prieš veikdamas', 'analizuoji situaciją prieš pradedant veikti'],
  ['tiesioginė, akimirksniu priimta akcija, kuri dažnai pasiteisina', 'tiesioginis, akimirksniu priimtas veiksmas, kuris dažnai pasiteisina'],
  ['patikimumą ir nuoseklumą laike', 'patikimumą ir pastovumą laikui bėgant'],
  ['artimiausiems žmonėms neatskleidei visko', 'artimiausiems žmonėms neatskleidi visko'],
  ['vietoj to, laukei, kol aplinkybės pasikeis, ir tada veiksmi', 'vietoj to, lauki, kol aplinkybės pasikeis, ir tada veiki'],
  ['Laukei tinkamo momento, ne forsuoji', 'Lauki tinkamo momento, ne forsuoji'],
  ['Geriausiai uždirbsi ne per riziką', 'Geriausiai uždirbi ne per riziką'],
  ['Uždirbsi per kompetenciją, ne ryšius', 'Uždirbi per kompetenciją, ne ryšius'],
  ['kur gali pats nuspręsti', 'kur gali savarankiškai nuspręsti'],
  ['esi pranašesnis už tuos, kurie ilgai svarsto', 'veiki pranašiau už tuos, kurie ilgai svarsto'],
  ['iš karto būti efektyvus', 'iš karto pasiekti rezultatų'],
  ['Tau nereikia būti garsiam, kad būtum sėkmingas', 'Tau nereikia garsėti, kad pasiektum sėkmę'],

  // ── Rezultato ekrano nuotraukų partija (2026-09-20) ──
  // Santykiai / gyvenimo kryptis: būtasis laikas vietoj esamojo, bendratis vietoj "tu" formos
  ['siekei per aiškius lūkesčius ir atvirą komunikaciją — nepalikti vietos neaiškumams', 'sieki aiškių lūkesčių ir atviros komunikacijos — nepaliki vietos neaiškumams'],
  ['arba bendrauja giliai', 'arba bendrauji giliai'],
  ['esi ištikimas ir patikimas', 'tavo ištikimybe ir patikimumu galima pasikliauti'],
  // Kliūtys: neegzistuojantys/klaidingi žodžiai ir giminę turintys padalyviai
  ['— linkimas laukti', '— polinkis laukti'],
  ['pradėtum su tuo, ką turi dabar', 'pradėtum nuo to, ką turi dabar'],
  ['kurį paleisti atblokuotų tavo potencialą', 'kurį paleidus atsiskleistų tavo potencialas'],
  ['atblokuotų tavo potencialą', 'atrakintų tavo potencialą'],
  ["'žalio šviesos'", "'žalios šviesos'"],
  ['prieš veikiant', 'prieš pradedant veikti'],
  ['prieš žengdamas', 'prieš žengiant'],
  ['prieš žengdama', 'prieš žengiant'],
  ['tik eidamas', 'tik einant'],
  ['tik eidama', 'tik einant'],
  // Galimybės / finansai: "pasidarę" vietoj "pasidavę", "apmokomi" vietoj "apmokami"
  ['būtų pasidarę', 'būtų pasidavę'],
  ['apmokomi', 'apmokami'],
  // Santykiai: "laiku" (on time) vietoj "su laiku" (over time) — ši klaida buvo paties prompto pavyzdyje
  ['užsitarnauji laiku, ne iš karto', 'užsitarnauji ne iš karto, o su laiku'],
  ['užsitarnauji laiku', 'užsitarnauji su laiku'],
  // Pokyčiai: "jausti" vietoj "atrodyti", "nebepriima" vietoj "nebetinka"
  ['atrodė pakankamai gera, dabar pradeda jausti per maža ar per siaura', 'atrodė pakankamai gerai, dabar pradeda atrodyti per mažai ir per ankšta'],
  ['dalykai tau nebepriima', 'dalykai tau nebetinka'],
  // Rašyba: "anksčiau" (ne "ankščiau") — pasikartoja keliuose skyriuose
  ['ankščiau', 'anksčiau'],
  ['Ankščiau', 'Anksčiau'],

  // ── Rezultato ekrano nuotraukų 2-a partija (2026-09-20) ──
  // Charakteris: giminę turintis dalyvis + sulipę žodžiai
  ['kartą nusprendęs ką nors daryti, jaužengi į priekį, o ne grįžti atgal svarstyti', 'kartą nusprendi ką nors daryti, jau žengi į priekį ir daugiau nebesvarstai'],
  ['jaužengi', 'jau žengi'],
  ['prieš veikdamas', 'prieš pradedant veikti'],
  ['prieš veikdama', 'prieš pradedant veikti'],
  // Charakteris: neteisingas linksnis ("branduolys" → galininkas "branduolį") ir giminę turintys būdvardžiai
  ['branduolą', 'branduolį'],
  ['būti tvirtam savo įsitikinimuose, bet atviram naujoms galimybėms', 'tvirtai laikytis savo įsitikinimų ir kartu priimti naujas galimybes'],
  // Sėkmės raktas: "o ne ieškoi" → "o neieškai"
  ['o ne ieškoi', 'o neieškai'],
  // Finansai: nenatūralus "labiausiai įmanoma" (kopijuota iš prompto)
  ['sėkmė labiausiai įmanoma ten', 'sėkmė labiausiai pasiekiama ten'],
  // Kliūtys: sugadintas prompto frazės nuosėdų sakinys
  ['Kasdien įpročiai, kurie vėlina sėkmę, yra tie, kai atidėlioji pradžią', 'Kasdienis įprotis, vėlinantis sėkmę, yra pradžios atidėliojimas'],
  ['Kasdien įpročiai', 'Kasdieniai įpročiai'],

  // ── Rezultato ekrano nuotraukų 4-a partija (2026-09-20) ──
  // LYTIES NEUTRALUMAS: modelis vis tiek panaudojo giminę turintį dalyvį/būdvardį,
  // nors taisyklė jau buvo prompte — dictionary saugiklis konkretiems pasikartojantiems atvejams.
  ['Kartą nusprendęs, neatitrūksti nuo tikslo', 'Kai kartą apsisprendi, neatitrūksti nuo tikslo'],
  ['Esi atviras naujoms patirtims ir nebijai keisti įprastą rutiną', 'Atvirai priimi naujas patirtis ir nebijai keisti įprastą rutiną'],
  ['bet kai pasitiki, esi ištikimas ir atidus', 'bet kai pasitiki, elgiesi ištikimai ir dėmesingai'],
  // Asmenų nesutapimas sudėtiniame sakinyje su "ir" (tas pats "tu" turėtų valdyti abu veiksmažodžius)
  ['nuo tokių žmonių atsitraukia savaime', 'nuo tokių žmonių atsitrauki savaime'],
  // "vienas/viena" be "iš" prieš aukščiausiojo laipsnio kilmininką — žodžių tvarkos klaida
  ['yra tavo vienas stipriausių vidinių variklių', 'yra vienas iš tavo stipriausių vidinių variklių'],

  // ── Rezultato ekrano nuotraukų 5-a partija (2026-09-20) ──
  // Giminės nesutapimas: "komanda" moteriškos giminės, bet būdvardis vyriškos ("nedideliu")
  ['su nedideliu komanda', 'su nedidele komanda'],
  // Per sudėtingas/knyginis žodis (pažeidžia jau esamą stiliaus taisyklę, žr. DRAUDŽIAMA sąrašą)
  ['ieškoti konsensuso', 'siekti bendro sutarimo'],

  // ── Rezultato ekrano nuotraukų 6-a partija (2026-09-20) ──
  // LYTIES NEUTRALUMAS: "pats" (savarankiškumo prasme) — nauja giminę turinčio žodžio kategorija,
  // kurios iki šiol nebuvo draudžiamų žodžių sąraše (tik "vienas/viena" buvo)
  ['stengiesi kontroliuoti pats', 'stengiesi kontroliuoti savarankiškai'],
  ['stengiesi išspręsti pats', 'stengiesi išspręsti savarankiškai'],
  ['kurią pats sau kuri nuolat galvodamas', 'kurią sau sukuri nuolat galvojant'],
  ['ir sprendžiai viską pats', 'ir sprendi viską savarankiškai'],
  ['Sunkiais momentais sprendžiai viską pats', 'Sunkiais momentais viską sprendi savarankiškai'],
  // "vienas" (vienišumo prasme) — jau seniai draudžiamas, bet vėl pasitaikė
  ['atsakomybės vienas ir greitai perdegi', 'atsakomybės savarankiškai ir greitai perdegi'],
  // Giminės nesutapimas + išgalvotas žodis: "savikritika" moteriškos giminės, instrumentalis "griežta savikritika", NE "griežtu savikritiki" (tokio žodžio nėra)
  ['pernelyg griežtu savikritiki', 'pernelyg griežta savikritika'],
  // Asmenavimo/formos nesutapimas sudėtiniame sakinyje (bendratis vietoj asmenuojamos formos)
  ['Sunkiausiais momentais neieškoti pagalbos iš kitų, o užsidarai', 'Sunkiausiais momentais neieškai pagalbos iš kitų, o užsidarai'],
  // Sudėtingas/knyginis žodis (pažeidžia stiliaus taisyklę)
  ['pasitikėti kitais ir delegauti', 'pasitikėti kitais ir perduoti jiems dalį darbų'],

  // ── Rezultato ekrano nuotraukų 7-a partija (2026-09-20) ──
  // Giminės nesutapimas: "gairė" moteriškos giminės, bet abu būdvardžiai vyriškos
  ['Svarbiausias tavo vidinis gairė', 'Svarbiausia tavo vidinė gairė'],
  // Išgalvotas žodis: bendrauti → tu bendrauji (NE bendrauni)
  ['Su žmonėmis bendrauni atvirai', 'Su žmonėmis bendrauji atvirai'],
  // Sudėtingas/knyginis žodis (pažeidžia stiliaus taisyklę)
  ['ne per vidinę kontempliaciją', 'ne per vidinį apmąstymą'],
  // LYTIES NEUTRALUMAS: "pirmam" (giminę turinti dativo forma) ir gimininis dalyvis "linkęs"
  ['drąsos pradėti pirmam', 'drąsos pradėti pirmiau'],
  ['Pasikartojantis elgesio modelis — linkęs imtis iniciatyvos santykiuose, o ne laukti', 'Pasikartojantis elgesio modelis — imiesi iniciatyvos santykiuose, o ne lauki'],

  // ── Rezultato ekrano nuotraukų 8-a partija (2026-09-20, vakaro sesija) ──
  // Neteisinga nosinė: bendrauti → tu bendrauji (be nosinės ant "i"), NE "bendraujį"
  ['bendraujį', 'bendrauji'],
  ['Bendraujį', 'Bendrauji'],
  // Neteisingas žodis pagal reikšmę: "užsidarbiauti" reiškia uždirbti pinigus, NE pasitikėjimą — turi būti "užsitarnauji"
  ['pasitikėjimą užsidarbuoji', 'pasitikėjimą užsitarnauji'],
  ['Pasitikėjimą užsidarbuoji', 'Pasitikėjimą užsitarnauji'],
  // LYTIES NEUTRALUMAS: "tvirtam" (gimininė dativo forma, ta pati klaidos rūšis kaip "pirmam")
  ['gebėjimas išlikti tvirtam savo pozicijoje', 'gebėjimas tvirtai laikytis savo pozicijos'],
  // LYTIES NEUTRALUMAS: "priklausomas" — jau seniai draudžiamas pavyzdys, bet vėl panaudotas
  ['ir nesi priklausomas nuo kitų', 'ir nepriklausai nuo kitų'],
  // Netaisyklinga (neegzistuojanti) frazė: "pusiau kelio" → "pusiaukelėje" (vienas žodis, vietininkas)
  ['nekeičiant krypties pusiau kelio', 'nekeičiant krypties pusiaukelėje'],
  // Išgalvotas daiktavardis: "užtikrintumas" (ne "užtikrintimas"), instrumentalis "-u" (vyriškos giminės), ne "-imi"
  ['tylia, nepajudinama užtikrintimi savimi', 'tyliu, nepajudinamu pasitikėjimu savimi'],
  // Išgalvotas veiksmažodis: sumaišyti "vaikytis" (sekti/gaudyti) ir "vaikščioti" (eiti) kamienai —
  // neigiama sangrąžinio "vaikytis" forma taisyklingai "nesivaikai" (ne "vaikstai")
  ['Nesivaikstai paskui kitus', 'Nesivaikai paskui kitus'],
  // LYTIES NEUTRALUMAS: gimininis dalyvis "Nelinkęs" (-ęs galūnė)
  ['Nelinkęs ilgai svarstyti ar ieškoti kompromisų, kai jau matai aiškų kelią.',
   'Nesvarstai ilgai ir neieškai kompromisų, kai jau matai aiškų kelią.'],
  // Asmenų nesutapimas (numanomas veiksnys): "išlaikau" (1 asm.) vietoj "tu" formos, nors "tu" tiesiogiai nestovi šalia
  ['Emociniai svyravimai tau svetimi — išlaikau stabilumą ir ramybę net įtampos kupinose situacijose.',
   'Emociniai svyravimai tau svetimi — išlaikai stabilumą ir ramybę net įtampos kupinose situacijose.'],
  // VERTIMO KALKĖ: "perdeginėti/perdegti" NEGALI turėti papildinio (negalima "perdegti KO NORS",
  // tik "pats perdegti") — čia panaudota tranzityviai kaip angliškas "burn through X", kas
  // lietuviškai visai kitas veiksmažodis. Šis dictionary įrašas suveikia PRIEŠ bendrą regex
  // (kuris čia duotų vis tiek negramatišką "neperdegi jų dėmesio").
  ['neperdeginėji jų dėmesio', 'neeikvoji jų dėmesio'],
  // Dar vienas "vaikytis" klaidos variantas: 3-io asmens forma "vaikosi" panaudota vietoj "tu" formos "vaikaisi"
  ['nesivaikosi kiekvienos naujos galimybės', 'nesivaikai kiekvienos naujos galimybės'],
  // LYTIES NEUTRALUMAS: "pačiam" — giminė dativo forma ("pats" šeima), ta pati klaidos rūšis kaip "pirmam"/"tvirtam"
  ['tau svarbu pačiam valdyti savo kelią', 'tau svarbu savarankiškai valdyti savo kelią'],
  // LYTIES NEUTRALUMAS (geltonas sakinys): "esi/išlieki + būdvardis" konstrukcija
  ['Išlieki stabilus chaoso akivaizdoje', 'Išlaikai stabilumą chaoso akivaizdoje'],
  // Linksnio nesutapimas (geltonas sakinys): "Aiškus" (vardininkas) + "matymą" (galininkas) — turi sutapti
  ['Aiškus matymą be iliuzijų', 'Aiškus matymas be iliuzijų'],
  // LYTIES NEUTRALUMAS: du giminę turintys būdvardžiai viename sakinyje ("teisiam", "nepakankamas")
  ['Paleisk poreikį visada būti teisiam — klaidos yra dalis kelio, ne ženklas, kad esi nepakankamas.',
   'Paleisk poreikį visada įrodyti savo teisumą — klaidos yra dalis kelio, ne ženklas, kad tau ko nors trūksta.'],
  // Asmenų nesutapimas sudėtiniame sakinyje su "ir" (dar vienas atvejis — "priimi" tu, "neieško" jis)
  ['Priimi atsakomybę už savo pasirinkimus ir neieško išorinių pateisinimų.',
   'Priimi atsakomybę už savo pasirinkimus ir neieškai išorinių pateisinimų.'],
  // Išgalvotas žodis: "judėti" nereguliarus — esamojo laiko kamienas "jud-" (judu/judi/juda),
  // NE bendraties kamienas "judėj-" (KLAIDA "judėji", tokio žodžio nėra)
  ['Judėji link to', 'Judi link to'],
  // Išgalvotas daiktavardis: "iešką" nėra — ieškoti → ieškojimas
  ['motyvacijos iešką', 'motyvacijos ieškojimą'],
  // LYTIES NEUTRALUMAS: gimininis dalyvis "esi pradėjęs" — perrašyta į esamąjį laiką
  ['tu jau esi pradėjęs veikti', 'tu jau veiki'],
  // LYTIES NEUTRALUMAS: gimininis padalyvys "ignoruodamas" → neutralus "ignoruojant"
  ['tiesiu keliu, ignoruodamas šalutinius triukšmus', 'tiesiu keliu, ignoruojant šalutinius triukšmus'],

  // ── Rezultato ekrano 9-a partija (2026-09-21) ──
  // Asmenų nesutapimas: "kai nusprendžia" (3 asm.) sumaišyta su "laikaisi" (2 asm., "tu") tame pačiame sakinyje
  ['Kai nusprendžia, laikaisi savo pasirinkimo tvirtai', 'Kai nusprendi, laikaisi savo pasirinkimo tvirtai'],
  // Asmenų nesutapimas sudėtiniame sakinyje su "ir": "užsidarai" (tu) + "sprendžia" (jis/ji) — turi būti "sprendi"
  ['užsidarai ir sprendžia problemą savarankiškai', 'užsidarai ir sprendi problemą savarankiškai'],
  // Būtasis laikas vietoj esamojo: kreipiantis "tu", visada esamuoju laiku
  ['nesujaudina — išlaikei ramybę ten', 'nesujaudina — išlaikai ramybę ten'],
  // LYTIES NEUTRALUMAS: gimininis padalyvys "neužsibūdamas"/"užsibūdamas" → neutralus "-ant" (žodžio
  // lygiu, kad veiktų NEPRIKLAUSOMAI nuo likusio sakinio — anksčiau buvo pririšta prie viso sakinio
  // ir nesuveikė kitame kontekste, žr. vartotojo pranešimą 2026-09-22)
  // LYTIES NEUTRALUMAS + asmenų nesutapimas: "esi stabilus"/"išvedamas" gimininiai, "tu išlaikau" — 1 asmuo prie "tu"
  ['Emociškai esi stabilus ir sunkiai išvedamas iš pusiausvyros — net kai aplinkui chaosas, tu išlaikau ramybę ir susikaupimą.',
   'Emociškai išlaikai stabilumą, ir tave sunku išvesti iš pusiausvyros — net kai aplinkui chaosas, tu išlaikai ramybę ir susikaupimą.'],
  // LYTIES NEUTRALUMAS: "esi produktyviausias" — gimininis aukščiausiojo laipsnio būdvardis (ta pati "esi + būdvardis" konstrukcija)
  ['sunkiausiomis akimirkomis esi produktyviausias', 'sunkiausiomis akimirkomis veiki produktyviausiai'],

  // ── Rezultato ekrano nuotraukų 3-a partija (2026-09-20) ──
  // Asmenų nesutapimas sakinio viduje: "tavo kūnas įvykdai" (3-io asmens
  // vardažodis + 2-o asmens veiksmažodžio galūnė) — turi būti "įvykdo".
  ['ką nusprendžia tavo protas, tavo kūnas įvykdai', 'ką nusprendžia tavo protas, tą tavo kūnas įvykdo']
];

// ═══════════════════════════════════════════════════════════════════
// REGEX pataisymai — žodžiams, kurie pasitaiko KITOKIAME sakinio kontekste
// kiekvieną kartą (žodyno `includes` čia netinka, nes pvz. "tikies" yra
// "tikiesi" pradžia — reikia žodžio ribų). Taikomi PO žodyno.
// ═══════════════════════════════════════════════════════════════════
const KNOWN_REGEX_FIXES = [
  [/\btikies\b/g, 'tikiesi'],            // "ką tikies sužinoti" → "ką tikiesi sužinoti"
  [/\b([Ll])aukei\b/g, '$1auki'],        // "Laukei 'idealaus momento'" → "Lauki ..." (jau 4-a skirtinga vieta)
  [/\b([Ss])iekei\b/g, '$1ieki'],        // "Siekei ne tik rezultato" → "Sieki ..."
  // SKIRTINGA linksniuotės klasė: laikyti/palaikyti/sulaikyti/išlaikyti/atlaikyti ir pan. (-yti)
  // esamajame laike baigiasi "-ai" (laikau/laikai/laiko), NE "-i" — todėl atskiras regex nuo
  // laukei/siekei aukščiau. Veikia bet kuriam priešdėliui ir išsaugo didžiąją raidę sakinio pradžioje.
  [/(?<!\p{L})(\p{L}*)laikei(?!\p{L})/giu, (full, prefix) => {
    const isCapital = full[0] !== full[0].toLowerCase();
    let result = prefix.toLowerCase() + 'laikai';
    if (isCapital) result = result.charAt(0).toUpperCase() + result.slice(1);
    return result;
  }],
  [/\blinkimas\b/g, 'polinkis'],         // neegzistuojantis "linkimas"; \b apsaugo "sulinkimas"

  // ── Neteisingos "tu" formos (nereguliarūs veiksmažodžiai) — 2-a nuotraukų partija ──
  [/\b((?:ne)?)ieški\b/giu, (full, prefix) => {
    const isCapital = full[0] !== full[0].toLowerCase();
    let result = prefix.toLowerCase() + 'ieškai';
    if (isCapital) result = result.charAt(0).toUpperCase() + result.slice(1);
    return result;
  }], // "Neieški"/"neieški"/"ieški"/"Ieški" → visos "-ai" formos (ieškoti: tu ieškai)
  // ieškoti: VISI "ieškoi" (išgalvota forma) variantai vienu regex — su/be "ne-" priešdėlio,
  // su didžiąja/mažąja raide sakinio pradžioje. Ankstesnis siauras regex NEVEIKĖ su "ne-"
  // priešdėliu (nėra žodžio ribos tarp "ne" ir "ieškoi") ir žodyno įrašas neveikė su didžiąja
  // raide (case-sensitive) — abi spragos ištaisytos šiuo vienu, bendru regex.
  [/\b((?:ne)?)ieškoi\b/giu, (full, prefix) => {
    const isCapital = full[0] !== full[0].toLowerCase();
    let result = prefix.toLowerCase() + 'ieškai';
    if (isCapital) result = result.charAt(0).toUpperCase() + result.slice(1);
    return result;
  }],
  [/(?<!\p{L})(\p{L}*)leidži(?:ai)?(?!\p{L})/gu, '$1leidi'], // leisti: "praleidži", "nepaleidži", "atleidžiai" → "praleidi", "nepaleidi", "atleidi"
  [/\bpranokai\b/g, 'pranoksti'],         // pranokti: tu pranoksti
  [/\b(renkies|vadovaujies|elgies|jaučies|stengies|imies)\b/g, '$1i'], // sangrąžinė "-iesi" (trūkstamas galūnės -i)
  [/\bpabalos\b/g, 'pabaigos'],            // rašybos klaida

  // leistis: "tu" forma taisyklingai "leidiesi" (kamienas be dž), ne "leidžiesi"
  // (dž lieka tik 1 ir 3 asmenyje: leidžiuosi / leidiesi / leidžiasi).
  // Raidžių dydis (didžioji/mažoji) IŠSAUGOMAS.
  [/\bLeidžiesi\b/g, 'Leidiesi'],
  [/\bleidžiesi\b/g, 'leidiesi'],

  // pakęsti: "tu" forma taisyklingai "pakenti" (kamienas be č), ne "pakenči"
  // (pakenčiu / pakenti / pakenčia — č lieka tik 1 ir 3 asmenyje, kaip ir leistis aukščiau)
  [/\bNepakenči\b/g, 'Nepakenti'],
  [/\bnepakenči\b/g, 'nepakenti'],
  [/\bPakenči\b/g, 'Pakenti'],
  [/\bpakenči\b/g, 'pakenti'],

  // dusti/uždusti: būsimojo laiko "tu" forma taisyklingai "uždusi" (kamienas be minkštinimo), ne "užduši"
  [/\bUžduši\b/g, 'Uždusi'],
  [/\bužduši\b/g, 'uždusi'],

  // spręsti: "tu" forma taisyklingai "sprendi" (aš sprendžiu / tu sprendi / jis sprendžia) — "sprendžiai" neegzistuoja
  [/\bsprendžiai\b/g, 'sprendi'],
  // Nereikalingai pridėta "-inėti" dažninė priesaga: perdegti → tu perdegi, NE "perdeginėji"
  [/\b((?:ne)?)perdeginėji\b/giu, (full, prefix) => {
    const isCapital = full[0] !== full[0].toLowerCase();
    let result = prefix.toLowerCase() + 'perdegi';
    if (isCapital) result = result.charAt(0).toUpperCase() + result.slice(1);
    return result;
  }],
  [/\bSprendžiai\b/g, 'Sprendi'],

  // Neteisingai uždėta nosinė ant "-auji" tipo veiksmažodžių ("tu" forma): bendrauji, keliauji,
  // dalyvauji ir pan. baigiasi paprastu "i", NE "į" (KLAIDA: "bendraujį" — nėra tokio žodžio)
  [/\b(\p{L}*auj)į\b/gu, '$1i'],

  // LYTIES NEUTRALUMAS (bendra taisyklė): "esi [būdvardis]iausias" — aukščiausiojo laipsnio būdvardis
  // visada gali būti perrašytas į neutralų prieveiksmį "veiki [būdvardis]iausiai" (pvz. "esi produktyviausias"
  // → "veiki produktyviausiai"). Veikia ir moteriškai giminei ("esi produktyviausia" — ta pati problema).
  [/\b[Ee]si (\p{L}+?)iausi(?:as|a)\b/gu, 'veiki $1iausiai'],

  // LYTIES NEUTRALUMAS: „buvai/esi/tapai + giminę turintis būdvardis“ (pvz. „iš prigimties buvai atviras“)
  // → neutralus „… atviro būdo“. Dažniausi charakterio būdvardžiai abiem giminėm.
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:atviras|atvira)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'atviro būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:uždaras|uždara)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'uždaro būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:linksmas|linksma)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'linksmo būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:emocingas|emocinga)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'emocingo būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:savarankiškas|savarankiška)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'savarankiško būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:ramus|rami)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'ramaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:drąsus|drąsi)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'drąsaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:jautrus|jautri)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'jautraus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:stiprus|stipri)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'stipraus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:kantrus|kantri)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'kantraus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:santūrus|santūri)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'santūraus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:atsargus|atsargi)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'atsargaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:švelnus|švelni)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'švelnaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:impulsyvus|impulsyvi)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'impulsyvaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:aktyvus|aktyvi)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'aktyvaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:nedrąsus|nedrąsi)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'nedrąsaus būdo'],
  [/(?<!\p{L})(esi|buvai|tapai|likai|išlikai|išlieki|tampi|lieki)\s+(labai\s+|daug\s+|kur kas\s+|labiau\s+)?(?:užsispyręs|užsispyrusi)(?!\p{L})/giu, (_, v, mod) => v + ' ' + (mod || '') + 'užsispyrusio būdo'],

  // Asmenų nesutapimas: "kai nusprendžia," (3 asm.) — šioje app'oje VISADA kreipiamasi "tu", tad be aiškaus
  // trečio asmens daiktavardžio prieš tai, "kai nusprendžia" turi būti "kai nusprendi"
  [/\b([Kk])ai nusprendžia,/g, '$1ai nusprendi,'],

  // BENDRA APSAUGA: "tu" + veiksmažodis su 1-o asmens galūne "-au" yra savaime prieštaringa
  // klaida (žodis "tu" reikalauja 2-o asmens) — šios klasės veiksmažodžiams (laikau/laikai,
  // žinau/žinai, matau/matai, rašau/rašai ir pan.) 2-as asmuo visada "-ai". Priešdėlis bent
  // 2 raidžių, kad neužkliūtų trumpi ne-veiksmažodžiai kaip "jau", "sau", "tau".
  [/\b([Tt])u (\p{L}{2,})au\b/gu, '$1u $2ai'],

  // LYTIES NEUTRALUMAS (žodžio lygiu, ne sakinio — veikia bet kuriame kontekste):
  // gimininiai padalyviai "-damas" → neutralus "-ant". Kiekvienas veiksmažodis pridedamas
  // atskirai, nes mechaninis "-damas"→"-ant" keitimas NĖRA visada teisingas (kai kurių
  // veiksmažodžių esamojo laiko kamienas skiriasi nuo pusdalyvio kamieno, pvz. "užsibūti":
  // pusdalyvis "užsibūdamas", bet padalyvis "užsibūnant", ne "užsibūant").
  // "užsibūti" gerundo (neužsibūnant) klaidingi variantai — įvairios sugalvotos priesagos vietoj "-nant"
  [/\bneužsibū(?:damas|dama|davęs|davusi|dave)\b/g, 'neužsibūnant'],
  [/\bužsibū(?:damas|dama|davęs|davusi|dave)\b/g, 'užsibūnant'],
  // judėti nereguliarus: bendraties kamienas "judėj-" klaidingai panaudotas vietoj tikro "jud-"
  [/\bJudėji\b/g, 'Judi'],
  [/\bjudėji\b/g, 'judi'],
  [/\bgalvodamas\b/g, 'galvojant'],
  [/\bignoruodamas\b/g, 'ignoruojant'],
  [/\babejodamas\b/g, 'abejojant']
];

// ═══════════════════════════════════════════════════════════════════
// BENDRAS (ne žodyno, o ŠABLONO) DETERMINISTINIS SAUGIKLIS
// Priežastis: "tu" + veiksmažodis su neteisinga "-a"/"-ia" galūne
// (vietoj "-i") yra DAŽNIAUSIA šio teksto klaida — bet kadangi ji
// pasitaiko su VIS KITAIS žodžiais (ne tik 1-2 konkrečiais), žodyno
// metodas (KNOWN_GRAMMAR_FIXES aukščiau) čia nepakankamas. Šis regex'as
// ieško BENDRO ŠABLONO: "tu [galbūt įvardis] [žodis]" ir jei paskutinis
// žodis baigiasi "-a"/"-ia" (o ne jau teisingai "-i"), pakeičia galūnę.
// Apima ir atvejį, kai tarp "tu" ir veiksmažodžio įsiterpia įvardis
// (pvz. "tu ją pralaužia" → "tu ją pralauži").
// RIBOTUMAS: tai heuristika, ne tikras gramatikos analizatorius — veikia
// TIK tiesiogiai po "tu" (galbūt su vienu įvardžiu tarp) einantiems
// žodžiams, ne visame sakinyje. Neapima atvejų, kai veiksmažodis nutolęs
// toliau nuo "tu" (pvz. per kelis žodžius ar kablelį).
// ═══════════════════════════════════════════════════════════════════
const TU_ENDING_EXCEPTIONS = new Set([
  'pats','pati','esi','esą','savo','save','sau','tau','tavo','čia','ten','yra','jog','kad'
]);

function fixTuVerbEndings(text) {
  const pronouns = 'ją|jį|jam|jai|juos|jas|jiems|joms|save|savo|sau|tave|tau|jo|jos';
  const re = new RegExp(`\\btu(\\s+(?:(?:${pronouns})\\s+)?)([A-Za-ząčęėįšųūžĄČĘĖĮŠŲŪŽ]+)\\b`, 'g');
  return text.replace(re, (match, between, word) => {
    const lower = word.toLowerCase();
    if (TU_ENDING_EXCEPTIONS.has(lower)) return match;
    if (lower.endsWith('i') || lower.endsWith('ti')) return match; // jau teisinga arba bendratis (paliekama promptui/žingsniui 3)
    let fixedWord = null;
    if (lower.endsWith('ia') && word.length > 3) {
      fixedWord = word.slice(0, -2) + 'i';
    } else if (lower.endsWith('a') && word.length > 2) {
      fixedWord = word.slice(0, -1) + 'i';
    }
    if (!fixedWord) return match;
    return 'tu' + between + fixedWord;
  });
}

// Vienas bendras kelias VISIEMS tekstams (skyriams ir geltoniems insights):
// 1) žodynas  2) regex (žodžių ribos)  3) "tu + -a" galūnių šablonas
function applyTextFixes(text) {
  let fixed = text;
  let count = 0;
  for (const [wrong, correct] of KNOWN_GRAMMAR_FIXES) {
    if (fixed.includes(wrong)) { fixed = fixed.split(wrong).join(correct); count++; }
  }
  for (const [re, correct] of KNOWN_REGEX_FIXES) {
    const next = fixed.replace(re, correct);
    if (next !== fixed) { fixed = next; count++; }
  }
  const patternFixed = fixTuVerbEndings(fixed);
  if (patternFixed !== fixed) { fixed = patternFixed; count++; }
  return { text: fixed, count };
}

function applyKnownGrammarFixes(result) {
  const fields = ['prigimtines_stiprybes','gyvenimo_tikslas','santykiai','finansai','galimybes','pokyciai','klutys'];
  const insightFields = ['prigimtines_insights','gyvenimo_insights','santykiai_insights','finansai_insights','galimybes_insights','pokyciai_insights','klutys_insights'];
  let fixCount = 0;
  for (const f of fields) {
    if (typeof result[f] === 'string') {
      const r = applyTextFixes(result[f]);
      result[f] = r.text;
      fixCount += r.count;
    }
  }
  for (const f of insightFields) {
    if (Array.isArray(result[f])) {
      result[f] = result[f].map(s => {
        if (typeof s !== 'string') return s;
        const r = applyTextFixes(s);
        fixCount += r.count;
        return r.text;
      });
    }
  }
  // Kairysis/dešinysis delnas greta — tie patys pataisymai (ypač lyties neutralumas)
  const dg = result.delnai_greta;
  if (dg && typeof dg === 'object') {
    const fx = t => { if (typeof t !== 'string') return t; const r = applyTextFixes(t); fixCount += r.count; return r.text; };
    for (const k of ['sirdis', 'protas', 'gyvenimas']) {
      if (dg[k] && typeof dg[k] === 'object') { dg[k].kairys = fx(dg[k].kairys); dg[k].desinys = fx(dg[k].desinys); }
    }
    dg.isvada = fx(dg.isvada);
  }
  if (fixCount > 0) console.log(`[applyKnownGrammarFixes] pritaikyta ${fixCount} deterministinių pataisymų`);
  return result;
}

// --- Pagrindinė Claude analizės funkcija ---
async function runPalmAnalysis(photos, name, sessionId) {

  const imageBlocks = photos.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data }
  }));

  // ═══════════════════════════════════════════════════════════════════
  // IŠJUNGTA: pakartotinė delno validacija analizės viduje.
  // Priežastis: griežta patikra JAU atliekama endpoint'e /validate-palm
  // fotografavimo metu (su galimybe iškart bandyti dar kartą, jei
  // netinka). Kartoti tą patį patikrinimą čia, PO sėkmingo mokėjimo,
  // yra perteklinis ir tik rizikuoja klaidingai atmesti jau patvirtintą,
  // apmokėjusį klientą. Delno atpažinimas dabar pilnai patikimas
  // /validate-palm endpoint'ui — jis lieka griežtas ir sprendžia
  // vienintelis.
  // ═══════════════════════════════════════════════════════════════════

  // Žingsnis 1: Vizualinė diagnostika
  const step1Body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    temperature: 0.2,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        {
          type: 'text',
          text: `Pažvelk į šias delno nuotraukas (kairio ir dešinio delno) ir aprašyk 14 ATSKIRŲ, KONKREČIŲ vizualinių pastebėjimų — kiekvienas apie KITĄ delno/rankos zoną ar aspektą (žr. sąrašą žemiau). SVARBU: šie 14 punktų VĖLIAU bus paskirstyti po 7 skirtingus analizės skyrius (2 punktai kiekvienam) — TODĖL kiekvienas punktas PRIVALO būti apie AIŠKIAI KITOKĮ, atskirą fizinį aspektą, kad NIEKAS nesikartotų.

SVARBU — kiekvienas įrašas PRIVALO prasidėti nuo to, ką TIKSLIAI MATAI nuotraukoje — TIK TADA trumpai susiek tai su galima interpretacija. DRAUDŽIAMA rašyti vien abstrakčią išvadą be to, KĄ TIKSLIAI matai. Kiekvienas įrašas turi būti toks konkretus ir individualus, kad kitas žmogus, neregintis šių nuotraukų, galėtų įsivaizduoti, KAIP TIKSLIAI atrodo BŪTENT ŠIS delnas.

14 aspektų, apie kuriuos reikia parašyti (po VIENĄ atskirą pastebėjimą kiekvienam, TA PAČIA tvarka):
1. Nykščio ilgis ir storis
2. Nykščio padėtis/atstumas nuo delno
3. Smiliaus (rodomojo) piršto ypatybė (ilgis, tiesumas, forma)
4. Didžiojo (vidurinio) piršto ypatybė
5. Bevardžio piršto ypatybė
6. Mažojo piršto ypatybė
7. Pirštų tarpų šablonas (glaudūs/platūs, tolygūs/netolygūs)
8. Delno plotis santykyje su jo ilgiu
9. Odos/raumenų reljefas VIENOJE delno zonoje (pvz. ties nykščio pagrindu)
10. Odos/raumenų reljefas KITOJE delno zonoje (pvz. delno viduryje ar apačioje)
11. Sąnarių/linijų įtempimo ar atsipalaidavimo pastaba
12. Bendra delno forma (kvadratinė, pailga, ir pan.)
13. Kairio ir dešinio delno SKIRTUMAS #1 (kuo jie skiriasi vienas nuo kito)
14. Kairio ir dešinio delno SKIRTUMAS #2 (kitas skirtumas, ne tas pats kaip #13)

SVARBU (kalba): rašyk TAISYKLINGA lietuvių kalba — teisingi linksniai, galūnės, natūrali žodžių tvarka, joks žodis nesugalvotas. Šis tekstas nėra rodomas vartotojui tiesiogiai, bet naudojamas kaip pagrindas kitam žingsniui, tad jo kalbos klaidos gali persiduoti toliau.

Grąžink TIKTAI JSON (BE numerių pačiuose aprašymuose — tik grynas tekstas, numeriai bus pridėti automatiškai):
{
  "bruozai": [
    "[konkretus vizualinis aprašymas apie nykščio ilgį/storį]",
    "[konkretus vizualinis aprašymas apie nykščio padėtį]",
    "[konkretus vizualinis aprašymas apie smiliaus pirštą]",
    "[konkretus vizualinis aprašymas apie didįjį pirštą]",
    "[konkretus vizualinis aprašymas apie bevardį pirštą]",
    "[konkretus vizualinis aprašymas apie mažąjį pirštą]",
    "[konkretus vizualinis aprašymas apie pirštų tarpus]",
    "[konkretus vizualinis aprašymas apie delno plotį/ilgį]",
    "[konkretus vizualinis aprašymas apie odos reljefą, zona A]",
    "[konkretus vizualinis aprašymas apie odos reljefą, zona B]",
    "[konkretus vizualinis aprašymas apie įtempimą/atsipalaidavimą]",
    "[konkretus vizualinis aprašymas apie bendrą delno formą]",
    "[konkretus vizualinis aprašymas apie kairio/dešinio skirtumą #1]",
    "[konkretus vizualinis aprašymas apie kairio/dešinio skirtumą #2]"
  ]
}`
        }
      ]
    }]
  });

  let step1Data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: step1Body
      }, 90000);
      step1Data = await r.json();
    } catch (networkErr) {
      // Laiko limitas suveikė (užklausa "pakibo") arba kitas tinklo trikdis —
      // traktuojame kaip laikiną, bandome dar kartą, o NE kaboti be galo.
      console.log(`Žingsnis 1 tinklo/laiko klaida, bandymas ${attempt}/3: ${networkErr.message}`);
      step1Data = null;
      if (attempt < 3) { await new Promise(res => setTimeout(res, 3000 * attempt)); continue; }
      break;
    }
    if (step1Data?.error?.type === 'overloaded_error') {
      console.log(`Žingsnis 1 perkrautas, bandymas ${attempt}/3...`);
      if (attempt < 3) await new Promise(res => setTimeout(res, 3000 * attempt));
      continue;
    }
    break;
  }

  let bruozai = [];
  try {
    const step1Text = step1Data.content.map(b => b.text || '').join('');
    const jsonMatch = step1Text.match(/\{[\s\S]*\}/);
    if (jsonMatch) bruozai = parseJsonLenient(jsonMatch[0]).bruozai || [];
  } catch(e) {
    console.warn('Žingsnis 1 JSON klaida:', e.message);
  }

  // Žingsnis 2: Pilna analizė
  // Pažymime REALŲ tarpinį statusą (jei ši analizė susieta su fone
  // vykstančia sesija) — tai leidžia klientui rodyti tikslų, realų
  // antrą etapą, o ne dirbtinai suskaidytus 7 "žingsnius".
  if (sessionId) {
    const entry = analysisCache.get(sessionId);
    if (entry && entry.status === 'pending') { entry.status = 'step2'; saveAnalysisSessionToDisk(sessionId, entry); }
  }
  const bruozaiText = bruozai.length > 0
    ? `Vizualiniai delno parametrai:\n${bruozai.map((b, i) => `${i+1}. ${b}`).join('\n')}\n\n`
    : '';

  const step2Content = [
    ...imageBlocks,
    {
      type: 'text',
      text: `PIRMENYBĖ (svarbiau už viską kitą šiame prompte): šį tekstą skaitys realus žmogus, sumokėjęs pinigus, gimtąja lietuvių kalba. VIENA gramatinė ar sugalvoto žodžio klaida iškart sugriauna pasitikėjimą visu produktu — net jei turinys puikus. Taisyklinga, natūrali, gimtakalbio lietuvių kalba yra LYGIAVERTIS reikalavimas turinio kokybei, o kilus konfliktui tarp „skambesnio" žodžio ir „paprasto bei tikrai teisingo" — VISADA rink paprastą ir teisingą. Detalios kalbos taisyklės pateiktos žemiau ir GALUTINIAME PATIKRINIME prieš pat atsakymo pabaigą — jos privalomos be išimčių.

Tu esi chiromantijos meistras su 20 metų patirtimi. Prieš tave yra${name ? ' ' + name + ' —' : ''} kairio ir dešinio delno nuotraukos. Matai juos aiškiai.

${bruozaiText}Remdamasis TIKTAI tuo, ką realiai MATAI šiuose konkrečiuose delnuose (aukščiau esančiais vizualiniais parametrais), parašyk tikslią, konkrečią, MAKSIMALIAI TIKSLIĄ chiromantijos analizę lietuvių kalba BŪTENT apie šį žmogų — remiantis BŪTENT ŠIAIS delnais, ne bendrais chiromantijos principais. Tai NĖRA bendro pobūdžio tekstas — kiekvienas sakinys turi remtis tuo, ką matai ŠIUOSE delnuose, ir turi būti toks specifiškas, kad netiktų jokiam kitam žmogui.

KIEKVIENAM skyriui PRISKIRTI TIKSLIAI DU (2) vizualiniai parametrai iš aukščiau esančio 14 punktų sąrašo — naudok JUOS kaip VIDINĮ, TAU PAČIAM skirtą pagrindą (kad šio skyriaus išvados būtų individualios ir konkrečios BŪTENT šiam žmogui, o ne bendros bet kam tinkančios frazės), o NE bet kuriuos kitus iš sąrašo (tai užtikrina, kad joks parametras nebūtų naudojamas dukart skirtinguose skyriuose):
- prigimtines_stiprybes → remkis TIK parametrais #1 ir #2
- gyvenimo_tikslas → remkis TIK parametrais #3 ir #4
- santykiai → remkis TIK parametrais #5 ir #6
- finansai → remkis TIK parametrais #7 ir #8
- galimybes → remkis TIK parametrais #9 ir #10
- pokyciai → remkis TIK parametrais #11 ir #12
- klutys → remkis TIK parametrais #13 ir #14

SVARBU (parametrų naudojimas): jie skirti TIK vidiniam pagrindimui — GALUTINIAME TEKSTE niekada nerašyk apie pačius fizinius požymius (pirštų ilgį, delno plotį, nykščio storį, odos reljefą ir pan.), tik IŠVADĄ apie žmogaus charakterį/gyvenimą (pvz. vietoj "tavo nykščio storis rodo, kad priimi sprendimus greitai" rašyk tiesiog "sprendimus priimi greitai ir juos retai keiti").

PRIEŠ atiduodamas kiekvieną skyrių, patikrink: (1) ar VIDINIAI (savo paties apmąstyme, ne tekste) rėmiausi TIK tam skyriui priskirtais parametrų numeriais? (2) ar NĖ VIENAME sakinyje NĖRA tiesioginio fizinio delno/pirštų/nykščio/odos požymio paminėjimo? Jei bent vienas atsakymas "ne" — perrašyk.

TAISYKLĖS:
- Kiekvienas sakinys = konkretus faktas apie ŠĮ ŽMOGŲ, kurio pagrindas — tai, ką matai šiame delne (bet PATS požymis tekste neminimas, žr. instrukciją aukščiau) — ne bendra tiesa apie žmones apskritai
- PRIEŠ rašydamas kiekvieną sakinį, patikrink: ar šis sakinys tiktų BET KURIAM kitam žmogui? Jei taip — perrašyk konkrečiau, kad išvada būtų individuali BŪTENT šiam delnui (nerašant paties fizinio požymio)
- DRAUDŽIAMA tušti, "vatos" sakiniai, kurie nieko konkretaus nepasako ir neduoda vertės (pvz. bendri apibendrinimai, pripildymo frazės) — kiekvienas sakinys privalo nešti naują, konkretų faktą
- PAVYZDYS, ko VENGTI (per bendra, tiktų bet kam): "Tu esi žmogus, kurio pamatinė jėga slypi gebėjime išlaikyti vidinę ramybę net chaotiškose situacijose." — tai tuščia, nes bet kas norėtų, kad apie jį taip pasakytų
- PAVYZDYS, KAIP TURI BŪTI (konkretus faktas, susietas su vizualiniais parametrais): "Sprendimus priimi greitai ir juos retai keiti — net kai aplinkiniai bando tave perkalbėti, laikaisi savo pirminio pasirinkimo." — tiesioginis faktinis teiginys apie šį žmogų, ne hipotetinis scenarijus
- DRAUDŽIAMA: hipotetiniai scenarijai ar iliustracijos su "jei", "kai", "įsivaizduok" konstrukcijomis (pvz. "kai nutinka X, tu darai Y") — rašyk TIESIOGINIUS FAKTUS apie šį žmogų, ne pavyzdines situacijas ar iliustracijas
- Rašyk tiesiai ir drąsiai: "Tu esi...", "Tu linkęs...", "Tau sekasi...", "Tu vengi...", "Tau sunku..."
- SVARBU (kaip suprasti "drąsiai"): tiesus, drąsus tonas reiškia AIŠKUMĄ ir KONKRETUMĄ formuluotėje — ne pretenziją į objektyvų, moksliškai patvirtintą tikrumą. Rašai ĮŽVALGĄ/INTERPRETACIJĄ, ne prognozę ar diagnozę. Tai NEKEIČIA nė vienos aukščiau ar žemiau esančios taisyklės dėl konkretumo, specifiškumo ar draudimo vartoti "gali būti"/"tikėtina" — sakiniai lieka tiesūs, aiškūs ir konkretūs; keičiasi tik tai, KAIP autorius (tu) supranti šių sakinių statusą, rašydamas juos
- DRAUDŽIAMA: "gali būti", "tikėtina", "galima manyti", "energija", "vibracija"
- DRAUDŽIAMA: minėti linijų pavadinimus ar delno anatomiją
- DRAUDŽIAMA: abstrakčios, bendrinės frazės kurios tiktų bet kuriam žmogui (pvz. "kiekvienas žmogus turi savo stiprybes", "gyvenimas kupinas iššūkių") — VISKAS turi būti konkretu ir asmeniška
- Rašyk taisyklinga, natūralia lietuvių kalba, kreipdamasis "tu" esamuoju laiku. Jei abejoji dėl retesnio žodžio formos, rinkis paprastesnį, tau gerai žinomą.
- Skaitytojo lytis nežinoma, tad geriau vengti aiškiai giminę turinčių žodžių apie jį (pvz. "pasirengęs", "laukdamas") — rink neutralią formą, kai natūraliai išeina.
- Rašyk taip, kaip natūraliai kalbėtų gimtakalbis lietuvis.
- Žodis "akcija" lietuviškai reiškia akcijų paketą/nuolaidą, NE "action" — naudok "veiksmas".
- Stiliaus lygis: VIDUTINIS — nei sudėtingas/knyginis/mokslinis, nei gatvės/šnekamosios kalbos stilius su žargonu. Rašyk taip, kaip protingas, kultūringas žmogus kalbėtų rimtame, bet šiltame pokalbyje
- DRAUDŽIAMA: sudėtingi, knyginiai, moksliniai ar oficialūs žodžiai (pvz. "manifestuoja", "transformacija", "potencialas" kaip terminas, "orientyras", "dinamika", "konsensusas" — vietoj jo "bendras sutarimas", "delegauti/delegavimas" — vietoj jo "perduoti kitiems", "faktorius" — vietoj jo "veiksnys", "kontempliacija" — vietoj jo "apmąstymas". BENDRA TAISYKLĖ (svarbesnė už šį sąrašą): šis sąrašas TIK ILIUSTRUOJA — jei parašai BET KOKĮ žodį, kurio nevartotum kalbėdamas su draugu prie kavos, PAKEISK jį paprastesniu, kasdieniu atitikmeniu, NET jei šio konkretaus žodžio sąraše nėra)
- DRAUDŽIAMA: gatvės stiliaus, žargoninė, per daug šnekamoji kalba, sutrumpinimai
- DRAUDŽIAMA žodis "galva" — jei reikia paminėti protą/mąstymą, naudok žodį "protas" (pvz. "tavo protas dirba greitai", ne "tavo galva dirba greitai")
- KRITIŠKAI SVARBU (JSON formatui): NIEKADA nenaudok tiesioginės kabutės simbolio " teksto viduje, nei akcentuojant žodį/frazę, nei kaip citatos ženklo — NET IR VIENĄ KARTĄ, nes tai sugadina JSON struktūrą. Jei nori pabrėžti ar "iškelti" žodį/frazę, naudok TIK paprastą kablelinę kabutę 'štai taip' (apostrofus), niekada ne „lietuviškas" ar tiesiogines dvigubas kabutes. Tai taikoma VISUR — visuose skyriuose ir insights laukuose.
- Kiekvienas žodis ir sakinys turi turėti prasmę ir svorį — jokių tuščių, niekuo neprisidedančių žodžių ar sakinio dalių
- PATIKRINIMAS KIEKVIENAM SAKINIUI: uždenk šį sakinį ranka ir paklausk savęs — "ar be šio sakinio skaitytojas prarastų KONKREČIĄ informaciją apie save, kurios negautų iš likusio teksto?" Jei atsakymas "ne" (t. y. sakinį galima išmesti be jokio informacijos praradimo) — IŠTRINK jį arba perrašyk taip, kad neštų naują faktą
- PAVYZDYS tuščio sakinio (IŠTRINTI, jei pasitaikytų): "Tai svarbi tavo asmenybės dalis, kuri formuoja tai, kas tu esi." — nieko konkretaus nepasako, galėtų sekti po BET KOKIO teiginio
- Kiekvienas sakinys privalo atskleisti KONKRETŲ, TIESIOGINĮ FAKTĄ apie šį žmogų — ne hipotetinį pavyzdį, scenarijų ar iliustraciją. Arba (a) atskleidžia NAUJĄ faktą, arba (b) tiesiogiai pagrindžia prieš tai buvusį faktą kitu konkrečiu faktu (ne pramanytu pavyzdžiu) — niekada tik "užpildyti vietą" ar pakartoti jau pasakytą mintį kitais žodžiais
- DRAUDŽIAMA: metaforos, palyginimai ("kaip...", "tarsi...", "panašiai kaip...", "lyg...") ir bendro pobūdžio, niekam konkrečiai netinkantys teiginiai (pvz. "gyvenimas kupinas galimybių", "viskas įmanoma, jei tik tiki savimi", "kiekviena diena – naujas puslapis"). Rašyk KONKREČIAI ir TIESIAI, be užuolankų ir be pritemptų palyginimų — kiekvienas sakinys turi būti toks specifiškas, kad iš karto būtų aišku, KĄ TIKSLIAI apie ŠĮ ŽMOGŲ jis sako, o ne tik skambiai nuskambėti
- DRAUDŽIAMA: ilgi, pernelyg susiraizgę, keliais šalutiniais sakiniais apkrauti sakiniai — rašyk aiškiais, tvirtais sakiniais
- Kiekvienas skyrius: 7–9 sakiniai, skyriai nesikartoja tarpusavyje
- KIEKVIENAME skyriuje žemiau nurodytos 3 potemių grupės — atskleisk visas 3, sklandžiu, natūraliu tekstu (ne sąrašu)

SKYRIAI — kiekvienas kalba tik apie savo temą ir atskleidžia 3 žemiau nurodytas potemių grupes:

- SVARBU (potemių aprašymai NĖRA sakinių šablonai): žemiau esančios (a), (b), (c) frazės tik NURODO TEMĄ — NEKOPIJUOK jų žodžių ir NEPRADĖK sakinių jų formuluotėmis. Kiekvieną mintį suformuluok NAUJAIS, natūraliais žodžiais apie ŠĮ žmogų — dviejų skirtingų žmonių tekstai neturi prasidėti tais pačiais sakiniais

- KRITIŠKAI SVARBU: skyriai NIEKADA nesikartoja tarpusavyje — nei ta pačia mintimi, nei tuo pačiu pavyzdžiu, nei kitais žodžiais perfrazuota ta pati esmė. Prieš rašydamas KIEKVIENĄ naują skyrių, peržiūrėk, KAS JAU BUVO PASAKYTA ankstesniuose skyriuose (charakterio bruožai, sėkmės formulė, kliūtys ir t. t.), ir įsitikink, kad šis skyrius atskleidžia TIK NAUJĄ, dar niekur šiame atsakyme nepaminėtą turinį. Jei pastebi, kad rašai apie tą pačią savybę/temą, kuri jau buvo I skyriuje (pvz. "analitinis protas"), PERRAŠYK sakinį apie ką nors kitą, atitinkantį TIK šio konkretaus skyriaus temą

- prigimtines_stiprybes (Prigimtinės stiprybės ir charakteris): (a) tavo unikalų asmenybės branduolį ir pamatinius, tave apibrėžiančius charakterio bruožus; (b) gilų vidinį/psichologinį portretą ir tai, kokia vidinė jėga/prigimtis tave veda; (c) tavo natūralų, įgimtą potencialą ir tai, kas konkrečiai tave išskiria iš kitų

- gyvenimo_tikslas (Gyvenimo kryptis ir tikslai): (a) kryptį, kuria natūraliai judi gyvenime, ir kas tave iš vidaus veda pirmyn; (b) giliau slypinčius tavo tikslus ir kryptį, kuria augi kaip asmenybė; (c) svarbiausius tavo gyvenimo kelio posūkius ir gaires, kurias sau keli ateičiai

- santykiai (Bendravimo būdas ir įtaka santykiams): (a) kaip kuri emocinį ryšį su kitais ir koks tavo bendravimo stilius; (b) kokį poveikį darai aplinkiniams ir pasikartojančius elgesio su žmonėmis modelius; (c) kaip sieki pusiausvyros santykiuose ir gebėjimą kurti gilų, ilgalaikį ryšį

- finansai (Finansinis potencialas): (a) kur/kaip tavo finansinė sėkmė labiausiai pasiekiama ir tavo potencialą kurti materialią gerovę; (b) kas tau natūraliai atveria finansines galimybes; (c) tavo karjeros/gerovės perspektyvas ir nepastebėtus, dar neišnaudotus finansinius talentus. Rašyk apie GALIMYBES ir POTENCIALĄ — ne apie tai, kaip leidi/taupai pinigus

- galimybes (Unikalus sėkmės raktas): SVARBU — šis skyrius NĖRA apie tai, KOKS žmogus esi (tai jau atskleista I skyriuje) — jis apie tai, KAIP PRAKTIŠKAI PANAUDOJI save, kad pasiektum rezultatų: (a) konkrečią STRATEGIJĄ ar veiksmų būdą, kuris tau labiausiai pasiteisina siekiant tikslų (ne charakterio bruožą, o VEIKSMĄ/METODĄ); (b) ką konkrečiai DARAI sunkiausiais momentais, kad įveiktum iššūkį (elgesys, ne savybė); (c) kokioje SITUACIJOJE ar aplinkybėse tau sekasi geriausiai, palyginti su kitais

- pokyciai (Svarbiausi artėjantys pokyčiai): SVARBU — šis skyrius NĖRA apie bendrą gyvenimo kryptį ar ilgalaikius tikslus (tai jau atskleista II skyriuje) — jis apie KONKREČIUS, ARTIMIAUSIU METU (ne apskritai ateityje) vyksiančius įvykius ar aplinkybių pasikeitimus: (a) koks konkretus, laiku apibrėžtas posūkis ar nauja galimybė artėja NETRUKUS (ne bendra kryptis, o konkretus artėjantis įvykis/situacija); (b) kokia IŠORINĖ aplinkybė ar situacija tavo gyvenime greitai pasikeis; (c) kokie KONKRETŪS ženklai (ne bendri jausmai) jau dabar rodo, kad ši permaina artėja

- klutys (Pažangą stabdančios kliūtys): (a) kokie tavo įpročiai ir nuostatos, kurių pats dažnai nepastebi, lėtina tavo pažangą; (b) kuri viena konkreti kliūtis šiuo metu labiausiai atitolina tave nuo tikslo; (c) ką tau verta paleisti, kad kelias pirmyn taptų lengvesnis

- stiprybes_sarasas: 5 savybių pavadinimai (2–4 žodžiai, konkretūs ir prasmingi)
- delnai_greta (Kairysis ir dešinysis delnas): ŠIS BLOKAS — VIENINTELĖ IŠIMTIS iš draudimo minėti linijas ir delno anatomiją: čia PRIVALAI trumpai įvardyti, KĄ matai. Chiromantijoje kairysis delnas rodo prigimtį (su kuo žmogus gimė), dešinysis — kokiu žmogus tapo dabar. Palygink TIKRUS skirtumus tarp ŠIŲ dviejų nuotraukų trijose srityse: sirdis (širdies linija — jausmai), protas (galvos linija — mąstymas), gyvenimas (gyvenimo linija — gyvenimo tempas ir jėgos). Kiekvienai sričiai: kairys ir desinys — po vieną frazę (iki 80 simbolių) formatu „trumpas, ką matai — ką tai reiškia“, „tu“ forma, pvz. kairys: „Ilga, švelniai lenkta — iš prigimties jausmus reiški atvirai“, desinys: „Tiesesnė ir ramesnė — dabar jausmus labiau saugai sau“. Jei kurioje srityje delnai beveik vienodi — taip ir parašyk (pvz. „Beveik tokia pati — šią savybę išlaikei nepakitusią“). Žodžio „galva“ nenaudok — rašyk „mąstymas“ ar „protas“. isvada: 2 sakiniai — ką žmogus per gyvenimą išsiugdė ar pakeitė, palyginus su prigimtimi (konkretu, šilta). LYTIS NEŽINOMA: šiame bloke (ir kairys/desinys frazėse) NIEKADA nerašyk giminę turinčių būdvardžių ar dalyvių apie žmogų — NE „buvai atviras/atvira“, „esi ramus“, „tapai santūresnis“, „gimęs“, „išmokęs“; VIETOJ jų — veiksmažodis + prieveiksmis: „iš prigimties jausmus reiškei atvirai“, „dabar elgiesi ramiau“, „tapo lengviau susivaldyti“
- Kiekvienam skyriui "_insights": 3 trumpi sakiniai (max 8 žodžiai) — NAUJI faktai kurie PAPILDO tekstą, tiksliai atitinkantys skyriaus temą, nesikartojantys su tekstu
- SVARBU (_insights formos nuoseklumas): kiekvienas "_insights" punktas PRIVALO būti "tu/tavo" forma, TA PAČIA kaip likęs tekstas — NIEKADA bendratimi ar trečiuoju asmeniu (KLAIDA: "Vengia paviršutiniškų pažinčių", "Siekia materialios sėkmės", "Pasitikėjimą užsitarnauti reikia laiko" — teisingai: "Vengi paviršutiniškų pažinčių", "Sieki materialios sėkmės" arba "Tavo siekis — materialinė sėkmė", "Pasitikėjimą užsitarnauji palaipsniui"). Jei natūraliau skamba daiktavardinė frazė su "tavo" (pvz. "Tavo lyderio pozicija natūralesnė"), tai irgi tinka — bet NIEKADA trečiojo asmens veiksmažodis (vengia/siekia/kuria/nustato) be "tu/tavo"

GALUTINIS PATIKRINIMAS PRIEŠ ATSAKANT (privalomas, be išimčių):
Prieš išvesdamas galutinį JSON, perskaityk KIEKVIENĄ savo parašytą sakinį iš naujo — skyrių tekstuose, _insights punktuose IR lentelės delnai_greta frazėse (kairys, desinys, isvada) — ir patikrink VISUS penkis klausimus kartu:
1. Ar šis sakinys (ar frazė) yra TIKSLUS, TIESIOGINIS FAKTAS apie ŠĮ konkretų žmogų (ne bendra tiesa, ne nuomonė, ne hipotezė, ne "gali būti")?
2. Ar šis sakinys AIŠKUS — suprantamas iš pirmo skaitymo, be dviprasmybių, be miglotų formuluočių?
3. Ar šis sakinys KONKRETUS — vidiniai pagrįstas tuo, kas realiai matoma ŠIUOSE delnuose (1 etapo vizualiniais parametrais), o ne bendrais chiromantijos štampais?
4. Ar šiame sakinyje NĖRA jokio TIESIOGINIO fizinio delno/pirštų/nykščio/odos požymio paminėjimo (pvz. "nykščio storis", "delno plotis", "pirštų ilgis")? Rašai TIK išvadą, ne fizinį aprašymą. (Vienintelė išimtis — delnai_greta kairys/desinys frazės, kur trumpai įvardyti, ką matai, PRIVALOMA.)
5. Ar šiame sakinyje NĖRA giminę turinčio dalyvio (pasirengęs/-usi, atradęs/-usi, likęs/-usi ir pan.)? Skaitytojo lytis nežinoma — naudok tik giminės neturinčias, asmenuojamas veiksmažodžio formas.
Jei BENT VIENAS atsakymas iš 1-5 yra "ne" — sakinys NETINKA. Arba ištrink jį, arba perrašyk taip, kad visi atsakymai būtų "taip", PRIEŠ tęsdamas toliau. JEI PERRAŠEI BENT VIENĄ SAKINĮ PATAISYDAMAS KLAIDĄ — prieš atiduodamas galutinį atsakymą, PERSKAITYK TĄ PATAISYTĄ SAKINĮ DAR KARTĄ NUO PRADŽIOS per visus 5 klausimus (pataisymas pats gali įnešti naują klaidą). Šis patikrinimas svarbesnis už bet kurią kitą taisyklę aukščiau — jei kyla konfliktas tarp "gražiai skamba" ir "tikslus/aiškus/konkretus/be fizinio aprašymo/lyčiai neutralus/taisyklingas faktas", VISADA rink antrąjį.

ATSAKYK TIKTAI JSON. Pradėk nuo {.

{"prigimtines_stiprybes":"7-9 sakiniai","prigimtines_insights":["Faktas 1","Faktas 2","Faktas 3"],"gyvenimo_tikslas":"7-9 sakiniai","gyvenimo_insights":["Faktas 1","Faktas 2","Faktas 3"],"santykiai":"7-9 sakiniai","santykiai_insights":["Faktas 1","Faktas 2","Faktas 3"],"finansai":"7-9 sakiniai","finansai_insights":["Faktas 1","Faktas 2","Faktas 3"],"pokyciai":"7-9 sakiniai","pokyciai_insights":["Faktas 1","Faktas 2","Faktas 3"],"galimybes":"7-9 sakiniai","galimybes_insights":["Faktas 1","Faktas 2","Faktas 3"],"stiprybes_sarasas":["Savybė 1","Savybė 2","Savybė 3","Savybė 4","Savybė 5"],"klutys":"7-9 sakiniai","klutys_insights":["Faktas 1","Faktas 2","Faktas 3"],"delnai_greta":{"sirdis":{"kairys":"...","desinys":"..."},"protas":{"kairys":"...","desinys":"..."},"gyvenimas":{"kairys":"...","desinys":"..."},"isvada":"2 sakiniai"}}`
    }
  ];

  let step2Data;
  // SVARBU: 'invalid_request_error' beveik VISADA yra NELAIKINA klaida
  // (pvz. pasiektas API naudojimo/išlaidų limitas, netinkamas užklausimo
  // formatas) — kartojant tą patį kvietimą gaunama LYGIAI TA PATI klaida,
  // tik švaistomas laikas (patvirtinta realiuose Deploy Logs: 3 bandymai,
  // visi su ta pačia "usage limits" klaida). Todėl ŠIO tipo klaidoms
  // NEBEBANDOME pakartotinai — iškart pasiduodame ir aiškiai užloginame.
  // Kitiems (tikrai laikiniems) tipams — 'overloaded_error', 'api_error',
  // 'rate_limit_error' ir trumpalaikiams tinklo trikdžiams — pakartotinis
  // bandymas prasmingas.
  const NON_RETRYABLE_ERROR_TYPES = ['invalid_request_error', 'authentication_error', 'permission_error'];
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      // SVARBU (laiko limitas): žingsnis 2 generuoja iki 10000 žetonų
      // atsakymą, tad jam skiriame ilgesnį limitą (150s) nei žingsniui 1
      // (90s, mažesnis atsakymas) — vis tiek pakankamai griežta riba, kad
      // "pakibusi" užklausa nekabotų amžinai, bet nenutrauktų realiai
      // vykstančio, tik lėtesnio generavimo per anksti.
      r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 12000,
          temperature: 0.2,
          messages: [
            { role: 'user', content: step2Content },
            { role: 'assistant', content: '{' }
          ]
        })
      }, 150000);
      step2Data = await r.json();
    } catch (networkErr) {
      // Trumpalaikis tinklo trikdis (fetch() pats metė klaidą) — taip
      // pat verta pakartoti, o ne iškart pasiduoti.
      console.log(`Žingsnis 2 tinklo klaida, bandymas ${attempt}/3: ${networkErr.message}`);
      step2Data = null;
      if (attempt < 3) { await new Promise(res => setTimeout(res, 3000 * attempt)); continue; }
      throw new Error('Tuščias Claude atsakymas (tinklo klaida)');
    }
    if (step2Data?.error) {
      console.log(`Žingsnis 2 klaida (${step2Data.error.type}: ${step2Data.error.message||''}), bandymas ${attempt}/3...`);
      if (NON_RETRYABLE_ERROR_TYPES.includes(step2Data.error.type)) {
        console.error(`[runPalmAnalysis] NELAIKINA klaida (${step2Data.error.type}) — pakartotinis bandymas praleidžiamas.`);
        break;
      }
      if (attempt < 3) { await new Promise(res => setTimeout(res, 3000 * attempt)); continue; }
    }
    break;
  }

  if (!step2Data || !step2Data.content || step2Data.content.length === 0) {
    // Diagnostikai: jei tai buvo API klaida (ne tiesiog netikėtai tuščias
    // atsakymas), užloginame TIKSLŲ jos tipą/pranešimą — anksčiau ši
    // informacija tiesiog dingdavo, o klaida atrodydavo nepaaiškinama.
    if (step2Data?.error) {
      console.error('[runPalmAnalysis] Žingsnis 2 galutinė klaida:', JSON.stringify(step2Data.error));
      // SVARBU: PERDUODAME tikslų API klaidos tipą/tekstą toliau (o NE
      // bendrą "Tuščias Claude atsakymas") — kitaip administratoriaus
      // klaidos laiške dingsta pati svarbiausia informacija (pvz., kad
      // baigėsi API kreditai ar negalioja raktas), ir problemą tenka
      // spėlioti vietoj to, kad ją iš karto pasakytų klaidos pranešimas.
      throw new Error(`${step2Data.error.type || 'API klaida'}: ${step2Data.error.message || 'Tuščias Claude atsakymas'}`);
    }
    throw new Error('Tuščias Claude atsakymas');
  }
  if (step2Data.stop_reason === 'max_tokens') throw new Error('Atsakymas nukirptas');

  const rawText = '{' + step2Data.content.map(b => b.text || '').join('');
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON nerastas');

  let result;
  try {
    result = parseJsonLenient(jsonMatch[0]);
  } catch (parseErr) {
    // Diagnostikai: parodome tekstą APLINK klaidos pozicijoje (ne visą —
    // kad log'ai liktų skaitomi), kad ateityje būtų galima tiksliai
    // nustatyti, KODĖL AI atsakymo JSON tapo neteisingas šioje vietoje.
    const posMatch = parseErr.message.match(/position (\d+)/);
    const pos = posMatch ? parseInt(posMatch[1], 10) : null;
    if (pos !== null) {
      const snippet = jsonMatch[0].slice(Math.max(0, pos - 150), pos + 150);
      console.error(`[runPalmAnalysis] JSON klaida ties pozicija ${pos}, tekstas aplink klaidą:\n---\n${snippet}\n---`);
    } else {
      console.error('[runPalmAnalysis] JSON klaida (be pozicijos), pirmi 500 simboliai:', jsonMatch[0].slice(0, 500));
    }
    throw parseErr;
  }
  if (!result || !result.prigimtines_stiprybes) throw new Error('Netinkamas rezultatas');
  sanitizeExtraResult(result);

  // ═══════════════════════════════════════════════════════════════════
  // 3 žingsnis (AI korektūra) PILNAI PAŠALINTAS (2026-09-24, vartotojo prašymu) —
  // jis pats kurdavo naujas klaidas (iškraipytus žodžius, neteisingą asmenį/giminę).
  // Tekstas eina tiesiai iš žingsnio 2 į deterministinį žodyno/regex saugiklį žemiau.

  // Galutinis, DETERMINISTINIS saugiklis — taikomas VISADA, nepriklausomai
  // nuo to, ar žingsnis 3 pavyko, ar ne (žr. KNOWN_GRAMMAR_FIXES aukščiau).
  applyKnownGrammarFixes(result);

  return result;
}

// Papildomi rezultato blokai (kairysis ir dešinysis delnas greta) —
// neprivalomi: jei AI juos pateikė netvarkingai, jie tiesiog nerodomi.
function sanitizeExtraResult(result) {
  const KEYS = ['santykiai', 'karjera', 'finansai', 'kuryba', 'intuicija', 'stiprybe'];
  const p = result.potencialas;
  if (p && typeof p === 'object' && KEYS.every(k => p[k] && Number.isFinite(Number(p[k].balas)))) {
    const out = {};
    for (const k of KEYS) out[k] = { balas: Math.max(55, Math.min(98, Math.round(Number(p[k].balas)))), fraze: typeof p[k].fraze === 'string' ? applyTextFixes(p[k].fraze.trim().slice(0, 160)).text : '' };
    result.potencialas = out;
  } else delete result.potencialas;
  delete result.planas;
  const dg = result.delnai_greta;
  const dgOk = v => typeof v === 'string' && v.trim().length > 3;
  if (dg && typeof dg === 'object' && ['sirdis', 'protas', 'gyvenimas'].every(k => dg[k] && dgOk(dg[k].kairys) && dgOk(dg[k].desinys))) {
    const fx = (t, n = 140) => applyTextFixes(t.trim().replace(/"/g, '').slice(0, n)).text;
    const out = {};
    for (const k of ['sirdis', 'protas', 'gyvenimas']) out[k] = { kairys: fx(dg[k].kairys), desinys: fx(dg[k].desinys) };
    if (dgOk(dg.isvada)) out.isvada = fx(dg.isvada, 400);
    result.delnai_greta = out;
  } else delete result.delnai_greta;
}

// --- ENDPOINT: Greita delno validacija ---
app.post('/validate-palm', sensitiveLimiter, async (req, res) => {
  try {
    const { photos, livePreview } = req.body;
    if (!photos || photos.length === 0) return res.json({ valid: false });
    if (!isValidPhotosArray(photos)) return res.status(400).json({ valid: false, reason: 'no_hand' });
    // ═══════════════════════════════════════════════════════════════════
    // DVIEJŲ ŽINGSNIŲ VALIDACIJA: AI grąžina TIK objektyvius, išmatuojamus
    // vizualinius faktus (kiek pirštų matosi, koks % delno matomas, ir t.t.)
    // — o YES/NO SPRENDIMĄ priima ŠIS KODAS pagal aiškias skaitines
    // taisykles (žr. PALM_VALIDATION_THRESHOLDS žemiau).
    // PRIEŽASTIS: ankstesnis variantas prašė modelio IŠKART atsakyti
    // vienu žodžiu (YES/NO) pagal subjektyvų "be reasonable" jausmą — dėl
    // to griežtumas nuolat svyravo (per griežta → atmesdavo geras
    // nuotraukas; per švelnu → praleisdavo pusę delno/trūkstamą pirštą).
    // Dabar, jei ateityje reikės koreguoti griežtumą, PAKANKA pakeisti
    // vieną skaičių žemiau (pvz. minPalmPercent), o NE perrašinėti
    // prompt'o žodžius ir spėlioti, kaip modelis juos interpretuos.
    // ═══════════════════════════════════════════════════════════════════
    const PALM_VALIDATION_THRESHOLDS = {
      minFingersVisible: 5,      // visi 5 pirštai (su nykščiu) turi būti matomi
      minPalmPercent: 65         // bent 65% delno paviršiaus turi būti kadre
    };

    const promptText = `Analyze this hand photo carefully and objectively. Do not decide pass/fail — just report what you observe as measurements.

IMPORTANT: Many rejected photos show only 1-2 fingers with most of the hand out of frame, or only a small sliver of palm. Do NOT assume a finger is present just because a hand is generally in the photo — you must actually see each specific finger to count it as visible. If you are unsure whether a finger is really there, mark it as NOT visible (false). Judge each finger separately and independently; do not let a general impression of "there's a hand here" inflate the count.

Reply with ONLY this JSON object, no other text, no markdown formatting:
{"thumb_visible": true|false, "index_visible": true|false, "middle_visible": true|false, "ring_visible": true|false, "pinky_visible": true|false, "palm_percent_visible": <integer 0-100>, "orientation": "palm" | "back" | "side", "fingertips_cropped": true | false, "hand_present": true | false}

Field definitions:
- {finger}_visible: true ONLY if that specific finger can be clearly seen and identified in the frame, from roughly its base to its tip. If most of a finger is out of frame or hidden, mark it false, even if you can see other fingers clearly.
- palm_percent_visible: your best estimate of what percentage of the total palm surface area is actually shown in the frame (0 = none visible, 100 = entire palm visible). If only a corner or sliver of the palm is in frame, this should be a LOW number (10-30), not a default like 50.
- orientation: "palm" if the palm (not back of hand) is facing the camera and reasonably flat to it; "side" if the hand is rotated showing mostly its edge; "back" if the back of the hand faces the camera.
- fingertips_cropped: true if any of the visible fingers has its tip genuinely cut off by the frame edge (not just close to it).
- hand_present: false if no hand is visible at all in the image.

Be precise and objective — do not round everything to convenient default numbers.`;

    const imageBlocks = photos.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data }
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 150,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: promptText }
          ]
        }]
      })
    });

    const data = await response.json();
    const rawAnswer = (data.content?.[0]?.text || '').trim();
    console.log('[validate-palm] raw:', JSON.stringify(rawAnswer));

    let facts = null;
    try {
      const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
      if (jsonMatch) facts = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[validate-palm] JSON parse klaida:', parseErr.message);
    }

    if (!facts) {
      // Modelis negrąžino tinkamo JSON — saugumo dėlei atmetame, kad
      // vartotojas galėtų iš karto bandyti dar kartą (ne kliūva be atsako).
      return res.json({ valid: false, reason: 'no_hand' });
    }

    console.log('[validate-palm] facts:', JSON.stringify(facts));

    const fingersVisibleCount = ['thumb_visible','index_visible','middle_visible','ring_visible','pinky_visible']
      .reduce((count, key) => count + (facts[key] === true ? 1 : 0), 0);

    let valid = true;
    let reason = null;

    if (facts.hand_present === false) {
      valid = false; reason = 'no_hand';
    } else if (facts.orientation === 'back') {
      valid = false; reason = 'no_hand';
    } else if (facts.orientation === 'side') {
      valid = false; reason = 'sideways';
    } else if (fingersVisibleCount < PALM_VALIDATION_THRESHOLDS.minFingersVisible || facts.fingertips_cropped === true) {
      valid = false; reason = 'fingers_missing';
    } else if ((facts.palm_percent_visible ?? 0) < PALM_VALIDATION_THRESHOLDS.minPalmPercent) {
      valid = false; reason = 'low_palm_visibility';
    } else if ((facts.palm_percent_visible ?? 0) >= 95 && fingersVisibleCount === 5) {
      // Papildoma euristika "too_close" atvejui: jei delnas užima visą kadrą
      // (labai aukštas % + visi pirštai vos telpa), tikėtina kad per arti.
      // Paliekama valid=true čia — modelis šio atvejo tiksliau nepraneša per
      // šiuos laukus, todėl "too_close" toliau tikrinamas kliento pusėje
      // (skin-area canvas patikra prieš siunčiant į šį endpoint'ą).
    }

    console.log('[validate-palm] rezultatas: valid=', valid, 'reason=', reason);
    res.json({ valid, reason });
  } catch(e) {
    console.error('validate-palm klaida:', e.message);
    res.json({ valid: false });
  }
});

// --- ENDPOINT: Paleisti foninę analizę ---
app.post('/start-analysis', sensitiveLimiter, async (req, res) => {
  try {
    const { photos, sessionId } = req.body;
    console.log(`[start-analysis] gauta sessionId=${sessionId||'(nėra)'} photos=${photos?photos.length:0}`);
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });
    if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });
    if (typeof sessionId !== 'string' || sessionId.length > 200) return res.status(400).json({ error: 'Neteisingas sessionId' });
    if (!isValidPhotosArray(photos)) return res.status(400).json({ error: 'Neteisingas nuotraukų formatas' });

    if (analysisCache.has(sessionId)) {
      console.log(`[start-analysis] sessionId=${sessionId} JAU YRA cache (dublikatas), grąžinam started:true be naujo paleidimo`);
      return res.json({ started: true, sessionId });
    }

    const newEntry = {
      status: 'pending',
      result: null,
      error: null,
      photos,
      name: req.body.name || '',
      createdAt: Date.now()
    };
    analysisCache.set(sessionId, newEntry);
    saveAnalysisSessionToDisk(sessionId, newEntry);
    console.log(`[start-analysis] sessionId=${sessionId} UŽREGISTRUOTAS cache'e (status=pending), cacheSize=${analysisCache.size}`);

    res.json({ started: true, sessionId });

    runPalmAnalysis(photos, req.body.name || '', sessionId)
      .then(result => {
        const entry = analysisCache.get(sessionId);
        if (entry) { entry.status = 'done'; entry.result = result; saveAnalysisSessionToDisk(sessionId, entry); console.log(`[start-analysis] sessionId=${sessionId} FONO ANALIZĖ BAIGTA sėkmingai`); }
        else console.log(`[start-analysis] sessionId=${sessionId} FONO ANALIZĖ baigta, BET cache įrašo BENĖRA (?!)`);
      })
      .catch(err => {
        const entry = analysisCache.get(sessionId);
        if (entry) { entry.status = 'error'; entry.error = err.message; saveAnalysisSessionToDisk(sessionId, entry); }
        console.log(`[start-analysis] sessionId=${sessionId} FONO ANALIZĖ KLAIDA: ${err.message}`);
      });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT: Analizės statusas ---
app.get('/analysis-status', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });
  const entry = analysisCache.get(sessionId);
  if (!entry) return res.json({ status: 'notfound' });
  res.json({ status: entry.status });
});

// --- ENDPOINT: Gauti analizės rezultatą ---
// --- Checkout sesija Revolut/Klarna ---
// ═══════════════════════════════════════════════════════════════════
// PASIŪLYMAS PRIE MOKĖJIMO („Klausk savo delnų“ su nuolaida) IR
// REKOMENDACIJŲ PROGRAMA (draugo nuoroda: −20 % draugui, 3 klausimai kvietėjui)
// ═══════════════════════════════════════════════════════════════════
// Suma VISADA skaičiuojama serveryje — klientas siunčia tik pasirinkimus.
const KLAUSK_BUMP_CENTS = parseInt(process.env.KLAUSK_BUMP_CENTS || '299', 10);
const REF_DISCOUNT_PCT = parseInt(process.env.REF_DISCOUNT_PCT || '20', 10);
const REF_MAX_REWARDS = 5;
const REFS_FILE = path.join(SHARED_STORAGE_DIR, 'refs.json');
function loadRefs() {
  try { if (fs.existsSync(REFS_FILE)) { const d = JSON.parse(fs.readFileSync(REFS_FILE, 'utf8')); return { codes: d.codes || {}, byPayment: d.byPayment || {} }; } }
  catch (e) { console.error('[ref] nepavyko nuskaityti refs.json:', e.message); }
  return { codes: {}, byPayment: {} };
}
function saveRefs(st) { const tmp = REFS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st, null, 2)); fs.renameSync(tmp, REFS_FILE); }
// Rekomendacijų įrašai (su analizės tekstu atlygiui) saugomi 12 mėn.
(function cleanupRefs() {
  try {
    const st = loadRefs(), cutoff = Date.now() - 365 * 864e5; let ch = false;
    for (const [c, r] of Object.entries(st.codes)) if ((r.createdAt || 0) < cutoff) { delete st.codes[c]; if (st.byPayment[r.paymentRef] === c) delete st.byPayment[r.paymentRef]; ch = true; }
    if (ch) saveRefs(st);
  } catch (e) {}
})();
function normalizeRefCode(c) { return typeof c === 'string' ? c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : ''; }
// Galiojantis kodas, kuris nepriklauso pačiam pirkėjui
function validRef(code, email) {
  const c = normalizeRefCode(code); if (c.length < 5) return null;
  const r = loadRefs().codes[c]; if (!r) return null;
  if (email && r.email && r.email.toLowerCase() === String(email).toLowerCase()) return null;
  return c;
}
async function computeOrderAmount({ ref, addKlausk, email, promo, bundle }) {
  const activePrice = await stripe.prices.retrieve(ACTIVE_PRICE_ID);
  const base = activePrice.unit_amount, currency = activePrice.currency;
  let refCode = validRef(ref, email);
  const refDiscount = refCode ? Math.round(base * REF_DISCOUNT_PCT / 100) : 0;
  // Nuolaidos nesumuojamos — taikoma didesnė (draugo arba asmeninis kodas)
  const pr = getValidPromo(promo, 'asmenine');
  const promoDiscount = pr ? base - promoAmount(pr, base) : 0;
  let discount = refDiscount, promoCode = null, discountLabel = refCode ? `🎁 Draugo dovana −${REF_DISCOUNT_PCT} %` : '';
  if (promoDiscount > 0 && promoDiscount >= refDiscount) { discount = promoDiscount; promoCode = pr.code; refCode = null; discountLabel = promoTag(pr); }
  const bump = addKlausk ? KLAUSK_BUMP_CENTS : 0;
  const bundleCents = bundle ? PORA_BUNDLE_CENTS : 0;
  return { base, discount, bump, bundle: bundleCents, total: base - discount + bump + bundleCents, currency, refCode, promoCode, promoKind: pr && promoCode ? pr.kind : null, discountLabel };
}
// Patikrina apmokėtą asmeninės analizės mokėjimą (PaymentIntent arba Checkout)
async function getPaidAnalysisPayment(paymentRef) {
  if (typeof paymentRef !== 'string' || paymentRef.length > 200) return null;
  if (paymentRef.startsWith('pi_')) {
    const pi = await stripe.paymentIntents.retrieve(paymentRef);
    if (!pi || pi.status !== 'succeeded') return null;
    return { metadata: pi.metadata || {}, email: (pi.metadata && pi.metadata.email) || pi.receipt_email || '' };
  }
  if (paymentRef.startsWith('cs_')) {
    const s = await stripe.checkout.sessions.retrieve(paymentRef);
    if (!s || s.payment_status !== 'paid' || (s.metadata && s.metadata.type)) return null;
    return { metadata: s.metadata || {}, email: (s.metadata && s.metadata.email) || s.customer_email || '' };
  }
  return null;
}
// Apmokėtas užsakymas su draugo kodu → kvietėjui dovanojami 3 klausimai (vieną kartą už pirkimą)
function rewardReferrer(refCode, paymentRef, buyerEmail) {
  try {
    const st = loadRefs(), r = st.codes[refCode];
    if (!r || !paymentRef) return;
    if ((r.uses || []).some(u => u.paymentRef === paymentRef)) return;
    if (buyerEmail && r.email && r.email.toLowerCase() === String(buyerEmail).toLowerCase()) return;
    r.uses = r.uses || [];
    let rewardId = null;
    if (r.uses.filter(u => u.rewardId).length < REF_MAX_REWARDS && r.result) {
      rewardId = 'kp_' + crypto.randomBytes(12).toString('hex');
      const orders = loadKlauskOrders();
      orders[rewardId] = { email: r.email, name: r.name || '', result: r.result, qa: [], paid: true, paidAt: Date.now(), amount: 0, reward: refCode, createdAt: Date.now() };
      saveKlauskOrders(orders);
      mailer.sendMail({
        from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
        to: r.email,
        subject: '🎁 Tavo kvietimu pasinaudota — dovanojame 3 klausimus',
        html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:28px;margin-bottom:8px">🎁</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:10px">Ačiū, kad pakvietei draugą!</div><p style="font-size:15px;line-height:1.7;color:rgba(245,238,216,.85);margin:0 0 18px">Tavo draugas atliko delnų analizę su tavo nuoroda. Dovanojame tau <b style="color:#f0d58a">3 asmeninius klausimus</b> — atsakymai rems tavo delnų analize.</p><a href="${appBaseUrl()}/klausk?s=${rewardId}" style="display:inline-block;background:#d4a843;color:#140f02;text-decoration:none;padding:14px 26px;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">Užduoti klausimus →</a>${EMAIL_FOOTER_HTML}</div>`
      }).catch(e => console.error('[ref] atlygio laiško klaida:', e.message));
    }
    r.uses.push({ paymentRef, at: Date.now(), rewardId });
    saveRefs(st);
    console.log(`[ref] kodas ${refCode} panaudotas (${paymentRef})${rewardId ? ' → atlygis ' + rewardId : ''}`);
  } catch (e) { console.error('[ref] atlygio klaida:', e.message); }
}
const _paidCounted = new Set();
function handlePaidAnalysis(paymentRef, metadata, email) {
  if (!_paidCounted.has(paymentRef)) {
    _paidCounted.add(paymentRef); statInc('paid');
    if (metadata && metadata.addKlausk === '1') statInc('bump');
    if (metadata && metadata.ref) statInc('ref_paid');
  }
  if (metadata && metadata.ref) rewardReferrer(normalizeRefCode(metadata.ref), paymentRef, email);
  if (metadata && metadata.promo) markPromoUsed(metadata.promo, paymentRef);
  if (metadata && metadata.bundle === '1') issueBundleGift(paymentRef, isValidEmail(email) ? email : '', metadata.name || '');
  markEmailPaid(email);
}

// Kaina prieš mokėjimą (rodoma ekrane ir Apple/Google Pay lange — turi sutapti su nuskaitoma suma)
app.post('/order-quote', sensitiveLimiter, async (req, res) => {
  try {
    const { ref, addKlausk, email, promo, bundle } = req.body || {};
    const q = await computeOrderAmount({ ref, addKlausk: !!addKlausk, email: isValidEmail(email) ? email : '', promo, bundle: !!bundle });
    res.json({ ...q, bumpCents: KLAUSK_BUMP_CENTS, klauskCents: KLAUSK_PRICE_CENTS, refPct: REF_DISCOUNT_PCT, bundleCents: PORA_BUNDLE_CENTS, poraCents: PORA_PRICE_CENTS });
  } catch (err) {
    console.error('/order-quote klaida:', err);
    res.status(503).json({ error: 'Nepavyko gauti kainos' });
  }
});

// Ar mokėjime buvo pridėtas „Klausk“ priedas ir ar jau sukurtas klausimų užsakymas
// Dovanų kuponas su įskaičiuotais klausimais: ref „gift:KODAS“ → panaudota asmeninė dovana su klausk
function giftKlausk(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('gift:') || ref.length > 40) return null;
  const g = loadGiftStore().codes[ref.slice(5)];
  return g && g.klausk && g.kind !== 'pora' && g.status === 'redeemed' ? g : null;
}
// Porų dovana su įskaičiuotais klausimais → klausimų užsakymas porai (kp_…), vieną kartą
app.post('/klausk/pora-gift', sensitiveLimiter, (req, res) => {
  try {
    const poraSid = req.body && req.body.poraSid;
    if (typeof poraSid !== 'string' || !/^gp_[a-f0-9]{24}$/.test(poraSid)) return res.status(400).json({ error: 'Neteisingas užsakymas' });
    const po = loadPoraOrders()[poraSid];
    const g = po && po.gift ? loadGiftStore().codes[po.gift] : null;
    if (!g || !g.klausk) return res.json({ id: null });
    if (po.status !== 'done' || !po.result) return res.status(400).json({ error: 'Porų analizė dar neparuošta' });
    const orders = loadKlauskOrders();
    const existing = Object.entries(orders).find(([, o]) => o.poraSid === poraSid && o.gift);
    if (existing) return res.json({ id: existing[0] });
    const id = 'kp_' + crypto.randomBytes(12).toString('hex');
    orders[id] = { kind: 'pora', email: po.email, name: `${po.nameA} ir ${po.nameB}`, nameA: po.nameA, nameB: po.nameB, poraSid, result: po.result, qa: [], paid: true, paidAt: Date.now(), amount: 0, gift: po.gift, createdAt: Date.now() };
    saveKlauskOrders(orders);
    res.json({ id });
  } catch (err) {
    console.error('/klausk/pora-gift klaida:', err);
    res.status(500).json({ error: 'Nepavyko atidaryti klausimų' });
  }
});
app.get('/order-extras', sensitiveLimiter, async (req, res) => {
  try {
    const ref = req.query.ref;
    const gk = giftKlausk(ref);
    if (gk) { const ex = Object.entries(loadKlauskOrders()).find(([, o]) => o.paymentRef === ref); return res.json({ addKlausk: true, gift: true, klauskId: ex ? ex[0] : null }); }
    const p = await getPaidAnalysisPayment(ref);
    if (!p) return res.json({ addKlausk: false });
    const existing = Object.entries(loadKlauskOrders()).find(([, o]) => o.paymentRef === ref);
    res.json({ addKlausk: p.metadata.addKlausk === '1', klauskId: existing ? existing[0] : null });
  } catch (err) { res.json({ addKlausk: false }); }
});

// Su analize apmokėti klausimai → klausimų užsakymas (kp_…), vieną kartą
app.post('/klausk/claim', sensitiveLimiter, async (req, res) => {
  try {
    const { paymentRef, result } = req.body || {};
    const gk = giftKlausk(paymentRef);
    const p = gk ? { email: gk.redeemedEmail || '', metadata: { addKlausk: '1', name: gk.redeemedName || '' } } : await getPaidAnalysisPayment(paymentRef);
    if (!p || p.metadata.addKlausk !== '1') return res.status(403).json({ error: 'Klausimai šiame užsakyme neapmokėti' });
    const orders = loadKlauskOrders();
    const existing = Object.entries(orders).find(([, o]) => o.paymentRef === paymentRef);
    if (existing) return res.json({ id: existing[0] });
    const picked = pickKlauskResult(result);
    if (!picked) return res.status(400).json({ error: 'Nerasta asmeninė analizė. Atnaujinkite rezultato puslapį.' });
    const id = 'kp_' + crypto.randomBytes(12).toString('hex');
    orders[id] = { email: p.email, name: p.metadata.name || '', result: picked, qa: [], paid: true, paidAt: Date.now(), amount: gk ? 0 : KLAUSK_BUMP_CENTS, gift: gk ? gk.code : undefined, paymentRef, createdAt: Date.now() };
    saveKlauskOrders(orders);
    res.json({ id });
  } catch (err) {
    console.error('/klausk/claim klaida:', err);
    res.status(500).json({ error: 'Nepavyko atidaryti klausimų' });
  }
});

// Asmeninė draugo nuoroda (sukuriama apmokėjusiam klientui, vieną kartą mokėjimui)
app.post('/ref/create', sensitiveLimiter, async (req, res) => {
  try {
    const { paymentRef, result } = req.body || {};
    const st = loadRefs();
    if (st.byPayment[paymentRef] && st.codes[st.byPayment[paymentRef]]) {
      const c = st.byPayment[paymentRef];
      return res.json({ code: c, link: `${appBaseUrl()}/?ref=${c}`, pct: REF_DISCOUNT_PCT });
    }
    const p = await getPaidAnalysisPayment(paymentRef);
    if (!p || !isValidEmail(p.email)) return res.status(403).json({ error: 'Nuoroda galima tik apmokėjusiems klientams' });
    let code;
    for (let i = 0; i < 20; i++) { let c = ''; for (let j = 0; j < 6; j++) c += GIFT_CODE_ALPHABET[crypto.randomInt(GIFT_CODE_ALPHABET.length)]; if (!st.codes[c]) { code = c; break; } }
    if (!code) throw new Error('Nepavyko sugeneruoti kodo');
    st.codes[code] = { email: p.email, name: p.metadata.name || '', paymentRef, result: pickKlauskResult(result), uses: [], createdAt: Date.now() };
    st.byPayment[paymentRef] = code;
    saveRefs(st);
    res.json({ code, link: `${appBaseUrl()}/?ref=${code}`, pct: REF_DISCOUNT_PCT });
  } catch (err) {
    console.error('/ref/create klaida:', err);
    res.status(500).json({ error: 'Nepavyko sukurti nuorodos' });
  }
});

app.post('/create-checkout', sensitiveLimiter, async (req, res) => {
  try {
    const { email, name, bgSessionId, orderNumber } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (bgSessionId && (typeof bgSessionId !== 'string' || bgSessionId.length > 200)) return res.status(400).json({ error: 'Neteisingas bgSessionId' });
    if (orderNumber && !isValidOrderNumber(orderNumber)) return res.status(400).json({ error: 'Neteisingas orderNumber formatas' });

    const q = await computeOrderAmount({ ref: req.body.ref, addKlausk: !!req.body.addKlausk, email, promo: req.body.promo, bundle: !!req.body.bundle });
    // Be nuolaidos ir priedų — kaip anksčiau (Stripe kaina); kitu atveju — apskaičiuotos eilutės
    const lineItems = (!q.discount && !q.bump && !q.bundle) ? [{ price: ACTIVE_PRICE_ID, quantity: 1 }] : [
      { price_data: { currency: q.currency, unit_amount: q.base - q.discount, product_data: { name: q.discount ? `DELNAS — Gyvenimo žemėlapis (${q.promoCode ? 'nuolaida' : `draugo nuolaida −${REF_DISCOUNT_PCT} %`})` : 'DELNAS — Gyvenimo žemėlapis' } }, quantity: 1 },
      ...(q.bump ? [{ price_data: { currency: q.currency, unit_amount: q.bump, product_data: { name: 'Klausk savo delnų — 3 klausimai' } }, quantity: 1 }] : []),
      ...(q.bundle ? [{ price_data: { currency: q.currency, unit_amount: q.bundle, product_data: { name: 'Porų suderinamumas (rinkinio kaina)' } }, quantity: 1 }] : [])
    ];
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['revolut_pay'],
      line_items: lineItems,
      mode: 'payment',
      locale: 'lt',
      customer_email: email,
      // SVARBU: bgSessionId ir orderNumber saugomi ČIA, Stripe pusėje —
      // kai vartotojas peradresuojamas per Stripe Checkout (Revolut Pay) ir
      // grįžta atgal, naršyklės sessionStorage KAI KADA "pamiršta" šiuos
      // duomenis (ypač iOS Safari, dėl griežtos tarpsvetaininės apsaugos).
      // Stripe metadata yra PATIKIMAS, serverio pusės šaltinis, nepriklausantis
      // nuo naršyklės saugyklos elgsenos.
      metadata: { name: name || '', email, bgSessionId: bgSessionId || '', orderNumber: orderNumber || '', addKlausk: q.bump ? '1' : '', ref: q.refCode || '', promo: q.promoCode || '', bundle: q.bundle ? '1' : '' },
      success_url: `https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/`
    });
    
    res.json({ url: session.url });
  } catch(err) {
    console.error('/create-checkout klaida:', err);
    res.status(500).json({ error: err.message });
  }
});

// PASTABA: anksčiau čia buvo funkcija sendResultEmail(), likusi iš laikų
// prieš Resend integraciją — ji NESIUSDAVO laiško, o tiesiog įrašydavo
// kliento el. paštą, vardą IR analizės rezultatą į vietinį failą
// (email_queue.json). Ji NIEKUR nebuvo kviečiama (negyvas kodas), bet
// galėjo kelti riziką (asmens duomenys serverio faile be jokio realaus
// tikslo) — pašalinta (2026-08) dėl tos pačios priežasties, dėl kurios
// anksčiau pašalinti /share-result ir /store-pdf endpoint'ai: duomenų
// kiekio mažinimo principas (BDAR 5(1)(c) str.).

// Atnaujinti sesijos vardą ir el. paštą
app.post('/update-session-name', sensitiveLimiter, (req, res) => {
  const { sessionId, name, email } = req.body;
  if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
  if (sessionId && analysisCache.has(sessionId)) {
    const entry = analysisCache.get(sessionId);
    entry.name = name || entry.name;
    entry.email = email || entry.email;
  }
  res.json({ ok: true });
});

// Vartotojas ką tik įvedė vardą + el. paštą (dar prieš mokėjimą) —
// sugeneruojame ir laikinai išsaugome vienetinį užsakymo numerį.
app.post('/register-order', sensitiveLimiter, (req, res) => {
  try {
    const { name, email } = req.body;
    if (!isValidName(name) || !isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas vardas arba el. paštas' });
    const orderNumber = generateOrderNumber();
    pendingOrders.set(orderNumber, { name, email, createdAt: Date.now(), notified: false });
    savePendingOrdersToDisk(pendingOrders);
    // Vienas priminimas, jei mokėjimas nebus baigtas (nebent žmogus paspaudė „Nesiųsti“)
    if (req.body.remind === true) noteAbandonCandidate({ kind: 'asmenine', email, name, orderNumber });
    console.log(`[register-order] sukurtas ${orderNumber} (${name}, ${email})`);
    res.json({ orderNumber });
  } catch (err) {
    console.error('[register-order] klaida:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atidarius rezultato ekraną, klientas iškviečia šį endpoint'ą.
// PASTABA (pakeitimas): administratoriui (info@) apie šį užsakymą JAU
// išsiųstas VIENINTELIS pranešimas — žr. sendPaymentSuccessEmails() aukščiau,
// kuri iškviečiama IŠ KARTO po sėkmingo mokėjimo ir turi pilną kliento
// informaciją (vardą, el. paštą, užsakymo numerį, sumą). Kad į info@
// nebūtų siunčiami DU laiškai apie tą patį užsakymą, čia administracinis
// laiškas NEBESIUNČIAMAS — šis endpoint'as dabar tik išvalo laikiną įrašą
// iš atminties (nebereikia jo saugoti, kai rezultato ekranas jau atidarytas).
app.post('/notify-order-complete', sensitiveLimiter, async (req, res) => {
  try {
    const { orderNumber } = req.body;
    if (!isValidOrderNumber(orderNumber)) return res.status(400).json({ error: 'Neteisingas orderNumber formatas' });
    const existed = pendingOrders.delete(orderNumber);
    if (existed) savePendingOrdersToDisk(pendingOrders);
    console.log(`[notify-order-complete] ${orderNumber} — įrašas ${existed ? 'ištrintas iš atminties' : 'nerastas (jau ištrintas arba pasenęs)'} (administracinis laiškas jau išsiųstas anksčiau, žr. sendPaymentSuccessEmails)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify-order-complete] klaida:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATAISYMAS (2026-09-26): jei klientui rezultatų ekrane BUVO parodytas
// atsiprašymo/klaidos pranešimas (t.y. analizė užtruko neįprastai ilgai —
// žr. 15s/45s pranešimus kliento pusėje), BET analizė VIS DĖLTO vėliau
// sėkmingai baigėsi ir klientas gavo savo rezultatą — administratorius
// (info@) vis tiek apie tai informuojamas (su [KLAIDA] žyme temoje), kad
// žinotų, jog PROBLEMA BUVO, net jei ji galiausiai išsisprendė pati, o
// klientas rezultatą gavo. Tai leidžia sekti tokius atvejus ir, jei jie
// kartojasi, ieškoti gilesnės priežasties.
function logRecoveredAfterDelay({ name, email, sessionId, orderNumber }) {
  try {
    mailer.sendMail({
      from: `"Delno Skaitymas — Sistema" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `[KLAIDA] Klientas GAVO rezultatą, bet po vėlavimo/klaidos`,
      html: `<div style="font-family:Georgia,serif;padding:20px">
        <h2 style="color:#a07828">Analizė užtruko/rodė klaidą, bet GALIAUSIAI sėkmingai baigėsi</h2>
        <p><strong>Vardas:</strong> ${escapeHtml(name || '(nežinoma)')}</p>
        <p><strong>El. paštas:</strong> ${escapeHtml(email || '(nežinomas)')}</p>
        <p><strong>Užsakymo numeris:</strong> ${escapeHtml(orderNumber || '(nėra)')}</p>
        <p>Klientui rezultatų ekrane BUVO parodytas atsiprašymo/klaidos pranešimas (analizė užtruko ilgiau nei 45s), BET analizė vis dėlto vėliau sėkmingai baigėsi ir klientas GAVO savo rezultatą. Papildomai susisiekti su klientu NEBŪTINA — bet verta stebėti, ar tokie atvejai nesikartoja per dažnai (tai rodytų nuolatinę, o ne vienkartinę problemą).</p>
      </div>`
    }).then(() => console.log(`[logRecoveredAfterDelay] laiškas išsiųstas į ${ADMIN_EMAIL} (orderNumber=${orderNumber||'?'}, sessionId=${sessionId||'?'})`))
      .catch(e => console.error('[logRecoveredAfterDelay] klaida siunčiant laišką:', e.message));
  } catch (e) {
    console.error('[logRecoveredAfterDelay] bendra klaida:', e.message);
  }
}

app.post('/notify-recovered-after-error', sensitiveLimiter, async (req, res) => {
  try {
    const { name, email, sessionId, orderNumber } = req.body;
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (sessionId && (typeof sessionId !== 'string' || sessionId.length > 200)) return res.status(400).json({ error: 'Neteisingas sessionId' });
    if (orderNumber && !isValidOrderNumber(orderNumber)) return res.status(400).json({ error: 'Neteisingas orderNumber formatas' });
    logRecoveredAfterDelay({ name, email, sessionId, orderNumber });
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify-recovered-after-error] klaida:', err);
    res.status(500).json({ error: err.message });
  }
});

// Klientas iškviečia šį endpoint'ą TIKSLIAI TADA, kai atsidaro rezultato
// ekranas — PDF (sugeneruotas kliento pusėje, tas pats, kaip "Atsisiųsti
// PDF" mygtukas) išsiunčiamas į vartotojo el. paštą iš
// info@delnaskaitymas.lt (CLIENT_EMAIL_FROM).
// SVARBU (pakeitimas): šis laiškas dabar yra VIENINTELIS, kurį klientas
// gauna — jame sujungtas IR užsakymo patvirtinimas (antraštė + užsakymo
// numeris), IR PDF failas. Anksčiau tai buvo DU atskiri laiškai (vienas
// iš karto po mokėjimo su tekstu "atsiųsime PDF vėliau", kitas su pačiu
// PDF) — tai kūrė nereikalingą trintį, "email fatigue" jausmą ir riziką,
// kad vienas iš dviejų laiškų patenka į Spam, o klientas susirūpinęs
// rašo į palaikymo tarnybą.
app.post('/email-result-pdf', sensitiveLimiter, async (req, res) => {
  try {
    const { email, name, orderNumber, pdfBase64, gift } = req.body;
    const isGift = gift === true;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. paštas' });
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (orderNumber && !isValidOrderNumber(orderNumber)) return res.status(400).json({ error: 'Neteisingas orderNumber formatas' });
    if (typeof pdfBase64 !== 'string' || pdfBase64.length === 0 || pdfBase64.length > 15_000_000) {
      return res.status(400).json({ error: 'Neteisingas arba per didelis PDF turinys' });
    }
    // Papildoma apsauga: jei šis TIKSLUS užsakymo numeris jau kartą gavo
    // PDF laišką (pvz. dėl naršyklės atnaujinimo su tuo pačiu session_id
    // URL adrese), NEBEsiunčiame antro egzemplioriaus. Grąžiname "ok",
    // kad klientas nematytų klaidos — laiškas juk jau realiai nuėjo.
    if (orderNumber && sentPdfEmailsForOrder.has(orderNumber)) {
      console.log(`[email-result-pdf] praleista — laiškas šiam užsakymui (${orderNumber}) jau išsiųstas anksčiau.`);
      return res.json({ ok: true, alreadySent: true });
    }
    if (orderNumber) sentPdfEmailsForOrder.add(orderNumber);
    await mailer.sendMail({
      from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
      to: email,
      subject: isGift
        ? `${name ? ltPhrase(name, 'voc') + ', tavo' : 'Tavo'} dovana paruošta: gyvenimo žemėlapis pagal delnus 🎁`
        : `${name ? ltPhrase(name, 'voc') + ', tavo' : 'Tavo'} gyvenimo žemėlapis paruoštas ✦ Mokėjimas gautas`,
      html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:22px"><div style="font-size:26px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:12px">${isGift ? '🎁 Tavo dovana atkeliavo' : 'Mokėjimas gautas, ačiū'}${name ? ', ' + escapeHtml(name) : ''}!</div><div style="font-size:15px;color:rgba(245,238,216,.85)">Tavo asmeninis gyvenimo žemėlapis paruoštas!</div></div>${orderNumber ? `<div style="text-align:center;margin-bottom:20px"><p style="font-size:14px;line-height:1.4;margin:0 0 5px">Tavo užsakymo numeris:</p><p style="font-size:18px;font-weight:700;color:#d4a843;letter-spacing:.05em;margin:0">${escapeHtml(orderNumber)}</p></div>` : ''}<p style="font-size:14px;line-height:1.7;color:rgba(245,238,216,.8);text-align:center;margin:0 0 4px">Pridėtame PDF faile rasi pilną savo gyvenimo žemėlapį.</p><div style="text-align:center;margin:22px 0 0"><p style="font-size:13px;line-height:1.6;color:rgba(245,238,216,.75);margin:0 0 10px">Patiko? Padovanok ir artimam žmogui:</p><a href="${appBaseUrl()}/dovana?utm_source=email&amp;utm_campaign=rezultatas" style="display:inline-block;border:1px solid #d4a843;border-radius:999px;padding:10px 20px;color:#d4a843;font-size:14px;font-weight:700;text-decoration:none">🎁 Padovanok gyvenimo žemėlapį →</a><p style="font-size:12px;margin:10px 0 0"><a href="${appBaseUrl()}/dovana?utm_source=email&amp;utm_campaign=rezultatas" style="color:#d4a843;text-decoration:underline">www.delnaskaitymas.lt/dovana</a></p></div>${EMAIL_FOOTER_HTML}</div>`,
      attachments: [{
        filename: name ? `${name.replace(/\s+/g, '-')}-gyvenimo-zemelapis.pdf` : 'gyvenimo-zemelapis.pdf',
        content: pdfBase64,
        encoding: 'base64'
      }]
    });
    console.log(`[email-result-pdf] PDF (su užsakymo patvirtinimu) išsiųstas į ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[email-result-pdf] klaida:', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/analyze-palm', sensitiveLimiter, async (req, res) => {
  try {
    const { photos, name, email, token, sessionId, orderNumber } = req.body;

    if (typeof token !== 'string' || token.length === 0) return res.status(403).json({ error: 'Mokėjimas nepatvirtintas.' });
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (sessionId && (typeof sessionId !== 'string' || sessionId.length > 200)) return res.status(400).json({ error: 'Neteisingas sessionId' });
    if (orderNumber && !isValidOrderNumber(orderNumber)) return res.status(400).json({ error: 'Neteisingas orderNumber formatas' });
    if (photos && photos.length > 0 && !isValidPhotosArray(photos)) return res.status(400).json({ error: 'Neteisingas nuotraukų formatas' });

    const tokenEntry = validTokens.get(token);
    if (!tokenEntry) return res.status(403).json({ error: 'Mokėjimas nepatvirtintas.' });
    // Leisti pakartotinį kvietimą jei yra sessionId cache arba photos
    if (tokenEntry.used && !sessionId && (!photos || photos.length === 0)) {
      return res.status(403).json({ error: 'Skaitymas jau atliktas.' });
    }

    const userName = name || tokenEntry.name || '';
    let result = null;

    console.log(`[analyze-palm] sessionId=${sessionId||'(nėra)'} cacheHas=${sessionId?analysisCache.has(sessionId):'n/a'} cacheSize=${analysisCache.size}`);

    if (sessionId && analysisCache.has(sessionId)) {
      const cached = analysisCache.get(sessionId);
      console.log(`[analyze-palm] sessionId=${sessionId} cache statusas='${cached.status}'`);
      if (cached.status === 'done' && cached.result) {
        result = cached.result;
        console.log(`[analyze-palm] sessionId=${sessionId} -> NAUDOJAMAS JAU PARUOŠTAS cache rezultatas (greitas kelias)`);
        // SVARBU (lenktynių sąlygos taisymas): ANKSČIAU čia iškart
        // ištrindavome cache įrašą. Bet jei KLIENTO fetch() nutrūksta dėl
        // laiko limito (pvz. lėtas tinklas), SERVERIS TOLIAU tęsia šio
        // užklausimo apdorojimą fone (Node.js to automatiškai
        // nesustabdo) — ir jei tuo metu analizė būdavo baigta bei cache
        // įrašas ištrintas, o klientas jau buvo "pasidavęs" nesulaukęs
        // atsakymo, KITAS kliento bandymas su TUO PAČIU sessionId
        // NEBERASDAVO cache įrašo (jis jau ištrintas!) ir buvo
        // PRIVERSTINAI pradedama VISIŠKAI NAUJA, lėta analizė nuo nulio —
        // kuri VĖL viršydavo kliento laiko limitą, ir taip be galo. Dabar
        // NETRINAME įrašo — jis saugiai lieka, kol jį išvalys bendras 3
        // valandų TTL valymas (žr. aukščiau), garantuojant, kad bet koks
        // pakartotinis bandymas VISADA ras jau paruoštą rezultatą.
      } else if (cached.status === 'pending' || cached.status === 'step2') {
        // SVARBU (2026-09 taisymas): ANKSČIAU šis langas tikrino TIK
        // 'pending' — bet kol AI dirba ties 2-uoju/3-iuoju žingsniu, tikras
        // statusas jau būna 'step2', o NE 'pending'. Kadangi žemiau esantis
        // paskutinis "else" blokas KLAIDINGAI elgėsi taip, lyg BET KOKS
        // statusas, kuris nėra 'done' ar 'pending', reikštų 'error' —
        // realiai VYKSTANTI (bet dar nebaigta) analizė buvo klaidingai
        // laikoma NEPAVYKUSIA, ir vartotojui iškart grąžinama 500 klaida,
        // NORS analizė po kelių sekundžių/minučių sėkmingai baigdavosi.
        // Ši klaida buvo pastebima retai, kol žingsnis 2 buvo vienintelis
        // ilgas etapas — pridėjus 3-ią (korektūros) žingsnį, 'step2'
        // trukmė pailgėjo, ir klaida ėmė kartotis daug dažniau.
        //
        // Trumpas laukimo langas VIENAM HTTP užklausimui (saugu nuo proxy/
        // gateway laiko limitų). Jei per šį langą analizė nebaigiama,
        // GRĄŽINAME "pending" signalą — klientas mandagiai paprašys dar
        // kartą po kelių sekundžių. SVARBU: NIEKADA netriname dar vykstančios
        // fono analizės ir NEPRADEDAME jos iš naujo — tai anksčiau
        // priversdavo dvigubą, brangią ir ilgą pakartotinę analizę, kai
        // originali tiesiog dar nebuvo baigusi (dažna klaidos priežastis:
        // vartotojas taip ir nesulaukdavo rezultato per 130s).
        await new Promise((resolve) => {
          let waited = 0;
          const iv = setInterval(() => {
            waited++;
            const entry = analysisCache.get(sessionId);
            if (!entry || (entry.status !== 'pending' && entry.status !== 'step2') || waited >= 8) { clearInterval(iv); resolve(); }
          }, 1000);
        });
        const entry = analysisCache.get(sessionId);
        if (entry && entry.status === 'done' && entry.result) {
          result = entry.result;
          console.log(`[analyze-palm] sessionId=${sessionId} -> baigėsi per laukimo langą, naudojamas rezultatas`);
          // Netriname (žr. komentarą aukščiau — apsauga nuo lenktynių
          // sąlygos su kliento pusės laiko limitu/abort).
        } else if (entry && (entry.status === 'pending' || entry.status === 'step2')) {
          console.log(`[analyze-palm] sessionId=${sessionId} -> VIS DAR '${entry.status}' po 8s laukimo, grąžinam 202`);
          return res.status(202).json({ pending: true, sessionId });
        } else if (entry && entry.status === 'error') {
          // Ta pati apsauga kaip aukščiau — grąžiname klaidą IŠKART, o NE
          // triname cache ir paleidžiame naują brangų AI kvietimą.
          console.log(`[analyze-palm] sessionId=${sessionId} -> fono analizė nepavyko laukimo lango metu (${entry.error}), grąžinam klaidą IŠKART`);
          logAnalysisFailure({ name: userName, email: email || tokenEntry.email, sessionId, orderNumber, errorMessage: entry.error });
          analysisCache.delete(sessionId);
          deleteAnalysisSessionFromDisk(sessionId);
          return res.status(500).json({ error: entry.error || 'Analizė nepavyko. Prašome bandyti dar kartą arba susisiekti: info@delnaskaitymas.lt' });
        } else {
          console.log(`[analyze-palm] sessionId=${sessionId} -> statusas tapo '${entry&&entry.status}', triname cache`);
          // įrašas dingo (nenumatyta situacija) — cache nebenaudingas
          analysisCache.delete(sessionId);
          deleteAnalysisSessionFromDisk(sessionId);
        }
      } else if (cached.status === 'error') {
        // fono analizė JAU KARTĄ NEPAVYKO (pvz. AI
        // atsakymo JSON nebuvo įmanoma apdoroti). SVARBU: ČIA ANKSČIAU
        // ištrindavome cache ir PALEISDAVOME VISIŠKAI NAUJĄ, MOKAMĄ AI
        // analizę nuo nulio — o kadangi klientas bando kas ~3s iki 20
        // kartų, TAI REIŠKĖ IKI 20 PAKARTOTINIŲ BRANGIŲ AI KVIETIMŲ vienai
        // nepavykusiai nuotraukų porai, jei klaida buvo nuosekli (ne
        // atsitiktinė). Dabar VIETOJ TO iškart grąžiname jau žinomą
        // klaidą klientui — jokio naujo AI kvietimo, jokio kartojimo.
        console.log(`[analyze-palm] sessionId=${sessionId} -> fono analizė ANKSČIAU NEPAVYKO (${cached.error}), grąžinam klaidą IŠKART (be pakartotinio AI kvietimo)`);
        logAnalysisFailure({ name: userName, email: email || tokenEntry.email, sessionId, orderNumber, errorMessage: cached.error });
        analysisCache.delete(sessionId);
        deleteAnalysisSessionFromDisk(sessionId);
        return res.status(500).json({ error: cached.error || 'Analizė nepavyko. Prašome bandyti dar kartą arba susisiekti: info@delnaskaitymas.lt' });
      } else {
        // Bet koks kitas, nenumatytas statusas — saugiausia elgtis kaip su
        // dar vykstančia analize (prašyti klientą pabandyti dar kartą), o
        // NE iškart laikyti tai klaida.
        console.log(`[analyze-palm] sessionId=${sessionId} -> NEATPAŽINTAS statusas '${cached.status}', grąžinam 202 (saugumo sumetimais, ne klaidą)`);
        return res.status(202).json({ pending: true, sessionId });
      }
    }

    if (!result) {
      if (!photos || photos.length === 0) {
        console.log(`[analyze-palm] sessionId=${sessionId||'(nėra)'} -> NĖRA rezultato IR nėra nuotraukų, grąžinam 400`);
        return res.status(400).json({ error: 'Analizė dar nebaigta. Bandykite dar kartą.' });
      }
      console.log(`[analyze-palm] sessionId=${sessionId||'(nėra)'} -> PRADEDAMA NAUJA PILNA ANALIZĖ (lėtas kelias, cache nerastas arba tuščias)`);
      result = await runPalmAnalysis(photos, userName);
    }

    tokenEntry.used = true;
    markPaymentTokenUsedPersistently(token);
    if (userName) result.userName = userName;
    // Pažymime analizę kaip apmokėtą — tik tada ją galima išsaugoti „Mano analizėse“ ar palyginti
    if (sessionId) {
      let ce = analysisCache.get(sessionId);
      if (!ce) { ce = { status: 'done', result, error: null, photos: [], name: userName, createdAt: Date.now() }; analysisCache.set(sessionId, ce); }
      if (ce.status === 'done') {
        ce.paid = true; ce.paidEmail = email || tokenEntry.email || ''; ce.paidName = userName;
        saveAnalysisSessionToDisk(sessionId, ce);
      }
    }

    // Priminimas užregistruojamas tik kai vartotojas pats paspaudžia mygtuką (/schedule-reminder)
    // PASTABA: pilnas rezultatų el. laiškas klientui ČIA NEBESIUNČIAMAS —
    // dabar jis siunčiamas PDF formatu iš /email-result-pdf endpoint'o,
    // kurį klientas iškviečia TIKSLIAI TADA, kai atsidaro rezultato ekranas
    // (žr. /email-result-pdf žemiau).

    res.json(result);

  } catch (err) {
    console.error('Klaida /analyze-palm:', err);
    // NEDELNAS = AI nustatė, kad nuotraukoje nėra delno — tai NE gedimas,
    // o įprastas, teisingas validacijos atmetimas, tad administratoriui
    // apie tai NEPRANEŠAME (priešingu atveju kiekvienas netinkamos
    // nuotraukos bandymas siųstų nereikalingą "gedimo" laišką).
    if (err.message.startsWith('NEDELNAS')) return res.json({ error: err.message });
    // Bet koks KITAS netikėtas gedimas čia — o mokėjimo tokenas jau
    // patvirtintas (t.y. klientas TIKRAI apmokėjo) — reiškia, kad
    // apmokėjęs klientas ką tik negavo savo rezultato. Pranešame
    // administratoriui iškart, automatiškai.
    // PASTABA: 'userName'/'tokenEntry' čia NEPASIEKIAMI (deklaruoti try
    // bloke aukščiau, kitame scope) — naudojame tiesiogiai iš req.body tai,
    // ką klientas atsiuntė (pakankama pranešimui administratoriui).
    logAnalysisFailure({ name: req.body && req.body.name, email: req.body && req.body.email, sessionId: req.body && req.body.sessionId, orderNumber: req.body && req.body.orderNumber, errorMessage: err.message });
    res.status(500).json({ error: err.message });
  }
});

function buildEmailHtml(userName, result) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#07040f;font-family:Georgia,serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;margin-bottom:12px">✦</div><h1 style="color:#d4a843;font-size:24px;margin:0 0 6px">${userName ? userName + ' —' : ''} Tavo Delno Skaitymas</h1></div>
  ${section('I · Prigimtinės stiprybės ir charakteris', result.prigimtines_stiprybes)}
  ${section('II · Gyvenimo kryptis ir tikslai', result.gyvenimo_tikslas)}
  ${section('III · Bendravimo būdas ir jo įtaka santykiams', result.santykiai)}
  ${section('IV · Finansinis potencialas', result.finansai)}
  ${section('V · Unikalus sėkmės raktas', result.galimybes)}
  ${pills(result.stiprybes_sarasas)}
  ${section('VI · Svarbiausi artėjantys pokyčiai', result.pokyciai)}
  ${section('VII · Pažangą stabdančios kliūtys', result.klutys)}
  <div style="text-align:center;padding-top:24px;border-top:0.5px solid rgba(212,168,67,0.15)"><p style="color:rgba(245,238,216,0.35);font-size:12px;margin:0;font-style:italic">Šis skaitymas sukurtas tik tau ✦</p></div></div></body></html>`;
}

function section(title, text) {
  return `<div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">${title}</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0">${text || ''}</p></div>`;
}

function pills(arr) {
  return `<div style="margin-bottom:12px">${(arr||[]).map(d=>`<span style="background:rgba(212,168,67,0.1);border:0.5px solid rgba(212,168,67,0.3);border-radius:50px;padding:4px 12px;font-size:12px;color:#f0c96a;display:inline-block;margin:3px">${d}</span>`).join('')}</div>`;
}

app.post('/create-payment', sensitiveLimiter, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    // Suma imama TIESIOGIAI iš Stripe Price objekto (ne kietai įrašyta), kad
    // kaina visada sutaptų su Product catalog įrašu (ACTIVE_PRICE_ID).
    const q = await computeOrderAmount({ ref: req.body.ref, addKlausk: !!req.body.addKlausk, email, promo: req.body.promo, bundle: !!req.body.bundle });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: q.total,
      currency: q.currency,
      metadata: { name: name || '', email: email || '', priceId: ACTIVE_PRICE_ID, addKlausk: q.bump ? '1' : '', ref: q.refCode || '', promo: q.promoCode || '', bundle: q.bundle ? '1' : '' },
      ...(email ? {receipt_email: email} : {}),
      payment_method_types: ['card', 'revolut_pay']
    });
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, sessionId: paymentIntent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/verify-payment-intent', sensitiveLimiter, async (req, res) => {
  try {
    const { paymentIntentId, name, email, orderNumber } = req.body;
    if (typeof paymentIntentId !== 'string' || paymentIntentId.length === 0 || paymentIntentId.length > 200) {
      return res.status(400).json({ paid: false, error: 'Neteisingas paymentIntentId' });
    }
    if (name && !isValidName(name)) return res.status(400).json({ paid: false, error: 'Neteisingas vardo formatas' });
    if (email && !isValidEmail(email)) return res.status(400).json({ paid: false, error: 'Neteisingas el. pašto formatas' });
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status === 'succeeded') {
      const finalName = name || pi.metadata.name || '';
      const finalEmail = email || pi.metadata.email || '';
      // getOrCreateTokenForPayment (ne createToken tiesiogiai): jei šis
      // paymentIntentId jau kartą buvo apdorotas, grąžinamas TAS PATS
      // tokenas, o ne naujas — apsauga nuo pakartotinio šio endpoint'o
      // iškvietimo (žr. komentarą prie funkcijos aukščiau).
      const token = getOrCreateTokenForPayment(paymentIntentId, finalName, finalEmail);
      sendPaymentSuccessEmails(orderNumber, finalName, finalEmail);
      handlePaidAnalysis(paymentIntentId, pi.metadata, finalEmail);
      res.json({ paid: true, token, name: finalName, email: finalEmail });
    } else {
      res.json({ paid: false, status: pi.status });
    }
  } catch (err) {
    res.status(500).json({ paid: false, error: err.message });
  }
});

app.get('/verify-payment', sensitiveLimiter, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    if (session.payment_status === 'paid') {
      const finalName = session.metadata?.name || '';
      const finalEmail = session.metadata?.email || '';
      // Pirmenybė Stripe metadata (patikimas šaltinis) — atsarginis
      // variantas req.query, jei metadata dėl kokios nors priežasties tuščia.
      const finalBgSessionId = session.metadata?.bgSessionId || req.query.bgSessionId || '';
      const finalOrderNumber = session.metadata?.orderNumber || req.query.orderNumber || '';
      // getOrCreateTokenForPayment (ne createToken tiesiogiai) — žr.
      // komentarą prie funkcijos aukščiau. Čia raktas yra session.id (ne
      // req.query.session_id tiesiogiai), nes tai Stripe patvirtinta,
      // patikima reikšmė tam pačiam checkout session'ui.
      const token = getOrCreateTokenForPayment(session.id, finalName, finalEmail);
      sendPaymentSuccessEmails(finalOrderNumber, finalName, finalEmail);
      handlePaidAnalysis(session.id, session.metadata, finalEmail);
      res.json({ paid: true, name: finalName, email: finalEmail, token, bgSessionId: finalBgSessionId, orderNumber: finalOrderNumber });
    } else {
      res.json({ paid: false });
    }
  } catch (err) {
    res.json({ paid: false });
  }
});

app.get('/stripe-key', (req, res) => {
  res.json({ key: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// Priminimo laiškų atsisakymas (unsubscribe) — pasiekiamas iš laiško nuorodos.
// Pašalina laukiantį (dar neišsiųstą) priminimą IR įtraukia el. paštą į
// "nebenoriu gauti" sąrašą, kad ateityje pakartotinis "Primink man"
// paspaudimas šio adreso vėl automatiškai neužregistruotų.
app.get('/unsubscribe-reminder', (req, res) => {
  const email = (req.query.email || '').toString().trim().toLowerCase();
  const page = (title, text, extra) => `<!DOCTYPE html><html lang="lt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — DELNAS</title><style>html,body{height:100%}body{margin:0;background:#000;color:#e8e2d4;font-family:'DM Sans',-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;padding:24px;text-align:center;box-sizing:border-box}.box{max-width:400px;width:100%}h1{font-family:Georgia,serif;color:#f0c96a;font-size:22px;margin-bottom:12px}p{font-size:14px;color:rgba(232,226,212,.8);line-height:1.6}a{color:#d4a843}</style></head><body><div class="box"><div style="font-size:26px;margin-bottom:14px;color:#d4a843">✦</div><h1>${title}</h1><p>${text}</p>${extra || ''}<p style="margin-top:24px"><a href="/">← Grįžti į DELNAS</a></p></div></body></html>`;

  if (!isValidEmail(email)) {
    return res.status(400).send(page('Klaida', 'Netinkamas el. pašto adresas nuorodoje.'));
  }

  try {
    const blacklist = loadReminderBlacklist();
    if (!blacklist.includes(email)) {
      blacklist.push(email);
      saveReminderBlacklist(blacklist);
    }
    const reminders = loadReminders();
    const filtered = reminders.filter(r => r.email.toLowerCase() !== email);
    if (filtered.length !== reminders.length) saveReminders(filtered);
    const resubEmail = escapeHtml(email).replace(/'/g, "\\'");
    const resubButton = `<button id="resub-btn" onclick="reSubscribe()" style="width:100%;background:#000000;border:1px solid rgba(212,168,67,.4);border-radius:10px;padding:15px;color:#d4a843;font-size:15px;font-weight:800;cursor:pointer;font-family:'DM Sans',sans-serif;letter-spacing:.04em;margin-top:22px">✦ Primink man</button><div id="resub-msg" style="margin-top:12px;font-size:13px;color:rgba(232,226,212,.6);min-height:18px"></div><script>function reSubscribe(){var btn=document.getElementById('resub-btn'),msg=document.getElementById('resub-msg');btn.disabled=true;btn.style.opacity='.6';fetch('/schedule-reminder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${resubEmail}'})}).then(function(r){return r.json();}).then(function(){btn.textContent='✓ Vėl užregistruota';msg.textContent='Priminimą gausi po 3 mėnesių.';}).catch(function(){msg.textContent='Nepavyko. Pabandyk dar kartą.';btn.disabled=false;btn.style.opacity='1';});}</script>`;
    res.send(page('Atsisakyta', 'Daugiau šių priminimo laiškų negausi. Jei persigalvosi, tiesiog vėl paspausk „Primink man":', resubButton));
  } catch (e) {
    console.error('/unsubscribe-reminder klaida:', e.message);
    res.status(500).send(page('Klaida', 'Nepavyko apdoroti prašymo. Parašyk mums: info@delnaskaitymas.lt'));
  }
});

// Realios kainos tiesiogiai iš Stripe katalogo — kad UI rodomas perbrauktas
// "įprastas" skaičius ir aktyvi akcijos kaina VISADA sutaptų su tuo, kas
// realiai užregistruota Stripe (Product catalog), o ne liktų kietai įrašytas
// tekstas, galintis nesutapti pasikeitus kainai dashboard'e.
let _priceInfoCache = null;
let _priceInfoCacheAt = 0;
app.get('/price-info', async (req, res) => {
  try {
    if (_priceInfoCache && (Date.now() - _priceInfoCacheAt) < 5 * 60 * 1000) {
      return res.json(_priceInfoCache);
    }
    const [promo, regular] = await Promise.all([
      stripe.prices.retrieve(STRIPE_PRICE_ID_PROMO),
      stripe.prices.retrieve(STRIPE_PRICE_ID_REGULAR)
    ]);
    const activePrice = ACTIVE_PRICE_ID === STRIPE_PRICE_ID_PROMO ? promo : regular;
    _priceInfoCache = {
      promo: { amount: promo.unit_amount, currency: promo.currency },
      regular: { amount: regular.unit_amount, currency: regular.currency },
      active: { amount: activePrice.unit_amount, currency: activePrice.currency },
      isPromoActive: ACTIVE_PRICE_ID === STRIPE_PRICE_ID_PROMO,
      pora: { amount: PORA_PRICE_CENTS, currency: 'eur' },
      giftKlausk: GIFT_KLAUSK_CENTS,
      giftKlauskPora: GIFT_KLAUSK_PORA_CENTS
    };
    _priceInfoCacheAt = Date.now();
    res.json(_priceInfoCache);
  } catch (err) {
    console.error('/price-info klaida:', err);
    // SVARBU: čia ANKSČIAU buvo grąžinamos hardcoded, pasenusios kainos
    // (15,99 €/9,99 €) — jei Stripe API laikinai nepasiekiamas, vartotojui
    // galėjo būti parodyta NETEISINGA (sena) suma. Dabar, vietoj to,
    // grąžiname aiškią klaidą — GERIAU NERODYTI sumos, nei rodyti pasenusią.
    // Kliento pusėje (index.html) tai jau tinkamai apdorojama:
    //  - kainos rodymo bloke: .catch() tiesiog palieka statinį HTML
    //    atsarginį skaičių (jis atnaujintas ir atitinka dabartinę kainą);
    //  - Apple/Google Pay sumos nustatyme: jau yra apsauga
    //    "if(!activeCents){ alert(...); return; }", kuri saugiai nutraukia
    //    mokėjimą, jei "active.amount" lauko šiame atsakyme nėra.
    res.status(503).json({ error: 'Nepavyko gauti aktualios kainos iš Stripe' });
  }
});

// Priminimas po 90 d. (vienas laiškas). savedId — išsaugota analizė, su kuria bus palyginta nauja.
function scheduleReminderFor(rawEmail, name, savedId) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const blacklist = loadReminderBlacklist();
  const blIdx = blacklist.indexOf(email);
  if (blIdx !== -1) {
    blacklist.splice(blIdx, 1);
    saveReminderBlacklist(blacklist);
  }

  // Priminimas užregistruojamas TIK į tikrą 90 dienų eilę — laiškas
  // išsiunčiamas TIK praėjus 3 mėnesiams (žr. setInterval mechanizmą
  // aukščiau faile), tiksliai taip, kaip vartotojui rodoma UI.
  const reminders = loadReminders();
  const ex = reminders.find(r => (r.email || '').toLowerCase() === email);
  if (ex) { if (savedId && ex.savedId !== savedId) { ex.savedId = savedId; saveReminders(reminders); } return 'exists'; }
  reminders.push({ email, name: name || '', ...(savedId ? { savedId } : {}), sendAt: Date.now() + (90 * 24 * 60 * 60 * 1000), createdAt: Date.now() });
  saveReminders(reminders);
  return 'ok';
}

app.post('/schedule-reminder', sensitiveLimiter, async (req, res) => {
  try {
    const { name } = req.body;
    if (!isValidEmail(req.body.email)) return res.status(400).json({ error: 'Neteisingas el. paštas' });
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    // El. paštas normalizuojamas į mažąsias raides IŠ KARTO ir naudojamas
    // NUOSEKLIAI visur toliau (dublikato patikra, saugojimas, blacklist) —
    // anksčiau dublikato patikra buvo jautri didžiosioms/mažosioms raidėms,
    // todėl "Vardas@Gmail.com" ir "vardas@gmail.com" būtų buvę traktuojami
    // kaip du skirtingi adresai (rizika gauti du priminimo laiškus).
    const email = (req.body.email || '').toString().trim().toLowerCase();

    // SVARBU: jei vartotojas anksčiau paspaudė "Nebenoriu gauti šių
    // priminimų" nuorodą, bet DABAR SĄMONINGAI, SAVO NORU vėl paspaudžia
    // "Primink man" mygtuką (naujas, aiškus veiksmas) — tai yra naujas,
    // galiojantis sutikimas, kuris pakeičia ankstesnį atsisakymą (standartinė
    // sutikimo praktika: vėlesnis aiškus veiksmas turi viršenybę). Todėl
    // PAŠALINAME jį iš "nebenoriu gauti" sąrašo, o ne tyliai ignoruojame
    // jo prašymą — priešingu atveju UI pažadas ("jei persigalvosi, tiesiog
    // vėl paspausk") būtų neteisingas/neveikiantis.
    const r = scheduleReminderFor(email, name || '');
    if (r === 'exists') return res.json({ ok: true, message: 'Jau užregistruota' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TIK ADMINISTRATORIUI: priminimo laiško DIZAINO peržiūra.
// SVARBU (skirtumas nuo anksčiau pašalinto testavimo bloko): šis
// endpoint'as NIEKO NEĮRAŠO į tikrą 90 dienų eilę ir NIEKAIP nepaveikia
// realių vartotojų — jis tiesiog IŠ KARTO išsiunčia TĄ PATĮ šabloną,
// kurį realiai naudoja 90 dienų mechanizmas (žr. aukščiau), į JŪSŲ
// paties nurodytą el. paštą, kad galėtumėte pamatyti, kaip laiškas
// atrodo, nelaukiant 90 dienų ir neklaidinant jokio tikro kliento.
// Apsaugotas paprastu raktu (ADMIN_PREVIEW_KEY aplinkos kintamasis),
// kad pašaliniai negalėtų juo piktnaudžiauti masiniam laiškų siuntimui.
// Naudojimas naršyklėje:
//   /preview-reminder-email?email=jusu@paštas.lt&name=Vardas&key=RAKTAS
app.get('/preview-reminder-email', sensitiveLimiter, async (req, res) => {
  try {
    const { email, name, key } = req.query;
    const expectedKey = process.env.ADMIN_PREVIEW_KEY;
    if (!expectedKey) return res.status(503).send('ADMIN_PREVIEW_KEY nenustatytas Railway Variables — pridėkite jį, kad ši peržiūra veiktų.');
    if (key !== expectedKey) return res.status(403).send('Neteisingas raktas.');
    if (!isValidEmail(email)) return res.status(400).send('Neteisingas el. pašto formatas (naudokite ?email=...)');
    await mailer.sendMail({
      from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
      to: email,
      subject: `${name ? ltPhrase(name, 'voc') + ', l' : 'L'}aikas naujam delnų skaitymui ✦ [PERŽIŪRA]`,
      html: `<div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:24px"><div style="font-size:28px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:22px;font-weight:700;color:#d4a843;margin-bottom:8px">${name ? escapeHtml(ltPhrase(name, 'voc')) + ', atėjo laikas' : 'Atėjo laikas'}</div><div style="font-size:14px;color:rgba(245,238,216,.6)">Praėjo 3 mėnesiai nuo tavo delnų analizės</div></div><div style="background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.2);border-radius:12px;padding:20px;margin-bottom:24px;font-size:14px;line-height:1.8;color:rgba(245,238,216,.85)">Delnų linijos keičiasi kartu su tavimi. Per 3 mėnesius tavo gyvenimas pasikeitė — o su juo ir tai, ką pasakoja tavo delnai.</div><div style="text-align:center;margin-bottom:20px"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}" style="background:linear-gradient(125deg,#fff0c4 0%,#f5d061 22%,#e0a930 45%,#c98a1f 68%,#8a5a0f 100%);color:#000000;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:800;font-size:15px;letter-spacing:.02em;display:inline-block;box-shadow:0 4px 20px rgba(212,168,67,.4)">Nauja delnų analizė →</a></div><div style="text-align:center;padding-top:16px;border-top:1px solid rgba(212,168,67,.15)"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/unsubscribe-reminder?email=${encodeURIComponent(email)}" style="color:rgba(245,238,216,.4);text-decoration:underline;font-size:11px">Nebenoriu gauti šių priminimų</a></div>${EMAIL_FOOTER_HTML}</div>`
    });
    res.send(`Peržiūros laiškas išsiųstas į ${email}. (Tai TIK peržiūra — jokia tikra 90 dienų eilė nepaliesta.)`);
  } catch(e) {
    res.status(500).send('Klaida siunčiant peržiūros laišką: ' + e.message);
  }
});

// PASTABA: anksčiau čia buvo serverio pusės "dalinimosi nuoroda" ir "PDF
// nuorodos kopijavimo" mechanizmai (/share-result, /shared-result/:id,
// /shared/:id, /store-pdf, /pdf/:id), saugoję vartotojo analizės rezultatą
// ir/ar PDF failą serveryje (faile arba atmintyje). Jie buvo PALIKTI
// nenaudojami po to, kai dalinimosi funkcija buvo perkelta į kliento pusę
// (canvas + navigator.share() — žr. index.html shareStory()/inviteFriend()/
// sharePdfToFriend()), kuri VISIŠKAI neišsaugo jokių duomenų serveryje.
// Kadangi šie senieji maršrutai jokios programos dalies nebebuvo kviečiami,
// bet vis tiek priiminėjo užklausas ir galėjo saugoti asmens duomenis be
// jokio realaus naudojimo tikslo, jie buvo PAŠALINTI (2026-08) — atitinka
// duomenų kiekio mažinimo principą (BDAR 5(1)(c) str.) ir Privatumo
// politikos teiginį, kad dalinimasis serveryje nieko neišsaugo.

// Teisiniai puslapiai — Privatumo politika ir Naudojimosi sąlygos.
// SVARBU: šie maršrutai TURI būti registruoti PRIEŠ bendrą "catch-all"
// maršrutą failo gale — priešingu atveju jis juos perimtų pirmiau.
// ═════════════════════════════════════════════════════════════════
// DOVANŲ KUPONAI
// ═════════════════════════════════════════════════════════════════
// Pirkėjas perka kuponą atskirame puslapyje /dovana (ne programėlėje) per
// Stripe Checkout. Po apmokėjimo sugeneruojamas vienkartinis kodas
// (pvz. K7P3-Q9XM) ir pirkėjui el. paštu išsiunčiama dovanų kortelė su
// asmenine nuoroda delnaskaitymas.lt/?dovana=KODAS. Gavėjas, atėjęs per
// šią nuorodą, programėlėje eina įprastu keliu, tik mokėjimo ekrane vietoj
// kainos mato „Dovana nuo … — jau apmokėta“; /redeem-gift išduoda tą patį
// analizės tokeną, kokį išduotų /verify-payment-intent.
//
// Kodai saugomi SHARED_STORAGE_DIR/gift-codes.json — Railway'uje BŪTINAS
// Volume (kitaip kodai dingtų po kiekvieno deploy'inimo).
const GIFT_CODES_FILE = path.join(SHARED_STORAGE_DIR, 'gift-codes.json');
const GIFT_VALID_DAYS = 365;
const GIFT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // be 0/O/1/I — kad nesupainiotų

function loadGiftStore() {
  try {
    if (fs.existsSync(GIFT_CODES_FILE)) {
      const d = JSON.parse(fs.readFileSync(GIFT_CODES_FILE, 'utf8'));
      return { codes: d.codes || {}, bySession: d.bySession || {} };
    }
  } catch (e) { console.error('[gift] nepavyko nuskaityti gift-codes.json:', e.message); }
  return { codes: {}, bySession: {} };
}
function saveGiftStore(store) {
  // Rašoma per laikiną failą + rename, kad nutrūkus rašymui failas nesugestų.
  const tmp = GIFT_CODES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, GIFT_CODES_FILE);
}
function generateGiftCode(existing) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += GIFT_CODE_ALPHABET[crypto.randomInt(GIFT_CODE_ALPHABET.length)];
    const code = raw.slice(0, 4) + '-' + raw.slice(4);
    if (!existing[code]) return code;
  }
  throw new Error('Nepavyko sugeneruoti unikalaus kodo');
}
// Priima „k7p3q9xm“, „K7P3-Q9XM“, „ k7p3 q9xm “ ir pan. → „K7P3-Q9XM“ arba null.
function normalizeGiftCode(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return null;
  for (const ch of raw) if (!GIFT_CODE_ALPHABET.includes(ch)) return null;
  return raw.slice(0, 4) + '-' + raw.slice(4);
}
function isValidGiftText(str, max) {
  return str === undefined || str === '' || (typeof str === 'string' && str.trim().length <= max);
}
function appBaseUrl() {
  const d = (process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return 'https://' + d;
}
function giftStatus(gift) {
  if (!gift) return 'not_found';
  if (gift.status === 'redeemed') return 'redeemed';
  if (gift.status === 'void') return 'void';
  if (Date.now() > gift.expiresAt) return 'expired';
  return 'active';
}
function fmtLtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildGiftEmailHtml(gift) {
  const link = giftRedeemLink(gift);
  const pora = gift.kind === 'pora';
  const cardLink = `${appBaseUrl()}/dovana/kortele?kodas=${encodeURIComponent(gift.code)}`;
  const to = gift.recipientName ? escapeHtml(ltPhrase(gift.recipientName, 'dat')) : 'Tau';
  // Planuotas siuntimas: dovaną gavėjui išsiųsime mes, tad pirkėjui — patvirtinimas, ne „atidaryk dovaną“
  const sched = !!gift.recipientEmail;
  return `<div style="background:#0a0a0a;padding:28px 12px;font-family:Georgia,serif">
  <div style="max-width:520px;margin:0 auto;background:#000;border:1px solid rgba(212,168,67,.45);border-radius:18px;padding:34px 26px;text-align:center;color:#fff">
    <div style="font-size:15px;letter-spacing:.32em;color:#d4a843;font-weight:bold">DELNAS</div>
    <div style="font-size:11px;letter-spacing:.3em;color:rgba(255,255,255,.45);margin-top:4px">${sched ? 'DOVANA UŽSAKYTA' : 'DOVANŲ KUPONAS'}</div>
    ${gift.season && SEASON_LABELS[gift.season] ? `<div style="margin-top:12px;font-size:15px;color:#f0d58a;font-style:italic">${SEASON_LABELS[gift.season]}</div>` : ''}
    ${gift.recipientEmail ? `<div style="margin:16px auto 0;max-width:420px;border:1px solid rgba(212,168,67,.45);border-radius:10px;padding:10px 14px;font-family:Arial,sans-serif;font-size:13px;color:#f0d58a">📅 Dovana bus išsiųsta gavėjui <b>${escapeHtml(gift.recipientEmail)}</b> ${escapeHtml(gift.sendAt)} apie ${String(Number.isInteger(gift.sendHour) ? gift.sendHour : 8).padStart(2, '0')}:00 Lietuvos laiku (gali vėluoti iki 5 min.).</div>` : ''}
    <div style="font-size:30px;margin:26px 0 6px">🎁 ${to}</div>
    <div style="font-size:17px;color:rgba(255,255,255,.75)">${pora ? '<em style="color:#d4a843">Porų suderinamumas</em> pagal abiejų delnus' : 'Asmeninis <em style="color:#d4a843">Gyvenimo žemėlapis</em> pagal delnus'}</div>
    ${gift.message ? `<div style="margin:22px auto 0;max-width:420px;font-style:italic;font-size:16px;line-height:1.5;color:#f0d58a">„${escapeHtml(gift.message)}“</div>` : ''}
    ${gift.fromName ? `<div style="margin-top:10px;font-size:14px;color:rgba(255,255,255,.6)">— nuo ${escapeHtml(ltPhrase(gift.fromName, 'gen'))}</div>` : ''}
    ${sched ? `<div style="margin-top:24px;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:rgba(255,255,255,.6)">Nieko daryti nereikia — gavėjas gaus laišką su dovana ir mygtuku jai atidaryti. Kai laiškas bus išsiųstas, jums atsiųsime patvirtinimą.<br><br>Dovanos kodas: <b style="color:#f0d58a;letter-spacing:.12em">${escapeHtml(gift.code)}</b> · galioja iki ${fmtLtDate(gift.expiresAt)}</div>
    <div style="margin-top:18px;font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:rgba(255,255,255,.6)">Jei norėsite įteikti ir asmeniškai:<br>
      <a href="${cardLink}" style="display:inline-block;margin-top:10px;border:1px solid #d4a843;color:#d4a843;text-decoration:none;padding:10px 20px;border-radius:999px;font-size:14px;font-weight:bold">⬇ Atsisiųsti dovanų kortelę</a>
    </div>` : `<div style="margin:28px auto 6px;display:inline-block;border:1px dashed rgba(212,168,67,.7);border-radius:10px;padding:12px 22px;font-family:'Courier New',monospace;font-size:24px;letter-spacing:.18em;color:#f0d58a">${escapeHtml(gift.code)}</div>
    <div style="font-size:12px;color:rgba(255,255,255,.45)">Galioja iki ${fmtLtDate(gift.expiresAt)}</div>
    <div style="margin-top:26px"><a href="${link}" style="display:inline-block;background:#d4a843;color:#140f02;text-decoration:none;padding:14px 28px;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${pora ? 'Sužinoti, kaip derate poroje →' : 'Atskleisti savo žemėlapį →'}</a></div>
    <div style="margin-top:22px;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:rgba(255,255,255,.6)">
      Kaip panaudoti: paspausk mygtuką aukščiau arba įvesk kodą adresu <a href="${appBaseUrl()}/kodas" style="color:#f5d061;font-weight:bold;text-decoration:underline">www.delnaskaitymas.lt/kodas&nbsp;↗</a>, tada ${pora ? 'abu nufotografuokite savo delnus' : 'nufotografuok abu delnus'} — mokėti nereikės.
    </div>
    <div style="margin-top:18px;font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:rgba(255,255,255,.6)">
      Kortelė su QR kodu spausdinimui ar persiuntimui:<br>
      <a href="${cardLink}" style="display:inline-block;margin-top:10px;border:1px solid #d4a843;color:#d4a843;text-decoration:none;padding:10px 20px;border-radius:999px;font-size:14px;font-weight:bold">⬇ Atsisiųsti dovanų kortelę</a>
    </div>`}
  </div>
  <div style="max-width:520px;margin:18px auto 0;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#888;text-align:center">
    ${sched ? 'Šį laišką gavote, nes įsigijote DELNAS dovaną.' : 'Šį laišką gavote, nes įsigijote DELNAS dovanų kuponą. Persiųskite jį tam, kam dovanojate, arba atsisiųskite kortelę.'}
    Kodas vienkartinis. Pramoginio pobūdžio paslauga, 18+.
  </div>
  ${EMAIL_FOOTER_HTML}
</div>`;
}

function giftPublicInfo(gift) {
  return {
    code: gift.code,
    fromName: gift.fromName || '',
    recipientName: gift.recipientName || '',
    message: gift.message || '',
    expiresAt: gift.expiresAt,
    kind: gift.kind === 'pora' ? 'pora' : 'asmenine',
    season: gift.season || '',
    status: giftStatus(gift)
  };
}
// Data Vilniaus laiku (YYYY-MM-DD) ir valanda
function ltDate(ts) { return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Vilnius' }); }
function ltHour(ts) { return parseInt(new Date(ts).toLocaleString('en-GB', { timeZone: 'Europe/Vilnius', hour: '2-digit', hour12: false }), 10); }
const SEASON_LABELS = { valentinas: 'Su Valentino diena 💞', mama: 'Su Motinos diena 🌷', kaledos: 'Linksmų Kalėdų 🎄' };

// Laiškas dovanos GAVĖJUI (siunčiamas nurodytą dieną)
function buildGiftRecipientEmailHtml(gift) {
  const link = giftRedeemLink(gift), pora = gift.kind === 'pora';
  const to = gift.recipientName ? escapeHtml(ltPhrase(gift.recipientName, 'dat')) : (pora ? 'Jums' : 'Tau');
  const from = gift.fromName ? escapeHtml(gift.fromName) : '';
  return `<div style="background:#0a0a0a;padding:28px 12px;font-family:Georgia,serif">
  <div style="max-width:520px;margin:0 auto;background:#000;border:1px solid rgba(212,168,67,.45);border-radius:18px;padding:34px 26px;text-align:center;color:#fff">
    <div style="font-size:15px;letter-spacing:.32em;color:#d4a843;font-weight:bold">DELNAS</div>
    ${gift.season && SEASON_LABELS[gift.season] ? `<div style="margin-top:14px;font-size:15px;color:#f0d58a;font-style:italic">${SEASON_LABELS[gift.season]}</div>` : ''}
    <div style="font-size:30px;margin:22px 0 6px">🎁 ${to}</div>
    <div style="font-size:17px;color:rgba(255,255,255,.8)">${from ? from + ' ' + (pora ? 'jums dovanoja' : 'tau dovanoja') : (pora ? 'Jums dovana' : 'Tau dovana')}:</div>
    <div style="font-size:19px;color:#fff;margin-top:8px">${from ? (pora ? '<em style="color:#d4a843">Porų suderinamumą</em> pagal abiejų delnus' : 'Asmeninį <em style="color:#d4a843">Gyvenimo žemėlapį</em> pagal delnus') : (pora ? '<em style="color:#d4a843">Porų suderinamumas</em> pagal abiejų delnus' : 'Asmeninis <em style="color:#d4a843">Gyvenimo žemėlapis</em> pagal delnus')}</div>
    ${gift.message ? `<div style="margin:22px auto 0;max-width:420px;font-style:italic;font-size:16px;line-height:1.5;color:#f0d58a">„${escapeHtml(gift.message)}“</div>` : ''}
    <div style="margin-top:28px"><a href="${link}" style="display:inline-block;background:#d4a843;color:#140f02;text-decoration:none;padding:14px 28px;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">Atidaryti dovaną →</a></div>
    <div style="margin-top:18px;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:rgba(255,255,255,.6)">Dovanos kodas: <b style="color:#f0d58a;letter-spacing:.12em">${escapeHtml(gift.code)}</b> · galioja iki ${fmtLtDate(gift.expiresAt)}<br>${pora ? 'Abu nufotografuokite savo delnus' : 'Nufotografuok abu delnus'} — mokėti nereikės.</div>
  </div>
  <div style="max-width:520px;margin:16px auto 0;font-family:Arial,sans-serif;font-size:11.5px;line-height:1.6;color:#888;text-align:center">${from ? `Šį laišką ${pora ? 'gavote, nes ' + from + ' jums' : 'gavai, nes ' + from + ' tau'} padovanojo ${pora ? 'DELNAS porų suderinamumą' : 'DELNAS gyvenimo žemėlapį'}.` : `Šį laišką ${pora ? 'gavote, nes jums' : 'gavai, nes tau'} buvo padovanotas ${pora ? 'DELNAS porų suderinamumas' : 'DELNAS gyvenimo žemėlapis'}.`} Pramoginio pobūdžio paslauga, 18+.</div>
  ${EMAIL_FOOTER_HTML}
</div>`;
}

// Planuotas siuntimas gavėjams ir priminimas pirkėjams (tikrinama kas valandą)
function processGiftSchedules() {
  try {
    const store = loadGiftStore(), now = Date.now(), today = ltDate(now);
    let changed = false;
    for (const g of Object.values(store.codes)) {
      if (giftStatus(g) === 'void') continue;
      // 1) Siuntimas gavėjui nurodytą dieną ir valandą (Lietuvos laiku; senesni kuponai — 8 val.)
      const sendHour = Number.isInteger(g.sendHour) ? g.sendHour : 8;
      if (g.recipientEmail && !g.recipientSentAt && g.sendAt && (g.sendAt < today || (g.sendAt === today && ltHour(now) >= sendHour))) {
        g.recipientSentAt = now; changed = true;
        mailer.sendMail({ from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`, to: g.recipientEmail, subject: g.fromName ? `🎁 ${g.fromName} ${g.kind === 'pora' ? 'jums' : 'tau'} dovanoja DELNAS ${g.kind === 'pora' ? 'porų suderinamumą' : 'gyvenimo žemėlapį'}` : `🎁 ${g.kind === 'pora' ? 'Jums padovanotas DELNAS porų suderinamumas' : 'Tau padovanotas DELNAS gyvenimo žemėlapis'}`, html: buildGiftRecipientEmailHtml(g) })
          .then(() => {
            console.log(`[gift] dovana išsiųsta gavėjui ${g.code}`);
            if (g.buyerEmail) mailer.sendMail({ from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`, to: g.buyerEmail, subject: '✓ Jūsų dovana išsiųsta', html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:28px 22px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:24px">🎁</div><p style="font-size:15px;line-height:1.7">Jūsų DELNAS dovana${g.recipientName ? ' (' + escapeHtml(g.recipientName) + ')' : ''} ką tik išsiųsta adresu <b>${escapeHtml(g.recipientEmail)}</b>.</p>${EMAIL_FOOTER_HTML}</div>` }).catch(() => {});
          })
          .catch(e => { console.error('[gift] gavėjo laiško klaida:', e.message); const st2 = loadGiftStore(); if (st2.codes[g.code]) { delete st2.codes[g.code].recipientSentAt; saveGiftStore(st2); } });
      }
      // 2) Priminimas pirkėjui: neatidaryta po 30 d. (skaičiuojant nuo išsiuntimo gavėjui, jei toks buvo)
      const startTs = g.recipientSentAt || g.createdAt;
      if (giftStatus(g) === 'active' && g.buyerEmail && !g.buyerReminderAt && startTs && now - startTs > 30 * 864e5 && (!g.sendAt || g.recipientSentAt)) {
        g.buyerReminderAt = now; changed = true;
        const card = `${appBaseUrl()}/dovana/kortele?kodas=${encodeURIComponent(g.code)}`;
        mailer.sendMail({ from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`, to: g.buyerEmail, subject: g.recipientName ? `🎁 ${g.recipientName} dar neatidarė dovanos` : '🎁 Jūsų dovana dar neatidaryta',
          html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:30px 22px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:26px;margin-bottom:6px">🎁</div><div style="font-size:19px;font-weight:700;color:#d4a843;margin-bottom:10px">Dovana dar laukia</div><p style="font-size:15px;line-height:1.7;color:rgba(245,238,216,.85)">${g.recipientName ? escapeHtml(g.recipientName) + ' dar' : 'Dovanos gavėjas dar'} neatidarė jūsų DELNAS dovanos (kodas <b style="color:#f0d58a">${escapeHtml(g.code)}</b>, galioja iki ${fmtLtDate(g.expiresAt)}). Gal norite priminti? Kortelę galite persiųsti dar kartą.</p><a href="${card}" style="display:inline-block;margin-top:8px;background:#d4a843;color:#140f02;text-decoration:none;padding:12px 24px;border-radius:999px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold">Atidaryti dovanų kortelę →</a>${EMAIL_FOOTER_HTML}</div>` })
          .catch(e => console.error('[gift] priminimo klaida:', e.message));
      }
    }
    if (changed) saveGiftStore(store);
  } catch (e) { console.error('[gift] planavimo klaida:', e.message); }
}
setTimeout(processGiftSchedules, 15000);
setInterval(processGiftSchedules, 5 * 60 * 1000);
// Porų kuponas panaudojamas /pora puslapyje (reikia abiejų vardų), asmeninis — programėlėje
function giftRedeemLink(gift) {
  return gift.kind === 'pora'
    ? `${appBaseUrl()}/pora?dovana=${encodeURIComponent(gift.code)}`
    : `${appBaseUrl()}/?dovana=${encodeURIComponent(gift.code)}`;
}

// Sukuria kodą apmokėtai Checkout sesijai. Idempotentiška: tas pats
// session.id visada grąžina TĄ PATĮ kodą (pirkėjas gali perkrauti puslapį).
function issueGiftForSession(session) {
  const store = loadGiftStore();
  const existingCode = store.bySession[session.id];
  if (existingCode && store.codes[existingCode]) return { gift: store.codes[existingCode], isNew: false };
  const md = session.metadata || {};
  const code = generateGiftCode(store.codes);
  const now = Date.now();
  const gift = {
    code,
    sessionId: session.id,
    buyerEmail: md.buyerEmail || session.customer_email || (session.customer_details && session.customer_details.email) || '',
    fromName: md.fromName || '',
    recipientName: md.recipientName || '',
    message: md.message || '',
    kind: md.kind === 'pora' ? 'pora' : 'asmenine',
    klausk: md.klausk === '1',
    recipientEmail: md.recipientEmail || '',
    sendAt: md.sendAt || '',
    sendHour: md.sendHour !== undefined && md.sendHour !== '' ? parseInt(md.sendHour, 10) : 8,
    season: md.season || '',
    amount: session.amount_total,
    currency: session.currency,
    status: 'active',
    createdAt: now,
    expiresAt: now + GIFT_VALID_DAYS * 24 * 60 * 60 * 1000
  };
  store.codes[code] = gift;
  store.bySession[session.id] = code;
  saveGiftStore(store);
  console.log(`[gift] išduotas kodas ${code} (session=${session.id})`);
  return { gift, isNew: true };
}

// Duomenų kiekio mažinimas (BDAR 5(1)(c)): praėjus 90 d. po kupono
// panaudojimo / anuliavimo / galiojimo pabaigos, įrašas (su vardais,
// palinkėjimu ir pirkėjo el. paštu) ištrinamas. Mokėjimo įrašai lieka Stripe.
function cleanupGiftStore() {
  try {
    const store = loadGiftStore();
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const [code, g] of Object.entries(store.codes)) {
      const end = g.redeemedAt || g.voidAt || g.expiresAt;
      if (end && end < cutoff) {
        delete store.codes[code];
        if (store.bySession[g.sessionId] === code) delete store.bySession[g.sessionId];
        changed = true;
      }
    }
    if (changed) { saveGiftStore(store); console.log('[gift] išvalyti seni kuponų įrašai'); }
  } catch (e) { console.error('[gift] valymo klaida:', e.message); }
}
cleanupGiftStore();
setInterval(cleanupGiftStore, 24 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// PORŲ SUDERINAMUMAS (/pora)
// ═══════════════════════════════════════════════════════════════════
// Eiga: /pora puslapyje įvedami abu vardai ir el. paštas → Stripe Checkout
// (19,99 €) → grįžtama į /?pora=SESSION_ID → app porų režimu nufotografuoja
// abiejų partnerių delnus (po 2) → /pora/start paleidžia analizę → rezultatas
// saugomas SHARED_STORAGE_DIR/pora-orders.json (vienas užsakymas = viena
// analizė; grįžus ta pačia nuoroda rodomas tas pats rezultatas).
const PORA_ORDERS_FILE = path.join(SHARED_STORAGE_DIR, 'pora-orders.json');
const PORA_PRICE_CENTS = parseInt(process.env.PORA_PRICE_CENTS || '1999', 10);
// Dovanų kupone visada įskaičiuoti 3 „Klausk savo delnų“ klausimai — prie dovanos kainos pridedama
const GIFT_KLAUSK_CENTS = parseInt(process.env.GIFT_KLAUSK_CENTS || '200', 10);
// Porų dovanoje klausimai — nemokamas priedas (kaina lieka iki 20 €)
const GIFT_KLAUSK_PORA_CENTS = parseInt(process.env.GIFT_KLAUSK_PORA_CENTS || '0', 10);
// Porų analizės kaina rinkinyje su asmenine analize (mokėjimo ir rezultato ekrane)
const PORA_BUNDLE_CENTS = parseInt(process.env.PORA_BUNDLE_CENTS || '1299', 10);
const PORA_RESULT_KEYS = ['traukia', 'bendravimas', 'papildo', 'trintis', 'ateitis', 'stiprybe', 'patarimai'];
// Šešios santykių sritys (0–100) — iš jų skaičiuojamas bendras suderinamumas
const PORA_DIMENSIONS = ['jausmai', 'bendravimas', 'vertybes', 'kasdienybe', 'trauka', 'ateitis'];
// Delnų palyginimai: kiekvienam — abiejų partnerių bruožas ir ką jų derinys reiškia porai
const PORA_COMPARE_KEYS = ['sirdies', 'galvos', 'gyvenimo', 'forma'];

function loadPoraOrders() {
  try {
    if (fs.existsSync(PORA_ORDERS_FILE)) return JSON.parse(fs.readFileSync(PORA_ORDERS_FILE, 'utf8')) || {};
  } catch (e) { console.error('[pora] nepavyko nuskaityti pora-orders.json:', e.message); }
  return {};
}
function savePoraOrders(orders) {
  const tmp = PORA_ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, PORA_ORDERS_FILE);
}
function updatePoraOrder(sessionId, patch) {
  const orders = loadPoraOrders();
  orders[sessionId] = { ...(orders[sessionId] || {}), ...patch };
  savePoraOrders(orders);
  return orders[sessionId];
}
// Pasenusių (>90 d.) užsakymų valymas paleidimo metu
(function cleanupPoraOrders() {
  try {
    const orders = loadPoraOrders(), cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const [id, o] of Object.entries(orders)) if ((o.createdAt || 0) < cutoff) { delete orders[id]; changed = true; }
    if (changed) savePoraOrders(orders);
  } catch (e) {}
})();

function isValidKlauskId(id) {
  return typeof id === 'string' && ((id.startsWith('cs_') && id.length <= 200) || /^kp_[a-f0-9]{24}$/.test(id));
}
function isValidCheckoutSessionId(id) {
  return typeof id === 'string' && ((id.startsWith('cs_') && id.length <= 200) || /^gp_[a-f0-9]{24}$/.test(id));
}

// Patikrina Stripe sesiją ir grąžina užsakymo duomenis (arba null, jei neapmokėta / ne porų).
// gp_… — užsakymas, sukurtas panaudojus porų dovanų kuponą (apmokėtas kuponu).
async function getPaidPoraSession(sessionId) {
  if (sessionId.startsWith('gp_')) {
    const o = loadPoraOrders()[sessionId];
    if (!o || !o.gift) return null;
    return { nameA: o.nameA || '', nameB: o.nameB || '', email: o.email || '', amount: 0, gift: o.gift };
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session || !session.metadata || session.metadata.type !== 'pora') return null;
  if (session.payment_status !== 'paid') return null;
  if (session.metadata.promo) markPromoUsed(session.metadata.promo, session.id);
  markEmailPaid(session.metadata.email || session.customer_email || '');
  return {
    nameA: session.metadata.nameA || '',
    nameB: session.metadata.nameB || '',
    email: session.metadata.email || session.customer_email || '',
    amount: session.amount_total || PORA_PRICE_CENTS
  };
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 78;
  return Math.max(55, Math.min(97, v));
}

// Lietuviškų vardų linksniai porų tekstams — AI duodamos tikslios formos, kad nerašytų
// „pasakyk Darius“ ar „Ugne randa Darius ramybę“. Nežinomos galūnės — grąžinama tuščia eilutė.
// Porų užsakymo numeris (rodomas PDF, laiške ir admin pranešime) — iš užsakymo ID, be atskiros saugyklos
function poraOrderNo(sid) { return 'P-' + String(sid || '').replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase(); }
function ltFormsObj(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž-]{3,}$/.test(n)) return null;
  const end = (k) => n.toLowerCase().endsWith(k);
  const soft = (b) => b.replace(/t$/, 'č').replace(/d$/, 'dž');
  let f = null;
  if (end('us')) { const b = n.slice(0, -2); f = [b + 'aus', b + 'ui', b + 'ų', b + 'umi', b + 'au']; }
  else if (end('as')) { const b = n.slice(0, -2); f = [b + 'o', b + 'ui', b + 'ą', b + 'u', b + 'ai']; }
  else if (end('is') || end('ys')) { const b = n.slice(0, -2); f = [soft(b) + 'io', soft(b) + 'iui', b + 'į', soft(b) + 'iu', b + (end('ys') ? 'y' : 'i')]; }
  else if (end('ė') || end('e')) { const b = n.slice(0, -1); f = [b + 'ės', b + 'ei', b + 'ę', b + 'e', b + 'e']; }
  else if (end('a')) { const b = n.slice(0, -1); f = [b + 'os', b + 'ai', b + 'ą', b + 'a', b + 'a']; }
  return f ? { nom: n, gen: f[0], dat: f[1], acc: f[2], ins: f[3], voc: f[4] } : null;
}
function ltNameForms(name) {
  const f = ltFormsObj(name);
  return f ? `${f.nom}: kilm. ${f.gen}, naud. ${f.dat}, gal. ${f.acc}, įnag. ${f.ins}, šauksm. ${f.voc}` : '';
}
// Frazės (pvz. „Ieva ir Tomas“) linksniavimas laiškams: kiekvienas žodis atskirai, „ir“ ir nežinomos galūnės nekeičiamos
function ltPhrase(s, c) { return String(s || '').split(/(\s+)/).map(w => /^\s*$/.test(w) || w.toLowerCase() === 'ir' ? w : ((ltFormsObj(w) || {})[c] || w)).join(''); }
// Bendros taisyklės apie vardus porų tekstuose (analizė ir „Klauskite“)
function poraNameRules(A, B) {
  const forms = [ltNameForms(A), ltNameForms(B)].filter(Boolean);
  return `- VARDUS NAUDOK SAIKINGAI — tekstas turi skambėti profesionaliai, taktiškai ir natūraliai, o ne komiškai. Viename skyriuje kiekvieną vardą naudok ne daugiau kaip 1–2 kartus. Dažniausiai rašyk apie jus kaip porą („jūs abu“, „jums abiem“, „vienas iš jūsų“, „kitas“), o vardą rašyk tik ten, kur be jo neaišku, apie ką kalbama. Nesikreipk į vieną iš jų vardu (NE „${A}, pasakyk…“) — patarimus rašyk abiem kartu („pasakykite vienas kitam…“). Trumpose įžvalgose vardų nenaudok.
- Kai vardą naudoji, linksniuok jį taisyklingai${forms.length ? ' — naudok TIKSLIAI šias formas: ' + forms.join('; ') : ''}.`;
}

async function runCoupleAnalysis(photos, nameA, nameB) {
  const A = nameA || 'Pirmasis partneris', B = nameB || 'Antrasis partneris';
  const img = p => ({ type: 'image', source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data } });
  const content = [
    { type: 'text', text: `${A} — kairysis delnas:` }, img(photos[0]),
    { type: 'text', text: `${A} — dešinysis delnas:` }, img(photos[1]),
    { type: 'text', text: `${B} — kairysis delnas:` }, img(photos[2]),
    { type: 'text', text: `${B} — dešinysis delnas:` }, img(photos[3]),
    {
      type: 'text',
      text: `PIRMENYBĖ: šį tekstą skaitys du realūs žmonės, sumokėję pinigus, gimtąja lietuvių kalba. Taisyklinga, natūrali lietuvių kalba yra tiek pat svarbi kaip turinys.

Tu esi chiromantijos meistras su 20 metų patirtimi. Prieš tave — dviejų žmonių, ${A} ir ${B}, abiejų delnų nuotraukos (po kairįjį ir dešinįjį). Tavo užduotis — kuo tiksliau palyginti JŲ KONKREČIUS delnus ir parašyti poros suderinamumo analizę.

KAIP ANALIZUOTI (darbo eiga, svarbiausia tikslumui):
1. Atidžiai išnagrinėk kiekvieną iš 4 nuotraukų atskirai: delno formą (kvadratinis / pailgas, platus / siauras), pirštų ilgį palyginus su delnu, nykščio padėtį, širdies, galvos, gyvenimo ir likimo linijų ilgį, gylį, lenkimą, pradžią ir pabaigą, šakeles, ryškiausius kalnelius, kairio ir dešinio delno skirtumus (kairysis — prigimtis, dešinysis — kaip žmogus gyvena dabar).
2. Kiekvienai sričiai palygink abu žmones TARPUSAVYJE: kur bruožai panašūs (lengvas supratimas), kur priešingi, bet papildo, o kur priešingi ir kelia trintį.
3. Tik tada rašyk išvadas. Kiekvienas teiginys turi kilti iš to, ką MATAI būtent šiuose delnuose — ne bendros frazės, tinkančios bet kuriai porai. Dvi skirtingos poros turi gauti aiškiai skirtingas analizes ir balus.
4. Jei kurios nors linijos nuotraukoje neįžiūri — rašyk pagal tai, kas matoma aiškiausiai, ir nieko neišsigalvok.

TAISYKLĖS:
- Kreipkis į abu kartu „jūs“ forma (jūs, jūsų, jums), esamuoju laiku.
${poraNameRules(A, B)}
- Skyrių tekstuose (traukia…patarimai) PATIEMS fiziniams požymiams vietos neskirk — rašyk išvadas apie jų santykį. Fiziniai požymiai aprašomi TIK lauke „palyginimai“.
- Tonas šiltas, pozityvus ir sąžiningas: trintis aprašyk kaip augimo galimybes, ne kaip grėsmes. Nieko nepranašauk apie išsiskyrimą, ligas ar nelaimes.
- JSON formatui: teksto viduje NIEKADA nenaudok dvigubų kabučių ". Jei reikia pabrėžti — naudok 'apostrofus'.
- Įžvalgos (izvalgos) ir poros bruožai — TA PAČIA „jūs“ forma kaip tekstas: NIEKADA trečiojo asmens veiksmažodis be „jūs/jūsų“ (KLAIDA: „Vengia konfliktų“, „Siekia artumo“ — teisingai: „Vengiate konfliktų“, „Jūsų siekis — artumas“).

${klauskLangRules('jūs', { physicalOk: true, extraCheck: '5. Ar įžvalgos parašytos „jūs“ forma, o skyriuose nėra fizinių požymių?' })}
- Kiekvienas skyrius: 9–12 sakinių, išsamus ir sklandus tekstas (ne sąrašas), su konkrečiais kasdienio gyvenimo pavyzdžiais, kaip tai pasireiškia jūsų santykiuose; skyriai nesikartoja tarpusavyje.

PALYGINIMAI (pildyk PIRMIAUSIA — tai tavo stebėjimų pagrindas): keturios sritys — sirdies (širdies linija: jausmai), galvos (galvos linija: mąstymas ir sprendimai), gyvenimo (gyvenimo linija: gyvenimo tempas ir jėgos), forma (delnų forma ir pirštai: charakteris). Kiekvienai:
- a: ką matai ${A} delnuose ir ką tai reiškia (iki 120 simbolių, pvz. Ilgos, švelniai lenktos — jausmus reiškia atvirai ir šiltai). Apie delnus ir linijas visada rašyk DAUGISKAITA (delnai, linijos), nes kiekvienas turi du delnus — niekada „delnas“, „delno“, „linija“ apie vieną žmogų.
- b: tas pats apie ${B} (iki 120 simbolių)
- isvada: ką šių dviejų bruožų derinys reiškia jūsų porai ir kaip tai jaučiasi kasdien (2 sakiniai, iki 260 simbolių)

SRITYS (balai 0–100, įvertink kiekvieną atskirai pagal palyginimus; balai turi skirtis tarpusavyje ir atspindėti šią porą): jausmai (jausmai ir artumas), bendravimas, vertybes (vertybės ir požiūris), kasdienybe (kasdienybė ir gyvenimo ritmas), trauka (trauka ir aistra), ateitis (ateities planai). Kiekvienai — tik balas (sveikas skaičius 55–98); iš jų skaičiuojamas bendras suderinamumas.

SKYRIAI:
- traukia (Kas jus traukia vienas prie kito): kas jus natūraliai sieja ir ko kiekvienas randa kitame
- bendravimas (Kaip bendraujate ir sprendžiate nesutarimus): jūsų bendravimo stiliai, kaip jie dera, kaip geriausiai išspręsti nesutarimus
- papildo (Kuo vienas kitą papildote): kur vieno stiprybė užpildo kito silpnesnę vietą
- trintis (Kur gali kilti trintis): 2–3 konkrečios sritys ir kaip su jomis tvarkytis
- ateitis (Požiūris į pinigus, namus ir ateitį): kur jūsų požiūriai sutampa ir kur verta susitarti
- stiprybe (Jūsų poros stiprybė): kas daro jūsų porą išskirtinę
- patarimai (Patarimai jums abiem): 3–4 praktiški patarimai, parašyti sklandžiu tekstu

Taip pat:
- poros_bruozai: 3 trumpos (2–4 žodžių) frazės, apibūdinančios šią porą (pvz. Gilus tarpusavio supratimas)
- izvalgos: kiekvienam skyriui (traukia…patarimai) 3 trumpi sakiniai (iki 8 žodžių) „jūs“ forma, be vardų — NAUJI faktai, kurie PAPILDO skyriaus tekstą ir jo nekartoja (pvz. Jums lengva susitarti dėl svarbiausių dalykų)

ATSAKYK TIKTAI JSON (laukų tvarka svarbi):
{"palyginimai":{"sirdies":{"a":"...","b":"...","isvada":"..."},"galvos":{"a":"...","b":"...","isvada":"..."},"gyvenimo":{"a":"...","b":"...","isvada":"..."},"forma":{"a":"...","b":"...","isvada":"..."}},"sritys":{"jausmai":{"balas":84},"bendravimas":{"balas":76},"vertybes":{"balas":88},"kasdienybe":{"balas":71},"trauka":{"balas":90},"ateitis":{"balas":80}},"poros_bruozai":["...","...","..."],"izvalgos":{"traukia":["...","...","..."],"bendravimas":["...","...","..."],"papildo":["...","...","..."],"trintis":["...","...","..."],"ateitis":["...","...","..."],"stiprybe":["...","...","..."],"patarimai":["...","...","..."]},"traukia":"...","bendravimas":"...","papildo":"...","trintis":"...","ateitis":"...","stiprybe":"...","patarimai":"..."}`
    }
  ];
  let data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16000, temperature: 0.2, messages: [{ role: 'user', content }, { role: 'assistant', content: '{' }] })
      }, 220000);
      data = await r.json();
    } catch (e) {
      console.log(`[pora] AI tinklo klaida, bandymas ${attempt}/3: ${e.message}`);
      data = null;
    }
    if (data && !data.error && data.content && data.content.length) break;
    if (data && data.error && ['invalid_request_error', 'authentication_error', 'permission_error'].includes(data.error.type)) break;
    if (attempt < 3) await new Promise(res => setTimeout(res, 3000 * attempt));
  }
  if (!data || data.error || !data.content) throw new Error(data && data.error ? `${data.error.type}: ${data.error.message || ''}` : 'Tuščias AI atsakymas');
  if (data.stop_reason === 'max_tokens') throw new Error('Atsakymas nukirptas');
  const text = '{' + data.content.map(b => b.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON nerastas');
  const raw = parseJsonLenient(m[0]);
  const fix = (t, max) => applyTextFixes(String(t).trim().slice(0, max)).text;
  // Sritys: balai 55–98; bendras suderinamumas — sričių vidurkis (nuoseklu su tuo, ką mato vartotojas)
  const sritys = {};
  const rs = raw.sritys && typeof raw.sritys === 'object' ? raw.sritys : {};
  for (const k of PORA_DIMENSIONS) {
    const d = rs[k] || {};
    const v = Math.round(Number(d.balas));
    if (Number.isFinite(v)) sritys[k] = { balas: Math.max(55, Math.min(98, v)), fraze: typeof d.fraze === 'string' ? fix(d.fraze, 70) : '', aprasymas: typeof d.aprasymas === 'string' ? fix(d.aprasymas, 300) : '' };
  }
  const allDims = PORA_DIMENSIONS.every(k => sritys[k]);
  const avg = allDims ? PORA_DIMENSIONS.reduce((a, k) => a + sritys[k].balas, 0) / PORA_DIMENSIONS.length : raw.suderinamumas;
  const out = { suderinamumas: clampScore(avg) };
  if (allDims) out.sritys = sritys;
  else console.log('[pora] AI nepateikė visų sričių balų — rodomas tik bendras įvertis');
  // Delnų palyginimai (neprivalomi — jei AI jų nepateikė, rezultatas vis tiek rodomas)
  const rp = raw.palyginimai && typeof raw.palyginimai === 'object' ? raw.palyginimai : {};
  const pal = {};
  for (const k of PORA_COMPARE_KEYS) {
    const c = rp[k];
    if (c && typeof c.a === 'string' && typeof c.b === 'string' && c.a.trim() && c.b.trim()) {
      pal[k] = { a: fix(c.a, 150), b: fix(c.b, 150), isvada: typeof c.isvada === 'string' ? fix(c.isvada, 320) : '' };
    }
  }
  if (Object.keys(pal).length) out.palyginimai = pal;
  // Įžvalgų kortelės prie kiekvieno skyriaus (kaip asmeninėje analizėje)
  const ri = raw.izvalgos && typeof raw.izvalgos === 'object' ? raw.izvalgos : {};
  const izv = {};
  for (const k of PORA_RESULT_KEYS) {
    const arr = Array.isArray(ri[k]) ? ri[k].filter(x => typeof x === 'string' && x.trim()).slice(0, 3).map(x => fix(x, 90)) : [];
    if (arr.length) izv[k] = arr;
  }
  if (Object.keys(izv).length) out.izvalgos = izv;
  for (const k of PORA_RESULT_KEYS) {
    if (typeof raw[k] !== 'string' || !raw[k].trim()) throw new Error(`Trūksta skyriaus: ${k}`);
    out[k] = applyTextFixes(raw[k].trim()).text;
  }
  out.poros_bruozai = (Array.isArray(raw.poros_bruozai) ? raw.poros_bruozai : [])
    .filter(s => typeof s === 'string' && s.trim()).slice(0, 3).map(s => applyTextFixes(s.trim().slice(0, 60)).text);
  return out;
}

app.get('/pora', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'pora.html'));
});

app.post('/pora/create-checkout', sensitiveLimiter, async (req, res) => {
  try {
    const { email, nameA, nameB } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (!nameA || !nameB || !isValidName(nameA) || !isValidName(nameB)) return res.status(400).json({ error: 'Įrašykite abu vardus' });
    const base = appBaseUrl();
    // Nuolaidos kodas: grįžimas po nebaigto mokėjimo (−15 %) arba rinkinio kaina po asmeninės analizės
    const pr = getValidPromo(req.body.promo, 'pora');
    const amount = pr ? promoAmount(pr, PORA_PRICE_CENTS) : PORA_PRICE_CENTS;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'revolut_pay'],
      line_items: [{
        price_data: { currency: 'eur', unit_amount: amount, product_data: { name: pr ? `DELNAS — Porų suderinamumas (${pr.kind === 'bundle' ? 'rinkinio kaina' : 'nuolaida'})` : 'DELNAS — Porų suderinamumas' } },
        quantity: 1
      }],
      locale: 'lt',
      customer_email: email,
      metadata: { type: 'pora', email, nameA: nameA.trim(), nameB: nameB.trim(), promo: pr ? pr.code : '' },
      success_url: `${base}/?pora={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/pora${pr ? '?promo=' + pr.code : ''}`
    });
    if (req.body.remind === true) noteAbandonCandidate({ kind: 'pora', email, nameA: nameA.trim(), nameB: nameB.trim(), ref: session.id });
    res.json({ url: session.url });
  } catch (err) {
    console.error('/pora/create-checkout klaida:', err);
    res.status(500).json({ error: 'Nepavyko pradėti mokėjimo. Pabandykite dar kartą.' });
  }
});

// Ar užsakymas apmokėtas ir kokia jo būsena (app porų režimui)
app.get('/pora/check', sensitiveLimiter, async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!isValidCheckoutSessionId(sessionId)) return res.status(400).json({ paid: false });
    const order = loadPoraOrders()[sessionId];
    if (order && order.status === 'done') return res.json({ paid: true, nameA: order.nameA, nameB: order.nameB, status: 'done', result: order.result });
    const s = await getPaidPoraSession(sessionId);
    if (!s) return res.json({ paid: false });
    res.json({ paid: true, nameA: s.nameA, nameB: s.nameB, status: order ? order.status : 'new' });
  } catch (err) {
    console.error('/pora/check klaida:', err);
    res.status(500).json({ paid: false, error: 'Nepavyko patikrinti užsakymo' });
  }
});

app.post('/pora/start', sensitiveLimiter, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    let { photos } = req.body || {};
    if (!isValidCheckoutSessionId(sessionId)) return res.status(400).json({ error: 'Neteisingas užsakymas' });
    const existing = loadPoraOrders()[sessionId];
    // Nuotolinis režimas: pirmojo partnerio nuotraukos jau išsaugotos, antrasis atsiunčia savo 2
    if (existing && existing.status === 'waiting_partner' && Array.isArray(photos) && photos.length === 2) {
      const first = loadPoraFirstPhotos(sessionId);
      if (!first) return res.status(410).json({ error: 'Pirmojo partnerio nuotraukos nebegalioja — nufotografuokite abu iš naujo' });
      photos = [...first, ...photos];
    }
    if (!isValidPhotosArray(photos) || photos.length !== 4) return res.status(400).json({ error: 'Reikia 4 delnų nuotraukų' });
    // Viena analizė vienam užsakymui: jei jau baigta ar vykdoma — nepaleidžiame iš naujo
    if (existing && (existing.status === 'done' || (existing.status === 'pending' && Date.now() - existing.startedAt < 10 * 60 * 1000))) {
      return res.json({ started: true, status: existing.status });
    }
    const s = await getPaidPoraSession(sessionId);
    if (!s) return res.status(403).json({ error: 'Užsakymas neapmokėtas' });
    const isFirst = !existing || (existing.status === 'waiting_partner' && !existing.gift);
    if (isFirst && !sessionId.startsWith('gp_')) statInc('pora_paid');
    deletePoraFirstPhotos(sessionId);
    updatePoraOrder(sessionId, { nameA: s.nameA, nameB: s.nameB, email: s.email, amount: s.amount, status: 'pending', error: null, startedAt: Date.now(), createdAt: (existing && existing.createdAt) || Date.now() });
    res.json({ started: true, status: 'pending' });

    if (isFirst) {
      mailer.sendMail({
        from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
        to: ADMIN_EMAIL,
        subject: `Nauja porų analizė — ${s.nameA} ir ${s.nameB}`,
        html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Nauja porų analizė</h2>
          <p><strong>Užsakymo numeris:</strong> ${poraOrderNo(sessionId)}</p>
          <p><strong>Pora:</strong> ${escapeHtml(s.nameA)} ir ${escapeHtml(s.nameB)}</p>
          <p><strong>El. paštas:</strong> ${escapeHtml(s.email)}</p>
          <p><strong>Suma:</strong> ${(s.amount / 100).toFixed(2).replace('.', ',')} €</p>
          <p><strong>Stripe session:</strong> ${escapeHtml(sessionId)}</p></div>`
      }).catch(e => console.error('[pora] admin laiško klaida:', e.message));
    }

    runCoupleAnalysis(photos, s.nameA, s.nameB)
      .then(result => { updatePoraOrder(sessionId, { status: 'done', result, finishedAt: Date.now() }); console.log(`[pora] analizė baigta ${sessionId}`); })
      .catch(err => {
        updatePoraOrder(sessionId, { status: 'error', error: err.message });
        console.error(`[pora] analizės klaida ${sessionId}:`, err.message);
        mailer.sendMail({
          from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
          to: ADMIN_EMAIL,
          subject: '[KLAIDA] Porų analizė nepavyko',
          html: `<div style="font-family:Georgia,serif;padding:20px"><p>Pora: ${escapeHtml(s.nameA)} ir ${escapeHtml(s.nameB)} (${escapeHtml(s.email)})</p><p>Klaida: ${escapeHtml(err.message)}</p><p>Stripe session: ${escapeHtml(sessionId)}</p><p>Klientas gali bandyti dar kartą ta pačia nuoroda.</p></div>`
        }).catch(() => {});
      });
  } catch (err) {
    console.error('/pora/start klaida:', err);
    res.status(500).json({ error: 'Nepavyko pradėti analizės' });
  }
});

// ── Nuotolinis režimas: pirmojo partnerio nuotraukos laikinai (iki 48 val.) ──
const PORA_PHOTOS_DIR = path.join(SHARED_STORAGE_DIR, 'pora-photos');
function poraPhotosFile(id) { return path.join(PORA_PHOTOS_DIR, id.replace(/[^A-Za-z0-9_]/g, '') + '.json'); }
function loadPoraFirstPhotos(id) {
  try { const f = poraPhotosFile(id); if (!fs.existsSync(f)) return null; const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d.photos) && d.photos.length === 2 ? d.photos : null; } catch (e) { return null; }
}
function deletePoraFirstPhotos(id) { try { fs.unlinkSync(poraPhotosFile(id)); } catch (e) {} }
function cleanupPoraPhotos() {
  try {
    if (!fs.existsSync(PORA_PHOTOS_DIR)) return;
    const cutoff = Date.now() - 48 * 3600e3;
    for (const f of fs.readdirSync(PORA_PHOTOS_DIR)) { const fp = path.join(PORA_PHOTOS_DIR, f); try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (e) {} }
  } catch (e) {}
}
cleanupPoraPhotos();
setInterval(cleanupPoraPhotos, 3 * 3600e3);

app.post('/pora/save-first', sensitiveLimiter, async (req, res) => {
  try {
    const { sessionId, photos } = req.body || {};
    if (!isValidCheckoutSessionId(sessionId)) return res.status(400).json({ error: 'Neteisingas užsakymas' });
    if (!isValidPhotosArray(photos) || photos.length !== 2) return res.status(400).json({ error: 'Reikia 2 delnų nuotraukų' });
    const existing = loadPoraOrders()[sessionId];
    if (existing && ['done', 'pending'].includes(existing.status)) return res.status(409).json({ error: 'Analizė jau vykdoma arba baigta' });
    const s = await getPaidPoraSession(sessionId);
    if (!s) return res.status(403).json({ error: 'Užsakymas neapmokėtas' });
    fs.mkdirSync(PORA_PHOTOS_DIR, { recursive: true });
    const f = poraPhotosFile(sessionId), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ photos, at: Date.now() })); fs.renameSync(tmp, f);
    updatePoraOrder(sessionId, { nameA: s.nameA, nameB: s.nameB, email: s.email, amount: s.amount, status: 'waiting_partner', firstSavedAt: Date.now(), createdAt: (existing && existing.createdAt) || Date.now(), ...(s.gift ? { gift: s.gift } : {}) });
    res.json({ ok: true, link: `${appBaseUrl()}/?pora=${encodeURIComponent(sessionId)}&partneris=1` });
  } catch (err) {
    console.error('/pora/save-first klaida:', err);
    res.status(500).json({ error: 'Nepavyko išsaugoti nuotraukų' });
  }
});

app.get('/pora/status', (req, res) => {
  const sessionId = req.query.session_id;
  if (!isValidCheckoutSessionId(sessionId)) return res.status(400).json({ status: 'notfound' });
  const o = loadPoraOrders()[sessionId];
  if (!o) return res.json({ status: 'notfound' });
  res.json({ status: o.status, result: o.status === 'done' ? o.result : undefined, error: o.status === 'error' ? 'Analizė nepavyko' : undefined });
});

// Rezultato PDF laiškas užsakovui (vieną kartą užsakymui)
const poraEmailsInFlight = new Set();
app.post('/pora/email-pdf', sensitiveLimiter, async (req, res) => {
  try {
    const { sessionId, pdfBase64 } = req.body || {};
    if (!isValidCheckoutSessionId(sessionId)) return res.status(400).json({ error: 'Neteisingas užsakymas' });
    if (typeof pdfBase64 !== 'string' || !pdfBase64.length || pdfBase64.length > 15_000_000 || !/^[A-Za-z0-9+/=]+$/.test(pdfBase64)) return res.status(400).json({ error: 'Neteisingas PDF' });
    const o = loadPoraOrders()[sessionId];
    if (!o || o.status !== 'done' || !isValidEmail(o.email)) return res.status(400).json({ error: 'Rezultatas dar neparuoštas' });
    if (o.emailSent || poraEmailsInFlight.has(sessionId)) return res.json({ ok: true, alreadySent: true });
    poraEmailsInFlight.add(sessionId);
    const names = `${escapeHtml(o.nameA)} ir ${escapeHtml(o.nameB)}`;
    await mailer.sendMail({
      from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
      to: o.email,
      subject: `${o.nameA} ir ${o.nameB} — jūsų porų suderinamumas paruoštas 💞`,
      html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:26px;margin-bottom:8px;color:#d4a843">💞</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:10px">${o.gift ? 'Jūsų dovana paruošta!' : 'Mokėjimas gautas, ačiū!'}</div><div style="font-size:15px;color:rgba(245,238,216,.85);margin-bottom:6px">${names} — jūsų porų suderinamumas paruoštas.</div><div style="font-size:34px;font-weight:700;color:#f0c96a;margin:14px 0 18px">${o.result.suderinamumas}%</div><p style="font-size:14px;line-height:1.7;color:rgba(245,238,216,.8);margin:0 0 6px">Pridėtame PDF faile rasite visą analizę.</p><p style="font-size:12px;color:rgba(245,238,216,.55);margin:6px 0 0">Užsakymo numeris: ${poraOrderNo(sessionId)}</p><p style="font-size:13px;line-height:1.6;color:rgba(245,238,216,.7);margin:18px 0 0">Norite sužinoti ir savo asmeninį gyvenimo žemėlapį?</p><a href="${appBaseUrl()}/?utm_source=email&amp;utm_campaign=pora" style="display:inline-block;margin-top:10px;border:1px solid #d4a843;border-radius:999px;padding:10px 20px;color:#d4a843;font-size:14px;font-weight:700;text-decoration:none">Asmeninė delnų analizė →</a>${EMAIL_FOOTER_HTML}</div>`,
      attachments: [{ filename: `${(o.nameA + '-ir-' + o.nameB).replace(/\s+/g, '-')}-poru-suderinamumas.pdf`, content: pdfBase64, encoding: 'base64' }]
    }).finally(() => poraEmailsInFlight.delete(sessionId));
    updatePoraOrder(sessionId, { emailSent: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('/pora/email-pdf klaida:', err);
    res.status(500).json({ error: 'Nepavyko išsiųsti laiško' });
  }
});

// Porų dovanų kupono panaudojimas: /pora?dovana=KODAS → įvedami abu vardai ir
// el. paštas → sukuriamas „apmokėtas“ porų užsakymas gp_… → /?pora=gp_…
app.post('/pora/redeem-gift', sensitiveLimiter, async (req, res) => {
  try {
    const { code: rawCode, nameA, nameB, email } = req.body || {};
    const code = normalizeGiftCode(rawCode);
    if (!code) return res.status(400).json({ error: 'Neteisingas dovanos kodas' });
    const store = loadGiftStore();
    const gift = store.codes[code];
    const status = giftStatus(gift);
    if (status === 'not_found') return res.status(404).json({ status, error: 'Dovanos kodas nerastas' });
    if (gift.kind !== 'pora') return res.status(409).json({ status, kind: 'asmenine', error: 'Tai asmeninės analizės kuponas' });
    // Jau panaudotas — grąžiname tą patį užsakymą (pvz. uždarė langą prieš fotografuodami)
    if (status === 'redeemed' && gift.poraOrderId) return res.json({ ok: true, id: gift.poraOrderId });
    if (status === 'expired') return res.status(410).json({ status, error: 'Dovanos kodo galiojimas baigėsi' });
    if (status !== 'active') return res.status(410).json({ status, error: 'Dovanos kodas nebegalioja' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (!nameA || !nameB || !isValidName(nameA) || !isValidName(nameB)) return res.status(400).json({ error: 'Įrašykite abu vardus' });
    if (await isGiftRefunded(gift)) {
      gift.status = 'void'; gift.voidReason = 'refunded'; gift.voidAt = Date.now(); saveGiftStore(store);
      return res.status(410).json({ status: 'void', error: 'Dovanos kodas nebegalioja' });
    }
    // Po async patikrinimo — perskaitome iš naujo (vienkartiškumas)
    const fresh = loadGiftStore();
    const g = fresh.codes[code];
    if (giftStatus(g) !== 'active') {
      if (g && g.poraOrderId) return res.json({ ok: true, id: g.poraOrderId });
      return res.status(409).json({ error: 'Šis dovanos kodas jau panaudotas' });
    }
    const id = 'gp_' + crypto.randomBytes(12).toString('hex');
    const A = nameA.trim(), B = nameB.trim(), em = email.trim();
    updatePoraOrder(id, { nameA: A, nameB: B, email: em, amount: 0, gift: code, status: 'new', createdAt: Date.now() });
    g.status = 'redeemed'; g.redeemedAt = Date.now(); g.redeemedName = `${A} ir ${B}`; g.redeemedEmail = em; g.poraOrderId = id;
    saveGiftStore(fresh);
    console.log(`[gift] panaudotas porų kodas ${code} → ${id}`);
    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `Panaudotas porų dovanų kuponas ${code} — ${A} ir ${B}`,
      html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Panaudotas porų dovanų kuponas</h2>
        <p><strong>Kodas:</strong> ${escapeHtml(code)}</p>
        <p><strong>Pora:</strong> ${escapeHtml(A)} ir ${escapeHtml(B)} (${escapeHtml(em)})</p>
        <p><strong>Pirko:</strong> ${escapeHtml(g.buyerEmail || '—')}</p>
        <p><strong>Užsakymas:</strong> ${escapeHtml(id)}</p></div>`
    }).catch(e => console.error('[gift] admin laiško klaida:', e.message));
    res.json({ ok: true, id });
  } catch (err) {
    console.error('/pora/redeem-gift klaida:', err);
    res.status(500).json({ error: 'Nepavyko panaudoti dovanos kodo' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// „KLAUSK SAVO DELNŲ“ (/klausk) — mokamas priedas po asmeninės analizės
// ═══════════════════════════════════════════════════════════════════
// Eiga: rezultato ekrane → /klausk/create-checkout (išsaugoma analizės
// santrauka) → Stripe (naujame skirtuke) → /klausk?s=SESSION_ID → iki 3
// klausimų, atsakymai remiasi asmenine analize; kiekvienas atsakymas ir el. paštu.
const KLAUSK_ORDERS_FILE = path.join(SHARED_STORAGE_DIR, 'klausk-orders.json');
const KLAUSK_PRICE_CENTS = parseInt(process.env.KLAUSK_PRICE_CENTS || '499', 10);
const KLAUSK_MAX_QUESTIONS = 3;
const KLAUSK_RESULT_FIELDS = ['prigimtines_stiprybes', 'gyvenimo_tikslas', 'santykiai', 'finansai', 'galimybes', 'pokyciai', 'klutys'];
const KLAUSK_LIST_FIELDS = ['stiprybes_sarasas', 'prigimtines_insights', 'gyvenimo_insights', 'santykiai_insights', 'finansai_insights', 'galimybes_insights', 'pokyciai_insights', 'klutys_insights'];

function loadKlauskOrders() {
  try { if (fs.existsSync(KLAUSK_ORDERS_FILE)) return JSON.parse(fs.readFileSync(KLAUSK_ORDERS_FILE, 'utf8')) || {}; }
  catch (e) { console.error('[klausk] nepavyko nuskaityti klausk-orders.json:', e.message); }
  return {};
}
function saveKlauskOrders(o) {
  const tmp = KLAUSK_ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, KLAUSK_ORDERS_FILE);
}
// Neapmokėti įrašai — 1 d., apmokėti — 90 d.
function cleanupKlauskOrders() {
  try {
    const o = loadKlauskOrders(), now = Date.now(); let changed = false;
    for (const [id, r] of Object.entries(o)) {
      const ttl = r.paid ? 90 * 864e5 : 864e5;
      if ((r.createdAt || 0) < now - ttl) { delete o[id]; changed = true; }
    }
    if (changed) saveKlauskOrders(o);
  } catch (e) {}
}
cleanupKlauskOrders();
setInterval(cleanupKlauskOrders, 6 * 60 * 60 * 1000);

// Iš kliento atsiųsto rezultato paimame tik žinomus tekstinius laukus (su ribomis)
function pickKlauskResult(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const k of KLAUSK_RESULT_FIELDS) if (typeof r[k] === 'string' && r[k].trim()) out[k] = r[k].trim().slice(0, 3000);
  for (const k of KLAUSK_LIST_FIELDS) if (Array.isArray(r[k])) out[k] = r[k].filter(x => typeof x === 'string').slice(0, 6).map(x => x.slice(0, 200));
  if (r.potencialas && typeof r.potencialas === 'object') {
    out.potencialas = {};
    for (const [k, v] of Object.entries(r.potencialas).slice(0, 6)) if (v && typeof v.fraze === 'string') out.potencialas[k] = v.fraze.slice(0, 200);
  }
  const dg = r.delnai_greta;
  if (dg && typeof dg === 'object') {
    const t = [];
    for (const [k, l] of [['sirdis', 'Jausmai'], ['protas', 'Mąstymas'], ['gyvenimas', 'Gyvenimo tempas']]) if (dg[k] && typeof dg[k].kairys === 'string' && typeof dg[k].desinys === 'string') t.push(`${l}: prigimtis — ${dg[k].kairys.slice(0, 160)}; dabar — ${dg[k].desinys.slice(0, 160)}`);
    if (typeof dg.isvada === 'string') t.push(dg.isvada.slice(0, 400));
    if (t.length) out.delnai_greta = t.join('\n');
  }
  return Object.keys(out).length >= 4 ? out : null;
}

async function getPaidKlausk(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session || !session.metadata || session.metadata.type !== 'klausk') return null;
  if (session.payment_status !== 'paid') return null;
  return session;
}

function klauskContextText(res) {
  const L = { prigimtines_stiprybes: 'Prigimtinės stiprybės ir charakteris', gyvenimo_tikslas: 'Gyvenimo kryptis ir tikslai', santykiai: 'Bendravimas ir santykiai', finansai: 'Finansinis potencialas', galimybes: 'Unikalus sėkmės raktas', pokyciai: 'Artėjantys pokyčiai', klutys: 'Pažangą stabdančios kliūtys' };
  let t = '';
  const INS = { prigimtines_stiprybes: 'prigimtines_insights', gyvenimo_tikslas: 'gyvenimo_insights', santykiai: 'santykiai_insights', finansai: 'finansai_insights', galimybes: 'galimybes_insights', pokyciai: 'pokyciai_insights', klutys: 'klutys_insights' };
  for (const k of KLAUSK_RESULT_FIELDS) if (res[k]) t += `## ${L[k]}\n${res[k]}\n${(res[INS[k]] || []).join('; ')}\n\n`;
  if (res.stiprybes_sarasas) t += `## Stiprybės\n${res.stiprybes_sarasas.join(', ')}\n\n`;
  if (typeof res.delnai_greta === 'string') t += `## Kairysis (prigimtis) ir dešinysis (dabar) delnas\n${res.delnai_greta}\n\n`;
  if (res.potencialas) t += `## Potencialas\n${Object.entries(res.potencialas).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
  return t;
}

function klauskPoraContext(res) {
  const T = { traukia: 'Kas jus traukia vienas prie kito', bendravimas: 'Kaip bendraujate ir sprendžiate nesutarimus', papildo: 'Kuo vienas kitą papildote', trintis: 'Kur gali kilti trintis', ateitis: 'Požiūris į pinigus, namus ir ateitį', stiprybe: 'Jūsų poros stiprybė', patarimai: 'Patarimai jums abiem' };
  const C = { sirdies: 'Širdies linijos (jausmai)', galvos: 'Galvos linijos (mąstymas)', gyvenimo: 'Gyvenimo linijos (tempas)', forma: 'Delnų forma (charakteris)' };
  let t = `Suderinamumas: ${res.suderinamumas || ''}%\nPoros bruožai: ${(res.poros_bruozai || []).join(', ')}\n\n`;
  for (const [k, l] of Object.entries(C)) { const c = (res.palyginimai || {})[k]; if (c) t += `## ${l}\nA: ${c.a}\nB: ${c.b}\nIšvada: ${c.isvada || ''}\n\n`; }
  for (const [k, l] of Object.entries(T)) if (res[k]) t += `## ${l}\n${res[k]}\n${((res.izvalgos || {})[k] || []).join('; ')}\n\n`;
  return t;
}

// Klausimų atsakymų kalbos taisyklės — tokios pačios kaip asmeninės analizės punktų blokuose
// (taisyklinga kalba, vidutinis stilius, lyties neutralumas, be metaforų ir tuščių sakinių, galutinis patikrinimas).
function klauskLangRules(you, opts = {}) {
  const pl = you === 'jūs';
  return `KALBOS TAISYKLĖS (tokios pačios kaip asmeninės analizės tekste):
- Rašyk taisyklinga, natūralia lietuvių kalba, kreipdamasis „${pl ? 'jūs' : 'tu'}“ esamuoju laiku — taip, kaip natūraliai kalbėtų gimtakalbis lietuvis. Jei abejoji dėl retesnio žodžio formos, rinkis paprastesnį, tau gerai žinomą.
- Lytis nežinoma: NIEKADA nerašyk giminę turinčių dalyvių ir būdvardžių apie ${pl ? 'juos' : 'skaitytoją'} — NE „pasirengęs/-usi“, „atradęs“, „likęs“, „buvai atviras“, „esi ramus“, „laukdamas“; VIETOJ jų — asmenuojamas veiksmažodis + prieveiksmis (pvz. ${pl ? '„elgiatės ramiau“, „jausmus reiškiate atvirai“' : '„elgiesi ramiau“, „jausmus reiški atvirai“'}).
- Stiliaus lygis: VIDUTINIS — nei knyginis/mokslinis/oficialus, nei gatvės stiliaus su žargonu ar sutrumpinimais. Rašyk taip, kaip protingas, kultūringas žmogus kalbėtų rimtame, bet šiltame pokalbyje.
- DRAUDŽIAMA: sudėtingi, knyginiai žodžiai (pvz. „manifestuoja“, „transformacija“, „potencialas“ kaip terminas, „orientyras“, „dinamika“, „konsensusas“, „delegavimas“, „faktorius“, „kontempliacija“). Jei parašai žodį, kurio nevartotum kalbėdamas su draugu prie kavos — pakeisk paprastesniu, kasdieniu atitikmeniu.
- DRAUDŽIAMA: „gali būti“, „tikėtina“, „galima manyti“, „energija“, „vibracija“, žodis „galva“ (rašyk „protas“), „akcija“ reikšme „veiksmas“.
- DRAUDŽIAMA: metaforos ir palyginimai („kaip…“, „tarsi…“, „lyg…“), bendros frazės, kurios tiktų bet kam (pvz. „gyvenimas kupinas galimybių“), ${opts.physicalOk ? 'fiziniai delnų požymiai skyrių tekstuose (jie aprašomi TIK lauke „palyginimai“), žodis „galva“ (išskyrus pavadinimą „galvos linija“).' : 'linijų pavadinimai ir fiziniai delnų požymiai.'}
- DRAUDŽIAMA: tušti, „vatos“ sakiniai ir ilgi, keliais šalutiniais sakiniais apkrauti sakiniai — rašyk aiškiais, tvirtais sakiniais; kiekvienas sakinys turi nešti konkrečią mintį.
- Tekste nenaudok dvigubų kabučių.

GALUTINIS PATIKRINIMAS PRIEŠ ATSAKANT (privalomas): perskaityk KIEKVIENĄ sakinį iš naujo ir patikrink:
1. Ar jis taisyklingas — be rašybos, linksnių, galūnių ir skyrybos klaidų?
2. Ar jis aiškus iš pirmo skaitymo ir konkretus, susietas su šia analize?
3. Ar jame NĖRA giminę turinčio dalyvio ar būdvardžio apie ${pl ? 'juos' : 'skaitytoją'}?
4. Ar jame NĖRA draudžiamų žodžių, metaforų${opts.physicalOk ? ' (skyriuose — ir fizinių delnų požymių)' : ' ir fizinių delnų požymių'}?${opts.extraCheck ? '\n' + opts.extraCheck : ''}
Jei bent vienas atsakymas „ne“ — perrašyk sakinį ir patikrink jį dar kartą nuo pradžios.`;
}

async function answerKlausk(order, question) {
  if (order.kind === 'pora') return answerKlauskPora(order, question);
  const prev = (order.qa || []).map((x, i) => `${i + 1}. Klausimas: ${x.q}\nAtsakymas: ${x.a}`).join('\n\n');
  const name = order.name || '';
  const prompt = `Tu esi patyręs chiromantas ir šiltas, išmintingas patarėjas. Žemiau — ${name ? name + ' ' : 'žmogaus '}asmeninė delnų analizė (jau sugeneruota iš jo delnų nuotraukų). Žmogus užduoda asmeninį klausimą. Atsakyk remdamasis BŪTENT šia analize: jo stiprybėmis, kryptimi, santykių ir bendravimo būdu, finansiniu potencialu, artėjančiais pokyčiais ir kliūtimis.

ASMENINĖ DELNŲ ANALIZĖ:
${klauskContextText(order.result)}
${prev ? `ANKSČIAU UŽDUOTI KLAUSIMAI IR ATSAKYMAI (nesikartok):\n${prev}\n` : ''}
KLAUSIMAS: ${question}

KAIP ATSAKYTI:
- 7–10 sakinių, sklandus tekstas „tu“ forma, esamuoju laiku, šiltai ir konkrečiai. Pradėk iškart nuo esmės (be „Puikus klausimas“).
- Susiek atsakymą su 2–3 konkrečiais dalykais iš analizės (pvz. kokia jo stiprybė čia padės, kokia kliūtis trukdo) — kad žmogus jaustų, jog atsakymas skirtas būtent jam.
- Pabaigoje — 2–3 aiškūs, praktiški žingsniai, ką daryti dabar (sklandžiu tekstu, ne sąrašu).
- Tai savęs pažinimo patirtis, ne profesionali konsultacija. Nepranašauk mirties, ligų, nelaimių, išsiskyrimo ar konkrečių datų. Neduok medicininių, teisinių ar konkrečių investavimo patarimų — tokiu atveju švelniai pasakyk, kad dėl to verta pasitarti su specialistu, ir atsakyk tik apie tai, ką analizė sako apie žmogaus savybes ir sprendimų būdą.
- Jei klausimas rodo, kad žmogui labai sunku arba kyla minčių apie savęs žalojimą — atsakyk itin švelniai, palaikančiai ir paragink nedelsiant kreiptis pagalbos: Vilties linija 116 123 (visą parą), Jaunimo linija 8 800 28888, skubiai — 112.
- Jei klausimas visai nesusijęs su žmogaus gyvenimu (pvz. matematika, kodas) — trumpai ir maloniai paaiškink, kad atsakai tik į klausimus apie jo paties gyvenimą, ir pasiūlyk, ko galėtų paklausti.
${klauskLangRules('tu')}

ATSAKYK TIK ATSAKYMO TEKSTU.`;
  return klauskCallAI(prompt);
}

async function klauskCallAI(prompt) {
  let data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1800, temperature: 0.2, messages: [{ role: 'user', content: prompt }] })
      }, 90000);
      data = await r.json();
    } catch (e) { data = null; console.log(`[klausk] AI tinklo klaida, bandymas ${attempt}/3: ${e.message}`); }
    if (data && !data.error && data.content && data.content.length) break;
    if (data && data.error && ['invalid_request_error', 'authentication_error', 'permission_error'].includes(data.error.type)) break;
    if (attempt < 3) await new Promise(res => setTimeout(res, 2500 * attempt));
  }
  if (!data || data.error || !data.content) throw new Error(data && data.error ? `${data.error.type}: ${data.error.message || ''}` : 'Tuščias AI atsakymas');
  const text = data.content.map(b => b.text || '').join('').trim();
  if (!text) throw new Error('Tuščias atsakymas');
  return applyTextFixes(text.slice(0, 4000)).text;
}

async function answerKlauskPora(order, question) {
  const A = order.nameA || 'Pirmasis partneris', B = order.nameB || 'Antrasis partneris';
  const prev = (order.qa || []).map((x, i) => `${i + 1}. Klausimas: ${x.q}\nAtsakymas: ${x.a}`).join('\n\n');
  const prompt = `Tu esi patyręs chiromantas ir šiltas, išmintingas porų patarėjas. Žemiau — ${A} ir ${B} porų suderinamumo analizė, sugeneruota iš abiejų delnų nuotraukų (A — ${A}, B — ${B}). Pora užduoda klausimą apie savo santykius. Atsakyk remdamasis BŪTENT šia analize.

PORŲ ANALIZĖ:
${klauskPoraContext(order.result)}
${prev ? `ANKSČIAU UŽDUOTI KLAUSIMAI IR ATSAKYMAI (nesikartok):\n${prev}\n` : ''}
KLAUSIMAS: ${question}

KAIP ATSAKYTI:
- 7–10 sakinių, sklandus tekstas, kreipkis į abu kartu „jūs“ forma, esamuoju laiku, šiltai ir konkrečiai. Pradėk iškart nuo esmės.
${poraNameRules(A, B)}
- Susiek atsakymą su 2–3 konkrečiais dalykais iš analizės (kuo vienas kitą papildote, kur kyla trintis, ką rodo jūsų delnų palyginimas) — kad pora jaustų, jog atsakymas skirtas būtent jai.
- Pabaigoje — 2–3 aiškūs, praktiški žingsniai jums abiem (sklandžiu tekstu, ne sąrašu).
- Apie delnus rašyk daugiskaita.
- Tai savęs pažinimo patirtis, ne profesionali konsultacija. Nepranašauk išsiskyrimo, neištikimybės, ligų, nelaimių ar konkrečių datų; nespręsk už porą, ar jiems būti kartu. Neduok medicininių, teisinių ar investavimo patarimų — tokiu atveju švelniai pasakyk, kad verta pasitarti su specialistu.
- Jei klausimas rodo smurtą, grėsmę ar minčių apie savęs žalojimą — atsakyk švelniai, palaikančiai ir paragink nedelsiant kreiptis pagalbos: skubiai — 112, Vilties linija 116 123 (visą parą), pagalba nukentėjusiems nuo smurto — 8 800 66366 (Moterų linija) arba 8 800 55522 (Vyrų linija).
- Jei klausimas nesusijęs su jų santykiais ar gyvenimu — maloniai paaiškink, kad atsakai tik į klausimus apie jūsų porą, ir pasiūlyk, ko galėtų paklausti.
${klauskLangRules('jūs')}

ATSAKYK TIK ATSAKYMO TEKSTU.`;
  return klauskCallAI(prompt);
}

app.get('/klausk', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'klausk.html'));
});

app.post('/klausk/create-checkout', sensitiveLimiter, async (req, res) => {
  try {
    const { kind, poraSid } = req.body || {};
    let { email, name, result } = req.body || {};
    let record;
    if (kind === 'pora') {
      // Porų klausimai: analizė, vardai ir el. paštas imami iš apmokėto porų užsakymo
      if (!isValidCheckoutSessionId(poraSid)) return res.status(400).json({ error: 'Neteisingas porų užsakymas' });
      const po = loadPoraOrders()[poraSid];
      if (!po || po.status !== 'done' || !po.result) return res.status(400).json({ error: 'Porų analizė nerasta' });
      email = po.email; name = `${po.nameA} ir ${po.nameB}`;
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Nerastas užsakymo el. paštas' });
      record = { kind: 'pora', email, name, nameA: po.nameA, nameB: po.nameB, poraSid, result: po.result };
    } else {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
      if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardas' });
      const picked = pickKlauskResult(result);
      if (!picked) return res.status(400).json({ error: 'Nerasta asmeninė analizė. Atnaujinkite rezultato puslapį.' });
      record = { email, name: (name || '').trim(), result: picked };
    }
    const base = appBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'revolut_pay'],
      line_items: [{ price_data: { currency: 'eur', unit_amount: KLAUSK_PRICE_CENTS, product_data: { name: record.kind === 'pora' ? 'DELNAS — Klauskite savo delnų: porai (3 klausimai)' : 'DELNAS — Klausk savo delnų (3 klausimai)' } }, quantity: 1 }],
      locale: 'lt',
      customer_email: email,
      metadata: { type: 'klausk', kind: record.kind || 'asmenine', email, name: (name || '').trim().slice(0, 120) },
      success_url: `${base}/klausk?s={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/klausk?atsaukta=1`
    });
    const orders = loadKlauskOrders();
    orders[session.id] = { ...record, qa: [], paid: false, createdAt: Date.now() };
    saveKlauskOrders(orders);
    res.json({ url: session.url });
  } catch (err) {
    console.error('/klausk/create-checkout klaida:', err);
    res.status(500).json({ error: 'Nepavyko pradėti mokėjimo. Pabandykite dar kartą.' });
  }
});

app.get('/klausk/check', sensitiveLimiter, async (req, res) => {
  try {
    const id = req.query.s;
    if (!isValidKlauskId(id)) return res.status(400).json({ paid: false });
    const orders = loadKlauskOrders(), o = orders[id];
    if (!o) return res.json({ paid: false, notfound: true });
    if (!o.paid) {
      const s = await getPaidKlausk(id);
      if (!s) return res.json({ paid: false });
      o.paid = true; o.paidAt = Date.now(); o.amount = s.amount_total; saveKlauskOrders(orders); statInc('klausk_paid');
      mailer.sendMail({
        from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
        to: ADMIN_EMAIL,
        subject: `Naujas „Klausk savo delnų“${o.kind === 'pora' ? ' (porai)' : ''} užsakymas — ${o.name || o.email}`,
        html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Klausk savo delnų</h2><p><strong>Klientas:</strong> ${escapeHtml(o.name || '—')} (${escapeHtml(o.email)})</p><p><strong>Suma:</strong> ${((s.amount_total || KLAUSK_PRICE_CENTS) / 100).toFixed(2).replace('.', ',')} €</p><p><strong>Stripe session:</strong> ${escapeHtml(id)}</p></div>`
      }).catch(e => console.error('[klausk] admin laiško klaida:', e.message));
    }
    res.json({ paid: true, kind: o.kind || 'asmenine', name: o.name, qa: o.qa || [], left: KLAUSK_MAX_QUESTIONS - (o.qa || []).length });
  } catch (err) {
    console.error('/klausk/check klaida:', err);
    res.status(500).json({ paid: false, error: 'Nepavyko patikrinti užsakymo' });
  }
});

// ═══ „Klausk“ atsakymai el. paštu — visi viename laiške ═══
const KLAUSK_DIGEST_QUIET_MS = Number(process.env.KLAUSK_DIGEST_QUIET_MS) || 30 * 60 * 1000;
const klauskDigestSending = new Set();
async function sendKlauskDigest(id) {
  if (klauskDigestSending.has(id)) return;
  klauskDigestSending.add(id);
  try {
    const orders = loadKlauskOrders(), cur = orders[id];
    if (!cur || !cur.email || !cur.digestPending || !(cur.qa || []).length) return;
    const pora = cur.kind === 'pora', n = cur.qa.length, left = KLAUSK_MAX_QUESTIONS - n;
    const para = t => escapeHtml(t).split(/\n+/).filter(Boolean).map(x => `<p style="margin:0 0 10px">${x}</p>`).join('');
    const items = cur.qa.map((x, i) => `<div style="border:1px solid rgba(212,168,67,.45);border-radius:14px;padding:18px 16px;margin:0 0 16px;background:#000"><div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:.12em;color:#d4a843;margin-bottom:8px">✦ ${['PIRMAS', 'ANTRAS', 'TREČIAS', 'KETVIRTAS', 'PENKTAS'][i] || i + 1 + '-AS'} KLAUSIMAS</div><div style="font-size:17px;font-style:italic;color:#f0d58a;margin-bottom:14px">„${escapeHtml(x.q)}“</div><div style="font-size:15px;line-height:1.7;color:rgba(245,238,216,.88)">${para(x.a)}</div></div>`).join('');
    const btn = left > 0 ? `Užduoti kitą klausimą (liko ${left}) →` : 'Peržiūrėti atsakymus svetainėje →';
    // Pažymima prieš siunčiant — kad vienas atsakymas nebūtų išsiųstas du kartus
    cur.digestPending = false; cur.digestSentAt = Date.now(); cur.digestCount = n;
    saveKlauskOrders(orders);
    await mailer.sendMail({
      from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
      to: cur.email,
      subject: `✋ ${pora ? 'Jūsų' : 'Tavo'} delnų ${n === 1 ? 'atsakymas' : 'atsakymai'}${n > 1 ? ` (${n})` : ''}${cur.name ? ' — ' + cur.name : ''}`,
      html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:520px;margin:0 auto"><div style="text-align:center;font-size:13px;letter-spacing:.3em;color:#d4a843;margin-bottom:8px">${pora ? 'KLAUSKITE SAVO DELNŲ' : 'KLAUSK SAVO DELNŲ'}</div><div style="text-align:center;font-size:14px;color:rgba(245,238,216,.7);margin-bottom:22px">${n === 1 ? (pora ? 'Jūsų klausimas ir atsakymas' : 'Tavo klausimas ir atsakymas') : (pora ? `Visi jūsų klausimai ir atsakymai (${n})` : `Visi tavo klausimai ir atsakymai (${n})`)}</div>${items}<div style="text-align:center;margin-top:22px"><a href="${appBaseUrl()}/klausk?s=${encodeURIComponent(id)}" style="display:inline-block;border:1px solid #d4a843;border-radius:999px;padding:10px 20px;color:#d4a843;font-size:14px;font-weight:700;text-decoration:none">${btn}</a></div><p style="font-size:11px;color:rgba(245,238,216,.45);text-align:center;margin-top:18px">Savęs pažinimo priemonė, ne profesionali konsultacija.</p>${EMAIL_FOOTER_HTML}</div>`
    });
    console.log(`[klausk] suvestinė (${n} atsak.) išsiųsta į ${cur.email}`);
  } catch (e) {
    // Nepavyko išsiųsti — bandysime kitą kartą
    try { const o = loadKlauskOrders(); if (o[id]) { o[id].digestPending = true; saveKlauskOrders(o); } } catch (_) {}
    throw e;
  } finally { klauskDigestSending.delete(id); }
}
function processKlauskDigests() {
  try {
    const now = Date.now();
    for (const [id, o] of Object.entries(loadKlauskOrders())) {
      if (!o.digestPending || !(o.qa || []).length) continue;
      const lastAt = o.qa[o.qa.length - 1].at || 0;
      if (now - lastAt >= KLAUSK_DIGEST_QUIET_MS) sendKlauskDigest(id).catch(e => console.error('[klausk] suvestinės laiško klaida:', e.message));
    }
  } catch (e) { console.error('[klausk] processKlauskDigests klaida:', e.message); }
}
setInterval(processKlauskDigests, Math.min(5 * 60 * 1000, KLAUSK_DIGEST_QUIET_MS));

const klauskInFlight = new Set();
app.post('/klausk/ask', sensitiveLimiter, async (req, res) => {
  const { s: id, question } = req.body || {};
  if (!isValidKlauskId(id)) return res.status(400).json({ error: 'Neteisingas užsakymas' });
  const q = typeof question === 'string' ? question.trim() : '';
  if (q.length < 5) return res.status(400).json({ error: 'Parašykite klausimą (bent kelis žodžius).' });
  if (q.length > 400) return res.status(400).json({ error: 'Klausimas per ilgas (iki 400 simbolių).' });
  if (klauskInFlight.has(id)) return res.status(429).json({ error: 'Palaukite — ruošiamas ankstesnis atsakymas.' });
  klauskInFlight.add(id);
  try {
    const o = loadKlauskOrders()[id];
    if (!o || !o.paid) return res.status(403).json({ error: 'Užsakymas neapmokėtas' });
    if ((o.qa || []).length >= KLAUSK_MAX_QUESTIONS) return res.status(409).json({ error: 'Visi 3 klausimai jau užduoti.' });
    const a = await answerKlausk(o, q);
    const orders = loadKlauskOrders(), cur = orders[id];
    cur.qa = [...(cur.qa || []), { q, a, at: Date.now() }];
    // Visi atsakymai el. paštu VIENU laišku: iš karto, kai užduoti visi 3, arba
    // po KLAUSK_DIGEST_QUIET_MS tylos (jei daugiau klausimų neužduodama) — žr. processKlauskDigests
    cur.digestPending = true;
    saveKlauskOrders(orders);
    if (cur.qa.length >= KLAUSK_MAX_QUESTIONS) sendKlauskDigest(id).catch(e => console.error('[klausk] suvestinės laiško klaida:', e.message));
    res.json({ ok: true, q, a, left: KLAUSK_MAX_QUESTIONS - cur.qa.length });
  } catch (err) {
    console.error('/klausk/ask klaida:', err);
    res.status(500).json({ error: 'Nepavyko gauti atsakymo. Pabandykite dar kartą — klausimas nebuvo įskaičiuotas.' });
  } finally { klauskInFlight.delete(id); }
});

app.get('/dovana', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'dovana.html'));
});
// Dovanos kodo įvedimas ranka (jei gavėjas neskenuoja QR) — tas pats
// dovana.html, rodinys parenkamas pagal kelią.
app.get('/kodas', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'dovana.html'));
});
app.get('/dovana/kortele', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'dovana.html'));
});

app.post('/gift/create-checkout', sensitiveLimiter, async (req, res) => {
  try {
    const { buyerEmail, fromName, recipientName, message } = req.body || {};
    const kind = (req.body && req.body.kind) === 'pora' ? 'pora' : 'asmenine';
    // Neprivaloma: dovana gavėjui el. paštu nurodytą dieną ir valandą (Vilniaus laiku)
    const sendTo = (req.body && typeof req.body.recipientEmail === 'string') ? req.body.recipientEmail.trim() : '';
    const sendAt = (req.body && typeof req.body.sendAt === 'string') ? req.body.sendAt.trim() : '';
    if (sendTo && !isValidEmail(sendTo)) return res.status(400).json({ error: 'Neteisingas gavėjo el. paštas' });
    if (sendAt && (!/^\d{4}-\d{2}-\d{2}$/.test(sendAt) || sendAt < ltDate(Date.now()) || sendAt > ltDate(Date.now() + 366 * 864e5))) return res.status(400).json({ error: 'Neteisinga siuntimo data' });
    // Siuntimo valanda Lietuvos laiku (0–23), numatyta 8
    const sendHourRaw = req.body && req.body.sendHour;
    const sendHour = Number.isInteger(Number(sendHourRaw)) && Number(sendHourRaw) >= 0 && Number(sendHourRaw) <= 23 ? Number(sendHourRaw) : 8;
    const season = ['valentinas', 'mama', 'kaledos'].includes(req.body && req.body.season) ? req.body.season : '';
    // Pirkėjo el. paštas privalomas, nebent dovana siunčiama gavėjui (tada Stripe pats paprašys pirkėjo el. pašto kvitui)
    if (buyerEmail ? !isValidEmail(buyerEmail) : !sendTo) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (!isValidGiftText(fromName, 60) || !isValidGiftText(recipientName, 60)) return res.status(400).json({ error: 'Vardas per ilgas' });
    if (!isValidGiftText(message, 300)) return res.status(400).json({ error: 'Palinkėjimas per ilgas (iki 300 simbolių)' });
    // Porų kuponas — porų analizės kaina; asmeninis — aktyvi asmeninės analizės kaina
    const activePrice = kind === 'pora' ? { currency: 'eur', unit_amount: PORA_PRICE_CENTS } : await stripe.prices.retrieve(ACTIVE_PRICE_ID);
    // −30 % pasiūlymas po analizės (24 val.)
    const pr = getValidPromo(req.body && req.body.promo, 'dovana');
    const giftAmount = pr ? promoAmount(pr, activePrice.unit_amount) : activePrice.unit_amount;
    const giftKlauskCents = kind === 'pora' ? GIFT_KLAUSK_PORA_CENTS : GIFT_KLAUSK_CENTS;
    const base = appBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'revolut_pay'],
      line_items: [{
        price_data: {
          currency: activePrice.currency,
          unit_amount: giftAmount,
          product_data: { name: (kind === 'pora' ? 'DELNAS dovanų kuponas — Porų suderinamumas' : 'DELNAS dovanų kuponas — Gyvenimo žemėlapis') + (pr ? ` (−${pr.pct} %)` : '') }
        },
        quantity: 1
      }, ...(giftKlauskCents > 0 ? [{
        price_data: { currency: activePrice.currency, unit_amount: giftKlauskCents, product_data: { name: kind === 'pora' ? 'Klauskite savo delnų — 3 klausimai porai (dovanoje)' : 'Klausk savo delnų — 3 klausimai (dovanoje)' } },
        quantity: 1
      }] : [])],
      locale: 'lt',
      ...(buyerEmail ? { customer_email: buyerEmail } : {}),
      metadata: {
        type: 'gift',
        kind,
        klausk: '1',
        recipientEmail: sendTo,
        sendAt: sendTo ? (sendAt || ltDate(Date.now())) : '',
        sendHour: sendTo ? String(sendHour) : '',
        season,
        buyerEmail: buyerEmail || '',
        fromName: (fromName || '').trim(),
        recipientName: (recipientName || '').trim(),
        message: (message || '').trim(),
        promo: pr ? pr.code : ''
      },
      success_url: `${base}/dovana?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/dovana${kind === 'pora' ? '?tipas=pora' : ''}`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('/gift/create-checkout klaida:', err);
    res.status(500).json({ error: 'Nepavyko pradėti mokėjimo. Pabandykite dar kartą.' });
  }
});

app.get('/gift/confirm', sensitiveLimiter, async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_') || sessionId.length > 200) {
      return res.status(400).json({ paid: false, error: 'Neteisingas session_id' });
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session.metadata || session.metadata.type !== 'gift') return res.status(400).json({ paid: false, error: 'Tai ne dovanų kupono užsakymas' });
    if (session.payment_status !== 'paid') return res.json({ paid: false });

    const { gift, isNew } = issueGiftForSession(session);
    if (isNew) {
      statInc('gift_paid');
      if (session.metadata.promo) markPromoUsed(session.metadata.promo, session.id);
      if (gift.recipientEmail) setTimeout(processGiftSchedules, 3000);
      // Pirkėjui — dovanų kortelė el. paštu
      if (gift.buyerEmail) {
        mailer.sendMail({
          from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
          to: gift.buyerEmail,
          subject: gift.recipientEmail ? '🎁 Jūsų DELNAS dovana užsakyta' : '🎁 Jūsų DELNAS dovanų kuponas',
          html: buildGiftEmailHtml(gift)
        }).then(() => console.log(`[gift] kortelė išsiųsta ${gift.buyerEmail}`))
          .catch(e => console.error('[gift] nepavyko išsiųsti kortelės pirkėjui:', e.message));
      }
      // Administratoriui — pranešimas apie pardavimą
      mailer.sendMail({
        from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
        to: ADMIN_EMAIL,
        subject: `Parduotas ${gift.kind === 'pora' ? 'porų ' : ''}dovanų kuponas ${gift.code}`,
        html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Parduotas dovanų kuponas</h2>
          <p><strong>Kodas:</strong> ${escapeHtml(gift.code)}</p>
          <p><strong>Tipas:</strong> ${gift.kind === 'pora' ? 'Porų suderinamumas' : 'Asmeninė analizė'}</p>
          <p><strong>Pirkėjas:</strong> ${escapeHtml(gift.buyerEmail)} (${escapeHtml(gift.fromName || '—')})</p>
          <p><strong>Gavėjas:</strong> ${escapeHtml(gift.recipientName || '—')}</p>
          <p><strong>Suma:</strong> ${((gift.amount || 0) / 100).toFixed(2).replace('.', ',')} €</p>
          <p><strong>Galioja iki:</strong> ${fmtLtDate(gift.expiresAt)}</p>
          <p><strong>Stripe session:</strong> ${escapeHtml(gift.sessionId)}</p></div>`
      }).catch(e => console.error('[gift] admin laiško klaida:', e.message));
    }
    res.json({ paid: true, ...giftPublicInfo(gift), link: giftRedeemLink(gift) });
  } catch (err) {
    console.error('/gift/confirm klaida:', err);
    res.status(500).json({ paid: false, error: 'Nepavyko patvirtinti mokėjimo' });
  }
});

// Viešai grąžinama TIK tai, kas matoma dovanų kortelėje (be pirkėjo el. pašto).
app.get('/gift/check', sensitiveLimiter, (req, res) => {
  const code = normalizeGiftCode(req.query.code);
  if (!code) return res.json({ valid: false, status: 'not_found' });
  const gift = loadGiftStore().codes[code];
  if (!gift) return res.json({ valid: false, status: 'not_found' });
  const info = giftPublicInfo(gift);
  res.json({ valid: info.status === 'active', ...info });
});

// Grąžinamas kuponas (refund Stripe'e) nebeturi galioti. Jei Stripe
// laikinai nepasiekiamas — leidžiame (kuponas buvo apmokėtas), bet užrašome.
async function isGiftRefunded(gift) {
  try {
    // Rinkinio kuponas: tikrinamas asmeninės analizės mokėjimas (PaymentIntent arba Checkout)
    if (String(gift.sessionId).startsWith('bundle:')) {
      const ref = gift.sessionId.slice(7);
      const pi = ref.startsWith('cs_') ? (await stripe.checkout.sessions.retrieve(ref, { expand: ['payment_intent.latest_charge'] })).payment_intent : await stripe.paymentIntents.retrieve(ref, { expand: ['latest_charge'] });
      const ch = pi && pi.latest_charge;
      return !!(ch && (ch.refunded || ch.amount_refunded > 0));
    }
    const session = await stripe.checkout.sessions.retrieve(gift.sessionId, { expand: ['payment_intent.latest_charge'] });
    const charge = session.payment_intent && session.payment_intent.latest_charge;
    return !!(charge && (charge.refunded || charge.amount_refunded > 0));
  } catch (e) {
    console.error('[gift] nepavyko patikrinti grąžinimo Stripe:', e.message);
    return false;
  }
}

app.post('/redeem-gift', sensitiveLimiter, async (req, res) => {
  try {
    const { code: rawCode, name, email, orderNumber, bgSessionId } = req.body || {};
    const code = normalizeGiftCode(rawCode);
    if (!code) return res.status(400).json({ paid: false, error: 'Neteisingas dovanos kodas' });
    if (name && !isValidName(name)) return res.status(400).json({ paid: false, error: 'Neteisingas vardo formatas' });
    if (email && !isValidEmail(email)) return res.status(400).json({ paid: false, error: 'Neteisingas el. pašto formatas' });
    if (orderNumber && !isValidOrderNumber(orderNumber)) return res.status(400).json({ paid: false, error: 'Neteisingas orderNumber formatas' });
    if (bgSessionId && (typeof bgSessionId !== 'string' || bgSessionId.length > 200)) return res.status(400).json({ paid: false, error: 'Neteisingas bgSessionId' });

    const store = loadGiftStore();
    const gift = store.codes[code];
    const status = giftStatus(gift);
    if (status === 'not_found') return res.status(404).json({ paid: false, status, error: 'Dovanos kodas nerastas' });
    if (gift.kind === 'pora') return res.status(409).json({ paid: false, status, kind: 'pora', error: 'Tai porų suderinamumo kuponas — jį panaudokite adresu www.delnaskaitymas.lt/pora' });
    if (status === 'expired') return res.status(410).json({ paid: false, status, error: 'Dovanos kodo galiojimas baigėsi' });
    if (status === 'void') return res.status(410).json({ paid: false, status, error: 'Dovanos kodas nebegalioja' });
    if (status === 'redeemed') {
      // Pakartotinis bandymas iš TOS PAČIOS sesijos (pvz. tinklo klaida po
      // pirmo kvietimo) — grąžiname tą patį tokeną; kitu atveju — atmetame.
      if (bgSessionId && gift.redeemedBgSessionId && bgSessionId === gift.redeemedBgSessionId) {
        const token = getOrCreateTokenForPayment('gift:' + code, name || gift.redeemedName || '', email || gift.redeemedEmail || '');
        return res.json({ paid: true, token, name: name || gift.redeemedName || '', email: email || gift.redeemedEmail || '', gift: true });
      }
      return res.status(409).json({ paid: false, status, error: 'Šis dovanos kodas jau panaudotas' });
    }
    if (await isGiftRefunded(gift)) {
      gift.status = 'void'; gift.voidReason = 'refunded'; gift.voidAt = Date.now(); saveGiftStore(store);
      return res.status(410).json({ paid: false, status: 'void', error: 'Dovanos kodas nebegalioja' });
    }
    // isGiftRefunded() yra async — per tą laiką kita užklausa galėjo jau
    // panaudoti kodą. Perskaitome saugyklą iš naujo ir tikriname dar kartą
    // (nuo čia iki saveGiftStore() kodas sinchroninis — lenktynių nebėra).
    const fresh = loadGiftStore();
    const freshGift = fresh.codes[code];
    if (giftStatus(freshGift) !== 'active') return res.status(409).json({ paid: false, status: giftStatus(freshGift), error: 'Šis dovanos kodas jau panaudotas' });
    // Pažymime panaudotu PRIEŠ išduodant tokeną (vienkartiškumas).
    freshGift.status = 'redeemed';
    freshGift.redeemedAt = Date.now();
    freshGift.redeemedBgSessionId = bgSessionId || '';
    freshGift.redeemedName = name || '';
    freshGift.redeemedEmail = email || '';
    freshGift.redeemedOrderNumber = orderNumber || '';
    saveGiftStore(fresh);
    markEmailPaid(email);
    const token = getOrCreateTokenForPayment('gift:' + code, name || '', email || '');
    console.log(`[gift] panaudotas kodas ${code} (order=${orderNumber || '-'})`);
    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `Panaudotas dovanų kuponas ${code}${orderNumber ? ' — užsakymas #' + orderNumber : ''}`,
      html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Panaudotas dovanų kuponas</h2>
        <p><strong>Kodas:</strong> ${escapeHtml(code)}</p>
        <p><strong>Užsakymo numeris:</strong> ${escapeHtml(orderNumber || '(nėra)')}</p>
        <p><strong>Gavėjas:</strong> ${escapeHtml(name || '—')} (${escapeHtml(email || '—')})</p>
        <p><strong>Pirko:</strong> ${escapeHtml(gift.buyerEmail || '—')}</p></div>`
    }).catch(e => console.error('[gift] admin laiško klaida:', e.message));
    res.json({ paid: true, token, name: name || '', email: email || '', gift: true });
  } catch (err) {
    console.error('/redeem-gift klaida:', err);
    res.status(500).json({ paid: false, error: 'Nepavyko panaudoti dovanos kodo' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ĮVERTINIMAI IR ATSILIEPIMAI + STATISTIKA (be slapukų ir asmens duomenų)
// ═══════════════════════════════════════════════════════════════════
const FEEDBACK_FILE = path.join(SHARED_STORAGE_DIR, 'feedback.json');
const STATS_FILE = path.join(SHARED_STORAGE_DIR, 'stats.json');
// Administratoriaus raktas (statistikai ir atsiliepimų patvirtinimui). Jei ADMIN_KEY
// nenustatytas — išvedamas iš Stripe slapto rakto (stabilus, bet ne viešas).
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.createHash('sha256').update('delnas-admin:' + (process.env.STRIPE_SECRET_KEY || 'dev')).digest('hex').slice(0, 24);
function readJson(file, def) { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {} return def; }
function writeJson(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); }
function feedbackToken(id) { return crypto.createHmac('sha256', ADMIN_KEY).update('fb:' + id).digest('hex').slice(0, 20); }

app.post('/feedback', sensitiveLimiter, (req, res) => {
  try {
    const { stars, text, allowPublic, name, kind } = req.body || {};
    const st = Math.round(Number(stars));
    if (!(st >= 1 && st <= 5)) return res.status(400).json({ error: 'Pasirinkite įvertinimą' });
    const t = typeof text === 'string' ? text.trim().slice(0, 500) : '';
    const first = typeof name === 'string' ? name.trim().split(/\s+/)[0].slice(0, 30) : '';
    const fb = readJson(FEEDBACK_FILE, { items: [] });
    const id = crypto.randomBytes(8).toString('hex');
    const item = { id, stars: st, text: t, name: first, allowPublic: !!allowPublic && !!t && st >= 4, approved: false, kind: kind === 'pora' ? 'pora' : 'asmenine', createdAt: Date.now() };
    fb.items.push(item); writeJson(FEEDBACK_FILE, fb); statInc('feedback');
    const approve = item.allowPublic && st >= 4 ? `<p><a href="${appBaseUrl()}/feedback/approve?id=${id}&t=${feedbackToken(id)}" style="display:inline-block;background:#d4a843;color:#140f02;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:bold">✓ Rodyti šį atsiliepimą svetainėje</a></p>` : '';
    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `${'★'.repeat(st)}${'☆'.repeat(5 - st)} Naujas įvertinimas${first ? ' — ' + first : ''}`,
      html: `<div style="font-family:Georgia,serif;padding:20px"><h2>${'★'.repeat(st)}${'☆'.repeat(5 - st)}</h2><p><strong>Vardas:</strong> ${escapeHtml(first || '—')} · ${item.kind === 'pora' ? 'porų analizė' : 'asmeninė analizė'}</p><p><strong>Atsiliepimas:</strong> ${escapeHtml(t || '—')}</p><p><strong>Leidžia rodyti viešai:</strong> ${item.allowPublic ? 'taip' : 'ne'}</p>${approve}<p style="margin-top:18px;font-size:13px"><a href="${appBaseUrl()}/admin/stats?key=${ADMIN_KEY}" style="color:#8a5a0f">📊 Statistika ir visi įvertinimai</a></p></div>`
    }).catch(e => console.error('[feedback] laiško klaida:', e.message));
    res.json({ ok: true });
  } catch (err) { console.error('/feedback klaida:', err); res.status(500).json({ error: 'Nepavyko išsaugoti' }); }
});

// Patvirtinimas iš administratoriaus laiško (rodomi tik patvirtinti atsiliepimai)
app.get('/feedback/approve', (req, res) => {
  const { id, t } = req.query;
  if (typeof id !== 'string' || typeof t !== 'string' || t !== feedbackToken(id)) return res.status(403).send('Neteisinga nuoroda');
  const fb = readJson(FEEDBACK_FILE, { items: [] });
  const it = fb.items.find(x => x.id === id);
  if (!it || !it.allowPublic) return res.status(404).send('Atsiliepimas nerastas');
  it.approved = true; writeJson(FEEDBACK_FILE, fb);
  res.send('<div style="font-family:sans-serif;padding:40px;text-align:center"><h2>✓ Atsiliepimas bus rodomas svetainėje</h2><p>„' + escapeHtml(it.text) + '“ — ' + escapeHtml(it.name || '') + '</p></div>');
});

app.get('/testimonials', (req, res) => {
  const fb = readJson(FEEDBACK_FILE, { items: [] });
  const items = fb.items.filter(x => x.approved && x.allowPublic && x.stars >= 4 && x.text).slice(-8).reverse()
    .map(x => ({ stars: x.stars, text: x.text, name: x.name }));
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ items });
});

// Statistika: tik įvykių skaičiai per dieną (be IP, slapukų ar asmens duomenų)
const STAT_EVENTS = ['home', 'start', 'photos', 'pay_view', 'paid', 'bump', 'ref_paid', 'result', 'klausk_paid', 'pora_view', 'pora_paid', 'dovana_view', 'gift_paid', 'feedback', 'abandon_sent', 'promo_back', 'bundle', 'promo_bundle', 'promo_once', 'saved', 'promo_repeat', 'mano'];
let _statsBuf = null, _statsTimer = null;
function statInc(ev) {
  if (!STAT_EVENTS.includes(ev)) return;
  if (!_statsBuf) _statsBuf = readJson(STATS_FILE, { days: {} });
  const d = new Date().toISOString().slice(0, 10);
  const day = (_statsBuf.days[d] = _statsBuf.days[d] || {});
  day[ev] = (day[ev] || 0) + 1;
  clearTimeout(_statsTimer);
  _statsTimer = setTimeout(() => { try { writeJson(STATS_FILE, _statsBuf); } catch (e) {} }, 2000);
}
// Reklamos šaltiniai (UTM): apsilankymai ir pirkimai pagal „šaltinis / kampanija“ (iki 40 skirtingų per dieną)
function statSrc(src, field) {
  const s = String(src).toLowerCase().replace(/[^a-z0-9ąčęėįšųūž_\- /]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  if (!s) return;
  if (!_statsBuf) _statsBuf = readJson(STATS_FILE, { days: {} });
  const d = new Date().toISOString().slice(0, 10);
  const day = (_statsBuf.days[d] = _statsBuf.days[d] || {});
  const src2 = (day.src = day.src || {});
  if (!src2[s] && Object.keys(src2).length >= 40) return;
  const row = (src2[s] = src2[s] || {});
  row[field] = (row[field] || 0) + 1;
  clearTimeout(_statsTimer);
  _statsTimer = setTimeout(() => { try { writeJson(STATS_FILE, _statsBuf); } catch (e) {} }, 2000);
}
app.post('/ev', express.text({ type: '*/*', limit: '1kb' }), (req, res) => {
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (['home', 'start', 'photos', 'pay_view', 'result', 'pora_view', 'dovana_view'].includes(b.e)) statInc(b.e);
    else if ((b.e === 'src_visit' || b.e === 'src_buy') && typeof b.s === 'string') statSrc(b.s, b.e === 'src_visit' ? 'v' : (['asmenine', 'pora', 'dovana'].includes(b.k) ? b.k : 'kita'));
  } catch (e) {}
  res.status(204).end();
});
app.get('/admin/stats', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('Neteisingas raktas');
  const st = _statsBuf || readJson(STATS_FILE, { days: {} });
  const days = Object.keys(st.days).sort().reverse().slice(0, 60);
  const fb = readJson(FEEDBACK_FILE, { items: [] }).items;
  const avg = fb.length ? (fb.reduce((a, x) => a + x.stars, 0) / fb.length).toFixed(2) : '—';
  // Trys siauresnės lentelės — kad viskas matytųsi be slinkimo į šoną
  const groups = [
    ['Pagrindinis kelias', [['home', 'Atidarė'], ['start', 'Pradėjo'], ['photos', 'Nufotografavo'], ['pay_view', 'Mokėjimo ekranas'], ['paid', 'Apmokėjo']], true],
    ['Papildomi pardavimai', [['bump', '+3 klausimai'], ['klausk_paid', 'Klausk'], ['ref_paid', 'Per draugą'], ['pora_view', '/pora'], ['pora_paid', 'Poros'], ['dovana_view', '/dovana'], ['gift_paid', 'Dovanos'], ['feedback', 'Įvertinimai']]],
    ['Priminimai ir pasiūlymai', [['abandon_sent', 'Priminimai (nebaigė)'], ['promo_back', 'Grįžo ir sumokėjo'], ['promo_bundle', 'Poros po analizės'], ['promo_once', 'Dovana −30 %'], ['saved', 'Išsaugojo'], ['promo_repeat', 'Pakartojo'], ['mano', 'Mano analizės'], ['bundle', 'Rinkinys']]]
  ];
  const allCols = groups.flatMap(g => g[1]);
  const sum = {}; days.forEach(d => allCols.forEach(([k]) => { sum[k] = (sum[k] || 0) + (st.days[d][k] || 0); }));
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  const table = ([title, cols, conv]) => {
    const row = (label, v, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td>${cols.map(([k]) => `<td>${v[k] || 0}</td>`).join('')}${conv ? `<td>${pct(v.paid || 0, v.pay_view || 0)}</td>` : ''}</tr>`;
    return `<h2>${title}</h2><div class="tw"><table><tr><th>Diena</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}${conv ? '<th>Mokėjimas %</th>' : ''}</tr>
${row('Iš viso (60 d.)', sum, 'sum')}
${days.map(d => row(d, st.days[d])).join('')}</table></div>`;
  };
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="lt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DELNAS statistika</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0b;color:#eee;padding:16px;max-width:1100px}h1{color:#d4a843;font-size:20px}h2{color:#d4a843;font-size:15px;margin:22px 0 8px}.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #333;padding:6px 8px;text-align:right;white-space:nowrap}th{background:#1a1a1a;color:#d4a843;white-space:normal;max-width:110px;vertical-align:bottom}td:first-child,th:first-child{text-align:left;position:sticky;left:0;background:#0b0b0b}th:first-child{background:#1a1a1a}tr.sum td{background:#1d1708;font-weight:700}.k{color:#aaa;font-size:13px}</style></head><body>
<h1>DELNAS — statistika</h1><div class="k">Įvertinimų vidurkis: <b>${avg}</b> (${fb.length}) · „Mokėjimas %“ = apmokėjo / pasiekė mokėjimo ekraną</div>
${groups.map(table).join('')}
${(() => {
  const agg = {};
  days.forEach(d => Object.entries(st.days[d].src || {}).forEach(([k, v]) => { const a = (agg[k] = agg[k] || {}); for (const [f, n] of Object.entries(v)) a[f] = (a[f] || 0) + n; }));
  const rows = Object.entries(agg).sort((a, b) => (b[1].v || 0) - (a[1].v || 0));
  const buys = v => (v.asmenine || 0) + (v.pora || 0) + (v.dovana || 0);
  return `<h2>Iš kur atėjo (reklamos nuorodos su UTM, 60 d.)</h2>` + (rows.length ? `<div class="tw"><table><tr><th>Šaltinis / kampanija</th><th>Apsilankė</th><th>Asmeninė</th><th>Poros</th><th>Dovanos</th><th>Pirkimai %</th></tr>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v.v || 0}</td><td>${v.asmenine || 0}</td><td>${v.pora || 0}</td><td>${v.dovana || 0}</td><td>${pct(buys(v), v.v || 0)}</td></tr>`).join('')}</table></div>` : '<div class="k">Kol kas nėra lankytojų, atėjusių per nuorodas su UTM žymomis (pvz. ?utm_source=facebook&amp;utm_campaign=kaledos).</div>');
})()}
<h2>Paskutiniai įvertinimai</h2><div class="tw"><table><tr><th>Data</th><th>★</th><th>Vardas</th><th style="text-align:left">Atsiliepimas</th><th>Viešai</th></tr>
${fb.slice(-30).reverse().map(x => `<tr><td>${new Date(x.createdAt).toISOString().slice(0, 10)}</td><td>${x.stars}</td><td>${escapeHtml(x.name || '')}</td><td style="text-align:left;white-space:normal">${escapeHtml(x.text || '')}</td><td>${x.approved ? '✓ rodomas' : x.allowPublic ? `<a style="color:#d4a843" href="/feedback/approve?id=${x.id}&t=${feedbackToken(x.id)}">rodyti</a>` : 'ne'}</td></tr>`).join('')}</table></div>
</body></html>`);
});

// ═══════════════════════════════════════════════════════════════════
// NUOLAIDŲ KODAI, NEBAIGTI MOKĖJIMAI, „MANO ANALIZĖS“ IR PALYGINIMAS
// ─ back:   −15 % 24 val. — laiške apie nebaigtą mokėjimą (tik su sutikimu)
// ─ once:   −30 % dovanai artimam žmogui, 24 val. po apmokėtos analizės
// ─ bundle: porų analizė už rinkinio kainą tam, kas jau pirko asmeninę
// ─ repeat: −30 % pakartotinei analizei su palyginimu (priminimo laiške po 3 mėn.)
// Suma visada skaičiuojama serveryje; kodas vienkartinis.
// ═══════════════════════════════════════════════════════════════════
const PROMOS_FILE = path.join(SHARED_STORAGE_DIR, 'promos.json');
const ABANDONED_FILE = path.join(SHARED_STORAGE_DIR, 'abandoned.json');
const SAVED_FILE = path.join(SHARED_STORAGE_DIR, 'saved-analyses.json');
const BACK_PCT = parseInt(process.env.BACK_DISCOUNT_PCT || '15', 10);
const ONCE_PCT = parseInt(process.env.ONCE_DISCOUNT_PCT || '30', 10);
const REPEAT_PCT = parseInt(process.env.REPEAT_DISCOUNT_PCT || '30', 10);
const ABANDON_DELAY_MS = parseInt(process.env.ABANDON_DELAY_MIN || '60', 10) * 60 * 1000;
const SAVED_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function loadPromos() { return readJson(PROMOS_FILE, { codes: {}, byKey: {} }); }
function savePromos(s) { writeJson(PROMOS_FILE, s); }
function normalizePromoCode(c) { return typeof c === 'string' ? c.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : ''; }
// key — kad tas pats mokėjimas / laiškas visada gautų TĄ PATĮ kodą (ir laikmatis neprasidėtų iš naujo)
function createPromo({ kind, product, pct, price, ttlMs, email, key, meta }) {
  const s = loadPromos();
  if (key && s.byKey[key] && s.codes[s.byKey[key]]) return s.codes[s.byKey[key]];
  let code = '';
  for (let i = 0; i < 30 && (!code || s.codes[code]); i++) { code = ''; for (let j = 0; j < 8; j++) code += GIFT_CODE_ALPHABET[crypto.randomInt(GIFT_CODE_ALPHABET.length)]; }
  const now = Date.now();
  const p = { code, kind, product, pct: pct || 0, price: price || 0, email: (email || '').toLowerCase(), createdAt: now, expiresAt: now + ttlMs, usedBy: null };
  if (meta) p.meta = meta;
  s.codes[code] = p;
  if (key) s.byKey[key] = code;
  savePromos(s);
  return p;
}
// Galiojantis kodas konkrečiam produktui (asmenine | pora | dovana)
function getValidPromo(code, product) {
  code = normalizePromoCode(code);
  if (!code) return null;
  const p = loadPromos().codes[code];
  if (!p || p.product !== product || p.usedBy || Date.now() > p.expiresAt) return null;
  return p;
}
function markPromoUsed(code, ref) {
  code = normalizePromoCode(code);
  if (!code || !ref) return;
  const s = loadPromos(), p = s.codes[code];
  if (p && !p.usedBy) { p.usedBy = ref; p.usedAt = Date.now(); savePromos(s); statInc('promo_' + p.kind); }
}
function promoAmount(p, base) { return p.price ? Math.max(50, Math.min(base, p.price)) : Math.round(base * (100 - p.pct) / 100); }
const PROMO_LABELS = { back: 'Tavo nuolaida', once: 'Pasiūlymas po analizės', bundle: 'Rinkinio kaina', repeat: 'Pakartotinė analizė' };
function promoPublic(p) { return p ? { code: p.code, kind: p.kind, product: p.product, pct: p.pct, price: p.price, expiresAt: p.expiresAt, label: PROMO_LABELS[p.kind] || 'Nuolaida' } : null; }
function promoTag(p) { return p.kind === 'repeat' ? `✦ Pakartotinė analizė −${p.pct} %` : `⏳ Tavo nuolaida −${p.pct} %`; }
function cleanupPromos() {
  try {
    const s = loadPromos(), cut = Date.now() - 30 * DAY_MS; let changed = false;
    for (const [c, p] of Object.entries(s.codes)) if (p.expiresAt < cut) { delete s.codes[c]; changed = true; }
    for (const [k, c] of Object.entries(s.byKey)) if (!s.codes[c]) { delete s.byKey[k]; changed = true; }
    if (changed) savePromos(s);
  } catch (e) {}
}

// Be užklausų ribos: tik skaito, o 8 ženklų kodų atspėti praktiškai neįmanoma
app.get('/promo/check', (req, res) => {
  const code = normalizePromoCode(req.query.code);
  const p = code && loadPromos().codes[code];
  if (!p) return res.json({ valid: false });
  const valid = !p.usedBy && Date.now() <= p.expiresAt;
  res.json({ valid, used: !!p.usedBy, expired: Date.now() > p.expiresAt, ...promoPublic(p), poraPrice: PORA_PRICE_CENTS });
});

// Pasiūlymai rezultato ekrane apmokėjusiam klientui: −30 % dovana (24 val.) ir porų analizė rinkinio kaina
app.post('/promo/offers', sensitiveLimiter, async (req, res) => {
  try {
    const { paymentRef } = req.body || {};
    const p = await getPaidAnalysisPayment(paymentRef);
    if (!p) return res.json({});
    const email = isValidEmail(p.email) ? p.email : '';
    const once = createPromo({ kind: 'once', product: 'dovana', pct: ONCE_PCT, ttlMs: DAY_MS, email, key: 'once:' + paymentRef });
    let bundleGift = null, bundle = null;
    if (p.metadata.bundle === '1') {
      const g = issueBundleGift(paymentRef, email, p.metadata.name || '');
      bundleGift = { code: g.code, link: giftRedeemLink(g), status: giftStatus(g) };
    } else {
      bundle = createPromo({ kind: 'bundle', product: 'pora', price: PORA_BUNDLE_CENTS, ttlMs: 30 * DAY_MS, email, key: 'bundle:' + paymentRef });
    }
    res.json({ once: once.usedBy ? null : promoPublic(once), bundle: bundle && !bundle.usedBy ? promoPublic(bundle) : null, bundleGift, poraPrice: PORA_PRICE_CENTS });
  } catch (err) {
    console.error('/promo/offers klaida:', err);
    res.json({});
  }
});

// Rinkinys „Asmeninė + porų“: apmokėjus išduodamas porų kuponas pirkėjui (vieną kartą mokėjimui)
function issueBundleGift(paymentRef, email, name) {
  const store = loadGiftStore();
  const key = 'bundle:' + paymentRef;
  if (store.bySession[key] && store.codes[store.bySession[key]]) return store.codes[store.bySession[key]];
  const code = generateGiftCode(store.codes), now = Date.now();
  const gift = { code, sessionId: key, buyerEmail: email || '', fromName: name || '', recipientName: '', message: '', kind: 'pora', bundle: true, recipientEmail: '', sendAt: '', season: '', amount: PORA_BUNDLE_CENTS, currency: 'eur', status: 'active', createdAt: now, expiresAt: now + GIFT_VALID_DAYS * DAY_MS };
  store.codes[code] = gift;
  store.bySession[key] = code;
  saveGiftStore(store);
  statInc('bundle');
  console.log(`[bundle] išduotas porų kuponas ${code} (${paymentRef})`);
  if (gift.buyerEmail) {
    mailer.sendMail({
      from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
      to: gift.buyerEmail,
      subject: '💞 Jūsų porų suderinamumas jau apmokėtas',
      html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:28px;margin-bottom:8px">💞</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:10px">Porų suderinamumas — jau apmokėtas</div><p style="font-size:15px;line-height:1.7;color:rgba(245,238,216,.85);margin:0 0 18px">Kartu su asmenine analize įsigijote porų suderinamumą. Kai būsite kartu, atidarykite nuorodą ir nufotografuokite abiejų delnus — mokėti nebereikės.</p><a href="${giftRedeemLink(gift)}" style="display:inline-block;background:#d4a843;color:#140f02;text-decoration:none;padding:14px 26px;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">Pradėti porų analizę →</a><p style="font-size:12px;color:rgba(245,238,216,.5);margin:16px 0 0">Kodas: <b style="letter-spacing:.08em;color:#f0d58a">${escapeHtml(code)}</b> · galioja iki ${fmtLtDate(gift.expiresAt)}</p>${EMAIL_FOOTER_HTML}</div>`
    }).catch(e => console.error('[bundle] laiško klaida:', e.message));
  }
  return gift;
}

// ── Nebaigti mokėjimai: vienas priminimas su −15 % (tik pažymėjus sutikimą) ──
function loadAbandoned() { return readJson(ABANDONED_FILE, { items: [], paid: {} }); }
function saveAbandoned(s) { writeJson(ABANDONED_FILE, s); }
function noteAbandonCandidate(item) {
  try {
    if (!isValidEmail(item.email)) return;
    const s = loadAbandoned(), email = item.email.toLowerCase();
    s.items = s.items.filter(x => !(x.email === email && x.kind === item.kind && !x.sentAt && !x.skip));
    s.items.push({ ...item, id: crypto.randomBytes(6).toString('hex'), email, createdAt: Date.now(), sentAt: null });
    saveAbandoned(s);
  } catch (e) { console.error('[abandon] klaida:', e.message); }
}
const _paidEmailsNoted = new Set();
function markEmailPaid(email) {
  if (!isValidEmail(email)) return;
  const e = email.toLowerCase(), k = e + ':' + Math.floor(Date.now() / 600000);
  if (_paidEmailsNoted.has(k)) return;
  _paidEmailsNoted.add(k);
  try { const s = loadAbandoned(); s.paid[e] = Date.now(); saveAbandoned(s); } catch (err) {}
}
function buildAbandonEmailHtml(it, p) {
  const base = appBaseUrl();
  const pora = it.kind === 'pora';
  const link = pora ? `${base}/pora?grizk=${p.code}` : `${base}/?grizk=${p.code}`;
  const hi = pora ? 'Jūsų porų suderinamumas laukia' : `${it.name ? escapeHtml(it.name) + ', tavo' : 'Tavo'} gyvenimo žemėlapis laukia`;
  const txt = pora
    ? `Pastebėjome, kad nebaigėte užsakymo${it.nameA && it.nameB ? ` (${escapeHtml(it.nameA)} ir ${escapeHtml(it.nameB)})` : ''}. Dovanojame <b style="color:#f0d58a">−${p.pct} % nuolaidą</b> — ji galioja 24 valandas.`
    : `Pastebėjome, kad nebaigei užsakymo — iki tavo delnų analizės liko vienas žingsnis. Dovanojame <b style="color:#f0d58a">−${p.pct} % nuolaidą</b> — ji galioja 24 valandas.`;
  return `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:26px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:10px">${hi}</div><p style="font-size:15px;line-height:1.7;color:rgba(245,238,216,.85);margin:0 0 20px">${txt}</p><a href="${link}" style="display:inline-block;background:linear-gradient(125deg,#fff0c4 0%,#f5d061 22%,#e0a930 45%,#c98a1f 68%,#8a5a0f 100%);color:#000;text-decoration:none;padding:14px 28px;border-radius:14px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">Tęsti su −${p.pct} % →</a><p style="font-size:12px;color:rgba(245,238,216,.5);line-height:1.6;margin:18px 0 0">Nuolaida galioja iki ${ltDate(p.expiresAt)} ${ltHour(p.expiresAt)} val.<br>${pora ? 'Šį vienkartinį laišką gavote, nes pradėjote užsakymą ir jo nebaigėte.' : 'Šį vienkartinį laišką gavai, nes pradėjai užsakymą ir jo nebaigei.'} Daugiau tokių laiškų dėl šio užsakymo nesiųsime.<br><a href="${base}/unsubscribe-reminder?email=${encodeURIComponent(it.email)}" style="color:rgba(245,238,216,.45)">Nebenoriu gauti tokių laiškų</a></p>${EMAIL_FOOTER_HTML}</div>`;
}
let _abandonRunning = false;
async function processAbandoned() {
  if (_abandonRunning) return;
  _abandonRunning = true;
  try {
    const s = loadAbandoned(), now = Date.now(), done = {};
    for (const it of s.items) {
      if (it.sentAt || it.skip || now - it.createdAt < ABANDON_DELAY_MS) continue;
      const paidAt = s.paid[it.email];
      let skip = null;
      if (paidAt && paidAt >= it.createdAt - 5 * 60 * 1000) skip = 'paid';
      else if (now - it.createdAt > DAY_MS) skip = 'old';
      else if (isReminderBlacklisted(it.email)) skip = 'unsub';
      else if (s.items.some(x => x !== it && x.email === it.email && x.sentAt && now - x.sentAt < 30 * DAY_MS)) skip = 'recent';
      else if (it.kind === 'pora' && it.ref) {
        try { const cs = await stripe.checkout.sessions.retrieve(it.ref); if (cs && cs.payment_status === 'paid') skip = 'paid'; } catch (e) {}
      } else if (it.kind === 'asmenine') {
        // Galėjo sumokėti, bet uždaryti langą negrįžęs į programą — patikriname Stripe
        try {
          const r = await stripe.paymentIntents.search({ query: `metadata['email']:'${it.email.replace(/'/g, '')}' AND status:'succeeded'`, limit: 10 });
          if ((r.data || []).some(x => x.created * 1000 >= it.createdAt - 5 * 60 * 1000)) skip = 'paid';
        } catch (e) {}
        if (!skip) try {
          const r = await stripe.checkout.sessions.list({ customer_details: { email: it.email }, limit: 10 });
          if ((r.data || []).some(x => x.payment_status === 'paid' && x.created * 1000 >= it.createdAt - 5 * 60 * 1000)) skip = 'paid';
        } catch (e) {}
      }
      if (skip) { done[it.id] = { skip }; continue; }
      const p = createPromo({ kind: 'back', product: it.kind === 'pora' ? 'pora' : 'asmenine', pct: BACK_PCT, ttlMs: DAY_MS, email: it.email, key: 'back:' + it.id });
      try {
        await mailer.sendMail({
          from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
          to: it.email,
          subject: it.kind === 'pora' ? `Jūsų porų suderinamumas laukia — −${p.pct} % 24 valandoms` : `Tavo gyvenimo žemėlapis laukia — −${p.pct} % 24 valandoms`,
          html: buildAbandonEmailHtml(it, p)
        });
        done[it.id] = { sentAt: Date.now(), code: p.code };
        statInc('abandon_sent');
        console.log(`[abandon] priminimas išsiųstas ${it.email} (${it.kind})`);
      } catch (e) { console.error('[abandon] laiško klaida:', e.message); }
    }
    // Įrašome iš naujo nuskaitytą saugyklą (kol laukėme Stripe/laiškų, galėjo atsirasti naujų įrašų)
    const fresh = loadAbandoned();
    for (const it of fresh.items) if (done[it.id]) Object.assign(it, done[it.id]);
    fresh.items = fresh.items.filter(x => x.createdAt > now - 35 * DAY_MS);
    for (const [e, t] of Object.entries(fresh.paid)) if (t < now - 3 * DAY_MS) delete fresh.paid[e];
    saveAbandoned(fresh);
  } catch (e) { console.error('[abandon] klaida:', e.message); }
  _abandonRunning = false;
}
setInterval(processAbandoned, 10 * 60 * 1000);
setTimeout(processAbandoned, 20 * 1000);

// ── „Mano analizės“: išsaugotos (su sutikimu) asmeninės analizės, be nuotraukų ──
function loadSaved() { return readJson(SAVED_FILE, { items: {}, bySession: {}, tokens: {}, lastLink: {} }); }
function saveSavedStore(s) { writeJson(SAVED_FILE, s); }
function upsertSavedAnalysis(sessionId, email, name, result, extra) {
  const s = loadSaved();
  let id = s.bySession[sessionId];
  const now = Date.now();
  if (!id || !s.items[id]) { id = 'sa_' + crypto.randomBytes(9).toString('hex'); s.bySession[sessionId] = id; statInc('saved'); }
  const prev = s.items[id] || {};
  s.items[id] = { ...prev, ...(extra || {}), id, email: email.toLowerCase(), name: name || prev.name || '', result, createdAt: prev.createdAt || now, expiresAt: now + SAVED_DAYS * DAY_MS };
  saveSavedStore(s);
  return id;
}
function cleanupSaved() {
  try {
    const s = loadSaved(), now = Date.now(); let changed = false;
    for (const [id, it] of Object.entries(s.items)) if (it.expiresAt < now) { delete s.items[id]; changed = true; }
    for (const [sid, id] of Object.entries(s.bySession)) if (!s.items[id]) { delete s.bySession[sid]; changed = true; }
    for (const [t, v] of Object.entries(s.tokens)) if (v.exp < now) { delete s.tokens[t]; changed = true; }
    for (const [e, t] of Object.entries(s.lastLink)) if (t < now - DAY_MS) { delete s.lastLink[e]; changed = true; }
    if (changed) saveSavedStore(s);
  } catch (e) {}
}
setInterval(() => { cleanupSaved(); cleanupPromos(); }, 6 * 60 * 60 * 1000);
setTimeout(() => { cleanupSaved(); cleanupPromos(); }, 30 * 1000);

// Išsaugoti apmokėtą analizę (serveris ima rezultatą iš savo laikinos saugyklos — klientas jo nesiunčia)
app.post('/save-analysis', sensitiveLimiter, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return res.status(400).json({ error: 'Neteisinga užklausa' });
    const e = analysisCache.get(sessionId);
    if (!e || e.status !== 'done' || !e.result || !e.paid) return res.status(404).json({ error: 'Analizės išsaugoti nebepavyksta — tai galima padaryti per 3 valandas po užsakymo.' });
    const email = isValidEmail(e.paidEmail) ? e.paidEmail : (isValidEmail(req.body.email) ? req.body.email : '');
    if (!email) return res.status(400).json({ error: 'Nerastas el. paštas' });
    const name = e.paidName || e.name || '';
    const id = upsertSavedAnalysis(sessionId, email, name, e.compare ? { ...e.result, palyginimas: e.compare } : e.result);
    scheduleReminderFor(email, name, id);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('/save-analysis klaida:', err);
    res.status(500).json({ error: 'Nepavyko išsaugoti' });
  }
});

// ── Palyginimas su ankstesne analize (pakartotinė analizė per priminimo laišką) ──
async function runCompareAnalysis(prev, cur, name) {
  const brief = r => {
    let t = '';
    const dg = r.delnai_greta;
    if (dg && dg.sirdis) t += `Delnai: jausmai — ${dg.sirdis.desinys}; mąstymas — ${dg.protas && dg.protas.desinys}; gyvenimo tempas — ${dg.gyvenimas && dg.gyvenimas.desinys}. ${dg.isvada || ''}\n`;
    for (const k of KLAUSK_RESULT_FIELDS) if (typeof r[k] === 'string') t += `${k}: ${r[k].slice(0, 700)}\n`;
    if (Array.isArray(r.stiprybes_sarasas)) t += `Stiprybės: ${r.stiprybes_sarasas.join(', ')}\n`;
    return t;
  };
  const prompt = `Tu esi patyręs chiromantas. ${name ? name + ' ' : 'Žmogus '}prieš kelis mėnesius pasidarė delnų analizę, o dabar — naują. Palygink jas ir parašyk, KAS PASIKEITĖ.

ANKSTESNĖ ANALIZĖ:
${brief(prev)}
NAUJA ANALIZĖ:
${brief(cur)}
Užduotis: išrink 3 sritis, kuriose skirtumas ryškiausias (pvz. Jausmai, Mąstymas, Santykiai, Darbas ir pinigai, Pasitikėjimas savimi, Gyvenimo tempas). Kiekvienai: tema (1–3 žodžiai), anksciau (iki 100 simbolių — kas buvo), dabar (iki 100 simbolių — kas yra dabar). Tada isvada: 2–3 sakiniai apie tai, kur žmogus pajudėjo ir kam verta skirti dėmesio toliau. Jei kurioje srityje pokyčių beveik nėra — taip ir parašyk (pvz. „Ši stiprybė išliko tvirta“). Nieko neišgalvok, remkis tik abiem analizėmis.
Rašyk taisyklinga, paprasta lietuvių kalba, „tu“ forma, esamuoju laiku apie dabartį. Skaitytojo lytis nežinoma — nevartok giminę turinčių dalyvių. Nenaudok tiesioginių kabučių simbolio " teksto viduje.
ATSAKYK TIK JSON: {"sritys":[{"tema":"...","anksciau":"...","dabar":"..."}],"isvada":"..."}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1200, temperature: 0.4, messages: [{ role: 'user', content: prompt }] })
      }, 60000);
      const d = await r.json();
      const txt = (d.content || []).map(b => b.text || '').join('');
      const m = txt.match(/\{[\s\S]*\}/);
      const j = m ? parseJsonLenient(m[0]) : null;
      const fx = (t, n) => applyTextFixes(String(t).trim().replace(/"/g, '').slice(0, n)).text;
      const sr = j && Array.isArray(j.sritys) ? j.sritys.filter(x => x && typeof x.tema === 'string' && typeof x.anksciau === 'string' && typeof x.dabar === 'string').slice(0, 4) : [];
      if (sr.length >= 2 && typeof j.isvada === 'string') return { sritys: sr.map(x => ({ tema: fx(x.tema, 40), anksciau: fx(x.anksciau, 160), dabar: fx(x.dabar, 160) })), isvada: fx(j.isvada, 500) };
    } catch (e) { console.error('[compare] klaida:', e.message); }
  }
  throw new Error('Nepavyko palyginti analizių');
}
const _comparePending = new Map();
app.post('/compare', sensitiveLimiter, async (req, res) => {
  try {
    const { sessionId, code } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return res.status(400).json({ error: 'Neteisinga užklausa' });
    const ps = loadPromos(), p = ps.codes[normalizePromoCode(code)];
    if (!p || p.kind !== 'repeat' || !p.meta || !p.meta.savedId) return res.status(404).json({ error: 'Palyginimo kodas nerastas' });
    if (p.meta.compareSession && p.meta.compareSession !== sessionId) return res.status(409).json({ error: 'Šis palyginimas jau panaudotas' });
    const e = analysisCache.get(sessionId);
    if (!e || e.status !== 'done' || !e.result || !e.paid) return res.status(404).json({ error: 'Analizė nerasta' });
    const prev = loadSaved().items[p.meta.savedId];
    if (!prev) return res.status(404).json({ error: 'Ankstesnė analizė nebeišsaugota' });
    if (e.compare) return res.json({ palyginimas: e.compare, prevDate: prev.createdAt });
    if (!p.meta.compareSession) { p.meta.compareSession = sessionId; savePromos(ps); }
    if (!_comparePending.has(sessionId)) {
      _comparePending.set(sessionId, runCompareAnalysis(prev.result, e.result, e.paidName || prev.name || '').finally(() => _comparePending.delete(sessionId)));
    }
    const cmp = await _comparePending.get(sessionId);
    e.compare = cmp;
    saveAnalysisSessionToDisk(sessionId, e);
    // Nauja analizė su palyginimu išsaugoma tame pačiame „Mano analizės“ sąraše (sutikimas duotas anksčiau)
    upsertSavedAnalysis(sessionId, prev.email, e.paidName || prev.name || '', { ...e.result, palyginimas: cmp }, { prevId: prev.id });
    res.json({ palyginimas: cmp, prevDate: prev.createdAt });
  } catch (err) {
    console.error('/compare klaida:', err);
    res.status(500).json({ error: 'Nepavyko palyginti analizių' });
  }
});

// ── „Mano analizės“ puslapis: nuoroda el. paštu (be slaptažodžio) ──
app.get('/mano', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'mano.html'));
});
function manoItems(email) {
  const e = email.toLowerCase();
  const analizes = Object.values(loadSaved().items).filter(x => x.email === e)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(x => ({ id: x.id, name: x.name || '', createdAt: x.createdAt, expiresAt: x.expiresAt, compare: !!(x.result && x.result.palyginimas) }));
  const poros = Object.entries(loadPoraOrders()).filter(([, o]) => (o.email || '').toLowerCase() === e && o.status === 'done')
    .map(([id, o]) => ({ id, nameA: o.nameA || '', nameB: o.nameB || '', createdAt: o.finishedAt || o.createdAt || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const klausimai = Object.entries(loadKlauskOrders()).filter(([, o]) => (o.email || '').toLowerCase() === e && o.paid)
    .map(([id, o]) => ({ id, kind: o.kind || 'asmenine', name: o.name || '', count: (o.qa || []).length, createdAt: o.paidAt || o.createdAt || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { analizes, poros, klausimai };
}
function manoEmailFromToken(t) {
  if (typeof t !== 'string' || !/^mt_[a-f0-9]{32}$/.test(t)) return null;
  const v = loadSaved().tokens[t];
  return v && v.exp > Date.now() ? v.email : null;
}
app.post('/mano/link', sensitiveLimiter, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto adresas' });
    // Atsakymas visada tas pats — kad nebūtų galima tikrinti, ar adresas yra mūsų sąraše
    res.json({ ok: true });
    const items = manoItems(email);
    if (!items.analizes.length && !items.poros.length && !items.klausimai.length) return;
    const s = loadSaved();
    if (s.lastLink[email] && Date.now() - s.lastLink[email] < 2 * 60 * 1000) return;
    const t = 'mt_' + crypto.randomBytes(16).toString('hex');
    s.tokens[t] = { email, exp: Date.now() + 7 * DAY_MS };
    s.lastLink[email] = Date.now();
    saveSavedStore(s);
    statInc('mano');
    await mailer.sendMail({
      from: `"DELNAS" <${CLIENT_EMAIL_FROM}>`,
      to: email,
      subject: '✦ Jūsų DELNAS analizės',
      html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto;text-align:center"><div style="font-size:26px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:10px">Jūsų analizės</div><p style="font-size:15px;line-height:1.7;color:rgba(245,238,216,.85);margin:0 0 20px">Paspauskite mygtuką — atsidarys visos šiuo el. paštu išsaugotos jūsų analizės.</p><a href="${appBaseUrl()}/mano?t=${t}" style="display:inline-block;background:#d4a843;color:#140f02;text-decoration:none;padding:14px 26px;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">Atidaryti mano analizes →</a><p style="font-size:12px;color:rgba(245,238,216,.5);margin:16px 0 0">Nuoroda galioja 7 dienas. Jei jos neprašėte — tiesiog ignoruokite šį laišką.</p>${EMAIL_FOOTER_HTML}</div>`
    }).catch(e => console.error('[mano] laiško klaida:', e.message));
  } catch (err) {
    console.error('/mano/link klaida:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Nepavyko išsiųsti nuorodos' });
  }
});
app.get('/mano/list', sensitiveLimiter, (req, res) => {
  const email = manoEmailFromToken(req.query.t);
  if (!email) return res.status(403).json({ error: 'Nuoroda nebegalioja — paprašykite naujos.' });
  res.json({ email, ...manoItems(email) });
});
app.get('/mano/item', sensitiveLimiter, (req, res) => {
  const email = manoEmailFromToken(req.query.t);
  if (!email) return res.status(403).json({ error: 'Nuoroda nebegalioja — paprašykite naujos.' });
  const it = loadSaved().items[String(req.query.id || '')];
  if (!it || it.email !== email) return res.status(404).json({ error: 'Analizė nerasta' });
  res.json({ id: it.id, name: it.name, createdAt: it.createdAt, result: it.result });
});
app.post('/mano/delete', sensitiveLimiter, (req, res) => {
  const { t, id } = req.body || {};
  const email = manoEmailFromToken(t);
  if (!email) return res.status(403).json({ error: 'Nuoroda nebegalioja — paprašykite naujos.' });
  const s = loadSaved(), it = s.items[String(id || '')];
  if (!it || it.email !== email) return res.status(404).json({ error: 'Analizė nerasta' });
  delete s.items[it.id];
  for (const [sid, v] of Object.entries(s.bySession)) if (v === it.id) delete s.bySession[sid];
  saveSavedStore(s);
  const rem = loadReminders(); let ch = false;
  for (const r of rem) if (r.savedId === it.id) { delete r.savedId; ch = true; }
  if (ch) saveReminders(rem);
  console.log(`[mano] ištrinta analizė ${it.id}`);
  res.json({ ok: true });
});

app.get('/privatumo-politika', (req, res) => {
  res.sendFile(path.join(__dirname, 'privatumo-politika.html'));
});
app.get('/naudojimosi-salygos', (req, res) => {
  res.sendFile(path.join(__dirname, 'naudojimosi-salygos.html'));
});

// SVARBU: šis bendras "catch-all" maršrutas TURI būti PASKUTINIS
// registruotas GET maršrutas šiame faile — jis veikia kaip atsarginis
// variantas TIK toms užklausoms, kurios neatitiko NĖ VIENO aukščiau
// esančio konkretaus maršruto. Jei jis būtų registruotas ANKSČIAU, jis
// perimtų visas vėlesnes užklausas pirmiau, nei jos pasiektų savo
// tikruosius apdorotojus.
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DELNAS v25 veikia: http://localhost:${PORT}`));
