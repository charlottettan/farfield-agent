import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { identify, cleanTitle, showTitle, stripBrowserSuffix, stripStatusNotices, titleShape } from "../src/screen/sites.js";
import { explain, createProbe, PICK_SOURCE, ensureNative, compileHelp } from "../src/screen/probe.js";
import { shapeDump, maskNodes } from "../src/screen/shape.js";
import { extractTurns } from "../src/screen/turns.js";
import { createObserver } from "../src/screen/observer.js";
import { createScreenStep } from "../src/screen/watch.js";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults, loadConfig } from "../src/config.js";
import { createFileStorage } from "../src/storage.js";
import { main as cli } from "../src/cli.js";
import { hasToken } from "./helpers.js";

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
  let r = await probe.tree({ engine: "slow" });
  assert.deepEqual(calls.splice(0), ["slow"]); assert.equal(r.engine, "events");
  await probe.tree({ engine: "fast" });
  assert.deepEqual(calls.splice(0), ["fast"]);
});

test("macOS reader: reads content properties, never the role description, and records depth", async () => {
  let script = "";
  await createProbe("darwin", async (cmd, args) => { script = args[args.length - 1]; return { nodes: [] }; }).tree({ engine: "slow" });
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

test("a page with no message from the person is not a conversation (the real Claude app header case)", () => {
  // what a real Mac returned for the Claude desktop app: an app header that says "Claude", then the page title
  const snap = { nodes: [
    { role: "AXGroup", text: "Claude" }, { role: "AXWebArea", text: "Follow-up email to Tim - Claude" },
    { role: "AXHeading", text: "Claude" }, { role: "AXStaticText", text: "Claude" },
  ] };
  assert.deepEqual(extractTurns(snap).turns, []);
  const o = createObserver({ now: () => 1, mode: "full" });
  const r = o.feed(snap, { id: "claude", name: "Claude" });
  assert.deepEqual(r.sessions, []);
  assert.equal(o.conversations(), 0);
  // but a message from the person with no reply yet is still a conversation
  assert.equal(extractTurns({ nodes: lines(["You", "Summarize Q3"]) }).turns.length, 1);
});

test("macOS reader: asking the app to build its accessibility tree is a separate, reported step, and only when requested", async () => {
  const scripts = [], waits = [];
  const probe = createProbe("darwin", async (cmd, args) => {
    const sc = args[args.length - 1]; scripts.push(sc);
    return sc.includes("AXManualAccessibility") ? { attributes: { AXManualAccessibility: "set", AXEnhancedUserInterface: "failed: nope" } } : { visited: 3, nodes: [] };
  }, async (ms) => { waits.push(ms); });
  const plain = await probe.tree({ engine: "slow" });
  assert.equal(scripts.length, 1); assert.ok(!scripts[0].includes("AXManualAccessibility")); assert.equal(plain.accessibility, undefined);
  scripts.length = 0;
  const asked = await probe.tree({ engine: "slow", enableAccessibility: true });
  assert.equal(scripts.length, 2);
  assert.ok(scripts[0].includes("AXManualAccessibility") && scripts[0].includes("AXEnhancedUserInterface"));
  assert.ok(!scripts[1].includes("AXManualAccessibility"));         // the reading script does not touch the app's settings
  assert.deepEqual(waits, [3000]);
  assert.equal(asked.accessibility.AXManualAccessibility, "set");
  assert.match(asked.accessibility.AXEnhancedUserInterface, /failed/);
  assert.equal(asked.visited, 3);
});

test("every macOS script Farfield sends is at least valid JavaScript (they cannot be run here, so this catches typos)", async () => {
  const vm = await import("node:vm");
  const scripts = [];
  const probe = createProbe("darwin", async (cmd, args) => { scripts.push(args[args.length - 1]); return { attributes: {}, visited: 0, nodes: [], windows: 1, top: 1, app: "x", title: "y" }; }, async () => {});
  await probe.title(); await probe.check();
  await probe.tree({ engine: "slow" }); await probe.tree({ engine: "slow", enableAccessibility: true }); await probe.tree({ engine: "fast" });
  assert.equal(scripts.length, 6);
  scripts.forEach((s, i) => { assert.doesNotThrow(() => new vm.Script(s), `script ${i} does not parse`); });
});

test("saved window dumps keep structure and short labels but never long text", () => {
  const secret = "Rotate the production database password to hunter2-Prod-8841 before Friday";
  const nodes = [{ role: "AXTextArea", depth: 3, text: secret }, { role: "AXButton", depth: 4, text: "Close tab" }, { role: "AXGroup", depth: 1, text: "" }];
  const masked = maskNodes(nodes);
  const saved = JSON.stringify(masked);
  assert.ok(!/hunter2|password|Friday/i.test(saved));
  assert.equal(masked[0].textLength, secret.length);
  assert.equal(masked[1].text, "Close tab");
  const shown = shapeDump({ win: { app: "Claude" }, nodes: masked });
  assert.ok(!/hunter2|password/i.test(shown));
  assert.ok(shown.includes(`len=${secret.length}`));
  assert.ok(shown.includes('AXButton "Close tab"'));
  // showing a raw dump and showing its masked copy gives the same picture
  assert.equal(shapeDump({ win: { app: "Claude" }, nodes }), shapeDump({ win: { app: "Claude" }, nodes: masked }));
});

async function runCli(argv, home, probe) {
  const lines = []; const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { lines.push(String(c)); return true; };
  try { const code = await cli(argv, { FARFIELD_HOME: home }, { probe }); return { code, out: lines.join("") }; }
  finally { process.stdout.write = orig; }
}

test("screen dump: saves structure only by default, raw text only with --keep-text, and screen forget deletes it all", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-dump-"));
  const SECRET = "Rotate the production database password to hunter2-Prod-8841 before Friday";
  const probe = {
    title: async () => ({ app: "Claude", title: "Claude" }),
    check: async () => ({ windows: 1, top: 4 }),
    tree: async () => ({ engine: "events", visited: 5, nodes: [{ role: "AXStaticText", depth: 2, text: "You" }, { role: "AXStaticText", depth: 2, text: SECRET }, { role: "AXStaticText", depth: 2, text: "Claude" }, { role: "AXStaticText", depth: 2, text: "Done." }] }),
  };
  const files = () => fs.readdirSync(path.join(home, "dumps")).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(home, "dumps", f), "utf8"));
  const a = await runCli(["screen", "dump"], home, probe);
  assert.equal(a.code, 0);
  assert.ok(!a.out.includes("hunter2"), "the terminal output should not print the text either");
  assert.match(a.out, /Only the structure was saved/);
  assert.match(a.out, /found 2 messages \(1 from you, 1 from the AI\)/);   // it still understood the chat in memory
  let saved = files(); assert.equal(saved.length, 1);
  assert.ok(!/hunter2|password/i.test(saved[0]));
  assert.ok(saved[0].includes('"masked": true'));
  await new Promise((r) => setTimeout(r, 5));
  const b = await runCli(["screen", "dump", "--keep-text"], home, probe);
  assert.match(b.out, /WITH the text/);
  saved = files(); assert.equal(saved.length, 2);
  assert.ok(saved.some((f) => f.includes("hunter2")));            // raw only because it was asked for
  const shape = await runCli(["screen", "shape"], home, probe);
  assert.ok(!/hunter2/.test(shape.out), "shape must not print the text, even from a raw dump");
  const shapeFiles = fs.readdirSync(path.join(home, "dumps")).filter((f) => f.endsWith(".shape.txt"));
  assert.ok(shapeFiles.length >= 1);
  shapeFiles.forEach((f) => assert.ok(!/hunter2/.test(fs.readFileSync(path.join(home, "dumps", f), "utf8"))));
  const forget = await runCli(["screen", "forget"], home, probe);
  assert.match(forget.out, /Deleted \d+ saved file/);
  assert.equal(fs.readdirSync(path.join(home, "dumps")).length, 0);
});

test("window choice: skips an untitled, empty helper window and picks the real one (the Chrome case seen on a real Mac)", () => {
  const pickWindow = new Function(PICK_SOURCE + "; return pickWindow;")();
  const win = (o) => ({ subrole: () => o.sub || "AXUnknown", name: () => o.name || "", uiElements: { length: o.items || 0 }, attributes: { byName: (n) => ({ value: () => (n === "AXMain" ? !!o.main : n === "AXFocused" ? !!o.focused : false) }) } });
  const helper = win({}), devtools = win({ sub: "AXStandardWindow", name: "DevTools", items: 5 }), real = win({ sub: "AXStandardWindow", name: "Q3 summary - Claude", items: 40, main: true, focused: true }), other = win({ sub: "AXStandardWindow", name: "Inbox", items: 30 });
  const r = pickWindow({ windows: () => [helper, devtools, real, other] });
  assert.equal(r.index, 2);
  assert.equal(r.window, real);
  assert.equal(r.count, 4);
  assert.deepEqual(r.info.map((w) => w.items), [0, 5, 40, 30]);
  assert.equal(pickWindow({ windows: () => [helper] }).index, 0);       // a lone window is still chosen
  assert.equal(pickWindow({ windows: () => [] }).window, null);
  // with nothing marked main or focused, a titled window with content beats an empty one
  assert.equal(pickWindow({ windows: () => [helper, win({ sub: "AXStandardWindow", name: "x", items: 3 })] }).index, 1);
  // when a window throws on every question, it is skipped rather than breaking the choice
  const broken = { subrole: () => { throw new Error("no"); }, name: () => { throw new Error("no"); }, uiElements: { get length() { throw new Error("no"); } }, attributes: { byName: () => { throw new Error("no"); } } };
  assert.equal(pickWindow({ windows: () => [broken, real] }).index, 1);
});

test("all three macOS window scripts use the window chooser, not the first window", async () => {
  const scripts = [];
  const probe = createProbe("darwin", async (cmd, args) => { scripts.push(args[args.length - 1]); return { windows: 1, chosen: 0, top: 1, candidates: [], visited: 0, nodes: [], app: "x", title: "y" }; }, async () => {});
  await probe.title(); await probe.check(); await probe.tree({ engine: "slow" });
  assert.equal(scripts.length, 3);
  scripts.forEach((s) => { assert.ok(s.includes("function pickWindow")); assert.ok(!/windows\[0\]/.test(s), "still reads the first window"); });
});

test("real titles seen so far: Safari shows 'Google Gemini', and look-alike titles are still refused", () => {
  const ok = (app, title, id) => assert.equal(identify({ app, title }) && identify({ app, title }).id, id, `${app}: ${title}`);
  ok("Safari", "Sierra AI Connection Follow-Up Draft - Google Gemini", "gemini");
  ok("Google Chrome", "Q3 summary - Claude", "claude");
  ok("Safari", "Google Gemini", "gemini");
  ok("Firefox", "Some chat - ChatGPT", "chatgpt");
  ok("Google Chrome", "Weekly update | Microsoft Copilot", "copilot");
  assert.equal(identify({ app: "Safari", title: "Notes about Google Gemini" }), null);
  assert.equal(identify({ app: "Safari", title: "Gemini vs Claude - Google Docs" }), null);
  assert.equal(identify({ app: "Safari", title: "Why Google Gemini beat the benchmark" }), null);
});

test("the reading script keeps the top of the structure and records the window's errors", async () => {
  let script = "";
  await createProbe("darwin", async (cmd, args) => { script = args[args.length - 1]; return { nodes: [] }; }).tree({ engine: "slow" });
  assert.ok(script.includes("depth <= 3"));
  assert.ok(script.includes("errs.push"));
  assert.ok(script.includes("errors: errs"));
});

test("screen dump says when the window reported problems, and keeps them in the saved file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-dump2-"));
  const probe = { title: async () => ({ app: "Safari", title: "x - Google Gemini" }), check: async () => ({ windows: 1, chosen: 0, top: 2, candidates: [] }),
    tree: async () => ({ engine: "events", visited: 2, errors: ["Can't get object."], nodes: [{ role: "AXToolbar", depth: 1, text: "" }, { role: "AXGroup", depth: 1, text: "" }] }) };
  const r = await runCli(["screen", "dump"], home, probe);
  assert.match(r.out, /reported problems/);
  assert.match(r.out, /Can't get object/);
  const saved = fs.readdirSync(path.join(home, "dumps")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(home, "dumps", f), "utf8")))[0];
  assert.deepEqual(saved.errors, ["Can't get object."]);
  assert.deepEqual(saved.nodes.map((n) => n.role), ["AXToolbar", "AXGroup"]);
});

test("hidden characters in a window title do not stop it matching, and look-alikes are still refused", () => {
  const LRM = "\u200e", NBSP = "\u00a0", ZWSP = "\u200b", BOM = "\ufeff";
  const gem = (title) => identify({ app: "Safari", title });
  assert.equal(gem("Sierra AI Connection Follow-Up Draft - Google Gemini" + LRM).id, "gemini");
  assert.equal(gem(LRM + "Google Gemini").id, "gemini");
  assert.equal(gem("Draft -" + NBSP + "Google" + NBSP + "Gemini").id, "gemini");
  assert.equal(gem("Draft " + ZWSP + "\u2013 Google Gemini" + BOM).id, "gemini");              // en dash
  assert.equal(gem("Notes about Google Gemini" + LRM), null);
  assert.equal(gem("Gemini vs Claude - Google Docs" + LRM), null);
  assert.equal(identify({ app: "Gem" + ZWSP + "ini", title: "anything" }) && identify({ app: "Gem" + ZWSP + "ini", title: "anything" }).id, "gemini");   // an app name with a hidden character
  assert.equal(cleanTitle("  a" + NBSP + NBSP + "b" + LRM + "  "), "a b");
  assert.equal(showTitle("Google Gemini" + LRM + "é"), "Google Gemini\\u200e\\u00e9");
});

test("screen dump shows an unrecognised title with hidden characters spelled out", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-dump3-"));
  const probe = { title: async () => ({ app: "Safari", title: "Some page \u200e" }), check: async () => ({}), tree: async () => ({ nodes: [] }) };
  const r = await runCli(["screen", "dump"], home, probe);
  assert.equal(r.code, 1);
  assert.match(r.out, /hidden characters spelled out\): "Some page \\u200e"/);
});

test("native reader: compiled once and reused, recompiled when the source changes, with help when Swift is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-native-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// v1");
  const calls = [];
  const compile = async (cmd, args) => { calls.push([cmd, args]); fs.writeFileSync(args[args.indexOf("-o") + 1], "binary"); };
  const binDir = path.join(dir, "bin");
  const a = await ensureNative({ binDir, compile, source: src });
  const b = await ensureNative({ binDir, compile, source: src });
  assert.equal(a, b); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "swiftc"); assert.ok(calls[0][1].includes("-O"));
  fs.writeFileSync(src, "// v2");
  const c = await ensureNative({ binDir, compile, source: src });
  assert.notEqual(c, a); assert.equal(calls.length, 2);
  const missing = Object.assign(new Error("spawn swiftc ENOENT"), { code: "ENOENT" });
  await assert.rejects(ensureNative({ binDir: path.join(dir, "b2"), compile: async () => { throw missing; }, source: src }), /xcode-select --install/);
  const broken = new Error("ax.swift:12:5: error: cannot find 'foo' in scope");
  await assert.rejects(ensureNative({ binDir: path.join(dir, "b3"), compile: async () => { throw broken; }, source: src }), /The compiler's errors:[\s\S]*cannot find 'foo'/);
  assert.match(compileHelp({ message: "xcrun: error: invalid active developer path" }), /xcode-select/);
});

test("native reader: the engine runs the compiled program with the size, time and enable options", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-native2-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// x");
  const ran = [];
  const probe = createProbe("darwin", async (cmd, args, t) => { ran.push({ cmd, args, t }); return { engine: "native", visited: 9, errors: [], accessibility: { AXEnhancedUserInterface: "set" }, nodes: [] }; }, async () => {},
    { binDir: path.join(dir, "bin"), compile: async (c, a) => { fs.writeFileSync(a[a.indexOf("-o") + 1], "bin"); }, fsApi: { ...fs, readFileSync: (p) => (String(p).endsWith("ax.swift") ? "// fixed" : fs.readFileSync(p)) } });
  const r = await probe.tree({ engine: "native", maxNodes: 1500, timeoutMs: 120000, enableAccessibility: true });
  assert.equal(r.engine, "native");
  assert.match(ran[0].cmd, /farfield-ax-/);
  assert.deepEqual(ran[0].args, ["--max", "1500", "--seconds", "110", "--enable"]);
  assert.equal(ran[0].t, 120000);
  await probe.tree({ engine: "native" });
  assert.ok(!ran[1].args.includes("--enable"));
});

test("the Swift source is at least balanced and has the calls the reader depends on (it cannot be compiled here)", () => {
  const src = fs.readFileSync(new URL("../src/screen/ax.swift", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');          // drop comments and strings
  const count = (re) => (code.match(re) || []).length;
  assert.equal(count(/\{/g), count(/\}/g), "braces");
  assert.equal(count(/\(/g), count(/\)/g), "parentheses");
  assert.equal(count(/\[/g), count(/\]/g), "brackets");
  for (const needle of ["AXIsProcessTrusted", "AXUIElementCopyAttributeValue", "AXChildren", "AXDOMClassList", "AXMain", "AXStandardWindow", "JSONEncoder"]) assert.ok(src.includes(needle), needle);
  assert.ok(!/CGWindowListCreateImage|CGEvent|AXUIElementPerformAction/.test(src), "the reader must not take screenshots, send events, or click");
});

test("the page's own class names are kept in saved structure and shown in the shape, but long text is not", () => {
  const nodes = [{ role: "AXGroup", depth: 5, text: "", dom: "message-content.user-query-bubble" }, { role: "AXStaticText", depth: 6, text: "Draft a long confidential reply about the Sierra deal terms", dom: "query-text-line" }];
  const masked = maskNodes(nodes);
  assert.equal(masked[0].dom, "message-content.user-query-bubble");
  assert.ok(!/confidential|Sierra/.test(JSON.stringify(masked)));
  const shown = shapeDump({ win: { app: "Safari" }, nodes: masked });
  assert.ok(shown.includes("[message-content.user-query-bubble]"));
  assert.ok(!/confidential|Sierra/.test(shown));
});

test("a Swift compile failure shows the compiler's real errors, not its long command line, and recognises a toolchain mismatch", async () => {
  // shaped like what a real Mac printed: the error lines come first, then a very long command line
  const longLine = "/Library/Developer/CommandLineTools/usr/bin/swift-frontend -frontend -compile-module-from-interface -module-name Swift " + "-enable-experimental-feature X ".repeat(120);
  const stderr = [
    "error: failed to build module 'Swift'; this SDK is not supported by the compiler (the SDK is built with 'Apple Swift version 6.2', while this compiler is 'Apple Swift version 6.1'). Please select a toolchain which matches the SDK.",
    "note: compiled with a different version",
    longLine,
  ].join("\n");
  const help = compileHelp({ message: stderr.slice(-1500), full: stderr });
  assert.match(help, /does not match this Mac's system files/);
  assert.match(help, /Command Line Tools/);
  assert.match(help, /failed to build module 'Swift'/);          // the real error is shown
  assert.ok(help.length < 1200, "the long command line must not be dumped: " + help.length);
  // an ordinary compile error is shown line by line
  const plainLine = "/Library/Developer/CommandLineTools/usr/bin/swift-frontend -frontend -c ax.swift -module-name farfield_ax " + "-enable-experimental-feature X ".repeat(120);
  const plain = compileHelp({ full: "ax.swift:12:5: error: cannot find 'foo' in scope\nax.swift:30:1: error: expected '}'\n" + plainLine });
  assert.match(plain, /ax.swift:12:5: error: cannot find 'foo' in scope/);
  assert.match(plain, /expected '}'/);
  assert.ok(!/does not match/.test(plain));
  // the full output is saved to a file and its location is reported
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-log-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// x");
  await assert.rejects(ensureNative({ binDir: path.join(dir, "bin"), source: src, compile: async () => { throw Object.assign(new Error("tail"), { full: stderr }); } }), (err) => {
    assert.match(err.message, /saved in .*compile\.log/);
    assert.ok(fs.readFileSync(path.join(dir, "bin", "compile.log"), "utf8").includes("failed to build module"));
    return true;
  });
});

test("a compile failure that shows only the standard-library build command (what a real Mac printed) is still recognised as a toolchain mismatch", () => {
  const onlyTail = "brary-evolution -module-link-name swiftCore -parse-stdlib -language-mode 5 -O -library-level api -user-module-version 6.4.0.31.5 -module-name Swift";
  const help = compileHelp({ message: onlyTail, full: onlyTail });
  assert.match(help, /does not match this Mac's system files/);
  assert.match(help, /Software Update/);
});

test("the leak check matches whole values, so random ids and timestamps cannot cause a false alarm", () => {
  assert.equal(hasToken('{"id":"usr_ab2100cd"}', "2100"), false);          // inside an id
  assert.equal(hasToken("created 1794342100123", "2100"), false);          // inside a timestamp
  assert.equal(hasToken('{"after":"2100"}', "2100"), true);                // the value itself
  assert.equal(hasToken("revenue 2100 up", "2100"), true);
  assert.equal(hasToken("2100", "2100"), true);
  assert.equal(hasToken('{"a":"Revenue (USD m)"}', "Revenue (USD m)"), true);   // text with regex characters
  // regex characters are matched literally, never as patterns
  for (const [h, w, want] of [["RevenueXUSD m", "Revenue (USD m)", false], ["a.b", "a.b", true], ["axb", "a.b", false], ["x[1]", "x[1]", true], ["x1", "x[1]", false],
    ["c++", "c++", true], ["what?", "what?", true], ["a|b", "a|b", true], ["a", "a|b", false], ["$100", "$100", true], ["back\\slash", "back\\slash", true]]) {
    assert.equal(hasToken(h, w), want, JSON.stringify([h, w]));
  }
});

test("a compiler older than the system files retries with older SDKs from the same folder, newest first, never the one it refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-sdk-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// sdk test");
  const sdkDir = path.join(dir, "SDKs"); fs.mkdirSync(sdkDir);
  ["MacOSX.sdk", "MacOSX14.sdk", "MacOSX26.2.sdk", "MacOSX26.10.sdk", "MacOSX27.0.sdk"].forEach((n) => fs.mkdirSync(path.join(sdkDir, n)));
  const mismatch = (sdk) => Object.assign(new Error("tail"), { full: `${sdkDir}/${sdk}/usr/lib/swift/Swift.swiftmodule/arm64e-apple-macos.swiftinterface:1:1: error: failed to build module 'Swift'; this SDK is not supported by the compiler` });
  const calls = [];
  const works = new Set(["MacOSX26.2.sdk"]);                          // only this older SDK compiles
  const compile = async (cmd, args) => {
    const sdk = args.includes("-sdk") ? path.basename(args[args.indexOf("-sdk") + 1]) : "default";
    calls.push(sdk);
    if (sdk === "default") throw mismatch("MacOSX27.0.sdk");
    if (works.has(sdk)) { fs.writeFileSync(args[args.indexOf("-o") + 1], "bin"); return; }
    throw mismatch(sdk);
  };
  const bin = await ensureNative({ binDir: path.join(dir, "bin"), compile, source: src, sdkDir });
  assert.ok(fs.existsSync(bin));
  assert.deepEqual(calls, ["default", "MacOSX26.10.sdk", "MacOSX26.2.sdk"]);   // 26.10 is newer than 26.2; 27.0 (refused) and the MacOSX.sdk link are skipped

  // none of them work: a clear message that lists what was tried, and the log is saved
  calls.length = 0; works.clear();
  await assert.rejects(ensureNative({ binDir: path.join(dir, "bin2"), compile, source: src, sdkDir }), (err) => {
    assert.match(err.message, /older SDKs \(MacOSX26.10.sdk, MacOSX26.2.sdk, MacOSX14.sdk\) did not work/);
    assert.match(err.message, /Software Update/);
    assert.match(err.message, /compile\.log/);
    return true;
  });
  assert.deepEqual(calls, ["default", "MacOSX26.10.sdk", "MacOSX26.2.sdk", "MacOSX14.sdk"]);

  // an ordinary compile error is not retried with other SDKs, and a missing SDK folder is fine
  calls.length = 0;
  const plain = async (cmd, args) => { calls.push("x"); throw Object.assign(new Error("t"), { full: "ax.swift:3:1: error: expected '}'" }); };
  await assert.rejects(ensureNative({ binDir: path.join(dir, "bin3"), compile: plain, source: src, sdkDir }), /expected '}'/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(ensureNative({ binDir: path.join(dir, "bin4"), compile: async () => { calls.push("y"); throw mismatch("MacOSX27.0.sdk"); }, source: src, sdkDir: path.join(dir, "nope") }), /does not match/);
  assert.equal(calls.length, 1);
});

test("SDK shortcuts that point at an SDK already refused or tried are skipped (the layout seen on a real Mac)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-sdk2-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// sdk links");
  const sdkDir = path.join(dir, "SDKs"); fs.mkdirSync(sdkDir);
  for (const n of ["MacOSX27.0.sdk", "MacOSX26.5.sdk", "MacOSX15.4.sdk", "MacOSX11.1.sdk"]) fs.mkdirSync(path.join(sdkDir, n));
  for (const [link, target] of [["MacOSX.sdk", "MacOSX27.0.sdk"], ["MacOSX27.sdk", "MacOSX27.0.sdk"], ["MacOSX26.sdk", "MacOSX26.5.sdk"], ["MacOSX15.sdk", "MacOSX15.4.sdk"]]) fs.symlinkSync(target, path.join(sdkDir, link));
  const refusal = (sdk) => Object.assign(new Error("t"), { full: `${sdkDir}/${sdk}/usr/lib/swift/Swift.swiftmodule/x.swiftinterface:1:1: error: failed to build module 'Swift'; this SDK is not supported by the compiler` });
  const calls = [];
  const compileNone = async (cmd, args) => { calls.push(args.includes("-sdk") ? path.basename(args[args.indexOf("-sdk") + 1]) : "default"); throw refusal("MacOSX27.0.sdk"); };
  await assert.rejects(ensureNative({ binDir: path.join(dir, "b1"), compile: compileNone, source: src, sdkDir }), /older SDKs \(MacOSX26.5.sdk, MacOSX15.4.sdk, MacOSX11.1.sdk\)/);
  assert.deepEqual(calls, ["default", "MacOSX26.5.sdk", "MacOSX15.4.sdk", "MacOSX11.1.sdk"]);      // no 27.sdk, 26.sdk or 15.sdk repeats
  calls.length = 0;
  const compile265 = async (cmd, args) => { const sdk = args.includes("-sdk") ? path.basename(args[args.indexOf("-sdk") + 1]) : "default"; calls.push(sdk); if (sdk === "MacOSX26.5.sdk") { fs.writeFileSync(args[args.indexOf("-o") + 1], "bin"); return; } throw refusal("MacOSX27.0.sdk"); };
  const bin = await ensureNative({ binDir: path.join(dir, "b2"), compile: compile265, source: src, sdkDir });
  assert.ok(fs.existsSync(bin));
  assert.deepEqual(calls, ["default", "MacOSX26.5.sdk"]);                                          // stops at the first that works
});

test("auto engine: the native reader first, the slow one if it cannot be built, and never a fallback for a permission problem or a timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-auto-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// auto");
  const fsApi = { ...fs, readFileSync: (p, e) => (String(p).endsWith("ax.swift") ? "// auto" : fs.readFileSync(p, e)) };
  const ran = [];
  const mk = (compile, nativeResult) => createProbe("darwin", async (cmd, args) => {
    ran.push(cmd.includes("farfield-ax") ? "native" : "slow");
    if (cmd.includes("farfield-ax")) { if (nativeResult instanceof Error) throw nativeResult; return nativeResult || { engine: "native", visited: 5, nodes: [] }; }
    return { visited: 1, nodes: [] };
  }, async () => {}, { binDir: path.join(dir, "bin" + Math.random().toString(36).slice(2)), compile, fsApi });
  const ok = async (c, a) => { fs.writeFileSync(a[a.indexOf("-o") + 1], "bin"); };
  let r = await mk(ok).tree({});
  assert.equal(r.engine, "native"); assert.deepEqual(ran.splice(0), ["native"]);
  // Swift cannot be built here: fall back to the slow reader and say why
  r = await mk(async () => { throw Object.assign(new Error("spawn swiftc ENOENT"), { code: "ENOENT" }); }).tree({});
  assert.equal(r.engine, "events"); assert.match(r.fellBack, /Swift was not found/); assert.deepEqual(ran.splice(0), ["slow"]);
  // a permission problem or a timeout is not something the slow reader can fix
  await assert.rejects(mk(ok, new Error("macOS has not allowed this. Open System Settings > Privacy & Security > Accessibility")).tree({}), /Accessibility/);
  assert.deepEqual(ran.splice(0), ["native"]);
  await assert.rejects(mk(ok, new Error("It took longer than 30 seconds and was stopped.")).tree({}), /longer than/);
  ran.length = 0;
  // asking for the slow reader, by name, never touches Swift
  r = await mk(async () => { throw new Error("must not compile"); }).tree({ engine: "slow" });
  assert.equal(r.engine, "events"); assert.deepEqual(ran.splice(0), ["slow"]);
});

test("the watcher never compiles in the middle of its loop: an unbuilt native reader falls back to the slow one until 'screen build' is run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-nobuild-"));
  const compiled = []; const ran = [];
  const probe = createProbe("darwin", async (cmd) => { ran.push(cmd.includes("farfield-ax") ? "native" : "slow"); return { visited: 1, nodes: [] }; }, async () => {},
    { binDir: path.join(dir, "bin"), compile: async () => { compiled.push(1); } });
  const r = await probe.tree({ engine: "auto", build: false });
  assert.equal(compiled.length, 0);                                   // no compile was started
  assert.deepEqual(ran, ["slow"]);
  assert.match(r.fellBack, /not been built yet.*screen build/);
  await assert.rejects(ensureNative({ binDir: path.join(dir, "bin2"), build: false, compile: async () => { compiled.push(1); } }), /screen build/);
  assert.equal(compiled.length, 0);
});

test("the screen step asks for a read without building, and reads in a size and time that suit a loop", async () => {
  const s = setup(); const asked = [];
  s.probe.tree = async (o) => { asked.push(o); return { nodes: first }; };
  const a = s.mk();
  await a.tick();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].build, false);
  assert.equal(asked[0].engine, "auto");
  assert.ok(asked[0].timeoutMs <= 30000 && asked[0].maxNodes >= 2000);
});

test("screen dump reads the web page only by default, the whole window only when asked", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-scope-"));
  const asked = [];
  const probe = { title: async () => ({ app: "Safari", title: "x - Google Gemini" }), check: async () => ({}), tree: async (o) => { asked.push(o); return { engine: "native", visited: 1, nodes: [] }; } };
  await runCli(["screen", "dump"], home, probe);
  await runCli(["screen", "dump", "--scope", "window"], home, probe);
  assert.deepEqual(asked.map((o) => o.scope), ["web", "window"]);
});

test("screen build compiles the native reader once and says where it is", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-build-"));
  let got;
  const lines = []; const orig = process.stdout.write.bind(process.stdout); process.stdout.write = (c) => { lines.push(String(c)); return true; };
  try { await cli(["screen", "build"], { FARFIELD_HOME: home }, { ensureNative: async (o) => { got = o; return "/x/farfield-ax-abc123"; } }); } finally { process.stdout.write = orig; }
  assert.equal(got.binDir, path.join(home, "bin"));
  assert.match(lines.join(""), /Ready: \/x\/farfield-ax-abc123/);
});

test("the Swift reader is limited to the web page unless told otherwise (checked in the source, since it cannot be run here)", () => {
  const src = fs.readFileSync(new URL("../src/screen/ax.swift", import.meta.url), "utf8");
  for (const needle of ['"--scope"', "findWebArea", 'scope = "web"', "scopeWholeWindow", "var scope: String"]) assert.ok(src.includes(needle), needle);
  assert.ok(/\[\(start, 0\)\]/.test(src), "the walk must start from the chosen start element, not the whole window");
  assert.ok(!/\[\(win, 0\)\]/.test(src), "the walk must not start from the whole window");
});

test("browser name and profile at the end of a window title are removed before matching (Chrome, as seen on a real Mac)", () => {
  const id = (app, title) => { const r = identify({ app, title }); return r && r.id; };
  // the exact title seen in Chrome
  assert.equal(id("Google Chrome", "Chrome extension for correction tracking - Claude - Google Chrome - Charlotte (Person 1)"), "claude");
  assert.equal(id("Google Chrome", "Q3 summary - Claude - Google Chrome"), "claude");
  assert.equal(id("Google Chrome", "Weekly update - Google Gemini - Google Chrome - Work"), "gemini");
  assert.equal(id("Firefox", "Draft reply — ChatGPT — Mozilla Firefox"), "chatgpt");
  assert.equal(id("Safari", "Sierra AI Connection Follow-Up Draft - Google Gemini"), "gemini");       // Safari adds nothing, as before
  assert.equal(stripBrowserSuffix("A - B - Google Chrome - Charlotte (Person 1)"), "A - B");
  assert.equal(stripBrowserSuffix("Notes about Safari - Claude"), "Notes about Safari - Claude");      // a browser name inside the page title is left alone
  assert.equal(stripBrowserSuffix("Comparison - Safari vs Chrome - Claude"), "Comparison - Safari vs Chrome - Claude");
  assert.equal(stripBrowserSuffix("Plain title"), "Plain title");
  // look-alikes are still refused even with a browser tail
  assert.equal(id("Google Chrome", "Claude vs GPT - Google Docs - Google Chrome - Charlotte (Person 1)"), null);
  assert.equal(id("Google Chrome", "Inbox - Gmail - Google Chrome - Charlotte (Person 1)"), null);
  assert.equal(id("Google Chrome", "Notes about Claude - Google Chrome"), null);
  assert.equal(id("Google Chrome", "Q3 summary - Claude - Google Chrome", ), "claude");
  assert.equal(identify({ app: "Google Chrome", title: "Q3 summary - Claude - Google Chrome - Work" }, ["chatgpt"]), null);                // still respects the allowed list
});

test("native reader: the focus and tail hints are passed to the program, and only when given", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-focus-"));
  const src = path.join(dir, "ax.swift"); fs.writeFileSync(src, "// focus");
  const ran = [];
  const probe = createProbe("darwin", async (cmd, args) => { ran.push(args); return { engine: "native", visited: 1, nodes: [] }; }, async () => {},
    { binDir: path.join(dir, "bin"), compile: async (c, a) => { fs.writeFileSync(a[a.indexOf("-o") + 1], "bin"); }, fsApi: { ...fs, readFileSync: (p, e) => (String(p).endsWith("ax.swift") ? "// focus" : fs.readFileSync(p, e)) } });
  await probe.tree({ engine: "native", focus: "Chat messages", tail: 900 });
  assert.deepEqual(ran[0].slice(ran[0].indexOf("--focus")), ["--focus", "Chat messages", "--tail", "900"]);
  await probe.tree({ engine: "native", focus: "Chat messages" });
  assert.equal(ran[1][ran[1].indexOf("--tail") + 1], "1500");                       // a default tail
  await probe.tree({ engine: "native" });
  assert.ok(!ran[2].includes("--focus") && !ran[2].includes("--tail"));
});

test("the screen step asks for the tail of Claude's message list, and nothing special for Gemini", async () => {
  const asked = [];
  for (const [title, expectFocus] of [["Q3 summary - Claude", "Chat messages"], ["Q3 summary - Google Gemini", undefined]]) {
    const s = setup({ tools: ["claude", "gemini"] });
    s.state.win = { app: "Google Chrome", title }; s.state.nodes = first;
    s.probe.tree = async (o) => { asked.push(o); return { nodes: first }; };
    await s.mk().tick();
    assert.equal(asked.at(-1).focus, expectFocus, title);
    if (expectFocus) assert.ok(asked.at(-1).tail >= 500);
  }
});

test("screen dump uses the same hints as the watcher, reads a generous amount, and says what the focus did", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-dump-focus-"));
  const asked = [];
  const mk = (focus) => ({ title: async () => ({ app: "Google Chrome", title: "x - Claude - Google Chrome - Me" }), check: async () => ({}), tree: async (o) => { asked.push(o); return { engine: "native", visited: 40, focus, skipped: 3100, nodes: [] }; } });
  const found = await runCli(["screen", "dump"], home, mk("found"));
  assert.equal(asked[0].focus, "Chat messages"); assert.ok(asked[0].maxNodes >= 5000);
  assert.match(found.out, /Jumped to the message list and read only its last part \(3100 earlier items skipped\)/);
  const missing = await runCli(["screen", "dump"], home, mk("missing"));
  assert.match(missing.out, /Could not find the message list by its label/);
});

test("the Swift reader can jump to a labelled element and read only the end of its children (checked in the source)", () => {
  const src = fs.readFileSync(new URL("../src/screen/ax.swift", import.meta.url), "utf8");
  for (const needle of ['"--focus"', '"--tail"', "findByLabel", "kids.suffix(tailCount)", "focusResult", "skippedChildren", "var focus: String", "var skipped: Int"]) assert.ok(src.includes(needle), needle);
  assert.ok(/if d == 0 && tailing/.test(src), "only the first level is cut to its tail");
});

test("the same kind of task groups into one workflow across tools by default, and 'tool' naming gives one row per tool", () => {
  let t = 1_700_000_000_000;
  const mk = (who) => [...lines(["You", "Summarize the Q3 earnings call for Acme Corp"], [who, "Revenue was $1.2 billion."]), ...lines(["You", "The revenue figure is wrong, it was $1.1 billion"])];
  const run = (naming) => {
    const o = createObserver({ now: () => t, mode: "full", naming });
    const a = o.feed({ nodes: mk("Claude") }, { id: "claude", name: "Claude" });
    t += 1000;
    const b = o.feed({ nodes: mk("Gemini") }, { id: "gemini", name: "Gemini" });
    return [a, b];
  };
  const [a, b] = run("task");
  assert.equal(a.sessions[0].workflow, "Summary"); assert.equal(a.rePrompts[0].workflow, "Summary");
  assert.equal(b.sessions[0].workflow, "Summary"); assert.equal(b.rePrompts[0].workflow, "Summary");     // the same workflow, from two tools
  assert.equal(a.sessions[0].site, "Claude"); assert.equal(b.sessions[0].site, "Gemini");
  const [c, d] = run("tool");
  assert.equal(c.sessions[0].workflow, "Claude chat"); assert.equal(d.sessions[0].workflow, "Gemini chat");
  assert.ok(![a, b, c, d].some((r) => JSON.stringify(r).includes("Unassigned")));
});

test("the observer reports how many messages were on screen, even when none are new", () => {
  let t = 1_700_000_000_000; const o = createObserver({ now: () => t, mode: "full" });
  const tool = { id: "claude", name: "Claude" };
  assert.equal(o.feed({ nodes: first }, tool).seen, 2);
  t += 5000;
  const again = o.feed({ nodes: first }, tool);
  assert.equal(again.seen, 2); assert.equal(again.labels.length, 0);
  assert.equal(o.feed({ nodes: [{ role: "AXStaticText", text: "nothing here" }] }, tool).seen, 0);
});

test("screen log: every distinct look is recorded without any message text, and an unchanged look is not repeated", async () => {
  const s = setup({ tools: ["claude"] }); const a = s.mk();
  s.state.win = { app: "Google Chrome", title: "Inbox - Gmail - Google Chrome - Me" };
  await a.tick();
  s.c.tick(30); s.state.win = { app: "Google Chrome", title: "Q3 summary - Claude - Google Chrome - Me" }; s.state.nodes = first;
  await a.tick();
  s.c.tick(15); await a.tick();                                       // the same screen again: not logged twice
  s.c.tick(30); s.state.nodes = [...first, ...lines(["You", "The revenue figure is wrong, it was $1.1 billion"])];
  await a.tick();
  const log = (await a.storage.local.get("screenLog")).screenLog;
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((e) => e.skipped || e.tool), ["not_allowed", "claude", "claude"]);
  assert.deepEqual(log.map((e) => [e.seen, e.labels, e.rePrompts]), [[0, 0, 0], [2, 0, 0], [3, 1, 1]]);
  const raw = JSON.stringify(log);
  assert.ok(!/Acme|revenue figure|Inbox|Q3 summary/.test(raw), "the log must not hold message text or real titles");
  const r = await runCli(["screen", "log"], s.home, null);
  const rows = r.out.trim().split("\n");
  assert.match(rows[0], /^Chat reading is ON\./);
  assert.equal(rows.length, 1 + 1 + 3);                                  // header, the "is the app still running?" hint (the test clock is old), then three looks
  assert.match(rows[1], /Is `node src\/cli.js app` still running/);
  assert.match(rows[2], /the window in front was Google Chrome \(title pattern: Xxxxx - Gmail - Google Chrome - Xx\), which does not look like an AI chat/);
  assert.match(rows[3], /claude: 2 message\(s\) on screen, 0 new follow-up\(s\), 0 counted/);
  assert.match(rows[4], /claude: 3 message\(s\) on screen, 1 new follow-up\(s\), 1 counted/);
  const empty = await runCli(["screen", "log"], fs.mkdtempSync(path.join(os.tmpdir(), "ff-nolog-")), null);
  assert.match(empty.out, /Nothing logged yet/);
});

test("a probe error shows up in the log with its reason", async () => {
  const s = setup(); const a = s.mk();
  s.probe.title = async () => { throw new Error("macOS has not allowed this. Open System Settings > Privacy & Security > Accessibility"); };
  await a.tick();
  const r = await runCli(["screen", "log"], s.home, null);
  assert.match(r.out, /could not read the window: macOS has not allowed this/);
});

test("title pattern: AI tool, browser and common app names are kept, everything else is masked", () => {
  assert.equal(titleShape("Chrome extension for correction tracking - Claude - Google Chrome - Charlotte (Person 1)"), "Chrome xxxxxxxxx xxx xxxxxxxxxx xxxxxxxx - Claude - Google Chrome - Xxxxxxxxx (Xxxxxx 9)");
  assert.equal(titleShape("Q3 summary for Acme - Claude"), "x9 xxxxxxx xxx Xxxx - Claude");
  assert.equal(titleShape("Inbox - Gmail - Google Chrome - Me"), "Xxxxx - Gmail - Google Chrome - Xx");
  assert.equal(titleShape("Sierra AI Connection Follow-Up Draft - Google Gemini"), "Xxxxxx Xx Xxxxxxxxxx Xxxxxx-Xx Xxxxx - Google Gemini");
  assert.equal(titleShape("\u200eSecret deal 2026"), "Xxxxxx xxxx 9999");
  assert.ok(!/Secret|Acme|Sierra|correction/.test(titleShape("Secret Acme Sierra correction - Claude")));
  assert.equal(titleShape("").length, 0);
});

test("screen log: an entry that stays the same for a while shows its whole span, and the header says on/off and how stale it is", async () => {
  const s = setup(); const a = s.mk();
  s.state.win = { app: "Terminal", title: "farfield-agent - node src/cli.js app - 80x24" };
  await a.tick();
  s.c.tick(90); await a.tick();                                            // still the same look, a minute and a half later
  s.c.tick(90); await a.tick();
  const log = (await a.storage.local.get("screenLog")).screenLog;
  assert.equal(log.length, 1);
  assert.ok(log[0].lastAt - log[0].at >= 150000);
  const r = await runCli(["screen", "log"], s.home, null);
  assert.match(r.out, /\d\d:\d\d:\d\d-\d\d:\d\d:\d\d  the window in front was Terminal/);
  assert.match(r.out, /Is `node src\/cli.js app` still running/);
  const cfg = loadConfig(s.home); cfg.screen = { ...cfg.screen, enabled: false }; saveConfig(s.home, cfg);
  assert.match((await runCli(["screen", "log"], s.home, null)).out, /^Chat reading is OFF\./);
  cfg.paused = true; cfg.screen.enabled = true; saveConfig(s.home, cfg);
  assert.match((await runCli(["screen", "log"], s.home, null)).out, /^Chat reading is ON \(paused\)\./);
});

test("Chrome's status notices at the end of a window title (a heavy tab shows 'High memory usage - 1.9 GB') do not stop a chat from being recognised", () => {
  const id = (title) => { const r = identify({ app: "Google Chrome", title }); return r && r.id; };
  // the shape seen in a real log: "... - Claude - High memory usage - 1.9 GB - Google Chrome - Charlotte (Person 1)"
  assert.equal(id("Chrome extension for correction tracking - Claude - High memory usage - 1.9 GB - Google Chrome - Charlotte (Person 1)"), "claude");
  assert.equal(id("New chat - Claude - High memory usage - 1.5 GB - Google Chrome - Charlotte (Person 1)"), "claude");
  assert.equal(id("Q3 notes - Google Gemini - High memory usage - 850 MB - Google Chrome - Work"), "gemini");
  assert.equal(id("Q3 notes - Claude - High memory usage - 2 GB - Google Chrome"), "claude");
  assert.equal(id("Q3 notes - Claude - High memory usage - Google Chrome - Me"), "claude");            // no size given
  assert.equal(id("Q3 notes - Claude - Audio playing - Google Chrome - Me"), "claude");
  assert.equal(id("Q3 notes - Claude - High memory usage - 1.9 GB - Audio playing - Google Chrome - Me"), "claude");   // more than one notice
  assert.equal(id("Q3 notes - Claude - Google Chrome - Me"), "claude");                                  // none, as before
  // still refused
  assert.equal(id("Notes about Claude - High memory usage - 1.9 GB - Google Chrome - Me"), null);
  assert.equal(id("Claude vs GPT - Google Docs - High memory usage - 1.9 GB - Google Chrome - Me"), null);
  assert.equal(id("Inbox - Gmail - High memory usage - 1.9 GB - Google Chrome - Me"), null);
  assert.equal(stripStatusNotices("A - Claude - High memory usage - 1.9 GB"), "A - Claude");
  assert.equal(stripStatusNotices("A - High memory usage of the system - Claude"), "A - High memory usage of the system - Claude");   // only at the very end
  assert.equal(stripStatusNotices("Plain"), "Plain");
});

test("the double-click launcher starts the app from its own folder, and can be run (executable, with a shebang)", () => {
  const file = new URL("../Start Farfield.command", import.meta.url);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("#!/bin/bash\n"));
  assert.match(text, /cd "\$\(dirname "\$0"\)" \|\| exit 1/);
  assert.match(text, /exec node src\/cli\.js app/);
  assert.ok(fs.statSync(file).mode & 0o100, "the owner execute bit must be set so a double-click works");
  assert.ok(!/caffeinate|sudo|launchctl/.test(text), "it must not change power settings, ask for admin rights, or install anything");
});
