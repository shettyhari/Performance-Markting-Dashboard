// Google Ads API helpers (REST), shared by api/google.js (dashboard) and api/google-cron.js (every 30 minutes).
// Vercel › Settings › Environment Variables:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN   (OAuth client of the Google Cloud project that has Google Ads API access)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   optional: your manager (MCC) account id, digits only — used when an account is only reachable through it
//   GOOGLE_ADS_DEVELOPER_TOKEN     optional: sent when set (Google ignores it since Sept 2026; access follows the Cloud project)
//   GOOGLE_ADS_API_VERSION         optional, default v25
const DB = require("./_db");
const VER = process.env.GOOGLE_ADS_API_VERSION || "v25";
const BASE = "https://googleads.googleapis.com/" + VER;
const n = (v) => { const x = Number(v); return isFinite(x) ? x : 0; };
const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "");
/* platform OAuth client (env) + this workspace's refresh token (Settings › Data connections, kept in Vault) */
const configured = async () => !!(process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET && (await DB.orgSecret("google_refresh_token")));

const toks = {};   // cached access tokens per workspace for this warm function instance
async function accessToken() {
  const rt = await DB.orgSecret("google_refresh_token"), key = DB.currentOrg() || "";
  if (!rt) throw new Error("Google Ads isn't connected for this workspace (Settings › Data connections › Google Ads refresh token).");
  const tok = toks[key];
  if (tok && tok.rt === rt && tok.exp > Date.now() + 60000) return tok.v;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: process.env.GOOGLE_ADS_CLIENT_ID, client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: rt }).toString() });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b || !b.access_token) throw new Error("Google sign-in failed (" + r.status + "): " + ((b && (b.error_description || b.error)) || "no access token") + ". Check the Google Ads refresh token in Settings › Data connections.");
  toks[key] = { v: b.access_token, rt, exp: Date.now() + (n(b.expires_in) || 3000) * 1000 };
  return b.access_token;
}
function errText(b, status) {
  const e = b && (Array.isArray(b) ? b[0] && b[0].error : b.error) || {};
  const det = (e.details || []).map((d) => (d.errors || []).map((x) => (x.message || "") + (x.errorCode ? " [" + Object.values(x.errorCode).join("/") + "]" : "")).join("; ")).filter(Boolean).join("; ");
  return "Google Ads answered " + status + ": " + (det || e.message || "unknown error");
}
async function call(path, opt, loginId) {
  const h = { authorization: "Bearer " + await accessToken(), "content-type": "application/json" };
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) h["developer-token"] = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const lid = digits(loginId); if (lid) h["login-customer-id"] = lid;
  const r = await fetch(BASE + path, Object.assign({ headers: h }, opt || {}));
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errText(b, r.status));
  return b || {};
}
/* GAQL search with paging; via = the manager account to go through (login-customer-id), or "" for direct access */
async function search(customerId, query, via, maxPages) {
  let out = [], pageToken = "", pages = 0;
  do {
    const body = { query }; if (pageToken) body.pageToken = pageToken;
    const b = await call("/customers/" + digits(customerId) + "/googleAds:search", { method: "POST", body: JSON.stringify(body) }, via);
    out = out.concat(b.results || []); pageToken = b.nextPageToken || ""; pages++;
  } while (pageToken && pages < (maxPages || 20));
  return out;
}
const STATUS = { ENABLED: true };
/* every client account the signed-in Google user can reach: directly, or through any manager (MCC) account in its access, incl. agency MCCs */
async function listAccounts() {
  const acc = await call("/customers:listAccessibleCustomers", { method: "GET" });
  const ids = (acc.resourceNames || []).map((r) => digits(r.split("/")[1]));
  const found = {}, managers = [], errors = [];
  const envMcc = digits(await DB.orgSecret("google_login_customer_id"));
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await search(id, "SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.status FROM customer LIMIT 1", id, 1);
      const c = (r[0] || {}).customer || {};
      if (c.manager) managers.push({ id, name: c.descriptiveName || id });
      else found[id] = { id, name: c.descriptiveName || id, currency: c.currencyCode || "", active: !!STATUS[c.status], via: "", manager: "" };
    } catch (e) {
      // some accounts can only be read through a manager; try the one in Vercel
      if (envMcc && envMcc !== id) return; errors.push(id + ": " + e.message);
    }
  }));
  if (envMcc && !managers.some((m) => m.id === envMcc)) managers.push({ id: envMcc, name: "Manager " + envMcc });
  await Promise.all(managers.map(async (m) => {
    try {
      const r = await search(m.id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level <= 4", m.id, 5);
      r.forEach((x) => { const c = x.customerClient || {}, id = digits(c.id);
        if (!id || c.manager || found[id] && !found[id].via) return;   // direct access wins (no login-customer-id needed)
        found[id] = { id, name: c.descriptiveName || id, currency: c.currencyCode || "", active: !!STATUS[c.status], via: m.id, manager: m.name }; });
    } catch (e) { errors.push("manager " + m.id + ": " + e.message); }
  }));
  const list = Object.values(found).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  return { accounts: list, managers, errors };
}
/* one row per campaign per day (all campaign types incl. Performance Max): spend, conversions (= Google's "Conversions" column), impressions, clicks */
async function campaignDaily(customerId, via, from, to) {
  const q = "SELECT segments.date, campaign.id, campaign.name, campaign.advertising_channel_type, customer.descriptive_name, customer.currency_code, " +
    "metrics.cost_micros, metrics.conversions, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '" + from + "' AND '" + to + "'";
  const r = await search(customerId, q, via, 30);
  return r.map((x) => ({ date: (x.segments || {}).date, campaignId: String((x.campaign || {}).id || ""), campaign: (x.campaign || {}).name || "", type: (x.campaign || {}).advertisingChannelType || "",
    account: (x.customer || {}).descriptiveName || "", currency: (x.customer || {}).currencyCode || "INR",
    spend: Math.round(n((x.metrics || {}).costMicros) / 10000) / 100, conversions: Math.round(n((x.metrics || {}).conversions) * 100) / 100,
    impressions: n((x.metrics || {}).impressions), clicks: n((x.metrics || {}).clicks) }))
    .filter((x) => x.date && x.campaign && (x.spend > 0 || x.conversions > 0 || x.impressions > 0));
}
module.exports = { VER, configured, digits, accessToken, search, listAccounts, campaignDaily, n };
