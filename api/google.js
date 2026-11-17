// Google Ads API (direct) for the dashboard. Every call carries the signed-in user's token (api/auth.js) and the workspace (x-org-id).
//   GET /api/google?op=status                       (any member)
//   GET /api/google?op=accounts                     (admin / editor: every account the workspace's Google login can reach, direct or through a manager / MCC)
//   GET /api/google?op=sync[&from=YYYY-MM-DD&to=…]  (admin / editor: "Sync now" — same as the 30-minute auto-sync)
//   POST /api/google?op=cron&org=<id>               (workspace cron schedule from ec2/fanout.sh)
// Platform env: GOOGLE_ADS_CLIENT_ID / SECRET (one OAuth client). Per workspace: refresh token (+ optional manager id) in Settings › Data connections.
const D = require("./_db");
const G = require("./_gadslib");
const { syncGoogle, syncGoogleOfflineConversions } = require("./_gadsync");
const { isDueToSync } = require("./_crmlib");

module.exports = D.logged("google", async function handler(req, res) {
  try {
    const op = String((req.query && req.query.op) || "status");

    // Scheduled Cron
    if (op === "cron") {
      if (!(await D.cronAllowed(req))) return D.send(res, 401, { error: "Not allowed" });
      const org = await D.orgById(req.query && req.query.org);
      if (!org) return D.send(res, 404, { error: "Unknown workspace" });
      return await D.withOrg(org, async () => {
        if (!(await G.configured())) return D.send(res, 200, { skipped: "Google Ads isn't connected for this workspace." });
        const S = await D.orgSettings();
        if (!S.googleAutoSync) return D.send(res, 200, { skipped: "Google auto-sync is off (Settings › Data connections)." });
        const due = await isDueToSync(S, "google");
        if (!due.due) return D.send(res, 200, { skipped: due.reason });
        const out = await syncGoogle(S, D.sbFetch, { budgetMs: 50000 });
        return D.send(res, out.errors && out.errors.length && !out.done ? 502 : 200, out);
      });
    }

    const me = await D.auth(req);
    if (me.error) return D.send(res, me.status, { error: me.error });
    return await D.withOrg(me.org, async () => {
      const ok = await G.configured();
      if (op === "status") return D.send(res, 200, { configured: ok, version: G.VER, mcc: G.digits(await D.orgSecret("google_login_customer_id")) || null, role: me.role, syncReady: true });
      if (!ok) return D.send(res, 400, { error: "Google Ads isn't connected for this workspace yet: an admin adds the Google Ads refresh token in Settings › Data connections." });
      if (me.role !== "admin" && me.role !== "editor") return D.send(res, 403, { error: "Only admins and editors can do this." });
      if (op === "accounts") return D.send(res, 200, await G.listAccounts());
      if (op === "sync") return D.send(res, 200, await syncGoogle(await D.orgSettings(), D.sbFetch, { from: req.query.from, to: req.query.to, budgetMs: 50000 }));
      if (op === "offline-conversions") return D.send(res, 200, await syncGoogleOfflineConversions(await D.orgSettings(), D.sbFetch, { force: req.query.force === "1" }));
      return D.send(res, 400, { error: "Unknown op" });
    });
  } catch (e) { return D.send(res, 502, { error: String((e && e.message) || e) }); }
});
