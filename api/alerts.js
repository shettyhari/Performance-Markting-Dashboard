// Alerts (Settings › Alerts): connect the one person in a workspace who gets Telegram alerts, send a test, send an update now, list recent alerts.
//   GET /api/alerts?op=status | link-start | link-check | unlink | test | run&what=summary|activity|daily|daily-yesterday|weekly | log | activity&days=7 | activity-sync | cpl | insights
//   Alerts & Monitoring: mon | mon-history | mon-preview | mon-trends | mon-ack&key=…&note=…&resolve=1|reopen=1
//   POST /api/alerts?op=tg-webhook   Telegram → us (one shared bot for every workspace; checked with the secret token header)
// Platform env: TELEGRAM_BOT_TOKEN (one bot), APP_URL (optional; the site address Telegram calls back). The workspace's Meta token comes from its settings.
const D = require("./_db");
const T = require("./_tg");
const A = require("./_alertlib");
const send = D.send, sbFetch = D.sbFetch;
const hookSecret = () => D.sha256("tg-webhook|" + (process.env.TELEGRAM_BOT_TOKEN || "")).slice(0, 48);
/* who sees and runs alerts in this workspace: the person chosen in Settings › Alerts › recipient; until one is chosen, any admin */
function isRecipient(S, me) {
  const r = String(((S.alerts || {}).recipient) || "").toLowerCase().trim();
  return r ? me.email === r : me.role === "admin";
}
/* Telegram calls this when someone presses START in the bot chat; the start code names the workspace and the link request */
async function webhook(req, res) {
  if (!T.configured() || !D.same(String(req.headers["x-telegram-bot-api-secret-token"] || ""), hookSecret())) return send(res, 401, { ok: false });
  let u = req.body; if (typeof u === "string") { try { u = JSON.parse(u); } catch (e) { u = {}; } }
  const m = u && u.message, text = String((m && m.text) || "").trim(), hit = /^\/start ([0-9a-f]{32})_([0-9a-f]{18})$/.exec(text);
  if (!m || !m.chat || m.chat.type !== "private" || !hit) return send(res, 200, { ok: true });
  const id = hit[1].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"), org = await D.orgById(id);
  if (!org) return send(res, 200, { ok: true });
  await D.withOrg(org, async () => {
    const L = await A.getState(sbFetch, "link");
    if (!L || L.code !== hit[2] || L.exp < Date.now()) { await T.send(m.chat.id, "That connect link has expired. Open the dashboard › Settings › Alerts and click Connect Telegram again."); return; }
    const who = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(" ") || (m.from && m.from.username) || "Telegram user";
    await A.setState(sbFetch, "telegram", { chat_id: m.chat.id, name: who, email: L.email, at: new Date().toISOString() });
    await A.setState(sbFetch, "link", null);
    await T.send(m.chat.id, "✅ <b>" + T.esc(D.orgName()) + " alerts connected</b> for " + T.esc(L.email) + ".\nYou'll get: critical account alerts straight away, performance alerts (tracked until resolved), Meta ad account changes, the performance report every 30 minutes, a morning recap and a weekly report.");
  });
  return send(res, 200, { ok: true });
}
module.exports = D.logged("alerts", async function handler(req, res) {
  try {
    const op = String((req.query && req.query.op) || "status");
    if (op === "tg-webhook") return await webhook(req, res);
    const me = await D.auth(req);
    if (me.error) return send(res, me.status, { error: me.error });
    return await D.withOrg(me.org, () => run(req, res, op, me));
  } catch (e) { return send(res, 502, { error: String((e && e.message) || e) }); }
});
async function run(req, res, op, me) {
  try {
    const S = await D.orgSettings();
    const rec = isRecipient(S, me);
    // everything about alerts is visible to the recipient's own login only
    if (!rec) return send(res, op === "status" ? 200 : 403, op === "status" ? { isRecipient: false } : { error: "Alerts are private to the alert recipient." });
    if (op === "status") {
      let link = null, bot = null; try { link = await A.chatOf(sbFetch); } catch (e) { return send(res, 200, { configured: T.configured(), setup: /alert_state|schema cache|does not exist/i.test(e.message), error: e.message, me: me.email, isRecipient: rec }); }
      if (T.configured()) { try { bot = (await T.tg("getMe")).username; } catch (e) { bot = null; } }
      return send(res, 200, { configured: T.configured(), bot, linked: link ? { name: link.name, email: link.email, at: link.at } : null, me: me.email, isRecipient: rec, role: me.role });
    }
    if (op === "log") { const r = await sbFetch("alert_log?select=at,kind,text&order=id.desc&limit=" + Math.min(50, +req.query.n || 20)); return send(res, 200, { log: r || [] }); }
    if (op === "insights") return send(res, 200, await require("./_insights").insights(S, sbFetch));   // Trends › Updates & issues
    if (op === "cpl") {   // Trends › Live CPL updates: CPL right now + the CPL alerts that were sent / recorded
      const [now, ev] = await Promise.all([A.cplNow(S, sbFetch), sbFetch("alert_log?select=at,text&kind=eq.cpl-event&order=id.desc&limit=" + Math.min(200, +req.query.n || 60))]);
      return send(res, 200, { now, events: (ev || []).map((r) => { try { return JSON.parse(r.text); } catch (e) { return null; } }).filter(Boolean) });
    }
    if (op === "activity") {   // Ad account activity page: stored changes, explained
      const days = Math.max(1, Math.min(90, +req.query.days || 7)), since = new Date(Date.now() - days * 864e5).toISOString();
      const rows = await sbFetch("meta_activity?select=*&event_time=gte." + encodeURIComponent(since) + "&order=event_time.desc&limit=2000") || [];
      const ACT = require("./_activity");
      return send(res, 200, { days, rows: rows.map((r) => Object.assign({ at: r.event_time, who: r.actor_name || r.application_name || "Meta (automatic)", account: r.account_name, brand: r.brand,
        campaign: r.campaign || "", adset: r.adset || "", ad: r.ad || "", object: r.object_name, meta: r.translated || r.event_type }, ACT.describe(r))) });
    }
    if (op === "activity-sync") { if (!(await D.orgSecret("meta_access_token"))) return send(res, 400, { error: "No Meta token yet: an admin adds it in Settings › Data connections." });
      return send(res, 200, await A.runActivity(S, sbFetch, { force: true, storeOnly: true })); }
    /* ---- Alerts & Monitoring page ---- */
    if (op === "mon") {   // open issues + recently resolved, feed status, settings defaults
      const M = require("./_monitor"), days = Math.max(1, Math.min(90, +req.query.days || 14)), since = new Date(Date.now() - days * 864e5).toISOString();
      let issues = [], setup = false;
      try { issues = await sbFetch("alert_issues?select=*&or=(status.eq.open,last_seen.gte." + encodeURIComponent(since) + ")&order=last_seen.desc&limit=2000") || []; }
      catch (e) { if (/alert_issues|schema cache|does not exist/i.test(e.message)) setup = true; else throw e; }
      const ups = await sbFetch("uploads?select=meta_files,crm_file,uploaded_at&order=uploaded_at.desc&limit=60") || [];
      const feeds = M.feeds({ uploads: ups }), chat = await A.chatOf(sbFetch).catch(() => null), outbox = (await A.getState(sbFetch, "outbox").catch(() => null)) || [], reports = (await A.getState(sbFetch, "reports").catch(() => null)) || {};
      return send(res, 200, { setup, issues, feeds, telegram: { configured: T.configured(), linked: !!chat }, outbox: outbox.length, reports, defaults: { th: M.TH, labels: M.TH_LABEL, sched: M.SCHED } });
    }
    if (op === "mon-history") {   // everything sent / recorded, newest first, with filters
      const days = Math.max(1, Math.min(180, +req.query.days || 30)), since = new Date(Date.now() - days * 864e5).toISOString(), q = String(req.query.q || "").trim(), kind = String(req.query.kind || "").replace(/[^a-z\-]/g, "");
      let path = "alert_log?select=id,at,kind,text&at=gte." + encodeURIComponent(since) + "&kind=neq.cpl-event&order=id.desc&limit=" + Math.min(1000, +req.query.n || 300);
      if (kind) path += "&kind=eq." + kind;
      if (q) path += "&text=ilike." + encodeURIComponent("*" + q.replace(/[*,()]/g, " ") + "*");
      return send(res, 200, { rows: await sbFetch(path) || [] });
    }
    if (op === "mon-ack") {   // acknowledge (stops reminders), add a note, or close an issue by hand
      const b = Object.assign({}, req.query || {}, (req.body && typeof req.body === "object") ? req.body : {}), key = String(b.key || "");
      if (!key) return send(res, 400, { error: "Missing issue." });
      const patch = { ack_by: me.email, ack_at: new Date().toISOString() };
      if (b.note !== undefined) patch.note = String(b.note).slice(0, 2000);
      if (b.resolve && b.resolve !== "0") { patch.status = "resolved"; patch.resolved_at = new Date().toISOString(); }
      if (b.reopen && b.reopen !== "0") { patch.status = "open"; patch.resolved_at = null; patch.ack_by = null; patch.ack_at = null; }
      await sbFetch("alert_issues?key=eq." + encodeURIComponent(key), { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return send(res, 200, { ok: true });
    }
    if (op === "mon-preview" || op === "mon-trends") {   // the report as it would be sent now (nothing is sent or tracked) / weekly + month view
      const M = require("./_monitor"), D = await M.loadData(S, sbFetch, { noMeta: op === "mon-trends" }), Mx = M.metrics(D), found = M.detect(D, Mx);
      if (op === "mon-trends") return send(res, 200, { weekly: M.weekly(D), errors: D.errors, today: D.today });
      const [dToday, dYday, wk] = await Promise.all([M.fullDaily(D, found, D.today), M.fullDaily(D, found, D.yday), M.fullWeekly(D, found)]);
      return send(res, 200, { text: M.reportText(D, Mx, found), dailyToday: dToday.parts, dailyYday: dYday.parts, weeklyParts: wk.parts, ids: { today: dToday.id, yday: dYday.id, weekly: wk.id },
        issues: found, recon: Mx.recon, outside: Mx.outsideNames, errors: D.errors.concat(D.live.errors || [], D.health.errors || []) });
    }
    if (!T.configured()) return send(res, 400, { error: "Telegram isn't set up on this site yet (TELEGRAM_BOT_TOKEN)." });
    if (op === "link-start") {
      const bot = (await T.tg("getMe")).username, code = D.sha256(Math.random() + "|" + Date.now()).slice(0, 18);
      const hook = D.appUrl(req) + "/api/alerts?op=tg-webhook", info = await T.tg("getWebhookInfo").catch(() => ({}));
      if (!info || info.url !== hook) await T.tg("setWebhook", { url: hook, secret_token: hookSecret(), allowed_updates: ["message"] });
      await A.setState(sbFetch, "link", { code, email: me.email, exp: Date.now() + 15 * 60000 });
      return send(res, 200, { bot, code, url: "https://t.me/" + bot + "?start=" + me.org.id.replace(/-/g, "") + "_" + code });
    }
    if (op === "link-check") {   // the webhook stores the chat; this only reports whether it has arrived
      const t = await A.chatOf(sbFetch);
      if (t && t.email === me.email) return send(res, 200, { linked: true, name: t.name });
      const L = await A.getState(sbFetch, "link");
      if (!L || L.email !== me.email || L.exp < Date.now()) return send(res, 400, { error: "The connect link expired. Click Connect Telegram again." });
      return send(res, 200, { linked: false });
    }
    if (op === "unlink") { await A.setState(sbFetch, "telegram", null); return send(res, 200, { ok: true }); }
    if (op === "test") {
      const ok = await A.deliver(sbFetch, "test", "👋 Test from the " + T.esc(D.orgName()) + " dashboard (" + T.esc(me.email) + "). Alerts are working."); return send(res, ok ? 200 : 400, ok ? { ok } : { error: "Telegram isn't connected yet." }); }
    if (op === "run") {
      const what = String(req.query.what || "summary");
      if (what === "activity") return send(res, 200, await A.runActivity(S, sbFetch, { force: true }));
      if (what === "weekly" || what === "daily" || what === "daily-yesterday") {   // full brand-wise report now, in numbered parts
        const M = require("./_monitor"), chat = await A.chatOf(sbFetch); if (!chat) return send(res, 400, { error: "Telegram isn't connected yet." });
        const Dd = await M.loadData(S, sbFetch), found = M.detect(Dd, M.metrics(Dd));
        const rep = what === "weekly" ? await M.fullWeekly(Dd, found) : await M.fullDaily(Dd, found, what === "daily" ? Dd.today : Dd.yday);
        const ok = await M.sendParts(sbFetch, chat.chat_id, what === "weekly" ? "weekly" : "daily", rep);
        return send(res, 200, { sent: [what + ":" + rep.parts.length + " parts"], id: rep.id, delivered: ok }); }
      try { return send(res, 200, await require("./_monitor").run(S, sbFetch, { force: true })); }
      catch (e) { return send(res, 200, Object.assign({ monitorError: e.message }, await A.runSummary(S, sbFetch, { force: true }))); } }
    return send(res, 400, { error: "Unknown op" });
  } catch (e) { return send(res, 502, { error: String((e && e.message) || e) }); }
}
