// v24 — foninė analizė prieš mokėjimą
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));

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

// --- Pagrindinė Claude analizės funkcija ---
async function runPalmAnalysis(photos, name) {
  const content = [];
  for (const p of photos) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data }
    });
  }

  content.push({
    type: 'text',
    text: `Tu esi profesionalus chiromantijos ir žmogaus charakterio analitikas. Pažvelk į šias dvi delno nuotraukas ir pateik tikslią, profesionalią analizę lietuvių kalba.

SVARBU — ANALIZĖS PRINCIPAI:
- Rašyk tik konkrečius faktus ir teiginius apie šį žmogų
- Jokios poezijos, metaforų ar pasakojimų
- Jokio pamokslavimo ar patarimų kaip gyventi
- Trumpi, tiesūs sakiniai — kaip gydytojo diagnozė
- Kiekvienas skyrius kalba TIKTAI apie savo temą — jokio kartojimo
- Kalba: taisyklinga lietuvių kalba, kreipkis "tu"
- DRAUDŽIAMA minėti bet kokias laiko ar amžiaus nuorodas: "artimiausi metai", "artimiausiu metu", "po X metų", "X-Y metų amžiuje", "šiais metais" ir pan. Vietoj to kalbėk apie charakterio savybes ir tendencijas be laiko rėmų.

SKYRIAI — kiekvienas turi savo ATSKIRĄ temą:

prigimtine_galia — unikali prigimtinė galia ir potencialas: kokie unikalūs gebėjimai, stiprybės ir galimybės glūdi šio žmogaus prigimtyje
gyvenimo_pasaukimas — tikrasis gyvenimo pašaukimas ir misija: ko šis žmogus ieško, koks jo tikrasis kelias ir gyvenimo tikslas
santykiai — asmeninio gyvenimo ir santykių dėsningumai: kaip myli, ko ieško partnerijoje, kokie santykių modeliai ir dėsningumai
finansai — finansinės laisvės ir materialinės sėkmės prognozė: finansinė trajektorija, karjeros galimybės, pinigų santykis
stiprybes_dekoduotos — charakterio stiprybių ir sėkmės žymų dekodavimas: kokie charakterio bruožai veda į sėkmę, ką delno linijos atskleidžia
gyvenimo_posukiai — artimiausio gyvenimo etapo posūkiai ir galimybės: kokie pokyčiai, galimybės ir svarbūs momentai laukia artimiausiu metu
klutys — tikrosios priežastys ir kliūtys, stabdančios progresą: kas iki šiol stabdė, kokie vidiniai ar išoriniai barjerai

KIEKVIENAS skyrius: 5-6 trumpi, konkretūs sakiniai. Tik faktai. Be įžangų ir išvadų.

ATSAKYK TIKTAI JSON. Pradėk nuo {. Jokio teksto prieš ar po.

{"prigimtine_galia":"5-6 sakiniai","gyvenimo_pasaukimas":"5-6 sakiniai","santykiai":"5-6 sakiniai","finansai":"5-6 sakiniai","stiprybes_dekoduotos":"5-6 sakiniai","stiprybes_sarasas":["Stiprybė 1","Stiprybė 2","Stiprybė 3","Stiprybė 4","Stiprybė 5"],"gyvenimo_posukiai":"5-6 sakiniai","klutys":"5-6 sakiniai"}`
  });

  let data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 5000,
        messages: [
          { role: 'user', content },
          { role: 'assistant', content: '{' }
        ]
      })
    });
    data = await response.json();

    if (data?.error?.type === 'overloaded_error') {
      console.log(`Overloaded, bandymas ${attempt}/3, laukiam ${attempt * 3} sek...`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
      continue;
    }
    break;
  }

  if (!data.content || data.content.length === 0) throw new Error('Tuščias Claude atsakymas');
  if (data.stop_reason === 'max_tokens') throw new Error('Atsakymas nukirptas');

  const rawText = '{' + data.content.map(b => b.text || '').join('');
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON nerastas');

  const result = JSON.parse(jsonMatch[0]);
  if (!result || !result.prigimtine_galia) throw new Error('Netinkamas rezultatas');

  return result;
}

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

    // Jei cache jau done — grąžiname iš karto
    let result = null;
    if (sessionId && analysisCache.has(sessionId)) {
      const cached = analysisCache.get(sessionId);
      if (cached.status === 'done' && cached.result) {
        result = cached.result;
        console.log('Cache done, grąžinama iš karto:', sessionId);
        analysisCache.delete(sessionId);
      } else if (cached.status === 'pending') {
        // Laukiame max 8s — analizė turėjo baigti per 110s ekraną
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
        // error arba notfound
        analysisCache.delete(sessionId);
      }
    }

    // Jei cache nebuvo arba nepavyko — paleisti naują analizę su nuotraukomis
    if (!result) {
      if (!photos || photos.length === 0) {
        return res.status(400).json({ error: 'Analizė dar nevykdyta. Bandykite dar kartą.' });
      }
      console.log('Cache nerastas, paleidžiame naują analizę:', sessionId);
      result = await runPalmAnalysis(photos, userName);
    }

    tokenEntry.used = true;
    console.log('Analizė sėkminga:', userName);

    if (userName) {
      result.userName = userName;
    }

    // El. laiškas siunčiamas fone — negrąžina klientui laukimo
    mailer.sendMail({
      from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
      to: tokenEntry.email,
      subject: `${userName ? userName + ' — ' : ''}Tavo delno skaitymas ✦`,
      html: buildEmailHtml(userName, result)
    }).catch(mailErr => console.error('Laiško klaida (nesvarbi):', mailErr.message));

    res.json(result);

  } catch (err) {
    console.error('Klaida /analyze-palm:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildEmailHtml(userName, result) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#07040f;font-family:Georgia,serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;margin-bottom:12px">✦</div><h1 style="color:#d4a843;font-size:24px;margin:0 0 6px">${userName ? userName + ' —' : ''} Tavo Delno Skaitymas</h1><p style="color:rgba(245,238,216,0.5);font-size:13px;margin:0;font-style:italic">Delno planetų kalnai · Chiromantija · Sielos žemėlapis</p></div>
  ${section('Atskleista Jūsų unikali prigimtinė galia ir potencialas', result.prigimtine_galia)}
  ${section('Tikrojo Jūsų gyvenimo pašaukimo ir misijos nustatymas', result.gyvenimo_pasaukimas)}
  ${section('Asmeninio gyvenimo ir santykių dėsningumų analizė', result.santykiai)}
  ${section('Finansinės laisvės bei materialinės sėkmės prognozė', result.finansai)}
  ${section('Jūsų charakterio stiprybių ir sėkmės žymų dekodavimas', result.stiprybes_dekoduotos)}
  ${pills(result.stiprybes_sarasas)}
  ${section('Artimiausio gyvenimo etapo posūkių ir galimybių apžvalga', result.gyvenimo_posukiai)}
  ${section('Tikrosios priežastys ir kliūtys, stabdančios Jūsų progresą', result.klutys)}
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
app.listen(PORT, () => console.log(`DELNAS v24 veikia: http://localhost:${PORT}`));
