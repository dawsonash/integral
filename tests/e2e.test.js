// End-to-end test in a real headless Chrome: dev sets up a test through the
// setup UI (including point-and-click success-target picking inside the
// preview iframe), a testee takes it through the shell (consent → multi-screen
// task → auto-detected success → SEQ), and the results reflect the session.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-e2e-'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const app = require('../server/app');

let server, base, browser, cookie;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  // Dev-mode session: once for node-side fetches (cookie header), once for the
  // browser's cookie jar (the setup/results pages are auth-gated now).
  const res = await fetch(`${base}/auth/dev`, { redirect: 'manual' });
  cookie = res.headers.getSetCookie()[0].split(';')[0];
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-first-run', '--disable-extensions'],
  });
  const p = await browser.newPage();
  await p.goto(`${base}/auth/dev`, { waitUntil: 'networkidle0' });
  await p.close();
});

after(async () => {
  if (browser) await browser.close();
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

async function createDemoTest() {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(__dirname, '..', 'fixtures', 'demo-shop'));
  const fd = new FormData();
  fd.append('name', 'E2E demo shop');
  fd.append('zip', new Blob([zip.toBuffer()]), 'shop.zip');
  const res = await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return res.json();
}

test('full loop: setup UI picker → launch → testee flow → results', { timeout: 120000 }, async () => {
  const t = await createDemoTest();

  // ---------- dev: setup via the UI ----------
  const dev = await browser.newPage();
  await dev.setViewport({ width: 1400, height: 900 });
  await dev.goto(`${base}/tests/${t.id}/setup`, { waitUntil: 'networkidle0' });

  await dev.type('#task_prompt', 'Add the blue hoodie to your cart and check out.');

  // Navigate the preview to the cart screen (browse mode), then record the
  // checkout click as the success step (record mode drives the app for real).
  await dev.click('#mode-browse');
  const frameEl = await dev.$('#frame');
  let frame = await frameEl.contentFrame();
  await frame.waitForSelector('#cart-link');
  await frame.click('#cart-link');
  await dev.waitForFunction(
    () => document.getElementById('curpage').textContent.includes('cart.html')
  );
  await dev.click('#mode-pick');
  frame = await (await dev.$('#frame')).contentFrame();
  await frame.waitForSelector('#checkout');
  await frame.click('#checkout');
  await dev.waitForFunction(
    () => document.querySelector('#chips code') &&
      document.querySelector('#chips code').textContent === '#checkout'
  );

  await dev.click('#launch');
  await dev.waitForSelector('#sharebox', { visible: true });
  const shareLink = await dev.$eval('#sharelink', (el) => el.value);
  assert.match(shareLink, new RegExp(`/t/${t.id}$`));
  await dev.close();

  // Confirm persisted config: demonstration produced a one-step chain.
  const cfg = await (await fetch(`${base}/api/tests/${t.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(cfg.status, 'live');
  assert.deepEqual(cfg.signals, [
    { kind: 'click', selector: '#checkout', label: 'Check out', page: 'cart.html' },
  ]);

  // ---------- testee: take the test ----------
  const tester = await browser.newPage();
  await tester.setViewport({ width: 1280, height: 800 });
  await tester.goto(`${base}/t/${t.id}`, { waitUntil: 'networkidle0' });

  // Consent gate: the recording notice now lives behind the privacy link.
  const consentText = await tester.$eval('#gatecard', (el) => el.textContent);
  assert.match(consentText, /Privacy policy/);
  assert.match(consentText, /Try Integral/);
  await tester.click('#consent');
  await tester.waitForSelector('#appframe');

  const getAppFrame = async () => {
    const el = await tester.$('#appframe');
    return el.contentFrame();
  };

  // Multi-screen task: shop → add to cart → cart → type (masked) → checkout.
  let af = await getAppFrame();
  await af.waitForSelector('button.add[data-item=blue]');
  await new Promise((r) => setTimeout(r, 800)); // generate some dwell + mousemove
  await af.hover('button.add[data-item=blue]');
  await af.click('button.add[data-item=blue]');
  await af.click('#cart-link');

  await tester.waitForFunction(() => {
    const f = document.getElementById('appframe');
    return f && f.contentWindow.location.pathname.endsWith('cart.html');
  });
  af = await getAppFrame();
  await af.waitForSelector('#checkout');
  await af.type('#email', 'secret@example.com'); // must be masked in the replay
  await new Promise((r) => setTimeout(r, 2600)); // clear the junk-filter floor
  await af.click('#checkout');

  // Success auto-detected → SEQ overlay.
  await tester.waitForSelector('#overlay', { visible: true });
  const overlayText = await tester.$eval('#overlaycard', (el) => el.textContent);
  assert.match(overlayText, /Task complete/);
  await tester.$$eval('.seq-scale button', (btns) => btns[5].click()); // score 6
  await tester.type('#seqcomment', 'Smooth, found it right away');
  await tester.click('#seqsubmit');
  await tester.waitForFunction(
    () => document.getElementById('overlaycard').textContent.includes('thank')
  );
  await new Promise((r) => setTimeout(r, 3000)); // let the shell flush buffers
  await tester.close();

  // ---------- verify captured data ----------
  const results = await (await fetch(`${base}/api/tests/${t.id}/results`, { headers: { Cookie: cookie } })).json();
  assert.equal(results.metrics.completed, 1);
  assert.equal(results.metrics.succeeded, 1);
  assert.equal(results.metrics.successRate, 1);
  assert.ok(results.metrics.medianTimeMs > 3000);
  assert.equal(results.sessions[0].seqScore, 6);
  assert.match(results.comments[0].comment, /Smooth/);
  assert.ok(results.sessions[0].interactionCount > 5, 'interaction stream captured');

  const sid = results.sessions[0].id;
  const { events } = await (await fetch(`${base}/api/tests/${t.id}/sessions/${sid}/events`, { headers: { Cookie: cookie } })).json();
  assert.ok(events.length > 20, `expected a real rrweb stream, got ${events.length} events`);
  assert.ok(events.some((e) => e.type === 2), 'has full snapshots');
  assert.ok(events.filter((e) => e.type === 2).length >= 2, 'snapshot per screen (multi-page)');

  // Privacy: typed email content must not appear anywhere in the replay stream.
  const raw = JSON.stringify(events);
  assert.ok(!raw.includes('secret@example.com'), 'typed input is masked');
  assert.ok(raw.includes('******'), 'masked value preserves keystroke behavior (length)');

  // Heatmap captured document-coordinate points for the entry page.
  const heat = await (await fetch(`${base}/api/tests/${t.id}/heatmap?kind=click&page=index.html`, { headers: { Cookie: cookie } })).json();
  assert.ok(heat.points.length >= 1, 'click heatmap has points');
  assert.ok(heat.pages.some((p) => p.key === 'cart.html'), 'multi-screen pages tracked');
  assert.ok(heat.snapshot && heat.snapshot.sessionId, 'nav marker gives a snapshot moment');

  // ---------- dev: results page renders and replay plays ----------
  const rp = await browser.newPage();
  await rp.setViewport({ width: 1400, height: 900 });
  await rp.goto(`${base}/tests/${t.id}/results`, { waitUntil: 'networkidle0' });
  const statText = await rp.$eval('#metrics', (el) => el.textContent);
  assert.match(statText, /100%/);

  // Comment renders with its sentiment badge and the card rollup. "Smooth,
  // found it right away" reads positive to a human but scores 0 — neither
  // "smooth" nor "found" is in VADER's lexicon — which is exactly the caveat
  // the card copy carries.
  const commentText = await rp.$eval('#comments', (el) => el.textContent);
  assert.match(commentText, /Smooth, found it right away/);
  assert.match(commentText, /neutral/);
  const rollText = await rp.$eval('#commentroll', (el) => el.textContent);
  assert.match(rollText, /0 negative · 1 neutral · 0 positive/);

  await rp.click('[data-replay]');
  await rp.waitForSelector('#playerview iframe', { timeout: 15000 });
  const replayOk = await rp.waitForFunction(() => {
    const f = document.querySelector('#playerview iframe');
    return f && f.contentDocument && f.contentDocument.body &&
      f.contentDocument.body.innerHTML.includes('Hoodie');
  }, { timeout: 15000 });
  assert.ok(replayOk, 'replayer rebuilt the recorded shop DOM');
  // The masked email field must not leak content into the replayed DOM.
  const replayedInputs = await rp.evaluate(() => {
    const f = document.querySelector('#playerview iframe');
    return f.contentDocument.documentElement.outerHTML;
  });
  assert.ok(!replayedInputs.includes('secret@example.com'), 'replayed DOM stays masked');

  // Heatmap background is a paused rrweb snapshot, not a live iframe.
  await rp.waitForSelector('#heatstage .replayer-wrapper iframe', { timeout: 15000 });
  await rp.close();
});

test('SPA screens split the heatmap: pushState routes and pure DOM swaps', { timeout: 120000 }, async () => {
  const fd = new FormData();
  fd.append('name', 'SPA screens');
  fd.append('html', fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'spa.html'), 'utf8'));
  const t = await (await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
  await fetch(`${base}/api/tests/${t.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      task_prompt: 'Buy the pro plan',
      success_type: 'click',
      success_selector: '#buy',
      status: 'live',
    }),
  });

  // Two testers take the same wizard detour so we can assert the DOM-derived
  // screen key is stable across sessions (buckets must aggregate, not fork).
  for (const ua of ['integral-e2e-spa-1', 'integral-e2e-spa-2']) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/t/${t.id}`, { waitUntil: 'networkidle0' });
    await page.click('#consent');
    await page.waitForSelector('#appframe');
    const af = await (await page.$('#appframe')).contentFrame();
    await af.waitForSelector('#to-wizard');
    await new Promise((r) => setTimeout(r, 1200)); // dwell on home (baseline screen)
    await af.click('#to-wizard');                  // DOM swap, no URL change
    await new Promise((r) => setTimeout(r, 800));  // let the swap detector commit
    await af.click('#wizard-ok');                  // interaction on the wizard screen
    await new Promise((r) => setTimeout(r, 400));
    await af.click('#go-plans');                   // pushState route change
    await af.waitForSelector('#buy');
    await new Promise((r) => setTimeout(r, 1200));
    await af.click('#buy');                        // success + interaction on 'plans'
    await page.waitForSelector('#overlay', { visible: true });
    await new Promise((r) => setTimeout(r, 3000)); // let the shell flush buffers
    await page.close();
  }

  const heat = await (await fetch(`${base}/api/tests/${t.id}/heatmap?kind=click&page=index.html`, { headers: { Cookie: cookie } })).json();
  const keys = heat.pages.map((p) => p.key);
  assert.ok(keys.includes('index.html'), `entry screen tracked (got ${keys})`);
  assert.ok(keys.includes('index.html::Wizard'), `DOM-swap screen tracked (got ${keys})`);
  assert.ok(keys.includes('plans'), `pushState route tracked (got ${keys})`);
  // Stability: two sessions, still exactly one wizard bucket.
  assert.equal(keys.filter((k) => k.indexOf('::') !== -1).length, 1, `DOM screens must not fork per session (got ${keys})`);

  const wiz = await (await fetch(
    `${base}/api/tests/${t.id}/heatmap?kind=click&page=${encodeURIComponent('index.html::Wizard')}`,
    { headers: { Cookie: cookie } }
  )).json();
  assert.ok(wiz.points.length >= 2, 'wizard clicks bucketed to the wizard screen');
  assert.ok(wiz.snapshot && wiz.snapshot.sessionId, 'wizard screen has a snapshot moment');
});

test('deep DOM swaps under persistent chrome: screens split without chrome-named keys', { timeout: 120000 }, async () => {
  // React-shaped fixture: persistent header h1 "Acme", content swapped three
  // levels below <body>. Screens must split on the deep swaps, be named after
  // the content heading (not the chrome), and returning to the first screen
  // must map back to the bare route key instead of forking "::Tools".
  const fd = new FormData();
  fd.append('name', 'React-like screens');
  fd.append('html', fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'react-like.html'), 'utf8'));
  const t = await (await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
  await fetch(`${base}/api/tests/${t.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      task_prompt: 'Upload an audio file',
      success_type: 'click',
      success_selector: '#do-upload',
      status: 'live',
    }),
  });

  for (const ua of ['integral-e2e-react-1', 'integral-e2e-react-2']) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/t/${t.id}`, { waitUntil: 'networkidle0' });
    await page.click('#consent');
    await page.waitForSelector('#appframe');
    const af = await (await page.$('#appframe')).contentFrame();
    await af.waitForSelector('#open-upload');
    await new Promise((r) => setTimeout(r, 1200)); // dwell on Tools (baseline screen)
    await af.click('#refresh');                    // identical re-render: must not fork
    await new Promise((r) => setTimeout(r, 800));
    await af.click('#open-upload');                // deep swap → Upload screen
    await new Promise((r) => setTimeout(r, 800));
    await af.click('#back-tools');                 // back to Tools: must map to the bare key
    await new Promise((r) => setTimeout(r, 800));
    await af.click('#open-upload');                // revisit: key must be stable
    await af.waitForSelector('#do-upload');
    await new Promise((r) => setTimeout(r, 800));
    await af.click('#do-upload');                  // success on the Upload screen
    await page.waitForSelector('#overlay', { visible: true });
    await new Promise((r) => setTimeout(r, 3000)); // let the shell flush buffers
    await page.close();
  }

  const heat = await (await fetch(`${base}/api/tests/${t.id}/heatmap?kind=click&page=index.html`, { headers: { Cookie: cookie } })).json();
  const keys = heat.pages.map((p) => p.key);
  assert.ok(keys.includes('index.html'), `Tools screen on the bare route key (got ${keys})`);
  assert.ok(keys.includes('index.html::Upload audio'), `deep-swap screen tracked (got ${keys})`);
  assert.ok(!keys.some((k) => k.includes('Acme')), `persistent chrome must not name screens (got ${keys})`);
  assert.ok(!keys.includes('index.html::Tools'), `return to the first screen must not fork (got ${keys})`);
  assert.equal(keys.filter((k) => k.indexOf('::') !== -1).length, 1, `exactly one DOM screen across sessions (got ${keys})`);

  const up = await (await fetch(
    `${base}/api/tests/${t.id}/heatmap?kind=click&page=${encodeURIComponent('index.html::Upload audio')}`,
    { headers: { Cookie: cookie } }
  )).json();
  // The swap-triggering #back-tools click is captured before the debounced
  // commit, so it belongs to the Upload screen: 2 clicks × 2 sessions.
  assert.ok(up.points.length >= 4, `back + upload clicks bucketed to the Upload screen (got ${up.points.length})`);
  assert.ok(up.snapshot && up.snapshot.sessionId, 'Upload screen has a snapshot moment');
});

test('chained signals: record by demonstration, wrong path waits, right path succeeds', { timeout: 120000 }, async () => {
  // DeskDrop: success = picked desk B4 AND date = Tuesday AND confirmed.
  const fd = new FormData();
  fd.append('name', 'DeskDrop chain');
  fd.append('html', fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'desk-booking.html'), 'utf8'));
  const t = await (await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();

  // ---------- dev: demonstrate the successful task in record mode ----------
  const dev = await browser.newPage();
  await dev.setViewport({ width: 1400, height: 900 });
  await dev.goto(`${base}/tests/${t.id}/setup`, { waitUntil: 'networkidle0' });
  await dev.type('#task_prompt', 'Book desk B4 for Tuesday.');

  const frame = await (await dev.$('#frame')).contentFrame();
  await frame.waitForSelector('[data-testid="desk-B4"]');
  await frame.click('[data-testid="desk-B4"]'); // step: pick the desk
  await frame.click('#to-details');             // incidental navigation
  await frame.select('#date', 'Tue Jul 7');     // step: date = Tuesday (change → value chip)
  await frame.click('#to-review');              // incidental navigation
  await frame.click('#confirm');                // step: the finish line
  await dev.waitForFunction(() => document.querySelectorAll('#chips li').length === 5);

  // Prune the incidental steps (Continue, Review booking).
  await dev.$$eval('#chips li', (lis) => lis[1].querySelector('.del').click());
  await dev.$$eval('#chips li', (lis) => lis[2].querySelector('.del').click());
  await dev.waitForFunction(() => document.querySelectorAll('#chips li').length === 3);

  await dev.click('#launch');
  await dev.waitForSelector('#sharebox', { visible: true });
  await dev.close();

  const cfg = await (await fetch(`${base}/api/tests/${t.id}`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(cfg.signals.map((s) => [s.kind, s.selector]), [
    ['click', '[data-testid="desk-B4"]'],
    ['value', '#date'],
    ['click', '#confirm'],
  ]);
  assert.equal(cfg.signals[1].value, 'Tue Jul 7');
  assert.equal(cfg.signals[1].label, 'Date = Tuesday, Jul 7');

  // ---------- testee: wrong path first, then correct ----------
  const page = await browser.newPage();
  await page.setUserAgent('integral-e2e-chain');
  await page.goto(`${base}/t/${t.id}`, { waitUntil: 'networkidle0' });
  await page.click('#consent');
  await page.waitForSelector('#appframe');
  const af = await (await page.$('#appframe')).contentFrame();
  await af.waitForSelector('[data-testid="desk-B4"]');
  await new Promise((r) => setTimeout(r, 900)); // dwell past nothing; junk filter needs >3s total

  // Wrong path: B4 but the default Monday — confirming must NOT finish the task.
  await af.click('[data-testid="desk-B4"]');
  await af.click('#to-details');
  await af.click('#to-review');
  await af.click('#confirm');
  await new Promise((r) => setTimeout(r, 1200));
  const overlayShown = await page.$eval('#overlay', (el) => getComputedStyle(el).display !== 'none');
  assert.equal(overlayShown, false, 'wrong-path confirm must not terminate the task');

  // Correct it: back to details, pick Tuesday, confirm again.
  await af.click('#restart');
  await af.click('[data-testid="desk-B4"]');
  await af.click('#to-details');
  await af.select('#date', 'Tue Jul 7');
  await new Promise((r) => setTimeout(r, 1200));
  await af.click('#to-review');
  await af.click('#confirm');
  await page.waitForSelector('#overlay', { visible: true });
  const overlayText = await page.$eval('#overlaycard', (el) => el.textContent);
  assert.match(overlayText, /Task complete/);
  await new Promise((r) => setTimeout(r, 3000)); // let the shell flush buffers
  await page.close();

  // ---------- results: success + full chain progress ----------
  const results = await (await fetch(`${base}/api/tests/${t.id}/results`, { headers: { Cookie: cookie } })).json();
  assert.equal(results.metrics.completed, 1);
  assert.equal(results.metrics.succeeded, 1);
  assert.deepEqual(results.metrics.signals.map((s) => s.hit), [1, 1, 1]);
});

test('give-up path records a completed unsuccessful session', { timeout: 60000 }, async () => {
  const t = await createDemoTest();
  await fetch(`${base}/api/tests/${t.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      task_prompt: 'Find the pricing page',
      success_type: 'click',
      success_selector: '#nonexistent',
      status: 'live',
    }),
  });

  const page = await browser.newPage();
  // Distinct fingerprint from the previous test's sessions (shared IP+UA).
  await page.setUserAgent('integral-e2e-giveup');
  await page.goto(`${base}/t/${t.id}`, { waitUntil: 'networkidle0' });
  await page.click('#consent');
  const af = await (await page.$('#appframe')).contentFrame();
  await af.waitForSelector('h1');
  await af.hover('h1');
  await new Promise((r) => setTimeout(r, 3200));
  await page.click('#giveup');
  await page.waitForSelector('#overlay', { visible: true });
  await page.close();

  const results = await (await fetch(`${base}/api/tests/${t.id}/results`, { headers: { Cookie: cookie } })).json();
  assert.equal(results.metrics.completed, 1);
  assert.equal(results.metrics.succeeded, 0);
  assert.equal(results.metrics.gaveUp, 1);
});
