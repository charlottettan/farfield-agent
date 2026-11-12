// Connects an email draft to the AI reply it came from, and records how the person changed it before it left the draft box.
//
// How it works:
//   1. While chat reading is on, every AI reply seen on screen is kept IN MEMORY ONLY (the last 20, for 3 hours). It is never
//      written to disk, so a restart forgets them.
//   2. When a Gmail draft is in front, its text is compared with those replies. A draft that does not clearly come from one of
//      them (the person wrote it themselves) is dropped straight away and nothing about it is kept.
//   3. A draft that does come from a reply is followed. The "AI version" is only the part of the reply the draft was built from
//      (a reply that offers three options and a preamble is cut down to the option that was used).
//   4. When the draft box goes away (sent, discarded or closed), or has not been seen for 3 minutes, the last version seen is
//      compared with the AI version, using the same comparison as Word files, and one correction is produced (surface "Gmail").
//      3 minutes, so an email that is sent and then left behind (the person moved to another window before the next look) is
//      still recorded soon. If the same draft is seen again later, it is followed again and its record is updated in place
//      (same id, same start time), never added a second time.
//
// What it cannot know: whether the email was actually sent or thrown away (the reader only sees the draft box), and any edit made
// in the last few seconds before sending (the screen is looked at about every 10 seconds).
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../../vendor/office-logic.js");

const MAX_REPLIES = 20;
const REPLY_TTL = 3 * 3600 * 1000;
export const DRAFT_IDLE = 3 * 60 * 1000;
const MIN_SHARED = 6;          // at least this many three-word phrases in common
const MIN_SHARE = 0.25;        // and at least this share of the draft's phrases found in the reply

const words = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}@.'-]+/gu, " ").split(" ").filter(Boolean);
function trigrams(s) {
  const w = words(s), out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(w[i] + " " + w[i + 1] + " " + w[i + 2]);
  return out;
}

// How much of the draft was taken from this reply: { shared, share } where share is the part of the draft's phrases found in it.
export function overlap(draft, reply) {
  const d = trigrams(draft), r = trigrams(reply);
  if (!d.size) return { shared: 0, share: 0 };
  let shared = 0;
  for (const g of d) if (r.has(g)) shared++;
  return { shared, share: shared / d.size };
}

// The reply that a draft most clearly came from, or null. Short drafts ("Thanks!") never match anything.
export function matchReply(draft, replies) {
  let best = null;
  for (const r of replies) {
    const o = overlap(draft, r.text);
    if (o.shared < MIN_SHARED || o.share < MIN_SHARE) continue;
    if (!best || o.shared > best.o.shared) best = { reply: r, o };
  }
  return best ? best.reply : null;
}

// The part of an AI reply that a draft was built from: the lines from the first to the last one that shares a phrase with the
// draft. "Here are three options" before it, and the options that were not used after it, are left out.
export function aiSpan(replyText, draft) {
  const d = trigrams(draft);
  const lines = String(replyText || "").split("\n");
  let first = -1, last = -1;
  lines.forEach((line, i) => {
    for (const g of trigrams(line)) if (d.has(g)) { if (first < 0) first = i; last = i; break; }
  });
  if (first < 0) return String(replyText || "").trim();
  // Blank lines between greeting, body and sign-off are stepped over (Claude's email card has them, seen on a real Mac).
  const prevText = (i) => { let k = i - 1; while (k >= 0 && !lines[k].trim()) k--; return k; };
  const nextText = (i) => { let k = i + 1; while (k < lines.length && !lines[k].trim()) k++; return k; };
  // keep a greeting line just above the first matching line ("Hi Tim,") since it is part of the email the AI wrote
  const g = prevText(first);
  if (g >= 0 && /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening))\b.{0,40}[,!]?\s*$/i.test(lines[g])) first = g;
  // and a sign-off just after the last one ("Best," / "Thanks,") plus the name line right under it
  let end = last;
  const s = nextText(last);
  if (s < lines.length && /^(best|thanks|thank you|regards|kind regards|best regards|cheers|sincerely|warmly)\b.{0,20}$/i.test(lines[s].trim())) {
    end = s;
    if (s + 1 < lines.length && lines[s + 1].trim() && lines[s + 1].trim().split(/\s+/).length <= 4) end = s + 1;
  }
  return lines.slice(first, end + 1).join("\n").trim();
}

const PRIVACY = { full: "full", redacted: "redacted", off: "none" };

// mode: how wording is kept ("redacted" masks emails and numbers, "off" keeps none), as for chat reading.
export function createEmailTracker({ now = Date.now, mode = "redacted", salt = "" } = {}) {
  const h = (s) => crypto.createHash("sha256").update(salt + "|" + s).digest("hex");
  let replies = [];               // { text, tool, workflow, at }   in memory only
  let draft = null;               // { app, ai, tool, last, firstAt, lastAt, key }
  const ended = new Map();        // key -> when that email was first seen, so a draft picked up again keeps its start time (in memory only)

  // items: the replies' text, or { text, workflow } with the workflow of the chat task each one answered
  function noteReplies(toolName, items) {
    const t = now();
    for (const item of items || []) {
      const text = typeof item === "string" ? item : item && item.text;
      const workflow = typeof item === "string" ? "" : String((item && item.workflow) || "").slice(0, 120);
      if (!text || text.length < 40) continue;
      const i = replies.findIndex((r) => r.text === text);
      if (i >= 0) { replies[i].at = t; if (workflow) replies[i].workflow = workflow; continue; }
      replies.push({ text, tool: toolName, workflow, at: t });
    }
    replies = replies.filter((r) => t - r.at <= REPLY_TTL).slice(-MAX_REPLIES);
  }

  function finish(reason) {
    const d = draft;
    draft = null;
    if (!d) return null;
    const ctx = { agent: d.tool, privacy: PRIVACY[mode] || "redacted", now: now() };
    const built = L.buildWordCorrection(d.ai, d.last, ctx);
    ended.set(d.key, d.firstAt);
    for (const [k, at] of ended) if (now() - at > REPLY_TTL) ended.delete(k);
    const send = { ...built.send, id: "em_" + d.key, surface: d.surface, workflow: d.workflow };      // the id lets a re-finished email replace its send
    let correction = null;
    if (built.correction) {
      correction = {
        ...built.correction, id: "em_" + d.key, surface: d.surface, workflow: d.workflow, file: "",
        timeSource: "estimated", ended: reason,     // "closed": the draft box went away (sent or discarded); "idle": not seen for 3 minutes
        activeSeconds: Math.round(Math.max(0, d.lastAt - d.firstAt) / 1000),
      };
    }
    return { correction, send };
  }

  // One look at an email draft box. body: the draft's text, or null when the email app is in front but no draft box is open.
  // Returns a finished record when a followed draft has ended, otherwise null.
  // boxId: the page's own id for this draft box (Gmail gives each one, e.g. ":qk"). Optional.
  function see(app, body, boxId = "") {
    const t = now();
    if (body === null || body === undefined) return finish("closed");       // the draft box went away
    const text = String(body).trim();
    // A different draft box than the one being followed: the followed email is done. Seen on a real Mac: closing a new-email
    // pop-up left a reply box open in the thread behind it, which would otherwise have been taken for the same email.
    if (draft && boxId && draft.boxId && boxId !== draft.boxId) {
      const done = finish("closed");
      start(app, text, t, boxId);
      return done;
    }
    // While the draft box stays open it is the same email, however much it is rewritten. Rewriting it completely is a correction too.
    if (draft) { if (text) draft.last = text; draft.lastAt = t; if (boxId && !draft.boxId) draft.boxId = boxId; return null; }
    start(app, text, t, boxId);
    return null;
  }

  // Numbers only (never text), for `screen log`: how many AI replies are remembered, how long the draft is, and how close the
  // closest reply came, so a draft that was not followed can be explained.
  let last = { replies: 0, draftWords: 0, shared: 0, share: 0 };

  function start(app, text, t, boxId = "") {
    const live = replies.filter((r) => t - r.at <= REPLY_TTL);
    let best = { shared: 0, share: 0 };
    for (const r of live) { const o = overlap(text, r.text); if (o.shared > best.shared) best = o; }
    last = { replies: live.length, draftWords: words(text).length, shared: best.shared, share: Math.round(best.share * 100) };
    const hit = text ? matchReply(text, live) : null;
    if (!hit) return;                                                        // not from an AI reply seen here: nothing is kept
    const ai = aiSpan(hit.text, text);
    const key = h(app.id + "|" + ai).slice(0, 14);
    // filed with the chat it came from (its workflow), or "Email draft" when that is not known
    draft = { app: app.id, boxId, surface: app.surface || app.name, tool: hit.tool, workflow: hit.workflow || "Email draft", ai, last: text, firstAt: ended.get(key) || t, lastAt: t, key };
  }

  // Called on every look, whatever is in front, so a draft left open and forgotten still ends.
  function tick() {
    if (draft && now() - draft.lastAt > DRAFT_IDLE) return finish("idle");
    return null;
  }

  // What the dashboard may show about a draft being followed right now: no text, only which tool and app, and since when.
  const status = () => (draft ? { tool: draft.tool, surface: draft.surface, workflow: draft.workflow, since: draft.firstAt, endsAfterIdle: Math.round(DRAFT_IDLE / 60000) } : null);

  return { noteReplies, see, tick, status, following: () => !!draft, replyCount: () => replies.length, lastLook: () => ({ ...last, replies: replies.length }) };
}
