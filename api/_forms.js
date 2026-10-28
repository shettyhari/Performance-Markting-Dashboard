// Lead forms: which Meta lead form each ad uses, and the forms' names.
//   adForms(adIds): ad id → {form, page}  — read from each ad's creative (ads_read is enough)
//   formNames(formIds): form id → {name, status, page} — from the Facebook Pages the system user can manage
//     (Page access token via /me/accounts); forms on Pages it can't see come back without a name.
const DB = require("./_db");
const { graph, VER } = require("./_metalib");
const GRAPH = "https://graph.facebook.com/" + VER;
function findKey(o, k, depth) {
  if (!o || typeof o !== "object" || (depth || 0) > 8) return null;
  if (o[k]) return o[k];
  for (const v of Object.values(o)) { const r = findKey(v, k, (depth || 0) + 1); if (r) return r; }
  return null;
}
async function withToken(url, token) {   // a call with a Page access token instead of the system user token
  const r = await fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "access_token=" + encodeURIComponent(token));
  const b = await r.json().catch(() => null);
  if (!r.ok || !b || b.error) throw new Error((b && b.error && b.error.message) || "Meta answered " + r.status);
  return b;
}
async function adForms(adIds) {
  const ids = Array.from(new Set(adIds.map((x) => String(x).trim()).filter((x) => /^\d{3,25}$/.test(x)))), out = {}, errors = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    try {
      const b = await graph(GRAPH + "/?ids=" + part.join(",") + "&fields=" + encodeURIComponent("id,name,creative{object_story_spec,asset_feed_spec}"));
      part.forEach((id) => { const a = b[id]; if (!a) return; const f = findKey(a.creative, "lead_gen_form_id"), p = findKey(a.creative, "page_id");
        out[id] = { form: f ? String(f) : "", page: p ? String(p) : "" }; });
    } catch (e) {
      // one deleted / unreadable ad fails the whole batch: retry one by one
      for (const id of part) { try { const a = await graph(GRAPH + "/" + id + "?fields=" + encodeURIComponent("id,creative{object_story_spec,asset_feed_spec}"));
        const f = findKey(a.creative, "lead_gen_form_id"), p = findKey(a.creative, "page_id"); out[id] = { form: f ? String(f) : "", page: p ? String(p) : "" }; }
        catch (e2) { out[id] = { form: "", page: "", err: e2.message.slice(0, 120) }; } }
    }
  }
  return { ads: out, errors };
}
async function formNames(formIds) {
  const want = new Set(formIds.map(String)), forms = {}, pages = [], errors = [];
  let acc = [];
  try { let next = GRAPH + "/me/accounts?fields=id,name,access_token&limit=100"; for (let n = 0; next && n < 5; n++) { const b = await graph(next); acc = acc.concat(b.data || []); next = b.paging && b.paging.next; } }
  catch (e) { errors.push("Pages: " + e.message); }
  await Promise.all(acc.map(async (p) => {
    pages.push({ id: p.id, name: p.name });
    if (!p.access_token) return;
    try { let next = GRAPH + "/" + p.id + "/leadgen_forms?fields=id,name,status,created_time&limit=100";
      for (let n = 0; next && n < 10; n++) { const b = await withToken(next, p.access_token);
        (b.data || []).forEach((f) => { forms[f.id] = { id: f.id, name: f.name || "", status: f.status || "", created: f.created_time || "", page: p.name, pageId: p.id }; });
        next = b.paging && b.paging.next ? b.paging.next.replace(/([?&])access_token=[^&]*&?/, "$1") : null; } }
    catch (e) { errors.push((p.name || p.id) + ": " + e.message.slice(0, 120)); }
  }));
  // forms used by ads but not on a Page we can see: try reading them directly
  const missing = Array.from(want).filter((id) => !forms[id]).slice(0, 60);
  await Promise.all(missing.map(async (id) => { try { const f = await graph(GRAPH + "/" + id + "?fields=id,name,status,created_time"); forms[id] = { id, name: f.name || "", status: f.status || "", created: f.created_time || "", page: "" }; } catch (e) { /* name stays unknown */ } }));
  return { forms, pages, errors };
}
module.exports = { adForms, formNames, findKey };
