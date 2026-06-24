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
app.use(express.static(path.join(__dirname, '.')));
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

// --- Pagrindinė Claude analizės funkcija ---
async function runPalmAnalysis(photos, name) {

  const imageBlocks = photos.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data }
  }));

  // Validacija
  const validationResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 20,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: 'Look at this image. Is this a photo of an open human PALM (the inner side of a hand, with fingers spread)? Answer YES only if it is clearly a palm facing the camera. Answer NO if it is: a face, head, fingertips only, the back of a hand, a body part other than palm, a table, or any object. Answer only YES or NO.'
          }
        ]
      }]
    })
  });

  const validationData = await validationResponse.json();
  const validationText = (validationData.content?.[0]?.text || '').trim().toUpperCase();

  if (!validationText.startsWith('YES')) {
    throw new Error('NEDELNAS: Nuotraukoje nematome delno. Prašome nufotografuoti atvirą delną.');
  }

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
    if (jsonMatch) bruozai = JSON.parse(jsonMatch[0]).bruozai || [];
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

${bruozaiText}Remdamasis tuo ką MATAI šiuose delnuose, parašyk tikslią ir naudingą chiromantijos analizę lietuvių kalba. Kiekvienas tavo teiginys turi būti pagrįstas tuo, ką matai — ne bendromis frazėmis.

TAISYKLĖS:
- Kiekvienas sakinys = konkretus faktas apie ŠĮ žmogų paremtas delno analize
- Rašyk tiesiai ir drąsiai: "Tu esi...", "Tu linkęs...", "Tau sekasi...", "Tu vengi...", "Tau sunku..."
- DRAUDŽIAMA: "gali būti", "tikėtina", "galima manyti", "energija", "vibracija"
- DRAUDŽIAMA: minėti linijų pavadinimus ar delno anatomiją
- DRAUDŽIAMA: abstrakčios frazės kurios tiktų bet kuriam žmogui
- Kalba: paprasta, kasdienė, lietuvių, kreipkis "tu"
- Kiekvienas skyrius: 6–8 sakiniai, skyriai nesikartoja tarpusavyje

SKYRIAI — kiekvienas kalba tik apie savo temą:
- prigimtines_stiprybes: kokie šio žmogaus stipriausi prigimtiniai charakterio bruožai ir kaip jie pasireiškia kasdieniame gyvenime
- gyvenimo_tikslas: TEMOS ESMĖ — gyvenimo KRYPTIS ir TIKSLAI. Ką šis žmogus nori pasiekti gyvenime? Kokia jo gyvenimo misija? Kur jis juda? Ko siekia? Kas jam svarbiausia gyvenime — ne darbe, bet gyvenime apskritai. Rašyk apie jo vidinę kryptį, svajonę, tikslą
- santykiai: kaip šis žmogus myli ir bendrauja — ko ieško ryšiuose, kaip elgiasi su artimaisiais, kas jam sunku santykiuose
- finansai: TEMOS ESMĖ — FINANSINIS POTENCIALAS. Kiek šis žmogus gali uždirbti? Kokioje srityje jo finansinė sėkmė didžiausia? Ar jo potencialas didelis ar vidutinis? Kaip jis gali jį realizuoti? Rašyk apie galimybes ir potencialą — ne apie tai kaip jis elgiasi su pinigais
- galimybes: kokia konkreti savybė ar gebėjimas išskiria jį iš kitų — tai jo didžiausias pranašumas
- pokyciai: kokie reikšmingi gyvenimo pokyčiai artėja arba jau vyksta
- klutys: kas konkrečiai stabdo šį žmogų — koks jo pagrindinis vidinių barjeras
- stiprybes_sarasas: 5 savybių pavadinimai (2–4 žodžiai, konkretūs ir prasmingi)
- Kiekvienam skyriui "_insights": 3 trumpi sakiniai (max 8 žodžiai) — NAUJI faktai kurie PAPILDO tekstą, tiksliai atitinkantys skyriaus temą, nesikartojantys su tekstu

ATSAKYK TIKTAI JSON. Pradėk nuo {.

{"prigimtines_stiprybes":"6-8 sakiniai","prigimtines_insights":["Faktas 1","Faktas 2","Faktas 3"],"gyvenimo_tikslas":"6-8 sakiniai","gyvenimo_insights":["Faktas 1","Faktas 2","Faktas 3"],"santykiai":"6-8 sakiniai","santykiai_insights":["Faktas 1","Faktas 2","Faktas 3"],"finansai":"6-8 sakiniai","finansai_insights":["Faktas 1","Faktas 2","Faktas 3"],"pokyciai":"6-8 sakiniai","pokyciai_insights":["Faktas 1","Faktas 2","Faktas 3"],"galimybes":"6-8 sakiniai","galimybes_insights":["Faktas 1","Faktas 2","Faktas 3"],"stiprybes_sarasas":["Savybė 1","Savybė 2","Savybė 3","Savybė 4","Savybė 5"],"klutys":"6-8 sakiniai","klutys_insights":["Faktas 1","Faktas 2","Faktas 3"]}`
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
        max_tokens: 5000,
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

  const result = JSON.parse(jsonMatch[0]);
  if (!result || !result.prigimtines_stiprybes) throw new Error('Netinkamas rezultatas');

  return result;
}

// --- ENDPOINT: Greita delno validacija ---
app.post('/validate-palm', async (req, res) => {
  try {
    const { photos } = req.body;
    if (!photos || photos.length === 0) return res.json({ valid: false });

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
        max_tokens: 10,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: 'Look at this image. Is this a photo of an open human PALM (the inner side of a hand, with fingers spread)? Answer YES only if it is clearly a palm facing the camera. Answer NO if it is: a face, head, fingertips only, the back of a hand, a body part other than palm, a table, or any object. Answer only YES or NO.' }
          ]
        }]
      })
    });

    const data = await response.json();
    const answer = (data.content?.[0]?.text || '').trim().toUpperCase();
    res.json({ valid: answer.startsWith('YES') });
  } catch(e) {
    console.error('validate-palm klaida:', e.message);
    res.json({ valid: false });
  }
});

// --- ENDPOINT: Paleisti foninę analizę ---
app.post('/start-analysis', async (req, res) => {
  try {
    const { photos, sessionId } = req.body;
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });
    if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });

    if (analysisCache.has(sessionId)) return res.json({ started: true, sessionId });

    analysisCache.set(sessionId, {
      status: 'pending',
      result: null,
      error: null,
      photos,
      name: req.body.name || '',
      createdAt: Date.now()
    });

    res.json({ started: true, sessionId });

    runPalmAnalysis(photos, req.body.name || '')
      .then(result => {
        const entry = analysisCache.get(sessionId);
        if (entry) { entry.status = 'done'; entry.result = result; }
      })
      .catch(err => {
        const entry = analysisCache.get(sessionId);
        if (entry) { entry.status = 'error'; entry.error = err.message; }
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
    const { email, name, method, amount, currency } = req.body;
    
    const paymentMethodTypes = method === 'klarna' ? ['klarna'] : 
                               method === 'revolut' ? ['revolut_pay'] : ['card'];
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: paymentMethodTypes,
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: { name: 'Gyvenimo žemėlapis — Delnų analizė' },
          unit_amount: amount || 599
        },
        quantity: 1
      }],
      mode: 'payment',
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

app.post('/analyze-palm', async (req, res) => {
  try {
    const { photos, name, token, sessionId } = req.body;

    const tokenEntry = validTokens.get(token);
    if (!tokenEntry) return res.status(403).json({ error: 'Mokėjimas nepatvirtintas.' });
    // Leisti pakartotinį kvietimą jei yra sessionId cache arba photos
    if (tokenEntry.used && !sessionId && (!photos || photos.length === 0)) {
      return res.status(403).json({ error: 'Skaitymas jau atliktas.' });
    }

    const userName = name || tokenEntry.name || '';
    let result = null;

    if (sessionId && analysisCache.has(sessionId)) {
      const cached = analysisCache.get(sessionId);
      if (cached.status === 'done' && cached.result) {
        result = cached.result;
        analysisCache.delete(sessionId);
      } else if (cached.status === 'pending') {
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
        }
        analysisCache.delete(sessionId);
      } else {
        analysisCache.delete(sessionId);
      }
    }

    if (!result) {
      if (!photos || photos.length === 0) {
        return res.status(400).json({ error: 'Analizė dar nebaigta. Bandykite dar kartą.' });
      }
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
    if (!email) return res.status(400).json({ error: 'Trūksta el. pašto' });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 599,
      currency: 'eur',
      metadata: { name: name || '', email },
      receipt_email: email,
      automatic_payment_methods: { enabled: true }
    });
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
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
