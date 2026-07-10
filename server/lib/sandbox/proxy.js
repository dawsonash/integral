// Same-origin reverse proxy (spec §6): everything downstream of the iframe —
// recorder, success chain, heatmap, replay — is reused unchanged because the
// proxied app is served under /t/:id/app/* exactly like an extracted
// artifact, recorder tag injected into every HTML response.
const { Readable } = require('stream');
const { injectIntoHtml } = require('../artifacts');

// Hop-by-hop and proxy-managed headers, never forwarded either direction.
// accept-encoding is forced to identity so HTML can be mutated in place.
const DROP_REQ = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
  'host', 'content-length', 'accept-encoding',
]);
const DROP_RES = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer',
  // recomputed after mutation / left to Express
  'content-length', 'content-encoding',
  // the frame must load and inline injection must run (spec §6.4)
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  // forwarded separately via getSetCookie
  'set-cookie',
]);

// The injected fake-user session must win over whatever anonymous session
// cookie the app already handed this browser, or gated pages regress to
// logged-out after the first response.
function mergeCookies(browserCookieHeader, authCookies) {
  const jar = new Map();
  for (const part of String(browserCookieHeader || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const c of authCookies || []) {
    const eq = c.indexOf('=');
    if (eq > 0) jar.set(c.slice(0, eq).trim(), c.slice(eq + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Redirects and absolute URLs come back rooted at the upstream origin; they
// must stay under the mount so navigation remains same-origin (spec §6.5).
function rewriteLocation(loc, upstreamOrigin, mountPrefix) {
  let l = String(loc);
  if (l.startsWith(upstreamOrigin)) l = l.slice(upstreamOrigin.length) || '/';
  if (l.startsWith('/') && !l.startsWith('//')) return mountPrefix.replace(/\/$/, '') + l;
  return l;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Friendly upstream-down page (mirrors the boot-error overlay UX in
// artifacts.js): what failed, plus the sandbox log tail so the developer
// sees *why* right in the preview.
function sandboxErrorPage(err, logs) {
  const tail = (err?.sandboxLogs || logs || []).slice(-40);
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>App failed to start</title></head>' +
    '<body style="margin:0;font:14px/1.5 system-ui,sans-serif;background:#fff">' +
    '<div style="margin:12px;background:#fff3f3;color:#8a1f1f;border:1px solid #e0b4b4;border-radius:8px;padding:16px">' +
    '<strong>This app failed to start in the Integral sandbox.</strong><br>' +
    escapeHtml(err?.message || 'Unknown error') +
    (tail.length
      ? '<pre style="margin:12px 0 0;background:#1e1e28;color:#e6e6ef;border-radius:6px;padding:12px;overflow:auto;font:12px/1.5 ui-monospace,monospace">' +
        escapeHtml(tail.join('\n')) + '</pre>'
      : '') +
    '</div></body></html>'
  );
}

async function proxyRequest(req, res, { handle, mountPrefix, injectScript, headScript }) {
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const rel = '/' + (Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path || '');
  const target = handle.upstreamOrigin + rel + q;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQ.has(k)) headers[k] = v;
  }
  headers['accept-encoding'] = 'identity';
  headers['x-forwarded-for'] = req.ip || req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = req.protocol;
  headers['x-forwarded-host'] = req.get('host') || '';
  if (handle.auth?.cookies?.length) {
    headers.cookie = mergeCookies(req.headers.cookie, handle.auth.cookies);
  }
  Object.assign(headers, handle.auth?.headers || {});

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (req.readableEnded) {
      // The app-wide JSON parser already consumed this body; re-serialize it.
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    } else {
      body = req; // form posts, multipart, …: stream through untouched
    }
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      duplex: 'half',
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    res.status(502).type('html').send(sandboxErrorPage(
      new Error(`The sandboxed app stopped answering (${e.message}).`), handle.logs
    ));
    return;
  }

  res.status(upstream.status);
  for (const [k, v] of upstream.headers) {
    if (DROP_RES.has(k)) continue;
    if (k === 'location') res.set(k, rewriteLocation(v, handle.upstreamOrigin, mountPrefix));
    else res.set(k, v);
  }
  for (const c of upstream.headers.getSetCookie()) res.append('Set-Cookie', c);

  const type = upstream.headers.get('content-type') || '';
  if (/text\/html/i.test(type)) {
    const html = await upstream.text();
    res.send(injectIntoHtml(html, { mountPrefix, headScript, injectScript }));
    return;
  }
  if (!upstream.body || upstream.status === 204 || upstream.status === 304 || req.method === 'HEAD') {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

module.exports = { proxyRequest, sandboxErrorPage, rewriteLocation, mergeCookies };
