// Qlarity Local Development Server
// Serves static dashboard, demo, marketing pages and handles rewrites & local api calls.
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// Load .env.development.local if present
const envPath = path.join(__dirname, ".env.development.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const REWRITES = {
  "/": "/index.html",
  "/app": "/app.html",
  "/admin": "/admin.html",
  "/privacy": "/privacy.html",
  "/terms": "/terms.html"
};

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = parsed.pathname || "/";

  // Rewrites
  if (REWRITES[pathname]) {
    pathname = REWRITES[pathname];
  }

  // Handle API routes
  if (pathname.startsWith("/api/")) {
    const parts = pathname.slice(5).split("/");
    const endpoint = parts[0];
    const apiFile = path.join(__dirname, "api", endpoint + ".js");
    if (fs.existsSync(apiFile)) {
      let bodyData = "";
      req.on("data", (chunk) => { bodyData += chunk; });
      req.on("end", async () => {
        req.query = parsed.query || {};
        if (bodyData) {
          try { req.body = JSON.parse(bodyData); } catch (e) { req.body = bodyData; }
        } else {
          req.body = {};
        }
        try {
          const handler = require(apiFile);
          await handler(req, res);
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      });
      return;
    }
  }

  // Handle static files
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end("Not Found: " + pathname);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("content-type", MIME[ext] || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n=======================================================");
  console.log("  🚀 Qlarity Local Server running at:");
  console.log(`  - Landing page:     http://localhost:${PORT}/`);
  console.log(`  - App Dashboard:    http://localhost:${PORT}/app`);
  console.log(`  - Admin Console:    http://localhost:${PORT}/admin`);
  console.log("=======================================================\n");
});

