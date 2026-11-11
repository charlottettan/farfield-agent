// The local Farfield app: a small web server that only listens on this computer.
//
// Why it is built defensively: any web page you visit can try to send requests to http://127.0.0.1. So every request is
// checked for (1) a session cookie that only the person who opened the one-time link has, (2) the expected Host header,
// which blocks DNS-rebinding tricks, and (3) for anything that changes data, a custom header plus a matching Origin,
// which a foreign page cannot send without a CORS preflight that this server never approves.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { resetSample, clearRecords } from "./sample.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "web");
const MAX_BODY = 12 * 1024 * 1024;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function listFiles(dir, base = dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out);
    else out.set("/" + path.relative(base, full).split(path.sep).join("/"), full);
  }
  return out;
}

const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createAppServer({ agent, home, token, getLoop = () => ({ running: false }), onChange = () => {} }) {
  const files = new Map();
  for (const [k, v] of listFiles(path.join(WEB, "dashboard"))) files.set(k, v);          // /dashboard.html, /fonts/...
  for (const n of ["panel.html", "panel.js", "shim.js"]) files.set("/" + n, path.join(WEB, n));

  let entryToken = token;                       // one-time: cleared as soon as it is used
  const sessions = new Set();
  let allowedHosts = new Set();
  let origin = "";
  let stamp = 0;

  const send = (res, status, body, type = "application/json", extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { "content-type": type, "content-length": buf.length, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": CSP, ...extra });
    res.end(buf);
  };
  const fail = (res, status, msg) => send(res, status, { error: msg });

  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });

  const cookieOf = (req) => { const m = /(?:^|;\s*)ff_session=([a-f0-9]{64})/.exec(req.headers.cookie || ""); return m ? m[1] : ""; };

  async function statusPayload() {
    const st = await agent.status();
    const loop = getLoop();
    const cfg = loadConfig(home);
    return { ...st, running: !!loop.running && !cfg.paused, loopRunning: !!loop.running, lastTickAt: loop.lastTickAt || 0, pollSeconds: cfg.pollSeconds };
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const body = req.method === "POST" ? await readBody(req) : {};
    const store = agent.storage.local;

    if (p === "/api/storage/get") { return send(res, 200, { data: await store.get(body.keys == null ? null : body.keys) }); }
    if (p === "/api/storage/set") { if (!body.items || typeof body.items !== "object") return fail(res, 400, "items required"); await store.set(body.items); stamp++; onChange(); return send(res, 200, { ok: true }); }
    if (p === "/api/storage/remove") { await store.remove(body.keys || []); stamp++; return send(res, 200, { ok: true }); }
    if (p === "/api/storage/stamp") { const f = agent.storage.file; let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { /* none yet */ } return send(res, 200, { stamp: m + ":" + stamp }); }

    if (p === "/api/message") {
      if (body.type === "RESET_DEMO_DATA") { await resetSample(agent.storage); return send(res, 200, { ok: true }); }
      if (body.type === "CLEAR_DATA") { await clearRecords(agent.storage); return send(res, 200, { ok: true }); }
      return send(res, 200, { ok: true });
    }

    // The dashboard talks to the company server through here, so the browser page never needs cross-origin access.
    if (p === "/api/proxy") {
      const co = (await store.get("company")).company;
      if (!co || !co.server) return fail(res, 409, "not joined");
      let target;
      try { target = new URL(String(body.url)); } catch { return fail(res, 400, "bad url"); }
      if (target.origin !== new URL(co.server).origin) return fail(res, 403, "only your company's server is allowed");
      const method = String(body.method || "GET").toUpperCase();
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) return fail(res, 405, "method");
      const headers = {};
      for (const [k, v] of Object.entries(body.headers || {})) if (!/^(host|cookie|origin|referer|content-length|connection|transfer-encoding)$/i.test(k)) headers[k] = String(v);
      try {
        const r = await (agent.fetch || fetch)(target.href, { method, headers, body: method === "GET" ? undefined : body.body, signal: AbortSignal.timeout(20000) });
        return send(res, 200, { status: r.status, contentType: r.headers.get("content-type") || "", body: await r.text() });
      } catch (e) { return fail(res, 502, "could not reach the company server"); }
    }

    if (p === "/api/agent/status") return send(res, 200, await statusPayload());
    if (p === "/api/agent/pause" || p === "/api/agent/resume") { const cfg = loadConfig(home); cfg.paused = p.endsWith("pause"); saveConfig(home, cfg); return send(res, 200, await statusPayload()); }
    if (p === "/api/agent/scan") { const r = await agent.tick(); return send(res, 200, { result: r, status: await statusPayload() }); }
    if (p === "/api/agent/folders") {
      const cfg = loadConfig(home);
      const dir = path.resolve(String(body.path || ""));
      if (body.action === "add") {
        let ok = false; try { ok = fs.statSync(dir).isDirectory(); } catch { /* not there */ }
        if (!ok) return fail(res, 400, "That folder doesn't exist.");
        if (!cfg.folders.includes(dir)) cfg.folders.push(dir);
      } else if (body.action === "remove") cfg.folders = cfg.folders.filter((f) => f !== dir);
      else return fail(res, 400, "action");
      saveConfig(home, cfg);
      return send(res, 200, await statusPayload());
    }
    if (p === "/api/agent/join-preview") { try { return send(res, 200, await agent.sync.preview(String(body.server || ""), String(body.code || ""))); } catch (e) { return fail(res, 400, (e && e.message) || "could not check that invite"); } }
    if (p === "/api/agent/join") {
      if (body.consent !== true) return fail(res, 400, "consent is required");
      try { await agent.sync.join({ server: String(body.server || ""), code: String(body.code || ""), email: String(body.email || ""), name: String(body.name || ""), consent: true, deviceLabel: agent.deviceLabel }); return send(res, 200, await statusPayload()); }
      catch (e) { return fail(res, 400, (e && e.message) || "could not join"); }
    }
    if (p === "/api/agent/leave") { try { await agent.sync.leave({ deleteData: body.deleteData === true }); } catch (e) { return fail(res, 400, (e && e.message) || "could not leave"); } return send(res, 200, await statusPayload()); }
    return fail(res, 404, "not found");
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) return fail(res, 403, "bad host");
      const url = new URL(req.url, origin);

      // One-time entry link: swaps the token in the address for a cookie, then goes to the panel.
      if (url.pathname === "/" ) {
        const t = url.searchParams.get("t");
        if (t) {
          if (entryToken && safeEqual(t, entryToken)) {
            entryToken = null;
            const sid = crypto.randomBytes(32).toString("hex");
            sessions.add(sid);
            return send(res, 302, "", "text/plain", { location: "/panel.html", "set-cookie": `ff_session=${sid}; HttpOnly; SameSite=Strict; Path=/` });
          }
          return fail(res, 403, "This link was already used or is wrong. Start the app again to get a new one.");
        }
        if (sessions.has(cookieOf(req))) return send(res, 302, "", "text/plain", { location: "/panel.html" });
        return fail(res, 401, "Open the link printed in the terminal.");
      }

      if (!sessions.has(cookieOf(req))) return fail(res, 401, "Open the link printed in the terminal.");

      if (req.method === "POST") {
        if (req.headers["x-farfield"] !== "1") return fail(res, 403, "missing header");
        const o = req.headers.origin;
        if (o && o !== origin && o !== origin.replace("127.0.0.1", "localhost")) return fail(res, 403, "bad origin");
      } else if (req.method !== "GET") return fail(res, 405, "method");

      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "POST" && !(req.method === "GET" && url.pathname === "/api/agent/status")) return fail(res, 405, "method");
        return await api(req, res, url);
      }
      if (req.method !== "GET") return fail(res, 405, "method");

      let key = url.pathname === "/dashboard" ? "/dashboard.html" : url.pathname;
      const file = files.get(key);
      if (!file) return fail(res, 404, "not found");
      let data = fs.readFileSync(file);
      if (key === "/dashboard.js") {
        // the app finds corrections in files, not in Gmail or chat sites, so the banner should say what is true here
        data = Buffer.from(data.toString("utf8").split("Your own data appears as you use Gmail and AI chat sites.").join("Your own data appears as Farfield finds corrections in your Excel, Word and PowerPoint files."));
      }
      if (key === "/dashboard.html") {
        // the shim has to run before any dashboard script so that chrome.storage etc. exist
        data = Buffer.from(data.toString("utf8").replace(/<head[^>]*>/i, (m) => m + '<script src="/shim.js"></script>'));
      }
      return send(res, 200, data, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    } catch (e) {
      if (e && e.status) return fail(res, e.status, e.message);
      return fail(res, 500, "Something went wrong.");
    }
  });

  return {
    server,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const p = server.address().port;
          allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
          origin = `http://127.0.0.1:${p}`;
          resolve({ port: p, url: `${origin}/?t=${token}` });
        });
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
  };
}
