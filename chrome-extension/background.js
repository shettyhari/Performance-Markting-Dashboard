// Fetches campaign numbers from your Qlarity workspace (/api/suite?op=ext) with the workspace API key saved in the options, and caches them for 10 minutes.
// The key stays in this browser's extension storage; it is never sent anywhere except the dashboard URL you entered.
let cache = { at: 0, key: "", data: null };
async function numbers(days) {
  const o = await chrome.storage.local.get(["url", "token", "days"]);
  if (!o.url || !o.token) return { error: "Open the extension options and enter the dashboard URL and API key." };
  const d = days || o.days || 30, key = o.url + "|" + d;
  if (cache.data && cache.key === key && Date.now() - cache.at < 10 * 60000) return cache.data;
  const to = new Date(), from = new Date(to.getTime() - (d - 1) * 864e5), iso = (x) => x.toISOString().slice(0, 10);
  const r = await fetch(o.url.replace(/\/+$/, "") + "/api/suite?op=ext&from=" + iso(from) + "&to=" + iso(to), { headers: { authorization: "Bearer " + o.token } });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b) return { error: (b && b.error) || "Dashboard answered " + r.status };
  cache = { at: Date.now(), key, data: b };
  return b;
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "lp-numbers") { numbers(msg.days).then(reply).catch((e) => reply({ error: String(e.message || e) })); return true; }
  if (msg && msg.type === "lp-clear") { cache = { at: 0, key: "", data: null }; reply({ ok: true }); }
  return false;
});
