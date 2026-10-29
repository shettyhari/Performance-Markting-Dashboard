// Sign-up and sign-in for the dashboard (own login; accounts live in auth.users on the API server, reached through db/20-auth.sql).
// POST /api/auth?op=…   (JSON body; answers { user, token } when someone is signed in afterwards)
//   signup  { email, password, name }  → sends a confirmation link (/?verify=…); no session until the email is confirmed.
//                                        Signing up again with the same email sends a new link (the older one stops working).
//   verify  { token, password }        → confirms the email and signs in. The link only works with the password chosen at the
//                                        sign-up that sent it, so a sign-up someone else made with your email can't take your account.
//   login   { email, password }        → signs in (10 wrong passwords in a row lock the account for 15 minutes)
//   forgot  { email }                  → sends a reset link (/app?reset=…); says so when the email has no account
//   reset   { token, password }        → new password, signs in, ends every other session
//   me                                 → the signed-in person (Authorization: Bearer <token>)
//   profile { name }                   → saves the profile name
//   password { password }              → new password (not the current one); ends every other session and returns a fresh token
// Sessions are HS256 JWTs signed with JWT_SECRET (the secret PostgREST checks): role authenticated, sub, email, tv (token version).
const crypto = require("crypto");
const D = require("./_db");
const M = require("./_mail");

const SESSION_DAYS = 7;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const body = (req) => { let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } return b || {}; };
const cleanEmail = (e) => String(e || "").trim().toLowerCase();

/* ---------- passwords: scrypt, stored as scrypt$N$r$p$salt$hash ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw, salt, o) => new Promise((ok, no) => crypto.scrypt(String(pw), salt, 64, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16), k = await scrypt(pw, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), k.toString("base64")].join("$");
}
async function checkPassword(pw, stored) {
  const p = String(stored || "").split("$");
  if (p.length !== 6 || p[0] !== "scrypt") { await scrypt(pw, "x", SCRYPT); return false; }   // same work either way
  const want = Buffer.from(p[5], "base64"), k = await scrypt(pw, Buffer.from(p[4], "base64"), { N: +p[1], r: +p[2], p: +p[3] });
  return want.length === k.length && crypto.timingSafeEqual(want, k);
}
const DISABLED = "This account has been disabled. Contact the Qlarity team if you think this is a mistake.";
const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
const passwordProblem = (pw) => (typeof pw !== "string" || pw.length < 8 ? "Use at least 8 characters for the password." : pw.length > 200 ? "That password is too long." : "");

/* ---------- accounts (service_role functions from db/20-auth.sql) ---------- */
const rpc = (fn, args) => D.raw("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });
const userBy = async (args) => { const r = await rpc("auth_user_get", args); return (r && r[0]) || null; };
const publicUser = (u) => ({ id: u.id, email: u.email, email_confirmed_at: u.email_confirmed_at || null,
  user_metadata: { full_name: (u.raw_user_meta_data && u.raw_user_meta_data.full_name) || (u.name || "") } });
const session = (u) => ({ token: D.jwtSign({ sub: u.id, role: "authenticated", email: u.email, tv: Number(u.token_version || 0) }, SESSION_DAYS * 86400), user: publicUser(u) });

/* where email links point: the address this request came in on (Vercel only routes this project's own domains here, so the host is
   ours), so a stale APP_URL can't send people to an old or removed address; APP_URL is used when the host is missing or local */
function linkBase(req) {
  const h = req && req.headers ? req.headers : {}, host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !/^(localhost|127\.|10\.|192\.168\.)/.test(host)) return "https://" + host;
  return D.appUrl(req);
}
async function sendLink(req, u, kind, pwHash) {
  const tok = crypto.randomBytes(32).toString("base64url");
  const made = await rpc("auth_token_add", { p_user: u.id, p_kind: kind, p_hash: D.sha256(tok), p_minutes: kind === "verify" ? 48 * 60 : 60, p_pw: pwHash || null });
  if (made !== true) return false;   // one a minute is enough
  const name = process.env.APP_NAME || "Qlarity", url = linkBase(req) + "/app?" + kind + "=" + encodeURIComponent(tok);
  if (kind === "verify") await M.sendLink(u.email, "Confirm your email for " + name, "Confirm your email address to start using " + name + ".", "Confirm email", url, "The link works for 48 hours. If you didn't sign up, ignore this email.");
  else await M.sendLink(u.email, "Reset your " + name + " password", "Someone (hopefully you) asked to reset the password for " + u.email + ".", "Choose a new password", url, "The link works for 1 hour and only once. If you didn't ask, ignore this email: your password stays the same.");
  return true;
}

const ops = {
  async signup(req, b) {
    const email = cleanEmail(b.email), bad = passwordProblem(b.password);
    if (!EMAIL_RE.test(email) || email.length > 254) return [400, { error: "Enter a valid email address." }];
    if (bad) return [400, { error: bad }];
    if (!M.configured()) return [503, { error: "Email isn't set up on this site yet, so new accounts can't be confirmed. The site owner sets SMTP_HOST and MAIL_FROM in Vercel." }];
    const pw = await hashPassword(b.password);
    const id = await rpc("auth_user_create", { p_email: email, p_hash: pw, p_name: String(b.name || "").slice(0, 120) || null });
    const u = await userBy(id ? { p_id: id } : { p_email: email });
    if (u && !u.email_confirmed_at) await sendLink(req, u, "verify", pw);   // an existing confirmed account gets nothing: no hint either way
    return [200, { ok: true, confirm: true }];
  },
  async verify(req, b) {
    const h = D.sha256(String(b.token || "")), t = ((await rpc("auth_token_peek", { p_hash: h, p_kind: "verify" })) || [])[0];
    if (!t) return [400, { error: "This confirmation link has expired or was already used. Sign in, or sign up again for a new link." }];
    if (!t.password_hash || !(await checkPassword(String(b.password || ""), t.password_hash)))
      return [401, { error: "That isn't the password chosen with this sign-up. If you signed up more than once, use the newest email, or sign up again." }];
    const id = await rpc("auth_token_use", { p_hash: h, p_kind: "verify" });
    if (!id) return [400, { error: "This confirmation link has expired or was already used." }];
    const v = await userBy({ p_id: id }); if (v.disabled_at) return [403, { error: DISABLED, disabled: true }];
    await rpc("auth_user_update", { p_id: id, p_signed_in: true });
    return [200, session(v)];
  },
  async login(req, b) {
    const u = await userBy({ p_email: cleanEmail(b.email) });
    const good = await checkPassword(String(b.password || ""), u ? u.encrypted_password : DUMMY);
    if (u && u.locked_until && new Date(u.locked_until) > new Date()) return [429, { error: "Too many wrong passwords. Try again in 15 minutes, or reset your password." }];
    if (!u || !good) { if (u) await rpc("auth_user_update", { p_id: u.id, p_failed: true }); return [401, { error: "Invalid login credentials" }]; }
    if (!u.email_confirmed_at) return [403, { error: "Email not confirmed", confirm: true }];   // only after the password check: no hint for guessers
    if (u.disabled_at) return [403, { error: DISABLED, disabled: true }];
    await rpc("auth_user_update", { p_id: u.id, p_signed_in: true });
    return [200, session(u)];
  },
  async forgot(req, b) {
    const email = cleanEmail(b.email);
    if (!EMAIL_RE.test(email)) return [400, { error: "Enter a valid email address." }];
    if (!M.configured()) return [503, { error: "Email isn't set up on this site yet, so reset links can't be sent." }];
    const u = await userBy({ p_email: email });
    if (!u) return [404, { error: "There's no account with this email. Check the spelling, or create an account.", noAccount: true }];
    await sendLink(req, u, "reset");
    return [200, { ok: true }];
  },
  async reset(req, b) {
    const bad = passwordProblem(b.password); if (bad) return [400, { error: bad }];
    const id = await rpc("auth_token_use", { p_hash: D.sha256(String(b.token || "")), p_kind: "reset" });
    if (!id) return [400, { error: "This reset link has expired or was already used. Ask for a new one." }];
    const tv = await rpc("auth_user_update", { p_id: id, p_hash: await hashPassword(b.password), p_signed_in: true });
    const u = await userBy({ p_id: id }); if (u.disabled_at) return [403, { error: DISABLED, disabled: true }];
    return [200, session(Object.assign({}, u, { token_version: tv }))];
  },
  async me(req) {
    const u = await D.signedIn(req); if (!u) return [401, { error: "Sign in again." }];
    return [200, { user: publicUser(u) }];
  },
  async profile(req, b) {
    const u = await D.signedIn(req); if (!u) return [401, { error: "Sign in again." }];
    await rpc("auth_user_update", { p_id: u.id, p_name: String(b.name || "").trim().slice(0, 120) });
    return [200, { user: publicUser(await userBy({ p_id: u.id })) }];
  },
  async password(req, b) {
    const u = await D.signedIn(req); if (!u) return [401, { error: "Sign in again." }];
    const bad = passwordProblem(b.password); if (bad) return [400, { error: bad }];
    const cur = await userBy({ p_id: u.id });
    if (cur && await checkPassword(String(b.password), cur.encrypted_password)) return [400, { error: "That's your current password. Try a different password.", samePassword: true }];
    const tv = await rpc("auth_user_update", { p_id: u.id, p_hash: await hashPassword(b.password) });
    return [200, session(Object.assign({}, await userBy({ p_id: u.id }), { token_version: tv }))];
  },
};

module.exports = D.logged("auth", async function handler(req, res) {
  const op = String((req.query && req.query.op) || "");
  if (!ops[op]) return D.send(res, 404, { error: "Unknown action." });
  if (req.method !== "POST" && !(op === "me" && req.method === "GET")) return D.send(res, 405, { error: "Use POST" });
  try {
    const [code, out] = await ops[op](req, body(req));
    D.send(res, code, out);
  } catch (e) {
    console.error("auth " + op + ": " + (e && e.message));
    D.send(res, /not set on this site|isn't set up/.test(String(e && e.message)) ? 503 : 500, { error: /not set on this site|isn't set up/.test(String(e && e.message)) ? e.message : "Something went wrong. Try again in a minute." });
  }
});
module.exports.hashPassword = hashPassword;
module.exports.checkPassword = checkPassword;
module.exports.sendLink = sendLink;
