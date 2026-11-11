import test from "node:test";
import assert from "node:assert/strict";
import { geminiTurns } from "../src/screen/adapters/gemini.js";
import { extractTurns } from "../src/screen/turns.js";
import { createObserver } from "../src/screen/observer.js";

// Node lists shaped like a real Safari dump of gemini.google.com (class names and nesting copied from it; the wording is invented).
const N = (role, depth, text = "", dom = "") => ({ role, depth, text, dom });
const USER_LABEL = ".cdk-visually-hidden.screen-reader-user-query-label";
const LINE = ".query-text-line.ng-star-inserted";
const MODEL = (id) => `model-response-message-content${id}.markdown.markdown-main-panel.md`;
const BUTTONS = [N("AXButton", 3, "Copy prompt", ".mdc-icon-button"), N("AXButton", 3, "Edit", ".mdc-icon-button"), N("AXCheckBox", 3, "Good response", ".mdc-icon-button"), N("AXCheckBox", 3, "Bad response", ".mdc-icon-button"), N("AXButton", 3, "Copy", ".mdc-icon-button")];
const GEMINI_SAID = [N("AXGroup", 2, "", ".model-response-label-announcer"), N("AXHeading", 3, "Gemini said", ".cdk-visually-hidden.screen-reader-model-response-label"), N("AXStaticText", 4, "Gemini said")];

// an earlier exchange that has scrolled out of view: the elements exist but their text is empty
const SCROLLED_AWAY = [N("AXHeading", 2, "", USER_LABEL), N("AXStaticText", 3, ""), N("AXStaticText", 3, ""), N("AXGroup", 2, "", LINE), N("AXStaticText", 3, ""), ...BUTTONS, ...GEMINI_SAID, N("AXGroup", 2, "", MODEL("r_0001")), N("AXStaticText", 3, ""), N("AXStaticText", 3, "")];

const VISIBLE_USER = [
  N("AXHeading", 2, "You said Draft a follow-up email to Tim after our call", USER_LABEL), N("AXStaticText", 3, "You said"), N("AXStaticText", 3, "Draft a follow-up email to Tim after our call"),
  N("AXGroup", 2, "", LINE), N("AXStaticText", 3, "Draft a follow-up email to Tim after our call on Tuesday, keep it short"),
  N("AXGroup", 2, "", LINE), N("AXStaticText", 3, "and mention the November 14 deadline"),
  ...BUTTONS.slice(0, 2),
];
const VISIBLE_REPLY = [
  ...GEMINI_SAID, N("AXGroup", 2, "", MODEL("r_5e9b")),
  N("AXStaticText", 3, "Here are three options."), N("AXHeading", 3, "Option 1: Short and direct"), N("AXStaticText", 4, "Option 1: Short and direct"), N("AXStaticText", 4, "Hi Tim,"), N("AXStaticText", 4, "Following up on Tuesday."), N("AXStaticText", 4, "Best,"),
  N("AXGroup", 2, "", ".follow-up-text.gds-headline-s"), N("AXStaticText", 3, "Want me to adjust the tone?"), N("AXButton", 3, "Yes", ".follow-up-button"),
  ...BUTTONS.slice(2),
];
const COMPOSER = [N("AXPopUpButton", 2, "Upload & tools"), N("AXTextArea", 2, "\n", ".ql-editor.ql-blank.textarea"), N("AXStaticText", 3, "Ask Gemini")];
const PAGE = (...parts) => [N("AXWebArea", 0, "Sierra AI Connection Follow-Up Draft - Google Gemini"), N("AXGroup", 1, "", ".chat-app"), ...parts.flat()];

test("gemini: your message and Gemini's reply are pulled out of the page, and nothing else", () => {
  const r = geminiTurns(PAGE(SCROLLED_AWAY, VISIBLE_USER, VISIBLE_REPLY, COMPOSER));
  assert.deepEqual(r.turns.map((t) => t.role), ["user", "assistant"]);
  assert.equal(r.turns[0].text, "Draft a follow-up email to Tim after our call on Tuesday, keep it short\nand mention the November 14 deadline");
  assert.equal(r.turns[1].text, "Here are three options.\nOption 1: Short and direct\nHi Tim,\nFollowing up on Tuesday.\nBest,");
  const all = JSON.stringify(r.turns);
  for (const junk of ["You said", "Gemini said", "Copy prompt", "Good response", "Want me to adjust", "Ask Gemini", "Upload"]) assert.ok(!all.includes(junk), junk);
});

test("gemini: messages that scrolled out of view (empty text) are skipped, not invented", () => {
  const r = geminiTurns(PAGE(SCROLLED_AWAY));
  assert.deepEqual(r.turns, []);
});

test("gemini: the draft box is reported separately and never becomes a message", () => {
  const draft = [N("AXTextArea", 2, "a half typed follow-up", ".ql-editor.textarea"), N("AXStaticText", 3, "text inside the draft box")];
  const r = geminiTurns(PAGE(VISIBLE_USER, VISIBLE_REPLY, draft));
  assert.equal(r.composer, "a half typed follow-up");
  assert.ok(!JSON.stringify(r.turns).includes("half typed"));
  assert.ok(!JSON.stringify(r.turns).includes("inside the draft box"));
});

test("gemini: several exchanges come out in order, bullets in a message are kept, and the heading text is the fallback", () => {
  const second = [
    N("AXHeading", 2, "You said", USER_LABEL), N("AXStaticText", 3, "You said"), N("AXStaticText", 3, "Make it warmer"),        // no query-text-line: use the heading's own text
    ...GEMINI_SAID, N("AXGroup", 2, "", MODEL("r_7777")), N("AXStaticText", 3, "Warmer version: Hi Tim, great to speak Tuesday."),
  ];
  const bullets = [N("AXHeading", 2, "You said", USER_LABEL), N("AXStaticText", 3, "You said"), N("AXList", 2, "", ".query-bullet-list.ng-star-inserted"), N("AXGroup", 3, "", ".query-bullet-item"), N("AXListMarker", 4, "•"), N("AXStaticText", 4, "cut the second paragraph"), N("AXGroup", 3, "", ".query-bullet-item"), N("AXStaticText", 4, "keep the date")];
  const r = geminiTurns(PAGE(VISIBLE_USER, VISIBLE_REPLY, second, bullets));
  assert.deepEqual(r.turns.map((t) => t.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(r.turns[2].text, "Make it warmer");
  assert.equal(r.turns[4].text, "cut the second paragraph\nkeep the date");
});

test("gemini: nodes with no page structure give nothing for the adapter, so the generic reader can try", () => {
  assert.equal(geminiTurns([{ role: "AXStaticText", depth: 1, text: "You" }]), null);
  assert.equal(geminiTurns(null), null);
});

test("extractTurns uses the Gemini reader for Gemini, and the labels reader otherwise", () => {
  const nodes = PAGE(VISIBLE_USER, VISIBLE_REPLY);
  const viaAdapter = extractTurns({ nodes }, { id: "gemini", name: "Gemini" });
  assert.equal(viaAdapter.basis, "adapter:gemini");
  assert.equal(viaAdapter.turns.length, 2);
  const generic = extractTurns({ nodes }, { id: "claude", name: "Claude" });          // a tool with no adapter: nothing is guessed from this page
  assert.notEqual(generic.basis, "adapter:claude");
  // an adapter result with no user message is not a conversation, and falls through
  assert.notEqual(extractTurns({ nodes: PAGE(VISIBLE_REPLY) }, { id: "gemini" }).basis, "adapter:gemini");
});

test("end to end: watching a Gemini chat across looks counts a correction, once, and ignores the draft box", () => {
  let t = 1_700_000_000_000; const o = createObserver({ now: () => t, mode: "full" });
  const tool = { id: "gemini", name: "Gemini" };
  assert.deepEqual(o.feed({ nodes: PAGE(SCROLLED_AWAY, VISIBLE_USER, VISIBLE_REPLY, COMPOSER) }, tool).rePrompts, []);      // first message: not a re-prompt
  t += 40_000;
  const fix = [
    N("AXHeading", 2, "You said", USER_LABEL), N("AXStaticText", 3, "You said"), N("AXGroup", 2, "", LINE), N("AXStaticText", 3, "That is wrong, the deadline is November 18 not November 14"),
    ...GEMINI_SAID, N("AXGroup", 2, "", MODEL("r_9999")), N("AXStaticText", 3, "Corrected: the deadline is November 18."),
  ];
  const draft = [N("AXTextArea", 2, "typing something else", ".ql-editor.textarea")];
  const r = o.feed({ nodes: PAGE(VISIBLE_USER, VISIBLE_REPLY, fix, draft) }, tool);
  assert.equal(r.rePrompts.length, 1);
  assert.equal(r.rePrompts[0].site, "Gemini");
  assert.match(r.rePrompts[0].text, /deadline is November 18/);
  assert.ok(r.rePrompts[0].reviewSeconds >= 40);
  assert.ok(!JSON.stringify(r).includes("typing something else"));
  t += 10_000;
  assert.deepEqual(o.feed({ nodes: PAGE(VISIBLE_USER, VISIBLE_REPLY, fix, draft) }, tool).rePrompts, []);        // the same screen again adds nothing
});
