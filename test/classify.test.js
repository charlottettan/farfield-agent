import test from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, classifyConversation, countsAsRework } from "../src/screen/classify.js";
import { SCENES, CASES, SCENES2, CASES2 } from "./chats.js";

function run() {
  return CASES.map(([scene, text, want, gap]) => {
    const s = SCENES[scene];
    const got = classifyTurn(text, { user: s.user, assistant: s.assistant }, gap || 0);
    return { scene, text, want, got };
  });
}

test("measured on made-up chats (printed so it can be read, not just passed)", () => {
  const rows = run();
  const right = rows.filter((r) => r.got.label === r.want).length;
  const corr = rows.filter((r) => r.want === "correction");
  const corrRight = corr.filter((r) => r.got.label === "correction").length;
  const flagged = rows.filter((r) => r.got.label === "correction");
  const precision = flagged.filter((r) => r.want === "correction").length / Math.max(flagged.length, 1);
  const misses = rows.filter((r) => r.got.label !== r.want).map((r) => `  want ${r.want}, got ${r.got.label} (${r.got.confidence}): "${r.text.slice(0, 70)}"`);
  console.log(`\n  ${right}/${rows.length} labelled correctly; corrections found ${corrRight}/${corr.length}; correction precision ${(precision * 100).toFixed(0)}%`);
  if (misses.length) console.log(misses.join("\n"));
  assert.ok(rows.length >= 30);
});

test("rework counts only confident corrections, and always says why", () => {
  const prev = { user: SCENES.earnings.user, assistant: SCENES.earnings.assistant };
  const fix = classifyTurn("The revenue figure is wrong, it was $1.1 billion", prev);
  assert.equal(countsAsRework(fix), true);
  assert.ok(fix.reasons.length > 0);
  const thanks = classifyTurn("Thanks, looks good", prev);
  assert.equal(countsAsRework(thanks), false);
  const unsure = classifyTurn("hmm", prev);
  assert.equal(countsAsRework(unsure), false);
});

test("a chat with two tasks is split into two episodes, and only the corrections count", () => {
  const T = 1_700_000_000_000;
  const msgs = [
    { role: "user", text: SCENES.earnings.user, at: T },
    { role: "assistant", text: SCENES.earnings.assistant, at: T + 20_000 },
    { role: "user", text: "The revenue figure is wrong, it was $1.1 billion", at: T + 90_000 },
    { role: "assistant", text: "Acme Corp reported Q3 revenue of $1.1 billion, up 8% year over year.", at: T + 110_000 },
    { role: "user", text: "Make it shorter", at: T + 150_000 },
    { role: "assistant", text: "Acme: Q3 revenue $1.1 billion, margin 21%.", at: T + 160_000 },
    { role: "user", text: "Separately, can you draft talking points for the Delta Inc call tomorrow", at: T + 240_000 },
    { role: "assistant", text: "Here are talking points for the Delta Inc call: growth outlook, leverage, and covenant headroom.", at: T + 260_000 },
    { role: "user", text: "Remove the covenant point", at: T + 300_000 },
  ];
  const r = classifyConversation(msgs);
  assert.deepEqual(r.map((x) => x.label), ["correction", "correction", "new_task", "correction"]);
  assert.deepEqual(r.map((x) => x.episode), [0, 0, 1, 1]);
  assert.equal(r.filter((x) => x.rework).length, 3);
});

test("a long pause before an unrelated request starts a new task", () => {
  const prev = { user: SCENES.email.user, assistant: SCENES.email.assistant };
  const r = classifyTurn("Quick question about the Brazil bond auction results", prev, 3 * 3600);
  assert.equal(r.label, "new_task");
  const stillFixing = classifyTurn("It's still too long, cut it in half", prev, 3 * 3600);
  assert.equal(stillFixing.label, "correction");     // a pause does not turn a fix into a new task
});

test("measured on a second set written after tuning (the fairer number, still made up)", () => {
  const rows = CASES2.map(([scene, text, want]) => ({ text, want, got: classifyTurn(text, { user: SCENES2[scene].user, assistant: SCENES2[scene].assistant }, 0) }));
  const right = rows.filter((r) => r.got.label === r.want).length;
  const corr = rows.filter((r) => r.want === "correction");
  const flagged = rows.filter((r) => r.got.label === "correction");
  console.log(`\n  second set: ${right}/${rows.length} labelled correctly; corrections found ${corr.filter((r) => r.got.label === "correction").length}/${corr.length}; correction precision ${(flagged.filter((r) => r.want === "correction").length / Math.max(flagged.length, 1) * 100).toFixed(0)}%`);
  rows.filter((r) => r.got.label !== r.want).forEach((r) => console.log(`  want ${r.want}, got ${r.got.label} (${r.got.confidence}): "${r.text.slice(0, 70)}"`));
  assert.ok(rows.length >= 15);
});

test("with nothing earlier to compare against, only the message's own wording decides (a correction seen first is still a correction)", () => {
  const none = {};
  const fix = classifyTurn("That is wrong, the deadline is November 18 not November 14", none);
  assert.equal(fix.label, "correction");
  assert.equal(countsAsRework(fix), true);
  assert.equal(countsAsRework(classifyTurn("The table is missing the Q2 comparison column", none)), true);
  assert.equal(countsAsRework(classifyTurn("Make it shorter and more formal", none)), true);
  // no cue at all and no context: not enough to call it rework, and never a confident new task by lack of overlap
  const bare = classifyTurn("Quarterly figures for the Beta Corp merger", none);
  assert.equal(countsAsRework(bare), false);
  assert.notEqual(bare.label === "new_task" && bare.confidence >= 0.6, true);
  assert.equal(classifyTurn("Thanks, looks good", none).label, "acceptance");
  assert.equal(classifyTurn("Separately, can you draft talking points for the Delta Inc call", none).label, "new_task");     // an explicit cue still works
});

// Re-prompts (the AI got it wrong, I'm refining) must stay apart from new requests (a separate email, a different task).
test("corrections stay corrections; new deliverables of another kind are new tasks; more work on the same task is an extension", async () => {
  const { classifyTurn } = await import("../src/screen/classify.js");
  const summary = { user: "Summarize this report in five bullets", assistant: "1. Revenue grew 12%. 2. Margins held. 3. Churn fell.", task: "Summary" };
  const code = { user: "Write a python function to parse dates", assistant: "def parse(s): return datetime.strptime(s, '%Y-%m-%d')", task: "Code" };
  const label = (t, p = summary) => classifyTurn(t, p, 30).label;
  for (const t of ["That's wrong, revenue grew 14%", "Make it shorter.", "Can you make it less formal?", "Can you write that again but more concise?", "Rewrite the third bullet"])
    assert.equal(label(t), "correction", t);
  assert.equal(label("That throws a TypeError", code), "correction");
  for (const t of ["Now draft an email to the board sending this summary.", "Great. Now prepare talking points for my call with Acme tomorrow.",
    "Also draft a separate email to the team about the offsite.", "Help me build an Excel formula that sums column B when column A says Paid.",
    "Can you also write a LinkedIn post announcing our new Boston office?"])
    assert.equal(label(t), "new_task", t);
  assert.equal(label("Write a test for this function", code), "extension");
  assert.equal(label("Make a pivot table of this", { user: "Write a formula to sum column B", assistant: "=SUM(B:B)", task: "Spreadsheet help" }), "extension");
});

test("a pasted email is not judged as the person's words: Carlos's \u201cthe date should be the 18th\u201d is not a correction", async () => {
  const { classifyTurn } = await import("../src/screen/classify.js");
  const prev = { user: "Draft an email to Carlos", assistant: "Hi Carlos,\nThank you for the summary. Free next week?\nBest,\nCharlotte", task: "Email draft" };
  const reply = "Hi Charlotte,\nHappy to help. The date should be the 18th though, and I'd change the agenda. Is there an error in the deck?\nBest,\nCarlos";
  assert.equal(classifyTurn("He replied:\n\n" + reply + "\n\nDraft a response saying the 18th works", prev, 30).label, "new_task");
  assert.equal(classifyTurn(reply, prev, 30).label, "new_task");
  assert.equal(classifyTurn(reply + "\n\nwhat should I say back?", prev, 30).label, "new_task");
  assert.equal(classifyTurn("Change it to:\n\nHi Carlos,\nThanks so much. Free Thursday?\nBest,\nCharlotte", prev, 30).label, "correction");
  assert.equal(classifyTurn("Too formal, he's a friend", prev, 30).label, "correction");
});
