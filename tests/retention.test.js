// The retention sweep enforces plan retention windows (sessions + event files),
// expires free-tier live links, and clears orphaned files. Runs against its own
// data dir; the sweep is never scheduled inside tests (index.js does that).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-retention-'));

const app = require('../server/app');
const { db, EVENTS_DIR, ARTIFACTS_DIR } = require('../server/db');
const { sweep, DAY_MS } = require('../server/lib/retention');
const { RETENTION_GRACE_DAYS } = require('../server/lib/plans');
const { setUserPlan } = require('../server/routes/billing');

let server;
let base;
let cookie;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  cookie = await freeLogin('freeswept');
});

async function freeLogin(login) {
  const res = await fetch(`${base}/auth/dev?login=${login}&plan=free`, { redirect: 'manual' });
  return res.headers.getSetCookie()[0].split(';')[0];
}

after(() => {
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

async function createLiveTest(name, asCookie = cookie) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('html', '<html><body><button id="b">go</button></body></html>');
  const t = await (await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: asCookie } })).json();
  const patched = await fetch(`${base}/api/tests/${t.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: asCookie },
    body: JSON.stringify({ task_prompt: 'x', success_selector: '#b', status: 'live' }),
  });
  assert.equal((await patched.json()).status, 'live', `${name} must launch`);
  return t;
}

test('sweep deletes sessions past the plan retention window, keeps fresh ones', async () => {
  const t = await createLiveTest('Retention');
  const ins = db.prepare(
    "INSERT INTO sessions (id, test_id, status, started_at) VALUES (?, ?, 'completed', ?)"
  );
  const now = Date.now();
  ins.run('old-session', t.id, now - 20 * DAY_MS); // free retention = 14 days
  ins.run('fresh-session', t.id, now - 2 * DAY_MS);
  fs.writeFileSync(path.join(EVENTS_DIR, 'old-session.jsonl'), '[]\n');
  fs.writeFileSync(path.join(EVENTS_DIR, 'fresh-session.jsonl'), '[]\n');

  const r = sweep(now);
  assert.ok(r.deletedSessions >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'old-session'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'fresh-session'").get().n, 1);
  assert.ok(!fs.existsSync(path.join(EVENTS_DIR, 'old-session.jsonl')));
  assert.ok(fs.existsSync(path.join(EVENTS_DIR, 'fresh-session.jsonl')));
});

test('sweep expires free-tier live links after linkTtlDays', async () => {
  // Own user: the free plan's 1-live-test cap is already used by the test above.
  const t = await createLiveTest('Expiring link', await freeLogin('freeswept2'));
  db.prepare('UPDATE tests SET launched_at = ? WHERE id = ?').run(Date.now() - 15 * DAY_MS, t.id);
  sweep();
  assert.equal(db.prepare('SELECT status FROM tests WHERE id = ?').get(t.id).status, 'closed');
});

// A solo subscriber gets the same runway a team does: volume limits tighten the
// moment the subscription ends, but the data survives the grace window.
test('a lapsed individual keeps paid retention through the grace window', async () => {
  const soloCookie = await freeLogin('lapsedsolo');
  const t = await createLiveTest('Lapsed solo', soloCookie);
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get('lapsedsolo');

  const aged = Date.now() - 60 * DAY_MS; // past free (14d), inside paid (365d)
  db.prepare("INSERT INTO sessions (id, test_id, status, started_at) VALUES (?, ?, 'completed', ?)")
    .run('solo-sess', t.id, aged);
  db.prepare('UPDATE tests SET launched_at = ? WHERE id = ?').run(aged, t.id);

  // They were paying; the subscription ends today.
  db.prepare("UPDATE users SET plan = 'individual' WHERE id = ?").run(user.id);
  setUserPlan(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), 'free', null);
  const lapsedAt = db.prepare('SELECT plan_lapsed_at FROM users WHERE id = ?').get(user.id).plan_lapsed_at;
  assert.ok(lapsedAt, 'the lapse is stamped');

  // Data and the live link both survive the window.
  sweep();
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('solo-sess'), 'kept during grace');
  assert.equal(db.prepare('SELECT status FROM tests WHERE id = ?').get(t.id).status, 'live');

  // /api/me hands the dashboard the deadline to show.
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: soloCookie } })).json();
  assert.equal(me.graceEndsAt, lapsedAt + RETENTION_GRACE_DAYS * DAY_MS);
  assert.equal(me.plan, 'free', 'volume limits tightened immediately');

  // Past the window, the free rules apply.
  sweep(Date.now() + (RETENTION_GRACE_DAYS + 1) * DAY_MS);
  assert.ok(!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('solo-sess'), 'swept after grace');
  assert.equal(db.prepare('SELECT status FROM tests WHERE id = ?').get(t.id).status, 'closed');
});

test('the individual grace clock is stamped once, and unlimited never lapses', async () => {
  const cookie2 = await freeLogin('clocksolo');
  const user = () => db.prepare('SELECT * FROM users WHERE login = ?').get('clocksolo');
  db.prepare("UPDATE users SET plan = 'individual' WHERE id = ?").run(user().id);

  setUserPlan(user(), 'free', null);
  const first = user().plan_lapsed_at;
  assert.ok(first);
  // A replayed webhook must not push the deadline back.
  setUserPlan(user(), 'free', null);
  assert.equal(user().plan_lapsed_at, first, 'clock is not extended');
  // Resubscribing clears it.
  setUserPlan(user(), 'individual', 'sub_x');
  assert.equal(user().plan_lapsed_at, null);
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: cookie2 } })).json();
  assert.equal(me.graceEndsAt, null);

  // A never-paid free account has nothing to grace.
  const never = db.prepare('SELECT * FROM users WHERE login = ?').get('freeswept');
  assert.equal(never.plan_lapsed_at, null);

  // The internal comp grant is untouched by billing events entirely.
  await freeLogin('compaccount');
  const comp = () => db.prepare('SELECT * FROM users WHERE login = ?').get('compaccount');
  db.prepare("UPDATE users SET plan = 'unlimited' WHERE id = ?").run(comp().id);
  setUserPlan(comp(), 'free', null);
  assert.equal(comp().plan, 'unlimited', 'comp grant is never downgraded');
  assert.equal(comp().plan_lapsed_at, null);
});

test('sweep removes orphaned event files and artifact dirs', () => {
  fs.writeFileSync(path.join(EVENTS_DIR, 'ghost-session.jsonl'), '[]\n');
  fs.mkdirSync(path.join(ARTIFACTS_DIR, 'ghosttest99'), { recursive: true });
  const r = sweep();
  assert.ok(r.orphanEventFiles >= 1);
  assert.ok(r.orphanArtifactDirs >= 1);
  assert.ok(!fs.existsSync(path.join(EVENTS_DIR, 'ghost-session.jsonl')));
  assert.ok(!fs.existsSync(path.join(ARTIFACTS_DIR, 'ghosttest99')));
});
