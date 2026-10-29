// Attribution suite endpoint (one Vercel function for all of it, to stay within the plan's function limit).
// Members (sign-in token + x-org-id header, same rule as the database):
//   GET  ?op=perf|attribution|trend&from=&to=&brand=[&model=&by=&granularity=]   · ?op=journey&id=   · ?op=find&q=
//   GET  ?op=capi-status[&days=7] · ?op=audiences-status · ?op=tracking-status[&days=7]
//   POST ?op=capi-run · ?op=audiences-run   (admins / editors)       POST ?op=ask {question, history, context}
//   POST ?op=ai-models {provider} · ?op=ai-test   (workspace owners: Settings › AI)
// Scheduler (pg_cron Vault key or CRON_SECRET), once per workspace:  POST ?op=cron&mode=capi|audiences|digest&org=<id>
// Machine access (a workspace API key):  /api/mcp (MCP server)  ·  GET ?op=ext&from=&to= (Chrome extension)
const D = require("./_db");
const U = require("./_suite");

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const body = (req) => { let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } return b || {}; };

async function cron(req, res, mode) {
  if (!(await D.cronAllowed(req))) return D.send(res, 401, { error: "Not allowed" });
  const org = await D.orgById(req.query.org);
  if (!org) return D.send(res, 404, { error: "Unknown workspace" });
  return D.withOrg(org, async () => {
    const S = await D.orgSettings();
    if (mode === "capi") return D.send(res, 200, await require("./_capi").run(S));
    if (mode === "audiences") return D.send(res, 200, await require("./_audiences").run(S));
    if (mode === "digest") {
      if (!(S.ai || {}).digest) return D.send(res, 200, { skipped: "AI digest is off (Settings › Attribution & sync)." });
      const T = require("./_tg"), A = require("./_alertlib");
      if (!T.configured()) return D.send(res, 200, { skipped: "Telegram is not set up on this site." });
      let d; try { d = await require("./_ai").digest(S); } catch (e) { if (e.code === "AI_OFF") return D.send(res, 200, { skipped: "Ask Qlarity is off (Settings › AI)." }); throw e; }
      const sentTo = await A.deliver(D.sbFetch, "ai-digest", "🧠 <b>" + T.esc(D.orgName()) + " AI DIGEST · " + T.esc(U.istDay(-1)) + "</b>\n\n" + T.esc(d.answer) + "\n\n<i>Written by AI from the dashboard's numbers. Check the dashboard before acting on it.</i>");
      return D.send(res, 200, { sent: !!sentTo, chars: d.answer.length });
    }
    return D.send(res, 400, { error: "Unknown mode" });
  });
}
async function ext(req, res) {
  const org = await U.orgFromApiKey(req);
  if (!org) return D.send(res, 401, { error: "Wrong, revoked or missing API key." }, CORS);
  return D.withOrg(org, async () => {
    const S = await D.orgSettings(), P = await U.performance(S, { from: req.query.from, to: req.query.to });
    const by = {}; P.campaigns.forEach((c) => { by[U.lc(c.campaign)] = { brand: c.brand, campaign: c.campaign, spend: c.spend, metaLeads: c.metaLeads, crm: c.crm, ql: c.ql, won: c.won, cpl: c.cpl, cpql: c.cpql, costPerSale: c.costPerSale, qlRate: c.qlRate }; });
    return D.send(res, 200, { workspace: D.orgName(), currency: D.currency(), crm: D.crm(), from: P.from, to: P.to, salesConfigured: P.salesConfigured, campaigns: by }, Object.assign({ "cache-control": "private, max-age=300" }, CORS));
  });
}
async function trackingStatus(S, days) {
  const since = new Date(Date.now() - Math.min(90, days || 7) * 864e5).toISOString();
  let ev = [];
  try { ev = await D.sbAll("web_events?select=vid,kind,channel,host,at&at=gte." + since + "&order=id.desc", 50000); } catch (e) { return { setup: false, error: e.message }; }
  const ch = {}, hosts = {}, vids = new Set(); let forms = 0, wa = 0, last = null;
  ev.forEach((e) => { vids.add(e.vid); if (!last || e.at > last) last = e.at; hosts[e.host] = (hosts[e.host] || 0) + 1;
    if (e.kind === "touch") ch[e.channel] = (ch[e.channel] || 0) + 1; if (e.kind === "form") forms++; if (e.kind === "whatsapp") wa++; });
  let ids = 0; try { ids = await D.sbCount("web_identities?select=vid&at=gte." + since); } catch (e) {}
  return { setup: true, days: days || 7, events: ev.length, visitors: vids.size, lastEvent: last, forms, whatsappClicks: wa, identified: ids,
    channels: Object.keys(ch).map((k) => ({ channel: k, touches: ch[k], aiSearch: U.AI_NAMES.has(k) })).sort((a, b) => b.touches - a.touches),
    hosts: Object.keys(hosts).map((h) => ({ host: h, events: hosts[h] })).sort((a, b) => b.events - a.events).slice(0, 20),
    allowedDomains: ((S.tracking || {}).domains || []), publicId: D.org().public_id };
}

module.exports = async function handler(req, res) {
  const op = String((req.query && req.query.op) || "");
  try {
    if (req.method === "OPTIONS") { res.statusCode = 204; Object.keys(CORS).forEach((k) => res.setHeader(k, CORS[k])); return res.end(); }
    if (op === "cron") return await cron(req, res, String(req.query.mode || ""));
    if (op === "mcp") return await require("./_mcp").handle(req, res);
    if (op === "ext") return await ext(req, res);

    const me = await D.auth(req);
    if (me.error) return D.send(res, me.status, { error: me.error });
    return await D.withOrg(me.org, async () => {
      const canRun = me.role === "admin" || me.role === "editor";
      const S = await D.orgSettings(), q = req.query || {};
      const opt = { from: q.from, to: q.to, brand: q.brand || "", model: q.model, by: q.by, granularity: q.granularity };
      switch (op) {
        case "perf": return D.send(res, 200, await U.performance(S, opt));
        case "attribution": return D.send(res, 200, await U.attribution(S, opt));
        case "trend": return D.send(res, 200, await U.trend(S, opt));
        case "journey": { const j = await U.journey(S, String(q.id || "")); return j ? D.send(res, 200, j) : D.send(res, 404, { error: "No lead with that id." }); }
        case "find": return D.send(res, 200, { leads: await U.findLeads(q.q) });
        case "capi-status": return D.send(res, 200, await require("./_capi").status(S, Math.min(90, +q.days || 7)));
        case "audiences-status": return D.send(res, 200, await require("./_audiences").status(S));
        case "tracking-status": return D.send(res, 200, await trackingStatus(S, +q.days || 7));
        case "capi-run": if (req.method !== "POST") break; if (!canRun) return D.send(res, 403, { error: "Admins and editors only." }); return D.send(res, 200, await require("./_capi").run(S, { force: true }));
        case "audiences-run": if (req.method !== "POST") break; if (!canRun) return D.send(res, 403, { error: "Admins and editors only." }); return D.send(res, 200, await require("./_audiences").run(S, { force: true }));
        case "ask": { if (req.method !== "POST") break; const b = body(req); if (!String(b.question || "").trim()) return D.send(res, 400, { error: "Ask a question." });
          return D.send(res, 200, await require("./_ai").ask(S, b.question, b.history, b.context)); }
        case "ai-models": { if (req.method !== "POST") break; if (!me.owner) return D.send(res, 403, { error: "Only the workspace owner manages AI settings." });
          return D.send(res, 200, { models: await require("./_ai").models(String(body(req).provider || "")) }); }
        case "ai-test": { if (req.method !== "POST") break; if (!me.owner) return D.send(res, 403, { error: "Only the workspace owner manages AI settings." });
          return D.send(res, 200, await require("./_ai").test()); }
      }
      return D.send(res, 400, { error: "Unknown op or method: " + op });
    });
  } catch (e) {
    return D.send(res, 502, { error: String((e && e.message) || e) });
  }
};
