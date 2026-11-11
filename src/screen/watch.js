// One look at the screen: ask which window is in front, and only if it is an allowed AI chat, read its text.
import { identify } from "./sites.js";
import { createObserver } from "./observer.js";

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
      if (!tool) return { skipped: "not_allowed" };            // the window's content is never requested
      let snapshot;
      try { snapshot = await probe.tree({ engine: sc.engine || "auto", build: false, maxNodes: 3000, timeoutMs: 30000 }); } catch (e) { return { skipped: "probe_error", error: String((e && e.message) || e).slice(0, 200) }; }
      const mode = sc.storeMode === "full" || sc.storeMode === "off" ? sc.storeMode : "redacted";
      if (!observer || observerMode !== mode) { observer = createObserver({ now, mode }); observerMode = mode; }
      const res = observer.feed(snapshot, tool);
      if (res.rePrompts.length || res.sessions.length) {
        const d = await storage.local.get(["rePrompts", "aiSessions", "settings"]);
        const settings = d.settings || {};
        const agents = Array.isArray(settings.agents) ? settings.agents : [];
        const patch = { rePrompts: mergeById(d.rePrompts, res.rePrompts), aiSessions: mergeById(d.aiSessions, res.sessions) };
        if (!agents.includes(tool.name)) patch.settings = { ...settings, agents: agents.concat([tool.name]) };
        await storage.local.set(patch);
      }
      return { tool: tool.id, basis: tool.basis, rePrompts: res.rePrompts.length, labels: res.labels.length };
    } finally { busy = false; }
  };
}
