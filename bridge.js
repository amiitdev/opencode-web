#!/usr/bin/env node
/**
 * bridge.js — the glue between the browser and the real OpenCode server.
 *
 * Two jobs:
 *   1. Serve the static UI (./public) on http://127.0.0.1:5175/
 *   2. Forward every /oc/... request to the OpenCode server (/oc/session -> /session)
 *
 * The proxy exists so the page is same-origin: no CORS, no auth headers
 * to juggle, and SSE streams pass through untouched.
 *
 * Run:  node bridge.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5175;
const OPENCODE = process.env.OPENCODE_URL || "http://127.0.0.1:4321";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let file = req.url.split("?")[0];
  if (file === "/" || file === "") file = "/index.html";
  const abs = path.join(__dirname, "public", path.normalize(file));
  if (!abs.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
    res.end(data);
  });
}

function proxy(req, res) {
  // /oc/session/abc -> /session/abc  (query string preserved)
  const target = OPENCODE + req.url.replace(/^\/oc/, "");

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;

  const upstream = http.request(
    target,
    { method: req.method, headers },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res, { end: true }); // streams SSE chunks as they arrive
    }
  );

  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ bridge_error: String(e) }));
  });

  req.pipe(upstream, { end: true });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/oc/")) proxy(req, res);
  else serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`opencode-web bridge  ->  http://127.0.0.1:${PORT}`);
  console.log(`forwarding /oc/*     ->  ${OPENCODE}`);
});
