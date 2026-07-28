// Records the landing-page product demo: boots a throwaway Integral instance,
// drives the real product through the full loop in a headless Chrome, and
// stitches the captured frames into public/demo/demo.mp4 + a poster frame.
//
// Usage: node scripts/demo-video.js [--keep-frames]
// Requires Google Chrome (CHROME_PATH to override) and ffmpeg on PATH.
//
// Nothing here touches your real data: the server runs on an ephemeral port
// against a temp INTEGRAL_DATA_DIR that is deleted on exit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = path.join(__dirname, '..', 'public', 'demo');
const KEEP_FRAMES = process.argv.includes('--keep-frames');

// The video is 1280×800; frames are captured at 1.5× and downsampled, which
// is what keeps text crisp without a 4× file size.
const VIEW = { width: 1280, height: 800, deviceScaleFactor: 2 };
const CAPTURE = { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 };
const FPS = 30;
// Playback is stretched at mux time rather than by driving the browser more
// slowly: the capture stays quick and deterministic, and the pacing is one
// number to turn. 1.0 = as recorded.
const SLOWDOWN = 1.4;

// A demo instance must never inherit real OAuth/Stripe/Postgres config: dev
// login has to be available and billing has to stay off.
for (const k of Object.keys(process.env)) {
  if (/^(GITHUB_|STRIPE_|RESEND_|INTEGRAL_)/.test(k)) delete process.env[k];
}
// Placeholder OAuth credentials: never used (the demo signs in through dev
// login, which is gated on NODE_ENV, not on these) but they make the repo tab
// render its real "Connect GitHub repositories" state instead of the
// "OAuth isn't configured on this server" warning.
process.env.NODE_ENV = 'development';
process.env.GITHUB_CLIENT_ID = 'demo-video';
process.env.GITHUB_CLIENT_SECRET = 'demo-video';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-demo-'));
const FRAME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-frames-'));
process.env.INTEGRAL_DATA_DIR = DATA_DIR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------- overlay --
// Injected into every top-level document (survives navigation via
// evaluateOnNewDocument). Chrome's screencast never captures the real cursor,
// so the demo draws its own — plus the caption bar and the title cards.
function installOverlay() {
  if (window.top !== window || window.__demo) return;
  const state = { x: -100, y: -100, tween: null };

  function boot() {
    const root = document.createElement('div');
    root.id = '__demo';
    root.innerHTML = `
      <style>
        #__demo, #__demo * { box-sizing: border-box; }
        #__demo {
          position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
          font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
        }
        #__demo-cursor {
          position: absolute; left: 0; top: 0; width: 26px; height: 26px;
          margin: -3px 0 0 -3px; transform: translate3d(-100px, -100px, 0);
          filter: drop-shadow(0 2px 4px rgba(15, 16, 40, .45));
        }
        #__demo-ripple {
          position: absolute; left: 0; top: 0; width: 14px; height: 14px;
          margin: -7px 0 0 -7px; border-radius: 50%;
          border: 2px solid #c2410c; background: rgba(194, 65, 12, .18);
          opacity: 0; transform: translate3d(-100px, -100px, 0) scale(1);
        }
        #__demo-ripple.go { animation: __demo-pop .5s ease-out; }
        @keyframes __demo-pop {
          from { opacity: .95; }
          to   { opacity: 0; width: 54px; height: 54px; margin: -27px 0 0 -27px; }
        }
        #__demo-cap {
          position: absolute; left: 28px; bottom: 28px; max-width: 620px;
          display: flex; align-items: center; gap: 12px;
          padding: 12px 20px 12px 14px; border-radius: 12px;
          background: rgba(20, 20, 46, .93); color: #fff;
          font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
          box-shadow: 0 10px 30px rgba(15, 16, 40, .28);
          opacity: 0; transform: translateY(10px);
          transition: opacity .28s ease, transform .28s ease;
        }
        #__demo-cap.on { opacity: 1; transform: translateY(0); }
        /* Right-anchored when the left column is where the action is. */
        #__demo-cap.br { left: auto; right: 28px; }
        #__demo-cap b {
          flex: none; width: 26px; height: 26px; border-radius: 50%;
          background: #c2410c; color: #fff; font-size: 14px;
          display: flex; align-items: center; justify-content: center;
        }
        #__demo-title {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 18px;
          background: #14142e; color: #fff; text-align: center; padding: 40px;
          opacity: 0; transition: opacity .5s ease; visibility: hidden;
        }
        #__demo-title.on { opacity: 1; visibility: visible; }
        #__demo-title .mark { font-size: 46px; font-weight: 700; letter-spacing: -0.03em; }
        /* --accent (#c2410c) only makes ~3.5:1 on the #14142e title card and
           goes muddy; orange-300 (#fdba74) clears contrast but is pale enough
           to read yellow next to the nav's period. orange-500 splits it: ~6.5:1
           and still unmistakably orange. */
        #__demo-title .mark span { color: #f97316; }
        #__demo-title .sub { font-size: 21px; color: #b9bad4; max-width: 640px; line-height: 1.45; }
        #__demo-title .foot { font-size: 15px; color: #7f80a3; letter-spacing: .04em; }
      </style>
      <svg id="__demo-cursor" viewBox="0 0 26 26">
        <path d="M4 2 L4 21 L9.2 16.2 L12.6 24 L16.4 22.3 L13 14.7 L20 14.4 Z"
              fill="#14142e" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      <div id="__demo-ripple"></div>
      <div id="__demo-cap"></div>
      <div id="__demo-title">
        <div class="mark">◱ Integral<span>.</span></div>
        <div class="sub"></div>
        <div class="foot"></div>
      </div>`;
    document.documentElement.appendChild(root);

    const cursor = root.querySelector('#__demo-cursor');
    const ripple = root.querySelector('#__demo-ripple');
    const cap = root.querySelector('#__demo-cap');
    const title = root.querySelector('#__demo-title');

    function place() {
      const t = `translate3d(${state.x}px, ${state.y}px, 0)`;
      cursor.style.transform = t;
      ripple.style.transform = t;
    }
    place();

    window.__demo = {
      cursor(x, y) {
        state.tween = null;
        state.x = x;
        state.y = y;
        place();
      },
      // Mirrors the easing the driver uses for page.mouse.move, so the drawn
      // cursor and the real pointer stay on top of each other.
      glide(x, y, ms) {
        const from = { x: state.x, y: state.y };
        const t0 = performance.now();
        const id = {};
        state.tween = id;
        const step = (now) => {
          if (state.tween !== id) return;
          const p = Math.min(1, (now - t0) / ms);
          const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          state.x = from.x + (x - from.x) * e;
          state.y = from.y + (y - from.y) * e;
          place();
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      ripple() {
        ripple.classList.remove('go');
        void ripple.offsetWidth;
        ripple.classList.add('go');
      },
      caption(n, text, pos) {
        if (!text) return cap.classList.remove('on');
        cap.innerHTML = '';
        if (n) {
          const b = document.createElement('b');
          b.textContent = n;
          cap.appendChild(b);
        }
        cap.appendChild(document.createTextNode(text));
        cap.className = pos === 'br' ? 'on br' : 'on';
      },
      title(sub, foot) {
        title.querySelector('.sub').textContent = sub || '';
        title.querySelector('.foot').textContent = foot || '';
        title.classList.add('on');
      },
      untitle() {
        title.classList.remove('on');
      },
    };
  }

  if (document.documentElement) boot();
  else document.addEventListener('DOMContentLoaded', boot);
}

// --------------------------------------------------------------- recorder --
// Screencast frames only arrive when something changes, so each frame carries
// a wall-clock stamp and the muxer turns the deltas into per-frame durations.
// Pauses (off-camera work) are subtracted so they cost no video time.
class Recorder {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.frames = [];
    this.gaps = [];
    this.n = 0;
    this.on = false;
  }

  async attach() {
    this.client = await this.page.createCDPSession();
    this.client.on('Page.screencastFrame', (f) => {
      this.client.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (!this.on) return;
      const file = `f${String(this.n++).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(this.dir, file), Buffer.from(f.data, 'base64'));
      this.frames.push({ file, t: Date.now() });
    });
  }

  async start() {
    if (this.on) return;
    if (this.gapStart) {
      this.gaps.push({ start: this.gapStart, end: Date.now() });
      this.gapStart = null;
    }
    this.on = true;
    await this.client.send('Page.startScreencast', CAPTURE);
  }

  async pause() {
    if (!this.on) return;
    this.on = false;
    this.gapStart = Date.now();
    await this.client.send('Page.stopScreencast').catch(() => {});
  }

  // Screencast stops emitting after a cross-document navigation on some
  // Chrome builds; re-issuing it is cheap and idempotent.
  async poke() {
    if (this.on) await this.client.send('Page.startScreencast', CAPTURE).catch(() => {});
  }

  paused(a, b) {
    return this.gaps.reduce(
      (s, g) => s + Math.max(0, Math.min(b, g.end) - Math.max(a, g.start)),
      0
    );
  }

  concatFile() {
    if (this.frames.length < 2) throw new Error('no frames captured');
    const lines = [];
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const next = this.frames[i + 1];
      // Floor at 1ms, not a frame interval: bursts of frames sharing a
      // millisecond would otherwise each claim 1/60s and stretch the timeline.
      const raw = next ? next.t - f.t - this.paused(f.t, next.t) : 400;
      const dur = (Math.max(1, raw) * SLOWDOWN) / 1000;
      lines.push(`file '${path.join(this.dir, f.file)}'`, `duration ${dur.toFixed(4)}`);
    }
    // The concat demuxer ignores the final duration unless the last entry is
    // repeated, which would otherwise drop the closing frame.
    lines.push(`file '${path.join(this.dir, this.frames[this.frames.length - 1].file)}'`);
    const list = path.join(this.dir, 'frames.txt');
    fs.writeFileSync(list, lines.join('\n'));
    return list;
  }
}

// ----------------------------------------------------------------- driver --
// A pointer that the camera can see: every interaction goes through moveTo /
// click so the drawn cursor and the real input events stay in lockstep.
class Driver {
  constructor(page, rec) {
    this.page = page;
    this.rec = rec;
    this.at = { x: VIEW.width / 2, y: VIEW.height + 60 };
    this.cap = null;
  }

  async moveTo(x, y, ms = 620) {
    await this.page.evaluate((a) => window.__demo.glide(a.x, a.y, a.ms), { x, y, ms });
    const from = this.at;
    const steps = Math.max(10, Math.round(ms / 26));
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      const e = easeInOut(i / steps);
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      const wait = t0 + ms * (i / steps) - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.at = { x, y };
  }

  async click(x, y, { moveMs = 620 } = {}) {
    await this.moveTo(x, y, moveMs);
    await sleep(140);
    await this.page.evaluate(() => window.__demo.ripple());
    await this.page.mouse.down();
    await sleep(80);
    await this.page.mouse.up();
    await sleep(200);
  }

  // boundingBox() is in the same coordinate space as page.mouse, including
  // for elements inside the preview/app iframes.
  async box(target, sel, { scroll = false } = {}) {
    const el = await target.waitForSelector(sel, { visible: true, timeout: 20000 });
    if (scroll) {
      await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await sleep(700);
    }
    const b = await el.boundingBox();
    if (!b) throw new Error(`no box for ${sel}`);
    return { el, x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
  }

  async clickSel(target, sel, opts = {}) {
    const b = await this.box(target, sel, opts);
    await this.click(b.x, b.y, opts);
    return b;
  }

  async typeSel(target, sel, text, { delay = 30, ...opts } = {}) {
    await this.clickSel(target, sel, opts);
    await target.type(sel, text, { delay });
    await sleep(260);
  }

  async say(n, text, hold = 0, pos = 'bl') {
    this.cap = [n, text, pos];
    await this.page.evaluate((a) => window.__demo.caption(a[0], a[1], a[2]), this.cap);
    if (hold) await sleep(hold);
  }

  async hush() {
    this.cap = null;
    await this.page.evaluate(() => window.__demo.caption(null, null));
    await sleep(280);
  }

  // Where this lands in the finished video (pause-adjusted, slowdown applied),
  // for pacing the script against the running time people actually watch.
  beat(label) {
    const f = this.rec.frames;
    if (!f.length) return;
    const ms = f[f.length - 1].t - f[0].t - this.rec.paused(f[0].t, f[f.length - 1].t);
    console.log(`  ${((ms * SLOWDOWN) / 1000).toFixed(1)}s  ${label}`);
  }

  // Navigation wipes the overlay; re-apply the caption and park the cursor
  // off-screen on the far side. Callers do their own readiness wait, since
  // the recorder and rrweb keep the network busy on the take/results pages.
  async go(url, opts = {}) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', ...opts });
    await this.settle();
  }

  async settle() {
    await this.rec.poke();
    await this.page.waitForFunction(() => !!window.__demo, { timeout: 20000 });
    if (this.cap) {
      await this.page.evaluate((a) => window.__demo.caption(a[0], a[1], a[2]), this.cap);
    }
    this.at = { x: VIEW.width / 2, y: VIEW.height + 60 };
    await this.page.evaluate((a) => window.__demo.cursor(a.x, a.y), this.at);
  }

  async scrollTo(top, ms = 900) {
    await this.page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), top);
    await sleep(ms);
  }
}

// ------------------------------------------------------------------- main --
async function main() {
  const puppeteer = require('puppeteer-core');
  const app = require('../server/app');
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://localhost:${server.address().port}`;

  const auth = await fetch(`${base}/auth/dev`, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie()[0].split(';')[0];

  const zipPath = path.join(FRAME_DIR, 'hoodie-shop.zip');
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(__dirname, '..', 'fixtures', 'demo-shop'));
  zip.writeZip(zipPath);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    defaultViewport: VIEW,
    args: ['--no-first-run', '--disable-extensions', '--hide-scrollbars'],
  });

  const page = await browser.newPage();
  await page.setViewport(VIEW);
  await page.evaluateOnNewDocument(installOverlay);

  const rec = new Recorder(page, FRAME_DIR);
  await rec.attach();
  const d = new Driver(page, rec);

  // Session cookie for the browser's jar (setup/results are auth-gated).
  await page.goto(`${base}/auth/dev`, { waitUntil: 'networkidle0' });
  await rec.start();

  // ---- title card -----------------------------------------------------
  await page.evaluate(() =>
    window.__demo.title('Usability tests for the slice you just built', 'A quick tour')
  );
  await sleep(1900);
  await page.evaluate(() => window.__demo.untitle());
  await sleep(500);

  // ---- 1. create the test ---------------------------------------------
  await d.say(1, 'Upload the slice you just built — no deploy, no staging.', 400);
  await d.typeSel(page, '#name', 'Checkout flow v2', { delay: 45 });
  await d.clickSel(page, '.tabs button[data-tab="zip"]', { moveMs: 500 });
  await sleep(250);
  const zipBox = await d.box(page, '#zip');
  await d.moveTo(zipBox.x, zipBox.y, 450);
  await zipBox.el.uploadFile(zipPath);
  await sleep(600);
  await d.clickSel(page, '#create', { moveMs: 500 });

  await page.waitForFunction(() => location.pathname.endsWith('/setup'), { timeout: 20000 });
  const testId = new URL(page.url()).pathname.split('/')[2];
  await d.settle();
  await sleep(400);
  d.beat('setup page');

  // ---- 2. write the task ----------------------------------------------
  // Captions move right of centre here: the success-step chips build up in
  // the left column and the default corner would sit on top of them.
  await d.say(2, 'Write the task you want a real person to attempt.', 400, 'br');
  await d.typeSel(page, '#task_prompt', 'Add the blue hoodie to your cart and check out.', { delay: 28, moveMs: 500 });
  await sleep(300);

  // ---- 3. record success by demonstration ------------------------------
  await d.say(3, 'Just do the task. Every action becomes a step.', 700, 'br');
  await d.clickSel(page, '#mode-pick', { moveMs: 500 });
  const frameEl = await page.$('#frame');
  let frame = await frameEl.contentFrame();
  await frame.waitForSelector('button.add[data-item=blue]');
  await sleep(350);

  await d.clickSel(frame, 'button.add[data-item=blue]', { moveMs: 620 });
  await page.waitForFunction(() => document.querySelectorAll('#chips li').length >= 1);
  await sleep(400);

  await d.clickSel(frame, '#cart-link', { moveMs: 560 });
  await page.waitForFunction(() =>
    document.getElementById('curpage').textContent.includes('cart.html')
  );
  frame = await (await page.$('#frame')).contentFrame();
  await frame.waitForSelector('#checkout');
  await sleep(400);

  // A value step: the field must hold this value for the run to count.
  await d.typeSel(frame, '#promo', 'HOODIE10', { delay: 60, moveMs: 560 });
  await frame.evaluate(() => document.getElementById('promo').blur());
  await page.waitForFunction(() => document.querySelectorAll('#chips li').length >= 3);
  await sleep(350);

  await d.clickSel(frame, '#checkout', { moveMs: 560 });
  await page.waitForFunction(() => document.querySelectorAll('#chips li').length >= 4);
  await sleep(300);
  // Bring the whole recorded chain into frame for the payoff line.
  await d.scrollTo(330, 800);
  await d.say(3, 'The last step is the finish line.', 1900, 'br');
  d.beat('chain recorded');

  // ---- 4. launch --------------------------------------------------------
  await d.say(4, 'Launch it. Testers need no account.', 300, 'br');
  await d.clickSel(page, '#launch', { scroll: true, moveMs: 560 });
  await page.waitForSelector('#sharebox', { visible: true });
  await sleep(1400);

  // ---- off-camera: other people take the test --------------------------
  await d.hush();
  await rec.pause();
  await backgroundSessions(browser, base, testId);
  // A backgrounded tab stops producing screencast frames.
  await page.bringToFront();
  await rec.start();
  d.beat('launched');

  // ---- 5. a tester takes it --------------------------------------------
  await d.say(5, 'What a tester sees: consent, the task, your app.', 0);
  await d.go(`${base}/t/${testId}`);
  await sleep(1200);
  await d.clickSel(page, '#consent', { moveMs: 520 });
  await page.waitForSelector('#appframe');
  await sleep(700);

  let af = await (await page.$('#appframe')).contentFrame();
  await af.waitForSelector('button.add[data-item=blue]');
  await d.say(5, 'Every click and scroll recorded. Keystrokes masked.', 0);
  await d.moveTo(430, 470, 600);
  await sleep(300);
  await d.clickSel(af, 'button.add[data-item=blue]', { moveMs: 560 });
  await sleep(400);
  await d.clickSel(af, '#cart-link', { moveMs: 560 });
  await page.waitForFunction(() => {
    const fr = document.getElementById('appframe');
    return fr && fr.contentWindow.location.pathname.endsWith('cart.html');
  });
  af = await (await page.$('#appframe')).contentFrame();
  await af.waitForSelector('#checkout');
  await sleep(400);
  await d.typeSel(af, '#promo', 'HOODIE10', { delay: 65, moveMs: 520 });
  await af.evaluate(() => document.getElementById('promo').blur());
  await sleep(300);
  await d.clickSel(af, '#checkout', { moveMs: 560 });
  await page.waitForSelector('#overlay', { visible: true });
  await d.say(5, 'Success is detected automatically.', 1100);
  await d.say(5, 'Then one question: how easy was that?', 500);
  await d.clickSel(page, '.seq-scale button:nth-of-type(7)', { moveMs: 520 });
  await sleep(250);
  await d.clickSel(page, '#seqsubmit', { moveMs: 450 });
  await d.hush();
  await sleep(1900); // let the recorder flush its buffer
  d.beat('tester done');

  // ---- 6. results -------------------------------------------------------
  await d.say(6, 'Results land as responses come in.', 0);
  await d.go(`${base}/tests/${testId}/results`);
  await page.waitForSelector('#metrics .stat');
  await sleep(2100);

  await d.say(6, 'Success rate, drop-off, time on task, ease.', 0);
  await d.scrollTo(320, 1000);
  await sleep(1700);

  await d.say(7, 'A click heatmap over your actual screen.', 0);
  const heat = await d.box(page, '#heatwrap', { scroll: true });
  await sleep(1500);
  await d.moveTo(heat.x, heat.y, 700);
  await sleep(400);
  await page.select('#heatkind', 'move');
  await d.say(7, 'Clicks, mouse movement, or scroll depth.', 1900);

  await d.say(8, 'And a full replay of every session.', 0);
  await d.clickSel(page, '#sessions tbody tr button[data-replay]', { scroll: true, moveMs: 560 });
  await page.waitForSelector('#playerview', { visible: true });
  await sleep(4200);
  await d.clickSel(page, '#closereplay', { moveMs: 500 });
  await sleep(400);
  d.beat('results toured');

  // ---- 9. sentiment -----------------------------------------------------
  // Captions go bottom-right: the comment feed fills the left column here.
  await d.say(9, 'Every comment is scored — a lexicon, not a model.', 0, 'br');
  await d.box(page, '#commentroll', { scroll: true });
  await sleep(2000);
  await d.say(9, 'So the unhappy ones sort to the top, and you read those first.', 0, 'br');
  const sortSel = await d.box(page, '#commentsort');
  await d.moveTo(sortSel.x, sortSel.y, 620);
  await sleep(350);
  await page.select('#commentsort', 'negfirst');
  await sleep(3000);
  d.beat('sentiment shown');

  // ---- outro ------------------------------------------------------------
  await d.hush();
  await page.evaluate(() =>
    window.__demo.title('Test the slice you just built, in about two minutes.', 'Free plan · no credit card')
  );
  await sleep(2400);

  await rec.pause();
  await browser.close();
  server.close();

  // ---- encode -----------------------------------------------------------
  console.log(`Captured ${rec.frames.length} frames; encoding…`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const list = rec.concatFile();
  const vf = `fps=${FPS},scale=${VIEW.width}:${VIEW.height}:flags=lanczos`;

  // H.264/MP4 only. A VP9 WebM alongside it was ~350 KB smaller, but Chrome
  // preferred it and then died on it with PIPELINE_ERROR_DECODE (ffmpeg
  // decoded the same file fine, and so did headless Chrome — it only showed up
  // in the real browser). A wedged media pipeline makes play() a silent no-op,
  // which is a bad trade for 350 KB. H.264 plays everywhere.
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', path.join(OUT_DIR, 'demo.mp4')]);

  // Poster: a few seconds in, past the title card, on the new-test screen.
  ffmpeg(['-ss', String(6 * SLOWDOWN), '-i', path.join(OUT_DIR, 'demo.mp4'),
    '-frames:v', '1', '-q:v', '3', path.join(OUT_DIR, 'demo-poster.jpg')]);

  for (const f of ['demo.mp4', 'demo-poster.jpg']) {
    const p = path.join(OUT_DIR, f);
    console.log(`  public/demo/${f}  ${(fs.statSync(p).size / 1e6).toFixed(2)} MB`);
  }
}

// Other people's attempts, recorded off-camera so the results page has a real
// spread (successes, a wanderer, one give-up) by the time we show it.
async function backgroundSessions(browser, base, testId) {
  console.log('Running background tester sessions…');
  async function session({ ua, succeed, seq, comment, dwellMs = 1200, wander = false, giveUp = false }) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/t/${testId}`, { waitUntil: 'networkidle0' });
    await page.click('#consent');
    const getFrame = async () => (await page.$('#appframe')).contentFrame();
    let f = await getFrame();
    await f.waitForSelector('button.add[data-item=blue]');
    await sleep(dwellMs);
    if (wander) {
      await f.hover('button.add[data-item=red]');
      await f.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
      await sleep(600);
      await f.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await f.hover('button.add[data-item=green]');
      await sleep(500);
    }
    await f.hover('button.add[data-item=blue]');
    await f.click('button.add[data-item=blue]');
    await sleep(400);
    await f.click('#cart-link');
    await page.waitForFunction(() => {
      const fr = document.getElementById('appframe');
      return fr && fr.contentWindow.location.pathname.endsWith('cart.html');
    });
    f = await getFrame();
    await f.waitForSelector('#checkout');
    await f.type('#promo', 'HOODIE10', { delay: 40 });
    await f.type('#email', 'tester@example.com', { delay: 25 });
    await sleep(900);
    if (giveUp) await page.click('#giveup');
    else if (succeed) await f.click('#checkout');
    await page.waitForSelector('#overlay', { visible: true });
    if (seq) {
      await page.$$eval('.seq-scale button', (btns, s) => btns[s - 1].click(), seq);
      if (comment) await page.type('#seqcomment', comment);
      await page.click('#seqsubmit');
    }
    await sleep(3200);
    await page.close();
  }

  // The comments are load-bearing: beat 9 shows the sentiment rollup and the
  // negative-first sort, so the set needs one of each label. Keep them worded
  // in vocabulary the lexicon actually carries — "dead simple" reads as a
  // strong *negative* to VADER ("dead"), which would demo the feature getting
  // its happiest comment backwards. See server/lib/sentiment.js on the blind spot.
  await session({ ua: 'demo-tester-1', succeed: true, seq: 7, comment: 'Perfect, the cart was obvious and checkout was easy.' });
  await session({ ua: 'demo-tester-2', succeed: true, seq: 6, comment: 'Took me a second to spot the cart link.', wander: true });
  await session({ ua: 'demo-tester-3', succeed: true, seq: 5, comment: 'The cart link is hidden and the whole flow felt awkward.', dwellMs: 2500, wander: true });
  await session({ ua: 'demo-tester-4', giveUp: true, seq: 2, comment: 'Confusing. I hated hunting for the checkout button.', dwellMs: 2000, wander: true });
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

function cleanup() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (!KEEP_FRAMES) fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  else console.log(`Frames kept in ${FRAME_DIR}`);
}

main()
  .then(cleanup)
  .catch((e) => {
    console.error(e);
    cleanup();
    process.exit(1);
  });
