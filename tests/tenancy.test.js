// Tests that one workspace can never read or write another's data through the server (api/_db.js and the endpoints that use it).
// Run: node tests/tenancy.test.js — no network: the database API and Meta are replaced by an in-memory fake that records every call.
const assert = require("assert");
process.env.API_URL = "https://db.test"; process.env.JWT_SECRET = "test-secret-" + "x".repeat(40);
const DB = require("../api/_db");

let passed = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const A = { id: "aaaaaaaa-0000-4000-8000-000000000001", public_id: "aaaa1111aaaa1111aa", name: "Alpha", crm_name: "TeleCRM", currency: "INR", tz_offset_min: 330, active: true };
const B = { id: "bbbbbbbb-0000-4000-8000-000000000002", public_id: "bbbb2222bbbb2222bb", name: "Beta", crm_name: "Zoho", currency: "AED", tz_offset_min: 240, active: true };
const KEY_A = "lp_push_" + "a".repeat(48), KEY_B_API = "lp_api_" + "b".repeat(48);
const SECRETS = { [A.id]: { meta_access_token: "TOKEN-A" }, [B.id]: { meta_access_token: "TOKEN-B" } };
let calls = [];
function fake(extra) {
  return async (url, opt) => {
    opt = opt || {}; const u = String(url), method = opt.method || "GET";
    calls.push({ url: u, method, headers: opt.headers || {}, body: opt.body });
    const json = (b, st) => ({ ok: (st || 200) < 400, status: st || 200, headers: { get: () => "0-0/7" }, text: async () => JSON.stringify(b), json: async () => b });
    if (extra) { const r = await extra(u, opt, json); if (r) return r; }
    const path = decodeURIComponent(u.split("/rest/v1/")[1] || ""), table = path.split("?")[0];
    if (table === "rpc/get_org_secret") { const b = JSON.parse(opt.body); await new Promise((r) => setTimeout(r, b.p_org === A.id ? 30 : 5)); return json((SECRETS[b.p_org] || {})[b.p_key] || ""); }
    if (table === "organizations") return json([A, B].filter((o) => path.indexOf(o.id) >= 0 || path.indexOf(o.public_id) >= 0));
    if (table === "org_api_keys") return json(path.indexOf(DB.sha256(KEY_A)) >= 0 ? [{ org_id: A.id, kind: "crm_push" }] : path.indexOf(DB.sha256(KEY_B_API)) >= 0 ? [{ org_id: B.id, kind: "api" }] : []);
    if (table === "uploads" && method === "POST") return json([{ id: 7 }]);
    if (table === "org_settings") return json([{ settings: path.indexOf(A.id) >= 0 ? { brands: ["A1"], tracking: { enabled: true, domains: ["alpha.com"] } } : { brands: ["B1"], tracking: { enabled: true, domains: ["beta.com"] } } }]);
    return json([]);
  };
}

test("reads, updates and deletes are filtered to the current workspace; a forged org_id filter is replaced", () => {
  assert.strictEqual(DB.scopePath("crm_leads?select=lead_id&brand=eq.X", "GET", A.id), "crm_leads?select=lead_id&brand=eq.X&org_id=eq." + A.id);
  assert.strictEqual(DB.scopePath("crm_leads?select=*&org_id=eq." + B.id, "GET", A.id), "crm_leads?select=*&org_id=eq." + A.id);
  assert.strictEqual(DB.scopePath("alert_issues?key=eq.k", "PATCH", A.id), "alert_issues?key=eq.k&org_id=eq." + A.id);
  assert.strictEqual(DB.scopePath("meta_ad_rows?day=gte.2026-01-01", "DELETE", A.id), "meta_ad_rows?day=gte.2026-01-01&org_id=eq." + A.id);
  assert.strictEqual(DB.scopePath("uploads", "GET", A.id), "uploads?org_id=eq." + A.id);
});
test("inserts carry the current workspace (overwriting any org_id sent) and on_conflict keys get org_id first", () => {
  assert.strictEqual(DB.scopePath("crm_leads?on_conflict=lead_id", "POST", A.id), "crm_leads?on_conflict=" + encodeURIComponent("org_id,lead_id"));
  assert.strictEqual(DB.scopePath("x?on_conflict=" + encodeURIComponent("org_id,k"), "POST", A.id), "x?on_conflict=" + encodeURIComponent("org_id,k"));
  const b = JSON.parse(DB.scopeBody(JSON.stringify([{ lead_id: "1", org_id: B.id }, { lead_id: "2" }]), A.id));
  assert.ok(b.every((r) => r.org_id === A.id));
});
test("no workspace selected → the server refuses to touch data tables", async () => {
  global.fetch = fake(); calls = [];
  await assert.rejects(() => DB.sbFetch("crm_leads?select=*"), /No workspace/);
  assert.strictEqual(calls.length, 0);
});
test("two requests at the same time keep their own workspace and token (AsyncLocalStorage)", async () => {
  global.fetch = fake(); calls = [];
  const [ra, rb] = await Promise.all([
    DB.withOrg(A, async () => { const t = await DB.orgSecret("meta_access_token"); await DB.sbFetch("crm_leads?select=*"); return { t, org: DB.currentOrg(), cur: DB.cur(), crm: DB.crm() }; }),
    DB.withOrg(B, async () => { const t = await DB.orgSecret("meta_access_token"); await DB.sbFetch("crm_leads?select=*"); return { t, org: DB.currentOrg(), cur: DB.cur(), crm: DB.crm() }; })]);
  assert.deepStrictEqual(ra, { t: "TOKEN-A", org: A.id, cur: "₹", crm: "TeleCRM" });
  assert.deepStrictEqual(rb, { t: "TOKEN-B", org: B.id, cur: "AED ", crm: "Zoho" });
  const reads = calls.filter((c) => c.url.indexOf("crm_leads") >= 0);
  assert.ok(reads.some((c) => c.url.indexOf("org_id=eq." + A.id) >= 0 && c.headers["x-org-id"] === A.id));
  assert.ok(reads.some((c) => c.url.indexOf("org_id=eq." + B.id) >= 0 && c.headers["x-org-id"] === B.id));
});
test("workspace time: dates follow each workspace's time zone", async () => {
  const a = await DB.withOrg(A, async () => DB.tzLabel()), b = await DB.withOrg(B, async () => DB.tzLabel());
  assert.strictEqual(a, "IST"); assert.strictEqual(b, "UTC+4");
});
test("machine keys: a push key opens only its workspace; an API key isn't accepted as a push key; revoked/unknown keys fail", async () => {
  global.fetch = fake();
  assert.strictEqual((await DB.orgFromKey(KEY_A, "crm_push")).id, A.id);
  assert.strictEqual(await DB.orgFromKey(KEY_B_API, "crm_push"), null);
  assert.strictEqual((await DB.orgFromKey(KEY_B_API, "api")).id, B.id);
  assert.strictEqual(await DB.orgFromKey("lp_push_" + "z".repeat(48), "crm_push"), null);
});
test("CRM push with workspace A's key writes only to workspace A", async () => {
  global.fetch = fake(); calls = [];
  const H = require("../api/crm-push"), out = {};
  const res = { statusCode: 0, setHeader() {}, end(b) { out.status = this.statusCode; out.body = JSON.parse(b); } };
  await H({ method: "POST", headers: { "x-push-key": KEY_A }, body: [{ "Lead id": "L1", "Created On": "2026-10-01 10:00:00", Status: "New" }], query: {} }, res);
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const writes = calls.filter((c) => c.url.indexOf("/rest/v1/") > 0 && c.url.indexOf("/rest/v1/org_api_keys") < 0 && c.url.indexOf("/rest/v1/organizations") < 0);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((c) => c.headers["x-org-id"] === A.id), "every call carries workspace A");
  assert.ok(!calls.some((c) => (c.url + (c.body || "")).indexOf(B.id) >= 0), "workspace B never touched");
  const ins = calls.filter((c) => c.method === "POST" && c.url.indexOf("crm_leads") >= 0)[0];
  assert.ok(JSON.parse(ins.body).every((r) => r.org_id === A.id));
});
test("tracking collector: a site listed by workspace B is refused for workspace A's id", async () => {
  global.fetch = fake();
  const C = require("../api/collect");
  const call = async (pid, origin) => { const out = {}; const res = { statusCode: 0, setHeader() {}, end() { out.status = this.statusCode; } };
    await C({ method: "POST", headers: { origin }, body: JSON.stringify({ o: pid, v: "abcdefghijkl12", k: "touch" }), query: {} }, res); return out.status; };
  assert.strictEqual(await call(A.public_id, "https://www.beta.com"), 403);
  assert.strictEqual(await call(A.public_id, "https://www.alpha.com"), 200);
  assert.strictEqual(await call("ffff0000ffff0000ff", "https://www.alpha.com"), 404);
});
test("sign-in: membership needs the workspace header; pending invites count only for a proven email", async () => {
  const UID = "cccccccc-0000-4000-8000-00000000000c";
  const user = { id: UID, email: "x@a.com", email_confirmed_at: "2026-01-01", confirmation_sent_at: null, invited_at: null, token_version: 0, raw_user_meta_data: {} };
  global.fetch = fake(async (u, opt, json) => {
    if (u.indexOf("/rest/v1/rpc/auth_user_get") > 0) { assert.ok(/^Bearer /.test(opt.headers.authorization)); return json(JSON.parse(opt.body).p_id === UID ? [user] : []); }
    if (u.indexOf("/rest/v1/org_members") > 0) return json([{ role: "admin", user_id: null, email: "x@a.com" }]);
    return null;
  });
  let tok = DB.jwtSign({ sub: UID, role: "authenticated", email: "x@a.com", tv: 0 }, 3600);
  const req = (org) => ({ headers: { authorization: "Bearer " + tok, "x-org-id": org || "" }, query: {} });
  assert.strictEqual((await DB.auth({ headers: {}, query: {} })).status, 401, "no token");
  assert.strictEqual((await DB.auth(req())).status, 400);
  const good = tok;
  tok = good.slice(0, -2) + (good.slice(-2) === "AA" ? "BB" : "AA");
  assert.strictEqual((await DB.auth(req(A.id))).status, 401, "tampered signature");
  tok = DB.jwtSign({ sub: UID, role: "authenticated", tv: 0 }, -10);
  assert.strictEqual((await DB.auth(req(A.id))).status, 401, "expired");
  tok = DB.jwtSign({ sub: UID, role: "service_role", tv: 0 }, 3600);
  assert.strictEqual((await DB.auth(req(A.id))).status, 401, "a non-user role isn't a sign-in");
  user.token_version = 1; tok = good;
  assert.strictEqual((await DB.auth(req(A.id))).status, 401, "password changed since: old sessions end");
  user.token_version = 0;
  assert.strictEqual((await DB.auth(req(A.id))).status, 403, "auto-confirmed email can't claim an invite");
  user.confirmation_sent_at = "2026-01-01";
  const ok = await DB.auth(req(A.id));
  assert.strictEqual(ok.role, "admin"); assert.strictEqual(ok.org.id, A.id);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + "\n   " + (e && e.stack || e)); }
  }
  console.log("\n" + passed + "/" + tests.length + " passed");
  if (passed !== tests.length) process.exit(1);
})();
