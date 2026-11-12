// Decides what each message after the first one in a chat is, and where one task ends and the next begins.
//
//   correction  the person is fixing what the AI produced (this is the rework Farfield measures)
//   extension   the person is adding scope, not saying the output was wrong
//   question    the person is asking about the output
//   new_task    an unrelated request in the same chat
//   acceptance  thanks / looks good
//
// It is a transparent scoring rule, not a model: every decision carries the reasons behind it, so a person can see why
// something was or was not counted. It has been checked only on made-up chats. Real accuracy is not known yet.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../../vendor/analysis.js");
import { taskKind, hasPastedEmail, instructionOf } from "./task.js";

export const EPISODE_GAP_MINUTES = 45;
export const COUNT_AS_REWORK_AT = 0.6;

const STOP = new Set("a an the and or but if then so to of in on at for with from by as is are was were be been it its this that these those you your i me my we our they them their he she his her do does did done please thanks thank just into out up down over than also about like should would could can will have has had need needs want wants make made using use used".split(" "));
const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9%$.\-\s]/g, " ").split(/\s+/).map((w) => w.replace(/^[.\-]+|[.\-]+$/g, "")).filter((w) => w && !STOP.has(w));
const caps = (s) => (String(s || "").match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b|\b\d[\d,.]*%?/g) || []).map((w) => w.toLowerCase());

const ACCEPT = /^(thanks|thank you|thx|great|perfect|looks good|that works|ok(ay)?|got it|nice|awesome|cool|good|that'?s (it|all|great|perfect|right|correct)|(yes|yep|yeah),? (that'?s|this is) (right|correct|it))\b[^?]{0,40}$/i;
const NEW_CUE = /^(new (task|question|topic|request)|different (question|topic|task)|separate(ly)?|switching (gears|topics)|unrelated|on (a )?different note|now (let'?s|i need|help me|can you help)|next( task| up)?[,:]|i also need|another (task|thing|request))\b/i;
const EXT_CUE = /^(also|and also|additionally|now add|next add|can you also|could you also|add (a|an|another|one more)|one more thing)\b/i;
const STRONG_NEG = /\b(wrong|incorrect|not (right|correct|what)|that'?s not|isn'?t|aren'?t|doesn'?t|didn'?t|mistake|error|should be|should have|instead|actually|fix|redo|rewrite|too (long|short|formal|casual|vague|wordy|generic)|shorter|longer|remove|delete|replace|change|don'?t|do not|stop|missing|forgot|left out|off by|not matching|doesn'?t match|expected|meant|asked for|unclear|confusing|vague|leaves? out|omits?|omitted|skips?|skipped|supposed to|supposed to be|again|try again|more concise|less \w+|too \w+)\b|\w*(error|exception)\b|\b(traceback|throws|crash(es|ed)?|fails?|failed|failing|broken|doesn'?t work|not working|returns? (#|nan|null|undefined|nothing|blank|zero))|#(n\/a|ref!?|value!?|div\/0!?|name\?)/i;
const EDIT_VERB = /^(please\s+)?(make|rewrite|rephrase|reword|shorten|lengthen|tighten|simplify|soften|change|adjust|tweak|fix|redo|trim|cut|expand|reduce|use|replace|rename|reorder|reformat)\b/i;
const REFERS_BACK = /\b(it|this|that|these|those|above|earlier|previous|last|you (wrote|said|put|used|gave|included)|the (table|chart|summary|paragraph|slide|number|figure|section|draft|email|memo|output|answer|first|second|third|bullet|list))\b/i;
// "Great. Now ..." / "Ok, ..." : a short thanks in front of a real request. It is dropped before the request is read.
const PREAMBLE = /^(?:great|ok(?:ay)?|thanks|thank you|thx|perfect|cool|nice|awesome|got it|sounds good|good|alright|all right)\b[\s,.!:;-]+(?=\S)/i;
// polite openers in front of an edit ("can you make it less formal?")
const ASK = /^(?:(?:can|could|would|will) you\s+(?:please\s+)?|please\s+)/i;
// asks the AI to produce a new piece of work, as opposed to changing the one it just gave
const MAKE = /^(?:(?:and|also|now|next|then|ok(?:ay)?|so)[,:]?\s+)*(?:(?:can|could|would|will) you\s+(?:also\s+|please\s+|now\s+)*|please\s+|i (?:also )?(?:need|want) you to\s+|help me\s+(?:to\s+)?)?(?:(?:also|now|then)\s+)?(write|draft|create|make|prepare|build|compose|generate|put together|come up with|give me|set up|outline|plan|summari[sz]e|translate)\s+(?:me\s+|up\s+)?(\S+)/i;
const REF_OBJECT = /^(it|this|that|these|those|them|the|one|a\s+(?:shorter|longer|better|new version|revised|different version))\b/i;
// "for this function", "of this", "to it": the request is about the AI's output (a relative "that", as in "a macro that emails", is not)
const POINTS_AT_OUTPUT = /\b(?:of|for|to|from|on|with|in|into|using|about|around|based on)\s+(?:it|this|these|those|that (?!\w+s\b)|the (?:above|output|answer|code|function|formula|table|summary|draft|email|memo|script|query|data))\b|\b(?:of|for|to|from|on|with)\s+(?:it|this|that)\s*[.?!]?$/i;
const SEPARATE = /\b(separate|another|different|new|unrelated)\b/i;
const QUESTION = /\?\s*$|^(why|how|what|which|where|when|who|can you explain|explain|could you explain|is (it|that|this)|are (these|those))\b/i;

function containment(a, b) {
  if (!a.length) return 0;
  const set = new Set(b);
  let hit = 0;
  for (const w of a) if (set.has(w)) hit++;
  return hit / a.length;
}

// prev: { user, assistant }   gapSeconds: time since the AI's last reply appeared
// prev.task: the label of the task under way ("Summary"), when known. Without it the kind is read from prev.user.
export function classifyTurn(text, prev = {}, gapSeconds = 0) {
  const whole = String(text || "").trim();
  const reasons = [];
  if (!whole) return { label: "acceptance", confidence: 0.5, reasons: ["empty message"] };
  if (ACCEPT.test(whole)) return { label: "acceptance", confidence: 0.9, reasons: ["thanks or approval"] };
  // A pasted email (someone's reply, a thread) is not the person's own words: "the date should be the 18th" inside Carlos's
  // email is not a complaint about the AI. Only the instruction around it is judged. With no instruction, or one about
  // answering it, it is a new email to write.
  if (hasPastedEmail(whole)) {
    const own = instructionOf(whole).trim();
    if (!own || /\b(say back|write back|reply|respond|response|answer|get back to|draft (?:a |an |my )?(?:reply|response|answer)|what (?:should|do) i say)\b/i.test(own))
      return { label: "new_task", confidence: 0.85, reasons: ["pastes an email to answer (its wording is not judged)"] };
    if (!hasPastedEmail(own)) {
      const c = classifyTurn(own, prev, gapSeconds);
      return { ...c, reasons: c.reasons.concat(["only the instruction around a pasted email was judged"]) };
    }
  }
  const t = whole.replace(PREAMBLE, "").trim() || whole;
  if (NEW_CUE.test(t)) return { label: "new_task", confidence: 0.9, reasons: ["says it is a new or separate request"] };
  const fresh0 = newWork(t, prev);
  if (fresh0) return fresh0;
  if (gapSeconds > EPISODE_GAP_MINUTES * 60 && !STRONG_NEG.test(t)) return { label: "new_task", confidence: 0.75, reasons: ["came back after a long pause with a fresh request"] };

  const ctx = tokens((prev.assistant || "") + " " + (prev.user || ""));
  const mine = tokens(t);
  // With nothing earlier to compare against (the first message on screen, or a restarted watcher), overlap and "new names" say nothing,
  // so only the wording of the message itself is used.
  const hasCtx = ctx.length > 0;
  const overlap = hasCtx ? containment(mine, ctx) : 0;
  const ctxCaps = new Set(caps((prev.assistant || "") + " " + (prev.user || "")));
  const newEntities = hasCtx ? caps(t).filter((w) => !ctxCaps.has(w)).length : 0;
  const neg = STRONG_NEG.test(t);
  const known = A.classifyPrompt(t).isCorrection;
  const back = REFERS_BACK.test(t);
  const ext = EXT_CUE.test(t);
  const q = QUESTION.test(t) && !neg && !(EDIT_VERB.test(t.replace(ASK, "")) && back);   // "can you make it shorter?" is an edit, not a question

  let corr = 0, extn = 0, ques = 0, fresh = 0;
  const why = { corr: [], ext: [], ques: [], fresh: [] };
  if (neg) { corr += 0.5; why.corr.push("says something should change or was wrong"); }
  else if (known) { corr += 0.3; why.corr.push("matches a known correction pattern"); }
  if (back) { corr += 0.2; why.corr.push("refers to the AI's output"); }
  if (overlap >= 0.35) { corr += 0.2; why.corr.push("reuses the same words as the last answer"); }
  else if (overlap >= 0.2) corr += 0.1;
  const editsOutput = EDIT_VERB.test(t.replace(ASK, "")) && t.length <= 160 && newEntities < 3;
  if (editsOutput) { corr += 0.3; why.corr.push("asks to change how the output is worded or laid out"); }
  if (t.length <= 160) corr += 0.1;
  if (newEntities >= 3) { corr -= 0.3; why.corr.push("but introduces several new names or numbers"); }

  if (ext) { extn += 0.6; why.ext.push("starts by adding something"); if (!neg) corr -= 0.2; }
  if (!neg && /\b(add|include)\b/i.test(t) && back) { extn += 0.2; why.ext.push("asks to add to the output"); }

  if (q) { ques += 0.5; why.ques.push("is a question"); if (back || overlap >= 0.25) { ques += 0.2; why.ques.push("about the AI's output"); } }

  if (hasCtx && overlap < 0.1) { fresh += 0.4; why.fresh.push("shares almost no words with the last answer"); }
  if (newEntities >= 3) { fresh += 0.3; why.fresh.push("brings in several new names or numbers"); }
  if (t.length > 200) { fresh += 0.1; why.fresh.push("is a long fresh request"); }
  if (!back && !neg) fresh += 0.1;

  const scored = [["correction", corr, why.corr], ["extension", extn, why.ext], ["question", ques, why.ques], ["new_task", fresh, why.fresh]].sort((a, b) => b[1] - a[1]);
  const [label, top, r] = scored[0];
  const margin = top - scored[1][1];
  const confidence = Math.max(0.3, Math.min(0.95, 0.5 + margin));
  if (top < 0.25) return { label: "question", confidence: 0.35, reasons: ["not enough to tell what this is"], unsure: true };
  // With nothing earlier to weigh a weak cue against, a "known pattern" word alone is not enough to call something a correction.
  if (!hasCtx && label === "correction" && !(neg || editsOutput || back)) return { label: "question", confidence: 0.35, reasons: ["no earlier message to compare with, and no clear sign of a correction"], unsure: true };
  return { label, confidence: Math.round(confidence * 100) / 100, reasons: r.length ? r : reasons };
}

// A request for a new piece of work: "Now draft an email to the board", "Can you also write a LinkedIn post", "Also draft a separate email".
// It is a new task when it is a different kind of task from the one under way, or says it is separate/another.
// Asking for a new version of the same thing ("write it again", "give me a shorter one") is not: that is a correction.
function newWork(t, prev) {
  const m = MAKE.exec(t);
  if (!m) return null;
  const rest = t.slice(m.index + m[0].length - m[2].length);
  if (REF_OBJECT.test(rest) && !SEPARATE.test(rest.split(/\s+/).slice(0, 3).join(" "))) return null;     // "make it shorter", "write the intro again"
  if (STRONG_NEG.test(t)) return null;
  const kind = taskKind(t);
  const current = prev.task || (taskKind(prev.user || "") || {}).label || "";
  if (SEPARATE.test(t.slice(0, 80)) && kind) return { label: "new_task", confidence: 0.85, reasons: ["asks for another, separate piece of work"] };
  if (kind && current && kind.label !== current) return { label: "new_task", confidence: 0.85, reasons: ["asks for a new " + kind.label.toLowerCase() + ", a different kind of task from the " + current.toLowerCase() + " under way"] };
  if (kind && !current && !REFERS_BACK.test(t)) return { label: "new_task", confidence: 0.7, reasons: ["asks for a new " + kind.label.toLowerCase() + " and does not refer to the last answer"] };
  // a new piece of the same task that points at the output ("write a test for this function", "make a pivot table of this"): more work, not a fix.
  // Anything else is left to the scoring below.
  if (!POINTS_AT_OUTPUT.test(t)) return null;
  return { label: "extension", confidence: 0.65, reasons: ["asks for an additional piece of work on the same task, not a fix"] };
}

export function countsAsRework(c) { return c.label === "correction" && c.confidence >= COUNT_AS_REWORK_AT; }

// messages: [{ role: "user"|"assistant", text, at? (ms) }, ...] in order. Works on a live capture, an imported chat or a vendor log.
// Returns one entry per user message after the first, with the episode (task) it belongs to.
export function classifyConversation(messages) {
  const out = [];
  let prev = { user: "", assistant: "" };
  let lastAssistantAt = 0;
  let episode = 0, userCount = 0;
  for (const m of messages || []) {
    if (!m || !m.text) continue;
    if (m.role === "assistant") { prev.assistant = m.text; lastAssistantAt = m.at || 0; continue; }
    userCount++;
    if (userCount === 1) { prev.user = m.text; prev.task = (taskKind(m.text) || {}).label || ""; continue; }
    const gap = m.at && lastAssistantAt ? Math.max(0, (m.at - lastAssistantAt) / 1000) : 0;
    const c = classifyTurn(m.text, prev, gap);
    if (c.label === "new_task") episode++;
    out.push({ index: userCount, text: m.text, episode, ...c, rework: countsAsRework(c) });
    if (c.label === "new_task") prev = { user: m.text, assistant: "", task: (taskKind(m.text) || {}).label || "" }; else prev.user = m.text;
  }
  return out;
}
