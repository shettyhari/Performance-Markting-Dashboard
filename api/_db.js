// Shared server core for a multi-company deployment.
// Every request works on exactly one workspace (organization). withOrg(org, fn) puts it in an AsyncLocalStorage context, so
// sbFetch() below always reads and writes that workspace only, even when one function instance serves several requests at once:
//   reads / updates / deletes get "org_id=eq.<org>" added, inserts get org_id set, on_conflict keys get org_id in front,
//   and every call sends the x-org-id header the database functions read (private.current_org()).
// Tokens per workspace (Meta, Conversions API, audiences, Google) come from the database vault through orgSecret(key).
// The database is reached through PostgREST on the API server (API_URL); calls carry a short-lived service_role JWT signed with
// JWT_SECRET (the secret PostgREST checks). Sign-in tokens are JWTs signed with the same secret by api/auth.js.
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const als = new AsyncLocalStorage();

const API_URL = () => String(process.env.API_URL || "").replace(/\/+$/, "");
const JWT_SECRET = () => process.env.JWT_SECRET || "";
const GLOBAL = new Set(["organizations", "org_api_keys", "app_config"]);   // tables without workspace scoping (looked up by id / hash only)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_COLS = "id,public_id,name,logo,currency,tz_offset_min,crm_name,active";

function send(res, code, body, headers) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  Object.keys(headers || {}).forEach((k) => res.setHeader(k, headers[k]));
  res.end(JSON.stringify(body));
}
function same(a, b) {
  const x = crypto.createHash("sha256").update(String(a || "")).digest(), y = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(x, y);
}
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ---------- workspace context ---------- */
const ctx = () => als.getStore() || null;
const currentOrg = () => { const c = ctx(); return c && c.org ? c.org.id : null; };
const org = () => { const c = ctx(); if (!c || !c.org) throw new Error("No workspace selected."); return c.org; };
function withOrg(o, fn) { return als.run({ org: o, secrets: {}, settings: null }, fn); }

/* ---------- tokens (HS256 JWT, Node crypto only) ---------- */
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function jwtSign(claims, ttlSec) {
  const now = Math.floor(Date.now() / 1000), body = Object.assign({ iat: now, exp: now + (ttlSec || 3600) }, claims);
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64u(JSON.stringify(body));
  return head + "." + b64u(crypto.createHmac("sha256", JWT_SECRET()).update(head).digest());
}
/* the claims of a valid, unexpired token signed with JWT_SECRET, else null */
function jwtVerify(tok) {
  const p = String(tok || "").split("."); if (p.length !== 3 || !JWT_SECRET()) return null;
  const sig = b64u(crypto.createHmac("sha256", JWT_SECRET()).update(p[0] + "." + p[1]).digest());
  if (sig.length !== p[2].length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(p[2]))) return null;
  let h, c; try { h = JSON.parse(Buffer.from(p[0], "base64").toString()); c = JSON.parse(Buffer.from(p[1], "base64").toString()); } catch (e) { return null; }
  if (!h || h.alg !== "HS256" || !c || typeof c.exp !== "number" || c.exp * 1000 < Date.now()) return null;
  return c;
}
let svcTok = { t: "", until: 0 };
/* service_role token for the server's own calls, renewed every few minutes */
function svc() {
  if (svcTok.until < Date.now()) svcTok = { t: jwtSign({ role: "service_role" }, 600), until: Date.now() + 300000 };
  return svcTok.t;
}

/* ---------- database ---------- */
async function parse(r) {
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) throw new Error("Database answered " + r.status + ": " + String((b && (b.message || b.error)) || t).slice(0, 300));
  return b;
}
/* service-role call with no workspace scoping (global tables, cross-workspace lookups) */
function raw(path, opt) {
  opt = Object.assign({}, opt || {});
  if (!API_URL() || !JWT_SECRET()) return Promise.reject(new Error("API_URL and JWT_SECRET are not set on this site yet."));
  opt.headers = Object.assign({ authorization: "Bearer " + svc(), "content-type": "application/json" }, opt.headers || {});
  return fetch(API_URL() + "/rest/v1/" + path, opt).then(parse);
}
/* path rewrite for the current workspace (exported for tests) */
function scopePath(path, method, orgId) {
  const i = path.indexOf("?"), table = (i < 0 ? path : path.slice(0, i)), q = i < 0 ? "" : path.slice(i + 1);
  if (table.indexOf("rpc/") === 0 || GLOBAL.has(table)) return path;
  let params = q ? q.split("&") : [];
  params = params.map((p) => { if (p.indexOf("on_conflict=") !== 0) return p; const v = decodeURIComponent(p.slice(12)); return /(^|,)org_id(,|$)/.test(v) ? p : "on_conflict=" + encodeURIComponent("org_id," + v); });
  if (method !== "POST") params = params.filter((p) => p.indexOf("org_id=") !== 0).concat(["org_id=eq." + orgId]);
  return table + (params.length ? "?" + params.join("&") : "");
}
function scopeBody(body, orgId) {
  if (typeof body !== "string" || !body) return body;
  let b; try { b = JSON.parse(body); } catch (e) { return body; }
  const set = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.assign({}, o, { org_id: orgId }) : o);
  return JSON.stringify(Array.isArray(b) ? b.map(set) : set(b));
}
function sbFetch(path, opt) {
  opt = Object.assign({}, opt || {});
  const method = String(opt.method || "GET").toUpperCase(), table = path.split("?")[0];
  if (GLOBAL.has(table)) return raw(path, opt);
  const o = currentOrg(); if (!o) return Promise.reject(new Error("No workspace selected for " + table + "."));
  opt.headers = Object.assign({ "x-org-id": o }, opt.headers || {});
  const p = scopePath(path, method, o);
  if (method === "POST" && table.indexOf("rpc/") !== 0) opt.body = scopeBody(opt.body, o);
  return raw(p, opt);
}
async function sbAll(path, cap) {
  let out = [];
  for (let off = 0; off < (cap || 100000); off += 1000) {
    const rows = await sbFetch(path, { headers: { range: off + "-" + (off + 999), "range-unit": "items" } });
    out = out.concat(rows || []);
    if (!rows || rows.length < 1000) break;
  }
  return out;
}
/* row count of a filtered select in the current workspace */
async function sbCount(path) {
  const o = currentOrg(), p = scopePath(path, "HEAD", o);
  const r = await fetch(API_URL() + "/rest/v1/" + p, { method: "HEAD", headers: { authorization: "Bearer " + svc(), prefer: "count=exact", "x-org-id": o } });
  return Number(String(r.headers.get("content-range") || "").split("/")[1]) || 0;
}

/* ---------- workspace lookups ---------- */
async function orgById(id) {
  if (!UUID.test(String(id || ""))) return null;
  const r = await raw("organizations?select=" + ORG_COLS + "&id=eq." + id + "&active=is.true");
  return r && r[0] ? r[0] : null;
}
async function orgByPublicId(pid) {
  if (!/^[0-9a-f]{8,40}$/i.test(String(pid || ""))) return null;
  const r = await raw("organizations?select=" + ORG_COLS + "&public_id=eq." + pid + "&active=is.true");
  return r && r[0] ? r[0] : null;
}
/* machine key (CRM push / API) → its workspace, or null */
async function orgFromKey(key, kind) {
  const k = String(key || "").trim(); if (k.length < 24) return null;
  const r = await raw("org_api_keys?select=org_id,kind&key_hash=eq." + sha256(k) + "&revoked_at=is.null&limit=1");
  if (!r || !r[0] || (kind && r[0].kind !== kind)) return null;
  return orgById(r[0].org_id);
}
const bearer = (req) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

/* the person behind a sign-in token (still valid: account exists, password not changed since), with their email flags; else null */
async function signedIn(req) {
  const c = jwtVerify(bearer(req));
  if (!c || c.role !== "authenticated" || !UUID.test(String(c.sub || ""))) return null;
  const r = await raw("rpc/auth_user_get", { method: "POST", body: JSON.stringify({ p_id: c.sub }) });
  const u = r && r[0];
  if (!u || Number(u.token_version) !== Number(c.tv || 0)) return null;
  return { id: u.id, email: String(u.email || "").toLowerCase(), name: (u.raw_user_meta_data && u.raw_user_meta_data.full_name) || "",
    email_confirmed_at: u.email_confirmed_at, confirmation_sent_at: u.confirmation_sent_at, invited_at: u.invited_at, token_version: u.token_version };
}
/* the signed-in person and their role in the workspace named by the x-org-id header */
async function auth(req) {
  const user = await signedIn(req);
  if (!user) return { status: 401, error: bearer(req) ? "Sign in again." : "Sign in first." };
  const email = user.email;
  const proven = !!user.email_confirmed_at && !!(user.confirmation_sent_at || user.invited_at);
  const want = String(req.headers["x-org-id"] || (req.query && req.query.org) || "");
  if (!UUID.test(want)) return { status: 400, error: "No workspace selected." };
  const rows = await raw("org_members?select=role,is_owner,user_id,email&org_id=eq." + want + "&or=" + encodeURIComponent("(user_id.eq." + user.id + ",email.eq." + email + ")"));
  const m = (rows || []).filter((r) => r.user_id === user.id || (!r.user_id && r.email === email && proven))[0];
  if (!m) return { status: 403, error: "You're not a member of this workspace." };
  const o = await orgById(want);
  if (!o) return { status: 403, error: "This workspace isn't active." };
  return { email, userId: user.id, role: m.role, owner: m.role === "admin" && m.is_owner === true, org: o };
}
/* scheduler: CRON_SECRET header (ec2/fanout.sh), or a database cron key */
async function cronAllowed(req) {
  const secret = process.env.CRON_SECRET || "", given = String(req.headers["x-cron-secret"] || bearer(req));
  if (secret && given && same(given, secret)) return true;
  const k = req.headers["x-cron-key"];
  if (!k || String(k).length < 32) return false;
  try { return (await raw("rpc/cron_key_ok", { method: "POST", body: JSON.stringify({ k: String(k) }) })) === true; } catch (e) { return false; }
}

/* ---------- per-workspace settings and tokens ---------- */
async function orgSettings(fresh) {
  const c = ctx(); if (c && c.settings && !fresh) return c.settings;
  const r = await sbFetch("org_settings?select=settings,updated_at");
  const S = (r && r[0] && r[0].settings) || {};
  if (c) { c.settings = S; c.settingsAt = r && r[0] ? r[0].updated_at : null; }
  return S;
}
const settingsUpdatedAt = () => { const c = ctx(); return c ? c.settingsAt : null; };
const ENV_FALLBACK = { meta_access_token: "META_ACCESS_TOKEN", meta_capi_token: "META_CAPI_TOKEN", meta_audience_token: "META_AUDIENCE_TOKEN", google_refresh_token: "GOOGLE_ADS_REFRESH_TOKEN", google_login_customer_id: "GOOGLE_ADS_LOGIN_CUSTOMER_ID" };
async function orgSecret(key) {
  const c = ctx(); if (!c || !c.org) return "";
  if (key in c.secrets) return c.secrets[key];
  let v = "";
  try { v = (await raw("rpc/get_org_secret", { method: "POST", body: JSON.stringify({ p_org: c.org.id, p_key: key }) })) || ""; } catch (e) { v = ""; }
  if (!v && process.env.APP_SINGLE_ORG === "1" && ENV_FALLBACK[key]) v = process.env[ENV_FALLBACK[key]] || "";   // one-company deployments may keep env tokens
  c.secrets[key] = String(v || "");
  return c.secrets[key];
}

/* ---------- workspace time, money and names ---------- */
const tzMin = () => { const c = ctx(); const m = c && c.org ? Number(c.org.tz_offset_min) : 330; return isFinite(m) ? m : 330; };
const tzMs = () => tzMin() * 60000;
const orgNow = () => Date.now() + tzMs();                 // wall-clock of the workspace, as a UTC timestamp
const orgDay = (off) => new Date(orgNow() + (off || 0) * 864e5).toISOString().slice(0, 10);
const tzLabel = () => { const m = tzMin(); if (m === 330) return "IST"; const s = m < 0 ? "-" : "+", a = Math.abs(m); return "UTC" + s + Math.floor(a / 60) + (a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""); };
const SYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£", AED: "AED ", SAR: "SAR ", SGD: "S$", AUD: "A$", CAD: "C$" };
const currency = () => { const c = ctx(); return (c && c.org && c.org.currency) || "INR"; };
const cur = () => SYM[currency()] || currency() + " ";
const locale = () => (currency() === "INR" ? "en-IN" : "en-US");
const crm = () => { const c = ctx(); return (c && c.org && c.org.crm_name) || "CRM"; };
const orgName = () => { const c = ctx(); return (c && c.org && c.org.name) || (process.env.APP_NAME || "Qlarity"); };
const CC = { INR: "91", AED: "971", SAR: "966", USD: "1", CAD: "1", GBP: "44", EUR: "", AUD: "61", SGD: "65" };
/* phone country code for hashing numbers saved without one (Settings › Attribution & sync › phone country code, else from the currency) */
const phoneCC = () => { const c = ctx(), s = c && c.settings; return String((s && s.phoneCountryCode) || CC[currency()] || "91").replace(/\D+/g, ""); };
const appUrl = (req) => (process.env.APP_URL || (req && req.headers && req.headers.host ? "https://" + req.headers.host : "")).replace(/\/+$/, "");

module.exports = { send, same, sha256, raw, sbFetch, sbAll, sbCount, scopePath, scopeBody, withOrg, currentOrg, org, orgById, orgByPublicId, orgFromKey, bearer, auth, signedIn, jwtSign, jwtVerify,
  cronAllowed, orgSettings, settingsUpdatedAt, orgSecret, tzMin, tzMs, orgNow, orgDay, tzLabel, cur, currency, locale, crm, orgName, appUrl, phoneCC, UUID, API_URL };
