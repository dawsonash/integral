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
