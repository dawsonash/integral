const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, EVENTS_DIR } = require('../db');
const { newId, fingerprint } = require('../lib/util');
const { serveArtifactFile } = require('../lib/artifacts');
const { mockSnippet } = require('../lib/mocks');
const { isServerTest } = require('../lib/sandbox/classify');
const sandboxes = require('../lib/sandbox/registry');
const { proxyRequest, sandboxErrorPage } = require('../lib/sandbox/proxy');
const { signalsFor } = require('../lib/signals');
const sentiment = require('../lib/sentiment');
const { planFor, scopeFor, monthStart } = require('../lib/plans');
const { sendEmail } = require('../lib/email');
const { sessionLimiter, ingestLimiter, reportLimiter } = require('../lib/ratelimit');

const router = express.Router();

const MIN_DURATION_MS = Number(process.env.INTEGRAL_MIN_DURATION_MS || 3000);

const getTest = db.prepare('SELECT * FROM tests WHERE id = ?');
const completedCount = db.prepare(
  "SELECT COUNT(*) AS n FROM sessions WHERE test_id = ? AND status = 'completed'"
);

function testOr404(req, res, next) {
  const test = getTest.get(req.params.testId);
  if (!test) return res.status(404).send('Test not found');
  req.test = test;
  next();
}

// ---------- artifact serving (same-origin, with injection) ----------

// All modes carry the API-mock shim (in <head>, so it patches fetch/XHR
// before any artifact script fires a request).
//
// Two ways bytes get into /t/:id/…: static tests read files from disk
// (serveArtifactFile); server-rendered tests reverse-proxy a live sandboxed
// app (lib/sandbox). Both inject the same scripts, so everything downstream
// of the iframe — recorder, success chain, heatmap, replay — is unchanged.

async function serveTestee(req, res, mode, injectScript) {
  const rel = (req.params.path || []).join('/');
  const mountPrefix = `/t/${req.test.id}/${mode}/`;
  if (isServerTest(req.test)) {
    try {
      const handle = await sandboxes.ensure(req.test);
      await proxyRequest(req, res, { handle, mountPrefix, injectScript, headScript: mockSnippet(req.test) });
    } catch (e) {
      if (!res.headersSent) res.status(502).type('html').send(sandboxErrorPage(e));
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed');
  serveArtifactFile(res, req.test.id, rel, injectScript, mockSnippet(req.test), mountPrefix);
}

// Taker mode: recorder injected into every HTML screen. `.all` because a
// server-rendered app takes form POSTs, not just GETs.
router.all('/t/:testId/app/{*path}', testOr404, (req, res) =>
  serveTestee(req, res, 'app', '<script src="/__integral/recorder.js"></script>')
);

// Setup preview mode: element picker injected.
router.all('/t/:testId/preview/{*path}', testOr404, (req, res) =>
  serveTestee(req, res, 'preview', '<script src="/__integral/picker.js"></script>')
);

// Plain view (heatmap background): no script injection beyond the mocks.
router.all('/t/:testId/view/{*path}', testOr404, (req, res) =>
  serveTestee(req, res, 'view', '')
);

// Create-form entry preview: a branch snapshot with no test row yet, hosted
// under an unguessable id minted by POST /api/github/preview. Lives on the
// run surface for the same reason tests do — artifact scripts must never
// share an origin with dashboard cookies. No injection: it's a look, not a
// recording.
router.get('/p/:previewId/{*path}', (req, res) => {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(req.params.previewId)) return res.status(404).send('Not found');
  const rel = (req.params.path || []).join('/');
  serveArtifactFile(res, 'preview-' + req.params.previewId, rel, '', '', `/p/${req.params.previewId}/`);
});

// Taker shell — with OG meta so open links unfurl nicely in Slack/Discord/X.
const takeShellPath = path.join(__dirname, '..', '..', 'public', 'take.html');
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
router.get('/t/:testId', testOr404, (req, res) => {
  const name = escapeHtml(req.test.name);
  const meta =
    `<title>${name} — quick usability test</title>\n` +
    `<meta property="og:title" content="${name}">\n` +
    '<meta property="og:description" content="Try a short task in a prototype — takes about 2 minutes. No signup, anything you type is masked.">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta name="twitter:card" content="summary">';
  const html = fs.readFileSync(takeShellPath, 'utf8').replace('<title>Usability test</title>', meta);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ---------- take API ----------

router.get('/api/take/:testId/config', testOr404, (req, res) => {
  const t = req.test;
  const done = completedCount.get(t.id).n;
  res.json({
    testId: t.id,
    name: t.name,
    status: t.status,
    open: t.status === 'live' && done < t.response_cap,
    entryPath: t.entry_path,
    taskPrompt: t.task_prompt,
    signals: signalsFor(t),
    // Deprecated flat fields; the shell/recorder read only `signals`.
    successType: t.success_type,
    successSelector: t.success_selector,
    successScreen: t.success_screen,
    seqEnabled: !!t.seq_enabled,
    notesEnabled: !!t.notes_enabled,
    roamEnabled: !!t.roam_enabled,
    screenerEnabled: !!t.screener_enabled,
    screenerQuestion: t.screener_question,
    unmaskSelectors: (t.unmask_selectors || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
});

// Owner's plan gates the testee surface indirectly: total completed responses
// across all their tests this month. Ownerless (pre-auth) tests skip the gate.
const getOwner = db.prepare('SELECT * FROM users WHERE id = ?');

// Counted over the owner's whole allowance pool — for a team member that's
// every test the team owns, since the monthly cap is shared.
function monthlyResponses(owner) {
  const scope = scopeFor(owner);
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions s JOIN tests t ON t.id = s.test_id
       WHERE ${scope.where} AND s.status = 'completed' AND s.started_at >= ?`
    )
    .get(...scope.args, monthStart()).n;
}

router.post('/api/take/:testId/sessions', sessionLimiter, testOr404, (req, res) => {
  const t = req.test;
  if (t.status !== 'live') return res.status(409).json({ error: 'closed' });
  if (completedCount.get(t.id).n >= t.response_cap) {
    db.prepare("UPDATE tests SET status = 'closed' WHERE id = ?").run(t.id);
    return res.status(409).json({ error: 'closed' });
  }
  const owner = t.user_id ? getOwner.get(t.user_id) : null;
  if (owner && monthlyResponses(owner) >= planFor(owner).responsesPerMonth) {
    return res.status(409).json({ error: 'closed' });
  }
  const fp = fingerprint(req);
  // A prior completed session only blocks a retake if it happened under the
  // test's current launch — relaunching (Save & launch) bumps launched_at,
  // which lets the same device take the edited test again.
  const dup = db
    .prepare(
      "SELECT 1 FROM sessions WHERE test_id = ? AND fingerprint = ? AND status = 'completed' AND started_at >= ?"
    )
    .get(t.id, fp, t.launched_at || 0);
  if (dup) return res.status(409).json({ error: 'already_participated' });
  const id = newId(16);
  db.prepare(
    'INSERT INTO sessions (id, test_id, started_at, fingerprint, screener_answer) VALUES (?, ?, ?, ?, ?)'
  ).run(id, t.id, Date.now(), fp, req.body?.screenerAnswer || null);
  res.json({ sessionId: id });
});

function getSession(req, res, next) {
  const s = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND test_id = ?')
    .get(req.params.sessionId, req.params.testId);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  req.session = s;
  next();
}

// rrweb event batches, appended as JSONL (one batch per line).
router.post('/api/take/:testId/sessions/:sessionId/events', ingestLimiter, getSession, (req, res) => {
  const events = req.body?.events;
  if (Array.isArray(events) && events.length) {
    fs.appendFileSync(
      path.join(EVENTS_DIR, req.session.id + '.jsonl'),
      JSON.stringify(events) + '\n'
    );
  }
  res.json({ ok: true });
});

// Lightweight interaction stream (clicks / move samples / scroll depth) for heatmaps.
const insertInteraction = db.prepare(
  'INSERT INTO interactions (session_id, page, kind, x, y, vw, vh, dh, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
router.post('/api/take/:testId/sessions/:sessionId/interactions', ingestLimiter, getSession, (req, res) => {
  const items = req.body?.items;
  if (Array.isArray(items)) {
    const tx = db.transaction((rows) => {
      // 'nav' rows are screen-transition markers, not tester activity — they
      // must not count toward interaction_count or a load-and-leave session
      // would dodge the no_interaction discard.
      let counted = 0;
      for (const it of rows) {
        if (!['click', 'move', 'scroll', 'key', 'nav'].includes(it.kind)) continue;
        insertInteraction.run(
          req.session.id, String(it.page || '').slice(0, 500), it.kind,
          Number(it.x) || 0, Number(it.y) || 0,
          Number(it.vw) || 0, Number(it.vh) || 0, Number(it.dh) || 0,
          Number(it.t) || 0
        );
        if (it.kind !== 'nav') counted++;
      }
      db.prepare('UPDATE sessions SET interaction_count = interaction_count + ? WHERE id = ?').run(
        counted, req.session.id
      );
    });
    tx(items);
  }
  res.json({ ok: true });
});

// Per-signal progress reported by the shell (chain step index + ms offset).
function cleanSignalHits(v) {
  if (!Array.isArray(v)) return null;
  const hits = v
    .filter((h) => h && Number.isInteger(h.i) && h.i >= 0 && h.i < 64 && Number.isInteger(h.t) && h.t >= 0)
    .slice(0, 100)
    .map((h) => ({ i: h.i, t: h.t }));
  return hits.length ? JSON.stringify(hits) : null;
}

router.post('/api/take/:testId/sessions/:sessionId/finish', getSession, (req, res) => {
  const s = req.session;
  if (s.status !== 'started') return res.json({ ok: true, status: s.status });
  const now = Date.now();
  // When the test lets testees roam after the task, the client reports the
  // task's own completion time separately so roaming doesn't inflate the
  // "time to complete" metric — clamp it to a sane range in case of clock skew.
  const elapsed = now - s.started_at;
  const taskDurationMs = Number(req.body?.taskDurationMs);
  const duration = Number.isFinite(taskDurationMs) && taskDurationMs > 0 && taskDurationMs <= elapsed
    ? taskDurationMs
    : elapsed;
  const success = req.body?.success ? 1 : 0;
  const gaveUp = req.body?.gaveUp ? 1 : 0;
  const signalHits = cleanSignalHits(req.body?.signalHits);
  const interactions = db
    .prepare('SELECT interaction_count AS n FROM sessions WHERE id = ?')
    .get(s.id).n;

  let status = 'completed';
  let discardReason = null;
  if (duration < MIN_DURATION_MS) {
    status = 'discarded';
    discardReason = 'too_fast';
  } else if (interactions === 0) {
    status = 'discarded';
    discardReason = 'no_interaction';
  }
  db.prepare(
    'UPDATE sessions SET status = ?, success = ?, gave_up = ?, ended_at = ?, duration_ms = ?, discard_reason = ?, signal_hits = ? WHERE id = ?'
  ).run(status, success, gaveUp, now, duration, discardReason, signalHits, s.id);

  // Auto-close once the response cap is reached — and tell the owner, since
  // "your results are ready" is the single highest-value email this product has.
  const t = getTest.get(s.test_id);
  if (t.status === 'live' && completedCount.get(t.id).n >= t.response_cap) {
    db.prepare("UPDATE tests SET status = 'closed' WHERE id = ?").run(t.id);
    // §7 v1 shared-state reset point: drop the sandbox at the cap so a
    // relaunch boots a freshly seeded database.
    if (isServerTest(t)) sandboxes.teardown(t.id).catch(() => {});
    const owner = t.user_id ? getOwner.get(t.user_id) : null;
    if (owner && owner.email) {
      const appUrl = process.env.INTEGRAL_APP_URL || `${req.protocol}://${req.get('host')}`;
      sendEmail({
        to: owner.email,
        subject: `"${t.name}" hit its response cap — results are ready`,
        text:
          `Your usability test "${t.name}" collected all ${t.response_cap} responses and closed itself.\n\n` +
          `See the results, heatmap, and session replays:\n${appUrl}/tests/${t.id}/results\n`,
      });
    }
  }
  res.json({ ok: true, status });
});

// ---------- abuse reports ----------
// Anyone who lands on a hosted test can flag it; payment processors and
// registrars expect *a* takedown channel to exist. Review is manual.

router.post('/api/take/:testId/report', reportLimiter, testOr404, (req, res) => {
  const reason = String(req.body?.reason || '').slice(0, 200);
  const detail = String(req.body?.detail || '').slice(0, 2000);
  db.prepare('INSERT INTO reports (test_id, reason, detail, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)').run(
    req.test.id, reason, detail, fingerprint(req), Date.now()
  );
  if (process.env.INTEGRAL_ABUSE_EMAIL) {
    sendEmail({
      to: process.env.INTEGRAL_ABUSE_EMAIL,
      subject: `Abuse report for test ${req.test.id}`,
      text: `Test: ${req.test.name} (${req.test.id})\nReason: ${reason}\nDetail: ${detail}\n`,
    });
  } else {
    console.warn(`[report] test ${req.test.id} flagged: ${reason} (set INTEGRAL_ABUSE_EMAIL to get notified)`);
  }
  res.json({ ok: true });
});

router.post('/api/take/:testId/sessions/:sessionId/seq', getSession, (req, res) => {
  const score = Number(req.body?.score);
  const comment = String(req.body?.comment || '').slice(0, 2000);
  if (score >= 1 && score <= 7) {
    db.prepare(
      'UPDATE sessions SET seq_score = ?, seq_comment = ?, seq_comment_sentiment = ? WHERE id = ?'
    ).run(score, comment, sentiment.score(comment), req.session.id);
  }
  res.json({ ok: true });
});

// Open-ended post-test note, independent of the SEQ score/comment above.
router.post('/api/take/:testId/sessions/:sessionId/notes', getSession, (req, res) => {
  const notes = String(req.body?.notes || '').slice(0, 2000).trim();
  if (notes) {
    db.prepare('UPDATE sessions SET notes = ?, notes_sentiment = ? WHERE id = ?').run(
      notes, sentiment.score(notes), req.session.id
    );
  }
  res.json({ ok: true });
});

// Tab closed mid-task (sendBeacon) — record the end time, keep status 'started'
// so it shows up as a drop-off.
router.post('/api/take/:testId/sessions/:sessionId/abandon', getSession, (req, res) => {
  if (req.session.status === 'started') {
    db.prepare('UPDATE sessions SET ended_at = ?, signal_hits = ? WHERE id = ?').run(
      Date.now(), cleanSignalHits(req.body?.signalHits), req.session.id
    );
  }
  res.json({ ok: true });
});

module.exports = router;
