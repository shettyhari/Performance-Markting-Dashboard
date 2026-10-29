// Audience sync: CRM segments as Meta custom audiences, per brand, refreshed daily.
//   ql  = leads that became qualified, won = sales (statuses ticked as Sale), all = every CRM lead (for exclusions)
// Only hashed phone / email are sent (sha256), never raw values. Leads already added are remembered (audience_members), so each run sends only new ones.
// Settings › Attribution & sync › Audiences (S.audiences): enabled, lists, lookbackDays. Ad account per brand = the first ticked Meta account with that brand.
// Token: the workspace's audience token (Settings › Data connections), else its Meta token; it needs ads_management and the Custom Audience terms accepted on each ad account.
const U = require("./_suite");
const VER = process.env.META_API_VERSION || "v23.0";
const LISTS = { ql: "Qualified leads", won: "Customers", all: "All CRM leads" };
const D = require("./_db");
const token = async () => (await D.orgSecret("meta_audience_token")) || (await D.orgSecret("meta_access_token"));
const act = (id) => (String(id).indexOf("act_") === 0 ? String(id) : "act_" + id);

async function graph(path, body) {
  const r = await fetch("https://graph.facebook.com/" + VER + "/" + path + (path.indexOf("?") >= 0 ? "&" : "?") + "access_token=" + encodeURIComponent(await token()), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b || b.error) throw new Error("Meta answered " + r.status + ": " + ((b && b.error && (b.error.error_user_msg || b.error.message)) || "no details"));
  return b;
}
function cfgOf(S) { const a = S.audiences || {}; return { enabled: !!a.enabled, lists: Array.isArray(a.lists) && a.lists.length ? a.lists.filter((x) => LISTS[x]) : ["ql", "won"], lookbackDays: Math.min(540, Math.max(7, +a.lookbackDays || 180)) }; }

async function run(S, opt) {
  opt = opt || {};
  const C = cfgOf(S), t0 = Date.now();
  if (!C.enabled && !opt.force) return { skipped: "Audience sync is off (Settings › Attribution & sync)." };
  if (!(await token())) return { skipped: "No audience or Meta token yet (Settings › Data connections)." };
  const accs = (S.metaAccounts || []).filter((a) => a && a.id && a.on !== false && a.brand);
  const accOf = {}; accs.forEach((a) => { if (!accOf[a.brand]) accOf[a.brand] = act(a.id); });
  const W = U.wonSet(S), from = U.addDays(U.istDay(0), -C.lookbackDays);
  const leads = await U.sbAll("crm_leads?select=lead_id,brand,status,is_ql,phone,email&created_on=gte." + from + "&prev_lead=is.null", 60000);
  const lists = await U.sbFetch("audience_lists?select=*");
  const have = {}; (lists || []).forEach((l) => { have[l.k] = l; });
  const report = [];
  for (const brand of (S.brands || [])) {
    if (Date.now() - t0 > 45000) { report.push({ brand, note: "Continues next run (time limit)." }); continue; }
    const account = accOf[brand];
    if (!account) { report.push({ brand, note: "No ticked Meta ad account has this brand (Settings › Data connections)." }); continue; }
    for (const list of C.lists) {
      const k = brand + "|" + list, members = leads.filter((L) => L.brand === brand && (list === "all" || (list === "ql" ? L.is_ql : W.size && U.isWon(L.status, W))));
      if (list === "won" && !W.size) { report.push({ brand, list, note: "No statuses are ticked as Sale yet." }); continue; }
      let A = have[k];
      try {
        if (!A) {
          const name = D.orgName() + " · " + brand + " · " + LISTS[list] + " (" + D.crm() + ")";
          const b = await graph(account + "/customaudiences", { name, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", description: "Synced daily from Qlarity (hashed phone / email)." });
          A = { k, brand, list, account_id: account, audience_id: String(b.id), name, members: 0 };
          await U.sbFetch("audience_lists", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify([A]) });
        }
        const sentIds = new Set(); await U.inChunks(members.map((m) => m.lead_id), 150, async (c) => { (await U.sbFetch("audience_members?select=lead_id&k=eq." + encodeURIComponent(k) + "&lead_id=in." + U.inList(c)) || []).forEach((r) => sentIds.add(r.lead_id)); return []; });
        const fresh = members.filter((m) => !sentIds.has(m.lead_id)).map((m) => ({ id: m.lead_id, row: [U.phHash(m.phone), U.emHash(m.email)] })).filter((x) => x.row[0] || x.row[1]);
        for (let i = 0; i < fresh.length; i += 5000) {
          const part = fresh.slice(i, i + 5000);
          await graph(A.audience_id + "/users", { payload: { schema: ["PHONE_SHA256", "EMAIL_SHA256"], data: part.map((x) => x.row) } });
          await U.sbFetch("audience_members", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(part.map((x) => ({ k, lead_id: x.id }))) });
        }
        const total = (A.members || 0) + fresh.length;
        await U.sbFetch("audience_lists?k=eq." + encodeURIComponent(k), { method: "PATCH", body: JSON.stringify({ members: total, last_sync: new Date().toISOString(), last_error: "" }) });
        report.push({ brand, list, audience: A.name, added: fresh.length, total });
      } catch (e) {
        if (A && have[k]) await U.sbFetch("audience_lists?k=eq." + encodeURIComponent(k), { method: "PATCH", body: JSON.stringify({ last_error: String(e.message).slice(0, 400), last_sync: new Date().toISOString() }) }).catch(() => {});
        report.push({ brand, list, error: String(e.message) });
      }
    }
  }
  return { lookbackFrom: from, report };
}
async function status(S) {
  let lists = []; try { lists = await U.sbFetch("audience_lists?select=*&order=brand,list"); } catch (e) { return { config: cfgOf(S), tokenSet: !!(await token()), setup: false, error: e.message }; }
  return { config: cfgOf(S), tokenSet: !!(await token()), setup: true, lists, listNames: LISTS };
}
module.exports = { run, status, LISTS };
