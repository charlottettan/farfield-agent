import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { identifyEmail, identify } from "../src/screen/sites.js";
import { gmailDraft, cutQuoted } from "../src/screen/adapters/gmail.js";
import { overlap, matchReply, aiSpan, createEmailTracker } from "../src/screen/email.js";
import { createScreenStep } from "../src/screen/watch.js";
import { createProbe } from "../src/screen/probe.js";
import { createFileStorage } from "../src/storage.js";
import { defaults } from "../src/config.js";

// An AI reply that offers options, and the email a person built from option 2 and then edited (all wording invented).
const REPLY = [
  "Here are two ways you could write it.",
  "Option 1: Short",
  "Hi Tim,",
  "Quick note to confirm we are on for the review next week.",
  "Best,",
  "Option 2: Detailed",
  "Hi Tim,",
  "Thanks again for making time to meet with our team on Tuesday afternoon.",
  "As we discussed, the revised budget will be ready by November 14 and I will send it over as soon as it is final.",
  "Please let me know if you have any questions in the meantime.",
  "Best regards,",
  "Sam",
  "Want me to make it more formal?",
].join("\n");
const SENT = [
  "Hi Tim,",
  "Thanks again for meeting with our team on Tuesday.",
  "As we discussed, the revised budget will be ready by November 18 and I will send it over as soon as it is final.",
  "Let me know if anything comes up before then.",
  "Best regards,",
  "Sam",
].join("\n");

const N = (role, depth, text = "", dom = "") => ({ role, depth, text, dom });
// What the native reader returns when it starts at the "Message Body" box: the box itself, then the draft's lines,
// then the signature and the quoted earlier message (their class names follow Gmail's HTML; not yet checked on a real dump).
const draftNodes = (body, extra = []) => [
  N("AXTextArea", 0, body + "\nSam Lee | Finance\nOn Mon, Nov 10, 2026 at 9:02 AM Tim <tim@example.com> wrote:\n> old text", ".Am.Al.editable.LW-avf"),
  ...body.split("\n").map((l) => N("AXStaticText", 1, l)),
  N("AXGroup", 1, "", ".gmail_signature"), N("AXStaticText", 2, "Sam Lee | Finance"),
  N("AXGroup", 1, "", ".gmail_quote"), N("AXStaticText", 2, "On Mon, Nov 10, 2026 at 9:02 AM Tim <tim@example.com> wrote:"), N("AXStaticText", 3, "old text from Tim"),
  ...extra,
];

test("email apps: Gmail is recognised only when email reading allows it, and only in a browser", () => {
  assert.equal(identifyEmail({ app: "Google Chrome", title: "Inbox (3) - sam@example.com - Gmail" }, ["gmail"]).id, "gmail");
  assert.equal(identifyEmail({ app: "Safari", title: "Compose Mail - sam@example.com - Gmail" }, ["gmail"]).id, "gmail");
  assert.equal(identifyEmail({ app: "Google Chrome", title: "Re: budget - sam@example.com - Gmail - Google Chrome - Sam (Work)" }, ["gmail"]).id, "gmail");
  assert.equal(identifyEmail({ url: "https://mail.google.com/mail/u/0/#inbox" }, ["gmail"]).id, "gmail");
  assert.equal(identifyEmail({ url: "https://mail.google.com.evil.com/" }, ["gmail"]), null);
  assert.equal(identifyEmail({ app: "Google Chrome", title: "Inbox - Gmail" }, []), null);                    // email reading off
  assert.equal(identifyEmail({ app: "Google Chrome", title: "Inbox - Gmail" }), null);
  assert.equal(identifyEmail({ app: "Mail", title: "Inbox - Gmail" }, ["gmail"]), null);                    // not a browser
  assert.equal(identifyEmail({ app: "Google Chrome", title: "Gmail tips - Google Docs" }, ["gmail"]), null);
  assert.equal(identify({ app: "Google Chrome", title: "Inbox - Gmail" }), null);                            // still never an AI chat
});

test("gmail draft: only the person's own lines are read, not the signature or the quoted earlier email", () => {
  const d = gmailDraft(draftNodes(SENT));
  assert.equal(d.body, SENT);
  assert.ok(!d.body.includes("old text") && !d.body.includes("Finance"));
  assert.equal(gmailDraft([]), null);
  // a box exposed only as one value: cut where the quoted message starts
  assert.equal(cutQuoted("Sounds good.\nThanks\nOn Mon, Nov 10, 2026 at 9:02 AM Tim <tim@example.com> wrote:\n> hi"), "Sounds good.\nThanks");
  assert.equal(gmailDraft([N("AXTextArea", 0, "Sounds good.\n---------- Forwarded message ---------\nFrom: x")]).body, "Sounds good.");
});

test("matching: a draft built from an AI reply is matched to it, and the AI version is only the option that was used", () => {
  const replies = [{ text: "Revenue for Q3 grew 12 percent, driven by the enterprise segment and lower churn in Europe.", tool: "Claude" }, { text: REPLY, tool: "Gemini" }];
  assert.equal(matchReply(SENT, replies).tool, "Gemini");
  assert.ok(overlap(SENT, REPLY).share > 0.25);
  const span = aiSpan(REPLY, SENT);
  assert.ok(span.startsWith("Hi Tim,\nThanks again for making time"), span);
  assert.ok(span.endsWith("Best regards,\nSam"), span);
  assert.ok(!span.includes("Option 1") && !span.includes("Quick note") && !span.includes("more formal"));
  // the person's own email, and a two-word reply, match nothing
  assert.equal(matchReply("Hey, are we still on for lunch tomorrow at noon? I can book the usual place.", replies), null);
  assert.equal(matchReply("Thanks Tim!", replies), null);
});

test("tracker: an AI draft that was edited and then closed becomes one Gmail correction; the person's own drafts leave nothing", () => {
  let t = 1_000_000;
  const tr = createEmailTracker({ now: () => t, mode: "redacted", salt: "s".repeat(16) });
  const GMAIL = { id: "gmail", name: "Gmail", surface: "Gmail" };
  tr.noteReplies("Gemini", [REPLY]);
  assert.equal(tr.see(GMAIL, "Hey, are we still on for lunch tomorrow at noon? I can book the usual place."), null);
  assert.equal(tr.following(), false);                                   // not from an AI reply: dropped
  assert.equal(tr.see(GMAIL, null), null);                               // closing it records nothing
  // the person pastes option 2, then edits it over two looks
  t += 10_000; assert.equal(tr.see(GMAIL, aiSpan(REPLY, SENT)), null);
  assert.equal(tr.following(), true);
  t += 10_000; assert.equal(tr.see(GMAIL, SENT.replace("November 18", "November 16")), null);
  t += 10_000; assert.equal(tr.see(GMAIL, SENT), null);
  t += 10_000; const done = tr.see(GMAIL, null);                        // the draft box went away
  assert.equal(done.correction.surface, "Gmail");
  assert.equal(done.correction.agent, "Gemini");
  assert.equal(done.correction.workflow, "Email draft");
  assert.equal(done.correction.ended, "closed");
  assert.equal(done.correction.activeSeconds, 20);
  assert.equal(done.send.surface, "Gmail");
  assert.ok(done.correction.wordsAdded > 0 && done.correction.wordsRemoved > 0);
  assert.ok(!/\d/.test(done.correction.originalSnippet + done.correction.editedSnippet), "numbers are masked in redacted mode");
  assert.equal(tr.following(), false);
});

test("tracker: a draft left open is closed after 30 minutes, and AI replies are forgotten after 3 hours", () => {
  let t = 0;
  const tr = createEmailTracker({ now: () => t, mode: "off" });
  const GMAIL = { id: "gmail", name: "Gmail", surface: "Gmail" };
  tr.noteReplies("Claude", [REPLY]);
  tr.see(GMAIL, SENT);
  t += 31 * 60 * 1000;
  const done = tr.tick();
  assert.equal(done.correction.ended, "idle");
  assert.equal(done.correction.originalSnippet, "[text not stored]");  // "off" keeps no wording
  t += 3 * 3600 * 1000;
  tr.noteReplies("Claude", []);
  assert.equal(tr.replyCount(), 0);
  tr.see(GMAIL, SENT);
  assert.equal(tr.following(), false);
});

function setup(screen) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-email-"));
  const storage = createFileStorage(path.join(root, "data.json"));
  const cfg = { ...defaults(), screen: { ...defaults().screen, enabled: true, intervalSeconds: 2, tools: ["gemini"], ...screen } };
  let t = 5_000_000;
  const asked = [];
  const state = { win: null, tree: null };
  const probe = { title: async () => state.win, tree: async (o) => { asked.push(o); return state.tree(o); } };
  const step = createScreenStep({ storage, probe, now: () => t, getConfig: () => cfg });
  const next = async () => { t += 10_000; return step(); };
  return { storage, state, asked, next };
}
// a Gemini chat read by its own labels (the Gemini adapter needs page structure, so the plain "You" / "Gemini" labels are used here)
const CHAT = [N("AXStaticText", 2, "You"), N("AXStaticText", 2, "Draft a follow-up email to Tim about the budget"), N("AXStaticText", 2, "Gemini"), N("AXStaticText", 2, REPLY)];
const GEMINI_WIN = { app: "Google Chrome", title: "Budget email - Google Gemini" };
const GMAIL_WIN = { app: "Google Chrome", title: "Compose Mail - sam@example.com - Gmail" };

test("screen step: with email reading on, an AI reply in a chat and the Gmail draft built from it give one Gmail correction", async () => {
  const s = setup({ email: true });
  s.state.win = GEMINI_WIN; s.state.tree = () => ({ engine: "native", nodes: CHAT });
  assert.equal((await s.next()).tool, "gemini");
  s.state.win = GMAIL_WIN;
  s.state.tree = () => ({ engine: "native", focus: "found", nodes: draftNodes(aiSpan(REPLY, SENT)) });
  const r1 = await s.next();
  assert.equal(r1.email, true); assert.equal(r1.draft, true); assert.equal(r1.following, true);
  // only the draft box is asked for, with the native reader, and nothing when it is missing
  const ask = s.asked[s.asked.length - 1];
  assert.deepEqual([ask.engine, ask.focus, ask.focusOnly], ["native", "Message Body", true]);
  s.state.tree = () => ({ engine: "native", focus: "found", nodes: draftNodes(SENT) });
  await s.next();
  s.state.tree = () => ({ engine: "native", focus: "missing", nodes: [] });   // sent: the box is gone
  const r3 = await s.next();
  assert.equal(r3.emailRecorded, 1);
  const d = await s.storage.local.get(["corrections", "sends", "settings"]);
  assert.equal(d.corrections.length, 1);
  assert.equal(d.corrections[0].surface, "Gmail");
  assert.equal(d.corrections[0].agent, "Gemini");
  assert.equal(d.sends.at(-1).surface, "Gmail");
  assert.ok(d.settings.agents.includes("Gemini"));
  const saved = fs.readFileSync(s.storage.file, "utf8");
  assert.ok(!saved.includes("old text from Tim"), "the quoted earlier email is never saved");
  assert.ok(!saved.includes("Want me to make it more formal"), "the AI reply itself is never saved");
});

test("screen step: with email reading off, Gmail is never read", async () => {
  const s = setup({ email: false });
  s.state.win = GMAIL_WIN; s.state.tree = () => { throw new Error("must not be read"); };
  const r = await s.next();
  assert.equal(r.skipped, "not_allowed");
  assert.equal(s.asked.length, 0);
});

test("screen step: a Gmail read that is not limited to the draft box is thrown away", async () => {
  const s = setup({ email: true });
  s.state.win = GEMINI_WIN; s.state.tree = () => ({ engine: "native", nodes: CHAT });
  await s.next();
  s.state.win = GMAIL_WIN;
  s.state.tree = () => ({ engine: "events", nodes: draftNodes(SENT) });          // not the native reader
  assert.equal((await s.next()).draft, false);
  s.state.tree = () => ({ engine: "native", focus: "missing", nodes: draftNodes(SENT) });
  assert.equal((await s.next()).draft, false);
  assert.equal(((await s.storage.local.get("corrections")).corrections || []).length, 0);
});

test("native reader: --focus-only is passed for the draft box, and other readers refuse to read just one element", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-focusonly-"));
  const ran = [];
  const probe = createProbe("darwin", async (cmd, args) => { ran.push(args); return { engine: "native", nodes: [] }; }, async () => {},
    { binDir: path.join(dir, "bin"), compile: async (c, a) => { fs.writeFileSync(a[a.indexOf("-o") + 1], "bin"); }, fsApi: { ...fs, readFileSync: (p, e) => (String(p).endsWith("ax.swift") ? "// x" : fs.readFileSync(p, e)) } });
  await probe.tree({ engine: "native", focus: "Message Body", focusOnly: true, tail: 400 });
  assert.ok(ran[0].includes("--focus-only"));
  await probe.tree({ engine: "native", focus: "Chat messages" });
  assert.ok(!ran[1].includes("--focus-only"));
  await assert.rejects(() => probe.tree({ engine: "slow", focus: "Message Body", focusOnly: true }));
  await assert.rejects(() => probe.tree({ engine: "auto", focus: "Message Body", focusOnly: true }));
  await assert.rejects(() => createProbe("win32", async () => ({})).tree({ focus: "Message Body", focusOnly: true }));
  const src = fs.readFileSync(new URL("../src/screen/ax.swift", import.meta.url), "utf8");
  assert.ok(src.includes('if focusOnly && focusResult != "found" { stack = [] }'));
});

test("cli: `screen dump --email --delay 5` waits before reading (--email takes no value)", async () => {
  const { main } = await import("../src/cli.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-email-cli-"));
  const out = [];
  const realTimeout = globalThis.setTimeout;
  let waited = 0;
  globalThis.setTimeout = (fn, ms) => { waited += ms; return realTimeout(fn, 0); };
  try {
    const probe = { title: async () => ({ app: "Terminal", title: "" }) };
    await main(["screen", "dump", "--email", "--delay", "5"], { FARFIELD_HOME: home }, { probe });
  } finally { globalThis.setTimeout = realTimeout; }
  assert.ok(waited >= 5000, "waited " + waited + "ms; output: " + out.join(" | "));
});
