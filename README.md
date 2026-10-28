# Lead Performance

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
| Report builder, Ask AI | Your own groupings and numbers (CSV); plain-language questions answered from the workspace's numbers |
| Sync & tracking, Alerts & Monitoring, Ad account activity | What was sent to Meta, website tracking health, audiences; alerts with open / resolved tracking; who changed what in Meta |

**Definitions** (used everywhere, including Telegram, AI and MCP): Meta leads = lead / chat Results (excluded campaigns' results left out, spend kept); CRM leads by created day in the workspace time zone, repeat leads left out; QL = qualified statuses; sales = statuses ticked as sale; CPL = spend ÷ Meta leads; CPQL = spend ÷ QL; cost per sale = spend ÷ sales; est. revenue = sales × the brand's average deal value (always labelled an estimate); ratios from summed totals; totals = listed brands only; **N/A, never 0**, when data is missing or a denominator is 0.

## Running the site (one deployment serves every company)

**Stack:** static `index.html` + `attribution.js` (ES5, no build), Vercel serverless functions in `api/`, Supabase (Postgres, Auth, RLS, Vault, pg_cron, pg_net).

1. **Supabase** (new project): SQL Editor › run `supabase/install.sql`, then the line at its end with your site address: `update public.app_config set site_url = 'https://your-site' where id = 1;`. Authentication › Email: keep **Confirm email ON** (a login gets a workspace role only with a proven email). Authentication › URL configuration: your site address.
2. **Vercel** (this repo), environment variables:

| Variable | What |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project |
| `APP_URL` | the site address (used for Telegram's webhook and links in reports) |
| `TELEGRAM_BOT_TOKEN` | optional: one bot for every workspace's alerts (@BotFather) |
| `ANTHROPIC_API_KEY` | optional: Ask AI and the AI digest (Claude) |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | optional: one Google OAuth client; each workspace adds its own refresh token |
| `CRON_SECRET` | optional: lets another scheduler call `/api/*-cron?org=<id>` |
| `APP_NAME` | optional: product name on the sign-in page (default "Lead Performance") |

3. Deploy. Sign up, create the first workspace.

Schedules run inside the database (`install.sql`): each one calls the site **once per active workspace** (`?org=<id>`), so every company gets its own 60-second budget. Tokens per workspace are stored in Supabase Vault (`set_org_secret`; only the server can read them back). Machine keys (CRM push, API) are stored as sha256 hashes and shown once.


**Not included:** billing / plans, a platform super-admin console, custom domains per workspace, call tracking, daylight-saving time zones (time zones are fixed offsets).

## Developing

- `npm run test:ui` — `tests/ui.smoke.js`: loads the page in jsdom with a fake Supabase and walks sign-up → workspace wizard → settings pages (needs `npm install` for jsdom).
- `npm test` — `tests/monitor.test.js` (alerts and reports), `tests/suite.test.js` (definitions, attribution, Conversions API, MCP, collector), `tests/tenancy.test.js` (workspace isolation: scoped queries, concurrent requests, keys, collector domains, invite rules). No network; Supabase / Meta / Telegram are faked.
- Before pushing: `node --check api/*.js`, ES5 parse of the inline script in `index.html`, `attribution.js` and `lp-track.js`, `npm test`. Keep phone width working (no horizontal scroll).
- Server code never calls Supabase directly: use `api/_db.js` (`withOrg`, `sbFetch`, `orgSecret`, `orgSettings`), which scopes everything to the request's workspace.
