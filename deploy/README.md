# Deploying Integral

One VPS, one Node process, SQLite on local disk. Total standing cost ≈ $10–15/mo.
This is the deliberate architecture (see docs/go-to-market.md §1.3): don't move to
Postgres/S3 until backups or write volume actually hurt.

## One-time setup (Ubuntu/Debian VPS)

The app lives in `/opt/integral/app`, one level below the service user's home. Don't
clone straight into `/opt/integral`: `useradd -d` makes that the home directory, and
`.ssh/` (deploy key) has no business sitting inside a git working tree.

```bash
# 1. Node LTS + a system user + the app
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs git
sudo useradd -r -m -d /opt/integral integral
sudo -u integral git clone <your-repo> /opt/integral/app
cd /opt/integral/app && sudo -u integral npm ci --omit=dev

# 2. Config
sudo -u integral cp .env.example /opt/integral/app/.env   # then fill it in
# Required for production: INTEGRAL_APP_URL, INTEGRAL_RUN_HOST, INTEGRAL_BIND_HOST,
# GITHUB_CLIENT_ID/SECRET, STRIPE_* (when charging), RESEND_API_KEY.
# GitHub OAuth is not optional: NODE_ENV=production disables dev login
# (server/lib/auth.js), so without it nobody can sign in at all.

# 3. Process supervision. The unit ships with /opt/integral paths; rewrite them
#    for the app subdir — this fixes WorkingDirectory, EnvironmentFile and
#    ReadWritePaths in one pass.
sed 's|/opt/integral|/opt/integral/app|g' deploy/integral.service \
  | sudo tee /etc/systemd/system/integral.service >/dev/null
# ReadWritePaths is bind-mounted at unit start, so the data dir must already
# exist — otherwise systemd fails with status=226/NAMESPACE and the process
# never runs far enough for server/db.js to create it.
sudo install -d -o integral -g integral -m 0751 /opt/integral/app/data
sudo systemctl daemon-reload && sudo systemctl enable --now integral
curl -sI http://127.0.0.1:4000/    # expect a status line before touching Caddy

# 4. TLS + reverse proxy (two DNS records → this box: app. and run.)
#    Caddy is not in the default Ubuntu/Debian repos.
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit domains + upstream first
sudo systemctl reload caddy && journalctl -u caddy -f   # watch certs issue

# 5. Backups
#    - SQLite: litestream (deploy/litestream.yml → /etc/litestream.yml)
#    - artifacts + event logs: nightly cron of deploy/backup-files.sh
```

**Set `INTEGRAL_BIND_HOST` even with the sandbox off** — use `127.0.0.1`, and match the
`reverse_proxy` upstream in the Caddyfile (which ships as `127.0.0.2` for the sandbox
case). Unset is the one genuinely unsafe value: Node then listens on every interface, so
port 4000 is reachable publicly, bypassing TLS, and `INTEGRAL_TRUST_PROXY=1` lets anyone
hitting it directly forge `X-Forwarded-For` past the rate limiter.

**Before Caddy runs, point DNS at the box** — `app.` and `run.`, A and/or AAAA — and open
inbound 80 **and** 443. Port 80 is not optional; ACME validation uses it. If you publish
AAAA records, verify the address is really the server's (`ip -6 addr show scope global`):
Let's Encrypt prefers IPv6 when it exists, so a wrong AAAA fails issuance on both names
while IPv4 looks perfectly healthy, and the error does not mention IPv6.

## Locking down secrets (do this regardless)

`.env` and everything under `data/` land at 0644 — world-readable — and hold the live
Stripe key, the OAuth secret, the session signing secret, and every user row:

```bash
sudo chmod 0600 /opt/integral/app/.env
sudo chmod 0751 /opt/integral/app/data    # traversable, not listable
```

Chmod'ing `integral.db` alone is not enough. SQLite writes `-wal` and `-shm` alongside it
holding the same rows, and recreates both on every connection — so the fix has to be the
process umask, not a one-off chmod. Add to the `[Service]` block of the unit:

```ini
UMask=0027
```

That covers the WAL pair and the `artifacts/` + `events/` dirs (uploaded HTML and session
recordings) as they are created. Files already on disk need a one-time pass:

```bash
sudo chmod 0640 /opt/integral/app/data/integral.db*
sudo chmod 0750 /opt/integral/app/data/artifacts /opt/integral/app/data/events
```

Note `data/` is traversable (`0751`), so world-readable files in it stay reachable by
anyone who knows the filename — being unlistable is not the protection it looks like.

## Server-rendered tests (the fake-backend sandbox)

Skip this section unless you are enabling `INTEGRAL_SANDBOX_ALLOW`. Booting a
sandbox executes a connected repo's own commands on this box, so it runs behind a
separate uid and a systemd scope. `server/lib/sandbox/confine.js` **refuses to
boot in production** until the setup below is in place — it would otherwise be
running that code as the `integral` user, which can read the secrets you just
locked down.

```bash
# 1. The unprivileged uid the sandbox runs as.
sudo useradd -r -M -s /usr/sbin/nologin integral-sbx
# `integral` joins the group so it can still delete files the sandbox wrote.
sudo usermod -aG integral-sbx integral

# 2. The confinement wrapper — root-owned, so the caller cannot weaken it.
sudo install -o root -g root -m 0755 deploy/integral-sandbox-run /usr/local/bin/
echo 'integral ALL=(root) NOPASSWD:SETENV: /usr/local/bin/integral-sandbox-run' \
  | sudo install -m 0440 /dev/stdin /etc/sudoers.d/integral

# 3. Shared ownership of the artifacts tree. setgid so everything created
#    inside inherits the group (the wrapper's umask 002 makes it writable).
sudo chgrp -R integral-sbx /opt/integral/app/data/artifacts
sudo chmod 2770 /opt/integral/app/data/artifacts

# 4. Keep this API off 127.0.0.1 — see below. Change BOTH, together:
#    .env: INTEGRAL_BIND_HOST=127.0.0.2
#    /etc/caddy/Caddyfile: reverse_proxy 127.0.0.2:4000
sudo systemctl restart integral && sudo systemctl reload caddy

# 5. Verify. Refuses to run if anything above is missing or misconfigured.
sudo -u integral sudo -n /usr/local/bin/integral-sandbox-run --check
```

`SETENV:` in the sudoers line is required: it lets Integral pass the sandbox's
environment (throwaway DB coordinates, stub-proxy vars) through `sudo -E`. The
alternative, `systemd-run --setenv=`, would put the database password in `argv`
where `/proc` exposes it to every local user.

**Why steps 1 and 3 go together.** The artifact dir is the sandboxed app's cwd
and `$HOME`, so it writes `node_modules` and virtualenvs there as `integral-sbx`.
Integral deletes those dirs with plain `fs.rmSync` (`lib/purge.js`,
`lib/retention.js`, `lib/github.js`) and `force: true` does not swallow EPERM —
so without the setgid bit and the shared group, a repo re-pull fails and the
retention sweep logs an error for every dir it cannot remove.

**Re-check `UMask` if you enable this.** The hardening section above sets `UMask=0027` on
the unit, which is right for a box without the sandbox. Here the artifacts tree is shared
group-writable (`2770`) with `integral-sbx`, and dirs Integral itself creates under it
land `0750` — group-readable but not group-writable. Whether that matters depends on
which side creates a given dir first, so verify a full boot-and-purge cycle rather than
assuming either way. This is why `UMask` is documented but not shipped in
`integral.service`.

**Why `INTEGRAL_BIND_HOST=127.0.0.2`.** cgroup address filtering is per-address,
not per-port. The sandbox needs `127.0.0.1` for its throwaway Postgres and the
stub proxy, so anything else listening there is reachable too. Moving this API to
`127.0.0.2` is what keeps a sandboxed app from calling `/api/*` directly and
spoofing `X-Forwarded-For` past the rate limiter.

### What this does and does not buy you

Confinement gives the sandbox its own uid, no read access to Integral's secrets,
memory/CPU/task/wall-clock caps, and egress filtering that holds even for clients
ignoring proxy env vars. It does **not** make the box safe for untrusted code:
same kernel, no disk quota, and `pip` still runs `setup.py` for source
distributions. `INTEGRAL_SANDBOX_ALLOW` is still the boundary that keeps
strangers out — see `docs/fake-backend-spec.md` §9.

## The two origins

| | `app.` (dashboard) | `run.` (hosted artifacts + take flow) |
|---|---|---|
| Auth | GitHub OAuth session cookie | **anonymous, no cookies ever** |
| Serves | `/`, `/tests/*`, `/api/*` | `/t/*`, `/api/take/*`, injected scripts |
| Why | billing needs identity | uploaded HTML executes here; there must be nothing to steal |

`INTEGRAL_RUN_HOST` activates the split in `server/app.js`: dev-facing routes 404
on the run origin, `/t/*` on the app origin redirects to the run origin, and the
session cookie is never read on the run origin.

## Stripe

`scripts/stripe-bootstrap.js` provisions the whole Stripe side — 3 products, the 6
prices `server/lib/prices.js` resolves from env, the webhook endpoint, and a Customer
Portal configuration — and prints the `.env` block. Dry run first; it writes nothing
without `--apply`:

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-bootstrap.js --url=https://app.<domain>
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-bootstrap.js --url=https://app.<domain> --apply
```

Re-running is safe: it addresses products by fixed id and prices by `lookup_key`, and
falls back to matching `metadata.integral_plan` so a catalog built by hand in the
Dashboard gets adopted rather than duplicated. A price that exists at a *different*
amount is reported and left alone — reconcile that by hand, since a second price at a
new amount silently changes what new customers pay.

Two things the script cannot do for you:

- **The webhook signing secret is only returned when the endpoint is created.** If the
  endpoint already exists, Stripe will not show the secret again — reuse the saved one
  or roll it in the Dashboard.
- **Live mode is a different account from a sandbox**, so sandbox price ids are not
  valid live and vice versa. Run the script once per mode with that mode's key, and
  keep the two `.env` files apart.

The prices it creates ($20/mo individual, $216/yr, $20/mo team base, $10/mo per extra
seat, $108/yr) are also hardcoded in `public/landing.html` and `docs/go-to-market.md`.
Change all three together.

## Promo codes

`scripts/stripe-promo.js` creates a discount and one promotion code per partner. **It
does not run on the box** — like `stripe-bootstrap.js` it is a Stripe API client, so it
runs from a laptop with the live key and talks only to `api.stripe.com`. Nothing needs
deploying: `allow_promotion_codes: true` has been in `server/routes/billing.js` since the
first commit, so Checkout already renders the code field in production.

```bash
# Rehearse in a sandbox first — a redeemed code cannot be un-redeemed.
node --env-file=.env scripts/stripe-promo.js --codes=TESTONE --apply

# Then live.
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-promo.js \
  --codes=ACME,BETAINC --applies-to=integral_individual,integral_team \
  --expires=2026-12-31 --apply
```

Defaults are deliberately tight: `--percent=100`, one month, **one redemption per code**,
and `first_time_transaction` so an acquisition code cannot be redeemed by someone already
paying. `--max-redemptions=N` and `--allow-existing-customers` loosen them.

### Why `--applies-to` matters

A discount applies to whole **invoices**, not to months, and a coupon can only be
restricted by *product* — never by billing interval. Each Integral product carries both a
monthly and a yearly price, so a percent-off coupon cannot be limited to monthly. Redeemed
against a yearly plan, "100% off for 1 month" zeroes the annual invoice: a free year.

Worse, `integral_team_seat` has no ceiling — its quantity tracks headcount, so a large
team redeeming on yearly is an unbounded giveaway. Excluding that one product is what
turns the exposure into a number:

| Flags | Worst case per redemption |
| --- | --- |
| `--percent=100` | $216 **plus $108 per extra seat — no ceiling** |
| `--percent=100 --applies-to=integral_individual,integral_team` | $216 |
| `--amount-off=2000 --once` | $20 |

The script prints this before it writes anything. Read that line rather than trusting the
flags to mean what they sound like.

### Verifying a redemption

Plan state moves only when the webhook fires, so a successful Checkout proves nothing on
its own. After a test purchase, confirm the row actually changed:

```bash
sqlite3 /opt/integral/app/data/integral.db \
  "SELECT login, plan, billing_interval, stripe_subscription_id FROM users WHERE login='<you>';"
```

`plan` should be `individual` (or `team`) with a non-null subscription id. If `plan` is
still `free` but `stripe_customer_id` is set, Checkout worked and the webhook did not
land — check **Developers → Webhooks** for non-200 deliveries.

Locally the webhook cannot reach `localhost`, so this always looks broken until you run
`stripe listen --forward-to localhost:4000/webhooks/stripe` and put *its* signing secret
(not the Dashboard endpoint's) in `.env`.

## Retention

`server/index.js` sweeps daily in-process (plan retention windows, free-tier link
expiry, orphaned files). Prefer cron? `node scripts/sweep.js` runs one sweep.

## Updating to the latest master

The box deploys `origin/master` and nothing else. Everything that touches the working
tree runs as `integral`, with `-H`: without it `sudo` can leave `HOME` pointing at
root's, git never finds the deploy key in `/opt/integral/.ssh`, and the fetch fails
with a permission error that reads like GitHub's fault. Running any of this as root
also leaves root-owned files in the tree that break the *next* update.

```bash
cd /opt/integral/app
PREV=$(sudo -u integral -H git rev-parse --short HEAD)   # rollback target
echo "$PREV"                                             # write it down

sudo -u integral -H git fetch origin master
sudo -u integral -H git log --oneline HEAD..origin/master   # what is about to ship
sudo -u integral -H git status --porcelain                  # expect no output
```

`git status` should be silent. `.env`, `data/`, and `node_modules/` are gitignored, and
the unit file and Caddyfile were copied *out* of the tree during setup, so nothing on a
healthy box edits it in place — output here means someone patched production by hand,
and the reset below would throw that away. Find out what it is first.

```bash
# Take master exactly. reset --hard, not pull: no merge commits on a box nobody
# commits from, and no chance of a divergence that leaves a half-merged tree.
sudo -u integral -H git reset --hard origin/master
```

Dependencies only when the lockfile actually moved — `npm ci` deletes `node_modules`
outright and rebuilding it costs minutes on a 2 vCPU box:

```bash
if ! sudo -u integral -H git diff --quiet "$PREV" HEAD -- package-lock.json; then
  # Stop first in this case only. npm ci empties node_modules under the running
  # process, and anything it has not required yet (the sandbox modules load
  # lazily) would throw until the restart.
  sudo systemctl stop integral
  sudo -u integral -H npm ci --omit=dev
  sudo systemctl start integral
else
  sudo systemctl restart integral
fi
```

Then confirm what is actually running:

```bash
sudo -u integral -H git rev-parse --short HEAD   # should equal origin/master
systemctl status integral --no-pager
curl -sI http://127.0.0.1:4000/                  # local first: skips Caddy and DNS
curl -sI https://app.<domain>/ | head -1
journalctl -u integral -n 30 --no-pager
```

**Schema changes apply themselves on boot.** `server/db.js` runs `CREATE TABLE IF NOT
EXISTS` plus a list of `ensureColumn` calls at require time, so a restart is the
migration. There is no separate migrate step and no down-migration — `ensureColumn` only
ever *adds* columns, which is what makes the rollback below safe: old code ignores
columns it does not know about.

**Pick the moment if tests are live.** `public/take.js` empties its buffer before posting
and never retries, so a restart during an active session drops up to ~2.5s of that
tester's recording. Nothing logs requests — not the app, and not Caddy without a `log`
directive — so the journal will not tell you. Ask the database instead (`apt install -y
sqlite3` if it is missing; `-readonly` so this can never be the thing that corrupts it):

```bash
sudo -u integral sqlite3 -readonly /opt/integral/app/data/integral.db \
  "SELECT count(*) FROM sessions
    WHERE status='started' AND started_at > (strftime('%s','now')-600)*1000;"
```

`started_at` is `Date.now()`, hence the ×1000. The 10-minute floor matters: a tester who
closes the tab without the `/abandon` beacon landing leaves `status='started'` behind
forever, so an unbounded count reads as busy on an idle box.

### Rolling back

Code-only, since the database is forward-compatible by the note above:

```bash
sudo -u integral -H git reset --hard "$PREV"      # or the SHA you wrote down
sudo -u integral -H npm ci --omit=dev             # only if the lockfile moved
sudo systemctl restart integral
```

If `$PREV` is gone from the shell, `sudo -u integral -H git reflog` on the box still has
it — `reset --hard` leaves the old commit reachable there.
