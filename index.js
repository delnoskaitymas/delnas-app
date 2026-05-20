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
// sessionId -> { status: 'pending'|'done'|'error', result, error, createdAt }
const analysisCache = new Map();

// Valymas kas valandą
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
    text: `Vardas: ${name}. Tu esi profesionalus chiromantijos ir žmogaus charakterio analitikas. Pažvelk į šias dvi delno nuotraukas ir pateik tikslią, profesionalią analizę lietuvių kalba.

SVARBU — ANALIZĖS PRINCIPAI:
- Rašyk tik konkrečius faktus ir teiginius apie šį žmogų
- Jokios poezijos, metaforų ar pasakojimų
- Jokio pamokslavimo ar patarimų kaip gyventi
- Trumpi, tiesūs sakiniai — kaip gydytojo diagnozė
- Kiekvienas skyrius kalba TIKTAI apie savo temą — jokio kartojimo
- Kalba: taisyklinga lietuvių kalba, kreipkis "tu"

SKYRIAI — kiekvienas turi savo ATSKIRĄ temą:

charakteris — tik apie asmenybės bruožus: kaip mąsto, kaip priima sprendimus, kaip elgiasi su kitais
sielos_misija — tik apie tai ko šis žmogus viduje ieško gyvenime ir kas jam suteikia prasmę
finansai — tik apie finansinę sėkmę, karjerą, pinigų santykį ir profesinę trajektoriją
dovanos_tekstas — tik apie talentus ir natūralius gebėjimus
meile_santykiai — tik apie meilę: kaip myli, ko ieško partnerijoje, kokie santykių modeliai
astrologija — tik apie delno planetų kalnus ir ką jie atskleidžia apie temperamentą
issukiai — tik apie didžiausius gyvenimo iššūkius ir kaip juos įveikti

KIEKVIENAS skyrius: 5-6 trumpi, konkretūs sakiniai. Tik faktai. Be įžangų ir išvadų.

ATSAKYK TIKTAI JSON. Pradėk nuo {. Jokio teksto prieš ar po.

{"charakteris":"5-6 sakiniai","sielos_misija":"5-6 sakiniai","finansai":"5-6 sakiniai","dovanos_tekstas":"5-6 sakiniai","dovanos_sarasas":["Dovana 1","Dovana 2","Dovana 3","Dovana 4","Dovana 5"],"meile_santykiai":"5-6 sakiniai","astrologija":"5-6 sakiniai","issukiai":"5-6 sakiniai","stiprybes":["Stiprybė 1","Stiprybė 2","Stiprybė 3","Stiprybė 4","Stiprybė 5"]}`
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
  if (!result || !result.charakteris) throw new Error('Netinkamas rezultatas');

  return result;
}

// --- ENDPOINT: Paleisti foninę analizę (BE token, prieš mokėjimą) ---
app.post('/start-analysis', async (req, res) => {
  try {
    const { photos, sessionId } = req.body;
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });
    if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });

    // Jei jau vyksta arba baigta — grąžiname tą patį
    if (analysisCache.has(sessionId)) {
      return res.json({ started: true, sessionId });
    }

    // Įrašome į cache kaip 'pending'
    analysisCache.set(sessionId, {
      status: 'pending',
      result: null,
      error: null,
      photos,
      name: req.body.name || '',
      createdAt: Date.now()
    });

    // Paleidžiame fone — negrąžiname rezultato čia
    res.json({ started: true, sessionId });

    // Analizė vyksta asinchroniškai
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

// --- ENDPOINT: Patikrinti analizės statusą (po mokėjimo) ---
app.get('/analysis-status', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Nėra sessionId' });

  const entry = analysisCache.get(sessionId);
  if (!entry) return res.json({ status: 'notfound' });

  res.json({ status: entry.status });
});

// --- ENDPOINT: Gauti analizės rezultatą (su token po mokėjimo) ---
app.post('/analyze-palm', async (req, res) => {
  try {
    const { photos, name, token, sessionId } = req.body;

    // Tikrinamas token
    const tokenEntry = validTokens.get(token);
    if (!tokenEntry) {
      return res.status(403).json({ error: 'Mokėjimas nepatvirtintas. Norėdami skaitymo — sumokėkite.' });
    }
    if (tokenEntry.used) {
      return res.status(403).json({ error: 'Skaitymas jau atliktas. Norėdami naujo — sumokėkite dar kartą.' });
    }

    const userName = name || tokenEntry.name || '';

    // Jei foninė analizė jau baigta — naudojame ją
    let result = null;
    if (sessionId && analysisCache.has(sessionId)) {
      const cached = analysisCache.get(sessionId);
      if (cached.status === 'done' && cached.result) {
        result = cached.result;
        console.log('Naudojamas cache:', sessionId);
        analysisCache.delete(sessionId); // Išvalom
      } else if (cached.status === 'error') {
        console.log('Cache klaida, paleidžiame iš naujo:', cached.error);
        analysisCache.delete(sessionId);
      }
    }

    // Jei cache nebuvo arba klaida — paleidžiame naują analizę
    if (!result) {
      if (!photos || photos.length === 0) {
        return res.status(400).json({ error: 'Nėra nuotraukų' });
      }
      result = await runPalmAnalysis(photos, userName);
    }

    // Tokenas sunaudojamas TIK po sėkmingos analizės
    tokenEntry.used = true;
    console.log('Analizė sėkminga:', userName);

    // Siunčiame el. laišką
    try {
      await mailer.sendMail({
        from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
        to: tokenEntry.email,
        subject: `${userName ? userName + ' — ' : ''}Tavo delno skaitymas ✦`,
        html: buildEmailHtml(userName, result)
      });
    } catch (mailErr) {
      console.error('Laiško klaida (nesvarbi):', mailErr.message);
    }

    res.json(result);

  } catch (err) {
    console.error('Klaida /analyze-palm:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildEmailHtml(userName, result) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#07040f;font-family:Georgia,serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;margin-bottom:12px">✦</div><h1 style="color:#d4a843;font-size:24px;margin:0 0 6px">${userName ? userName + ' —' : ''} Tavo Delno Skaitymas</h1><p style="color:rgba(245,238,216,0.5);font-size:13px;margin:0;font-style:italic">Delno planetų kalnai · Chiromantija · Sielos žemėlapis</p></div>
  ${section('Charakteris ir paslėptas potencialas', result.charakteris)}
  ${section('Sielos misija ir karminis kelias', result.sielos_misija)}
  ${section('Finansinė sėkmė ir karjeros trajektorija', result.finansai)}
  ${section('Prigimtinės dovanos ir paslėpti talentai', result.dovanos_tekstas)}
  ${pills(result.dovanos_sarasas)}
  ${section('Meilė, santykiai ir suderinamumas', result.meile_santykiai)}
  ${section('Planetų kalnai delne (Astrologinė įtaka)', result.astrologija)}
  ${section('Didžiausi iššūkiai ir tavo stiprybės', result.issukiai)}
  ${pills(result.stiprybes)}
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
    if (!name || !email) return res.status(400).json({ error: 'Trūksta duomenų' });
    const session = await stripe.checkout.sessions.create({
      line_items: [{ price_data: { currency: 'eur', product_data: { name: 'Delno skaitymas', description: 'Pilnas asmeninis skaitymas' }, unit_amount: 559 }, quantity: 1 }],
      mode: 'payment',
      customer_email: email,
      metadata: { name, email },
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/?cancelled=true`,
      locale: 'lt'
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/verify-payment', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    if (session.payment_status === 'paid') {
      const sessionAge = Date.now() - (session.created * 1000);
      if (sessionAge > 2 * 60 * 60 * 1000) {
        return res.json({ paid: false, error: 'Sesija pasibaigė' });
      }
      const token = createToken(session.metadata.name, session.metadata.email);
      res.json({ paid: true, name: session.metadata.name, email: session.metadata.email, token });
    } else {
      res.json({ paid: false });
    }
  } catch (err) {
    res.status(500).json({ paid: false });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DELNAS v24 veikia: http://localhost:${PORT}`));
