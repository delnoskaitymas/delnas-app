// v9 — galutinis
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

function validateAndConsume(token) {
  const entry = validTokens.get(token);
  if (!entry) return null;
  if (entry.used) return null;
  entry.used = true;
  return entry;
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
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'eur', product_data: { name: 'Delno skaitymas', description: 'Pilnas asmeninis skaitymas' }, unit_amount: 599 }, quantity: 1 }],
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

    const tokenEntry = validateAndConsume(token);
    if (!tokenEntry) {
      return res.status(403).json({ error: 'Mokėjimas nepatvirtintas arba skaitymas jau buvo atliktas. Norėdami naujo skaitymo — sumokėkite dar kartą.' });
    }

    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });

    const content = [];
    for (const p of photos) {
      content.push({ type: 'image', source: { type: 'base64', media_type: p.type, data: p.data } });
    }

    const userName = name || tokenEntry.name || '';

    content.push({
      type: 'text',
      text: `Tu esi delno skaitymo meistras. Gauni dvi nuotraukas — kairę ir dešinę ranką.

Tavo tikslas: parašyti skaitymą kuris žmogų privers sustoti ir pagalvoti "iš kur jie žino". Ne šablonas — o tikslus, intimus, gilus tekstas kuris atspindi universalią žmogišką tiesą taip konkrečiai, kad kiekvienas atpažįsta save.

TECHNIKA — kaip rašyti kad skambėtų asmeniškai:

Vietoj "tu esi jautrus žmogus" rašyk:
"Yra momentų kai esi kambaryje pilname žmonių ir jautiesi vienišiausias iš visų — ir niekas to nemato. Tu išmokai slėpti tai po šypsena."

Vietoj "tu trokšti meilės" rašyk:
"Tu ne kartą save sulaikei — nepasakei ko norėjai, nepasirodei koks esi iš tikrųjų, nes bijojo kad bus per daug. Ir dėl to praradai dalykų kurių vis dar gailiesi."

Vietoj "tu esi stiprus" rašyk:
"Žmonės pas tave ateina su savo problemomis nes jaučia kad tu susitvarkysi. Ir tu susitvarkai. Bet kas ateina pas tave kai tau sunku? Dažniausiai — niekas."

Vietoj "artėja pokyčiai" rašyk:
"Yra kažkas ką žinai kad reikia pakeisti — ir jau kurį laiką žinai. Bet vis dar lauki. Ne laiko — drąsos."

PRINCIPAI:
- Kiekvienas skyrius mažiausiai 10 sakinių
- Kalbėk apie konkrečius momentus, jausmus, situacijas — ne abstrakčias savybes
- Naudok "tu" — tiesiogiai, intymiai, kaip žmogus kuris tave pažįsta
- Maišyk šviesą ir šešėlį — ne tik komplimentai, bet ir tiesos kurios šiek tiek skauda
- Kalbėk apie santykius, praradimus, baimes, troškimus, slaptus dalykus
- Baik kiekvieną skyrių kažkuo kas suteikia viltį arba stiprybę
- Tonas: šiltas, tikslus, poetiškas — kaip geriausias draugas kuris mato tave giliau nei tu pats

DRAUDŽIAMA:
- Bendros frazės kurios netinka niekam konkrečiai
- Komplimentai be gelmės
- Sakiniai kurie skamba kaip horoskopas
- Kartotis tarp skyrių

Atsakyk TIKTAI JSON formatu, be jokio teksto prieš ar po, be markdown:

{"charakteris":"mažiausiai 10 sakinių — kas tu esi iš tikrųjų, kaip mąstai, ko bijai, ką slėpi, kaip elgiesi su žmonėmis","sielos_misija":"mažiausiai 10 sakinių — kodėl atėjai į šį pasaulį, kas tavo gyvenime svarbiausia iš tikrųjų, net jei pats to dar nesuvokei","gyvenimo_tikslas":"mažiausiai 10 sakinių — kur eini, kas laukia, ko neprarask, ko dar nepadarei bet privalai, kas tave stabdo","dovanos_tekstas":"mažiausiai 10 sakinių — kokios tavo dovanos ir kaip jos pasireiškia, ko kiti pas tave ateina, kuo tu kitiems ypatingas net nesuprasdamas","dovanos_sarasas":["Dovana 1","Dovana 2","Dovana 3","Dovana 4","Dovana 5","Dovana 6"],"meile_santykiai":"mažiausiai 10 sakinių — kaip myli, ko ieškai, ką jau išgyvenai, kas tavo santykiuose kartojasi, kas tave žeidžia, kas laukia","astrologija":"mažiausiai 10 sakinių — kokios energijos veikia tavo gyvenimą, kokia tavo vidinė jėga ir kokia tamsa, su kuo kovojai ir su kuo dar kovosi","stiprybes":["Stiprybė 1","Stiprybė 2","Stiprybė 3","Stiprybė 4","Stiprybė 5","Stiprybė 6","Stiprybė 7"]}

Kalba: lietuvių. Vardas: ${userName || 'nežinomas'}.`
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: [{ role: 'user', content }] })
    });

    const data = await response.json();

    if (!data.content || data.content.length === 0) {
      console.error('Tuščias Claude atsakymas:', JSON.stringify(data));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    const text = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(text);
    } catch(parseErr) {
      console.error('JSON parse klaida:', text.substring(0, 500));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    if (!result || !result.charakteris) {
      console.error('Netinkamas atsakymas:', text.substring(0, 500));
      return res.status(500).json({ error: 'Analizės klaida. Bandyk dar kartą.' });
    }

    try {
      await mailer.sendMail({
        from: `"Delno Skaitymas" <${process.env.EMAIL_FROM}>`,
        to: tokenEntry.email,
        subject: `${userName ? userName + ' — ' : ''}Tavo delno skaitymas ✦`,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#07040f;font-family:Georgia,serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;margin-bottom:12px">✦</div><h1 style="color:#d4a843;font-size:24px;margin:0 0 6px">${userName ? userName + ' —' : ''} Tavo Delno Skaitymas</h1><p style="color:rgba(245,238,216,0.5);font-size:13px;margin:0;font-style:italic">Delno planetų kalnai · Chiromantija · Sielos žemėlapis</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Charakteris ir asmenybė</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.charakteris}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Sielos misija</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.sielos_misija}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Gyvenimo tikslas ir kelias</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.gyvenimo_tikslas}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Dovanos ir talentai</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.dovanos_tekstas}</p><div style="margin-top:12px">${(result.dovanos_sarasas||[]).map(d=>`<span style="background:rgba(212,168,67,0.1);border:0.5px solid rgba(212,168,67,0.3);border-radius:50px;padding:4px 12px;font-size:12px;color:#f0c96a;display:inline-block;margin:3px">${d}</span>`).join('')}</div></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Meilė ir santykiai</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.meile_santykiai}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:12px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Planetų kalnai delne</div><p style="color:#f5eed8;font-size:14px;line-height:1.8;margin:0;font-style:italic">${result.astrologija}</p></div><div style="background:rgba(255,255,255,0.03);border:0.5px solid rgba(212,168,67,0.2);border-radius:14px;padding:20px;margin-bottom:28px"><div style="font-size:10px;letter-spacing:.16em;color:#d4a843;margin-bottom:10px;text-transform:uppercase">Stipriausios asmenybės pusės</div><div>${(result.stiprybes||[]).map(s=>`<span style="background:rgba(212,168,67,0.1);border:0.5px solid rgba(212,168,67,0.3);border-radius:50px;padding:4px 12px;font-size:12px;color:#f0c96a;display:inline-block;margin:3px">${s}</span>`).join('')}</div></div><div style="text-align:center;padding-top:24px;border-top:0.5px solid rgba(212,168,67,0.15)"><p style="color:rgba(245,238,216,0.35);font-size:12px;line-height:1.7;margin:0;font-style:italic">Šis skaitymas sukurtas tik tau ✦<br>Išsaugok jį — galėsi grįžti ir perskaityti dar kartą</p></div></div></body></html>`
      });
    } catch (mailErr) {
      console.error('Laiško klaida:', mailErr);
    }

    res.json(result);

  } catch (err) {
    console.error('Klaida:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DELNAS veikia: http://localhost:${PORT}`));
