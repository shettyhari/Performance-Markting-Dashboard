// Ads monitoring: the Telegram performance report, alerts with open / resolved tracking, and the data behind the
// Alerts & Monitoring page. Built on the dashboard's own data (meta_ad_rows, crm_leads via mon_* functions), definitions and settings.
//
// Definitions (same as the dashboard): Meta leads = Meta "Results" of lead / chat / website-lead rows; CPL = spend ÷ Meta leads;
// CRM leads = TeleCRM leads created that day (repeat leads left out); QL = qualified leads; CPQL = spend ÷ QL; CTR = clicks ÷ impressions;
// CPC = spend ÷ clicks; CPM = spend ÷ impressions × 1000. Totals are the sum of the LISTED brands; spend outside them is shown separately.
// Days are the workspace's time zone; Meta days follow the ad account's time zone (the workspace time zone).
const DB = require("./_db");
const PUSH_FILE_NAME = "CRM push";
const T = require("./_tg");
const A = require("./_alertlib");
const ACT = require("./_activity");
const R = require("./_reports");
const { all, graph, VER } = require("./_metalib");
const GRAPH = "https://graph.facebook.com/" + VER;

/* ---------- settings ---------- */
const TH = { cplUp: 30, leadDrop: 40, zeroLeadSpend: 1500, cpqlUp: 40, qlRateDrop: 30, syncMin: 80, stopSpendMin: 1000, budgetDev: 30, abnormalSpend: 60,
  cpmUp: 40, cpcUp: 40, ctrDrop: 30, minSpend: 1000, minLeads: 5, minImpr: 5000, minCrm: 20 };
const SCHED = { every: 30, recapHour: 9, todayHour: -1, weeklyOn: true, weeklyDay: 1, weeklyHour: 10, remindCritical: 2, remindHigh: 6, remindMedium: 24, changeMin: "medium" };
const TH_LABEL = { cplUp: "CPL up by (%)", leadDrop: "Lead volume down by (%)", zeroLeadSpend: "Campaign spend with 0 leads (amount)", cpqlUp: "CPQL up by (%)", qlRateDrop: "QL rate down by (%)",
  syncMin: "Meta leads reaching " + DB.crm() + " below (%)", stopSpendMin: "Campaign stopped: usual daily spend at least (amount)", budgetDev: "Spend off budget by (%)", abnormalSpend: "Spending faster than usual by (%)",
  cpmUp: "CPM up by (%)", cpcUp: "CPC up by (%)", ctrDrop: "CTR down by (%)", minSpend: "Minimum spend to judge (amount)", minLeads: "Minimum leads to judge", minImpr: "Minimum impressions to judge", minCrm: "Minimum CRM leads to judge quality" };
const sched = (S) => Object.assign({}, SCHED, (S.alerts || {}).sched || {});
function thOf(S, brand) { const a = S.alerts || {}, g = Object.assign({}, TH, a.th || {}), b = ((a.thBrand || {})[brand]) || {}, o = {};
  Object.keys(TH).forEach((k) => { o[k] = b[k] !== undefined && b[k] !== "" && b[k] !== null && isFinite(+b[k]) ? +b[k] : +g[k]; }); return o; }

/* ---------- small helpers ---------- */
const istMs = () => Date.now() + DB.tzMs();
const istDay = (o) => new Date(istMs() + (o || 0) * 864e5).toISOString().slice(0, 10);
const istHour = () => new Date(istMs()).getUTCHours() + new Date(istMs()).getUTCMinutes() / 60;
const addDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
const inr = (v) => (v === null || v === undefined || !isFinite(v) ? "—" : DB.cur() + Math.round(v).toLocaleString(DB.locale()));
const int = (v) => (v === null || v === undefined || !isFinite(v) ? "—" : Math.round(v).toLocaleString(DB.locale()));
const pc = (v, d) => (v === null || v === undefined || !isFinite(v) ? "—" : (v * 100).toFixed(d || 0) + "%");
const chg = (v) => (v === null || v === undefined || !isFinite(v) ? "" : (v > 0 ? "+" : "") + Math.round(v * 100) + "%");
const esc = T.esc;
const fmtTime = (iso) => { const d = new Date(Date.parse(iso) + DB.tzMs()); let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, "0"), ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return d.getUTCDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] + ", " + h + ":" + m + " " + ap; };
const nowLabel = () => { const d = new Date(istMs()); let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, "0"), ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return h + ":" + m + " " + ap; };
function kpi(x) { x = x || {}; const s = +x.spend || 0, l = +x.leads || 0, c = +x.crm || 0, q = +x.ql || 0, i = +x.imp || 0, k = +x.clk || 0;
  return { spend: s, leads: l, crm: c, ql: q, imp: i, clk: k, cpl: l > 0 ? s / l : null, cpql: q > 0 ? s / q : null, ctr: i > 0 ? k / i : null, cpc: k > 0 ? s / k : null, cpm: i > 0 ? s / i * 1000 : null,
    sync: l > 0 ? c / l : null, qlRate: c > 0 ? q / c : null }; }
function sumWin(rows, from, to, keyFn) { const o = {}; rows.forEach((r) => { if (r.day < from || r.day > to) return; const k = keyFn(r), x = o[k] || (o[k] = { spend: 0, leads: 0, crm: 0, ql: 0, imp: 0, clk: 0, days: {} });
  x.spend += +r.spend || 0; x.leads += +r.leads || 0; x.crm += +r.crm || 0; x.ql += +r.ql || 0; x.imp += +r.impressions || 0; x.clk += +r.clicks || 0; if (+r.spend > 0) x.days[r.day] = (x.days[r.day] || 0) + (+r.spend); }); return o; }
async function rpcAll(sbFetch, fn, body) {   // PostgREST returns at most 1,000 rows per call: page through
  let out = [];
  for (let off = 0; off < 50000; off += 1000) { const r = await sbFetch("rpc/" + fn + "?limit=1000&offset=" + off, { method: "POST", body: JSON.stringify(body) }) || []; out = out.concat(r); if (r.length < 1000) break; }
  return out;
}
const accountsOf = (S) => (Array.isArray(S.metaAccounts) ? S.metaAccounts : []).filter((a) => a && a.id && a.on !== false);
const actId = (id) => (String(id).indexOf("act_") === 0 ? String(id) : "act_" + id);
function brander(S) { const kws = (S.keywords || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]).toLowerCase(), k[1]]);
  return (acc, name) => (acc && acc.brand) || (function(){ const s = String(name || "").toLowerCase(); for (const k of kws) if (s.indexOf(k[0]) >= 0) return k[1]; return "Unmapped"; })(); }
const ACCOUNT_STATUS = { 1: "Active", 2: "Disabled", 3: "Unsettled (payment due)", 7: "Pending risk review", 8: "Pending settlement", 9: "In grace period", 100: "Pending closure", 101: "Closed", 201: "Any active", 202: "Any closed" };

/* ---------- 1. load everything once ---------- */
async function loadData(S, sbFetch, opt) {
  opt = opt || {};
  const today = istDay(0), from = addDays(today, -35), errors = [];
  const D = { today, yday: addDays(today, -1), hour: istHour(), S, errors, listed: (S.brands || []).slice() };
  const exc = S.excludedCampaigns || [];
  try { D.brandRows = await rpcAll(sbFetch, "mon_brand_daily", { p_from: from, p_excluded: exc }); D.v2 = true; }
  catch (e) {   // monitoring.sql not run yet: fall back to the alerts function (no impressions / clicks)
    D.v2 = false; errors.push("CTR / CPC / CPM and campaign alerts need the latest database setup: whoever runs the site re-runs ec2/setup.sh on the database server (it applies db/*.sql; data stays).");
    D.brandRows = (await sbFetch("rpc/alerts_brand_daily", { method: "POST", body: JSON.stringify({ p_from: from, p_excluded: exc }) }) || []).map((r) => Object.assign({ impressions: 0, clicks: 0 }, r)); }
  try { D.campRows = D.v2 ? await rpcAll(sbFetch, "mon_campaign_daily", { p_from: addDays(today, -8), p_excluded: exc }) : []; } catch (e) { D.campRows = []; errors.push("campaigns: " + e.message); }
  try { D.uploads = await sbFetch("uploads?select=meta_files,crm_file,uploaded_at,meta_rows,crm_rows&order=uploaded_at.desc&limit=60") || []; } catch (e) { D.uploads = []; errors.push("feeds: " + e.message); }
  try { D.acts = await sbFetch("meta_activity?select=*&event_time=gte." + encodeURIComponent(new Date(Date.now() - 864e5).toISOString()) + "&order=event_time.desc&limit=500") || []; } catch (e) { D.acts = []; }
  if (!opt.noMeta) { D.live = await liveDetail(S); D.health = await accountHealth(S); } else { D.live = { by: {}, total: { camps: 0, sets: 0, ads: 0 }, camps: {}, bad: [], errors: [], skipped: true }; D.health = { list: [], errors: [], skipped: true }; }
  return D;
}
async function liveDetail(S) {
  const accs = accountsOf(S), brandOf = brander(S), out = {}, camps = {}, bad = [], errors = [];
  await Promise.all(accs.map(async (a) => {
    try { const ads = await all(GRAPH + "/" + actId(a.id) + "/ads?fields=id,adset_id,campaign_id,campaign%7Bname%7D&effective_status=" + encodeURIComponent('["ACTIVE"]') + "&limit=500", 20);
      ads.forEach((x) => { const cn = x.campaign && x.campaign.name, b = brandOf(a, cn), o = out[b] || (out[b] = { camps: {}, sets: {}, ads: 0 }); o.camps[x.campaign_id] = 1; o.sets[x.adset_id] = 1; o.ads++; if (cn) camps[cn.toLowerCase()] = 1; }); }
    catch (e) { errors.push((a.name || a.id) + ": " + e.message.slice(0, 120)); }
    try { const rej = await all(GRAPH + "/" + actId(a.id) + "/ads?fields=id,name,effective_status,campaign%7Bname%7D&effective_status=" + encodeURIComponent('["DISAPPROVED","WITH_ISSUES"]') + "&limit=100", 2);
      rej.forEach((x) => bad.push({ account: a.name || a.id, accountId: actId(a.id), brand: brandOf(a, x.campaign && x.campaign.name), ad: x.name, campaign: x.campaign && x.campaign.name, status: x.effective_status })); }
    catch (e) { /* optional */ }
  }));
  const by = {}; let tc = 0, ts = 0, ta = 0;
  Object.keys(out).forEach((b) => { const o = out[b], c = Object.keys(o.camps).length, s = Object.keys(o.sets).length; by[b] = { camps: c, sets: s, ads: o.ads }; tc += c; ts += s; ta += o.ads; });
  return { by, total: { camps: tc, sets: ts, ads: ta }, camps, bad, errors };
}
async function accountHealth(S) {
  const want = {}; accountsOf(S).forEach((a) => { want[actId(a.id)] = a; });
  if (!Object.keys(want).length) return { list: [], errors: [] };
  try { const list = await all(GRAPH + "/me/adaccounts?fields=id,name,account_status,disable_reason&limit=200", 10);
    const seen = {}, out = [];
    list.forEach((x) => { if (!want[x.id]) return; seen[x.id] = 1; out.push({ id: x.id, name: x.name || want[x.id].name, brand: want[x.id].brand || "", status: x.account_status, disable: x.disable_reason }); });
    Object.keys(want).forEach((id) => { if (!seen[id]) out.push({ id, name: want[id].name || id, brand: want[id].brand || "", status: null, unseen: true }); });
    return { list: out, errors: [] }; }
  catch (e) { return { list: [], errors: [e.message] }; }
}

/* ---------- 2. metrics ---------- */
function metrics(D) {
  const t = D.today, y = D.yday, mStart = t.slice(0, 8) + "01", R = D.brandRows, b = (r) => r.brand;
  const W = { today: sumWin(R, t, t, b), yday: sumWin(R, y, y, b), b7: sumWin(R, addDays(t, -7), y, b), b7y: sumWin(R, addDays(t, -8), addDays(t, -2), b), mtd: sumWin(R, mStart, t, b),
    matR: sumWin(R, addDays(t, -10), addDays(t, -4), b), matB: sumWin(R, addDays(t, -31), addDays(t, -11), b), last3: sumWin(R, addDays(t, -3), y, b) };
  const all = {}; Object.keys(W).forEach((k) => { all[k] = {}; Object.keys(W[k]).forEach((br) => { all[k][br] = Object.assign(kpi(W[k][br]), { days: W[k][br].days }); }); });
  const listed = D.listed, isListed = (br) => listed.indexOf(br) >= 0;
  const tot = (k, f) => { const o = { spend: 0, leads: 0, crm: 0, ql: 0, imp: 0, clk: 0 }; Object.keys(W[k]).forEach((br) => { if (f(br)) ["spend", "leads", "crm", "ql", "imp", "clk"].forEach((m) => { o[m] += W[k][br][m]; }); }); return kpi(o); };
  const totalToday = tot("today", isListed), outside = tot("today", (br) => !isListed(br)), everything = tot("today", () => true);
  const outsideNames = Object.keys(W.today).filter((br) => !isListed(br) && (W.today[br].spend > 0 || W.today[br].leads > 0 || W.today[br].crm > 0));
  // reconciliation: overall must equal the sum of the brand lines (listed) + outside
  const sumLines = listed.reduce((s, br) => s + (W.today[br] ? W.today[br].spend : 0), 0);
  const recon = { ok: Math.abs(sumLines - totalToday.spend) < 1 && Math.abs(totalToday.spend + outside.spend - everything.spend) < 1, brandSum: sumLines, total: totalToday.spend, outside: outside.spend, all: everything.spend };
  const camp = { today: sumWin(D.campRows || [], t, t, (r) => r.brand + "|" + r.campaign), b7: sumWin(D.campRows || [], addDays(t, -7), y, (r) => r.brand + "|" + r.campaign),
    last3: sumWin(D.campRows || [], addDays(t, -3), y, (r) => r.brand + "|" + r.campaign) };
  const leadType = {}; (D.campRows || []).forEach((r) => { if (r.lead_type) leadType[r.brand + "|" + r.campaign] = true; });
  return { W: all, total: totalToday, outside, outsideNames, recon, camp, leadType };
}

/* ---------- 3. feeds and freshness ---------- */
function feeds(D) {
  const ups = D.uploads || [], meta = ups.filter((u) => (u.meta_files || []).indexOf("Meta API · auto-sync") >= 0)[0], push = ups.filter((u) => u.crm_file === PUSH_FILE_NAME)[0];
  const age = (u) => (u ? (Date.now() - Date.parse(u.uploaded_at)) / 60000 : null);
  return { meta: meta ? { at: meta.uploaded_at, age: age(meta), err: /^Last run errors/.test(meta.crm_file || "") ? meta.crm_file : "" } : null, crm: push ? { at: push.uploaded_at, age: age(push) } : null };
}

/* ---------- 4. issues ---------- */
function detect(D, Mx) {
  const S = D.S, out = [], F = feeds(D), h = D.hour, t = D.today, listed = D.listed;
  const add = (o) => out.push(Object.assign({ confirmed: true, brand: "", account: "", campaign: "", baseline: null, change: null, unit: "", value: null }, o));
  const W = Mx.W;
  /* account status (critical, confirmed by Meta) */
  (D.health.list || []).forEach((a) => {
    if (a.unseen) add({ key: "account_access|" + a.id, kind: "account", severity: "high", confirmed: false, brand: a.brand, account: a.name, title: "Ad account not visible to the dashboard", current: "Not returned by Meta", impact: "Its status, spend and changes can't be checked, so problems there won't be caught.", action: "Give the dashboard's system user access to this ad account (Business Settings › System users › Assign assets)." });
    else if (a.status !== 1 && a.status !== null && a.status !== undefined) add({ key: "account_status|" + a.id, kind: "account", severity: "critical", brand: a.brand, account: a.name, title: "Ad account " + (ACCOUNT_STATUS[a.status] || "status " + a.status), current: ACCOUNT_STATUS[a.status] || String(a.status), baseline: "Active", impact: "Ads in this account can't deliver or will stop soon.", action: a.status === 3 || a.status === 8 || a.status === 9 ? "Pay the outstanding balance / update the payment method in Billing now." : "Open Account Quality in Meta Business Suite to see the reason and request a review." });
  });
  if ((D.health.errors || []).length) add({ key: "account_unverified", kind: "account", severity: "medium", confirmed: false, title: "Couldn't verify ad account status", current: D.health.errors[0].slice(0, 140), impact: "Account problems (disabled, payment) might not be caught until this works again.", action: "Check the Meta token in Vercel (META_ACCESS_TOKEN) and the system user's access." });
  /* payment failures, rejections and limits from the change log (last 24 h) */
  (D.acts || []).forEach((r) => { const d = ACT.describe(r);
    if (d.category === "payfail") add({ key: "payfail|" + r.account_id, kind: "billing", severity: "critical", brand: r.brand, account: r.account_name, title: "Payment failed", current: "Failed " + fmtTime(r.event_time), impact: "Meta may pause every ad in this account.", action: "Update the payment method or add funds now." });
    if (d.category === "stopped") add({ key: "limit|" + r.account_id + "|" + (r.campaign || r.object_name), kind: "billing", severity: "high", brand: r.brand, account: r.account_name, campaign: r.campaign || r.object_name, title: d.what, current: fmtTime(r.event_time), impact: "No more spend or leads here until it's extended.", action: d.remark }); });
  const rej = {}; (D.live.bad || []).forEach((x) => { const k = x.brand + "|" + x.accountId; (rej[k] = rej[k] || []).push(x); });
  Object.keys(rej).forEach((k) => { const L = rej[k]; add({ key: "rejected|" + k, kind: "rejected", severity: "high", brand: L[0].brand, account: L[0].account, title: L.length + " ad" + (L.length > 1 ? "s" : "") + " rejected or with issues", current: L.slice(0, 3).map((x) => x.ad + " (" + x.campaign + ")").join("; "), value: L.length, impact: "These ads don't deliver.", action: "Open them in Ads Manager, read Meta's reason, fix and request review." }); });
  /* feeds */
  if (S.metaAutoSync && (!F.meta || F.meta.age > 75)) add({ key: "meta_sync", kind: "sync", severity: "critical", title: "Meta data is not updating", current: F.meta ? "Last sync " + fmtTime(F.meta.at) : "No automatic sync yet", impact: "Every number on the dashboard and in these alerts is older than it looks.", action: "Settings › Data connections: check the Meta connection and the Vercel logs for /api/meta-cron." });
  else if (F.meta && F.meta.err) add({ key: "meta_sync_partial", kind: "sync", severity: "high", title: "Some ad accounts failed to sync", current: F.meta.err.slice(0, 200), impact: "Spend and leads of those accounts are missing from today's numbers.", action: "Give the system user access to those ad accounts, then Sync now." });
  if (F.crm && F.crm.age > 120 && h >= 9 && h < 21) { const metaToday = listed.reduce((s, b) => s + (W.today[b] ? W.today[b].leads : 0), 0);
    add({ key: "crm_feed", kind: "sync", severity: "high", confirmed: metaToday > 0, title: DB.crm() + " leads are not arriving", current: "Last lead from n8n " + fmtTime(F.crm.at), impact: metaToday > 0 ? "Meta has " + int(metaToday) + " leads today, so new leads are probably missing in " + DB.crm() + "." : "No new " + DB.crm() + " leads for 2+ hours during working time.", action: "Open the n8n workflow: check it is Active and its last execution succeeded." }); }
  /* per brand */
  listed.forEach((b) => { const th = thOf(S, b), td = W.today[b] || kpi({}), b7 = W.b7[b] || kpi({}), yd = W.yday[b] || kpi({}), b7y = W.b7y[b] || kpi({});
    // CPL up vs 7-day baseline (ratios, so a partial day is fine)
    if (td.leads >= th.minLeads && td.spend >= th.minSpend && b7.leads >= th.minLeads && td.cpl && b7.cpl) { const c = td.cpl / b7.cpl - 1;
      if (c >= th.cplUp / 100) add({ key: "cpl_up|" + b + "|" + t, kind: "cpl_up", severity: c >= 2 * th.cplUp / 100 ? "high" : "medium", brand: b, title: "CPL up " + chg(c) + " vs last 7 days", current: inr(td.cpl), baseline: inr(b7.cpl), change: c, value: td.cpl, unit: "inr",
        impact: "At today's spend that's about " + inr(td.spend - td.leads * b7.cpl) + " more than the usual cost for these " + int(td.leads) + " leads.", action: "Check today's changes (Ad account activity), the ad set taking the spend, and Reports › Creative analysis." }); }
    // lead volume drop: yesterday (complete day) vs the 7 days before it
    const avg = b7y.leads / 7; if (avg >= th.minLeads) { const c = yd.leads / avg - 1;
      if (c <= -th.leadDrop / 100) add({ key: "lead_drop|" + b + "|" + D.yday, kind: "lead_drop", severity: "high", brand: b, title: "Leads down " + Math.round(-c * 100) + "% yesterday", current: int(yd.leads) + " leads", baseline: (Math.round(avg * 10) / 10) + "/day (7-day average)", change: c, value: yd.leads, daily: true,
        impact: "About " + int(avg - yd.leads) + " fewer leads than a normal day" + (yd.spend < b7y.spend / 7 * 0.7 ? "; spend was also lower (" + inr(yd.spend) + ")" : " at similar spend") + ".", action: yd.spend < b7y.spend / 7 * 0.7 ? "Check budgets and delivery (paused campaigns, limits)." : "Check forms and creatives: same money is buying fewer leads." }); }
    // lead quality on leads old enough to have been worked (created 4–10 days ago vs 11–31 days ago)
    const mr = W.matR[b], mb = W.matB[b];
    if (mr && mb && mr.crm >= th.minCrm && mb.ql >= 5) {
      if (mr.qlRate !== null && mb.qlRate) { const c = mr.qlRate / mb.qlRate - 1; if (c <= -th.qlRateDrop / 100) add({ key: "ql_rate|" + b + "|" + t, kind: "quality", severity: "medium", brand: b, title: "Lead quality down: QL rate " + Math.round(-c * 100) + "% lower", current: pc(mr.qlRate), baseline: pc(mb.qlRate), change: c, value: mr.qlRate, daily: true,
        impact: "Leads from 4–10 days ago qualify less often than usual (" + int(mr.ql) + " of " + int(mr.crm) + ").", action: "Review targeting and form questions of the campaigns that grew recently; ask sales which leads are poor." }); }
      if (mr.cpql && mb.cpql) { const c = mr.cpql / mb.cpql - 1; if (c >= th.cpqlUp / 100) add({ key: "cpql_up|" + b + "|" + t, kind: "quality", severity: "medium", brand: b, title: "CPQL up " + chg(c), current: inr(mr.cpql), baseline: inr(mb.cpql), change: c, value: mr.cpql, daily: true,
        impact: "Each qualified lead costs more than usual (leads created 4–10 days ago vs the 3 weeks before).", action: "Move budget to the campaigns with the best QL rate (Campaigns page, QL rate column)." }); }
    }
    // Meta leads reaching TeleCRM (yesterday = complete; today only late in the day, as suspected)
    if (yd.leads >= th.minLeads && yd.sync !== null && yd.sync < th.syncMin / 100) add({ key: "sync|" + b + "|" + D.yday, kind: "crm_sync", severity: "high", brand: b, title: "Leads not reaching " + DB.crm(), current: int(yd.crm) + " of " + int(yd.leads) + " (" + pc(yd.sync) + ")", baseline: th.syncMin + "%+ expected", value: yd.sync, daily: true,
      impact: int(yd.leads - yd.crm) + " Meta leads from yesterday aren't in " + DB.crm() + " (repeat leads and form test submissions explain small gaps).", action: "Open Lead forms / Lead leaks to find the form or campaign that isn't connected." });
    if (h >= 14 && td.leads >= 2 * th.minLeads && td.sync !== null && td.sync < (th.syncMin - 20) / 100) add({ key: "sync_today|" + b + "|" + t, kind: "crm_sync", severity: "medium", confirmed: false, brand: b, title: "Today's leads slow to reach " + DB.crm(), current: int(td.crm) + " of " + int(td.leads) + " (" + pc(td.sync) + ")", value: td.sync,
      impact: "Could be a delay or a broken form connection.", action: "If it's still low tomorrow morning, check Lead forms / Lead leaks." });
    // brand not spending although it spent every day for 3 days
    const l3 = W.last3[b]; if (h >= 11 && l3 && Object.keys(l3.days || {}).length >= 3 && l3.spend / 3 >= th.minSpend && !td.spend) add({ key: "no_spend|" + b + "|" + t, kind: "delivery", severity: "high", confirmed: false, brand: b, title: "No spend today", current: inr(0), baseline: inr(l3.spend / 3) + "/day (last 3 days)", value: 0,
      impact: "About " + inr(l3.spend / 3 * Math.min(1, h / 24)) + " of usual spend (and its leads) hasn't happened yet today.", action: "Check the brand's campaigns are on, have budget, and the account can pay (Ad account activity)." });
    // spending much faster than usual
    if (h >= 10 && b7.spend > 0) { const exp = b7.spend / 7 * (h / 24), c = exp > 0 ? td.spend / exp - 1 : null;
      if (c !== null && c >= th.abnormalSpend / 100 && td.spend >= 2 * th.minSpend) add({ key: "fast_spend|" + b + "|" + t, kind: "spend", severity: "high", confirmed: false, brand: b, title: "Spending faster than usual", current: inr(td.spend) + " so far", baseline: "about " + inr(exp) + " by this time", change: c, value: td.spend,
        impact: "At this pace today ends near " + inr(td.spend / Math.max(0.1, h / 24)) + " vs a usual " + inr(b7.spend / 7) + ".", action: "Check for budget increases today (Ad account activity) and whether CPL is holding." }); }
    // delivery costs vs 7 days
    if (td.imp >= th.minImpr && b7.imp >= th.minImpr) { const parts = []; let worst = 0;
      if (td.cpm && b7.cpm) { const c = td.cpm / b7.cpm - 1; if (c >= th.cpmUp / 100){ parts.push("CPM " + inr(td.cpm) + " vs " + inr(b7.cpm) + " (" + chg(c) + ")"); worst = Math.max(worst, c); } }
      if (td.cpc && b7.cpc) { const c = td.cpc / b7.cpc - 1; if (c >= th.cpcUp / 100){ parts.push("CPC " + inr(td.cpc) + " vs " + inr(b7.cpc) + " (" + chg(c) + ")"); worst = Math.max(worst, c); } }
      if (td.ctr !== null && b7.ctr) { const c = td.ctr / b7.ctr - 1; if (c <= -th.ctrDrop / 100){ parts.push("CTR " + pc(td.ctr, 2) + " vs " + pc(b7.ctr, 2) + " (" + chg(c) + ")"); worst = Math.max(worst, -c); } }
      if (parts.length) add({ key: "costs|" + b + "|" + t, kind: "costs", severity: "medium", brand: b, title: "Delivery costs changed", current: parts.join(" · "), change: worst, value: worst,
        impact: "Paying more to reach people or get clicks than usual; CPL usually follows.", action: "Check audience overlap / frequency and refresh tired creatives (Reports › Creative analysis)." }); }
    // budget: yesterday vs daily budget, month pacing (only where Report targets have a budget)
    const mk = t.slice(0, 7), tg = ((((S.report || {}).months || {})[mk] || {}).brands || {})[b] || {}, dim = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)).getUTCDate();
    if (+tg.budget > 0) { const daily = +tg.budget / dim;
      if (yd.spend > 0 || W.b7[b]) { const c = yd.spend / daily - 1; if (Math.abs(c) >= th.budgetDev / 100) add({ key: "budget_day|" + b + "|" + D.yday, kind: "budget", severity: "medium", brand: b, title: "Yesterday's spend " + (c > 0 ? "over" : "under") + " daily budget", current: inr(yd.spend), baseline: inr(daily) + "/day (monthly budget ÷ " + dim + ")", change: c, value: yd.spend, daily: true,
        impact: (c > 0 ? "Overspent by " : "Underspent by ") + inr(Math.abs(yd.spend - daily)) + ".", action: c > 0 ? "Lower daily budgets or check for unplanned increases." : "Check delivery limits; raise budgets on the best ad sets if leads are needed." }); }
      const el = +t.slice(8) - 1 + h / 24; if (+t.slice(8) >= 3) { const m = W.mtd[b] || kpi({}), proj = m.spend / el * dim, c = proj / +tg.budget - 1;
        if (Math.abs(c) >= 0.15) add({ key: "budget_month|" + b + "|" + mk, kind: "budget", severity: c > 0.3 || c < -0.4 ? "high" : "medium", brand: b, title: "Month spend heading " + (c > 0 ? "over" : "under") + " budget", current: "about " + inr(proj) + " by month end", baseline: inr(+tg.budget) + " budget", change: c, value: proj,
          impact: "Spent " + inr(m.spend) + " so far this month.", action: "Aim for about " + inr(Math.max(0, (+tg.budget - m.spend) / Math.max(1, dim - el))) + "/day for the rest of the month." }); } }
  });
  /* campaigns: spend without leads, stopped spending */
  Object.keys(Mx.camp.today).forEach((k) => { const [b, cn] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)], th = thOf(S, b), c = Mx.camp.today[k], base = Mx.camp.b7[k];
    if (listed.indexOf(b) < 0) return;
    const leadType = Mx.leadType[k] || (base && base.leads > 0);
    if (leadType && c.spend >= th.zeroLeadSpend && !c.leads) add({ key: "zero|" + k + "|" + t, kind: "zero_leads", severity: "high", brand: b, campaign: cn, title: "Spending with no leads", current: inr(c.spend) + " today, 0 leads", baseline: base && base.leads ? inr(base.spend / base.leads) + " usual CPL" : "", value: c.spend,
      impact: inr(c.spend) + " spent without a lead" + (c.clk > 50 ? " although people clicked " + int(c.clk) + " times — possibly a broken form or tracking (suspected)" : "") + ".", action: "Check the form / WhatsApp destination and the ad's delivery; pause it if leads don't start within the next hour or two." }); });
  if (h >= 12) Object.keys(Mx.camp.last3).forEach((k) => { const b = k.slice(0, k.indexOf("|")), cn = k.slice(k.indexOf("|") + 1), th = thOf(S, b), l3 = Mx.camp.last3[k], td = Mx.camp.today[k];
    if (listed.indexOf(b) < 0 || Object.keys(l3.days || {}).length < 3 || l3.spend / 3 < th.stopSpendMin || (td && td.spend > 0)) return;
    if (D.live.skipped || !D.live.camps[cn.toLowerCase()]) return;   // only campaigns that still have live ads (a paused one is reported as a change)
    add({ key: "stopped|" + k + "|" + t, kind: "delivery", severity: "high", confirmed: false, brand: b, campaign: cn, title: "Active campaign stopped spending", current: inr(0) + " today", baseline: inr(l3.spend / 3) + "/day (last 3 days)", value: 0,
      impact: "It still has live ads but hasn't spent today — about " + inr(l3.spend / 3 * Math.min(1, h / 24)) + " of usual delivery missing.", action: "Check its budget, schedule, spending limit and ad review status in Ads Manager." }); });
  return out;
}

/* ---------- 5. open / resolved tracking and anti-spam ---------- */
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
function material(prev, cur) { if (prev === null || prev === undefined || cur === null || cur === undefined || !isFinite(prev) || !isFinite(cur)) return false; if (prev === 0) return cur !== 0; return Math.abs(cur - prev) / Math.abs(prev) >= 0.25; }
async function trackIssues(D, found, sbFetch) {
  const sc = sched(D.S), now = new Date().toISOString(), open = await sbFetch("alert_issues?status=eq.open&select=*&limit=1000") || [], byKey = {};
  open.forEach((r) => { byKey[r.key] = r; });
  const notify = [], resolvedNow = [], upserts = [], seen = {}, quiet = A.cfgOf(D.S) && inQuiet(D.S);
  // PostgREST bulk upserts need the same columns in every row: always send the full set (the note column is never touched here)
  const full = (o, r) => ({ key: r.key, kind: r.kind, severity: r.severity, confirmed: r.confirmed !== false, status: r.status, brand: r.brand || "", account: r.account || "", campaign: r.campaign || "", title: r.title || "",
    detail: r.detail || {}, first_seen: (o && o.first_seen) || now, last_seen: r.last_seen, last_notified: o ? o.last_notified || null : null, notified_value: o && o.notified_value !== undefined ? o.notified_value : null,
    notify_count: o ? o.notify_count || 0 : 0, missed: r.missed || 0, resolved_at: r.resolved_at || null, ack_by: o ? o.ack_by || null : null, ack_at: o ? o.ack_at || null : null });
  found.forEach((x) => { seen[x.key] = 1; const o = byKey[x.key], remindH = x.severity === "critical" ? sc.remindCritical : x.severity === "high" ? sc.remindHigh : sc.remindMedium;
    const row = full(o, { key: x.key, kind: x.kind, severity: x.severity, confirmed: x.confirmed, status: "open", brand: x.brand, account: x.account, campaign: x.campaign, title: x.title,
      detail: { current: x.current, baseline: x.baseline, change: x.change, impact: x.impact, action: x.action }, last_seen: now, missed: 0 });
    let why = null;
    if (!o) why = "new";
    else if (SEV[x.severity] < SEV[o.severity]) why = "worse";
    else if (!o.ack_at && material(o.notified_value === null || o.notified_value === undefined ? null : +o.notified_value, x.value)) why = "changed";
    else if (!o.ack_at && o.last_notified && remindH > 0 && Date.now() - Date.parse(o.last_notified) >= remindH * 3600e3) why = "reminder";
    else if (!o.last_notified) why = "pending";
    if (why && quiet && x.severity !== "critical") why = null;   // quiet hours: only critical; the rest goes out after
    if (why) { row.last_notified = now; row.notified_value = isFinite(x.value) ? x.value : null; row.notify_count += 1; notify.push(Object.assign({ why }, x)); }
    upserts.push(row); });
  // not detected any more: resolved after 2 checks in a row (or straight away, silently, when its day has passed)
  open.forEach((o) => { if (seen[o.key]) return; const m = /\|(\d{4}-\d{2}-\d{2})$/.exec(o.key), stale = !!(m && m[1] < D.today), missed = (o.missed || 0) + 1;
    if (missed >= 2 || stale) { upserts.push(full(o, Object.assign({}, o, { status: "resolved", missed, resolved_at: now })));
      if (!stale && o.last_notified && !quiet) resolvedNow.push(o); }
    else upserts.push(full(o, Object.assign({}, o, { status: "open", missed }))); });
  for (let i = 0; i < upserts.length; i += 200) await sbFetch("alert_issues?on_conflict=key", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(upserts.slice(i, i + 200)) });
  return { notify, resolvedNow, open: found };
}
function inQuiet(S) { const c = A.cfgOf(S), d = new Date(istMs()), h = d.getUTCHours(), a = +c.quietFrom, b = +c.quietTo; if (a === b) return false; return a < b ? h >= a && h < b : h >= a || h < b; }

/* ---------- 6. Telegram text ---------- */
const ICON = { critical: "🚨", high: "🔴", medium: "🟠", low: "⚪" };
function issueBlock(x, short) {
  const L = [ICON[x.severity] + " <b>" + esc(x.title) + "</b>" + (x.confirmed === false ? " <i>(suspected)</i>" : "")];
  const where = [x.brand && "Brand: " + esc(x.brand), x.account && "Account: " + esc(x.account), x.campaign && "Campaign: " + esc(x.campaign)].filter(Boolean);
  if (where.length) L.push(where.join(" · "));
  if (x.current) L.push("Now: " + esc(x.current) + (x.baseline ? " · Usual: " + esc(x.baseline) : "") + (x.change !== null && x.change !== undefined && isFinite(x.change) ? " (" + chg(x.change) + ")" : ""));
  if (!short && x.impact) L.push("Impact: " + esc(x.impact));
  if (x.action) L.push("👉 " + esc(x.action));
  return L.join("\n");
}
function reportText(D, Mx, found, opt) {
  opt = opt || {}; const W = Mx.W, F = feeds(D), listed = D.listed, L = [], T0 = Mx.total, win = opt.yesterday ? "yday" : "today";
  const tot = opt.yesterday ? (function(){ const o = { spend: 0, leads: 0, crm: 0, ql: 0, imp: 0, clk: 0 }; listed.forEach((b) => { const x = W.yday[b]; if (x) ["spend", "leads", "crm", "ql", "imp", "clk"].forEach((m) => { o[m] += x[m]; }); }); return kpi(o); })() : T0;
  const accIssues = new Set(found.filter((x) => /^(account|billing|rejected)$/.test(x.kind) && x.key !== "account_unverified").map((x) => x.account || x.key)).size,
    feedIssues = found.filter((x) => x.kind === "sync").length, unverified = found.some((x) => x.key === "account_unverified");
  L.push((opt.yesterday ? "📊 <b>" + DB.orgName() + " " + "Ads · Yesterday (" + D.yday.slice(8) + "/" + D.yday.slice(5, 7) + ")</b>" : "📊 <b>" + DB.orgName() + " " + "Ads · Today, " + nowLabel() + "</b>"));
  L.push("<i>Meta " + (F.meta ? "synced " + fmtTime(F.meta.at).split(", ")[1] : "not synced yet") + " · " + DB.crm() + " " + (F.crm ? fmtTime(F.crm.at).split(", ")[1] : "—") + " · " + accountsOf(D.S).length + " ad accounts · " + listed.length + " brands ·" + " " + DB.tzLabel() + "</i>");
  L.push("", "💰 <b>" + inr(tot.spend) + "</b> · " + int(tot.leads) + " Meta leads · " + int(tot.crm) + " " + DB.crm() + " · " + int(tot.ql) + " QL",
    "CPL <b>" + inr(tot.cpl) + "</b> · CPQL " + inr(tot.cpql) + (tot.imp ? " · CTR " + pc(tot.ctr, 2) + " · CPM " + inr(tot.cpm) : ""));
  if (!opt.yesterday) L.push("🟢 Live " + int(D.live.total.camps) + " campaigns · " + int(D.live.total.sets) + " ad sets · " + int(D.live.total.ads) + " ads" + (D.live.errors.length ? " (some accounts unreadable)" : ""));
  if (accIssues || feedIssues || unverified) L.push("⚠️ " + [accIssues ? accIssues + " of " + accountsOf(D.S).length + " ad accounts with issues" : "", feedIssues ? feedIssues + " data feed issue" + (feedIssues > 1 ? "s" : "") : "", unverified ? "account status not verified" : ""].filter(Boolean).join(" · "));
  else L.push("✅ Ad accounts and data feeds OK (checked " + nowLabel() + ")");
  if (!opt.yesterday && Mx.outside.spend > 0) L.push("<i>Not in a listed brand: " + inr(Mx.outside.spend) + " (" + esc(Mx.outsideNames.join(", ")) + ") — not in the totals above.</i>");
  if (!opt.yesterday && !Mx.recon.ok) L.push("⚠️ Totals check failed: brands " + inr(Mx.recon.brandSum) + " vs total " + inr(Mx.recon.total) + ".");
  L.push("", "<b>BRANDS</b>");
  const rows = listed.map((b) => ({ b, x: W[win][b] || kpi({}), base: W[opt.yesterday ? "b7y" : "b7"][b] || kpi({}), live: D.live.by[b] })).filter((r) => r.x.spend > 0 || r.x.leads > 0 || r.x.crm > 0 || r.live);
  rows.sort((p, q) => q.x.spend - p.x.spend);
  rows.forEach((r) => { const x = r.x, c = x.cpl && r.base.cpl ? x.cpl / r.base.cpl - 1 : null;
    const deliv = opt.yesterday ? "" : r.live ? "🟢 " + r.live.camps + " live" + (!x.spend && D.hour >= 11 ? " but no spend" : "") : x.spend ? "⚪ nothing live now" : "⚪ off";
    L.push("<b>" + esc(r.b) + "</b> " + deliv,
      inr(x.spend) + " · " + int(x.leads) + " leads · " + int(x.crm) + " CRM · " + int(x.ql) + " QL",
      "CPL " + inr(x.cpl) + (c !== null ? " (" + (c > 0 ? "▲" : "▼") + Math.abs(Math.round(c * 100)) + "% vs 7d)" : "") + " · CPQL " + inr(x.cpql) + (x.imp ? " · CTR " + pc(x.ctr, 2) + " · CPC " + inr(x.cpc) + " · CPM " + inr(x.cpm) : "")); });
  if (!rows.length) L.push("No spend yet.");
  /* highlights: need enough leads; quality and spend count, not CPL alone */
  const th0 = thOf(D.S, ""), cand = rows.filter((r) => r.x.leads >= th0.minLeads && r.x.spend >= th0.minSpend);
  const score = (r) => (r.x.ql >= 3 && r.x.cpql ? r.x.cpql : r.x.cpl * 3);   // CPQL when quality is known, else CPL weighted
  const H = [];
  if (cand.length) { const best = cand.slice().sort((p, q) => score(p) - score(q))[0]; H.push("🏆 Best: <b>" + esc(best.b) + "</b> — " + (best.x.ql >= 3 ? "CPQL " + inr(best.x.cpql) + ", " : "") + "CPL " + inr(best.x.cpl) + " on " + int(best.x.leads) + " leads"); }
  const moves = cand.filter((r) => r.base.cpl && r.base.leads >= th0.minLeads).map((r) => ({ r, c: r.x.cpl / r.base.cpl - 1 }));
  const up = moves.filter((m) => m.c > 0.05).sort((p, q) => q.c - p.c)[0], dn = moves.filter((m) => m.c < -0.05).sort((p, q) => p.c - q.c)[0];
  if (dn) H.push("📉 Most improved: <b>" + esc(dn.r.b) + "</b> CPL " + chg(dn.c) + " vs 7d");
  if (up) H.push("📈 Most worsened: <b>" + esc(up.r.b) + "</b> CPL " + chg(up.c) + " vs 7d");
  const zero = rows.filter((r) => r.x.spend >= th0.minSpend && !r.x.leads).sort((p, q) => q.x.spend - p.x.spend)[0];
  if (zero) H.push("🚫 Highest spend, 0 leads: <b>" + esc(zero.b) + "</b> " + inr(zero.x.spend));
  const gap = rows.filter((r) => r.x.leads >= th0.minLeads && r.x.leads > r.x.crm).sort((p, q) => (q.x.leads - q.x.crm) - (p.x.leads - p.x.crm))[0];
  if (gap) H.push("🔀 Biggest Meta→CRM gap: <b>" + esc(gap.b) + "</b> " + int(gap.x.leads) + " vs " + int(gap.x.crm) + " (" + pc(gap.x.sync) + " reached " + DB.crm() + ")");
  const idle = found.filter((x) => x.kind === "delivery" && /^no_spend/.test(x.key)).map((x) => x.brand);
  if (idle.length) H.push("⏸ No spend though usually running: " + esc(idle.join(", ")));
  if (H.length) L.push("", "<b>HIGHLIGHTS</b>", ...H);
  /* top three actions: severity, then money at stake */
  const top = found.slice().sort((p, q) => (SEV[p.severity] - SEV[q.severity]) || ((q.value || 0) - (p.value || 0))).slice(0, 3);
  L.push("", "<b>ACTION REQUIRED</b>");
  if (!top.length) L.push("Nothing urgent. ✅");
  top.forEach((x, i) => L.push((i + 1) + ". " + ICON[x.severity] + " <b>" + esc(x.title) + "</b>" + (x.brand ? " — " + esc(x.brand) : "") + (x.campaign ? " · " + esc(x.campaign) : "") + (x.confirmed === false ? " <i>(suspected)</i>" : "") +
    (x.impact ? "\n   " + esc(x.impact) : "") + (x.action ? "\n   👉 " + esc(x.action) : "")));
  L.push("", "<i>Totals = listed brands only. Meta leads by Meta's reporting day; " + DB.crm() + " leads by created day (repeat leads left out); QL for recent leads keeps rising as sales qualifies them.</i>");
  if (D.errors.length) L.push("<i>" + esc(D.errors.join(" · ")) + "</i>");
  return L.join("\n");
}

/* ---------- 7. weekly / month view (Telegram + dashboard) ---------- */
function weekly(D) {
  const S = D.S, t = D.today, dow = (new Date(Date.parse(t + "T00:00:00Z")).getUTCDay() + 6) % 7, lastMon = addDays(t, -dow - 7), lastSun = addDays(lastMon, 6), prevMon = addDays(lastMon, -7), prevSun = addDays(lastMon, -1);
  const R = D.brandRows, w1 = sumWin(R, lastMon, lastSun, (r) => r.brand), w0 = sumWin(R, prevMon, prevSun, (r) => r.brand), mStart = t.slice(0, 8) + "01", mtd = sumWin(R, mStart, t, (r) => r.brand);
  const mk = t.slice(0, 7), TG = (((S.report || {}).months || {})[mk] || {}).brands || {}, dim = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)).getUTCDate(), el = +t.slice(8) - 1 + D.hour / 24;
  const rows = D.listed.map((b) => { const a = kpi(w1[b]), p = kpi(w0[b]), m = kpi(mtd[b]), tg = TG[b] || {}, labels = [];
    const cplC = a.cpl && p.cpl ? a.cpl / p.cpl - 1 : null, cpqlC = a.cpql && p.cpql ? a.cpql / p.cpql - 1 : null, leadC = p.leads ? a.leads / p.leads - 1 : null, qlC = a.qlRate !== null && p.qlRate ? a.qlRate / p.qlRate - 1 : null;
    if (cplC !== null && a.leads >= 10) { if (cplC <= -0.1) labels.push("Improving"); else if (cplC >= 0.1) labels.push("Deteriorating"); }
    if (qlC !== null && a.crm >= 20 && qlC <= -0.2) labels.push("Lower-quality leads");
    const budget = +tg.budget > 0 ? +tg.budget : null, leadsTg = +tg.leads > 0 ? +tg.leads : null;
    const util = budget ? m.spend / budget : null, expSpend = budget ? budget / dim * el : null, expLeads = leadsTg ? leadsTg / dim * el : null;
    if (budget && expSpend > 0) { const r = m.spend / expSpend; if (r > 1.1) labels.push("Overspending"); else if (r < 0.85) labels.push("Underspending"); }
    return { brand: b, week: a, prev: p, mtd: m, cplC, cpqlC, leadC, qlC, budget, util, expSpend, leadsTarget: leadsTg, expLeads, leadPace: expLeads ? m.leads / expLeads : null, labels }; })
    .filter((r) => r.week.spend > 0 || r.prev.spend > 0 || r.mtd.spend > 0);
  return { from: lastMon, to: lastSun, prevFrom: prevMon, prevTo: prevSun, month: mk, rows };
}
function weeklyText(Wk) {
  const L = ["📅 <b>" + DB.orgName() + " " + "weekly report · " + Wk.from.slice(8) + "/" + Wk.from.slice(5, 7) + "–" + Wk.to.slice(8) + "/" + Wk.to.slice(5, 7) + "</b>", "<i>vs the week before · month-to-date vs Report targets (only brands with targets)</i>"];
  Wk.rows.forEach((r) => { const a = r.week;
    L.push("", "<b>" + esc(r.brand) + "</b>" + (r.labels.length ? " · " + r.labels.join(", ") : ""),
      inr(a.spend) + " · " + int(a.leads) + " leads" + (r.leadC !== null ? " (" + chg(r.leadC) + ")" : " (none the week before)") + " · " + int(a.crm) + " CRM · " + int(a.ql) + " QL",
      "CPL " + inr(a.cpl) + (r.cplC !== null ? " (" + chg(r.cplC) + ")" : "") + " · CPQL " + inr(a.cpql) + (r.cpqlC !== null ? " (" + chg(r.cpqlC) + ")" : "") + (a.imp ? " · CTR " + pc(a.ctr, 2) + " · CPC " + inr(a.cpc) + " · CPM " + inr(a.cpm) : ""),
      (r.budget ? "Month: " + inr(r.mtd.spend) + " of " + inr(r.budget) + " (" + pc(r.util) + " used, " + pc(r.mtd.spend / r.expSpend) + " of plan)" : "Month: " + inr(r.mtd.spend) + " (no budget set)") +
      (r.leadsTarget ? " · leads " + int(r.mtd.leads) + " vs " + int(r.expLeads) + " expected by now" : "")); });
  if (!Wk.rows.length) L.push("", "No spend last week.");
  return L.join("\n");
}

/* ---------- 8. one run (called every 30 minutes) ---------- */
async function flushOutbox(sbFetch, chatId) {   // retry Telegram messages that failed earlier (kept up to 6 hours)
  const box = (await A.getState(sbFetch, "outbox")) || [], keep = [];
  for (const m of box) { if (Date.now() - Date.parse(m.at) > 6 * 3600e3) continue; try { await T.send(chatId, m.html); } catch (e) { keep.push(m); } }
  if (box.length) await A.setState(sbFetch, "outbox", keep);
}
async function sendSafe(sbFetch, chatId, kind, html) {
  try { await T.send(chatId, html); await logRow(sbFetch, kind, html); return true; }
  catch (e) { const box = (await A.getState(sbFetch, "outbox")) || []; box.push({ kind, html, at: new Date().toISOString() }); await A.setState(sbFetch, "outbox", box.slice(-30)); await logRow(sbFetch, kind + "-failed", html); return false; }
}
async function logRow(sbFetch, kind, text) { try { await sbFetch("alert_log", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify([{ kind, text: String(text).slice(0, 8000) }]) }); } catch (e) {} }
/* full brand-wise reports (api/_reports.js), with reach where it can be counted without double-counting */
function spendMap(D, from, to) { const o = {}; D.brandRows.forEach((r) => { if (r.day >= from && r.day <= to) o[r.brand] = (o[r.brand] || 0) + (+r.spend || 0); }); return o; }
function withFeeds(D) { const F = feeds(D); D.feedsInfo = { meta: F.meta, crm: F.crm, metaErr: F.meta && F.meta.err ? F.meta.err : "" }; return D; }
async function fullDaily(D, found, day) {
  withFeeds(D); let reach = {};
  if (!D.live.skipped) { try { reach = await R.reachFor(D.S, D.listed, { day: [day, day] }, { day: spendMap(D, day, day) }); } catch (e) { reach = {}; } }
  return R.daily(D, found, { day, reach });
}
async function fullWeekly(D, found) {
  withFeeds(D); const wb = R.weekBounds(D.today); let reach = {};
  if (!D.live.skipped) { try { reach = await R.reachFor(D.S, D.listed, { week: [wb.from, wb.to] }, { week: spendMap(D, wb.from, wb.to) }); } catch (e) { reach = {}; } }
  return R.weeklyFull(D, found, { reach });
}
async function sendParts(sbFetch, chatId, kind, rep) { let okAll = true; for (const p of rep.parts) okAll = (await sendSafe(sbFetch, chatId, kind, p)) && okAll; return okAll; }
async function run(S, sbFetch, opt) {
  opt = opt || {}; const sc = sched(S), out = { sent: [] };
  if (!A.cfgOf(S).summary) sc.every = 0;   // the 30-minute report can be switched off (Settings › Alerts); alerts and the morning recap still go
  const D = await loadData(S, sbFetch, opt), Mx = metrics(D), found = detect(D, Mx);
  const tr = opt.noTrack ? { notify: [], resolvedNow: [] } : await trackIssues(D, found, sbFetch);
  out.issues = found.length; out.notify = tr.notify.length; out.resolved = tr.resolvedNow.length; out.recon = Mx.recon;
  const chat = T.configured() ? await A.chatOf(sbFetch) : null;
  if (!chat) { out.skipped = "Telegram isn't connected."; return out; }
  await flushOutbox(sbFetch, chat.chat_id);
  /* critical: one message each, straight away; others grouped */
  for (const x of tr.notify.filter((x) => x.severity === "critical")) { await sendSafe(sbFetch, chat.chat_id, "critical", "🚨 <b>CRITICAL" + (x.confirmed === false ? " · SUSPECTED" : " · CONFIRMED") + "</b>" + (x.why === "reminder" ? " (reminder)" : "") + "\n\n" + issueBlock(x) + "\n\n<i>" + fmtTime(new Date().toISOString()) + "</i>"); out.sent.push("critical"); }
  const rest = tr.notify.filter((x) => x.severity !== "critical").sort((p, q) => SEV[p.severity] - SEV[q.severity]);
  if (rest.length) { await sendSafe(sbFetch, chat.chat_id, "warning", "⚠️ <b>PERFORMANCE ALERTS (" + rest.length + ")</b>\n\n" + rest.slice(0, 12).map((x) => (x.why === "reminder" ? "<i>Reminder · open since earlier</i>\n" : x.why === "changed" || x.why === "worse" ? "<i>Updated · impact changed</i>\n" : "") + issueBlock(x)).join("\n\n") + (rest.length > 12 ? "\n\n… and " + (rest.length - 12) + " more on the dashboard › Alerts & Monitoring" : "")); out.sent.push("warnings:" + rest.length); }
  if (tr.resolvedNow.length) { await sendSafe(sbFetch, chat.chat_id, "resolved", "✅ <b>RESOLVED (" + tr.resolvedNow.length + ")</b>\n" + tr.resolvedNow.slice(0, 15).map((o) => "• " + esc(o.title) + (o.brand ? " — " + esc(o.brand) : "") + (o.campaign ? " · " + esc(o.campaign) : "")).join("\n")); out.sent.push("resolved"); }
  /* reports on their schedule (quiet hours skip them) */
  if (!inQuiet(S) || opt.force) {
    const st = (await A.getState(sbFetch, "reports")) || {}, nowMs = Date.now(), changed = {};
    const h = D.hour, dayKey = D.today, wk = weekly(D), wkKey = wk.from;
    if (opt.force || (sc.every > 0 && (!st.last || nowMs - Date.parse(st.last) >= (sc.every - 3) * 60000))) { await sendSafe(sbFetch, chat.chat_id, "summary", reportText(D, Mx, found)); changed.last = new Date().toISOString(); out.sent.push("report"); }
    if (sc.recapHour >= 0 && h >= sc.recapHour && st.recap !== dayKey && !opt.force) { const rep = await fullDaily(D, found, D.yday); await sendParts(sbFetch, chat.chat_id, "daily", rep); changed.recap = dayKey; out.sent.push("daily:" + rep.parts.length); }
    if (sc.todayHour >= 0 && h >= sc.todayHour && st.todayFull !== dayKey && !opt.force) { const rep = await fullDaily(D, found, D.today); await sendParts(sbFetch, chat.chat_id, "daily", rep); changed.todayFull = dayKey; out.sent.push("daily-today:" + rep.parts.length); }
    const dow = (new Date(Date.parse(dayKey + "T00:00:00Z")).getUTCDay() + 6) % 7 + 1;
    if (sc.weeklyOn && dow === +sc.weeklyDay && h >= sc.weeklyHour && st.weekly !== wkKey && !opt.force) { const rep = await fullWeekly(D, found); await sendParts(sbFetch, chat.chat_id, "weekly", rep); changed.weekly = wkKey; out.sent.push("weekly:" + rep.parts.length); }
    if (Object.keys(changed).length) await A.setState(sbFetch, "reports", Object.assign({}, st, changed));
  }
  return out;
}
module.exports = { fullDaily, fullWeekly, sendParts, TH, SCHED, TH_LABEL, thOf, sched, loadData, metrics, feeds, detect, trackIssues, reportText, weekly, weeklyText, run, issueBlock, kpi, sumWin };
