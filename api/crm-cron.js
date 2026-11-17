// CRM auto-sync for one workspace: POST /api/crm-cron?org=<id>
// Called once per workspace by the database server's schedule (ec2/fanout.sh) or any scheduler sending x-cron-secret.
const D = require("./_db");
const { syncCrm, isDueToSync } = require("./_crmlib");

module.exports = D.logged("crm-cron", async function handler(req, res) {
  try {
    if (!(await D.cronAllowed(req))) return D.send(res, 401, { error: "Not allowed" });
    const org = await D.orgById(req.query && req.query.org);
    if (!org) return D.send(res, 404, { error: "Unknown workspace" });
    return await D.withOrg(org, async () => {
      const key = await D.orgSecret("crm_api_key");
      if (!key) return D.send(res, 200, { skipped: "No CRM API key set for this workspace." });
      const S = await D.orgSettings();
      if (!S.crmAutoSync) return D.send(res, 200, { skipped: "CRM auto-sync is off (Settings › Data connections)." });
      const due = await isDueToSync(S, "crm");
      if (!due.due) return D.send(res, 200, { skipped: due.reason });
      const out = await syncCrm(S, { sourceFile: "CRM API · auto-sync" });
      return D.send(res, out.error ? 502 : 200, out);
    });
  } catch (e) {
    return D.send(res, 502, { error: String((e && e.message) || e) });
  }
});
