import test from "node:test";
import assert from "node:assert/strict";
import { claudeTurns } from "../src/screen/adapters/claude.js";
import { extractTurns } from "../src/screen/turns.js";
import { createObserver } from "../src/screen/observer.js";

// Node lists shaped like a real Chrome dump of claude.ai: the messages sit at ONE flat depth inside a "Chat messages" group.
// Class names and ordering are copied from the dump; the wording is invented.
const D = 11;                                                           // the flat depth of everything inside the list
const N = (role, text = "", dom = "", sub = "", depth = D) => ({ role, sub, depth, text, dom });
const ARTICLE = (i, n) => N("AXGroup", `Message ${i} of ${n}`, ".rounded-lg.focus-visible:shadow-focus", "AXDocumentArticle");
const TOOLBAR = (...buttons) => [N("AXToolbar", "Message actions", ".flex.items-center.select-none"), ...buttons.map((b) => N("AXButton", b, "_r_x_.cds-reset.group/btn")), N("AXGroup", "", "_r_t_.flex.h-control", "AXTimeGroup")];
const TIME = (t) => N("AXStaticText", t);

const USER = (i, n, lines, firstLine = lines[0]) => [
  ARTICLE(i, n),
  N("AXHeading", `You said: ${firstLine}`, ".sr-only.select-none"), N("AXStaticText", `You said: ${firstLine}`),
  N("AXGroup", "", ".group/bubble.relative.flex.min-w-0.flex-col.gap-xs.rounded-[var(--cds-message-b]"), N("AXGroup", "", "_r_gd_"),
  ...lines.flatMap((l) => [N("AXGroup", "", ".whitespace-pre-wrap.break-words"), N("AXStaticText", l)]),
  ...TOOLBAR("Retry", "Edit", "Copy"), TIME("42 minutes ago"),
];
const CLAUDE = (i, n, paras, { status = "Reviewed the request", code = null } = {}) => [
  ARTICLE(i, n),
  N("AXHeading", `Claude responded: ${paras[0]}`, ".sr-only.select-none"), N("AXStaticText", `Claude responded: ${paras[0]}`),
  N("AXGroup", "", "_r_9g_abc.group/message-row.relative.flex.w-ful"), N("AXGroup", "", ".group/status.flex.w-full.min-w-0.flex-col"),
  N("AXButton", status, ".cds-reset.-ms-1.inline-flex.h-[1lh]"), N("AXGroup", "", "", "AXApplicationStatus"), N("AXStaticText", status),
  ...paras.map((p) => N("AXStaticText", p)),
  ...(code ? [N("AXGroup", "Code", ".relative.group/copy.bg-bg-000/50", "AXApplicationGroup"), N("AXButton", "Copy to clipboard", "_r_eq_.cds-reset"), N("AXGroup", "", ".code-block__code.!my-0"), N("AXStaticText", code)] : []),
  ...TOOLBAR("Copy", "Read aloud", "Retry"), TIME("47 minutes ago"),
];
const LIST = (...messages) => [
  N("AXGroup", "Chat messages", "", "AXApplicationGroup", D - 1),
  N("AXGroup", "", "_r_9h_.sr-only.select-none"), N("AXStaticText", "Press Tab to move to the end of the chat"), N("AXButton", "Skip to composer", ".sr-only.select-none"),    // before the first message
  ...messages.flat(),
];
const COMPOSER = [N("AXGroup", "", ".composer.relative", "", D - 3), N("AXTextArea", "half typed follow-up", ".ProseMirror", "", D - 2), N("AXStaticText", "Reply to Claude", "", "", D - 1)];
const PAGE = (...parts) => [{ role: "AXWebArea", depth: 0, text: "Chrome extension for correction tracking - Claude" }, N("AXGroup", "", ".chat-ui-core", "", 1), ...parts.flat()];

test("claude: messages are split by their markers, you vs Claude is told apart, and the noise is dropped", () => {
  const r = claudeTurns(PAGE(LIST(
    CLAUDE(1, 4, ["Here is the summary you asked for.", "1. Capture re-prompts", "2. Group them into problems"], { code: "git push" }),
    USER(2, 4, ["Make the summary shorter, three bullets max", "and drop the git section"]),
    CLAUDE(3, 4, ["Done: three bullets."]),
    USER(4, 4, ["That is wrong, the deadline is November 18"]),
  ), COMPOSER));
  assert.deepEqual(r.turns.map((t) => t.role), ["assistant", "user", "assistant", "user"]);
  assert.equal(r.turns[0].text, "Here is the summary you asked for.\n1. Capture re-prompts\n2. Group them into problems\ngit push");
  assert.equal(r.turns[1].text, "Make the summary shorter, three bullets max\nand drop the git section");
  assert.equal(r.turns[3].text, "That is wrong, the deadline is November 18");
  const all = JSON.stringify(r.turns);
  for (const junk of ["You said", "Claude responded", "Reviewed the request", "minutes ago", "Press Tab", "half typed", "Reply to Claude", "Retry", "Message 1 of 4"]) assert.ok(!all.includes(junk), junk);
});

test("claude: who said it falls back to the bubble and reply classes when the heading words differ from what was inferred, and the repeated heading text is still dropped", () => {
  // replace the heading's wording, and its repeated copy, with something that matches neither "You" nor "Claude"
  const reword = (block) => { const h = block.find((n) => n.role === "AXHeading"); const old = h.text; return block.map((n) => (n.text === old && (n.role === "AXHeading" || n.role === "AXStaticText") ? { ...n, text: "Zed: " + old.split(": ")[1] } : n)); };
  const r = claudeTurns(PAGE(LIST(reword(CLAUDE(1, 2, ["A reply."])), reword(USER(2, 2, ["A question", "second line"])))));
  assert.deepEqual(r.turns, [{ role: "assistant", text: "A reply." }, { role: "user", text: "A question\nsecond line" }]);
});

test("claude: the draft box and anything after the message list is never a message", () => {
  const r = claudeTurns(PAGE(LIST(USER(1, 1, ["Hello there"])), COMPOSER));
  assert.deepEqual(r.turns, [{ role: "user", text: "Hello there" }]);
});

test("claude: text before the first marker is not attributed to anyone, and a page without the message list gives nothing", () => {
  assert.deepEqual(claudeTurns(PAGE(LIST())).turns, []);
  assert.equal(claudeTurns([{ role: "AXStaticText", depth: 1, text: "You", dom: "" }]), null);
  assert.equal(claudeTurns(PAGE([N("AXStaticText", "just some page")])), null);
});

test("claude: a status line that repeats a button's label is not part of the reply", () => {
  const r = claudeTurns(PAGE(LIST(CLAUDE(1, 1, ["The real answer."], { status: "Thought for 12 seconds" }))));
  assert.equal(r.turns[0].text, "The real answer.");
});

test("extractTurns uses the Claude reader for Claude", () => {
  const nodes = PAGE(LIST(USER(1, 2, ["Summarize Q3"]), CLAUDE(2, 2, ["Revenue was $1.2 billion."])));
  const r = extractTurns({ nodes }, { id: "claude", name: "Claude" });
  assert.equal(r.basis, "adapter:claude");
  assert.deepEqual(r.turns.map((t) => t.role), ["user", "assistant"]);
});

test("end to end: watching a Claude chat in Chrome counts a correction once and ignores the draft box", () => {
  let t = 1_700_000_000_000; const o = createObserver({ now: () => t, mode: "full" });
  const tool = { id: "claude", name: "Claude" };
  const first = [USER(1, 2, ["Summarize the Q3 call for Acme"]), CLAUDE(2, 2, ["Acme reported revenue of $1.2 billion, up 8%."])];
  assert.deepEqual(o.feed({ nodes: PAGE(LIST(...first), COMPOSER) }, tool).rePrompts, []);
  t += 45_000;
  const fix = [USER(3, 4, ["The revenue figure is wrong, it was $1.1 billion"]), CLAUDE(4, 4, ["Corrected to $1.1 billion."])];
  const r = o.feed({ nodes: PAGE(LIST(...first, ...fix), COMPOSER) }, tool);
  assert.equal(r.rePrompts.length, 1);
  assert.equal(r.rePrompts[0].site, "Claude");
  assert.match(r.rePrompts[0].text, /revenue figure is wrong/);
  assert.ok(r.rePrompts[0].reviewSeconds >= 40);
  assert.ok(!JSON.stringify(r).includes("half typed"));
  t += 10_000;
  assert.deepEqual(o.feed({ nodes: PAGE(LIST(...first, ...fix), COMPOSER) }, tool).rePrompts, []);
});
