// Tells the page where the database API is (API_URL in Vercel: the EC2 server set up by ec2/setup.sh). Nothing secret is sent:
// the page signs in through /api/auth, and every table is protected by row level security per workspace (db/10-schema.sql).
module.exports = function handler(req, res) {
  const url = String(process.env.API_URL || "").replace(/\/+$/, ""), ready = !!(url && process.env.JWT_SECRET);
  res.statusCode = ready ? 200 : 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(ready ? { apiUrl: url, appName: process.env.APP_NAME || "Qlarity", mail: !!(process.env.SMTP_HOST && process.env.MAIL_FROM) }
    : { error: "API_URL and JWT_SECRET are not set on this site yet." }));
};
