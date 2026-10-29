// UI smoke test (npm run test:ui, needs the jsdom dev dependency): boot index.html + attribution.js in jsdom with a fake query builder and a fake /api/auth, walk sign-in → wizard → workspace → settings pages, then the email-link and setup screens.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const repo = path.join(__dirname, "..");
let html = fs.readFileSync(path.join(repo, "index.html"), "utf8");
const attr = fs.readFileSync(path.join(repo, "attribution.js"), "utf8");
html = html.replace(/<script src="https:\/\/cdnjs[^"]*"><\/script>/, "").replace('<script src="attribution.js"></script>', "<script>" + attr.split("</script>").join("<\\/script>") + "</script>");

const calls = [], errors = [];
let orgs = [], user = { id: "u1", email: "owner@acme.test", user_metadata: {}, created_at: "2026-01-01" };
function result(data, error) { return Promise.resolve({ data, error: error || null }); }
function query(table) {
  const q = { table, filters: [], _single: false };
  const chain = ["select", "eq", "in", "or", "order", "limit", "range", "gte", "lte", "lt", "not", "is", "neq", "ilike"];
  chain.forEach((m) => { q[m] = function () { q.filters.push([m].concat([].slice.call(arguments))); return q; }; });
  q.maybeSingle = () => { q._single = true; return q; };
  q.single = () => { q._single = true; return q; };
  q.upsert = (rows, o) => { calls.push({ op: "upsert", table, rows, o }); return q; };
  q.insert = (rows) => { calls.push({ op: "insert", table, rows }); return q; };
  q.update = (rows) => { calls.push({ op: "update", table, rows }); return q; };
  q.delete = () => { calls.push({ op: "delete", table }); return q; };
  q.then = (res, rej) => {
    let data = [];
    if (table === "org_settings") data = q._single ? { settings: { brands: ["Alpha"] }, updated_at: "x" } : [];
    if (table === "org_members") data = [{ email: user.email, role: "admin", user_id: "u1", invited_by: user.email }];
    if (table === "org_secrets") data = [{ key: "meta_access_token", last4: "abcd", updated_by: user.email, updated_at: "2026-10-28" }];
    if (q._single && Array.isArray(data)) data = null;
    return result(data).then(res, rej);
  };
  return q;
}
/* a token the page can read the expiry of (it never checks the signature: the server does) */
const TOKEN = "h." + Buffer.from(JSON.stringify({ exp: 4102444800, sub: "u1", role: "authenticated" })).toString("base64").replace(/=+$/, "") + ".sig";
function apiFake(calls) {
  return (u, o) => {
    u = String(u); o = o || {}; calls.push({ op: "fetch", u, body: o.body, headers: o.headers });
    const reply = (st, b) => Promise.resolve({ ok: st < 400, status: st, json: () => Promise.resolve(b), text: () => Promise.resolve(JSON.stringify(b)) });
    if (u.indexOf("/api/config") >= 0) return reply(200, { apiUrl: "https://db.test", appName: "Lead Performance", mail: true });
    const op = (u.match(/\/api\/auth\?op=(\w+)/) || [])[1], b = o.body ? JSON.parse(o.body) : {};
    if (op === "login") return b.password === "right password" ? reply(200, { token: TOKEN, user }) : reply(401, { error: "Invalid login credentials" });
    if (op === "signup" || op === "forgot") return reply(200, { ok: true });
    if (op === "verify") return b.password === "right password" ? reply(200, { token: TOKEN, user }) : reply(401, { error: "That isn't the password chosen with this sign-up." });
    if (op === "me") return reply(200, { user });
    return reply(404, {});
  };
}
const fakeSupabase = {
  createClient: function (url, key, opts) {
    return {
      _opts: opts,
      from: (t) => query(t),
      rpc: (fn, args) => {
        calls.push({ op: "rpc", fn, args });
        if (fn === "accept_invites") return result(0);
        if (fn === "my_orgs") return result(orgs.slice());
        if (fn === "create_organization") { orgs.push({ id: "11111111-1111-4111-8111-111111111111", public_id: "pub123", name: args.p_name, logo: null, currency: args.p_currency, tz_offset_min: args.p_tz_offset_min, crm_name: args.p_crm_name, role: "admin", is_owner: true }); return result(orgs[0].id); }
        return result(null);
      }
    };
  }
};
class Hdr { constructor(h) { this.m = {}; if (h) Object.keys(h).forEach((k) => (this.m[k.toLowerCase()] = h[k])); } set(k, v) { this.m[k.toLowerCase()] = v; } get(k) { return this.m[k.toLowerCase()]; } delete(k) { delete this.m[k.toLowerCase()]; } }
const dom = new JSDOM(html, {
  url: "https://app.example.test/", runScripts: "dangerously", pretendToBeVisual: true,
  beforeParse(w) {
    w.supabase = fakeSupabase;
    w.XLSX = {};
    w.fetch = apiFake(calls);
    w.Headers = Hdr;
    w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
    w.scrollTo = () => {};
    w.addEventListener("error", (e) => errors.push(e.message));
    w.console.error = (...a) => errors.push(a.map(String).join(" "));
  }
});
const w = dom.window, $ = (s) => w.document.querySelector(s), text = () => w.document.getElementById("view").textContent;
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 50));
const ok = (c, m) => { if (!c) { console.log("✗ " + m); process.exitCode = 1; } else console.log("✓ " + m); };
const submit = (doc) => doc.querySelector("form").dispatchEvent(new doc.defaultView.Event("submit", { cancelable: true, bubbles: true }));
(async () => {
  await wait(300);
  ok(/Sign in/.test(text()) && /Forgot password\?/.test(text()), "signed out → the sign-in page, with “Forgot password?”");
  $("#sb-email").value = "owner@acme.test"; $("#sb-pw").value = "wrong password"; submit(w.document); await wait(100);
  ok(/Wrong email or password/.test(text()), "a wrong password says so");
  $("#sb-pw").value = "right password"; submit(w.document); await wait(300);
  ok(/Set up your workspace/.test(text()), "signed in without a workspace → the workspace wizard");
  ok(w.localStorage.getItem("lp-session") && JSON.parse(w.localStorage.getItem("lp-session")).token === TOKEN, "the session is kept in this browser");
  ok(/Lead Performance/.test(w.document.body.textContent) && !/Lead Performance · Lead Performance/.test(w.document.title), "neutral product name before a workspace exists");
  w.document.getElementById("wz-name").value = "Acme Homes";
  w.document.getElementById("wz-crm").value = "Zoho CRM";
  w.document.getElementById("wz-tz").value = "240";
  w.document.getElementById("wz-brands").value = "Alpha\nBeta";
  w.document.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  await wait(400);
  const co = calls.filter((c) => c.fn === "create_organization")[0];
  ok(co && co.args.p_name === "Acme Homes" && co.args.p_tz_offset_min === 240 && co.args.p_brands.length === 2, "wizard calls create_organization with the form values");
  ok(w.document.title === "Acme Homes · Lead Performance", "title shows the workspace (" + w.document.title + ")");
  ok(($("#org-crumb") || {}).textContent.indexOf("Acme Homes") === 0, "header shows the workspace");
  ok(/Workspace/.test(text()), "lands on Settings › Workspace");
  ok(/Kept encrypted/.test(text()) && /Set · ends …abcd|ends …abcd/.test(w.document.body.innerHTML), "tokens card shows a stored token only by its last 4");
  const cl = w.eval("sb.client"), h = new w.Headers({});
  // the client's fetch wrapper adds the workspace header
  let seen = null; const realFetch = w.fetch; w.fetch = (u, o) => { seen = o.headers; return realFetch(u, o); };
  await cl._opts.global.fetch("https://db.test/rest/v1/crm_leads", { headers: { apikey: "own-login", authorization: "Bearer own-login" } }); w.fetch = realFetch;
  ok(seen.get("x-org-id") === "11111111-1111-4111-8111-111111111111", "database calls carry x-org-id");
  ok(seen.get("authorization") === "Bearer " + TOKEN && !seen.get("apikey"), "…and the sign-in token, not a placeholder key");
  ok(w.eval("tzLabel()") === "UTC+4" && /UTC\+4/.test(w.eval("whText()")), "time zone and working hours follow the workspace (" + w.eval("whText()") + ")");
  // other pages render without errors
  for (const tab of ["overview", "settings", "attribution", "builder", "ask", "capi", "help"]) { try { w.eval("state.tab = '" + tab + "'; render();"); } catch (e) { errors.push(tab + ": " + e.message); } await wait(30); }
  w.eval("state.tab = 'settings'; state.setTab = 'hours'; render();"); await wait(30);
  ok(/Save working hours/.test(text()) && /Add India's 2026 public holidays/.test(text()), "working hours editor and holiday preset on Settings › Working hours");
  w.eval("state.tab = 'settings'; state.setTab = 'growth'; render();"); await wait(30);
  ok(/data-org=\\?"pub123/.test(text()) || /data-org="pub123"/.test(text()), "tracking snippet carries the workspace id");
  // right after an upload (data not reloaded from the database yet), saved brands still go to the workspace
  w.eval("state.source = 'upload'; state.tab = 'settings'; state.setTab = 'brands'; state.setDraft = null; render(); state.setDraft.brands = ['Natuf']; applySettings();");
  await wait(1200);
  const pushed = calls.filter((c) => c.op === "upsert" && c.table === "org_settings").pop();
  ok(pushed && JSON.stringify(pushed.rows.settings.brands) === '["Natuf"]', "brands saved after an upload are shared with the workspace");
  ok(!errors.length, "no script errors" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  /* the email link: /?verify=… asks for the sign-up's password and signs in; the address bar is cleaned */
  const d3 = new JSDOM(html, { url: "https://app.example.test/?verify=link123", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(x) {
    x.supabase = fakeSupabase; x.XLSX = {}; x.scrollTo = () => {}; x.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
    x.fetch = apiFake(calls); x.Headers = Hdr; x.addEventListener("error", (e) => errors.push("verify page: " + e.message)); } });
  await wait(300);
  const t3 = () => d3.window.document.getElementById("view").textContent;
  ok(/Confirm your email/.test(t3()) && !d3.window.document.getElementById("sb-email") && d3.window.location.search === "", "confirmation link → password form, link removed from the address bar");
  d3.window.document.getElementById("sb-pw").value = "right password"; submit(d3.window.document); await wait(300);
  const vc = calls.filter((c) => /op=verify/.test(c.u)).pop();
  ok(vc && JSON.parse(vc.body).token === "link123", "the link's token goes to /api/auth?op=verify");
  ok(d3.window.eval("sb.status") === "ready" && d3.window.eval("sb.email") === "owner@acme.test" && !/Confirm your email/.test(t3()), "confirmed, signed in, in the workspace");
  /* several workspaces: signing in asks which one; a reload keeps the last one; the profile menu can switch */
  orgs.push({ id: "22222222-2222-4222-8222-222222222222", public_id: "pub456", name: "Beta Foods", logo: null, currency: "INR", tz_offset_min: 330, crm_name: "Zoho", role: "viewer" });
  const boot = (pre) => new JSDOM(html, { url: "https://app.example.test/", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(x) {
    x.supabase = fakeSupabase; x.XLSX = {}; x.scrollTo = () => {}; x.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
    x.fetch = apiFake(calls); x.Headers = Hdr; if (pre) pre(x); x.addEventListener("error", (e) => errors.push("workspaces: " + e.message)); } });
  const d4 = boot(), t4 = () => d4.window.document.getElementById("view").textContent;
  await wait(300);
  d4.window.document.getElementById("sb-email").value = "owner@acme.test"; d4.window.document.getElementById("sb-pw").value = "right password"; submit(d4.window.document); await wait(300);
  ok(/Choose a workspace/.test(t4()) && /Acme Homes/.test(t4()) && /Beta Foods/.test(t4()) && /Viewer/.test(t4()) && d4.window.eval("sb.status") === "choose" && !d4.window.eval("sb.org"),
    "signing in with two workspaces → “Choose a workspace”, nothing opened yet");
  [...d4.window.document.querySelectorAll(".ws-pick")].filter((b) => /Beta Foods/.test(b.textContent))[0].click(); await wait(300);
  ok(d4.window.eval("sb.status") === "ready" && d4.window.eval("sb.org.name") === "Beta Foods" && d4.window.eval("sb.role") === "viewer" && d4.window.localStorage.getItem("lp-org") === "22222222-2222-4222-8222-222222222222",
    "picking one opens it with that workspace's role, and remembers it");
  const d5 = boot((x) => { x.localStorage.setItem("lp-session", JSON.stringify({ token: TOKEN, user })); x.localStorage.setItem("lp-org", "22222222-2222-4222-8222-222222222222"); }), t5 = () => d5.window.document.getElementById("view").textContent;
  await wait(300);
  ok(d5.window.eval("sb.status") === "ready" && d5.window.eval("sb.org.name") === "Beta Foods" && !/Choose a workspace/.test(t5()), "a reload while signed in goes straight back to the last workspace");
  d5.window.eval("sb.status = 'choose'; render();"); await wait(50);
  ok(/Choose a workspace/.test(t5()) && /open now/.test(t5()) && [...d5.window.document.querySelectorAll("button")].some((b) => b.textContent === "Cancel"), "Switch workspace shows the list with Cancel and the open one marked");
  [...d5.window.document.querySelectorAll(".ws-pick")].filter((b) => /Acme Homes/.test(b.textContent))[0].click(); await wait(300);
  ok(d5.window.eval("sb.org.name") === "Acme Homes" && d5.window.eval("sb.role") === "admin" && d5.window.eval("sb.status") === "ready", "switching opens the other workspace, with its own role");
  /* Ask AI and Settings › AI: owners only for the settings; everyone sees on / off */
  const W5 = d5.window, nav5 = () => [...W5.document.querySelectorAll(".set-nav button")].map((b) => b.textContent);
  W5.eval("state.tab = 'settings'; state.setTab = 'ai'; render();"); await wait(200);
  ok(nav5().indexOf("AI") >= 0 && /Ask AI is on for this workspace/.test(t5()) && W5.document.querySelectorAll('input[aria-label$=" key"]').length === 4, "an owner sees Settings › AI with the provider, model and four key fields");
  W5.document.getElementById("ai-on").click(); await wait(30);
  W5.document.getElementById("ai-prov").value = "compatible"; W5.document.getElementById("ai-prov").dispatchEvent(new W5.Event("change")); await wait(30);
  W5.document.getElementById("ai-model").value = "some-model"; W5.document.getElementById("ai-model").dispatchEvent(new W5.Event("input"));
  W5.document.getElementById("ai-base").value = "https://openrouter.ai/api/v1"; W5.document.getElementById("ai-base").dispatchEvent(new W5.Event("input"));
  [...W5.document.querySelectorAll("button")].filter((b) => b.textContent === "Save AI settings")[0].click(); await wait(200);
  const sc = calls.filter((c) => c.fn === "set_ai_config").pop();
  ok(sc && sc.args.p_enabled === true && sc.args.p_provider === "compatible" && sc.args.p_model === "some-model" && sc.args.p_base_url === "https://openrouter.ai/api/v1", "Save AI settings sends provider, model and address to set_ai_config");
  W5.eval("state.tab = 'ask'; render();"); await wait(200);
  ok(/isn't set up yet/.test(t5()) && [...W5.document.querySelectorAll("button")].filter((b) => b.textContent === "Ask")[0].disabled, "Ask AI off: a clear message and Ask is disabled");
  W5.eval("sbSwitchOrg('22222222-2222-4222-8222-222222222222')"); await wait(300);
  W5.eval("state.tab = 'settings'; state.setTab = 'ai'; render();"); await wait(100);
  ok(nav5().indexOf("AI") < 0 && !/Ask AI is on for this workspace/.test(t5()), "a viewer (not owner) has no AI section, even when asking for it");
  W5.eval("state.tab = 'ask'; render();"); await wait(200);
  ok(/workspace owner can switch it on/.test(t5()), "…and Ask AI tells them the owner sets it up");
  /* a site without its database settings says so, instead of quietly showing upload-only mode */
  const d2 = new JSDOM(html, { url: "https://app.example.test/", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(x) {
    x.XLSX = {}; x.scrollTo = () => {}; x.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
    x.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: "API_URL and JWT_SECRET are not set on this site yet." }), text: () => Promise.resolve("") });
    x.addEventListener("error", (e) => errors.push("setup page: " + e.message)); } });
  await wait(300);
  const t2 = () => d2.window.document.getElementById("view").textContent;
  ok(/isn't connected to its database yet/.test(t2()) && /API_URL and JWT_SECRET are not set/.test(t2()), "missing site settings → a setup screen that names what's missing");
  [...d2.window.document.querySelectorAll("button")].filter((b) => /Use without an account/.test(b.textContent))[0].click(); await wait(50);
  ok(/No report yet/.test(t2()) && /Upload-only mode/.test(t2()), "“Use without an account” opens upload-only mode");
  ok(!errors.length, "no script errors on the setup screen" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  process.exit();
})().catch((e) => { console.log("CRASH", e.stack); process.exit(1); });
