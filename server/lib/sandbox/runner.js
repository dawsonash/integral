// Sandbox lifecycle (spec §3): provision an ephemeral DB, run the app's own
// schema setup against it, seed fake rows, boot the app as a child process
// with an injected environment (dummy secrets, DB coords, stub proxy), and
// health-check until it answers. Prototype posture per spec §9: trusted repos
// only — the app runs behind a uid + cgroup boundary (confine.js), not in a
// container.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { artifactRoot } = require('../artifacts');
const sandboxDb = require('./db');
const { seedFaker } = require('./seed');
const { establish } = require('./auth');
const { startStubs } = require('./stubs');
const { preflight, spawnConfined, killConfined, unitFor } = require('./confine');

const MAX_LOG_LINES = 300;

// Python apps get a virtualenv inside the artifact dir rather than polluting
// the host interpreter, and the sentinel marks a *completed* install (a bare
// venv dir would also exist after a pip failure, silently skipping the retry).
const VENV_DIR = '.integral-venv';
const VENV_READY = `${VENV_DIR}/.integral-installed`;

function pythonBin() {
  return process.env.INTEGRAL_PYTHON || 'python3';
}

function pushLog(logs, label, chunk) {
  for (const line of String(chunk).split('\n')) {
    if (!line.trim()) continue;
    logs.push(`[${label}] ${line}`);
    if (logs.length > MAX_LOG_LINES) logs.shift();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Run a setup command (schema/seed/install) to completion; output lands in the
// sandbox log so failures are diagnosable from the boot-error page. Each step
// gets its own scope unit so a leftover scope can never collide with the app's.
function runCmd(cmd, { cwd, env, logs, label, timeoutMs = 120000, confined, unit, profile = 'app' }) {
  return new Promise((resolve, reject) => {
    pushLog(logs, label, `$ ${cmd}`);
    const stepUnit = `${unit}-${label}`;
    const proc = spawnConfined(cmd, { cwd, env, unit: stepUnit, profile, confined });
    proc.stdout.on('data', (d) => pushLog(logs, label, d));
    proc.stderr.on('data', (d) => pushLog(logs, label, d));
    const timer = setTimeout(() => {
      // Killing the local child only kills sudo; the scope holds the actual
      // work, so it has to be stopped by name.
      if (confined) killConfined(stepUnit);
      proc.kill('SIGKILL');
      reject(new Error(`${label} command timed out after ${timeoutMs / 1000}s: ${cmd}`));
    }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} command failed (exit ${code}): ${cmd}`));
    });
  });
}

// Dependency installation, per runtime. A pulled repo arrives without its
// dependency tree, so the app can't even import its framework. Installed once
// per pull (the artifact dir persists across sandbox boots), and it needs real
// network — so it runs *without* the stub-proxy env, before the app starts.
// Returns null when nothing needs installing.
function installPlan(root, config) {
  if (config.install === false) return null;
  const custom = config.install?.cmd;

  if ((config.runtime || 'node') === 'python') {
    if (fs.existsSync(path.join(root, VENV_READY))) return null;
    const req = ['requirements.txt', 'requirements/base.txt', 'requirements/common.txt']
      .find((r) => fs.existsSync(path.join(root, r)));
    const install = custom
      || (req && `"${VENV_DIR}/bin/pip" install -q -r ${req}`)
      || (fs.existsSync(path.join(root, 'pyproject.toml')) && `"${VENV_DIR}/bin/pip" install -q .`);
    if (!install) return null;
    // venv creation is idempotent, so a retry after a failed pip reuses it.
    return { cmd: `${pythonBin()} -m venv ${VENV_DIR} && ${install} && touch ${VENV_READY}` };
  }

  if (!fs.existsSync(path.join(root, 'package.json'))) return null;
  if (fs.existsSync(path.join(root, 'node_modules'))) return null;
  // postinstall scripts are arbitrary code from every transitive dependency,
  // and they run before the app itself does — so they are off unless the test
  // owner deliberately turns them back on. Packages that fetch prebuilt
  // binaries this way (better-sqlite3, prisma) need install.allowScripts.
  const scripts = config.install?.allowScripts === true ? '' : ' --ignore-scripts';
  return {
    cmd: custom || (fs.existsSync(path.join(root, 'package-lock.json'))
      ? `npm ci --no-audit --no-fund${scripts}`
      : `npm install --no-audit --no-fund${scripts}`),
  };
}

// The environment handed to the app: slim base (never Integral's own
// process.env — the whole point is that no real secret reaches the sandbox),
// then the config's dummy values, then ephemeral-DB coordinates under every
// conventional name plus the config's envMap, then the stub proxy.
function buildEnv(config, handle) {
  const env = {
    PATH: process.env.PATH,
    // Never Integral's own HOME. The service user's home *is* the app root
    // (deploy/README.md creates it with `useradd -d /opt/integral`), which
    // holds .env and data/integral.db — so passing it through would hand the
    // sandboxed app a signpost to every secret this process took care not to
    // put in its environment. The artifact dir is a writable home of its own,
    // and it gets cleaned up with the artifact.
    HOME: artifactRoot(handle.testId),
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
    // development, not production: production presets (secure cookies, strict
    // TLS) would break an http://127.0.0.1 sandbox.
    NODE_ENV: 'development',
    ...(config.env || {}),
  };
  if ((config.runtime || 'node') === 'python') {
    // Put the virtualenv first on PATH so `python`, `flask`, `uvicorn` and
    // `alembic` all resolve to it — that's what makes the schema and seed
    // commands run against the app's own dependencies. Prepended before the
    // venv exists (buildEnv runs ahead of the install step); by the time
    // anything is spawned with this env, it does.
    env.PATH = `${path.join(artifactRoot(handle.testId), VENV_DIR, 'bin')}:${env.PATH}`;
    // Unbuffered, or the app's stdout only reaches the sandbox log on exit —
    // which is exactly when a developer needs it most.
    env.PYTHONUNBUFFERED = '1';
  }
  const c = handle.coords;
  if (c) {
    const tokens = {
      $HOST: c.host, $PORT: String(c.port), $USER: c.user,
      $PASSWORD: c.password, $DB: c.database, $URL: c.url,
    };
    Object.assign(env, {
      DATABASE_URL: c.url,
      PGHOST: c.host, PGPORT: String(c.port), PGUSER: c.user, PGPASSWORD: c.password, PGDATABASE: c.database,
      POSTGRES_HOST: c.host, POSTGRES_PORT: String(c.port), POSTGRES_USER: c.user,
      POSTGRES_PASSWORD: c.password, POSTGRES_DB: c.database,
    });
    for (const [key, value] of Object.entries(config.db?.envMap || {})) {
      env[key] = tokens[value] !== undefined ? tokens[value] : value;
    }
  }
  if (handle.stub) Object.assign(env, handle.stub.env);
  env.PORT = String(handle.port);
  return env;
}

async function waitReady(handle, readyPath, timeoutMs) {
  const url = handle.upstreamOrigin + (readyPath || '/');
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    if (handle.exited !== null) {
      throw new Error(`App exited with code ${handle.exited} before answering ${url}.`);
    }
    try {
      // Any HTTP response — even a 500 — means the server is up.
      await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`App did not answer ${url} within ${(timeoutMs || 30000) / 1000}s.`);
}

async function runSqlFile(handle, root, rel, logs) {
  const full = path.join(root, rel);
  pushLog(logs, 'sql', `applying ${rel}`);
  const sql = fs.readFileSync(full, 'utf8');
  await sandboxDb.withDb(handle.coords, (query) => query(sql));
}

async function boot(test, config) {
  const root = artifactRoot(test.id);
  const logs = [];
  const start = config.start || {};
  if (!start.cmd) throw new Error('backend_config.start.cmd is not set.');
  // Before anything with side effects: a host that cannot confine the child
  // must fail here, not after it has provisioned a database and started
  // running the repo's code as the service user.
  const confined = preflight().mode === 'systemd';
  const port = start.port || (await freePort());
  const handle = {
    testId: test.id,
    port,
    upstreamOrigin: `http://127.0.0.1:${port}`,
    logs,
    proc: null,
    coords: null,
    seeded: {},
    auth: null,
    stub: null,
    exited: null,
    confined,
    unit: unitFor(test.id),
  };
  try {
    // 1. throwaway DB (postgres only; sqlite apps own their file, 'none' skips)
    if ((config.db?.kind || 'none') === 'postgres') {
      handle.coords = await sandboxDb.provision(test.id);
      pushLog(logs, 'db', `provisioned ${handle.coords.database}`);
    }

    // 2. outbound stubs — always on, so un-stubbed egress is denied for every
    // client that honors proxy env (see stubs.js for the honest limits)
    handle.stub = await startStubs(config.stubs || []);
    const env = buildEnv(config, handle);

    // 2b. dependencies (see installPlan): real network, no stub proxy.
    const install = installPlan(root, config);
    if (install) {
      const installEnv = { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, TMPDIR: env.TMPDIR };
      // The 'install' profile is the one moment the sandbox gets real network
      // (npm/pypi). It is still denied link-local — cloud instance metadata —
      // and RFC1918, so a hostile package cannot reach IAM credentials or
      // anything else on the host's network.
      await runCmd(install.cmd, {
        cwd: root, env: installEnv, logs, label: 'install', timeoutMs: 300000,
        confined, unit: handle.unit, profile: 'install',
      });
    }

    // 3. the app's own schema setup, pointed at the ephemeral DB
    if (config.db?.schemaCmd) {
      await runCmd(config.db.schemaCmd, { cwd: root, env, logs, label: 'schema', confined, unit: handle.unit });
    } else if (config.db?.schemaSql) {
      await runSqlFile(handle, root, config.db.schemaSql, logs);
    }

    // 4. fake rows
    const seed = config.seed || {};
    if (seed.mode === 'faker' && handle.coords && Object.keys(seed.tables || {}).length) {
      handle.seeded = await sandboxDb.withDb(handle.coords, (query) => seedFaker(query, seed.tables));
      pushLog(logs, 'seed', `seeded ${Object.keys(handle.seeded).join(', ')}`);
    } else if (seed.mode === 'command' && seed.command) {
      if (seed.command.startsWith('__sql:')) await runSqlFile(handle, root, seed.command.slice(6), logs);
      else await runCmd(seed.command, { cwd: root, env, logs, label: 'seed', confined, unit: handle.unit });
    }

    // 5. boot the app (own process group so teardown can kill shell + children)
    pushLog(logs, 'app', `$ ${start.cmd}`);
    handle.proc = spawnConfined(start.cmd, {
      cwd: root, env, unit: handle.unit, profile: 'app', detached: true, confined,
    });
    handle.proc.stdout.on('data', (d) => pushLog(logs, 'app', d));
    handle.proc.stderr.on('data', (d) => pushLog(logs, 'app', d));
    handle.proc.on('exit', (code) => { handle.exited = code == null ? -1 : code; });

    // 6. health-check
    await waitReady(handle, start.readyPath, start.readyTimeoutMs);

    // 7. fake-user session
    handle.auth = await establish(config, {
      coords: handle.coords,
      seeded: handle.seeded,
      env,
      upstreamOrigin: handle.upstreamOrigin,
    });
    pushLog(logs, 'sandbox', 'ready');
    return handle;
  } catch (e) {
    await teardown(handle).catch(() => {});
    e.sandboxLogs = logs.slice();
    throw e;
  }
}

async function teardown(handle) {
  if (!handle) return;
  // Stop the scope first: it kills every process in the cgroup, including
  // anything that detached with setsid to survive the process-group kill
  // below. Unconfined, that escape is simply available — which is one more
  // reason production requires confinement.
  if (handle.confined && handle.unit) {
    try { killConfined(handle.unit); } catch (e) { /* best effort */ }
  }
  if (handle.proc && handle.exited === null) {
    // Negative pid = the whole process group (shell:true means the app is a
    // grandchild; killing just the shell would orphan it).
    try { process.kill(-handle.proc.pid, 'SIGTERM'); } catch (e) { try { handle.proc.kill('SIGTERM'); } catch (e2) {} }
    await new Promise((r) => setTimeout(r, 500));
    if (handle.exited === null) {
      try { process.kill(-handle.proc.pid, 'SIGKILL'); } catch (e) {}
    }
  }
  if (handle.stub) await handle.stub.close().catch(() => {});
  if (handle.coords) await sandboxDb.drop(handle.testId).catch(() => {});
}

module.exports = { boot, teardown, buildEnv, freePort, installPlan };
