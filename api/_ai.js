// AI marketing analyst (Phase 5): plain-language questions answered from the dashboard's own numbers, through tools that run
// the same calculations as the dashboard (api/_suite.js). Also writes the daily AI digest sent to Telegram.
// Provider, model and key are per workspace (Settings › AI, owners only): Anthropic Claude, OpenAI, Google Gemini or any OpenAI-compatible
// service. The model never sees phone numbers or emails (tools return business numbers only).
const U = require("./_suite");
const D = require("./_db");

const TOOLS = [
  { name: "brand_performance", description: "Spend, Meta leads, CRM leads, QL, sales, CPL, CPQL, cost per sale, est. revenue / ROAS, CTR/CPC/CPM per brand plus the total of listed brands, for a date range (max 92 days). Use for any 'how are we doing' question.",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD (workspace time zone)" }, to: { type: "string", description: "YYYY-MM-DD (workspace time zone)" }, brand: { type: "string", description: "Optional: one brand name" } }, required: ["from", "to"], additionalProperties: false } },
  { name: "campaign_performance", description: "The same numbers per Meta campaign, sorted by the chosen metric. Use for 'which campaigns' questions.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, brand: { type: "string" }, sort_by: { type: "string", enum: ["spend", "metaLeads", "crm", "ql", "won", "cpl", "cpql", "costPerSale"] }, ascending: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["from", "to"], additionalProperties: false } },
  { name: "trend", description: "Numbers per day, week or month for a date range, overall or for one brand.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, brand: { type: "string" }, granularity: { type: "string", enum: ["day", "week", "month"] } }, required: ["from", "to"], additionalProperties: false } },
  { name: "attribution", description: "Leads, QL and sales credited to channels (Meta Ads, Google Ads, ChatGPT and other AI search engines, organic search, WhatsApp, referral…) or campaigns under an attribution model, with spend and cost per credited lead, plus the most common conversion paths.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, brand: { type: "string" }, model: { type: "string", enum: ["first", "last", "linear", "position", "decay"] }, by: { type: "string", enum: ["channel", "campaign"] } }, required: ["from", "to"], additionalProperties: false } },
  { name: "lead_journey", description: "Every recorded touch of one lead (by CRM lead id), its status and what was sent to Meta.",
    input_schema: { type: "object", properties: { lead_id: { type: "string" } }, required: ["lead_id"], additionalProperties: false } }
];
async function runTool(S, name, a) {
  a = a || {};
  if (name === "brand_performance") { const P = await U.performance(S, a); delete P.campaigns; return P; }
  if (name === "campaign_performance") {
    const P = await U.performance(S, a), k = a.sort_by || "spend", dir = a.ascending ? 1 : -1;
    const rows = P.campaigns.filter((c) => U.isNum(c[k])).sort((x, y) => dir * (x[k] - y[k])).slice(0, a.limit || 15);
    return { from: P.from, to: P.to, definitions: P.definitions, salesConfigured: P.salesConfigured, sortedBy: k, campaigns: rows, campaignsWithoutThisMetric: P.campaigns.length - P.campaigns.filter((c) => U.isNum(c[k])).length };
  }
  if (name === "trend") return U.trend(S, a);
  if (name === "attribution") { const A = await U.attribution(S, a); A.rows = A.rows.slice(0, 30); return A; }
  if (name === "lead_journey") { const j = await U.journey(S, String(a.lead_id || "")); return j || { error: "No lead with that id." }; }
  return { error: "Unknown tool" };
}
function system(S, ctx) {
  return [
    "You are the marketing analyst inside " + D.orgName() + "'s Qlarity dashboard, which compares ad spend with the leads, qualified leads and sales in the CRM (brands: " + ((S.brands || []).join(", ") || "none set yet") + "; CRM: " + D.crm() + ").",
    "Today is " + U.istDay(0) + " (" + D.tzLabel() + "). Currency is " + D.currency() + " (" + D.cur().trim() + "). Answer like a senior performance marketer: business impact first, plain language, short.",
    "Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent numbers, targets, people or events.",
    "When a value is null or missing, say N/A and why (for example: no sales statuses ticked yet, no deal value set, no spend for that channel). Never treat N/A as 0.",
    "Use the definitions the tools return. Compare periods by calling the tool for each period. Say which dates you used.",
    "Est. revenue and ROAS are estimates (sales × average deal value from Settings); label them as estimates.",
    "End with at most three concrete next actions when the question is about performance.",
    "Format for a chat panel: short paragraphs, bullet lists, **bold** for key figures, and a small markdown table only when comparing several rows."
  ].concat(ctx ? [ctx] : []).join("\n");
}
/* ---------- providers: each workspace's owner picks one in Settings › AI (org_ai_config); its key is in the vault (ai_<provider>_key) ---------- */
const PROVIDERS = {
  anthropic: { label: "Anthropic Claude", base: "https://api.anthropic.com/v1" },
  openai: { label: "OpenAI", base: "https://api.openai.com/v1" },
  gemini: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta" },
  compatible: { label: "OpenAI-compatible", base: "" },
};
const OFF = "Ask AI isn't set up yet. Your workspace owner can switch it on in Settings › AI.";
const TIMEOUT = 45000;

/* the https address an OpenAI-compatible service gets (same rule as set_ai_config in the database) */
function safeBase(u) {
  const m = /^https:\/\/([^\s/?#:]+)(:\d+)?(\/[^\s?#]*)?$/.exec(String(u || "").trim()); if (!m) return "";
  const h = m[1].toLowerCase();
  if (h === "localhost" || /\.(local|internal)$/.test(h) || /^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.indexOf("[") === 0) return "";
  return String(u).trim().replace(/\/+$/, "");
}
/* the workspace's AI settings and key; provider overrides the saved one (listing models before switching) */
async function settings(provider) {
  const r = await D.sbFetch("org_ai_config?select=enabled,provider,model,base_url");
  const c = (r && r[0]) || { enabled: false, provider: "anthropic", model: "", base_url: "" };
  const p = provider || c.provider;
  if (!PROVIDERS[p]) throw new Error("Unknown AI provider.");
  const base = p === "compatible" ? safeBase(c.base_url) : PROVIDERS[p].base;
  return { enabled: !!c.enabled, provider: p, label: PROVIDERS[p].label, model: p === c.provider ? String(c.model || "") : "", base, key: await D.orgSecret("ai_" + p + "_key") };
}
/* one HTTP call to the provider; the key never appears in an error */
async function call(cfg, path, body, method) {
  if (!cfg.key) throw new Error("No " + cfg.label + " key saved yet (Settings › AI).");
  if (!cfg.base) throw new Error("Set the service's https address in Settings › AI.");
  const h = { "content-type": "application/json" };
  if (cfg.provider === "anthropic") { h["x-api-key"] = cfg.key; h["anthropic-version"] = "2023-06-01"; }
  else if (cfg.provider === "gemini") h["x-goog-api-key"] = cfg.key;
  else h.authorization = "Bearer " + cfg.key;
  let r;
  try { r = await fetch(cfg.base + path, { method: method || "POST", headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (e) { throw new Error(cfg.label + " didn't answer in time or couldn't be reached."); }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) {
    const msg = String((j && ((j.error && (j.error.message || j.error)) || j.message)) || t || "").replace(cfg.key, "…").slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new Error(cfg.label + " refused the key (" + r.status + "). Check it in Settings › AI.");
    if (r.status === 404) throw new Error(cfg.label + " doesn't know the model “" + cfg.model + "” (404). Pick another in Settings › AI.");
    if (r.status === 429) throw new Error(cfg.label + " says the limit or credit is used up (429). " + msg);
    throw new Error(cfg.label + " answered " + r.status + ": " + msg);
  }
  return j || {};
}
/* Gemini takes a subset of JSON schema: no additionalProperties */
function geminiSchema(x) {
  if (Array.isArray(x)) return x.map(geminiSchema);
  if (!x || typeof x !== "object") return x;
  const o = {}; Object.keys(x).forEach((k) => { if (k !== "additionalProperties") o[k] = geminiSchema(x[k]); }); return o;
}

/* one conversation turn per provider: returns {text, calls: [{id, name, input}], stop, push(results)} with the provider's own message format kept */
const ADAPTERS = {
  anthropic: {
    start: (sys, msgs) => ({ system: sys, messages: msgs.map((m) => ({ role: m.role, content: m.content })) }),
    async turn(cfg, st, tools) {
      const res = await call(cfg, "/messages", { model: cfg.model, max_tokens: 4096, system: st.system, messages: st.messages,
        tools: tools ? TOOLS : undefined });
      const content = res.content || []; st.messages.push({ role: "assistant", content });
      return { text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n"), stop: res.stop_reason,
        calls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} })) };
    },
    results(st, out) { st.messages.push({ role: "user", content: out.map((o) => ({ type: "tool_result", tool_use_id: o.id, content: o.content, is_error: o.error || undefined })) }); },
  },
  openai: {
    start: (sys, msgs) => ({ messages: [{ role: "system", content: sys }].concat(msgs.map((m) => ({ role: m.role, content: m.content }))) }),
    async turn(cfg, st, tools) {
      const res = await call(cfg, "/chat/completions", { model: cfg.model, messages: st.messages,
        tools: tools ? TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) : undefined });
      const ch = (res.choices || [])[0] || {}, m = ch.message || { role: "assistant", content: "" };
      st.messages.push(m);
      const calls = (m.tool_calls || []).map((c) => { let a = {}; try { a = JSON.parse((c.function && c.function.arguments) || "{}"); } catch (e) {} return { id: c.id, name: c.function && c.function.name, input: a }; });
      return { text: typeof m.content === "string" ? m.content : "", calls, stop: ch.finish_reason === "length" ? "max_tokens" : ch.finish_reason === "content_filter" ? "refusal" : ch.finish_reason };
    },
    results(st, out) { out.forEach((o) => st.messages.push({ role: "tool", tool_call_id: o.id, content: o.content })); },
  },
  gemini: {
    start: (sys, msgs) => ({ system: sys, contents: msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) }),
    async turn(cfg, st, tools) {
      const model = String(cfg.model || "").replace(/^models\//, "");
      const res = await call(cfg, "/models/" + encodeURIComponent(model) + ":generateContent", { systemInstruction: { parts: [{ text: st.system }] }, contents: st.contents,
        tools: tools ? [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) })) }] : undefined });
      const cand = (res.candidates || [])[0] || {}, content = cand.content || { role: "model", parts: [] };
      st.contents.push({ role: "model", parts: content.parts || [] });
      const parts = content.parts || [];
      return { text: parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("\n"),
        calls: parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id || "call_" + i, name: p.functionCall.name, input: p.functionCall.args || {} })),
        stop: cand.finishReason === "MAX_TOKENS" ? "max_tokens" : /SAFETY|PROHIBITED|BLOCKLIST/.test(cand.finishReason || "") || (res.promptFeedback && res.promptFeedback.blockReason) ? "refusal" : cand.finishReason };
    },
    results(st, out) { st.contents.push({ role: "user", parts: out.map((o) => ({ functionResponse: { name: o.name, response: { result: o.content } } })) }); },
  },
};
ADAPTERS.compatible = ADAPTERS.openai;

/* what the person is looking at in the dashboard (checked; only a default when the question names no dates or brand) */
function contextLine(c) {
  if (!c || typeof c !== "object") return "";
  const day = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || "")) ? String(x) : ""), txt = (x, n) => String(x || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);
  const page = txt(c.page, 40), from = day(c.from), to = day(c.to), brand = txt(c.brand, 80);
  if (!page && !from && !brand) return "";
  return "Context: the person is looking at the " + JSON.stringify(page || "dashboard") + " page" + (from && to ? " for " + from + " to " + to : "") +
    (brand ? ", brand " + JSON.stringify(brand) : ", all brands") + ". When the question doesn't name dates or a brand, use these.";
}
/* one question (with optional earlier turns as plain text) → answer text + the tools used + which model answered */
async function ask(S, question, history, context) {
  const cfg = await settings();
  if (!cfg.enabled) { const e = new Error(OFF); e.code = "AI_OFF"; throw e; }
  if (!cfg.model) throw new Error("No model chosen yet. Your workspace owner picks one in Settings › AI.");
  const A = ADAPTERS[cfg.provider];
  const prior = (Array.isArray(history) ? history : []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-10).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  prior.push({ role: "user", content: String(question).slice(0, 4000) });
  const st = A.start(system(S, contextLine(context)), prior), used = [], by = { provider: cfg.label, model: cfg.model };
  for (let turn = 0; turn < 6; turn++) {
    const r = await A.turn(cfg, st, true);
    if (r.stop === "refusal") return { answer: "I can't answer that one. Try asking about spend, leads, QL, sales or campaigns.", tools: used, by };
    if (!r.calls.length) return { answer: (r.text || "").trim() || "No answer was produced.", tools: used, truncated: r.stop === "max_tokens", by };
    const out = await Promise.all(r.calls.map(async (c) => {
      used.push({ tool: c.name, input: c.input });
      try { return { id: c.id, name: c.name, content: JSON.stringify(await runTool(S, c.name, c.input)).slice(0, 60000) }; }
      catch (e) { return { id: c.id, name: c.name, error: true, content: String(e.message || e) }; }
    }));
    A.results(st, out);
  }
  return { answer: "That needed more steps than allowed. Try a narrower question (one brand or a shorter date range).", tools: used, by };
}
/* Settings › AI: the models a saved key can use (owners only) */
async function models(provider) {
  const cfg = await settings(provider);
  if (cfg.provider === "gemini") {
    const r = await call(cfg, "/models?pageSize=200", null, "GET");
    return (r.models || []).filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0).map((m) => String(m.name || "").replace(/^models\//, "")).filter(Boolean).sort();
  }
  const r = await call(cfg, "/models" + (cfg.provider === "anthropic" ? "?limit=100" : ""), null, "GET");
  return (r.data || []).map((m) => m.id).filter(Boolean).sort();
}
/* Settings › AI › Test: a tiny request with the saved provider, model and key */
async function test() {
  const cfg = await settings();
  if (!cfg.model) throw new Error("Choose a model first.");
  const A = ADAPTERS[cfg.provider], st = A.start("Reply with the single word OK.", [{ role: "user", content: "Test" }]);
  const t0 = Date.now(), r = await A.turn(cfg, st, false);
  return { ok: true, provider: cfg.label, model: cfg.model, reply: String(r.text || "").trim().slice(0, 80), ms: Date.now() - t0 };
}
async function digest(S) {
  const y = U.istDay(-1);
  return ask(S, "Write the morning digest for " + y + " (yesterday, complete day) for the leadership team. Compare with the 7 days before (" + U.addDays(y, -7) + " to " + U.addDays(y, -1) + "). " +
    "Cover: total spend, Meta leads, CRM leads, QL, sales if configured, CPL and CPQL with change; the best and worst brand by CPQL (only brands with 5+ QL in either period); campaigns that spent 1,500+ (workspace currency) with 0 QL; and the top 3 actions. " +
    "Plain text, no markdown tables, under 1,800 characters.", []);
}
module.exports = { ask, digest, models, test, settings, safeBase, contextLine, PROVIDERS, TOOLS, runTool };
