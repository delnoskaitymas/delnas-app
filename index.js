// v23 — profesionali analizė, faktai, kiekvienas skyrius apie save
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

const validTokens = new Map();

function createToken(name, email) {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.set(token, { name, email, used: false, createdAt: Date.now() });
  setTimeout(() => validTokens.delete(token), 2 * 60 * 60 * 1000);
  return token;
}

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS }
});

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

app.post('/analyze-palm', async (req, res) => {
  try {
    const { photos, name, token } = req.body;

    const tokenEntry = validTokens.get(token);
    if (!tokenEntry) {
      return res.status(403).json({ error: 'Mokėjimas nepatvirtintas. Norėdami skaitymo — sumokėkite.' });
    }
    if (tokenEntry.used) {
      return res.status(403).json({ error: 'Skaitymas jau atliktas. Norėdami naujo — sumokėkite dar kartą.' });
    }

    if (!photos || photos.length === 0) {
      return res.status(400).json({ error: 'Nėra nuotraukų' });
    }

    const content = [];
    for (const p of photos) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: p.type || 'image/jpeg', data: p.data }
      });
    }

    const userName = name || tokenEntry.name || '';

    content.push({
      type: 'text',
      text: `Vardas: ${userName}. Tu esi profesionalus chiromantijos ir žmogaus charakterio analitikas. Pažvelk į šias dvi delno nuotraukas ir pateik tikslią, profesionalią analizę lietuvių kalba.

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
gyvenimo_tikslas — tik apie tai ką nori pasiekti ir sukurti gyvenime
dovanos_tekstas — tik apie talentus ir natūralius gebėjimus
meile_santykiai — tik apie meilę: kaip myli, ko ieško partnerijoje, kokie santykių modeliai
astrologija — tik apie delno planetų kalnus ir ką jie atskleidžia apie temperamentą
stiprybes — tik konkrečios stiprybės kaip faktų sąrašas

KIEKVIENAS skyrius: 5-6 trumpi, konkretūs sakiniai. Tik faktai. Be įžangų ir išvadų.

ATSAKYK TIKTAI JSON. Pradėk nuo {. Jokio teksto prieš ar po.

{"charakteris":"5-6 sakiniai","sielos_misija":"5-6 sakiniai","gyvenimo_tikslas":"5-6 sakiniai","dovanos_tekstas":"5-6 sakiniai","dovanos_sarasas":["Dovana 1","Dovana 2","Dovana 3","Dovana 4","Dovana 5"],"meile_santykiai":"5-6 sakiniai","astrologija":"5-6 sakiniai","stiprybes":["Stiprybė 1","Stiprybė 2","Stiprybė 3","Stiprybė 4","Stiprybė 5"]}`
    });

    // Retry logika overloaded_error atveju
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

    console.log('stop_reason:', data.stop_reason);
    console.log('usage:', JSON.stringify(data.usage));

    if (!data.content || data.content.length === 0) {
      console.error('Tuščias Claude atsakymas:', JSON.stringify(data));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    if (data.stop_reason === 'max_tokens') {
      console.error('ATSAKYMAS NUKIRPTAS — JSON neužbaigtas');
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    const rawText = '{' + data.content.map(b => b.text || '').join('');
    console.log('RAW ilgis:', rawText.length);
    console.log('RAW pradžia:', rawText.substring(0, 150));
    console.log('RAW pabaiga:', rawText.substring(rawText.length - 150));

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.error('JSON nerastas:', rawText.substring(0, 400));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('JSON parse klaida:', parseErr.message);
      console.error('Bandyta parse:', jsonMatch[0].substring(0, 400));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    if (!result || !result.charakteris) {
      console.error('Netinkamas rezultatas:', JSON.stringify(result).substring(0, 300));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    // Tokenas sunaudojamas TIK po sėkmingos analizės
    tokenEntry.used = true;
    console.log('Analizė sėkminga:', userName);

    try {
      await mailer.sendMail({
        from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
        to: tokenEntry.email,
        subject: `${userName ? userName + ' — ' : ''}Tavo delno skaitymas ✦`,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#07040f;font-family:Georgia,serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;margin-bottom:12px">✦</div><h1 style="color:#d4a843;font-size:24px;margin:0 0 6px">${userName ? userName + ' —' : ''} Tavo Delno Skaitymas</h1><p style="color:rgba(245,238,216,0.5);font-size:13px;margin:0;font-style:italic">Delno planetų kalnai · Chiromantija · Sielos žemėlapis</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Charakteris ir asmenybė</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.charakteris}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Sielos misija</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.sielos_misija}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Gyvenimo tikslas ir kelias</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.gyvenimo_tikslas}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Dovanos ir talentai</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.dovanos_tekstas}</p><div style="margin-top:12px">${(result.dovanos_sarasas||[]).map(d=>`<span style="background:rgba(212,168,67,0.1);border:0.5px solid rgba(212,168,67,0.3);border-radius:50px;padding:4px 12px;font-size:12px;color:#f0c96a;display:inline-block;margin:3px">${d}</span>`).join('')}</div></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Meilė ir santykiai</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.meile_santykiai}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Planetų kalnai delne</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.astrologija}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:28px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Stipriausios asmenybės pusės</div><div>${(result.stiprybes||[]).map(s=>`<span style="background:rgba(212,168,67,0.1);border:0.5px solid rgba(212,168,67,0.3);border-radius:50px;padding:4px 12px;font-size:12px;color:#f0c96a;display:inline-block;margin:3px">${s}</span>`).join('')}</div></div><div style="text-align:center;padding-top:24px;border-top:0.5px solid rgba(212,168,67,0.15)"><p style="color:rgba(245,238,216,0.35);font-size:12px;line-height:1.7;margin:0;font-style:italic">Šis skaitymas sukurtas tik tau ✦<br>Išsaugok jį — galėsi grįžti ir perskaityti dar kartą</p></div></div></body></html>`
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DELNAS v23 veikia: http://localhost:${PORT}`));
