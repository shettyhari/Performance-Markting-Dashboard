// CEO console test: api/admin.js + db/30-platform.sql in PGlite, with PostgREST imitated (JWT → role; rpc/<fn>; the two platform
// tables) and the mailer replaced by a list. Checks: only listed, confirmed emails get in; no workspace or login can call the platform
// functions; counts and sizes come back but never lead details; suspend / delete / disable / sign out / resend work; errors are logged.
// Run: node tests/admin.test.js   (no network, nothing kept)
const fs = require("fs"), path = require("path"), assert = require("assert");
process.env.API_URL = "https://db.test"; process.env.JWT_SECRET = "test-secret-" + "w".repeat(40);
process.env.APP_URL = "https://app.example"; process.env.SMTP_HOST = "smtp.test"; process.env.MAIL_FROM = "App <no-reply@app.example>";
process.env.SUPER_ADMIN_EMAILS = "Boss@Qlarity.example, other@qlarity.example";
const D = require("../api/_db"), M = require("../api/_mail"), AUTH = require("../api/auth"), ADMIN = require("../api/admin");

let passed = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sql = (f) => fs.readFileSync(path.join(__dirname, "..", "db", f), "utf8");
let db, mails = [];
M.setSender(async (m) => { mails.push(m); });
const TABLE_FNS = new Set(["auth_user_get", "auth_token_peek", "platform_orgs", "platform_users"]);

/* PostgREST, just enough: JWT → role; rpc/<fn> with named arguments; GET / POST on the two platform tables */
async function postgrest(url, opt) {
  opt = opt || {}; const h = opt.headers || {};
  const claims = D.jwtVerify(String(h.authorization || "").replace(/^Bearer /, ""));
  const role = claims ? claims.role : "anon", rest = url.split("/rest/v1/")[1], fn = rest.indexOf("rpc/") === 0 ? rest.slice(4) : null;
  const reply = (b, st) => ({ ok: st < 400, status: st, headers: { get: () => null }, text: async () => (b === undefined ? "" : JSON.stringify(b)) });
  const run = (q, p) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [JSON.stringify(claims || {}), JSON.stringify({ "x-org-id": h["x-org-id"] || "" })]);
    await tx.query("set local role " + role);
    return tx.query(q, p || []);
  });
  try {
    if (fn) {
      const args = JSON.parse(opt.body || "{}"), keys = Object.keys(args), call = "public." + fn + "(" + keys.map((k, i) => k + " => $" + (i + 1)).join(", ") + ")";
      const r = await run(TABLE_FNS.has(fn) ? "select * from " + call : "select " + call + " as v", keys.map((k) => args[k]));
      return reply(TABLE_FNS.has(fn) ? r.rows : r.rows[0].v, 200);
    }
    const table = rest.split("?")[0], lim = Number((rest.match(/limit=(\d+)/) || [])[1] || 1000);
    if (table === "platform_events" && opt.method === "POST") {
      await run("insert into public.platform_events (source, level, area, message, org_id, detail) select source, level, area, message, org_id, detail from jsonb_populate_record(null::public.platform_events, $1::jsonb)", [opt.body]);
      return reply(undefined, 201);
    }
    if (table === "platform_health") {
      const cols = /disk:/.test(rest) ? "taken_at, data->'disk' as disk, data->'memory' as memory, data->'load' as load" : "taken_at, data";
      return reply((await run("select " + cols + " from public.platform_health order by taken_at desc limit " + lim)).rows, 200);
    }
    if (table === "platform_events") return reply((await run("select * from public.platform_events order by at desc limit " + lim)).rows, 200);
    return reply({ message: "not imitated: " + table }, 404);
  } catch (e) { return reply({ message: e.message }, 400); }
}
function invoke(H, method, op, b, token, extra) {
  const out = {}, res = { statusCode: 0, setHeader() {}, end(s) { out.status = this.statusCode; out.body = s ? JSON.parse(s) : null; } };
  return Promise.resolve(H({ method, query: Object.assign({ op }, extra || {}), headers: token ? { authorization: "Bearer " + token } : {}, body: JSON.stringify(b || {}) }, res)).then(() => out);
}
const auth = (op, b, t) => invoke(AUTH, "POST", op, b, t);
const admin = (op, t, b) => invoke(ADMIN, b ? "POST" : "GET", op, b, t);
const linkIn = (m, kind) => decodeURIComponent((String(m.text).match(new RegExp("\\?" + kind + "=([^\\s]+)")) || [])[1] || "");
const ageLinks = () => db.query("update auth.email_tokens set created_at = created_at - interval '2 minutes'");
async function account(email, pw) {
  mails = []; await auth("signup", { email, password: pw });
  const r = await auth("verify", { token: linkIn(mails[0], "verify"), password: pw }); await ageLinks();
  return { id: (await D.signedIn({ headers: { authorization: "Bearer " + r.body.token } })).id, token: r.body.token };
}
/* as a signed-in member, in a workspace (what the browser does through PostgREST) */
async function asUser(t, org, q, p) {
  const c = D.jwtVerify(t);
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [JSON.stringify(c), JSON.stringify(org ? { "x-org-id": org } : {})]);
    await tx.query("set local role authenticated");
    return tx.query(q, p || []);
  });
}
let boss, ann, bob, A, B;

test("setup: all four SQL files install twice in PGlite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  db = new PGlite({ extensions: { pgcrypto } });
  for (let i = 0; i < 2; i++) for (const f of ["00-platform.sql", "10-schema.sql", "20-auth.sql", "30-platform.sql"]) await db.exec(sql(f));
  global.fetch = postgrest;
  boss = await account("boss@qlarity.example", "boss password 1");
  ann = await account("ann@alpha.example", "ann password 1");
  bob = await account("bob@beta.example", "bob password 1");
  A = (await asUser(ann.token, null, "select public.create_organization('Alpha Co', 'INR', 330, 'CRM', array['A1']) as id")).rows[0].id;
  B = (await asUser(bob.token, null, "select public.create_organization('Beta Ltd', 'AED', 240, 'Zoho', array['B1']) as id")).rows[0].id;
  await asUser(ann.token, A, "insert into public.crm_leads (lead_id, created_on, status, brand, phone, email, lead_name) values ('L-1', now(), 'New', 'A1', '9876543210', 'lead.person@mail.example', 'Secret Lead Name'), ('L-2', now(), 'QL', 'A1', '9999999999', '', 'Other Lead')");
  await asUser(ann.token, A, "select public.set_org_secret('meta_access_token', 'TEST-TOKEN-ALPHA-9876')");
});

test("only confirmed logins listed in SUPER_ADMIN_EMAILS get in", async () => {
  assert.strictEqual((await admin("me")).status, 403, "no sign-in");
  assert.strictEqual((await admin("overview", ann.token)).status, 403, "a workspace owner isn't a platform admin");
  const r = await admin("me", boss.token); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.email, "boss@qlarity.example");
  assert.strictEqual((await admin("action", boss.token)).status, 405, "actions are POST only");
  const saved = process.env.SUPER_ADMIN_EMAILS; process.env.SUPER_ADMIN_EMAILS = "";
  try { const x = await admin("me", boss.token); assert.strictEqual(x.status, 403); assert.ok(/SUPER_ADMIN_EMAILS/.test(x.body.error)); } finally { process.env.SUPER_ADMIN_EMAILS = saved; }
});

test("no login or workspace can call the platform functions or read the platform tables", async () => {
  for (const q of ["select * from public.platform_orgs()", "select * from public.platform_users()", "select public.platform_db()", "select * from public.platform_events", "select * from public.platform_health",
    "select public.platform_set_org_active('" + B + "', false)", "select public.platform_delete_org('" + B + "', 'Beta Ltd')", "select public.platform_user_action('" + bob.id + "', 'disable')"])
    await assert.rejects(asUser(ann.token, A, q), /permission denied/, q);
});

test("overview: counts and sizes per workspace, logins, database; never lead details or tokens", async () => {
  await db.query("insert into public.platform_health (data) values ($1)", [JSON.stringify({ disk: { total: 100, used: 95, free: 5 }, memory: { total: 100, available: 50 }, load: [0.1, 0.1, 0.1], cpus: 2,
    services: { postgresql: "active", postgrest: "failed" }, backup: { file: "lp-1.dump", at: new Date().toISOString(), s3: "ok" }, schedules: { ok_24h: 10, failed_24h: 0 } })]);
  const r = await admin("overview", boss.token); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const a = r.body.orgs.filter((o) => o.id === A)[0];
  assert.strictEqual(Number(a.leads), 2); assert.ok(Number(a.storage_bytes) > 0 && a.storage.crm_leads > 0, "storage per table"); assert.deepStrictEqual(a.owners, ["ann@alpha.example"]);
  assert.strictEqual(r.body.users.length, 3); assert.ok(r.body.db.size_bytes > 0); assert.strictEqual(r.body.series.length, 1);
  const all = JSON.stringify(r.body);
  for (const secret of ["9876543210", "lead.person@mail.example", "Secret Lead Name", "TEST-TOKEN-ALPHA", "scrypt$"]) assert.ok(all.indexOf(secret) < 0, "leaks " + secret);
  const titles = r.body.issues.map((i) => i.title).join(" | ");
  assert.ok(/disk is almost full/.test(titles) && /postgrest is failed/.test(titles), titles);
});

test("suspend: members lose the workspace (list and rows); reactivate brings it back; both are logged", async () => {
  assert.strictEqual((await admin("action", boss.token, { kind: "org-suspend", id: A, label: "Alpha Co" })).status, 200);
  assert.strictEqual((await asUser(ann.token, null, "select * from public.my_orgs()")).rows.length, 0);
  assert.strictEqual((await asUser(ann.token, A, "select * from public.crm_leads")).rows.length, 0, "rows closed by RLS");
  assert.strictEqual((await admin("action", boss.token, { kind: "org-reactivate", id: A })).status, 200);
  assert.strictEqual((await asUser(ann.token, A, "select * from public.crm_leads")).rows.length, 2);
  const ev = (await db.query("select message from public.platform_events where source = 'admin' order by id")).rows.map((x) => x.message);
  assert.ok(/boss@qlarity\.example suspended workspace "Alpha Co"/.test(ev[0]), ev[0]);
});

test("disable a login: sessions end, sign-in refused, database refuses it; enable restores; sign out ends sessions only", async () => {
  assert.strictEqual((await admin("action", boss.token, { kind: "user-disable", id: boss.id })).status, 400, "not yourself");
  assert.strictEqual((await admin("action", boss.token, { kind: "user-disable", id: bob.id })).status, 200);
  assert.strictEqual(await D.signedIn({ headers: { authorization: "Bearer " + bob.token } }), null);
  const l = await auth("login", { email: "bob@beta.example", password: "bob password 1" }); assert.strictEqual(l.status, 403); assert.ok(l.body.disabled);
  await assert.rejects(asUser(bob.token, B, "select private.check_session()"));
  assert.strictEqual((await admin("action", boss.token, { kind: "user-enable", id: bob.id })).status, 200);
  const again = await auth("login", { email: "bob@beta.example", password: "bob password 1" }); assert.strictEqual(again.status, 200); bob.token = again.body.token;
  assert.strictEqual((await admin("action", boss.token, { kind: "user-signout", id: bob.id })).status, 200);
  assert.strictEqual(await D.signedIn({ headers: { authorization: "Bearer " + bob.token } }), null, "old session ended");
  assert.strictEqual((await auth("login", { email: "bob@beta.example", password: "bob password 1" })).status, 200, "can sign in again");
});

test("resend confirmation: a new link that works with the sign-up's password", async () => {
  mails = []; await auth("signup", { email: "late@gamma.example", password: "late password 1" }); await ageLinks(); mails = [];
  const u = (await admin("overview", boss.token)).body.users.filter((x) => x.email === "late@gamma.example")[0];
  assert.ok(u && !u.confirmed_at);
  assert.strictEqual((await admin("action", boss.token, { kind: "user-resend", id: u.id })).status, 200);
  assert.strictEqual(mails.length, 1); assert.strictEqual(mails[0].to, "late@gamma.example");
  assert.strictEqual((await auth("verify", { token: linkIn(mails[0], "verify"), password: "late password 1" })).status, 200);
  assert.strictEqual((await admin("action", boss.token, { kind: "user-resend", id: u.id })).status, 400, "already confirmed");
});

test("delete a workspace: the typed name must match; then its rows and encrypted tokens are gone", async () => {
  const before = Number((await db.query("select count(*) n from vault.secrets")).rows[0].n);
  const wrong = await admin("action", boss.token, { kind: "org-delete", id: A, name: "Alpha" }); assert.strictEqual(wrong.status, 400);
  const del = await admin("action", boss.token, { kind: "org-delete", id: A, name: "Alpha Co" }); assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual(Number((await db.query("select count(*) n from public.organizations where id = $1", [A])).rows[0].n), 0);
  assert.strictEqual(Number((await db.query("select count(*) n from public.crm_leads where org_id = $1", [A])).rows[0].n), 0);
  assert.strictEqual(Number((await db.query("select count(*) n from vault.secrets")).rows[0].n), before - 1);
  assert.strictEqual(Number((await db.query("select count(*) n from public.organizations where id = $1", [B])).rows[0].n), 1, "other workspaces untouched");
});

test("error log: a 5xx answer or an uncaught error from an endpoint is written to platform_events", async () => {
  const H1 = D.logged("demo", async (req, res) => D.send(res, 502, { error: "Meta answered 400: token expired" }));
  const r1 = await invoke(H1, "GET", "sync"); assert.strictEqual(r1.status, 502);
  const H2 = D.logged("boom", async () => { throw new Error("kaput"); });
  const r2 = await invoke(H2, "GET", "x"); assert.strictEqual(r2.status, 500);
  const H3 = D.logged("fine", async (req, res) => D.send(res, 404, { error: "nope" }));
  await invoke(H3, "GET", "x");
  const rows = (await db.query("select area, message, detail from public.platform_events where source = 'vercel' order by id")).rows;
  assert.deepStrictEqual(rows.map((x) => x.area), ["demo", "boom"]);
  assert.ok(/token expired/.test(rows[0].message) && rows[0].detail.status === 502 && rows[0].detail.op === "sync");
});

test("issues: stale snapshot, failed S3 copy, old backup, expiring certificate", () => {
  const old = new Date(Date.now() - 3600e3).toISOString();
  const t = ADMIN.issuesOf({ taken_at: old, data: { disk: { total: 10, used: 1 }, services: {}, backup: { file: "x", at: new Date(Date.now() - 50 * 3600e3).toISOString(), s3: "failed" }, cert_expires: new Date(Date.now() + 2 * 864e5).toISOString() } }, [], []).map((i) => i.title).join(" | ");
  for (const want of ["stopped reporting", "more than a day old", "S3", "certificate expires"]) assert.ok(t.indexOf(want) >= 0, want + " in " + t);
  assert.ok(/No health data/.test(ADMIN.issuesOf(null, [], [])[0].title));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + "\n   " + (e && e.stack || e)); }
  }
  console.log("\n" + passed + "/" + tests.length + " passed");
  process.exit(passed === tests.length ? 0 : 1);
})();
