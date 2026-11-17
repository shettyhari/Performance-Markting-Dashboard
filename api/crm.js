// CRM API for the dashboard, webhooks, and cron.
//   GET  /api/crm?op=status                       (any member)
//   GET/POST /api/crm?op=sync[&from=YYYY-MM-DD]    (admin / editor: "Sync now" / initial sync)
//   POST /api/crm?op=push  (or header x-push-key) (webhook / n8n push: [ {lead}, ... ] or { "leads": [...] })
//   POST /api/crm?op=cron&org=<id>                (workspace cron schedule from ec2/fanout.sh)
const D = require("./_db");
const { syncCrm, isDueToSync, ingestLeads } = require("./_crmlib");
const send = D.send;
const MAX_LEADS = 5000;

module.exports = D.logged("crm", async function handler(req, res) {
  try {
    const op = String((req.query && req.query.op) || "");
    const pushKey = (req.headers && (req.headers["x-push-key"] || req.headers["x-crm-key"])) || "";

    // 1. Webhook / n8n push (either via push key header or op=push)
    if (pushKey || op === "push") {
      const org = await D.orgFromKey(pushKey || D.bearer(req), "crm_push");
      if (!org) return send(res, 401, { error: "Not allowed: unknown or revoked CRM push key." });
      return await D.withOrg(org, () => ingestPush(req, res));
    }

    // 2. Scheduled Cron
    if (op === "cron") {
      if (!(await D.cronAllowed(req))) return send(res, 401, { error: "Not allowed" });
      const org = await D.orgById(req.query && req.query.org);
      if (!org) return send(res, 404, { error: "Unknown workspace" });
      return await D.withOrg(org, async () => {
        const key = await D.orgSecret("crm_api_key");
        if (!key) return send(res, 200, { skipped: "No CRM API key set for this workspace." });
        const S = await D.orgSettings();
        if (!S.crmAutoSync) return send(res, 200, { skipped: "CRM auto-sync is off (Settings › Data connections)." });
        const due = await isDueToSync(S, "crm");
        if (!due.due) return send(res, 200, { skipped: due.reason });
        const out = await syncCrm(S, { sourceFile: "CRM API · auto-sync" });
        return send(res, out.error ? 502 : 200, out);
      });
    }

    // 3. User operations (status & on-demand sync)
    const me = await D.auth(req);
    if (me.error) return send(res, me.status, { error: me.error });
    return await D.withOrg(me.org, async () => {
      const key = await D.orgSecret("crm_api_key");
      const S = await D.orgSettings();
      if (!op || op === "status") {
        return send(res, 200, {
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
      if (!key) return send(res, 400, { error: "No CRM API key set: an admin adds it in Settings › Workspace › Tokens or Settings › Data connections." });
      if (me.role !== "admin" && me.role !== "editor") return send(res, 403, { error: "Only admins and editors can do this." });
      if (op === "sync") {
        const out = await syncCrm(S, { from: req.query.from, to: req.query.to, force: true });
        return send(res, out.error ? 502 : 200, out);
      }
      return send(res, 400, { error: "Unknown op" });
    });
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
});

async function ingestPush(req, res) {
  try {
    if (req.method === "GET") return send(res, 200, { ok: true, workspace: D.orgName(), message: "Key accepted. POST leads as a JSON array." });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { return send(res, 400, { error: "Body is not JSON" }); } }
    let list = Array.isArray(body) ? body : body && Array.isArray(body.leads) ? body.leads : body && Array.isArray(body.data) ? body.data : body && typeof body === "object" ? [body] : [];
    if (!list.length) return send(res, 400, { error: "No leads in the body" });
    if (list.length > MAX_LEADS) return send(res, 413, { error: "Send at most " + MAX_LEADS + " leads per call" });

    const S = await D.orgSettings();
    const estimate = String((req.query && req.query.estimateCreated) || "") === "1";
    const out = await ingestLeads(list, S, { sourceFile: "CRM push", estimateCreated: estimate });
    if (out.error && !out.saved) return send(res, 400, out);
    return send(res, 200, out);
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
}
