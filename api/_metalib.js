// Shared Meta Marketing API helpers for api/meta.js (manual sync) and api/meta-cron.js (every 30 minutes).
const DB = require("./_db");
const VER = process.env.META_API_VERSION || "v23.0";
const GRAPH = "https://graph.facebook.com/" + VER;
const n = (v) => { const x = Number(v); return isFinite(x) ? x : 0; };
async function graph(url) {
  const r = await fetch(url, { headers: { authorization: "Bearer " + (await DB.orgSecret("meta_access_token")) } });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || body.error) {
    const e = body && body.error ? body.error : {};
    throw new Error("Meta answered " + r.status + ": " + (e.message || "unknown error") + (e.code ? " (code " + e.code + (e.error_subcode ? "/" + e.error_subcode : "") + ")" : ""));
  }
  return body;
}
async function all(url, max) {
  let out = [], next = url, pages = 0;
  while (next && pages < (max || 50)) { const b = await graph(next); out = out.concat(b.data || []); next = b.paging && b.paging.next; pages++; }
  return out;
}
const act = (list, types) => { let s = 0; (list || []).forEach((a) => { if (types.indexOf(a.action_type) >= 0) s += n(a.value); }); return s; };
/* what Meta's "Results" column would show for the row, from the campaign objective */
function result(r) {
  const obj = String(r.objective || "").toUpperCase(), A = r.actions || [];
  const form = act(A, ["onsite_conversion.lead_grouped"]) || act(A, ["lead"]) || act(A, ["leadgen.other"]);
  const web = act(A, ["offsite_conversion.fb_pixel_lead"]) || act(A, ["onsite_web_lead"]);   // website leads tracked by the pixel
  const msgs = act(A, ["onsite_conversion.messaging_conversation_started_7d"]);
  const lpv = act(A, ["landing_page_view"]), lc = act(A, ["link_click"]) || n(r.inline_link_clicks);
  const L = [form, "Leads (form)"], W = [web, "Leads (website)"], M = [msgs, "Messaging conversations started"];
  if (/LEAD/.test(obj)) return form > 0 ? L : msgs > 0 ? M : web > 0 ? W : [0, ""];
  if (/ENGAGEMENT|MESSAG/.test(obj)) return msgs > 0 ? M : form > 0 ? L : web > 0 ? W : [0, ""];
  // Traffic campaigns that send people to WhatsApp / a form / a lead page: count the chats or leads, not the clicks
  if (/TRAFFIC|LINK_CLICK/.test(obj)) return msgs > 0 ? M : form > 0 ? L : web > 0 ? W : lpv > 0 ? [lpv, "Landing page views"] : lc > 0 ? [lc, "Link clicks"] : [0, ""];
  return form > 0 ? L : msgs > 0 ? M : web > 0 ? W : [0, ""];
}
const COLS = ["date", "account_id", "account_name", "currency", "campaign", "adset", "ad", "spend", "results", "result_indicator", "impressions", "clicks", "reach", "ad_id"];
/* daily ad-level rows for one ad account, as arrays in COLS order */
async function accountRows(accountId, from, to) {
  const id = String(accountId).indexOf("act_") === 0 ? accountId : "act_" + accountId;
  const info = await graph(GRAPH + "/" + id + "?fields=name,currency");
  const q = new URLSearchParams({
    level: "ad", time_increment: "1", limit: "500", action_breakdowns: "action_type",
    time_range: JSON.stringify({ since: from, until: to }),
    fields: "date_start,campaign_name,adset_name,ad_name,ad_id,objective,spend,impressions,inline_link_clicks,reach,actions",
  });
  const rows = await all(GRAPH + "/" + id + "/insights?" + q.toString(), 60);
  return rows.filter((r) => r.campaign_name).map((r) => {
    const rs = result(r);
    return [String(r.date_start).slice(0, 10), id, info.name || id, info.currency || "", String(r.campaign_name || ""), String(r.adset_name || ""), String(r.ad_name || ""),
      Math.round(n(r.spend) * 100) / 100, rs[0], rs[1], Math.round(n(r.impressions)), Math.round(n(r.inline_link_clicks)), r.reach === undefined ? null : Math.round(n(r.reach)), String(r.ad_id || "")];
  });
}
async function adAccounts() {
  const list = await all(GRAPH + "/me/adaccounts?fields=id,account_id,name,currency,account_status,amount_spent&limit=200", 10);
  return list.map((a) => ({ id: a.id, name: a.name || a.id, currency: a.currency || "", active: a.account_status === 1, spend: n(a.amount_spent) }))
    .sort((a, b) => (b.active - a.active) || (b.spend - a.spend));
}

/* money left on each ad account, live from Meta (never stored).
   Prepaid: the available balance Meta shows (funding source "Available balance …").
   Card / invoiced: no balance to show; the account spending limit left, if one is set.
   Amounts from Meta are in the currency's minor unit (paise); divided by 100. */
const parseMoney = (t) => { const m = String(t || "").replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
async function accountFunds(ids) {
  const base = "id,name,currency,account_status,amount_spent,spend_cap,balance,is_prepay_account";
  let list;
  try { list = await all(GRAPH + "/me/adaccounts?fields=" + base + ",funding_source_details&limit=200", 10); }
  catch (e) { list = await all(GRAPH + "/me/adaccounts?fields=" + base + "&limit=200", 10); }
  if (ids && ids.length) { const want = {}; ids.forEach((i) => { want[String(i).replace(/^act_/, "")] = 1; }); list = list.filter((a) => want[String(a.id).replace(/^act_/, "")]); }
  return Promise.all(list.map(async (a) => {
    const fs = a.funding_source_details || {}, txt = String(fs.display_string || "");
    const cap = n(a.spend_cap), spent = n(a.amount_spent);
    let funds = null;
    if (/balance/i.test(txt)) funds = parseMoney(txt);
    let spend7 = null;
    try { const r = await graph(GRAPH + "/" + a.id + "/insights?fields=spend&date_preset=last_7d"); spend7 = r.data && r.data[0] ? n(r.data[0].spend) : 0; } catch (e) { spend7 = null; }
    return { id: a.id, name: a.name || a.id, currency: a.currency || "", active: a.account_status === 1, status: a.account_status,
      prepay: a.is_prepay_account === true || /balance/i.test(txt), funds, fundingText: txt,
      capLeft: cap > 0 ? Math.max(0, (cap - spent) / 100) : null, owed: a.balance !== undefined ? n(a.balance) / 100 : null, spend7 };
  }));
}

/* current daily budget of every active campaign (live from Meta, never stored).
   Campaign budget (CBO) when set, otherwise the sum of its active ad sets' daily budgets.
   Lifetime budgets are returned separately. Amounts are in the currency's minor unit (paise) → divided by 100. */
async function accountBudgets(accountId) {
  const id = String(accountId).indexOf("act_") === 0 ? accountId : "act_" + accountId;
  const active = encodeURIComponent(JSON.stringify(["ACTIVE"]));
  const camps = await all(GRAPH + "/" + id + "/campaigns?fields=id,name,daily_budget,lifetime_budget,effective_status&effective_status=" + active + "&limit=500", 20);
  const sets = await all(GRAPH + "/" + id + "/adsets?fields=campaign_id,daily_budget,lifetime_budget,effective_status&effective_status=" + active + "&limit=500", 40);
  const bySet = {};
  sets.forEach((x) => { const o = bySet[x.campaign_id] || (bySet[x.campaign_id] = { daily: 0, lifetime: 0 }); o.daily += n(x.daily_budget) / 100; o.lifetime += n(x.lifetime_budget) / 100; });
  return camps.map((c) => {
    const cbo = n(c.daily_budget) > 0 || n(c.lifetime_budget) > 0, s = bySet[c.id] || { daily: 0, lifetime: 0 };
    return { account: id, campaign: c.name || c.id, daily: cbo ? n(c.daily_budget) / 100 : s.daily, lifetime: cbo ? n(c.lifetime_budget) / 100 : s.lifetime, level: cbo ? "campaign" : "ad set" };
  }).filter((c) => c.daily > 0 || c.lifetime > 0);
}

/* account-level daily totals straight from Meta (what Ads Manager shows at account level), for reconciliation */
async function accountDaily(accountId, from, to) {
  const id = String(accountId).indexOf("act_") === 0 ? accountId : "act_" + accountId;
  const q = new URLSearchParams({ level: "account", time_increment: "1", limit: "500", fields: "account_name,spend,impressions,date_start",
    time_range: JSON.stringify({ since: from, until: to }) });
  const rows = await all(GRAPH + "/" + id + "/insights?" + q.toString(), 10);
  let name = rows[0] && rows[0].account_name;
  if (!name) { try { name = (await graph(GRAPH + "/" + id + "?fields=name")).name; } catch (e) { name = id; } }
  return { id, name, days: rows.map((r) => ({ date: String(r.date_start).slice(0, 10), spend: Math.round(n(r.spend) * 100) / 100, impressions: Math.round(n(r.impressions)) })) };
}
/* every ad account the token can see, with its spend for a date range (one call): finds accounts that spend but aren't synced */
async function accountsSpend(from, to) {
  const fields = "id,name,account_status,insights.time_range(" + JSON.stringify({ since: from, until: to }) + "){spend}";
  const list = await all(GRAPH + "/me/adaccounts?fields=" + encodeURIComponent(fields) + "&limit=100", 10);
  return list.map((a) => ({ id: a.id, name: a.name || a.id, active: a.account_status === 1, status: a.account_status,
    spend: n(a.insights && a.insights.data && a.insights.data[0] && a.insights.data[0].spend) }))
    .sort((x, y) => (y.spend - x.spend) || (y.active - x.active));
}
module.exports = { VER, COLS, graph, all, result, accountRows, adAccounts, accountsSpend, accountFunds, accountBudgets, accountDaily, n };
