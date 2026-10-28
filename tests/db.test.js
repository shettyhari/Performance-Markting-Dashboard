// Database test: db/00-platform.sql + db/10-schema.sql in PGlite (real Postgres compiled to WebAssembly), then the workspace isolation
// checks, run the way PostgREST runs them: per request, a transaction with the JWT claims and headers set and the JWT's role switched on.
// Run: node tests/db.test.js   (needs the @electric-sql/pglite dev dependency; no network, nothing kept)
const fs = require("fs"), path = require("path"), assert = require("assert");

let passed = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sql = (f) => fs.readFileSync(path.join(__dirname, "..", "db", f), "utf8");
const U = { alice: "aaaaaaaa-0000-4000-8000-00000000000a", bob: "bbbbbbbb-0000-4000-8000-00000000000b", carol: "cccccccc-0000-4000-8000-00000000000c" };
const EMAIL = { alice: "alice@alpha.example", bob: "bob@beta.example", carol: "carol@alpha.example" };
let db, A, B;

/* one PostgREST-style request: claims + headers + role, inside a transaction */
async function as(who, org, fn) {
  return db.transaction(async (tx) => {
    const claims = who === "service" ? { role: "service_role" } : { sub: U[who], role: "authenticated", email: EMAIL[who] };
    await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [JSON.stringify(claims), JSON.stringify(org ? { "x-org-id": org } : {})]);
    await tx.query("set local role " + (who === "service" ? "service_role" : "authenticated"));
    return fn(tx);
  });
}
const count = async (tx, q, p) => Number((await tx.query("select count(*)::int as n from (" + q + ") x", p || [])).rows[0].n);
async function fails(p) { try { await p; return false; } catch (e) { return true; } }

test("both SQL files install cleanly, twice (safe to re-run)", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  db = new PGlite({ extensions: { pgcrypto } });
  for (let i = 0; i < 2; i++) { await db.exec(sql("00-platform.sql")); await db.exec(sql("10-schema.sql")); }
  await db.query("insert into auth.users (id, email, encrypted_password, email_confirmed_at, confirmation_sent_at) values ($1, $2, 'x', now(), now()), ($3, $4, 'x', now(), now()), ($5, $6, 'x', now(), null)",
    [U.alice, EMAIL.alice, U.bob, EMAIL.bob, U.carol, EMAIL.carol]);
});
test("a confirmed user creates a workspace and becomes its admin; data, token and key stay in it", async () => {
  A = (await as("alice", null, (tx) => tx.query("select public.create_organization('Alpha Co', 'INR', 330, 'CRM', array['A1']) as id"))).rows[0].id;
  await as("alice", A, async (tx) => {
    await tx.query("insert into public.crm_leads (lead_id, created_on, status, brand) values ('L-A1', now(), 'New', 'A1')");
    await tx.query("insert into public.org_members (org_id, email, role, invited_by) values ($1, $2, 'viewer', $3)", [A, EMAIL.carol, EMAIL.alice]);
    assert.strictEqual(await count(tx, "select 1 from public.crm_leads"), 1);
    assert.ok(/^lp_api_/.test((await tx.query("select public.create_api_key('api', 'test') as k")).rows[0].k));
    await tx.query("select public.set_org_secret('meta_access_token', 'TEST-TOKEN-1234')");
    assert.strictEqual((await tx.query("select last4 from public.org_secrets")).rows[0].last4, "1234");
  });
  B = (await as("bob", null, (tx) => tx.query("select public.create_organization('Beta Ltd', 'AED', 240, 'Zoho', array['B1']) as id"))).rows[0].id;
});
test("another workspace's member gets nothing from Alpha, even claiming Alpha's id", async () => {
  await as("bob", A, async (tx) => {
    for (const t of ["crm_leads", "org_members", "org_secrets", "org_settings", "uploads", "data_days"]) assert.strictEqual(await count(tx, "select 1 from public." + t), 0, t);
    assert.strictEqual(await count(tx, "select 1 from public.organizations where id = $1", [A]), 0);
    assert.strictEqual(await count(tx, "select 1 from public.my_orgs()"), 1);
  });
});
test("…and can't write to it, set its tokens, create its keys or run its functions", async () => {
  const blocked = async (q, p) => assert.ok(await fails(as("bob", A, (tx) => tx.query(q, p || []))), q);
  await blocked("insert into public.crm_leads (lead_id, org_id, status) values ('X', $1, 'x')", [A]);
  await blocked("select public.set_org_secret('meta_access_token', 'X')");
  await blocked("select public.create_api_key('api', 'x')");
  await blocked("select public.lead_keys(array['x'])");
  await blocked("select public.meta_replace_days('[{\"c\":\"x\",\"d\":\"2026-10-01\"}]')");
  await blocked("select public.refresh_lead_dupes()");
  await blocked("select public.get_org_secret($1, 'meta_access_token')", [A]);
  await blocked("select * from public.alert_log");
  await blocked("select * from vault.decrypted_secrets");
  await blocked("select * from auth.users");
  await as("bob", A, async (tx) => {
    assert.strictEqual((await tx.query("update public.crm_leads set status = 'hacked'")).affectedRows || 0, 0);
    assert.strictEqual(await count(tx, "select 1 from public.owner_name_map(array['x@y.z'])"), 0);
  });
  assert.ok(await fails(as("bob", B, (tx) => tx.query("insert into public.crm_leads (lead_id, org_id, status) values ('Y', $1, 'x')", [A]))), "row claiming Alpha from Beta");
  const tok = await as("service", A, (tx) => tx.query("select public.get_org_secret($1, 'meta_access_token') as v", [A]));
  assert.strictEqual(tok.rows[0].v, "TEST-TOKEN-1234", "only the server reads the token back, decrypted");
});
test("column grants: key hashes unreadable; admins can't switch a workspace off or change its public id", async () => {
  await as("alice", A, async (tx) => { assert.ok(await fails(tx.query("select key_hash from public.org_api_keys"))); });
  assert.ok(await fails(as("alice", A, (tx) => tx.query("update public.organizations set active = false where id = $1", [A]))));
  assert.ok(await fails(as("alice", A, (tx) => tx.query("update public.organizations set public_id = 'x' where id = $1", [A]))));
  await as("alice", A, (tx) => tx.query("update public.organizations set name = 'Alpha Company' where id = $1", [A]));
});
test("an invite counts only after the email is proven; then the viewer reads but can't write", async () => {
  await as("carol", A, async (tx) => {
    assert.strictEqual(await count(tx, "select 1 from public.crm_leads"), 0);
    assert.strictEqual((await tx.query("select public.accept_invites() as n")).rows[0].n, 0);
  });
  await db.query("update auth.users set confirmation_sent_at = now() where id = $1", [U.carol]);
  await as("carol", A, async (tx) => {
    assert.strictEqual((await tx.query("select public.accept_invites() as n")).rows[0].n, 1);
    assert.strictEqual(await count(tx, "select 1 from public.crm_leads"), 1);
  });
  assert.ok(await fails(as("carol", A, (tx) => tx.query("insert into public.crm_leads (lead_id, status) values ('C', 'x')"))));
});
test("the last admin can't be removed; people's changes are logged", async () => {
  assert.ok(await fails(as("alice", A, (tx) => tx.query("delete from public.org_members where email = $1", [EMAIL.alice]))));
  await as("alice", A, async (tx) => assert.ok(await count(tx, "select 1 from public.change_log") >= 2));
});
test("server role with a workspace header: monitoring numbers for that workspace only", async () => {
  await as("service", A, async (tx) => assert.strictEqual(await count(tx, "select 1 from public.alerts_brand_daily(current_date - 1)"), 1));
  await as("service", B, async (tx) => assert.strictEqual(await count(tx, "select 1 from public.alerts_brand_daily(current_date - 1)"), 0));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + "\n   " + (e && e.message || e)); }
  }
  console.log("\n" + passed + "/" + tests.length + " passed");
  if (passed !== tests.length) process.exit(1);
  process.exit(0);
})();
