import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const A = createRequire(import.meta.url)("../vendor/analysis.js");

const AI = "Hi Carlos,\nHope you're having a great week!\nThank you again for sending over the Rewired summary. Belle and I read through it, and it was super helpful.\nWould you be open to a 20 minute call next week?\nBest,\nCharlotte";
const kind = (edited) => A.analyzeEdit(AI, edited);

test("edits: each change gets its own kind, and tone words are tone, not terminology", () => {
  assert.equal(kind(AI.replace("week!\n", "week!\nHahha\n")).category, A.CATEGORIES.TONE);          // a laugh on its own line is not a name
  assert.equal(kind(AI.replace("super helpful", "really useful")).category, A.CATEGORIES.TONE);
  assert.equal(kind(AI.replace("Hi Carlos", "Hey Carlos")).category, A.CATEGORIES.TONE);
  assert.equal(kind(AI.replace("20 minute", "15 minute")).category, A.CATEGORIES.FACTUAL);
  assert.equal(kind(AI.replace("next week", "next Thursday")).category, A.CATEGORIES.FACTUAL, "a date is a fact, not a name");
  assert.equal(kind(AI.replace("the Rewired", "the McKinsey Rewired")).category, A.CATEGORIES.TERM);
  assert.equal(kind(AI.replace("helpful.", "helpful. We are building a prototype that tracks where people fix AI output.")).category, A.CATEGORIES.CONTENT);
  const mixed = kind(AI.replace("Hi Carlos", "Hey Carlos").replace("20 minute", "15 minute"));
  assert.equal(mixed.category, A.CATEGORIES.FACTUAL, "a factual fix decides the whole edit");
  assert.deepEqual(mixed.edits.map((e) => e.category), [A.CATEGORIES.TONE, A.CATEGORIES.FACTUAL]);
  const kept = A.sanitizeCorrection({ id: "x", timestamp: 1, category: mixed.category, edits: mixed.edits.concat([{ category: "Made up", before: "a", after: "b" }]) });
  assert.deepEqual(kept.edits.map((e) => e.category), [A.CATEGORIES.TONE, A.CATEGORIES.FACTUAL], "kept through backup and sync; made-up kinds dropped");
  assert.deepEqual(mixed.edits.map((e) => [e.before, e.after]), [["Hi", "Hey"], ["20", "15"]]);
});

test("edits: time is per change plus typing, so a one-word tweak is seconds, not minutes", () => {
  assert.ok(kind(AI.replace("week!\n", "week!\nHahha\n")).estimatedMinutes <= 0.2);
  assert.ok(kind(AI.replace("20 minute", "15 minute")).estimatedMinutes < 1);
  assert.ok(A.estimateMinutes(A.CATEGORIES.FACTUAL, 0, 0, 3) > A.estimateMinutes(A.CATEGORIES.TONE, 0, 0, 3), "a factual fix takes longer to decide");
  assert.ok(A.estimateMinutes(A.CATEGORIES.CONTENT, 200, 0) > 5, "writing a long passage still adds up");
});
