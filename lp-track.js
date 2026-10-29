/* Qlarity website tracking. Add to every page of your website, before </body> (copy the exact line from Settings › Attribution & sync):
     <script src="https://<your dashboard>/lp-track.js" data-org="<workspace id>" data-brand="<brand>" async></script>
   What it does:
   - gives each browser an anonymous visitor id (first-party cookie + localStorage on your own site)
   - records where each visit came from: UTM tags, Meta / Google / Microsoft click ids, the referring site (Google, ChatGPT, Perplexity…)
   - when a form is submitted, sends the phone / email typed in it (hashed on our server, never stored raw) so the CRM lead
     can be joined to its visits; also adds hidden utm_* / fbclid / gclid / lp_vid fields to forms so they reach the CRM
   - logs clicks on WhatsApp links
   Turn it off for a visitor who declines tracking: set window.LP_TRACK_CONSENT = false before this script loads. */
(function(){
  if (window.LP_TRACK_CONSENT === false || window.__lpTrack) return; window.__lpTrack = 1;
  var me = document.currentScript || (function(){ var s = document.getElementsByTagName("script"); for (var i = s.length - 1; i >= 0; i--) if (/lp-track\.js/.test(s[i].src)) return s[i]; return null; })();
  if (!me) return;
  var ORG = me.getAttribute("data-org") || ""; if (!ORG) return;   /* the workspace this site belongs to */
  var END = me.src.replace(/\/lp-track\.js.*$/, "") + "/api/collect", BRAND = me.getAttribute("data-brand") || "";
  var DAY = 864e5, SESSION_MS = 30 * 60000, KEEP_DAYS = 395;
  function store(k, v){ try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function cookie(k, v){ if (v === undefined){ var m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : null; }
    /* widest domain the browser accepts (example.com, then example.co.in …, then this host only), so subdomains share one visitor */
    var host = location.hostname.split("."), tail = "; path=/; max-age=" + KEEP_DAYS * 86400 + "; samesite=lax" + (location.protocol === "https:" ? "; secure" : "");
    for (var n = 2; n <= host.length && !/^\d+$/.test(host[host.length - 1]); n++){
      document.cookie = k + "=" + encodeURIComponent(v) + "; domain=." + host.slice(-n).join(".") + tail; if (cookie(k) === v) return; }
    document.cookie = k + "=" + encodeURIComponent(v) + tail; }
  function rid(){ var a = "", c = "abcdefghijklmnopqrstuvwxyz0123456789"; var r = window.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(20)) : null;
    for (var i = 0; i < 20; i++) a += c.charAt((r ? r[i] : Math.floor(Math.random() * 256)) % 36); return a; }
  var vid = cookie("_lp_vid") || store("_lp_vid"); if (!/^[a-z0-9]{12,40}$/i.test(vid || "")) vid = rid();
  cookie("_lp_vid", vid); store("_lp_vid", vid);

  var qs = {}; location.search.replace(/^\?/, "").split("&").forEach(function(p){ if (!p) return; var i = p.indexOf("="), k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\+/g, " ")).toLowerCase();
    try { qs[k] = i < 0 ? "" : decodeURIComponent(p.slice(i + 1).replace(/\+/g, " ")); } catch (e) { qs[k] = p.slice(i + 1); } });
  var utm = {source: qs.utm_source || "", medium: qs.utm_medium || "", campaign: qs.utm_campaign || "", content: qs.utm_content || "", term: qs.utm_term || ""};
  var ids = {fbclid: qs.fbclid || "", gclid: qs.gclid || qs.gbraid || qs.wbraid || "", msclkid: qs.msclkid || ""};
  var ref = ""; try { ref = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : ""; } catch (e) {}
  if (ref === location.hostname.toLowerCase()) ref = "";
  if (ids.fbclid && !cookie("_fbc")) cookie("_fbc", "fb.1." + Date.now() + "." + ids.fbclid);   // the cookie Meta's pixel also uses
  /* remember the latest campaign info for 90 days, so forms filled later still carry it */
  var hasNew = !!(utm.source || utm.campaign || ids.fbclid || ids.gclid || ids.msclkid || ref);
  var last = null; try { last = JSON.parse(store("_lp_src") || "null"); } catch (e) {}
  if (hasNew){ last = {u: utm, c: ids, r: ref, t: Date.now()}; store("_lp_src", JSON.stringify(last)); }
  else if (last && Date.now() - last.t > 90 * DAY) last = null;
  var seen = +(store("_lp_seen") || 0), newSession = !seen || Date.now() - seen > SESSION_MS; store("_lp_seen", String(Date.now()));

  function send(kind, extra){
    var b = {o: ORG, v: vid, k: kind, h: location.hostname, p: location.pathname, b: BRAND, m: /Mobi|Android/i.test(navigator.userAgent), r: ref, u: utm, c: ids};
    if (kind !== "touch" && last){ b.u = last.u; b.c = last.c; b.r = last.r; }
    for (var k in extra) b[k] = extra[k];
    var s = JSON.stringify(b);
    try { if (navigator.sendBeacon && navigator.sendBeacon(END, new Blob([s], {type: "text/plain"}))) return; } catch (e) {}
    try { var x = new XMLHttpRequest(); x.open("POST", END, true); x.setRequestHeader("content-type", "text/plain"); x.send(s); } catch (e) {}
  }
  /* a touch = a visit that starts a session or arrives with campaign info; every page view is also logged for the landing page report */
  if (hasNew || newSession) send("touch"); else send("page");

  /* forms: hidden attribution fields + hashed contact keys */
  var FIELDS = [["utm_source", "source"], ["utm_medium", "medium"], ["utm_campaign", "campaign"], ["utm_content", "content"], ["utm_term", "term"]];
  function addHidden(f){ if (f.__lp) return; f.__lp = 1; var src = last || {u: utm, c: ids};
    var put = function(n, v){ if (!v || f.querySelector('[name="' + n + '"]')) return; var i = document.createElement("input"); i.type = "hidden"; i.name = n; i.value = v; f.appendChild(i); };
    FIELDS.forEach(function(x){ put(x[0], src.u && src.u[x[1]]); }); put("fbclid", src.c && src.c.fbclid); put("gclid", src.c && src.c.gclid); put("lp_vid", vid); }
  function scan(){ var fs = document.forms; for (var i = 0; i < fs.length; i++) addHidden(fs[i]); }
  scan(); if (window.MutationObserver) new MutationObserver(scan).observe(document.documentElement, {childList: true, subtree: true});
  function contact(f){ var ph = "", em = "", els = f.elements || [];
    for (var i = 0; i < els.length; i++){ var e = els[i], n = ((e.name || "") + " " + (e.id || "") + " " + (e.type || "") + " " + (e.getAttribute("autocomplete") || "")).toLowerCase(), v = String(e.value || "").trim();
      if (!v || e.type === "hidden" || e.type === "password") continue;
      if (!em && (e.type === "email" || /e-?mail/.test(n)) && /@/.test(v)) em = v;
      else if (!ph && (e.type === "tel" || /phone|mobile|tel|whatsapp|contact/.test(n)) && v.replace(/\D/g, "").length >= 10) ph = v; }
    return {ph: ph, em: em}; }
  document.addEventListener("submit", function(ev){ var f = ev.target; if (!f || f.tagName !== "FORM") return; var c = contact(f); send("form", {ph: c.ph, em: c.em}); }, true);
  document.addEventListener("click", function(ev){ var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (a && /(^|\/\/)(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)|^whatsapp:/i.test(a.getAttribute("href"))) send("whatsapp"); }, true);
  /* sites that submit forms with JavaScript (no submit event) can call this after a successful submit */
  window.lpTrackLead = function(phone, email){ send("form", {ph: phone || "", em: email || ""}); };
})();
