// The CEO console's server side (page: /admin → admin.html). Only for the Qlarity team: a signed-in, confirmed login whose email is
// listed in SUPER_ADMIN_EMAILS (comma separated, Vercel env). Everyone else gets 403 and nothing else.
// It sees counts and sizes per workspace and account data of logins, never a workspace's leads, phone numbers, emails or tokens.
//   GET  /api/admin?op=me        → { admin: true, email }
//   GET  /api/admin?op=overview  → workspaces, logins, database, server health (latest + 24 h), issues, recent events
//   GET  /api/admin?op=vercel    → recent deployments (VERCEL_TOKEN read-only, VERCEL_PROJECT_ID, optional VERCEL_TEAM_ID)
//   POST /api/admin?op=action    { kind, id, name? }
//        kind: org-suspend | org-reactivate | org-delete (name must match) | user-signout | user-disable | user-enable | user-resend
// Every action is written to the event log with the admin's email.
const D = require("./_db");
const A = require("./auth");
const M = require("./_mail");

const body = (req) => { let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } return b || {}; };
const rpc = (fn, args) => D.raw("rpc/" + fn, { method: "POST", body: JSON.stringify(args || {}) });
const admins = () => String(process.env.SUPER_ADMIN_EMAILS || "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const HOUR = 3600000;

/* the signed-in platform admin, or null */
async function adminOf(req) {
  const list = admins(); if (!list.length) return null;
  const u = await D.signedIn(req);
  return u && u.email_confirmed_at && list.indexOf(u.email) >= 0 ? u : null;
}

/* plain-language problems from the latest health snapshot, the event log and the workspaces */
function issuesOf(h, events, orgs) {
  const out = [], add = (level, area, title, detail) => out.push({ level, area, title, detail: detail || "" });
  if (!h) { add("warn", "server", "No health data from the server yet", "The health job (ec2/health.sh) runs every 5 minutes once setup.sh has been run again."); return out; }
  const d = h.data || {}, age = Date.now() - new Date(h.taken_at).getTime();
  if (age > 20 * 60000) add("error", "server", "The server stopped reporting", "Last health snapshot " + Math.round(age / 60000) + " minutes ago: the server, its database or the schedule may be down.");
  const disk = d.disk || {}, pct = disk.total ? disk.used / disk.total : 0;
  if (pct >= 0.9) add("error", "storage", "Server disk is almost full", Math.round(pct * 100) + "% used. Grow the EBS volume in AWS.");
  else if (pct >= 0.8) add("warn", "storage", "Server disk is filling up", Math.round(pct * 100) + "% used.");
  const mem = d.memory || {};
  if (mem.total && mem.available / mem.total < 0.1) add("warn", "server", "Memory is low", Math.round(100 * mem.available / mem.total) + "% available.");
  const load = (d.load || [])[1], cpus = d.cpus || 1;
  if (load > cpus * 1.5) add("warn", "server", "The server is busy", "Load " + load + " on " + cpus + " CPU" + (cpus > 1 ? "s" : "") + " (5-minute average).");
  Object.keys(d.services || {}).forEach((k) => { if (d.services[k] !== "active") add("error", "server", "Service " + k + " is " + (d.services[k] || "down"), "Check: journalctl -u " + k + " -n 50"); });
  const b = d.backup || {};
  if (!b.at) add("error", "backup", "No backup found on the server");
  else if (Date.now() - new Date(b.at).getTime() > 36 * HOUR) add("error", "backup", "The last backup is more than a day old", "Newest: " + b.file);
  if (b.s3 === "failed") add("error", "backup", "The off-server (S3) backup copy failed", b.s3_last || "");
  else if (b.s3 === "off") add("warn", "backup", "Backups are not copied off the server", "Set BACKUP_S3_URI and run setup.sh again.");
  const s = d.schedules || {};
  if (s.failed_24h > 0) add(s.failed_24h > 5 ? "error" : "warn", "schedules", s.failed_24h + " scheduled job" + (s.failed_24h > 1 ? "s" : "") + " failed in 24 hours", s.last_failure || "");
  if (d.cert_expires) { const days = (new Date(d.cert_expires).getTime() - Date.now()) / 864e5; if (days < 14) add(days < 3 ? "error" : "warn", "server", "HTTPS certificate expires in " + Math.max(0, Math.floor(days)) + " days", "Caddy renews it on its own; if this stays, check journalctl -u caddy."); }
  const errs = (events || []).filter((e) => e.level === "error" && e.source !== "admin" && Date.now() - new Date(e.at).getTime() < 24 * HOUR);
  if (errs.length) add(errs.length > 20 ? "error" : "warn", "errors", errs.length + " server error" + (errs.length > 1 ? "s" : "") + " in 24 hours", "Latest: " + errs[0].area + " — " + errs[0].message);
  const stale = (orgs || []).filter((o) => o.active && o.uploads > 0 && o.last_upload && Date.now() - new Date(o.last_upload).getTime() > 14 * 24 * HOUR);
  if (stale.length) add("info", "workspaces", stale.length + " workspace" + (stale.length > 1 ? "s haven't" : " hasn't") + " uploaded data for 2 weeks", stale.slice(0, 5).map((o) => o.name).join(", "));
  return out;
}

const ops = {
  async me(req, b, who) { return [200, { admin: true, email: who.email, name: who.name }]; },

  async overview() {
    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const [orgs, users, db, latest, series, events] = await Promise.all([
      rpc("platform_orgs"), rpc("platform_users"), rpc("platform_db"),
      D.raw("platform_health?select=taken_at,data&order=taken_at.desc&limit=1"),
      D.raw("platform_health?select=taken_at,disk:data->disk,memory:data->memory,load:data->load&taken_at=gte." + since + "&order=taken_at.asc&limit=400"),
      D.raw("platform_events?select=id,at,source,level,area,message,org_id,detail&order=at.desc&limit=300"),
    ]);
    const h = (latest || [])[0] || null;
    return [200, { at: new Date().toISOString(), orgs: orgs || [], users: users || [], db: db || {}, health: h, series: series || [], events: events || [],
      issues: issuesOf(h, events, orgs), vercel: !!process.env.VERCEL_TOKEN }];
  },

  async vercel() {
    const tok = process.env.VERCEL_TOKEN, pid = process.env.VERCEL_PROJECT_ID;
    if (!tok || !pid) return [200, { configured: false }];
    const team = process.env.VERCEL_TEAM_ID ? "&teamId=" + encodeURIComponent(process.env.VERCEL_TEAM_ID) : "";
    const r = await fetch("https://api.vercel.com/v6/deployments?projectId=" + encodeURIComponent(pid) + "&limit=12" + team, { headers: { authorization: "Bearer " + tok } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return [200, { configured: true, error: "Vercel answered " + r.status + ((j.error && j.error.message) ? ": " + j.error.message : "") }];
    const deps = (j.deployments || []).map((d) => ({ id: d.uid, url: d.url, state: d.state || d.readyState, target: d.target || "preview", created: d.created,
      message: String((d.meta && (d.meta.githubCommitMessage || d.meta.gitlabCommitMessage)) || "").split("\n")[0].slice(0, 120),
      sha: String((d.meta && d.meta.githubCommitSha) || "").slice(0, 7), by: (d.creator && d.creator.username) || "" }));
    return [200, { configured: true, deployments: deps }];
  },

  async action(req, b, who) {
    const kind = String(b.kind || ""), id = String(b.id || "");
    if (!D.UUID.test(id)) return [400, { error: "Missing id." }];
    let ok = false, what = "";
    if (kind === "org-suspend" || kind === "org-reactivate") {
      ok = await rpc("platform_set_org_active", { p_org: id, p_active: kind === "org-reactivate" }); what = kind === "org-suspend" ? "suspended workspace" : "reactivated workspace";
    } else if (kind === "org-delete") {
      ok = await rpc("platform_delete_org", { p_org: id, p_name: String(b.name || "") }); what = "deleted workspace";
    } else if (kind === "user-signout" || kind === "user-disable" || kind === "user-enable") {
      if (kind === "user-disable" && id === who.id) return [400, { error: "You can't disable your own login." }];
      ok = await rpc("platform_user_action", { p_user: id, p_action: kind.slice(5) }); what = { "user-signout": "signed out every session of", "user-disable": "disabled", "user-enable": "enabled" }[kind] + " login";
    } else if (kind === "user-resend") {
      const u = ((await rpc("auth_user_get", { p_id: id })) || [])[0];
      if (!u) return [404, { error: "No such login." }];
      if (u.email_confirmed_at) return [400, { error: "This email is already confirmed." }];
      if (!M.configured()) return [503, { error: "Email isn't set up on this site (SMTP_HOST, MAIL_FROM)." }];
      ok = await A.sendLink(req, u, "verify", u.encrypted_password);   // the link works with the password chosen at sign-up
      if (!ok) return [429, { error: "A link was sent less than a minute ago. Try again shortly." }];
      what = "re-sent the confirmation email to login";
    } else return [400, { error: "Unknown action." }];
    if (!ok) return [404, { error: "Not found (it may have been deleted already)." }];
    const label = String(b.label || "").replace(/\s+/g, " ").slice(0, 80);
    await D.logEvent("console", who.email + " " + what + " " + (label ? JSON.stringify(label) : id), { source: "admin", level: "info", org: kind.indexOf("org-") === 0 && kind !== "org-delete" ? id : null, detail: { kind, id, by: who.email } });
    return [200, { ok: true }];
  },
};

module.exports = D.logged("admin", async function handler(req, res) {
  const op = String((req.query && req.query.op) || "");
  if (!ops[op]) return D.send(res, 404, { error: "Unknown action." });
  if ((op === "action") !== (req.method === "POST")) return D.send(res, 405, { error: op === "action" ? "Use POST" : "Use GET" });
  let who;
  try { who = await adminOf(req); } catch (e) { return D.send(res, 503, { error: "The database server isn't answering." }); }
  if (!who) return D.send(res, 403, { error: admins().length ? "This page is for the Qlarity team." : "No platform admins yet: set SUPER_ADMIN_EMAILS in Vercel." });
  try {
    const [code, out] = await ops[op](req, body(req), who);
    D.send(res, code, out);
  } catch (e) {
    D.send(res, /name does not match/.test(String(e && e.message)) ? 400 : 500, { error: /name does not match/.test(String(e && e.message)) ? "The name doesn't match. Type the workspace name exactly." : String((e && e.message) || e).slice(0, 300) });
  }
});
module.exports.issuesOf = issuesOf;
