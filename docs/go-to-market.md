# Go-to-Market Additions — Integral

> Status: Draft v0.1 (2026-07-06). Companion to [design-spec.md](design-spec.md).
> The spec defines *what the product is*; this document defines *what must be added*
> to turn the working v1 (an Express + SQLite app on `localhost:4000`) into something
> a solo, bootstrapped developer can charge money for.

---

## 0. Framing

Two constraints shape everything below, and both mirror the spec's own design filter
("would a developer bother, or just ship it?" — spec §1):

1. **The buyer is an indie/solo developer.** Pricing, onboarding, and feature depth
   must stay indie-shaped (spec §8: ~$19–39/mo). No enterprise checkboxes.
2. **The builder is one person with no funding.** Every addition below is chosen for
   the *lean* implementation: boring tech, managed services only where they replace a
   full-time job (payments, email deliverability), and infrastructure that fits the
   existing single-process better-sqlite3 architecture instead of fighting it.

**Solo-builder design filter:** *"Does this need to exist before a stranger can pay me,
and is there a version of it I can run alone?"* Everything that fails the first clause
goes to Tier 2/3; everything that fails the second gets a managed service or gets cut.

What already works and is **not** revisited here: the entire core loop (ingest →
same-origin hosting → visual setup → open link → auto success detection → results
dashboard with heatmap + replays), junk filtering, fingerprint dedupe, input masking,
and the consent gate. The v1 is feature-complete against spec §3–§6. The gap is
everything *around* the product: identity, money, hosting, safety, and trust.

---

## Tier 1 — Launch blockers

You cannot charge money without these. Each item names the concrete gap in the current
code, the market reason, and the lean implementation.

### 1.1 Accounts & auth

- **Current gap:** there is no concept of a user anywhere. `server/routes/api.js` —
  test CRUD, results, replay events, artifact upload — is fully open. Anyone who can
  reach the server owns every test. `server/db.js` has no `users` table and `tests`
  has no owner column.
- **Why it's required:** billing needs an identity to bill; multi-tenant hosting needs
  ownership to isolate dashboards; "your data" is meaningless without "you."
- **Lean version:**
  - **GitHub OAuth as the only login method** at launch. The buyer is a developer
    (spec §1); every one of them has a GitHub account. One provider = no password
    storage, no reset flows, no email-verification loop. Email magic links can come
    later *after* transactional email exists (Tier 2).
  - Schema: a `users` table + `tests.user_id`, following the existing
    `ensureColumn()` migration pattern in `server/db.js:75`.
  - Session: signed cookie (e.g. `iron-session`-style sealed cookie or a plain
    `express-session` + SQLite store) — no Redis, no JWT infrastructure.
  - **Gate only the dev-facing surface** (`routes/api.js`, `/tests/:id/setup`,
    `/tests/:id/results`, the dashboard). The testee-facing surface (`routes/take.js`,
    `/t/:id`, `/t/:id/app/*`) **must stay anonymous** — spec §5 is explicit that an
    account requirement would gut completion. The route split in `server/app.js`
    already separates these cleanly.

### 1.2 Billing

- **Current gap:** none of it exists, by design (README: "accounts + billing … out of
  scope in this pass").
- **Why it's required:** it's the definition of "to market."
- **Lean version:**
  - **Stripe Checkout + Stripe Customer Portal.** Zero custom billing UI: Checkout
    handles cards/tax/receipts, the Portal handles upgrades, cancellations, and card
    updates. The only code you write is one webhook handler that flips a
    `users.plan` column.
  - **One paid plan.** Free + one $29/mo tier (midpoint of spec §8's $19–39 band).
    A single price point is easier to reason about, easier to A/B later, and avoids
    building plan-comparison UI.
  - **Gate on the axes the spec already chose** (§8: volume + retention + seats —
    seats deferred): free = e.g. 1 active test, 25 responses/mo, 14-day retention;
    paid = e.g. 10 active tests, 500 responses/mo, 1-year retention. The enforcement
    points already exist in code: `response_cap` in `tests`, test `status`, and the
    session-ingest path in `routes/take.js`.
  - Free tier stays generous enough to reach the "aha" (run one real test, watch one
    real replay) — spec §8's conversion logic.

### 1.3 Production deployment

- **Current gap:** `npm start` on localhost. No TLS, no domain, no process
  supervision, no backups. Data is a WAL-mode SQLite file plus loose directories
  (`data/artifacts/`, `data/events/`) on local disk.
- **Why it's required:** the product *is* a hosted link (spec §2 — "you are the
  runtime"). No deployment, no product.
- **Lean version:**
  - **One VPS** (Hetzner/DO, ~$6–12/mo). The single-process + local-disk architecture
    is a *feature* for a solo operator — do not prematurely move to Postgres or S3.
    better-sqlite3 comfortably serves this workload for thousands of users.
  - **Caddy** as reverse proxy: automatic TLS, two lines of config. systemd unit for
    the Node process.
  - **Backups: Litestream** replicating the SQLite WAL to any S3-compatible bucket
    (~$1/mo), plus a nightly `tar` of `data/artifacts/` and `data/events/` to the
    same bucket. `INTEGRAL_DATA_DIR` (`server/db.js:5`) already externalizes the data
    location, so the deploy needs no code changes.
  - **Two domains or a strict subdomain split**, e.g. `app.integral.dev` (dashboard)
    and `run.integral.dev` (hosted artifacts + take flow). See 1.4 — this is a
    security boundary, not cosmetics.

### 1.4 Abuse & safety hardening

This is the most easily-forgotten blocker, and for this product it is existential:
**same-origin hosting of arbitrary uploaded HTML (spec §2) means you are a free
anonymous web host.** Phishers will find that before customers do.

- **Current gaps in code:**
  - `express.json({ limit: '50mb' })` in `server/app.js:8` is the *only* size guard
    anywhere; upload and event-ingest endpoints have no rate limiting.
  - Artifacts execute their own scripts same-origin with the dashboard (single
    origin today) — an uploaded artifact could script against dev-facing pages.
  - No takedown/report mechanism, no retention enforcement (event `.jsonl` files and
    sessions accumulate forever).
- **Lean version:**
  - **Origin split** (see 1.3): serve `/t/:id/app/*` from a separate domain so
    hosted artifacts can never touch dashboard cookies. This preserves the keystone —
    the artifact and the recorder still share *an* origin with each other, which is
    all spec §2 requires — while removing the scariest attack path. Cheapest
    possible fix: one extra DNS record and a host check in `server/app.js`.
  - **Rate limiting**: `express-rate-limit` (in-memory is fine on one process) on
    upload, session-create, and event-ingest routes. Per-plan caps on artifact size
    (e.g. 10 MB free / 50 MB paid) and artifact count, enforced in
    `server/lib/artifacts.js` at ingest.
  - **Abuse friction**: tests are only reachable while `status = 'live'` and under
    their `response_cap` (both already enforced); add auto-expiry for free-tier tests
    (e.g. links die after 14 days) — doubles as the retention lever in 1.2.
  - **Report/takedown**: a `/report/:id` link in the testee footer that flags a test
    and emails you. Manual review is fine at this scale; the point is having *a*
    channel, which payment processors and registrars expect.
  - **Retention job**: a daily sweep (plain `setInterval` or cron hitting a script —
    no queue infra) deleting sessions, `data/events/*.jsonl`, and orphaned artifacts
    past the plan's retention window.

### 1.5 Legal minimum

- **Current gap:** the one-line consent gate exists in the take flow, but nothing
  backs it: no privacy policy, no terms, no data-deletion path.
- **Why it's required:** the product records people. Stripe onboarding, GDPR, and
  basic buyer trust all require the paperwork. Testers are EU residents whether you
  market there or not.
- **Lean version:**
  - Privacy policy + ToS from a generator/template, reviewed once; link the privacy
    policy *from the consent gate itself* (a one-word change to the gate copy).
  - **Data deletion = account deletion**: one endpoint that removes a user's tests,
    sessions, event files, and artifacts. Ship export as "email support and I run a
    script" until someone asks twice.
  - An honest sub-processor list (VPS provider, backup bucket, Stripe, email
    provider) on one page.
  - The spec's privacy posture (§4: masked inputs by default, zero permission
    prompts, behavioral-timing-not-content) is a genuine *selling point* — put it on
    the marketing page, not just in legal copy.

---

## Tier 2 — Credibility & conversion

Not blockers to charging money, but blockers to strangers *choosing* to pay. Ship in
roughly this order after launch.

| Addition | Why | Lean version |
|---|---|---|
| **Landing page with a live demo** | The product demos itself in 2 minutes — that's the wedge (spec §1). Show, don't claim. | Static page; "try a live test" links to a real seeded test, and "see real results" to its dashboard in read-only mode. `scripts/seed-demo.js` + `fixtures/demo-shop/` already build exactly this test with real recorded sessions. |
| **First-run onboarding** | Time-to-aha is the conversion event. The dashboard's empty state must produce a first test in under 2 minutes. | "Use the sample artifact" one-click path (reuse `fixtures/demo-shop/`), then a 3-step checklist: upload → pick target → copy link. No tours, no modals. |
| **Transactional email** | Magic-link login (widens auth beyond GitHub) and the single highest-value notification this product has: **"your test hit its response cap — results are ready."** The cap (`tests.response_cap`) already auto-closes tests; today nobody finds out. | One provider (Resend/Postmark, free tier covers launch volume). Two templates. No marketing-email infrastructure. |
| **Product analytics + error tracking** | You're selling analytics; fly instrumented. Know where signups stall in your own funnel (upload → launch → first response → paid). | PostHog (already in the toolchain): dashboard-side funnel events + error tracking. **Never inside hosted artifacts or the take flow** — don't add third-party scripts to the surface you promised was clean. |
| **Results export (CSV/JSON)** | Devs distrust dashboards they can't get data out of; cheap trust win and a paid-tier perk. | One endpoint serializing what `routes/api.js` results queries already compute. |
| **Link niceties** | Open links (spec §12) go into Slack/Discord/X; they should look and behave right. | OG meta tags on `/t/:id`, optional link expiry, optional passcode on paid tier. Custom domains are a v2 upsell, not now. |

---

## Tier 3 — Retention & expansion

Post-launch, revenue-expanding. Mostly this re-affirms the spec §7 deferral list with
sequencing; the new information is what live operation will teach you first.

1. **Selector stability across re-uploads** (spec §10 open question). The first
   *retention* feature: the whole point is test → fix → re-test, and today a re-upload
   is a new test with a possibly-broken `success_selector`. "Re-upload artifact, keep
   task + target, compare runs side-by-side" turns Integral from a one-shot tool into
   an iteration loop — and iteration loops are what justify a subscription. Likely
   the highest-leverage post-launch feature and it's pure product work, no new infra.
2. **Figma prototype player** — the spec already marks it fast-follow (§7). Doubles
   the addressable audience (designers adjacent to the dev buyer). Real, scoped work:
   custom same-origin player over Figma's REST API.
3. **AI friction synthesis** — the v2 hero feature (§7), gated on data volume and
   shipped with the honest "directional only, n=3" framing (§9). A cheap precursor
   that's shippable early: a non-AI "friction digest" (rage-click counts, backtrack
   loops, longest-hesitation moments) computed from the `interactions` table that
   already stores everything needed.
4. **Team seats** — the third pricing axis from §8. Wait for the pull ("can I share
   this dashboard with my cofounder?"); it's a solo tool until customers say
   otherwise.
5. **Paid tester panel** — last, exactly as §7 warns: it's a second company. Consider
   a broker/partner integration (e.g. hand off to an existing panel provider) before
   building a marketplace.

---

## Sequencing & cost

Suggested order within Tier 1 — each step is independently shippable:

| Step | Item | Effort | Running cost |
|---|---|---|---|
| 1 | Deploy: VPS + Caddy + systemd + Litestream + origin split (1.3, part of 1.4) | S–M | ~$10–15/mo |
| 2 | Auth: GitHub OAuth + `users` + ownership (1.1) | M | $0 |
| 3 | Hardening: rate limits, size caps, retention sweep, report link (1.4) | M | $0 |
| 4 | Legal pages + deletion endpoint (1.5) | S | $0 |
| 5 | Billing: Stripe Checkout + Portal + webhook + plan gates (1.2) | M | % of revenue |
| 6 | Landing page + live demo + onboarding + email + analytics (Tier 2 core) | M | ~$0–10/mo |

Total standing cost before revenue: **roughly $15–25/month.** Total new code: small —
the deliberate pattern is that every Tier-1 item leans on something that already
exists (`INTEGRAL_DATA_DIR`, `response_cap`, test `status`, the dev/testee route
split, the seed + fixture demo assets).

### Explicitly not doing (protecting the wedge)

- **No Postgres/S3/queue migration** — the single-box architecture is the lean moat;
  revisit only when backups or write volume actually hurt.
- **No teams/SSO/roles at launch** — fights the individual-developer buyer (spec §1).
- **No free-forever positioning** — spec §8 already rejected it; the free tier is a
  funnel, not the product.
- **No third-party scripts in the take flow** — testee-side cleanliness (zero
  prompts, zero trackers) is part of the product's promise.
- **No GitHub-repo ingestion** — still the Vercel+MSW tarpit (§7), and it violates
  the "reducible to same-origin static content" rule (§9.3).

---

## Appendix — Decision log (go-to-market trunk)

| # | Branch | Decision |
|---|---|---|
| 1 | Auth method | GitHub OAuth only at launch; magic links after email exists |
| 2 | Billing | Stripe Checkout + Portal; one paid tier (~$29/mo); gate on active tests / responses / retention |
| 3 | Hosting | Single VPS + Caddy + systemd; keep SQLite + local disk; Litestream backups |
| 4 | Artifact-hosting safety | Separate origin for hosted artifacts; rate limits + size caps; report/takedown link; retention sweep |
| 5 | Legal | Template privacy policy + ToS; deletion = account deletion; consent gate links policy |
| 6 | Launch marketing | Static landing page powered by the seeded demo test |
| 7 | First retention feature | Re-upload with kept target + run comparison (selector stability, spec §10) |
| 8 | Panel | Deferred hardest; explore brokering before building |
