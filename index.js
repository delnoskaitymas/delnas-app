const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// Stripe webhook needs raw body
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── EMAIL SETUP ──
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS  // Gmail App Password
  }
});

// ── CREATE PAYMENT ──
app.post('/create-payment', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Trūksta duomenų' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Delno skaitymas',
            description: 'Pilnas asmeninis skaitymas — astrologija, chiromantija, sielos žemėlapis',
            images: []
          },
          unit_amount: 559  // 5.00 EUR in cents
        },
        quantity: 1
      }],
      mode: 'payment',
      customer_email: email,
      metadata: { name, email },
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/?cancelled=true`,
      locale: 'lt'
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── VERIFY PAYMENT ──
app.get('/verify-payment', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ paid: false });

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      res.json({
        paid: true,
        name: session.metadata.name,
        email: session.metadata.email
      });
    } else {
      res.json({ paid: false });
    }
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ paid: false, error: err.message });
  }
});

// ── STRIPE WEBHOOK (send confirmation email) ──
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { name, email } = session.metadata;

    // Send confirmation email
    try {
      await mailer.sendMail({
        from: `"DELNAS ✦" <${process.env.EMAIL_FROM}>`,
        to: email,
        subject: '✦ Tavo delno skaitymas paruoštas!',
        html: `
          <div style="background:#07040f;color:#f5eed8;font-family:Georgia,serif;padding:40px;max-width:500px;margin:0 auto;border-radius:16px">
            <div style="text-align:center;margin-bottom:28px">
              <div style="font-size:40px;margin-bottom:10px">🤚</div>
              <h1 style="color:#f0c96a;font-size:24px;margin:0">Sveiki, ${name}!</h1>
              <p style="color:rgba(245,238,216,0.6);font-style:italic;margin-top:8px">Jūsų mokėjimas patvirtintas</p>
            </div>
            <div style="background:rgba(212,168,67,0.1);border:1px solid rgba(212,168,67,0.3);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
              <p style="font-size:15px;line-height:1.7;margin:0">Dabar galite grįžti į app ir įkelti delno nuotraukas.<br>Jūsų asmeninis skaitymas laukia! ✦</p>
            </div>
            <div style="text-align:center">
              <p style="color:rgba(245,238,216,0.5);font-size:13px;font-style:italic">Klausimai? TikTok: @delnas.lt</p>
            </div>
          </div>
        `
      });
    } catch (mailErr) {
      console.error('Email error:', mailErr);
    }
  }

  res.json({ received: true });
});

// ── SERVE FRONTEND ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DELNAS serveris veikia: http://localhost:${PORT}`));
