// Meta ad account activity → plain language. Used by the Telegram change alerts and the dashboard's "Ad account activity" page.
// Raw events are stored as Meta sends them (meta_activity); describe() turns each into
//   who · brand · campaign · ad set / ad · what changed · before → after · remarks (what will happen next) · impact.
const DB = require("./_db");
const { all, graph, VER } = require("./_metalib");
const GRAPH = "https://graph.facebook.com/" + VER;
const actId = (id) => (String(id).indexOf("act_") === 0 ? String(id) : "act_" + id);
const isoOf = (t) => { const x = Date.parse(String(t).replace(/([+-]\d{2})(\d{2})$/, "$1:$2")); return isFinite(x) ? new Date(x).toISOString() : null; };
const inr = (v) => DB.cur() + Math.round(v).toLocaleString(DB.locale());

/* ---------- values inside extra_data ---------- */
function parseExtra(x) { try { return typeof x === "string" ? JSON.parse(x) : (x || null); } catch (e) { return null; } }
function pick(v) {   // a value, or {old_value: n, currency} style wrapper
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of ["old_value", "new_value", "amount", "value", "status", "name"]) if (k in v && typeof v[k] !== "object") return { v: v[k], cur: v.currency };
    return { v: v, cur: v.currency };
  }
  return { v: v };
}
const MONEY = /budget|spend_cap|spend_limit|spending_limit|bid_amount|bid_info|billing|charge|funding|refund/;
function valText(raw, money) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "object") { const s = JSON.stringify(raw); return s.length > 60 ? "" : s; }   // big objects (targeting) aren't readable
  if (money && isFinite(Number(raw))) return inr(Number(raw) / 100);   // Meta budgets / caps are in paise
  const s = String(raw);
  if (/^(1|active|enabled)$/i.test(s)) return "Active"; if (/^(2|paused|inactive|disabled)$/i.test(s)) return "Paused";
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

/* ---------- what kind of change ---------- */
function category(t) {
  t = String(t || "").toLowerCase();
  if (/review_approved/.test(t)) return "approved";
  if (/review_declined|review_rejected|disapprov/.test(t)) return "rejected";
  if (/billing_charge_failed|billing_decline|charge_failed|payment_failed/.test(t)) return "payfail";
  if (/limit_reached|budget_spent|campaign_ended|ad_set_ended|_ended$/.test(t)) return "stopped";
  if (/spend_cap|spend_limit|spending_limit/.test(t)) return "cap";
  if (/budget/.test(t)) return "budget";
  if (/run_status|stop_delivery|update_status/.test(t)) return "status";
  if (/^create_|_created$|add_ad$/.test(t)) return "created";
  if (/target|placement|age|gender|geo/.test(t)) return "targeting";
  if (/optimization|bid_strategy|bidding|bid_type|bid_info|bid_adjust/.test(t)) return "bidding";
  if (/creative|image|video|_ad_link|carousel/.test(t)) return "creative";
  if (/duration|schedule|end_time|start_time/.test(t)) return "schedule";
  if (/name/.test(t)) return "rename";
  if (/billing|funding|charge|refund|payment/.test(t)) return "billing";
  if (/audience/.test(t)) return "audience";
  if (/role|user|permission|access/.test(t)) return "access";
  if (/learning/.test(t)) return "learning";
  if (/first_delivery/.test(t)) return "delivery";
  return "other";
}
const LEVEL = { campaign: "campaign", adset: "ad set", ad: "ad", account: "ad account" };
function levelOf(e) {
  if (e.level) return e.level;
  const o = String(e.object_type || "").toUpperCase(), t = String(e.event_type || "");
  if (/CAMPAIGN_GROUP/.test(o) || /campaign_group/.test(t)) return "campaign";
  if (/AD_SET|ADSET|^CAMPAIGN$/.test(o) || /ad_set/.test(t)) return "adset";
  if (/ADGROUP|^AD$/.test(o) || /_ad_|^create_ad$/.test(t)) return "ad";
  if (/ACCOUNT/.test(o) || /ad_account/.test(t)) return "account";
  return "";
}
const TGT = { age_min: "Min age", age_max: "Max age", genders: "Gender", geo_locations: "Locations", excluded_geo_locations: "Excluded locations", flexible_spec: "Interests / behaviours",
  interests: "Interests", behaviors: "Behaviours", custom_audiences: "Custom audiences", excluded_custom_audiences: "Excluded audiences", publisher_platforms: "Platforms",
  facebook_positions: "Facebook placements", instagram_positions: "Instagram placements", device_platforms: "Devices", locales: "Languages", targeting_automation: "Advantage+ audience" };
function targetingText(o, n) {
  if (!o || !n || typeof o !== "object" || typeof n !== "object") return "";
  const keys = Array.from(new Set(Object.keys(o).concat(Object.keys(n)))), out = [];
  keys.forEach((k) => { const a = o[k], b = n[k]; if (JSON.stringify(a) === JSON.stringify(b)) return; const nm = TGT[k] || k.replace(/_/g, " ");
    const simple = (v) => v === undefined || v === null ? null : typeof v !== "object" ? String(v) : Array.isArray(v) && v.every((x) => typeof x !== "object") ? v.join(", ") : null;
    if (a === undefined) out.push(nm + " added"); else if (b === undefined) out.push(nm + " removed");
    else if (simple(a) !== null && simple(b) !== null) out.push(nm + " " + simple(a) + " → " + simple(b)); else out.push(nm + " changed"); });
  return out.slice(0, 5).join(" · ") + (out.length > 5 ? " · +" + (out.length - 5) + " more" : "");
}
function describe(e) {
  const cat = category(e.event_type), lvl = levelOf(e), L = LEVEL[lvl] || "item", x = parseExtra(e.extra_data != null ? e.extra_data : e.extra) || {};
  const money = MONEY.test(String(e.event_type || ""));
  const ov = "old_value" in x ? pick(x.old_value).v : undefined, nv = "new_value" in x ? pick(x.new_value).v : undefined;
  const before = valText(ov, money), after = valText(nv, money);
  const on = Number(ov) / 100, nn = Number(nv) / 100, ch = money && isFinite(on) && isFinite(nn) && on > 0 ? nn / on - 1 : null;
  let what = e.translated_event_type || String(e.event_type || "").replace(/_/g, " "), remark = "Check Ads Manager › Activity history for the full detail.", impact = "low";
  switch (cat) {
    case "budget":
      what = (ch === null ? "Budget changed" : ch > 0 ? "Budget increased" : "Budget decreased") + (ch !== null ? " (" + (ch > 0 ? "+" : "") + Math.round(ch * 100) + "%)" : "");
      if (ch === null) { remark = "Daily spend for this " + L + " changes from now; watch CPL over the next 2–3 days."; impact = "medium"; }
      else if (ch > 0.2) { remark = "Meta can now spend up to " + after + "/day here. Expect more leads, but CPL may rise for 2–3 days while delivery re-adjusts (big jumps can restart learning). Check CPL tomorrow."; impact = "high"; }
      else if (ch > 0) { remark = "Small increase: spend goes up to about " + after + "/day with stable delivery. Expect a few more leads at a similar CPL."; impact = "medium"; }
      else if (ch < -0.2) { remark = "Spend drops to about " + after + "/day: fewer leads from today. A big cut can make delivery less stable for a day or two."; impact = "high"; }
      else { remark = "Spend drops slightly to about " + after + "/day: a few fewer leads, CPL should stay similar."; impact = "medium"; }
      break;
    case "status": {
      const off = /pause|inactive|off|delete|archiv|stop/i.test(after + " " + what), onn = /active|on|resum/i.test(after) && !off;
      what = off ? "Turned OFF (" + L + " paused)" : onn ? "Turned ON (" + L + " active)" : "Status changed";
      remark = off ? "Stops spending now: no new leads from this " + L + " until it's switched on again. Leads already received are not affected."
        : onn ? "Starts spending within minutes (after review if it was edited). The first 2–3 days can have uneven CPL while it warms up." : "Delivery of this " + L + " changes from now; check it's running as intended.";
      impact = "high"; break; }
    case "created":
      what = "New " + L + " created";
      remark = lvl === "ad" ? "Goes to Meta review (usually under 24 hours), then starts delivering. Early CPL is unstable for the first few days."
        : lvl === "adset" ? "Starts in the learning phase: it needs about 50 leads in 7 days to stabilise, so expect higher and jumpy CPL at first."
        : lvl === "campaign" ? "No spend until it has active ad sets and ads. Once live, it starts in learning (higher CPL for the first days)." : "New item added to the ad account.";
      impact = "medium"; break;
    case "targeting": what = "Audience / targeting changed"; remark = "Different people will see the ads. The ad set re-enters learning, so expect CPL swings for 2–3 days and possibly different lead quality — check " + DB.crm() + " QL rate."; impact = "high"; break;
    case "bidding": what = "Bid strategy / optimisation changed"; remark = "Changes how Meta buys results. Learning restarts: CPL can rise for a few days before it settles at the new level."; impact = "high"; break;
    case "creative": what = "Ad creative / copy changed"; remark = "The ad goes back to review and restarts learning; delivery may pause briefly and CPL can move for 1–2 days."; impact = "medium"; break;
    case "schedule": what = "Start / end date changed"; remark = "Ads will run until the new date" + (after ? " (" + after + ")" : "") + ", then stop spending automatically."; impact = "medium"; break;
    case "rename": what = "Renamed"; remark = "Name only — no effect on delivery or results. New " + DB.crm() + " leads will carry the new campaign name; the dashboard matches by ad account and day, so nothing is double-counted."; impact = "low"; break;
    case "approved": what = "Ad approved by Meta"; remark = "The ad can start spending now."; impact = "low"; break;
    case "rejected": what = "Ad rejected by Meta"; remark = "This ad will not spend. Open it in Ads Manager to see the policy reason, fix it and request review again."; impact = "high"; break;
    case "cap": what = "Spending limit changed"; remark = "Spending stops automatically when the limit" + (after ? " (" + after + ")" : "") + " is reached — raise it in time to keep ads running."; impact = "medium"; break;
    case "stopped": what = "Stopped delivering (limit / budget / end date reached)"; remark = "No more spend or leads from here until the limit, budget or end date is extended."; impact = "high"; break;
    case "payfail": what = "Payment failed"; remark = "Meta may pause ALL ads in this account soon. Update the payment method or add funds now."; impact = "high"; break;
    case "billing": what = "Billing / payment activity"; remark = "Routine billing event — no change to delivery."; impact = "low"; break;
    case "audience": what = "Saved audience changed"; remark = "Ad sets using this audience will reach different people and may re-enter learning."; impact = "medium"; break;
    case "access": what = "Ad account access changed"; remark = "Someone's access to the ad account was added, changed or removed — make sure this was intended."; impact = "high"; break;
    case "learning": what = "Ad set left the learning phase"; remark = "Performance should be steadier from now; avoid big edits for a few days."; impact = "low"; break;
    case "delivery": what = "Started delivering"; remark = "First impressions served — spend and leads start from now."; impact = "low"; break;
  }
  let status = before || after ? (before || "—") + " → " + (after || "—") : "";
  if (cat === "targeting" || cat === "audience") { const tt = targetingText(pick(x.old_value).v, pick(x.new_value).v); status = tt || (status.length > 70 || /[{\[]/.test(status) ? "changed" : status); }
  else if (/[{\[]/.test(status)) status = "changed";
  const diff = money && isFinite(on) && isFinite(nn) ? nn - on : null;
  return { category: cat, level: lvl, what, before, after, status, remark, impact, change: ch, diff, money };
}
/* one change as the Telegram "META ACCOUNT CHANGE DETECTED" block. Only what Meta's activity log gives: no invented values or people. */
const LEVEL_IMPACT = { high: 0, medium: 1, low: 2 };
function changeBlock(e, esc, when) {
  const d = describe(e), L = ["📝 <b>META ACCOUNT CHANGE DETECTED</b>", ""];
  L.push("Brand: " + esc(e.brand || "Not mapped"), "Ad Account: " + esc(e.account_name || e.account_id || "—"));
  if (e.campaign) L.push("Campaign: " + esc(e.campaign));
  if (e.adset && d.level !== "campaign") L.push("Ad set: " + esc(e.adset));
  if (e.ad) L.push("Ad: " + esc(e.ad));
  if (!e.campaign && !e.adset && !e.ad && e.object_name) L.push((LEVEL[d.level] ? LEVEL[d.level].charAt(0).toUpperCase() + LEVEL[d.level].slice(1) : "Item") + ": " + esc(e.object_name));
  L.push("Change: " + esc(d.what.replace(/ \([+-]?\d+%\)$/, "")));
  if (d.category === "targeting" || d.category === "audience") { if (d.status && d.status !== "changed") L.push("", "What changed: " + esc(d.status)); else L.push("", "Previous / new: not given in detail by Meta (open Activity history in Ads Manager)"); }
  else if (d.before || d.after) {
    const per = d.category === "budget" ? (/lifetime/i.test(e.event_type) ? " (lifetime)" : "/day") : "";
    L.push("", "Previous: " + esc(d.before ? d.before + per : "not given by Meta"), "New: " + esc(d.after ? d.after + per : "not given by Meta"));
    if (d.change !== null && d.change !== undefined) L.push("Change: " + (d.change > 0 ? "+" : "") + Math.round(d.change * 100) + "%");
  }
  L.push("", "Changed at: " + when(e.event_time) + " " + DB.tzLabel(), "Changed by: " + esc(e.actor_name || (e.application_name ? e.application_name + " (app)" : "Not given by Meta (automatic or system change)")));
  let imp = d.remark;
  if (d.category === "budget" && d.diff !== null) imp = "Budget " + (d.diff > 0 ? "increased" : "decreased") + " by " + inr(Math.abs(d.diff)) + ". " + d.remark;
  L.push("", "Impact: " + esc(imp), "", "Action: " + esc(d.category === "rejected" || d.category === "payfail" || d.category === "stopped" ? "Fix it now (see impact)." : d.category === "rename" || d.category === "approved" || d.category === "delivery" || d.category === "learning" ? "No action needed." : "Verify whether this change was planned."));
  return L.join("\n");
}

/* ---------- names of the campaign / ad set an object belongs to (looked up once, when stored) ---------- */
async function enrich(objectId) {
  for (const f of ["name,adset{name},campaign{name}", "name,campaign{name}", "name,objective"]) {
    try { const o = await graph(GRAPH + "/" + objectId + "?fields=" + encodeURIComponent(f));
      if (o.adset) return { level: "ad", campaign: o.campaign && o.campaign.name, adset: o.adset.name, ad: o.name };
      if (o.campaign) return { level: "adset", campaign: o.campaign.name, adset: o.name };
      if ("objective" in o) return { level: "campaign", campaign: o.name };
    } catch (e) { /* try the next shape; deleted objects fail every time */ }
  }
  return null;
}
/* fetch new events for every synced account and store them; first time per account: the last `backfillDays` days */
async function fetchAndStore(S, sbFetch, opt) {
  opt = opt || {};
  const accs = (Array.isArray(S.metaAccounts) ? S.metaAccounts : []).filter((a) => a && a.id && a.on !== false);
  const kws = (S.keywords || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]).toLowerCase(), k[1]]);
  const brandOf = (a, name) => a.brand || (function(){ const s = String(name || "").toLowerCase(); for (const k of kws) if (s.indexOf(k[0]) >= 0) return k[1]; return ""; })();
  const st = (await opt.getState(sbFetch, "activity")) || {}, next = Object.assign({}, st), fresh = [], errors = [];
  await Promise.all(accs.map(async (a) => {
    const id = actId(a.id), last = st[id], first = !last;
    const since = first ? Date.now() - (opt.backfillDays || 7) * 864e5 : Date.parse(last) - 120000;
    try {
      const list = await all(GRAPH + "/" + id + "/activities?fields=event_time,event_type,translated_event_type,actor_name,actor_id,object_name,object_type,object_id,extra_data,application_name&since=" + Math.floor(since / 1000) + "&limit=100", first ? 20 : 3);
      let max = last || new Date().toISOString();
      const rows = [];
      for (const e of list) {
        const t = isoOf(e.event_time); if (!t || (last && t <= last)) continue; if (t > max) max = t;
        rows.push({ ev_key: [id, t, e.event_type, e.object_id || ""].join("|"), account_id: id, account_name: a.name || id, event_time: t, event_type: e.event_type || "",
          translated: e.translated_event_type || "", actor_name: e.actor_name || "", actor_id: e.actor_id || "", application_name: e.application_name || "",
          object_type: e.object_type || "", object_id: e.object_id || "", object_name: e.object_name || "", level: "", campaign: "", adset: "", ad: "", brand: "",
          extra: e.extra_data == null ? null : (typeof e.extra_data === "string" ? e.extra_data : JSON.stringify(e.extra_data)), first_load: first });
      }
      // campaign / ad set names (few objects per run; cached per object within the run)
      const cache = {};
      for (const r of rows.slice(0, 60)) { if (!r.object_id || /ACCOUNT/i.test(r.object_type)) continue;
        if (!(r.object_id in cache)) cache[r.object_id] = await enrich(r.object_id);
        const n = cache[r.object_id]; if (n){ r.level = n.level; r.campaign = n.campaign || ""; r.adset = n.adset || ""; r.ad = n.ad || ""; } }
      rows.forEach((r) => { r.brand = brandOf(a, r.campaign || r.object_name); if (!r.campaign && /campaign_group|CAMPAIGN_GROUP/.test(r.event_type + r.object_type)) r.campaign = r.object_name; });
      if (rows.length) await sbFetch("meta_activity?on_conflict=ev_key", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows.map((r) => { const o = Object.assign({}, r); delete o.first_load; return o; })) });
      rows.forEach((r) => { if (!r.first_load) fresh.push(Object.assign({ _acc: a }, r)); });
      next[id] = max;
    } catch (e) { errors.push((a.name || id) + ": " + e.message); }
  }));
  await opt.setState(sbFetch, "activity", next);
  fresh.sort((x, y) => (x.event_time < y.event_time ? -1 : 1));
  return { fresh, errors };
}
module.exports = { describe, category, fetchAndStore, enrich, valText, changeBlock, LEVEL_IMPACT };
