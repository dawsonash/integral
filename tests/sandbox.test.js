// Fake-backend sandbox (docs/fake-backend-spec.md): classification, config
// validation, seed/stub/proxy helpers, and a real boot of the server-app
// fixture behind the same-origin proxy. Postgres provisioning has its own
// test that skips when no local Postgres is reachable.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-sbx-test-'));
process.env.INTEGRAL_MIN_DURATION_MS = '400';

const app = require('../server/app');
const { classify, validateBackendConfig } = require('../server/lib/sandbox/classify');
const { globToRe } = require('../server/lib/sandbox/stubs');
const { seedValue, resolveSeedTokens } = require('../server/lib/sandbox/seed');
const { rewriteLocation, mergeCookies } = require('../server/lib/sandbox/proxy');
const registry = require('../server/lib/sandbox/registry');
const runner = require('../server/lib/sandbox/runner');
const sandboxDb = require('../server/lib/sandbox/db');
const policy = require('../server/lib/sandbox/policy');
const confine = require('../server/lib/sandbox/confine');

let server;
let base;
let cookie;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  const res = await fetch(`${base}/auth/dev?login=sbxdev`, { redirect: 'manual' });
  cookie = res.headers.getSetCookie()[0].split(';')[0];
});

after(async () => {
  await registry.teardownAll();
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

// ---------- classification ----------

test('classify detects a server app and drafts its backend config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { start: 'node src/index.js', seed: 'node scripts/seed.js' },
    dependencies: { express: '^4.0.0', 'express-handlebars': '^7.0.0', pg: '^8.0.0', 'express-session': '^1.17.0' },
  }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'app.listen(process.env.PORT || 3000);');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'setup-test-db.sh'), 'psql …');
  fs.writeFileSync(path.join(dir, '.env.example'),
    'POSTGRES_HOST=localhost\nPOSTGRES_DB=mydb\nSESSION_SECRET=\nSTRIPE_KEY=sk_live_x\nPORT=3000\n');

  const cfg = classify(dir);
  assert.equal(cfg.kind, 'server');
  assert.equal(cfg.framework, 'express');
  assert.equal(cfg.start.cmd, 'node src/index.js');
  assert.equal(cfg.start.port, undefined); // honors PORT env → runner picks a free one
  assert.equal(cfg.db.kind, 'postgres');
  assert.equal(cfg.db.schemaCmd, 'bash scripts/setup-test-db.sh');
  assert.equal(cfg.db.envMap.POSTGRES_HOST, '$HOST');
  assert.equal(cfg.db.envMap.POSTGRES_DB, '$DB');
  assert.equal(cfg.seed.mode, 'command');
  assert.equal(cfg.seed.command, 'npm run seed');
  assert.equal(cfg.auth.mode, 'session-cookie');
  // Dummy values, never real secrets; PORT belongs to the runner.
  assert.equal(cfg.env.SESSION_SECRET, 'dummy');
  assert.equal(cfg.env.STRIPE_KEY, 'sk_live_x');
  assert.equal(cfg.env.PORT, undefined);
  assert.equal(validateBackendConfig(cfg), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classify drafts a Django config: migrate, loaddata, dummy settings env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-py-'));
  fs.writeFileSync(path.join(dir, 'requirements.txt'),
    '# comment\n-r base.txt\nDjango==5.0.1\npsycopg2-binary==2.9.9 ; sys_platform != "win32"\n');
  fs.writeFileSync(path.join(dir, 'manage.py'), 'import django');
  fs.mkdirSync(path.join(dir, 'shop', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shop', 'fixtures', 'demo.json'), '[]');
  fs.writeFileSync(path.join(dir, '.env.example'), 'SECRET_KEY=\nDATABASE_URL=postgres://real/db\nSTRIPE_KEY=sk_live_x\n');

  const cfg = classify(dir);
  assert.equal(cfg.kind, 'server');
  assert.equal(cfg.runtime, 'python');
  assert.equal(cfg.framework, 'django');
  assert.equal(cfg.start.cmd, 'python manage.py runserver --noreload 127.0.0.1:$PORT');
  assert.equal(cfg.start.port, undefined); // the runner picks a free one, $PORT carries it
  assert.equal(cfg.db.kind, 'postgres');
  assert.equal(cfg.db.schemaCmd, 'python manage.py migrate --noinput');
  assert.equal(cfg.db.envMap.DATABASE_URL, '$URL'); // repointed at the ephemeral DB
  assert.equal(cfg.seed.command, 'python manage.py loaddata demo');
  assert.equal(cfg.auth.mode, 'none'); // no cookie forgery for Python; dev picks 'login'
  assert.equal(cfg.env.SECRET_KEY, 'dummy');
  assert.equal(cfg.env.ALLOWED_HOSTS, '*'); // or every proxied request is a DisallowedHost
  assert.equal(cfg.env.STRIPE_KEY, 'sk_live_x');
  assert.equal(validateBackendConfig(cfg), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classify finds the Flask and FastAPI app objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-py-'));

  fs.writeFileSync(path.join(dir, 'pyproject.toml'),
    '[project]\ndependencies = ["flask>=3", "gunicorn"]\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.py'), 'from flask import Flask\nsite = Flask(__name__)\n');
  let cfg = classify(dir);
  assert.equal(cfg.framework, 'flask');
  assert.equal(cfg.start.cmd, 'flask --app src.app:site run --host 127.0.0.1 --port $PORT');
  assert.equal(cfg.db.kind, 'none');
  assert.equal(cfg.seed.mode, 'faker');

  fs.rmSync(path.join(dir, 'pyproject.toml'));
  fs.writeFileSync(path.join(dir, 'Pipfile'), '[packages]\nfastapi = "*"\nasyncpg = "*"\n');
  fs.writeFileSync(path.join(dir, 'main.py'), 'app = FastAPI()\n');
  fs.writeFileSync(path.join(dir, 'alembic.ini'), '[alembic]\n');
  cfg = classify(dir);
  assert.equal(cfg.framework, 'fastapi');
  assert.equal(cfg.start.cmd, 'uvicorn main:app --host 127.0.0.1 --port $PORT');
  assert.equal(cfg.db.kind, 'postgres');
  assert.equal(cfg.db.schemaCmd, 'alembic upgrade head');
  assert.equal(validateBackendConfig(cfg), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Python server repo carrying a front-end package.json still classifies as server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-py-'));
  // Tailwind for the asset pipeline, Django for everything that matters.
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { tailwindcss: '^3.0.0' } }));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'django\n');
  fs.writeFileSync(path.join(dir, 'manage.py'), 'import django');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>'); // would otherwise read as static
  const cfg = classify(dir);
  assert.equal(cfg.kind, 'server');
  assert.equal(cfg.runtime, 'python');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Python repo with no recognizable framework is not a server test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-py-'));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests\nnumpy\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  assert.equal(classify(dir).kind, 'static');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installPlan: per-runtime dependency install, skipped once satisfied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));

  // Node: lockfile picks `npm ci`, and an existing tree skips entirely.
  // Lifecycle scripts are off by default — they are arbitrary code from every
  // transitive dependency, running before the app itself does.
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.match(runner.installPlan(dir, {}).cmd, /^npm install/);
  assert.match(runner.installPlan(dir, {}).cmd, /--ignore-scripts/);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  assert.match(runner.installPlan(dir, {}).cmd, /^npm ci/);
  assert.match(runner.installPlan(dir, {}).cmd, /--ignore-scripts/);
  // ...and back on only by explicit opt-in (better-sqlite3, prisma et al).
  assert.doesNotMatch(
    runner.installPlan(dir, { install: { allowScripts: true } }).cmd,
    /--ignore-scripts/
  );
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(runner.installPlan(dir, {}), null);
  assert.equal(runner.installPlan(dir, { install: false }), null);

  // Python: venv + pip, and the sentinel (not the venv dir) gates the retry.
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\n');
  const plan = runner.installPlan(dir, { runtime: 'python' });
  assert.match(plan.cmd, /-m venv \.integral-venv/);
  assert.match(plan.cmd, /pip" install -q -r requirements\.txt/);
  fs.mkdirSync(path.join(dir, '.integral-venv'));
  assert.ok(runner.installPlan(dir, { runtime: 'python' }), 'bare venv dir must not count as installed');
  fs.writeFileSync(path.join(dir, '.integral-venv', '.integral-installed'), '');
  assert.equal(runner.installPlan(dir, { runtime: 'python' }), null);

  assert.equal(runner.installPlan(dir, { runtime: 'python', install: { cmd: 'x' } }), null); // sentinel wins
  fs.rmSync(path.join(dir, '.integral-venv'), { recursive: true, force: true });
  assert.match(runner.installPlan(dir, { runtime: 'python', install: { cmd: 'poetry install' } }).cmd, /poetry install/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildEnv puts the virtualenv ahead of the host interpreter', () => {
  const nodeEnv = runner.buildEnv({}, { testId: 'abc', port: 1 });
  assert.equal(nodeEnv.PATH, process.env.PATH);
  assert.equal(nodeEnv.PYTHONUNBUFFERED, undefined);

  const pyEnv = runner.buildEnv({ runtime: 'python' }, { testId: 'abc', port: 1 });
  assert.match(pyEnv.PATH, /\.integral-venv\/bin:/);
  assert.equal(pyEnv.PYTHONUNBUFFERED, '1');
});

test('classify keeps static and SPA repos off the sandbox path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  assert.equal(classify(dir).kind, 'spa');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  assert.equal(classify(dir).kind, 'static');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateBackendConfig rejects malformed configs', () => {
  assert.ok(validateBackendConfig(null));
  assert.ok(validateBackendConfig({ kind: 'server' })); // no start.cmd
  assert.ok(validateBackendConfig({ kind: 'server', start: { cmd: 'node x' }, db: { kind: 'mysql' } }));
  assert.ok(validateBackendConfig({ kind: 'server', start: { cmd: 'node x' }, stubs: [{}] }));
  assert.equal(validateBackendConfig({ kind: 'server', start: { cmd: 'node x' } }), null);
});

// ---------- helpers ----------

test('stub glob matching', () => {
  assert.ok(globToRe('api.stripe.com/**').test('api.stripe.com/v1/charges'));
  assert.ok(globToRe('api.stripe.com').test('api.stripe.com/v1/charges'));
  assert.ok(!globToRe('api.stripe.com/**').test('api.stripe.com.evil.com/x'));
  assert.ok(globToRe('*.resend.com/emails').test('api.resend.com/emails'));
  assert.ok(!globToRe('*.resend.com/emails').test('api.resend.com/other'));
});

test('seed value specs: faker paths, $i, literals, $SEED refs', () => {
  assert.equal(typeof seedValue('faker.internet.userName', 0), 'string');
  assert.equal(seedValue('$i', 4), 4);
  assert.equal(seedValue('plain text', 0), 'plain text');
  assert.equal(seedValue(42, 0), 42);
  assert.throws(() => seedValue('faker.nope.nothing', 0));
  const seeded = { users: [{ user_id: 7 }] };
  assert.equal(resolveSeedTokens('$SEED.users[0].user_id', seeded), 7);
  assert.throws(() => resolveSeedTokens('$SEED.users[3].user_id', seeded));
});

test('proxy location rewriting and cookie merging', () => {
  const up = 'http://127.0.0.1:5555';
  assert.equal(rewriteLocation('/home', up, '/t/abc/app/'), '/t/abc/app/home');
  assert.equal(rewriteLocation(`${up}/login`, up, '/t/abc/app/'), '/t/abc/app/login');
  assert.equal(rewriteLocation('https://other.example.com/x', up, '/t/abc/app/'), 'https://other.example.com/x');
  // injected fake session must beat the browser's stale cookie
  assert.equal(
    mergeCookies('connect.sid=old; other=1', ['connect.sid=new']),
    'connect.sid=old; other=1'.replace('old', 'new')
  );
});

// ---------- fixture boot behind the proxy ----------

const FIXTURE_CONFIG = {
  kind: 'server',
  framework: 'express',
  install: false, // node:http only — don't npm-install the decoy express dep
  start: { cmd: 'node server.js', readyPath: '/', readyTimeoutMs: 15000 },
  db: { kind: 'none' },
  seed: { mode: 'none' },
  auth: {
    mode: 'session-cookie',
    cookie: { strategy: 'login' },
    login: { path: '/login', method: 'POST', body: {} },
  },
  env: { FIXTURE_GREETING: 'hello-sandbox' },
  stubs: [],
};

async function createServerTest() {
  const fd = new FormData();
  fd.append('name', 'Server fixture');
  const dir = path.join(__dirname, '..', 'fixtures', 'server-app');
  const paths = ['package.json', 'server.js'];
  for (const p of paths) fd.append('files', new Blob([fs.readFileSync(path.join(dir, p))]), p);
  fd.append('paths', JSON.stringify(paths));
  const res = await fetch(`${base}/api/tests`, { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return res.json();
}

test('server-rendered test: classify on create, boot, proxy, inject, auth, teardown', async () => {
  const t = await createServerTest();
  // Classified as a server test on create (no static HTML anywhere).
  assert.equal(t.backendConfig.kind, 'server');
  assert.equal(t.backendConfig.framework, 'express');
  assert.equal(t.backendConfig.start.cmd, 'node server.js');
  assert.equal(t.entry_path, '');

  // Dev confirms/edits the config (fixture needs no DB; login-bootstrap auth).
  const patch = await fetch(`${base}/api/tests/${t.id}/backend-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ backendConfig: FIXTURE_CONFIG }),
  });
  assert.equal(patch.status, 200);

  // First request boots the sandbox, then proxies. Recorder + mount rebase in.
  const page = await fetch(`${base}/t/${t.id}/app/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /__integral\/recorder\.js/);
  assert.match(html, /hello-sandbox/); // injected env reached the app
  assert.match(html, new RegExp(`href="/t/${t.id}/app/style\\.css"`)); // root-absolute rebased
  assert.equal(page.headers.get('content-security-policy'), null); // stripped so injection runs
  assert.equal(page.headers.get('x-frame-options'), null);

  // Gated page renders because the sandbox established a fake session at boot.
  const gated = await fetch(`${base}/t/${t.id}/app/gated`);
  assert.equal(gated.status, 200);
  assert.match(await gated.text(), /Secret page/);

  // Interactive flow: form POST goes through, redirect stays under the mount.
  const post = await fetch(`${base}/t/${t.id}/app/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=proxied+item',
    redirect: 'manual',
  });
  assert.equal(post.status, 302);
  assert.equal(post.headers.get('location'), `/t/${t.id}/app/`);
  const after1 = await (await fetch(`${base}/t/${t.id}/app/`)).text();
  assert.match(after1, /proxied item/);

  // Assets stream through untouched; view mode carries no recorder.
  const css = await fetch(`${base}/t/${t.id}/app/style.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.doesNotMatch(await css.text(), /__integral/);
  const view = await (await fetch(`${base}/t/${t.id}/view/`)).text();
  assert.doesNotMatch(view, /recorder\.js/);
  const preview = await (await fetch(`${base}/t/${t.id}/preview/`)).text();
  assert.match(preview, /__integral\/picker\.js/);

  // Deleting the test tears the sandbox down with it.
  const del = await fetch(`${base}/api/tests/${t.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.status, 200);
});

test('broken start command surfaces a boot-error page, not a hang', async () => {
  const t = await createServerTest();
  await fetch(`${base}/api/tests/${t.id}/backend-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      backendConfig: {
        ...FIXTURE_CONFIG,
        auth: { mode: 'none' },
        start: { cmd: 'node does-not-exist.js', readyPath: '/', readyTimeoutMs: 5000 },
      },
    }),
  });
  const page = await fetch(`${base}/t/${t.id}/app/`);
  assert.equal(page.status, 502);
  const html = await page.text();
  assert.match(html, /failed to start/i);
  assert.match(html, /does-not-exist/); // log tail is on the page
  await fetch(`${base}/api/tests/${t.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
});

// ---------- who may run code here (lib/sandbox/policy.js) ----------

// Booting a sandbox is remote code execution by design, so a production
// instance runs it only for an allowlist. The gate reads process.env on every
// call, so a production-shaped environment can be simulated in place.
function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Simulate a production instance to exercise the *entitlement* gate. Real
// production also demands confinement (confine.js), which no developer machine
// has — so this pins it off to keep these tests on one axis. The confinement
// gate has its own test below.
async function asProduction(allow, fn) {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllow = process.env.INTEGRAL_SANDBOX_ALLOW;
  const prevConfine = process.env.INTEGRAL_SANDBOX_CONFINE;
  setEnv('NODE_ENV', 'production');
  setEnv('INTEGRAL_SANDBOX_ALLOW', allow);
  setEnv('INTEGRAL_SANDBOX_CONFINE', 'off');
  try {
    return await fn();
  } finally {
    setEnv('NODE_ENV', prevNodeEnv);
    setEnv('INTEGRAL_SANDBOX_ALLOW', prevAllow);
    setEnv('INTEGRAL_SANDBOX_CONFINE', prevConfine);
  }
}

test('sandbox entitlement: off in production unless the owner is allowlisted', async () => {
  // Outside production it stays on, so local dev and this suite are untouched.
  assert.equal(policy.sandboxEnabledFor({ login: 'nobody' }), true);

  await asProduction(undefined, () => {
    assert.equal(policy.sandboxEnabledFor({ login: 'sbxdev' }), false);
    assert.equal(policy.sandboxEnabledFor(null), false);
  });
  await asProduction('someone,SBXDev', () => {
    assert.equal(policy.sandboxEnabledFor({ login: 'sbxdev' }), true); // case-insensitive
    assert.equal(policy.sandboxEnabledFor({ login: 'nobody' }), false);
  });
  await asProduction('*', () => {
    assert.equal(policy.sandboxEnabledFor({ login: 'anyone' }), true);
  });
});

test('a disallowed owner cannot create a server test or store a start command', async () => {
  await asProduction(undefined, async () => {
    const fd = new FormData();
    fd.append('name', 'Server fixture');
    const dir = path.join(__dirname, '..', 'fixtures', 'server-app');
    const paths = ['package.json', 'server.js'];
    for (const p of paths) fd.append('files', new Blob([fs.readFileSync(path.join(dir, p))]), p);
    fd.append('paths', JSON.stringify(paths));
    const res = await fetch(`${base}/api/tests`, { method: 'POST', body: fd, headers: { Cookie: cookie } });
    assert.equal(res.status, 400);
    // Honest about why: the repo was recognized, running it isn't permitted.
    assert.equal((await res.json()).error, 'server_app_unsupported');
  });
});

test('entitlement is re-checked at boot, not just at creation', async () => {
  // Created and configured while allowed — the row outlives the entitlement.
  const t = await createServerTest();
  const patch = await fetch(`${base}/api/tests/${t.id}/backend-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ backendConfig: FIXTURE_CONFIG }),
  });
  assert.equal(patch.status, 200);

  await asProduction(undefined, async () => {
    // Nothing spawns: the testee gets the preview notice, not an app.
    const page = await fetch(`${base}/t/${t.id}/app/`);
    assert.equal(page.status, 502);
    assert.match(await page.text(), /limited preview/i);
    // And the shell command surface is closed too.
    const blocked = await fetch(`${base}/api/tests/${t.id}/backend-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backendConfig: { ...FIXTURE_CONFIG, start: { cmd: 'touch /tmp/pwned' } } }),
    });
    assert.equal(blocked.status, 403);
  });

  // Allowlisting the owner turns it back on, same instance, same test.
  await asProduction('sbxdev', async () => {
    const page = await fetch(`${base}/t/${t.id}/app/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello-sandbox/);
  });

  await fetch(`${base}/api/tests/${t.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
});

test('the sandboxed app is never pointed at Integral\'s own home directory', () => {
  // $HOME on the service user is the app root — it holds .env and
  // data/integral.db. buildEnv must hand the child its artifact dir instead.
  const env = runner.buildEnv({}, { testId: 'abc', port: 1 });
  assert.notEqual(env.HOME, process.env.HOME);
  assert.match(env.HOME, /abc$/);
});

// ---------- confinement (server/lib/sandbox/confine.js) ----------

// Run fn with the confinement knobs pinned, then restore. The wrapper path is
// pointed at something absent so these exercise the "cannot confine" branches
// without needing root or systemd.
async function withConfine({ mode, nodeEnv, wrapper }, fn) {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    INTEGRAL_SANDBOX_CONFINE: process.env.INTEGRAL_SANDBOX_CONFINE,
    INTEGRAL_SANDBOX_WRAPPER: process.env.INTEGRAL_SANDBOX_WRAPPER,
  };
  setEnv('NODE_ENV', nodeEnv);
  setEnv('INTEGRAL_SANDBOX_CONFINE', mode);
  setEnv('INTEGRAL_SANDBOX_WRAPPER', wrapper || '/nonexistent/integral-sandbox-run');
  confine.resetCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) setEnv(k, v);
    confine.resetCache();
  }
}

test('confinement is required in production and optional outside it', async () => {
  const refuses = async (opts) => {
    await withConfine(opts, () => {
      assert.throws(() => confine.preflight(), (e) => e.code === 'SANDBOX_NOT_CONFINED');
    });
  };
  const allows = async (opts) => {
    await withConfine(opts, () => assert.equal(confine.preflight().mode, 'none'));
  };

  // Explicitly off: unconfined everywhere, no questions asked.
  await allows({ mode: 'off' });
  await allows({ mode: 'off', nodeEnv: 'production' });
  // Default 'auto' mirrors policy.js — permissive in dev, strict in production.
  await allows({ mode: 'auto' });
  await allows({ mode: undefined });
  await refuses({ mode: 'auto', nodeEnv: 'production' });
  await refuses({ mode: undefined, nodeEnv: 'production' });
  // 'require' is how a developer opts into production strictness locally.
  await refuses({ mode: 'require' });
  await refuses({ mode: 'require', nodeEnv: 'production' });

  // An unrecognised value must not read as "off".
  await refuses({ mode: 'yes-please', nodeEnv: 'production' });
});

test('a wrapper that is not root-owned is not trusted', async () => {
  // The wrapper holds the whole policy, so a copy anyone could edit is no
  // better than none — it must not satisfy preflight.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-'));
  const fake = path.join(dir, 'integral-sandbox-run');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fake, 0o777);
  await withConfine({ mode: 'require', wrapper: fake }, () => {
    assert.throws(() => confine.preflight(), (e) => e.code === 'SANDBOX_NOT_CONFINED');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight catches secrets the sandbox user could still read', () => {
  // The uid split is cosmetic if .env is left at 0644, so preflight stats the
  // secret files against the sandbox user rather than trusting the setup.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'STRIPE_SECRET_KEY=sk_live_x\n');
  const stranger = { uid: process.getuid() + 1000, gid: 999999, groups: [999999] };

  fs.chmodSync(f, 0o644);
  assert.match(confine.readableBy(f, stranger), /world-readable/);
  fs.chmodSync(f, 0o600);
  assert.equal(confine.readableBy(f, stranger), null);

  // Group-readable counts as reachable when the sandbox user is in that group,
  // whether it is their primary gid or a supplementary one.
  fs.chmodSync(f, 0o640);
  const gid = fs.statSync(f).gid;
  assert.match(confine.readableBy(f, { ...stranger, gid }), /readable by the sandbox user's group/);
  assert.match(
    confine.readableBy(f, { ...stranger, groups: [999999, gid] }),
    /readable by the sandbox user's group/
  );
  // Owning the file is the third way in.
  assert.match(
    confine.readableBy(f, { ...stranger, uid: process.getuid() }),
    /owned by the sandbox user/
  );

  assert.equal(confine.readableBy(path.join(dir, 'absent'), stranger), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unconfinable host refuses to boot instead of running as the service user', async () => {
  const t = await createServerTest();
  const patch = await fetch(`${base}/api/tests/${t.id}/backend-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ backendConfig: FIXTURE_CONFIG }),
  });
  assert.equal(patch.status, 200);

  await withConfine({ mode: 'require' }, async () => {
    const page = await fetch(`${base}/t/${t.id}/app/`);
    assert.equal(page.status, 502);
    // Fails closed, and says why rather than quietly downgrading.
    assert.match(await page.text(), /cannot be confined/i);
  });

  // A failed boot is remembered for ERROR_COOLDOWN_MS so a page full of asset
  // requests doesn't retry it per request; clear it before re-testing.
  await registry.teardown(t.id);

  // Same instance, same test: with confinement waived it boots normally, so the
  // refusal above is the gate and not a broken fixture.
  await withConfine({ mode: 'off' }, async () => {
    const page = await fetch(`${base}/t/${t.id}/app/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello-sandbox/);
  });

  await fetch(`${base}/api/tests/${t.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
});

// ---------- Python fixture boot behind the proxy ----------

const PYTHON = process.env.INTEGRAL_PYTHON || 'python3';

async function createPythonTest() {
  const fd = new FormData();
  fd.append('name', 'Python fixture');
  const dir = path.join(__dirname, '..', 'fixtures', 'python-app');
  const paths = ['requirements.txt', 'app.py'];
  for (const p of paths) fd.append('files', new Blob([fs.readFileSync(path.join(dir, p))]), p);
  fd.append('paths', JSON.stringify(paths));
  const res = await fetch(`${base}/api/tests`, { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return res.json();
}

test('python server test: classify on create, boot, proxy, inject, auth, teardown', async (t) => {
  if (spawnSync(PYTHON, ['-V']).status !== 0) {
    t.skip(`no ${PYTHON} on PATH (set INTEGRAL_PYTHON to enable)`);
    return;
  }
  const created = await createPythonTest();

  // Classified from requirements.txt alone — no package.json anywhere.
  assert.equal(created.backendConfig.kind, 'server');
  assert.equal(created.backendConfig.runtime, 'python');
  assert.equal(created.backendConfig.framework, 'flask');
  assert.equal(created.backendConfig.db.kind, 'postgres'); // psycopg2-binary
  assert.equal(created.entry_path, '');

  // Dev confirms/edits in setup. install: false means no virtualenv is built,
  // so the start command names the host interpreter rather than the venv's
  // `python`; the fixture is standard-library only and needs nothing else.
  const patch = await fetch(`${base}/api/tests/${created.id}/backend-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      backendConfig: {
        kind: 'server',
        runtime: 'python',
        framework: 'flask',
        install: false,
        start: { cmd: `${PYTHON} app.py`, readyPath: '/', readyTimeoutMs: 15000 },
        db: { kind: 'none' },
        seed: { mode: 'none' },
        auth: {
          mode: 'session-cookie',
          cookie: { strategy: 'login' },
          login: { path: '/login', method: 'POST', body: {} },
        },
        env: { FIXTURE_GREETING: 'hello-python' },
        stubs: [],
      },
    }),
  });
  assert.equal(patch.status, 200);

  // $PORT reached the app: the proxy only connects if it bound the free port
  // the runner picked and passed through the environment.
  const page = await fetch(`${base}/t/${created.id}/app/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /__integral\/recorder\.js/);
  assert.match(html, /hello-python/);
  assert.match(html, new RegExp(`href="/t/${created.id}/app/style\\.css"`));
  assert.equal(page.headers.get('x-frame-options'), null);

  // The framework-agnostic 'login' strategy stands in for Python's absent
  // cookie forgery: drive the app's real login endpoint, reuse its cookie.
  const gated = await fetch(`${base}/t/${created.id}/app/gated`);
  assert.equal(gated.status, 200);
  assert.match(await gated.text(), /Secret page/);

  const post = await fetch(`${base}/t/${created.id}/app/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=python+item',
    redirect: 'manual',
  });
  assert.equal(post.status, 302);
  assert.equal(post.headers.get('location'), `/t/${created.id}/app/`);
  assert.match(await (await fetch(`${base}/t/${created.id}/app/`)).text(), /python item/);

  const del = await fetch(`${base}/api/tests/${created.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.status, 200);
});

// ---------- ephemeral Postgres (skips without a local server) ----------

test('provision + faker seed + drop against local Postgres', async (t) => {
  try {
    await sandboxDb.provision('sbxtestdb');
  } catch (e) {
    if (e.code === 'SANDBOX_PG_UNREACHABLE') {
      t.skip('no local Postgres (set INTEGRAL_SANDBOX_PG_URL to enable)');
      return;
    }
    throw e;
  }
  try {
    const { seedFaker } = require('../server/lib/sandbox/seed');
    const coords = await sandboxDb.provision('sbxtestdb'); // re-provision must be idempotent
    const seeded = await sandboxDb.withDb(coords, async (query) => {
      await query('CREATE TABLE user_data (user_id serial PRIMARY KEY, username text NOT NULL, bio text)');
      return seedFaker(query, {
        user_data: { rows: 3, columns: { username: 'faker.internet.userName', bio: 'faker.lorem.sentence' } },
      });
    });
    assert.equal(seeded.user_data.length, 3);
    assert.ok(seeded.user_data[0].user_id); // RETURNING captured for $SEED refs
    assert.ok(seeded.user_data[1].username);
  } finally {
    await sandboxDb.drop('sbxtestdb');
  }
});

test('the app gets an unprivileged role, never Postgres superuser', async (t) => {
  // A superuser connection is a host compromise by itself: COPY ... FROM
  // PROGRAM runs shell commands as the postgres OS user, pg_read_file reads
  // the host filesystem, and ACLs stop applying so every other database on
  // the instance is readable. Owning one database is all a sandboxed app
  // needs, so that is all it may have.
  const { Client } = require('pg');
  let victim;
  let attacker;
  try {
    victim = await sandboxDb.provision('sbxvictim');
    attacker = await sandboxDb.provision('sbxattack');
  } catch (e) {
    if (e.code === 'SANDBOX_PG_UNREACHABLE') {
      t.skip('no local Postgres (set INTEGRAL_SANDBOX_PG_URL to enable)');
      return;
    }
    throw e;
  }
  const client = new Client({
    host: attacker.host, port: Number(attacker.port), user: attacker.user,
    password: attacker.password, database: attacker.database, connectionTimeoutMillis: 4000,
  });
  await client.connect();
  try {
    const role = (await client.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user'
    )).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolcreatedb, false);
    assert.equal(role.rolcreaterole, false);

    for (const sql of [
      "CREATE TABLE rce(l text); COPY rce FROM PROGRAM 'id'",
      "SELECT pg_read_file('/etc/passwd')",
      "ALTER SYSTEM SET log_statement = 'all'",
    ]) {
      await assert.rejects(() => client.query(sql), /permission denied/i, sql);
    }

    // Its own database is still fully usable — schema setup and seeding run
    // as this role, so anything less would break every server test.
    await client.query('CREATE TABLE ok_here (id serial PRIMARY KEY, v text)');
    await client.query("INSERT INTO ok_here (v) VALUES ('fine')");
    assert.equal((await client.query('SELECT v FROM ok_here')).rows[0].v, 'fine');
  } finally {
    await client.end();
  }

  // Each sandbox is a different tenant's code; a fresh database would leave
  // CONNECT granted to PUBLIC without the explicit revoke in provision().
  const crossTenant = new Client({
    host: victim.host, port: Number(victim.port), user: attacker.user,
    password: attacker.password, database: victim.database, connectionTimeoutMillis: 4000,
  });
  await assert.rejects(() => crossTenant.connect(), /permission denied for database/i);

  await sandboxDb.drop('sbxvictim');
  await sandboxDb.drop('sbxattack');
  // Dropping takes the role with it, or the next boot collides on the name.
  const admin = new Client({ connectionString: sandboxDb.ADMIN_URL, connectionTimeoutMillis: 4000 });
  await admin.connect();
  try {
    const left = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [sandboxDb.roleNameFor('sbxattack')]);
    assert.equal(left.rowCount, 0);
  } finally {
    await admin.end();
  }
});
