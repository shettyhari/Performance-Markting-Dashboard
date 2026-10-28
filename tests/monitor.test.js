// Tests for the monitoring module (api/_monitor.js) and the change-alert format (api/_activity.js).
// Run: node tests/monitor.test.js   — no network, no real data: the database API, Meta and Telegram are replaced by in-memory fakes.
const assert = require("assert");
process.env.META_ACCESS_TOKEN = "test"; process.env.TELEGRAM_BOT_TOKEN = "test";
const M = require("../api/_monitor");
const ACT = require("../api/_activity");
const T = require("../api/_tg");

let passed = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const istDay = (o) => new Date(Date.now() + 330 * 60000 + (o || 0) * 864e5).toISOString().slice(0, 10);

/* ---------- fixture: 3 listed brands + unmapped spend ---------- */
function fixture() {
  const camp = [], crm = {};
  const add = (brand, campaign, o, spend, leads, imp, clk, lt) => camp.push({ brand, campaign, day: istDay(o), spend, leads, impressions: imp || 0, clicks: clk || 0, lead_type: lt !== false });
  const addCrm = (brand, o, n, ql) => { crm[brand + "|" + istDay(o)] = { crm: n, ql }; };
  for (let o = -31; o <= -1; o++) {
    add("Nexus", "Nexus | Leads", o, 5000, 50, 50000, 500); addCrm("Nexus", o, 48, 20);
    add("Coastal", "Coastal | Form", o, 2000, o === -1 ? 5 : 20, 20000, 200); addCrm("Coastal", o, o === -1 ? 1 : 19, 8);
    if (o >= -3) add("Arco", "Arco | WA", o, 1500, 10, 10000, 100);
  }
  // Arco also ran two small days in the last full Mon–Sun week (whatever weekday the tests run on): too little to judge
  const dow = (new Date(istDay(0) + "T00:00:00Z").getUTCDay() + 6) % 7, lastMon = -dow - 7;
  [lastMon, lastMon + 1].forEach((o) => { if (o < -3) add("Arco", "Arco | WA", o, 300, 2, 2000, 20); });
  add("Nexus", "Nexus | Leads", 0, 3000, 15, 30000, 300); addCrm("Nexus", 0, 14, 0);
  add("Coastal", "Coastal | WA", 0, 1000, 10, 10000, 100);
  add("Coastal", "Coastal | Form", 0, 1600, 0, 9000, 90);      // spending, no leads, used to get leads
  add("Unmapped", "Misc test campaign", 0, 700, 2, 5000, 20);  // outside the listed brands
  const brand = {};
  camp.forEach((r) => { const k = r.brand + "|" + r.day, b = brand[k] || (brand[k] = { brand: r.brand, day: r.day, spend: 0, leads: 0, impressions: 0, clicks: 0, crm: 0, ql: 0, rows_n: 0 });
    b.spend += r.spend; b.leads += r.leads; b.impressions += r.impressions; b.clicks += r.clicks; b.rows_n++; });
  Object.keys(crm).forEach((k) => { const b = brand[k] || (brand[k] = { brand: k.split("|")[0], day: k.split("|")[1], spend: 0, leads: 0, impressions: 0, clicks: 0, crm: 0, ql: 0, rows_n: 0 }); b.crm = crm[k].crm; b.ql = crm[k].ql; });
  return { camp, brand: Object.values(brand) };
}
function settings(extra) {
  return Object.assign({ brands: ["Nexus", "Coastal", "Arco"], keywords: [["nexus", "Nexus"], ["coastal", "Coastal"], ["arco", "Arco"]], excludedCampaigns: [], metaAutoSync: true,
    metaAccounts: [{ id: "1", name: "Acc One", on: true }, { id: "2", name: "Acc Two", on: true }, { id: "3", name: "Acc Three", on: true }],
    alerts: { quietFrom: 0, quietTo: 0, summary: true } }, extra || {});
}

/* ---------- fakes ---------- */
function fakeDb(fx) {
  const db = { issues: {}, state: { telegram: { chat_id: 42 } }, log: [] };
  db.fetch = async (path, opt) => {
    opt = opt || {}; const method = opt.method || "GET", body = opt.body ? JSON.parse(opt.body) : null;
    const page = (rows) => { const m = /offset=(\d+)/.exec(path), off = m ? +m[1] : 0; return rows.slice(off, off + 1000); };
    if (path.indexOf("rpc/mon_brand_daily") === 0) return page(fx.brand.filter((r) => r.day >= body.p_from));
    if (path.indexOf("rpc/mon_campaign_daily") === 0) return page(fx.camp.filter((r) => r.day >= body.p_from));
    if (path.indexOf("uploads?") === 0) return [{ meta_files: ["Meta API · auto-sync"], crm_file: "", uploaded_at: new Date(Date.now() - 10 * 60000).toISOString() }, { meta_files: [], crm_file: "TeleCRM · n8n push", uploaded_at: new Date(Date.now() - 5 * 60000).toISOString() }];
    if (path.indexOf("meta_activity?") === 0) return db.acts || [];
    if (path.indexOf("alert_issues?status=eq.open") === 0) return Object.values(db.issues).filter((r) => r.status === "open").map((r) => Object.assign({}, r));
    if (path.indexOf("alert_issues?on_conflict") === 0) { const k0 = Object.keys(body[0]).sort().join(); body.forEach((r) => { if (Object.keys(r).sort().join() !== k0) throw new Error("PostgREST: All object keys must match"); });
      body.forEach((r) => { db.issues[r.key] = Object.assign({ notify_count: 0, missed: 0 }, db.issues[r.key] || {}, r); }); return null; }
    if (path.indexOf("alert_state?k=eq.") === 0) { const k = decodeURIComponent(path.split("k=eq.")[1].split("&")[0]); return db.state[k] !== undefined && db.state[k] !== null ? [{ v: db.state[k] }] : []; }
    if (path.indexOf("alert_state?on_conflict") === 0) { body.forEach((r) => { db.state[r.k] = r.v; }); return null; }
    if (path.indexOf("alert_log") === 0) { db.log.push.apply(db.log, body); return null; }
    throw new Error("fake db: unexpected " + method + " " + path);
  };
  return db;
}
const sent = []; let tgFail = false, metaFail = false;
global.fetch = async (url, opt) => {
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (url.indexOf("api.telegram.org") >= 0) { if (tgFail) return { ok: false, status: 502, json: async () => ({ ok: false, description: "Bad Gateway" }) }; sent.push(JSON.parse(opt.body).text); return ok({ ok: true, result: {} }); }
  if (url.indexOf("graph.facebook.com") >= 0) {
    if (metaFail) return { ok: false, status: 400, json: async () => ({ error: { message: "Invalid OAuth access token", code: 190 } }) };
    if (url.indexOf("/insights?level=account") >= 0) { const m = /act_(\d+)\//.exec(url); return ok({ data: [{ spend: String((global.__acctSpend || {})[m[1]] || 0), reach: "12345" }] }); }
    if (url.indexOf("/me/adaccounts") >= 0) return ok({ data: [{ id: "act_1", name: "Acc One", account_status: 1 }, { id: "act_2", name: "Acc Two", account_status: 3 }] });
    if (url.indexOf("DISAPPROVED") >= 0) return ok({ data: url.indexOf("act_1/") >= 0 ? [{ id: "9", name: "Nexus Reel 3", effective_status: "DISAPPROVED", campaign: { name: "Nexus | Leads" } }] : [] });
    if (url.indexOf("/ads?") >= 0) return ok({ data: url.indexOf("act_1/") >= 0 ? [{ id: "1", adset_id: "s1", campaign_id: "c1", campaign: { name: "Nexus | Leads" } }, { id: "2", adset_id: "s2", campaign_id: "c2", campaign: { name: "Arco | WA" } }] : [] });
  }
  throw new Error("fake fetch: unexpected " + url);
};
async function prepared(S, db, opt) { const D = await M.loadData(S, db.fetch, opt); D.hour = 15; return D; }

/* ---------- 1. reconciliation ---------- */
test("totals = sum of listed brands; outside spend shown separately, never added silently", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(), D = await prepared(S, db), Mx = M.metrics(D);
  assert.strictEqual(Mx.total.spend, 3000 + 2600);                      // Nexus + Coastal today (Arco 0)
  assert.strictEqual(Mx.total.leads, 15 + 10);
  assert.strictEqual(Mx.outside.spend, 700);
  assert.deepStrictEqual(Mx.outsideNames, ["Unmapped"]);
  assert.ok(Mx.recon.ok);
  assert.strictEqual(Mx.recon.all, 6300);
  const txt = M.reportText(D, Mx, M.detect(D, Mx));
  assert.ok(txt.indexOf("₹5,600") >= 0, "overall spend in the report is the listed-brand total");
  assert.ok(/Not in a listed brand: ₹700 \(Unmapped\)/.test(txt), "unmapped spend is disclosed");
  assert.ok(txt.indexOf("Totals check failed") < 0);
  // brand lines add up to the total
  const brandSpends = (txt.split("<b>BRANDS</b>")[1].split("<b>HIGHLIGHTS</b>")[0].match(/\n₹[\d,]+/g) || []).map((s) => +s.replace(/[^\d]/g, ""));
  assert.strictEqual(brandSpends.reduce((a, b) => a + b, 0), 5600);
});

/* ---------- 2. performance alerts ---------- */
test("CPL +30% vs 7-day baseline, lead drop, zero-lead campaign, CRM gap, no spend", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(), D = await prepared(S, db), found = M.detect(D, M.metrics(D)), kinds = (k) => found.filter((x) => x.key.indexOf(k) === 0);
  const cpl = kinds("cpl_up|Nexus")[0]; assert.ok(cpl, "Nexus CPL alert");
  assert.strictEqual(cpl.current, "₹200"); assert.strictEqual(cpl.baseline, "₹100"); assert.ok(Math.abs(cpl.change - 1) < 1e-9); assert.strictEqual(cpl.severity, "high");
  assert.ok(cpl.action && cpl.impact);
  assert.ok(kinds("lead_drop|Coastal")[0], "Coastal lead drop (5 vs 20/day)");
  const z = kinds("zero|Coastal|Coastal | Form")[0]; assert.ok(z, "zero-lead campaign"); assert.strictEqual(z.severity, "high");
  assert.ok(kinds("sync|Coastal")[0], "Coastal 1 of 5 leads in TeleCRM yesterday");
  assert.ok(!kinds("sync|Nexus")[0], "Nexus 96% reached TeleCRM: no alert");
  const ns = kinds("no_spend|Arco")[0]; assert.ok(ns && ns.confirmed === false, "Arco usually spends, nothing today: suspected");
});
test("minimum sample: no CPL alert below the minimum leads; per-brand thresholds override global", async () => {
  const fx = fixture(), db = fakeDb(fx);
  let S = settings({ alerts: { quietFrom: 0, quietTo: 0, th: { minLeads: 20 } } }), D = await prepared(S, db);
  assert.ok(!M.detect(D, M.metrics(D)).some((x) => x.key.indexOf("cpl_up|Nexus") === 0), "15 leads < 20 minimum");
  S = settings({ alerts: { quietFrom: 0, quietTo: 0, thBrand: { Nexus: { cplUp: 150 } } } }); D = await prepared(S, db);
  assert.ok(!M.detect(D, M.metrics(D)).some((x) => x.key.indexOf("cpl_up|Nexus") === 0), "Nexus allows +150%");
  assert.strictEqual(M.thOf(S, "Nexus").cplUp, 150); assert.strictEqual(M.thOf(S, "Coastal").cplUp, 30);
});

/* ---------- 3. account health ---------- */
test("account health: payment due = critical confirmed; unseen account = suspected; never 'healthy' when unverified", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(), D = await prepared(S, db), Mx = M.metrics(D), found = M.detect(D, Mx);
  const st = found.find((x) => x.key === "account_status|act_2"); assert.ok(st); assert.strictEqual(st.severity, "critical"); assert.strictEqual(st.confirmed, true);
  assert.ok(/payment/i.test(st.action));
  const un = found.find((x) => x.key === "account_access|act_3"); assert.ok(un && un.confirmed === false);
  assert.ok(found.find((x) => x.key.indexOf("rejected|") === 0), "rejected ad");
  metaFail = true;
  try { const D2 = await prepared(S, db), F2 = M.detect(D2, M.metrics(D2)), txt = M.reportText(D2, M.metrics(D2), F2);
    assert.ok(F2.find((x) => x.key === "account_unverified"), "status couldn't be verified is an issue");
    assert.ok(txt.indexOf("✅ No account or feed issues found") < 0, "doesn't claim healthy"); }
  finally { metaFail = false; }
});

/* ---------- 4. anti-spam: dedupe, material change, resolution, acknowledgement, quiet hours, retry ---------- */
test("issues: notified once, again only on material change; resolved after 2 clear checks with a resolution", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings();
  let D = await prepared(S, db), f = M.detect(D, M.metrics(D));
  const r1 = await M.trackIssues(D, f, db.fetch); assert.ok(r1.notify.length >= 5); assert.ok(r1.notify.every((x) => x.why === "new"));
  const r2 = await M.trackIssues(D, f, db.fetch); assert.strictEqual(r2.notify.length, 0, "same issues, same values: nothing re-sent");
  const changed = f.map((x) => (x.key.indexOf("zero|") === 0 ? Object.assign({}, x, { value: x.value * 2 }) : x));
  const r3 = await M.trackIssues(D, changed, db.fetch); assert.deepStrictEqual(r3.notify.map((x) => x.why), ["changed"]);
  const rest = f.filter((x) => x.key.indexOf("zero|") !== 0);
  const r4 = await M.trackIssues(D, rest, db.fetch); assert.strictEqual(r4.resolvedNow.length, 0, "one clear check is not enough");
  const r5 = await M.trackIssues(D, rest, db.fetch); assert.strictEqual(r5.resolvedNow.length, 1); assert.strictEqual(db.issues[r5.resolvedNow[0].key].status, "resolved");
});
test("yesterday's day-keyed issue closes silently on the next day; open issues keep the same columns for PostgREST", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(), D = await prepared(S, db);
  db.issues["cpl_up|Nexus|2000-01-01"] = { key: "cpl_up|Nexus|2000-01-01", kind: "cpl_up", severity: "high", confirmed: true, status: "open", brand: "Nexus", account: "", campaign: "", title: "old", detail: {}, first_seen: "2000-01-01T00:00:00Z", last_seen: "2000-01-01T00:00:00Z", last_notified: "2000-01-01T00:00:00Z", notified_value: 1, notify_count: 1, missed: 0, resolved_at: null, ack_by: null, ack_at: null };
  const r = await M.trackIssues(D, M.detect(D, M.metrics(D)), db.fetch);
  assert.strictEqual(db.issues["cpl_up|Nexus|2000-01-01"].status, "resolved"); assert.ok(!r.resolvedNow.some((o) => o.key === "cpl_up|Nexus|2000-01-01"), "no Telegram for a day that ended");
});
test("acknowledged issues get no reminders; reminders after the interval otherwise", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(), D = await prepared(S, db), f = M.detect(D, M.metrics(D));
  await M.trackIssues(D, f, db.fetch);
  const old = new Date(Date.now() - 30 * 3600e3).toISOString();
  Object.values(db.issues).forEach((r) => { r.last_notified = old; });
  const k = f.find((x) => x.key.indexOf("zero|") === 0).key; db.issues[k].ack_at = new Date().toISOString();
  const r = await M.trackIssues(D, f, db.fetch);
  assert.ok(r.notify.length > 0 && r.notify.every((x) => x.why === "reminder")); assert.ok(!r.notify.some((x) => x.key === k));
});
test("quiet hours hold back everything except critical", async () => {
  const fx = fixture(), db = fakeDb(fx), h = new Date(Date.now() + 330 * 60000).getUTCHours();
  const S = settings({ alerts: { quietFrom: h, quietTo: (h + 2) % 24 } }), D = await prepared(S, db), r = await M.trackIssues(D, M.detect(D, M.metrics(D)), db.fetch);
  assert.ok(r.notify.length > 0 && r.notify.every((x) => x.severity === "critical"));
});
test("run(): critical sent alone, others grouped, report sent; failed Telegram goes to the outbox and is retried", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(); sent.length = 0;
  const out = await M.run(S, db.fetch);
  assert.ok(out.sent.indexOf("critical") >= 0 && out.sent.some((s) => s.indexOf("warnings:") === 0) && out.sent.indexOf("report") >= 0);
  assert.ok(sent.some((t) => /CRITICAL · CONFIRMED/.test(t)) && sent.some((t) => /PERFORMANCE ALERTS/.test(t)) && sent.some((t) => /Test Co Ads · Today/.test(t)));
  const out2 = await M.run(S, db.fetch); assert.strictEqual(out2.notify, 0, "nothing new on the next run");
  assert.ok(out2.sent.indexOf("report") < 0, "report waits for its 30-minute slot");
  db.issues = {}; tgFail = true; await M.run(S, db.fetch, { force: true }); tgFail = false;
  assert.ok((db.state.outbox || []).length > 0, "failed sends kept");
  sent.length = 0; db.state.reports = { last: new Date().toISOString(), recap: istDay(0), weekly: "x" };
  await M.run(S, db.fetch); assert.strictEqual((db.state.outbox || []).length, 0, "outbox flushed"); assert.ok(sent.length > 0);
});

/* ---------- 5. weekly / pacing: only configured targets ---------- */
test("weekly: budget pacing only where a budget is set; labels from real numbers", async () => {
  const fx = fixture(), db = fakeDb(fx), mk = istDay(0).slice(0, 7);
  const S = settings({ report: { months: { [mk]: { brands: { Nexus: { budget: 100000, leads: 900 } } } } } }), D = await prepared(S, db, { noMeta: true }), W = M.weekly(D);
  const n = W.rows.find((r) => r.brand === "Nexus"), c = W.rows.find((r) => r.brand === "Coastal");
  assert.strictEqual(n.budget, 100000); assert.ok(n.util > 0); assert.strictEqual(c.budget, null); assert.strictEqual(c.leadsTarget, null);
  const txt = M.weeklyText(W); assert.ok(/Coastal[\s\S]*no budget set/.test(txt));
});

/* ---------- 6. change notifications ---------- */
test("META ACCOUNT CHANGE DETECTED: real previous / new values, % and ₹ difference; missing actor not invented", () => {
  const e = { event_type: "update_ad_set_budget", account_name: "Acc One", brand: "Nexus", campaign: "Nexus | Leads", adset: "Broad 25-45", event_time: "2026-10-27T05:30:00Z",
    actor_name: "", application_name: "", extra: JSON.stringify({ old_value: 500000, new_value: 700000 }) };
  const t = ACT.changeBlock(e, T.esc, () => "27 Oct, 11:00 am");
  assert.ok(t.indexOf("📝 <b>META ACCOUNT CHANGE DETECTED</b>") === 0);
  ["Brand: Nexus", "Ad Account: Acc One", "Campaign: Nexus | Leads", "Previous: ₹5,000/day", "New: ₹7,000/day", "Change: +40%", "Changed at: 27 Oct, 11:00 am IST", "Budget increased by ₹2,000", "Action: Verify whether this change was planned."].forEach((s) => assert.ok(t.indexOf(T.esc(s)) >= 0, "missing " + s + "\n" + t));
  assert.ok(/Changed by: Not given by Meta/.test(t));
  const t2 = ACT.changeBlock({ event_type: "update_ad_set_target_spec", account_name: "A", campaign: "C", event_time: "2026-10-27T05:30:00Z", actor_name: "Ravi", extra: null }, T.esc, () => "x");
  assert.ok(/not given in detail by Meta/.test(t2) && /Changed by: Ravi/.test(t2) && t2.indexOf("Previous: ₹") < 0);
});

/* ---------- 7. full brand-wise reports (api/_reports.js) ---------- */
const Rp = require("../api/_reports");
const tagless = (s) => s.replace(/<[^>]+>/g, "");
function brandBlocks(parts) { return parts.join("\n").split("\n").filter((l) => l.indexOf("🏢 ") === 0).map((l) => tagless(l).slice(3)); }
test("daily report: every configured brand once (even with no activity), overall = sum of brands, blended CPL from totals, N/A not 0", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings({ brands: ["Nexus", "Coastal", "Arco", "Tundra"] }), D = await prepared(S, db), found = M.detect(D, M.metrics(D));
  const rep = await M.fullDaily(D, found, D.yday), txt = rep.parts.join("\n");
  assert.deepStrictEqual(brandBlocks(rep.parts).sort(), ["Arco", "Coastal", "Nexus", "Tundra"]);
  assert.ok(!rep.partial && /complete day/.test(txt));
  // yesterday: Nexus 5000/50, Coastal 2000/5, Arco 1500/10, Tundra nothing → 8500 spend, 65 leads, blended CPL 131 (not the average of brand CPLs)
  assert.strictEqual(rep.total.spend, 8500); assert.strictEqual(rep.total.leads, 65); assert.ok(/Blended CPL: ₹131\b/.test(txt));
  assert.ok(/Totals check: ✅ overall = sum of the 4 brand blocks/.test(txt));
  const tz = tagless(txt.split("🏢 <b>Tundra</b>")[1].split("━━")[0]);
  assert.ok(/CPL: N\/A/.test(tz) && /CPQL: N\/A/.test(tz) && /CTR: N\/A/.test(tz) && /Spend: ₹0/.test(tz) && /No active campaigns · no spend/.test(tz) && /Attention: None/.test(tz), tz);
  const ca = tagless(txt.split("🏢 <b>Coastal</b>")[1].split("━━")[0]);
  assert.ok(/Meta Leads: 5\n/.test(ca) && /TeleCRM Leads: 1\n/.test(ca) && /CPL: ₹400/.test(ca) && /Attention: .*(Leads|CPL|TeleCRM)/.test(ca), ca);
  rep.parts.forEach((p, i) => { assert.ok(p.length <= 4096, "part " + (i + 1) + " is " + p.length); assert.ok(p.indexOf(rep.id) >= 0); assert.ok(p.indexOf("Date: ") >= 0); });
  assert.ok(rep.parts[0].indexOf("OVERALL PERFORMANCE") >= 0 && rep.parts[0].indexOf("🏢") < 0, "overall summary alone in part 1");
});
test("today's daily report is labelled partial; impressions unavailable shows N/A, not 0", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(), D = await prepared(S, db); D.v2 = false;
  const rep = await M.fullDaily(D, M.detect(D, M.metrics(D)), D.today), txt = tagless(rep.parts.join("\n"));
  assert.ok(rep.partial && /PARTIAL DAY/.test(txt) && /\(partial\)/.test(txt));
  assert.ok(/Impressions: N\/A/.test(txt) && !/Impressions: 0\b/.test(txt));
});
test("many brands: split at brand boundaries into numbered parts, same ID, nothing lost or repeated, each part under Telegram's limit", async () => {
  const fx = fixture(), names = []; for (let i = 1; i <= 24; i++) names.push("Brand " + i);
  names.forEach((b, i) => { for (let o = -14; o <= 0; o++) fx.brand.push({ brand: b, day: istDay(o), spend: 1000 + i * 50, leads: 8 + (i % 5), impressions: 40000, clicks: 400, crm: 7, ql: 3, rows_n: 1 }); });
  const db = fakeDb(fx), S = settings({ brands: ["Nexus", "Coastal", "Arco"].concat(names) }), D = await prepared(S, db), found = M.detect(D, M.metrics(D));
  for (const rep of [await M.fullDaily(D, found, D.yday), await M.fullWeekly(D, found)]) {
    assert.ok(rep.parts.length >= 3, rep.parts.length + " parts");
    const seen = brandBlocks(rep.parts); assert.strictEqual(seen.length, 27); assert.strictEqual(new Set(seen).size, 27);
    rep.parts.forEach((p, i) => { assert.ok(p.length <= 4096); assert.ok(p.indexOf("Part " + (i + 1) + "/" + rep.parts.length) >= 0); assert.ok(p.indexOf(rep.id) >= 0);
      const blocks = p.split("🏢 ").length - 1, lines = p.split("━━━━━━━━━━━━━━━━").length - 1; assert.strictEqual(blocks, lines, "a brand block was cut in part " + (i + 1)); });
  }
});
test("weekly report: Mon–Sun vs previous week, ratios from weekly totals, small samples not judged, budgets only where set", async () => {
  const fx = fixture(), db = fakeDb(fx), mk = istDay(0).slice(0, 7), S = settings({ brands: ["Nexus", "Coastal", "Arco", "Tundra"], report: { months: { [mk]: { brands: { Nexus: { budget: 150000 } } } } } });
  const D = await prepared(S, db), rep = await M.fullWeekly(D, M.detect(D, M.metrics(D))), txt = tagless(rep.parts.join("\n")), wb = Rp.weekBounds(D.today);
  assert.strictEqual(new Date(wb.from + "T00:00:00Z").getUTCDay(), 1); assert.strictEqual(new Date(wb.to + "T00:00:00Z").getUTCDay(), 0);
  assert.deepStrictEqual(brandBlocks(rep.parts).sort(), ["Arco", "Coastal", "Nexus", "Tundra"]);
  const na = txt.split("🏢 Nexus")[1].split("━━")[0];
  ["Spend: ₹35,000", "Previous week: ₹35,000", "Spend Change: 0%", "Meta Leads: 350", "TeleCRM Leads: 336", "Qualified Leads: 140", "CPL: ₹100", "Previous CPL: ₹100", "CPL Change: 0%", "CPQL: ₹250", "CPQL Change: 0%",
    "CTR: 1.00%", "CPC: ₹10", "CPM: ₹100", "Average Daily Spend: ₹5,000", "Average Daily Leads: 50", "Qualified Lead Rate: 42%", "Status: Steady", "budget ("].forEach((s) => assert.ok(na.indexOf(s) >= 0, "Nexus missing " + s + "\n" + na));
  const ap = txt.split("🏢 Arco")[1].split("━━")[0];
  assert.ok(/Not enough data to judge/.test(ap) && /Month budget: not set/.test(ap) && /Previous CPL: N\/A/.test(ap), ap);
  assert.ok(/No activity/.test(txt.split("🏢 Tundra")[1].split("━━")[0]));
  // on a Monday, yesterday (the fixture's Coastal lead drop) is inside last week, so Coastal counts as deteriorating
  const monday = new Date(D.today + "T00:00:00Z").getUTCDay() === 1;
  assert.ok(/Budget \(month to date, 1 brand with a budget\)/.test(txt) && new RegExp("Improving: 0 · 📉 Deteriorating: " + (monday ? 1 : 0)).test(txt));
  assert.ok(/WEEKLY MANAGEMENT SUMMARY/.test(txt) && /PRIORITIES FOR NEXT WEEK/.test(txt) && new RegExp("Best Lead Quality: Coastal — QL rate " + (monday ? "49%" : "42%")).test(txt) && !/CPL up \+100%/.test(txt.split('PRIORITIES FOR NEXT WEEK')[1]));
  assert.strictEqual(rep.total.cpl, rep.total.spend / rep.total.leads);
});
test("reach only where it can't double-count: one dedicated ad account whose spend equals the brand's", async () => {
  const fx = fixture(), db = fakeDb(fx), S = settings(); S.metaAccounts[1].brand = "Coastal";   // act_2 belongs to Coastal only
  const D = await prepared(S, db), found = M.detect(D, M.metrics(D));
  global.__acctSpend = { 2: 2000 }; let txt = tagless((await M.fullDaily(D, found, D.yday)).parts.join("\n"));
  assert.ok(/Coastal[\s\S]*?Reach: 12,345/.test(txt.split("🏢 Nexus")[0] + txt.split("🏢 Coastal")[1].split("━━")[0]) || /Reach: 12,345/.test(txt.split("🏢 Coastal")[1].split("━━")[0]));
  assert.ok(/Reach: N\/A \(shared ad account\)/.test(txt.split("🏢 Nexus")[1].split("━━")[0]));
  global.__acctSpend = { 2: 2600 }; txt = tagless((await M.fullDaily(D, found, D.yday)).parts.join("\n"));
  assert.ok(/Reach: N\/A \(account also runs other campaigns\)/.test(txt.split("🏢 Coastal")[1].split("━━")[0]));
  global.__acctSpend = {};
});

(async () => {
  const DB = require("../api/_db"), ORG = { id: "00000000-0000-4000-8000-000000000001", name: "Test Co", crm_name: "TeleCRM", currency: "INR", tz_offset_min: 330 };
  for (const [name, fn] of tests) { try { await DB.withOrg(ORG, fn); passed++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + "\n  " + (e && e.stack || e)); process.exitCode = 1; } }
  console.log("\n" + passed + "/" + tests.length + " passed");
})();
