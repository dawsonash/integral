# Integral

Low-ceremony usability testing for developers: **test the slice you just built in
~2 minutes, from a link, without a research team.** This is the v1 implementation
of [docs/design-spec.md](docs/design-spec.md) plus the launch layer from
[docs/go-to-market.md](docs/go-to-market.md): accounts, plans + billing, abuse
hardening, legal, and a single-box deploy recipe.

## Run it

```bash
npm install
npm start            # http://localhost:4000 — "Continue in dev mode" to sign in
npm run seed         # optional: seed a demo test with real recorded sessions
npm test             # API suite + real-browser E2E (needs Google Chrome installed)
npm run demo:video   # re-record the landing page tour (needs Chrome + ffmpeg)
```

`demo:video` drives the real product through the whole loop in a headless
Chrome — against a throwaway data dir, so it never touches your own tests — and
writes `public/demo/demo.mp4` plus a poster frame. Re-run it whenever the
dashboard, setup, take, or results screens change, so the landing page never
shows a UI that no longer exists.

With nothing configured you get dev login, console email, and no billing — the
full product loop works locally. `.env.example` documents every production knob
(GitHub OAuth, Stripe, Resend, data dir, origin split); `deploy/` has the VPS
recipe (Caddy, systemd, Litestream backups).

## The core loop

1. **Ingest** — pull a GitHub repo branch (with a live entry-page preview),
   paste raw HTML, upload a zip, or upload a folder of static files (dashboard
   at `/`), or one-click the bundled sample test. Unbuilt React projects work:
   conventional entry modules (`src/main.jsx` and friends) are offered as start
   pages and mounted via a synthesized wrapper page.
2. **Host** — the artifact is served **same-origin** under `/t/:id/app/*` with an
   rrweb recorder injected into every HTML screen. Same-origin hosting is the
   keystone: it's what makes recording work at all (spec §2). JSX/TS modules are
   transpiled at serve time (esbuild transform — no repo builds run) with bare
   imports rewritten to esm.sh, pinned to the artifact's `package.json` versions.
3. **Set up** (`/tests/:id/setup`) — record success **by demonstration**: drive
   the artifact for real in the live preview and every click / field change
   becomes a step chip (a stable selector is inferred — id → data-testid, on the
   element or a near ancestor → structural path). Prune the incidental steps;
   what's left is the success chain. Then the task prompt, optional SEQ and
   one-question screener, response cap.
4. **Share** — launching produces an open link `/t/:id`. Bring your own testers.
   Free-tier links auto-expire after 14 days.
5. **Test** — anonymous testee (never needs an account): one-tap consent gate →
   task → **auto-detected success** — the chain's final step firing while every
   earlier step is satisfied (value steps re-checked against the live DOM) →
   optional SEQ + comment.
6. **Report** (`/tests/:id/results`) — success rate, per-step chain progress,
   time-on-task distribution, SEQ distribution + comments, drop-off,
   click/move/scroll **attention heatmap** overlaid on the artifact, full
   **session replays**, and CSV/JSON export. Comments and post-test notes carry
   a **lexicon sentiment** badge so the negative ones can be sorted to the top.

## What's captured (spec §4)

- Mouse / touch / click / scroll — full rrweb session replay.
- Keyboard **content masked by default** (`maskAllInputs`); devs can un-mask
  known-safe fields via selector list. Keyboard **behavior** (timing, corrections)
  survives masking because masked values keep their length.
- Task success + time-on-task, auto-derived.
- Zero browser permission prompts, ever.

## Server-rendered apps (fake-backend sandbox)

A repo with no static HTML but a recognizable server framework — Node (Express,
Koa, Fastify, Nest, Next) or Python (Django, Flask, FastAPI, Starlette) —
becomes a **server-rendered test** ([docs/fake-backend-spec.md](docs/fake-backend-spec.md)):
Integral provisions a throwaway Postgres database, runs the repo's own schema
setup against it, seeds fake rows (dev-editable per test in setup), boots the
app as a child process with dummy secrets, auto-authenticates a fake user, and
reverse-proxies it same-origin under `/t/:id/app/*` with the usual recorder
injection — real pages from fake data, never real credentials or a real
database. Needs a local Postgres (`INTEGRAL_SANDBOX_PG_URL`, default
`127.0.0.1:5432`); per spec §9 the prototype is for trusted repos only.

Python repos are classified from `requirements.txt` / `pyproject.toml` /
`Pipfile`, installed into a virtualenv inside the artifact dir
(`INTEGRAL_PYTHON`, default `python3`), and booted with the port interpolated
into the start command — `$PORT` rather than Node's `process.env.PORT`. Django
gets `migrate` + `loaddata` and dummy settings vars for free. There's no
Python equivalent of the express-session cookie forgery, so auto-auth uses the
framework-agnostic `login` strategy: drive the app's own login endpoint once at
boot and reuse its cookie.

## Data quality (spec §5)

- Anonymous, no login; one-line consent gate (linking `/privacy`).
- Response cap auto-closes the test — and emails the owner that results are ready.
- Junk filter: sessions under 3s (`INTEGRAL_MIN_DURATION_MS`) or with zero
  interactions are auto-discarded.
- Fingerprint dedupe (IP+UA hash): one completed response per device per test.
- Results are permanently labeled **"unscreened sample."**

## The launch layer (go-to-market Tier 1)

- **Auth** — GitHub OAuth (dev-mode login locally); signed session cookie, no
  external session store. Only the dev-facing surface is gated; the testee flow
  stays anonymous.
- **Plans + billing** — Free, Individual ($20/mo, $216/yr), and Team ($20/mo +
  $10 per teammate; $216/yr + $108/teammate) via Stripe Checkout + Customer
  Portal. The webhook flips `users.plan` or `teams.plan`. Gates: concurrent live
  tests, responses/month, retention window, artifact size, link TTL
  (`server/lib/plans.js`).
- **Teams** — a shared workspace: members see and manage the same tests,
  results, and replays, and the paid limits are pooled and scale per seat. The
  roster (`server/lib/teams.js`) drives the per-seat quantity on the team's
  Stripe subscription. One team per user; joining moves a member's existing
  tests in, leaving hands them to the owner.
- **Origin split** — set `INTEGRAL_RUN_HOST` and hosted artifacts + the take
  flow live on a separate domain that never sees dashboard cookies, so uploaded
  scripts can't touch the dev surface (artifact and recorder still share an
  origin with each other, which is all recording needs).
- **Abuse hardening** — rate limits on upload / session-create / ingest /
  report, per-plan artifact size caps, free-link expiry, and a testee-facing
  report/takedown channel that emails `INTEGRAL_ABUSE_EMAIL`.
- **Retention sweep** — daily in-process sweep (or `node scripts/sweep.js` from
  cron): enforces plan retention on sessions + event files, expires free links,
  removes orphaned files.
- **Legal** — `/privacy` and `/terms` (served on both origins); account
  deletion wipes the user and everything they own.

## Architecture

```
server/
  app.js            express app (exported for tests), origin split, index.js boots it
  db.js             better-sqlite3 schema (users, tests, sessions, interactions, reports)
  lib/artifacts.js  zip/html/folder ingestion + same-origin serving w/ script injection
  lib/transpile.js  serve-time esbuild transform + import rewriting (no-build React hosting)
  lib/sandbox/      fake backend for server-rendered repos (docs/fake-backend-spec.md):
                    classify, ephemeral Postgres + fake seed, auto-auth, outbound
                    stubs, boot runner + registry, same-origin reverse proxy
  lib/auth.js       GitHub OAuth + sealed session cookie + dev login
  lib/plans.js      plan limits (free / pro / unlimited)
  lib/signals.js    success-signal chains (+ legacy single-target synthesis)
  lib/sentiment.js  VADER lexicon polarity for SEQ comments / notes (no model)
  lib/retention.js  daily sweep: retention windows, link expiry, orphan cleanup
  lib/purge.js      test/session/account deletion
  lib/ratelimit.js  express-rate-limit instances for the abuse surfaces
  lib/email.js      Resend transactional email (console fallback)
  routes/api.js     dev-facing API (tests CRUD, results, export, replay events, heatmap)
  routes/take.js    testee-facing flow (config, sessions, ingest, abuse reports)
  routes/auth.js    login/logout/OAuth callback, account deletion
  routes/billing.js Stripe Checkout, Portal, webhook
public/
  inject/recorder.js  injected into artifact screens (taker mode): rrweb record,
                      interaction stream, chain detection — talks to shell via postMessage
  inject/picker.js    injected in preview mode: record-by-demonstration + selector inference
  take.html/js        testee shell (consent → screener → task → SEQ → thanks; report link)
  setup.html/js       demonstration-based test setup with live preview
  results.html/js     dashboard + heatmap + thin replay UI over rrweb.Replayer
  privacy.html, terms.html
deploy/               Caddyfile, systemd unit, Litestream config, backup script
scripts/              seed-demo.js, seed-deskdrop.js, sweep.js
data/                 sqlite db, extracted artifacts, rrweb event logs (gitignored)
fixtures/             demo-shop/ (multi-screen) + desk-booking.html (chained signals)
```

Implementation notes on the spec's open questions (§10): recorder is **rrweb 2.x**
(the `rrweb-player` package's dist is broken in 2.1.0 — the replay UI is a thin
custom wrapper over `rrweb.Replayer` from the same bundle we record with, which
also guarantees event-schema match). Screens in a bundle are identified by
artifact-relative path; multi-page navigation produces one full rrweb snapshot per
screen in a single stream.

Still out of scope, per spec §7 and the go-to-market Tier 3 list: GitHub/Figma
ingestion, paid panel, AI synthesis, team seats, eye-tracking, think-aloud audio.
