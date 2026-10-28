// Alerts schedule for one workspace, called once per workspace by Supabase pg_cron (x-cron-key, checked against Vault)
// or any scheduler with x-cron-secret = CRON_SECRET.
//   POST /api/alerts-cron?org=<id>&mode=activity   every 5 minutes: Meta ad account changes (who changed what)
//   POST /api/alerts-cron?org=<id>&mode=summary    every 30 minutes: CPL events (dashboard) + monitoring (alerts with open / resolved tracking, daily / weekly reports)
const D = require("./_db");
const A = require("./_alertlib");
const M = require("./_monitor");

module.exports = async function handler(req, res) {
  try {
    if (!(await D.cronAllowed(req))) return D.send(res, 401, { error: "Not allowed" });
    const org = await D.orgById(req.query && req.query.org);
    if (!org) return D.send(res, 404, { error: "Unknown workspace" });
    return await D.withOrg(org, async () => {
      if (!(await D.orgSecret("meta_access_token"))) return D.send(res, 200, { skipped: "No Meta token for this workspace." });
      const S = await D.orgSettings(), sbFetch = D.sbFetch;
      const mode = String((req.query && req.query.mode) || "summary");
      // without Telegram, changes and CPL moves are still recorded for the dashboard
      if (mode === "activity") return D.send(res, 200, await A.runActivity(S, sbFetch));
      let mon, cpl;
      try { mon = await M.run(S, sbFetch); cpl = await A.runSummary(S, sbFetch, { recordOnly: true }); }
      catch (e) {   // monitoring failed: fall back to the simple 30-minute update + CPL alerts so nothing goes silent
        mon = { error: String((e && e.message) || e) }; try { cpl = await A.runSummary(S, sbFetch); } catch (x) { mon.fallbackError = x.message; } }
      return D.send(res, 200, { monitor: mon, cpl });
    });
  } catch (e) { return D.send(res, 502, { error: String((e && e.message) || e) }); }
};
