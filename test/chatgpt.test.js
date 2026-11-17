import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatgptTurns } from "../src/screen/adapters/chatgpt.js";
import { extractTurns } from "../src/screen/turns.js";
import { identify, isBrowser } from "../src/screen/sites.js";
import { matchReply, aiSpan } from "../src/screen/email.js";
import { createScreenStep } from "../src/screen/watch.js";
import { createProbe } from "../src/screen/probe.js";
import { createFileStorage } from "../src/storage.js";
import { defaults } from "../src/config.js";

// Shaped like a real Chrome dump of chatgpt.com (Nov 2026): class names and nesting copied, wording from a throwaway test chat.
const N = (depth, role, text = "", dom = "", sub = "") => ({ depth, role, text, dom, sub });
const HEAD = ".sr-only.m-0.select-none.print:not-sr-only";
const user = (text) => [
  N(19, "AXHeading", "You said:", HEAD), N(20, "AXStaticText", "You said:"),
  N(19, "AXGroup", "", ".bg-user-message.text-user-message"), N(20, "AXGroup", "", ".relative.w-full"), N(21, "AXGroup", "", ".text-size-chat.whitespace-pre-wrap"),
  N(22, "AXStaticText", text),
  N(19, "AXButton", "Copy message", ".no-drag"), N(19, "AXButton", "Share prompt", ".no-drag"), N(19, "AXButton", "Edit message", ".no-drag"),
];
const BOT_HEAD = [N(19, "AXHeading", "ChatGPT said:", HEAD), N(20, "AXStaticText", "ChatGPT said:")];
const ACTIONS = [N(19, "AXButton", "Copy", ".no-drag"), N(19, "AXCheckBox", "Read aloud", ".no-drag", "AXToggleButton"), N(19, "AXButton", "Share", ".no-drag"), N(19, "AXPopUpButton", "More actions", "radix-x")];
const collapsedCard = [...BOT_HEAD, N(19, "AXGroup", "", ".relative.PortalBoundary"), N(20, "AXGroup", "", ".group/writing-block-surface"), N(21, "AXGroup", "", ".relative.z-[1]"),
  N(22, "AXGroup", "", ".flex.min-w-0", "AXSectionHeader"), N(23, "AXGroup", "", ".min-w-0"), N(24, "AXStaticText", "Budget Meeting Tuesday"), N(22, "AXButton", "Show more", ".flex"), ...ACTIONS];
const emailCard = [...BOT_HEAD, N(19, "AXGroup", "", ".relative.PortalBoundary"), N(20, "AXGroup", "", ".group/writing-block-surface"), N(21, "AXGroup", "", ".relative.z-[1]"),
  N(22, "AXGroup", "", ".flex.min-w-0", "AXSectionHeader"), N(23, "AXGroup", "", ".min-w-0"), N(24, "AXStaticText", "Tuesday Meeting"), N(23, "AXButton", "Copy", ".no-drag"),
  N(23, "AXGroup", "", ".contents", "AXFieldset"), N(24, "AXButton", "Open in email", ".no-drag"), N(24, "AXButton", "Connect email", ".no-drag"),
  N(22, "AXButton", "Recipients", ".min-h"), N(22, "AXTextArea", "Tuesday Meeting", ".col-start-1.resize-none"), N(22, "AXSplitter", "", ".mx-4"), N(22, "AXGroup", "", ".relative"),
  N(23, "AXTextArea", "Hi Tim,\nConfirming our budget meeting Tuesday!\nBest,\nAndrew", ".ProseMirror.content-xaiQhS"),
  N(25, "AXStaticText", "Hi Tim,"), N(25, "AXStaticText", "Confirming our budget meeting Tuesday!"), N(25, "AXStaticText", "Best,"), N(25, "AXStaticText", "Andrew"),
  N(20, "AXGroup", "", ".relative.mb-4"), N(21, "AXGroup", "", ".relative.min-w-0"), N(22, "AXButton", "Add the meeting time", ".relative.flex"), N(22, "AXButton", "Make the confirmation warmer", ".relative.flex"),
  ...ACTIONS];
const plainReply = (text) => [...BOT_HEAD, N(19, "AXGroup", "", ".markdown.prose"), N(20, "AXStaticText", text), ...ACTIONS];
const FOOTER = [
  N(17, "AXGroup", "", ".sticky.bottom-0"), N(18, "AXGroup", "", ".text-center.text-xs"), N(20, "AXStaticText", "ChatGPT can make mistakes. Check important info."),
  N(17, "AXGroup", "", ".footer-A8ZvKV"), N(20, "AXHeading", "Latest response", ".sr-only.m-0.select-none"), N(21, "AXStaticText", "Latest response"),
  N(28, "AXTextArea", "a half typed follow-up\n", ".ProseMirror.ProseMirror-focused"), N(31, "AXStaticText", "a half typed follow-up"),
];
const PAGE = (...parts) => [N(0, "AXWebArea", "Write Budget Meeting Email"), N(16, "AXGroup", "Conversation", ".scrollContainer-fG6qEo.thread-scroll-container", "AXLandmarkRegion"), N(17, "AXGroup", "", ".relative.flex"), ...parts.flat(), ...FOOTER];

test("chatgpt: your messages and ChatGPT's replies come out, without buttons, suggestions, the footer or the draft box", () => {
  const r = chatgptTurns(PAGE(user("Write a short email to Tim confirming our budget meeting Tuesday"), collapsedCard, user("make it shorter"), emailCard));
  assert.deepEqual(r.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(r.turns[0].text, "Write a short email to Tim confirming our budget meeting Tuesday");
  assert.equal(r.turns[1].text, "Budget Meeting Tuesday");                                   // collapsed behind "Show more": only what is on screen
  assert.equal(r.turns[3].text, "Tuesday Meeting\nHi Tim,\nConfirming our budget meeting Tuesday!\nBest,\nAndrew");   // card body read once, title once
  const all = JSON.stringify(r.turns);
  for (const junk of ["Copy", "Share", "Edit message", "Read aloud", "Open in email", "Recipients", "Make the confirmation warmer", "can make mistakes", "Latest response", "half typed", "You said", "ChatGPT said"]) assert.ok(!all.includes(junk), junk);
});

test("chatgpt: plain replies, and the reader is the one used for ChatGPT", () => {
  const nodes = PAGE(user("Summarise Q3 for the board"), plainReply("Revenue rose 12% on stronger subscriptions."), user("use bps not %"), plainReply("Revenue rose 1,200 bps."));
  const r = extractTurns({ nodes }, { id: "chatgpt", name: "ChatGPT" });
  assert.equal(r.basis, "adapter:chatgpt");
  assert.deepEqual(r.turns.map((t) => t.text), ["Summarise Q3 for the board", "Revenue rose 12% on stronger subscriptions.", "use bps not %", "Revenue rose 1,200 bps."]);
  assert.equal(chatgptTurns([N(0, "AXStaticText", "nothing here")]), null);              // not a ChatGPT page structure
});

test("chatgpt: an email drafted in ChatGPT's card links to a Gmail draft built from it", () => {
  const reply = chatgptTurns(PAGE(user("Write a short email to Tim"), emailCard)).turns[1].text;
  assert.ok(reply.includes("Confirming our budget meeting Tuesday!"));                    // the card's email is part of the reply
  const longer = "Hi Tim,\nConfirming our budget meeting on Tuesday at 2pm in the main conference room. Please bring the Q3 numbers and the revised forecast so we can finish the review.\nBest,\nAndrew";
  const longReply = "Tuesday Meeting\n" + "Hi Tim,\nConfirming our budget meeting on Tuesday in the main conference room. Please bring the Q3 numbers and the revised forecast so we can finish the review.\nBest,\nAndrew";
  assert.equal(matchReply(longer, [{ text: longReply, tool: "ChatGPT" }]).tool, "ChatGPT");
  assert.ok(aiSpan(longReply, longer).startsWith("Hi Tim,"));
});

test("chatgpt windows: recognised by the tab's website when the title is only the chat's name", () => {
  assert.equal(identify({ app: "Google Chrome", title: "Write Budget Meeting Email - High memory usage - 836 MB - Google Chrome - Belle (school.example.edu)" }), null);
  assert.equal(identify({ url: "https://chatgpt.com" }).id, "chatgpt");
  assert.equal(identify({ url: "https://chatgpt.com.evil.example" }), null);
  assert.ok(isBrowser("Google Chrome") && isBrowser("Safari") && !isBrowser("Microsoft Excel"));
});

function setup(screen) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-chatgpt-"));
  const storage = createFileStorage(path.join(root, "data.json"));
  const cfg = { ...defaults(), screen: { ...defaults().screen, enabled: true, intervalSeconds: 2, ...screen } };
  let t = 9_000_000;
  const calls = { site: 0, tree: 0 };
  const state = { win: null, site: "", nodes: [] };
  const probe = { title: async () => state.win, site: async () => { calls.site++; return { url: state.site }; }, tree: async () => { calls.tree++; return { engine: "native", nodes: state.nodes }; } };
  const step = createScreenStep({ storage, probe, now: () => t, getConfig: () => cfg });
  return { storage, state, calls, next: async () => { t += 10_000; return step(); } };
}

test("screen step: a ChatGPT tab is read after checking its website, and other tabs are never read", async () => {
  const s = setup();
  s.state.win = { app: "Google Chrome", title: "Write Budget Meeting Email - Google Chrome" };
  s.state.site = "https://chatgpt.com";
  s.state.nodes = PAGE(user("Summarise Q3 for the board"), plainReply("Revenue rose 12% on stronger subscriptions."), user("too long, cut it to one line"), plainReply("Revenue up 12%."));
  const r = await s.next();
  assert.equal(r.tool, "chatgpt");
  assert.equal(r.basis, "address");
  assert.equal(r.seen, 4);
  // a news site in the same browser: only its website is checked, its content is never requested
  s.state.site = "https://www.example-news.com"; s.state.win = { app: "Google Chrome", title: "Markets today - Google Chrome" };
  const before = s.calls.tree;
  assert.equal((await s.next()).skipped, "not_allowed");
  assert.equal(s.calls.tree, before);
  // a non-browser app: not even the website is checked
  const sites = s.calls.site; s.state.win = { app: "Microsoft Excel", title: "comps.xlsx" };
  await s.next();
  assert.equal(s.calls.site, sites);
});

test("native reader: --site-only is how the website is asked for", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-site-"));
  const ran = [];
  const probe = createProbe("darwin", async (cmd, args) => { ran.push(args); return { url: "https://chatgpt.com" }; }, async () => {},
    { binDir: path.join(dir, "bin"), compile: async (c, a) => { fs.writeFileSync(a[a.indexOf("-o") + 1], "bin"); }, fsApi: { ...fs, readFileSync: (p, e) => (String(p).endsWith("ax.swift") ? "// x" : fs.readFileSync(p, e)) } });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  await probe.tree({ engine: "native" });                                                      // builds the reader once
  assert.deepEqual(await probe.site(), { url: "https://chatgpt.com" });
  assert.deepEqual(ran[ran.length - 1], ["--site-only"]);
  const src = fs.readFileSync(new URL("../src/screen/ax.swift", import.meta.url), "utf8");
  assert.ok(src.includes('args.contains("--site-only")') && src.includes("c.host = host"));
});
