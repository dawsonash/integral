const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.INTEGRAL_DATA_DIR || path.join(__dirname, '..', 'data');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const EVENTS_DIR = path.join(DATA_DIR, 'events');

for (const dir of [DATA_DIR, ARTIFACTS_DIR, EVENTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'integral.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT UNIQUE NOT NULL,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  fingerprint TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tests (
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
  success_signals TEXT,
  seq_enabled INTEGER DEFAULT 1,
  screener_enabled INTEGER DEFAULT 0,
  screener_question TEXT,
  response_cap INTEGER DEFAULT 25,
  unmask_selectors TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
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
  discard_reason TEXT,
  signal_hits TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_test ON sessions(test_id);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  page TEXT,
  kind TEXT NOT NULL,
  x REAL,
  y REAL,
  vw INTEGER,
  vh INTEGER,
  dh INTEGER,
  t INTEGER
);

CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
`);

// CREATE TABLE IF NOT EXISTS never alters an existing table, so columns added
// after a database was first created must be backfilled here.
function ensureColumn(table, col, ddl) {
  const has = db.pragma(`table_info(${table})`).some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('tests', 'success_signals', 'TEXT');
ensureColumn('sessions', 'signal_hits', 'TEXT');
ensureColumn('tests', 'user_id', 'INTEGER REFERENCES users(id)');
ensureColumn('tests', 'launched_at', 'INTEGER');
// Repo-scoped OAuth token, granted separately from sign-in (which is scope-free).
ensureColumn('users', 'github_token', 'TEXT');
// Repo-backed tests: where the artifact was pulled from, so it can be re-pulled.
ensureColumn('tests', 'repo_full_name', 'TEXT');
ensureColumn('tests', 'repo_branch', 'TEXT');
ensureColumn('tests', 'repo_path', 'TEXT');
ensureColumn('tests', 'repo_synced_at', 'INTEGER');
// Hardcoded sandbox responses for the artifact's API calls (JSON array).
ensureColumn('tests', 'api_mocks', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_tests_user ON tests(user_id)');

module.exports = { db, DATA_DIR, ARTIFACTS_DIR, EVENTS_DIR };
