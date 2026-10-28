// UI smoke test (npm run test:ui, needs the jsdom dev dependency): boot index.html + attribution.js in jsdom with a fake Supabase, walk sign-in → wizard → workspace → settings pages.
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
const fakeSupabase = {
  createClient: function (url, key, opts) {
    return {
      _opts: opts,
      auth: {
        onAuthStateChange: () => {}, getSession: () => result({ session: { user, access_token: "tok" } }),
        signOut: () => result({}), updateUser: () => result({ user })
      },
      from: (t) => query(t),
      rpc: (fn, args) => {
        calls.push({ op: "rpc", fn, args });
        if (fn === "accept_invites") return result(0);
        if (fn === "my_orgs") return result(orgs.slice());
        if (fn === "create_organization") { orgs.push({ id: "11111111-1111-4111-8111-111111111111", public_id: "pub123", name: args.p_name, logo: null, currency: args.p_currency, tz_offset_min: args.p_tz_offset_min, crm_name: args.p_crm_name, role: "admin" }); return result(orgs[0].id); }
        return result(null);
      }
    };
  }
};
const dom = new JSDOM(html, {
  url: "https://app.example.test/", runScripts: "dangerously", pretendToBeVisual: true,
  beforeParse(w) {
    w.supabase = fakeSupabase;
    w.XLSX = {};
    w.fetch = (u) => { calls.push({ op: "fetch", u: String(u) }); return Promise.resolve({ ok: String(u).indexOf("/api/config") >= 0, status: 200, json: () => Promise.resolve({ supabaseUrl: "https://db.test", supabaseAnonKey: "anon" }), text: () => Promise.resolve("{}") }); };
    w.Headers = class { constructor(h) { this.m = {}; if (h) Object.keys(h).forEach((k) => (this.m[k.toLowerCase()] = h[k])); } set(k, v) { this.m[k.toLowerCase()] = v; } get(k) { return this.m[k.toLowerCase()]; } };
    w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
    w.scrollTo = () => {};
    w.addEventListener("error", (e) => errors.push(e.message));
    w.console.error = (...a) => errors.push(a.map(String).join(" "));
  }
});
const w = dom.window, $ = (s) => w.document.querySelector(s), text = () => w.document.getElementById("view").textContent;
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 50));
const ok = (c, m) => { if (!c) { console.log("✗ " + m); process.exitCode = 1; } else console.log("✓ " + m); };
(async () => {
  await wait(300);
  ok(/Set up your workspace/.test(text()), "signed in without a workspace → the workspace wizard");
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
  let seen = null; const realFetch = w.fetch; w.fetch = (u, o) => { seen = o.headers.get("x-org-id"); return realFetch(u, o); };
  await cl._opts.global.fetch("https://db.test/rest/v1/crm_leads", {}); w.fetch = realFetch;
  ok(seen === "11111111-1111-4111-8111-111111111111", "database calls carry x-org-id");
  ok(w.eval("tzLabel()") === "UTC+4" && /UTC\+4/.test(w.eval("whText()")), "time zone and working hours follow the workspace (" + w.eval("whText()") + ")");
  // other pages render without errors
  for (const tab of ["overview", "settings", "attribution", "builder", "ask", "capi", "help"]) { try { w.eval("state.tab = '" + tab + "'; render();"); } catch (e) { errors.push(tab + ": " + e.message); } await wait(30); }
  w.eval("state.tab = 'settings'; state.setTab = 'hours'; render();"); await wait(30);
  ok(/Save working hours/.test(text()) && /Add India's 2026 public holidays/.test(text()), "working hours editor and holiday preset on Settings › Working hours");
  w.eval("state.tab = 'settings'; state.setTab = 'growth'; render();"); await wait(30);
  ok(/data-org=\\?"pub123/.test(text()) || /data-org="pub123"/.test(text()), "tracking snippet carries the workspace id");
  ok(!errors.length, "no script errors" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  /* a site without its Supabase settings says so, instead of quietly showing upload-only mode */
  const d2 = new JSDOM(html, { url: "https://app.example.test/", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(x) {
    x.XLSX = {}; x.scrollTo = () => {}; x.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
    x.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: "SUPABASE_URL and SUPABASE_ANON_KEY are not set on this site yet." }), text: () => Promise.resolve("") });
    x.addEventListener("error", (e) => errors.push("setup page: " + e.message)); } });
  await wait(300);
  const t2 = () => d2.window.document.getElementById("view").textContent;
  ok(/isn't connected to its database yet/.test(t2()) && /SUPABASE_URL and SUPABASE_ANON_KEY are not set/.test(t2()), "missing site settings → a setup screen that names what's missing");
  [...d2.window.document.querySelectorAll("button")].filter((b) => /Use without an account/.test(b.textContent))[0].click(); await wait(50);
  ok(/No report yet/.test(t2()) && /Upload-only mode/.test(t2()), "“Use without an account” opens upload-only mode");
  ok(!errors.length, "no script errors on the setup screen" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  process.exit();
})().catch((e) => { console.log("CRASH", e.stack); process.exit(1); });
