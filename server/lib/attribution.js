// First-touch signup attribution: which channel a visitor arrived from,
// remembered just long enough to be stamped onto their user row when they
// sign up.
//
// This is deliberately not an analytics product. It answers one question —
// which advertising avenue produces signups — with no third-party script, no
// per-pageview storage, and no cross-site identifier. The entire mechanism is
// one first-party cookie and two columns on `users`. Nothing identifying is
// recorded for visitors who never sign up (lib/pageviews.js adds them to a
// daily total and nothing else), which is why the privacy policy's "no
// third-party trackers" claim still holds.
const { db } = require('../db');
const { parseCookies } = require('./session');
const pageviews = require('./pageviews');

const COOKIE = 'integral_attr';
const MAX_AGE_DAYS = 30;

// Sources end up in a GROUP BY and on a chart axis, so they're normalized
// hard: lowercased, trimmed, length-capped. Anything unusable collapses into
// 'direct' rather than minting a new bucket.
const MAX_FIELD = 60;

function clean(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().slice(0, MAX_FIELD);
  return s || null;
}

// An off-site referrer is an advertising avenue too — a Reddit comment or an
// HN post has no utm_source but is exactly the kind of thing worth counting.
// Same-host referrers are internal navigation and must not overwrite the
// first touch.
function referrerSource(req) {
  const ref = req.headers.referer || req.headers.referrer;
  if (typeof ref !== 'string') return null;
  let host;
  try {
    host = new URL(ref).hostname;
  } catch (e) {
    return null;
  }
  if (!host || host === req.hostname) return null;
  return clean(host.replace(/^www\./, ''));
}

function encode(rec) {
  return Buffer.from(JSON.stringify(rec)).toString('base64url');
}

function decode(raw) {
  if (!raw) return null;
  try {
    const rec = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return rec && typeof rec.s === 'string' ? rec : null;
  } catch (e) {
    return null;
  }
}

// What this visit looks like as an attribution record. utm_source wins when
// present (that's the tagged ad); otherwise the referrer; otherwise direct.
// 'direct' is stored rather than skipped so the signup totals add up — a
// channel's share is only meaningful against the untagged traffic.
function capture(req) {
  const q = req.query || {};
  const rec = {
    s: clean(q.utm_source) || referrerSource(req) || 'direct',
    t: Date.now(),
  };
  const campaign = clean(q.utm_campaign) || clean(q.utm_medium);
  if (campaign) rec.c = campaign;
  return rec;
}

// Stamps the first-touch cookie on HTML page views. Registered app-wide on the
// dashboard origin only: the run host serves uploaded artifacts and the
// test-taking flow, which stay cookie-free by design.
function middleware(req, res, next) {
  if (req.isRunHost) return next();
  if (req.method !== 'GET') return next();
  if (!(req.headers.accept || '').includes('text/html')) return next();

  // Aggregate traffic tally (lib/pageviews.js). Above the first-touch check so
  // a returning visitor's second view still counts as a view — it just doesn't
  // re-stamp the channel.
  pageviews.record(req);

  // First touch wins: a visitor who arrives via an ad, leaves, and comes back
  // directly is still that ad's signup.
  if (parseCookies(req)[COOKIE]) return next();

  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${encode(capture(req))}; ${attrs.join('; ')}`);
  next();
}

// The stored first touch, as the two columns upsertUser writes. Null when the
// visitor has no cookie (bookmarked the login URL, blocked cookies, or signed
// up before this shipped).
function read(req) {
  const rec = decode(parseCookies(req)[COOKIE]);
  if (!rec) return null;
  return { source: rec.s, campaign: rec.c || null };
}

// Spent once it's on the user row; no reason to keep it for another 30 days.
function clear(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Signups and paid conversions per channel — the whole reason the cookie
// exists. Accounts created before this shipped have no source and are reported
// under UNTRACKED so the totals stay honest rather than flattering.
//
// "Paid" is the entitlement in force now, not what they bought: a member of a
// paying team converted, even though their own users.plan row still says
// 'free'. 'unlimited' is the internal comp grant and never counts.
const UNTRACKED = '(before tracking)';

function report({ days } = {}) {
  const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const rows = db
    .prepare(
      `SELECT COALESCE(u.signup_source, ?) AS source,
              u.signup_campaign AS campaign,
              COUNT(*) AS signups,
              SUM(CASE WHEN u.plan IN ('individual', 'pro') OR t.plan = 'team' THEN 1 ELSE 0 END) AS paid,
              MAX(u.created_at) AS last_at
         FROM users u
         LEFT JOIN team_members tm ON tm.user_id = u.id
         LEFT JOIN teams t ON t.id = tm.team_id
        WHERE u.created_at >= ?
        GROUP BY source, campaign
        ORDER BY signups DESC, paid DESC, source`
    )
    .all(UNTRACKED, since);

  // The chart axis is the channel; campaigns are the drill-down under it.
  const bySource = new Map();
  for (const r of rows) {
    const cur = bySource.get(r.source) || { source: r.source, signups: 0, paid: 0, last_at: 0, campaigns: [] };
    cur.signups += r.signups;
    cur.paid += r.paid;
    cur.last_at = Math.max(cur.last_at, r.last_at);
    if (r.campaign) cur.campaigns.push({ campaign: r.campaign, signups: r.signups, paid: r.paid });
    bySource.set(r.source, cur);
  }
  const sources = [...bySource.values()].sort((a, b) => b.signups - a.signups || b.paid - a.paid);
  return {
    sources,
    totals: {
      signups: sources.reduce((n, s) => n + s.signups, 0),
      paid: sources.reduce((n, s) => n + s.paid, 0),
    },
  };
}

module.exports = {
  middleware, read, clear, report,
  COOKIE, MAX_AGE_DAYS, UNTRACKED, capture, encode, decode,
};
