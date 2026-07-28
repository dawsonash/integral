// Repo-backed tests, driven against a local mock of the GitHub API
// (INTEGRAL_GITHUB_API). Covers connection status, creating a test from a
// repo (root and subfolder), re-pulling the latest snapshot, and token
// revocation handling.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const AdmZip = require('adm-zip');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-test-'));

const app = require('../server/app');
const { db, ARTIFACTS_DIR } = require('../server/db');

let server;
let base;
let cookie;
let gh;
let zipVersion = 1;

function repoZip(version) {
  const zip = new AdmZip();
  const p = 'owner-site-abc123/';
  zip.addFile(p + 'index.html', Buffer.from(
    `<!DOCTYPE html><html><head><title>root</title></head><body><img src="/logo.png"><h1>root v${version}</h1><script>fetch('/api/rsvp')</script></body></html>`
  ));
  zip.addFile(p + 'README.md', Buffer.from('# site'));
  // Root-absolute stylesheet: dist/ is this page's site root, so /app.css
  // means dist/app.css — the shape that must survive both hosting paths.
  zip.addFile(p + 'dist/index.html', Buffer.from(
    `<!DOCTYPE html><html><head><link rel="stylesheet" href="/app.css"></head><body><h1>dist v${version}</h1></body></html>`
  ));
  zip.addFile(p + 'dist/app.css', Buffer.from('body{color:blue}'));
  zip.addFile(p + '.github/workflows/ci.yml', Buffer.from('name: ci'));
  // An unbuilt React app alongside the static pages.
  zip.addFile(p + 'package.json', Buffer.from(JSON.stringify({
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
  })));
  zip.addFile(p + 'src/main.jsx', Buffer.from(
    'import React from "react";\nimport { createRoot } from "react-dom/client";\n' +
    'import App from "./App";\nimport "./App.css";\n' +
    'createRoot(document.getElementById("root")).render(<App />);\n'
  ));
  zip.addFile(p + 'src/App.jsx', Buffer.from(
    `export default function App() { return <h1>react v${version}</h1>; }\n`
  ));
  zip.addFile(p + 'src/App.css', Buffer.from('h1{color:red}'));
  return zip.toBuffer();
}

const SITE_PKG = JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } });
// A React SPA with no HTML at all — the wrapper page must be synthesized.
function spaZip() {
  const zip = new AdmZip();
  const p = 'owner-spa-abc123/';
  zip.addFile(p + 'package.json', Buffer.from(SITE_PKG));
  zip.addFile(p + 'src/main.jsx', Buffer.from('export default 1;\n'));
  return zip.toBuffer();
}
// An Ink terminal app (create-ink-app layout): source/cli.tsx entry, TS-style
// ".js" imports of .ts/.tsx files, and Node-only deps (conf) that get browser
// stand-ins.
const TUI_PKG = JSON.stringify({
  type: 'module',
  dependencies: { ink: '^6.8.0', react: '^19.2.7', conf: '^15.1.0' },
});
function tuiZip() {
  const zip = new AdmZip();
  const p = 'owner-tui-abc123/';
  zip.addFile(p + 'package.json', Buffer.from(TUI_PKG));
  zip.addFile(p + 'source/cli.tsx', Buffer.from(
    "import {render} from 'ink';\nimport App from './app.js';\nrender(<App />);\n"
  ));
  zip.addFile(p + 'source/app.tsx', Buffer.from(
    "import {Text} from 'ink';\nimport {store} from './store.js';\n" +
    "export default function App() { return <Text>ready {String(store.get('setupComplete'))}</Text>; }\n"
  ));
  zip.addFile(p + 'source/store.ts', Buffer.from(
    "import Conf from 'conf';\nexport const store = new Conf({projectName: 'tui', defaults: {setupComplete: false}});\n"
  ));
  return zip.toBuffer();
}
// A Node backend whose src/index.js matches the entry path convention but is
// not a browser app.
const SERVER_PKG = JSON.stringify({ dependencies: { express: '^4.18.2' } });
function serverZip() {
  const zip = new AdmZip();
  const p = 'owner-server-abc123/';
  zip.addFile(p + 'package.json', Buffer.from(SERVER_PKG));
  zip.addFile(p + 'src/index.js', Buffer.from("const express = require('express');\n"));
  return zip.toBuffer();
}

async function login(loginName) {
  const res = await fetch(`${base}/auth/dev?login=${loginName}`, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  return res.headers.getSetCookie()[0].split(';')[0];
}

before(async () => {
  gh = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer good-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"message":"Bad credentials"}');
    }
    if (req.url.startsWith('/user/repos')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([
        { full_name: 'owner/site', default_branch: 'main', private: true, pushed_at: '2026-07-01T00:00:00Z' },
      ]));
    }
    if (req.url === '/repos/owner/site') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ full_name: 'owner/site', default_branch: 'main' }));
    }
    if (req.url.startsWith('/repos/owner/site/git/trees/main')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        truncated: false,
        tree: [
          { path: 'index.html', type: 'blob' },
          { path: 'README.md', type: 'blob' },
          { path: 'dist/index.html', type: 'blob' },
          { path: 'dist/app.css', type: 'blob' },
          { path: 'src/main.jsx', type: 'blob' },
          { path: 'src/App.jsx', type: 'blob' },
          { path: '.github/page.html', type: 'blob' },
        ],
      }));
    }
    if (req.url.startsWith('/repos/owner/site/contents/package.json')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw' });
      return res.end(SITE_PKG);
    }
    if (req.url.startsWith('/repos/owner/site/zipball/main')) {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      return res.end(repoZip(zipVersion));
    }
    const other = { spa: [spaZip, SITE_PKG], server: [serverZip, SERVER_PKG], tui: [tuiZip, TUI_PKG] };
    for (const [name, [zipFn, pkg]] of Object.entries(other)) {
      if (req.url.startsWith(`/repos/owner/${name}/git/trees/main`)) {
        const zip = new AdmZip(zipFn());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          truncated: false,
          tree: zip.getEntries().filter((e) => !e.isDirectory).map((e) => ({
            path: e.entryName.split('/').slice(1).join('/'), type: 'blob',
          })),
        }));
      }
      if (req.url.startsWith(`/repos/owner/${name}/contents/package.json`)) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw' });
        return res.end(pkg);
      }
      if (req.url.startsWith(`/repos/owner/${name}/zipball/main`)) {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        return res.end(zipFn());
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => gh.listen(0, resolve));
  process.env.INTEGRAL_GITHUB_API = `http://localhost:${gh.address().port}`;

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  cookie = await login('repodev');
});

after(() => {
  server.close();
  gh.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

function setToken(login, token) {
  db.prepare('UPDATE users SET github_token = ? WHERE login = ?').run(token, login);
}

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function createRepoTest(fields, asCookie) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: asCookie || cookie } });
  return { status: res.status, json: await res.json() };
}

test('repos endpoint reports not connected without a token', async () => {
  const res = await fetch(base + '/api/github/repos', { headers: { Cookie: cookie } });
  const j = await res.json();
  assert.equal(j.connected, false);
  // No GITHUB_CLIENT_ID in the test env, so connecting isn't offered either.
  assert.equal(j.available, false);
});

test('repos endpoint lists repos once connected', async () => {
  setToken('repodev', 'good-token');
  const res = await fetch(base + '/api/github/repos', { headers: { Cookie: cookie } });
  const j = await res.json();
  assert.equal(j.connected, true);
  assert.equal(j.repos.length, 1);
  assert.equal(j.repos[0].full_name, 'owner/site');
  assert.equal(j.repos[0].default_branch, 'main');
});

test('creating a test from a repo pulls the snapshot and records the source', async () => {
  const { status, json: t } = await createRepoTest({ name: '', repo: 'owner/site', branch: 'main', path: '' });
  assert.equal(status, 200);
  assert.equal(t.source_type, 'repo');
  assert.equal(t.name, 'site'); // blank name defaults to the repo name
  assert.equal(t.repo_full_name, 'owner/site');
  assert.equal(t.repo_branch, 'main');
  assert.ok(t.repo_synced_at > 0);
  assert.equal(t.entry_path, 'index.html');
  // Dotfile trees (.github) never become part of the artifact.
  assert.ok(t.html_files.includes('index.html'));
  assert.ok(t.html_files.every((f) => !f.startsWith('.')));
  const html = fs.readFileSync(path.join(ARTIFACTS_DIR, t.id, 'index.html'), 'utf8');
  assert.match(html, /root v1/);
});

test('a repo subfolder becomes the artifact root', async () => {
  const { status, json: t } = await createRepoTest({ name: 'Dist only', repo: 'owner/site', branch: 'main', path: 'dist' });
  assert.equal(status, 200);
  assert.deepEqual(t.html_files, ['index.html']);
  const html = fs.readFileSync(path.join(ARTIFACTS_DIR, t.id, 'index.html'), 'utf8');
  assert.match(html, /dist v1/);
});

test('blank branch falls back to the repo default branch', async () => {
  const { status, json: t } = await createRepoTest({ name: 'Default branch', repo: 'owner/site', branch: '', path: '' });
  assert.equal(status, 200);
  assert.equal(t.repo_synced_at > 0, true);
});

test('pull refreshes the artifact from the latest snapshot', async () => {
  const { json: t } = await createRepoTest({ name: 'Pullable', repo: 'owner/site', branch: 'main', path: '' });
  zipVersion = 2;
  const res = await fetch(base + `/api/tests/${t.id}/pull`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.ok(updated.repo_synced_at >= t.repo_synced_at);
  const html = fs.readFileSync(path.join(ARTIFACTS_DIR, t.id, 'index.html'), 'utf8');
  assert.match(html, /root v2/);
  zipVersion = 1;
});

test('pull on a non-repo test is rejected', async () => {
  const fd = new FormData();
  fd.append('name', 'Pasted');
  fd.append('html', '<!DOCTYPE html><html><body>hi</body></html>');
  const created = await (await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
  const res = await fetch(base + `/api/tests/${created.id}/pull`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'not_repo_test');
});

test('a bad path returns a clear error and no test is created', async () => {
  const { status, json } = await createRepoTest({ name: 'Nope', repo: 'owner/site', branch: 'main', path: 'no-such-dir' });
  assert.equal(status, 400);
  assert.equal(json.error, 'ingest_failed');
  assert.match(json.message, /no-such-dir/);
});

test('creating from a repo without a connection is rejected', async () => {
  const other = await login('unconnected');
  const { status, json } = await createRepoTest({ name: 'X', repo: 'owner/site', branch: 'main', path: '' }, other);
  assert.equal(status, 400);
  assert.equal(json.error, 'github_not_connected');
});

test('tree endpoint lists HTML pages and React entry modules, dot-dirs hidden', async () => {
  const res = await fetch(base + '/api/github/tree?repo=owner/site&ref=main', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.html, ['index.html', 'dist/index.html']);
  // main.jsx is a conventional entry; App.jsx is not.
  assert.deepEqual(j.modules, ['src/main.jsx']);
});

test('preview endpoint hosts a branch snapshot that renders React entries', async () => {
  const post = (entry) => fetch(base + '/api/github/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ repo: 'owner/site', ref: 'main', entry }),
  });
  const j = await (await post('src/main.jsx')).json();
  assert.ok(j.id && j.id.length >= 16);
  // index.html exists at the repo root, so the wrapper takes the next name.
  assert.equal(j.path, 'app.html');
  const page = await (await fetch(base + `/p/${j.id}/${j.path}`)).text();
  assert.match(page, /<div id="root">/);
  assert.match(page, /<script type="module"[^>]* src="\.\/src\/main\.jsx">/);
  // The module itself is served transpiled: JSX compiled away, bare imports
  // pinned to esm.sh via the repo's package.json, CSS import turned into a
  // <link> injection, extensionless relative import resolved.
  const mod = await (await fetch(base + `/p/${j.id}/src/main.jsx`)).text();
  assert.match(mod, /esm\.sh\/react-dom@%5E18\.3\.1\/client/);
  assert.match(mod, /from\s*"\.\/App\.jsx"/);
  assert.match(mod, /rel:"stylesheet"/);
  assert.ok(!mod.includes('<App'), 'JSX must be compiled away');
  const app = await (await fetch(base + `/p/${j.id}/src/App.jsx`)).text();
  assert.match(app, /esm\.sh\/react@%5E18\.3\.1\/jsx-runtime/);
  // An entry in another folder re-roots the snapshot at that folder, exactly
  // like the test it previews — so the page is served from the root, not
  // under dist/.
  const j2 = await (await post('dist/index.html')).json();
  assert.equal(j2.path, 'index.html');
  const dist = await (await fetch(base + `/p/${j2.id}/${j2.path}`)).text();
  assert.match(dist, /dist v1/);
  // The whole point of re-rooting: href="/app.css" is rebased onto the mount
  // and resolves to dist/app.css, so the preview renders styled.
  assert.ok(dist.includes(`href="/p/${j2.id}/app.css"`));
  const css = await fetch(base + `/p/${j2.id}/app.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await css.text(), /color:blue/);
});

test('a React entry module becomes a start page with a synthesized wrapper', async () => {
  const { status, json: t } = await createRepoTest({ name: 'React app', repo: 'owner/site', branch: 'main', entry: 'src/main.jsx' });
  assert.equal(status, 200);
  // The app root (everything above src/) is hosted, and the wrapper dodges
  // the repo's real index.html.
  assert.equal(t.repo_path, '');
  assert.equal(t.entry_path, 'app.html');
  assert.ok(t.html_files.includes('app.html'));
  // Taker mode serves the wrapper with the recorder and the transpiled module.
  const page = await (await fetch(base + `/t/${t.id}/app/app.html`)).text();
  assert.match(page, /__integral\/recorder\.js/);
  const mod = await (await fetch(base + `/t/${t.id}/app/src/main.jsx`)).text();
  assert.match(mod, /esm\.sh\/react@%5E18\.3\.1/);
});

test('root-absolute asset paths in artifact HTML are rebased onto the mount', async () => {
  const { json: t } = await createRepoTest({ name: 'Abs paths', repo: 'owner/site', branch: 'main', entry: 'index.html' });
  const page = await (await fetch(base + `/t/${t.id}/app/index.html`)).text();
  assert.ok(page.includes(`src="/t/${t.id}/app/logo.png"`));
});

test('a Node backend is never offered or mounted as a React entry', async () => {
  // Tree gate: src/index.js matches the path convention, but package.json
  // has no react — no module entries offered.
  const tree = await (await fetch(base + '/api/github/tree?repo=owner/server&ref=main', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(tree.modules, []);
  // Creation gate: forcing the entry can't mount it as a React module — the
  // repo classifies as a server-rendered app instead (fake-backend sandbox),
  // with no wrapper page synthesized.
  const { status, json } = await createRepoTest({ name: 'Backend', repo: 'owner/server', branch: 'main', entry: 'src/index.js' });
  assert.equal(status, 200);
  assert.equal(json.backendConfig.kind, 'server');
  assert.equal(json.backendConfig.framework, 'express');
  assert.equal(json.entry_path, '');
  assert.deepEqual(json.html_files, []);
  // Preview gate: same refusal, with a reason instead of a blank page.
  const prev = await fetch(base + '/api/github/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ repo: 'owner/server', ref: 'main', entry: 'src/index.js' }),
  });
  assert.equal(prev.status, 400);
  assert.equal((await prev.json()).error, 'not_ui_module');
});

test('an HTML-less repo gets exactly one wrapper, with a boot-error reporter', async () => {
  const { status, json: t } = await createRepoTest({ name: 'SPA', repo: 'owner/spa', branch: 'main', entry: 'src/main.jsx' });
  assert.equal(status, 200);
  // Regression: ensureEntry + the picked-entry path used to each write a
  // wrapper (index.html and app.html) — there must be exactly one now.
  assert.equal(t.entry_path, 'index.html');
  assert.deepEqual(t.html_files, ['index.html']);
  const page = await (await fetch(base + `/t/${t.id}/view/index.html`)).text();
  assert.match(page, /__integralBootError/);
});

test('an HTML-less React zip still gets a start page', async () => {
  const zip = new AdmZip();
  zip.addFile('package.json', Buffer.from('{"dependencies":{"react":"^18.3.1"}}'));
  zip.addFile('src/main.jsx', Buffer.from('export default 1;\n'));
  const fd = new FormData();
  fd.append('name', 'React zip');
  fd.append('zip', new Blob([zip.toBuffer()]), 'app.zip');
  const res = await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const t = await res.json();
  assert.equal(t.entry_path, 'index.html');
  const html = fs.readFileSync(path.join(ARTIFACTS_DIR, t.id, 'index.html'), 'utf8');
  assert.match(html, /<script type="module"[^>]* src="\.\/src\/main\.jsx">/);
  // A zip that only *looks* like a browser app (no react dependency) is
  // never given a wrapper page — it classifies as a server-rendered test
  // (fake-backend sandbox) instead of hosting a blank page.
  const zip2 = new AdmZip();
  zip2.addFile('package.json', Buffer.from('{"dependencies":{"express":"^4.18.2"}}'));
  zip2.addFile('src/index.js', Buffer.from('module.exports = 1;\n'));
  const fd2 = new FormData();
  fd2.append('name', 'Server zip');
  fd2.append('zip', new Blob([zip2.toBuffer()]), 'server.zip');
  const res2 = await fetch(base + '/api/tests', { method: 'POST', body: fd2, headers: { Cookie: cookie } });
  assert.equal(res2.status, 200);
  const t2 = await res2.json();
  assert.equal(t2.backendConfig.kind, 'server');
  assert.deepEqual(t2.html_files, []);
  // A zip with neither HTML nor any recognizable app is still refused.
  const zip3 = new AdmZip();
  zip3.addFile('notes.txt', Buffer.from('hello'));
  const fd3 = new FormData();
  fd3.append('name', 'Nothing zip');
  fd3.append('zip', new Blob([zip3.toBuffer()]), 'nothing.zip');
  const res3 = await fetch(base + '/api/tests', { method: 'POST', body: fd3, headers: { Cookie: cookie } });
  assert.equal(res3.status, 400);
  assert.equal((await res3.json()).error, 'no_html');
});

test('boot failures name the cause and give fix steps', async () => {
  const zip = new AdmZip();
  zip.addFile('package.json', Buffer.from(SITE_PKG));
  zip.addFile('src/main.jsx', Buffer.from('import App from "./App";\nexport default 1;\n'));
  zip.addFile('src/Broken.jsx', Buffer.from('export default function B() { return <h1>; }\n'));
  const fd = new FormData();
  fd.append('name', 'Diagnostics');
  fd.append('zip', new Blob([zip.toBuffer()]), 'diag.zip');
  const res = await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const t = await res.json();
  // The wrapper's last-resort onerror routes through the fallback that
  // explains where to look; the specific reporter is still defined.
  const page = await (await fetch(base + `/t/${t.id}/app/index.html`)).text();
  assert.match(page, /__integralBootFallback\('\.\/src\/main\.jsx'\)/);
  assert.match(page, /__integralBootError/);
  // An import of a file that doesn't exist is diagnosed at transpile time:
  // the statement is replaced with a reporter naming importer and specifier.
  const mod = await (await fetch(base + `/t/${t.id}/app/src/main.jsx`)).text();
  assert.match(mod, /Cannot find \\"\.\/App\\" imported by src\/main\.jsx/);
  assert.match(mod, /How to fix/);
  assert.ok(!/from\s*"\.\/App"/.test(mod), 'broken import statement must be replaced');
  // A file esbuild can't compile is served as a diagnosis (file:line and
  // fix steps), not as raw JSX the browser would reject without detail.
  const broken = await (await fetch(base + `/t/${t.id}/app/src/Broken.jsx`)).text();
  assert.match(broken, /src\/Broken\.jsx:\d+:\d+/);
  assert.match(broken, /How to fix/);
  assert.ok(!broken.includes('<h1>'), 'raw JSX must not be served');
  // Requesting a JS-family path that doesn't exist yields a reporting
  // module (200), not a bare 404 the module loader swallows silently.
  const missing = await fetch(base + `/t/${t.id}/app/src/Nope.jsx`);
  assert.equal(missing.status, 200);
  const body = await missing.text();
  assert.match(body, /\.\/src\/Nope\.jsx doesn't exist/);
  assert.match(body, /How to fix/);
  // Non-module paths still 404 normally.
  assert.equal((await fetch(base + `/t/${t.id}/app/src/Nope.css`)).status, 404);
});

test('a navigation out of the hosted slice explains itself instead of "Not found"', async () => {
  const { json: t } = await createRepoTest({ name: 'Dead end', repo: 'owner/site', branch: 'main', entry: 'index.html' });
  // A link to a route the app serves from code the artifact never contained.
  const res = await fetch(base + `/t/${t.id}/app/auth/github`);
  assert.equal(res.status, 404, 'still a 404 on the wire');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const page = await res.text();
  assert.match(page, /isn't part of the test/);
  assert.match(page, /auth\/github/);
  assert.match(page, /history\.back\(\)/);
  // Carries the mode's injection, so the session keeps recording on the dead
  // end and the walk back shows up in the replay.
  assert.match(page, /__integral\/recorder\.js/);
  // Assets are not navigations: a missing image stays the bare 404, never the
  // explainer page — an <img> or <link> must not resolve to a document.
  const asset = await fetch(base + `/t/${t.id}/app/logo.png`);
  assert.equal(asset.status, 404);
  assert.equal(await asset.text(), 'Not found');
});

test('picking an entry file hosts its folder and starts on that page', async () => {
  const { status, json: t } = await createRepoTest({ name: 'Picked entry', repo: 'owner/site', branch: 'main', entry: 'dist/index.html' });
  assert.equal(status, 200);
  assert.equal(t.repo_path, 'dist');
  assert.equal(t.entry_path, 'index.html');
  assert.deepEqual(t.html_files, ['index.html']);
});

test('api mocks round-trip through PATCH and reject invalid rules', async () => {
  const { json: t } = await createRepoTest({ name: 'Mocked', repo: 'owner/site', branch: 'main', entry: 'index.html' });
  const mocks = [{ method: 'GET', url: '/api/events', status: 200, body: '{"events":[]}' }];
  const ok = await api('PATCH', `/api/tests/${t.id}`, { api_mocks: mocks });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.apiMocks, mocks);
  const bad = await api('PATCH', `/api/tests/${t.id}`, { api_mocks: [{ method: 'GET', url: '/x', status: 9999 }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_api_mocks');
});

test('mock shim is injected into artifact <head> before page scripts', async () => {
  const { json: t } = await createRepoTest({ name: 'Shimmed', repo: 'owner/site', branch: 'main', entry: 'index.html' });
  await api('PATCH', `/api/tests/${t.id}`, {
    api_mocks: [{ method: 'ANY', url: '/api/rsvp*', status: 201, body: '{"ok":true}' }],
  });
  const page = await (await fetch(base + `/t/${t.id}/preview/index.html`)).text();
  assert.ok(page.includes('window.__INTEGRAL_MOCKS__='));
  assert.ok(page.includes('/__integral/mock.js'));
  assert.ok(page.indexOf('__INTEGRAL_MOCKS__') < page.indexOf('</head>'), 'shim must load in <head>');
  // No mocks configured → no shim.
  const { json: bare } = await createRepoTest({ name: 'Bare', repo: 'owner/site', branch: 'main', entry: 'index.html' });
  const barePage = await (await fetch(base + `/t/${bare.id}/preview/index.html`)).text();
  assert.ok(!barePage.includes('__INTEGRAL_MOCKS__'));
});

test('api suggestions surface fetch/axios/XHR calls found in the artifact', async () => {
  const fd = new FormData();
  fd.append('name', 'Sniffed');
  fd.append('html', `<!DOCTYPE html><html><body><script>
    fetch('/api/events');
    axios.post('/api/rsvp', data);
    var x = new XMLHttpRequest(); x.open('GET', '/api/user/me');
    fetch('/assets/logo.png');
  </script></body></html>`);
  const t = await (await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
  const { json } = await api('GET', `/api/tests/${t.id}/api-suggestions`);
  const urls = json.calls.map((c) => `${c.method} ${c.url}`);
  assert.ok(urls.includes('GET /api/events'));
  assert.ok(urls.includes('POST /api/rsvp'));
  assert.ok(urls.includes('GET /api/user/me'));
  assert.ok(!urls.some((u) => u.includes('logo.png')), 'asset URLs are not API calls');
});

test('an Ink TUI repo offers source/cli.tsx and mounts a terminal wrapper', async () => {
  // Tree gate: cli.tsx under source/ is a conventional entry, and the ink
  // dependency passes the UI-framework check; app.tsx is a component, not
  // an entry.
  const tree = await (await fetch(base + '/api/github/tree?repo=owner/tui&ref=main', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(tree.modules, ['source/cli.tsx']);

  const { status, json: t } = await createRepoTest({ name: 'TUI', repo: 'owner/tui', branch: 'main', entry: 'source/cli.tsx' });
  assert.equal(status, 200);
  // The app root is everything above source/, so package.json rides along.
  assert.equal(t.repo_path, '');
  assert.equal(t.entry_path, 'index.html');
  // The wrapper hosts a browser terminal (not a DOM mount) and boots the
  // entry module against the tty bridge.
  const page = await (await fetch(base + `/t/${t.id}/view/index.html`)).text();
  assert.match(page, /@xterm\/xterm/);
  assert.match(page, /__integralTty/);
  assert.ok(page.includes('"./source/cli.tsx"'));
  assert.match(page, /__integralBootError/);

  // The entry is served transpiled: bare "ink" lands on the stand-in that
  // routes render() to the page terminal, and the TS-style "./app.js"
  // import resolves to the real app.tsx.
  const mod = await (await fetch(base + `/t/${t.id}/app/source/cli.tsx`)).text();
  assert.match(mod, /from\s*"\.\.\/__integral\/ink\.js"/);
  assert.match(mod, /from\s*"\.\/app\.tsx"/);
  const appMod = await (await fetch(base + `/t/${t.id}/app/source/app.tsx`)).text();
  assert.match(appMod, /from\s*"\.\/store\.ts"/);
  assert.ok(!appMod.includes('<Text'), 'JSX must be compiled away');
  // conf (filesystem config) gets the localStorage-backed stand-in.
  const storeMod = await (await fetch(base + `/t/${t.id}/app/source/store.ts`)).text();
  assert.match(storeMod, /from\s*"\.\.\/__integral\/conf\.js"/);
  const conf = await (await fetch(base + `/t/${t.id}/app/__integral/conf.js`)).text();
  assert.match(conf, /localStorage/);
  // The ink stand-in pins the repo's declared ink version, with react pinned
  // via ?deps — the same URL ink companion packages get, so the whole app
  // shares one ink instance (esm.sh forks a build variant per deps pin).
  const ink = await (await fetch(base + `/t/${t.id}/app/__integral/ink.js`)).text();
  assert.match(ink, /esm\.sh\/ink@%5E6\.8\.0\?deps=react@%5E19\.2\.7/);
  assert.match(ink, /__integralTty/);
});

test('a revoked token flips the picker back to disconnected and is dropped', async () => {
  const revoked = await login('revoked');
  setToken('revoked', 'revoked-token');
  const res = await fetch(base + '/api/github/repos', { headers: { Cookie: revoked } });
  const j = await res.json();
  assert.equal(j.connected, false);
  assert.equal(db.prepare("SELECT github_token FROM users WHERE login = 'revoked'").get().github_token, null);
});
