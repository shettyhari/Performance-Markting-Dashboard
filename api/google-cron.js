// Google Ads auto-sync (every 30 minutes) for one workspace: POST /api/google-cron?org=<id>, called once per workspace by pg_cron
// (ec2/fanout.sh) or any scheduler sending x-cron-secret = CRON_SECRET. On/off: Settings › Data connections › Google Ads.
const D = require("./_db");
const G = require("./_gadslib");
const { syncGoogle } = require("./_gadsync");

module.exports = D.logged("google-cron", async function handler(req, res) {
  try {
    if (!(await D.cronAllowed(req))) return D.send(res, 401, { error: "Not allowed" });
    const org = await D.orgById(req.query && req.query.org);
    if (!org) return D.send(res, 404, { error: "Unknown workspace" });
    return await D.withOrg(org, async () => {
      if (!(await G.configured())) return D.send(res, 200, { skipped: "Google Ads isn't connected for this workspace." });
      const S = await D.orgSettings();
      if (!S.googleAutoSync) return D.send(res, 200, { skipped: "Google auto-sync is off (Settings › Data connections)." });
      const out = await syncGoogle(S, D.sbFetch, { budgetMs: 50000 });
      return D.send(res, out.errors && out.errors.length && !out.done ? 502 : 200, out);
    });
  } catch (e) { return D.send(res, 502, { error: String((e && e.message) || e) }); }
});
