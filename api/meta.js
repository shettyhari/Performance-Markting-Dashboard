// Meta Marketing API (direct) → Meta Ads daily rows for the dashboard & cron auto-sync.
// The workspace's token (a System User token with ads_read) is saved by an admin in Settings › Data connections and kept in the database vault;
// it never reaches the browser. Optional platform env: META_API_VERSION (default v23.0).
// Every call carries the signed-in user's token (api/auth.js) and the workspace (x-org-id); only admins / editors can list accounts or pull data.
//   GET /api/meta?op=status
//   GET /api/meta?op=accounts
//   GET /api/meta?op=funds[&accounts=act_1,act_2]   (any team member; live, not stored)
//   GET /api/meta?op=reconcile&from=YYYY-MM-DD&to=YYYY-MM-DD&accounts=act_1,act_2   (any team member: Meta account totals vs stored rows, per day)
//   GET /api/meta?op=coverage&from=YYYY-MM-DD&to=YYYY-MM-DD   (any team member: every ad account the token sees, with spend in the range)
//   GET /api/meta?op=forms&ads=id1,id2 (any team member: lead form of each ad, form names from the Pages the token can manage)
//   GET /api/meta?op=budgets&accounts=act_1,act_2   (any team member; daily budgets of active campaigns, live)
//   GET /api/meta?op=data&from=YYYY-MM-DD&to=YYYY-MM-DD&accounts=act_1
//   POST /api/meta?op=cron&org=<workspace id> (scheduled cron auto-sync from ec2/fanout.sh)
const D = require("./_db");
const { VER, COLS, accountRows, adAccounts, accountsSpend, accountFunds, accountBudgets, accountDaily } = require("./_metalib");
const { isDueToSync } = require("./_crmlib");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const send = D.send, sbFetch = D.sbFetch;
const AUTO_FILE = "Meta API · auto-sync";
const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const istDay = (offsetDays) => D.orgDay(offsetDays);
const addDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
const acctId = (x) => { const s = String(x || "").trim(); return s.indexOf("act_") === 0 ? s : "act_" + s; };
const BUDGET_MS = +process.env.META_CRON_BUDGET_MS || 50000;
const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

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

module.exports = D.logged("meta", async function handler(req, res) {
  try {
    const op = String((req.query && req.query.op) || "status");

    // Scheduled Cron
    if (op === "cron") {
      return await runMetaCron(req, res);
    }

    const me = await D.auth(req);
    if (me.error) return send(res, me.status, { error: me.error });
    return await D.withOrg(me.org, async () => {
    const tok = await D.orgSecret("meta_access_token");
    if (op === "status") return send(res, 200, { configured: !!tok, last4: tok ? tok.slice(-4) : null, role: me.role, version: VER, cronReady: true });
    if (!tok) return send(res, 400, { error: "No Meta token yet: an admin adds it in Settings › Data connections." });
    if (op === "coverage") {
      const from = String(req.query.from || ""), to = String(req.query.to || "");
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return send(res, 400, { error: "Pick a valid date range." });
      return send(res, 200, { at: new Date().toISOString(), from, to, accounts: await accountsSpend(from, to) });
    }
    if (op === "reconcile") {
      const from = String(req.query.from || ""), to = String(req.query.to || "");
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return send(res, 400, { error: "Pick a valid date range." });
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > 30) return send(res, 400, { error: "Check up to 31 days at a time." });
      const acc = String(req.query.accounts || "").split(",").map((s) => s.trim()).filter((s) => /^(act_)?\d+$/.test(s)).slice(0, 40);
      const errors = [], metaAcc = [];
      await Promise.all(acc.map(async (a) => { try { metaAcc.push(await accountDaily(a, from, to)); } catch (e) { errors.push(a + ": " + e.message); } }));
      /* what the dashboard has stored for this workspace */
      const stored = {};
      (await D.sbAll("meta_ad_rows?select=source_file,day,spend,impressions&day=gte." + from + "&day_end=lte." + to + "&order=id", 50000))
        .forEach((x) => { const k = x.source_file + "|" + x.day, o = stored[k] || (stored[k] = { spend: 0, impressions: 0 }); o.spend += Number(x.spend) || 0; o.impressions += Number(x.impressions) || 0; });
      const out = metaAcc.map((a) => {
        const label = "Meta API · " + a.name + " · " + a.id, suffix = " · " + a.id, byDay = {};
        a.days.forEach((d) => { byDay[d.date] = { date: d.date, meta: d }; });
        Object.keys(stored).forEach((k) => { const i = k.lastIndexOf("|"), f = k.slice(0, i); if (f.slice(-suffix.length) !== suffix) return; const day = k.slice(i + 1); (byDay[day] = byDay[day] || { date: day, meta: { spend: 0, impressions: 0 } }).stored = stored[k]; });
        const days = Object.values(byDay).map((d) => ({ date: d.date, metaSpend: d.meta.spend, metaImp: d.meta.impressions,
          spend: d.stored ? Math.round(d.stored.spend * 100) / 100 : 0, imp: d.stored ? Math.round(d.stored.impressions) : 0 })).sort((x, y) => (x.date < y.date ? -1 : 1));
        return { id: a.id, name: a.name, label, days };
      });
      return send(res, 200, { at: new Date().toISOString(), from, to, accounts: out, errors });
    }
    if (op === "forms") {   // which lead form each ad uses (+ form names); ads = comma-separated Meta ad ids (any team member)
      const F = require("./_forms");
      const ids = String(req.query.ads || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200);
      const a = await F.adForms(ids), fids = Array.from(new Set(Object.values(a.ads).map((x) => x.form).filter(Boolean)));
      const n = req.query.names === "0" ? { forms: {}, pages: [], errors: [] } : await F.formNames(fids);
      return send(res, 200, { at: new Date().toISOString(), ads: a.ads, forms: n.forms, pages: n.pages, errors: a.errors.concat(n.errors) });
    }
    if (op === "budgets") {
      const acc = String(req.query.accounts || "").split(",").map((s) => s.trim()).filter((s) => /^(act_)?\d+$/.test(s)).slice(0, 40);
      const out = [], errors = [];
      await Promise.all(acc.map(async (a) => { try { (await accountBudgets(a)).forEach((x) => out.push(x)); } catch (e) { errors.push(a + ": " + e.message); } }));
      return send(res, 200, { at: new Date().toISOString(), campaigns: out, errors });
    }
    if (op === "funds") {
      const acc = String(req.query.accounts || "").split(",").map((s) => s.trim()).filter((s) => /^(act_)?\d+$/.test(s));
      return send(res, 200, { at: new Date().toISOString(), accounts: await accountFunds(acc) });
    }
    if (me.role !== "admin" && me.role !== "editor") return send(res, 403, { error: "Only admins and editors can pull Meta data." });
    if (op === "accounts") return send(res, 200, { accounts: await adAccounts() });
    if (op === "data") {
      const from = String(req.query.from || ""), to = String(req.query.to || "");
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return send(res, 400, { error: "Pick a valid date range." });
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > 31) return send(res, 400, { error: "Pull up to 31 days per call." });
      const acc = String(req.query.accounts || "").split(",").map((s) => s.trim()).filter((s) => /^(act_)?\d+$/.test(s));
      if (acc.length !== 1) return send(res, 400, { error: "Pull one ad account per call." });
      return send(res, 200, { cols: COLS, rows: await accountRows(acc[0], from, to) });
    }
    return send(res, 400, { error: "Unknown op" });
    });
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
});

async function runMetaCron(req, res) {
  const t0 = Date.now();
  try {
    if (!(await D.cronAllowed(req))) return send(res, 401, { error: "Not allowed" });
    const org = await D.orgById(req.query && req.query.org);
    if (!org) return send(res, 404, { error: "Unknown workspace" });
    return await D.withOrg(org, async () => {
    if (!(await D.orgSecret("meta_access_token"))) return send(res, 200, { skipped: "No Meta token for this workspace." });
    const S = await D.orgSettings(), stAt = D.settingsUpdatedAt();
    if (!S.metaAutoSync) return send(res, 200, { skipped: "Auto-sync is off (dashboard › Settings › Meta API)." });
    const due = await isDueToSync(S, "meta");
    if (!due.due) return send(res, 200, { skipped: due.reason });
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
}
