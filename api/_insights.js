// Updates & issues (Trends, private to the alert recipient): what needs action now, what is about to go wrong, and what just happened.
// Every item: { kind: "issue" | "upcoming" | "update", level: "high" | "medium" | "low", brand, title, detail, action, at }
const DB = require("./_db");
const PUSH_FILE_NAME = "CRM push";
const A = require("./_alertlib");
const ACT = require("./_activity");
const { accountFunds } = require("./_metalib");

const istMs = () => Date.now() + DB.tzMs();
const istDay = (o) => new Date(istMs() + (o || 0) * 864e5).toISOString().slice(0, 10);
const inr = (v) => DB.cur() + Math.round(Number(v) || 0).toLocaleString(DB.locale());
const int = (v) => Math.round(Number(v) || 0).toLocaleString(DB.locale());
const pct = (v) => Math.round(v * 100) + "%";
const minsAgo = (t) => (Date.now() - Date.parse(t)) / 60000;
const ago = (t) => { const m = minsAgo(t); return m < 60 ? Math.round(m) + " min ago" : m < 1440 ? (m / 60).toFixed(1) + " h ago" : Math.round(m / 1440) + " days ago"; };

async function insights(S, sbFetch) {
  const items = [], add = (o) => items.push(Object.assign({ brand: "", detail: "", action: "", at: new Date().toISOString() }, o)), errors = [];
  const c = A.cfgOf(S), N = await A.brandNumbers(S, sbFetch), today = N.today, mk = today.slice(0, 7);
  const minL = +c.minLeads || 3, lim = (+c.pct || 20) / 100, M = (((S.report || {}).months || {})[mk] || {}).brands || {};
  const cplOf = (x) => (x && x.leads > 0 ? x.spend / x.leads : null);

  /* ---- issues now: per brand, today ---- */
  Object.keys(N.td).forEach((b) => { if (b === "Unmapped") return; const t = N.td[b];
    if (t.spend >= 500 && !t.leads) add({ kind: "issue", level: "high", brand: b, title: "Spending with no leads today", detail: inr(t.spend) + " spent today, 0 Meta leads so far.", action: "Check the ads are delivering to the right lead form (Lead forms) and nothing changed (Ad account activity)." });
    const cpl = cplOf(t), r7 = cplOf(N.p7[b]), tg = M[b] && Number(M[b].cpl) > 0 ? Number(M[b].cpl) : null;
    if (t.leads >= minL && cpl && r7 && cpl >= r7 * (1 + lim)) add({ kind: "issue", level: "high", brand: b, title: "CPL up " + pct(cpl / r7 - 1) + " vs last 7 days", detail: "Today " + inr(cpl) + " vs " + inr(r7) + " (7-day average) · " + int(t.leads) + " leads for " + inr(t.spend) + ".", action: "Find the ad set taking the spend and check today's changes; compare ads in Reports › Creative analysis." });
    else if (t.leads >= minL && cpl && tg && cpl > tg) add({ kind: "issue", level: "medium", brand: b, title: "CPL above target", detail: "Today " + inr(cpl) + " vs target " + inr(tg) + ".", action: "Shift budget from the costliest ad sets to the cheaper ones." });
    if (t.leads >= 5 && t.crm / t.leads < 0.8) add({ kind: "issue", level: "high", brand: b, title: "Leads not reaching " + DB.crm(), detail: int(t.crm) + " of " + int(t.leads) + " Meta leads are in " + DB.crm() + " today (" + pct(t.crm / t.leads) + ").", action: "Open Lead leaks / Lead forms to see which form or campaign isn't connected to " + DB.crm() + "." });
  });

  /* ---- data feeds ---- */
  try {
    const ups = await sbFetch("uploads?select=meta_files,crm_file,uploaded_at&order=uploaded_at.desc&limit=40") || [];
    const meta = ups.filter((u) => (u.meta_files || []).indexOf("Meta API · auto-sync") >= 0)[0], push = ups.filter((u) => u.crm_file === PUSH_FILE_NAME)[0];
    if (S.metaAutoSync && (!meta || minsAgo(meta.uploaded_at) > 75)) add({ kind: "issue", level: "high", title: "Meta data is not updating", detail: meta ? "Last Meta sync " + ago(meta.uploaded_at) + "." : "No automatic Meta sync has run yet.", action: "Settings › Data connections: check the Meta connection; numbers on the dashboard are older than they look." });
    else if (meta && /^Last run errors/.test(meta.crm_file || "")) add({ kind: "issue", level: "medium", title: "Some ad accounts failed to sync", detail: String(meta.crm_file).slice(0, 220), action: "Give the system user access to those ad accounts, then Sync now." });
    if (push && minsAgo(push.uploaded_at) > 75) add({ kind: "issue", level: "high", title: DB.crm() + " leads are not arriving", detail: "Last lead from n8n " + ago(push.uploaded_at) + ".", action: "Open the n8n workflow and check it is Active and its last execution succeeded." });
  } catch (e) { errors.push("feeds: " + e.message); }

  /* ---- ad account events of the last 24 hours ---- */
  let acts = [];
  try { acts = await sbFetch("meta_activity?select=*&event_time=gte." + encodeURIComponent(new Date(Date.now() - 864e5).toISOString()) + "&order=event_time.desc&limit=300") || []; } catch (e) { errors.push("activity: " + e.message); }
  const learnSeen = {};
  acts.forEach((r) => { const d = ACT.describe(r), where = [r.campaign, r.adset, r.ad].filter(Boolean).join(" › ") || r.object_name || r.account_name, who = r.actor_name || r.application_name || "Meta";
    if (d.category === "payfail" || d.category === "rejected" || d.category === "stopped") add({ kind: "issue", level: "high", brand: r.brand, title: d.what, detail: where + " · " + who + ".", action: d.remark, at: r.event_time });
    else if (d.category === "access") add({ kind: "issue", level: "medium", brand: r.brand, title: d.what, detail: where + " · " + who + ".", action: d.remark, at: r.event_time });
    else if (d.impact === "high" && /budget|status|targeting|bidding|audience/.test(d.category) && !(d.category === "status" && /OFF/.test(d.what))) {
      const k = (r.campaign || "") + "|" + (r.adset || r.object_name); if (learnSeen[k]) return; learnSeen[k] = 1;
      add({ kind: "upcoming", level: "medium", brand: r.brand, title: "CPL may swing for 2–3 days", detail: d.what + (d.status ? " (" + d.status + ")" : "") + " on " + where + " by " + who + ".", action: "Don't judge or edit this ad set again for 2–3 days; check its CPL on the third day.", at: r.event_time }); }
    add({ kind: "update", level: d.impact, brand: r.brand, title: d.what + (d.status ? " · " + d.status : ""), detail: where + " · " + who, action: d.remark, at: r.event_time });
  });

  /* ---- money running out ---- */
  try {
    const accs = (S.metaAccounts || []).filter((a) => a && a.on !== false).map((a) => a.id);
    if (accs.length) (await accountFunds(accs)).forEach((f) => { const per = f.spend7 ? f.spend7 / 7 : null, amt = f.funds !== null && f.funds !== undefined ? f.funds : f.capLeft, what = f.funds !== null && f.funds !== undefined ? "prepaid balance" : "spending limit";
      if (amt === null || amt === undefined || !per) return; const days = amt / per;
      if (days < 2) add({ kind: "issue", level: "high", title: "Ads about to stop: " + what + " almost used up", detail: f.name + ": " + inr(amt) + " left at about " + inr(per) + "/day (" + (days < 1 ? "less than a day" : "about " + Math.floor(days) + " day") + ").", action: what === "prepaid balance" ? "Add funds to this ad account today." : "Raise the account spending limit today." });
      else if (days < 7) add({ kind: "upcoming", level: days < 4 ? "high" : "medium", title: what.charAt(0).toUpperCase() + what.slice(1) + " runs out in about " + Math.floor(days) + " days", detail: f.name + ": " + inr(amt) + " left at about " + inr(per) + "/day.", action: what === "prepaid balance" ? "Plan the next top-up before it runs out." : "Raise the spending limit before it's reached." }); });
  } catch (e) { errors.push("funds: " + e.message); }

  /* ---- month pacing vs Report targets ---- */
  const d = new Date(istMs()), dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), elapsed = Math.max(0.5, d.getUTCDate() - 1 + d.getUTCHours() / 24);
  if (d.getUTCDate() >= 3) Object.keys(M).forEach((b) => { const t = M[b] || {}, m = N.mtd[b] || { leads: 0, spend: 0 };
    if (Number(t.leads) > 0) { const proj = m.leads / elapsed * dim, r = proj / Number(t.leads);
      if (r < 0.9) add({ kind: "upcoming", level: r < 0.75 ? "high" : "medium", brand: b, title: "Monthly lead target at risk", detail: "At this pace " + int(proj) + " of " + int(t.leads) + " leads by month end (" + pct(r) + "). So far " + int(m.leads) + ".", action: "Needs about " + int(Math.max(0, (Number(t.leads) - m.leads) / Math.max(1, dim - elapsed))) + " leads a day from now: raise budget on the best ad sets or fix weak ones." }); }
    if (Number(t.budget) > 0) { const proj = m.spend / elapsed * dim, r = proj / Number(t.budget);
      if (r > 1.05) add({ kind: "upcoming", level: r > 1.15 ? "high" : "medium", brand: b, title: "Monthly budget will be overspent", detail: "At this pace " + inr(proj) + " vs budget " + inr(t.budget) + " (" + pct(r) + ").", action: "Lower daily budgets to about " + inr(Math.max(0, (Number(t.budget) - m.spend) / Math.max(1, dim - elapsed))) + "/day for the rest of the month." });
      else if (r < 0.85) add({ kind: "upcoming", level: "low", brand: b, title: "Monthly budget will be underspent", detail: "At this pace " + inr(proj) + " of " + inr(t.budget) + " (" + pct(r) + ").", action: "There's room to spend about " + inr(Math.max(0, (Number(t.budget) - m.spend) / Math.max(1, dim - elapsed))) + "/day; add it to the ad sets with the best CPL." }); }
  });

  /* ---- CPL updates of the last 24 hours ---- */
  try { const ev = await sbFetch("alert_log?select=at,text&kind=eq.cpl-event&at=gte." + encodeURIComponent(new Date(Date.now() - 864e5).toISOString()) + "&order=id.desc&limit=50") || [];
    ev.forEach((r) => { let e = null; try { e = JSON.parse(r.text); } catch (x) { return; }
      add({ kind: "update", level: e.impact, brand: e.brand, title: e.what + " · today " + inr(e.cpl), detail: (e.comparisons || []).map((c2) => "vs " + c2.compared + " " + inr(c2.ref) + (c2.change !== null && c2.change !== undefined ? " (" + (c2.change > 0 ? "+" : "") + Math.round(c2.change * 100) + "%)" : "")).join(" · "), action: e.remark, at: e.at }); }); }
  catch (e) { errors.push("cpl: " + e.message); }

  const rank = { high: 0, medium: 1, low: 2 };
  items.sort((x, y) => (rank[x.level] - rank[y.level]) || (x.at < y.at ? 1 : -1));
  return { at: new Date().toISOString(), day: today, issues: items.filter((x) => x.kind === "issue"), upcoming: items.filter((x) => x.kind === "upcoming"),
    updates: items.filter((x) => x.kind === "update").sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 40), errors };
}
module.exports = { insights };
