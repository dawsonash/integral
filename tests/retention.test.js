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

test('sweep removes orphaned event files and artifact dirs', () => {
  fs.writeFileSync(path.join(EVENTS_DIR, 'ghost-session.jsonl'), '[]\n');
  fs.mkdirSync(path.join(ARTIFACTS_DIR, 'ghosttest99'), { recursive: true });
  const r = sweep();
  assert.ok(r.orphanEventFiles >= 1);
  assert.ok(r.orphanArtifactDirs >= 1);
  assert.ok(!fs.existsSync(path.join(EVENTS_DIR, 'ghost-session.jsonl')));
  assert.ok(!fs.existsSync(path.join(ARTIFACTS_DIR, 'ghosttest99')));
});
