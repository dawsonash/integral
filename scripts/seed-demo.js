// Seeds a demo test ("Hoodie Shop") with a handful of real browser sessions so
// the dashboard, replays, and heatmap have data to show.
//
// Usage: node scripts/seed-demo.js
// Requires Google Chrome at the default macOS path (used headlessly).
const path = require('path');
const AdmZip = require('adm-zip');

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

  // Create + configure + launch the demo test.
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(__dirname, '..', 'fixtures', 'demo-shop'));
  const fd = new FormData();
  fd.append('name', 'Hoodie Shop — checkout flow');
  fd.append('zip', new Blob([zip.toBuffer()]), 'shop.zip');
  const test = await (await fetch(`${base}/api/tests`, { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
  await fetch(`${base}/api/tests/${test.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      task_prompt: 'Add the blue hoodie to your cart and check out.',
      success_type: 'click',
      success_selector: '#checkout',
      success_label: 'Check out',
      success_screen: 'cart.html',
      response_cap: 25,
      status: 'live',
    }),
  });
  console.log(`Seeded test ${test.id}; running demo sessions…`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });

  async function session({ ua, succeed, seq, comment, dwellMs = 1200, wander = false, giveUp = false }) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/t/${test.id}`, { waitUntil: 'networkidle0' });
    await page.click('#consent');
    const getFrame = async () => (await page.$('#appframe')).contentFrame();
    let f = await getFrame();
    await f.waitForSelector('button.add[data-item=blue]');
    await new Promise((r) => setTimeout(r, dwellMs));
    if (wander) {
      await f.hover('button.add[data-item=red]');
      await f.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
      await new Promise((r) => setTimeout(r, 600));
      await f.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await f.hover('button.add[data-item=green]');
      await new Promise((r) => setTimeout(r, 500));
    }
    await f.hover('button.add[data-item=blue]');
    await f.click('button.add[data-item=blue]');
    await new Promise((r) => setTimeout(r, 400));
    await f.click('#cart-link');
    await page.waitForFunction(() => {
      const fr = document.getElementById('appframe');
      return fr && fr.contentWindow.location.pathname.endsWith('cart.html');
    });
    f = await getFrame();
    await f.waitForSelector('#checkout');
    await f.type('#promo', 'HOODIE10', { delay: 60 });
    await f.type('#email', 'tester@example.com', { delay: 40 });
    await new Promise((r) => setTimeout(r, 900));
    if (giveUp) {
      await page.click('#giveup');
    } else if (succeed) {
      await f.click('#checkout');
    }
    await page.waitForSelector('#overlay', { visible: true });
    if (seq) {
      await page.$$eval('.seq-scale button', (btns, s) => btns[s - 1].click(), seq);
      if (comment) await page.type('#seqcomment', comment);
      await page.click('#seqsubmit');
    }
    await new Promise((r) => setTimeout(r, 3200)); // let buffers flush
    await page.close();
    console.log(`  session done (${ua})`);
  }

  await session({ ua: 'demo-tester-1', succeed: true, seq: 7, comment: 'Dead simple, found it immediately.' });
  await session({ ua: 'demo-tester-2', succeed: true, seq: 6, wander: true });
  await session({ ua: 'demo-tester-3', succeed: true, seq: 5, comment: 'Took me a second to spot the cart link.', dwellMs: 2500, wander: true });
  await session({ ua: 'demo-tester-4', giveUp: true, seq: 2, comment: 'I expected a buy button on the product itself.', dwellMs: 2000, wander: true });

  await browser.close();
  server.close();
  console.log(`Done. Start the app (npm start) and open /tests/${test.id}/results`);
}

main().catch((e) => { console.error(e); process.exit(1); });
