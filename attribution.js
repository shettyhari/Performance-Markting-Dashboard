/* Lead Performance — attribution suite pages (loaded after index.html's main script; ES5 like the rest).
   Pages: Attribution (models, channels, AI search, conversion paths), Lead journeys, Report builder, Ask AI, Sync & tracking.
   Settings section: Attribution & sync (deal values, Conversions API, website tracking, channel costs, audiences, AI digest, MCP / Chrome extension).
   Server: /api/suite (api/_suite.js and friends). Numbers follow the dashboard's definitions; N/A, never 0, when data is missing. */
(function(){
  var X = {cache: {}, busy: {}, err: {}, model: "last", by: "channel", chat: [], asking: false, jq: "", found: null, lead: null, cmp: null};
  try { var m0 = localStorage.getItem("lp-attr-model"); if (m0) X.model = m0; } catch (e) {}
  var MODELS = [["first", "First click"], ["last", "Last click"], ["linear", "Linear"], ["position", "Position-based"], ["decay", "Time decay"]];

  /* ---------- server calls ---------- */
  function api(op, params, body){
    if (!sb.client) return Promise.reject(new Error("Connect the workspace database first (Saved data › Workspace database)."));
    return Promise.resolve(lpAuth.token()).then(function(tok){
      if (!tok) throw new Error("Sign in first");
      var q = Object.keys(params || {}).filter(function(k){ return params[k] !== "" && params[k] !== null && params[k] !== undefined; })
        .map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
      return fetch("/api/suite?op=" + op + (q ? "&" + q : ""), {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok, "content-type": "application/json", "x-org-id": sb.org ? sb.org.id : ""}, body: body ? JSON.stringify(body) : undefined}); })
      .then(function(res){ return res.text().then(function(t){ var b = null; try { b = JSON.parse(t); } catch (e) {}
        if (!b) throw new Error(res.status === 404 ? "The attribution API isn't deployed yet (api/suite.js)." : "Unexpected answer (" + res.status + ")");
        if (!res.ok) throw new Error(b.error || ("Error " + res.status)); return b; }); });
  }
  /* cached GET: returns the data, or null while it loads (render() runs again when it arrives) */
  function load(op, params, force){
    var key = op + "|" + JSON.stringify(params);
    if (!force && X.cache[key]) return X.cache[key];
    if (X.busy[key] || (!force && X.err[key])) return null;   /* a failed call waits for "Try again", it doesn't retry on every render */
    X.busy[key] = true; delete X.err[key];
    api(op, params).then(function(d){ X.cache[key] = d; }).catch(function(e){ X.err[key] = e.message || String(e); })
      .then(function(){ delete X.busy[key]; render(); });
    return null;
  }
  function errOf(op, params){ return X.err[op + "|" + JSON.stringify(params)]; }
  function ready(){ return sb.cfg && sb.status === "ready"; }
  function needDb(){ return el("section", {cls: "panel"}, el("div", {cls: "banner warn", text: "These pages read the workspace database. Sign in with your team account (Saved data › Workspace database) to use them."})); }
  function rangeParams(){ var r = rangeOf(state.range), t = todayDay();
    if (!r || state.range.preset === "max") r = {from: t - 29, to: t};
    var from = r.from, to = Math.min(r.to, t); if (to - from > 91) from = to - 91;
    return {from: isoDay(from), to: isoDay(to), brand: state.brand !== "All" ? state.brand : ""}; }
  function waiting(op, params, what){ var e = errOf(op, params);
    return e ? el("div", {cls: "banner warn"}, el("span", {text: "Couldn't load " + what + ": " + e + " "}), el("button", {cls: "btn ghost", type: "button", onclick: function(){ load(op, params, true); render(); }}, "Try again"))
      : el("div", {cls: "empty", text: "Loading " + what + "…"}); }
  var f1 = function(v){ return isNum(v) ? (Math.round(v * 10) / 10).toLocaleString("en-IN") : "N/A"; };
  var xRoas = function(v){ return isNum(v) ? v.toFixed(2) + "×" : "N/A"; };
  function head(title, note){ return el("div", {cls: "sec-head"}, el("h2", {text: title}), note ? el("span", {cls: "note", text: note}) : null); }
  function chips(list, cur, on, label){ return el("div", {cls: "chips", role: "group", "aria-label": label}, list.map(function(x){
    return el("button", {cls: "chip", type: "button", "aria-pressed": x[0] === cur ? "true" : "false", onclick: function(){ on(x[0]); }}, x[1]); })); }
  function canEdit(){ return typeof sbCanWrite === "function" && sbCanWrite(); }
  function pre(text){ return el("pre", {cls: "code-box", style: "white-space:pre-wrap;word-break:break-all;margin:0;padding:12px;border:1px solid var(--line);background:var(--panel);font-size:12px;max-width:100%;overflow:auto"}, text); }

  /* ================= Attribution ================= */
  function viewAttribution(){
    if (!ready()) return needDb();
    var P = rangeParams(), q = {from: P.from, to: P.to, brand: P.brand, model: X.model, by: X.by}, A = load("attribution", q);
    var box = el("section", {cls: "panel"},
      head("Who gets credit for each lead", "Every CRM lead is followed back through its recorded touches (Meta ads, website visits from Google, ChatGPT, WhatsApp…). The model decides how the credit is split. Dates: " + P.from + " → " + P.to + (P.brand ? " · " + P.brand : "") + "."),
      el("div", {cls: "filters", style: "display:flex;flex-wrap:wrap;gap:10px"},
        chips(MODELS, X.model, function(k){ X.model = k; try { localStorage.setItem("lp-attr-model", k); } catch (e) {} render(); }, "Attribution model"),
        chips([["channel", "By channel"], ["campaign", "By campaign"]], X.by, function(k){ X.by = k; render(); }, "Group by")));
    if (!A){ box.appendChild(waiting("attribution", q, "attribution")); return box; }
    var ai = A.rows.filter(function(r){ return r.aiSearch; }).reduce(function(s, r){ return s + r.leads; }, 0);
    box.appendChild(el("div", {cls: "kpis"},
      kpi("CRM leads", fInt(A.leads), A.modelName),
      kpi("With a website journey", A.leads ? fPct(A.leadsWithWebJourney / A.leads) : "N/A", fInt(A.leadsWithWebJourney) + " leads linked to site visits"),
      kpi("From AI search", f1(ai), "credited leads (ChatGPT, Perplexity, Gemini…)"),
      kpi("Channels", fInt(A.rows.length), X.by === "campaign" ? "channel · campaign rows" : "with credited leads"),
      kpi("Sales tracking", A.salesConfigured ? "On" : "Off", A.salesConfigured ? "statuses ticked as Sale" : "tick Sale statuses on the QL statuses page")));
    var cols = [{k: "key", label: X.by === "campaign" ? "Channel · campaign" : "Channel", t: "text", cls: "name", render: function(r){
        return el("span", null, r.key, r.aiSearch ? el("span", {cls: "pill good", style: "margin-left:6px", text: "AI search"}) : null); }},
      {k: "leads", label: "Leads (credited)", t: "text", get: function(r){ return f1(r.leads); }},
      {k: "ql", label: "QL (credited)", t: "text", get: function(r){ return f1(r.ql); }},
      {k: "qlRate", label: "QL rate", t: "pct"},
      {k: "spend", label: "Amount spent", t: "inr"}, {k: "cpl", label: "Cost per credited lead", t: "inr"}, {k: "cpql", label: "Cost per credited QL", t: "inr"}];
    if (A.salesConfigured) cols = cols.concat([{k: "won", label: "Sales (credited)", t: "text", get: function(r){ return f1(r.won); }}, {k: "costPerSale", label: "Cost per sale", t: "inr"},
      {k: "estRevenue", label: "Est. revenue", t: "inr"}, {k: "estRoas", label: "Est. ROAS", t: "text", get: function(r){ return xRoas(r.estRoas); }}]);
    box.appendChild(table("attr-" + X.by, cols, A.rows, {empty: "No CRM leads in these dates."}));
    box.appendChild(el("p", {cls: "small", text: A.note}));
    /* compare models */
    box.appendChild(head("Compare models", "Same leads, five ways of splitting the credit. Big differences show which channels start journeys and which close them."));
    if (!X.cmp || X.cmp.key !== JSON.stringify([P, X.by])) box.appendChild(el("button", {cls: "btn ghost", type: "button", onclick: function(){ compareModels(P); }}, "Compare all five models"));
    else if (X.cmp.busy) box.appendChild(el("div", {cls: "empty", text: "Loading the five models…"}));
    else {
      var keys = {}; X.cmp.res.forEach(function(r){ r.rows.forEach(function(x){ keys[x.key] = 1; }); });
      var rows = Object.keys(keys).map(function(k){ var o = {key: k}; X.cmp.res.forEach(function(r, i){ var x = r.rows.filter(function(y){ return y.key === k; })[0]; o["m" + i] = x ? x.leads : 0; }); return o; });
      box.appendChild(table("attr-cmp", [{k: "key", label: "Channel", t: "text", cls: "name"}].concat(MODELS.map(function(m, i){ return {k: "m" + i, label: m[1], t: "text", get: function(r){ return f1(r["m" + i]); }}; })), rows.sort(function(a, b){ return b.m1 - a.m1; })));
    }
    box.appendChild(head("Top conversion paths", "The order of channels before the lead arrived (repeat visits from the same source counted once)."));
    box.appendChild(table("attr-paths", [{k: "path", label: "Path", t: "text", cls: "name"}, {k: "steps", label: "Touches", t: "int"}, {k: "leads", label: "Leads", t: "int"}, {k: "ql", label: "QL", t: "int"},
      {k: "qlRate", label: "QL rate", t: "pct", get: function(r){ return r.leads ? r.ql / r.leads : null; }}].concat(A.salesConfigured ? [{k: "won", label: "Sales", t: "int"}] : []), A.paths));
    return box;
  }
  function compareModels(P){
    X.cmp = {key: JSON.stringify([P, X.by]), busy: true, res: []}; render();
    var chain = Promise.resolve();
    MODELS.forEach(function(m, i){ chain = chain.then(function(){ return api("attribution", {from: P.from, to: P.to, brand: P.brand, model: m[0], by: X.by}).then(function(d){ X.cmp.res[i] = d; }); }); });
    chain.then(function(){ X.cmp.busy = false; }).catch(function(e){ X.cmp = null; toast("Couldn't compare: " + e.message); }).then(render);
  }

  /* ================= Lead journeys ================= */
  function viewJourneys(){
    if (!ready()) return needDb();
    var inp = el("input", {type: "search", cls: "search", placeholder: "Lead id, phone number or name", "aria-label": "Find a lead", value: X.jq});
    var go = function(){ X.jq = inp.value.trim(); if (!X.jq) return; X.found = {busy: true}; render();
      api("find", {q: X.jq}).then(function(d){ X.found = d; if (d.leads.length === 1) openLead(d.leads[0].lead_id); }).catch(function(e){ X.found = {error: e.message}; }).then(render); };
    inp.addEventListener("keydown", function(e){ if (e.key === "Enter"){ e.preventDefault(); go(); } });
    var box = el("section", {cls: "panel"}, head("Where did this lead come from?", "Every recorded touch of one lead, from the first ad click or site visit to the CRM, and what was sent back to Meta."),
      el("div", {style: "display:flex;gap:8px;flex-wrap:wrap"}, inp, el("button", {cls: "btn", type: "button", onclick: go}, "Find")));
    var F = X.found;
    if (F && F.busy) box.appendChild(el("div", {cls: "empty", text: "Searching…"}));
    else if (F && F.error) box.appendChild(el("div", {cls: "banner warn", text: F.error}));
    else if (F && F.leads && F.leads.length !== 1) box.appendChild(table("jr-found", [{k: "lead_id", label: "Lead id", t: "text", cls: "name", render: function(r){ return el("button", {cls: "btn ghost", type: "button", onclick: function(){ openLead(r.lead_id); }}, r.lead_id); }},
      {k: "created_on", label: "Created", t: "text"}, {k: "lead_name", label: "Name", t: "text"}, {k: "brand", label: "Brand", t: "text"}, {k: "campaign", label: "Campaign", t: "text"}, {k: "status", label: "Status", t: "text"}], F.leads, {empty: "No lead matches."}));
    var J = X.lead;
    if (J && J.busy) box.appendChild(el("div", {cls: "empty", text: "Loading the journey…"}));
    else if (J && J.error) box.appendChild(el("div", {cls: "banner warn", text: J.error}));
    else if (J && J.lead){
      var L = J.lead;
      box.appendChild(el("div", {cls: "kpis"}, kpi("Lead", L.id, L.created + " " + tzLabel()), kpi("Brand", L.brand || "N/A", L.campaign || L.source || ""), kpi("Status", L.status || "N/A", L.qualified ? "Qualified" : "Not qualified"),
        kpi("Sale", L.sale === null ? "N/A" : L.sale ? "Yes" : "No", L.sale === null ? "no Sale statuses ticked" : ""), kpi("First call", isNum(L.tatMin) ? fDur(L.tatMin) : "N/A", L.owner || "")));
      box.appendChild(el("ol", {cls: "journey", style: "list-style:none;margin:0;padding:0;display:grid;gap:0;border-left:2px solid var(--line)"}, J.touches.map(function(t, i){
        return el("li", {style: "padding:10px 14px;position:relative;border-bottom:1px solid var(--line)"},
          el("div", {cls: "eyebrow", text: (i + 1) + " · " + t.at.replace("T", " ").slice(0, 16) + " UTC · " + t.from}),
          el("div", {style: "font-weight:600", text: t.channel + (t.campaign ? " · " + t.campaign : "")}),
          el("div", {cls: "small", text: [t.adset, t.ad, t.source && "source " + t.source, t.medium && "medium " + t.medium, t.page].filter(Boolean).join(" · ")})); })));
      if (J.touches.length === 1 && J.touches[0].from === "CRM") box.appendChild(el("p", {cls: "small", text: "Only the CRM's own source is known for this lead. Website visits appear here once lp-track.js is on the site and the visitor submits a form with the same phone or email."}));
      box.appendChild(head("Sent to Meta", null));
      box.appendChild(table("jr-capi", [{k: "stage", label: "Stage", t: "text", get: function(r){ return r.stage === "won" ? "Sale" : "Qualified"; }}, {k: "event_name", label: "Event", t: "text"}, {k: "status", label: "Result", t: "text"},
        {k: "match_keys", label: "Matched with", t: "text"}, {k: "sent_at", label: "Sent at", t: "text"}, {k: "detail", label: "Detail", t: "text", cls: "remarks"}], J.sentToMeta || [], {empty: "Nothing sent to Meta for this lead."}));
    }
    return box;
  }
  function openLead(id){ X.lead = {busy: true}; render(); api("journey", {id: id}).then(function(d){ X.lead = d; }).catch(function(e){ X.lead = {error: e.message}; }).then(render); }

  /* ================= Report builder (works on the loaded data, like every other page) ================= */
  var DIMS = [["brand", "Brand", "ad"], ["campaign", "Campaign", "ad"], ["adset", "Ad set", "ad"], ["ad", "Ad", "ad"], ["owner", "Lead owner", "lead"], ["manager", "Leader (manager)", "lead"],
    ["status", "CRM status", "lead"], ["source", "Lead source", "lead"], ["day", "Day", "lead"], ["week", "Week", "lead"], ["month", "Month", "lead"]];
  var METS = [["spend", "Amount spent", "inr", "ad"], ["ui", "Leads in UI", "int", "ad"], ["crm", "Leads in CRM", "int"], ["ql", "Qualified leads", "int"], ["qlRate", "QL rate", "pct"],
    ["cpl", "CPL", "inr", "ad"], ["cpql", "CPQL", "inr", "ad"], ["wonN", "Sales", "int"], ["saleRate", "Sale rate", "pct"], ["cps", "Cost per sale", "inr", "ad"],
    ["estRev", "Est. revenue", "inr", "ad"], ["estRoas", "Est. ROAS", "text", "ad"], ["imp", "Impressions", "int", "ad"], ["clk", "Clicks", "int", "ad"], ["ctr", "CTR", "pct", "ad"],
    ["cpc", "CPC", "inr2", "ad"], ["tat", "Avg TAT (overall)", "min"], ["sla", "SLA %", "pct"], ["pend", "Not Contacted", "int"]];
  function bState(){ if (!state.builder) state.builder = {dims: ["brand"], mets: ["spend", "crm", "ql", "cpql", "wonN", "cps"], name: ""}; return state.builder; }
  function weekKey(day){ var w = ymd(day).w; return isoDay(day - ((w + 6) % 7)); }
  function builderRows(B){
    var R = state.R, adLevel = B.dims.every(function(d){ return DIMS.filter(function(x){ return x[0] === d; })[0][2] === "ad"; });
    var groups = {}, order = [];
    var keyOf = function(r){ return B.dims.map(function(d){ return d === "day" ? isoDay(dayOf(r.created)) : d === "week" ? weekKey(dayOf(r.created)) : d === "month" ? isoDay(dayOf(r.created)).slice(0, 7) : (r[d] || "—"); }); };
    if (adLevel){
      R.allAds.forEach(function(a){ if (!a.shown || !brandOK(a.brand)) return; var k = keyOf(a), ks = k.join("|~|"); if (!groups[ks]){ groups[ks] = {k: k, rows: []}; order.push(ks); } groups[ks].rows.push(a); });
      return {adLevel: true, rows: order.map(function(ks){ var g = groups[ks], o = sumRows(g.rows); B.dims.forEach(function(d, i){ o[d] = g.k[i]; }); return o; })};
    }
    (R.leadRows || []).forEach(function(L){ if (!brandOK(L.brand) || !isNum(L.created)) return; var k = keyOf(L), ks = k.join("|~|");
      var g = groups[ks] || (groups[ks] = (order.push(ks), {k: k, o: newAcc({spend: null, ui: null, imp: null, clk: null})}));
      addLead(g.o, {isQL: !!L.ql, isWon: !!L.won, brand: L.brand, tat: L.tat, wh: L.wh, sla: L.sla, created: L.created}); });
    return {adLevel: false, rows: order.map(function(ks){ var g = groups[ks], o = derive(g.o); B.dims.forEach(function(d, i){ o[d] = g.k[i]; }); return o; })};
  }
  function viewBuilder(){
    var B = bState(), S = state.settings, saved = S.customReports || [];
    var toggle = function(arr, k){ var i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); else arr.push(k); render(); };
    var box = el("section", {cls: "panel"}, head("Build your own report", "Pick how to group the data and which numbers to show. Uses the data and dates loaded at the top, with the dashboard's own definitions. Grouping by owner, status, source or date shows CRM numbers only (spend isn't known per lead)."));
    box.appendChild(el("div", {cls: "group"}, el("h3", {text: "Group by (in order)"}), el("div", {cls: "chips", style: "flex-wrap:wrap"}, DIMS.map(function(d){
      var on = B.dims.indexOf(d[0]); return el("button", {cls: "chip", "aria-pressed": on >= 0 ? "true" : "false", type: "button", onclick: function(){ toggle(B.dims, d[0]); }}, (on >= 0 ? (on + 1) + ". " : "") + d[1]); }))),
      el("div", {cls: "group"}, el("h3", {text: "Numbers"}), el("div", {cls: "chips", style: "flex-wrap:wrap"}, METS.map(function(m){
      var on = B.mets.indexOf(m[0]) >= 0; return el("button", {cls: "chip", "aria-pressed": on ? "true" : "false", type: "button", onclick: function(){ toggle(B.mets, m[0]); }}, m[1]); }))));
    if (!state.R){ box.appendChild(el("div", {cls: "empty", text: "Load data first."})); return box; }
    if (!B.dims.length){ box.appendChild(el("div", {cls: "empty", text: "Pick at least one way to group."})); return box; }
    var res = builderRows(B);
    var cols = B.dims.map(function(d){ return {k: d, label: DIMS.filter(function(x){ return x[0] === d; })[0][1], t: "text", cls: "name"}; })
      .concat(B.mets.map(function(k){ var m = METS.filter(function(x){ return x[0] === k; })[0];
        return {k: k, label: m[1], t: m[2], get: k === "estRoas" ? function(r){ return xRoas(r.estRoas); } : (!res.adLevel && m[3] === "ad") ? function(){ return null; } : undefined}; }));
    var total = res.adLevel ? sumRows(state.R.allAds.filter(function(a){ return a.shown && brandOK(a.brand); })) : null;
    if (total) B.dims.forEach(function(d, i){ total[d] = i === 0 ? "TOTAL" : ""; });
    box.appendChild(table("builder", cols, res.rows, {total: total, empty: "No data for this grouping."}));
    if (!res.adLevel && B.mets.some(function(k){ return (METS.filter(function(x){ return x[0] === k; })[0] || [])[3] === "ad"; }))
      box.appendChild(el("p", {cls: "small", text: "Spend-based numbers show N/A here because this grouping is per lead. Group only by brand / campaign / ad set / ad to see them."}));
    var name = el("input", {type: "text", placeholder: "Report name", value: B.name || "", "aria-label": "Report name"});
    box.appendChild(el("div", {style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center"},
      el("button", {cls: "btn ghost", type: "button", onclick: function(){ csv(cols, res.rows, (name.value || "lead-report")); }}, "Download CSV"), name,
      el("button", {cls: "btn ghost", type: "button", onclick: function(){ var n = name.value.trim(); if (!n){ toast("Name the report first"); return; }
        var L = (S.customReports || []).filter(function(r){ return r.name !== n; }); L.push({name: n, dims: B.dims.slice(), mets: B.mets.slice()}); S.customReports = L; B.name = n; provSave(); toast("Saved “" + n + "”" + (canEdit() ? " for the team" : " in this browser")); render(); }}, "Save report")));
    if (saved.length) box.appendChild(el("div", {cls: "group"}, el("h3", {text: "Saved reports"}), el("div", {cls: "chips", style: "flex-wrap:wrap"}, saved.map(function(r){
      return el("span", {style: "display:inline-flex;gap:4px"}, el("button", {cls: "chip", type: "button", onclick: function(){ state.builder = {dims: r.dims.slice(), mets: r.mets.slice(), name: r.name}; render(); }}, r.name),
        el("button", {cls: "icon-mini", type: "button", "aria-label": "Delete " + r.name, onclick: function(){ if (!confirm("Delete the saved report “" + r.name + "”?")) return; S.customReports = saved.filter(function(x){ return x !== r; }); provSave(); render(); }}, "✕")); }))));
    return box;
  }
  function csv(cols, rows, name){
    var esc = function(v){ var s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [cols.map(function(c){ return esc(c.label); }).join(",")].concat(rows.map(function(r){ return cols.map(function(c){ var v = c.get ? c.get(r) : r[c.k]; return esc(isNum(v) ? Math.round(v * 100) / 100 : v); }).join(","); }));
    var a = el("a", {href: URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], {type: "text/csv"})), download: name.replace(/[^\w\- ]+/g, "") + ".csv"}); document.body.appendChild(a); a.click(); a.remove();
  }

  /* ================= Ask AI ================= */
  var SUGGEST = ["How did we do last week vs the week before?", "Which campaigns spent the most with no qualified leads in the last 14 days?", "Which brand has the best CPQL this month?",
    "How many leads came from ChatGPT or other AI search this month?", "Which brand's cost per lead changed most over the last 30 days?"];
  function viewAsk(){
    if (!ready()) return needDb();
    var ta = el("textarea", {rows: 3, placeholder: "Ask about spend, leads, QL, sales, campaigns, channels…", "aria-label": "Question", spellcheck: "true"});
    var send = function(text){ var qtext = String(text || ta.value).trim(); if (!qtext || X.asking) return;
      var hist = X.chat.map(function(m){ return {role: m.role, content: m.text}; }); X.chat.push({role: "user", text: qtext}); X.asking = true; render();
      api("ask", {}, {question: qtext, history: hist}).then(function(d){ X.chat.push({role: "assistant", text: d.answer, tools: d.tools || []}); })
        .catch(function(e){ X.chat.push({role: "assistant", text: "Couldn't answer: " + e.message, error: true}); }).then(function(){ X.asking = false; render(); }); };
    ta.addEventListener("keydown", function(e){ if (e.key === "Enter" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); send(); } });
    var box = el("section", {cls: "panel"}, head("Ask your data", "An AI analyst answers from the dashboard's own numbers (same definitions). It never sees phone numbers or emails. Always check important numbers on the dashboard before acting."));
    var log = el("div", {style: "display:grid;gap:12px"});
    X.chat.forEach(function(m){ log.appendChild(el("div", {cls: "group", style: m.role === "user" ? "background:transparent" : ""},
      el("div", {cls: "eyebrow", text: m.role === "user" ? "You" : "AI analyst"}), el("div", {style: "white-space:pre-wrap;line-height:1.55", text: m.text}),
      m.tools && m.tools.length ? el("div", {cls: "small", text: "Looked up: " + m.tools.map(function(t){ return t.tool.replace(/_/g, " ") + (t.input && t.input.from ? " " + t.input.from + "→" + t.input.to : "") + (t.input && t.input.brand ? " (" + t.input.brand + ")" : ""); }).join(" · ")}) : null)); });
    if (X.asking) log.appendChild(el("div", {cls: "empty", text: "Looking at the numbers…"}));
    box.appendChild(log);
    if (!X.chat.length) box.appendChild(el("div", {cls: "chips", style: "flex-wrap:wrap"}, SUGGEST.map(function(s){ return el("button", {cls: "chip", type: "button", onclick: function(){ send(s); }}, s); })));
    box.appendChild(ta);
    box.appendChild(el("div", {style: "display:flex;gap:8px;flex-wrap:wrap"}, el("button", {cls: "btn", type: "button", disabled: X.asking ? true : null, onclick: function(){ send(); }}, "Ask"),
      X.chat.length ? el("button", {cls: "btn ghost", type: "button", onclick: function(){ X.chat = []; render(); }}, "New conversation") : null,
      el("span", {cls: "small", text: "Ctrl + Enter to send"})));
    return box;
  }

  /* ================= Sync & tracking (Conversions API log, audiences, website tracking health) ================= */
  function viewSync(){
    if (!ready()) return needDb();
    var box = el("section", {cls: "panel"});
    var C = load("capi-status", {days: 7});
    box.appendChild(head("Sent to Meta (Conversions API)", "Qualified leads and sales from your CRM sent back to Meta, so its delivery looks for people like your real buyers. Last 7 days."));
    if (!C) box.appendChild(waiting("capi-status", {days: 7}, "the Conversions API log"));
    else {
      var cf = C.config;
      box.appendChild(el("div", {cls: "kpis"}, kpi("Status", cf.enabled ? "On" : "Off", cf.enabled ? "every 30 minutes" : "Settings › Attribution & sync"), kpi("Token", C.tokenSet ? "Set" : "Missing", "Settings › Workspace › Tokens"),
        kpi("Sent", fInt(C.events.filter(function(e){ return e.status === "sent"; }).length), cf.testCode ? "TEST mode (" + cf.testCode + ")" : "events"),
        kpi("Failed", fInt(C.events.filter(function(e){ return e.status === "failed"; }).length), "retried up to 3 times", C.events.some(function(e){ return e.status === "failed"; }) ? "bad" : ""),
        kpi("Skipped", fInt(C.events.filter(function(e){ return e.status === "skipped"; }).length), "no dataset or no match key")));
      if (canEdit()) box.appendChild(el("div", null, el("button", {cls: "btn ghost", type: "button", id: "capi-run", onclick: function(){ var b = document.getElementById("capi-run"); b.disabled = true; b.textContent = "Sending…";
        api("capi-run", {}, {}).then(function(d){ toast(d.skipped || ("Sent " + (d.sent || 0) + ", failed " + (d.failed || 0) + ", skipped " + (d.skipped || 0))); load("capi-status", {days: 7}, true); }).catch(function(e){ toast(e.message); render(); }); }}, "Send now")));
      box.appendChild(table("capi-sum", [{k: "brand", label: "Brand", t: "text", cls: "name"}, {k: "stage", label: "Stage", t: "text", get: function(r){ return r.stage === "won" ? "Sale" : "Qualified"; }},
        {k: "sent", label: "Sent", t: "int"}, {k: "failed", label: "Failed", t: "int"}, {k: "skipped", label: "Skipped", t: "int"}], C.summary, {empty: "Nothing sent in the last 7 days."}));
      box.appendChild(table("capi-ev", [{k: "created_at", label: "When", t: "text", get: function(r){ return (r.sent_at || r.created_at || "").replace("T", " ").slice(0, 16); }}, {k: "lead_id", label: "Lead", t: "text"},
        {k: "brand", label: "Brand", t: "text"}, {k: "event_name", label: "Event", t: "text"}, {k: "status", label: "Result", t: "text", render: function(r){ return el("span", {cls: "pill " + (r.status === "sent" ? "good" : r.status === "failed" ? "bad" : "mut"), text: r.status}); }},
        {k: "match_keys", label: "Matched with", t: "text"}, {k: "detail", label: "Detail", t: "text", cls: "remarks"}], C.events, {empty: "No events yet."}));
    }
    var T = load("tracking-status", {days: 7});
    box.appendChild(head("Website tracking", "Visits and form fills recorded by lp-track.js on your sites (last 7 days)."));
    if (!T) box.appendChild(waiting("tracking-status", {days: 7}, "website tracking"));
    else if (!T.setup) box.appendChild(el("div", {cls: "banner warn", text: "The database isn't set up for this yet: whoever runs the site re-runs ec2/setup.sh on the database server (it applies db/*.sql; data stays). (" + (T.error || "") + ")"}));
    else {
      box.appendChild(el("div", {cls: "kpis"}, kpi("Visitors", fInt(T.visitors), "anonymous"), kpi("Events", fInt(T.events), T.lastEvent ? "last " + T.lastEvent.replace("T", " ").slice(0, 16) + " UTC" : "none yet"),
        kpi("Form fills", fInt(T.forms), fInt(T.identified) + " with phone / email"), kpi("WhatsApp clicks", fInt(T.whatsappClicks), ""), kpi("Allowed sites", fInt(T.allowedDomains.length), T.allowedDomains.join(", ") || "none — add them in Settings")));
      box.appendChild(table("trk-ch", [{k: "channel", label: "Channel", t: "text", cls: "name", render: function(r){ return el("span", null, r.channel, r.aiSearch ? el("span", {cls: "pill good", style: "margin-left:6px", text: "AI search"}) : null); }}, {k: "touches", label: "Visits with a source", t: "int"}], T.channels, {empty: "No visits recorded yet."}));
    }
    var Au = load("audiences-status", {});
    box.appendChild(head("Meta audiences", "CRM lists synced daily to Meta custom audiences (hashed phone and email only), for lookalikes and exclusions."));
    if (!Au) box.appendChild(waiting("audiences-status", {}, "audiences"));
    else {
      box.appendChild(el("div", {cls: "kpis"}, kpi("Status", Au.config.enabled ? "On" : "Off", "daily, early morning"), kpi("Token", Au.tokenSet ? "Set" : "Missing", "needs ads_management"), kpi("Audiences", fInt((Au.lists || []).length), "")));
      if (canEdit()) box.appendChild(el("div", null, el("button", {cls: "btn ghost", type: "button", id: "aud-run", onclick: function(){ var b = document.getElementById("aud-run"); b.disabled = true; b.textContent = "Syncing…";
        api("audiences-run", {}, {}).then(function(d){ toast(d.skipped || "Audience sync finished"); load("audiences-status", {}, true); }).catch(function(e){ toast(e.message); render(); }); }}, "Sync now")));
      box.appendChild(table("aud", [{k: "name", label: "Audience", t: "text", cls: "name"}, {k: "account_id", label: "Ad account", t: "text"}, {k: "members", label: "People sent", t: "int"},
        {k: "last_sync", label: "Last sync", t: "text", get: function(r){ return (r.last_sync || "").replace("T", " ").slice(0, 16); }}, {k: "last_error", label: "Last error", t: "text", cls: "remarks"}], Au.lists || [], {empty: Au.error ? "Couldn't load audiences: " + Au.error : "No audiences yet."}));
    }
    return box;
  }

  /* ================= Settings › Attribution & sync ================= */
  function setGrowth(h){
    var S = state.settings, ed = canEdit() || !sb.cfg;
    var cap = S.capi || {}, trk = S.tracking || {}, aud = S.audiences || {}, ai = S.ai || {}, dv = S.dealValue || {};
    var wrap = el("div", {style: "display:grid;gap:18px"});
    var inputs = {};
    var num = function(id, label, v, hint){ var i = el("input", {type: "number", id: id, min: "0", step: "1", value: isNum(Number(v)) && v !== "" && v !== undefined ? v : "", disabled: ed ? null : true}); inputs[id] = i;
      return el("div", {cls: "field"}, el("label", {"for": id, text: label}), i, hint ? el("span", {cls: "small", text: hint}) : null); };
    var txt = function(id, label, v, hint, type){ var i = el("input", {type: type || "text", id: id, value: v || "", disabled: ed ? null : true}); inputs[id] = i;
      return el("div", {cls: "field"}, el("label", {"for": id, text: label}), i, hint ? el("span", {cls: "small", text: hint}) : null); };
    var chk = function(id, label, v, hint){ var i = el("input", {type: "checkbox", id: id, checked: v ? true : null, disabled: ed ? null : true}); inputs[id] = i;
      return el("label", {cls: "toggle", "for": id}, i, el("span", null, el("span", {text: label}), hint ? el("span", {cls: "small tog-hint", text: hint}) : null)); };
    var ta = function(id, label, v, hint){ var i = el("textarea", {id: id, rows: 4, spellcheck: "false", disabled: ed ? null : true}, v || ""); inputs[id] = i;
      return el("div", {cls: "field"}, el("label", {"for": id, text: label}), i, hint ? el("span", {cls: "small", text: hint}) : null); };
    var brands = (S.brands || []).filter(function(b){ return String(b).trim(); });
    var grid = function(nodes){ return el("div", {style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px"}, nodes); };

    wrap.appendChild(h.card("Sales and deal values", "Sales = statuses ticked as “Counts as a sale” on the QL statuses page (" + ((S.wonStatuses || []).length ? (S.wonStatuses || []).join(", ") : "none ticked yet") + "). " +
      "Most CRMs don't send deal amounts here, so estimated revenue = sales × the average deal value you enter per brand. Leave a brand empty and its revenue and ROAS show N/A.",
      grid(brands.map(function(b, i){ return num("dv-" + i, b + " · average deal value (₹)", dv[b]); }))));

    wrap.appendChild(h.card("Conversions API (send qualified leads and sales to Meta)", "Every 30 minutes, leads that became qualified or a sale are sent to Meta's dataset for the brand, matched by Facebook lead id, phone, email and the ad click id. Each lead and stage is sent once. In Meta Events Manager › your dataset › Settings, create a Conversions API access token and paste it in Settings › Workspace › Tokens (without one, the Meta token is used).",
      chk("capi-on", "Send to Meta", cap.enabled), grid([txt("capi-since", "Send leads created from", cap.since || "", "Older leads are never sent.", "date"),
        num("capi-win", "Look back (days)", cap.windowDays || 28, "Leads older than this are not sent (Meta ignores very old leads)."),
        txt("capi-qlev", "Event name for qualified", cap.qlEvent || "Qualified Lead"), txt("capi-wonev", "Event name for a sale", cap.wonEvent || "Converted"),
        txt("capi-ds", "Default dataset (pixel) id", cap.dataset || "", "Used for brands without their own."), txt("capi-test", "Test event code (optional)", cap.testCode || "", "From Events Manager › Test events. Remove it to go live.")]),
      chk("capi-ql", "Send qualified leads", cap.sendQl !== false), chk("capi-won", "Send sales", cap.sendWon !== false, "Needs statuses ticked as Sale."),
      grid(brands.map(function(b, i){ return txt("capi-b-" + i, b + " · dataset id", (cap.datasets || {})[b] || ""); }))));

    var origin = location.origin;
    wrap.appendChild(h.card("Website tracking", "Add the snippet to every page of each of your websites (before </body>). It records where visits come from — ads, Google, ChatGPT and other AI search, WhatsApp — and links them to the CRM lead by the phone or email typed in the form. Only the sites listed here are accepted. Tell visitors about it in your privacy notice; set window.LP_TRACK_CONSENT = false to switch it off for someone who declines.",
      chk("trk-on", "Accept tracking data", trk.enabled), ta("trk-dom", "Allowed sites (one per line)", (trk.domains || []).join("\n"), "For example yourbrand.com — subdomains are included."),
      ta("trk-cust", "Your own channels (utm_source values, one per line)", (trk.customChannels || []).join("\n"), "For example newsletter, podcast, influencer-raj. Each becomes a channel of its own."),
      el("div", {cls: "field"}, el("label", {text: "Snippet"}), pre(brands.map(function(b){ return "<!-- " + b + " -->\n<script src=\"" + origin + "/lp-track.js\" data-org=\"" + (sb.org ? sb.org.public_id : "") + "\" data-brand=\"" + b + "\" async></script>"; }).join("\n\n")))));

    wrap.appendChild(h.card("Costs of channels without an ad account", "So cost per lead covers everything you spend: SEO retainers, influencers, print, events. One line per month: channel | YYYY-MM | amount | brand (optional). The channel must match the name on the Attribution page (for example Organic search, ChatGPT, Referral · newsletter).",
      ta("costs", "Channel costs", (S.channelCosts || []).map(function(c){ return [c.channel, c.month, c.amount, c.brand || ""].join(" | ").replace(/ \| $/, ""); }).join("\n"))));

    wrap.appendChild(h.card("Meta audiences", "Daily, CRM lists become Meta custom audiences per brand (hashed phone and email only), in the brand's first ticked ad account. Use them for lookalikes of buyers and to exclude existing leads. The token (audience token or Meta token in Settings › Workspace › Tokens) needs ads_management, and each ad account must have accepted Meta's Custom Audience terms.",
      chk("aud-on", "Sync audiences", aud.enabled), chk("aud-ql", "Qualified leads", (aud.lists || ["ql", "won"]).indexOf("ql") >= 0), chk("aud-won", "Customers (sales)", (aud.lists || ["ql", "won"]).indexOf("won") >= 0),
      chk("aud-all", "All CRM leads (for exclusions)", (aud.lists || []).indexOf("all") >= 0), num("aud-days", "Leads from the last (days)", aud.lookbackDays || 180)));

    wrap.appendChild(h.card("AI analyst", "Ask AI uses Claude (switched on by whoever runs the site). The daily digest goes to the Telegram chat connected in Settings › Alerts, every morning.",
      chk("ai-digest", "Send a daily AI digest to Telegram", ai.digest)));

    wrap.appendChild(h.card("Use the data in Claude, ChatGPT and the Chrome extension", "Create an API key in Settings › Workspace › API keys. Anyone with it can read this workspace's numbers, so keep it private and revoke it when it's no longer used.",
      el("div", {cls: "field"}, el("label", {text: "MCP server URL (Claude › Settings › Connectors › Add custom connector, or any MCP client)"}), pre(origin + "/api/mcp")),
      el("p", {cls: "small", text: "Clients that can't send an Authorization header can use " + origin + "/api/mcp?key=<API key>. The Chrome extension is in the chrome-extension folder of the repo: load it unpacked in chrome://extensions, then enter " + origin + " and the API key in its options."})));

    if (ed) wrap.appendChild(el("div", {style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap"}, el("button", {cls: "btn", type: "button", onclick: function(){ saveGrowth(inputs, brands); }}, "Save attribution settings"),
      el("span", {cls: "small", text: sb.cfg ? "Shared with the team." : "Saved in this browser."})));
    else wrap.appendChild(el("p", {cls: "small", text: "Only admins and editors can change these settings."}));
    return wrap;
  }
  function saveGrowth(I, brands){
    var S = state.settings, v = function(id){ return I[id] ? String(I[id].value || "").trim() : ""; }, on = function(id){ return !!(I[id] && I[id].checked); };
    var bad = [];
    var dv = {}; brands.forEach(function(b, i){ var x = v("dv-" + i); if (x !== ""){ var n = Number(x); if (isFinite(n) && n > 0) dv[b] = n; else bad.push(b + " deal value"); } });
    var ds = {}; brands.forEach(function(b, i){ var x = v("capi-b-" + i).replace(/\D+/g, ""); if (x) ds[b] = x; });
    if (on("capi-on") && !/^\d{4}-\d{2}-\d{2}$/.test(v("capi-since"))) bad.push("“Send leads created from” date");
    var lines = function(id){ return v(id).split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean); };
    var costs = []; lines("costs").forEach(function(l){ var p = l.split("|").map(function(s){ return s.trim(); }), amt = Number(String(p[2] || "").replace(/[₹,\s]/g, ""));
      if (p[0] && /^\d{4}-\d{2}$/.test(p[1] || "") && isFinite(amt) && amt > 0) costs.push({channel: p[0], month: p[1], amount: amt, brand: p[3] || ""}); else bad.push("cost line “" + l + "”"); });
    if (bad.length){ toast("Check: " + bad.slice(0, 3).join(", ")); return; }
    S.dealValue = dv;
    S.capi = {enabled: on("capi-on"), since: v("capi-since"), windowDays: Number(v("capi-win")) || 28, qlEvent: v("capi-qlev") || "Qualified Lead", wonEvent: v("capi-wonev") || "Converted",
      dataset: v("capi-ds").replace(/\D+/g, ""), testCode: v("capi-test"), sendQl: on("capi-ql"), sendWon: on("capi-won"), datasets: ds};
    S.tracking = {enabled: on("trk-on"), domains: lines("trk-dom").map(function(d){ return d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }), customChannels: lines("trk-cust").map(function(d){ return d.toLowerCase(); })};
    S.channelCosts = costs;
    S.audiences = {enabled: on("aud-on"), lists: ["ql", "won", "all"].filter(function(k){ return on("aud-" + k); }), lookbackDays: Number(v("aud-days")) || 180};
    S.ai = Object.assign({}, S.ai || {}, {digest: on("ai-digest")});
    provSave(); if (state.raw) recompute(); else render(); toast("Attribution settings saved");
  }

  /* ================= Settings › Workspace: name, logo, currency, time zone, CRM, tokens, API keys ================= */
  var TOKENS = [["meta_access_token", "Meta System User token", "Reads ad accounts, spend and results (ads_read). Meta Business Settings › Users › System users › Generate new token; give the system user your ad accounts under Assigned assets."],
    ["meta_capi_token", "Meta Conversions API token (optional)", "Events Manager › your dataset › Settings › Conversions API › Generate access token. Without it, the Meta token above is used."],
    ["meta_audience_token", "Meta audience token (optional)", "Needs ads_management, for Meta audiences. Without it, the Meta token above is used."],
    ["google_refresh_token", "Google Ads refresh token (optional)", "From the site's Google OAuth client (ask whoever runs the site for the client id), scope adwords."],
    ["google_login_customer_id", "Google Ads manager (MCC) id (optional)", "Digits only, when your accounts sit under a manager account."]];
  var W = {secrets: null, keys: null, newKey: null, busy: false};
  function wsLoad(force){
    if (W.busy || (!force && W.secrets)) return; W.busy = true;
    Promise.all([sb.client.from("org_secrets").select("key,last4,updated_by,updated_at"),
      sbRole() === "admin" ? sb.client.from("org_api_keys").select("id,kind,name,last4,created_by,created_at,revoked_at").order("created_at", {ascending: false}) : Promise.resolve({data: []})])
      .then(function(r){ W.secrets = {}; (r[0].data || []).forEach(function(x){ W.secrets[x.key] = x; }); W.keys = r[1].data || []; })
      .catch(function(e){ W.err = e.message; }).then(function(){ W.busy = false; render(); });
  }
  function sbRole(){ return sb.org ? sb.org.role : null; }
  function resizeLogo(file){ return new Promise(function(res, rej){
    if (!/^image\//.test(file.type)) return rej(new Error("Pick an image file."));
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function(){ var k = Math.min(1, 96 / img.height, 320 / img.width), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k)); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); var d = c.toDataURL("image/png"); d.length > 280000 ? rej(new Error("That logo is too detailed; try a simpler image.")) : res(d); };
    img.onerror = function(){ rej(new Error("Couldn't read that image.")); }; img.src = url; }); }
  function setWorkspace(h){
    var admin = sbRole() === "admin", o = sb.org || {}, S = state.settings, wrap = el("div", {style: "display:grid;gap:18px"});
    if (!sb.org){ wrap.appendChild(el("p", {cls: "small", text: "Sign in to a workspace first."})); return wrap; }
    wsLoad();
    /* identity */
    var F = orgFields(o, "ws"); [F.name, F.cur, F.tz, F.crm].forEach(function(n){ n.disabled = !admin; });
    var logo = o.logo || null, prev = el("img", {alt: "", src: logo || null, hidden: logo ? null : true, style: "max-height:48px;max-width:200px;border:1px solid var(--line);padding:4px;background:#fff"});
    var file = el("input", {type: "file", accept: "image/png,image/jpeg,image/svg+xml,image/webp", disabled: admin ? null : true, "aria-label": "Logo"});
    file.addEventListener("change", function(){ if (!file.files[0]) return; resizeLogo(file.files[0]).then(function(d){ logo = d; prev.src = d; prev.hidden = false; }).catch(function(e){ toast(e.message); }); });
    var pfx = el("textarea", {id: "ws-pfx", rows: 2, disabled: admin ? null : true, placeholder: "e.g. Agency name | (one per line)"}, (S.campaignPrefixes || []).join("\n"));
    var cc = el("input", {type: "text", id: "ws-cc", maxlength: "4", disabled: admin ? null : true, value: S.phoneCountryCode || "", placeholder: "e.g. 91"});
    wrap.appendChild(h.card("Workspace", "Shown in the header, page title, reports, Excel files and Telegram messages. Only admins can change it.",
      el("div", {style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"}, F.nodes,
        el("div", {cls: "field"}, el("label", {"for": "ws-cc", text: "Phone country code"}), cc, el("span", {cls: "small", text: "Added to CRM phone numbers saved without one, for matching with Meta and website forms."}))),
      el("div", {cls: "field"}, el("label", {text: "Logo (optional)"}), el("div", {style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap"}, prev, file,
        admin && logo ? el("button", {cls: "linkbtn", type: "button", onclick: function(){ logo = null; prev.hidden = true; }}, "Remove logo") : null)),
      el("div", {cls: "field"}, el("label", {"for": "ws-pfx", text: "Campaign name prefixes to ignore"}), pfx,
        el("span", {cls: "small", text: "When the CRM keeps a campaign's old name with a prefix that was later removed in Meta, the lead still matches."})),
      admin ? el("button", {cls: "btn", type: "button", onclick: function(){
        var n = F.name.value.trim(); if (!n){ toast("Give the workspace a name."); return; }
        sb.client.from("organizations").update({name: n, currency: F.cur.value, tz_offset_min: Number(F.tz.value), crm_name: F.crm.value.trim() || "CRM", logo: logo}).eq("id", sb.org.id)
          .then(function(r){ if (r.error) throw r.error;
            state.settings.campaignPrefixes = pfx.value.split(/\n+/).map(function(x){ return x.trim(); }).filter(Boolean);
            state.settings.phoneCountryCode = cc.value.replace(/\D+/g, ""); provSave();
            return sbLoadOrgs(); })
          .then(function(list){ var me = list.filter(function(x){ return x.id === sb.org.id; })[0]; sbUseOrg(me); if (state.raw) recompute(); else render(); toast("Workspace saved"); })
          .catch(function(e){ toast("Not saved: " + (e.message || e)); }); }}, "Save workspace") : null));
    /* tokens */
    var tokCard = h.card("Tokens", "Kept encrypted in the database vault for this workspace only. Nobody can read them back from here, not even admins: paste a new one to replace it.");
    if (!W.secrets) tokCard.appendChild(el("div", {cls: "small", text: W.err ? "Couldn't load: " + W.err : "Loading…"}));
    else TOKENS.forEach(function(t){
      var cur = W.secrets[t[0]], inp = el("input", {type: "password", autocomplete: "off", placeholder: cur ? "Set · ends …" + cur.last4 : "Not set", disabled: admin ? null : true, "aria-label": t[1]});
      var save = function(v){ sb.client.rpc("set_org_secret", {p_key: t[0], p_value: v}).then(function(r){ if (r.error) throw r.error; toast(v ? t[1] + " saved" : t[1] + " removed");
        inp.value = ""; state.prov = {}; wsLoad(true); }).catch(function(e){ toast("Not saved: " + (e.message || e)); }); };
      tokCard.appendChild(el("div", {cls: "field"}, el("label", {text: t[1] + (cur ? " · set " + String(cur.updated_at || "").slice(0, 10) + (cur.updated_by ? " by " + cur.updated_by : "") : "")}),
        el("div", {style: "display:flex;gap:8px;flex-wrap:wrap"}, inp, admin ? el("button", {cls: "btn ghost", type: "button", onclick: function(){ if (inp.value.trim()) save(inp.value.trim()); }}, "Save") : null,
          admin && cur ? el("button", {cls: "linkbtn", type: "button", onclick: function(){ if (confirm("Remove the " + t[1] + "? Syncs that use it stop.")) save(""); }}, "Remove") : null),
        el("span", {cls: "small", text: t[2]})));
    });
    wrap.appendChild(tokCard);
    /* API keys */
    if (admin){
      var kc = h.card("API keys", "A CRM push key lets n8n or your CRM's webhook send leads to " + location.origin + "/api/crm-push. An API key lets Claude / ChatGPT (MCP) and the Chrome extension read this workspace's numbers. Each key is shown once.");
      if (W.newKey) kc.appendChild(el("div", {cls: "banner"}, el("div", null, el("b", {text: "Copy it now — it won't be shown again: "}), pre(W.newKey),
        el("button", {cls: "btn ghost", type: "button", onclick: function(){ try { navigator.clipboard.writeText(W.newKey); toast("Copied"); } catch (e) {} }}, "Copy"),
        el("button", {cls: "linkbtn", type: "button", onclick: function(){ W.newKey = null; render(); }}, "Done"))));
      var kind = el("select", {"aria-label": "Key type"}, [["crm_push", "CRM push"], ["api", "API (MCP / Chrome extension)"]].map(function(x){ return el("option", {value: x[0], text: x[1]}); }));
      var kname = el("input", {type: "text", placeholder: "Name, e.g. n8n TeleCRM", maxlength: "60", "aria-label": "Key name"});
      kc.appendChild(el("div", {style: "display:flex;gap:8px;flex-wrap:wrap"}, kind, kname, el("button", {cls: "btn", type: "button", onclick: function(){
        sb.client.rpc("create_api_key", {p_kind: kind.value, p_name: kname.value.trim()}).then(function(r){ if (r.error) throw r.error; W.newKey = r.data; wsLoad(true); })
          .catch(function(e){ toast("Couldn't create: " + (e.message || e)); }); }}, "Create key")));
      kc.appendChild(table("ws-keys", [{k: "kind", label: "Type", t: "text", get: function(r){ return r.kind === "api" ? "API" : "CRM push"; }}, {k: "name", label: "Name", t: "text"},
        {k: "last4", label: "Ends", t: "text", get: function(r){ return "…" + r.last4; }}, {k: "created_at", label: "Created", t: "text", get: function(r){ return String(r.created_at || "").slice(0, 10) + (r.created_by ? " · " + r.created_by : ""); }},
        {k: "revoked_at", label: "", t: "text", nosort: true, render: function(r){ return r.revoked_at ? el("span", {cls: "pill mut", text: "Revoked"}) : el("button", {cls: "linkbtn", type: "button", onclick: function(){
          if (!confirm("Revoke this key? Anything using it stops working.")) return;
          sb.client.from("org_api_keys").update({revoked_at: new Date().toISOString()}).eq("id", r.id).then(function(x){ if (x.error) throw x.error; toast("Key revoked"); wsLoad(true); }).catch(function(e){ toast(e.message); }); }}, "Revoke"); }}],
        W.keys || [], {empty: "No keys yet."}));
      wrap.appendChild(kc);
    }
    wrap.appendChild(el("p", {cls: "small", text: "Members and invitations: Saved data › Workspace database. Workspace id for website tracking: " + (o.public_id || "")}));
    return wrap;
  }

  /* ---------- register ---------- */
  SET_TABS.unshift(["workspace", "Workspace", "Your workspace's name, logo, currency, time zone and CRM, the tokens it uses for Meta and Google, and API keys."]);
  EXTRA_SET.workspace = setWorkspace;
  PAGE_INFO.attribution = ["Attribution", "Which channels and campaigns really produce leads, qualified leads and sales, under the attribution model you pick."];
  PAGE_INFO.journeys = ["Lead journeys", "Every touch of one lead, from the first click to the CRM, and what was sent to Meta."];
  PAGE_INFO.builder = ["Report builder", "Group and count the loaded data any way you need; save reports for the team."];
  PAGE_INFO.ask = ["Ask AI", "Plain-language questions answered from the dashboard's numbers."];
  PAGE_INFO.capi = ["Sync & tracking", "Conversions API events sent to Meta, website tracking health and Meta audiences."];
  EXTRA_VIEWS.attribution = viewAttribution; EXTRA_VIEWS.journeys = viewJourneys; EXTRA_VIEWS.builder = viewBuilder; EXTRA_VIEWS.ask = viewAsk; EXTRA_VIEWS.capi = viewSync;
  SET_TABS.splice(SET_TABS.length - 1, 0, ["growth", "Attribution & sync", "Deal values, sending qualified leads and sales to Meta, website tracking, channel costs, audiences, the AI digest and API access."]);
  EXTRA_SET.growth = setGrowth;
  try { var saved = localStorage.getItem("lp-lead-dash-tab"); if (saved && EXTRA_VIEWS[saved]) state.tab = saved; } catch (e) {}
  try { render(); } catch (e) {}
})();
