import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { identify } from "../src/screen/sites.js";
import { explain, createProbe } from "../src/screen/probe.js";
import { shapeDump } from "../src/screen/shape.js";
import { extractTurns } from "../src/screen/turns.js";
import { createObserver } from "../src/screen/observer.js";
import { createScreenStep } from "../src/screen/watch.js";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults, loadConfig } from "../src/config.js";
import { createFileStorage } from "../src/storage.js";

const CLAUDE = { id: "claude", name: "Claude" };
const lines = (...pairs) => pairs.flatMap(([who, text]) => [{ role: "AXStaticText", text: who }, { role: "AXStaticText", text }]);

test("only AI chat windows are recognised, from the address when there is one", () => {
  assert.equal(identify({ url: "https://claude.ai/chat/abc" }).id, "claude");
  assert.equal(identify({ url: "https://chatgpt.com/c/1" }).id, "chatgpt");
  assert.equal(identify({ url: "https://evilclaude.ai/x" }), null);
  assert.equal(identify({ url: "https://claude.ai.evil.com/x" }), null);
  assert.equal(identify({ app: "Google Chrome", title: "Q3 summary - Claude" }).id, "claude");
  assert.equal(identify({ app: "Google Chrome", title: "Claude" }).id, "claude");
  assert.equal(identify({ app: "Google Chrome", title: "Claude vs GPT - Google Docs" }), null);
  assert.equal(identify({ app: "Microsoft Word", title: "Claude notes - Word" }), null);
  assert.equal(identify({ app: "Google Chrome", title: "Inbox - Gmail" }), null);
  assert.equal(identify({ app: "Google Chrome", title: "Q3 summary - Claude" }, ["chatgpt"]), null);   // not on the allowed list
});

test("turns: who said what comes from the page's own labels, and unlabelled text is dropped", () => {
  const snap = { nodes: [{ role: "AXStaticText", text: "Sidebar noise" }, ...lines(["You", "Summarize Q3"], ["Claude", "Revenue was $1.2 billion."], ["You", "Make it shorter"]), { role: "AXButton", text: "Copy" }] };
  const r = extractTurns(snap);
  assert.deepEqual(r.turns, [{ role: "user", text: "Summarize Q3" }, { role: "assistant", text: "Revenue was $1.2 billion." }, { role: "user", text: "Make it shorter" }]);
  assert.equal(r.basis, "labels");
});

test("turns: a draft in the message box is not a sent message", () => {
  const snap = { nodes: [...lines(["You", "Summarize Q3"], ["Claude", "Done."]), { role: "AXTextArea", text: "half typed follow-up that was never sent" }] };
  const r = extractTurns(snap);
  assert.equal(r.turns.length, 2);
  assert.equal(r.composer, "half typed follow-up that was never sent");
});

test("turns: structure from an adapter is used when present; a page with no labels gives nothing rather than a guess", () => {
  const s = extractTurns({ nodes: [{ role: "x", text: "hi", authorRole: "user" }, { role: "x", text: "hello", authorRole: "assistant" }, { role: "x", text: "more", authorRole: "assistant" }] });
  assert.deepEqual(s.turns, [{ role: "user", text: "hi" }, { role: "assistant", text: "hello\nmore" }]);
  const none = extractTurns({ nodes: [{ role: "AXStaticText", text: "some text" }, { role: "AXStaticText", text: "more text" }] });
  assert.deepEqual(none.turns, []);
  assert.equal(extractTurns(null).turns.length, 0);
});

function clock() { let t = 1_700_000_000_000; return { now: () => t, tick: (s) => { t += s * 1000; } }; }
const first = lines(["You", "Summarize the Q3 earnings call for Acme Corp"], ["Claude", "Acme Corp reported revenue of $1.2 billion, up 8%, with operating margin of 21%."]);

test("observer: the first prompt is not a re-prompt, a correction is, and seeing the same screen again adds nothing", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  assert.deepEqual(o.feed({ nodes: first }, CLAUDE).rePrompts, []);
  c.tick(40);
  const withFix = { nodes: [...first, ...lines(["You", "The revenue figure is wrong, it was $1.1 billion"])] };
  const r = o.feed(withFix, CLAUDE);
  assert.equal(r.rePrompts.length, 1);
  assert.equal(r.rePrompts[0].attemptIndex, 2);
  assert.equal(r.rePrompts[0].site, "Claude");
  assert.equal(r.rePrompts[0].source, "live");
  assert.ok(r.rePrompts[0].reviewSeconds >= 40);
  c.tick(5);
  assert.deepEqual(o.feed(withFix, CLAUDE).rePrompts, []);              // same screen, nothing new
  assert.equal(r.sessions.at(-1).attempts, 2);
});

test("observer: questions, additions and thanks are not rework", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  o.feed({ nodes: first }, CLAUDE); c.tick(30);
  let nodes = [...first];
  for (const msg of ["Why did you say operating margin was 21%?", "Also add a line about the dividend", "Thanks, looks good"]) {
    nodes = [...nodes, ...lines(["You", msg]), ...lines(["Claude", "Sure."])]; c.tick(30);
    assert.equal(o.feed({ nodes }, CLAUDE).rePrompts.length, 0, msg);
  }
});

test("observer: one chat with two tasks gives two sessions, and each correction belongs to its own task", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  let nodes = [...first]; o.feed({ nodes }, CLAUDE); c.tick(30);
  nodes = [...nodes, ...lines(["You", "The revenue figure is wrong, it was $1.1 billion"]), ...lines(["Claude", "Corrected: $1.1 billion."])]; const a = o.feed({ nodes }, CLAUDE); c.tick(30);
  nodes = [...nodes, ...lines(["You", "Separately, can you draft talking points for the Delta Inc call tomorrow"]), ...lines(["Claude", "Talking points: growth, leverage, covenants."])]; o.feed({ nodes }, CLAUDE); c.tick(30);
  nodes = [...nodes, ...lines(["You", "Remove the covenants point"])]; const b = o.feed({ nodes }, CLAUDE);
  assert.equal(a.rePrompts.length, 1); assert.equal(b.rePrompts.length, 1);
  assert.notEqual(a.rePrompts[0].sessionId, b.rePrompts[0].sessionId);
  const ids = new Set(b.sessions.map((s) => s.id));
  assert.equal(ids.size, 2);
  assert.ok(ids.has(a.rePrompts[0].sessionId) && ids.has(b.rePrompts[0].sessionId));
});

test("observer: a scrolled view that hides the start of the chat still belongs to the same chat; a different chat does not", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const long = [...first, ...lines(["You", "Make it shorter"]), ...lines(["Claude", "Acme: revenue $1.2 billion."])];
  o.feed({ nodes: long }, CLAUDE); c.tick(20);
  const scrolled = { nodes: [...lines(["You", "Make it shorter"]), ...lines(["Claude", "Acme: revenue $1.2 billion."]), ...lines(["You", "Remove the margin figure"])] };
  const r = o.feed(scrolled, CLAUDE);
  assert.equal(o.conversations(), 1);
  assert.equal(r.rePrompts.length, 1);
  c.tick(20);
  o.feed({ nodes: lines(["You", "Draft an email about the settlement delay"], ["Claude", "Dear client, your settlement is delayed."]) }, CLAUDE);
  assert.equal(o.conversations(), 2);
});

test("observer: stored wording follows the mode (redacted masks numbers and names, off keeps none)", () => {
  const msg = "The figure for Beta Corp is wrong, it was 1100 not 1200";
  for (const [mode, check] of [["redacted", (t) => !/1100|1200|Beta/.test(t) && /#/.test(t)], ["full", (t) => /1100/.test(t)], ["off", null]]) {
    const c = clock(); const o = createObserver({ now: c.now, mode });
    o.feed({ nodes: first }, CLAUDE); c.tick(30);
    const r = o.feed({ nodes: [...first, ...lines(["You", msg])] }, CLAUDE);
    if (mode === "off") assert.equal(r.rePrompts.length, 0); else { assert.equal(r.rePrompts.length, 1); assert.ok(check(r.rePrompts[0].text), mode + ": " + r.rePrompts[0].text); }
  }
});

function setup(screen) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-screen-"));
  const home = path.join(root, "home"); const watch = path.join(root, "dl"); fs.mkdirSync(watch, { recursive: true });
  const cfg = { ...defaults(), folders: [watch], screen: { enabled: true, storeMode: "redacted", intervalSeconds: 2, tools: ["claude"], ...(screen || {}) } };
  saveConfig(home, cfg);
  const calls = { title: 0, tree: 0 };
  const state = { win: { app: "Google Chrome", title: "Q3 summary - Claude" }, nodes: first };
  const probe = { title: async () => { calls.title++; return state.win; }, tree: async () => { calls.tree++; return { nodes: state.nodes }; } };
  const c = clock();
  return { home, probe, calls, state, c, cfg, mk: () => createAgent({ home, now: c.now, probe, fetch: async () => { throw new Error("offline"); } }) };
}

test("screen step: a window that is not an allowed AI chat is never read", async () => {
  const s = setup(); const a = s.mk();
  s.state.win = { app: "Google Chrome", title: "Inbox - Gmail" };
  const r = await a.tick();
  assert.equal(r.screen.skipped, "not_allowed");
  assert.equal(s.calls.title, 1);
  assert.equal(s.calls.tree, 0);                           // the content was never requested
});

test("screen step: off by default, and paused means nothing is read", async () => {
  const s = setup({ enabled: false }); const a = s.mk();
  assert.equal((await a.tick()).screen.skipped, "off");
  assert.equal(s.calls.title, 0);
  const s2 = setup(); const b = s2.mk();
  const cfg = loadConfig(s2.home); cfg.paused = true; saveConfig(s2.home, cfg);
  await b.tick();
  assert.equal(s2.calls.title, 0);
});

test("screen step: an allowed chat is read, re-prompts are stored (redacted), and the tool joins the agent list", async () => {
  const s = setup(); const a = s.mk();
  await a.tick(); s.c.tick(30);
  s.state.nodes = [...first, ...lines(["You", "The revenue figure is wrong, it was $1.1 billion"])];
  const r = await a.tick();
  assert.equal(r.screen.rePrompts, 1);
  const d = await a.storage.local.get(["rePrompts", "aiSessions", "settings"]);
  assert.equal(d.rePrompts.length, 1);
  assert.ok(!/1\.1/.test(d.rePrompts[0].text));            // digits masked by default
  assert.ok(d.aiSessions.length >= 1);
  assert.ok(d.settings.agents.includes("Claude"));
  s.c.tick(30); await a.tick();                            // same screen again: still one
  assert.equal((await a.storage.local.get("rePrompts")).rePrompts.length, 1);
});

test("screen step: it waits between looks, and a failing probe never breaks file watching", async () => {
  const s = setup(); const a = s.mk();
  await a.tick();
  assert.equal((await a.tick()).screen.skipped, "too_soon");
  assert.equal(s.calls.title, 1);
  s.c.tick(10);
  s.probe.title = async () => { throw new Error("Accessibility permission is off"); };
  const r = await a.tick();
  assert.equal(r.screen.skipped, "probe_error");
  assert.match(r.screen.error, /Accessibility/);
  assert.equal(r.scan.paused, false);                      // the file watcher still ran
});

test("screen step: nothing from the screen is written except sent prompts and session counts", async () => {
  const s = setup(); const a = s.mk();
  s.state.nodes = [...first, { role: "AXTextArea", text: "SECRET draft never sent 998877" }, { role: "AXStaticText", text: "Unlabelled sidebar 554433" }];
  await a.tick();
  const raw = fs.readFileSync(path.join(s.home, "data.json"), "utf8");
  assert.ok(!raw.includes("998877") && !raw.includes("554433"));
  assert.ok(!raw.includes("Q3 summary - Claude"));          // window titles are not stored either
});

test("a real Mac window title: the Gemini app, with the name first and an em dash (seen on a real machine)", () => {
  const w = { app: "Gemini", title: "Gemini — Project Pinecone Status Update" };
  assert.equal(identify(w).id, "gemini");
  assert.equal(identify(w).basis, "app");
  assert.equal(identify(w, ["claude"]), null);                                        // still respects the allowed list
  assert.equal(identify({ app: "Google Chrome", title: "Gemini — Project Pinecone Status Update" }), null);   // in a browser the title alone is not enough
  assert.equal(identify({ app: "Notes", title: "Gemini — shopping list" }), null);
});

test("probe errors say what happened and never include the script", () => {
  const killed = explain({ killed: true, signal: "SIGTERM", message: "Command failed: osascript -e SCRIPT" }, "", 40000);
  assert.match(killed, /longer than 40 seconds/);
  assert.match(killed, /--max-nodes/);
  const perm = explain({ message: "Command failed: osascript -e SCRIPT\nosascript is not allowed assistive access. (-25211)" }, "", 15000);
  assert.match(perm, /Accessibility/);
  const auto = explain({ message: "x" }, "Not authorized to send Apple events to System Events. (-1743)", 15000);
  assert.match(auto, /Automation/);
  const other = explain({ message: "Command failed: osascript -e SCRIPT\nsomething odd happened" }, "", 1000);
  assert.ok(!/SCRIPT/.test(other));
  assert.match(other, /something odd/);
});

test("the status says what the last look at the screen did, without any content", async () => {
  const s = setup(); const a = s.mk();
  s.state.win = { app: "Google Chrome", title: "Inbox - Gmail" };
  await a.tick();
  let st = await a.status();
  assert.equal(st.screen.enabled, true);
  assert.equal(st.screen.last.skipped, "not_allowed");
  s.c.tick(30); s.state.win = { app: "Google Chrome", title: "Q3 summary - Claude" }; s.state.nodes = first;
  await a.tick();
  st = await a.status();
  assert.equal(st.screen.last.tool, "claude");
  assert.ok(!JSON.stringify(st.screen).includes("Acme"));
});

test("macOS reader: the slow reader is the default, the experimental fast one only on request", async () => {
  const calls = [];
  const probe = createProbe("darwin", async (cmd, args) => {
    const script = args[args.length - 1]; calls.push(script.includes("AXUIElementCopyAttributeValue") ? "fast" : "slow");
    return { nodes: [{ role: "AXStaticText", text: "hi" }] };
  });
  let r = await probe.tree({});
  assert.deepEqual(calls.splice(0), ["slow"]); assert.equal(r.engine, "events");
  await probe.tree({ engine: "fast" });
  assert.deepEqual(calls.splice(0), ["fast"]);
});

test("macOS reader: reads content properties, never the role description, and records depth", async () => {
  let script = "";
  await createProbe("darwin", async (cmd, args) => { script = args[args.length - 1]; return { nodes: [] }; }).tree({});
  assert.ok(script.includes('"accessibilityDescription"'));
  assert.ok(!/\[\s*"value",\s*"title",\s*"description"/.test(script));
  assert.ok(script.includes("depth: depth"));
  assert.ok(script.includes("AXWebArea"));
});

test("shape: shows structure and short labels, never long text", () => {
  const dump = { win: { app: "Gemini" }, engine: "native", nodes: [
    { role: "AXGroup", sub: "", depth: 2, text: "" },
    { role: "AXStaticText", depth: 3, text: "You" },
    { role: "AXStaticText", depth: 4, text: "Quarterly revenue for Pinecone rose 12% on strong bond desk results" },
    { role: "AXButton", depth: 4, text: "Copy" },
  ] };
  const out = shapeDump(dump);
  assert.match(out, /AXStaticText "You"/);
  assert.match(out, /AXButton "Copy"/);
  assert.ok(!/Pinecone|revenue|bond/.test(out));
  const long = "Quarterly revenue for Pinecone rose 12% on strong bond desk results";
  assert.ok(out.includes(`len=${long.length} Xxxxxxxxx xxxxxxx`));
  assert.match(out, /engine: native/);
  assert.ok(shapeDump({ nodes: Array.from({ length: 500 }, () => ({ role: "AXRow", text: "" })) }, { lines: 20 }).includes("more items not shown"));
});
