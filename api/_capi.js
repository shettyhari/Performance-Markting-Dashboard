// Meta Conversions API for CRM: when a CRM lead becomes qualified or a sale, tell Meta, so delivery optimises for good leads.
// Settings › Attribution & sync › Conversions API (S.capi): enabled, since (only leads created on or after this day), datasets per brand,
// event names, which stages to send, test event code. Token: the workspace's Conversions API token (Settings › Data connections), else its Meta token.
// Each lead + stage is sent once (table capi_events); failures are retried up to 3 times; nothing is guessed: a lead with no match key is skipped with the reason.
const U = require("./_suite");
const VER = process.env.META_API_VERSION || "v23.0";
const MAX_PER_RUN = 1500;

const D = require("./_db");
const token = async () => (await D.orgSecret("meta_capi_token")) || (await D.orgSecret("meta_access_token"));
function cfgOf(S) {
  const c = S.capi || {};
  return { enabled: !!c.enabled, since: U.DAY_RE.test(c.since || "") ? c.since : "", windowDays: Math.min(90, Math.max(1, +c.windowDays || 28)),
    datasets: c.datasets || {}, dataset: String(c.dataset || "").trim(), sendQl: c.sendQl !== false, sendWon: c.sendWon !== false,
    qlEvent: String(c.qlEvent || "Qualified Lead").trim(), wonEvent: String(c.wonEvent || "Converted").trim(), testCode: String(c.testCode || "").trim() };
}
const datasetFor = (C, brand) => String((C.datasets || {})[brand] || C.dataset || "").replace(/\D+/g, "");

async function post(dataset, events, testCode) {
  const body = { data: events }; if (testCode) body.test_event_code = testCode;
  const r = await fetch("https://graph.facebook.com/" + VER + "/" + dataset + "/events?access_token=" + encodeURIComponent(await token()), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b || b.error) throw new Error("Meta answered " + r.status + ": " + ((b && b.error && (b.error.error_user_msg || b.error.message)) || "no details") + (b && b.error && b.error.fbtrace_id ? " (trace " + b.error.fbtrace_id + ")" : ""));
  return b;
}

async function run(S, opt) {
  opt = opt || {};
  const C = cfgOf(S);
  if (!C.enabled && !opt.force) return { skipped: "Conversions API is off (Settings › Attribution & sync)." };
  if (!(await token())) return { skipped: "No Conversions API or Meta token yet (Settings › Data connections)." };
  if (!C.since) return { skipped: "Pick “Send leads created from” in Settings › Attribution & sync first." };
  const W = U.wonSet(S), from = [C.since, U.addDays(U.istDay(0), -C.windowDays)].sort()[1];
  const leads = await U.sbAll("crm_leads?select=lead_id,created_on,campaign,status,brand,is_ql,phone,email,fb_lead_id&created_on=gte." + from + "&prev_lead=is.null&order=created_on", 30000);
  const want = [];
  leads.forEach((L) => {
    if (C.sendQl && L.is_ql) want.push([L, "ql"]);
    if (C.sendWon && U.isWon(L.status, W)) { if (C.sendQl && !L.is_ql) want.push([L, "ql"]); want.push([L, "won"]); }
  });
  if (!want.length) return { from, candidates: 0, sent: 0 };
  // what was sent already
  const ids = Array.from(new Set(want.map((w) => w[0].lead_id)));
  const done = {};
  await U.inChunks(ids, 100, async (c) => { const rows = await U.sbFetch("capi_events?select=lead_id,stage,status,attempts&lead_id=in." + U.inList(c)); (rows || []).forEach((r) => { done[r.lead_id + "|" + r.stage] = r; }); return []; });
  const todo = want.filter((w) => { const d = done[w[0].lead_id + "|" + w[1]]; return !d || (d.status === "failed" && d.attempts < 3); }).slice(0, MAX_PER_RUN);
  if (!todo.length) return { from, candidates: want.length, sent: 0, note: "Everything was sent already." };
  // fbc from the website journey (visitor who clicked a Meta ad and later submitted this phone / email)
  const J = await U.journeys(S, Array.from(new Map(todo.map((w) => [w[0].lead_id, w[0]])).values()));
  const now = Math.floor(Date.now() / 1000), byDs = {}, log = [];
  todo.forEach(([L, stage]) => {
    const brand = L.brand || "", ds = datasetFor(C, brand), prev = done[L.lead_id + "|" + stage];
    const rec = { lead_id: L.lead_id, stage, brand, campaign: L.campaign || "", dataset_id: ds, event_name: stage === "ql" ? C.qlEvent : C.wonEvent, attempts: (prev ? prev.attempts : 0) + 1 };
    if (!ds) { log.push(Object.assign(rec, { status: "skipped", detail: "No Meta dataset set for brand “" + (brand || "none") + "”." })); return; }
    const ud = {}, keys = [];
    const fl = String(L.fb_lead_id || "").replace(/^l:/i, ""); if (/^\d{6,}$/.test(fl)) { ud.lead_id = fl; keys.push("Facebook lead id"); }
    const ph = U.phHash(L.phone); if (ph) { ud.ph = [ph]; keys.push("phone"); }
    const em = U.emHash(L.email); if (em) { ud.em = [em]; keys.push("email"); }
    const fbTouch = ((J[L.lead_id] || {}).touches || []).filter((t) => t.fbclid).pop();
    if (fbTouch) { ud.fbc = "fb.1." + fbTouch.at + "." + fbTouch.fbclid; keys.push("click id (fbc)"); }
    if (!keys.length) { log.push(Object.assign(rec, { status: "skipped", detail: "No Facebook lead id, phone or email on this lead." })); return; }
    const cd = { event_source: "crm", lead_event_source: D.crm() };
    const v = stage === "won" ? U.dealValue(S, brand) : null; if (v !== null) { cd.value = v; cd.currency = D.currency(); }
    const ev = { event_name: rec.event_name, event_time: now, action_source: "system_generated", event_id: L.lead_id + "-" + stage, user_data: ud, custom_data: cd };
    (byDs[ds] = byDs[ds] || []).push({ ev, rec: Object.assign(rec, { match_keys: keys.join(", "), event_time: new Date(now * 1000).toISOString() }) });
  });
  let sent = 0, failed = 0;
  for (const ds of Object.keys(byDs)) {
    const items = byDs[ds];
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500);
      try {
        const b = await post(ds, part.map((x) => x.ev), C.testCode);
        part.forEach((x) => log.push(Object.assign(x.rec, { status: "sent", sent_at: new Date().toISOString(), fbtrace: String(b.fbtrace_id || ""), detail: C.testCode ? "Sent as a TEST event (" + C.testCode + ")" : "" })));
        sent += part.length;
      } catch (e) { part.forEach((x) => log.push(Object.assign(x.rec, { status: "failed", detail: String(e.message).slice(0, 500) }))); failed += part.length; }
    }
  }
  for (let i = 0; i < log.length; i += 500)
    await U.sbFetch("capi_events?on_conflict=lead_id,stage", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(log.slice(i, i + 500)) });
  return { from, candidates: want.length, processed: log.length, sent, failed, skipped: log.filter((x) => x.status === "skipped").length, test: !!C.testCode };
}
async function status(S, days) {
  const since = new Date(Date.now() - (days || 7) * 864e5).toISOString();
  const rows = await U.sbAll("capi_events?select=lead_id,stage,brand,campaign,event_name,status,detail,match_keys,sent_at,created_at,attempts&created_at=gte." + since + "&order=id.desc", 5000);
  const sum = {}; rows.forEach((r) => { const k = r.brand + "|" + r.stage; const o = sum[k] || (sum[k] = { brand: r.brand, stage: r.stage, sent: 0, failed: 0, skipped: 0 }); o[r.status] = (o[r.status] || 0) + 1; });
  return { config: cfgOf(S), tokenSet: !!(await token()), days: days || 7, summary: Object.values(sum), events: rows.slice(0, 500) };
}
module.exports = { run, status, cfgOf };
