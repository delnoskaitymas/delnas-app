// v24 — foninė analizė prieš mokėjimą
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

// Kasdieninis tikrinimas — kas valandą
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
          html: `
            <div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px 24px;max-width:480px;margin:0 auto">
              <div style="text-align:center;margin-bottom:24px">
                <div style="font-size:28px;margin-bottom:8px">✦</div>
                <div style="font-size:22px;font-weight:700;color:#d4a843;margin-bottom:8px">
                  ${r.name ? r.name + ', atėjo laikas' : 'Atėjo laikas'}
                </div>
                <div style="font-size:14px;color:rgba(245,238,216,.6)">Praėjo 3 mėnesiai nuo Jūsų delnų analizės</div>
              </div>
              <div style="background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.2);border-radius:12px;padding:20px;margin-bottom:24px;font-size:14px;line-height:1.8;color:rgba(245,238,216,.85)">
                Delno linijos keičiasi kartu su Jumis. Per 3 mėnesius Jūsų gyvenimas pasikeitė — o su juo ir tai, ką pasakoja Jūsų delnas. Nauja analizė atskleis naujus atsakymus.
              </div>
              <div style="text-align:center">
                <a href="https://${process.env.APP_DOMAIN || 'delnas-app-production.up.railway.app'}" 
                   style="background:linear-gradient(135deg,#f0c96a,#d4a843);color:#07040f;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:14px;letter-spacing:.06em;display:inline-block">
                  ATLIKTI NAUJĄ ANALIZĘ →
                </a>
              </div>
            </div>
          `
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

// --- Token sistema (po mokėjimo) ---
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

// --- Pagrindinė Claude analizės funkcija (dviejų žingsnių) ---
async function runPalmAnalysis(photos, name) {

  // Paruošiame nuotraukų bloką (naudojamas abiejuose žingsniuose)
  const imageBlocks = photos.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data }
  }));

  // ── VALIDACIJA: Ar nuotraukoje yra delnas? ──
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
            text: 'Is there a human hand or palm visible in this image? Answer YES if a hand is clearly present. Answer NO only if there is definitively no human hand. Answer only YES or NO.'
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

  // ── ŽINGSNIS 1: Profesionali vizualinė delno diagnostika ──
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

  // Ištraukiame bruožus iš 1 žingsnio
  let bruozai = [];
  try {
    const step1Text = step1Data.content.map(b => b.text || '').join('');
    const jsonMatch = step1Text.match(/\{[\s\S]*\}/);
    if (jsonMatch) bruozai = JSON.parse(jsonMatch[0]).bruozai || [];
  } catch(e) {
    console.warn('Žingsnis 1 JSON klaida, tęsiame be bruožų:', e.message);
  }

  console.log('Žingsnis 1 bruožai:', bruozai);

  // ── ŽINGSNIS 2: Analizė remiantis vizualiais bruožais ──
  const bruozaiText = bruozai.length > 0
    ? `Vizualiniai delno parametrai, kuriuos matai nuotraukose:\n${bruozai.map((b, i) => `${i+1}. ${b}`).join('\n')}\n\n`
    : '';

  const step2Content = [
    ...imageBlocks,
    {
      type: 'text',
      text: `Tu esi chiromantijos meistras su giliu šios mokslo srities išmanymu.${name ? ' Prieš tave — ' + name + ' delnai.' : ''}

${bruozaiText ? 'Vizualinė diagnostika:\n' + bruozaiText + '\n' : ''}

Parašyk profesionalią chiromantijos analizę lietuvių kalba pagal šias temas. Kalbėk tiesiai apie žmogų — jo charakterį, prigimtį, gyvenimo kelią, santykius, finansinį potencialą. Kiekvienas sakinys turi atskleisti kažką svarbaus ir tikslaus apie šį konkretų žmogų.

TAISYKLĖS:
- DRAUDŽIAMA minėti linijų pavadinimus, delno formą, pirštų ilgį ar bet kokias anatomines savybes
- DRAUDŽIAMA: "gali būti", "tikėtina", "galima manyti"
- DRAUDŽIAMA: laiko nuorodos su skaičiais
- Rašyk: "Tu esi...", "Tavo prigimtis...", "Tu linkęs...", "Tavo stiprybė..."
- Kiekvienas skyrius: 6–8 sakiniai, skyriai nesikartoja
- Kalba: lietuvių, kreipkis "tu"

SKYRIAI:
- prigimtines_stiprybes: kokie šio žmogaus prigimtiniai charakterio bruožai, įgimti talentai ir vidinė jėga
- gyvenimo_tikslas: kur šis žmogus realizuojasi pilniausiai, kokia jo gyvenimo kryptis ir misija
- santykiai: kaip šis žmogus myli ir bendrauja, ko ieško ryšiuose, kokios jo stiprybės ir silpnybės santykiuose
- finansai: koks šio žmogaus santykis su pinigais ir materialiniu pasauliu, koks finansinis potencialas
- galimybes: kokia unikali savybė išskiria jį iš kitų, kur slypi jo didžiausias pranašumas
- pokyciai: kokie vidiniai pokyčiai ir augimas artėja šio žmogaus gyvenime
- klutys: kokie vidiniai barjerai ir įpročiai stabdo šį žmogų nuo pilno potencialo realizavimo
- stiprybes_sarasas: 5 savybių pavadinimai (2–4 žodžiai, konkretūs ir prasmingi)

ATSAKYK TIKTAI JSON. Pradėk nuo {. Jokio teksto prieš ar po.

{"prigimtines_stiprybes":"6-8 sakiniai","gyvenimo_tikslas":"6-8 sakiniai","santykiai":"6-8 sakiniai","finansai":"6-8 sakiniai","pokyciai":"6-8 sakiniai","galimybes":"6-8 sakiniai","stiprybes_sarasas":["Savybė 1","Savybė 2","Savybė 3","Savybė 4","Savybė 5"],"klutys":"6-8 sakiniai"}`
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

// --- ENDPOINT: Greita delno validacija (prieš mokėjimą) ---
app.post('/validate-palm', async (req, res) => {
  try {
    const { photos } = req.body;
    if (!photos || photos.length === 0) return res.json({ valid: false, error: 'Nėra nuotraukų' });

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
            { type: 'text', text: 'Is there a human hand or palm visible in this image? Even if partially visible or at an angle, answer YES if it is clearly a human hand. Answer NO only if there is no hand at all. Answer only YES or NO.' }
          ]
        }]
      })
    });

    const data = await response.json();
    const answer = (data.content?.[0]?.text || '').trim().toUpperCase();
    const valid = answer.startsWith('YES');
    res.json({ valid });
  } catch(e) {
    console.error('validate-palm klaida:', e.message);
    res.json({ valid: true }); // Klaidos atveju leidžiame tęsti
  }
});

// --- ENDPOINT: Paleisti foninę analizę ---
app.post('/start-analysis', async (req, res) => {
  try {
    const { photos, sessionId } = req.body;
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });
    if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });

    if (analysisCache.has(sessionId)) {
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

    res.json({ started: true, sessionId });

    runPalmAnalysis(photos, req.body.name || '')
      .then(result => {
        const entry = analysisCache.get(sessionId);
        if (entry) {
          entry.status = 'done';
          entry.result = result;
          console.log('Foninė analizė baigta:', sessionId);
        }
      })
      .catch(err => {
        const entry = analysisCache.get(sessionId);
        if (entry) {
          entry.status = 'error';
          entry.error = err.message;
          console.error('Foninė analizė klaida:', err.message);
        }
      });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT: Patikrinti analizės statusą ---
app.get('/analysis-status', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });

  const entry = analysisCache.get(sessionId);
  if (!entry) return res.json({ status: 'notfound' });

  res.json({ status: entry.status });
});

// --- ENDPOINT: Gauti analizės rezultatą ---
app.post('/analyze-palm', async (req, res) => {
  try {
    const { photos, name, token, sessionId } = req.body;

    const tokenEntry = validTokens.get(token);
    if (!tokenEntry) {
      return res.status(403).json({ error: 'Mokėjimas nepatvirtintas. Norėdami skaitymo — sumokėkite.' });
    }
    if (tokenEntry.used) {
      return res.status(403).json({ error: 'Skaitymas jau atliktas. Norėdami naujo — sumokėkite dar kartą.' });
    }

    const userName = name || tokenEntry.name || '';

    let result = null;
    if (sessionId && analysisCache.has(sessionId)) {
      const cached = analysisCache.get(sessionId);
      if (cached.status === 'done' && cached.result) {
        result = cached.result;
        console.log('Cache done, grąžinama iš karto:', sessionId);
        analysisCache.delete(sessionId);
      } else if (cached.status === 'pending') {
        console.log('Cache pending, laukiame max 8s:', sessionId);
        await new Promise((resolve) => {
          let waited = 0;
          const iv = setInterval(() => {
            waited += 1;
            const entry = analysisCache.get(sessionId);
            if (!entry || entry.status !== 'pending' || waited >= 8) {
              clearInterval(iv);
              resolve();
            }
          }, 1000);
        });
        const entry = analysisCache.get(sessionId);
        if (entry && entry.status === 'done' && entry.result) {
          result = entry.result;
          analysisCache.delete(sessionId);
        } else {
          analysisCache.delete(sessionId);
        }
      } else {
        analysisCache.delete(sessionId);
      }
    }

    if (!result) {
      if (!photos || photos.length === 0) {
        if (sessionId) {
          console.log('Nuotraukos tuščios, laukiame cache papildomai 5s...');
          await new Promise(r => setTimeout(r, 5000));
          const lateEntry = analysisCache.get(sessionId);
          if (lateEntry && lateEntry.status === 'done' && lateEntry.result) {
            result = lateEntry.result;
            analysisCache.delete(sessionId);
          }
        }
        if (!result) {
          return res.status(400).json({ error: 'Analizė dar nebaigta. Prašome palaukti ir bandyti dar kartą.' });
        }
      } else {
        console.log('Cache nerastas, paleidžiame naują analizę:', sessionId);
        result = await runPalmAnalysis(photos, userName);
      }
    }

    tokenEntry.used = true;
    console.log('Analizė sėkminga:', userName);

    if (userName) {
      result.userName = userName;
    }

    const reminders = loadReminders();
    const alreadyRegistered = reminders.find(r => r.email === tokenEntry.email);
    if (!alreadyRegistered) {
      reminders.push({
        email: tokenEntry.email,
        name: userName || '',
        sendAt: Date.now() + (90 * 24 * 60 * 60 * 1000),
        createdAt: Date.now()
      });
      saveReminders(reminders);
      console.log(`Priminimas automatiškai užregistruotas: ${tokenEntry.email}`);
    }

    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
      to: tokenEntry.email,
      subject: `${userName ? userName + ' — ' : ''}Tavo delno skaitymas ✦`,
      html: buildEmailHtml(userName, result)
    }).catch(mailErr => console.error('Laiško klaida (nesvarbi):', mailErr.message));

    res.json(result);

  } catch (err) {
    console.error('Klaida /analyze-palm:', err);
    if (err.message.startsWith('NEDELNAS')) {
      return res.json({ error: err.message }); // 200 su klaida — tokenas lieka galioti
    }
    res.status(500).json({ error: err.message });
  }
});

function buildEmailHtml(userName, result) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#07040f;font-family:Georgia,serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;margin-bottom:12px">✦</div><h1 style="color:#d4a843;font-size:24px;margin:0 0 6px">${userName ? userName + ' —' : ''} Tavo Delno Skaitymas</h1><p style="color:rgba(245,238,216,0.5);font-size:13px;margin:0;font-style:italic">Delno planetų kalnai · Chiromantija · Sielos žemėlapis</p></div>
  ${section('Prigimtinės stiprybės ir unikalūs charakterio bruožai', result.prigimtines_stiprybes)}
  ${section('Gyvenimo tikslo ir asmeninio pašaukimo kryptis', result.gyvenimo_tikslas)}
  ${section('Asmeninio gyvenimo ir santykių dėsningumų analizė', result.santykiai)}
  ${section('Finansinės laisvės bei materialinės sėkmės prognozė', result.finansai)}
  ${section('Paslėpti gebėjimai ir potencialo išnaudojimo būdai', result.galimybes)}
  ${pills(result.stiprybes_sarasas)}
  ${section('Svarbiausi ateinančių metų gyvenimo pokyčiai', result.pokyciai)}
  ${section('Kliūtys, stabdančios asmeninę pažangą ir sėkmę', result.klutys)}
  <div style="text-align:center;padding-top:24px;border-top:0.5px solid rgba(212,168,67,0.15)"><p style="color:rgba(245,238,216,0.35);font-size:12px;line-height:1.7;margin:0;font-style:italic">Šis skaitymas sukurtas tik tau ✦<br>Išsaugok jį — galėsi grįžti ir perskaityti dar kartą</p></div></div></body></html>`;
}

function section(title, text) {
  return `<div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">${title}</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${text || ''}</p></div>`;
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

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.post('/schedule-reminder', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Neteisingas el. paštas' });

    const reminders = loadReminders();
    const exists = reminders.find(r => r.email === email);
    if (exists) return res.json({ ok: true, message: 'Jau užregistruota' });

    const sendAt = Date.now() + (90 * 24 * 60 * 60 * 1000);
    reminders.push({ email, name: name || '', sendAt, createdAt: Date.now() });
    saveReminders(reminders);

    console.log(`Priminimas užregistruotas: ${email}, bus išsiųstas: ${new Date(sendAt).toLocaleDateString('lt-LT')}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Priminimo klaida:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`DELNAS v24 veikia: http://localhost:${PORT}`));
