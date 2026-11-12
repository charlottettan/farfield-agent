import test from "node:test";
import assert from "node:assert/strict";
import { taskKind, firstSentence } from "../src/screen/task.js";
import { createObserver } from "../src/screen/observer.js";

// Made-up opening prompts and the kind a person would give each. Written before the rules were run on them.
const CASES = [
  ["Summarize the Q3 earnings call for Acme Corp", "Summary"],
  ["Write an Excel formula that computes CAGR from cells B2 to B6 over five years", "Spreadsheet help"],
  ["Draft an email to the client about the delayed settlement", "Email draft"],
  ["Create three bullets for a slide on our Q2 trading desk performance", "Slides"],
  ["Write a Python script that pulls FX rates from the ECB feed", "Code"],
  ["Write a one page memo on liquidity coverage ratio changes", "Memo or report"],
  ["Prepare talking points for the Delta Inc call tomorrow", "Meeting prep"],
  ["Explain how to reconcile the custody account against the general ledger", "Research and analysis"],
  ["Proofread this paragraph and make it more concise", "Editing"],
  ["Give me a recap of what the committee decided", "Summary"],
  ["Help me write the KYC disclosure language for the new onboarding form", "Compliance writing"],
  ["Build a pivot table of revenue by region", "Spreadsheet help"],
  ["Reply to Tim and say we can meet Thursday", "Email draft"],
  ["Compare the two vendors' pricing and give me a valuation estimate", "Research and analysis"],
  // added with the five kinds that used to fall into the catch-all
  ["Can you write a LinkedIn post announcing our new Boston office", "Social post or announcement"],
  ["Help me tailor my resume for an analyst role", "Job application"],
  ["Write a cover letter for the Goldman analyst role", "Job application"],
  ["Brainstorm names for our new savings product", "Brainstorming"],
  ["Help me think through whether to take this offer", "Advice and decisions"],
  ["Make a project timeline with milestones for the migration", "Planning"],
  ["hello there", null],
  ["thanks", null],
  ["", null],
];

test("task kind: measured on made-up prompts (printed so it can be read)", () => {
  const rows = CASES.map(([text, want]) => ({ text, want, got: (taskKind(text) || {}).label || null }));
  const right = rows.filter((r) => r.got === r.want).length;
  console.log(`\n  ${right}/${rows.length} task kinds right on made-up prompts`);
  rows.filter((r) => r.got !== r.want).forEach((r) => console.log(`  want ${r.want}, got ${r.got}: "${r.text.slice(0, 70)}"`));
  assert.ok(rows.length >= 15);
  assert.equal(right, rows.length, "the rules were tuned on these, so anything less is a regression");
});

test("task kind: a tie goes to the earlier kind in the priority list, and only the first 600 characters are read", () => {
  assert.equal(taskKind("Summarize this report and email it to Tim").label, "Email draft");
  assert.equal(taskKind("x ".repeat(400) + "summarize the call"), null);                      // the keyword is beyond 600 characters
  assert.equal(taskKind("summarize the call " + "x ".repeat(400)).label, "Summary");                  // and one inside them is found
  assert.equal(taskKind(null), null);
  assert.deepEqual(Object.keys(taskKind("Summarize the call")), ["label"]);                   // only a label comes back, never the text
});

test("first sentence: the opening sentence or line, shortened", () => {
  assert.equal(firstSentence("Draft a follow-up email to Tim. Keep it short."), "Draft a follow-up email to Tim.");
  assert.equal(firstSentence("Line one\nLine two"), "Line one");
  assert.equal(firstSentence("a".repeat(100)).length, 70);
  assert.ok(firstSentence("a".repeat(100)).endsWith("…"));
  assert.equal(firstSentence(""), "");
});

const L = (...p) => p.flatMap(([w, x]) => [{ role: "AXStaticText", text: w }, { role: "AXStaticText", text: x }]);
const tool = { id: "claude", name: "Claude" };
const clock = () => { let t = 1_700_000_000_000; return { now: () => t, tick: (s) => { t += s * 1000; } }; };
const OPEN = L(["You", "Summarize the Q3 earnings call for Acme Corp. Keep it to three bullets."], ["Claude", "Acme reported revenue of $1.2 billion."]);

test("workflow naming: task (default) uses a label only, tool uses the tool, first-prompt uses the opening line as the privacy mode allows", () => {
  const name = (naming, mode) => { const c = clock(); const o = createObserver({ now: c.now, mode, naming }); return o.feed({ nodes: OPEN }, tool).sessions[0].workflow; };
  assert.equal(name(undefined, "redacted"), "Summary");
  assert.equal(name("task", "full"), "Summary");
  assert.equal(name("tool", "full"), "Claude chat");
  assert.equal(name("first-prompt", "full"), "Summarize the Q3 earnings call for Acme Corp.");
  const redacted = name("first-prompt", "redacted");
  assert.ok(!/Acme|Q3/.test(redacted) && /Summarize/.test(redacted), redacted);
  assert.equal(name("first-prompt", "off"), "Summary");            // a mode that keeps no wording never keeps the opening line either
});

test("workflow naming: an unrecognised kind of task falls back to '<Tool> chat (unsorted)', so a catch-all never looks like a real group", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const r = o.feed({ nodes: L(["You", "Good morning, are you there"], ["Claude", "Yes, how can I help?"]) }, tool);
  assert.equal(r.sessions[0].workflow, "Claude chat (unsorted)");
});

test("workflow naming: a new task in the same chat is its own workflow, and its corrections belong to it", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const chat1 = [...OPEN, ...L(["You", "The revenue figure is wrong, it was $1.1 billion"], ["Claude", "Corrected."])];
  const r1 = o.feed({ nodes: chat1 }, tool);
  assert.deepEqual(r1.rePrompts.map((x) => x.workflow), ["Summary"]);
  c.tick(40);
  const chat2 = [...chat1, ...L(["You", "Separately, draft an email to Tim about the Beta deal"], ["Claude", "Hi Tim, about the Beta deal."]), ...L(["You", "Remove the second paragraph"], ["Claude", "Done."])];
  const r2 = o.feed({ nodes: chat2 }, tool);
  const names = r2.sessions.map((s) => s.workflow).sort();
  assert.deepEqual(names, ["Email draft", "Summary"]);
  assert.deepEqual(r2.rePrompts.map((x) => x.workflow), ["Email draft"]);
  assert.notEqual(r2.rePrompts[0].sessionId, r1.rePrompts[0].sessionId);
});

test("workflow naming: a chat that began before the watcher saw it has no known start, so it is unsorted", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const r = o.feed({ nodes: [...L(["Claude", "an earlier reply"]), ...L(["You", "Make it shorter and more formal"], ["Claude", "Shorter."])] }, tool);
  assert.equal(r.rePrompts.length, 1);
  assert.equal(r.rePrompts[0].workflow, "Claude chat (unsorted)");
});

test("a new piece of work of a different kind is a new workflow, not a re-prompt, even without 'separately'", () => {
  const c = clock(); const o = createObserver({ now: c.now, mode: "full" });
  const chat = [...OPEN,
    ...L(["You", "Great. Now draft an email to the board sending this summary."], ["Claude", "Dear board, please find the summary."]),
    ...L(["You", "Make it less formal"], ["Claude", "Hi all, here's the summary."])];
  const r = o.feed({ nodes: chat }, tool);
  assert.equal(r.sessions.at(-1).workflow, "Email draft");               // the email is its own task (the summary had no rework, so it is not reported)
  assert.equal(r.rePrompts.length, 1);                                   // only "make it less formal" is rework
  assert.equal(r.rePrompts[0].workflow, "Email draft");
});

test("workflow naming survives a restart, and what is remembered holds only a label (or the masked line, if that was chosen)", () => {
  const c = clock();
  const a = createObserver({ now: c.now, mode: "redacted", salt: "k" });
  a.feed({ nodes: OPEN }, tool);
  const saved = JSON.parse(JSON.stringify(a.snapshot()));
  assert.equal(saved.convs[0].episodes[0].workflow, "Summary");
  assert.ok(!/Acme|Q3|revenue|Summarize/i.test(JSON.stringify(saved)));
  c.tick(300);
  const b = createObserver({ now: c.now, mode: "redacted", salt: "k", state: saved });
  const r = b.feed({ nodes: [...OPEN, ...L(["You", "The revenue figure is wrong, it was $1.1 billion"])] }, tool);
  assert.equal(r.rePrompts[0].workflow, "Summary");
  // the optional line-as-name setting stores the masked line, and nothing more
  const f = createObserver({ now: c.now, mode: "redacted", salt: "k", naming: "first-prompt" });
  f.feed({ nodes: OPEN }, tool);
  const raw = JSON.stringify(f.snapshot());
  assert.ok(!/Acme|Q3/.test(raw) && /Summarize/.test(raw));
  // a damaged saved workflow name is cut down, not trusted
  const evil = JSON.parse(JSON.stringify(saved)); evil.convs[0].episodes[0].workflow = "x".repeat(500); evil.convs[1] = null;
  const g = createObserver({ now: c.now, mode: "full", salt: "k", state: evil });
  assert.ok(g.snapshot().convs[0].episodes[0].workflow.length <= 120);
});
