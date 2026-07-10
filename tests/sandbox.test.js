// Fake-backend sandbox (docs/fake-backend-spec.md): classification, config
// validation, seed/stub/proxy helpers, and a real boot of the server-app
// fixture behind the same-origin proxy. Postgres provisioning has its own
// test that skips when no local Postgres is reachable.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-sbx-test-'));
process.env.INTEGRAL_MIN_DURATION_MS = '400';

const app = require('../server/app');
const { classify, validateBackendConfig } = require('../server/lib/sandbox/classify');
const { globToRe } = require('../server/lib/sandbox/stubs');
const { seedValue, resolveSeedTokens } = require('../server/lib/sandbox/seed');
const { rewriteLocation, mergeCookies } = require('../server/lib/sandbox/proxy');
const registry = require('../server/lib/sandbox/registry');
const sandboxDb = require('../server/lib/sandbox/db');

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
