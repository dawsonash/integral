#!/usr/bin/env node
// Provision the Stripe side of a deployment: the 3 products, the 6 recurring
// prices lib/prices.js looks for, the webhook endpoint app.js mounts, and a
// Customer Portal configuration (without one, billingPortal.sessions.create
// fails in live mode). Prints the .env block at the end.
//
//   node scripts/stripe-bootstrap.js --url=https://app.integralco.us
//   node scripts/stripe-bootstrap.js --url=https://app.integralco.us --apply
//
// Dry run unless --apply. Safe to re-run: products are addressed by fixed ids
// and prices by lookup_key, so a second run adopts what the first created
// rather than duplicating it.
//
// The catalog here is the source of truth for what gets created, but NOT for
// what customers are told. server/lib/prices.js, public/landing.html and
// docs/go-to-market.md carry the same numbers — change them together.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const appUrl = (args.find((a) => a.startsWith('--url=')) || '').slice('--url='.length).replace(/\/$/, '');

// Amounts in cents. Yearly is exactly 10% off twelve months.
const PRODUCTS = [
  {
    id: 'integral_individual',
    name: 'Integral Individual',
    description: '10 active tests, 500 responses/month, 1-year session retention, 50 MB artifacts.',
    metadata: { integral_plan: 'individual' },
  },
  {
    id: 'integral_team',
    name: 'Integral Team',
    description: "Shared workspace: tests, results, and replays visible to the whole team. Includes the owner's seat.",
    metadata: { integral_plan: 'team' },
  },
  {
    id: 'integral_team_seat',
    name: 'Integral Team — additional seat',
    description: "Each teammate beyond the owner. Adds 10 active tests and 500 responses/month to the team's pooled limits.",
    unit_label: 'seat',
    metadata: { integral_plan: 'team_seat' },
  },
];

const PRICES = [
  { env: 'STRIPE_PRICE_INDIVIDUAL_MONTHLY',  product: 'integral_individual', plan: 'individual', interval: 'month', amount: 2000,  nickname: 'Individual monthly' },
  { env: 'STRIPE_PRICE_INDIVIDUAL_YEARLY',   product: 'integral_individual', plan: 'individual', interval: 'year',  amount: 21600, nickname: 'Individual yearly (10% off)' },
  { env: 'STRIPE_PRICE_TEAM_MONTHLY',        product: 'integral_team',       plan: 'team',       interval: 'month', amount: 2000,  nickname: 'Team base monthly' },
  { env: 'STRIPE_PRICE_TEAM_YEARLY',         product: 'integral_team',       plan: 'team',       interval: 'year',  amount: 21600, nickname: 'Team base yearly (10% off)' },
  { env: 'STRIPE_PRICE_TEAM_SEAT_MONTHLY',   product: 'integral_team_seat',  plan: 'team_seat',  interval: 'month', amount: 1000,  nickname: 'Team seat monthly' },
  { env: 'STRIPE_PRICE_TEAM_SEAT_YEARLY',    product: 'integral_team_seat',  plan: 'team_seat',  interval: 'year',  amount: 10800, nickname: 'Team seat yearly (10% off)' },
];

// Exactly the three the webhook in server/routes/billing.js acts on. Adding
// more here just means signature-verifying events that fall through to a no-op.
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

const lookupKey = (p) => `integral_${p.plan}_${p.interval}`;
const money = (cents) => '$' + (cents / 100).toFixed(2);

let created = 0;
let problems = 0;
const log = {
  ok: (verb, id, note) => console.log(`  ${verb.padEnd(8)} ${String(id).padEnd(34)} ${note || ''}`),
  warn: (msg) => { problems++; console.log(`  WARN     ${msg}`); },
};

async function ensureProduct(stripe, spec) {
  try {
    const existing = await stripe.products.retrieve(spec.id);
    log.ok('exists', existing.id, existing.name);
    return existing;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  // A catalog built by hand in the Dashboard has auto-generated ids, so the
  // fixed id above misses it. metadata.integral_plan is the durable handle:
  // adopt the existing product rather than creating a parallel one.
  const all = await stripe.products.list({ active: true, limit: 100 });
  const adopted = all.data.find((p) => p.metadata?.integral_plan === spec.metadata.integral_plan);
  if (adopted) {
    log.ok('adopted', adopted.id, `${adopted.name}  (matched on metadata, not id)`);
    return adopted;
  }
  if (!APPLY) {
    log.ok('CREATE', spec.id, spec.name);
    return { id: spec.id };
  }
  const product = await stripe.products.create(spec);
  created++;
  log.ok('created', product.id, product.name);
  return product;
}

async function ensurePrice(stripe, spec, productId) {
  const key = lookupKey(spec);
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  let existing = found.data[0];

  // Same story as products: a hand-made price has no lookup_key. Match it on
  // the product plus the recurring interval — one price per product per
  // interval is the whole shape of this catalog — and backfill the lookup_key
  // so the next run finds it the fast way.
  if (!existing && !productId.startsWith('integral_')) {
    const candidates = await stripe.prices.list({ product: productId, active: true, limit: 100 });
    existing = candidates.data.find((p) => p.recurring?.interval === spec.interval && !p.lookup_key);
    if (existing && existing.unit_amount === spec.amount) {
      if (APPLY) {
        existing = await stripe.prices.update(existing.id, {
          lookup_key: key,
          metadata: { integral_plan: spec.plan, integral_interval: spec.interval },
        });
      }
      log.ok('adopted', existing.id, `${spec.nickname}  ${money(existing.unit_amount)}/${spec.interval}${APPLY ? '  (tagged)' : ''}`);
      return existing;
    }
  }

  if (existing) {
    // A price's amount is immutable, so a mismatch here means the catalog in
    // this file and the catalog in the account have genuinely diverged. Creating
    // a second price would silently change what new customers pay, so stop and
    // let a human decide.
    if (existing.unit_amount !== spec.amount || existing.recurring?.interval !== spec.interval) {
      log.warn(
        `${key} exists as ${existing.id} at ${money(existing.unit_amount)}/${existing.recurring?.interval} ` +
        `but this script expects ${money(spec.amount)}/${spec.interval}. Left alone — reconcile by hand.`
      );
      return existing;
    }
    log.ok('exists', existing.id, `${spec.nickname}  ${money(existing.unit_amount)}/${spec.interval}`);
    return existing;
  }
  if (!APPLY) {
    log.ok('CREATE', `(${key})`, `${spec.nickname}  ${money(spec.amount)}/${spec.interval}`);
    return { id: `price_<${key}>` };
  }
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: spec.amount,
    recurring: { interval: spec.interval },
    nickname: spec.nickname,
    lookup_key: key,
    metadata: { integral_plan: spec.plan, integral_interval: spec.interval },
  });
  created++;
  log.ok('created', price.id, `${spec.nickname}  ${money(price.unit_amount)}/${spec.interval}`);
  return price;
}

async function ensureWebhook(stripe, url) {
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = list.data.find((w) => w.url === url && w.status !== 'disabled');
  if (existing) {
    const missing = EVENTS.filter((e) => !existing.enabled_events.includes(e) && !existing.enabled_events.includes('*'));
    log.ok('exists', existing.id, url);
    if (missing.length) log.warn(`endpoint ${existing.id} is not subscribed to: ${missing.join(', ')}`);
    // Stripe returns a webhook's signing secret only in the create response.
    log.warn('signing secret is only shown at creation — reuse the STRIPE_WEBHOOK_SECRET you saved, or roll it in the Dashboard.');
    return null;
  }
  if (!APPLY) {
    log.ok('CREATE', '(webhook)', url);
    return null;
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: EVENTS,
    description: 'Integral — plan state sync',
  });
  created++;
  log.ok('created', endpoint.id, url);
  return endpoint.secret;
}

async function ensurePortal(stripe, origin) {
  const list = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const existing = list.data.find((c) => c.is_default) || list.data[0];
  if (existing) {
    log.ok('exists', existing.id, 'customer portal configuration');
    return;
  }
  if (!APPLY) {
    log.ok('CREATE', '(portal)', 'customer portal configuration');
    return;
  }
  const config = await stripe.billingPortal.configurations.create({
    business_profile: {
      privacy_policy_url: `${origin}/privacy.html`,
      terms_of_service_url: `${origin}/terms.html`,
    },
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      // at_period_end keeps the customer paid-up until the term they bought
      // runs out; the webhook flips them to free on subscription.deleted.
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
  });
  created++;
  log.ok('created', config.id, 'customer portal configuration');
}

async function main() {
  if (!STRIPE_KEY) {
    console.error('STRIPE_SECRET_KEY is not set.\n\n  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-bootstrap.js --url=https://app.integralco.us --apply\n');
    process.exit(1);
  }
  if (!appUrl || !/^https?:\/\//.test(appUrl)) {
    console.error('Pass the dashboard origin, e.g. --url=https://app.integralco.us');
    process.exit(1);
  }

  const stripe = require('stripe')(STRIPE_KEY);
  const account = await stripe.accounts.retrieve();
  // Balance, not a list: `livemode` sits on individual objects, and a list
  // wrapper ({object, data, has_more, url}) has no such field — reading it off
  // a list yields undefined, which is falsy, which silently reports every key
  // as test. Balance always exists on every account and always carries the flag.
  const balance = await stripe.balance.retrieve();
  const live = balance.livemode;

  // Two independent signals for the same question. If they ever disagree, the
  // mode detection is broken again and guessing is the one thing not to do.
  const keyLooksLive = /^(sk|rk)_live_/.test(STRIPE_KEY);
  if (live !== keyLooksLive) {
    console.error(
      `\nRefusing to continue: the API reports livemode=${live}, but the key prefix says ` +
      `${keyLooksLive ? 'live' : 'test'}. Resolve that before writing anything.`
    );
    process.exit(1);
  }

  console.log(`\nAccount   ${account.id}${account.settings?.dashboard?.display_name ? '  (' + account.settings.dashboard.display_name + ')' : ''}`);
  console.log(`Mode      ${live ? '*** LIVE — REAL MONEY ***' : 'test/sandbox'}`);
  console.log(`App URL   ${appUrl}`);
  console.log(APPLY ? 'Action    APPLY\n' : 'Action    dry run (pass --apply to write)\n');

  console.log('Products');
  const productIds = {};
  for (const spec of PRODUCTS) {
    const product = await ensureProduct(stripe, spec);
    productIds[spec.id] = product.id;
  }

  console.log('\nPrices');
  const env = {};
  for (const spec of PRICES) {
    const price = await ensurePrice(stripe, spec, productIds[spec.product]);
    env[spec.env] = price.id;
  }

  console.log('\nWebhook');
  const secret = await ensureWebhook(stripe, `${appUrl}/webhooks/stripe`);

  console.log('\nCustomer portal');
  await ensurePortal(stripe, appUrl);

  console.log(`\n${'-'.repeat(64)}`);
  if (!APPLY) {
    console.log('Dry run — nothing was created. Re-run with --apply.');
  } else {
    console.log(`Created ${created} object(s)${problems ? `, ${problems} thing(s) need a look` : ''}.`);
  }

  console.log(`\n# --- ${live ? 'live' : 'test'} config for ${appUrl} ---`);
  console.log('STRIPE_SECRET_KEY=<the key you ran this with>');
  console.log(secret ? `STRIPE_WEBHOOK_SECRET=${secret}` : 'STRIPE_WEBHOOK_SECRET=<shown only when the endpoint is first created>');
  for (const spec of PRICES) console.log(`${spec.env}=${env[spec.env]}`);
  console.log();
  if (secret) console.log('The signing secret above is not recoverable later. Save it now.\n');
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
