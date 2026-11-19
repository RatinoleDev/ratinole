# Deploying to the VPS

Step-by-step for one Ubuntu server (Hostinger VPS, HANDOFF section 3): Postgres,
Redis, the three PM2 processes and Nginx in front. Nothing here deploys to a
chain, moves funds or registers a domain. Replace `example.com` with the domain
once the owner has chosen and registered it.

## 1. Server packages

```bash
sudo apt-get update && sudo apt-get install -y postgresql redis-server nginx certbot python3-certbot-nginx git curl
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

```bash
sudo corepack enable && sudo npm install -g pm2
```

Redis should listen on localhost only (the Ubuntu default). Check with
`redis-cli ping`.

## 2. Database

Pick a strong password and keep it only in the server's `.env`:

```bash
sudo -u postgres psql -c "CREATE ROLE rationale WITH LOGIN PASSWORD 'choose-a-strong-password';"
```

```bash
sudo -u postgres psql -c "CREATE DATABASE rationale OWNER rationale;"
```

## 3. Code and configuration

```bash
sudo mkdir -p /srv/rationale && sudo chown "$USER" /srv/rationale && git clone https://github.com/RatinoleDev/ratinole.git /srv/rationale
```

```bash
cd /srv/rationale && pnpm install --frozen-lockfile
```

Create `/srv/rationale/.env` from `.env.example` (`chmod 600 .env`) and set:

| Variable | Production value |
|---|---|
| `DATABASE_URL` | `postgresql://rationale:<password>@localhost:5432/rationale` |
| `REDIS_URL` | `redis://localhost:6379` |
| `APP_ORIGIN` | `https://example.com` (must match the address users open; sign-in checks it) |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | the key for strategy reading (or empty to switch it off) |
| `LLM_MODEL` | `claude-opus-5-5` unless the owner picks another |
| `LLM_MONTHLY_BUDGET_USD` | the owner's monthly budget |
| `API_INTERNAL_URL` | `http://127.0.0.1:4000` |

Then generate the database client, apply migrations and build the site:

```bash
pnpm db:generate && pnpm db:deploy && pnpm --filter @rationale/web build
```

## 4. Processes

```bash
pm2 start ecosystem.config.cjs && pm2 save
```

```bash
pm2 startup
```

(`pm2 startup` prints one command to run with sudo so the processes come back
after a reboot.) Run exactly one engine: it owns the hourly schedule.

## 5. Nginx and TLS

Two stages, because the full config points at a certificate that does not exist
yet. First a temporary HTTP-only site that answers the certificate challenge:

```bash
sudo mkdir -p /var/www/certbot && printf 'server {\n  listen 80;\n  listen [::]:80;\n  server_name example.com www.example.com;\n  location /.well-known/acme-challenge/ { root /var/www/certbot; }\n  location / { return 200 "ok"; }\n}\n' | sudo tee /etc/nginx/sites-available/rationale >/dev/null && sudo ln -sf /etc/nginx/sites-available/rationale /etc/nginx/sites-enabled/rationale && sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx
```

Get a certificate for both names (use your email for expiry notices):

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d example.com -d www.example.com --agree-tos -m you@example.com --no-eff-email --deploy-hook "systemctl reload nginx"
```

Then install the full site with the real domain and reload:

```bash
sed 's/example\.com/your-domain/g' deploy/nginx.conf | sudo tee /etc/nginx/sites-available/rationale >/dev/null && sudo nginx -t && sudo systemctl reload nginx
```

`www` redirects to the bare domain, because wallet sign-in is bound to the one
host in `APP_ORIGIN`. Certbot renews automatically through the same challenge
path and reloads Nginx after each renewal.

## 6. Backups and health checks

Add to the deploy user's crontab (`crontab -e`). Set `MAILTO` to get cron
output by email, and `ALERT_WEBHOOK_URL` to post alerts to a chat webhook.

```
MAILTO=you@example.com
15 3 * * * ENV_FILE=/srv/rationale/.env /srv/rationale/scripts/backup-db.sh >/dev/null
*/5 * * * * /srv/rationale/scripts/healthcheck.sh
```

Copy `/var/backups/rationale` off the server regularly (another machine or
object storage). Test a restore once:

```bash
pg_restore --clean --no-owner --dbname="postgresql://rationale:<password>@localhost:5432/rationale_restore_test" /var/backups/rationale/<file>.dump
```

## 7. The Phase 1 acceptance run (48 hours)

Launch a paper agent from Agent Studio, then leave the server alone for 48 hours.
Phase 1 is done when there are no missed hours:

```bash
curl -s http://127.0.0.1:4000/api/health
```

`missedHours` must be `0`. `lateDecisions` counts hours the engine made up
after a restart; they are allowed but should be rare. For a per-hour view:

```bash
psql "$DATABASE_URL" -c 'SELECT date_trunc($$hour$$, hour) AS hour, count(*), bool_or(late) AS late FROM "Decision" GROUP BY 1 ORDER BY 1 DESC LIMIT 60;'
```

## 8. Updating

```bash
cd /srv/rationale && git pull && pnpm install --frozen-lockfile && pnpm db:generate && pnpm db:deploy && pnpm --filter @rationale/web build && pm2 reload ecosystem.config.cjs
```

After an upgrade that adds agent statistics, recompute them once:

```bash
pnpm --filter @rationale/engine tick stats
```
