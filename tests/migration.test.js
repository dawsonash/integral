// A database created before the success_signals feature must gain the new
// columns on boot (CREATE TABLE IF NOT EXISTS won't touch existing tables —
// server/db.js backfills with ALTER TABLE guards) and legacy rows must keep
// working via the synthesized one-signal chain.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-migration-'));

// Pre-create the DB with the pre-signals schema and a legacy live test row.
{
  const db = new Database(path.join(process.env.INTEGRAL_DATA_DIR, 'integral.db'));
  db.exec(`
CREATE TABLE tests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_type TEXT NOT NULL,
  entry_path TEXT,
  task_prompt TEXT DEFAULT '',
  success_type TEXT DEFAULT 'click',
  success_selector TEXT,
  success_screen TEXT,
  success_label TEXT,
  seq_enabled INTEGER DEFAULT 1,
  screener_enabled INTEGER DEFAULT 0,
  screener_question TEXT,
  response_cap INTEGER DEFAULT 25,
  unmask_selectors TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES tests(id),
  status TEXT NOT NULL DEFAULT 'started',
  success INTEGER,
  gave_up INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  seq_score INTEGER,
  seq_comment TEXT,
  screener_answer TEXT,
  fingerprint TEXT,
  interaction_count INTEGER DEFAULT 0,
  discard_reason TEXT
);
`);
  db.prepare(
    "INSERT INTO tests (id, name, status, source_type, entry_path, task_prompt, success_type, success_selector, success_label, created_at) VALUES ('legacy1', 'Legacy booking', 'live', 'html', 'index.html', 'Book a desk', 'click', '#confirm', 'Confirm', ?)"
  ).run(Date.now());
  // A comment collected before sentiment existed — boot must score it.
  db.prepare(
    "INSERT INTO sessions (id, test_id, status, success, started_at, duration_ms, seq_score, seq_comment) VALUES ('legacysess1', 'legacy1', 'completed', 1, ?, 9000, 2, 'This was terrible and frustrating.')"
  ).run(Date.now());
  db.close();
}

const app = require('../server/app');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

test('boot adds the new columns to a pre-existing database', () => {
  const { db } = require('../server/db');
  const testCols = db.pragma('table_info(tests)').map((c) => c.name);
  const sessionCols = db.pragma('table_info(sessions)').map((c) => c.name);
  assert.ok(testCols.includes('success_signals'));
  assert.ok(sessionCols.includes('signal_hits'));
  assert.ok(sessionCols.includes('seq_comment_sentiment'));
  assert.ok(sessionCols.includes('notes_sentiment'));
});

test('adding the sentiment columns backfills the free text already collected', () => {
  const { db } = require('../server/db');
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('legacysess1');
  assert.ok(row.seq_comment_sentiment < -0.05, `expected negative, got ${row.seq_comment_sentiment}`);
  // No note was left, so there is nothing to score — not a fake neutral.
  assert.equal(row.notes_sentiment, null);
});

test('legacy row survives and synthesizes a one-signal chain', async () => {
  const config = await (await fetch(`${base}/api/take/legacy1/config`)).json();
  assert.equal(config.open, true);
  assert.deepEqual(config.signals, [{ kind: 'click', selector: '#confirm', label: 'Confirm' }]);
});
