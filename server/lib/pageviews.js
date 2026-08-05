// Aggregate page-view counts — the traffic line under the signup attribution
// card.
//
// The companion to lib/attribution.js, and held to the same promise. That
// module answers "which channel produced this signup"; this one answers "how
// many people looked at the site at all", which is the denominator you need
// before a signup count means anything.
//
// It stays a non-tracker by storing a tally rather than a visitor: one row per
// UTC day holding a number. No visitor id, no session, no path, no user agent,
// no referrer — two views on the same day are indistinguishable from one person
// reloading, and that is the deliberate limit of what this number can tell you.
// Nothing here can be traced back to a person, so there is nothing to expire,
// export, or delete on request.
const { db } = require('../db');
const { readSession } = require('./session');

const DAY_MS = 24 * 60 * 60 * 1000;
// Past this many days the graph switches to weekly buckets: 400 daily columns
// in a 780px chart is a texture, not a series.
const MAX_DAILY_BUCKETS = 90;

// Crawlers outnumber people on a small site, and a graph that counts them
// answers a question nobody asked. This is a filter, not a defence — anything
// determined to look like a browser will be counted, which is fine, because
// nothing is gated on the number.
const BOT = /bot\b|bot\/|crawl|spider|slurp|curl\/|wget|python-requests|scrapy|headless|lighthouse|monitor|uptime|preview|facebookexternalhit|feedfetcher/i;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

const bump = db.prepare(
  `INSERT INTO pageviews (day, views) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET views = views + 1`
);

// Counts one visit. Called from the attribution middleware, which has already
// narrowed this to GET requests for HTML on the dashboard origin.
//
// Signed-in requests are skipped on purpose: a logged-in page load is somebody
// using the product, not somebody discovering it, and the operator's own
// dashboard refreshes would otherwise drown out the traffic being measured.
function record(req) {
  const ua = req.headers['user-agent'];
  if (!ua || BOT.test(ua)) return;
  if (readSession(req)) return;
  bump.run(dayKey(Date.now()));
}

// The graph's series: one bucket per day (or per week over a long window),
// zero-filled, oldest first.
//
// `since` is the first day ever counted. The card needs it because view
// counting started long after signups did — without it, an "all time" window
// invites reading a handful of views against years of signups.
function series({ days } = {}) {
  const first = db.prepare('SELECT MIN(day) AS d FROM pageviews').get().d;
  const today = dayKey(Date.now());
  const start = days ? dayKey(Date.now() - (days - 1) * DAY_MS) : first || today;

  const counts = new Map();
  for (const r of db.prepare('SELECT day, views FROM pageviews WHERE day >= ?').all(start)) {
    counts.set(r.day, r.views);
  }

  // Every day in the window, present or not: a gap in a time series has to be
  // drawn as a zero, not closed up.
  const daily = [];
  for (let t = Date.parse(start + 'T00:00:00Z'); dayKey(t) <= today; t += DAY_MS) {
    const day = dayKey(t);
    daily.push({ start: day, end: day, views: counts.get(day) || 0 });
  }

  let buckets = daily;
  let bucket = 'day';
  if (daily.length > MAX_DAILY_BUCKETS) {
    // Grouped from the end, so the newest bucket is always a full week's worth
    // of the most recent days rather than a stub that reads as a collapse. The
    // leftover at the *oldest* end can be a partial week, which is why every
    // bucket carries its own start and end for the axis and tooltip to show —
    // a short bar there is a short week, not a quiet one.
    bucket = 'week';
    buckets = [];
    for (let i = daily.length; i > 0; i -= 7) {
      const week = daily.slice(Math.max(0, i - 7), i);
      buckets.unshift({
        start: week[0].start,
        end: week[week.length - 1].end,
        views: week.reduce((n, d) => n + d.views, 0),
      });
    }
  }

  return {
    bucket,
    buckets,
    since: first,
    total: daily.reduce((n, d) => n + d.views, 0),
  };
}

module.exports = { record, series, dayKey, BOT };
