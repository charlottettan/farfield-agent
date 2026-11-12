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

export function taskKind(text) {
  const t = String(text || "").toLowerCase().slice(0, 600);
  if (!t.trim()) return null;
  let best = null, bestHits = 0;
  for (const [label, re] of KINDS) {
    const hits = (t.match(re) || []).length;
    if (hits > bestHits) { best = label; bestHits = hits; }
  }
  return best ? { label: best } : null;
}

// the first sentence or line, for the optional "name it after the first prompt" setting
export function firstSentence(text, max = 70) {
  const line = String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";       // the first non-empty line
  const s = line.replace(/\s+/g, " ").trim();
  const cut = s.split(/(?<=[.!?])\s/)[0] || s;                                      // then its first sentence
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + "…" : cut;
}
