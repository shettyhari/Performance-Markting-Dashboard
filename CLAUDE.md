# Qlarity — notes for Claude

Read this first. It carries the decisions and rules agreed while building this project, so work can continue in a new session.

## What it is
- A multi-company web app (SaaS): any company signs up, creates a **workspace** (organization) and compares **Meta Ads (and optionally Google Ads) with the leads in its CRM** per brand: spend, Meta leads, CRM leads, QL, sales, CPL, CPQL, cost per sale, TAT, lead leaks, attribution, reports, alerts, AI analyst.
- People who decide budgets use it, so **accuracy is critical**: never invent numbers, targets, values, actors or events. N/A when data is missing or a denominator is 0 — never 0.
- Workspace name, logo, currency, time zone, CRM name are set per workspace (no company is hard-coded anywhere). Product brand **Qlarity** (tagline "See what your ad spend really delivers"): one place, `PRODUCT` in index.html (`brandMark()` / `brandHead()`; logo `brand/qlarity-logo.png` + `qlarity-logo-dark.png` for dark mode, icons `brand/qlarity-icon-*.png`, original `brand/qlarity-logo-source.png`; without `PRODUCT.logo` the wordmark shows); server default "Qlarity", overridable with `APP_NAME`. Internal names (`lp-` storage keys, repo folder) stay.

## Architecture
- `index.html` — the dashboard: one file, **ES5 JavaScript** (`var`, `function`, no build step, no arrow functions or modules). Engine between `ENGINE START` / `ENGINE END` (`processData`). Helpers: `el`, `table`, `render`, `state`, `FMT`, `provApi`, `alertsApi`, `alertsAllowed()`, `myPrefs` / `saveMyPrefs`, `orgName()`, `crmName()`, `tzLabel()`, `whText()`.
  - Own sign-in: `lpAuth` (session `{token, user}` in localStorage `lp-session`; talks to `/api/auth`). supabase-js is only the query builder, pointed at `API_URL` (PostgREST); the `global.fetch` wrapper in `sbInit` adds the sign-in token and `x-org-id` on every call; `sb.org` / `sb.orgs` / `sbUseOrg` / `sbSwitchOrg`; workspace wizard `workspaceWizard()`; settings in `org_settings`, members in `org_members`.
- `attribution.js` — pages Attribution, Lead journeys, Report builder, Sync & tracking; **Ask AI is a floating assistant on every page** (`AIW`: button bottom-right, Ctrl/⌘+K, sends the page, dates and brand as `context`; chat kept per workspace in sessionStorage; styles `.aiw-*` in index.html); Settings › Workspace (name, logo, currency, time zone, CRM, Vault tokens, API keys) and Settings › Attribution & sync. Registers into `EXTRA_VIEWS` / `EXTRA_SET` / `SET_TABS` / `PAGE_INFO`.
- `lp-track.js` — website tracking script (`data-org` = workspace public id).
- `api/*.js` — Vercel functions (Node 18+, CommonJS); `_`-files are libraries.
  - **`_db.js` is the only way to reach the database from the server** (PostgREST at `API_URL`, with a short-lived service_role JWT signed with `JWT_SECRET`): `D.auth(req)` (sign-in token checked locally + `x-org-id` membership), `D.signedIn(req)`, `D.jwtSign` / `D.jwtVerify`, `D.withOrg(org, fn)` (AsyncLocalStorage), `D.sbFetch` (adds `org_id` to every read/write, prefixes `on_conflict`), `D.orgSecret(key)` (database vault), `D.orgSettings()`, `D.orgFromKey(key, kind)`, `D.cronAllowed`, workspace time / currency / names (`D.orgDay`, `D.tzMs`, `D.cur`, `D.crm`, `D.orgName`). In libraries that already use `D` as a local name the import is `DB`.
  - Endpoints: `meta.js`, `meta-cron.js`, `google.js`, `google-cron.js`, `alerts.js` (incl. Telegram webhook), `alerts-cron.js`, `crm-push.js` (push key → workspace), `collect.js` (tracking), `suite.js` (attribution, AI, MCP via `/api/mcp`, Chrome extension, `op=cron`), `auth.js` (sign-up / confirm / sign-in / reset / profile; scrypt, token version), `config.js`. `_mail.js` sends email over SMTP. `_ai.js`: Ask AI and the digest through the workspace owner's provider (Anthropic, OpenAI, Gemini or OpenAI-compatible; `org_ai_config` + vault keys `ai_<provider>_key`), same tools for all; `suite.js?op=ai-models|ai-test` are owner-only. Cron endpoints take `?org=<id>`; the database server (`ec2/fanout.sh`) calls them once per workspace. 11 functions: Vercel Hobby allows 12.
- `db/` — the whole database, applied in order by `ec2/setup.sh` (safe to re-run): `00-platform.sql` (roles anon / authenticated / service_role / authenticator, `auth.users`, `auth.uid()`, vault), `10-schema.sql` (workspaces, tables, RLS, functions), `20-auth.sql` (service_role-only login functions, `private.check_session` run by PostgREST before every request). Changes stay non-destructive and re-runnable; add to these files or a new numbered one (and to `setup.sh` and the tests).
- `ec2/` — the database server: `setup.sh` (Postgres, PostgREST, Caddy HTTPS, firewall, backups, schedules), `postgrest.conf`, `Caddyfile`, `fanout.sh`.
- `chrome-extension/`, `n8n/telecrm-to-dashboard.json` (TeleCRM example), `tests/*.test.js` (`npm test`; `db.test.js` and `auth.test.js` run the real `db/*.sql` in PGlite), `tests/ui.smoke.js` (`npm run test:ui`).

## Agreed definitions (do not change without asking)
- **Meta leads** = Meta "Results" of lead / chat / website-lead rows (`result_indicator ~* 'lead|form|messag|conversation|whatsapp'`). Excluded campaigns' results are left out (their spend still counts).
- **CRM leads** = leads by created day (workspace wall-clock time; `created_on` is `timestamp` without zone); repeat leads (`prev_lead` not null) left out. **QL** = qualified statuses (QL statuses page).
- **Sales** = statuses ticked as “Counts as a sale” (`S.wonStatuses`, exact match); N/A until one is ticked. **Est. revenue** = sales × `S.dealValue[brand]`, always labelled estimate; N/A when a brand with sales has no value.
- CPL = spend ÷ Meta leads; CPQL = spend ÷ QL; cost per sale = spend ÷ sales; CTR = link clicks ÷ impressions; CPC = spend ÷ link clicks; CPM = spend ÷ impressions × 1,000. Blended figures from **summed totals**, never averages of ratios.
- **Totals = sum of the listed brands**; Unmapped spend shown separately, never silently added.
- **Attribution**: credit split over a lead's touches (website touches joined by hashed phone / email, then the CRM's own source); five models; spend only for Meta / Google / channels with entered costs, else N/A.
- **TAT** = working hours from Settings (`S.workHours` {start, end, days}, default Mon–Sat 10–21), holidays skipped. Reach only where it can't double-count.

## Rules
- **Never ask for or accept API keys, tokens or passwords in chat.** Workspace admins paste tokens in Settings › Workspace (Vault); site-wide secrets go in Vercel env (and `/etc/lp.env` on the server, generated there).
- **Every server query is workspace-scoped through `_db.js`**; never use the service key with a raw fetch on a data table. Every new data table gets `org_id` + RLS (`org_id = private.current_org()` and a member role) and is listed in `tests/tenancy.test.js` if the server writes it.
- Never drop or overwrite production data or settings without approval.
- Roles: viewer < editor < admin; **owner** = an admin with `org_members.is_owner` (creator of the workspace; set only via `set_member_owner` by an owner; at least one per workspace). Only owners see Settings › AI and change AI keys / provider / address (`set_ai_config`, `set_org_secret` for `ai_*`). Members see on/off, provider and model via `ai_status()`.
- Alerts are private to the workspace's alert recipient (Settings › Alerts), or its admins until one is chosen.
- Personal view settings are per login and workspace in `user_prefs`.
- Before pushing: `node --check api/*.js`, ES5 parse of `index.html`'s inline script, `attribution.js`, `lp-track.js`; `npm test`. Phone width must work.
- Reuse existing helpers; extend, don't rebuild.

## Environment variables (names only)
`API_URL`, `JWT_SECRET`, `CRON_SECRET` (all three from `ec2/setup.sh`), `APP_URL`, `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM`, `APP_NAME` (optional), `TELEGRAM_BOT_TOKEN` (optional), `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` / `GOOGLE_ADS_DEVELOPER_TOKEN` (optional), `META_API_VERSION` (optional), `APP_SINGLE_ORG=1` (optional: lets a one-company deployment keep Meta/Google tokens in env).

## Not built
Billing / plans, platform super-admin, custom domains per workspace, call tracking, Google Ads offline conversions, DST time zones, sales in the Telegram daily / weekly reports.
