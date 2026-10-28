const $ = (id) => document.getElementById(id);
chrome.storage.local.get(["url", "token", "days"]).then((o) => { $("url").value = o.url || ""; $("token").value = o.token || ""; $("days").value = o.days || 30; });
$("save").addEventListener("click", async () => {
  const url = $("url").value.trim().replace(/\/+$/, ""), token = $("token").value.trim(), days = Math.min(92, Math.max(1, +$("days").value || 30));
  if (!/^https:\/\//.test(url) || !token) { $("msg").textContent = "Enter an https:// dashboard URL and the API key."; return; }
  // the extension may only call the dashboard address you enter (Chrome asks you once)
  const ok = await chrome.permissions.request({ origins: [url + "/*"] });
  if (!ok) { $("msg").textContent = "Permission for " + url + " was not given."; return; }
  await chrome.storage.local.set({ url, token, days });
  await chrome.runtime.sendMessage({ type: "lp-clear" });
  $("msg").textContent = "Testing…";
  chrome.runtime.sendMessage({ type: "lp-numbers" }, (b) => {
    $("msg").textContent = !b || b.error ? "Not working: " + ((b && b.error) || "no answer") : "Working: " + Object.keys(b.campaigns).length + " campaigns, " + b.from + " → " + b.to + ". Reload Ads Manager.";
  });
});
