const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-test-'));
process.env.INTEGRAL_MIN_DURATION_MS = '400';

const app = require('../server/app');

let server;
let base;
let cookie; // dev-user session for the dev-facing API (testee surface stays anonymous)

async function login(loginName, plan) {
  const res = await fetch(
    `${base}/auth/dev?login=${loginName}${plan ? `&plan=${plan}` : ''}`,
    { headers: { Accept: 'application/json' }, redirect: 'manual' }
  );
  return res.headers.getSetCookie()[0].split(';')[0];
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  cookie = await login('dev');
});

after(() => {
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

const DEMO_HTML = `<!DOCTYPE html><html><body>
<h1>Demo</h1>
<input id="email" type="text">
<button id="buy">Buy now</button>
</body></html>`;

async function api(method, p, body, asCookie) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Cookie: asCookie || cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function createHtmlTest(name, asCookie) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('html', DEMO_HTML);
  const res = await fetch(base + '/api/tests', {
    method: 'POST',
    body: fd,
    headers: { Cookie: asCookie || cookie },
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function launch(id, overrides) {
  const { status, json } = await api('PATCH', `/api/tests/${id}`, {
    task_prompt: 'Buy the thing',
    success_type: 'click',
    success_selector: '#buy',
    success_label: 'Buy now',
    status: 'live',
    ...overrides,
  });
  assert.equal(status, 200);
  return json;
}

// Simulates what the taker shell + injected recorder do over HTTP.
async function runSession(testId, { successful = true, interactions = 3, waitMs = 500, seq = null, ua = 'test-agent', signalHits = null } = {}) {
  const start = await fetch(`${base}/api/take/${testId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({}),
  });
  if (start.status !== 200) return { startStatus: start.status, error: (await start.json()).error };
  const { sessionId } = await start.json();
  const sp = `/api/take/${testId}/sessions/${sessionId}`;

  await api('POST', `${sp}/events`, {
    events: [
      { type: 4, data: { width: 1280, height: 800 }, timestamp: Date.now() },
      { type: 2, data: { node: {} }, timestamp: Date.now() },
    ],
  });
  if (interactions > 0) {
    await api('POST', `${sp}/interactions`, {
      items: Array.from({ length: interactions }, (_, i) => ({
        kind: 'click', x: 100 + i, y: 200, vw: 1280, vh: 800, dh: 1600, t: 100 * i, page: 'index.html',
      })),
    });
  }
  await new Promise((r) => setTimeout(r, waitMs));
  const fin = await api('POST', `${sp}/finish`, { success: successful, gaveUp: false, signalHits });
  if (seq) await api('POST', `${sp}/seq`, seq);
  return { sessionId, finishStatus: fin.json.status };
}

// ---------------------------------------------------------------------------

test('create test from pasted HTML', async () => {
  const t = await createHtmlTest('Paste test');
  assert.equal(t.status, 'draft');
  assert.equal(t.entry_path, 'index.html');
  assert.deepEqual(t.html_files, ['index.html']);
});

test('artifact is served same-origin with recorder injected; preview gets picker; view gets nothing', async () => {
  const t = await createHtmlTest('Injection test');
  const app_ = await (await fetch(`${base}/t/${t.id}/app/index.html`)).text();
  assert.match(app_, /__integral\/recorder\.js/);
  const preview = await (await fetch(`${base}/t/${t.id}/preview/index.html`)).text();
  assert.match(preview, /__integral\/picker\.js/);
  const view = await (await fetch(`${base}/t/${t.id}/view/index.html`)).text();
  assert.doesNotMatch(view, /__integral/);
});

test('path traversal is blocked', async () => {
  const t = await createHtmlTest('Traversal test');
  const res = await fetch(`${base}/t/${t.id}/app/..%2f..%2f..%2fintegral.db`);
  assert.ok([400, 404].includes(res.status), `expected 400/404, got ${res.status}`);
});

test('cannot launch without a task prompt', async () => {
  const t = await createHtmlTest('No prompt');
  const { status, json } = await api('PATCH', `/api/tests/${t.id}`, { status: 'live' });
  assert.equal(status, 400);
  assert.equal(json.error, 'missing_task_prompt');
});

test('sessions are rejected while draft, accepted when live', async () => {
  const t = await createHtmlTest('Lifecycle');
  const before_ = await api('POST', `/api/take/${t.id}/sessions`, {});
  assert.equal(before_.status, 409);
  await launch(t.id);
  const after_ = await api('POST', `/api/take/${t.id}/sessions`, {});
  assert.equal(after_.status, 200);
  assert.ok(after_.json.sessionId);
});

test('full happy path: session with success, SEQ, events, results math', async () => {
  const t = await createHtmlTest('Happy path');
  await launch(t.id);

  const s1 = await runSession(t.id, { successful: true, seq: { score: 6, comment: 'easy!' }, ua: 'ua-1' });
  assert.equal(s1.finishStatus, 'completed');
  const s2 = await runSession(t.id, { successful: false, seq: { score: 2, comment: 'confusing' }, ua: 'ua-2' });
  assert.equal(s2.finishStatus, 'completed');

  const { json: r } = await api('GET', `/api/tests/${t.id}/results`);
  assert.equal(r.sampleLabel, 'unscreened sample');
  assert.equal(r.metrics.completed, 2);
  assert.equal(r.metrics.succeeded, 1);
  assert.equal(r.metrics.successRate, 0.5);
  assert.ok(r.metrics.medianTimeMs >= 400);
  assert.equal(r.metrics.seqDist[5], 1); // one 6
  assert.equal(r.metrics.seqDist[1], 1); // one 2
  assert.equal(r.comments.length, 2);

  // replay events round-trip
  const { json: ev } = await api('GET', `/api/tests/${t.id}/sessions/${s1.sessionId}/events`);
  assert.equal(ev.events.length, 2);
  assert.equal(ev.events[0].type, 4);
});

test('junk filter: too-fast sessions and zero-interaction sessions are discarded', async () => {
  const t = await createHtmlTest('Junk filter');
  await launch(t.id);
  const fast = await runSession(t.id, { waitMs: 0, ua: 'ua-fast' });
  assert.equal(fast.finishStatus, 'discarded');
  const idle = await runSession(t.id, { interactions: 0, ua: 'ua-idle' });
  assert.equal(idle.finishStatus, 'discarded');
  const { json: r } = await api('GET', `/api/tests/${t.id}/results`);
  assert.equal(r.metrics.completed, 0);
  assert.equal(r.metrics.discarded, 2);
  assert.equal(r.metrics.successRate, null);
});

test('fingerprint dedupe: same device cannot complete twice', async () => {
  const t = await createHtmlTest('Dedupe');
  await launch(t.id);
  const first = await runSession(t.id, { ua: 'same-device' });
  assert.equal(first.finishStatus, 'completed');
  const second = await runSession(t.id, { ua: 'same-device' });
  assert.equal(second.startStatus, 409);
  assert.equal(second.error, 'already_participated');
  const other = await runSession(t.id, { ua: 'different-device' });
  assert.equal(other.finishStatus, 'completed');
});

test('fingerprint dedupe resets when the developer relaunches the test', async () => {
  const t = await createHtmlTest('Dedupe relaunch');
  await launch(t.id);
  const first = await runSession(t.id, { ua: 'same-device' });
  assert.equal(first.finishStatus, 'completed');
  const blocked = await runSession(t.id, { ua: 'same-device' });
  assert.equal(blocked.startStatus, 409);
  assert.equal(blocked.error, 'already_participated');

  // Developer edits something and hits "Save & launch" again.
  await launch(t.id, { task_prompt: 'Buy the updated thing' });
  const retake = await runSession(t.id, { ua: 'same-device' });
  assert.equal(retake.finishStatus, 'completed');
});

test('roam and post-test-notes toggles surface on the take-config endpoint', async () => {
  const t = await createHtmlTest('Roam config');
  await launch(t.id, { roam_enabled: true, notes_enabled: true });
  const config = await (await fetch(`${base}/api/take/${t.id}/config`)).json();
  assert.equal(config.roamEnabled, true);
  assert.equal(config.notesEnabled, true);
});

test('post-test notes are collected independently of SEQ and show up in results', async () => {
  const t = await createHtmlTest('Notes');
  await launch(t.id, { notes_enabled: true, seq_enabled: false });
  const { json: start } = await api('POST', `/api/take/${t.id}/sessions`, {});
  const sp = `/api/take/${t.id}/sessions/${start.sessionId}`;
  await api('POST', `${sp}/interactions`, {
    items: [{ kind: 'click', x: 1, y: 1, vw: 100, vh: 100, dh: 100, t: 0, page: 'index.html' }],
  });
  await new Promise((r) => setTimeout(r, 500));
  await api('POST', `${sp}/finish`, { success: true, gaveUp: false });
  await api('POST', `${sp}/notes`, { notes: 'Loved the flow, but the button was hard to find.' });

  const { json: results } = await api('GET', `/api/tests/${t.id}/results`);
  assert.equal(results.notes.length, 1);
  assert.equal(results.notes[0].note, 'Loved the flow, but the button was hard to find.');
  const session = results.sessions.find((s) => s.id === start.sessionId);
  assert.equal(session.notes, 'Loved the flow, but the button was hard to find.');
});

test('roam: client-reported task duration is used instead of total session time', async () => {
  const t = await createHtmlTest('Roam duration');
  await launch(t.id, { roam_enabled: true });
  const { json: start } = await api('POST', `/api/take/${t.id}/sessions`, {});
  const sp = `/api/take/${t.id}/sessions/${start.sessionId}`;
  await api('POST', `${sp}/interactions`, {
    items: [{ kind: 'click', x: 1, y: 1, vw: 100, vh: 100, dh: 100, t: 0, page: 'index.html' }],
  });
  await new Promise((r) => setTimeout(r, 600)); // stands in for task time + roam time
  const fin = await api('POST', `${sp}/finish`, { success: true, gaveUp: false, taskDurationMs: 450 });
  assert.equal(fin.json.status, 'completed');
  const { json: results } = await api('GET', `/api/tests/${t.id}/results`);
  const session = results.sessions.find((s) => s.id === start.sessionId);
  assert.ok(session.durationMs >= 450 && session.durationMs < 550, `expected ~450ms, got ${session.durationMs}`);
});

test('roam: an out-of-range task duration falls back to total elapsed time', async () => {
  const t = await createHtmlTest('Roam duration clamp');
  await launch(t.id, { roam_enabled: true });
  const { json: start } = await api('POST', `/api/take/${t.id}/sessions`, {});
  const sp = `/api/take/${t.id}/sessions/${start.sessionId}`;
  await api('POST', `${sp}/interactions`, {
    items: [{ kind: 'click', x: 1, y: 1, vw: 100, vh: 100, dh: 100, t: 0, page: 'index.html' }],
  });
  await new Promise((r) => setTimeout(r, 500));
  const fin = await api('POST', `${sp}/finish`, { success: true, gaveUp: false, taskDurationMs: 999999 });
  assert.equal(fin.json.status, 'completed');
  const { json: results } = await api('GET', `/api/tests/${t.id}/results`);
  const session = results.sessions.find((s) => s.id === start.sessionId);
  assert.ok(session.durationMs >= 500 && session.durationMs < 999999, `expected elapsed fallback, got ${session.durationMs}`);
});

test('response cap auto-closes the test', async () => {
  const t = await createHtmlTest('Cap');
  await launch(t.id, { response_cap: 2 });
  await runSession(t.id, { ua: 'cap-1' });
  await runSession(t.id, { ua: 'cap-2' });
  const { json: after_ } = await api('GET', `/api/tests/${t.id}`);
  assert.equal(after_.status, 'closed');
  const blocked = await runSession(t.id, { ua: 'cap-3' });
  assert.equal(blocked.startStatus, 409);
  const config = await (await fetch(`${base}/api/take/${t.id}/config`)).json();
  assert.equal(config.open, false);
});

test('screen-based success config round-trips', async () => {
  const t = await createHtmlTest('Screen success');
  const { json } = await api('PATCH', `/api/tests/${t.id}`, {
    task_prompt: 'Reach the done page',
    success_type: 'screen',
    success_screen: 'done.html',
    status: 'live',
  });
  assert.equal(json.success_type, 'screen');
  const config = await (await fetch(`${base}/api/take/${t.id}/config`)).json();
  assert.equal(config.successType, 'screen');
  assert.equal(config.successScreen, 'done.html');
});

test('invalid success_type is rejected, not silently persisted', async () => {
  const t = await createHtmlTest('Bad success type');
  // 'selector' is a plausible mis-guess of the enum; the recorder only acts on
  // 'click' and 'screen', so persisting anything else silently breaks
  // success detection (task never terminates for the testee).
  const { status, json } = await api('PATCH', `/api/tests/${t.id}`, {
    task_prompt: 'Book desk B4 for Tuesday.',
    success_type: 'selector',
    success_selector: '[data-testid="confirm-booking"]',
    status: 'live',
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'invalid_success_type');
  const { json: after } = await api('GET', `/api/tests/${t.id}`);
  assert.equal(after.success_type, 'click'); // schema default, unchanged
  assert.notEqual(after.status, 'live'); // rejected PATCH applied nothing
});

const CHAIN = [
  { kind: 'click', selector: '[data-testid="desk-B4"]', label: 'Desk B4' },
  { kind: 'value', selector: '#date', value: 'Tue Jul 7', label: 'Date = Tuesday, Jul 7' },
  { kind: 'click', selector: '[data-testid="confirm-booking"]', label: 'Confirm booking' },
];

test('success_signals chain round-trips to test JSON and taker config', async () => {
  const t = await createHtmlTest('Chain roundtrip');
  const { status, json } = await api('PATCH', `/api/tests/${t.id}`, {
    task_prompt: 'Book desk B4 for Tuesday.',
    success_signals: CHAIN,
    status: 'live',
  });
  assert.equal(status, 200);
  assert.deepEqual(json.signals, CHAIN);
  const config = await (await fetch(`${base}/api/take/${t.id}/config`)).json();
  assert.deepEqual(config.signals, CHAIN);
});

test('invalid success_signals are rejected, not persisted', async () => {
  const t = await createHtmlTest('Bad chains');
  for (const bad of [
    [], // empty chain
    'not-an-array',
    [{ kind: 'hover', selector: '#x' }], // unknown kind
    [{ kind: 'click' }], // click without selector
    [{ kind: 'value', selector: '#date' }], // value without value
    [{ kind: 'screen' }], // screen without path
  ]) {
    const { status, json } = await api('PATCH', `/api/tests/${t.id}`, { success_signals: bad });
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(json.error, 'invalid_success_signals');
  }
  const { json: after } = await api('GET', `/api/tests/${t.id}`);
  assert.equal(after.success_signals, null);
});

test('legacy single-target tests synthesize a one-signal chain', async () => {
  const t = await createHtmlTest('Legacy synth');
  await launch(t.id); // legacy flat fields: click #buy
  const config = await (await fetch(`${base}/api/take/${t.id}/config`)).json();
  assert.deepEqual(config.signals, [{ kind: 'click', selector: '#buy', label: 'Buy now' }]);
});

test('cannot launch without any success signal', async () => {
  const t = await createHtmlTest('No signal');
  const { status, json } = await api('PATCH', `/api/tests/${t.id}`, {
    task_prompt: 'Do the thing',
    status: 'live',
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'missing_success_signal');
});

test('signal hits persist via finish and abandon and feed the chain funnel', async () => {
  const t = await createHtmlTest('Chain funnel');
  await api('PATCH', `/api/tests/${t.id}`, {
    task_prompt: 'Book desk B4 for Tuesday.',
    success_signals: CHAIN,
    status: 'live',
  });

  // Full chain, success.
  await runSession(t.id, { ua: 'chain-1', signalHits: [{ i: 0, t: 900 }, { i: 1, t: 1400 }, { i: 2, t: 2100 }] });
  // Got the desk, never the date: partial, unsuccessful.
  await runSession(t.id, { ua: 'chain-2', successful: false, signalHits: [{ i: 0, t: 700 }] });
  // Abandoned mid-task after hitting the first step (tab closed → beacon).
  const start = await fetch(`${base}/api/take/${t.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'chain-3' },
    body: JSON.stringify({}),
  });
  const { sessionId } = await start.json();
  await api('POST', `/api/take/${t.id}/sessions/${sessionId}/abandon`, {
    signalHits: [{ i: 0, t: 500 }, { i: 'junk', t: -1 }], // junk entry must be dropped
  });

  const { json: results } = await api('GET', `/api/tests/${t.id}/results`);
  assert.deepEqual(results.metrics.signals.map((s) => s.hit), [3, 1, 1]);
  assert.equal(results.metrics.signals[1].label, 'Date = Tuesday, Jul 7');
  assert.equal(results.metrics.succeeded, 1);
});

test('heatmap endpoint aggregates completed-session interactions by page', async () => {
  const t = await createHtmlTest('Heatmap');
  await launch(t.id);
  await runSession(t.id, { interactions: 5, ua: 'heat-1' });
  const { json } = await api('GET', `/api/tests/${t.id}/heatmap?kind=click&page=index.html`);
  assert.equal(json.points.length, 5);
  assert.deepEqual(json.pages, [{ key: 'index.html', count: 5, representative: 'index.html' }]);
  assert.equal(json.points[0].vw, 1280);
  // Legacy sessions have no nav markers: the snapshot falls back to the
  // moment of the first interaction on the screen.
  assert.ok(json.snapshot && json.snapshot.sessionId);
});

test('heatmap groups dynamic URL segments and picks a nav-marker snapshot', async () => {
  const t = await createHtmlTest('Heatmap grouping');
  await launch(t.id);
  const start = await fetch(`${base}/api/take/${t.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'heat-group' },
    body: JSON.stringify({}),
  });
  const { sessionId } = await start.json();
  const sp = `/api/take/${t.id}/sessions/${sessionId}`;
  const base_ = { x: 10, y: 20, vw: 1280, vh: 800, dh: 1600 };
  await api('POST', `${sp}/interactions`, {
    items: [
      { kind: 'nav', ...base_, t: 0, page: 'event/123' },
      { kind: 'click', ...base_, t: 50, page: 'event/123' },
      { kind: 'click', ...base_, t: 90, page: 'event/123' },
      { kind: 'nav', ...base_, t: 200, page: 'event/456' },
      { kind: 'click', ...base_, t: 250, page: 'event/456' },
      { kind: 'click', ...base_, t: 300, page: 'search' },
      { kind: 'click', ...base_, t: 350, page: 'index.html::Checkout' },
    ],
  });
  await new Promise((r) => setTimeout(r, 500));
  await api('POST', `${sp}/finish`, { success: true, gaveUp: false });

  const { json } = await api('GET', `/api/tests/${t.id}/heatmap?kind=click&page=${encodeURIComponent('event/{id}')}`);
  // event/123 + event/456 aggregate under one normalized key…
  assert.equal(json.points.length, 3); // nav rows excluded from points
  const keys = json.pages.map((p) => p.key);
  assert.ok(keys.includes('event/{id}'));
  // …while route words and DOM-screen keys survive untouched.
  assert.ok(keys.includes('search'));
  assert.ok(keys.includes('index.html::Checkout'));
  const group = json.pages.find((p) => p.key === 'event/{id}');
  assert.equal(group.representative, 'event/123'); // most interactions in the group
  // Snapshot anchors at the earliest nav marker into the group (+500ms settle).
  assert.equal(json.snapshot.sessionId, sessionId);
  const { json: results } = await api('GET', `/api/tests/${t.id}/results`);
  const sess = results.sessions.find((s) => s.id === sessionId);
  assert.equal(json.snapshot.at - sess.startedAt, 0 + 500);
});

test('nav markers do not count as interactions for junk filtering', async () => {
  const t = await createHtmlTest('Nav-only session');
  await launch(t.id);
  const start = await fetch(`${base}/api/take/${t.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'nav-only' },
    body: JSON.stringify({}),
  });
  const { sessionId } = await start.json();
  const sp = `/api/take/${t.id}/sessions/${sessionId}`;
  await api('POST', `${sp}/interactions`, {
    items: [{ kind: 'nav', x: 0, y: 0, vw: 1280, vh: 800, dh: 1600, t: 0, page: 'index.html' }],
  });
  await new Promise((r) => setTimeout(r, 500));
  const fin = await api('POST', `${sp}/finish`, { success: false, gaveUp: false });
  // A session that only loaded the page (nav marker, no activity) is still junk.
  assert.equal(fin.json.status, 'discarded');
});

// ---------------------------------------------------------------------------
// Go-to-market layer: auth, ownership, plan gates, exports, abuse reports.

test('dev-facing API requires auth; testee surface stays anonymous', async () => {
  const t = await createHtmlTest('Auth gate');
  await launch(t.id);
  for (const p of ['/api/tests', `/api/tests/${t.id}`, `/api/tests/${t.id}/results`, '/api/me']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 401, `${p} must 401 without a session`);
  }
  // Anonymous testee flow still works with no cookie at all.
  const config = await (await fetch(`${base}/api/take/${t.id}/config`)).json();
  assert.equal(config.open, true);
});

test('tests are scoped to their owner', async () => {
  const t = await createHtmlTest('Mine');
  const otherCookie = await login('intruder');
  for (const [method, p] of [
    ['GET', `/api/tests/${t.id}`],
    ['PATCH', `/api/tests/${t.id}`],
    ['DELETE', `/api/tests/${t.id}`],
    ['GET', `/api/tests/${t.id}/results`],
  ]) {
    const { status } = await api(method, p, method === 'PATCH' ? { name: 'stolen' } : undefined, otherCookie);
    assert.equal(status, 404, `${method} ${p} must 404 for a non-owner`);
  }
  const { json: list } = await api('GET', '/api/tests', undefined, otherCookie);
  assert.ok(!list.some((x) => x.id === t.id));
  const { json: mine } = await api('GET', `/api/tests/${t.id}`);
  assert.equal(mine.name, 'Mine'); // untouched
});

test('free plan allows one live test at a time', async () => {
  const freeCookie = await login('freeuser', 'free');
  const a = await createHtmlTest('Free A', freeCookie);
  const b = await createHtmlTest('Free B', freeCookie);
  const launchBody = { task_prompt: 'x', success_selector: '#buy', status: 'live' };
  const first = await api('PATCH', `/api/tests/${a.id}`, launchBody, freeCookie);
  assert.equal(first.status, 200);
  const second = await api('PATCH', `/api/tests/${b.id}`, launchBody, freeCookie);
  assert.equal(second.status, 403);
  assert.equal(second.json.error, 'plan_limit_active_tests');
  // Closing A frees the slot.
  await api('PATCH', `/api/tests/${a.id}`, { status: 'closed' }, freeCookie);
  const retry = await api('PATCH', `/api/tests/${b.id}`, launchBody, freeCookie);
  assert.equal(retry.status, 200);
});

test('artifact size is capped by plan (uncompressed)', async () => {
  const freeCookie = await login('freeuser2', 'free');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<html><body>big</body></html>'));
  zip.addFile('blob.bin', Buffer.alloc(11 * 1024 * 1024)); // 11 MB of zeros → tiny zip
  const fd = new FormData();
  fd.append('name', 'Too big');
  fd.append('zip', new Blob([zip.toBuffer()]), 'big.zip');
  const res = await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: freeCookie } });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'artifact_too_large');
});

test('monthly response cap closes the door across all of an owner\'s tests', async () => {
  const freeCookie = await login('freeuser3', 'free');
  const t = await createHtmlTest('Monthly cap', freeCookie);
  await api('PATCH', `/api/tests/${t.id}`, {
    task_prompt: 'x', success_selector: '#buy', response_cap: 100, status: 'live',
  }, freeCookie);
  // Simulate a month of usage directly (25 = the free plan's responsesPerMonth).
  const { db } = require('../server/db');
  const ins = db.prepare(
    "INSERT INTO sessions (id, test_id, status, started_at) VALUES (?, ?, 'completed', ?)"
  );
  for (let i = 0; i < 25; i++) ins.run(`fake-mo-${i}`, t.id, Date.now());
  const blocked = await fetch(`${base}/api/take/${t.id}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'closed');
});

test('sample test is pre-configured and launchable as-is', async () => {
  const { status, json: t } = await api('POST', '/api/tests/sample');
  assert.equal(status, 200);
  assert.ok(t.html_files.includes('cart.html'));
  assert.equal(t.signals[0].selector, '#checkout');
  const launched = await api('PATCH', `/api/tests/${t.id}`, { status: 'live' });
  assert.equal(launched.status, 200);
  assert.equal(launched.json.status, 'live');
});

test('results export as CSV and JSON', async () => {
  const t = await createHtmlTest('Export');
  await launch(t.id);
  await runSession(t.id, { seq: { score: 5, comment: 'has,comma "quotes"' }, ua: 'export-ua' });
  const csvRes = await fetch(`${base}/api/tests/${t.id}/export.csv`, { headers: { Cookie: cookie } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csv = await csvRes.text();
  assert.match(csv.split('\n')[0], /^id,status,success/);
  assert.match(csv, /"has,comma ""quotes"""/);
  const { json } = await api('GET', `/api/tests/${t.id}/export.json`);
  assert.equal(json.metrics.completed, 1);
});

test('anyone can report a test; the report is stored', async () => {
  const t = await createHtmlTest('Reportable');
  await launch(t.id);
  const res = await fetch(`${base}/api/take/${t.id}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'testee_flag', detail: 'looks like phishing' }),
  });
  assert.equal(res.status, 200);
  const { db } = require('../server/db');
  const row = db.prepare('SELECT * FROM reports WHERE test_id = ?').get(t.id);
  assert.equal(row.detail, 'looks like phishing');
});

test('deleting a test removes its artifact dir and event files', async () => {
  const t = await createHtmlTest('Purge');
  await launch(t.id);
  const s = await runSession(t.id, { ua: 'purge-ua' });
  const dataDir = process.env.INTEGRAL_DATA_DIR;
  const artifactDir = path.join(dataDir, 'artifacts', t.id);
  const eventFile = path.join(dataDir, 'events', s.sessionId + '.jsonl');
  assert.ok(fs.existsSync(artifactDir));
  assert.ok(fs.existsSync(eventFile));
  await api('DELETE', `/api/tests/${t.id}`);
  assert.ok(!fs.existsSync(artifactDir));
  assert.ok(!fs.existsSync(eventFile));
});

test('account deletion wipes the user and everything they own', async () => {
  const doomedCookie = await login('doomed');
  const t = await createHtmlTest('Doomed test', doomedCookie);
  const del = await fetch(base + '/api/account', { method: 'DELETE', headers: { Cookie: doomedCookie } });
  assert.equal(del.status, 200);
  const { db } = require('../server/db');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE login = 'doomed'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tests WHERE id = ?').get(t.id).n, 0);
  // The old cookie is now useless.
  const after = await fetch(base + '/api/me', { headers: { Cookie: doomedCookie } });
  assert.equal(after.status, 401);
});

test('billing endpoints degrade cleanly when Stripe is not configured', async () => {
  const { status, json } = await api('POST', '/api/billing/checkout');
  assert.equal(status, 503);
  assert.equal(json.error, 'billing_not_configured');
});

test('abandon marks end time but leaves session as drop-off', async () => {
  const t = await createHtmlTest('Abandon');
  await launch(t.id);
  const start = await api('POST', `/api/take/${t.id}/sessions`, {});
  const sid = start.json.sessionId;
  await api('POST', `/api/take/${t.id}/sessions/${sid}/abandon`, {});
  const { json: r } = await api('GET', `/api/tests/${t.id}/results`);
  assert.equal(r.metrics.abandoned, 1);
  assert.equal(r.metrics.completed, 0);
});

// ---------- landing page (session-aware front door) ----------

test('logged-out / serves the landing page, uncached', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  assert.match(body, /Usability tests for the slice you just built/);
  assert.ok(!body.includes('id="main"'));
});

test('logged-in / serves the dashboard, uncached', async () => {
  const res = await fetch(base + '/', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  assert.ok(body.includes('id="main"'));
  assert.ok(!body.includes('Usability tests for the slice you just built'));
});
