// Sealed-cookie sessions: base64url(JSON payload) + HMAC-SHA256 signature.
// One secret, no server-side session store. The secret comes from
// INTEGRAL_SESSION_SECRET or is generated once and persisted in the data dir
// so restarts don't log everyone out.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db');

const COOKIE = 'integral_session';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function loadSecret() {
  if (process.env.INTEGRAL_SESSION_SECRET) return process.env.INTEGRAL_SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}
const SECRET = loadSecret();

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function seal(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + sign(data);
}

function unseal(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.iat || Date.now() - payload.iat > MAX_AGE_MS) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res, payload) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${seal({ ...payload, iat: Date.now() })}; ${attrs.join('; ')}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readSession(req) {
  return unseal(parseCookies(req)[COOKIE]);
}

module.exports = { setSessionCookie, clearSessionCookie, readSession, parseCookies, seal, unseal };
