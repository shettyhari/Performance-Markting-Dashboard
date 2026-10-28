# Lead Performance — notes for Claude

Read this first. It carries the decisions and rules agreed while building this project, so work can continue in a new session.

## What it is
- A multi-company web app (SaaS): any company signs up, creates a **workspace** (organization) and compares **Meta Ads (and optionally Google Ads) with the leads in its CRM** per brand: spend, Meta leads, CRM leads, QL, sales, CPL, CPQL, cost per sale, TAT, lead leaks, attribution, reports, alerts, AI analyst.
- People who decide budgets use it, so **accuracy is critical**: never invent numbers, targets, values, actors or events. N/A when data is missing or a denominator is 0 — never 0.
- Workspace name, logo, currency, time zone, CRM name are set per workspace (no company is hard-coded anywhere). Default product name "Lead Performance".

## Architecture
- `index.html` — the dashboard: one file, **ES5 JavaScript** (`var`, `function`, no build step, no arrow functions or modules). Engine between `ENGINE START` / `ENGINE END` (`processData`). Helpers: `el`, `table`, `render`, `state`, `FMT`, `provApi`, `alertsApi`, `alertsAllowed()`, `myPrefs` / `saveMyPrefs`, `orgName()`, `crmName()`, `tzLabel()`, `whText()`.
  - Supabase client sends `x-org-id` on every call (`global.fetch` wrapper in `sbInit`); `sb.org` / `sb.orgs` / `sbUseOrg` / `sbSwitchOrg`; workspace wizard `workspaceWizard()`; settings in `org_settings`, members in `org_members`.
- `attribution.js` — pages Attribution, Lead journeys, Report builder, Ask AI, Sync & tracking; Settings › Workspace (name, logo, currency, time zone, CRM, Vault tokens, API keys) and Settings › Attribution & sync. Registers into `EXTRA_VIEWS` / `EXTRA_SET` / `SET_TABS` / `PAGE_INFO`.
- `lp-track.js` — website tracking script (`data-org` = workspace public id).
- `api/*.js` — Vercel functions (Node 18+, CommonJS); `_`-files are libraries.
  - **`_db.js` is the only way to reach Supabase from the server**: `D.auth(req)` (login + `x-org-id` membership), `D.withOrg(org, fn)` (AsyncLocalStorage), `D.sbFetch` (adds `org_id` to every read/write, prefixes `on_conflict`), `D.orgSecret(key)` (Vault), `D.orgSettings()`, `D.orgFromKey(key, kind)`, `D.cronAllowed`, workspace time / currency / names (`D.orgDay`, `D.tzMs`, `D.cur`, `D.crm`, `D.orgName`). In libraries that already use `D` as a local name the import is `DB`.
  - Endpoints: `meta.js`, `meta-cron.js`, `google.js`, `google-cron.js`, `alerts.js` (incl. Telegram webhook), `alerts-cron.js`, `crm-push.js` (push key → workspace), `collect.js` (tracking), `suite.js` (attribution, AI, MCP via `/api/mcp`, Chrome extension, `op=cron`), `config.js`. Cron endpoints take `?org=<id>`; pg_cron calls them once per workspace.
- `supabase/install.sql` — the whole database (multi-company). Changes go in new, non-destructive SQL files. SQL is only ever run on this product's own Supabase project.
- `chrome-extension/`, `n8n/telecrm-to-dashboard.json` (TeleCRM example), `tests/*.test.js` (`npm test`).

## Agreed definitions (do not change without asking)
- **Meta leads** = Meta "Results" of lead / chat / website-lead rows (`result_indicator ~* 'lead|form|messag|conversation|whatsapp'`). Excluded campaigns' results are left out (their spend still counts).
- **CRM leads** = leads by created day (workspace wall-clock time; `created_on` is `timestamp` without zone); repeat leads (`prev_lead` not null) left out. **QL** = qualified statuses (QL statuses page).
- **Sales** = statuses ticked as “Counts as a sale” (`S.wonStatuses`, exact match); N/A until one is ticked. **Est. revenue** = sales × `S.dealValue[brand]`, always labelled estimate; N/A when a brand with sales has no value.
- CPL = spend ÷ Meta leads; CPQL = spend ÷ QL; cost per sale = spend ÷ sales; CTR = link clicks ÷ impressions; CPC = spend ÷ link clicks; CPM = spend ÷ impressions × 1,000. Blended figures from **summed totals**, never averages of ratios.
- **Totals = sum of the listed brands**; Unmapped spend shown separately, never silently added.
- **Attribution**: credit split over a lead's touches (website touches joined by hashed phone / email, then the CRM's own source); five models; spend only for Meta / Google / channels with entered costs, else N/A.
- **TAT** = working hours from Settings (`S.workHours` {start, end, days}, default Mon–Sat 10–21), holidays skipped. Reach only where it can't double-count.

## Rules
- **Never ask for or accept API keys, tokens or passwords in chat.** Workspace admins paste tokens in Settings › Workspace (Vault); site-wide secrets go in Vercel env.
- **Every server query is workspace-scoped through `_db.js`**; never use the service key with a raw fetch on a data table. Every new data table gets `org_id` + RLS (`org_id = private.current_org()` and a member role) and is listed in `tests/tenancy.test.js` if the server writes it.
- Never drop or overwrite production data or settings without approval.
- Alerts are private to the workspace's alert recipient (Settings › Alerts), or its admins until one is chosen.
- Personal view settings are per login and workspace in `user_prefs`.
- Before pushing: `node --check api/*.js`, ES5 parse of `index.html`'s inline script, `attribution.js`, `lp-track.js`; `npm test`. Phone width must work.
- Reuse existing helpers; extend, don't rebuild.

## Environment variables (names only)
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `APP_NAME` (optional), `TELEGRAM_BOT_TOKEN` (optional), `ANTHROPIC_API_KEY` (optional), `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` / `GOOGLE_ADS_DEVELOPER_TOKEN` (optional), `CRON_SECRET` (optional), `META_API_VERSION` (optional), `APP_SINGLE_ORG=1` (optional: lets a one-company deployment keep Meta/Google tokens in env).

## Not built
Billing / plans, platform super-admin, custom domains per workspace, call tracking, Google Ads offline conversions, DST time zones, sales in the Telegram daily / weekly reports.
