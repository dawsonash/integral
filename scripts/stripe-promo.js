#!/usr/bin/env node
// Create a targeted discount and one promotion code per partner business.
// Unlike a Checkout trial, this reaches only the people you hand a code to.
//
//   node scripts/stripe-promo.js --codes=ACME,BETAINC --apply
//
// Dry run unless --apply. Safe to re-run: the coupon has a deterministic id
// derived from the offer, and existing codes are reported rather than
// recreated (Stripe rejects duplicate active codes anyway).
//
// No app change is needed — server/routes/billing.js already sets
// allow_promotion_codes:true, so Checkout renders the code field today.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE USING --percent ON A CATALOG THAT SELLS YEARLY PLANS
//
// A discount applies to whole invoices, not to months. Integral sells the same
// product on a monthly and a yearly price, and a coupon can only be restricted
// by *product* (applies_to.products), never by interval — so there is no way to
// build a percent-off coupon that a partner can only redeem on monthly.
//
// "100% off for 1 month" redeemed against a yearly plan zeroes the annual
// invoice: a free YEAR, and on Team that includes every seat. --amount-off is
// the only shape with a hard per-redemption ceiling. The script prints the
// worst case for whatever you chose before it writes anything.
// ---------------------------------------------------------------------------
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const has = (name) => args.includes(`--${name}`);

const codes = String(flag('codes', '')).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const amountOff = flag('amount-off') !== undefined ? Number(flag('amount-off')) : null;
const percentOff = amountOff === null ? Number(flag('percent', 100)) : null;
const months = Number(flag('months', 1));
const once = has('once');
const maxRedemptions = Number(flag('max-redemptions', 1));
const expires = flag('expires');           // YYYY-MM-DD
const firstTimeOnly = !has('allow-existing-customers');
const appliesTo = String(flag('applies-to', '')).split(',').map((p) => p.trim()).filter(Boolean);

// Largest invoice each product can contribute, i.e. its yearly price. The seat
// product is the dangerous one: its quantity tracks headcount, so it has no
// ceiling at all.
const YEARLY_MAX = {
  integral_individual: { amount: 21600, perSeat: false },
  integral_team: { amount: 21600, perSeat: false },
  integral_team_seat: { amount: 10800, perSeat: true },
};
const money = (cents) => '$' + (cents / 100).toFixed(2);

function couponSpec() {
  const duration = once ? 'once' : 'repeating';
  const base = {
    name: flag('name') || (amountOff !== null
      ? `${money(amountOff)} off${once ? ' first invoice' : ` for ${months} month(s)`}`
      : `${percentOff}% off${once ? ' first invoice' : ` for ${months} month(s)`}`),
    duration,
    ...(duration === 'repeating' ? { duration_in_months: months } : {}),
    ...(appliesTo.length ? { applies_to: { products: appliesTo } } : {}),
    metadata: { integral_offer: 'partner' },
  };
  if (amountOff !== null) {
    return {
      id: `integral_off${amountOff}_${once ? 'once' : months + 'mo'}`,
      amount_off: amountOff,
      currency: 'usd',
      ...base,
    };
  }
  return {
    id: `integral_pct${percentOff}_${once ? 'once' : months + 'mo'}`,
    percent_off: percentOff,
    ...base,
  };
}

function exposure() {
  const totalRedemptions = maxRedemptions * codes.length;
  if (amountOff !== null) {
    return {
      perRedemption: money(amountOff),
      total: money(amountOff * totalRedemptions),
      bounded: true,
    };
  }
  // A percent-off coupon zeroes whatever invoice it lands on, so the worst case
  // is the largest invoice the products in scope can produce — always the
  // yearly price, since a discount applies per invoice, not per month.
  const pct = percentOff / 100;
  const scope = appliesTo.length ? appliesTo : Object.keys(YEARLY_MAX);
  const unknown = scope.filter((p) => !YEARLY_MAX[p]);
  const seaty = scope.some((p) => YEARLY_MAX[p]?.perSeat);
  const worst = Math.max(...scope.map((p) => YEARLY_MAX[p]?.amount || 0));

  if (unknown.length) {
    return { perRedemption: `unknown product(s): ${unknown.join(', ')}`, total: 'unknown', bounded: false };
  }
  if (seaty) {
    return {
      perRedemption: `${money(worst * pct)} plus ${money(YEARLY_MAX.integral_team_seat.amount * pct)} per extra seat — no ceiling`,
      total: `unbounded (${totalRedemptions} redemption(s) × the above)`,
      bounded: false,
    };
  }
  return {
    perRedemption: `${money(worst * pct)} (a yearly plan in scope, redeemed in full)`,
    total: money(worst * pct * totalRedemptions),
    bounded: true,
  };
}

async function ensureCoupon(stripe, spec) {
  try {
    const existing = await stripe.coupons.retrieve(spec.id);
    console.log(`  exists   ${existing.id.padEnd(28)} ${existing.name}`);
    return existing;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  if (!APPLY) {
    console.log(`  CREATE   ${spec.id.padEnd(28)} ${spec.name}`);
    return { id: spec.id };
  }
  const coupon = await stripe.coupons.create(spec);
  console.log(`  created  ${coupon.id.padEnd(28)} ${coupon.name}`);
  return coupon;
}

async function ensureCode(stripe, couponId, code) {
  const found = await stripe.promotionCodes.list({ code, limit: 1 });
  if (found.data.length) {
    const p = found.data[0];
    console.log(`  exists   ${code.padEnd(28)} → ${p.coupon.id}${p.active ? '' : ' (INACTIVE)'}`);
    return;
  }
  const params = {
    promotion: { type: 'coupon', coupon: couponId },
    code,
    max_redemptions: maxRedemptions,
    metadata: { integral_partner: code },
    ...(expires ? { expires_at: Math.floor(new Date(`${expires}T23:59:59Z`).getTime() / 1000) } : {}),
    // Keeps an acquisition code from being redeemed by someone already paying.
    ...(firstTimeOnly ? { restrictions: { first_time_transaction: true } } : {}),
  };
  if (!APPLY) {
    console.log(`  CREATE   ${code.padEnd(28)} ${maxRedemptions} redemption(s)${expires ? `, expires ${expires}` : ''}`);
    return;
  }
  const promo = await stripe.promotionCodes.create(params);
  console.log(`  created  ${promo.code.padEnd(28)} ${maxRedemptions} redemption(s)${expires ? `, expires ${expires}` : ''}`);
}

async function main() {
  if (!STRIPE_KEY) {
    console.error('STRIPE_SECRET_KEY is not set.\n\n  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-promo.js --codes=ACME --apply\n');
    process.exit(1);
  }
  if (!codes.length) {
    console.error('Pass at least one code, e.g. --codes=ACME,BETAINC');
    process.exit(1);
  }
  if (amountOff !== null && (!Number.isInteger(amountOff) || amountOff < 1)) {
    console.error('--amount-off must be a positive integer in cents, e.g. --amount-off=2000 for $20.');
    process.exit(1);
  }
  if (amountOff === null && !(percentOff > 0 && percentOff <= 100)) {
    console.error('--percent must be >0 and <=100.');
    process.exit(1);
  }
  const bad = codes.filter((c) => !/^[A-Z0-9-]+$/.test(c));
  if (bad.length) {
    console.error(`Codes may only contain letters, digits and dashes. Rejected: ${bad.join(', ')}`);
    process.exit(1);
  }

  const stripe = require('stripe')(STRIPE_KEY);
  const account = await stripe.accounts.retrieve();
  // Same mode check as stripe-bootstrap.js, and for the same reason: `livemode`
  // lives on individual objects, never on a list wrapper.
  const balance = await stripe.balance.retrieve();
  const live = balance.livemode;
  const keyLooksLive = /^(sk|rk)_live_/.test(STRIPE_KEY);
  if (live !== keyLooksLive) {
    console.error(`\nRefusing to continue: API reports livemode=${live} but the key prefix says ${keyLooksLive ? 'live' : 'test'}.`);
    process.exit(1);
  }

  const spec = couponSpec();
  const risk = exposure();

  console.log(`\nAccount   ${account.id}${account.settings?.dashboard?.display_name ? '  (' + account.settings.dashboard.display_name + ')' : ''}`);
  console.log(`Mode      ${live ? '*** LIVE — REAL MONEY ***' : 'test/sandbox'}`);
  console.log(`Offer     ${spec.name}`);
  console.log(`Codes     ${codes.join(', ')}  (${maxRedemptions} redemption(s) each${expires ? `, expiring ${expires}` : ', no expiry'})`);
  console.log(`Eligible  ${firstTimeOnly ? 'first-time customers only' : 'ANY customer, including current subscribers'}`);
  console.log(APPLY ? 'Action    APPLY' : 'Action    dry run (pass --apply to write)');

  console.log(`\nWorst case per redemption:  ${risk.perRedemption}`);
  console.log(`Worst case total:           ${risk.total}`);
  if (!risk.bounded) {
    console.log(
      '\n  A percent-off coupon cannot be limited to monthly plans — coupons restrict by\n' +
      '  product, and each Integral product carries both a monthly and a yearly price.\n' +
      '  Redeemed on a yearly plan this is a free year, not a free month.\n' +
      '  To put a ceiling on it, either:\n' +
      '    --applies-to=integral_individual   keeps seats (and their unbounded\n' +
      '                                       quantity) out of scope\n' +
      '    --amount-off=2000                  a hard $20 cap per redemption'
    );
  }

  console.log('\nCoupon');
  const coupon = await ensureCoupon(stripe, spec);

  console.log('\nPromotion codes');
  for (const code of codes) await ensureCode(stripe, coupon.id, code);

  console.log(`\n${'-'.repeat(64)}`);
  console.log(APPLY
    ? `Done. Redemptions show up per code under Product catalog → Coupons → ${coupon.id}.`
    : 'Dry run — nothing was created. Re-run with --apply.');
  console.log();
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
