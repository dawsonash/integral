// The origin split reads INTEGRAL_RUN_HOST when the app module loads, so these
// tests live in their own file (node:test runs each file in a fresh process)
// rather than in api.test.js, where the env var would break the /t/ tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-test-'));
process.env.INTEGRAL_RUN_HOST = 'run.test';

const app = require('../server/app');

let server;
let port;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(() => {
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

// fetch silently drops the forbidden Host header, so drive node:http directly.
function get(p, host) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port, path: p, headers: host ? { Host: host } : {} }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('run host never serves the landing page', async () => {
  const res = await get('/', 'run.test');
  assert.equal(res.status, 404);
});

test('dashboard host still serves the landing page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  // Structural marker, not headline copy — see the note in api.test.js.
  assert.match(res.body, /class="lnav"/);
});

// The privacy page is served on the run host and its footer links /contact, so
// the contact page has to be on the run surface or that link 404s for testers.
test('run host serves the contact page', async () => {
  const res = await get('/contact', 'run.test');
  assert.equal(res.status, 200);
});

// The address is assembled by JavaScript specifically so it never appears in the
// served HTML. If someone inlines it as plain text later, this catches it.
test('contact page never ships a literal email address', async () => {
  const res = await get('/contact', 'run.test');
  assert.doesNotMatch(res.body, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
});
