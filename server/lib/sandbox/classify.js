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

// The reproducible schema setup (§8's irreducible floor), cheapest match wins.
function detectSchema(rootDir, pkg) {
  for (const rel of ['scripts/setup-test-db.sh', 'scripts/setup-db.sh', 'scripts/init-db.sh']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { schemaCmd: `bash ${rel}` };
  }
  for (const s of ['db:setup', 'db:migrate', 'migrate', 'setup-db']) {
    if (pkg.scripts && pkg.scripts[s]) return { schemaCmd: `npm run ${s}` };
  }
  for (const rel of ['init.sql', 'schema.sql', 'db/init.sql', 'db/schema.sql', 'sql/schema.sql', 'src/init_data/create.sql']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { schemaSql: rel };
  }
  return {};
}

function detectSeed(rootDir, pkg) {
  if (pkg.scripts && pkg.scripts.seed) return { mode: 'command', command: 'npm run seed' };
  for (const rel of ['scripts/seed.js', 'db/seed.js', 'seed.js']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { mode: 'command', command: `node ${rel}` };
  }
  for (const rel of ['db/seed.sql', 'sql/seed.sql', 'src/init_data/insert.sql']) {
    if (fs.existsSync(path.join(rootDir, rel))) return { mode: 'command', command: `__sql:${rel}` };
  }
  // Faker mode with no tables yet: the dev fills in seed.tables ("the Lorem
  // Ipsum") in setup, or points at their own script.
  return { mode: 'faker', tables: {} };
}

function classify(rootDir) {
  const pkg = readJson(path.join(rootDir, 'package.json'));
  if (!pkg) return { kind: hasHtml(rootDir) ? 'static' : 'unknown' };
  const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };

  let framework = null;
  for (const [dep, name] of Object.entries(SERVER_DEPS)) {
    if (deps[dep]) { framework = name; break; }
  }
  if (!framework) {
    if (deps.react || deps.preact || deps.vue || deps.svelte) return { kind: 'spa' };
    return { kind: hasHtml(rootDir) ? 'static' : 'unknown' };
  }

  const startCmd =
    (pkg.scripts && (pkg.scripts.start || pkg.scripts.dev)) ||
    (pkg.main ? `node ${pkg.main}` : 'node src/index.js');

  const dbKind = deps.pg || deps['pg-promise'] || deps.postgres
    ? 'postgres'
    : deps['better-sqlite3'] || deps.sqlite3 ? 'sqlite' : 'none';

  // Dummy secrets: every knob the app documents in its env file gets a value,
  // so boot never dies on a missing var — and no real secret is ever used.
  // DB-coordinate vars become envMap entries resolved from the ephemeral DB.
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
    framework,
    start: { cmd: startCmd, ...(port ? { port } : {}), readyPath: '/', readyTimeoutMs: 30000 },
    db: { kind: dbKind, ...detectSchema(rootDir, pkg), envMap },
    seed: detectSeed(rootDir, pkg),
    auth,
    env,
    stubs: [],
  };
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
