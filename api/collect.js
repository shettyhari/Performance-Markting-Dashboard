// Website tracking collector, called by /lp-track.js on a workspace's websites.
// POST /api/collect  body (text/plain JSON): { o: workspace public id, v: vid, k: kind, h: host, p: path, r: referrer host,
//                    u: {source, medium, campaign, content, term}, c: {fbclid, gclid, msclkid}, b: brand, m: mobile, ph, em }
// Only sites listed in that workspace's Settings › Attribution & sync › Website tracking are accepted (checked against the Origin header).
// Phone and email from forms are hashed here (sha256) and only the hashes are stored; raw values are never saved or logged.
const D = require("./_db");
const U = require("./_suite");
const VID = /^[a-z0-9]{12,40}$/i;
const KINDS = { page: 1, touch: 1, form: 1, whatsapp: 1 };
const cut = (v, n) => U.clean(v).slice(0, n || 200);
const cache = {};   // public id → { t, org, S } for 5 minutes, so every page view doesn't read the workspace twice

function hostOf(origin) { try { return new URL(origin).hostname.toLowerCase(); } catch (e) { return ""; } }
function allowed(S, host) {
  const list = ((S.tracking || {}).domains || []).map((d) => U.lc(d).replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
  return !!host && list.some((d) => host === d || host.endsWith("." + d));
}
async function workspace(pid) {
  const c = cache[pid]; if (c && Date.now() - c.t < 5 * 60000) return c;
  const org = await D.orgByPublicId(pid); if (!org) return null;
  const S = await D.withOrg(org, () => D.orgSettings());
  return (cache[pid] = { t: Date.now(), org, S });
}

module.exports = D.logged("collect", async function handler(req, res) {
  const origin = String(req.headers.origin || "");
  const cors = { "access-control-allow-origin": origin || "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" };
  if (req.method === "OPTIONS") { res.statusCode = 204; Object.keys(cors).forEach((k) => res.setHeader(k, cors[k])); return res.end(); }
  try {
    if (req.method !== "POST") return D.send(res, 405, { error: "Use POST" }, cors);
    let b = req.body; if (typeof b === "string") { if (b.length > 8000) return D.send(res, 413, { error: "Too large" }, cors); try { b = JSON.parse(b); } catch (e) { return D.send(res, 400, { error: "Bad JSON" }, cors); } }
    if (!b || !VID.test(String(b.v || "")) || !KINDS[b.k]) return D.send(res, 400, { error: "Bad event" }, cors);
    const W = await workspace(String(b.o || ""));
    if (!W) return D.send(res, 404, { error: "Unknown workspace" }, cors);
    const S = W.S;
    if (!(S.tracking || {}).enabled) return D.send(res, 200, { ok: false, off: true }, cors);
    const host = hostOf(origin);
    if (!allowed(S, host)) return D.send(res, 403, { error: "Site not allowed" }, cors);
    return await D.withOrg(W.org, async () => {
      const u = b.u || {}, c = b.c || {};
      const t = { source: cut(u.source, 100), medium: cut(u.medium, 100), campaign: cut(u.campaign), content: cut(u.content), term: cut(u.term),
        referrer: cut(b.r, 120).toLowerCase(), fbclid: cut(c.fbclid, 300), gclid: cut(c.gclid, 300), msclkid: cut(c.msclkid, 300) };
      t.referrer = t.referrer === host ? "" : t.referrer;
      const custom = ((S.tracking || {}).customChannels || []).map(U.lc);
      const row = Object.assign({ vid: String(b.v), kind: b.k, host, path: cut(b.p, 300), brand: cut(b.b, 80), mobile: typeof b.m === "boolean" ? b.m : null,
        channel: b.k === "touch" ? U.channelOf(Object.assign({ customChannels: custom }, t)) : "" }, t);
      await D.sbFetch("web_events", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify([row]) });
      if (b.k === "form") {
        await D.orgSettings();   // phone country code for hashing
        const ids = [];
        const ph = U.phHash(b.ph); if (ph) ids.push({ vid: row.vid, key_type: "ph", key_hash: ph });
        const em = U.emHash(b.em); if (em) ids.push({ vid: row.vid, key_type: "em", key_hash: em });
        if (ids.length) await D.sbFetch("web_identities", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(ids) });
      }
      return D.send(res, 200, { ok: true }, cors);
    });
  } catch (e) {
    return D.send(res, 502, { error: "Not saved" }, cors);
  }
});
