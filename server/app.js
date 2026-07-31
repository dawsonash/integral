const express = require('express');
const path = require('path');
const { attachUser, requireUserPage } = require('./lib/auth');
const billing = require('./routes/billing');

const app = express();

// Behind Caddy (production) the client IP arrives in X-Forwarded-For.
if (process.env.INTEGRAL_TRUST_PROXY) app.set('trust proxy', 1);

// ---------- origin split (1.4) ----------
// With INTEGRAL_RUN_HOST set, hosted artifacts + the take flow live on a
// separate domain that never sees dashboard cookies, so an uploaded artifact's
// scripts can't touch the dev-facing surface. The artifact and recorder still
// share an origin with each other — that's all same-origin recording needs.
const RUN_HOST = process.env.INTEGRAL_RUN_HOST;
// favicon.* is on the list because the run host serves real Integral chrome —
// the take flow and the privacy/terms/contact pages — and those tabs should
// carry the logo like every other page. /contact is here because the privacy
// page's footer links it, and testers have no other way to reach the operator.
const RUN_SURFACE = /^\/(t\/|p\/|api\/take\/|__integral\/|vendor\/|style\.css$|take\.js$|favicon\.(svg|png)$|privacy|terms|contact)/;
app.use((req, res, next) => {
  if (!RUN_HOST) return next();
  if (req.hostname === RUN_HOST) {
    req.isRunHost = true;
    if (!RUN_SURFACE.test(req.path) && req.path !== '/favicon.ico') {
      return res.status(404).send('Not found');
    }
  } else {
    // The dashboard origin must never execute uploaded artifacts — tests
    // (/t/) and entry-page previews (/p/) both bounce to the run host.
    if (/^\/(t|p)\//.test(req.path)) {
      return res.redirect(`${req.protocol}://${RUN_HOST}${req.originalUrl}`);
    }
    if (/^\/api\/take\//.test(req.path)) return res.status(404).json({ error: 'wrong_host' });
  }
  next();
});

// Stripe webhook first: signature verification needs the raw body, so it must
// beat the JSON parser.
app.post('/webhooks/stripe', express.raw({ type: '*/*' }), billing.webhook);

// sendBeacon posts JSON as text/plain or application/json depending on Blob type;
// accept both.
app.use(express.json({ limit: '50mb', type: ['application/json', 'text/plain'] }));

// Session cookie → req.user. Never on the artifact-serving host: uploaded
// scripts run there, and there must be nothing for them to steal.
app.use((req, res, next) => {
  if (req.isRunHost) {
    req.user = null;
    return next();
  }
  attachUser(req, res, next);
});

// Session-aware front door: logged-out visitors get the marketing page,
// signed-in devs get the dashboard. Must be registered before express.static,
// which would otherwise serve index.html for '/'. The response varies by
// cookie, so it must never be cached.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', req.user ? 'index.html' : 'landing.html'));
});

// Vendored recorder/replayer libs, served from node_modules (same-origin).
const nm = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/rrweb.js', (req, res) =>
  res.sendFile(path.join(nm, 'rrweb', 'dist', 'rrweb.umd.min.cjs'), {
    headers: { 'Content-Type': 'text/javascript' },
  })
);
app.use('/vendor/rrweb.css', (req, res) =>
  res.sendFile(path.join(nm, 'rrweb', 'dist', 'style.min.css'), {
    headers: { 'Content-Type': 'text/css' },
  })
);

// Scripts injected into hosted artifacts.
app.use('/__integral', express.static(path.join(__dirname, '..', 'public', 'inject')));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Legal pages, reachable from both origins (the consent gate links /privacy).
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terms.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'contact.html')));

app.use(require('./routes/auth'));
app.use(require('./routes/github'));
app.use(billing.router);
app.use(require('./routes/teams'));
app.use(require('./routes/api'));
app.use(require('./routes/take'));

// Team invite landing. Served signed-out too: the page walks the visitor
// through signing in and then finishes the join for them.
app.get('/join/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'join.html'));
});

// Dev-facing pages.
app.get('/tests/:id/setup', requireUserPage, (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'))
);
app.get('/tests/:id/results', requireUserPage, (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'results.html'))
);

module.exports = app;
