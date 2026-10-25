// Local test server: serves public/ and the API routes the same way Vercel does.
// Run with `npm run dev`, then open http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local (or .env) so ANTHROPIC_API_KEY works locally without exporting it.
for (const name of [".env.local", ".env"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}

const routes = {
  "/api/run": (await import("./api/run.js")).default,
  "/api/health": (await import("./api/health.js")).default
};
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain" };
const MAX_BODY = 4.5 * 1024 * 1024; // Vercel's request body limit

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = routes[url.pathname];
  if (route) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.statusCode = 413; return res.end(JSON.stringify({ code: "too_large" })); }
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = raw; }
    return route(req, res);
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.join(root, "public", rel);
  if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end("Not found");
  }
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT) || 3000, () => {
  console.log(`Process X-Ray running at http://localhost:${Number(process.env.PORT) || 3000}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("Note: ANTHROPIC_API_KEY is not set, so analyses will report that the service isn't configured.");
});
