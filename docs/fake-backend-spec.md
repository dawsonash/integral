# Spec — Fake Backend (Live Sandbox) for server-rendered apps

> Status: Draft v0.1 for implementation handoff.
> Audience: implementer (Fable). Prereq reading: `docs/design-spec.md` (§2 keystone, §7 deferred),
> `README.md` (core loop + architecture map).

---

## 1. Problem & goal

Integral today hosts **self-contained static frontends** served same-origin (`serveArtifactFile` in
`server/lib/artifacts.js`) with an injected rrweb recorder. That covers static sites and
client-rendered React (no-build serve-time transpile in `server/lib/transpile.js`).

It does **not** cover **server-rendered apps** (Express/Handlebars, Rails, Django, Next SSR…), where
the UI only exists after the dev's server runs a route, queries a database, and renders a template.
Reference app: `dawsonash/Function_Finder` — Express + `express-handlebars`, boots a Postgres
connection at `src/index.js:198`, and every page is built from SQL (`db.oneOrNone('SELECT … FROM
events …')`). Pulling the repo yields no static HTML, so Integral finds no start page; a naive wrapper
that loads the server entry in the browser renders blank.

**Goal:** let a developer connect a server-rendered repo and get a testable UI **without handing over
real secrets or a real database**. Integral boots the app against a **disposable fake backend**
(ephemeral DB seeded with fake data, stubbed external services, auto-authenticated session), then
**reverse-proxies the running app same-origin** and injects the existing recorder. The developer edits
the **fake seed / stub responses per test**, never real credentials.

### Non-goals (v1 of this feature)
- Hardened multi-tenant sandbox security. **Per an explicit product decision, the prototype runs
  trusted/local; production isolation is designed later** (see §9).
- Proxying the dev's *live deployed* app (spec §2 rejects this — we boot our own instance).
- Perfect fidelity for apps with no reproducible schema/seed setup (see §8 floor).
- Replacing the static pipeline. This is an **additional test type**, selected per test.

---

## 2. Core idea (what "fake" means, and at which layer)

Placeholders (Lorem Ipsum) at the **rendered-field** layer do not work: the database determines page
*existence and structure* (which rows exist, whether the route 200s, whether you're logged in), not
just field text. So the fake substitution happens at the **data + service + auth layer**:

| Real dependency | Replaced with |
|---|---|
| Dev's Postgres/MySQL | **Ephemeral throwaway DB** Integral provisions; app's own schema setup run against it |
| Real table data | **Fake seed rows** (faker-generated, or the dev's own seed script) — *this is where "Lorem Ipsum" lives* |
| Auth / login / session | **Injected pre-authenticated session** (fake user) so gated pages render |
| Stripe / email / 3rd-party HTTP | **Stubbed responses** (canned success), outbound network denied by default |
| `.env` secrets | **Dummy values**; only non-secret, boot-required config is real |

The app boots and renders **real pages from fake data**. Interactive flows work because writes hit the
disposable DB.

---

## 3. Test lifecycle (request flow)

```
Create test (server-rendered type)
  └─ pullRepo (reuse server/lib/github.js) → data/artifacts/<testId>/
  └─ classify(repo) → { kind: 'server', framework, startCmd, port, dbKind, schemaCmd }
  └─ persist backendConfig on the tests row (see §5)

Launch / preview / first take
  └─ Sandbox.ensure(testId):
        1. provision ephemeral DB (throwaway Postgres)
        2. run schemaCmd (e.g. scripts/setup-test-db.sh) against it
        3. run seed (faker or dev seed script) → fake rows
        4. boot app child process with injected env (dummy secrets + DB pointing at ephemeral) → :PORT
        5. health-check until the app answers
     returns { upstreamOrigin: 'http://127.0.0.1:PORT' }

Serve testee
  └─ GET /t/:testId/app/*  ── reverse-proxy ──▶ upstreamOrigin
        - inject fake-session cookie/header on the way in
        - stub outbound 3rd-party calls
        - inject <script src="/__integral/recorder.js"> into HTML responses on the way out
        - rewrite absolute URLs / redirects to stay under /t/:id/app/
  └─ recorder + take.js flow UNCHANGED (same-origin, postMessage, success chain, heatmap)

Teardown
  └─ on cap/idle/retention: kill child process, drop ephemeral DB
```

Everything **downstream of the iframe** (`public/take.html`, `public/take.js`,
`public/inject/recorder.js`, results/heatmap/replay) is reused **unchanged** — this feature only
changes how bytes get *into* `/t/:id/app/*`: proxied-from-a-live-app instead of read-from-disk.

---

## 4. New module layout

```
server/lib/sandbox/
  classify.js     detect kind (static|spa|server), framework, start cmd, port, db kind, schema/seed cmd
  runner.js       lifecycle: provision DB, run schema+seed, boot app child proc, health-check, teardown
  db.js           ephemeral DB provisioning (Postgres first) + connection env it hands the app
  seed.js         faker-based seeding; or shell out to the dev's declared seed command
  auth.js         fake-session injection strategy (cookie/header presets per framework)
  stubs.js        outbound HTTP interception → canned responses (Stripe/email/etc.)
  proxy.js        same-origin reverse proxy + HTML recorder injection + URL/redirect rewriting
  registry.js     testId → running sandbox handle; idle timers; caps
server/routes/take.js   add proxy branch for server-type tests (alongside serveArtifactFile branch)
server/routes/api.js    classify on create; expose backendConfig read/patch endpoints
```

Reuse, don't reinvent:
- Repo pull: `server/lib/github.js` `pullRepo`.
- HTML injection convention: mirror `serveArtifactFile`'s `</body>` insertion of the recorder tag and
  its root-absolute URL rebasing (`artifacts.js:414`). Factor the injection helper out so both the
  static path and the proxy path share it.
- Recorder tag + mock head-script: same `/__integral/*` static mounts (`server/app.js`).
- Origin split (`INTEGRAL_RUN_HOST`, `server/app.js:16–34`) still applies — proxied app is untrusted
  content and must live on the cookieless run host.

---

## 5. Per-test config (persisted)

Add a nullable JSON column `backend_config` to the `tests` table (`server/db.js`). Shape:

```jsonc
{
  "kind": "server",                     // static | spa | server  (server ⇒ use sandbox)
  "framework": "express",               // detected; informational + picks auth/stub presets
  "start": { "cmd": "node src/index.js", "port": 3000, "readyPath": "/", "readyTimeoutMs": 30000 },
  "db": {
    "kind": "postgres",
    "schemaCmd": "bash scripts/setup-test-db.sh",   // run once per sandbox against ephemeral DB
    "envMap": {                                       // which env vars the app reads for DB coords
      "POSTGRES_HOST": "$HOST", "POSTGRES_DB": "$DB",
      "POSTGRES_USER": "$USER", "POSTGRES_PASSWORD": "$PASSWORD", "POSTGRES_PORT": "$PORT"
    }
  },
  "seed": {
    "mode": "faker",                    // faker | command | none
    "command": "node scripts/seed.js",  // when mode=command
    "tables": {                         // when mode=faker — dev-editable per test ("the Lorem Ipsum")
      "user_data": { "rows": 5, "columns": { "username": "faker.internet.userName", "…": "…" } },
      "events":    { "rows": 12, "columns": { "title": "faker.lorem.words", "…": "…" } }
    }
  },
  "auth": {
    "mode": "session-cookie",           // session-cookie | header | none
    "as": { "userId": "$SEED.user_data[0].user_id" },   // which fake user to be
    "cookie": { "name": "connect.sid", "strategy": "express-session" }
  },
  "env": { "STRIPE_SECRET_KEY": "sk_test_dummy", "SESSION_SECRET": "dummy", "…": "…" },
  "stubs": [
    { "match": "api.stripe.com/**",  "status": 200, "body": "{ \"id\": \"pi_dummy\" }" },
    { "match": "api.resend.com/**",  "status": 200, "body": "{ \"id\": \"email_dummy\" }" }
  ]
}
```

Notes:
- `seed.tables` is the developer-editable surface that realizes the original "fake filler, per test"
  idea — but as **seed rows**, not rendered placeholders. Editable in setup UI (fast-follow; v1 can
  accept raw JSON).
- `$HOST/$DB/…` and `$SEED.…` are resolved by `runner.js` at boot from the freshly provisioned DB and
  the seeded rows.

---

## 6. The same-origin reverse proxy (`proxy.js`)

Requirements:
1. Mount at `/t/:testId/app/{*path}` for `kind:'server'` tests (branch in `server/routes/take.js`).
2. Forward method, path, query, headers, body to `upstreamOrigin`. Strip hop-by-hop headers.
3. **Inbound:** attach the fake-session cookie/header from `auth`. Force `X-Forwarded-*` sane.
4. **Outbound HTML** (`content-type: text/html`): inject the recorder `<script>` before `</body>`
   (reuse the shared injector) and the mock head-script if any; **strip `Content-Security-Policy` and
   `X-Frame-Options`** so the frame loads and inline injection runs; drop `Content-Length` or recompute
   after mutation.
5. **Redirects & absolute URLs:** rewrite `Location:` and same-host absolute links back under
   `/t/:id/app/` so navigation stays same-origin (the recorder re-injects on each screen, exactly like
   the multi-page static case).
6. Stream non-HTML responses (assets) through untouched.
7. Timeouts + friendly error page when upstream is down/booting (mirror the boot-error overlay UX in
   `artifacts.js` `BOOT_ERROR_SCRIPT`).

Implementation: `http-proxy` / `http-proxy-middleware` with an `onProxyRes` body rewrite, **or** a
hand-rolled `fetch`-based proxy (more control over HTML mutation). Recommend `http-proxy-middleware`
with a response interceptor.

---

## 7. State isolation between testers

A single running instance + one DB means testers collide (one deletes an event another sees). Options,
cheapest first:

- **v1 (accept shared state):** one sandbox per test, shared DB, re-seed on response-cap reset. Simple;
  acceptable for read-heavy flows; document the caveat.
- **v1.5 (reset per session):** wrap each session in a DB transaction rolled back on session end, or
  `TRUNCATE + reseed` between sessions (serialize sessions). Cheap-ish, no per-user fork.
- **v2 (fork per session):** template DB + `CREATE DATABASE … TEMPLATE` (Postgres) per session; true
  isolation, higher cost.

Ship **v1** first; leave hooks (`Sandbox.resetForSession(testId, sessionId)`) for v1.5/v2.

---

## 8. The irreducible floor (be honest with the developer)

The app **must boot against a fresh DB**, which means:
- A reproducible **schema setup** must exist and be runnable headless. Function_Finder qualifies
  (`scripts/setup-test-db.sh` + `.env.test`). Apps with no migration/seed path can't be fully
  auto-provisioned — detect this and fall back to the static-snapshot path with a clear message.
- Faker seeding must satisfy **NOT NULL / FK constraints**. v1 `faker` mode is best-effort; when it
  can't satisfy the schema, prompt the dev to use `seed.mode:"command"` with their own script.

Framing in UI: connecting shrinks required input from *"your real DB + all secrets"* to at most
*"confirm the detected start command / point us at your seed command."*

---

## 9. Security posture

**Prototype (this build): trusted/local only.** Boot the app as a **child process on the host** and use
a **local ephemeral Postgres** (reuse the repo's `docker-compose.yaml` service, or a throwaway DB on a
local instance). Deny outbound network except stubbed hosts. Do **not** expose this to untrusted repos
in production.

**Production (design later, out of scope here):** per-test isolated container (gVisor/Firecracker/
Docker) with no host FS access, egress firewall, CPU/mem/pids/time caps, ephemeral lifecycle. Untrusted
code execution is the central risk; the current static pipeline deliberately never runs artifact code,
and this feature crosses that line — gate it behind the sandbox before any public exposure.

---

## 10. Milestones

- **M1 — Boot & proxy one app (walking skeleton).** Manual `backend_config` for Function_Finder;
  `runner.js` provisions DB + runs `setup-test-db.sh` + boots child proc; `proxy.js` serves it under
  `/t/:id/app/*` with recorder injection; drive a session and see a replay + heatmap on the results
  page. Proves the recorder layer drops in unchanged.
- **M2 — Fake seed + auto-auth.** `seed.js` faker mode; `auth.js` injects an express-session cookie so
  gated pages render; dev edits `seed.tables` as JSON.
- **M3 — Classification + create flow.** `classify.js` detects `kind:'server'` on repo connect;
  `api.js` persists config; setup UI shows detected start/seed and a "server-rendered" test type.
- **M4 — Stubs + isolation + teardown.** `stubs.js` for Stripe/email; §7 v1 reset-on-cap; idle
  teardown + retention integration (`server/lib/retention.js`).
- **M5 — Hardening design.** Write the production sandbox spec (§9); not built here.

---

## 11. Decisions to confirm before M1
1. **Runtime for prototype:** host child process + local Postgres (recommended, matches "prototype/
   trusted") vs Docker-per-test now. → recommend host child process.
2. **DB provisioning:** reuse repo's `docker-compose.yaml` Postgres vs Integral-managed local instance
   with per-test database names. → recommend per-test DB names on one local instance.
3. **Seed default:** faker vs require dev seed command. → recommend faker with command fallback.
4. **Proxy lib:** `http-proxy-middleware` + response interceptor vs hand-rolled fetch proxy.

---

## 12. Implementation notes (as built, 2026-07-07)

M1–M4 are implemented (`server/lib/sandbox/`); M5 remains a design task. Deviations
and additions vs. the draft above, discovered against the reference app:

- **Proxy:** hand-rolled `fetch`-based proxy (§6's alternative), not
  `http-proxy-middleware` — full control over HTML mutation and redirect rewriting
  with zero new deps. The injection helper is shared with the static path
  (`injectIntoHtml` in `lib/artifacts.js`).
- **Dependency install:** a pulled repo has no `node_modules`, so the runner runs
  `npm ci`/`npm install` once per pull before the schema step (skippable via
  `install: false`, overridable via `install.cmd`). npm runs *without* the stub-proxy
  env; the app itself runs with it.
- **`db.schemaSql`:** alternative to `schemaCmd` — a repo-relative SQL file applied
  through the pg driver. Needed for Function_Finder, whose `setup-test-db.sh`
  requires a `.env` file that pulled repos don't ship.
- **Auth strategies:** `session-cookie` has two strategies. `express-session`
  (forge a signed cookie + seed the `session` table) only works with a Postgres
  session store; apps on the default MemoryStore (Function_Finder) use the added
  `login` strategy — drive the app's own login/register endpoint once at boot with
  $SEED-resolvable credentials and reuse the returned cookie. The proxy makes the
  fake session win over any anonymous cookie the browser holds.
- **Port pinning:** `start.port` is only set when the app hardcodes `listen(3000)`;
  apps that read `process.env.PORT` get a free port per boot.
- **`env` overrides:** the runner defaults the child to `NODE_ENV=development`
  (production presets break http://127.0.0.1 sandboxes), but `config.env` wins —
  Function_Finder needs `NODE_ENV=production` to skip its dev-only `insert.sql`
  seed (the fake seed replaces it).
- **Stub limits (honest):** interception is via proxy env vars + a CONNECT MITM
  with a locally generated self-signed cert; clients that build their own agents
  (stripe-node) bypass it. Real egress denial is the production container's job.
- **Classification default:** static HTML anywhere in the repo wins (static pipeline);
  `kind:'server'` is only auto-assigned when there is no static entry. The dev can
  flip it via `PATCH /api/tests/:id/backend-config`.

## 13. Verification

Reference app: `dawsonash/Function_Finder` (Express/Handlebars, Postgres).
- **M1 acceptance:** with a hand-written `backend_config`, `npm start` Integral, create/launch a
  server-type test, open the take link, complete a nav flow; confirm a session replay + heatmap appear
  on `/tests/:id/results`. No real secrets used; app talks only to the ephemeral DB.
- **M2 acceptance:** a gated page (e.g. `/home` / `/user`) renders as the fake user; editing
  `seed.tables.events` changes what the search/list page shows.
- **Regression:** existing static/SPA tests (demo-shop fixture, `npm run seed`, `npm test`) still pass
  unchanged — the proxy branch must not touch the `serveArtifactFile` path.
- Add a server-type fixture/E2E once M3 lands (there is currently no server-rendered fixture in
  `fixtures/`).
