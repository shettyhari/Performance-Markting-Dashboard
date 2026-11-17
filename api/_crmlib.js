// Shared CRM library: direct lead fetching from TeleCRM, HubSpot, Zoho, LeadSquared, etc.,
// and universal lead ingestion into crm_leads and uploads.
const D = require("./_db");
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

/* any date/time the CRM may send → "YYYY-MM-DD HH:MM:SS" wall-clock in the workspace time zone */
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

/* flatten one incoming lead item into { normalisedKey: [originalKey, value] } */
function flat(item) {
  if (item && item.json && typeof item.json === "object") item = item.json;
  const out = {};
  const put = (k, v) => {
    const n = nk(k); if (!n || (n in out && !blank(out[n][1]))) return;
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) v = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(", ");
      else return;
    }
    out[n] = [String(k).trim(), v];
  };
  if (item && item.fields && typeof item.fields === "object") Object.keys(item.fields).forEach((k) => put(k, item.fields[k]));
  if (item && item.properties && typeof item.properties === "object") Object.keys(item.properties).forEach((k) => put(k, item.properties[k]));
  Object.keys(item || {}).forEach((k) => { if (k !== "fields" && k !== "properties" && k !== "actions") put(k, item[k]); });
  return out;
}

function classify(status, S) {
  const l = String(status || "").toLowerCase(); if (!l) return false;
  const ov = (S.qlOverride || {})[l]; if (ov === "QL") return true; if (ov === "Not QL") return false;
  for (const w of S.qlNeg || []) if (w && l.indexOf(String(w).toLowerCase()) >= 0) return false;
  for (const w of S.qlPos || []) if (w && l.indexOf(String(w).toLowerCase()) >= 0) return true;
  return false;
}

/* Fetch leads directly from CRM APIs (TeleCRM, HubSpot, Zoho, LeadSquared, Custom) */
async function fetchCrmLeads(S, apiKey, options = {}) {
  const prov = String(S.crmProvider || S.crm_name || "TeleCRM").toLowerCase();
  const limit = options.limit || 500;

  if (S.crmEndpointUrl) {
    const r = await fetch(S.crmEndpointUrl, {
      method: "GET",
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" }
    });
    if (!r.ok) throw new Error("Custom CRM API returned " + r.status + " " + r.statusText);
    const body = await r.json();
    return Array.isArray(body) ? body : body.leads || body.data || [];
  }

  if (prov.indexOf("telecrm") >= 0 || prov === "crm") {
    let entId = S.crmEnterpriseId || S.crmEnterprise || (S.crmConfig && S.crmConfig.enterpriseId) || "";
    if (!entId) {
      // Try to discover enterprise ID using user token
      try {
        const me = await fetch("https://api.telecrm.in/enterprise", { headers: { Authorization: "Bearer " + apiKey } });
        if (me.ok) {
          const d = await me.json();
          entId = (d && (d.id || d.enterpriseId || d.enterprise_id)) || "";
        }
      } catch (e) {}
    }
    if (!entId) {
      throw new Error("TeleCRM Enterprise ID is required (Settings › Data connections › CRM Enterprise ID; found in TeleCRM › Settings › Website & API).");
    }

    // Call TeleCRM search API
    const url = "https://next.telecrm.in/autoupdate/v2/enterprise/" + encodeURIComponent(entId) + "/lead/search";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ fields: ["*"], limit: limit, sort: { created_at: -1 } })
    });
    if (!res.ok) {
      const errTxt = await res.text();
      let errMsg = "TeleCRM API error (" + res.status + ")";
      try { const b = JSON.parse(errTxt); if (b.message || b.error) errMsg += ": " + (b.message || b.error); } catch (e) { errMsg += ": " + errTxt.slice(0, 100); }
      throw new Error(errMsg);
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && (data.data || data.leads || data.result)) || [];
    return list;
  }

  if (prov.indexOf("hubspot") >= 0) {
    const url = "https://api.hubapi.com/crm/v3/objects/contacts?limit=" + Math.min(limit, 100) +
      "&properties=firstname,lastname,email,phone,hs_lead_status,utm_campaign,utm_source,utm_medium,createdate,hubspot_owner_id";
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" }
    });
    if (!res.ok) throw new Error("HubSpot API returned " + res.status + " " + res.statusText);
    const data = await res.json();
    const results = (data && data.results) || [];
    return results.map((c) => {
      const p = c.properties || {};
      return {
        id: c.id,
        phone: p.phone,
        email: p.email,
        name: [p.firstname, p.lastname].filter(Boolean).join(" "),
        status: p.hs_lead_status,
        campaign: p.utm_campaign,
        source: p.utm_source,
        created: p.createdate,
        owner: p.hubspot_owner_id
      };
    });
  }

  if (prov.indexOf("zoho") >= 0) {
    const url = "https://www.zohoapis.com/crm/v3/Leads?fields=id,Full_Name,Email,Phone,Lead_Status,Lead_Source,Created_Time";
    const res = await fetch(url, {
      headers: { Authorization: "Zoho-oauthtoken " + apiKey, Accept: "application/json" }
    });
    if (!res.ok) throw new Error("Zoho CRM API returned " + res.status + " " + res.statusText);
    const data = await res.json();
    return (data && data.data) || [];
  }

  // Fallback: TeleCRM shaped / generic
  throw new Error("Direct sync for CRM provider '" + prov + "' requires CRM Enterprise ID or custom endpoint (Settings › Data connections).");
}

/* Ingest lead records into crm_leads table and update uploads record */
async function ingestLeads(list, S, options = {}) {
  const sourceFile = options.sourceFile || "CRM API · auto-sync";
  const cc = (S.cols && S.cols.crm) || {};
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
  if (!ids.length) return { received: list.length, saved: 0, new_leads: 0, updated: 0, without_lead_id: noId, error: "None of the leads has a lead id" };

  // what is stored already (keep values the push doesn't send)
  const have = {};
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await sbFetch("crm_leads?select=lead_id,created_on,first_call,lead_source,campaign,adset,ad,status,crm_brand,owner,manager,phone,email,lead_name,fb_lead_id,extra,upload_id,source_file&lead_id=in.(" + encodeURIComponent(ids.slice(i, i + 100).map(q).join(",")) + ")");
    (rows || []).forEach((r) => { have[r.lead_id] = r; });
  }

  // brand: Meta "Brand" per campaign first, then keyword rules
  const camps = Array.from(new Set(ids.map((id) => leads[id].campaign || (have[id] && have[id].campaign) || "").filter(Boolean)));
  const campBrand = {};
  for (let i = 0; i < camps.length; i += 40) {
    const rows = await sbFetch("meta_ad_rows?select=campaign,brand&brand=neq.&campaign=in.(" + encodeURIComponent(camps.slice(i, i + 40).map(q).join(",")) + ")&limit=5000");
    (rows || []).forEach((r) => { if (r.brand && r.brand !== "Unmapped") campBrand[r.campaign.toLowerCase()] = r.brand; });
  }
  const brandOf = (t) => campBrand[String(t || "").toLowerCase()] || kwBrand(t);

  const ownerMap = {}, ownerEmails = Array.from(new Set(ids.map((id) => leads[id].owner).filter((x) => x && x.indexOf("@") > 0).map((x) => x.toLowerCase())));
  if (ownerEmails.length) { try { (await sbFetch("rpc/owner_name_map", { method: "POST", body: JSON.stringify({ emails: ownerEmails }) }) || []).forEach((r) => { ownerMap[r.email] = r; }); } catch (e) { /* names stay as emails */ } }

  // upload record for syncs (one, refreshed every call)
  let up = await sbFetch("uploads?select=id,date_from,date_to&crm_file=eq." + encodeURIComponent(sourceFile) + "&order=id.desc&limit=1");
  let uid;
  if (up && up[0]) uid = up[0].id;
  else {
    const ins = await sbFetch("uploads", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify([{ uploaded_by: sourceFile.indexOf("API") >= 0 ? "crm-auto-sync" : "crm-push", meta_files: [], crm_file: sourceFile, meta_rows: 0, crm_rows: 0 }]) });
    uid = ins[0].id;
  }

  let created = 0, updated = 0, estCreated = 0, noCreated = 0, minDay = null, maxDay = null;
  const estimate = !!options.estimateCreated;
  const out = ids.map((id) => {
    const L = leads[id], o = have[id] || null, pickV = (nv, ov) => (nv ? nv : ov || "");
    if (o) updated++; else created++;
    let createdOn = L.created || (o && o.created_on ? String(o.created_on).replace("T", " ").slice(0, 19) : null);
    const extra = Object.assign({}, (o && o.extra) || {}, L.extra);
    if (!createdOn && estimate) { createdOn = nowIst; estCreated++; extra["Created On source"] = "Time first received (no Created On sent)"; }
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
      upload_id: o && o.upload_id ? o.upload_id : uid, source_file: o && o.source_file ? o.source_file : sourceFile, updated_at: new Date().toISOString(),
      _ph: normPhone(phone), _em: normEmail(email),
    };
  });

  // duplicate-detection keys (hashed in database)
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
  return { received: list.length, saved: out.length, new_leads: created, updated, without_lead_id: noId, created_on_estimated: estCreated, without_created_on: noCreated, duplicates_refreshed: dupes, date_from: minDay, date_to: maxDay };
}

/* Run full direct CRM sync */
async function syncCrm(S, options = {}) {
  const apiKey = await D.orgSecret("crm_api_key");
  if (!apiKey) return { skipped: "No CRM API key set for this workspace (Settings › Workspace › Tokens)." };
  const leads = await fetchCrmLeads(S, apiKey, options);
  if (!leads || !leads.length) return { done: true, received: 0, saved: 0, message: "No leads returned from CRM." };
  const res = await ingestLeads(leads, S, Object.assign({ sourceFile: "CRM API · auto-sync" }, options));
  return Object.assign({ done: true }, res);
}

/* Schedule and timing check for auto-sync */
async function isDueToSync(S, service) {
  const pfx = service === "meta" ? "meta" : service === "google" ? "google" : "crm";
  const freq = String(S[pfx + "SyncFrequency"] || "30"); // "15", "30", "60", "120", "daily"
  const syncHours = String(S[pfx + "SyncHours"] || "all"); // "all", "working"
  const syncHour = String(S[pfx + "SyncHour"] || "09:00");

  const now = Date.now() + D.tzMs();
  const d = new Date(now);
  const curHour = d.getUTCHours();
  const curMin = d.getUTCMinutes();
  const curDay = d.getUTCDay(); // 0 = Sun, 1 = Mon ... 6 = Sat

  // Check working hours if enabled
  if (syncHours === "working") {
    const isWorking = curHour >= 9 && curHour < 21 && curDay >= 1 && curDay <= 6;
    if (!isWorking) return { due: false, reason: "Outside working hours (" + curHour + ":00, day " + curDay + ")" };
  }

  // Check frequency schedule
  if (freq === "daily") {
    const targetHour = parseInt(syncHour.split(":")[0] || "9", 10);
    if (curHour !== targetHour) return { due: false, reason: "Daily sync scheduled at " + targetHour + ":00" };
  } else if (freq === "60") {
    if (curMin > 14) return { due: false, reason: "Hourly sync runs at the top of the hour" };
  } else if (freq === "120") {
    if (curHour % 2 !== 0 || curMin > 14) return { due: false, reason: "2-hour sync runs every 2 hours" };
  }

  return { due: true };
}

module.exports = {
  fetchCrmLeads,
  ingestLeads,
  syncCrm,
  isDueToSync,
  classify,
  flat,
  istStamp
};
