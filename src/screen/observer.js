// Watches a chat across repeated looks at the screen and produces the same records the browser extension does:
// one session per task (so a chat with two tasks gives two sessions) and one re-prompt per follow-up that is a correction.
//
// Which chat is this? Three things, in order of strength:
//   1. messages on screen that were seen before (matched by a salted one-way fingerprint, never by text)
//   2. a fingerprint of the chat's title (so a chat is still recognised when its early messages have scrolled away)
//   3. nothing: it is a new chat
// What it remembers (snapshot/state) is only fingerprints, counts and times, so a restarted watcher recognises a chat it already knew.
// Is this the first prompt? When the page numbers its messages (Claude: "Message 3 of 8"), message 1 is. Otherwise the first user
// message of a chat it has never seen is, unless an assistant reply comes before it on screen (then the chat began earlier).
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { extractTurns } from "./turns.js";
import { classifyTurn, countsAsRework } from "./classify.js";
import { taskKind, firstSentence } from "./task.js";

const require = createRequire(import.meta.url);
const A = require("../../vendor/analysis.js");

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const WEEK = 7 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const MAX_KEYS = 400;
const MAX_CONVS = 30;

// mode: how follow-up wording is kept on this computer. "redacted" masks names, numbers and emails; "off" keeps no wording.
// salt: makes the fingerprints specific to this computer. state: what snapshot() returned earlier.
//
// naming: what each task (a "workflow") is called. "task" (default): the kind of task it opened with ("Summary", "Email draft"), a label only,
// so the same kind of task groups together across tools and people. "tool": "<Tool> chat". "first-prompt": the opening sentence, masked or not
// following mode (and falling back to the task label when mode keeps no wording).
export function createObserver({ now = Date.now, mode = "redacted", user = "You", salt = "", state = null, naming = "task" } = {}) {
  const h = (s) => crypto.createHash("sha256").update(salt + "|" + s).digest("hex");
  const convs = [];

  function restore(saved) {
    if (!saved || saved.v !== 1 || !Array.isArray(saved.convs)) return;
    for (const s of saved.convs) {
      if (!s || typeof s.id !== "string" || typeof s.tool !== "string" || !Array.isArray(s.keys)) continue;
      convs.push({
        id: s.id, tool: { id: s.tool, name: String(s.name || s.tool) }, titleHash: String(s.titleHash || ""),
        keys: new Set(s.keys.filter((k) => typeof k === "string")), userCount: Number(s.userCount) || 0,
        episodes: (Array.isArray(s.episodes) ? s.episodes : []).map((e) => ({ n: Number(e.n) || 0, startedAt: Number(e.startedAt) || 0, corrections: Number(e.corrections) || 0, reviewSeconds: Number(e.reviewSeconds) || 0, workflow: typeof e.workflow === "string" ? e.workflow.slice(0, 120) : "", kind: typeof e.kind === "string" ? e.kind.slice(0, 40) : "" })),
        lastAt: Number(s.lastAt) || 0, assistantSeenAt: Number(s.assistantSeenAt) || 0, prev: { user: "", assistant: "", task: "" },
      });
      const c = convs[convs.length - 1];
      if (c.episodes.length) c.prev.task = c.episodes[c.episodes.length - 1].kind;   // so a restarted watcher still knows what task is under way
    }
  }
  restore(state);

  function snapshot() {
    const t = now();
    const live = convs.filter((c) => t - c.lastAt <= WEEK).sort((a, b) => a.lastAt - b.lastAt).slice(-MAX_CONVS);
    return {
      v: 1,
      convs: live.map((c) => ({
        id: c.id, tool: c.tool.id, name: c.tool.name, titleHash: c.titleHash, keys: [...c.keys].slice(-MAX_KEYS),
        userCount: c.userCount, episodes: c.episodes.map((e) => ({ ...e })), lastAt: c.lastAt, assistantSeenAt: c.assistantSeenAt,
      })),
    };
  }

  function keysOf(turns) {
    const seen = {};
    return turns.map((t) => { const k = t.role + "|" + norm(t.text); seen[k] = (seen[k] || 0) + 1; return h(k + "#" + seen[k]).slice(0, 16); });
  }

  // Messages seen before count most. A matching title fingerprint is a tie-breaker, and the fallback when the early messages have scrolled away.
  function find(tool, keys, titleHash, t) {
    let best = null, bestScore = 0;
    for (const c of convs) {
      if (c.tool.id !== tool.id) continue;
      const age = t - c.lastAt;
      const overlap = age <= WEEK ? keys.filter((k) => c.keys.has(k)).length : 0;
      const titleMatch = !!titleHash && c.titleHash === titleHash && age <= DAY;
      const score = overlap * 10 + (titleMatch ? 5 : 0);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
  }

  // The name of the workflow a task belongs to, worked out once, from the message that started the task.
  // "<Tool> chat" is the deliberate name in "tool" mode. In the other modes, a task that could not be sorted is "<Tool> chat (unsorted)",
  // so a catch-all row is never mistaken for a real group.
  function workflowFor(tool, text) {
    if (naming === "tool") return tool.name + " chat";
    const fallback = unsorted(tool);
    if (!text) return fallback;
    const kind = taskKind(text);
    if (naming === "first-prompt" && mode !== "off") {
      const line = firstSentence(text);
      const shown = mode === "full" ? line : A.redactPrompt(line);
      if (shown) return shown.slice(0, 80);
    }
    return kind ? kind.label : fallback;
  }

  const unsorted = (tool) => naming === "tool" ? tool.name + " chat" : tool.name + " chat (unsorted)";
  const kindOf = (text) => (taskKind(text) || {}).label || "";

  function sessionRecord(c, ep, t) {
    return {
      id: "scr_" + h(c.id + ":" + ep.n).slice(0, 14), site: c.tool.name, workflow: ep.workflow || unsorted(c.tool),
      startedAt: ep.startedAt, lastAt: t, attempts: 1 + ep.corrections, regens: 0,
      gapSeconds: Math.round(ep.reviewSeconds), done: false, source: "live",
    };
  }

  // snapshot: { nodes: [...] }   tool: { id, name } from identify()   meta: { title } the chat's title, without the tool or browser name
  function feed(snapshot, tool, meta = {}) {
    const t = now();
    const { turns } = extractTurns(snapshot, tool);
    const out = { rePrompts: [], sessions: [], labels: [], seen: turns.length, changed: false };
    if (!turns.length) return out;
    const keys = keysOf(turns);
    const titleHash = meta && meta.title ? h("title|" + tool.id + "|" + norm(meta.title)).slice(0, 16) : "";

    let c = find(tool, keys, titleHash, t);
    const fresh = !c;
    if (fresh) {
      c = { id: "c_" + h(tool.id + "|" + titleHash + "|" + keys[0]).slice(0, 12), tool, titleHash, keys: new Set(), userCount: 0, lastAt: t, episodes: [], prev: { user: "", assistant: "", task: "" }, assistantSeenAt: 0 };
      convs.push(c);
      out.changed = true;
    }
    if (titleHash && c.titleHash !== titleHash) { c.titleHash = titleHash; out.changed = true; }
    // a chat always begins with the person's message, so an assistant reply at the very top of what is on screen means it began earlier
    const beganEarlier = fresh && turns[0].role === "assistant";
    c.lastAt = t;
    const ensureEpisode = () => { if (!c.episodes.length) c.episodes.push({ n: 0, startedAt: t, corrections: 0, reviewSeconds: 0, workflow: "", kind: "" }); return c.episodes[c.episodes.length - 1]; };

    turns.forEach((turn, i) => {
      const k = keys[i];
      if (c.keys.has(k)) {                                       // seen before: only keep the context current (a restarted watcher has none)
        if (turn.role === "assistant") c.prev.assistant = turn.text; else c.prev.user = turn.text;
        return;
      }
      c.keys.add(k);
      out.changed = true;
      if (turn.role === "assistant") { c.prev.assistant = turn.text; c.assistantSeenAt = t; return; }

      c.userCount++;
      const first = typeof turn.index === "number" ? turn.index === 1 : c.userCount === 1 && !beganEarlier;
      if (first) {                                               // the first prompt is not a re-prompt
        const ep0 = ensureEpisode();
        ep0.workflow = workflowFor(tool, turn.text);             // the first prompt starts the task, so it names it (only the label or masked line is kept)
        ep0.kind = kindOf(turn.text);
        c.prev.user = turn.text; c.prev.task = ep0.kind;
        return;
      }
      const gap = c.assistantSeenAt ? (t - c.assistantSeenAt) / 1000 : 0;
      const cls = classifyTurn(turn.text, c.prev, gap);
      out.labels.push({ text: turn.text, ...cls });
      if (cls.label === "new_task") {
        ensureEpisode();
        const kind = kindOf(turn.text);
        c.episodes.push({ n: c.episodes.length, startedAt: t, corrections: 0, reviewSeconds: 0, workflow: workflowFor(tool, turn.text), kind });
        c.prev = { user: turn.text, assistant: "", task: kind };
        return;
      }
      const ep = ensureEpisode();
      c.prev.user = turn.text;
      if (!countsAsRework(cls)) return;                          // questions, additions, thanks and unsure messages are not rework
      ep.corrections++;
      ep.reviewSeconds += Math.min(gap, 600);
      const sessionId = "scr_" + h(c.id + ":" + ep.n).slice(0, 14);
      const rec = A.buildRePrompt({
        id: "scrp_" + h(sessionId + k).slice(0, 14), sessionId, site: tool.name, workflow: ep.workflow || unsorted(tool),
        attemptIndex: ep.corrections + 1, kind: "followup", text: turn.text, mode, now: t, user, reviewSec: gap, source: "live",
      });
      if (rec) out.rePrompts.push(rec);
    });

    const last = c.episodes.length ? c.episodes[c.episodes.length - 1].n : -1;
    for (const ep of c.episodes) if (ep.corrections > 0 || ep.n === last) out.sessions.push(sessionRecord(c, ep, t));
    return out;
  }

  return { feed, snapshot, conversations: () => convs.length };
}
