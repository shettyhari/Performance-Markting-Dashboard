// Google Ads → google_ad_rows (database). Used by api/google-cron.js (every 30 min) and api/google.js?op=sync ("Sync now").
// For every ticked account: one query for the whole range (campaign × day), then that account's days in the range are replaced,
// so renamed campaigns never count twice and late conversions (Google adds them for days) are picked up.
const DB = require("./_db");
const { campaignDaily, digits } = require("./_gadslib");
const AUTO_FILE = "Google Ads API · auto-sync";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const istDay = (o) => new Date(Date.now() + DB.tzMs() + (o || 0) * 864e5).toISOString().slice(0, 10);
const addDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
/* range: "2m" (default) = 1st of last month → today; "30" / "90" = last N days; "mtd" = this month */
function googleRange(S, from, to) {
  if (DAY_RE.test(from || "") && DAY_RE.test(to || "")) return { from, to, key: "custom" };
  const t = istDay(0), k = String(S.googleAutoRange || "2m");
  let f;
  if (k === "mtd") f = t.slice(0, 8) + "01";
  else if (/^\d+$/.test(k)) f = addDays(t, -(+k - 1));
  else { const d = new Date(Date.parse(t.slice(0, 8) + "01T00:00:00Z")); d.setUTCMonth(d.getUTCMonth() - 1); f = d.toISOString().slice(0, 10); }
  if (addDays(f, 120) < t) f = addDays(t, -120);
  return { from: f, to: t, key: k };
}
async function syncGoogle(S, sbFetch, opt) {
  opt = opt || {};
  const t0 = Date.now(), budget = opt.budgetMs || 50000;
  const accounts = (Array.isArray(S.googleAccounts) ? S.googleAccounts : []).filter((a) => a && digits(a.id) && a.on !== false);
  if (!accounts.length) return { skipped: "No Google Ads accounts ticked (dashboard › Settings › Data connections › Google Ads)." };
  const R = googleRange(S, opt.from, opt.to);
  const kws = (S.keywords || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]).toLowerCase(), k[1]]);
  const kw = (t) => { const s = String(t || "").toLowerCase(); for (const k of kws) if (s.indexOf(k[0]) >= 0) return k[1]; return "Unmapped"; };
  const errors = [], done = []; let rowsSaved = 0, idx = 0;
  const one = async (a) => {
    const id = digits(a.id), raw = await campaignDaily(id, a.via || "", R.from, R.to), now = new Date().toISOString();
    const mm = {};
    raw.forEach((x) => { const k = x.campaignId + "|" + x.date, o = mm[k];
      if (o) { o.spend = Math.round((o.spend + x.spend) * 100) / 100; o.conversions += x.conversions; o.impressions += x.impressions; o.clicks += x.clicks; return; }
      mm[k] = { account_id: id, account_name: x.account || a.name || id, campaign_id: x.campaignId, campaign: x.campaign, campaign_type: x.type, day: x.date,
        spend: x.spend, conversions: x.conversions, impressions: x.impressions, clicks: x.clicks, currency: x.currency || "INR", brand: a.brand || kw(x.campaign), updated_at: now }; });
    const rows = Object.values(mm);
    await sbFetch("google_ad_rows?account_id=eq." + id + "&day=gte." + R.from + "&day=lte." + R.to, { method: "DELETE" });
    for (let i = 0; i < rows.length; i += 500)
      await sbFetch("google_ad_rows?on_conflict=account_id,campaign_id,day", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
    rowsSaved += rows.length; done.push((a.name || id) + ": " + rows.length + " rows");
  };
  const worker = async () => { while (idx < accounts.length && Date.now() - t0 < budget) { const a = accounts[idx++];
    try { await one(a); } catch (e) { errors.push((a.name || a.id) + ": " + e.message); } } };
  await Promise.all([worker(), worker(), worker()]);
  const left = accounts.length - idx;
  // status record (shown in Settings › Data connections)
  try {
    const up = await sbFetch("uploads?select=id&meta_files=cs." + encodeURIComponent('{"' + AUTO_FILE + '"}') + "&order=id.desc&limit=1");
    const note = (errors.length ? "Last run errors: " + errors.join(" | ") : "Google sync: " + R.from + " → " + R.to + " · " + done.length + " account(s)" + (left ? " · " + left + " left for next run" : "")).slice(0, 900);
    const rec = { uploaded_at: new Date().toISOString(), meta_files: [AUTO_FILE], meta_rows: rowsSaved, crm_rows: 0, date_from: R.from, date_to: R.to, crm_file: note };
    if (up && up[0]) await sbFetch("uploads?id=eq." + up[0].id, { method: "PATCH", body: JSON.stringify(rec) });
    else await sbFetch("uploads", { method: "POST", body: JSON.stringify([Object.assign({ uploaded_by: "google-auto-sync" }, rec)]) });
  } catch (e) { /* status only */ }
  return { from: R.from, to: R.to, accounts: accounts.length, done: done.length, left, rows: rowsSaved, errors, details: done, ms: Date.now() - t0 };
}

/* Google Ads offline conversions: upload qualified leads & sales with gclid to Google Ads */
async function syncGoogleOfflineConversions(S, sbFetch, opt) {
  opt = opt || {};
  const cfg = S.googleConversions || {};
  if (!cfg.enabled && !opt.force) return { skipped: "Google offline conversions is disabled in Settings." };
  const accounts = (Array.isArray(S.googleAccounts) ? S.googleAccounts : []).filter((a) => a && digits(a.id) && a.on !== false);
  if (!accounts.length) return { skipped: "No Google Ads account configured." };
  const targetAccount = accounts[0];
  const customerId = digits(targetAccount.id);
  const from = cfg.since && DAY_RE.test(cfg.since) ? cfg.since : addDays(istDay(0), -28);
  const actionQl = String(cfg.actionQl || "Qualified Lead").trim();
  const actionWon = String(cfg.actionWon || "Converted Sale").trim();
  const U = require("./_suite");
  const W = U.wonSet(S);

  const leads = await U.sbAll("crm_leads?select=lead_id,created_on,campaign,status,brand,is_ql,phone,email&created_on=gte." + from + "&prev_lead=is.null&order=created_on", 5000);
  const candidates = [];
  leads.forEach((L) => {
    if (cfg.sendQl !== false && L.is_ql) candidates.push([L, "ql"]);
    if (cfg.sendWon !== false && U.isWon(L.status, W)) candidates.push([L, "won"]);
  });
  if (!candidates.length) return { candidates: 0, sent: 0, from };

  const J = await U.journeys(S, Array.from(new Map(candidates.map((c) => [c[0].lead_id, c[0]])).values()));
  const conversions = [];
  candidates.forEach(([L, stage]) => {
    const touches = (J[L.lead_id] || {}).touches || [];
    const gTouch = touches.filter((t) => t.gclid).pop();
    if (gTouch && gTouch.gclid) {
      const convTime = new Date(Date.parse(String(L.created_on).replace(" ", "T") + "+05:30")).toISOString().replace("T", " ").slice(0, 19) + "+05:30";
      const actionName = stage === "ql" ? actionQl : actionWon;
      const convObj = {
        gclid: gTouch.gclid,
        conversionAction: "customers/" + customerId + "/conversionActions/" + actionName,
        conversionDateTime: convTime
      };
      if (stage === "won" && S.dealValue && S.dealValue[L.brand]) {
        convObj.conversionValue = Number(S.dealValue[L.brand]);
        convObj.currencyCode = S.currency || "INR";
      }
      conversions.push(convObj);
    }
  });

  if (!conversions.length) return { candidates: candidates.length, withGclid: 0, sent: 0, note: "No matching leads had a Google click id (gclid)." };

  let uploadRes = null;
  const { uploadClickConversions } = require("./_gadslib");
  try {
    uploadRes = await uploadClickConversions(customerId, conversions.slice(0, 1000), targetAccount.via || "");
  } catch (e) {
    return { candidates: candidates.length, withGclid: conversions.length, error: e.message };
  }
  return { candidates: candidates.length, withGclid: conversions.length, sent: conversions.length, uploadRes };
}

module.exports = { syncGoogle, syncGoogleOfflineConversions, googleRange, AUTO_FILE };
