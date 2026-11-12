// What kind of task a chat opened with, from the first message of the task. Only the label is ever kept, never the message.
// It is a keyword rule, not a model, and has been checked only on made-up prompts; real accuracy is not known.
// The label becomes the workflow's name, so the same kind of task groups together across tools and, once synced, across people.
const KINDS = [
  // [label, pattern]. Listed in priority order: when two kinds match equally often, the earlier one wins.
  ["Spreadsheet help", /\b(excel|spreadsheet|formula|vlookup|xlookup|pivot|worksheet|csv|macro|vba|cells?\b.*\b(range|formula|value)|column[s]?|row[s]?)\b/g],
  ["Slides", /\b(slides?|deck|presentation|powerpoint|pitch)\b/g],
  ["Code", /\b(code|python|javascript|typescript|sql|script|function|regex|debug|api|query|bug)\b/g],
  ["Email draft", /\b(e-?mails?|reply to|draft (?:a |an |the )?(?:reply|response|message|note)|follow[- ]?up|write (?:a |an )?(?:note|message) to)\b/g],
  ["Summary", /\b(summar(?:y|ize|ise|ies)|recap|tl;?dr|key points|takeaways?|digest|boil (?:it )?down)\b/g],
  ["Job application", /\b(r[eé]sum[eé]s?|cv|cover letters?|job applications?|applying for|interview prep|prepare for (?:an?|my) interview|personal statement)\b/g],
  ["Social post or announcement", /\b(linkedin|tweets?|twitter|instagram|blog(?: post)?|newsletter|announcement|announc(?:e|ing)|press release|caption|social media|posts?(?!-))\b/g],
  ["Memo or report", /\b(memo|report|write[- ]?up|white ?paper|proposal|letter|policy|procedure|checklist|one[- ]pager)\b/g],
  ["Compliance writing", /\b(compliance|disclosure|disclaimer|kyc|aml|regulat\w*|audit|risk committee)\b/g],
  ["Meeting prep", /\b(talking points|agenda|meeting|call prep|questions for|prep(?:are)? for)\b/g],
  ["Research and analysis", /\b(analy[sz]e|analysis|compare|comparison|research|explain|what is|how does|why did|forecast|estimate|valuation|dcf|model)\b/g],
  ["Editing", /\b(proofread|rewrite|rephrase|edit|polish|translate|shorten|simplify|improve)\b/g],
  ["Brainstorming", /\b(brainstorm\w*|ideas?|suggestions?|names for|come up with|options for)\b/g],
  ["Advice and decisions", /\b(should i|should we|pros and cons|decide|decision|whether (?:to|or not)|advice|advise|think through|trade-?offs?|which (?:one|option) is better)\b/g],
  ["Planning", /\b(plan|planning|schedule|timeline|roadmap|itinerary|milestones?|to-?do list|prioriti[sz]e)\b/g],
];

// A request that starts by asking for an email to someone ("write to Carlos", "message Tim that...", "reply to this") is an email,
// whatever the email is about ("...about the Rewired summary" is not a summary task). "write to a file" is not.
const EMAIL_LEAD = /^(?:(?:hi|hey|ok(?:ay)?|so|now|also|please|pls|can you|could you|would you|will you|help me|i need to|i want to|i have to|let'?s)[,!.]?\s+)*(?:(?:quickly|briefly)\s+)?(?:write (?:back )?to (?!(?:a|the|this|that|my|our) (?:file|csv|disk|database|db|table|log|sheet|cell|console)\b)|write back\b|message (?!box\b)\w+|text \w+ (?:that|to|about|and)|reply to|reply\b|respond to|respond\b|answer (?:this|his|her|their|the) (?:email|e-mail|message|note)|e-?mail\b|draft (?:a |an |the |my )?(?:\w+ )?(?:reply|response|email|e-mail|note|message)|get back to|follow up with|reach out to|thank \w+ for)/i;

// Is there a pasted email (or a whole thread) in this message? Headers, "On ... wrote:", or a greeting and a sign-off.
const HEADER = /^\s*(from|to|cc|bcc|sent|date|subject)\s*:/im;
const WROTE = /\bon .{4,160}\bwrote:\s*$/im;
const GREETING = /^\s*(hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^\n]{0,40}[,!:]?\s*$/im;
const SIGNOFF = /^\s*(best|thanks|thank you|regards|kind regards|best regards|warm regards|cheers|sincerely|warmly|all the best|talk soon)\b[^\n]{0,30}$/im;
export function hasPastedEmail(text) {
  const t = String(text || "");
  return HEADER.test(t) || WROTE.test(t) || (GREETING.test(t) && SIGNOFF.test(t) && t.split("\n").length >= 4);
}

// The person's own instruction, with pasted emails taken out. A thread pasted before or after "help me reply" would otherwise
// decide the kind of task by the words in the emails ("summary", "slides", "meeting"), and name the workflow after "From: Carlos".
// Email blocks: header lines, "On ... wrote:" lines, quoted ">" lines, and everything from a greeting or a header down to the
// sign-off and the name line under it. What is left is the instruction. Without a sign-off, the block runs to the next blank line
// that is followed by something that reads like a request to the AI.
const REQUEST = /^\s*(?:please|pls|can you|could you|would you|will you|help me|i need|i want|draft|write|reply|respond|answer|summari[sz]e|make|give|tell me|what|how|why|should i|prepare|translate|rewrite|shorten|turn this|use this|based on)/i;
export function instructionOf(text) {
  const t = String(text || "");
  if (!hasPastedEmail(t)) return t;
  const lines = t.split(/\r?\n/);
  const keep = [];
  let inEmail = false, afterSignoff = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], s = line.trim();
    if (afterSignoff > 0) {                                        // the name (and maybe a title) under a sign-off
      afterSignoff--;
      if (s && s.split(/\s+/).length <= 5 && !REQUEST.test(s)) continue;
      afterSignoff = 0;
    }
    if (/^\s*(from|to|cc|bcc|sent|date|subject)\s*:/i.test(line) || /\bwrote:\s*$/i.test(s) || /^\s*>/.test(line) || /^-{3,}\s*(original|forwarded) message/i.test(s)) { inEmail = true; continue; }
    if (!inEmail && GREETING.test(line) && !REQUEST.test(s)) { inEmail = true; continue; }
    if (inEmail) {
      if (SIGNOFF.test(line)) { inEmail = false; afterSignoff = 2; continue; }
      if (!s && i + 1 < lines.length && REQUEST.test(lines[i + 1]) ) { inEmail = false; continue; }
      continue;
    }
    keep.push(line);
  }
  const rest = keep.join("\n").trim();
  return rest;
}

export function taskKind(text) {
  const raw = String(text || "");
  const pasted = hasPastedEmail(raw);
  const instr = pasted ? instructionOf(raw) : raw;
  const lead = instr.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lead.some((l) => EMAIL_LEAD.test(l))) return { label: "Email draft" };
  // with an email pasted, asking how to answer it is an email too ("what should I say back?", "how do I respond?")
  if (pasted && /\b(say back|write back|reply|respond|response|answer (?:him|her|them|this|it)|get back to)\b/i.test(instr)) return { label: "Email draft" };
  const t = instr.toLowerCase().slice(0, 600);
  // An email pasted with no instruction around it (or one that names no other task) is most likely to be answered.
  if (pasted && !t.trim()) return { label: "Email draft" };
  if (!t.trim()) return null;
  let best = null, bestHits = 0;
  for (const [label, re] of KINDS) {
    const hits = (t.match(re) || []).length;
    if (hits > bestHits) { best = label; bestHits = hits; }
  }
  if (!best && pasted) return { label: "Email draft" };
  return best ? { label: best } : null;
}

// the first sentence or line, for the optional "name it after the first prompt" setting
export function firstSentence(text, max = 70) {
  // never named after a pasted email: the person's own instruction is used, or just "Email"
  const source = hasPastedEmail(text) ? instructionOf(text) || "Email" : String(text || "");
  const line = source.split(/\r?\n/).find((l) => l.trim()) || "";       // the first non-empty line
  const s = line.replace(/\s+/g, " ").trim();
  const cut = s.split(/(?<=[.!?])\s/)[0] || s;                                      // then its first sentence
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + "…" : cut;
}
