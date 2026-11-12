// One look at the screen: ask which window is in front, and only if it is an allowed AI chat (or, when email reading is on,
// an allowed email app), read its text.
import crypto from "node:crypto";
import { identify, identifyEmail, chatTitle, EMAIL_APP_IDS } from "./sites.js";
import { createObserver } from "./observer.js";
import { createEmailTracker } from "./email.js";
import { gmailDraft } from "./adapters/gmail.js";
import { hintsFor } from "./adapters/index.js";
import { titleShape, cleanTitle } from "./sites.js";

function mergeById(existing, incoming) {
  const map = new Map((Array.isArray(existing) ? existing : []).map((x) => [x.id, x]));
  for (const x of incoming) if (x && x.id) map.set(x.id, x);
  return [...map.values()];
}

// Which email apps may be read: none unless email reading was turned on (screen email on --agree).
export const emailAppsOf = (sc) => (sc && sc.email ? (Array.isArray(sc.emailApps) && sc.emailApps.length ? sc.emailApps : EMAIL_APP_IDS) : []);

// The draft box only: the native reader jumps to Gmail's "Message Body" box and reads nothing at all when there is none.
const DRAFT_READ = { engine: "native", build: false, maxNodes: 1500, timeoutMs: 20000, focus: "Message Body", focusOnly: true, tail: 400 };

export function createScreenStep({ storage, probe, now = Date.now, getConfig, log = () => {} }) {
  let observer = null, observerMode = "", lastAt = 0, busy = false;
  let tracker = null, trackerMode = "";

  async function saltOf() {
    const saved = await storage.local.get(["observerSalt"]);
    let salt = saved.observerSalt;
    if (typeof salt !== "string" || salt.length < 16) { salt = crypto.randomBytes(16).toString("hex"); await storage.local.set({ observerSalt: salt }); }
    return salt;
  }

  async function getTracker(mode) {
    if (!tracker || trackerMode !== mode) { tracker = createEmailTracker({ now, mode, salt: await saltOf() }); trackerMode = mode; }
    return tracker;
  }

  // Saves a finished email correction the same way the browser extension saves a Gmail one: a correction and a "send".
  async function saveEmail(done) {
    if (!done) return 0;
    const d = await storage.local.get(["corrections", "sends", "settings"]);
    const patch = {};
    const sends = Array.isArray(d.sends) ? d.sends : [];
    // an email picked up again after it was recorded replaces its earlier send, so one email is one send
    patch.sends = sends.filter((x) => !(done.send.id && x && x.id === done.send.id)).concat([done.send]);
    if (done.correction) {
      patch.corrections = mergeById(d.corrections, [done.correction]);
      const settings = d.settings || {};
      const agents = Array.isArray(settings.agents) ? settings.agents : [];
      if (done.correction.agent && !agents.includes(done.correction.agent)) patch.settings = { ...settings, agents: agents.concat([done.correction.agent]) };
    }
    await storage.local.set(patch);
    log("recorded email", { surface: done.send.surface, corrected: !!done.correction });
    return done.correction ? 1 : 0;
  }

  // Whether a draft is being followed right now, for the dashboard ("being followed, recorded when it closes"). Written only
  // when it changes, so the page is not redrawn on every look. No text: tool, app and start time only.
  let shownStatus = "";
  async function showStatus() {
    if (!tracker) return;
    const s = tracker.status();
    const key = JSON.stringify(s);
    if (key === shownStatus) return;
    shownStatus = key;
    await storage.local.set({ emailFollowing: s });
  }

  return async function step() {
    try { return await look(); } finally { try { await showStatus(); } catch (e) { /* the status line is a convenience only */ } }
  };

  async function look() {
    const cfg = getConfig();
    const sc = cfg.screen || {};
    if (!sc.enabled) return { skipped: "off" };
    if (cfg.paused) return { skipped: "paused" };
    const t = now();
    if (busy || t - lastAt < Math.max(2, Number(sc.intervalSeconds) || 10) * 1000) return { skipped: "too_soon" };
    busy = true; lastAt = t;
    try {
      const mode = sc.storeMode === "full" || sc.storeMode === "off" ? sc.storeMode : "redacted";
      const emailApps = emailAppsOf(sc);
      // a draft left open and forgotten still ends, whatever is in front now
      if (tracker && emailApps.length) await saveEmail(tracker.tick());

      let win;
      try { win = await probe.title(); } catch (e) { return { skipped: "probe_error", error: String((e && e.message) || e).slice(0, 200) }; }
      const tool = identify(win, sc.tools);
      const emailApp = tool ? null : identifyEmail(win, emailApps);
      if (emailApp) return await emailStep(emailApp, mode);
      if (!tool) return { skipped: "not_allowed", app: cleanTitle(win && win.app).slice(0, 60), titleShape: titleShape(win && win.title) };            // the window's content is never requested
      let snapshot;
      try { snapshot = await probe.tree({ engine: sc.engine || "auto", build: false, maxNodes: 6000, timeoutMs: 30000, ...hintsFor(tool.id) }); } catch (e) { return { skipped: "probe_error", error: String((e && e.message) || e).slice(0, 200) }; }
      if (!observer || observerMode !== mode + "|" + (sc.workflowNames || "task")) {
        // What a chat looked like last time is remembered as salted fingerprints only (no text), so a restart does not lose track of it.
        const saved = await storage.local.get(["observerState"]);
        const salt = await saltOf();
        const naming = sc.workflowNames === "tool" || sc.workflowNames === "first-prompt" ? sc.workflowNames : "task";
        observer = createObserver({ now, mode, salt, state: saved.observerState, naming });
        observerMode = mode + "|" + (sc.workflowNames || "task");
      }
      const res = observer.feed(snapshot, tool, { title: chatTitle(win, tool) });
      // the AI's replies are handed to the email matcher, which keeps them in memory only
      if (emailApps.length) (await getTracker(mode)).noteReplies(tool.name, res.replies);
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
      return { tool: tool.id, basis: tool.basis, engine: snapshot.engine || "", ...(emailApps.length ? { repliesKept: (await getTracker(mode)).replyCount(), repliesSeen: res.replies.length } : {}), seen: res.seen, rePrompts: res.rePrompts.length, labels: res.labels.length, fellBack: snapshot.fellBack || "" };
    } finally { busy = false; }
  };

  async function emailStep(app, mode) {
    const tr = await getTracker(mode);
    let snap;
    try { snap = await probe.tree(DRAFT_READ); } catch (e) { return { skipped: "probe_error", tool: app.id, error: String((e && e.message) || e).slice(0, 200) }; }
    // Anything that is not the draft box, read by the native reader, is thrown away without being looked at.
    const inBox = !!snap && snap.engine === "native" && snap.focus === "found";
    const draft = inBox ? gmailDraft(snap.nodes) : null;
    const recorded = await saveEmail(tr.see(app, draft ? draft.body : null, draft ? draft.id : ""));
    return { tool: app.id, email: true, basis: app.basis, engine: (snap && snap.engine) || "", draft: !!draft, following: tr.following(), emailRecorded: recorded, match: tr.lastLook(), seen: 0, rePrompts: 0, labels: 0 };
  }
}
