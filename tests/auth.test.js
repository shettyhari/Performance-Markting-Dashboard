// Login test: api/auth.js + api/_db.js against the real db/*.sql in PGlite, with PostgREST imitated (the JWT is checked and its
// role switched on, rpc/<fn> runs the function) and the mailer replaced by a list of sent emails.
// Run: node tests/auth.test.js   (no network, nothing kept)
const fs = require("fs"), path = require("path"), assert = require("assert");
process.env.API_URL = "https://db.test"; process.env.JWT_SECRET = "test-secret-" + "y".repeat(40);
process.env.APP_URL = "https://app.example"; process.env.SMTP_HOST = "smtp.test"; process.env.MAIL_FROM = "App <no-reply@app.example>";
const D = require("../api/_db"), M = require("../api/_mail"), AUTH = require("../api/auth");

let passed = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sql = (f) => fs.readFileSync(path.join(__dirname, "..", "db", f), "utf8");
let db, mails = [];
M.setSender(async (m) => { mails.push(m); });
const TABLE_FNS = new Set(["auth_user_get", "auth_token_peek"]);

/* PostgREST, just enough: JWT → role, then rpc/<fn> with named arguments */
async function postgrest(url, opt) {
  const claims = D.jwtVerify(String(opt.headers.authorization || "").replace(/^Bearer /, ""));
  const role = claims ? claims.role : "anon", fn = url.split("/rest/v1/rpc/")[1];
  const reply = (b, st) => ({ ok: st < 400, status: st, headers: { get: () => null }, text: async () => JSON.stringify(b) });
  if (!fn) return reply({ message: "only rpc in this test" }, 404);
  const args = JSON.parse(opt.body || "{}"), keys = Object.keys(args);
  const call = "public." + fn + "(" + keys.map((k, i) => k + " => $" + (i + 1)) .join(", ") + ")";
  try {
    const r = await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims || {})]);
      await tx.query("set local role " + role);
      return tx.query(TABLE_FNS.has(fn) ? "select * from " + call : "select " + call + " as v", keys.map((k) => args[k]));
    });
    return reply(TABLE_FNS.has(fn) ? r.rows : r.rows[0].v, 200);
  } catch (e) { return reply({ message: e.message }, 400); }
}
async function call(op, b, token) {
  const out = {}, res = { statusCode: 0, setHeader() {}, end(s) { out.status = this.statusCode; out.body = JSON.parse(s); } };
  await AUTH({ method: "POST", query: { op }, headers: token ? { authorization: "Bearer " + token } : {}, body: JSON.stringify(b || {}) }, res);
  return out;
}
const linkIn = (m, kind) => decodeURIComponent((String(m.text).match(new RegExp("\\?" + kind + "=([^\\s]+)")) || [])[1] || "");
const ageLinks = () => db.query("update auth.email_tokens set created_at = created_at - interval '2 minutes'");
const me = (t) => D.signedIn({ headers: { authorization: "Bearer " + t } });

test("setup: the SQL files install in PGlite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  db = new PGlite({ extensions: { pgcrypto } });
  for (const f of ["00-platform.sql", "10-schema.sql", "20-auth.sql"]) await db.exec(sql(f));
  global.fetch = postgrest;
});
let tokA;
test("sign up → confirmation email; no sign-in until confirmed; the link needs the sign-up's password", async () => {
  let r = await call("signup", { email: " Ann@Alpha.example ", password: "short" });
  assert.strictEqual(r.status, 400);
  r = await call("signup", { email: "Ann@Alpha.example", password: "correct horse 1", name: "Ann" });
  assert.strictEqual(r.status, 200); assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, "ann@alpha.example"); assert.ok(/^https:\/\/app\.example\/app\?verify=/.test(String(mails[0].text).split("\n\n")[1]));
  assert.strictEqual((await call("login", { email: "ann@alpha.example", password: "correct horse 1" })).status, 403, "not confirmed yet");
  const link = linkIn(mails[0], "verify");
  assert.strictEqual((await call("verify", { token: link, password: "wrong password" })).status, 401);
  r = await call("verify", { token: link, password: "correct horse 1" });
  assert.strictEqual(r.status, 200); tokA = r.body.token;
  assert.strictEqual(r.body.user.user_metadata.full_name, "Ann");
  const u = await me(tokA); assert.strictEqual(u.email, "ann@alpha.example"); assert.ok(u.email_confirmed_at && u.confirmation_sent_at, "email proven");
  assert.strictEqual((await call("verify", { token: link, password: "correct horse 1" })).status, 400, "a link works once");
});
test("email links use the address the person signed up on, even when APP_URL is stale", async () => {
  mails = []; await ageLinks();
  const out = {}, res = { statusCode: 0, setHeader() {}, end(s) { out.status = this.statusCode; } };
  await AUTH({ method: "POST", query: { op: "signup" }, headers: { host: "new-site.example", "x-forwarded-host": "new-site.example" }, body: JSON.stringify({ email: "host@gamma.example", password: "host check pass 1" }) }, res);
  assert.strictEqual(out.status, 200); assert.strictEqual(mails.length, 1);
  assert.ok(/^https:\/\/new-site\.example\/app\?verify=/.test(String(mails[0].text).split("\n\n")[1]), "not the APP_URL (https://app.example)");
  mails = []; await ageLinks();
  await AUTH({ method: "POST", query: { op: "forgot" }, headers: { host: "localhost:3000" }, body: JSON.stringify({ email: "ann@alpha.example" }) }, res);
  assert.ok(/^https:\/\/app\.example\/app\?reset=/.test(String(mails[0].text).split("\n\n")[1]), "a local host falls back to APP_URL");
});
test("sign in: right password works; wrong one doesn't; unknown email gets the same answer", async () => {
  const ok = await call("login", { email: "ANN@alpha.example", password: "correct horse 1" });
  assert.strictEqual(ok.status, 200); assert.ok(await me(ok.body.token));
  const bad = await call("login", { email: "ann@alpha.example", password: "nope nope 1" }), none = await call("login", { email: "nobody@alpha.example", password: "nope nope 1" });
  assert.strictEqual(bad.status, 401); assert.deepStrictEqual(bad.body, none.body);
});
test("a sign-up someone else made with your email can't take the account", async () => {
  mails = [];
  await call("signup", { email: "vic@beta.example", password: "attacker pass 1" });   // made by someone else, link goes to Vic's inbox
  await ageLinks();
  await call("signup", { email: "vic@beta.example", password: "victim pass 1" });     // Vic signs up
  assert.strictEqual(mails.length, 2);
  const theirs = linkIn(mails[0], "verify"), mine = linkIn(mails[1], "verify");
  assert.strictEqual((await call("verify", { token: theirs, password: "attacker pass 1" })).status, 400, "the older link stopped working");
  assert.strictEqual((await call("verify", { token: mine, password: "attacker pass 1" })).status, 401, "Vic's link doesn't take the other password");
  assert.strictEqual((await call("verify", { token: mine, password: "victim pass 1" })).status, 200);
  assert.strictEqual((await call("login", { email: "vic@beta.example", password: "attacker pass 1" })).status, 401);
  assert.strictEqual((await call("login", { email: "vic@beta.example", password: "victim pass 1" })).status, 200);
});
test("signing up again with a confirmed email sends nothing and changes nothing", async () => {
  mails = []; await ageLinks();
  assert.strictEqual((await call("signup", { email: "ann@alpha.example", password: "other pass 1" })).status, 200);
  assert.strictEqual(mails.length, 0);
  assert.strictEqual((await call("login", { email: "ann@alpha.example", password: "correct horse 1" })).status, 200);
});
test("forgot / reset: new password works, the old one and every old session stop", async () => {
  mails = []; await ageLinks();
  assert.strictEqual((await call("forgot", { email: "nobody@alpha.example" })).status, 200); assert.strictEqual(mails.length, 0);
  assert.strictEqual((await call("forgot", { email: "ann@alpha.example" })).status, 200); assert.strictEqual(mails.length, 1);
  const r = await call("reset", { token: linkIn(mails[0], "reset"), password: "brand new pass 2" });
  assert.strictEqual(r.status, 200); assert.ok(await me(r.body.token));
  assert.strictEqual(await me(tokA), null, "older session ended");
  assert.strictEqual((await call("login", { email: "ann@alpha.example", password: "correct horse 1" })).status, 401);
  tokA = (await call("login", { email: "ann@alpha.example", password: "brand new pass 2" })).body.token; assert.ok(tokA);
  assert.strictEqual((await call("reset", { token: linkIn(mails[0], "reset"), password: "again again 3" })).status, 400, "a reset link works once");
});
test("profile name and password change (other sessions end, a fresh token comes back)", async () => {
  let r = await call("profile", { name: "Ann Lee" }, tokA);
  assert.strictEqual(r.body.user.user_metadata.full_name, "Ann Lee");
  r = await call("password", { password: "changed pass 4" }, tokA);
  assert.strictEqual(r.status, 200); assert.strictEqual(await me(tokA), null); assert.ok(await me(r.body.token));
  assert.strictEqual((await call("me", {}, tokA)).status, 401);
  assert.strictEqual((await call("profile", { name: "x" })).status, 401, "needs a sign-in");
});
test("the database API also refuses a session from before a password change (PostgREST pre-request check)", async () => {
  const check = (claims) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await tx.query("set local role " + (claims.role || "anon"));
    await tx.query("select private.check_session()");
  }).then(() => "ok", (e) => e.code || e.message);
  const u = (await db.query("select id::text as id, token_version as tv from auth.users where email = 'ann@alpha.example'")).rows[0];
  assert.strictEqual(await check({ role: "authenticated", sub: u.id, tv: u.tv }), "ok");
  assert.strictEqual(await check({ role: "authenticated", sub: u.id, tv: u.tv - 1 }), "PT401", "old token version");
  assert.strictEqual(await check({ role: "authenticated", sub: "00000000-0000-4000-8000-000000000000", tv: 0 }), "PT401", "no such account");
  assert.strictEqual(await check({}), "ok", "anonymous requests pass through (RLS still applies)");
  assert.strictEqual(await check({ role: "service_role" }), "ok");
});
test("10 wrong passwords lock the account for 15 minutes, even for the right password", async () => {
  for (let i = 0; i < 10; i++) await call("login", { email: "vic@beta.example", password: "guess guess " + i });
  assert.strictEqual((await call("login", { email: "vic@beta.example", password: "victim pass 1" })).status, 429);
  await db.query("update auth.users set locked_until = now() - interval '1 second' where email = 'vic@beta.example'");
  assert.strictEqual((await call("login", { email: "vic@beta.example", password: "victim pass 1" })).status, 200);
});
test("the login functions are server-only: signed-in users and anonymous callers can't run them", async () => {
  const userTok = (await call("login", { email: "vic@beta.example", password: "victim pass 1" })).body.token;
  for (const t of [userTok, ""]) {
    const r = await postgrest("https://db.test/rest/v1/rpc/auth_user_get", { headers: { authorization: "Bearer " + t }, body: JSON.stringify({ p_email: "ann@alpha.example" }) });
    assert.strictEqual(r.status, 400, "refused");
  }
  const forged = D.jwtSign({ role: "service_role" }, 60).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.strictEqual(D.jwtVerify(forged), null, "a changed signature is rejected");
});
test("no email set up: sign-up says so instead of making an account nobody can confirm", async () => {
  const h = process.env.SMTP_HOST; delete process.env.SMTP_HOST;
  try { assert.strictEqual((await call("signup", { email: "new@gamma.example", password: "long enough 1" })).status, 503); }
  finally { process.env.SMTP_HOST = h; }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + "\n   " + (e && e.stack || e)); }
  }
  console.log("\n" + passed + "/" + tests.length + " passed");
  process.exit(passed === tests.length ? 0 : 1);
})();
