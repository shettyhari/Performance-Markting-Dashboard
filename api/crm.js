// CRM API (direct) for the dashboard. Every call carries the signed-in user's token and workspace (x-org-id).
//   GET  /api/crm?op=status                       (any member)
//   GET/POST /api/crm?op=sync[&from=YYYY-MM-DD]    (admin / editor: "Sync now" / initial sync)
const D = require("./_db");
const { syncCrm } = require("./_crmlib");

module.exports = D.logged("crm", async function handler(req, res) {
  try {
    const op = String((req.query && req.query.op) || "status");
    const me = await D.auth(req);
    if (me.error) return D.send(res, me.status, { error: me.error });
    return await D.withOrg(me.org, async () => {
      const key = await D.orgSecret("crm_api_key");
      const S = await D.orgSettings();
      if (op === "status") {
        return D.send(res, 200, {
          configured: !!key,
          last4: key ? String(key).slice(-4) : "",
          crm: D.crm(),
          provider: S.crmProvider || "TeleCRM",
          enterpriseId: S.crmEnterpriseId || "",
          autoSync: S.crmAutoSync !== false && !!key,
          frequency: S.crmSyncFrequency || "30",
          syncHours: S.crmSyncHours || "all",
          syncHour: S.crmSyncHour || "09:00",
          range: S.crmAutoRange || "7",
          role: me.role
        });
      }
      if (!key) return D.send(res, 400, { error: "No CRM API key set: an admin adds it in Settings › Workspace › Tokens or Settings › Data connections." });
      if (me.role !== "admin" && me.role !== "editor") return D.send(res, 403, { error: "Only admins and editors can do this." });
      if (op === "sync") {
        const out = await syncCrm(S, { from: req.query.from, to: req.query.to, force: true });
        return D.send(res, out.error ? 502 : 200, out);
      }
      return D.send(res, 400, { error: "Unknown op" });
    });
  } catch (e) {
    return D.send(res, 502, { error: String((e && e.message) || e) });
  }
});
