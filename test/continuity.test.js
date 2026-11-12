import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObserver } from "../src/screen/observer.js";
import { chatTitle } from "../src/screen/sites.js";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults } from "../src/config.js";
import { main as cli } from "../src/cli.js";

const L = (...p) => p.flatMap(([w, x]) => [{ role: "AXStaticText", text: w }, { role: "AXStaticText", text: x }]);
const tool = { id: "claude", name: "Claude" };
const m1 = L(["You", "Summarize the Q3 earnings call for Acme Corp"], ["Claude", "Acme reported revenue of $1.2 billion."]);
const m2 = L(["You", "The revenue figure is wrong, it was $1.1 billion"], ["Claude", "Corrected to $1.1 billion."]);
const m3 = L(["You", "Make it shorter and more formal"], ["Claude", "Shorter formal version."]);
const clock = () => { let t = 1_700_000_000_000; return { now: () => t, tick: (s) => { t += s * 1000; } }; };

test("a restarted watcher that remembers fingerprints keeps one session, counts the new correction once, and does not recount old ones", () => {
  const c = clock();
  const a = createObserver({ now: c.now, mode: "full", salt: "s1" });
  a.feed({ nodes: m1 }, tool); c.tick(30);
  const a2 = a.feed({ nodes: [...m1, ...m2] }, tool);
  const sessionId = a2.sessions.at(-1).id;
  assert.equal(a2.rePrompts.length, 1);
  const saved = JSON.parse(JSON.stringify(a.snapshot()));          // as it would come back from a file
  c.tick(600);
  // the app was restarted; the chat has grown; the first message has scrolled out of view
  const b = createObserver({ now: c.now, mode: "full", salt: "s1", state: saved });
  const r = b.feed({ nodes: [...m2, ...m3] }, tool);
  assert.equal(b.conversations(), 1);
  assert.ok(r.sessions.some((s) => s.id === sessionId), "same session as before the restart");
  assert.equal(r.rePrompts.length, 1);                             // only the new message (m3), not m2 again
  assert.match(r.rePrompts[0].text, /shorter and more formal/);
  assert.equal(r.rePrompts[0].attemptIndex, 3);                    // the first prompt, m2 and m3
});

test("without any memory, a chat that began earlier is not mistaken for a new one: an assistant reply at the top of the screen means so", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const r = o.feed({ nodes: [...L(["Claude", "Corrected to $1.1 billion."]), ...m3] }, tool);        // the screen starts with a reply
  assert.equal(r.rePrompts.length, 1);
  assert.match(r.rePrompts[0].text, /shorter and more formal/);
  // but a screen that starts with the person's message is a new chat, and its first message is the first prompt
  const o2 = createObserver({ now: c.now, mode: "full" });
  assert.equal(o2.feed({ nodes: m3 }, tool).rePrompts.length, 0);
});

test("what is remembered is salted fingerprints, counts and times, never message text or a title", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full", salt: "secret-salt" });
  o.feed({ nodes: [...m1, ...m2] }, tool, { title: "Q3 earnings summary for Acme" });
  const raw = JSON.stringify(o.snapshot());
  assert.ok(!/Acme|revenue|Summarize|earnings|figure|wrong|billion|Q3/i.test(raw), raw.slice(0, 300));
  const snap = o.snapshot().convs[0];
  assert.ok(snap.keys.every((k) => /^[0-9a-f]{16}$/.test(k)));
  assert.match(snap.titleHash, /^[0-9a-f]{16}$/);
  // a different salt (another computer) gives different fingerprints for the same messages
  const o2 = createObserver({ now: c.now, mode: "full", salt: "another-salt" });
  o2.feed({ nodes: [...m1, ...m2] }, tool, { title: "Q3 earnings summary for Acme" });
  const snap2 = o2.snapshot().convs[0];
  assert.ok(snap.keys.every((k) => !snap2.keys.includes(k)));
  assert.notEqual(snap.titleHash, snap2.titleHash);
});

test("the chat's title fingerprint keeps a chat together when its earlier messages have scrolled away completely", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const first = o.feed({ nodes: [...m1] }, tool, { title: "Q3 earnings summary" });
  const sessionId = first.sessions.at(-1).id;
  c.tick(300);
  const far = L(["You", "Remove the last paragraph"], ["Claude", "Done, the last paragraph is removed."]);       // no message in common with m1
  const same = o.feed({ nodes: [...L(["Claude", "an older reply that is on screen now"]), ...far] }, tool, { title: "Q3 earnings summary" });
  assert.equal(o.conversations(), 1);
  assert.ok(same.sessions.some((s) => s.id === sessionId));
  assert.equal(same.rePrompts.length, 1);
  // a different title with nothing in common is a different chat
  const o2 = createObserver({ now: c.now, mode: "full" });
  o2.feed({ nodes: m1 }, tool, { title: "Q3 earnings summary" });
  o2.feed({ nodes: far }, tool, { title: "Lunch plans" });
  assert.equal(o2.conversations(), 2);
  // a default title carries no identity, so two untitled chats are never merged by it
  const o3 = createObserver({ now: c.now, mode: "full" });
  o3.feed({ nodes: m1 }, tool, { title: chatTitle({ title: "New chat - Claude - Google Chrome - Me" }, tool) });
  o3.feed({ nodes: far }, tool, { title: chatTitle({ title: "New chat - Claude - Google Chrome - Me" }, tool) });
  assert.equal(o3.conversations(), 2);
});

test("chatTitle: the page's own title, without the browser's tail, status notices or the tool's name; empty when untitled", () => {
  const t = { id: "claude", name: "Claude", names: ["Claude"] };
  assert.equal(chatTitle({ title: "Q3 earnings summary - Claude - High memory usage - 1.9 GB - Google Chrome - Charlotte (Person 1)" }, t), "Q3 earnings summary");
  assert.equal(chatTitle({ title: "Q3 earnings summary - Claude" }, t), "Q3 earnings summary");
  assert.equal(chatTitle({ title: "Claude" }, t), "");
  assert.equal(chatTitle({ title: "New chat - Claude - Google Chrome" }, t), "");
  const g = { id: "gemini", name: "Gemini", names: ["Gemini", "Google Gemini"] };
  assert.equal(chatTitle({ title: "Sierra follow-up draft - Google Gemini" }, g), "Sierra follow-up draft");
  assert.equal(chatTitle({ title: "Google Gemini" }, g), "");
  assert.equal(chatTitle(null, g), "");
});

test("the memory is bounded: 400 fingerprints per chat, 30 chats, and nothing older than a week", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const many = Array.from({ length: 450 }, (_, i) => L(["You", `message number ${i} about topic ${i * 7}`], ["Claude", `reply ${i} with details ${i * 3}`])).flat();
  o.feed({ nodes: many }, tool, { title: "A very long chat" });
  assert.equal(o.snapshot().convs[0].keys.length, 400);
  const o2 = createObserver({ now: c.now, mode: "full" });
  for (let i = 0; i < 40; i++) { o2.feed({ nodes: L(["You", `unique chat ${i} opening`], ["Claude", `unique chat ${i} reply`]) }, tool, { title: `Chat ${i}` }); c.tick(1); }
  assert.equal(o2.snapshot().convs.length, 30);
  const o3 = createObserver({ now: c.now, mode: "full" });
  o3.feed({ nodes: m1 }, tool);
  c.tick(8 * 24 * 3600);
  assert.equal(o3.snapshot().convs.length, 0);
});

test("a damaged or unknown saved memory is ignored, not trusted and not fatal", () => {
  const c = clock();
  for (const bad of [null, undefined, {}, { v: 2, convs: [] }, { v: 1 }, { v: 1, convs: "x" }, { v: 1, convs: [null, 5, {}, { id: 1 }, { id: "c", tool: "claude", keys: "no" }] }]) {
    const o = createObserver({ now: c.now, mode: "full", state: bad });
    assert.equal(o.conversations(), 0);
    assert.doesNotThrow(() => o.feed({ nodes: m1 }, tool));
  }
});

test("review time survives a restart: the follow-up is timed from when the reply was first seen, not from the restart", () => {
  const c = clock();
  const a = createObserver({ now: c.now, mode: "full", salt: "k" });
  a.feed({ nodes: m1 }, tool);                                     // the reply to m1 was seen at t0
  const saved = JSON.parse(JSON.stringify(a.snapshot()));
  c.tick(120);
  const b = createObserver({ now: c.now, mode: "full", salt: "k", state: saved });
  const r = b.feed({ nodes: [...m1, ...m2] }, tool);
  assert.equal(r.rePrompts.length, 1);
  assert.ok(r.rePrompts[0].reviewSeconds >= 119, "review seconds: " + r.rePrompts[0].reviewSeconds);
});

function setup(screen) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-cont-"));
  const home = path.join(root, "home"); const watch = path.join(root, "dl"); fs.mkdirSync(watch, { recursive: true });
  saveConfig(home, { ...defaults(), folders: [watch], screen: { enabled: true, storeMode: "full", intervalSeconds: 2, tools: ["claude"], ...(screen || {}) } });
  const state = { win: { app: "Google Chrome", title: "Q3 earnings summary - Claude - Google Chrome - Me" }, nodes: m1 };
  const probe = { title: async () => state.win, tree: async () => ({ nodes: state.nodes }) };
  const c = clock();
  return { home, state, c, mk: () => createAgent({ home, now: c.now, probe, fetch: async () => { throw new Error("offline"); } }) };
}

test("the watcher saves its memory, and a restarted agent carries on the same chat", async () => {
  const s = setup(); let a = s.mk();
  await a.tick(); s.c.tick(30);
  s.state.nodes = [...m1, ...m2];
  await a.tick();
  const before = await a.storage.local.get(["observerState", "observerSalt", "aiSessions", "rePrompts"]);
  assert.match(before.observerSalt, /^[0-9a-f]{32}$/);
  assert.equal(before.observerState.convs.length, 1);
  assert.ok(!/Acme|revenue|billion/i.test(JSON.stringify(before.observerState)));
  const sessionIds = new Set(before.aiSessions.map((x) => x.id));
  // a new agent process, the first message has scrolled away
  s.c.tick(600); a = s.mk(); s.state.nodes = [...m2, ...m3];
  await a.tick();
  const after = await a.storage.local.get(["aiSessions", "rePrompts", "observerSalt"]);
  assert.equal(after.observerSalt, before.observerSalt);           // the same salt, so the old fingerprints still match
  assert.equal(new Set(after.aiSessions.map((x) => x.id)).size, sessionIds.size);
  assert.equal(after.rePrompts.length, 2);                         // m2 and m3, each once
});

test("forget --memory clears what chat reading remembers, and plain forget leaves it", async () => {
  const s = setup(); const a = s.mk();
  await a.tick();
  assert.ok((await a.storage.local.get("observerState")).observerState);
  const run = async (argv) => { const lines = []; const orig = process.stdout.write.bind(process.stdout); process.stdout.write = (x) => { lines.push(String(x)); return true; }; try { await cli(argv, { FARFIELD_HOME: s.home }, {}); } finally { process.stdout.write = orig; } return lines.join(""); };
  await run(["screen", "forget"]);
  assert.ok((await createAgent({ home: s.home }).storage.local.get("observerState")).observerState, "plain forget must not clear the memory");
  const out = await run(["screen", "forget", "--memory"]);
  assert.match(out, /Cleared what chat reading remembers/);
  const gone = await createAgent({ home: s.home }).storage.local.get(["observerState", "observerSalt", "screenLog"]);
  assert.deepEqual(gone, {});
});

test("screen naming sets how workflows are named, rejects anything else, and explains each choice", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-naming-"));
  const run = async (argv) => { const lines = []; const orig = process.stdout.write.bind(process.stdout); process.stdout.write = (x) => { lines.push(String(x)); return true; }; let code; try { code = await cli(argv, { FARFIELD_HOME: home }, {}); } finally { process.stdout.write = orig; } return { code, out: lines.join("") }; };
  const read = () => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).screen.workflowNames;
  assert.equal((await run(["screen", "naming", "tool"])).code, 0); assert.equal(read(), "tool");
  const ok = await run(["screen", "naming", "first-prompt"]); assert.equal(read(), "first-prompt");
  assert.match(ok.out, /existing ones keep their names/);
  assert.match(ok.out, /opening line/);
  assert.equal((await run(["screen", "naming", "task"])).code, 0); assert.equal(read(), "task");
  const bad = await run(["screen", "naming", "everything"]);
  assert.equal(bad.code, 1); assert.equal(read(), "task");                            // unchanged
  assert.match(bad.out, /Use: screen naming task \| tool \| first-prompt/);
  const none = await run(["screen", "naming"]); assert.equal(none.code, 0); assert.match(none.out, /task\s+name each workflow by the kind of task/);
});

test("the watcher follows the naming setting, and switching it takes effect for new tasks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-wn-")); const home = path.join(root, "home");
  saveConfig(home, { ...defaults(), folders: [], screen: { enabled: true, storeMode: "full", intervalSeconds: 2, tools: ["claude"], workflowNames: "tool" } });
  const c = clock();
  const state = { win: { app: "Google Chrome", title: "Q3 notes - Claude - Google Chrome - Me" }, nodes: m1 };
  const a = createAgent({ home, now: c.now, probe: { title: async () => state.win, tree: async () => ({ nodes: state.nodes }) } });
  await a.tick();
  assert.equal((await a.storage.local.get("aiSessions")).aiSessions[0].workflow, "Claude chat");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); cfg.screen.workflowNames = "task"; fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  c.tick(30);
  state.win = { app: "Google Chrome", title: "Draft - Claude - Google Chrome - Me" };
  state.nodes = L(["You", "Draft an email to the client about the delayed settlement"], ["Claude", "Dear client, your settlement is delayed."]);
  await a.tick();
  const names = (await a.storage.local.get("aiSessions")).aiSessions.map((s) => s.workflow).sort();
  assert.deepEqual(names, ["Claude chat", "Email draft"]);                            // the old task keeps its name, the new one follows the new setting
});
