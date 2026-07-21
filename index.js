// v25 — švariai perrašyta
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
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

// --- Priminimų saugykla ---
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');

function loadReminders() {
  try {
    if (fs.existsSync(REMINDERS_FILE)) return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function saveReminders(reminders) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2)); } catch(e) {}
}

setInterval(async () => {
  const reminders = loadReminders();
  const now = Date.now();
  const remaining = [];
  for (const r of reminders) {
    if (now >= r.sendAt) {
      try {
        await mailer.sendMail({
          from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
          to: r.email,
          subject: `${r.name ? r.name + ', l' : 'L'}aikas naujam delnų skaitymui ✦`,
          html: `<div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px 24px;max-width:480px;margin:0 auto"><div style="text-align:center;margin-bottom:24px"><div style="font-size:28px;margin-bottom:8px">✦</div><div style="font-size:22px;font-weight:700;color:#d4a843;margin-bottom:8px">${r.name ? r.name + ', atėjo laikas' : 'Atėjo laikas'}</div><div style="font-size:14px;color:rgba(245,238,216,.6)">Praėjo 3 mėnesiai nuo Jūsų delnų analizės</div></div><div style="background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.2);border-radius:12px;padding:20px;margin-bottom:24px;font-size:14px;line-height:1.8;color:rgba(245,238,216,.85)">Delno linijos keičiasi kartu su Jumis. Per 3 mėnesius Jūsų gyvenimas pasikeitė — o su juo ir tai, ką pasakoja Jūsų delnas.</div><div style="text-align:center"><a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}" style="background:linear-gradient(135deg,#f0c96a,#d4a843);color:#07040f;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:14px;letter-spacing:.06em;display:inline-block">ATLIKTI NAUJĄ ANALIZĘ →</a></div></div>`
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

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS }
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

// Bando JSON.parse() įprastai; jei nepavyksta — bando pataisytą versiją.
// Jei ir tai nepavyksta, meta ORIGINALIĄ klaidą (informatyvesnė log'ams).
function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch (originalErr) {
    try {
      return JSON.parse(repairJsonString(text));
    } catch (repairErr) {
      console.error('[parseJsonLenient] taisymas irgi nepavyko:', repairErr.message);
      throw originalErr;
    }
  }
}

// --- Pagrindinė Claude analizės funkcija ---
async function runPalmAnalysis(photos, name) {

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
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
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
    if (step2Data?.error?.type === 'overloaded_error') {
      console.log(`Žingsnis 2 perkrautas, bandymas ${attempt}/3...`);
      if (attempt < 3) await new Promise(res => setTimeout(res, 3000 * attempt));
      continue;
    }
    break;
  }

  if (!step2Data.content || step2Data.content.length === 0) throw new Error('Tuščias Claude atsakymas');
  if (step2Data.stop_reason === 'max_tokens') throw new Error('Atsakymas nukirptas');

  const rawText = '{' + step2Data.content.map(b => b.text || '').join('');
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON nerastas');

  const result = parseJsonLenient(jsonMatch[0]);
  if (!result || !result.prigimtines_stiprybes) throw new Error('Netinkamas rezultatas');

  return result;
}

// --- ENDPOINT: Greita delno validacija ---
app.post('/validate-palm', async (req, res) => {
  try {
    const { photos, livePreview } = req.body;
    if (!photos || photos.length === 0) return res.json({ valid: false });
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
      minPalmPercent: 85         // bent 85% delno paviršiaus turi būti kadre
    };

    const promptText = `Analyze this hand photo carefully and objectively. Do not decide pass/fail — just report what you observe as measurements.

Reply with ONLY this JSON object, no other text, no markdown formatting:
{"fingers_visible": <integer 0-5>, "palm_percent_visible": <integer 0-100>, "orientation": "palm" | "back" | "side", "fingertips_cropped": true | false, "hand_present": true | false}

Field definitions:
- fingers_visible: how many of the 5 fingers (including thumb) can be clearly identified and counted, even if close together or at a natural angle. A finger counts as visible even if the thumb sits close to the palm.
- palm_percent_visible: your best estimate of what percentage of the total palm surface area is actually shown in the frame (0 = none visible, 100 = entire palm visible). If only half the palm is in frame (rest cropped out or out of shot), this should be around 50 or less.
- orientation: "palm" if the palm (not back of hand) is facing the camera and reasonably flat to it; "side" if the hand is rotated showing mostly its edge; "back" if the back of the hand faces the camera.
- fingertips_cropped: true only if a fingertip is genuinely cut off by the frame edge (not just close to it).
- hand_present: false if no hand is visible at all in the image.

Be precise and objective with the percentages — do not round everything to convenient numbers like 50 or 100.`;

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

    let valid = true;
    let reason = null;

    if (facts.hand_present === false) {
      valid = false; reason = 'no_hand';
    } else if (facts.orientation === 'back') {
      valid = false; reason = 'no_hand';
    } else if (facts.orientation === 'side') {
      valid = false; reason = 'sideways';
    } else if ((facts.fingers_visible ?? 0) < PALM_VALIDATION_THRESHOLDS.minFingersVisible || facts.fingertips_cropped === true) {
      valid = false; reason = 'fingers_missing';
    } else if ((facts.palm_percent_visible ?? 0) < PALM_VALIDATION_THRESHOLDS.minPalmPercent) {
      valid = false; reason = 'low_palm_visibility';
    } else if ((facts.palm_percent_visible ?? 0) >= 95 && (facts.fingers_visible ?? 0) === 5) {
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
app.post('/start-analysis', async (req, res) => {
  try {
    const { photos, sessionId } = req.body;
    console.log(`[start-analysis] gauta sessionId=${sessionId||'(nėra)'} photos=${photos?photos.length:0}`);
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });
    if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });

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

    runPalmAnalysis(photos, req.body.name || '')
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
app.post('/create-checkout', async (req, res) => {
  try {
    const { email, name, amount, currency } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['revolut_pay'],
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: { name: 'Gyvenimo žemėlapis — Delnų analizė' },
          unit_amount: amount || 999
        },
        quantity: 1
      }],
      mode: 'payment',
      locale: 'lt',
      customer_email: email,
      metadata: { name: name || '', email },
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
app.post('/update-session-name', (req, res) => {
  const { sessionId, name, email } = req.body;
  if (sessionId && analysisCache.has(sessionId)) {
    const entry = analysisCache.get(sessionId);
    entry.name = name || entry.name;
    entry.email = email || entry.email;
  }
  res.json({ ok: true });
});

app.post('/analyze-palm', async (req, res) => {
  try {
    const { photos, name, email, token, sessionId } = req.body;

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
        } else {
          console.log(`[analyze-palm] sessionId=${sessionId} -> statusas tapo '${entry&&entry.status}', triname cache`);
          // status === 'error' arba įrašas dingo — cache nebenaudingas
          analysisCache.delete(sessionId);
        }
      } else {
        console.log(`[analyze-palm] sessionId=${sessionId} -> netikėtas statusas '${cached.status}', triname cache`);
        analysisCache.delete(sessionId);
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

    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
      to: tokenEntry.email,
      subject: `${userName ? userName + ' — ' : ''}Tavo gyvenimo žemėlapis ✦`,
      html: buildEmailHtml(userName, result)
    }).catch(e => console.error('Laiško klaida:', e.message));

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

app.post('/create-payment', async (req, res) => {
  try {
    const { name, email } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 999,
      currency: 'eur',
      metadata: { name: name || '', email: email || '' },
      ...(email ? {receipt_email: email} : {}),
      payment_method_types: ['card', 'revolut_pay']
    });
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, sessionId: paymentIntent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/verify-payment-intent', async (req, res) => {
  try {
    const { paymentIntentId, name, email } = req.body;
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status === 'succeeded') {
      const token = createToken(name || pi.metadata.name || '', email || pi.metadata.email || '');
      res.json({ paid: true, token, name: name || pi.metadata.name || '', email: email || pi.metadata.email || '' });
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
      const token = createToken(session.metadata?.name || '', session.metadata?.email || '');
      res.json({ paid: true, name: session.metadata?.name || '', email: session.metadata?.email || '', token });
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

app.post('/schedule-reminder', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Neteisingas el. paštas' });
    const reminders = loadReminders();
    if (reminders.find(r => r.email === email)) return res.json({ ok: true, message: 'Jau užregistruota' });
    reminders.push({ email, name: name || '', sendAt: Date.now() + (90 * 24 * 60 * 60 * 1000), createdAt: Date.now() });
    saveReminders(reminders);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Dalinimosi rezultatai (saugomi faile) ---
const SHARED_FILE = path.join(__dirname, 'shared_results.json');

function loadShared() {
  try {
    if (fs.existsSync(SHARED_FILE)) return JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveShared(data) {
  try { fs.writeFileSync(SHARED_FILE, JSON.stringify(data)); } catch(e) {}
}

// Valyti pasibaigusius (po 7 dienų)
setInterval(() => {
  const data = loadShared();
  const now = Date.now();
  let changed = false;
  for (const id in data) {
    if (now - data[id].createdAt > 7 * 24 * 60 * 60 * 1000) { delete data[id]; changed = true; }
  }
  if (changed) saveShared(data);
}, 60 * 60 * 1000);

// Išsaugoti analizę
app.post('/share-result', (req, res) => {
  try {
    const { result } = req.body;
    if (!result || !result.prigimtines_stiprybes) return res.status(400).json({ error: 'Nėra rezultato' });
    const id = crypto.randomBytes(8).toString('hex');
    const data = loadShared();
    data[id] = { result, createdAt: Date.now() };
    saveShared(data);
    const host = req.headers.host || process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app';
    res.json({ id, url: `https://${host}/shared/${id}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Gauti dalinimosi rezultatą
app.get('/shared-result/:id', (req, res) => {
  const data = loadShared();
  const entry = data[req.params.id];
  if (!entry) return res.status(404).json({ error: 'Rezultatas nerastas' });
  res.json(entry.result);
});

// Shared puslapis
app.get('/shared/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DELNAS v25 veikia: http://localhost:${PORT}`));
