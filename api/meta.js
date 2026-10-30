// Meta Marketing API (direct) → Meta Ads daily rows for the dashboard.
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
const D = require("./_db");
const { VER, COLS, accountRows, adAccounts, accountsSpend, accountFunds, accountBudgets, accountDaily } = require("./_metalib");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const send = D.send;

module.exports = D.logged("meta", async function handler(req, res) {
  try {
    const op = String((req.query && req.query.op) || "status");
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
