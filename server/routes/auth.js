const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { setSessionCookie, clearSessionCookie, parseCookies } = require('../lib/session');
const { requireUser, upsertUser, githubConfigured, devLoginEnabled } = require('../lib/auth');
const { planFor, monthStart } = require('../lib/plans');
const { deleteUserData } = require('../lib/purge');

const router = express.Router();

function appUrl(req) {
  return process.env.INTEGRAL_APP_URL || `${req.protocol}://${req.get('host')}`;
}

router.get('/api/auth/config', (req, res) => {
  res.json({ github: githubConfigured(), dev: devLoginEnabled() });
});

// ---------- GitHub OAuth ----------

function startOauth(req, res, scope) {
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', `integral_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: appUrl(req) + '/auth/github/callback',
    state,
  });
  if (scope) params.set('scope', scope);
  res.redirect('https://github.com/login/oauth/authorize?' + params);
}

router.get('/auth/github', (req, res) => {
  if (!githubConfigured()) return res.status(404).send('GitHub OAuth is not configured');
  startOauth(req, res);
});

// Repo connection: a second consent with `repo` scope, kept out of the normal
// sign-in so signing in never asks for more than a public profile. The
// resulting token is stored and used to list/pull the user's repositories.
router.get('/auth/github/connect', (req, res) => {
  if (!githubConfigured()) return res.status(404).send('GitHub OAuth is not configured');
  if (!req.user) return res.redirect('/');
  res.append('Set-Cookie', 'integral_oauth_connect=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600');
  startOauth(req, res, 'repo');
});

router.get('/auth/github/callback', async (req, res) => {
  if (!githubConfigured()) return res.status(404).send('GitHub OAuth is not configured');
  const { code, state } = req.query;
  if (!code || !state || state !== parseCookies(req).integral_oauth_state) {
    return res.status(400).send('OAuth state mismatch — try signing in again.');
  }
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const { access_token: token } = await tokenRes.json();
    if (!token) throw new Error('no access token from GitHub');
    const ghHeaders = { Authorization: `Bearer ${token}`, 'User-Agent': 'integral' };
    const gh = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json();
    let email = gh.email;
    if (!email) {
      // Most GitHub profiles keep email private; the emails endpoint has the real one.
      const emails = await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json();
      const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
      email = primary ? primary.email : null;
    }
    const user = upsertUser({
      githubId: String(gh.id),
      login: gh.login,
      name: gh.name,
      email,
      avatarUrl: gh.avatar_url,
    });
    // Only the connect flow's token carries repo scope; a plain sign-in token
    // is useless for repos and must not overwrite a stored repo-scoped one.
    if (parseCookies(req).integral_oauth_connect === '1') {
      db.prepare('UPDATE users SET github_token = ? WHERE id = ?').run(token, user.id);
      res.append('Set-Cookie', 'integral_oauth_connect=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    }
    setSessionCookie(res, { uid: user.id });
    res.redirect('/');
  } catch (e) {
    console.error('[auth] github callback failed:', e.message);
    res.status(502).send('GitHub sign-in failed — try again.');
  }
});

// ---------- dev login (never in production) ----------
// Lets local dev and the test suite get a session without OAuth credentials.
// ?login=name creates distinct users; ?plan=free exercises plan gates.

router.get('/auth/dev', (req, res) => {
  if (!devLoginEnabled()) return res.status(404).send('Not found');
  const login = String(req.query.login || 'dev').slice(0, 40);
  const plan = ['free', 'pro', 'unlimited'].includes(req.query.plan) ? req.query.plan : 'unlimited';
  const user = upsertUser({ githubId: 'dev:' + login, login, name: login, plan });
  if (req.query.plan) db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, user.id);
  setSessionCookie(res, { uid: user.id });
  if ((req.headers.accept || '').includes('application/json')) {
    return res.json({ ok: true, user: { id: user.id, login: user.login, plan } });
  }
  res.redirect('/');
});

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- account ----------

router.get('/api/me', requireUser, (req, res) => {
  const u = req.user;
  const plan = planFor(u);
  const activeTests = db
    .prepare("SELECT COUNT(*) AS n FROM tests WHERE user_id = ? AND status = 'live'")
    .get(u.id).n;
  const responsesThisMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions s JOIN tests t ON t.id = s.test_id
       WHERE t.user_id = ? AND s.status = 'completed' AND s.started_at >= ?`
    )
    .get(u.id, monthStart()).n;
  res.json({
    id: u.id,
    login: u.login,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatar_url,
    plan: u.plan,
    billingConfigured: !!process.env.STRIPE_SECRET_KEY,
    limits: {
      // Infinity serializes to null; the dashboard reads null as "no limit".
      activeTests: plan.activeTests,
      responsesPerMonth: plan.responsesPerMonth,
      retentionDays: plan.retentionDays,
      artifactBytes: plan.artifactBytes,
      linkTtlDays: plan.linkTtlDays,
    },
    usage: { activeTests, responsesThisMonth },
  });
});

// Data deletion = account deletion (GDPR minimum): removes the user and every
// test, session, interaction, event file, and artifact they own.
router.delete('/api/account', requireUser, async (req, res) => {
  if (req.user.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(req.user.stripe_subscription_id);
    } catch (e) {
      console.error('[billing] subscription cancel on account delete failed:', e.message);
    }
  }
  deleteUserData(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
