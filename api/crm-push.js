// CRM leads pushed in by n8n, a webhook or any tool → the workspace database, the same rows a CRM export upload saves.
//   POST /api/crm-push   header x-push-key: <the workspace's CRM push key, Settings › Data connections>   body: [ {lead}, … ]  or  { "leads": [ … ] }
// The key decides the workspace. A lead can be flat ("Lead id", "Created On", "Status", "Facebook Campaign Name", "Phone", …, any other columns)
// or TeleCRM API shaped ({ id, fields: { … }, status }). Column names are matched loosely (case, spaces, _ ignored).
// Leads are upserted by lead id: values sent replace stored ones; values not sent (or blank) keep what is stored,
// so a later CRM export upload can still fill in Created On / First Attempted Call if the push lacks them.
// A lead with no Created On stays undated (not shown in date views) unless the call adds ?estimateCreated=1,
// which uses the time it was first received — only sensible for flows that push each lead as it is created.
const D = require("./_db");
const PUSH_FILE = "CRM push";
const MAX_LEADS = 5000;
const send = D.send, sbFetch = D.sbFetch;
const blank = (v) => v === null || v === undefined || (typeof v === "string" && (v.trim() === "" || v.trim() === "-"));
const clean = (v) => (blank(v) ? "" : String(v).replace(/\s+/g, " ").trim());
const nk = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const normPhone = (v) => { const d = String(v == null ? "" : v).replace(/\D+/g, ""); return d.length >= 7 ? d.slice(-10) : ""; };
const normEmail = (v) => { const e = clean(v).toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : ""; };
const normFbLead = (v) => { const x = clean(v).replace(/^l:/i, ""); return /^[0-9]{6,}$/.test(x) ? x : ""; };
const pad = (n) => String(n).padStart(2, "0");
const fmt = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()); };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/* any date/time the CRM or n8n may send → "YYYY-MM-DD HH:MM:SS" wall-clock in the workspace time zone (how the dashboard stores times), or null */
function istStamp(v) {
  if (blank(v)) return null;
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v).trim())) {
    let n = Number(v); if (n < 1e12) n *= 1000; if (n < 9e11) return null;
    return fmt(n + D.tzMs());
  }
  const s = String(v).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /\d{4}-\d{2}-\d{2}T/.test(s)) { const t = Date.parse(s); return isFinite(t) ? fmt(t + D.tzMs()) : null; }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return fmt(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  const ampm = (h, ap) => { h = +h; if (!ap) return h; ap = ap.toLowerCase(); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; return h; };
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?/i);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return fmt(Date.UTC(y, +m[2] - 1, +m[1], ampm(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0))); }
  m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?/i);
  if (m && MON[m[2].toLowerCase()]) return fmt(Date.UTC(+m[3], MON[m[2].toLowerCase()] - 1, +m[1], ampm(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0)));
  return null;
}
const ALIAS = {
  id: ["leadid", "id", "leadsid", "telecrmleadid"],
  created: ["createdon", "createdat", "created", "leadcreatedon", "createdtime", "createddate", "leadcreatedat"],
  source: ["leadsource", "source"],
  campaign: ["facebookcampaignname", "facebookcampaign", "fbcampaignname", "campaignname", "campaign"],
  adset: ["facebookadsetname", "facebookadset", "fbadsetname", "adsetname", "adset"],
  ad: ["facebookad", "facebookadname", "fbadname", "adname", "ad"],
  status: ["status", "leadstatus", "stage"],
  brand: ["brand"],
  firstCall: ["firstattemptedcall", "firstcall", "firstcallat", "firstcalltime", "firstattemptedcallat"],
  owner: ["assigneename", "assignee", "owner", "assignedto", "employeeid"],
  manager: ["assigneemanagername", "manager", "managername"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "contactnumber"],
  email: ["email", "emailid", "emailaddress"],
  name: ["name", "fullname", "leadname", "customername"],
  fbLead: ["facebookleadid", "fbleadid", "metaleadid"],
};
/* flatten one incoming item (n8n item, flat row, or TeleCRM API lead) into { normalisedKey: [originalKey, value] } */
function flat(item) {
  if (item && item.json && typeof item.json === "object") item = item.json;
  const out = {};
  const put = (k, v) => { const n = nk(k); if (!n || n in out && !blank(out[n][1])) return; if (v !== null && typeof v === "object") { if (Array.isArray(v)) v = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(", "); else return; } out[n] = [String(k).trim(), v]; };
  if (item && item.fields && typeof item.fields === "object") Object.keys(item.fields).forEach((k) => put(k, item.fields[k]));
  Object.keys(item || {}).forEach((k) => { if (k !== "fields" && k !== "actions") put(k, item[k]); });
  return out;
}
function classify(status, S) {
  const l = String(status || "").toLowerCase(); if (!l) return false;
  const ov = (S.qlOverride || {})[l]; if (ov === "QL") return true; if (ov === "Not QL") return false;
  for (const w of S.qlNeg || []) if (w && l.indexOf(String(w).toLowerCase()) >= 0) return false;
  for (const w of S.qlPos || []) if (w && l.indexOf(String(w).toLowerCase()) >= 0) return true;
  return false;
}

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

    const S = await D.orgSettings(), cc = (S.cols && S.cols.crm) || {};
    const alias = {}; Object.keys(ALIAS).forEach((f) => { alias[f] = [nk(cc[f])].filter(Boolean).concat(ALIAS[f]); });
    const kws = (S.keywords || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]).toLowerCase(), k[1]]);
    const kwBrand = (t) => { const s = String(t || "").toLowerCase(); if (!s) return ""; for (const k of kws) if (s.indexOf(k[0]) >= 0) return k[1]; return "Unmapped"; };
    const nowIst = fmt(Date.now() + D.tzMs());

    // read each lead
    const leads = {}; let noId = 0;
    list.forEach((item) => {
      const f = flat(item), used = {};
      const pick = (field) => { for (const a of alias[field]) if (a in f && !blank(f[a][1])) { used[a] = 1; return f[a][1]; } for (const a of alias[field]) if (a in f) used[a] = 1; return null; };
      const id = clean(pick("id")); if (!id) { noId++; return; }
      const L = { id, created: istStamp(pick("created")), firstCall: istStamp(pick("firstCall")) };
      ["source", "campaign", "adset", "ad", "status", "brand", "owner", "manager", "phone", "email", "name", "fbLead"].forEach((x) => { L[x] = clean(pick(x)); });
      const extra = {}; Object.keys(f).forEach((n) => { if (!used[n] && !blank(f[n][1])) extra[f[n][0]] = typeof f[n][1] === "string" ? f[n][1].trim() : f[n][1]; });
      L.extra = extra; leads[id] = Object.assign(leads[id] || {}, L);
    });
    const ids = Object.keys(leads);
    if (!ids.length) return send(res, 400, { error: "None of the leads has a lead id", received: list.length });

    // what is stored already (keep values the push doesn't send)
    const have = {};
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await sbFetch("crm_leads?select=lead_id,created_on,first_call,lead_source,campaign,adset,ad,status,crm_brand,owner,manager,phone,email,lead_name,fb_lead_id,extra,upload_id,source_file&lead_id=in.(" + encodeURIComponent(ids.slice(i, i + 100).map(q).join(",")) + ")");
      (rows || []).forEach((r) => { have[r.lead_id] = r; });
    }
    // brand: Meta "Brand" per campaign first (as the dashboard does), then keyword rules
    const camps = Array.from(new Set(ids.map((id) => leads[id].campaign || (have[id] && have[id].campaign) || "").filter(Boolean)));
    const campBrand = {};
    for (let i = 0; i < camps.length; i += 40) {
      const rows = await sbFetch("meta_ad_rows?select=campaign,brand&brand=neq.&campaign=in.(" + encodeURIComponent(camps.slice(i, i + 40).map(q).join(",")) + ")&limit=5000");
      (rows || []).forEach((r) => { if (r.brand && r.brand !== "Unmapped") campBrand[r.campaign.toLowerCase()] = r.brand; });
    }
    const brandOf = (t) => campBrand[String(t || "").toLowerCase()] || kwBrand(t);
    // TeleCRM's API gives the assignee as an email; the export gives the name. Look the name (and usual manager) up
    // from earlier export uploads (their "Assignee emailid" column), so TAT by owner doesn't split one person in two.
    const ownerMap = {}, ownerEmails = Array.from(new Set(ids.map((id) => leads[id].owner).filter((x) => x && x.indexOf("@") > 0).map((x) => x.toLowerCase())));
    if (ownerEmails.length) { try { (await sbFetch("rpc/owner_name_map", { method: "POST", body: JSON.stringify({ emails: ownerEmails }) }) || []).forEach((r) => { ownerMap[r.email] = r; }); } catch (e) { /* names stay as emails */ } }

    // upload record for pushes (one, refreshed every call)
    let up = await sbFetch("uploads?select=id,date_from,date_to&crm_file=eq." + encodeURIComponent(PUSH_FILE) + "&order=id.desc&limit=1");
    let uid;
    if (up && up[0]) uid = up[0].id;
    else { const ins = await sbFetch("uploads", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify([{ uploaded_by: "crm-push", meta_files: [], crm_file: PUSH_FILE, meta_rows: 0, crm_rows: 0 }]) }); uid = ins[0].id; }

    let created = 0, updated = 0, estCreated = 0, noCreated = 0, minDay = null, maxDay = null;
    const estimate = String((req.query && req.query.estimateCreated) || "") === "1";
    const out = ids.map((id) => {
      const L = leads[id], o = have[id] || null, pickV = (nv, ov) => (nv ? nv : ov || "");
      if (o) updated++; else created++;
      let createdOn = L.created || (o && o.created_on ? String(o.created_on).replace("T", " ").slice(0, 19) : null);
      const extra = Object.assign({}, (o && o.extra) || {}, L.extra);
      if (!createdOn && estimate) { createdOn = nowIst; estCreated++; extra["Created On source"] = "Time first received from n8n (no Created On sent)"; }
      if (!createdOn) noCreated++;
      const firstCall = L.firstCall || (o && o.first_call ? String(o.first_call).replace("T", " ").slice(0, 19) : null);
      const campaign = pickV(L.campaign, o && o.campaign), crmBrand = pickV(L.brand, o && o.crm_brand), status = pickV(L.status, o && o.status);
      const tA = createdOn ? Date.parse(createdOn.replace(" ", "T") + "Z") : NaN, tB = firstCall ? Date.parse(firstCall.replace(" ", "T") + "Z") : NaN;
      const day = createdOn && !(o && o.upload_id && o.upload_id !== uid) ? createdOn.slice(0, 10) : null; if (day && (!minDay || day < minDay)) minDay = day; if (day && (!maxDay || day > maxDay)) maxDay = day;
      const phone = pickV(L.phone, o && o.phone), email = pickV(L.email, o && o.email);
      let owner = L.owner, manager = L.manager;
      if (owner && owner.indexOf("@") > 0) {
        const em = owner.toLowerCase(), mp = ownerMap[em] || {}, oldEm = String((o && o.extra && o.extra["Assignee emailid"]) || "").toLowerCase(), sameAs = !!o && (!oldEm || oldEm === em);
        extra["Assignee emailid"] = em;
        owner = mp.owner || (sameAs && o.owner && o.owner.indexOf("@") < 0 ? o.owner : "") || em;
        if (!manager) manager = mp.manager || (sameAs && o.manager) || "";
      }
      return {
        lead_id: id, created_on: createdOn, first_call: firstCall, lead_source: pickV(L.source, o && o.lead_source), campaign, adset: pickV(L.adset, o && o.adset), ad: pickV(L.ad, o && o.ad),
        status, crm_brand: crmBrand, owner: pickV(owner, o && o.owner), manager: pickV(manager, o && o.manager),
        brand: campaign ? brandOf(campaign) : crmBrand ? brandOf(crmBrand) : "No campaign", is_ql: classify(status, S),
        tat_min: isFinite(tA) && isFinite(tB) && tB >= tA ? Math.round((tB - tA) / 6000) / 10 : null,
        phone: phone || null, email: email || null, lead_name: pickV(L.name, o && o.lead_name) || null, fb_lead_id: normFbLead(L.fbLead) || (o && o.fb_lead_id) || "",
        extra: Object.keys(extra).length ? extra : null,
        upload_id: o && o.upload_id ? o.upload_id : uid, source_file: o && o.source_file ? o.source_file : PUSH_FILE, updated_at: new Date().toISOString(),
        _ph: normPhone(phone), _em: normEmail(email),
      };
    });
    // duplicate-detection keys (hashed in the database; same as an upload)
    const vals = [], idx = [];
    out.forEach((r, i) => { if (r._ph) { vals.push("p:" + r._ph); idx.push([i, "phone_key"]); } if (r._em) { vals.push("e:" + r._em); idx.push([i, "email_key"]); } });
    for (let s = 0; s < vals.length; s += 1000) {
      const h = await sbFetch("rpc/lead_keys", { method: "POST", body: JSON.stringify({ vals: vals.slice(s, s + 1000) }) });
      (h || []).forEach((x, k) => { const t = idx[s + k]; out[t[0]][t[1]] = x || ""; });
    }
    out.forEach((r) => { delete r._ph; delete r._em; if (r.phone_key === undefined) r.phone_key = ""; if (r.email_key === undefined) r.email_key = ""; });
    for (let i = 0; i < out.length; i += 500)
      await sbFetch("crm_leads?on_conflict=lead_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(out.slice(i, i + 500)) });
    let dupes = null; try { dupes = await sbFetch("rpc/refresh_lead_dupes", { method: "POST", body: "{}" }); } catch (e) { dupes = "skipped: " + e.message; }

    const total = await D.sbCount("crm_leads?select=lead_id&upload_id=eq." + uid);
    const prev = up && up[0] ? up[0] : {};
    await sbFetch("uploads?id=eq." + uid, { method: "PATCH", body: JSON.stringify({ uploaded_at: new Date().toISOString(), crm_rows: total,
      date_from: prev.date_from && prev.date_from < minDay ? prev.date_from : minDay, date_to: prev.date_to && prev.date_to > maxDay ? prev.date_to : maxDay }) });
    return send(res, 200, { received: list.length, saved: out.length, new_leads: created, updated, without_lead_id: noId, created_on_estimated: estCreated, without_created_on: noCreated, duplicates_refreshed: dupes });
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
}
