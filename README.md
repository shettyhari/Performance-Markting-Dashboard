# Qlarity

A web app where any company signs up, creates a **workspace** and sees whether its ad spend turns into real customers: **Meta Ads (and Google Ads) next to the leads in its CRM**, by brand, campaign, ad set and ad, with qualified leads, sales, call speed, lead leaks, attribution across channels (including ChatGPT and other AI search), Telegram alerts and an AI analyst.

Each workspace has its own data, settings, team, tokens and API keys. Nothing is shared between workspaces: the database checks every request (row level security on `org_id`), and the server works on one workspace per request.

## For companies using it

1. **Sign up** with your work email and confirm it from the link in your inbox.
2. **Create your workspace**: name, currency, time zone, your CRM (TeleCRM, Zoho, HubSpot, LeadSquared … or any other) and your brands. You become its admin.
3. **Settings › Workspace**: logo, tokens and API keys.
   - **Meta System User token** (ads_read) → Meta spend, leads and results sync every 30 minutes (Settings › Data connections › tick ad accounts, Auto-sync).
   - **CRM push key** → your CRM sends leads to `https://<site>/api/crm-push` with header `x-push-key`. TeleCRM users can import `n8n/telecrm-to-dashboard.json` into n8n. Without a push, upload CRM exports (Lead data upload).
   - Optional: Conversions API token, audience token, Google Ads refresh token, API keys for Claude / ChatGPT (MCP) and the Chrome extension.
4. **Invite your team** (Saved data › Workspace database › Members): viewer, editor or admin. They create an account with the invited email and confirm it; the workspace appears for them.
5. **QL statuses**: check which CRM statuses count as qualified, tick the ones that mean a **sale**.
6. Optional: **Settings › Attribution & sync** for deal values, sending qualified leads and sales to Meta, the website tracking snippet (`lp-track.js`), channel costs, Meta audiences and the daily AI digest; **Settings › Alerts** to connect Telegram; **Settings › Working hours & holidays**.

Anyone can belong to several workspaces (agencies, groups); switch from the profile menu.

## What it shows

| Page | Contents |
|---|---|
| Overview, Trends | Spend, Meta leads, CRM leads, CPL, QL, CPQL, sales, cost per sale, est. revenue / ROAS, TAT, SLA; brand summary and charts |
| Campaigns / Ad sets / Ads / Lead forms / Lead status | Every number per level, totals that follow filters, Excel export |
| Reports | Daily / MTD brand-wise and leader-wise templates, Master, creative analysis |
| TAT & calls, CRM leads data, Lead leaks | Call speed by owner and manager, leads still to call, paid leads that never reached the CRM |
| Attribution, Lead journeys | First / last click, linear, position-based and time-decay credit by channel or campaign; conversion paths; every touch of one lead |
| Report builder, Ask Qlarity | Your own groupings and numbers (CSV); plain-language questions answered from the workspace's numbers |
| Sync & tracking, Alerts & Monitoring, Ad account activity | What was sent to Meta, website tracking health, audiences; alerts with open / resolved tracking; who changed what in Meta |

**Definitions** (used everywhere, including Telegram, AI and MCP): Meta leads = lead / chat Results (excluded campaigns' results left out, spend kept); CRM leads by created day in the workspace time zone, repeat leads left out; QL = qualified statuses; sales = statuses ticked as sale; CPL = spend ÷ Meta leads; CPQL = spend ÷ QL; cost per sale = spend ÷ sales; est. revenue = sales × the brand's average deal value (always labelled an estimate); ratios from summed totals; totals = listed brands only; **N/A, never 0**, when data is missing or a denominator is 0.

## Running the site (one deployment serves every company)

**Stack:** a static marketing page (`index.html`, at `/`), the dashboard `app.html` (at `/app`) + `attribution.js` (ES5, no build) and serverless functions in `api/` on **Vercel**; one **database server on AWS EC2** running Postgres 16 (localhost only), PostgREST (the REST API the page and functions use; row level security per workspace) and Caddy (HTTPS). Sign-in is the site's own (`api/auth.js`): email + password, email confirmation, password reset.

1. **Database server.** Launch an EC2 instance (Ubuntu 24.04, e.g. t4g.small, 20 GB gp3) with an Elastic IP; security group: 22 from your IP, 80 and 443 from anywhere. Optionally point a domain (e.g. `api.yourdomain.com`) at the Elastic IP. Then from this repo:

   ```bash
   scp -r db ec2 ubuntu@<elastic-ip>:~/lp/
   ssh ubuntu@<elastic-ip> "sudo APP_URL=https://your-site.vercel.app bash ~/lp/ec2/setup.sh"
   ```

   Add `API_DOMAIN=api.yourdomain.com` if you set up a domain (otherwise it uses `<ip>.sslip.io`), `ADMIN_IP=<your ip>` to limit SSH, `BACKUP_S3_URI=s3://bucket/path` for off-server backups (the instance needs a role allowed only `s3:PutObject` on that path; the script installs the AWS CLI and logs each copy: `journalctl -t lp-backup`). `EXTRA_ORIGINS="https://other-address"` lets the site also run from more addresses (a custom domain, or the old address while moving); `APP_URL` is the main one, used by email links and schedules. It installs everything, creates the database from `db/*.sql`, turns on nightly backups (14 days) and the schedules, and prints `API_URL`, `JWT_SECRET` and `CRON_SECRET` once (they stay in `/etc/lp.env` on the server, root only). Run it again after pulling database changes: it keeps the data and secrets.
2. **Vercel** (this repo), environment variables:

| Variable | What |
|---|---|
| `API_URL`, `JWT_SECRET`, `CRON_SECRET` | printed by `ec2/setup.sh` |
| `APP_URL` | the site address (email links, Telegram's webhook, links in reports); same as on the server |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | sign-up confirmation and password-reset emails, through any SMTP server (Amazon SES, Gmail, Zoho, your host's mail). Without them nobody can sign up. |
| `TELEGRAM_BOT_TOKEN` | optional: one bot for every workspace's alerts (@BotFather) |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | optional: one Google OAuth client; each workspace adds its own refresh token |
| `APP_NAME` | optional: product name on the sign-in page and in emails (default "Qlarity") |

3. Deploy. Sign up, open the confirmation email, create the first workspace.

Schedules run on the database server (`/etc/cron.d/lp-fanout`, UTC): each one calls the site **once per active workspace** (`?org=<id>`, with `x-cron-secret`), so every company gets its own 60-second budget; results in `journalctl -t lp-fanout`. Tokens per workspace are stored encrypted in the database vault (`set_org_secret`; only the server can read them back). Machine keys (CRM push, API) are stored as sha256 hashes and shown once. Passwords are stored as scrypt hashes; email links as sha256 hashes; a password change or reset ends every other session.


**Not included:** billing / plans, a platform super-admin console, custom domains per workspace, call tracking, daylight-saving time zones (time zones are fixed offsets).

## Developing

- `npm run test:ui` — `tests/ui.smoke.js`: loads the page in jsdom with a fake database API and walks sign-in → workspace wizard → settings pages → the email-confirmation link (needs `npm install` for jsdom).
- `npm test` — `tests/monitor.test.js` (alerts and reports), `tests/suite.test.js` (definitions, attribution, Conversions API, MCP, collector), `tests/tenancy.test.js` (workspace isolation: scoped queries, concurrent requests, keys, collector domains, invite rules, sign-in tokens), `tests/db.test.js` (the real `db/*.sql` in PGlite: isolation between workspaces under row level security), `tests/auth.test.js` (sign-up, confirmation, sign-in, lockout, reset, session ending, against the real SQL). No network; Meta / Telegram / email are faked.
- Before pushing: `node --check api/*.js`, ES5 parse of the inline script in `app.html`, `attribution.js` and `lp-track.js`, `npm test`. Keep phone width working (no horizontal scroll).
- Server code never calls the database API directly: use `api/_db.js` (`withOrg`, `sbFetch`, `orgSecret`, `orgSettings`), which scopes everything to the request's workspace.
