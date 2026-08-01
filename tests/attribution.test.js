const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-test-'));

const app = require('../server/app');
const { db } = require('../server/db');
const attribution = require('../server/lib/attribution');
const { upsertUser } = require('../server/lib/auth');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://localhost:' + server.address().port;
      resolve();
    });
  });
});

after(() => {
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

const HTML = { Accept: 'text/html' };

// The Set-Cookie for the attribution cookie, decoded back to the record.
function attrFrom(res) {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(attribution.COOKIE + '='));
  if (!set) return null;
  return attribution.decode(set.slice(attribution.COOKIE.length + 1).split(';')[0]);
}

test('a tagged landing page view stamps source and campaign', async () => {
  const res = await fetch(base + '/?utm_source=Reddit&utm_campaign=Launch-Post', {
    headers: HTML,
    redirect: 'manual',
  });
  const rec = attrFrom(res);
  assert.equal(rec.s, 'reddit', 'source is normalized to lowercase');
  assert.equal(rec.c, 'launch-post');
});

test('an off-site referrer counts as its own channel', async () => {
  const res = await fetch(base + '/', {
    headers: { ...HTML, Referer: 'https://www.news.ycombinator.com/item?id=1' },
    redirect: 'manual',
  });
  assert.equal(attrFrom(res).s, 'news.ycombinator.com', 'www. is stripped');
});

test('an untagged, unreferred visit is recorded as direct', async () => {
  const res = await fetch(base + '/', { headers: HTML, redirect: 'manual' });
  assert.equal(attrFrom(res).s, 'direct');
});

test('first touch wins — a later visit does not overwrite the cookie', async () => {
  const first = attribution.encode({ s: 'reddit', t: Date.now() });
  const res = await fetch(base + '/?utm_source=twitter', {
    headers: { ...HTML, Cookie: attribution.COOKIE + '=' + first },
    redirect: 'manual',
  });
  assert.equal(attrFrom(res), null, 'no Set-Cookie at all once a touch is recorded');
});

test('non-page requests do not stamp anything', async () => {
  const res = await fetch(base + '/style.css?utm_source=reddit', { redirect: 'manual' });
  assert.equal(attrFrom(res), null);
});

test('attribution is written on signup only, never on a later sign-in', () => {
  const u = upsertUser({
    githubId: 'gh:attr1',
    login: 'attr1',
    attribution: { source: 'reddit', campaign: 'launch-post' },
  });
  assert.equal(u.signup_source, 'reddit');
  assert.equal(u.signup_campaign, 'launch-post');

  // Same GitHub id arriving through a different ad later: the channel that
  // actually acquired them must stick.
  const again = upsertUser({
    githubId: 'gh:attr1',
    login: 'attr1',
    attribution: { source: 'twitter', campaign: 'retarget' },
  });
  assert.equal(again.signup_source, 'reddit');
  assert.equal(again.signup_campaign, 'launch-post');
});

test('the report groups by channel and counts paid entitlements', () => {
  db.prepare('DELETE FROM users').run();
  const mk = (login, source, campaign, plan) => {
    const u = upsertUser({ githubId: 'gh:' + login, login, attribution: source ? { source, campaign } : null });
    if (plan) db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, u.id);
    return u;
  };
  mk('a', 'reddit', 'launch-post', 'individual');
  mk('b', 'reddit', 'launch-post');
  mk('c', 'reddit', 'sidebar-ad');
  mk('d', 'direct', null, 'pro');
  mk('e', null, null); // predates tracking

  const rep = attribution.report({});
  assert.equal(rep.totals.signups, 5);
  assert.equal(rep.totals.paid, 2);

  const reddit = rep.sources.find((s) => s.source === 'reddit');
  assert.equal(reddit.signups, 3);
  assert.equal(reddit.paid, 1);
  assert.deepEqual(
    reddit.campaigns.map((c) => c.campaign).sort(),
    ['launch-post', 'sidebar-ad'],
    'campaigns survive as the drill-down under the channel'
  );
  assert.equal(rep.sources[0].source, 'reddit', 'busiest channel sorts first');
  assert.ok(
    rep.sources.some((s) => s.source === attribution.UNTRACKED),
    'accounts with no source are reported, not dropped'
  );

  // 'unlimited' is the internal comp grant and must not inflate conversions.
  mk('f', 'reddit', 'launch-post', 'unlimited');
  assert.equal(attribution.report({}).totals.paid, 2);
});

test('a paying team member counts as a conversion for their channel', () => {
  db.prepare('DELETE FROM users').run();
  const u = upsertUser({ githubId: 'gh:t1', login: 't1', attribution: { source: 'podcast', campaign: null } });
  const t = db
    .prepare("INSERT INTO teams (name, owner_user_id, plan, created_at) VALUES ('T', ?, 'team', ?)")
    .run(u.id, Date.now());
  db.prepare('INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(t.lastInsertRowid, u.id, 'member', Date.now());

  const rep = attribution.report({});
  assert.equal(rep.sources.find((s) => s.source === 'podcast').paid, 1);
});

test('the report is refused to everyone but unlimited accounts', async () => {
  const anon = await fetch(base + '/api/attribution');
  assert.equal(anon.status, 401);

  const free = await fetch(base + '/auth/dev?login=freeuser&plan=free', {
    headers: { Accept: 'application/json' },
  });
  const cookie = free.headers.getSetCookie().join('; ');
  const denied = await fetch(base + '/api/attribution', { headers: { Cookie: cookie } });
  assert.equal(denied.status, 403);

  const op = await fetch(base + '/auth/dev?login=op&plan=unlimited', {
    headers: { Accept: 'application/json' },
  });
  const allowed = await fetch(base + '/api/attribution', {
    headers: { Cookie: op.headers.getSetCookie().join('; ') },
  });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray((await allowed.json()).sources));
});
