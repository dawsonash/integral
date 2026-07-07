// Stripe Checkout + Customer Portal: zero custom billing UI. The only billing
// state we own is users.plan (+ customer/subscription ids), flipped by the
// webhook. Everything degrades gracefully when STRIPE_SECRET_KEY is unset —
// the app runs, billing endpoints report not-configured.
const express = require('express');
const { db } = require('../db');
const { requireUser } = require('../lib/auth');

const router = express.Router();

let stripeClient = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function appUrl(req) {
  return process.env.INTEGRAL_APP_URL || `${req.protocol}://${req.get('host')}`;
}

function notConfigured(res) {
  return res.status(503).json({ error: 'billing_not_configured', message: 'Billing is not configured on this server.' });
}

async function ensureCustomer(s, user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await s.customers.create({
    email: user.email || undefined,
    name: user.login,
    metadata: { integral_user_id: String(user.id) },
  });
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer.id, user.id);
  return customer.id;
}

router.post('/api/billing/checkout', requireUser, async (req, res) => {
  const s = stripe();
  if (!s || !process.env.STRIPE_PRICE_ID) return notConfigured(res);
  try {
    const customer = await ensureCustomer(s, req.user);
    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: String(req.user.id),
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: appUrl(req) + '/?billing=success',
      cancel_url: appUrl(req) + '/?billing=cancelled',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] checkout failed:', e.message);
    res.status(502).json({ error: 'checkout_failed', message: e.message });
  }
});

router.post('/api/billing/portal', requireUser, async (req, res) => {
  const s = stripe();
  if (!s) return notConfigured(res);
  if (!req.user.stripe_customer_id) {
    return res.status(400).json({ error: 'no_customer', message: 'No billing history for this account.' });
  }
  try {
    const session = await s.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: appUrl(req) + '/',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] portal failed:', e.message);
    res.status(502).json({ error: 'portal_failed', message: e.message });
  }
});

// ---------- webhook ----------
// Mounted in app.js with express.raw BEFORE the JSON body parser — Stripe
// signature verification needs the exact raw bytes.

const setPlan = db.prepare('UPDATE users SET plan = ?, stripe_subscription_id = ? WHERE id = ?');
const byCustomer = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');

function webhook(req, res) {
  const s = stripe();
  if (!s || !process.env.STRIPE_WEBHOOK_SECRET) return notConfigured(res);
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: 'bad_signature' });
  }
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(obj.client_reference_id));
    if (user) {
      db.prepare('UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?').run(
        'pro', String(obj.customer), String(obj.subscription), user.id
      );
    }
  } else if (event.type === 'customer.subscription.updated') {
    const user = byCustomer.get(String(obj.customer));
    if (user && user.plan !== 'unlimited') {
      const active = ['active', 'trialing', 'past_due'].includes(obj.status);
      setPlan.run(active ? 'pro' : 'free', obj.id, user.id);
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const user = byCustomer.get(String(obj.customer));
    if (user && user.plan !== 'unlimited') setPlan.run('free', null, user.id);
  }
  res.json({ received: true });
}

module.exports = { router, webhook };
