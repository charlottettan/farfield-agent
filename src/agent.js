// The Farfield desktop agent core.
//
// What it does: looks at a few folders you choose. When a new Excel, Word or PowerPoint file appears there, it keeps a
// private copy as the "AI version". When that file is later saved with changes, it works out what changed (using the
// same comparison code as the browser extension) and stores the list of changes. If you have joined a company, the
// extension's own sync code sends those records, with the company's privacy mode applied first.
//
// What it does NOT do: read the screen, log keystrokes, take screenshots, or open any file outside the folders you chose.
// Files that were already in a folder when the agent first ran are ignored.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createFileStorage } from "./storage.js";
import { loadConfig } from "./config.js";
import { createProbe } from "./screen/probe.js";
import { createScreenStep } from "./screen/watch.js";

const require = createRequire(import.meta.url);
const A = require("../vendor/analysis.js");
const Files = require("../vendor/office-files.js");
const SyncFactory = require("../vendor/sync.js");

const inflateRaw = promisify(zlib.inflateRaw);
const inflate = async (bytes) => new Uint8Array(await inflateRaw(bytes));
const OFFICE = /\.(xlsx|xlsm|docx|pptx)$/i;
const DAY = 86400000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const keyOf = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

export function createAgent({ home, fetch: fetchImpl = globalThis.fetch, now = Date.now, log = () => {}, probe } = {}) {
  const storage = createFileStorage(path.join(home, "data.json"));
  const sync = SyncFactory.createSync({ chrome: { storage }, fetch: fetchImpl, now, A });
  const baseDir = path.join(home, "baselines");
  const screenStep = createScreenStep({ storage, probe: probe || createProbe(), now, getConfig: () => loadConfig(home), log });

  function listFiles(cfg) {
    const out = new Map();
    function walk(dir, level) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        // temporary and hidden files (Office's "~$" lock files, partial downloads) are never looked at
        if (e.name.startsWith(".") || e.name.startsWith("~$") || /\.tmp$/i.test(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (level < cfg.depth) walk(full, level + 1); continue; }
        if (!e.isFile() || !OFFICE.test(e.name)) continue;
        try {
          const st = fs.statSync(full);
          out.set(keyOf(full), { full, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished while scanning */ }
      }
    }
    cfg.folders.forEach((d) => walk(d, 0));
    return [...out.values()];
  }

  function dropBaseline(rec, st) {
    if (!rec.baseline) return;
    const stillUsed = Object.values(st.files).some((o) => o !== rec && o.state === "tracking" && o.baseline && o.baseline.hash === rec.baseline.hash);
    if (!stillUsed) { try { fs.unlinkSync(rec.baseline.file); } catch { /* already gone */ } }
    rec.baseline = { hash: rec.baseline.hash, at: rec.baseline.at };
  }

  function workflowName(fileName) {
    return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s*\(\d+\)\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  async function upsert(res, rec, en, t, cfg) {
    const d = await storage.local.get(["fileRuns", "corrections", "sends"]);
    // the id depends on the file's location as well as its starting version, so two files that began identical stay separate
    const bh = sha(Buffer.from(keyOf(rec.path) + "|" + rec.baseline.hash)).slice(0, 16);
    const runs = Array.isArray(d.fileRuns) ? d.fileRuns : [];
    const corrs = Array.isArray(d.corrections) ? d.corrections : [];
    const sends = Array.isArray(d.sends) ? d.sends : [];
    // One record per followed file, updated on every later save, so saving ten times is still one correction.
    const prior = runs.find((r) => r.id === "fr_" + bh);
    const run = { ...res.run, id: "fr_" + bh, createdAt: prior ? prior.createdAt : res.run.createdAt, source: "live" };
    let corr = null;
    if (res.correction) {
      const priorCorr = corrs.find((c) => c.id === "f_" + bh);
      corr = { ...res.correction, id: "f_" + bh, source: "live" };
      if (priorCorr && priorCorr.t) corr.t = priorCorr.t;
      run.corrId = corr.id;
    }
    let send = res.send ? { ...res.send } : null;
    if (send) {
      if (rec.send) send = { ...send, ...rec.send };
      else rec.send = { t: send.t, category: send.category, agent: send.agent, surface: send.surface };
    }
    const sameSend = (s) => rec.send && s.t === rec.send.t && s.agent === rec.send.agent && s.category === rec.send.category && s.surface === rec.send.surface;
    // the dashboard filters by agent name, so the name has to be in its list
    const settings = (await storage.local.get("settings")).settings || {};
    const agents = Array.isArray(settings.agents) ? settings.agents : [];
    const agentName = run.agent || cfg.agentName;
    if (agentName && !agents.includes(agentName)) await storage.local.set({ settings: { ...settings, agents: agents.concat([agentName]) } });
    await storage.local.set({
      fileRuns: runs.filter((r) => r.id !== run.id).concat([run]),
      corrections: corr ? corrs.filter((c) => c.id !== corr.id).concat([corr]) : corrs,
      sends: send ? sends.filter((s) => !sameSend(s)).concat([send]) : sends,
    });
    log("recorded", { file: en.name, changed: res.totals.changed });
  }

  // One pass over the chosen folders. Called every few seconds by run(), or once by `scan`.
  async function scanOnce() {
    const cfg = loadConfig(home);
    if (cfg.paused) return { paused: true, baselined: 0, recorded: 0, tracking: 0 };
    const t = now();
    const stored = await storage.local.get("agent");
    const st = stored.agent && stored.agent.files ? stored.agent : { initialized: false, files: {} };
    const first = !st.initialized;
    const entries = listFiles(cfg);
    const seen = new Set();
    let baselined = 0, recorded = 0;

    for (const en of entries) {
      const key = keyOf(en.full);
      seen.add(key);
      const sig = en.size + ":" + Math.round(en.mtimeMs);
      let rec = st.files[key];
      if (!rec) {
        // files that were already there when the agent first ran are not AI output we saw arrive, so they are left alone
        st.files[key] = first
          ? { state: "ignored", reason: "already there when the agent started", path: en.full, sig }
          : { state: "pending", path: en.full, name: en.name, firstSeen: t, sig, stable: 0, attempts: 0 };
        continue;
      }
      if (rec.state !== "pending" && rec.state !== "tracking") continue;
      rec.missing = 0;
      if (rec.sig !== sig) { rec.sig = sig; rec.stable = 0; continue; }   // still being written: wait until it stops changing
      rec.stable = (rec.stable || 0) + 1;
      if (rec.stable < 1 || rec.processedSig === sig) continue;
      if (en.size > MAX_FILE_BYTES) { rec.state = "ignored"; rec.reason = "file too large"; continue; }

      let buf;
      try { buf = fs.readFileSync(en.full); } catch { rec.attempts = (rec.attempts || 0) + 1; if (rec.attempts >= 12) { rec.state = "ignored"; rec.reason = "could not be opened"; } continue; }

      if (rec.state === "pending") {
        try { await Files.readOfficeFile(buf, en.name, inflate); }
        catch { rec.attempts = (rec.attempts || 0) + 1; if (rec.attempts >= 6) { rec.state = "ignored"; rec.reason = "not an Office file the agent can read"; } continue; }
        const hash = sha(buf);
        fs.mkdirSync(baseDir, { recursive: true });
        const bf = path.join(baseDir, hash + path.extname(en.name).toLowerCase());
        if (!fs.existsSync(bf)) fs.writeFileSync(bf, buf, { mode: 0o600 });
        rec.state = "tracking";
        rec.baseline = { hash, file: bf, at: t, mtimeMs: en.mtimeMs };
        rec.lastHash = hash;
        rec.processedSig = sig;
        baselined++;
        continue;
      }

      // tracking: the file has been saved again
      rec.processedSig = sig;
      const hash = sha(buf);
      if (hash === rec.lastHash) continue;
      rec.lastHash = hash;
      if (hash === rec.baseline.hash) continue;                           // changed back to the AI version
      try {
        const before = await Files.readOfficeFile(fs.readFileSync(rec.baseline.file), en.name, inflate);
        const after = await Files.readOfficeFile(buf, en.name, inflate);
        const res = Files.compareFiles(before, after, {
          workflow: workflowName(en.name), agent: cfg.agentName, fileName: en.name, now: t,
          aiModified: rec.baseline.mtimeMs, finalModified: en.mtimeMs,
        });
        if (res.totals.changed > 0) { await upsert(res, rec, en, t, cfg); recorded++; }
        rec.lastError = "";
      } catch (e) { rec.lastError = String((e && e.message) || e).slice(0, 200); }
    }

    // housekeeping: expire old baselines, notice files that went away
    for (const [key, rec] of Object.entries(st.files)) {
      if (rec.state !== "tracking") continue;
      if (rec.baseline && t - rec.baseline.at > cfg.baselineDays * DAY) { rec.state = "expired"; dropBaseline(rec, st); continue; }
      if (!seen.has(key)) { rec.missing = (rec.missing || 0) + 1; if (rec.missing >= 3) { rec.state = "gone"; dropBaseline(rec, st); } }
    }

    st.initialized = true;
    st.lastScanAt = t;
    await storage.local.set({ agent: st });
    const tracking = Object.values(st.files).filter((r) => r.state === "tracking").length;
    return { paused: false, baselined, recorded, tracking };
  }

  // A one-line note of what the last look at the screen did (never any content), so "why is nothing showing up?" has an answer.
  async function rememberScreen(r) {
    if (!r || ["off", "too_soon", "paused"].includes(r.skipped)) return;
    const next = { skipped: r.skipped || "", tool: r.tool || "", seen: r.seen || 0, rePrompts: r.rePrompts || 0, labels: r.labels || 0, error: r.error || "", engine: r.engine || "", app: r.app || "", titleShape: r.titleShape || "" };
    const d = await storage.local.get(["screenLast", "screenLog"]);
    const prev = d.screenLast;
    const same = prev && ["skipped", "tool", "seen", "rePrompts", "labels", "error", "app", "titleShape"].every((k) => (prev[k] || "") === (next[k] || ""));
    if (same && now() - (prev.at || 0) <= 60000) return;
    // Keeps the last 40 distinct looks: when it started, when it was last seen the same, what it was (the front app, the shape of its title,
    // how many messages were on screen, how many were new, how many counted). Never message text or a real title.
    let log = Array.isArray(d.screenLog) ? d.screenLog.slice() : [];
    if (same && log.length) log[log.length - 1] = { ...log[log.length - 1], lastAt: now() };
    else log.push({ ...next, at: now(), lastAt: now() });
    await storage.local.set({ screenLast: { ...next, at: now() }, screenLog: log.slice(-40) });
  }

  async function tick() {
    const scan = await scanOnce();
    // paused means paused: nothing is read and nothing is sent
    if (scan.paused) return { scan, synced: { ok: true, skipped: "paused" } };
    // reading chat windows is off unless the person turned it on; errors here never stop the file watching
    let screen = { skipped: "off" };
    try { screen = await screenStep(); } catch (e) { screen = { skipped: "error", error: String((e && e.message) || e).slice(0, 200) }; }
    await rememberScreen(screen);
    const synced = await sync.syncNow();
    return { scan, synced, screen };
  }

  async function status() {
    const cfg = loadConfig(home);
    const d = await storage.local.get("agent");
    const files = (d.agent && d.agent.files) || {};
    const by = {};
    Object.values(files).forEach((r) => { by[r.state] = (by[r.state] || 0) + 1; });
    const co = await sync.status();
    // sample rows (source "seed") are never counted as things this computer found
    const runs = ((await storage.local.get("fileRuns")).fileRuns || []).filter((r) => r && r.source !== "seed");
    // counts and file names only: never the wording of what changed
    const recorded = {
      count: runs.length,
      latest: runs.slice(-5).reverse().map((r) => ({ file: r.fileName, surface: r.surface, changedCells: r.changedCells, minutes: r.estimatedMinutes })),
    };
    return {
      paused: !!cfg.paused, screen: { enabled: !!(cfg.screen && cfg.screen.enabled), storeMode: (cfg.screen && cfg.screen.storeMode) || "redacted", last: (await storage.local.get("screenLast")).screenLast || null }, recorded, folders: cfg.folders, fileTypes: [".xlsx", ".xlsm", ".docx", ".pptx"], files: by,
      lastScanAt: (d.agent && d.agent.lastScanAt) || 0, company: co, pending: co.joined ? await sync.pending() : 0,
      dataFile: storage.file,
    };
  }

  return {
    scanOnce, tick, status, sync, storage, home, fetch: fetchImpl,
    deviceLabel: "Farfield desktop agent (" + os.platform() + ")",
  };
}
