import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { identify, cleanTitle, showTitle } from "../src/screen/sites.js";
import { explain, createProbe, PICK_SOURCE } from "../src/screen/probe.js";
import { shapeDump, maskNodes } from "../src/screen/shape.js";
import { extractTurns } from "../src/screen/turns.js";
import { createObserver } from "../src/screen/observer.js";
import { createScreenStep } from "../src/screen/watch.js";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults, loadConfig } from "../src/config.js";
import { createFileStorage } from "../src/storage.js";
import { main as cli } from "../src/cli.js";

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
  const plain = await probe.tree({});
  assert.equal(scripts.length, 1); assert.ok(!scripts[0].includes("AXManualAccessibility")); assert.equal(plain.accessibility, undefined);
  scripts.length = 0;
  const asked = await probe.tree({ enableAccessibility: true });
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
  await probe.tree({}); await probe.tree({ enableAccessibility: true }); await probe.tree({ engine: "fast" });
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
  await probe.title(); await probe.check(); await probe.tree({});
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
  await createProbe("darwin", async (cmd, args) => { script = args[args.length - 1]; return { nodes: [] }; }).tree({});
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
