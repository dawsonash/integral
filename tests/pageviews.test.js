const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-test-'));

const app = require('../server/app');
const { db } = require('../server/db');
const pageviews = require('../server/lib/pageviews');

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

beforeEach(() => db.prepare('DELETE FROM pageviews').run());

const BROWSER = {
  Accept: 'text/html',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
};

function today() {
  return pageviews.dayKey(Date.now());
}

function counted() {
  const row = db.prepare('SELECT views FROM pageviews WHERE day = ?').get(today());
  return row ? row.views : 0;
}

// A day this far back is always outside a 7-day window and always inside a
// 90-day one, whatever time of day the suite runs at.
function daysAgo(n) {
  return pageviews.dayKey(Date.now() - n * 24 * 60 * 60 * 1000);
}

function seed(day, views) {
  db.prepare('INSERT INTO pageviews (day, views) VALUES (?, ?)').run(day, views);
}

test('every page view is counted, including a repeat visit', async () => {
  await fetch(base + '/', { headers: BROWSER, redirect: 'manual' });
  assert.equal(counted(), 1);

  // The first-touch cookie stops at one; the traffic tally must not — a second
  // look is a second view.
  await fetch(base + '/', { headers: BROWSER, redirect: 'manual' });
  assert.equal(counted(), 2);
});

test('assets and API calls are not page views', async () => {
  await fetch(base + '/style.css', { headers: { 'User-Agent': BROWSER['User-Agent'] } });
  await fetch(base + '/api/attribution', { headers: { 'User-Agent': BROWSER['User-Agent'] } });
  assert.equal(counted(), 0);
});

test('crawlers and unattributed scripts are left out', async () => {
  for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'curl/8.4.0', 'python-requests/2.31']) {
    await fetch(base + '/', { headers: { ...BROWSER, 'User-Agent': ua }, redirect: 'manual' });
  }
  assert.equal(counted(), 0, 'known bots');

  // fetch() always sends a UA of its own, so the no-UA case is asserted against
  // the filter directly rather than over the wire.
  assert.equal(pageviews.BOT.test('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/126'), true);
});

test('a signed-in page load is product use, not traffic', async () => {
  const login = await fetch(base + '/auth/dev?login=trafficop&plan=unlimited', {
    headers: { Accept: 'application/json' },
  });
  const cookie = login.headers.getSetCookie().join('; ');
  db.prepare('DELETE FROM pageviews').run();

  await fetch(base + '/', { headers: { ...BROWSER, Cookie: cookie }, redirect: 'manual' });
  assert.equal(counted(), 0);

  // Same request without the session: a logged-out visitor on the same browser.
  await fetch(base + '/', { headers: BROWSER, redirect: 'manual' });
  assert.equal(counted(), 1);
});

test('the series zero-fills the window and reports where counting began', () => {
  seed(daysAgo(3), 5);
  seed(today(), 2);

  const s = pageviews.series({ days: 7 });
  assert.equal(s.bucket, 'day');
  assert.equal(s.buckets.length, 7, 'one bucket per day in the window');
  assert.equal(s.total, 7);
  assert.equal(s.buckets[s.buckets.length - 1].start, today(), 'newest day is last');
  assert.equal(s.buckets.find((b) => b.start === daysAgo(3)).views, 5);
  assert.equal(s.buckets.filter((b) => b.views === 0).length, 5, 'quiet days are drawn, not dropped');
  assert.equal(s.since, daysAgo(3), 'first day ever counted');
});

test('a window shorter than the record excludes the days outside it', () => {
  seed(daysAgo(30), 100);
  seed(today(), 4);

  assert.equal(pageviews.series({ days: 7 }).total, 4);
  assert.equal(pageviews.series({ days: 60 }).total, 104);
  assert.equal(pageviews.series({}).total, 104, 'no window means all time');
});

test('a long window switches to weekly buckets ending today', () => {
  seed(daysAgo(200), 3);
  seed(today(), 6);

  const s = pageviews.series({});
  assert.equal(s.bucket, 'week');
  assert.ok(s.buckets.length < 40, 'buckets collapse rather than drawing 200 columns');
  assert.equal(s.total, 9, 'collapsing buckets does not lose views');
  const last = s.buckets[s.buckets.length - 1];
  assert.equal(last.end, today());
  assert.equal(last.views, 6);
  assert.equal(last.start, daysAgo(6), 'the newest bucket is a full week, not a stub');
});

test('the operator report carries traffic on the same window', async () => {
  seed(today(), 3);
  const op = await fetch(base + '/auth/dev?login=viewop&plan=unlimited', {
    headers: { Accept: 'application/json' },
  });
  const res = await fetch(base + '/api/attribution?days=7', {
    headers: { Cookie: op.headers.getSetCookie().join('; ') },
  });
  const j = await res.json();
  assert.equal(j.views.total, 3);
  assert.equal(j.views.buckets.length, 7);
  assert.ok(Array.isArray(j.sources), 'the signup report is still there');
});
