// Stripe Checkout + Customer Portal: zero custom billing UI. The only billing
// state we own is users.plan / teams.plan (+ customer/subscription ids),
// flipped by the webhook. Everything degrades gracefully when
// STRIPE_SECRET_KEY is unset — the app runs, billing endpoints report
// not-configured.
//
// Two shapes of subscription:
//   individual — one line item, quantity 1.
//   team       — a base line item (workspace + owner seat) plus a per-seat
//                line item whose quantity tracks headcount beyond the owner.
//                syncSeats() is what keeps that quantity honest.
const express = require('express');
const { db } = require('../db');
const { requireUser } = require('../lib/auth');
const { priceId, billingConfigured, normalizeInterval } = require('../lib/prices');
const { PAID_PLANS } = require('../lib/plans');
const teams = require('../lib/teams');

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

// Statuses Stripe reports for a subscription that is still current in billing
// terms. past_due is one of them: dunning is under way but the customer has not
// lost access yet. The webhook decides plan state from this same list, so a
// subscription that blocks a second checkout is exactly one that grants a plan.
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

// Checkout knows nothing about what this customer already bought, so without a
// guard a second trip through it creates a second subscription on the same
// customer — a genuine double charge. The webhook would then overwrite
// users.stripe_subscription_id with whichever event landed last, leaving the
// first subscription billing with nothing in our database pointing at it.
//
// Ask Stripe rather than trusting users.stripe_subscription_id: that column is
// populated by the webhook, and a double-click beats the webhook.
//
// status:'all' because the list endpoint takes a single status and we care
// about three. 100 is far past what any real customer accumulates.
async function hasLiveSubscription(s, customerId) {
  const subs = await s.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  return subs.data.some((sub) => ACTIVE_STATUSES.includes(sub.status));
}

// ---------- seat quantity ----------

// Push the team's billable headcount onto its subscription. Stripe has no
// "quantity 0" line item worth keeping around, so the seat item is created on
// the first teammate and deleted when the last one leaves.
//
// proration_behavior defaults to Stripe's 'create_prorations': adding someone
// mid-cycle bills the remainder of the period, removing them credits it.
async function syncSeats(team) {
  const s = stripe();
  if (!s || !team || !team.stripe_subscription_id) return;
  const seats = teams.billableSeats(team.id);
  const interval = team.billing_interval === 'year' ? 'year' : 'month';
  const seatPrice = priceId('team_seat', interval);
  if (!seatPrice) return;
  try {
    if (team.stripe_seat_item_id) {
      if (seats > 0) {
        await s.subscriptionItems.update(team.stripe_seat_item_id, { quantity: seats });
      } else {
        await s.subscriptionItems.del(team.stripe_seat_item_id);
        db.prepare('UPDATE teams SET stripe_seat_item_id = NULL WHERE id = ?').run(team.id);
      }
    } else if (seats > 0) {
      const item = await s.subscriptionItems.create({
        subscription: team.stripe_subscription_id,
        price: seatPrice,
        quantity: seats,
      });
      db.prepare('UPDATE teams SET stripe_seat_item_id = ? WHERE id = ?').run(item.id, team.id);
    }
  } catch (e) {
    // Never block a membership change on a billing hiccup — the roster is the
    // source of truth and a later sync (or the webhook) reconciles it.
    console.error('[billing] seat sync failed for team', team.id + ':', e.message);
  }
}

// ---------- checkout ----------

router.post('/api/billing/checkout', express.json(), requireUser, async (req, res) => {
  const s = stripe();
  if (!s || !billingConfigured()) return notConfigured(res);

  const plan = req.body?.plan === 'team' ? 'team' : 'individual';
  const interval = normalizeInterval(req.body?.interval);
  const base = priceId(plan, interval);
  if (!base) {
    return res.status(503).json({ error: 'price_not_configured', message: `No Stripe price configured for ${plan} / ${interval}.` });
  }

  // Before anything with a side effect — a customer with no Stripe customer id
  // cannot have a subscription, so first-time buyers skip the round trip, and
  // running this ahead of team creation means a rejected checkout cannot leave
  // an orphaned workspace behind.
  if (req.user.stripe_customer_id) {
    let subscribed;
    try {
      subscribed = await hasLiveSubscription(s, req.user.stripe_customer_id);
    } catch (e) {
      // Fail closed. Only returning customers reach this branch, and for them
      // being billed twice for the same thing is worse than being asked to try
      // again.
      console.error('[billing] subscription check failed:', e.message);
      return res.status(502).json({
        error: 'billing_check_failed',
        message: 'Could not verify your current subscription. Please try again.',
      });
    }
    if (subscribed) {
      return res.status(409).json({
        error: 'already_subscribed',
        message: 'You already have an active subscription. Manage it from the billing portal.',
      });
    }
  }

  // Buying Team provisions the workspace up front, so the buyer can invite
  // people the moment they land back from Checkout. The team stays on the
  // 'free' plan until the webhook confirms payment.
  let team = teams.teamForUser(req.user.id);
  if (plan === 'team') {
    if (team && teams.roleFor(team.id, req.user.id) !== 'owner') {
      return res.status(409).json({ error: 'already_in_team', message: "You're already a member of a team. Leave it before starting your own." });
    }
    if (!team) {
      const name = String(req.body?.teamName || '').trim().slice(0, 80) || `${req.user.login}'s team`;
      team = teams.createTeam(req.user.id, name, interval);
    } else {
      db.prepare('UPDATE teams SET billing_interval = ? WHERE id = ?').run(interval, team.id);
      team = teams.teamById.get(team.id);
    }
  } else if (team) {
    return res.status(409).json({ error: 'in_team', message: 'Team members are billed through their team.' });
  }

  try {
    const customer = await ensureCustomer(s, req.user);
    const line_items = [{ price: base, quantity: 1 }];
    if (plan === 'team') {
      const seats = teams.billableSeats(team.id);
      const seatPrice = priceId('team_seat', interval);
      if (seats > 0 && seatPrice) line_items.push({ price: seatPrice, quantity: seats });
    }
    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: String(req.user.id),
      line_items,
      allow_promotion_codes: true,
      // The webhook is the authority on what got bought; metadata is how it
      // finds out. subscription_data copies it onto the subscription too, so
      // later lifecycle events carry the same context.
      metadata: { integral_plan: plan, integral_interval: interval, integral_team_id: team ? String(team.id) : '' },
      subscription_data: {
        metadata: { integral_plan: plan, integral_interval: interval, integral_team_id: team ? String(team.id) : '' },
      },
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
  // A team owner manages the team's subscription; everyone else manages their own.
  // Authorization is decided before Stripe config, so who may reach the team's
  // portal never depends on how this server happens to be set up.
  const team = teams.teamForUser(req.user.id);
  const isOwner = team && teams.roleFor(team.id, req.user.id) === 'owner';
  // Checkout created the team's Stripe customer under the buyer's account, so a
  // former owner's users.stripe_customer_id still points at it. Falling through
  // to the personal customer would hand a demoted owner the team's portal.
  if (team && !isOwner && req.user.stripe_customer_id === team.stripe_customer_id) {
    return res.status(403).json({
      error: 'not_team_owner',
      message: 'Your team owner manages the subscription.',
    });
  }
  const s = stripe();
  if (!s) return notConfigured(res);
  const customer = isOwner && team.stripe_customer_id ? team.stripe_customer_id : req.user.stripe_customer_id;
  if (!customer) {
    return res.status(400).json({ error: 'no_customer', message: 'No billing history for this account.' });
  }
  try {
    const session = await s.billingPortal.sessions.create({
      customer,
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

const byCustomer = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');
const teamBySub = db.prepare('SELECT * FROM teams WHERE stripe_subscription_id = ?');

// Move a team between 'team' and 'free', keeping the retention grace clock
// honest. The clock is stamped only on the paid→free edge, so a repeated or
// replayed webhook can't quietly extend the runway, and cleared on the way back
// up so a team that fixes its card doesn't stay marked as lapsed.
// past_due still counts as paid upstream, so this only fires once dunning has
// actually given up.
function setTeamPlan(team, plan, subscriptionId) {
  const lapsing = team.plan === 'team' && plan !== 'team';
  const lapsedAt = lapsing ? Date.now() : plan === 'team' ? null : team.plan_lapsed_at;
  db.prepare('UPDATE teams SET plan = ?, stripe_subscription_id = ?, plan_lapsed_at = ? WHERE id = ?')
    .run(plan, subscriptionId, lapsedAt, team.id);
}

// The individual counterpart, with the same grace-clock rules. 'unlimited' is
// the internal comp grant and is never moved by billing at all, so the guard
// that used to sit at each call site lives here instead.
function setUserPlan(user, plan, subscriptionId) {
  if (user.plan === 'unlimited') return;
  const lapsing = PAID_PLANS.has(user.plan) && !PAID_PLANS.has(plan);
  const lapsedAt = lapsing ? Date.now() : PAID_PLANS.has(plan) ? null : user.plan_lapsed_at;
  db.prepare('UPDATE users SET plan = ?, stripe_subscription_id = ?, plan_lapsed_at = ? WHERE id = ?')
    .run(plan, subscriptionId, lapsedAt, user.id);
}

// A subscription's metadata is set at Checkout and copied forward by Stripe,
// so it's the reliable way to tell a team subscription from an individual one.
function teamForEvent(obj) {
  const id = Number(obj.metadata && obj.metadata.integral_team_id);
  if (id) return teams.teamById.get(id) || null;
  return teamBySub.get(String(obj.id)) || null;
}

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
    const plan = (obj.metadata && obj.metadata.integral_plan) || 'individual';
    const interval = (obj.metadata && obj.metadata.integral_interval) === 'year' ? 'year' : 'month';
    const teamId = Number(obj.metadata && obj.metadata.integral_team_id);
    if (teamId) {
      // plan_lapsed_at clears here too: a lapsed team that re-subscribes through
      // a fresh Checkout is current again, not mid-grace.
      db.prepare(
        `UPDATE teams SET plan = 'team', billing_interval = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
         plan_lapsed_at = NULL WHERE id = ?`
      ).run(interval, String(obj.customer), String(obj.subscription), teamId);
      // The seat line item may not exist yet (solo owner at checkout) or may
      // be stale if people were invited while Checkout was open.
      recordSeatItem(String(obj.subscription), teamId);
    } else if (user) {
      // plan_lapsed_at clears here for the same reason it does on the team
      // branch: re-subscribing makes you current, not mid-grace.
      db.prepare(
        `UPDATE users SET plan = ?, billing_interval = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
         plan_lapsed_at = NULL WHERE id = ?`
      ).run(plan === 'team' ? 'individual' : plan, interval, String(obj.customer), String(obj.subscription), user.id);
    }
  } else if (event.type === 'customer.subscription.updated') {
    const active = ACTIVE_STATUSES.includes(obj.status);
    const team = teamForEvent(obj);
    if (team) {
      setTeamPlan(team, active ? 'team' : 'free', obj.id);
    } else {
      const user = byCustomer.get(String(obj.customer));
      if (user) setUserPlan(user, active ? 'individual' : 'free', obj.id);
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const team = teamForEvent(obj);
    if (team) {
      setTeamPlan(team, 'free', null);
      db.prepare('UPDATE teams SET stripe_seat_item_id = NULL WHERE id = ?').run(team.id);
    } else {
      const user = byCustomer.get(String(obj.customer));
      if (user) setUserPlan(user, 'free', null);
    }
  }
  res.json({ received: true });
}

// After checkout, find the seat line item Stripe created (if any) and remember
// it, then reconcile its quantity against the current roster.
function recordSeatItem(subscriptionId, teamId) {
  const s = stripe();
  if (!s) return;
  const team = teams.teamById.get(teamId);
  if (!team) return;
  const interval = team.billing_interval === 'year' ? 'year' : 'month';
  const seatPrice = priceId('team_seat', interval);
  s.subscriptions.retrieve(subscriptionId)
    .then((sub) => {
      const item = (sub.items && sub.items.data || []).find((i) => i.price && i.price.id === seatPrice);
      if (item) {
        db.prepare('UPDATE teams SET stripe_seat_item_id = ? WHERE id = ?').run(item.id, teamId);
      }
      return syncSeats(teams.teamById.get(teamId));
    })
    .catch((e) => console.error('[billing] seat item lookup failed:', e.message));
}

module.exports = { router, webhook, syncSeats, setTeamPlan, setUserPlan, stripe, hasLiveSubscription, ACTIVE_STATUSES };
