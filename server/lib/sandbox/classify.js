// Classify a pulled repo: static site, client-rendered SPA, or a
// server-rendered app that needs the fake-backend sandbox — and, for server
// apps, detect enough (start command, port, db kind, schema/seed commands)
// to draft the per-test backend_config (docs/fake-backend-spec.md §5).
// Detection is best-effort; the developer confirms/edits the config in setup.
const fs = require('fs');
const path = require('path');

const SERVER_DEPS = {
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  '@hapi/hapi': 'hapi',
  '@nestjs/core': 'nest',
  next: 'next',
};

// Python distributions we can boot, in detection order (a Django project that
// also pulls in Flask for a side script is a Django project).
const PY_SERVER_DEPS = {
  django: 'django',
  fastapi: 'fastapi',
  flask: 'flask',
  starlette: 'starlette',
};
const PY_PG_DEPS = ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'pg8000'];

const RUNTIMES = ['node', 'python'];
const DB_KINDS = ['postgres', 'sqlite', 'none'];
const SEED_MODES = ['faker', 'command', 'none'];
const AUTH_MODES = ['session-cookie', 'header', 'none'];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function hasHtml(rootDir) {
  let found = false;
  (function walk(dir, depth) {
    if (found || depth > 3) return;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
      else if (/\.html?$/i.test(name)) { found = true; return; }
    }
  })(rootDir, 0);
  return found;
}

// KEY=VALUE lines of an env file; comments and blanks skipped.
function parseEnvFile(p) {
  const out = {};
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Which $TOKEN a DB-ish env var name stands for, or null when it isn't one.
// The runner always injects the standard set (DATABASE_URL, PG*, POSTGRES_*);
// envMap covers app-specific names like DB_HOSTNAME.
function dbToken(key) {
  if (/^DATABASE_URL$/i.test(key)) return '$URL';
  if (!/^(POSTGRES_|PG_?|DB_|DATABASE_)/i.test(key)) return null;
  if (/HOST/i.test(key)) return '$HOST';
  if (/PORT/i.test(key)) return '$PORT';
  if (/(PASS|PASSWORD)/i.test(key)) return '$PASSWORD';
  if (/USER/i.test(key)) return '$USER';
  if (/(NAME|DB|DATABASE)$/i.test(key)) return '$DB';
  return null;
}

// Whether the app pins its listen port in code. An app that reads
// process.env.PORT gets a free port from the runner (concurrent sandboxes
// never collide); only a hardcoded `listen(3000)` forces that exact port.
function detectPort(rootDir, startCmd) {
  const m = (startCmd || '').match(/node\s+(?:--[^\s]+\s+)*([\w./-]+\.[cm]?js)/);
  const candidates = m ? [m[1]] : ['src/index.js', 'index.js', 'server.js', 'app.js'];
  for (const rel of candidates) {
    let src;
    try { src = fs.readFileSync(path.join(rootDir, rel), 'utf8'); } catch (e) { continue; }
    if (/process\.env\.PORT/.test(src)) return null;
    const port = src.match(/\.listen\(\s*(\d{2,5})/);
    if (port) return Number(port[1]);
  }
  return null;
}

// Language-agnostic halves of schema/seed detection, shared by both runtimes:
// a checked-in setup script and a checked-in .sql file mean the same thing
// whichever language the app is written in.
function detectSchemaScript(rootDir) {
  for (const rel of ['scripts/setup-test-db.sh', 'scripts/setup-db.sh', 'scripts/init-db.sh']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { schemaCmd: `bash ${rel}` };
  }
  return null;
}

function detectSchemaSql(rootDir) {
  for (const rel of ['init.sql', 'schema.sql', 'db/init.sql', 'db/schema.sql', 'sql/schema.sql', 'src/init_data/create.sql']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { schemaSql: rel };
  }
  return null;
}

function detectSeedSql(rootDir) {
  for (const rel of ['db/seed.sql', 'sql/seed.sql', 'src/init_data/insert.sql']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { mode: 'command', command: `__sql:${rel}` };
  }
  return null;
}

// Dummy secrets: every knob the app documents in its env file gets a value,
// so boot never dies on a missing var — and no real secret is ever used.
// DB-coordinate vars become envMap entries resolved from the ephemeral DB.
function detectEnv(rootDir) {
  const env = {};
  const envMap = {};
  for (const file of ['.env.test', '.env.example', '.env.sample']) {
    const vars = parseEnvFile(path.join(rootDir, file));
    for (const [key, value] of Object.entries(vars)) {
      if (key === 'PORT') continue; // the runner owns PORT
      const token = dbToken(key);
      if (token) envMap[key] = token;
      else if (!(key in env)) env[key] = value || 'dummy';
    }
  }
  return { env, envMap };
}

// The reproducible schema setup (§8's irreducible floor), cheapest match wins.
function detectSchema(rootDir, pkg) {
  const script = detectSchemaScript(rootDir);
  if (script) return script;
  for (const s of ['db:setup', 'db:migrate', 'migrate', 'setup-db']) {
    if (pkg.scripts && pkg.scripts[s]) return { schemaCmd: `npm run ${s}` };
  }
  return detectSchemaSql(rootDir) || {};
}

function detectSeed(rootDir, pkg) {
  if (pkg.scripts && pkg.scripts.seed) return { mode: 'command', command: 'npm run seed' };
  for (const rel of ['scripts/seed.js', 'db/seed.js', 'seed.js']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { mode: 'command', command: `node ${rel}` };
  }
  const sql = detectSeedSql(rootDir);
  if (sql) return sql;
  // Faker mode with no tables yet: the dev fills in seed.tables ("the Lorem
  // Ipsum") in setup, or points at their own script.
  return { mode: 'faker', tables: {} };
}

// ---------- Python ----------

// Distribution names a Python repo declares, lowercased. Best-effort across
// the three common manifests; extras, version pins and environment markers
// are stripped, so "psycopg2-binary==2.9.9 ; sys_platform != 'win32'" reads
// as psycopg2-binary.
function pyDeps(rootDir) {
  const names = new Set();
  const add = (raw) => {
    const m = String(raw).trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) names.add(m[1].toLowerCase());
  };
  const read = (rel) => {
    try { return fs.readFileSync(path.join(rootDir, rel), 'utf8'); } catch (e) { return ''; }
  };
  // A table's keys, e.g. [tool.poetry.dependencies] or Pipfile's [packages].
  const tableKeys = (text, header) => {
    const m = text.match(new RegExp(`\\[${header}\\]([\\s\\S]*?)(\\n\\[|$)`));
    if (!m) return;
    for (const line of m[1].split('\n')) {
      const k = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (k) add(k[1]);
    }
  };

  for (const rel of ['requirements.txt', 'requirements/base.txt', 'requirements/common.txt']) {
    for (const line of read(rel).split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('-')) add(t);
    }
  }
  const toml = read('pyproject.toml');
  // PEP 621 / PEP 508 array form: dependencies = ["flask>=3", "psycopg2"].
  for (const block of toml.match(/dependencies\s*=\s*\[[^\]]*\]/g) || []) {
    for (const quoted of block.match(/["']([^"']+)["']/g) || []) add(quoted.slice(1, -1));
  }
  tableKeys(toml, 'tool\\.poetry\\.dependencies');
  tableKeys(read('Pipfile'), 'packages');
  return names;
}

// Files that conventionally construct the app object, shallowest first.
const PY_ENTRY_FILES = [
  'main.py', 'app.py', 'wsgi.py', 'asgi.py', 'server.py',
  'src/main.py', 'src/app.py', 'app/main.py', 'app/app.py',
  'api/main.py', 'backend/main.py',
];

// Where the app object lives, as an importable dotted path plus the name it's
// bound to: src/main.py containing `app = FastAPI()` → src.main:app.
function findPyApp(rootDir, ctor) {
  const re = new RegExp(`^\\s*(\\w+)\\s*=\\s*${ctor}\\s*\\(`, 'm');
  for (const rel of PY_ENTRY_FILES) {
    let src;
    try { src = fs.readFileSync(path.join(rootDir, rel), 'utf8'); } catch (e) { continue; }
    const m = src.match(re);
    if (m) return `${rel.replace(/\.py$/, '').replace(/\//g, '.')}:${m[1]}`;
  }
  return null;
}

// A Django app's fixture file, loadable by name via manage.py loaddata.
function findDjangoFixture(rootDir) {
  let names;
  try { names = fs.readdirSync(rootDir); } catch (e) { return null; }
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const dir = path.join(rootDir, name, 'fixtures');
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    const fixture = files.find((f) => /\.(json|yaml|yml)$/i.test(f));
    if (fixture) return fixture.replace(/\.(json|yaml|yml)$/i, '');
  }
  return null;
}

function detectPySeed(rootDir, framework) {
  for (const rel of ['scripts/seed.py', 'seed.py', 'db/seed.py']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { mode: 'command', command: `python ${rel}` };
  }
  if (framework === 'django') {
    const fixture = findDjangoFixture(rootDir);
    if (fixture) return { mode: 'command', command: `python manage.py loaddata ${fixture}` };
  }
  return detectSeedSql(rootDir) || { mode: 'faker', tables: {} };
}

// A Python server repo, in the same config shape as a Node one (spec §5).
// Returns null when this isn't one, so classify() can fall through.
//
// The runner owns the port, but no Python framework picks up $PORT on its own
// the way `process.env.PORT` is idiomatic in Node — so the start command
// interpolates it, and the runner's `shell: true` spawn expands it from the
// injected environment.
function classifyPython(rootDir) {
  const deps = pyDeps(rootDir);
  if (!deps.size) return null;

  let framework = null;
  for (const [dep, name] of Object.entries(PY_SERVER_DEPS)) {
    if (deps.has(dep)) { framework = name; break; }
  }
  if (!framework) return null;

  const hasManage = fs.existsSync(path.join(rootDir, 'manage.py'));
  let startCmd = null;
  if (framework === 'django' && hasManage) {
    // --noreload: the autoreloader forks a second process for no benefit here
    // (the artifact never changes underneath a running sandbox) and slows the
    // health check.
    startCmd = 'python manage.py runserver --noreload 127.0.0.1:$PORT';
  } else if (framework === 'fastapi' || framework === 'starlette') {
    const target = findPyApp(rootDir, framework === 'fastapi' ? 'FastAPI' : 'Starlette');
    if (target) startCmd = `uvicorn ${target} --host 127.0.0.1 --port $PORT`;
  } else if (framework === 'flask') {
    const target = findPyApp(rootDir, 'Flask');
    if (target) startCmd = `flask --app ${target} run --host 127.0.0.1 --port $PORT`;
  }
  // App object not found where convention says it lives: hand the developer a
  // plausible command to correct in setup rather than refusing the repo.
  const startFallback = framework === 'django' ? 'python manage.py runserver --noreload 127.0.0.1:$PORT' : 'python main.py';

  const dbKind = PY_PG_DEPS.some((d) => deps.has(d))
    ? 'postgres'
    : framework === 'django' ? 'sqlite' : 'none';

  const schema = framework === 'django' && hasManage
    ? { schemaCmd: 'python manage.py migrate --noinput' }
    : fs.existsSync(path.join(rootDir, 'alembic.ini'))
      ? { schemaCmd: 'alembic upgrade head' }
      : detectSchemaScript(rootDir) || detectSchemaSql(rootDir) || {};

  const { env, envMap } = detectEnv(rootDir);
  if (framework === 'django') {
    // Django dies at import time without a SECRET_KEY, and rejects every
    // request as DisallowedHost when DEBUG is off. Only filled in when the
    // repo's own env file didn't already name them.
    for (const [key, value] of [['SECRET_KEY', 'dummy'], ['DJANGO_SECRET_KEY', 'dummy'], ['DEBUG', 'True'], ['ALLOWED_HOSTS', '*']]) {
      if (!(key in env)) env[key] = value;
    }
  }

  return {
    kind: 'server',
    runtime: 'python',
    framework,
    start: { cmd: startCmd || startFallback, readyPath: '/', readyTimeoutMs: 30000 },
    db: { kind: dbKind, ...schema, envMap },
    seed: detectPySeed(rootDir, framework),
    // No Python equivalent of the express-session cookie forgery: the session
    // formats are framework-specific and signed with the app's own key. The
    // developer picks the 'login' strategy in setup, which drives the app's
    // real login endpoint and works for any framework.
    auth: { mode: 'none' },
    env,
    stubs: [],
  };
}

// ---------- Node ----------

function classifyNode(rootDir, pkg) {
  const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };

  let framework = null;
  for (const [dep, name] of Object.entries(SERVER_DEPS)) {
    if (deps[dep]) { framework = name; break; }
  }
  if (!framework) return null;

  const startCmd =
    (pkg.scripts && (pkg.scripts.start || pkg.scripts.dev)) ||
    (pkg.main ? `node ${pkg.main}` : 'node src/index.js');

  const dbKind = deps.pg || deps['pg-promise'] || deps.postgres
    ? 'postgres'
    : deps['better-sqlite3'] || deps.sqlite3 ? 'sqlite' : 'none';

  const { env, envMap } = detectEnv(rootDir);

  const auth = deps['express-session']
    ? {
        mode: 'session-cookie',
        cookie: { name: 'connect.sid', strategy: 'express-session' },
        session: { user: { id: 1 } },
      }
    : { mode: 'none' };

  const port = detectPort(rootDir, startCmd);
  return {
    kind: 'server',
    runtime: 'node',
    framework,
    start: { cmd: startCmd, ...(port ? { port } : {}), readyPath: '/', readyTimeoutMs: 30000 },
    db: { kind: dbKind, ...detectSchema(rootDir, pkg), envMap },
    seed: detectSeed(rootDir, pkg),
    auth,
    env,
    stubs: [],
  };
}

// Server frameworks win over front-end ones in either language: a Django repo
// that also carries a package.json for its asset pipeline is a Django repo,
// and only the server path can actually serve it.
function classify(rootDir) {
  const pkg = readJson(path.join(rootDir, 'package.json'));
  const node = pkg ? classifyNode(rootDir, pkg) : null;
  if (node) return node;

  const python = classifyPython(rootDir);
  if (python) return python;

  if (pkg) {
    const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
    if (deps.react || deps.preact || deps.vue || deps.svelte) return { kind: 'spa' };
  }
  return { kind: hasHtml(rootDir) ? 'static' : 'unknown' };
}

// ---------- persisted-config helpers ----------

function backendConfigFor(test) {
  try {
    const v = JSON.parse(test.backend_config || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

function isServerTest(test) {
  const cfg = backendConfigFor(test);
  return !!cfg && cfg.kind === 'server';
}

// Returns an error string, or null if valid. Shape per spec §5; loose on
// purpose — unknown keys pass through so configs survive spec growth.
function validateBackendConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'backend_config must be an object.';
  if (!['static', 'spa', 'server', 'unknown'].includes(v.kind)) return "kind must be 'static', 'spa' or 'server'.";
  if (v.kind !== 'server') return null;
  if (v.runtime != null && !RUNTIMES.includes(v.runtime)) return `runtime must be one of ${RUNTIMES.join(', ')}.`;
  if (!v.start || typeof v.start.cmd !== 'string' || !v.start.cmd.trim()) return 'start.cmd is required for server tests.';
  if (v.start.port != null && !Number.isInteger(v.start.port)) return 'start.port must be an integer.';
  if (v.db && !DB_KINDS.includes(v.db.kind || 'none')) return `db.kind must be one of ${DB_KINDS.join(', ')}.`;
  if (v.seed && !SEED_MODES.includes(v.seed.mode || 'none')) return `seed.mode must be one of ${SEED_MODES.join(', ')}.`;
  if (v.seed && v.seed.mode === 'command' && (typeof v.seed.command !== 'string' || !v.seed.command.trim())) {
    return 'seed.command is required when seed.mode is "command".';
  }
  if (v.auth && !AUTH_MODES.includes(v.auth.mode || 'none')) return `auth.mode must be one of ${AUTH_MODES.join(', ')}.`;
  if (v.env && (typeof v.env !== 'object' || Object.values(v.env).some((x) => typeof x !== 'string'))) {
    return 'env must map variable names to strings.';
  }
  if (v.install != null && v.install !== false) {
    if (typeof v.install !== 'object' || Array.isArray(v.install)) {
      return 'install must be an object or false.';
    }
    if (v.install.cmd != null && typeof v.install.cmd !== 'string') return 'install.cmd must be a string.';
    // Opting dependency lifecycle scripts back on is a deliberate choice to
    // execute arbitrary code from every transitive dependency (runner.js
    // installPlan), so it has to be an explicit boolean.
    if (v.install.allowScripts != null && typeof v.install.allowScripts !== 'boolean') {
      return 'install.allowScripts must be a boolean.';
    }
  }
  if (v.stubs) {
    if (!Array.isArray(v.stubs)) return 'stubs must be an array.';
    for (const s of v.stubs) {
      if (!s || typeof s.match !== 'string' || !s.match.trim()) return 'Each stub needs a match pattern.';
      const status = Number(s.status || 200);
      if (!Number.isInteger(status) || status < 100 || status > 599) return 'Stub status must be an HTTP status code.';
      if (s.body != null && typeof s.body !== 'string') return 'Stub body must be a string.';
    }
  }
  return null;
}

module.exports = { classify, backendConfigFor, isServerTest, validateBackendConfig };
