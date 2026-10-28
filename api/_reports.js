// Full brand-wise Telegram reports: the DAILY PERFORMANCE REPORT and the WEEKLY PERFORMANCE REPORT.
// Every brand configured in the dashboard (Settings › Brands) gets its own block, even with no spend. Long reports are split into
// numbered parts at brand boundaries (Part 1/N = overall summary), all parts carrying the same date and report ID.
// Definitions (same as the dashboard): CPL = spend ÷ Meta leads; CPQL = spend ÷ QL; CTR = link clicks ÷ impressions × 100;
// CPC = spend ÷ link clicks; CPM = spend ÷ impressions × 1,000. Overall figures are computed from summed totals (never averages of brand
// ratios). Overall = sum of the listed brands; spend outside them is shown separately. N/A when a denominator is 0 or data is unavailable.
const DB = require("./_db");
const T = require("./_tg");
const { all, VER } = require("./_metalib");
const GRAPH = "https://graph.facebook.com/" + VER;
const esc = T.esc, LIMIT = 3800, LINE = "━━━━━━━━━━━━━━━━";
const DASH_URL = () => DB.appUrl();

/* ---------- formatting: N/A instead of 0 when a value is unknown ---------- */
const ok = (v) => v !== null && v !== undefined && isFinite(v);
const inr = (v) => (ok(v) ? DB.cur() + Math.round(v).toLocaleString(DB.locale()) : "N/A");
const int = (v) => (ok(v) ? Math.round(v).toLocaleString(DB.locale()) : "N/A");
const dec1 = (v) => (ok(v) ? (Math.round(v * 10) / 10).toLocaleString(DB.locale()) : "N/A");
const pct = (v, d) => (ok(v) ? (v * 100).toFixed(d === undefined ? 0 : d) + "%" : "N/A");
const sgn = (v) => (ok(v) ? (v > 0 ? "+" : "") + Math.round(v * 100) + "%" : "N/A");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso) => +iso.slice(8) + " " + MON[+iso.slice(5, 7) - 1] + " " + iso.slice(0, 4);
const istStamp = (ms) => { const d = new Date((ms || Date.now()) + DB.tzMs()); let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, "0"), ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + d.getUTCFullYear() + ", " + h + ":" + m + " " + ap + " " + DB.tzLabel(); };
const addDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };

/* totals of one window, from the summed brand rows: ratios from sums */
function kpi(x, unavailable) {
  x = x || {}; const s = +x.spend || 0, l = +x.leads || 0, c = +x.crm || 0, q = +x.ql || 0, i = unavailable ? null : +x.imp || 0, k = unavailable ? null : +x.clk || 0;
  return { spend: s, leads: l, crm: c, ql: q, imp: i, clk: k, cpl: l > 0 ? s / l : null, cpql: q > 0 ? s / q : null, ctr: i > 0 ? k / i : null, cpc: k > 0 ? s / k : null, cpm: i > 0 ? s / i * 1000 : null,
    qlRate: c > 0 ? q / c : null, sync: l > 0 ? c / l : null };
}
function sumRows(rows, from, to, brands) {
  const o = {}; brands.forEach((b) => { o[b] = { spend: 0, leads: 0, crm: 0, ql: 0, imp: 0, clk: 0, days: {} }; });
  rows.forEach((r) => { if (r.day < from || r.day > to || !o[r.brand]) return; const x = o[r.brand];
    x.spend += +r.spend || 0; x.leads += +r.leads || 0; x.crm += +r.crm || 0; x.ql += +r.ql || 0; x.imp += +r.impressions || 0; x.clk += +r.clicks || 0; if (+r.spend > 0) x.days[r.day] = 1; });
  return o;
}
function totalOf(map, brands, unavailable) { const o = { spend: 0, leads: 0, crm: 0, ql: 0, imp: 0, clk: 0 }; brands.forEach((b) => { const x = map[b]; if (x) Object.keys(o).forEach((k) => { o[k] += x[k]; }); }); return kpi(o, unavailable); }
function outsideOf(rows, from, to, listed) { let s = 0; const names = {}; rows.forEach((r) => { if (r.day < from || r.day > to || listed.indexOf(r.brand) >= 0) return; s += +r.spend || 0; if (+r.spend > 0) names[r.brand] = 1; }); return { spend: s, names: Object.keys(names) }; }

/* ---------- reach: only where it can be counted without double-counting people ----------
   Meta reach can't be added across ads, days or accounts. It is shown for a brand only when the brand has exactly ONE ad account of its own
   (Settings › Data connections › brand set on the account) and that account's spend for the period equals the brand's spend — i.e. the
   account holds that brand alone. Otherwise N/A. */
async function reachFor(S, brands, ranges, brandSpend) {
  const accs = (Array.isArray(S.metaAccounts) ? S.metaAccounts : []).filter((a) => a && a.id && a.on !== false), own = {}, out = {};
  accs.forEach((a) => { if (a.brand) (own[a.brand] = own[a.brand] || []).push(a); });
  await Promise.all(brands.map(async (b) => {
    out[b] = {}; const list = own[b] || [];
    Object.keys(ranges).forEach((k) => { out[b][k] = { reach: null, why: list.length > 1 ? "several ad accounts" : "shared ad account" }; });
    if (list.length !== 1) return;
    const id = String(list[0].id).indexOf("act_") === 0 ? list[0].id : "act_" + list[0].id;
    await Promise.all(Object.keys(ranges).map(async (k) => {
      try { const r = await all(GRAPH + "/" + id + "/insights?level=account&fields=spend,reach&time_range=" + encodeURIComponent(JSON.stringify({ since: ranges[k][0], until: ranges[k][1] })), 1);
        const row = r[0] || { spend: 0, reach: 0 }, sp = +row.spend || 0, bs = (brandSpend[k] || {})[b] || 0;
        out[b][k] = Math.abs(sp - bs) <= Math.max(1, bs * 0.01) ? { reach: +row.reach || 0 } : { reach: null, why: "account also runs other campaigns" }; }
      catch (e) { out[b][k] = { reach: null, why: "Meta didn't answer" }; } }));
  }));
  return out;
}

/* ---------- delivery status: no spend vs paused vs failed delivery vs missing data ---------- */
function delivery(D, b, x, period) {
  const F = D.feedsInfo || {}, live = D.live || {}, L = (live.by || {})[b], accs = (D.S.metaAccounts || []).filter((a) => a && a.brand === b && a.on !== false);
  const failedAcc = accs.filter((a) => F.metaErr && F.metaErr.indexOf(a.name || a.id) >= 0).map((a) => a.name || a.id);
  const liveUnknown = live.skipped || accs.some((a) => (live.errors || []).some((e) => e.indexOf((a.name || a.id) + ":") === 0));
  const counts = liveUnknown ? null : L || { camps: 0, sets: 0, ads: 0 };
  let status;
  if (failedAcc.length) status = "⚠️ Data missing: " + failedAcc.join(", ") + " failed to sync — figures may be incomplete";
  else if (!counts) status = x.spend > 0 ? "🟢 Spent " + (period === "today" ? "today" : "this period") + " · live ads couldn't be read from Meta" : "❔ Unknown — live ads couldn't be read from Meta";
  else if (period === "today") status = counts.ads && x.spend > 0 ? "🟢 Delivering" : counts.ads && D.hour >= 11 ? "🟠 Live but not spending — possible delivery problem" : counts.ads ? "🟢 Live (no spend yet today)" : x.spend > 0 ? "⚪ Spent earlier today, nothing live now (paused / ended)" : "⚪ No active campaigns · no spend";
  else status = x.spend > 0 ? (counts.ads ? "🟢 Delivered · still live" : "⚪ Delivered · nothing live now (paused / ended)") : counts.ads ? "🟠 Live now but no spend in the period" : "⚪ No active campaigns · no spend";
  return { counts, status, partialCounts: !liveUnknown && (live.errors || []).length > 0 };
}
const countTxt = (c, partial) => (c ? int(c.camps) + " / " + int(c.sets) + " / " + int(c.ads) + (partial ? " (some accounts unreadable)" : "") : "N/A");

/* ---------- splitting: overall summary first, brands whole, numbered parts ---------- */
function split(head, first, blocks, tail) {
  const parts = [first.join("\n")]; let cur = [];
  const flush = () => { if (cur.length) { parts.push(cur.join("\n\n")); cur = []; } };
  blocks.concat(tail).forEach((b) => { const len = cur.reduce((s, x) => s + x.length + 2, 0); if (cur.length && len + b.length + 160 > LIMIT) flush(); cur.push(b); });
  flush();
  return parts.map((p, i) => head(i + 1, parts.length) + "\n\n" + p);
}

/* ================= DAILY ================= */
function daily(D, found, opt) {
  opt = opt || {}; const S = D.S, listed = D.listed.slice(), day = opt.day || D.today, partial = day === D.today, reach = opt.reach || {};
  if (!partial) found = found.filter((x) => !new RegExp("\\|" + D.today + "$").test(x.key));   // a past day's report leaves out today's intraday issues
  const noImp = !D.v2, cur = sumRows(D.brandRows, day, day, listed), base = sumRows(D.brandRows, addDays(day, -7), addDays(day, -1), listed);
  const tot = totalOf(cur, listed, noImp), out = outsideOf(D.brandRows, day, day, listed), F = D.feedsInfo || {};
  const id = "D-" + day.replace(/-/g, "") + "-" + new Date(Date.now() + DB.tzMs()).toISOString().slice(11, 16).replace(":", "");
  const issuesOf = (b) => found.filter((x) => x.brand === b).sort((p, q) => SEV[p.severity] - SEV[q.severity]);
  const brandsAlert = listed.filter((b) => issuesOf(b).length).length;
  /* overall live = listed brands only (same scope as the money) */
  let lc = 0, ls = 0, la = 0, liveOk = !(D.live || {}).skipped; listed.forEach((b) => { const c = ((D.live || {}).by || {})[b]; if (c) { lc += c.camps; ls += c.sets; la += c.ads; } });
  const fresh = !F.meta ? "❌ No Meta sync yet" : F.meta.age <= 45 ? "✅ Fresh" : F.meta.age <= 75 ? "🟠 Slightly delayed" : "❌ Stale — numbers are older than they look";
  /* blocks */
  const blocks = [], rows = listed.map((b) => ({ b, x: kpi(cur[b], noImp), p: kpi(base[b], noImp) }));
  rows.sort((p, q) => q.x.spend - p.x.spend || q.x.leads - p.x.leads);
  rows.forEach((r) => { const x = r.x, dv = delivery(D, r.b, x, partial ? "today" : "day"), cplC = ok(x.cpl) && ok(r.p.cpl) && x.leads >= 1 && r.p.leads >= 1 ? x.cpl / r.p.cpl - 1 : null;
    const iss = issuesOf(r.b), rc = (reach[r.b] || {}).day;
    const att = iss.length ? iss.slice(0, 2).map((i) => (i.severity === "critical" ? "🚨 " : "") + i.title + (i.campaign ? " (" + i.campaign + ")" : "")).join("; ") + (iss[0].action ? "\n👉 " + iss[0].action : "") : "None";
    blocks.push(["🏢 <b>" + esc(r.b) + "</b>", "",
      "💰 Spend: " + inr(x.spend), "👁️ Impressions: " + int(x.imp), "👥 Reach: " + (rc && ok(rc.reach) ? int(rc.reach) : "N/A" + (rc && rc.why ? " (" + rc.why + ")" : "")),
      "🖱️ Link clicks: " + int(x.clk), "📊 CTR: " + pct(x.ctr, 2), "💵 CPC: " + inr(x.cpc), "📣 CPM: " + inr(x.cpm), "",
      "🎯 Meta Leads: " + int(x.leads), "📥 " + DB.crm() + " Leads: " + int(x.crm), "✅ Qualified Leads: " + int(x.ql), "",
      "📈 CPL: " + inr(x.cpl), "💵 CPQL: " + inr(x.cpql), "📉 CPL Trend: " + (ok(cplC) ? sgn(cplC) + " vs 7-day baseline (" + inr(r.p.cpl) + ")" : "N/A (no baseline)"), "",
      "📢 Campaigns / 🧩 Ad sets / 🖼️ Ads: " + countTxt(dv.counts, dv.partialCounts), "",
      "Status: " + dv.status, "Attention: " + esc(att), LINE].join("\n")); });
  if (blocks.length !== listed.length) throw new Error("report check: " + blocks.length + " brand blocks for " + listed.length + " brands");
  /* insights: need enough leads (minimum from Alerts & Monitoring thresholds) */
  const th = Object.assign({ minLeads: 5, minSpend: 1000 }, ((S.alerts || {}).th) || {}), enough = rows.filter((r) => r.x.leads >= th.minLeads && r.x.spend >= th.minSpend);
  const best = enough.slice().sort((p, q) => p.x.cpl - q.x.cpl)[0];
  const mv = enough.filter((r) => r.p.leads >= th.minLeads && ok(r.p.cpl)).map((r) => ({ b: r.b, c: r.x.cpl / r.p.cpl - 1 }));
  const imp = mv.filter((m) => m.c < -0.05).sort((p, q) => p.c - q.c)[0], det = mv.filter((m) => m.c > 0.05).sort((p, q) => q.c - p.c)[0];
  const zero = rows.filter((r) => r.x.spend > 0 && !r.x.leads).sort((p, q) => q.x.spend - p.x.spend)[0];
  const gap = rows.filter((r) => r.x.leads - r.x.crm > 0).sort((p, q) => (q.x.leads - q.x.crm) - (p.x.leads - p.x.crm))[0];
  const ins = ["<b>DAILY INSIGHTS</b>",
    "🏆 Best CPL: " + (best ? "<b>" + esc(best.b) + "</b> — " + inr(best.x.cpl) + " (" + int(best.x.leads) + " leads" + (best.x.ql ? ", CPQL " + inr(best.x.cpql) : "") + ")" : "N/A — no brand with " + th.minLeads + "+ leads and " + inr(th.minSpend) + "+ spend"),
    "📈 Biggest Improvement: " + (imp ? "<b>" + esc(imp.b) + "</b> — CPL " + sgn(imp.c) + " vs 7 days" : "N/A"),
    "⚠️ Biggest Deterioration: " + (det ? "<b>" + esc(det.b) + "</b> — CPL " + sgn(det.c) + " vs 7 days" : "N/A"),
    "🛑 Highest Spend With Zero Leads: " + (zero ? "<b>" + esc(zero.b) + "</b> — " + inr(zero.x.spend) : "None"),
    "🔗 Largest Lead Discrepancy: " + (gap ? "<b>" + esc(gap.b) + "</b> — " + int(gap.x.leads - gap.x.crm) + " (Meta " + int(gap.x.leads) + " vs " + DB.crm() + " " + int(gap.x.crm) + ")" + (partial ? " · today's gap can be timing" : "") : "None")];
  const top = found.filter((x) => x.brand && listed.indexOf(x.brand) >= 0 || /^(account|billing|sync)$/.test(x.kind)).sort((p, q) => SEV[p.severity] - SEV[q.severity] || ((q.value || 0) - (p.value || 0))).slice(0, 5);
  const act = ["<b>ACTION REQUIRED</b>"].concat(top.length ? top.map((x, i) => (i + 1) + ". " + (x.severity === "critical" ? "🚨" : x.severity === "high" ? "🔴" : "🟠") + " <b>" + esc(x.brand || x.account || "All") + "</b>: " + esc(x.title) + (x.confirmed === false ? " <i>(suspected)</i>" : "") + (x.action ? "\n   👉 " + esc(x.action) : "")) : ["Nothing urgent. ✅"]);
  act.push("", "🔗 Dashboard: " + DASH_URL(), "<i>Meta leads by Meta's reporting day; " + DB.crm() + " leads by created day " + "(" + DB.tzLabel() + ")" + ", repeat leads left out. QL keeps rising for a few days as sales qualifies leads.</i>");
  /* overall */
  const sumCheck = rows.reduce((s, r) => s + r.x.spend, 0), sumLeads = rows.reduce((s, r) => s + r.x.leads, 0), recOk = Math.abs(sumCheck - tot.spend) < 1 && Math.abs(sumLeads - tot.leads) < 0.5;
  const first = ["<b>OVERALL PERFORMANCE</b>" + (partial ? " · <i>PARTIAL DAY (up to " + istStamp().split(", ")[1] + ")</i>" : " · complete day"),
    "💰 Total Spend: " + inr(tot.spend), "🎯 Meta Leads: " + int(tot.leads), "📥 " + DB.crm() + " Leads: " + int(tot.crm), "✅ Qualified Leads: " + int(tot.ql),
    "📈 Blended CPL: " + inr(tot.cpl), "💵 CPQL: " + inr(tot.cpql), "👁️ Impressions: " + int(tot.imp) + " · 🖱️ Clicks: " + int(tot.clk) + " · CTR " + pct(tot.ctr, 2) + " · CPC " + inr(tot.cpc) + " · CPM " + inr(tot.cpm), "",
    "📢 Live Campaigns: " + (liveOk ? int(lc) : "N/A"), "🧩 Active Ad Sets: " + (liveOk ? int(ls) : "N/A"), "🖼️ Active Ads: " + (liveOk ? int(la) : "N/A") + ((D.live || {}).errors && D.live.errors.length ? " (some accounts unreadable)" : ""), "",
    "🏷️ Brands monitored: " + listed.length + " · with alerts: " + brandsAlert,
    "🔄 Last Meta sync: " + (F.meta ? istStamp(Date.parse(F.meta.at)) : "never") + " · " + fresh,
    "📥 Last " + DB.crm() + " lead received: " + (F.crm ? istStamp(Date.parse(F.crm.at)) : "none yet"),
    (recOk ? "🧮 Totals check: ✅ overall = sum of the " + listed.length + " brand blocks" : "🧮 Totals check: ⚠️ brand blocks " + inr(sumCheck) + " vs overall " + inr(tot.spend)) +
      (out.spend > 0 ? " · " + inr(out.spend) + " spent outside the listed brands (" + esc(out.names.join(", ")) + ") — not included" : "")];
  if (noImp) first.push("<i>Impressions / clicks unavailable until supabase/monitoring.sql is run.</i>");
  if (D.errors && D.errors.length) first.push("<i>" + esc(D.errors.join(" · ")) + "</i>");
  const head = (i, n) => "📊 <b>" + DB.orgName() + " " + "DAILY PERFORMANCE REPORT</b>" + (n > 1 ? " · Part " + i + "/" + n : "") + "\n📅 Date: " + dayLabel(day) + (partial ? " (partial)" : "") + "\n🕒 Updated: " + istStamp() + "\n🆔 " + id;
  const parts = split(head, first, ["<b>BRAND-WISE PERFORMANCE</b>\n\n" + blocks[0]].concat(blocks.slice(1)), [ins.join("\n"), act.join("\n")]);
  return { id, day, partial, parts, brands: rows.map((r) => r.b), total: tot, recon: recOk };
}

/* ================= WEEKLY (Monday–Sunday, last completed week vs the week before) ================= */
function weekBounds(today) { const dow = (new Date(Date.parse(today + "T00:00:00Z")).getUTCDay() + 6) % 7, from = addDays(today, -dow - 7); return { from, to: addDays(from, 6), prevFrom: addDays(from, -7), prevTo: addDays(from, -1) }; }
function weeklyFull(D, found, opt) {
  opt = opt || {}; const S = D.S, listed = D.listed.slice(), wb = weekBounds(D.today), reach = opt.reach || {}, noImp = !D.v2;
  const cur = sumRows(D.brandRows, wb.from, wb.to, listed), prev = sumRows(D.brandRows, wb.prevFrom, wb.prevTo, listed), tot = totalOf(cur, listed, noImp), ptot = totalOf(prev, listed, noImp);
  const mk = D.today.slice(0, 7), TG = (((S.report || {}).months || {})[mk] || {}).brands || {}, dim = new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)).getUTCDate();
  const mtd = sumRows(D.brandRows, mk + "-01", D.today, listed), el = Math.max(0.5, +D.today.slice(8) - 1 + D.hour / 24);
  const th = Object.assign({ minLeads: 5, minSpend: 1000, minCrm: 20 }, ((S.alerts || {}).th) || {}), minW = Math.max(10, 2 * th.minLeads);
  const id = "W-" + wb.from.replace(/-/g, "") + "-" + wb.to.slice(5).replace("-", "");
  // week-level issues only: account / billing / tracking / feeds / lead quality / month pacing (not today's intraday moves)
  const WEEK_KINDS = /^(account|billing|rejected|sync|crm_sync|quality|budget)$/; found = found.filter((x) => WEEK_KINDS.test(x.kind) && !/^budget_day/.test(x.key));
  const rows = listed.map((b) => { const a = kpi(cur[b], noImp), p = kpi(prev[b], noImp), m = kpi(mtd[b], true), tg = TG[b] || {}, budget = +tg.budget > 0 ? +tg.budget : null, leadsTg = +tg.leads > 0 ? +tg.leads : null;
    const judge = a.leads >= minW && p.leads >= minW, cplC = judge ? a.cpl / p.cpl - 1 : null, cpqlC = a.ql >= 5 && p.ql >= 5 ? a.cpql / p.cpql - 1 : null;
    const qlJudge = a.crm >= th.minCrm && p.crm >= th.minCrm, qlC = qlJudge && p.qlRate ? a.qlRate / p.qlRate - 1 : null, spendC = p.spend > 0 ? a.spend / p.spend - 1 : null;
    const labels = [];
    if (!a.spend && !a.leads && !a.crm) labels.push("No activity");
    else if (!judge) labels.push("Not enough data to judge (fewer than " + minW + " leads in a week)");
    else if (cplC <= -0.1) labels.push("Improving"); else if (cplC >= 0.1) labels.push("Deteriorating"); else labels.push("Steady");
    if (ok(qlC) && qlC <= -0.2) labels.push("Lower-quality leads");
    const pace = budget ? m.spend / (budget / dim * el) : null; if (ok(pace) && pace > 1.1) labels.push("Overspending"); else if (ok(pace) && pace < 0.85) labels.push("Underspending");
    return { b, a, p, m, cplC, cpqlC, qlC, spendC, judge, budget, leadsTg, pace, labels, iss: found.filter((x) => x.brand === b).sort((x, y) => SEV[x.severity] - SEV[y.severity]) }; });
  /* per brand: insight + action, only from the numbers */
  const insight = (r) => { const a = r.a, p = r.p, L = [];
    if (r.labels[0] === "No activity") return p.spend ? "No spend this week (" + inr(p.spend) + " the week before)." : "No spend or leads in either week.";
    L.push("Spend " + inr(a.spend) + " (" + sgn(r.spendC) + "), Meta leads " + int(a.leads) + " vs " + int(p.leads) + ".");
    if (ok(r.cplC)) L.push("CPL " + sgn(r.cplC) + " (" + inr(p.cpl) + " → " + inr(a.cpl) + ").");
    if (ok(a.qlRate)) L.push("QL rate " + pct(a.qlRate) + (ok(r.qlC) ? " (" + sgn(r.qlC) + ")" : "") + ".");
    if (a.leads >= th.minLeads && ok(a.sync) && a.sync < 0.8) L.push("Only " + pct(a.sync) + " of Meta leads reached " + DB.crm() + ".");
    if (a.spend >= th.minSpend && !a.leads) L.push("Spent with no Meta leads.");
    return L.join(" "); };
  const action = (r) => { const a = r.a, A = [];
    if (r.labels[0] === "No activity") return p0(r) ? "Confirm whether this brand should be running (it spent the week before)." : "No action from the data — no activity.";
    if (a.spend >= th.minSpend && !a.leads) A.push("Check the lead form / WhatsApp destination and tracking; pause spend until leads come in.");
    if (a.leads >= th.minLeads && ok(a.sync) && a.sync < 0.8) A.push("Fix the form → " + DB.crm() + " connection (Lead forms / Lead leaks).");
    if (r.labels.indexOf("Deteriorating") >= 0) A.push("Find the ad sets / creatives behind the CPL rise (Reports › Creative analysis) and move budget to the cheapest ones.");
    if (r.labels.indexOf("Lower-quality leads") >= 0) A.push("Review targeting and form questions with sales; weight budget to campaigns with the best QL rate.");
    if (r.labels.indexOf("Improving") >= 0 && !(ok(r.qlC) && r.qlC < -0.1)) A.push("Scale the best ad sets gradually (≤20% budget steps) while CPQL holds.");
    if (r.labels.indexOf("Overspending") >= 0 || r.labels.indexOf("Underspending") >= 0) A.push("Pace to about " + inr(Math.max(0, (r.budget - r.m.spend) / Math.max(1, dim - el))) + "/day to land on the " + inr(r.budget) + " monthly budget.");
    if (r.iss[0] && (r.iss[0].severity === "critical" || r.iss[0].severity === "high")) A.push(r.iss[0].action);
    return A.length ? A.slice(0, 2).join(" ") : "No change needed based on last week's numbers."; };
  const p0 = (r) => r.p.spend > 0;
  rows.sort((p, q) => q.a.spend - p.a.spend || q.p.spend - p.p.spend);
  const blocks = rows.map((r) => { const a = r.a, p = r.p, dv = delivery(D, r.b, a, "week"), rc = (reach[r.b] || {}).week;
    return ["🏢 <b>" + esc(r.b) + "</b>", "",
      "💰 Spend: " + inr(a.spend), "Previous week: " + inr(p.spend), "↔️ Spend Change: " + sgn(r.spendC), "",
      "👁️ Impressions: " + int(a.imp) + " · 👥 Reach: " + (rc && ok(rc.reach) ? int(rc.reach) : "N/A" + (rc && rc.why ? " (" + rc.why + ")" : "")), "🖱️ Link clicks: " + int(a.clk), "",
      "🎯 Meta Leads: " + int(a.leads), "📥 " + DB.crm() + " Leads: " + int(a.crm), "✅ Qualified Leads: " + int(a.ql), "",
      "📈 CPL: " + inr(a.cpl), "Previous CPL: " + inr(p.cpl), "CPL Change: " + (ok(r.cplC) ? sgn(r.cplC) : a.cpl && p.cpl ? sgn(a.cpl / p.cpl - 1) + " (small sample)" : "N/A"), "",
      "💵 CPQL: " + inr(a.cpql), "Previous CPQL: " + inr(p.cpql), "CPQL Change: " + (ok(r.cpqlC) ? sgn(r.cpqlC) : "N/A"), "",
      "📊 CTR: " + pct(a.ctr, 2), "🖱️ CPC: " + inr(a.cpc), "📣 CPM: " + inr(a.cpm), "",
      "📅 Average Daily Spend: " + inr(a.spend / 7), "🎯 Average Daily Leads: " + dec1(a.leads / 7), "📊 Qualified Lead Rate: " + pct(a.qlRate), "",
      "📢 Active Campaigns / 🧩 Ad Sets / 🖼️ Ads (now): " + countTxt(dv.counts, dv.partialCounts),
      r.budget ? "🎯 Month: " + inr(r.m.spend) + " of " + inr(r.budget) + " budget (" + pct(r.m.spend / r.budget) + " used, " + pct(r.pace) + " of plan)" + (r.leadsTg ? " · leads " + int(r.m.leads) + " of " + int(r.leadsTg) : "") : "🎯 Month budget: not set",
      "", "Status: " + r.labels.join(" · ") + (dv.status.indexOf("⚠️") === 0 || dv.status.indexOf("🟠") === 0 ? " · " + dv.status : "") + (r.iss.length ? " · open issues: " + r.iss.length : ""),
      "", "🔎 Key Insight:", esc(insight(r)), "", "➡️ Recommended Action:", esc(action(r)), LINE].join("\n"); });
  if (blocks.length !== listed.length) throw new Error("report check: " + blocks.length + " brand blocks for " + listed.length + " brands");
  /* management summary */
  const judged = rows.filter((r) => r.judge);
  const bestQ = rows.filter((r) => r.a.ql >= 5).sort((p, q) => p.a.cpql - q.a.cpql)[0] || rows.filter((r) => r.a.leads >= minW).sort((p, q) => p.a.cpl - q.a.cpl)[0];
  const impB = judged.filter((r) => r.cplC < 0).sort((p, q) => p.cplC - q.cplC)[0], detB = judged.filter((r) => r.cplC > 0).sort((p, q) => q.cplC - p.cplC)[0];
  const qual = rows.filter((r) => r.a.crm >= th.minCrm && ok(r.a.qlRate)).sort((p, q) => q.a.qlRate - p.a.qlRate)[0], spendTop = rows.filter((r) => r.a.spend > 0)[0];
  const attn = rows.filter((r) => r.labels.some((l) => /Deteriorating|Lower-quality|Overspending|Underspending/.test(l)) || r.iss.some((i) => SEV[i.severity] <= 1) || (r.a.spend >= th.minSpend && !r.a.leads)).map((r) => r.b);
  const nImp = rows.filter((r) => r.labels.indexOf("Improving") >= 0).length, nDet = rows.filter((r) => r.labels.indexOf("Deteriorating") >= 0).length;
  const summ = ["<b>WEEKLY MANAGEMENT SUMMARY</b>",
    "🏆 Best Performing Brand: " + (bestQ ? "<b>" + esc(bestQ.b) + "</b> — " + (bestQ.a.ql >= 5 ? "CPQL " + inr(bestQ.a.cpql) + ", " : "") + "CPL " + inr(bestQ.a.cpl) : "N/A (not enough data)"),
    "📈 Biggest CPL Improvement: " + (impB ? "<b>" + esc(impB.b) + "</b> " + sgn(impB.cplC) : "N/A"),
    "📉 Biggest CPL Deterioration: " + (detB ? "<b>" + esc(detB.b) + "</b> " + sgn(detB.cplC) : "N/A"),
    "🎯 Best Lead Quality: " + (qual ? "<b>" + esc(qual.b) + "</b> — QL rate " + pct(qual.a.qlRate) + " (" + int(qual.a.ql) + " of " + int(qual.a.crm) + ")" : "N/A (fewer than " + th.minCrm + " " + DB.crm() + " leads)"),
    "💸 Highest Spend: " + (spendTop ? "<b>" + esc(spendTop.b) + "</b> — " + inr(spendTop.a.spend) : "N/A"),
    "⚠️ Brands Requiring Attention: " + (attn.length ? esc(attn.join(", ")) : "None")];
  /* priorities: open issues first (severity, money), then week-level problems; only what the data shows */
  const pr = [], seen = {};
  found.slice().sort((p, q) => SEV[p.severity] - SEV[q.severity] || ((q.value || 0) - (p.value || 0))).forEach((x) => { if (SEV[x.severity] > 1 || pr.length >= 5) return; const k = (x.brand || x.account) + x.kind; if (seen[k]) return; seen[k] = 1; pr.push("<b>" + esc(x.brand || x.account || "All") + "</b>: " + esc(x.title) + " — " + esc(x.action)); });
  rows.forEach((r) => { if (pr.length >= 5) return; if (r.labels.some((l) => /Deteriorating|Lower-quality|Overspending|Underspending/.test(l)) || (r.a.spend >= th.minSpend && !r.a.leads)) pr.push("<b>" + esc(r.b) + "</b>: " + esc(action(r))); });
  const pri = ["<b>PRIORITIES FOR NEXT WEEK</b>"].concat(pr.length ? pr.map((x, i) => (i + 1) + ". " + x) : ["No urgent priorities from last week's data. ✅"]);
  pri.push("", "🔗 Dashboard: " + DASH_URL(), "<i>Week = Monday–Sunday " + "(" + DB.tzLabel() + ")" + ", complete week vs the one before. Brands are judged only with " + minW + "+ Meta leads in both weeks. QL for the last days of the week can still rise.</i>");
  /* overall */
  const budgets = rows.filter((r) => r.budget), bSum = budgets.reduce((s, r) => s + r.budget, 0), bSpend = budgets.reduce((s, r) => s + r.m.spend, 0);
  const major = found.filter((x) => /^(account|billing|rejected|sync|crm_sync)$/.test(x.kind) && SEV[x.severity] <= 1);
  const out = outsideOf(D.brandRows, wb.from, wb.to, listed), sumCheck = rows.reduce((s, r) => s + r.a.spend, 0), recOk = Math.abs(sumCheck - tot.spend) < 1;
  const ch = (a, b) => (ok(a) && ok(b) && b ? " (" + sgn(a / b - 1) + ")" : "");
  const first = ["<b>OVERALL PERFORMANCE</b> · complete week", "",
    "💰 Weekly Spend: " + inr(tot.spend) + ch(tot.spend, ptot.spend), "🎯 Meta Leads: " + int(tot.leads) + ch(tot.leads, ptot.leads), "📥 " + DB.crm() + " Leads: " + int(tot.crm) + ch(tot.crm, ptot.crm), "✅ Qualified Leads: " + int(tot.ql) + ch(tot.ql, ptot.ql), "",
    "📈 CPL: " + inr(tot.cpl) + ch(tot.cpl, ptot.cpl), "💵 CPQL: " + inr(tot.cpql) + ch(tot.cpql, ptot.cpql), "",
    "👁️ Impressions: " + int(tot.imp) + ch(tot.imp, ptot.imp), "🖱️ Clicks: " + int(tot.clk) + ch(tot.clk, ptot.clk), "📊 CTR: " + pct(tot.ctr, 2), "💵 CPC: " + inr(tot.cpc) + ch(tot.cpc, ptot.cpc), "📣 CPM: " + inr(tot.cpm) + ch(tot.cpm, ptot.cpm), "",
    "Comparison: previous 7-day period (" + dayLabel(wb.prevFrom) + " – " + dayLabel(wb.prevTo) + ")",
    "🎯 Budget (month to date, " + budgets.length + " brand" + (budgets.length === 1 ? "" : "s") + " with a budget): " + (budgets.length ? inr(bSpend) + " of " + inr(bSum) + " (" + pct(bSpend / bSum) + " used)" : "no budgets set in Report targets"),
    "📈 Improving: " + nImp + " · 📉 Deteriorating: " + nDet + " · not enough data: " + rows.filter((r) => !r.judge && r.labels[0] !== "No activity").length + " · no activity: " + rows.filter((r) => r.labels[0] === "No activity").length,
    "🚨 Account / tracking issues: " + (major.length ? major.slice(0, 4).map((x) => esc((x.brand || x.account || "") + (x.brand || x.account ? ": " : "") + x.title)).join("; ") + (major.length > 4 ? " +" + (major.length - 4) + " more" : "") : "none open"),
    (recOk ? "🧮 Totals check: ✅ overall = sum of the " + listed.length + " brand blocks" : "🧮 Totals check: ⚠️ brand blocks " + inr(sumCheck) + " vs overall " + inr(tot.spend)) + (out.spend > 0 ? " · " + inr(out.spend) + " outside the listed brands — not included" : "")];
  if (noImp) first.push("<i>Impressions / clicks unavailable until supabase/monitoring.sql is run.</i>");
  const head = (i, n) => "📅 <b>" + DB.orgName() + " " + "WEEKLY PERFORMANCE REPORT</b>" + (n > 1 ? " · Part " + i + "/" + n : "") + "\nPeriod: " + dayLabel(wb.from) + " – " + dayLabel(wb.to) + " (Mon–Sun)\n🆔 " + id;
  const parts = split(head, first, ["<b>BRAND-WISE WEEKLY PERFORMANCE</b>\n\n" + blocks[0]].concat(blocks.slice(1)), [summ.join("\n"), pri.join("\n")]);
  return { id, from: wb.from, to: wb.to, parts, brands: rows.map((r) => r.b), total: tot, prevTotal: ptot, recon: recOk };
}
module.exports = { daily, weeklyFull, reachFor, weekBounds, split, LIMIT, kpi };
