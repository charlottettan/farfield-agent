// Watches a chat across repeated looks at the screen and produces the same records the browser extension does:
// one session per task (so a chat with two tasks gives two sessions) and one re-prompt per follow-up that is a correction.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { extractTurns } from "./turns.js";
import { classifyTurn, countsAsRework } from "./classify.js";

const require = createRequire(import.meta.url);
const A = require("../../vendor/analysis.js");

const h = (s) => crypto.createHash("sha256").update(s).digest("hex");
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const RECENT_MS = 12 * 3600 * 1000;

// mode: how follow-up wording is kept on this computer. "redacted" masks names, numbers and emails; "off" keeps no wording.
export function createObserver({ now = Date.now, mode = "redacted", user = "You" } = {}) {
  const convs = [];

  function keysOf(turns) {
    const seen = {};
    return turns.map((t) => { const k = t.role + "|" + norm(t.text); seen[k] = (seen[k] || 0) + 1; return h(k + "#" + seen[k]).slice(0, 16); });
  }

  function find(tool, keys, t) {
    let best = null, bestOverlap = 0;
    for (const c of convs) {
      if (c.tool.id !== tool.id || t - c.lastAt > RECENT_MS) continue;
      const overlap = keys.filter((k) => c.keys.has(k)).length;
      if (overlap > bestOverlap) { best = c; bestOverlap = overlap; }
    }
    return best;
  }

  function sessionRecord(c, ep, t) {
    return {
      id: "scr_" + h(c.id + ":" + ep.n).slice(0, 14), site: c.tool.name, workflow: "Unassigned workflow",
      startedAt: ep.startedAt, lastAt: t, attempts: 1 + ep.corrections, regens: 0,
      gapSeconds: Math.round(ep.reviewSeconds), done: false, source: "live",
    };
  }

  // snapshot: { nodes: [...] }   tool: { id, name } from identify()
  function feed(snapshot, tool) {
    const t = now();
    const { turns } = extractTurns(snapshot, tool);
    const out = { rePrompts: [], sessions: [], labels: [] };
    if (!turns.length) return out;
    const keys = keysOf(turns);
    let c = find(tool, keys, t);
    if (!c) {
      const first = turns.find((x) => x.role === "user");
      c = { id: "c_" + h(tool.id + "|" + (first ? norm(first.text) : keys[0])).slice(0, 12), tool, keys: new Set(), userCount: 0, lastAt: t, episodes: [], prev: { user: "", assistant: "" }, assistantSeenAt: 0 };
      convs.push(c);
    }
    c.lastAt = t;

    turns.forEach((turn, i) => {
      const k = keys[i];
      if (c.keys.has(k)) return;
      c.keys.add(k);
      if (turn.role === "assistant") { c.prev.assistant = turn.text; c.assistantSeenAt = t; return; }

      c.userCount++;
      if (c.userCount === 1) {                                   // the first prompt is not a re-prompt
        c.episodes.push({ n: 0, startedAt: t, corrections: 0, reviewSeconds: 0 });
        c.prev.user = turn.text;
        return;
      }
      const gap = c.assistantSeenAt ? (t - c.assistantSeenAt) / 1000 : 0;
      const cls = classifyTurn(turn.text, c.prev, gap);
      out.labels.push({ text: turn.text, ...cls });
      if (cls.label === "new_task") {
        c.episodes.push({ n: c.episodes.length, startedAt: t, corrections: 0, reviewSeconds: 0 });
        c.prev = { user: turn.text, assistant: "" };
        return;
      }
      const ep = c.episodes[c.episodes.length - 1];
      c.prev.user = turn.text;
      if (!countsAsRework(cls)) return;                          // questions, additions, thanks and unsure messages are not rework
      ep.corrections++;
      ep.reviewSeconds += Math.min(gap, 600);
      const sessionId = "scr_" + h(c.id + ":" + ep.n).slice(0, 14);
      const rec = A.buildRePrompt({
        id: "scrp_" + h(sessionId + k).slice(0, 14), sessionId, site: tool.name, workflow: "Unassigned workflow",
        attemptIndex: ep.corrections + 1, kind: "followup", text: turn.text, mode, now: t, user, reviewSec: gap, source: "live",
      });
      if (rec) out.rePrompts.push(rec);
    });

    for (const ep of c.episodes) if (ep.corrections > 0 || ep.n === c.episodes[c.episodes.length - 1].n) out.sessions.push(sessionRecord(c, ep, t));
    return out;
  }

  return { feed, conversations: () => convs.length };
}
