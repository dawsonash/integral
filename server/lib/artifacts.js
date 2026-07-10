const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { ARTIFACTS_DIR } = require('../db');
const { transpile, canTranspile, readDeps, esmShUrl } = require('./transpile');

function artifactRoot(testId) {
  return path.join(ARTIFACTS_DIR, testId);
}

// Reject absolute paths and traversal; normalize to forward slashes.
function safeRelPath(rel) {
  const norm = path.posix.normalize(String(rel).replace(/\\/g, '/'));
  if (norm.startsWith('/') || norm.startsWith('..') || norm.includes('../')) return null;
  return norm;
}

// Per-plan artifact size cap, checked against *uncompressed* size before
// anything is written (a tiny zip can inflate to gigabytes).
function checkSize(bytes, maxBytes) {
  if (maxBytes && bytes > maxBytes) {
    const err = new Error('artifact too large');
    err.code = 'ARTIFACT_TOO_LARGE';
    throw err;
  }
}

function ingestHtml(testId, html, maxBytes) {
  checkSize(Buffer.byteLength(html), maxBytes);
  const root = artifactRoot(testId);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), html);
}

function ingestZip(testId, zipBuffer, maxBytes) {
  const zip = new AdmZip(zipBuffer);
  checkSize(zip.getEntries().reduce((n, e) => n + (e.header.size || 0), 0), maxBytes);
  const root = artifactRoot(testId);
  fs.mkdirSync(root, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    if (base.startsWith('.') || entry.entryName.includes('__MACOSX')) continue;
    const rel = safeRelPath(entry.entryName);
    if (!rel) continue;
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
  stripCommonPrefix(root);
}

function ingestFiles(testId, files, relPaths, maxBytes) {
  checkSize(files.reduce((n, f) => n + f.buffer.length, 0), maxBytes);
  const root = artifactRoot(testId);
  fs.mkdirSync(root, { recursive: true });
  files.forEach((file, i) => {
    const rel = safeRelPath(relPaths[i] || file.originalname);
    if (!rel) return;
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.buffer);
  });
  stripCommonPrefix(root);
}

// If everything landed inside a single top-level folder (typical of zipped
// folders), hoist its contents to the root so entry paths stay short.
function stripCommonPrefix(root) {
  const entries = fs.readdirSync(root);
  if (entries.length !== 1) return;
  const only = path.join(root, entries[0]);
  if (!fs.statSync(only).isDirectory()) return;
  for (const child of fs.readdirSync(only)) {
    fs.renameSync(path.join(only, child), path.join(root, child));
  }
  fs.rmdirSync(only);
}

function listHtmlFiles(testId) {
  const root = artifactRoot(testId);
  const out = [];
  (function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else if (/\.html?$/i.test(name)) out.push(rel);
    }
  })(root, '');
  out.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  return out;
}

function defaultEntry(testId) {
  const htmls = listHtmlFiles(testId);
  return htmls.includes('index.html') ? 'index.html' : htmls[0] || null;
}

// ---------- React/module entry points ----------
// An unbuilt React project has no HTML page to start on (or a Vite host page
// that references JSX). Conventional entry modules — src/main.jsx and
// friends — are accepted as start pages: a small HTML wrapper is synthesized
// that mounts them, and serve-time transpilation makes the modules loadable.
// Ink (terminal React) apps follow the same shape with source/cli.tsx; their
// wrapper hosts a browser terminal instead of a DOM mount point.

// main/index/cli with a JSX flavor anywhere, or any JS flavor when under
// src/ or source/ (create-ink-app scaffolds source/cli.tsx).
const MODULE_ENTRY_RE = /(?:^|\/)(?:main|index|cli)\.[jt]sx$|(?:^|\/)(?:src|source)\/(?:main|index|cli)\.[jt]sx?$/i;

function isModuleEntry(p) {
  return /\.(?:[jt]sx?|mjs)$/i.test(p) && !/\.html?$/i.test(p);
}

// The folder to host alongside a module entry: everything above src/ (or
// source/, so package.json and public assets ride along), or the module's
// own folder.
function appRootFor(entryPath) {
  const prefixed = '/' + entryPath;
  const m = prefixed.match(/\/(?:src|source)\//);
  if (m) return prefixed.slice(1, m.index);
  const dir = path.posix.dirname(entryPath);
  return dir === '.' ? '' : dir;
}

// Path shape alone is not proof of a browser app — a Node server's
// src/index.js matches the same convention. Only mount a module when its app
// root actually depends on a UI framework; a JSX extension is accepted as
// the signal when there's no manifest to consult at all.
function uiModuleOk(rootDir, moduleRel) {
  if (!fs.existsSync(path.join(rootDir, 'package.json'))) return /\.[jt]sx$/i.test(moduleRel);
  const deps = readDeps(rootDir);
  return !!(deps.react || deps.preact || deps.ink);
}

// A module that fails to boot would otherwise leave a silently blank page —
// the worst possible feedback. The wrapper reports load/runtime errors in an
// overlay so the developer sees *why* (bad import, missing dep, non-browser
// code) right in the preview. The first report wins: server-diagnosed causes
// (missing file, syntax error — see diagnosticModule) arrive before the
// loader's vague "Failed to load" event and must not be overwritten by it.
// __integralBootFallback is that last-resort message, fired by the wrapper's
// script onerror, which by spec carries no reason at all — so it explains
// where the reason can be found instead.
const BOOT_ERROR_SCRIPT =
  '<script>\n' +
  'window.__integralBootError = function (msg) {\n' +
  "  if (document.getElementById('integral-boot-error')) return;\n" +
  "  var d = document.createElement('pre'); d.id = 'integral-boot-error';\n" +
  "  d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;margin:0;background:#fff3f3;color:#8a1f1f;border:1px solid #e0b4b4;border-radius:8px;padding:12px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:2147483647';\n" +
  "  d.textContent = 'This app failed to start:\\n' + msg;\n" +
  '  document.body.appendChild(d);\n' +
  '};\n' +
  'window.__integralBootFallback = function (rel) {\n' +
  "  __integralBootError('Failed to load ' + rel + ' or one of its imports.\\n\\n" +
  'How to fix:\\n' +
  '1. Open the browser devtools and reload — the Console and Network tabs name the file or package that failed.\\n' +
  "2. npm packages load from esm.sh: make sure every package you import is listed in package.json, and that your network allows esm.sh.');\n" +
  '};\n' +
  "addEventListener('error', function (e) { __integralBootError(e.message || (e.error && e.error.message) || 'Script error'); });\n" +
  "addEventListener('unhandledrejection', function (e) { __integralBootError((e.reason && (e.reason.message || e.reason)) || 'Unhandled rejection'); });\n" +
  '</script>';

// Serve-time failures the server can name precisely (missing file, syntax
// error) are delivered as a tiny module in place of the broken one: it
// reports the cause and fix steps to the overlay, then throws so the app
// never half-starts. A bare 404 or raw un-compilable source would reach the
// developer only as the loader's detail-free "Failed to load" event.
function diagnosticModule(message) {
  return (
    `var m = ${JSON.stringify(message)};\n` +
    'console.error(m);\n' +
    'if (typeof window !== "undefined" && window.__integralBootError) window.__integralBootError(m);\n' +
    "throw new Error(m.split('\\n')[0]);\n"
  );
}

function missingFileMessage(rel) {
  return (
    `./${rel} doesn't exist in this test's files.\n\n` +
    'How to fix:\n' +
    `1. Find what references "./${rel}" — the path must match a file exactly (case-sensitive).\n` +
    '2. If the file exists in your project, commit and push it to the selected branch, or re-upload it.\n' +
    '3. Reload this preview.'
  );
}

const SYNTAX_FIX_STEPS =
  '\n\nHow to fix: correct the error above, push the fix to the selected branch (or re-upload the file), then reload this preview.';

// ---------- terminal (Ink) entry points ----------
// An Ink entry renders ANSI to stdout, not DOM — so its wrapper hosts an
// xterm.js terminal and exposes stdout/stdin facades bridged to it on
// window.__integralTty. The artifact also gets browser stand-in modules
// under __integral/ (the transpiler rewrites bare imports onto them):
//   - ink: re-exports the real esm.sh build but render() defaults its
//     stdio to the page terminal (a Node process has none here)
//   - conf: same surface, localStorage-backed, so config persists across
//     preview reloads without a filesystem
const XTERM = 'https://esm.sh/@xterm/xterm@5.5.0';
const XTERM_FIT = 'https://esm.sh/@xterm/addon-fit@0.10.0';

function tuiWrapperHtml(title, moduleRel) {
  return (
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${title}</title>\n` +
    `<link rel="stylesheet" href="${XTERM}/css/xterm.css">\n` +
    '<style>html,body{height:100%;margin:0;background:#16161e}' +
    '#terminal{height:100%;box-sizing:border-box;padding:10px}</style>\n' +
    '</head>\n<body>\n<div id="terminal"></div>\n' +
    BOOT_ERROR_SCRIPT + '\n' +
    '<script type="module">\n' +
    `import { Terminal } from "${XTERM}";\n` +
    `import { FitAddon } from "${XTERM_FIT}";\n` +
    'const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 14,\n' +
    '  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",\n' +
    '  theme: { background: "#16161e" } });\n' +
    'const fit = new FitAddon();\n' +
    'term.loadAddon(fit);\n' +
    'term.open(document.getElementById("terminal"));\n' +
    'fit.fit();\n' +
    'addEventListener("resize", () => fit.fit());\n' +
    '// Minimal Node-stream facades: just the surface Ink touches.\n' +
    'function emitter(obj) {\n' +
    '  const m = new Map();\n' +
    '  const list = (ev) => m.get(ev) || m.set(ev, []).get(ev);\n' +
    '  obj.on = obj.addListener = (ev, fn) => (list(ev).push(fn), obj);\n' +
    '  obj.once = (ev, fn) => obj.on(ev, function g(...a) { obj.off(ev, g); fn(...a); });\n' +
    '  obj.off = obj.removeListener = (ev, fn) => (m.set(ev, list(ev).filter((f) => f !== fn)), obj);\n' +
    '  obj.removeAllListeners = (ev) => (ev ? m.delete(ev) : m.clear(), obj);\n' +
    '  obj.listenerCount = (ev) => list(ev).length;\n' +
    '  obj.emit = (ev, ...a) => list(ev).slice().forEach((f) => f(...a));\n' +
    '  return obj;\n' +
    '}\n' +
    'const stdout = emitter({\n' +
    '  isTTY: true,\n' +
    '  get columns() { return term.cols; },\n' +
    '  get rows() { return term.rows; },\n' +
    '  write(chunk) { term.write(typeof chunk === "string" ? chunk : new Uint8Array(chunk)); return true; },\n' +
    '});\n' +
    '// Ink reads input with the pull model: a "readable" event, then read()\n' +
    '// until null. Keystrokes from xterm queue here until Ink drains them.\n' +
    'const inputQueue = [];\n' +
    'const stdin = emitter({\n' +
    '  isTTY: true,\n' +
    '  setRawMode() { return stdin; }, setEncoding() { return stdin; },\n' +
    '  resume() { return stdin; }, pause() { return stdin; },\n' +
    '  ref() { return stdin; }, unref() { return stdin; },\n' +
    '  read() { return inputQueue.length ? inputQueue.shift() : null; },\n' +
    '  unpipe() { return stdin; },\n' +
    '});\n' +
    'term.onResize(() => stdout.emit("resize"));\n' +
    'term.onData((d) => { inputQueue.push(d); stdin.emit("readable"); stdin.emit("data", d); });\n' +
    'window.__integralTty = { stdout, stdin, stderr: stdout };\n' +
    `import(${JSON.stringify('./' + moduleRel)}).then(() => term.focus(),\n` +
    '  (e) => __integralBootError((e && (e.stack || e.message)) || String(e)));\n' +
    '</script>\n</body>\n</html>\n'
  );
}

function inkStandIn(deps) {
  // Must be the exact URL the transpiler gives ink's companion packages via
  // ?deps, or the app splits into two ink instances.
  const url = esmShUrl('ink', deps);
  return (
    '// Integral stand-in for "ink": the real esm.sh build, with render()\n' +
    '// defaulting its stdio to the wrapper page\'s terminal bridge.\n' +
    `import * as Ink from "${url}";\n` +
    `export * from "${url}";\n` +
    'export function render(tree, options) {\n' +
    '  const tty = window.__integralTty || {};\n' +
    '  const opts = options && typeof options.write === "function" ? { stdout: options } : options || {};\n' +
    '  return Ink.render(tree, { stdout: tty.stdout, stdin: tty.stdin, stderr: tty.stderr,\n' +
    '    patchConsole: false, exitOnCtrlC: false, ...opts });\n' +
    '}\n'
  );
}

const CONF_STAND_IN =
  '// Integral stand-in for "conf": same surface, localStorage-backed, so a\n' +
  '// hosted TUI persists its config without a filesystem.\n' +
  'const parts = (k) => String(k).split(".");\n' +
  'export default class Conf {\n' +
  '  constructor(options = {}) {\n' +
  '    this._defaults = options.defaults || {};\n' +
  '    this._name = options.projectName || options.configName || "app";\n' +
  '    this._key = "__integral-conf:" + this._name;\n' +
  '    this.path = "/" + this._name + "/config.json";\n' +
  '    if (localStorage.getItem(this._key) == null) this.store = this._defaults;\n' +
  '  }\n' +
  '  get store() {\n' +
  '    try { return { ...this._defaults, ...JSON.parse(localStorage.getItem(this._key) || "{}") }; }\n' +
  '    catch { return { ...this._defaults }; }\n' +
  '  }\n' +
  '  set store(v) { localStorage.setItem(this._key, JSON.stringify(v || {})); }\n' +
  '  get(key, fallback) {\n' +
  '    let v = this.store;\n' +
  '    for (const p of parts(key)) { if (v == null) return fallback; v = v[p]; }\n' +
  '    return v === undefined ? fallback : v;\n' +
  '  }\n' +
  '  set(key, value) {\n' +
  '    const s = this.store;\n' +
  '    if (typeof key === "object") { Object.assign(s, key); this.store = s; return; }\n' +
  '    const ps = parts(key);\n' +
  '    let o = s;\n' +
  '    for (const p of ps.slice(0, -1)) { if (typeof o[p] !== "object" || o[p] === null) o[p] = {}; o = o[p]; }\n' +
  '    o[ps[ps.length - 1]] = value;\n' +
  '    this.store = s;\n' +
  '  }\n' +
  '  has(key) { return this.get(key) !== undefined; }\n' +
  '  delete(key) {\n' +
  '    const s = this.store;\n' +
  '    const ps = parts(key);\n' +
  '    let o = s;\n' +
  '    for (const p of ps.slice(0, -1)) { if (o == null) return; o = o[p]; }\n' +
  '    if (o) delete o[ps[ps.length - 1]];\n' +
  '    this.store = s;\n' +
  '  }\n' +
  '  clear() { this.store = { ...this._defaults }; }\n' +
  '  get size() { return Object.keys(this.store).length; }\n' +
  '  onDidChange() { return () => {}; }\n' +
  '  onDidAnyChange() { return () => {}; }\n' +
  '  *[Symbol.iterator]() { yield* Object.entries(this.store); }\n' +
  '}\n';

const EXECA_STAND_IN =
  '// Integral stand-in for "execa": a browser has no shell, so every command\n' +
  '// fails the way a missing binary would (ENOENT). Apps that handle a failed\n' +
  '// spawn — prereq checks, version probes — degrade honestly instead of the\n' +
  '// whole boot dying on execa\'s Node-only dependency graph.\n' +
  'function notFound(cmd) {\n' +
  '  const err = new Error("spawn " + cmd + " ENOENT (shell commands are unavailable in this hosted preview)");\n' +
  '  Object.assign(err, { code: "ENOENT", errno: -2, failed: true, exitCode: undefined,\n' +
  '    command: String(cmd), stdout: "", stderr: "", isCanceled: false, killed: false });\n' +
  '  return err;\n' +
  '}\n' +
  'function run(cmd, args, options) {\n' +
  '  if (options === undefined && args && !Array.isArray(args)) options = args;\n' +
  '  const err = notFound(cmd);\n' +
  '  const p = options && options.reject === false ? Promise.resolve(err) : Promise.reject(err);\n' +
  '  p.kill = () => {}; p.pid = undefined; p.stdout = null; p.stderr = null; p.stdin = null;\n' +
  '  return p;\n' +
  '}\n' +
  'export const execa = run;\n' +
  'export const execaCommand = run;\n' +
  'export const execaNode = run;\n' +
  'export const $ = (strings, ...values) => run(Array.isArray(strings) ? String.raw(strings, ...values) : strings);\n' +
  'export function execaSync(cmd) { throw notFound(cmd); }\n' +
  'export const execaCommandSync = execaSync;\n';

// Stand-in modules live in __integral/ next to the app root's package.json;
// the transpiler rewrites matching bare imports onto them (see rewriteSpec).
function writeStandIns(dir, deps) {
  const idir = path.join(dir, '__integral');
  fs.mkdirSync(idir, { recursive: true });
  fs.writeFileSync(path.join(idir, 'ink.js'), inkStandIn(deps));
  if (deps.conf) fs.writeFileSync(path.join(idir, 'conf.js'), CONF_STAND_IN);
  if (deps.execa) fs.writeFileSync(path.join(idir, 'execa.js'), EXECA_STAND_IN);
}

// Synthesize the HTML host page for a module entry, next to the app root.
// Never overwrites a real page — picks the first free conventional name.
// An app root that depends on ink gets the terminal wrapper (+ stand-ins);
// everything else gets the DOM mount wrapper.
function writeEntryWrapper(dir, moduleRel) {
  let name = ['index.html', 'app.html', 'start.html'].find((n) => !fs.existsSync(path.join(dir, n)));
  if (!name) name = 'integral-entry.html';
  const title = moduleRel.split('/').pop().replace(/\.[^.]+$/, '');
  fs.mkdirSync(dir, { recursive: true });
  const deps = readDeps(dir);
  let html;
  if (deps.ink) {
    writeStandIns(dir, deps);
    html = tuiWrapperHtml(title, moduleRel);
  } else {
    html =
      '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      `<title>${title}</title>\n</head>\n<body>\n` +
      '<div id="root"></div>\n<div id="app"></div>\n' +
      BOOT_ERROR_SCRIPT + '\n' +
      `<script type="module" onerror="__integralBootFallback('./${moduleRel}')" src="./${moduleRel}"></script>\n` +
      '</body>\n</html>\n';
  }
  fs.writeFileSync(path.join(dir, name), html);
  return name;
}

// Artifact has no HTML at all (React-only zip/folder/repo): find the most
// conventional entry module and give it a wrapper. Returns the new entry's
// path, or null when there's nothing to mount.
function ensureEntry(testId) {
  const existing = defaultEntry(testId);
  if (existing) return existing;
  const root = artifactRoot(testId);
  const candidates = [];
  (function walk(dir, prefix) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else if (MODULE_ENTRY_RE.test(rel)) candidates.push(rel);
    }
  })(root, '');
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const entry of candidates) {
    const appRoot = appRootFor(entry);
    const moduleRel = appRoot ? entry.slice(appRoot.length + 1) : entry;
    if (!uiModuleOk(path.join(root, appRoot), moduleRel)) continue;
    const name = writeEntryWrapper(path.join(root, appRoot), moduleRel);
    return appRoot ? `${appRoot}/${name}` : name;
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.mts': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

// Mutate an HTML screen for same-origin hosting. `injectScript` (a <script>
// tag string) goes before </body> so every screen carries it; `headScript`
// goes at the top of <head> — for shims that must run before any artifact
// script (e.g. the API-mock fetch/XHR patch). `mountPrefix` is the URL path
// the artifact root is mounted at (e.g. "/t/<id>/app/"); root-absolute
// references are rebased onto it. Shared by the static-file path below and
// the sandbox reverse proxy (lib/sandbox/proxy.js), so proxied apps get the
// exact same instrumentation as extracted artifacts.
function injectIntoHtml(html, { mountPrefix, headScript, injectScript } = {}) {
  if (mountPrefix) {
    // src="/logo.png" means the artifact's root, not the server's —
    // rebase (protocol-relative "//…" stays untouched).
    html = html.replace(/(\s(?:src|href|action)=["'])\/(?!\/)/gi, '$1' + mountPrefix);
  }
  if (headScript) {
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + headScript);
    else html = headScript + html;
  }
  if (injectScript) {
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, injectScript + '</body>');
    else html += injectScript;
  }
  return html;
}

// Serve an artifact file; HTML pages go through injectIntoHtml, and
// JS-family files are transpiled for native module loading.
function serveArtifactFile(res, testId, relPath, injectScript, headScript, mountPrefix) {
  const rel = safeRelPath(relPath || 'index.html');
  if (!rel) return res.status(400).send('Bad path');
  let full = path.join(artifactRoot(testId), rel === '.' ? 'index.html' : rel);
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    full = path.join(full, 'index.html');
  }
  const ext = path.extname(full).toLowerCase();
  if (!fs.existsSync(full)) {
    // A missing JS-family file is almost always a broken module reference; a
    // 404 would surface as a detail-free load failure, so name it instead.
    if (canTranspile(ext)) {
      res.setHeader('Content-Type', MIME[ext]);
      return res.send(diagnosticModule(missingFileMessage(rel)));
    }
    return res.status(404).send('Not found');
  }
  const mime = MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  if (ext === '.html' || ext === '.htm') {
    const html = fs.readFileSync(full, 'utf8');
    return res.send(injectIntoHtml(html, { mountPrefix, headScript, injectScript }));
  }
  if (canTranspile(ext)) {
    const source = fs.readFileSync(full, 'utf8');
    const { code, error } = transpile(source, { rootDir: artifactRoot(testId), relPath: rel, mountPrefix });
    if (error) return res.send(diagnosticModule(error + SYNTAX_FIX_STEPS));
    return res.send(code != null ? code : source);
  }
  res.send(fs.readFileSync(full));
}

module.exports = {
  artifactRoot,
  ingestHtml,
  ingestZip,
  ingestFiles,
  listHtmlFiles,
  defaultEntry,
  ensureEntry,
  isModuleEntry,
  appRootFor,
  uiModuleOk,
  writeEntryWrapper,
  MODULE_ENTRY_RE,
  injectIntoHtml,
  serveArtifactFile,
  BOOT_ERROR_SCRIPT,
};
