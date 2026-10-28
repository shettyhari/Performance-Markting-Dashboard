// Tells the page which Supabase project to use (set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel). The anon key is public by design:
// every table is protected by row level security per workspace (see supabase/install.sql).
module.exports = function handler(req, res) {
  const url = process.env.SUPABASE_URL || "", key = process.env.SUPABASE_ANON_KEY || "";
  res.statusCode = url && key ? 200 : 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(url && key ? { supabaseUrl: url, supabaseAnonKey: key, appName: process.env.APP_NAME || "Lead Performance" }
    : { error: "SUPABASE_URL and SUPABASE_ANON_KEY are not set on this site yet." }));
};
