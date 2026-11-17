// Small helpers that make the desktop app's records more honest. Kept out of vendor/ (the extension's shared code) so a refresh
// from the extension does not undo them.
//
//  - categoriesOf: one edit can be several kinds of change (a fact fixed AND the tone softened). Each changed sentence (or cell)
//    is labelled on its own; the label with the most words changed is the main one, and all of them are kept.
//  - minutesFor: time from what was measured, not only from the word-count estimate (which said 7 minutes for an 83-second edit).
//  - redact: the "redacted" privacy mode, with a choice to keep numbers readable (names and email addresses are always hidden).
//  - readingSeconds: how long a reply takes to read, for a re-prompt whose review time could not be measured.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../vendor/analysis.js");

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

// sentences, one per line of the email / paragraph, then split at sentence ends
export function sentences(text) {
  return String(text || "").split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)/)).map((s) => s.trim()).filter(Boolean);
}

// before/after pairs of the sentences that changed (removed and added sentences paired in order, like the Word comparison)
export function changedPairs(before, after) {
  const x = sentences(before), y = sentences(after), n = x.length, m = y.length;
  const T = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = x[i] === y[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const dels = [], adds = [];
  let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) dels.push(x[i++]); else adds.push(y[j++]); }
  while (i < n) dels.push(x[i++]);
  while (j < m) adds.push(y[j++]);
  const out = [];
  for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ before: dels[k] || "", after: adds[k] || "" });
  return out;
}

// A changed spreadsheet formula ("=AVERAGE(J5:J9)" -> "=AVERAGE(J5:J8)") is its own kind of change: the AI's formulas being wrong
// is a different, more serious problem than one number being off. It is kept as an extra label only, because the code that checks
// records before backup and sync (vendor/analysis.js, shared with the extension) accepts just the four main labels; the main label of
// a formula-only fix is "Factual/Data Correction", which routes it to engineering.
export const FORMULA = "Formula error";
const isFormula = (v) => /^=/.test(String(v || "").trim());

// The main label: the first of the four standard ones (never "Formula error"), or Factual for a formula-only fix.
export function mainCategory(kinds) {
  const std = Object.values(A.CATEGORIES);
  return (kinds || []).find((k) => std.includes(k)) || (kinds && kinds.includes(FORMULA) ? A.CATEGORIES.FACTUAL : "");
}

// every kind of change in a list of before/after pairs, the biggest first
export function categoriesOf(pairs) {
  const weight = {};
  for (const p of pairs || []) {
    if (String(p.before) === String(p.after)) continue;
    if (isFormula(p.before) || isFormula(p.after)) { weight[FORMULA] = (weight[FORMULA] || 0) + 3; continue; }   // a formula weighs more than a word
    const a = A.analyzeEdit(A.normalizeText(String(p.before || "")), A.normalizeText(String(p.after || "")));
    // The analyser calls any change of 12% of the length "content added or removed"; for a short phrase ("Best regards," ->
    // "Cheers,") one word is half the length. A small swap in a short phrase, with no figures involved, is a tone change.
    const longest = Math.max(String(p.before || "").split(/\s+/).filter(Boolean).length, String(p.after || "").split(/\s+/).filter(Boolean).length);
    let kind = a.category;
    if (kind === A.CATEGORIES.CONTENT && longest <= 6 && a.wordsAdded + a.wordsRemoved <= 4 && p.before && p.after) kind = A.CATEGORIES.TONE;
    weight[kind] = (weight[kind] || 0) + Math.max(1, a.wordsAdded + a.wordsRemoved);
  }
  return Object.keys(weight).sort((p, q) => weight[q] - weight[p]);
}

// Minutes to record.
//  measuredSeconds: time actually spent (an email draft's open time). Used when there is a real measurement; a draft that was only
//    closed because it sat idle may include idle time, so it is never counted above the estimate.
//  elapsedSeconds: time between the AI's version and the save (files). Not editing time, but a ceiling: an edit cannot take longer.
export function minutesFor({ estimate, measuredSeconds, elapsedSeconds, idle = false }) {
  const est = Number(estimate) || 0;
  if (measuredSeconds && measuredSeconds >= 15) {
    const m = Math.max(1, Math.round(measuredSeconds / 60));
    return idle ? { minutes: Math.min(m, Math.max(est, 1)), source: "measured, capped by the estimate" } : { minutes: m, source: "measured" };
  }
  if (elapsedSeconds && elapsedSeconds > 0) {
    const ceiling = Math.max(1, Math.ceil(elapsedSeconds / 60));
    if (ceiling < est) return { minutes: ceiling, source: "estimated, capped by the time between the AI's version and the save" };
  }
  return { minutes: est, source: "estimated" };
}

export const maskEmails = (text) => String(text == null ? "" : text).replace(EMAIL, "[email]");

// The "redacted" mode: email addresses and names are always hidden; numbers too unless keepNumbers.
const NOT_NAMES = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split(" "));
export function redact(text, { keepNumbers = false } = {}) {
  const words = maskEmails(text).split(/(\s+)/);
  let start = true;
  return words.map((w) => {
    if (/^\s+$/.test(w) || w === "") return w;
    const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    let out = w;
    if (!start && /^\p{Lu}/u.test(core) && core.length > 1 && !/^\p{Lu}+\d*$/u.test(core) && !NOT_NAMES.has(core.toLowerCase())) out = w.replace(core, "[name]");   // acronyms (Q3, EBITDA), weekdays and months are not names
    if (!keepNumbers) out = out.replace(/\d/g, "#");
    start = /[.!?]["')\]]?$/.test(w);
    return out;
  }).join("");
}

// Seconds to read a reply at about 240 words a minute, between 5 seconds and 5 minutes.
export function readingSeconds(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  return Math.min(300, Math.max(5, Math.round(words / 4)));
}
