const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { setSessionCookie, clearSessionCookie, parseCookies } = require('../lib/session');
const { requireUser, upsertUser, githubConfigured, devLoginEnabled } = require('../lib/auth');
const { planFor, scopeFor, monthStart, graceFor } = require('../lib/plans');
const { billingConfigured } = require('../lib/prices');
const teams = require('../lib/teams');
const attribution = require('../lib/attribution');
const pageviews = require('../lib/pageviews');
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
      attribution: attribution.read(req),
    });
    attribution.clear(res);
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
  const plan = ['free', 'individual', 'pro', 'unlimited'].includes(req.query.plan) ? req.query.plan : 'unlimited';
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
  // Usage is measured over whatever pool the plan grants: a team's limits are
  // shared, so a member's numbers are the whole team's numbers.
  const scope = scopeFor(u);
  const activeTests = db
    .prepare(`SELECT COUNT(*) AS n FROM tests t WHERE ${scope.where} AND t.status = 'live'`)
    .get(...scope.args).n;
  const responsesThisMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions s JOIN tests t ON t.id = s.test_id
       WHERE ${scope.where} AND s.status = 'completed' AND s.started_at >= ?`
    )
    .get(...scope.args, monthStart()).n;
  const team = teams.teamForUser(u.id);
  res.json({
    id: u.id,
    login: u.login,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatar_url,
    // The entitlement actually in force. A team member's personal users.plan
    // row is irrelevant while the team is paying, so report the plan label the
    // dashboard should show.
    plan: team && team.plan === 'team' ? 'team' : u.plan,
    planLabel: plan.label,
    billingInterval: (team && team.plan === 'team' ? team.billing_interval : u.billing_interval) || null,
    team: team
      ? { id: team.id, name: team.name, plan: team.plan, role: teams.roleFor(team.id, u.id), seats: teams.memberCount(team.id) }
      : null,
    billingConfigured: billingConfigured(),
    // When this account's data stops being kept at the paid window, after a
    // lapsed subscription. Null unless something is actually lapsing. Team
    // members get their team's clock; the team card renders that one instead.
    graceEndsAt: graceFor(u),
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

// Signup attribution report. 'unlimited' is the internal comp/dev grant (see
// lib/plans.js), so gating on it keeps this to operators — paying customers
// have no business reading how the business acquires people.
router.get('/api/attribution', requireUser, (req, res) => {
  if (req.user.plan !== 'unlimited') return res.status(403).json({ error: 'forbidden' });
  const days = Number(req.query.days);
  const window = { days: Number.isFinite(days) && days > 0 ? days : null };
  // Traffic rides along on the same request and the same window: views and the
  // signups they produced are one card, and two endpoints could disagree about
  // which range they answered for.
  res.json({ ...attribution.report(window), views: pageviews.series(window) });
});

// Data deletion = account deletion (GDPR minimum): removes the user and every
// test, session, interaction, event file, and artifact they own.
router.delete('/api/account', requireUser, async (req, res) => {
  const team = teams.teamForUser(req.user.id);
  const subs = [req.user.stripe_subscription_id];
  // An owner's account going away takes the team with it; a member just leaves
  // (their team tests stay with the owner, and the seat stops being billed).
  if (team && teams.roleFor(team.id, req.user.id) === 'owner') {
    subs.push(team.stripe_subscription_id);
    teams.deleteTeam(team.id);
  } else if (team) {
    teams.releaseMember(team.id, req.user.id);
    await require('./billing').syncSeats(teams.teamById.get(team.id));
  }
  for (const sub of subs.filter(Boolean)) {
    if (!process.env.STRIPE_SECRET_KEY) break;
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(sub);
    } catch (e) {
      console.error('[billing] subscription cancel on account delete failed:', e.message);
    }
  }
  await deleteUserData(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
