// Tests for the attribution suite (api/_suite.js, _capi.js, _mcp.js, collect.js).
// Run: node tests/suite.test.js — no network, no real data: the database API and Meta are replaced by an in-memory fake fetch.
const assert = require("assert");
process.env.API_URL = "https://db.test"; process.env.JWT_SECRET = "test-secret-" + "x".repeat(40);
const DB = require("../api/_db");
const ORG = { id: "00000000-0000-4000-8000-0000000000aa", public_id: "abcdef012345abcdef", name: "Test Co", crm_name: "TeleCRM", currency: "INR", tz_offset_min: 330, active: true };
const API_KEY = "lp_api_" + "t".repeat(40);
const U = require("../api/_suite");

let passed = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const d = (o) => U.istDay(o);

/* ---------- fixture ---------- */
const S0 = { brands: ["Nexus", "Coastal"], keywords: [["nexus", "Nexus"], ["coastal", "Coastal"]], excludedCampaigns: ["Nexus | Traffic"] };
const META = [
  { brand: "Nexus", campaign: "Nexus | Leads", adset: "", ad: "", day: d(-2), spend: 1000, results: 10, result_indicator: "actions:lead", impressions: 10000, clicks: 100 },
  { brand: "Nexus", campaign: "Nexus | Leads", adset: "", ad: "", day: d(-1), spend: 1000, results: 10, result_indicator: "actions:lead", impressions: 10000, clicks: 100 },
  { brand: "Nexus", campaign: "Nexus | Traffic", adset: "", ad: "", day: d(-1), spend: 500, results: 300, result_indicator: "actions:landing_page_view", impressions: 9000, clicks: 300 },
  { brand: "Coastal", campaign: "Coastal | Form", adset: "", ad: "", day: d(-1), spend: 600, results: 0, result_indicator: "actions:lead", impressions: 5000, clicks: 50 },
  { brand: "Unmapped", campaign: "Misc test", adset: "", ad: "", day: d(-1), spend: 300, results: 3, result_indicator: "actions:lead", impressions: 1000, clicks: 10 }];
const ts = (o, hh) => d(o) + " " + (hh || "10:00:00");
const LEADS = [
  { lead_id: "L1", created_on: ts(-1), lead_source: "Facebook", campaign: "Nexus | Leads", status: "Interested", brand: "Nexus", is_ql: true, phone: "+91 98765 43210", email: "a@x.com", fb_lead_id: "1234567890" },
  { lead_id: "L2", created_on: ts(-1), lead_source: "Facebook", campaign: "Nexus | Leads", status: "Booked", brand: "Nexus", is_ql: true, phone: "9000000002", email: "", fb_lead_id: "" },
  { lead_id: "L3", created_on: ts(-2), lead_source: "Website", campaign: "", status: "New Lead", brand: "Nexus", is_ql: false, phone: "9000000003", email: "", fb_lead_id: "" },
  { lead_id: "L4", created_on: ts(-1), lead_source: "WhatsApp", campaign: "", status: "Not interested", brand: "Coastal", is_ql: false, phone: "", email: "", fb_lead_id: "" }];
const IDS = [{ vid: "visitor0000001", key_type: "ph", key_hash: U.phHash("9000000003") }];
const EVENTS = [
  { vid: "visitor0000001", at: new Date(Date.parse(ts(-3).replace(" ", "T") + "+05:30")).toISOString(), kind: "touch", channel: "ChatGPT", source: "", medium: "", campaign: "", path: "/", host: "nexus.example", fbclid: "", gclid: "" },
  { vid: "visitor0000001", at: new Date(Date.parse(ts(-2, "09:00:00").replace(" ", "T") + "+05:30")).toISOString(), kind: "touch", channel: "Meta Ads", source: "facebook", medium: "paid", campaign: "Nexus | Leads", path: "/offer", host: "nexus.example", fbclid: "IwAR123", gclid: "" }];

let posted = {}, metaCalls = [];
function fakeFetch(S) {
  return async (url, opt) => {
    const u = String(url), method = (opt && opt.method) || "GET";
    const json = (b, st) => ({ ok: (st || 200) < 400, status: st || 200, headers: { get: () => null }, text: async () => JSON.stringify(b), json: async () => b });
    if (u.indexOf("graph.facebook.com") >= 0) { metaCalls.push({ url: u, body: JSON.parse(opt.body) }); return json({ events_received: JSON.parse(opt.body).data.length, fbtrace_id: "TR" }); }
    const path = u.split("/rest/v1/")[1] || "", table = path.split("?")[0];
    if (method !== "GET" && method !== "HEAD" && table.indexOf("rpc/") !== 0) { (posted[table] = posted[table] || []).push(JSON.parse(opt.body)); return json(null); }
    if (table === "org_settings") return json([{ settings: S }]);
    if (table === "organizations") return json([ORG]);
    if (table === "org_api_keys") return json(path.indexOf(DB.sha256(API_KEY)) >= 0 ? [{ org_id: ORG.id, kind: "api" }] : []);
    if (table === "rpc/get_org_secret") return json(JSON.parse(opt.body).p_key === "meta_capi_token" ? "capi" : "");
    if (table === "meta_ad_rows") return json(META);
    if (table === "google_ad_rows") return json([]);
    if (table === "crm_leads") return json(LEADS);
    if (table === "web_identities") return json(IDS.filter((r) => decodeURIComponent(path).indexOf(r.key_hash) >= 0));
    if (table === "web_events") return json(EVENTS);
    if (table === "capi_events") return json([]);
    return json([]);
  };
}

/* ---------- tests ---------- */
test("performance: CPL / CPQL from summed totals, excluded campaign's results left out but its spend kept, Unmapped outside the total", async () => {
  global.fetch = fakeFetch(S0);
  const P = await U.performance(S0, { from: d(-7), to: d(0) });
  const nat = P.brands.filter((b) => b.brand === "Nexus")[0];
  assert.strictEqual(nat.spend, 2500); assert.strictEqual(nat.metaLeads, 20); assert.strictEqual(nat.cpl, 125);
  assert.strictEqual(nat.crm, 3); assert.strictEqual(nat.ql, 2); assert.strictEqual(nat.cpql, 1250);
  assert.strictEqual(P.total.spend, 3100, "total = listed brands only"); assert.strictEqual(P.outsideListedBrands.filter((b) => b.brand === "Unmapped")[0].spend, 300);
  const car = P.brands.filter((b) => b.brand === "Coastal")[0];
  assert.strictEqual(car.cpl, null, "0 Meta leads → N/A, never 0"); assert.strictEqual(car.cpql, null);
});
test("sales: N/A until a status is ticked; with values, est. revenue and ROAS; a brand without a value → N/A", async () => {
  global.fetch = fakeFetch(S0);
  let P = await U.performance(S0, { from: d(-7), to: d(0) });
  assert.strictEqual(P.salesConfigured, false); assert.strictEqual(P.brands[0].won, null); assert.strictEqual(P.brands[0].costPerSale, null);
  const S = Object.assign({}, S0, { wonStatuses: ["booked"], dealValue: { Nexus: 50000 } });
  global.fetch = fakeFetch(S);
  P = await U.performance(S, { from: d(-7), to: d(0) });
  const nat = P.brands.filter((b) => b.brand === "Nexus")[0];
  assert.strictEqual(nat.won, 1); assert.strictEqual(nat.costPerSale, 2500); assert.strictEqual(nat.estRevenue, 50000); assert.strictEqual(nat.estRoas, 20);
  const car = P.brands.filter((b) => b.brand === "Coastal")[0];
  assert.strictEqual(car.won, 0); assert.strictEqual(car.estRevenue, 0, "0 sales with values configured = 0 revenue");
  assert.strictEqual(P.total.estRevenue, 50000);
});
test("channels: click ids, AI engines, search, social, email, direct", () => {
  assert.strictEqual(U.channelOf({ fbclid: "x" }), "Meta Ads");
  assert.strictEqual(U.channelOf({ gclid: "x" }), "Google Ads");
  assert.strictEqual(U.channelOf({ referrer: "chatgpt.com" }), "ChatGPT");
  assert.strictEqual(U.channelOf({ source: "chatgpt.com" }), "ChatGPT");
  assert.strictEqual(U.channelOf({ referrer: "www.perplexity.ai" }), "Perplexity");
  assert.strictEqual(U.channelOf({ referrer: "gemini.google.com" }), "Gemini");
  assert.strictEqual(U.channelOf({ referrer: "www.google.co.in" }), "Organic search");
  assert.strictEqual(U.channelOf({ referrer: "l.instagram.com" }), "Organic social");
  assert.strictEqual(U.channelOf({ source: "facebook", medium: "paid" }), "Meta Ads");
  assert.strictEqual(U.channelOf({ source: "newsletter", medium: "email" }), "Email");
  assert.strictEqual(U.channelOf({}), "Direct");
});
test("attribution models: credit always adds up to one lead", () => {
  const t = [{ at: 0 }, { at: 864e5 }, { at: 3 * 864e5 }];
  ["first", "last", "linear", "position", "decay"].forEach((m) => {
    const c = U.credits(t, m, 4 * 864e5); assert.ok(Math.abs(c.reduce((a, b) => a + b, 0) - 1) < 1e-9, m);
  });
  assert.deepStrictEqual(U.credits(t, "first", 0), [1, 0, 0]); assert.deepStrictEqual(U.credits(t, "position", 0).map((x) => Math.round(x * 100)), [40, 20, 40]);
});
test("attribution: website journey joined by phone; first click credits ChatGPT, last click the Meta ad; totals = leads", async () => {
  global.fetch = fakeFetch(S0);
  const first = await U.attribution(S0, { from: d(-7), to: d(0), model: "first" });
  const last = await U.attribution(S0, { from: d(-7), to: d(0), model: "last" });
  assert.strictEqual(first.leadsWithWebJourney, 1);
  const sum = (A) => A.rows.reduce((s, r) => s + r.leads, 0);
  assert.strictEqual(Math.round(sum(first)), 4); assert.strictEqual(Math.round(sum(last)), 4);
  assert.ok(first.rows.some((r) => r.channel === "ChatGPT" && r.leads === 1 && r.aiSearch));
  assert.ok(!last.rows.some((r) => r.channel === "ChatGPT"));
  assert.ok(last.rows.some((r) => r.channel === "WhatsApp (no campaign)"));
  const meta = last.rows.filter((r) => r.channel === "Meta Ads")[0];
  assert.strictEqual(meta.spend, 2500 + 600, "Meta spend = listed brands only (Unmapped left out, like every total)");
});
test("Conversions API: QL + sale sent once with hashed keys, lead id and fbc; no dataset → skipped with reason", async () => {
  const S = Object.assign({}, S0, { wonStatuses: ["booked"], capi: { enabled: true, since: d(-30), datasets: { Nexus: "111" } } });
  global.fetch = fakeFetch(S); posted = {}; metaCalls = [];
  const r = await require("../api/_capi").run(S);
  assert.strictEqual(metaCalls.length, 1); const evs = metaCalls[0].body.data;
  assert.ok(metaCalls[0].url.indexOf("/111/events") > 0);
  assert.deepStrictEqual(evs.map((e) => e.event_id).sort(), ["L1-ql", "L2-ql", "L2-won"]);
  const e1 = evs.filter((e) => e.event_id === "L1-ql")[0];
  assert.strictEqual(e1.user_data.lead_id, "1234567890"); assert.strictEqual(e1.user_data.ph[0], U.phHash("9876543210")); assert.ok(!/9876543210/.test(JSON.stringify(e1)), "no raw phone");
  assert.strictEqual(e1.action_source, "system_generated"); assert.strictEqual(e1.custom_data.event_source, "crm");
  assert.strictEqual(r.sent, 3);
});
test("MCP: initialize, tools/list, auth required", async () => {
  global.fetch = fakeFetch(S0);
  const MCP = require("../api/_mcp");
  const call = async (body, auth) => { const out = {}; const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { out.body = b ? JSON.parse(b) : null; out.status = this.statusCode; } };
    await MCP.handle({ method: "POST", headers: auth === false ? {} : { authorization: "Bearer " + API_KEY }, body, query: {} }, res); return out; };
  assert.strictEqual((await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, false)).status, 401);
  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.strictEqual(init.body.result.protocolVersion, "2025-06-18");
  const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.body.result.tools.some((t) => t.name === "brand_performance"));
  const note = await call({ jsonrpc: "2.0", method: "notifications/initialized" }); assert.strictEqual(note.status, 202);
});
test("collector: only listed sites; phone stored as a hash, never raw", async () => {
  const S = Object.assign({}, S0, { tracking: { enabled: true, domains: ["nexus.example"] } });
  global.fetch = fakeFetch(S); posted = {};
  Object.keys(require.cache).forEach((k) => { if (/[\\/]api[\\/]/.test(k)) delete require.cache[k]; });   // fresh settings cache
  const C = require("../api/collect");
  const call = async (origin, body) => { const out = {}; const res = { statusCode: 0, setHeader() {}, end(b) { out.status = this.statusCode; out.body = b; } };
    await C({ method: "POST", headers: { origin }, body: JSON.stringify(Object.assign({ o: ORG.public_id }, body)), query: {} }, res); return out; };
  assert.strictEqual((await call("https://evil.example", { v: "abcdefghijkl12", k: "touch" })).status, 403);
  assert.strictEqual((await call("https://www.nexus.example", { v: "abcdefghijkl12", k: "form", ph: "98765 43210" })).status, 200);
  assert.ok(posted.web_identities && posted.web_identities[0][0].key_hash === U.phHash("9876543210"));
  assert.ok(!/98765/.test(JSON.stringify(posted)), "raw phone never stored");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await DB.withOrg(ORG, fn); passed++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + "\n   " + e.message); }
  }
  console.log("\n" + passed + "/" + tests.length + " passed");
  if (passed !== tests.length) process.exit(1);
})();
