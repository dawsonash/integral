// The Stripe price catalog, resolved from env so the same code runs against a
// sandbox and against live. Shape: plan → interval → price id.
//
//   individual  $20/mo   $216/yr  (10% off)
//   team base   $20/mo   $216/yr  — covers the workspace + the owner's seat
//   team seat   $10/mo   $108/yr  — per teammate beyond the owner
//
// The displayed numbers on the landing page must match these prices; see
// docs/go-to-market.md.
function priceId(plan, interval) {
  const key = {
    'individual:month': 'STRIPE_PRICE_INDIVIDUAL_MONTHLY',
    'individual:year': 'STRIPE_PRICE_INDIVIDUAL_YEARLY',
    'team:month': 'STRIPE_PRICE_TEAM_MONTHLY',
    'team:year': 'STRIPE_PRICE_TEAM_YEARLY',
    'team_seat:month': 'STRIPE_PRICE_TEAM_SEAT_MONTHLY',
    'team_seat:year': 'STRIPE_PRICE_TEAM_SEAT_YEARLY',
  }[`${plan}:${interval}`];
  const id = key && process.env[key];
  // Legacy single-price installs: fall back to the old $29 price so an
  // upgrade button still works before the new ids are configured.
  if (!id && plan === 'individual' && interval === 'month') return process.env.STRIPE_PRICE_ID || null;
  return id || null;
}

// Billing is "configured" once a secret key and at least one purchasable price
// exist — the dashboard hides billing UI entirely otherwise.
function billingConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && priceId('individual', 'month'));
}

function normalizeInterval(v) {
  return v === 'year' || v === 'yearly' || v === 'annual' ? 'year' : 'month';
}

module.exports = { priceId, billingConfigured, normalizeInterval };
