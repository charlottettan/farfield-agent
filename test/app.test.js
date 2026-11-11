import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startApp } from "../src/app.js";
import { saveConfig, defaults, loadConfig } from "../src/config.js";

function tmpHome(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-app-"));
  const home = path.join(root, "home"), watch = path.join(root, "Downloads");
  fs.mkdirSync(watch, { recursive: true });
  saveConfig(home, { ...defaults(), folders: [watch], pollSeconds: 1, ...extra });
  return { root, home, watch };
}

async function boot(opts = {}) {
  const h = opts.h || tmpHome();
  if (opts.seed) { fs.mkdirSync(h.home, { recursive: true }); fs.writeFileSync(path.join(h.home, "data.json"), JSON.stringify(opts.seed)); }
  const app = await startApp({ home: h.home, port: 0, open: false });
  const base = `http://127.0.0.1:${app.port}`;
  const entry = await fetch(app.url, { redirect: "manual" });
  const cookie = (entry.headers.get("set-cookie") || "").split(";")[0];
  const call = (p, body, extra = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-farfield": "1", cookie, ...extra }, body: JSON.stringify(body || {}) });
  const get = (p, extra = {}) => fetch(base + p, { headers: { cookie, ...extra }, redirect: "manual" });
  return { app, base, cookie, call, get, entry, h };
}

test("the entry link works once, sets a cookie, and nothing works without it", async (t) => {
  const { app, base, cookie, entry, get } = await boot(); t.after(() => app.stop());
  assert.equal(entry.status, 302);
  assert.match(cookie, /^ff_session=[a-f0-9]{64}$/);
  assert.match(entry.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(entry.headers.get("set-cookie"), /SameSite=Strict/i);
  const again = await fetch(app.url, { redirect: "manual" });            // same link a second time
  assert.equal(again.status, 403);
  const wrong = await fetch(base + "/?t=" + "0".repeat(48), { redirect: "manual" });
  assert.equal(wrong.status, 403);
  for (const p of ["/panel.html", "/dashboard.html", "/shim.js", "/api/agent/status"]) assert.equal((await fetch(base + p)).status, 401, p);
  assert.equal((await get("/panel.html")).status, 200);
});

test("requests with a foreign Host header are refused (DNS rebinding)", async (t) => {
  const { app, cookie } = await boot(); t.after(() => app.stop());
  const status = await new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: app.port, path: "/panel.html", headers: { host: "evil.example.com", cookie } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject); r.end();
  });
  assert.equal(status, 403);
});

test("changing anything needs the custom header and a matching origin", async (t) => {
  const { app, base, cookie, call } = await boot(); t.after(() => app.stop());
  const noHeader = await fetch(base + "/api/agent/pause", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(noHeader.status, 403);
  const foreign = await call("/api/agent/pause", {}, { origin: "https://evil.example.com" });
  assert.equal(foreign.status, 403);
  assert.equal(loadConfig(app.agent.home).paused, false);                  // neither request changed anything
  const fine = await call("/api/agent/pause", {}, { origin: base });
  assert.equal(fine.status, 200);
  assert.equal(loadConfig(app.agent.home).paused, true);
});

test("data endpoints only accept POST, and the server never answers CORS preflights", async (t) => {
  const { app, base, get, cookie } = await boot(); t.after(() => app.stop());
  assert.equal((await get("/api/storage/get")).status, 405);
  const pre = await fetch(base + "/api/storage/get", { method: "OPTIONS", headers: { cookie, origin: "https://evil.example.com", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 405);
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
});

test("only the app's own files are served, never the data file or anything outside", async (t) => {
  const { app, get } = await boot(); t.after(() => app.stop());
  for (const p of ["/data.json", "/../data.json", "/%2e%2e/data.json", "/..%2fdata.json", "/baselines/x", "/config.json", "/src/agent.js", "/vendor/sync.js"]) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal((await get("/fonts/")).status, 404);
});

test("pages carry a strict content security policy and the dashboard loads the shim first", async (t) => {
  const { app, get } = await boot(); t.after(() => app.stop());
  const panel = await get("/panel.html");
  const csp = panel.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(panel.headers.get("cache-control"), "no-store");
  const html = await (await get("/dashboard.html")).text();
  const shimAt = html.indexOf('<script src="/shim.js"></script>');
  assert.ok(shimAt > 0);
  assert.ok(shimAt < html.indexOf('src="theme.js"'));
  assert.ok(shimAt < html.indexOf('src="sync.js"'));
});

test("starting the app adds the sample company, and keeps real corrections that were already there", async (t) => {
  const seed = { fileRuns: [{ id: "fr_real", source: "live", fileName: "mine.xlsx", surface: "Excel", changedCells: 3 }], corrections: [{ id: "f_real", source: "live", timestamp: Date.now() }] };
  const { app, call } = await boot({ seed }); t.after(() => app.stop());
  const d = (await (await call("/api/storage/get", { keys: null })).json()).data;
  assert.equal(d.fixes.length, 14);
  assert.ok(d.corrections.length > 1000);
  assert.ok(d.fileRuns.some((r) => r.id === "fr_real"));
  assert.ok(d.corrections.some((c) => c.id === "f_real"));
  assert.equal(d.sampleSeeded, true);
});

test("storage reads and writes round-trip through the API and reach the data file", async (t) => {
  const { app, call, h } = await boot(); t.after(() => app.stop());
  await call("/api/storage/set", { items: { viewMode: "mine", note: { a: [1, 2] } } });
  const r = await (await call("/api/storage/get", { keys: ["viewMode", "note", "nothing"] })).json();
  assert.deepEqual(r.data, { viewMode: "mine", note: { a: [1, 2] } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(h.home, "data.json"), "utf8"));
  assert.deepEqual(onDisk.note, { a: [1, 2] });
  await call("/api/storage/remove", { keys: ["note"] });
  assert.deepEqual((await (await call("/api/storage/get", { keys: "note" })).json()).data, {});
  assert.equal((await call("/api/storage/set", {})).status, 400);
});

test("oversized and malformed bodies are refused", async (t) => {
  const { app, call, base, cookie } = await boot(); t.after(() => app.stop());
  const big = await call("/api/storage/set", { items: { x: "a".repeat(13 * 1024 * 1024) } }).catch((e) => ({ status: 0, err: e }));
  assert.ok(big.status === 413 || big.status === 0);
  const bad = await fetch(base + "/api/storage/get", { method: "POST", headers: { cookie, "x-farfield": "1", "content-type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
});

test("pausing stops the loop's work, and the status says so", async (t) => {
  const { app, call, get } = await boot(); t.after(() => app.stop());
  const before = await (await get("/api/agent/status")).json();
  assert.equal(before.paused, false);
  assert.equal(before.running, true);
  const after = await (await call("/api/agent/pause")).json();
  assert.equal(after.paused, true);
  assert.equal(after.running, false);
  assert.deepEqual((await app.agent.tick()).synced, { ok: true, skipped: "paused" });
  const resumed = await (await call("/api/agent/resume")).json();
  assert.equal(resumed.paused, false);
});

test("folders: a real folder can be added and removed, a missing one is refused", async (t) => {
  const { app, call, h } = await boot(); t.after(() => app.stop());
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "ff-extra-"));
  const bad = await call("/api/agent/folders", { action: "add", path: path.join(extra, "nope") });
  assert.equal(bad.status, 400);
  const added = await (await call("/api/agent/folders", { action: "add", path: extra })).json();
  assert.ok(added.folders.includes(extra));
  const removed = await (await call("/api/agent/folders", { action: "remove", path: extra })).json();
  assert.ok(!removed.folders.includes(extra));
  assert.ok(removed.folders.includes(h.watch));
});

test("the company proxy only reaches the joined company's address", async (t) => {
  const seen = [];
  const company = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ hello: "company" })); });
  await new Promise((r) => company.listen(0, "127.0.0.1", r));
  t.after(() => company.close());
  const other = http.createServer((req, res) => { seen.push({ other: true }); res.end("no"); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  t.after(() => other.close());
  const { app, call } = await boot(); t.after(() => app.stop());

  assert.equal((await call("/api/proxy", { url: `http://127.0.0.1:${company.address().port}/v1/me` })).status, 409);   // not joined yet
  await call("/api/storage/set", { items: { company: { server: `http://127.0.0.1:${company.address().port}`, token: "tok" } } });
  const ok = await (await call("/api/proxy", { url: `http://127.0.0.1:${company.address().port}/v1/me`, headers: { authorization: "Bearer tok", cookie: "x=1" } })).json();
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { hello: "company" });
  assert.equal(seen[0].auth, "Bearer tok");
  const blocked = await call("/api/proxy", { url: `http://127.0.0.1:${other.address().port}/steal` });
  assert.equal(blocked.status, 403);
  assert.ok(!seen.some((s) => s.other));
  assert.equal((await call("/api/proxy", { url: "file:///etc/passwd" })).status, 403);
});

test("reset replaces only sample rows; clear removes everything and the sample does not come back after a restart", async (t) => {
  const seed = { fileRuns: [{ id: "fr_real", source: "live", fileName: "mine.xlsx" }] };
  const h = tmpHome();
  let b = await boot({ h, seed });
  assert.equal((await b.call("/api/message", { type: "RESET_DEMO_DATA" })).status, 200);
  let d = (await (await b.call("/api/storage/get", { keys: null })).json()).data;
  assert.ok(d.fileRuns.some((r) => r.id === "fr_real"));
  assert.equal(d.fixes.length, 14);
  assert.equal((await b.call("/api/message", { type: "CLEAR_DATA" })).status, 200);
  d = (await (await b.call("/api/storage/get", { keys: ["fixes", "corrections", "fileRuns"] })).json()).data;
  assert.deepEqual([d.fixes.length, d.corrections.length, d.fileRuns.length], [0, 0, 0]);
  await b.app.stop();
  b = await boot({ h });                                                   // restart
  t.after(() => b.app.stop());
  d = (await (await b.call("/api/storage/get", { keys: ["fixes"] })).json()).data;
  assert.equal(d.fixes.length, 0);
});

test("joining needs explicit consent", async (t) => {
  const { app, call } = await boot(); t.after(() => app.stop());
  const r = await call("/api/agent/join", { server: "http://127.0.0.1:1", code: "X", email: "a@b.co" });
  assert.equal(r.status, 400);
});

test("the dashboard's sample-data banner describes what this app actually does", async (t) => {
  const { app, get } = await boot(); t.after(() => app.stop());
  const js = await (await get("/dashboard.js")).text();
  assert.ok(js.includes("corrections in your Excel, Word and PowerPoint files"));
  assert.ok(!js.includes("Gmail and AI chat sites"));
});
