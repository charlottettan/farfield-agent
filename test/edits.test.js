import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedPairs, categoriesOf, minutesFor, redact, readingSeconds } from "../src/edits.js";
import { createEmailTracker } from "../src/screen/email.js";
import { createObserver } from "../src/screen/observer.js";
import { loadConfig, saveConfig, defaults } from "../src/config.js";
import { main as cli } from "../src/cli.js";

// The email from the first live ChatGPT test (Nov 17 2026), and what was changed by hand in Gmail.
const AI = "Hi Tim,\nI am writing to confirm our budget meeting on Tuesday at 2:00 PM in the main conference room. Please bring the Q3 financial figures and the revised forecast for our review. Thank you, and I look forward to our discussion.\nBest regards,\nSam";
const SENT = "Hi Tim,\nI am writing to confirm our budget meeting on Tuesday at 2:00 PM in the Galaxy room. Please bring the Q3 financial figures and the revised forecast for our review. Thank you, and I look forward to our discussion!\nCheers,\nSam";

test("kinds of change: a fact and the tone changed in one email are both kept, the biggest first", () => {
  const pairs = changedPairs(AI, SENT);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs[2], { before: "Best regards,", after: "Cheers," });
  assert.deepEqual(categoriesOf(pairs), ["Tone/Style Edit", "Terminology/Context Mismatch"]);   // a swapped sign-off is tone, not "content"
  assert.deepEqual(categoriesOf(changedPairs("Revenue was $1.2 billion in Q3.", "Revenue was $1.4 billion in Q3.")), ["Factual/Data Correction"]);
  assert.deepEqual(categoriesOf([{ before: "same", after: "same" }]), []);
});

test("time: measured when there is a measurement, never more than the time that passed, the estimate otherwise", () => {
  assert.deepEqual(minutesFor({ estimate: 7, measuredSeconds: 83 }), { minutes: 1, source: "measured" });            // the live test: 83 s, not 7 min
  assert.deepEqual(minutesFor({ estimate: 7, measuredSeconds: 25 * 60 }), { minutes: 25, source: "measured" });      // a long real edit is not cut down
  assert.equal(minutesFor({ estimate: 7, measuredSeconds: 25 * 60, idle: true }).minutes, 7);                       // a draft left idle is not counted beyond the estimate
  assert.equal(minutesFor({ estimate: 12, elapsedSeconds: 150 }).minutes, 3);                                       // a file saved 2.5 min after the AI's version
  assert.equal(minutesFor({ estimate: 4, elapsedSeconds: 3600 }).minutes, 4);
  assert.deepEqual(minutesFor({ estimate: 5 }), { minutes: 5, source: "estimated" });
  assert.equal(minutesFor({ estimate: 5, measuredSeconds: 5 }).minutes, 5);                                          // too short to be a measurement
});

test("redaction: numbers can be kept readable; names and email addresses are always hidden", () => {
  const t = "move it to 2:00 PM and fix the Q3 number for Tim at tim@acme.example";
  assert.equal(redact(t, { keepNumbers: true }), "move it to 2:00 PM and fix the Q3 number for [name] at [email]");
  const masked = redact(t);
  assert.ok(!/\d/.test(masked) && !masked.includes("Tim") && !masked.includes("acme"));
});

test("reading time: about 240 words a minute, between 5 seconds and 5 minutes", () => {
  assert.equal(readingSeconds(""), 5);
  assert.equal(readingSeconds(AI), 11);
  assert.equal(readingSeconds("word ".repeat(5000)), 300);
});

test("email edits: every kind of change, the measured time, and numbers kept when the company chose to", () => {
  let t = 0;
  const GMAIL = { id: "gmail", name: "Gmail", surface: "Gmail" };
  const run = (keepNumbers) => {
    const tr = createEmailTracker({ now: () => t, mode: "redacted", keepNumbers });
    tr.noteReplies("ChatGPT", [AI]);
    t += 10_000; tr.see(GMAIL, AI, ":a1");
    t += 73_000; tr.see(GMAIL, SENT, ":a1");
    t += 10_000; return tr.see(GMAIL, null).correction;
  };
  const kept = run(true);
  assert.deepEqual(kept.categories, ["Tone/Style Edit", "Terminology/Context Mismatch"]);
  assert.equal(kept.category, "Tone/Style Edit");
  assert.equal(kept.estimatedMinutes, 1);
  assert.equal(kept.timeSource, "measured");
  assert.ok(kept.modelMinutes >= 1);
  assert.ok(/\d/.test(kept.originalSnippet) && !kept.originalSnippet.includes("#:##"), kept.originalSnippet);              // numbers kept readable
  const masked = run(false);
  assert.ok(!/\d/.test(masked.originalSnippet + masked.editedSnippet), "numbers hidden by default");
});

test("re-prompts: when the reply and the follow-up are first seen together, review time is estimated from the reply, and marked", () => {
  const obs = createObserver({ now: () => 50_000, mode: "redacted", salt: "s".repeat(16), keepNumbers: true });
  const line = (who, text) => [{ role: "AXStaticText", text: who }, { role: "AXStaticText", text }];
  const snap = { nodes: [...line("You", "Write an email to Tim about the Q3 budget meeting"), ...line("Claude", AI), ...line("You", "make it more formal and move it to 3:00 PM")] };
  const res = obs.feed(snap, { id: "claude", name: "Claude" }, {});
  assert.equal(res.rePrompts.length, 1);
  const r = res.rePrompts[0];
  assert.equal(r.reviewSeconds, 11);
  assert.equal(r.reviewSource, "estimated from the reply's length");
  assert.ok(r.text.includes("3:00"), "numbers kept when the company chose to");
});

test("cli: screen numbers keep | mask", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-numbers-"));
  saveConfig(home, defaults());
  assert.equal(loadConfig(home).screen.maskNumbers, true);
  await cli(["screen", "numbers", "keep"], { FARFIELD_HOME: home });
  assert.equal(loadConfig(home).screen.maskNumbers, false);
  await cli(["screen", "numbers", "mask"], { FARFIELD_HOME: home });
  assert.equal(loadConfig(home).screen.maskNumbers, true);
});
