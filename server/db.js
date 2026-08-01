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

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL DEFAULT 'free',
  billing_interval TEXT NOT NULL DEFAULT 'month',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_seat_item_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- One team per user: the plan a member is entitled to must be unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS team_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  invitee TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  invited_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
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
// Returns true when the column was actually added, so a caller can hang a
// one-time backfill off it.
function ensureColumn(table, col, ddl) {
  const has = db.pragma(`table_info(${table})`).some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  return !has;
}
ensureColumn('tests', 'success_signals', 'TEXT');
ensureColumn('sessions', 'signal_hits', 'TEXT');
ensureColumn('tests', 'user_id', 'INTEGER REFERENCES users(id)');
ensureColumn('tests', 'launched_at', 'INTEGER');
// Post-task options: let testees keep exploring after finishing the task,
// and/or collect an open-ended note distinct from the SEQ comment.
ensureColumn('tests', 'roam_enabled', 'INTEGER DEFAULT 0');
ensureColumn('tests', 'notes_enabled', 'INTEGER DEFAULT 0');
ensureColumn('sessions', 'notes', 'TEXT');
// Repo-scoped OAuth token, granted separately from sign-in (which is scope-free).
ensureColumn('users', 'github_token', 'TEXT');
// Repo-backed tests: where the artifact was pulled from, so it can be re-pulled.
ensureColumn('tests', 'repo_full_name', 'TEXT');
ensureColumn('tests', 'repo_branch', 'TEXT');
ensureColumn('tests', 'repo_path', 'TEXT');
ensureColumn('tests', 'repo_synced_at', 'INTEGER');
// Hardcoded sandbox responses for the artifact's API calls (JSON array).
ensureColumn('tests', 'api_mocks', 'TEXT');
// Server-rendered tests: how to boot the app against a fake backend (JSON,
// see docs/fake-backend-spec.md §5). NULL for static/SPA tests.
ensureColumn('tests', 'backend_config', 'TEXT');
// Team-owned tests: set when the creator is in a team. NULL means a personal
// test, visible only to its user_id owner.
ensureColumn('tests', 'team_id', 'INTEGER REFERENCES teams(id)');
// Which cadence the user's individual subscription renews on ('month'|'year').
ensureColumn('users', 'billing_interval', 'TEXT');
// First-touch advertising attribution, stamped at signup from the cookie set
// in lib/attribution.js. NULL for accounts created before this shipped and for
// anyone who reached the login URL without a page view (they report as
// untracked rather than being folded into 'direct', which would be a lie).
ensureColumn('users', 'signup_source', 'TEXT');
ensureColumn('users', 'signup_campaign', 'TEXT');
// When a paid plan fell back to 'free' (cancelled, or dunning gave up). Drives
// the retention grace window in lib/retention.js; NULL for accounts that never
// paid and for accounts currently subscribed.
ensureColumn('teams', 'plan_lapsed_at', 'INTEGER');
ensureColumn('users', 'plan_lapsed_at', 'INTEGER');
// Lexicon sentiment (server/lib/sentiment.js) for the two free-text fields,
// scored once at write time so the results page can badge, count, and sort by
// it. Stores the normalized compound score only; buckets are derived.
const addedSeqSentiment = ensureColumn('sessions', 'seq_comment_sentiment', 'REAL');
const addedNotesSentiment = ensureColumn('sessions', 'notes_sentiment', 'REAL');
if (addedSeqSentiment || addedNotesSentiment) {
  // One-time pass so tests that already collected feedback aren't half-blank.
  // Required here rather than at the top: a warm database never pays to load
  // the lexicon at boot.
  const { score } = require('./lib/sentiment');
  const rows = db
    .prepare('SELECT id, seq_comment, notes FROM sessions WHERE seq_comment IS NOT NULL OR notes IS NOT NULL')
    .all();
  const upd = db.prepare(
    'UPDATE sessions SET seq_comment_sentiment = ?, notes_sentiment = ? WHERE id = ?'
  );
  db.transaction(() => {
    for (const r of rows) upd.run(score(r.seq_comment), score(r.notes), r.id);
  })();
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tests_user ON tests(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tests_team ON tests(team_id)');

module.exports = { db, DATA_DIR, ARTIFACTS_DIR, EVENTS_DIR };
