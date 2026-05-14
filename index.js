const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/create-payment', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Trūksta duomenų' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
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
      res.json({ paid: true, name: session.metadata.name, email: session.metadata.email });
    } else {
      res.json({ paid: false });
    }
  } catch (err) {
    res.status(500).json({ paid: false });
  }
});

app.post('/analyze-palm', async (req, res) => {
  try {
    const { photos, name } = req.body;
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'Nėra nuotraukų' });
    const content = [];
    for (const p of photos) {
      content.push({ type: 'image', source: { type: 'base64', media_type: p.type, data: p.data } });
    }
    content.push({
      type: 'text',
      text: `Tu esi gilios intuicijos delno skaitymo ekspertas. Išanalizuok šias delno nuotraukas ir pateik IŠSAMŲ skaitymą. Atsakyk TIKTAI JSON formatu be jokio teksto prieš ar po. Be markdown žymėjimų. {"charakteris":"...","sielos_misija":"...","gyvenimo_tikslas":"...","dovanos_tekstas":"...","dovanos_sarasas":["..."],"meile_santykiai":"...","astrologija":"...","stiprybes":["..."]} Kalba: lietuvių. Tonas: mistiškas, šiltas.${name ? ' Vardas: ' + name + '.' : ''}`
    });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content }] })
    });
    const data = await response.json();
    const text = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
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

