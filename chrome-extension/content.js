// Adds a small CRM badge next to every campaign name in Meta Ads Manager / Google Ads that your Qlarity workspace knows,
// with the dashboard's definitions: CRM leads, qualified leads, CPQL and sales for the period set in the options (default last 30 days).
(function () {
  let data = null, lastErr = "";
  const fmt = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v).toLocaleString("en-IN") : "N/A");
  const SYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£", AED: "AED ", SAR: "SAR ", SGD: "S$", AUD: "A$", CAD: "C$" };
  const inr = (v) => (typeof v === "number" && isFinite(v) ? (SYM[(data && data.currency) || "INR"] || data.currency + " ") + Math.round(v).toLocaleString("en-IN") : "N/A");
  function badge(c) {
    const s = document.createElement("span");
    s.setAttribute("data-lp", "1");
    s.title = (data.workspace || "Qlarity") + ", " + data.from + " → " + data.to + " (" + c.brand + ")\nCRM leads " + fmt(c.crm) + " · QL " + fmt(c.ql) + " · CPQL " + inr(c.cpql) +
      (data.salesConfigured ? " · Sales " + fmt(c.won) + " · Cost per sale " + inr(c.costPerSale) : "") + "\nMeta leads " + fmt(c.metaLeads) + " · CPL " + inr(c.cpl);
    s.textContent = "CRM " + fmt(c.crm) + " · QL " + fmt(c.ql) + " · CPQL " + inr(c.cpql) + (data.salesConfigured ? " · Sales " + fmt(c.won) : "");
    s.style.cssText = "display:inline-block;margin-left:6px;padding:1px 6px;font:600 11px/16px system-ui,sans-serif;border-radius:3px;background:#0b5;color:#fff;white-space:nowrap;vertical-align:middle";
    if (!c.ql && c.spend > 1500) s.style.background = "#c33";
    return s;
  }
  function scan() {
    if (!data || !data.campaigns) return;
    const els = document.querySelectorAll("a, span, div[role='gridcell'] div, td div");
    for (const e of els) {
      if (e.childElementCount || e.getAttribute("data-lp") || e.nextSibling && e.nextSibling.getAttribute && e.nextSibling.getAttribute("data-lp")) continue;
      const t = (e.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t.length < 3 || t.length > 200) continue;
      const c = data.campaigns[t];
      if (c) e.after(badge(c));
    }
  }
  function refresh() {
    chrome.runtime.sendMessage({ type: "lp-numbers" }, (b) => {
      if (!b || b.error) { if (b && b.error !== lastErr) { lastErr = b.error; console.info("Qlarity extension:", b.error); } return; }
      data = b; scan();
    });
  }
  refresh();
  setInterval(scan, 2500);
  setInterval(refresh, 10 * 60000);
})();
