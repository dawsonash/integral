// Seeds the "DeskDrop booking" test with a spread of real browser sessions —
// fast/slow successes, a wrong-first-pick, a back-and-forth date fix, a
// give-up, an abandon, and a too-fast discard — so the results screen shows a
// fully populated funnel, time chart, SEQ distribution, comments, heatmap,
// and replays.
//
// Usage: node scripts/seed-deskdrop.js
// Requires Google Chrome at the default macOS path (used headlessly).
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const puppeteer = require('puppeteer-core');
  const app = require('../server/app');
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://localhost:${server.address().port}`;

  // The dev-facing API is auth-gated; dev login gets the same 'dev' user the
  // local dashboard uses, so the seeded test shows up there.
  const auth = await fetch(`${base}/auth/dev`, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie()[0].split(';')[0];

  // Reuse the existing DeskDrop test; create it from the fixture if missing.
  const tests = await (await fetch(`${base}/api/tests`, { headers: { Cookie: cookie } })).json();
  let test = tests.find((t) => /deskdrop/i.test(t.name));
  if (!test) {
    const fd = new FormData();
    fd.append('name', 'DeskDrop booking');
    fd.append('html', fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'desk-booking.html'), 'utf8'));
    test = await (await fetch(`${base}/api/tests`, { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
  }
  await fetch(`${base}/api/tests/${test.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      task_prompt: test.task_prompt || 'Book desk B4 for Tuesday.',
      // The full chain, so the results screen shows per-step funnel progress:
      // wrong-desk and give-up sessions hit only part of it.
      success_signals: [
        { kind: 'click', selector: '[data-testid="desk-B4"]', label: 'Desk B4' },
        { kind: 'value', selector: '#date', value: 'Tue Jul 7', label: 'Date = Tuesday, Jul 7' },
        { kind: 'click', selector: '#confirm', label: 'Confirm booking' },
      ],
      status: 'live',
    }),
  });
  console.log(`Seeding test ${test.id} (${test.name}); running demo sessions…`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fingerprint dedupe allows one completed response per IP+UA, so the UA must
  // be unique per run or a rerun is rejected with 409 already_participated.
  const runId = Date.now().toString(36);

  async function openSession(ua) {
    const page = await browser.newPage();
    await page.setUserAgent(`${ua}-${runId}`);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/t/${test.id}`, { waitUntil: 'networkidle0' });
    await page.click('#consent');
    const f = await (await page.$('#appframe')).contentFrame();
    await f.waitForSelector('.card[data-desk="B4"]');
    return { page, f };
  }

  async function submitSeq(page, seq, comment) {
    await page.waitForSelector('#overlay', { visible: true });
    if (seq) {
      await page.$$eval('.seq-scale button', (btns, s) => btns[s - 1].click(), seq);
      if (comment) await page.type('#seqcomment', comment);
      await page.click('#seqsubmit');
    }
    await sleep(3200); // let event/interaction buffers flush
    await page.close();
  }

  async function fillDetails(f, { name, email, typos = false, date = 'Tue Jul 7' }) {
    await f.click('#name');
    if (typos) {
      await f.type('#name', name.slice(0, 4) + 'xx', { delay: 90 });
      await f.focus('#name');
      await f.$eval('#name', (el) => { el.value = ''; });
      await f.type('#name', name, { delay: 70 });
    } else {
      await f.type('#name', name, { delay: 55 });
    }
    await f.type('#email', email, { delay: 40 });
    if (date) await f.select('#date', date);
  }

  // A completing session: optional wandering, pick a desk (possibly the wrong
  // one first), fill details, review, confirm — then SEQ.
  async function success({ ua, seq, comment, dwellMs = 1200, wander = false, wrongDeskFirst = false, wrongDateFirst = false, typos = false, name, email }) {
    const { page, f } = await openSession(ua);
    await sleep(dwellMs);
    if (wander) {
      await f.hover('.card[data-desk="A1"]');
      await sleep(450);
      await f.hover('.card[data-desk="C2"]');
      await sleep(400);
      await f.hover('.card[data-desk="D1"]');
      await sleep(500);
    }
    if (wrongDeskFirst) {
      await f.click('.card[data-desk="C2"]');
      await sleep(900);
    }
    await f.hover('.card[data-desk="B4"]');
    await f.click('.card[data-desk="B4"]');
    await sleep(500);
    await f.click('#to-details');
    await f.waitForSelector('#screen-details.active');
    await fillDetails(f, { name, email, typos, date: wrongDateFirst ? null : 'Tue Jul 7' });
    await sleep(600);
    await f.click('#to-review');
    await f.waitForSelector('#screen-review.active');
    await sleep(1000);
    if (wrongDateFirst) {
      // Spots "Monday" on the review screen, goes back to fix the date.
      await f.hover('#r-date');
      await sleep(900);
      await f.click('#back-details');
      await f.waitForSelector('#screen-details.active');
      await f.select('#date', 'Tue Jul 7');
      await sleep(500);
      await f.click('#to-review');
      await f.waitForSelector('#screen-review.active');
      await sleep(800);
    }
    await f.hover('#confirm');
    await f.click('#confirm');
    await submitSeq(page, seq, comment);
    console.log(`  success session done (${ua})`);
  }

  // Pokes at the taken (grey) desks, gets confused, gives up from the taskbar.
  async function giveUp({ ua, seq, comment }) {
    const { page, f } = await openSession(ua);
    await sleep(1800);
    await f.hover('.card[data-desk="A2"]');
    await f.click('.card[data-desk="A2"]');
    await sleep(1200);
    await f.click('.card[data-desk="A2"]');
    await sleep(900);
    await f.hover('.card[data-desk="C3"]');
    await f.click('.card[data-desk="C3"]');
    await sleep(1500);
    await f.hover('#to-details');
    await sleep(800);
    await page.click('#giveup');
    await submitSeq(page, seq, comment);
    console.log(`  give-up session done (${ua})`);
  }

  // Starts the task, picks a desk, then leaves mid-flow → shows as a drop-off.
  async function abandon({ ua }) {
    const { page, f } = await openSession(ua);
    await sleep(1500);
    await f.click('.card[data-desk="D1"]');
    await sleep(800);
    await f.click('#to-details');
    await f.waitForSelector('#screen-details.active');
    await f.type('#name', 'Priya', { delay: 60 });
    await sleep(2800); // let at least one buffer flush land before bailing
    await page.goto('about:blank'); // fires pagehide → abandon beacon
    await sleep(600);
    await page.close();
    console.log(`  abandoned session done (${ua})`);
  }

  // Bails out within the junk-filter window → auto-discarded as too_fast.
  async function tooFast({ ua }) {
    const { page } = await openSession(ua);
    await sleep(700);
    await page.click('#giveup');
    await page.waitForSelector('#overlay', { visible: true });
    await sleep(1500);
    await page.close();
    console.log(`  too-fast session done (${ua})`);
  }

  await success({ ua: 'deskdrop-tester-1', seq: 7, comment: 'Three taps and done — the step dots made it obvious where I was.', dwellMs: 800, name: 'Ada Park', email: 'ada@company.com' });
  await success({ ua: 'deskdrop-tester-2', seq: 6, wander: true, dwellMs: 1600, name: 'Marcus Webb', email: 'marcus@company.com' });
  await success({ ua: 'deskdrop-tester-3', seq: 6, wrongDeskFirst: true, comment: 'Almost booked C2 — I was scanning for “B4” but the desk names are smaller than the perks.', dwellMs: 1400, name: 'Jo Tanaka', email: 'jo@company.com' });
  await success({ ua: 'deskdrop-tester-4', seq: 4, wrongDateFirst: true, comment: 'Nearly booked the wrong day. The date defaults to Monday and it’s easy to sail past.', dwellMs: 2000, wander: true, name: 'Sam Osei', email: 'sam@company.com' });
  await success({ ua: 'deskdrop-tester-5', seq: 5, typos: true, comment: 'Why do you need my email just to hold a desk?', dwellMs: 2400, name: 'Lena Kovacs', email: 'lena@company.com' });
  await success({ ua: 'deskdrop-tester-6', seq: 7, dwellMs: 1000, name: 'Diego Ruiz', email: 'diego@company.com' });
  await success({ ua: 'deskdrop-tester-7', seq: 5, wander: true, dwellMs: 3000, name: 'Nora Lind', email: 'nora@company.com' });
  await giveUp({ ua: 'deskdrop-tester-8', seq: 2, comment: 'The grey desks still look tappable — I kept clicking A2 and nothing happened.' });
  await abandon({ ua: 'deskdrop-tester-9' });
  await tooFast({ ua: 'deskdrop-tester-10' });

  await browser.close();
  server.close();
  console.log(`Done. Start the app (npm start) and open /tests/${test.id}/results`);
}

main().catch((e) => { console.error(e); process.exit(1); });
