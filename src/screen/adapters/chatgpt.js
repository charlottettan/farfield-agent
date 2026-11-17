// Reads a ChatGPT conversation from the page's own structure. Written from a real Chrome dump of chatgpt.com (Nov 2026), where:
//   the conversation   = a region labelled "Conversation"
//   each message       = starts with a hidden heading, "You said:" or "ChatGPT said:"; the message is what follows it at the same
//                        level or deeper, until something shallower (the page's footer and the draft box come after, shallower)
//   your message       = static text inside the message bubble
//   ChatGPT's reply    = static text, plus the text boxes of a drafted-email card ("writing block": a Subject box and a body box,
//                        with "Open in email" / "Recipients" buttons). The body box also exposes its lines as static text, so a
//                        text box's own text is used and the text inside it is not counted twice.
//   not a message      = buttons (Copy message, Edit message, Share, Read aloud, suggested follow-ups such as "Make it warmer")
// A reply collapsed behind "Show more" exposes only its card title, so only what is on screen is read, never guessed.
const norm = (s) => String(s || "").replace(/\r/g, "").trim();
const USER = /^you said:?$/i;
const BOT = /^chatgpt said:?$/i;
const isHeading = (n) => n && n.role === "AXHeading" && (USER.test(norm(n.text)) || BOT.test(norm(n.text)));

export function chatgptTurns(nodes) {
  if (!Array.isArray(nodes) || !nodes.some((n) => n && n.dom) || !nodes.some(isHeading)) return null;
  const turns = [];
  let cur = null, skipBelow = Infinity;
  const flush = () => {
    if (!cur) return;
    const parts = [];
    for (const p of cur.parts) if (p && p !== parts[parts.length - 1]) parts.push(p);   // a card's title and Subject box repeat
    const text = parts.join("\n");
    if (norm(text)) turns.push({ role: cur.role, text });
    cur = null;
  };
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const d = typeof n.depth === "number" ? n.depth : 0;
    if (isHeading(n)) { flush(); cur = { role: USER.test(norm(n.text)) ? "user" : "assistant", depth: d, parts: [] }; skipBelow = Infinity; continue; }
    if (!cur) continue;
    if (d < cur.depth) { flush(); continue; }                       // left the message: the footer and the draft box are shallower
    if (d > skipBelow) continue;                                    // lines inside a text box already taken whole
    skipBelow = Infinity;
    const t = norm(n.text);
    if (!t) continue;
    if (n.role === "AXStaticText") { if (!USER.test(t) && !BOT.test(t)) cur.parts.push(t); }
    else if (n.role === "AXTextArea" && cur.role === "assistant") { cur.parts.push(t); skipBelow = d; }
  }
  flush();
  return { turns, composer: "" };
}
