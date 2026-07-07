// Sandbox API mocks: hardcoded responses for the network calls an artifact
// makes. The artifact runs with no backend, so the developer supplies
// {method, url, status, body} rules; an injected shim (public/inject/mock.js)
// patches fetch/XHR in the page to answer matching requests.
const fs = require('fs');
const path = require('path');
const { artifactRoot } = require('./artifacts');

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_RULES = 20;
const MAX_BODY = 100 * 1024;

// Returns an error string, or null if valid.
function validateMocks(v) {
  if (!Array.isArray(v)) return 'api_mocks must be an array.';
  if (v.length > MAX_RULES) return `At most ${MAX_RULES} API mocks per test.`;
  for (const m of v) {
    if (!m || typeof m !== 'object') return 'Each mock must be an object.';
    if (!METHODS.includes(String(m.method || 'ANY').toUpperCase())) return `Mock method must be one of ${METHODS.join(', ')}.`;
    if (typeof m.url !== 'string' || !m.url.trim() || m.url.length > 500) return 'Each mock needs a URL (max 500 chars).';
    const status = Number(m.status || 200);
    if (!Number.isInteger(status) || status < 100 || status > 599) return 'Mock status must be an HTTP status code.';
    if (m.body != null && (typeof m.body !== 'string' || m.body.length > MAX_BODY)) {
      return `Mock body must be a string of at most ${Math.round(MAX_BODY / 1024)} KB.`;
    }
  }
  return null;
}

function cleanMocks(v) {
  return v.map((m) => ({
    method: String(m.method || 'ANY').toUpperCase(),
    url: m.url.trim(),
    status: Number(m.status || 200),
    body: m.body || '',
  }));
}

function mocksFor(test) {
  try {
    const v = JSON.parse(test.api_mocks || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

// Injected into <head> so the shim patches fetch/XHR before any artifact
// script runs.
function mockSnippet(test) {
  const mocks = mocksFor(test);
  if (!mocks.length) return '';
  const json = JSON.stringify(mocks).replace(/</g, '\\u003c');
  return `<script>window.__INTEGRAL_MOCKS__=${json}</script><script src="/__integral/mock.js"></script>`;
}

// ---------- detection ----------
// Scan the artifact's HTML/JS for network calls with literal URLs so the
// setup page can suggest what needs mocking. Best-effort, not exhaustive.

const SCAN_EXT = /\.(html?|m?js|[jt]sx|ts)$/i;
const ASSET_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|html?)(\?|$)/i;
const CALL_RE = /(?:\bfetch|\baxios(?:\.(get|post|put|patch|delete))?)\s*\(\s*['"`]([^'"`\s]+)['"`]/g;
const XHR_RE = /\.open\s*\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"`]([^'"`\s]+)['"`]/gi;

function suggestApiCalls(testId) {
  const seen = new Map();
  const add = (method, url) => {
    if (!/^(\/|https?:\/\/)/.test(url)) return;
    if (ASSET_EXT.test(url)) return;
    const key = `${method} ${url}`;
    if (!seen.has(key) && seen.size < MAX_RULES) seen.set(key, { method, url });
  };
  let scanned = 0;
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (scanned >= 200) return;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) { walk(full); continue; }
      if (!SCAN_EXT.test(name) || stat.size > 512 * 1024) continue;
      scanned++;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(CALL_RE)) add((m[1] || 'GET').toUpperCase(), m[2]);
      for (const m of text.matchAll(XHR_RE)) add(m[1].toUpperCase(), m[2]);
    }
  })(artifactRoot(testId));
  return [...seen.values()];
}

module.exports = { validateMocks, cleanMocks, mocksFor, mockSnippet, suggestApiCalls };
