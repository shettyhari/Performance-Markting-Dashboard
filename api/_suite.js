// Attribution suite: shared helpers and data functions for /api/suite (team, cron, MCP, extension) and /api/collect.
// Everything runs inside one workspace (api/_db.js withOrg): sbFetch only ever reads and writes that workspace.
// Numbers follow the dashboard's agreed definitions (CLAUDE.md): Meta leads = lead / chat Results (excluded campaigns left out),
// CRM leads by created day (workspace time zone) with repeat leads left out, QL = qualified statuses, sale = statuses ticked as "Sale" on the QL statuses page,
// ratios from summed totals, totals = listed brands only (Unmapped shown on its own), N/A (null) when a denominator is 0 or data is missing.
const crypto = require("crypto");
const D = require("./_db");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const { send, same, sbFetch, sbAll, cronAllowed } = D;
const SB_URL = D.SB_URL();
/* machine access (MCP server, Chrome extension): the workspace's API key, as a Bearer header or ?key= → that workspace, or null */
const orgFromApiKey = (req) => D.orgFromKey(D.bearer(req) || (req.query && req.query.key) || "", "api");
const loadSettings = () => D.orgSettings();

/* ---------- small helpers ---------- */
const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const lc = (v) => clean(v).toLowerCase();
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const phone10 = (v) => { const d = String(v == null ? "" : v).replace(/\D+/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const phHash = (v) => { const p = phone10(v); return p ? sha(D.phoneCC() + p) : ""; };   // E.164 digits (country code + number), as Meta expects
const emHash = (v) => { const e = lc(v); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? sha(e) : ""; };
const isNum = (x) => typeof x === "number" && isFinite(x);
const div = (a, b) => (isNum(a) && isNum(b) && b > 0 ? a / b : null);
const istDay = (off) => D.orgDay(off);
const addDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
const daysIn = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
const istToMs = (s) => { if (!s) return NaN; const x = String(s).replace(" ", "T").slice(0, 19); return Date.parse(x + "Z") - D.tzMs(); };   // workspace wall-clock → UTC ms
const isLeadInd = (ind) => { const t = String(ind || ""); return t === "" || /lead|form|messag|conversation|whatsapp/i.test(t); };
function range(from, to) {
  to = DAY_RE.test(to || "") ? to : istDay(0);
  from = DAY_RE.test(from || "") ? from : addDays(to, -29);
  if (from > to) { const x = from; from = to; to = x; }
  if (daysIn(from, to) > MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  return { from, to };
}
function brander(S) {
  const kws = (S.keywords || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]).toLowerCase(), k[1]]);
  return (t) => { const s = String(t || "").toLowerCase(); if (!s) return "Unmapped"; for (const k of kws) if (s.indexOf(k[0]) >= 0) return k[1]; return "Unmapped"; };
}
const wonSet = (S) => new Set((S.wonStatuses || []).map(lc).filter(Boolean));
const isWon = (status, W) => W.size > 0 && W.has(lc(status));
const dealValue = (S, brand) => { const v = Number(((S.dealValue || {})[brand])); return isFinite(v) && v > 0 ? v : null; };

/* ---------- traffic channels (website tracking) ---------- */
const AI_ENGINES = [["ChatGPT", /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|^openai$|^chatgpt/],
  ["Perplexity", /(^|\.)perplexity\.ai$|^perplexity/], ["Gemini", /(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$|^gemini/],
  ["Claude", /(^|\.)claude\.ai$|^claude/], ["Copilot", /(^|\.)copilot\.microsoft\.com$|^copilot/], ["Grok", /(^|\.)grok\.com$|^grok/],
  ["DeepSeek", /(^|\.)deepseek\.com$|^deepseek/]];
const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|yahoo\.com|duckduckgo\.com|yandex\.[a-z.]+|ecosia\.org)$/;
const SOCIAL = [["Facebook", /(^|\.)(facebook\.com|fb\.com|m\.facebook\.com|l\.facebook\.com)$|^(facebook|fb)$/], ["Instagram", /(^|\.)instagram\.com$|^(instagram|ig)$/],
  ["LinkedIn", /(^|\.)(linkedin\.com|lnkd\.in)$|^linkedin/], ["YouTube", /(^|\.)(youtube\.com|youtu\.be)$|^youtube/], ["X", /(^|\.)(twitter\.com|x\.com|t\.co)$|^(twitter|x)$/],
  ["WhatsApp", /(^|\.)(whatsapp\.com|wa\.me)$|^whatsapp/]];
const AI_NAMES = new Set(AI_ENGINES.map((x) => x[0]));
/* one touch → channel name, as LeadJourney does: click ids first, then UTMs, then the referrer */
function channelOf(t) {
  const src = lc(t.source), med = lc(t.medium), ref = lc(t.referrer);
  const paid = /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|cpm|display|ads?)$/.test(med);
  if (t.fbclid && (paid || !src || /facebook|instagram|fb|ig|meta/.test(src))) return "Meta Ads";
  if (t.gclid) return "Google Ads";
  if (t.msclkid) return "Microsoft Ads";
  for (const a of AI_ENGINES) if (a[1].test(src) || a[1].test(ref)) return a[0];
  if (paid && /facebook|instagram|fb|ig|meta/.test(src)) return "Meta Ads";
  if (paid && /google/.test(src)) return "Google Ads";
  if (paid) return "Paid · " + (src || "other");
  if (/e-?mail|newsletter/.test(med) || /newsletter|mailchimp|klaviyo/.test(src)) return "Email";
  if (/whatsapp/.test(src) || /whatsapp/.test(med)) return "WhatsApp";
  if (src && (t.custom || (Array.isArray(t.customChannels) && t.customChannels.indexOf(src) >= 0))) return src;
  for (const s of SOCIAL) if (s[1].test(src) || s[1].test(ref)) return "Organic social";
  if (SEARCH.test(ref) || /^(google|bing|yahoo|duckduckgo)$/.test(src) || med === "organic") return "Organic search";
  if (src) return "Referral · " + src;
  if (ref) return "Referral";
  return "Direct";
}
/* a CRM lead with no web touch: where the CRM says it came from */
function channelOfLead(L) {
  if (clean(L.campaign)) return "Meta Ads";
  const s = lc(L.lead_source);
  if (!s) return "Unknown";
  if (/whatsapp/.test(s)) return "WhatsApp (no campaign)";
  if (/google/.test(s)) return "Google Ads";
  if (/facebook|instagram|meta/.test(s)) return "Meta Ads";
  if (/web|site|landing|form/.test(s)) return "Website (source unknown)";
  if (/call|phone|ivr/.test(s)) return "Phone call";
  if (/referr|walk/.test(s)) return "Referral / walk-in";
  return "CRM · " + clean(L.lead_source);
}

/* ---------- data loaders ---------- */
async function metaRows(from, to) {
  return sbAll("meta_ad_rows?select=brand,campaign,adset,ad,day,spend,results,result_indicator,impressions,clicks&day=gte." + from + "&day_end=lte." + to + "&order=id");
}
async function googleRows(from, to) {
  try { return await sbAll("google_ad_rows?select=brand,campaign,day,spend,conversions,impressions,clicks&day=gte." + from + "&day=lte." + to + "&order=id"); } catch (e) { return []; }
}
async function crmLeads(from, to, extra) {
  const cols = "lead_id,created_on,lead_source,campaign,adset,ad,status,brand,is_ql,owner,manager,prev_lead" + (extra ? "," + extra : "");
  return sbAll("crm_leads?select=" + cols + "&created_on=gte." + from + "&created_on=lt." + addDays(to, 1) + "&prev_lead=is.null&order=created_on");
}

/* brand and campaign numbers with the dashboard's definitions */
function newAcc(k) { return { key: k, spend: 0, metaLeads: 0, imp: 0, clicks: 0, crm: 0, ql: 0, won: 0 }; }
function finish(o, S, wonOn) {
  o.cpl = div(o.spend, o.metaLeads); o.cpql = div(o.spend, o.ql); o.qlRate = div(o.ql, o.crm);
  o.ctr = div(o.clicks, o.imp); o.cpc = div(o.spend, o.clicks); o.cpm = isNum(div(o.spend, o.imp)) ? div(o.spend, o.imp) * 1000 : null;
  if (!wonOn) { o.won = null; o.saleRate = null; o.costPerSale = null; o.estRevenue = null; o.estRoas = null; return o; }
  o.saleRate = div(o.won, o.crm); o.costPerSale = div(o.spend, o.won);
  o.estRoas = isNum(o.estRevenue) ? div(o.estRevenue, o.spend) : null;
  return o;
}
function round(o) { const r = {}; Object.keys(o).forEach((k) => { const v = o[k]; r[k] = isNum(v) ? Math.round(v * 100) / 100 : v; }); return r; }

async function performance(S, opt) {
  const R = range(opt.from, opt.to), brandOf = brander(S), W = wonSet(S), wonOn = W.size > 0;
  const excl = new Set((S.excludedCampaigns || []).map(lc));
  const [meta, leads] = await Promise.all([metaRows(R.from, R.to), crmLeads(R.from, R.to)]);
  const listed = (S.brands || []).slice(), isListed = (b) => listed.indexOf(b) >= 0;
  const campBrand = {};
  const by = {}, camps = {};
  const get = (m, k) => m[k] || (m[k] = newAcc(k));
  meta.forEach((r) => {
    const b = r.brand || brandOf(r.campaign); campBrand[lc(r.campaign)] = b;
    if (opt.brand && opt.brand !== b) return;
    const lead = isLeadInd(r.result_indicator) && !excl.has(lc(r.campaign)) ? Number(r.results) || 0 : 0;
    [get(by, b), get(camps, b + "|" + r.campaign)].forEach((o) => { o.spend += Number(r.spend) || 0; o.metaLeads += lead; o.imp += Number(r.impressions) || 0; o.clicks += Number(r.clicks) || 0; });
    camps[b + "|" + r.campaign].brand = b; camps[b + "|" + r.campaign].campaign = r.campaign;
  });
  leads.forEach((L) => {
    const b = L.campaign ? (campBrand[lc(L.campaign)] || L.brand || brandOf(L.campaign)) : (L.brand || "No campaign");
    if (opt.brand && opt.brand !== b) return;
    const w = isWon(L.status, W), targets = [get(by, b)];
    if (L.campaign) { const c = get(camps, b + "|" + L.campaign); c.brand = b; c.campaign = L.campaign; targets.push(c); }
    targets.forEach((o) => { o.crm++; if (L.is_ql) o.ql++; if (w) { o.won++; const v = dealValue(S, b); if (v === null) o.revMissing = true; else o.rev = (o.rev || 0) + v; } });
  });
  const valueOn = Object.keys(S.dealValue || {}).some((b) => dealValue(S, b) !== null);
  const fin = (o) => { o.estRevenue = valueOn && wonOn ? (o.won === 0 ? 0 : o.revMissing ? null : o.rev || 0) : null; delete o.rev; delete o.revMissing; return round(finish(o, S, wonOn)); };
  const brands = listed.map((b) => fin(Object.assign(by[b] || newAcc(b), { brand: b })));
  const total = newAcc("TOTAL"); let revOk = true, rev = 0;
  brands.forEach((o) => { ["spend", "metaLeads", "imp", "clicks", "crm", "ql"].forEach((k) => { total[k] += o[k] || 0; }); if (wonOn) total.won += o.won || 0;
    if (isNum(o.estRevenue)) rev += o.estRevenue; else if (o.won) revOk = false; });
  total.estRevenue = valueOn && wonOn && revOk ? rev : null;
  const totalRow = round(finish(Object.assign(total, { brand: "TOTAL (listed brands)" }), S, wonOn));
  const outside = Object.keys(by).filter((b) => !isListed(b)).map((b) => fin(Object.assign(by[b], { brand: b })));
  const campaigns = Object.values(camps).map(fin).filter((c) => !opt.brand || c.brand === opt.brand);
  return { from: R.from, to: R.to, definitions: DEFINITIONS, salesConfigured: wonOn, dealValuesConfigured: valueOn, total: totalRow, brands, outsideListedBrands: outside, campaigns };
}
const DEFINITIONS = "Meta leads = Ads Manager lead/chat Results (excluded campaigns left out). CRM leads = leads in the workspace's CRM by created day (workspace time zone), repeat leads left out. QL = qualified statuses. " +
  "Sales = statuses ticked as Sale (null when none are ticked). Est. revenue = sales × the brand's average deal value from Settings (null when a value is missing). " +
  "CPL = spend ÷ Meta leads, CPQL = spend ÷ QL, cost per sale = spend ÷ sales, est. ROAS = est. revenue ÷ spend. Totals = listed brands only. null = not available.";

/* ---------- attribution ---------- */
const MODELS = { first: "First click", last: "Last click", linear: "Linear", position: "Position-based (40/20/40)", decay: "Time decay (7-day half-life)" };
function credits(touches, model, endMs) {
  const n = touches.length; if (!n) return [];
  if (n === 1) return [1];
  if (model === "first") return touches.map((_, i) => (i === 0 ? 1 : 0));
  if (model === "last") return touches.map((_, i) => (i === n - 1 ? 1 : 0));
  if (model === "linear") return touches.map(() => 1 / n);
  if (model === "position") { if (n === 2) return [0.5, 0.5]; return touches.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : 0.2 / (n - 2))); }
  const w = touches.map((t) => Math.pow(0.5, Math.max(0, (endMs - t.at) / (7 * 864e5)))), s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}
async function inChunks(list, size, fn) { const out = []; for (let i = 0; i < list.length; i += size) out.push(...(await fn(list.slice(i, i + size)))); return out; }
const inList = (arr) => encodeURIComponent("(" + arr.map((s) => '"' + String(s).replace(/"/g, '\\"') + '"').join(",") + ")");
/* touches per lead: website touches of the visitors who submitted the lead's phone / email, then the CRM's own source as the closing touch */
async function journeys(S, leads) {
  const keyOf = {}, hashes = { ph: new Set(), em: new Set() };
  leads.forEach((L) => { const p = phHash(L.phone), e = emHash(L.email); keyOf[L.lead_id] = { p, e }; if (p) hashes.ph.add(p); if (e) hashes.em.add(e); });
  let ids = [];
  try {
    for (const t of ["ph", "em"]) if (hashes[t].size)
      ids = ids.concat(await inChunks(Array.from(hashes[t]), 80, (c) => sbFetch("web_identities?select=vid,key_type,key_hash&key_type=eq." + t + "&key_hash=in." + inList(c))));
  } catch (e) { ids = []; }   // tracking tables not created yet
  const vidsByKey = {}; ids.forEach((r) => { (vidsByKey[r.key_type + r.key_hash] = vidsByKey[r.key_type + r.key_hash] || new Set()).add(r.vid); });
  const allVids = Array.from(new Set(ids.map((r) => r.vid)));
  const ev = allVids.length ? await inChunks(allVids, 80, (c) => sbFetch("web_events?select=vid,at,kind,channel,source,medium,campaign,content,term,path,host,referrer,fbclid,gclid&kind=in.(touch,form,whatsapp)&vid=in." + inList(c) + "&order=at&limit=5000")) : [];
  const evByVid = {}; ev.forEach((e) => { (evByVid[e.vid] = evByVid[e.vid] || []).push(e); });
  const out = {};
  leads.forEach((L) => {
    const k = keyOf[L.lead_id], vids = new Set();
    if (k.p) (vidsByKey["ph" + k.p] || []).forEach((v) => vids.add(v));
    if (k.e) (vidsByKey["em" + k.e] || []).forEach((v) => vids.add(v));
    const end = istToMs(L.created_on), start = end - 90 * 864e5;
    let t = [];
    vids.forEach((v) => (evByVid[v] || []).forEach((e) => { const at = Date.parse(e.at);
      if (e.kind === "touch" && at <= end + 5 * 60000 && at >= start) t.push({ at, channel: e.channel || "Direct", campaign: e.campaign || "", source: e.source, medium: e.medium, path: e.path, host: e.host, web: true, fbclid: e.fbclid, gclid: e.gclid }); }));
    t.sort((a, b) => a.at - b.at);
    if (L.campaign) t.push({ at: end, channel: "Meta Ads", campaign: L.campaign, adset: L.adset, ad: L.ad, crm: true });
    else if (!t.length) t.push({ at: end, channel: channelOfLead(L), campaign: "", crm: true });
    t = t.filter((x, i) => i === 0 || !(x.channel === t[i - 1].channel && x.campaign === t[i - 1].campaign));   // repeat visits from the same source count once
    out[L.lead_id] = { touches: t, web: vids.size > 0 };
  });
  return out;
}
async function attribution(S, opt) {
  const R = range(opt.from, opt.to), model = MODELS[opt.model] ? opt.model : "last", level = opt.by === "campaign" ? "campaign" : "channel";
  const brandOf = brander(S), W = wonSet(S), wonOn = W.size > 0;
  const [leadsAll, meta, goog] = await Promise.all([crmLeads(R.from, R.to, "phone,email"), metaRows(R.from, R.to), googleRows(R.from, R.to)]);
  const campBrand = {}; meta.forEach((r) => { campBrand[lc(r.campaign)] = r.brand || brandOf(r.campaign); });
  const listed = new Set(S.brands || []), keep = (b) => (opt.brand ? b === opt.brand : listed.has(b));   // like every total: listed brands only
  const leads = leadsAll.filter((L) => { L.b = L.campaign ? (campBrand[lc(L.campaign)] || L.brand || brandOf(L.campaign)) : (L.brand || "No campaign"); return keep(L.b); });
  const J = await journeys(S, leads);
  const rows = {}, paths = {};
  const row = (k, ch) => rows[k] || (rows[k] = { key: k, channel: ch, leads: 0, ql: 0, won: 0, rev: 0, revMissing: false, spend: null });
  let withWeb = 0;
  leads.forEach((L) => {
    const j = J[L.lead_id], t = j.touches, c = credits(t, model, istToMs(L.created_on)), w = isWon(L.status, W), v = dealValue(S, L.b);
    if (j.web) withWeb++;
    t.forEach((x, i) => { if (!c[i]) return; const k = level === "campaign" ? x.channel + " · " + (x.campaign || "(no campaign)") : x.channel, o = row(k, x.channel);
      if (level === "campaign") o.campaign = x.campaign || "";
      o.leads += c[i]; if (L.is_ql) o.ql += c[i]; if (w) { o.won += c[i]; if (v === null) o.revMissing = true; else o.rev += c[i] * v; } });
    const p = t.map((x) => x.channel).join(" → "), P = paths[p] || (paths[p] = { path: p, steps: t.length, leads: 0, ql: 0, won: 0 });
    P.leads++; if (L.is_ql) P.ql++; if (w) P.won++;
  });
  // spend: Meta from synced Ads Manager rows, Google from google_ad_rows, other channels from Settings › Attribution › channel costs
  const metaBy = {}, googBy = {}; let metaSpend = 0, googSpend = 0;
  meta.forEach((r) => { const b = r.brand || brandOf(r.campaign); if (!keep(b)) return; const s = Number(r.spend) || 0; metaSpend += s; metaBy[lc(r.campaign)] = (metaBy[lc(r.campaign)] || 0) + s; });
  goog.forEach((r) => { if (!keep(r.brand || brandOf(r.campaign))) return; const s = Number(r.spend) || 0; googSpend += s; googBy[lc(r.campaign)] = (googBy[lc(r.campaign)] || 0) + s; });
  const custom = {};
  (S.channelCosts || []).forEach((c) => { if (!c || !c.channel || !/^\d{4}-\d{2}$/.test(c.month || "") || !(Number(c.amount) > 0)) return; if (opt.brand && c.brand && c.brand !== opt.brand) return;
    const m0 = c.month + "-01", m1 = addDays(addDays(m0, 32).slice(0, 8) + "01", -1), a = R.from > m0 ? R.from : m0, b = R.to < m1 ? R.to : m1; if (a > b) return;
    custom[c.channel] = (custom[c.channel] || 0) + Number(c.amount) * daysIn(a, b) / daysIn(m0, m1); });
  const valueOn = Object.keys(S.dealValue || {}).some((b) => dealValue(S, b) !== null);
  const list = Object.values(rows).map((o) => {
    if (level === "channel") o.spend = o.channel === "Meta Ads" ? metaSpend : o.channel === "Google Ads" ? googSpend : isNum(custom[o.channel]) ? custom[o.channel] : null;
    else o.spend = o.channel === "Meta Ads" && o.campaign ? (metaBy[lc(o.campaign)] || 0) : o.channel === "Google Ads" && o.campaign ? (googBy[lc(o.campaign)] || 0) : null;
    const r = { key: o.key, channel: o.channel, campaign: o.campaign, aiSearch: AI_NAMES.has(o.channel), leads: o.leads, ql: o.ql, spend: o.spend,
      cpl: div(o.spend, o.leads), cpql: div(o.spend, o.ql), qlRate: div(o.ql, o.leads) };
    if (wonOn) { r.won = o.won; r.costPerSale = div(o.spend, o.won); r.estRevenue = valueOn ? (o.revMissing ? null : o.rev) : null; r.estRoas = div(r.estRevenue, o.spend); }
    return round(r);
  }).sort((a, b) => b.leads - a.leads);
  const pathList = Object.values(paths).sort((a, b) => b.leads - a.leads).slice(0, 25);
  return { from: R.from, to: R.to, model, modelName: MODELS[model], by: level, leads: leads.length, leadsWithWebJourney: withWeb, salesConfigured: wonOn,
    note: "Credit is split across each lead's touches; a lead with one touch gives that touch full credit. Website touches come from lp-track.js and are linked by the phone or email the visitor submitted. " +
      "Spend: Meta and Google from the synced ad accounts; other channels only where a cost is entered in Settings › Attribution & sync. Credited numbers can be fractional.",
    rows: list, paths: pathList, models: MODELS };
}
async function journey(S, leadId) {
  const rows = await sbFetch("crm_leads?select=lead_id,created_on,lead_source,campaign,adset,ad,status,brand,is_ql,owner,manager,first_call,tat_min,phone,email,fb_lead_id&lead_id=eq." + encodeURIComponent(leadId));
  const L = rows && rows[0]; if (!L) return null;
  const J = await journeys(S, [L]);
  let capi = []; try { capi = await sbFetch("capi_events?select=stage,event_name,status,detail,match_keys,sent_at,created_at&lead_id=eq." + encodeURIComponent(leadId) + "&order=id"); } catch (e) {}
  const W = wonSet(S);
  return { lead: { id: L.lead_id, created: L.created_on, source: L.lead_source, brand: L.brand, campaign: L.campaign, adset: L.adset, ad: L.ad, status: L.status, qualified: !!L.is_ql,
    sale: W.size ? isWon(L.status, W) : null, owner: L.owner, manager: L.manager, firstCall: L.first_call, tatMin: L.tat_min, hasPhone: !!L.phone, hasEmail: !!L.email, hasFacebookLeadId: !!L.fb_lead_id },
    touches: J[L.lead_id].touches.map((t) => ({ at: new Date(t.at).toISOString(), channel: t.channel, campaign: t.campaign || "", adset: t.adset || "", ad: t.ad || "", source: t.source || "", medium: t.medium || "", page: t.host ? t.host + (t.path || "") : "", from: t.crm ? "CRM" : "Website" })),
    sentToMeta: capi };
}
async function findLeads(q) {
  const s = clean(q); if (!s) return [];
  const p = phone10(s);
  const filt = p ? "phone=like." + encodeURIComponent("*" + p) : /^\d+$/.test(s) ? "lead_id=eq." + encodeURIComponent(s) : "or=" + encodeURIComponent("(lead_id.eq." + s + ",lead_name.ilike.*" + s.replace(/[*,()]/g, "") + "*)");
  return sbFetch("crm_leads?select=lead_id,created_on,lead_name,brand,campaign,status,is_ql&" + filt + "&order=created_on.desc&limit=20");
}
async function trend(S, opt) {
  const R = range(opt.from, opt.to), gran = opt.granularity === "week" ? "week" : opt.granularity === "month" ? "month" : "day";
  const keyOf = (d) => gran === "month" ? d.slice(0, 7) : gran === "week" ? addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7)) : d;
  const brandOf = brander(S), W = wonSet(S), excl = new Set((S.excludedCampaigns || []).map(lc));
  const listed = new Set(S.brands || []);
  const [meta, leads] = await Promise.all([metaRows(R.from, R.to), crmLeads(R.from, R.to)]);
  const by = {}, campBrand = {}, get = (k) => by[k] || (by[k] = newAcc(k));
  meta.forEach((r) => { const b = r.brand || brandOf(r.campaign); campBrand[lc(r.campaign)] = b; if (opt.brand ? b !== opt.brand : !listed.has(b)) return;
    const o = get(keyOf(r.day)); o.spend += Number(r.spend) || 0; if (isLeadInd(r.result_indicator) && !excl.has(lc(r.campaign))) o.metaLeads += Number(r.results) || 0; o.imp += Number(r.impressions) || 0; o.clicks += Number(r.clicks) || 0; });
  leads.forEach((L) => { const b = L.campaign ? (campBrand[lc(L.campaign)] || L.brand || brandOf(L.campaign)) : (L.brand || "No campaign"); if (opt.brand ? b !== opt.brand : !listed.has(b)) return;
    const o = get(keyOf(String(L.created_on).slice(0, 10))); o.crm++; if (L.is_ql) o.ql++; if (isWon(L.status, W)) o.won++; });
  const total = newAcc("TOTAL");
  Object.values(by).forEach((o) => ["spend", "metaLeads", "imp", "clicks", "crm", "ql", "won"].forEach((k) => { total[k] += o[k]; }));
  const rows = Object.keys(by).sort().map((k) => round(finish(Object.assign(by[k], { period: k, estRevenue: null }), S, W.size > 0)));
  return { from: R.from, to: R.to, granularity: gran, brand: opt.brand || "All listed brands", rows, total: round(finish(Object.assign(total, { estRevenue: null }), S, W.size > 0)) };
}

module.exports = { SB_URL, DAY_RE, send, same, sbFetch, sbAll, cronAllowed, orgFromApiKey, loadSettings, clean, lc, sha, phone10, phHash, emHash, isNum, div,
  istDay, addDays, istToMs, range, brander, wonSet, isWon, dealValue, channelOf, channelOfLead, AI_NAMES, MODELS, crmLeads, metaRows, performance, attribution, journey, journeys,
  findLeads, trend, DEFINITIONS, inList, inChunks, credits };
