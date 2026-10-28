// MCP server: lets Claude, ChatGPT or any MCP client read the dashboard's numbers.
// Endpoint https://<dashboard>/api/mcp (rewritten to /api/suite?op=mcp), Streamable HTTP, JSON responses, stateless.
// Auth: a workspace API key (Settings › Data connections › API keys) as "Authorization: Bearer <key>" (or ?key=<key>); the key decides the workspace. Read-only tools.
const AI = require("./_ai");
const U = require("./_suite");
const D = require("./_db");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }; }
async function one(S, m) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m && m.id, -32600, "Invalid request");
  const isNote = m.id === undefined || m.id === null;
  if (m.method === "initialize") {
    const want = m.params && m.params.protocolVersion;
    return rpcResult(m.id, { protocolVersion: PROTOCOLS.indexOf(want) >= 0 ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "lead-performance", version: "1.0.0" },
      instructions: D.orgName() + " lead performance data (Meta Ads + " + D.crm() + "). " + U.DEFINITIONS + " Dates are " + D.tzLabel() + ", currency " + D.currency() + ". Report null values as N/A." });
  }
  if (isNote) return null;   // notifications/initialized etc.
  if (m.method === "ping") return rpcResult(m.id, {});
  if (m.method === "tools/list") return rpcResult(m.id, { tools: AI.TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: true } })) });
  if (m.method === "tools/call") {
    const p = m.params || {}, tool = AI.TOOLS.filter((t) => t.name === p.name)[0];
    if (!tool) return rpcError(m.id, -32602, "Unknown tool: " + p.name);
    try { const out = await AI.runTool(S, p.name, p.arguments || {}); return rpcResult(m.id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }); }
    catch (e) { return rpcResult(m.id, { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true }); }
  }
  return rpcError(m.id, -32601, "Method not found: " + m.method);
}
async function handle(req, res) {
  if (req.method === "GET" || req.method === "DELETE") { res.statusCode = 405; res.setHeader("allow", "POST"); return res.end(); }
  if (req.method !== "POST") return U.send(res, 405, rpcError(null, -32600, "Use POST"));
  const org = await U.orgFromApiKey(req);
  if (!org) return U.send(res, 401, rpcError(null, -32001, "Unauthorized: send a workspace API key as a Bearer token."), { "www-authenticate": "Bearer" });
  return D.withOrg(org, () => handleIn(req, res));
}
async function handleIn(req, res) {
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { return U.send(res, 400, rpcError(null, -32700, "Parse error")); } }
  const S = await U.loadSettings();
  if (Array.isArray(body)) { const out = (await Promise.all(body.map((m) => one(S, m)))).filter(Boolean); if (!out.length) { res.statusCode = 202; return res.end(); } return U.send(res, 200, out); }
  const out = await one(S, body);
  if (!out) { res.statusCode = 202; return res.end(); }
  return U.send(res, 200, out);
}
module.exports = { handle };
