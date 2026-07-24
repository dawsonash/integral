// Unit tests for the recorder's pure helpers. The recorder is an IIFE meant
// for the browser, so it's loaded in a vm context with a minimal window /
// location / document stub and the helpers are read off
// window.__integralInternals (test hooks — no recorder state).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadInternals() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'inject', 'recorder.js'), 'utf8');
  const window = {
    top: {}, // must differ from window so the recorder doesn't bail
    parent: { postMessage() {} },
    addEventListener() {},
  };
  const ctx = {
    window,
    location: { origin: 'http://localhost', pathname: '/t/x/app/', hash: '' },
    // inDoc() resolves connectedness through documentElement.contains; fake
    // nodes carry a `connected` flag instead of living in a real DOM.
    document: { documentElement: { contains: (el) => !!(el && el.connected) } },
    Date,
    Math,
    String,
    Object,
    WeakSet,
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.ok(window.__integralInternals, 'recorder exposes test hooks');
  return window.__integralInternals;
}

const I = loadInternals();

test('cleanName strips ::, collapses whitespace, truncates at 48', () => {
  assert.equal(I.cleanName('  Upload::audio \n now  '), 'Upload audio now');
  const long = 'He simply accepted the sentence as if it had always been there and more';
  assert.equal(I.cleanName(long).length, 48);
  assert.equal(I.cleanName(long), 'He simply accepted the sentence as if it had alw');
});

test('fnv is deterministic and 6 hex chars', () => {
  assert.equal(I.fnv('abc'), I.fnv('abc'));
  assert.notEqual(I.fnv('abc'), I.fnv('abd'));
  assert.match(I.fnv('anything'), /^[0-9a-f]{6}$/);
});

test('subtreeWeight counts the node plus its descendants', () => {
  assert.equal(I.subtreeWeight({ nodeType: 1, getElementsByTagName: () => ({ length: 5 }) }), 6);
  assert.equal(I.subtreeWeight({ nodeType: 1, getElementsByTagName: () => ({ length: 0 }) }), 1);
});

test('churn carry: add-only churn never becomes a replacement candidate', () => {
  const carry = { a: 0, r: 0, until: 0 };
  const now = 1000;
  let g = I.churnGate(carry, 10, 0, now); // modal opens: add-only
  assert.equal(Math.min(g.a, g.r), 0, 'no replacement signal');
  I.churnSettle(carry, false, g.a, g.r, now); // unconsumed → carried
  g = I.churnGate(carry, 0, 10, now + 1000); // modal closes: remove-only
  // Carried add + fresh remove pairs up — the heading-turnover gate in
  // evalDomSwap is what stops this pair from committing a screen; the carry
  // itself is allowed to combine them.
  assert.equal(g.a, 10);
  assert.equal(g.r, 10);
});

test('churn carry: teardown + build windows combine within 4s', () => {
  const carry = { a: 0, r: 0, until: 0 };
  const now = 1000;
  let g = I.churnGate(carry, 0, 5, now); // clear phase: remove-heavy
  assert.equal(Math.min(g.a, g.r), 0);
  I.churnSettle(carry, false, g.a, g.r, now);
  g = I.churnGate(carry, 6, 0, now + 2000); // build phase after fetch
  assert.equal(g.a, 6);
  assert.equal(g.r, 5);
  assert.ok(Math.min(g.a, g.r) >= 2, 'combined halves form a replacement');
});

test('churn carry: expires after its window', () => {
  const carry = { a: 0, r: 0, until: 0 };
  I.churnSettle(carry, false, 0, 5, 1000);
  const g = I.churnGate(carry, 6, 0, 1000 + 4001); // past carry.until
  assert.equal(g.r, 0, 'stale teardown not carried');
});

test('churn carry: consumption clears it', () => {
  const carry = { a: 0, r: 0, until: 0 };
  I.churnSettle(carry, false, 4, 4, 1000);
  assert.equal(carry.a, 4);
  I.churnSettle(carry, true, 4, 4, 2000); // evalDomSwap consumed the churn
  const g = I.churnGate(carry, 0, 0, 2100);
  assert.equal(g.a + g.r, 0);
});

test('churn carry: sub-threshold noise is not carried', () => {
  const carry = { a: 0, r: 0, until: 0 };
  I.churnSettle(carry, false, 1, 0, 1000); // a single stray insert
  assert.equal(carry.a + carry.r, 0);
});

test('headingsSwapped: disconnected previous heading means turnover', () => {
  const gone = { connected: false };
  assert.equal(I.headingsSwapped([{ el: gone, text: 'Tools', tag: 'H2' }], []), true);
});

test('headingsSwapped: identical connected sets mean no turnover', () => {
  const h1 = { connected: true };
  const h2 = { connected: true };
  const prev = [{ el: h1, text: 'Acme', tag: 'H1' }, { el: h2, text: 'Tools', tag: 'H2' }];
  assert.equal(I.headingsSwapped(prev, prev.slice()), false);
});

test('headingsSwapped: a brand-new heading node means turnover', () => {
  const h1 = { connected: true };
  const fresh = { connected: true };
  assert.equal(
    I.headingsSwapped(
      [{ el: h1, text: 'Acme', tag: 'H1' }],
      [{ el: h1, text: 'Acme', tag: 'H1' }, { el: fresh, text: 'Upload audio', tag: 'H2' }]
    ),
    true
  );
});
