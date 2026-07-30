# Deploying Integral

One VPS, one Node process, SQLite on local disk. Total standing cost ≈ $10–15/mo.
This is the deliberate architecture (see docs/go-to-market.md §1.3): don't move to
Postgres/S3 until backups or write volume actually hurt.

## One-time setup (Ubuntu/Debian VPS)

```bash
# 1. Node LTS + a system user + the app
sudo useradd -r -m -d /opt/integral integral
sudo -u integral git clone <your-repo> /opt/integral
cd /opt/integral && sudo -u integral npm ci --omit=dev

# 2. Config
sudo -u integral cp .env.example /opt/integral/.env   # then fill it in
# Required for production: INTEGRAL_APP_URL, INTEGRAL_RUN_HOST,
# GITHUB_CLIENT_ID/SECRET, STRIPE_* (when charging), RESEND_API_KEY.

# 3. Process supervision
sudo cp deploy/integral.service /etc/systemd/system/
sudo systemctl enable --now integral

# 4. TLS + reverse proxy (two DNS A records → this box: app. and run.)
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit domains first
sudo systemctl reload caddy

# 5. Backups
#    - SQLite: litestream (deploy/litestream.yml → /etc/litestream.yml)
#    - artifacts + event logs: nightly cron of deploy/backup-files.sh
```

## Locking down secrets (do this regardless)

`.env` and `integral.db` land at 0644 — world-readable — and hold the live Stripe
key, the OAuth secret, the session signing secret, and every user row:

```bash
sudo chmod 0600 /opt/integral/.env
sudo chmod 0640 /opt/integral/data/integral.db
sudo chmod 0751 /opt/integral/data        # traversable, not listable
```

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
sudo chgrp -R integral-sbx /opt/integral/data/artifacts
sudo chmod 2770 /opt/integral/data/artifacts

# 4. Keep this API off 127.0.0.1 — see below.
#    .env: INTEGRAL_BIND_HOST=127.0.0.2   (Caddyfile upstream already matches)
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

1. Create one Product with one recurring Price (~$29/mo) → `STRIPE_PRICE_ID`.
2. Add a webhook endpoint `https://app.<domain>/webhooks/stripe` subscribed to
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` → `STRIPE_WEBHOOK_SECRET`.
3. Enable the no-code Customer Portal in the Stripe dashboard.

## Retention

`server/index.js` sweeps daily in-process (plan retention windows, free-tier link
expiry, orphaned files). Prefer cron? `node scripts/sweep.js` runs one sweep.

## Updating

```bash
cd /opt/integral && sudo -u integral git pull && sudo -u integral npm ci --omit=dev
sudo systemctl restart integral
```
