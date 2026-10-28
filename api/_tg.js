// Telegram Bot API helpers. Vercel env: TELEGRAM_BOT_TOKEN (from @BotFather). The token never reaches the browser.
const API = () => "https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/";
const configured = () => !!process.env.TELEGRAM_BOT_TOKEN;
async function tg(method, body) {
  const r = await fetch(API() + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const b = await r.json().catch(() => null);
  if (!b || !b.ok) throw new Error("Telegram: " + ((b && b.description) || r.status));
  return b.result;
}
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* send HTML text; split on line breaks to stay under Telegram's 4,096-character limit */
async function send(chatId, html) {
  const parts = [], lines = String(html).split("\n"); let cur = "";
  lines.forEach((l) => { if ((cur + "\n" + l).length > 3800) { parts.push(cur); cur = l; } else cur = cur ? cur + "\n" + l : l; });
  if (cur) parts.push(cur);
  for (const p of parts) await tg("sendMessage", { chat_id: chatId, text: p, parse_mode: "HTML", disable_web_page_preview: true });
  return parts.length;
}
module.exports = { configured, tg, send, esc };
