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
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: p.type, data: p.data }
      });
    }
    content.push({
      type: 'text',
      text: `Tu esi gilios intuicijos delno skaitymo ir astrologijos ekspertas. Išanalizuok šias delno nuotraukas ir pateik IŠSAMŲ, ASMENINĮ skaitymą.

Atsakyk TIKTAI JSON formatu be jokio teksto prieš ar po. Be markdown žymėjimų.

{
  "charakteris": "3-4 sakiniai apie asmenybę pagal delno linijas",
  "sielos_misija": "3-4 sakiniai apie sielos paskirtį šiame gyvenime",
  "gyvenimo_tikslas": "2-3 sakiniai apie gyvenimo kryptį ir tikslą",
  "dovanos_tekstas": "2-3 sakiniai apie talentus ir dvasines dovanas",
  "dovanos_sarasas": ["Dovana1","Dovana2","Dovana3","Dovana4","Dovana5"],
  "meile_santykiai": "3-4 sakiniai apie meilės li
