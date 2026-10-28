// AI marketing analyst (Phase 5): plain-language questions answered from the dashboard's own numbers, through tools that run
// the same calculations as the dashboard (api/_suite.js). Also writes the daily AI digest sent to Telegram.
// Vercel env: ANTHROPIC_API_KEY. The model never sees phone numbers or emails (tools return business numbers only).
const U = require("./_suite");
const D = require("./_db");
const MODEL = "claude-opus-5-5";

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
function system(S) {
  return [
    "You are the marketing analyst inside " + D.orgName() + "'s lead performance dashboard (brands: " + ((S.brands || []).join(", ") || "none set yet") + "; CRM: " + D.crm() + ").",
    "Today is " + U.istDay(0) + " (" + D.tzLabel() + "). Currency is " + D.currency() + " (" + D.cur().trim() + "). Answer like a senior performance marketer: business impact first, plain language, short.",
    "Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent numbers, targets, people or events.",
    "When a value is null or missing, say N/A and why (for example: no sales statuses ticked yet, no deal value set, no spend for that channel). Never treat N/A as 0.",
    "Use the definitions the tools return. Compare periods by calling the tool for each period. Say which dates you used.",
    "Est. revenue and ROAS are estimates (sales × average deal value from Settings); label them as estimates.",
    "End with at most three concrete next actions when the question is about performance."
  ].join("\n");
}
/* one question (with optional earlier turns as plain text) → answer text + the tools used */
async function ask(S, question, history) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in Vercel.");
  const SDK = require("@anthropic-ai/sdk"), Anthropic = SDK.default || SDK;   // loaded here so the MCP server works without it
  const client = new Anthropic();
  const messages = (Array.isArray(history) ? history : []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-10).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  messages.push({ role: "user", content: String(question).slice(0, 4000) });
  const used = [];
  for (let turn = 0; turn < 8; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium" }, system: system(S), tools: TOOLS, messages });
    if (res.stop_reason === "refusal") return { answer: "I can't answer that one. Try asking about spend, leads, QL, sales or campaigns.", tools: used };
    messages.push({ role: "assistant", content: res.content });   // full content, unchanged (thinking blocks included)
    const calls = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !calls.length) {
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "No answer was produced.", tools: used, truncated: res.stop_reason === "max_tokens" };
    }
    const results = await Promise.all(calls.map(async (c) => {
      used.push({ tool: c.name, input: c.input });
      try { return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(await runTool(S, c.name, c.input)).slice(0, 60000) }; }
      catch (e) { return { type: "tool_result", tool_use_id: c.id, is_error: true, content: String(e.message || e) }; }
    }));
    messages.push({ role: "user", content: results });
  }
  return { answer: "That needed more steps than allowed. Try a narrower question (one brand or a shorter date range).", tools: used };
}
async function digest(S) {
  const y = U.istDay(-1);
  return ask(S, "Write the morning digest for " + y + " (yesterday, complete day) for the chairman. Compare with the 7 days before (" + U.addDays(y, -7) + " to " + U.addDays(y, -1) + "). " +
    "Cover: total spend, Meta leads, CRM leads, QL, sales if configured, CPL and CPQL with change; the best and worst brand by CPQL (only brands with 5+ QL in either period); campaigns that spent ₹1,500+ with 0 QL; and the top 3 actions. " +
    "Plain text, no markdown tables, under 1,800 characters.", []);
}
module.exports = { ask, digest, TOOLS, runTool };
