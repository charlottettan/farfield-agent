// One look at the screen: ask which window is in front, and only if it is an allowed AI chat, read its text.
import crypto from "node:crypto";
import { identify, chatTitle } from "./sites.js";
import { createObserver } from "./observer.js";
import { hintsFor } from "./adapters/index.js";
import { titleShape, cleanTitle } from "./sites.js";

function mergeById(existing, incoming) {
  const map = new Map((Array.isArray(existing) ? existing : []).map((x) => [x.id, x]));
  for (const x of incoming) if (x && x.id) map.set(x.id, x);
  return [...map.values()];
}

export function createScreenStep({ storage, probe, now = Date.now, getConfig, log = () => {} }) {
  let observer = null, observerMode = "", lastAt = 0, busy = false;

  return async function step() {
    const cfg = getConfig();
    const sc = cfg.screen || {};
    if (!sc.enabled) return { skipped: "off" };
    if (cfg.paused) return { skipped: "paused" };
    const t = now();
    if (busy || t - lastAt < Math.max(2, Number(sc.intervalSeconds) || 10) * 1000) return { skipped: "too_soon" };
    busy = true; lastAt = t;
    try {
      let win;
      try { win = await probe.title(); } catch (e) { return { skipped: "probe_error", error: String((e && e.message) || e).slice(0, 200) }; }
      const tool = identify(win, sc.tools);
      if (!tool) return { skipped: "not_allowed", app: cleanTitle(win && win.app).slice(0, 60), titleShape: titleShape(win && win.title) };            // the window's content is never requested
      let snapshot;
      try { snapshot = await probe.tree({ engine: sc.engine || "auto", build: false, maxNodes: 6000, timeoutMs: 30000, ...hintsFor(tool.id) }); } catch (e) { return { skipped: "probe_error", error: String((e && e.message) || e).slice(0, 200) }; }
      const mode = sc.storeMode === "full" || sc.storeMode === "off" ? sc.storeMode : "redacted";
      if (!observer || observerMode !== mode + "|" + (sc.workflowNames || "task")) {
        // What a chat looked like last time is remembered as salted fingerprints only (no text), so a restart does not lose track of it.
        const saved = await storage.local.get(["observerState", "observerSalt"]);
        let salt = saved.observerSalt;
        if (typeof salt !== "string" || salt.length < 16) { salt = crypto.randomBytes(16).toString("hex"); await storage.local.set({ observerSalt: salt }); }
        const naming = sc.workflowNames === "tool" || sc.workflowNames === "first-prompt" ? sc.workflowNames : "task";
        observer = createObserver({ now, mode, salt, state: saved.observerState, naming });
        observerMode = mode + "|" + (sc.workflowNames || "task");
      }
      const res = observer.feed(snapshot, tool, { title: chatTitle(win, tool) });
      const patch = {};
      if (res.rePrompts.length || res.sessions.length) {
        const d = await storage.local.get(["rePrompts", "aiSessions", "settings"]);
        const settings = d.settings || {};
        const agents = Array.isArray(settings.agents) ? settings.agents : [];
        patch.rePrompts = mergeById(d.rePrompts, res.rePrompts);
        patch.aiSessions = mergeById(d.aiSessions, res.sessions);
        if (!agents.includes(tool.name)) patch.settings = { ...settings, agents: agents.concat([tool.name]) };
      }
      if (res.changed) patch.observerState = observer.snapshot();
      if (Object.keys(patch).length) await storage.local.set(patch);
      return { tool: tool.id, basis: tool.basis, engine: snapshot.engine || "", seen: res.seen, rePrompts: res.rePrompts.length, labels: res.labels.length, fellBack: snapshot.fellBack || "" };
    } finally { busy = false; }
  };
}
