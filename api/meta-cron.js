// Auto-sync (every 30 minutes): pulls the chosen date range from the Meta Marketing API for the ad accounts ticked in Settings,
// and replaces the stored Meta rows for those ad accounts and days (nothing is counted twice, even after a campaign is renamed).
// POST /api/meta-cron?org=<workspace id>: called once per workspace by the database server's schedule (ec2/fanout.sh, sends x-cron-secret),
// or by any scheduler that sends x-cron-secret = CRON_SECRET. Uses the workspace's own Meta token (Settings › Data connections).
// Range (dashboard › Settings › Meta API › Auto-sync): yesterday + today, last 3 / 7 / 14 / 30 days, this month, or the dashboard's dates.
// Every run refreshes yesterday + today first; older days in the range are refreshed in 7-day pieces, as many as fit in ~50 seconds,
// continuing where the last run stopped, so a long range is fully refreshed within a few runs.
const D = require("./_db");
const { accountRows } = require("./_metalib");
const AUTO_FILE = "Meta API · auto-sync";
const send = D.send, sbFetch = D.sbFetch;
const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const istDay = (offsetDays) => D.orgDay(offsetDays);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
/* the auto-sync range from team settings, as ISO days (IST) */
function autoRange(S) {
  const t = istDay(0), k = String(S.metaAutoRange || "2");
  let from = addDays(t, -1), to = t;
  if (k === "today") from = t;
  else if (/^\d+$/.test(k) && +k > 2) from = addDays(t, -(+k - 1));
  else if (k === "mtd") from = t.slice(0, 8) + "01";
  else if (k === "shown" && DAY_RE.test(S.metaAutoFrom || "")) { from = S.metaAutoFrom; to = DAY_RE.test(S.metaAutoTo || "") && S.metaAutoTo < t ? S.metaAutoTo : t; }
  if (from > to) from = to;
  if (addDays(from, 92) < to) from = addDays(to, -92);
  return { from, to, key: k };
}
const acctId = (x) => { const s = String(x || "").trim(); return s.indexOf("act_") === 0 ? s : "act_" + s; };
const BUDGET_MS = +process.env.META_CRON_BUDGET_MS || 50000;   // stop starting new pieces in time to finish within Vercel's 60 s
const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (!(await D.cronAllowed(req))) return send(res, 401, { error: "Not allowed" });
    const org = await D.orgById(req.query && req.query.org);
    if (!org) return send(res, 404, { error: "Unknown workspace" });
    return await D.withOrg(org, async () => {
    if (!(await D.orgSecret("meta_access_token"))) return send(res, 200, { skipped: "No Meta token for this workspace." });
    const S = await D.orgSettings(), stAt = D.settingsUpdatedAt();
    if (!S.metaAutoSync) return send(res, 200, { skipped: "Auto-sync is off (dashboard › Settings › Meta API)." });
    const accounts = (Array.isArray(S.metaAccounts) ? S.metaAccounts : []).filter((a) => a && a.id && a.on !== false);
    if (!accounts.length) return send(res, 200, { skipped: "No ad accounts ticked." });
    const R = autoRange(S);
    const kws = (S.keywords || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]).toLowerCase(), k[1]]);
    const kw = (t) => { const s = String(t || "").toLowerCase(); for (const k of kws) if (s.indexOf(k[0]) >= 0) return k[1]; return "Unmapped"; };

    // pieces: yesterday + today first (every run), then older days in 7-day pieces, newest first, continuing from the last run
    const recentFrom = R.from > addDays(R.to, -1) ? R.from : addDays(R.to, -1);
    const first = accounts.map((a) => ({ a, from: recentFrom, to: R.to }));
    const older = [];
    for (let end = addDays(recentFrom, -1); end >= R.from; end = addDays(end, -7)) {
      const f = addDays(end, -6) < R.from ? R.from : addDays(end, -6);
      accounts.forEach((a) => older.push({ a, from: f, to: end }));
    }
    const planKey = R.from + "|" + R.to.slice(0, 7) + "|" + accounts.map((a) => a.id).join(",");
    let cur = S.metaAutoCursor && S.metaAutoCursor.plan === planKey ? (S.metaAutoCursor.i || 0) % Math.max(1, older.length) : 0;
    const queue = first.concat(older.slice(cur), older.slice(0, cur));

    // one upload record for auto-sync, refreshed every run
    const up = await sbFetch("uploads?select=id,date_from,date_to&meta_files=cs." + encodeURIComponent('{"' + AUTO_FILE + '"}') + "&order=id.desc&limit=1");
    let uid;
    if (up && up[0]) uid = up[0].id;
    else { const ins = await sbFetch("uploads", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify([{ uploaded_by: "meta-auto-sync", meta_files: [AUTO_FILE], meta_rows: 0, crm_rows: 0, date_from: R.from, date_to: R.to }]) }); uid = ins[0].id; }

    const errors = [], done = [], files = new Set([AUTO_FILE]);
    let rowsSaved = 0, olderDone = 0, idx = 0, noAdId = false;
    const took = { ms: 0, n: 0 };
    const save = async (job, raw) => {
      const mm = {};
      raw.forEach((r) => {
        const camp = clean(r[4]), adset = clean(r[5]), ad = clean(r[6]), day = r[0]; if (!camp) return;
        const k = [camp, adset, ad, day].join("|~|"), x = mm[k];
        const row = { source_file: "Meta API · " + (r[2] || r[1]) + " · " + acctId(r[1] || job.a.id), campaign: camp, adset, ad, day, day_end: day, spend: r[7], results: r[8], result_indicator: r[9],
          currency: r[3] || "INR", brand: job.a.brand || kw(camp), impressions: r[10], clicks: r[11], reach: r[12], ad_id: String(r[13] || "") };
        if (x) { x.spend = Math.round((x.spend + row.spend) * 100) / 100; x.results += row.results; x.impressions += row.impressions; x.clicks += row.clicks; x.reach = null; if (!x.result_indicator) x.result_indicator = row.result_indicator;
          if (row.ad_id && (", " + x.ad_id + ", ").indexOf(", " + row.ad_id + ", ") < 0) x.ad_id = x.ad_id ? x.ad_id + ", " + row.ad_id : row.ad_id; }
        else mm[k] = row;
      });
      const rows = Object.values(mm); if (!rows.length) return;
      rows.forEach((r) => files.add(r.source_file));
      // replace this ad account's days first, by account id + day (renamed campaigns, ads or accounts don't stay twice)
      await sbFetch("meta_ad_rows?source_file=like." + encodeURIComponent("Meta API*· " + acctId(job.a.id)) + "&day=gte." + job.from + "&day_end=lte." + job.to, { method: "DELETE" });
      const camps = Array.from(new Set(rows.map((r) => r.campaign)));
      for (let i = 0; i < camps.length; i += 40)
        await sbFetch("meta_ad_rows?campaign=in.(" + encodeURIComponent(camps.slice(i, i + 40).map(q).join(",")) + ")&day=gte." + job.from + "&day_end=lte." + job.to, { method: "DELETE" });
      const now = new Date().toISOString();
      for (let i = 0; i < rows.length; i += 500) {
        const put = (strip) => sbFetch("meta_ad_rows?on_conflict=campaign,adset,ad,day,day_end", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 500).map((r) => { const o = Object.assign({}, r, { upload_id: uid, updated_at: now }); if (strip) delete o.ad_id; return o; })) });
        // before creative-report.sql is run the table has no ad_id column: save without it rather than fail
        try { await put(noAdId); } catch (e) { if (!noAdId && /ad_id/i.test(e.message)) { noAdId = true; await put(true); } else throw e; }
      }
      rowsSaved += rows.length;
    };
    const worker = async () => {
      while (idx < queue.length && Date.now() - t0 + (took.n ? took.ms / took.n : 8000) * 1.3 < BUDGET_MS) {
        const job = queue[idx++], isOld = idx > first.length, ts = Date.now();
        try {
          let raw, tries = 0;
          for (;;) {
            try { raw = await accountRows(job.a.id, job.from, job.to); break; }
            catch (e) { if (tries++ < 1 && /retry|incomplete|rate|limit|429|50\d|timeout|temporar|code (1|2|4|17|32|613)\b/i.test(e.message) && Date.now() - t0 < BUDGET_MS - 8000) { await new Promise((r) => setTimeout(r, 3000)); continue; } throw e; }
          }
          await save(job, raw);
          done.push((job.a.name || job.a.id) + " " + job.from + "→" + job.to);
        } catch (e) { errors.push((job.a.name || job.a.id) + " " + job.from + "→" + job.to + ": " + e.message); }
        took.ms += Date.now() - ts; took.n++;
        if (isOld) olderDone++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const left = queue.length - idx;

    // remember where the older pieces stopped (only if nobody changed the settings meanwhile)
    if (older.length && stAt) {
      const next = { plan: planKey, i: (cur + olderDone) % older.length, at: new Date().toISOString() };
      try {
        const fresh = await sbFetch("org_settings?select=settings,updated_at");
        if (fresh && fresh[0] && fresh[0].updated_at === stAt)
          await sbFetch("org_settings?updated_at=eq." + encodeURIComponent(stAt), { method: "PATCH", body: JSON.stringify({ settings: Object.assign({}, fresh[0].settings, { metaAutoCursor: next }) }) });
      } catch (e) { /* not critical */ }
    }
    const total = (await D.sbCount("meta_ad_rows?select=id&upload_id=eq." + uid)) || rowsSaved;
    const note = "Range " + R.from + " → " + R.to + " · " + done.length + " of " + queue.length + " pieces this run" + (left ? " (rest continues next run)" : "");
    await sbFetch("uploads?id=eq." + uid, { method: "PATCH", body: JSON.stringify({ uploaded_at: new Date().toISOString(), meta_files: Array.from(files), meta_rows: total,
      date_from: R.from, date_to: R.to,
      crm_file: (errors.length ? "Last run errors: " + errors.join(" | ") : "Auto-sync: " + note).slice(0, 900) }) });
    return send(res, errors.length && !done.length ? 502 : 200, { from: R.from, to: R.to, accounts: accounts.length, pieces: queue.length, done: done.length, left, rows: rowsSaved, errors, ms: Date.now() - t0 });
    });
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
};
