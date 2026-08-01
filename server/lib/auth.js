const { db } = require('../db');
const { readSession } = require('./session');

const getUser = db.prepare('SELECT * FROM users WHERE id = ?');

// GitHub OAuth is the only real login method (spec buyer = developer). Dev
// login exists so local development and tests work without OAuth credentials;
// it is hard-disabled in production.
function githubConfigured() {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}
function devLoginEnabled() {
  return process.env.NODE_ENV !== 'production';
}

// Attaches req.user (or null) from the session cookie. Mounted app-wide on the
// dev-facing surface; the testee surface never reads cookies.
function attachUser(req, res, next) {
  const s = readSession(req);
  req.user = s && s.uid ? getUser.get(s.uid) || null : null;
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
}

// Page variant: browsers get bounced to the dashboard's login screen.
function requireUserPage(req, res, next) {
  if (!req.user) return res.redirect('/');
  next();
}

// `attribution` is written on INSERT only. That's what makes the numbers
// first-touch: a returning user signing in through a fresh ad link keeps the
// channel that actually acquired them.
function upsertUser({ githubId, login, name, email, avatarUrl, plan, attribution }) {
  const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId);
  if (existing) {
    db.prepare('UPDATE users SET login = ?, name = ?, email = ?, avatar_url = ? WHERE id = ?').run(
      login, name || null, email || null, avatarUrl || null, existing.id
    );
    return getUser.get(existing.id);
  }
  const info = db
    .prepare(
      `INSERT INTO users (github_id, login, name, email, avatar_url, plan, signup_source, signup_campaign, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      githubId, login, name || null, email || null, avatarUrl || null, plan || 'free',
      (attribution && attribution.source) || null,
      (attribution && attribution.campaign) || null,
      Date.now()
    );
  return getUser.get(info.lastInsertRowid);
}

module.exports = { attachUser, requireUser, requireUserPage, upsertUser, githubConfigured, devLoginEnabled };
