// CRM leads pushed in by n8n, a webhook or any tool → the workspace database, the same rows a CRM export upload saves.
//   POST /api/crm-push   header x-push-key: <the workspace's CRM push key, Settings › Data connections>   body: [ {lead}, … ]  or  { "leads": [ … ] }
const D = require("./_db");
const { ingestLeads } = require("./_crmlib");
const send = D.send;
const MAX_LEADS = 5000;

module.exports = D.logged("crm-push", async function handler(req, res) {
  try {
    const org = await D.orgFromKey(req.headers["x-push-key"] || D.bearer(req), "crm_push");
    if (!org) return send(res, 401, { error: "Not allowed: unknown or revoked CRM push key." });
    return await D.withOrg(org, () => ingest(req, res));
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
});

async function ingest(req, res) {
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
