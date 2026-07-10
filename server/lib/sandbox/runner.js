// Sandbox lifecycle (spec §3): provision an ephemeral DB, run the app's own
// schema setup against it, seed fake rows, boot the app as a child process
// with an injected environment (dummy secrets, DB coords, stub proxy), and
// health-check until it answers. Prototype posture per spec §9: trusted/local
// only — the app runs as a host child process, not a container.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { artifactRoot } = require('../artifacts');
const sandboxDb = require('./db');
const { seedFaker } = require('./seed');
const { establish } = require('./auth');
const { startStubs } = require('./stubs');

const MAX_LOG_LINES = 300;

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

// Run a setup command (schema/seed) to completion; output lands in the
// sandbox log so failures are diagnosable from the boot-error page.
function runCmd(cmd, { cwd, env, logs, label, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    pushLog(logs, label, `$ ${cmd}`);
    const proc = spawn(cmd, { shell: true, cwd, env });
    proc.stdout.on('data', (d) => pushLog(logs, label, d));
    proc.stderr.on('data', (d) => pushLog(logs, label, d));
    const timer = setTimeout(() => {
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

// The environment handed to the app: slim base (never Integral's own
// process.env — the whole point is that no real secret reaches the sandbox),
// then the config's dummy values, then ephemeral-DB coordinates under every
// conventional name plus the config's envMap, then the stub proxy.
function buildEnv(config, handle) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
    // development, not production: production presets (secure cookies, strict
    // TLS) would break an http://127.0.0.1 sandbox.
    NODE_ENV: 'development',
    ...(config.env || {}),
  };
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

    // 2b. dependencies: a pulled repo arrives without node_modules, so the
    // app can't even require its framework. Installed once per pull (the
    // artifact dir persists across sandbox boots). npm needs real network —
    // it runs *without* the stub-proxy env, before the app ever starts.
    if (config.install !== false && fs.existsSync(path.join(root, 'package.json')) &&
        !fs.existsSync(path.join(root, 'node_modules'))) {
      const installCmd = config.install?.cmd ||
        (fs.existsSync(path.join(root, 'package-lock.json'))
          ? 'npm ci --no-audit --no-fund'
          : 'npm install --no-audit --no-fund');
      const npmEnv = { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, TMPDIR: env.TMPDIR };
      await runCmd(installCmd, { cwd: root, env: npmEnv, logs, label: 'install', timeoutMs: 300000 });
    }

    // 3. the app's own schema setup, pointed at the ephemeral DB
    if (config.db?.schemaCmd) {
      await runCmd(config.db.schemaCmd, { cwd: root, env, logs, label: 'schema' });
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
      else await runCmd(seed.command, { cwd: root, env, logs, label: 'seed' });
    }

    // 5. boot the app (own process group so teardown can kill shell + children)
    pushLog(logs, 'app', `$ ${start.cmd}`);
    handle.proc = spawn(start.cmd, { shell: true, cwd: root, env, detached: true });
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

module.exports = { boot, teardown, buildEnv, freePort };
