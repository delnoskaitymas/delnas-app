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
//   STRIPE_PRICE_ID_PROMO   = price_... (test režimo Price ID, 9,99 €)
//   STRIPE_PRICE_ID_REGULAR = price_... (test režimo Price ID, 15,99 €)
// (Test Price ID'us gausite Stripe Dashboard, perjungę viršuje "Test mode",
// tada Product catalog → sukurkite/pasižiūrėkite tuos pačius produktus.)
//
// GRĮŽTI Į LIVE: tiesiog ištrinkite šiuos 4 kintamuosius iš Railway
// Variables (arba įrašykite atgal sk_live_/pk_live_ ir live Price ID'us) —
// kodas automatiškai naudos numatytąsias (live) reikšmes žemiau.
const STRIPE_PRICE_ID_PROMO = process.env.STRIPE_PRICE_ID_PROMO || 'price_1TzgxjFqSjrMSpekQiJKn48d';    // 9,99 €  — speciali_kaina
const STRIPE_PRICE_ID_REGULAR = process.env.STRIPE_PRICE_ID_REGULAR || 'price_1TzgxjFqSjrMSpekJ8BSCRda'; // 15,99 € — iprasta_kaina
// ACTIVE_PRICE_ID nurodo, kuri kaina ŠIUO METU realiai taikoma checkout metu.
// Kol 9,99 € akcija dar nebuvo realiai taikyta bent tam tikrą laikotarpį,
// parduodame už TIKRĄ, įprastą kainą (15,99 €) — kad vėliau, jei norėsite
// paleisti 9,99 € akciją su perbrauktu 15,99 €, tai turėtų teisėtą, realiai
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
  max: 60,                  // iki 60 užklausų per 15 min. iš vieno IP
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

app.use(express.static(path.join(__dirname, '.'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use('/webhook', express.raw({ type: 'application/json' }));
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
          from: `"Delno Skaitymas" <${CLIENT_EMAIL_FROM}>`,
          to: r.email,
          subject: `${r.name ? escapeHtml(r.name) + ', l' : 'L'}aikas naujam delnų skaitymui ✦`,
          html: `<div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:24px"><div style="font-size:28px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:22px;font-weight:700;color:#d4a843;margin-bottom:8px">${r.name ? escapeHtml(r.name) + ', atėjo laikas' : 'Atėjo laikas'}</div><div style="font-size:14px;color:rgba(245,238,216,.6)">Praėjo 3 mėnesiai nuo tavo delnų analizės</div></div><div style="background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.2);border-radius:12px;padding:20px;margin-bottom:24px;font-size:14px;line-height:1.8;color:rgba(245,238,216,.85)">Delnų linijos keičiasi kartu su tavimi. Per 3 mėnesius tavo gyvenimas pasikeitė — o su juo ir tai, ką pasakoja tavo delnai.</div><div style="text-align:center;margin-bottom:20px"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}" style="background:linear-gradient(125deg,#fff0c4 0%,#f5d061 22%,#e0a930 45%,#c98a1f 68%,#8a5a0f 100%);color:#000000;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:700;font-size:14px;letter-spacing:.08em;text-transform:uppercase;display:inline-block;box-shadow:0 4px 20px rgba(212,168,67,.4)">Atnaujinti žemėlapį →</a></div><div style="text-align:center;padding-top:16px;border-top:1px solid rgba(212,168,67,.15)"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/unsubscribe-reminder?email=${encodeURIComponent(r.email)}" style="color:rgba(245,238,216,.4);text-decoration:underline;font-size:11px">Nebenoriu gauti šių priminimų</a></div></div>`
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

function createToken(name, email) {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.set(token, { name, email, used: false, createdAt: Date.now() });
  setTimeout(() => validTokens.delete(token), 2 * 60 * 60 * 1000);
  return token;
}

// --- Foninės analizės cache ---
const analysisCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of analysisCache.entries()) {
    if (now - entry.createdAt > 3 * 60 * 60 * 1000) analysisCache.delete(id);
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
const pendingOrders = new Map();

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
function sendPaymentSuccessEmails(orderNumber, fallbackName, fallbackEmail) {
  try {
    let entry = orderNumber ? pendingOrders.get(orderNumber) : null;
    const name = (entry && entry.name) || fallbackName || '';
    const email = (entry && entry.email) || fallbackEmail || '';
    console.log(`[sendPaymentSuccessEmails] iškviesta orderNumber=${orderNumber||'(nėra)'} entryRastas=${!!entry} email=${email||'(nėra)'}`);
    if (!email) { console.log('[sendPaymentSuccessEmails] nėra el. pašto, praleidžiama'); return; }
    if (entry && entry.orderConfirmed) { console.log('[sendPaymentSuccessEmails] jau išsiųsta anksčiau, praleidžiama'); return; }
    if (entry) entry.orderConfirmed = true;

    const displayOrderNumber = orderNumber || '(nėra numerio)';

    // Administratoriui (info@) — pranešimas apie naują mokėjimą. TAI
    // VIENINTELIS administracinis laiškas apie šį užsakymą —
    // /notify-order-complete (žr. žemiau) daugiau ANTRO tokio laiško
    // NEBESIUNČIA.
    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_USER || process.env.EMAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `Naujas užsakymas #${displayOrderNumber}`,
      html: `<div style="font-family:Georgia,serif;padding:20px"><h2>Naujas sėkmingas mokėjimas</h2><p><strong>Užsakymo numeris:</strong> ${escapeHtml(displayOrderNumber)}</p><p><strong>Klientas:</strong> ${escapeHtml(name)}</p><p><strong>El. paštas:</strong> ${escapeHtml(email)}</p><p><strong>Paslauga:</strong> Delno skaitymo asmeninė analizė</p><p><strong>Suma:</strong> 15,99 €</p></div>`
    }).then(() => console.log(`[sendPaymentSuccessEmails] administratoriui išsiųsta į ${ADMIN_EMAIL}`))
      .catch(e => console.error('[sendPaymentSuccessEmails] klaida siunčiant administratoriui:', e.message));
  } catch (e) {
    console.error('[sendPaymentSuccessEmails] bendra klaida:', e.message);
  }
}

// Apsauginis išvalymas — jei dėl kokios nors priežasties (vartotojas
// nebaigė proceso, tinklo klaida ir pan.) /notify-order-complete niekada
// nebuvo iškviestas, įrašas vis tiek nelieka amžinai atmintyje.
setInterval(() => {
  const now = Date.now();
  for (const [num, entry] of pendingOrders.entries()) {
    if (now - entry.createdAt > 6 * 60 * 60 * 1000) pendingOrders.delete(num);
  }
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
const EMAIL_FOOTER_HTML = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(212,168,67,.2);text-align:center"><a href="https://delnaskaitymas.lt" style="color:#d4a843;text-decoration:none;font-size:12px;letter-spacing:.04em">delnaskaitymas.lt</a></div>`;

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
  ['klutys', 'string'], ['klutys_insights', 'array']
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
    max_tokens: 1000,
    temperature: 0.2,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        {
          type: 'text',
          text: `Pažvelk į šias delno nuotraukas ir nustatyk 7 svarbiausius vizualinius požymius kurie atskleidžia šio žmogaus charakterį.

Grąžink TIKTAI JSON:
{
  "bruozai": [
    "Energijos lygis ir vitalumas: [ką matai]",
    "Emocinis gylis ir jautrumas: [ką matai]",
    "Mąstymo tipas - analitinis ar intuityvus: [ką matai]",
    "Ryžtas ir valios stiprumas: [ką matai]",
    "Santykių su kitais pobūdis: [ką matai]",
    "Ambicijų ir tikslų ryškumas: [ką matai]",
    "Vidinė įtampa ar ramybė: [ką matai]"
  ]
}`
        }
      ]
    }]
  });

  let step1Data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: step1Body
    });
    step1Data = await r.json();
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
    if (entry && entry.status === 'pending') entry.status = 'step2';
  }
  const bruozaiText = bruozai.length > 0
    ? `Vizualiniai delno parametrai:\n${bruozai.map((b, i) => `${i+1}. ${b}`).join('\n')}\n\n`
    : '';

  const step2Content = [
    ...imageBlocks,
    {
      type: 'text',
      text: `Tu esi chiromantijos meistras su 20 metų patirtimi. Prieš tave yra${name ? ' ' + name + ' —' : ''} kairio ir dešinio delno nuotraukos. Matai juos aiškiai.

${bruozaiText}Remdamasis TIKTAI tuo, ką realiai MATAI šiuose konkrečiuose delnuose (aukščiau esančiais vizualiniais parametrais), parašyk tikslią, konkrečią chiromantijos analizę lietuvių kalba BŪTENT apie šį žmogų. Tai NĖRA bendro pobūdžio tekstas — kiekvienas sakinys turi remtis tuo, ką matai ŠIUOSE delnuose, ir turi būti toks specifiškas, kad netiktų jokiam kitam žmogui.

TAISYKLĖS:
- Kiekvienas sakinys = konkretus faktas apie ŠĮ ŽMOGŲ, tiesiogiai paremtas tuo, ką matai jo delne — ne bendra tiesa apie žmones apskritai
- PRIEŠ rašydamas kiekvieną sakinį, patikrink: ar šis sakinys tiktų BET KURIAM kitam žmogui? Jei taip — perrašyk konkrečiau, susiedamas su tuo, ką matai šiame delne
- DRAUDŽIAMA tušti, "vatos" sakiniai, kurie nieko konkretaus nepasako ir neduoda vertės (pvz. bendri apibendrinimai, pripildymo frazės) — kiekvienas sakinys privalo nešti naują, konkretų faktą
- Rašyk tiesiai ir drąsiai: "Tu esi...", "Tu linkęs...", "Tau sekasi...", "Tu vengi...", "Tau sunku..."
- DRAUDŽIAMA: "gali būti", "tikėtina", "galima manyti", "energija", "vibracija"
- DRAUDŽIAMA: minėti linijų pavadinimus ar delno anatomiją
- DRAUDŽIAMA: abstrakčios, bendrinės frazės kurios tiktų bet kuriam žmogui (pvz. "kiekvienas žmogus turi savo stiprybes", "gyvenimas kupinas iššūkių") — VISKAS turi būti konkretu ir asmeniška
- Kalba: TAISYKLINGA lietuvių kalba — teisingi linksniai, galūnės, sakinio konstrukcijos. Kreipkis "tu"
- Stiliaus lygis: VIDUTINIS — nei sudėtingas/knyginis/mokslinis, nei gatvės/šnekamosios kalbos stilius su žargonu. Rašyk taip, kaip protingas, kultūringas žmogus kalbėtų rimtame, bet šiltame pokalbyje
- DRAUDŽIAMA: sudėtingi, knyginiai, moksliniai ar oficialūs žodžiai (pvz. "manifestuoja", "transformacija", "potencialas" kaip terminas, "orientyras", "dinamika")
- DRAUDŽIAMA: gatvės stiliaus, žargoninė, per daug šnekamoji kalba, sutrumpinimai
- DRAUDŽIAMA žodis "galva" — jei reikia paminėti protą/mąstymą, naudok žodį "protas" (pvz. "tavo protas dirba greitai", ne "tavo galva dirba greitai")
- KRITIŠKAI SVARBU (JSON formatui): NIEKADA nenaudok tiesioginės kabutės simbolio " teksto viduje, nei akcentuojant žodį/frazę, nei kaip citatos ženklo — NET IR VIENĄ KARTĄ, nes tai sugadina JSON struktūrą. Jei nori pabrėžti ar "iškelti" žodį/frazę, naudok TIK paprastą kablelinę kabutę 'štai taip' (apostrofus), niekada ne „lietuviškas" ar tiesiogines dvigubas kabutes. Tai taikoma VISUR — visuose skyriuose ir insights laukuose.
- Kiekvienas žodis ir sakinys turi turėti prasmę ir svorį — jokių tuščių, niekuo neprisidedančių žodžių ar sakinio dalių
- DRAUDŽIAMA: ilgi, pernelyg susiraizgę, keliais šalutiniais sakiniais apkrauti sakiniai — rašyk aiškiais, tvirtais sakiniais
- Kiekvienas skyrius: 7–9 sakiniai, skyriai nesikartoja tarpusavyje
- KIEKVIENAME skyriuje žemiau nurodytos 3 potemių grupės — atskleisk visas 3, sklandžiu, natūraliu tekstu (ne sąrašu)

SKYRIAI — kiekvienas kalba tik apie savo temą ir atskleidžia 3 žemiau nurodytas potemių grupes:

- prigimtines_stiprybes (Prigimtinės stiprybės ir charakteris): (a) jo unikalų asmenybės branduolį ir pamatinius, jį apibrėžiančius charakterio bruožus; (b) gilų vidinį/psichologinį portretą ir tai, kokia vidinė jėga/prigimtis jį veda; (c) jo natūralų, įgimtą potencialą ir tai, kas konkrečiai jį išskiria iš kitų

- gyvenimo_tikslas (Gyvenimo kryptis ir tikslai): (a) kryptį, kuria jis natūraliai juda gyvenime, ir kas jį iš vidaus varo pirmyn; (b) giliau slypinčius jo tikslus ir kryptį, kuria jis auga kaip asmenybė; (c) svarbiausius jo gyvenimo kelio posūkius ir gaires, kurias jis pats sau kelia ateičiai

- santykiai (Bendravimo būdas ir įtaka santykiams): (a) kaip jis kuria emocinį ryšį su kitais ir koks jo bendravimo stilius; (b) kokį poveikį daro aplinkiniams ir pasikartojančius elgesio su žmonėmis modelius; (c) kaip jis siekia pusiausvyros santykiuose ir gebėjimą kurti gilų, ilgalaikį ryšį

- finansai (Finansinis potencialas): (a) kur/kaip jo finansinė sėkmė labiausiai įmanoma ir jo potencialą kurti materialią gerovę; (b) kas jam natūraliai atveria finansines galimybes; (c) jo karjeros/gerovės perspektyvas ir nepastebėtus, dar neišnaudotus finansinius talentus. Rašyk apie GALIMYBES ir POTENCIALĄ — ne apie tai, kaip jis leidžia/taupo pinigus

- galimybes (Unikalus sėkmės raktas): (a) jo asmeninę sėkmės formulę ir didžiausią pranašumą prieš kitus; (b) kaip jis natūraliai įveikia iššūkius ir ką naudoja sunkiausiais momentais („slaptąjį ginklą"); (c) kas jam visada atveria duris ten, kur kitiems sunkiau, ir jo unikalų kelią į pripažinimą

- pokyciai (Svarbiausi artėjantys pokyčiai): (a) koks reikšmingas posūkis artėja jo gyvenime ir kokios naujos galimybės netrukus atsivers; (b) koks vidinis transformacijos etapas jo laukia; (c) kas konkrečiai jo gyvenime netrukus pasikeis į gerą ir kokie ženklai tai jau rodo

- klutys (Pažangą stabdančios kliūtys): (a) nesąmoningus, giliai įsišaknijusius jo stabdžius ir kasdienius įpročius, kurie vėlina sėkmę; (b) konkrečią kliūtį jo kelyje į tikslą ir kas trukdo jam pilnai atsiskleisti; (c) ką jam metas paleisti, kad atsiblokuotų tikrasis jo potencialas

- stiprybes_sarasas: 5 savybių pavadinimai (2–4 žodžiai, konkretūs ir prasmingi)
- Kiekvienam skyriui "_insights": 3 trumpi sakiniai (max 8 žodžiai) — NAUJI faktai kurie PAPILDO tekstą, tiksliai atitinkantys skyriaus temą, nesikartojantys su tekstu

ATSAKYK TIKTAI JSON. Pradėk nuo {.

{"prigimtines_stiprybes":"7-9 sakiniai","prigimtines_insights":["Faktas 1","Faktas 2","Faktas 3"],"gyvenimo_tikslas":"7-9 sakiniai","gyvenimo_insights":["Faktas 1","Faktas 2","Faktas 3"],"santykiai":"7-9 sakiniai","santykiai_insights":["Faktas 1","Faktas 2","Faktas 3"],"finansai":"7-9 sakiniai","finansai_insights":["Faktas 1","Faktas 2","Faktas 3"],"pokyciai":"7-9 sakiniai","pokyciai_insights":["Faktas 1","Faktas 2","Faktas 3"],"galimybes":"7-9 sakiniai","galimybes_insights":["Faktas 1","Faktas 2","Faktas 3"],"stiprybes_sarasas":["Savybė 1","Savybė 2","Savybė 3","Savybė 4","Savybė 5"],"klutys":"7-9 sakiniai","klutys_insights":["Faktas 1","Faktas 2","Faktas 3"]}`
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
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 10000,
          temperature: 0.2,
          messages: [
            { role: 'user', content: step2Content },
            { role: 'assistant', content: '{' }
          ]
        })
      });
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
    if (step2Data?.error) console.error('[runPalmAnalysis] Žingsnis 2 galutinė klaida:', JSON.stringify(step2Data.error));
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

  return result;
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

    analysisCache.set(sessionId, {
      status: 'pending',
      result: null,
      error: null,
      photos,
      name: req.body.name || '',
      createdAt: Date.now()
    });
    console.log(`[start-analysis] sessionId=${sessionId} UŽREGISTRUOTAS cache'e (status=pending), cacheSize=${analysisCache.size}`);

    res.json({ started: true, sessionId });

    runPalmAnalysis(photos, req.body.name || '', sessionId)
      .then(result => {
        const entry = analysisCache.get(sessionId);
        if (entry) { entry.status = 'done'; entry.result = result; console.log(`[start-analysis] sessionId=${sessionId} FONO ANALIZĖ BAIGTA sėkmingai`); }
        else console.log(`[start-analysis] sessionId=${sessionId} FONO ANALIZĖ baigta, BET cache įrašo BENĖRA (?!)`);
      })
      .catch(err => {
        const entry = analysisCache.get(sessionId);
        if (entry) { entry.status = 'error'; entry.error = err.message; }
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
app.post('/create-checkout', sensitiveLimiter, async (req, res) => {
  try {
    const { email, name, bgSessionId, orderNumber } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (bgSessionId && (typeof bgSessionId !== 'string' || bgSessionId.length > 200)) return res.status(400).json({ error: 'Neteisingas bgSessionId' });
    if (orderNumber && !isValidOrderNumber(orderNumber)) return res.status(400).json({ error: 'Neteisingas orderNumber formatas' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['revolut_pay'],
      line_items: [{
        price: ACTIVE_PRICE_ID,
        quantity: 1
      }],
      mode: 'payment',
      locale: 'lt',
      customer_email: email,
      // SVARBU: bgSessionId ir orderNumber saugomi ČIA, Stripe pusėje —
      // kai vartotojas peradresuojamas per Stripe Checkout (Revolut Pay) ir
      // grįžta atgal, naršyklės sessionStorage KAI KADA "pamiršta" šiuos
      // duomenis (ypač iOS Safari, dėl griežtos tarpsvetaininės apsaugos).
      // Stripe metadata yra PATIKIMAS, serverio pusės šaltinis, nepriklausantis
      // nuo naršyklės saugyklos elgsenos.
      metadata: { name: name || '', email, bgSessionId: bgSessionId || '', orderNumber: orderNumber || '' },
      success_url: `https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/`
    });
    
    res.json({ url: session.url });
  } catch(err) {
    console.error('/create-checkout klaida:', err);
    res.status(500).json({ error: err.message });
  }
});

// El. pašto siuntimas su rezultatais
async function sendResultEmail(email, name, result) {
  // Naudoti nodemailer jei sukonfigūruotas, arba išsaugoti queue
  const emailData = { email, name, result, sentAt: new Date().toISOString() };
  // Išsaugoti į failą kaip eilę (jei nėra SMTP)
  try {
    const queueFile = path.join(__dirname, 'email_queue.json');
    let queue = [];
    if (fs.existsSync(queueFile)) {
      queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    }
    queue.push(emailData);
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
    console.log(`Email eilė: ${email} (${name})`);
  } catch(e) { console.error('Email queue klaida:', e); }
}

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
    console.log(`[notify-order-complete] ${orderNumber} — įrašas ${existed ? 'ištrintas iš atminties' : 'nerastas (jau ištrintas arba pasenęs)'} (administracinis laiškas jau išsiųstas anksčiau, žr. sendPaymentSuccessEmails)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify-order-complete] klaida:', err);
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
    const { email, name, orderNumber, pdfBase64 } = req.body;
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
      from: `"Delno Skaitymas — Užsakymai" <${CLIENT_EMAIL_FROM}>`,
      to: email,
      subject: `${name ? escapeHtml(name) + ' — ' : ''}Mokėjimas gautas, tavo gyvenimo žemėlapis paruoštas ✦`,
      html: `<div style="font-family:Georgia,serif;background:#07040f;color:#f5eed8;padding:32px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:22px"><div style="font-size:26px;margin-bottom:8px">✦</div><div style="font-size:20px;font-weight:700;color:#d4a843;margin-bottom:12px">Mokėjimas gautas, ačiū${name ? ', ' + escapeHtml(name) : ''}!</div><div style="font-size:15px;color:rgba(245,238,216,.85)">Tavo asmeninis gyvenimo žemėlapis paruoštas!</div></div>${orderNumber ? `<div style="text-align:center;margin-bottom:20px"><p style="font-size:14px;line-height:1.4;margin:0 0 5px">Tavo užsakymo numeris:</p><p style="font-size:18px;font-weight:700;color:#d4a843;letter-spacing:.05em;margin:0">${escapeHtml(orderNumber)}</p></div>` : ''}<p style="font-size:14px;line-height:1.7;color:rgba(245,238,216,.8);text-align:center;margin:0 0 4px">Pridėtame PDF faile rasi pilną savo gyvenimo žemėlapį.</p>${EMAIL_FOOTER_HTML}</div>`,
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
    const { photos, name, email, token, sessionId } = req.body;

    if (typeof token !== 'string' || token.length === 0) return res.status(403).json({ error: 'Mokėjimas nepatvirtintas.' });
    if (name && !isValidName(name)) return res.status(400).json({ error: 'Neteisingas vardo formatas' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Neteisingas el. pašto formatas' });
    if (sessionId && (typeof sessionId !== 'string' || sessionId.length > 200)) return res.status(400).json({ error: 'Neteisingas sessionId' });
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
      } else if (cached.status === 'pending') {
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
            if (!entry || entry.status !== 'pending' || waited >= 8) { clearInterval(iv); resolve(); }
          }, 1000);
        });
        const entry = analysisCache.get(sessionId);
        if (entry && entry.status === 'done' && entry.result) {
          result = entry.result;
          console.log(`[analyze-palm] sessionId=${sessionId} -> baigėsi per laukimo langą, naudojamas rezultatas`);
          // Netriname (žr. komentarą aukščiau — apsauga nuo lenktynių
          // sąlygos su kliento pusės laiko limitu/abort).
        } else if (entry && entry.status === 'pending') {
          console.log(`[analyze-palm] sessionId=${sessionId} -> VIS DAR pending po 8s laukimo, grąžinam 202`);
          return res.status(202).json({ pending: true, sessionId });
        } else if (entry && entry.status === 'error') {
          // Ta pati apsauga kaip aukščiau — grąžiname klaidą IŠKART, o NE
          // triname cache ir paleidžiame naują brangų AI kvietimą.
          console.log(`[analyze-palm] sessionId=${sessionId} -> fono analizė nepavyko laukimo lango metu (${entry.error}), grąžinam klaidą IŠKART`);
          analysisCache.delete(sessionId);
          return res.status(500).json({ error: entry.error || 'Analizė nepavyko. Prašome bandyti dar kartą arba susisiekti: info@delnaskaitymas.lt' });
        } else {
          console.log(`[analyze-palm] sessionId=${sessionId} -> statusas tapo '${entry&&entry.status}', triname cache`);
          // įrašas dingo (nenumatyta situacija) — cache nebenaudingas
          analysisCache.delete(sessionId);
        }
      } else {
        // status === 'error' — fono analizė JAU KARTĄ NEPAVYKO (pvz. AI
        // atsakymo JSON nebuvo įmanoma apdoroti). SVARBU: ČIA ANKSČIAU
        // ištrindavome cache ir PALEISDAVOME VISIŠKAI NAUJĄ, MOKAMĄ AI
        // analizę nuo nulio — o kadangi klientas bando kas ~3s iki 20
        // kartų, TAI REIŠKĖ IKI 20 PAKARTOTINIŲ BRANGIŲ AI KVIETIMŲ vienai
        // nepavykusiai nuotraukų porai, jei klaida buvo nuosekli (ne
        // atsitiktinė). Dabar VIETOJ TO iškart grąžiname jau žinomą
        // klaidą klientui — jokio naujo AI kvietimo, jokio kartojimo.
        console.log(`[analyze-palm] sessionId=${sessionId} -> fono analizė ANKSČIAU NEPAVYKO (${cached.error}), grąžinam klaidą IŠKART (be pakartotinio AI kvietimo)`);
        analysisCache.delete(sessionId);
        return res.status(500).json({ error: cached.error || 'Analizė nepavyko. Prašome bandyti dar kartą arba susisiekti: info@delnaskaitymas.lt' });
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
    if (userName) result.userName = userName;

    // Priminimas užregistruojamas tik kai vartotojas pats paspaudžia mygtuką (/schedule-reminder)
    // PASTABA: pilnas rezultatų el. laiškas klientui ČIA NEBESIUNČIAMAS —
    // dabar jis siunčiamas PDF formatu iš /email-result-pdf endpoint'o,
    // kurį klientas iškviečia TIKSLIAI TADA, kai atsidaro rezultato ekranas
    // (žr. /email-result-pdf žemiau).

    res.json(result);

  } catch (err) {
    console.error('Klaida /analyze-palm:', err);
    if (err.message.startsWith('NEDELNAS')) return res.json({ error: err.message });
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
    // kaina visada sutaptų su Product catalog įrašu (speciali_kaina, 9,99 €).
    const activePrice = await stripe.prices.retrieve(ACTIVE_PRICE_ID);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: activePrice.unit_amount,
      currency: activePrice.currency,
      metadata: { name: name || '', email: email || '', priceId: ACTIVE_PRICE_ID },
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
      const token = createToken(finalName, finalEmail);
      sendPaymentSuccessEmails(orderNumber, finalName, finalEmail);
      res.json({ paid: true, token, name: finalName, email: finalEmail });
    } else {
      res.json({ paid: false, status: pi.status });
    }
  } catch (err) {
    res.status(500).json({ paid: false, error: err.message });
  }
});

app.get('/verify-payment', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    if (session.payment_status === 'paid') {
      const finalName = session.metadata?.name || '';
      const finalEmail = session.metadata?.email || '';
      // Pirmenybė Stripe metadata (patikimas šaltinis) — atsarginis
      // variantas req.query, jei metadata dėl kokios nors priežasties tuščia.
      const finalBgSessionId = session.metadata?.bgSessionId || req.query.bgSessionId || '';
      const finalOrderNumber = session.metadata?.orderNumber || req.query.orderNumber || '';
      const token = createToken(finalName, finalEmail);
      sendPaymentSuccessEmails(finalOrderNumber, finalName, finalEmail);
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
    const resubButton = `<button id="resub-btn" onclick="reSubscribe()" style="width:100%;background:transparent;border:.5px solid rgba(212,168,67,.35);border-radius:10px;padding:15px;color:#f0c96a;font-size:15px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;letter-spacing:.04em;margin-top:22px">✦ Primink man</button><div id="resub-msg" style="margin-top:12px;font-size:13px;color:rgba(232,226,212,.6);min-height:18px"></div><script>function reSubscribe(){var btn=document.getElementById('resub-btn'),msg=document.getElementById('resub-msg');btn.disabled=true;btn.style.opacity='.6';fetch('/schedule-reminder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${resubEmail}'})}).then(function(r){return r.json();}).then(function(){btn.textContent='✓ Vėl užregistruota';msg.textContent='Priminimą gausi po 3 mėnesių.';}).catch(function(){msg.textContent='Nepavyko. Pabandyk dar kartą.';btn.disabled=false;btn.style.opacity='1';});}</script>`;
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
      isPromoActive: ACTIVE_PRICE_ID === STRIPE_PRICE_ID_PROMO
    };
    _priceInfoCacheAt = Date.now();
    res.json(_priceInfoCache);
  } catch (err) {
    console.error('/price-info klaida:', err);
    // Atsarginis variantas, jei Stripe API laikinai nepasiekiamas —
    // rodomos dabartinės žinomos vertės, kad kainodaros blokas neliktų tuščias.
    res.json({ promo: { amount: 999, currency: 'eur' }, regular: { amount: 1599, currency: 'eur' }, active: { amount: 1599, currency: 'eur' }, isPromoActive: false });
  }
});

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
    if (reminders.find(r => (r.email || '').toLowerCase() === email)) return res.json({ ok: true, message: 'Jau užregistruota' });
    reminders.push({ email, name: name || '', sendAt: Date.now() + (90 * 24 * 60 * 60 * 1000), createdAt: Date.now() });
    saveReminders(reminders);
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
      from: `"Delno Skaitymas" <${CLIENT_EMAIL_FROM}>`,
      to: email,
      subject: `${name ? escapeHtml(name) + ', l' : 'L'}aikas naujam delnų skaitymui ✦ [PERŽIŪRA]`,
      html: `<div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:24px"><div style="font-size:28px;margin-bottom:8px;color:#d4a843">✦</div><div style="font-size:22px;font-weight:700;color:#d4a843;margin-bottom:8px">${name ? escapeHtml(name) + ', atėjo laikas' : 'Atėjo laikas'}</div><div style="font-size:14px;color:rgba(245,238,216,.6)">Praėjo 3 mėnesiai nuo tavo delnų analizės</div></div><div style="background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.2);border-radius:12px;padding:20px;margin-bottom:24px;font-size:14px;line-height:1.8;color:rgba(245,238,216,.85)">Delnų linijos keičiasi kartu su tavimi. Per 3 mėnesius tavo gyvenimas pasikeitė — o su juo ir tai, ką pasakoja tavo delnai.</div><div style="text-align:center;margin-bottom:20px"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}" style="background:linear-gradient(125deg,#fff0c4 0%,#f5d061 22%,#e0a930 45%,#c98a1f 68%,#8a5a0f 100%);color:#000000;text-decoration:none;padding:14px 32px;border-radius:14px;font-weight:700;font-size:14px;letter-spacing:.08em;text-transform:uppercase;display:inline-block;box-shadow:0 4px 20px rgba(212,168,67,.4)">Atnaujinti žemėlapį →</a></div><div style="text-align:center;padding-top:16px;border-top:1px solid rgba(212,168,67,.15)"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}/unsubscribe-reminder?email=${encodeURIComponent(email)}" style="color:rgba(245,238,216,.4);text-decoration:underline;font-size:11px">Nebenoriu gauti šių priminimų</a></div></div>`
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
