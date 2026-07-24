const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, EVENTS_DIR } = require('../db');
const { newId } = require('../lib/util');
const { requireUser } = require('../lib/auth');
const { planFor } = require('../lib/plans');
const { deleteTestData } = require('../lib/purge');
const { uploadLimiter } = require('../lib/ratelimit');
const { signalsFor, validateSignals } = require('../lib/signals');
const { groupPages } = require('../lib/screens');
const {
  artifactRoot, ingestHtml, ingestZip, ingestFiles, listHtmlFiles,
  ensureEntry, isModuleEntry, appRootFor, uiModuleOk, writeEntryWrapper,
} = require('../lib/artifacts');
const { pullRepo } = require('../lib/github');
const { validateMocks, cleanMocks, mocksFor, suggestApiCalls } = require('../lib/mocks');
const { classify, backendConfigFor, validateBackendConfig } = require('../lib/sandbox/classify');
const sandboxes = require('../lib/sandbox/registry');

const router = express.Router();
// fieldSize covers the pasted-HTML path; the per-plan artifact cap is enforced
// at ingest, this is just the hard transport ceiling.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 },
});

const getTest = db.prepare('SELECT * FROM tests WHERE id = ?');

function testJson(t) {
  return { ...t, signals: signalsFor(t), html_files: listHtmlFiles(t.id), apiMocks: mocksFor(t), backendConfig: backendConfigFor(t) };
}

// Everything under /api/tests is the dev-facing surface: authenticated and
// scoped to the owner. The testee surface (routes/take.js) stays anonymous.
router.use('/api/tests', requireUser);

function ownedTest(req, res, next) {
  const t = getTest.get(req.params.id);
  if (!t || t.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  req.test = t;
  next();
}

router.get('/api/tests', (req, res) => {
  const tests = db
    .prepare('SELECT * FROM tests WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  const counts = db
    .prepare(
      `SELECT s.test_id, COUNT(*) AS n FROM sessions s JOIN tests t ON t.id = s.test_id
       WHERE t.user_id = ? AND s.status = 'completed' GROUP BY s.test_id`
    )
    .all(req.user.id)
    .reduce((acc, r) => ((acc[r.test_id] = r.n), acc), {});
  res.json(tests.map((t) => ({ ...t, completed_count: counts[t.id] || 0 })));
});

// Create a test from a connected repo, a pasted HTML string, an uploaded zip,
// or a folder upload.
router.post('/api/tests', uploadLimiter, upload.any(), async (req, res) => {
  const repoField = (req.body.repo || '').trim();
  const name = (req.body.name || '').trim() || (repoField ? repoField.split('/')[1] : 'Untitled test');
  const id = newId(10);
  const files = req.files || [];
  const zip = files.find((f) => f.fieldname === 'zip');
  const folderFiles = files.filter((f) => f.fieldname === 'files');
  const maxBytes = planFor(req.user).artifactBytes;
  const repo = repoField;
  let sourceType;
  let repoCols = { full_name: null, branch: null, path: null, synced_at: null };
  try {
    if (repo) {
      if (!req.user.github_token) {
        return res.status(400).json({ error: 'github_not_connected', message: 'Connect GitHub repositories first.' });
      }
      sourceType = 'repo';
      const branch = (req.body.branch || '').trim();
      // `entry` is the picked start page. An HTML entry hosts its own folder;
      // a module entry (src/main.jsx) hosts its app root — everything above
      // src/ — so package.json and public assets ride along. `path` (explicit
      // folder) is the legacy/advanced form of the same thing.
      const entryFile = (req.body.entry || '').trim().replace(/^\/+/, '');
      const repoPath = entryFile
        ? (isModuleEntry(entryFile)
            ? appRootFor(entryFile)
            : (entryFile.includes('/') ? entryFile.slice(0, entryFile.lastIndexOf('/')) : ''))
        : (req.body.path || '').trim().replace(/^\/+|\/+$/g, '');
      await pullRepo(id, req.user.github_token, repo, branch, repoPath, maxBytes);
      repoCols = { full_name: repo, branch, path: repoPath, synced_at: Date.now() };
    } else if (req.body.html && req.body.html.trim()) {
      sourceType = 'html';
      ingestHtml(id, req.body.html, maxBytes);
    } else if (zip) {
      sourceType = 'zip';
      ingestZip(id, zip.buffer, maxBytes);
    } else if (folderFiles.length) {
      sourceType = 'folder';
      const relPaths = JSON.parse(req.body.paths || '[]');
      ingestFiles(id, folderFiles, relPaths, maxBytes);
    } else {
      return res.status(400).json({ error: 'no_artifact', message: 'Provide a repo, pasted HTML, a zip, or a folder.' });
    }
  } catch (e) {
    if (e.code === 'ARTIFACT_TOO_LARGE') {
      return res.status(413).json({
        error: 'artifact_too_large',
        message: `Artifact exceeds your plan's ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      });
    }
    return res.status(400).json({ error: 'ingest_failed', message: e.message });
  }
  let entry = null;
  const pickedEntry = sourceType === 'repo' ? (req.body.entry || '').trim().replace(/^\/+/, '') : '';
  if (pickedEntry && isModuleEntry(pickedEntry)) {
    // The artifact was rooted at the app root, so the module's path inside
    // it is what remains after that prefix. Same uiModuleOk gate as the
    // picker — path shape alone doesn't make a browser app.
    const moduleRel = repoCols.path ? pickedEntry.slice(repoCols.path.length + 1) : pickedEntry;
    if (fs.existsSync(path.join(artifactRoot(id), moduleRel)) && uiModuleOk(artifactRoot(id), moduleRel)) {
      entry = writeEntryWrapper(artifactRoot(id), moduleRel);
    }
  }
  if (!entry) {
    // ensureEntry also covers HTML-less React artifacts by synthesizing a
    // wrapper page around the conventional entry module.
    entry = ensureEntry(id);
    if (pickedEntry && !isModuleEntry(pickedEntry)) {
      const want = pickedEntry.split('/').pop();
      if (listHtmlFiles(id).includes(want)) entry = want;
    }
  }
  // No static start page — this may be a server-rendered app (Express/
  // Handlebars & co., spec docs/fake-backend-spec.md): the UI only exists
  // once its server runs. Classify the repo; when it looks like a server
  // app, create a server-type test whose pages come from the sandbox proxy
  // instead of disk. The detected config is a draft the dev confirms in setup.
  let backendConfig = null;
  if (!entry) {
    const detected = classify(artifactRoot(id));
    if (detected.kind === 'server') {
      backendConfig = detected;
      entry = ''; // the app's own routes decide pages; iframe starts at /t/:id/app/
    } else {
      return res.status(400).json({ error: 'no_html', message: 'Artifact contains no HTML page or React entry module.' });
    }
  }
  db.prepare(
    `INSERT INTO tests (id, name, source_type, entry_path, user_id, created_at,
       repo_full_name, repo_branch, repo_path, repo_synced_at, backend_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, sourceType, entry, req.user.id, Date.now(),
    repoCols.full_name, repoCols.branch, repoCols.path, repoCols.synced_at,
    backendConfig ? JSON.stringify(backendConfig) : null);
  res.json(testJson(getTest.get(id)));
});

// Re-pull a repo-backed test's artifact from its source branch.
router.post('/api/tests/:id/pull', ownedTest, async (req, res) => {
  const t = req.test;
  if (t.source_type !== 'repo') {
    return res.status(400).json({ error: 'not_repo_test', message: 'This test is not connected to a repository.' });
  }
  if (!req.user.github_token) {
    return res.status(400).json({ error: 'github_not_connected', message: 'Connect GitHub repositories first.' });
  }
  const maxBytes = planFor(req.user).artifactBytes;
  try {
    await pullRepo(t.id, req.user.github_token, t.repo_full_name, t.repo_branch, t.repo_path, maxBytes, { replace: true });
  } catch (e) {
    if (e.code === 'ARTIFACT_TOO_LARGE') {
      return res.status(413).json({
        error: 'artifact_too_large',
        message: `Artifact exceeds your plan's ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      });
    }
    return res.status(400).json({ error: 'pull_failed', message: e.message });
  }
  // Server-rendered test: pages come from the app, not disk — no entry to
  // re-derive. Drop the running sandbox so the next request boots the new code.
  if (backendConfigFor(t)?.kind === 'server') {
    sandboxes.teardown(t.id).catch(() => {});
    db.prepare('UPDATE tests SET repo_synced_at = ? WHERE id = ?').run(Date.now(), t.id);
    return res.json(testJson(getTest.get(t.id)));
  }
  // The entry screen may have been renamed or removed by the new snapshot —
  // and a synthesized module wrapper never survives a re-pull, so ensureEntry
  // recreates one when the snapshot is still HTML-less.
  const entry = listHtmlFiles(t.id).includes(t.entry_path) ? t.entry_path : ensureEntry(t.id);
  if (!entry) {
    return res.status(400).json({ error: 'no_html', message: 'Latest snapshot contains no HTML page or React entry module.' });
  }
  db.prepare('UPDATE tests SET entry_path = ?, repo_synced_at = ? WHERE id = ?').run(entry, Date.now(), t.id);
  res.json(testJson(getTest.get(t.id)));
});

// ---------- server-rendered backend config (docs/fake-backend-spec.md §5) ----------
// The dev-editable fake-backend surface: seed tables ("the Lorem Ipsum"),
// start command, auth preset, stubs. v1 edits raw JSON in setup.

router.get('/api/tests/:id/backend-config', ownedTest, (req, res) => {
  res.json({ backendConfig: backendConfigFor(req.test) });
});

router.patch('/api/tests/:id/backend-config', express.json(), ownedTest, (req, res) => {
  const cfg = req.body?.backendConfig;
  const err = validateBackendConfig(cfg);
  if (err) return res.status(400).json({ error: 'invalid_backend_config', message: err });
  db.prepare('UPDATE tests SET backend_config = ? WHERE id = ?').run(JSON.stringify(cfg), req.test.id);
  // A running sandbox was booted from the old config; retire it so the next
  // preview/take request boots (and re-seeds) with this one.
  sandboxes.teardown(req.test.id).catch(() => {});
  res.json(testJson(getTest.get(req.test.id)));
});

// Re-run detection (e.g. after editing the config into a corner).
router.post('/api/tests/:id/backend-config/detect', ownedTest, (req, res) => {
  res.json({ detected: classify(artifactRoot(req.test.id)) });
});

// One-click first test: the bundled demo shop, pre-configured so the empty
// state produces a launchable test in seconds (Tier 2 onboarding).
router.post('/api/tests/sample', (req, res) => {
  const id = newId(10);
  fs.cpSync(path.join(__dirname, '..', '..', 'fixtures', 'demo-shop'), artifactRoot(id), { recursive: true });
  db.prepare(
    `INSERT INTO tests (id, name, source_type, entry_path, task_prompt, success_signals, user_id, created_at)
     VALUES (?, ?, 'sample', 'index.html', ?, ?, ?, ?)`
  ).run(
    id,
    'Sample — Hoodie Shop checkout',
    'Add the blue hoodie to your cart and check out.',
    JSON.stringify([{ kind: 'click', selector: '#checkout', label: 'Check out', page: 'cart.html' }]),
    req.user.id,
    Date.now()
  );
  res.json(testJson(getTest.get(id)));
});

router.get('/api/tests/:id', ownedTest, (req, res) => {
  res.json(testJson(req.test));
});

// Network calls found in the artifact's code — setup-page suggestions for
// which endpoints need sandbox mocks.
router.get('/api/tests/:id/api-suggestions', ownedTest, (req, res) => {
  res.json({ calls: suggestApiCalls(req.test.id) });
});

const EDITABLE = {
  name: String,
  entry_path: String,
  task_prompt: String,
  success_type: String,
  success_selector: String,
  success_screen: String,
  success_label: String,
  seq_enabled: (v) => (v ? 1 : 0),
  screener_enabled: (v) => (v ? 1 : 0),
  screener_question: String,
  roam_enabled: (v) => (v ? 1 : 0),
  notes_enabled: (v) => (v ? 1 : 0),
  response_cap: (v) => Math.max(1, Number(v) || 25),
  unmask_selectors: String,
  success_signals: (v) => JSON.stringify(v),
  api_mocks: (v) => JSON.stringify(cleanMocks(v)),
  status: String,
};

router.patch('/api/tests/:id', express.json(), ownedTest, (req, res) => {
  const t = req.test;
  // The recorder only acts on these two; any other value would persist fine
  // but silently never detect success, so the testee's task never terminates.
  if ('success_type' in req.body && !['click', 'screen'].includes(req.body.success_type)) {
    return res.status(400).json({
      error: 'invalid_success_type',
      message: "success_type must be 'click' or 'screen'.",
    });
  }
  if ('success_signals' in req.body) {
    const err = validateSignals(req.body.success_signals);
    if (err) return res.status(400).json({ error: 'invalid_success_signals', message: err });
  }
  if ('api_mocks' in req.body) {
    const err = validateMocks(req.body.api_mocks);
    if (err) return res.status(400).json({ error: 'invalid_api_mocks', message: err });
  }
  const sets = [];
  const vals = [];
  for (const [key, cast] of Object.entries(EDITABLE)) {
    if (key in req.body) {
      if (key === 'status' && !['draft', 'live', 'closed'].includes(req.body.status)) continue;
      sets.push(`${key} = ?`);
      vals.push(cast(req.body[key]));
    }
  }
  if (req.body.status === 'live' && !t.task_prompt && !req.body.task_prompt) {
    return res.status(400).json({ error: 'missing_task_prompt', message: 'Write a task prompt before launching.' });
  }
  if (req.body.status === 'live') {
    const effective = { ...t, ...req.body };
    if ('success_signals' in req.body) effective.success_signals = JSON.stringify(req.body.success_signals);
    if (!signalsFor(effective).length) {
      return res.status(400).json({ error: 'missing_success_signal', message: 'Record at least one success step before launching.' });
    }
    // Plan gate: concurrent live tests (spec §8's volume axis).
    if (t.status !== 'live') {
      const plan = planFor(req.user);
      const live = db
        .prepare("SELECT COUNT(*) AS n FROM tests WHERE user_id = ? AND status = 'live' AND id != ?")
        .get(req.user.id, t.id).n;
      if (live >= plan.activeTests) {
        return res.status(403).json({
          error: 'plan_limit_active_tests',
          message: `Your ${plan.label} plan allows ${plan.activeTests} live test${plan.activeTests === 1 ? '' : 's'} at a time. Close one or upgrade.`,
        });
      }
    }
    sets.push('launched_at = ?');
    vals.push(Date.now());
  }
  if (sets.length) {
    db.prepare(`UPDATE tests SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  }
  res.json(testJson(getTest.get(req.params.id)));
});

router.delete('/api/tests/:id', ownedTest, (req, res) => {
  deleteTestData(req.test.id);
  res.json({ ok: true });
});

// ---------- results ----------

function buildResults(t) {
  const sessions = db
    .prepare('SELECT * FROM sessions WHERE test_id = ? ORDER BY started_at ASC')
    .all(t.id);

  const completed = sessions.filter((s) => s.status === 'completed');
  const discarded = sessions.filter((s) => s.status === 'discarded');
  const abandoned = sessions.filter((s) => s.status === 'started');
  const succeeded = completed.filter((s) => s.success);

  const times = succeeded.map((s) => s.duration_ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;

  // Per-signal progress: how many kept sessions reached each step of the chain.
  const signals = signalsFor(t);
  const kept = sessions.filter((s) => s.status !== 'discarded');
  const hitSets = kept.map((s) => {
    try {
      return new Set((JSON.parse(s.signal_hits) || []).map((h) => h.i));
    } catch (e) {
      return new Set();
    }
  });
  const signalMetrics = signals.map((sig, i) => ({
    kind: sig.kind,
    label: sig.label || sig.selector || sig.screen || '',
    hit: hitSets.filter((set) => set.has(i)).length,
  }));

  const seqScores = completed.filter((s) => s.seq_score).map((s) => s.seq_score);
  const seqDist = [1, 2, 3, 4, 5, 6, 7].map((n) => seqScores.filter((v) => v === n).length);
  const seqAvg = seqScores.length
    ? seqScores.reduce((a, b) => a + b, 0) / seqScores.length
    : null;

  return {
    test: testJson(t),
    sampleLabel: 'unscreened sample',
    metrics: {
      started: sessions.length,
      completed: completed.length,
      discarded: discarded.length,
      abandoned: abandoned.length,
      succeeded: succeeded.length,
      gaveUp: completed.filter((s) => s.gave_up).length,
      successRate: completed.length ? succeeded.length / completed.length : null,
      medianTimeMs: median,
      times,
      seqDist,
      seqAvg,
      seqCount: seqScores.length,
      signals: signalMetrics,
    },
    comments: completed
      .filter((s) => s.seq_comment)
      .map((s) => ({ sessionId: s.id, score: s.seq_score, comment: s.seq_comment })),
    notes: completed
      .filter((s) => s.notes)
      .map((s) => ({ sessionId: s.id, note: s.notes })),
    sessions: sessions.map((s) => ({
      id: s.id,
      status: s.status,
      success: !!s.success,
      gaveUp: !!s.gave_up,
      startedAt: s.started_at,
      durationMs: s.duration_ms,
      seqScore: s.seq_score,
      seqComment: s.seq_comment,
      notes: s.notes,
      screenerAnswer: s.screener_answer,
      interactionCount: s.interaction_count,
      discardReason: s.discard_reason,
    })),
  };
}

router.get('/api/tests/:id/results', ownedTest, (req, res) => {
  res.json(buildResults(req.test));
});

// ---------- export (devs distrust dashboards they can't get data out of) ----------

router.get('/api/tests/:id/export.json', ownedTest, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="integral-${req.test.id}.json"`);
  res.json(buildResults(req.test));
});

router.get('/api/tests/:id/export.csv', ownedTest, (req, res) => {
  const { sessions } = buildResults(req.test);
  const cols = [
    'id', 'status', 'success', 'gaveUp', 'startedAt', 'durationMs',
    'seqScore', 'seqComment', 'notes', 'screenerAnswer', 'interactionCount', 'discardReason',
  ];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(',')]
    .concat(sessions.map((s) => cols.map((c) => cell(s[c])).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="integral-${req.test.id}.csv"`);
  res.send(csv);
});

router.get('/api/tests/:id/sessions/:sessionId/events', ownedTest, (req, res) => {
  const s = db
    .prepare('SELECT id FROM sessions WHERE id = ? AND test_id = ?')
    .get(req.params.sessionId, req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  const file = path.join(EVENTS_DIR, s.id + '.jsonl');
  let events = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) events = events.concat(JSON.parse(line));
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ events });
});

// Aggregated heatmap points for one screen. Concrete screen keys recorded by
// testers ("event/123", "index.html::Checkout") are grouped under normalized
// keys ("event/{id}"), so `page` here is a normalized group key. Alongside
// the points, pick a representative rrweb moment (`snapshot`) so the client
// can render the screen the way a real tester saw it.
router.get('/api/tests/:id/heatmap', ownedTest, (req, res) => {
  const page = req.query.page || '';
  const kind = ['click', 'move', 'scroll'].includes(req.query.kind) ? req.query.kind : 'click';

  const pageCounts = db
    .prepare(
      `SELECT i.page, COUNT(*) AS count FROM interactions i
       JOIN sessions s ON s.id = i.session_id
       WHERE s.test_id = ? AND s.status = 'completed'
       GROUP BY i.page`
    )
    .all(req.params.id);
  const groups = groupPages(pageCounts).sort((a, b) => b.count - a.count);

  // Concrete pages behind the requested group; exact match keeps old-style
  // links (and yet-ungrouped keys) working.
  const group = groups.find((g) => g.key === page);
  const concretes = (group ? group.concretes : [page]).slice(0, 200);

  const ph = concretes.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT i.x, i.y, i.vw, i.vh, i.dh FROM interactions i
       JOIN sessions s ON s.id = i.session_id
       WHERE s.test_id = ? AND s.status = 'completed' AND i.kind = ? AND i.page IN (${ph})
       LIMIT 20000`
    )
    .all(req.params.id, kind, ...concretes);

  // Snapshot moment: prefer a session with a nav marker into this screen
  // (the DOM right after the transition is the screen itself), weighted by
  // how much that session actually interacted with it. Sessions recorded
  // before nav markers existed fall back to the first interaction there.
  const nav = db
    .prepare(
      `SELECT i.session_id AS sessionId, MIN(i.t) AS t, s.started_at AS startedAt,
              (SELECT COUNT(*) FROM interactions i2
                WHERE i2.session_id = i.session_id AND i2.kind != 'nav' AND i2.page IN (${ph})) AS activity
       FROM interactions i JOIN sessions s ON s.id = i.session_id
       WHERE s.test_id = ? AND s.status = 'completed' AND i.kind = 'nav' AND i.page IN (${ph})
       GROUP BY i.session_id
       ORDER BY activity DESC, t ASC LIMIT 1`
    )
    .get(...concretes, req.params.id, ...concretes);
  let snapshot = null;
  if (nav) {
    snapshot = { sessionId: nav.sessionId, at: nav.startedAt + nav.t + 500 };
  } else {
    const first = db
      .prepare(
        `SELECT i.session_id AS sessionId, MIN(i.t) AS t, s.started_at AS startedAt
         FROM interactions i JOIN sessions s ON s.id = i.session_id
         WHERE s.test_id = ? AND s.status = 'completed' AND i.kind != 'nav' AND i.page IN (${ph})
         GROUP BY i.session_id ORDER BY t ASC LIMIT 1`
      )
      .get(req.params.id, ...concretes);
    if (first) snapshot = { sessionId: first.sessionId, at: first.startedAt + first.t + 100 };
  }

  res.json({
    points: rows,
    pages: groups.map((g) => ({ key: g.key, count: g.count, representative: g.representative })),
    snapshot,
  });
});

module.exports = router;
