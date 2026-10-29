// Outgoing email (sign-up confirmation, password reset) over any SMTP server: Amazon SES, Gmail, Zoho, your host's mail…
// Vercel env: SMTP_HOST, SMTP_PORT (465 = TLS, else STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM ("Qlarity <no-reply@yourdomain.com>").
let transport = null, sender = null;

const configured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);

function mailer() {
  if (sender) return sender;   // tests replace the sender with setSender()
  if (!transport) {
    const nodemailer = require("nodemailer"), port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
  }
  return (m) => transport.sendMail(m);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* one plain message with a single button-style link */
async function sendLink(to, subject, intro, label, url, outro) {
  if (!configured()) throw new Error("Email isn't set up on this site yet (SMTP_HOST and MAIL_FROM).");
  const text = intro + "\n\n" + url + "\n\n" + (outro || "");
  const html = '<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2933;max-width:520px">' +
    "<p>" + esc(intro) + "</p>" +
    '<p><a href="' + esc(url) + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">' + esc(label) + "</a></p>" +
    '<p style="color:#52606d;font-size:13px">' + esc(outro || "") + "<br>Or paste this link into your browser: " + esc(url) + "</p></div>";
  await mailer()({ from: process.env.MAIL_FROM, to, subject, text, html });
}

module.exports = { configured, sendLink, setSender: (fn) => { sender = fn; } };
