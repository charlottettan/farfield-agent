// Reads a Claude conversation from the page's own structure. Written from a real Chrome dump of claude.ai, where:
//   the list of messages  = a group labelled "Chat messages"; everything inside sits at one flat level (no nesting to go by),
//                           so messages are split by the order of the markers
//   each message starts   = an item labelled like "Message 3 of 8" (an AXDocumentArticle)
//   who said it           = a hidden heading ("You said: ..." / "Claude responded: ..."); failing that, the bubble class
//                           (group/bubble = you) or the reply class (group/message-row, group/status = Claude)
//   not part of a message = the heading's own repeated text, the status line (it repeats a button's label), the
//                           "47 minutes ago" label, and buttons such as Copy, Retry and Edit
//   the draft box         = outside the message list, so it is never reached
// The wording of the two heading labels was inferred from their masked letter pattern, hence the class fallback.
const norm = (s) => String(s || "").replace(/\r/g, "").trim();
const TIME = /^(just now|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago)$/i;
const isArticle = (n) => n.role === "AXGroup" && n.sub === "AXDocumentArticle";

function messagesRegion(nodes) {
  const i = nodes.findIndex((n) => n && n.role === "AXGroup" && n.sub === "AXApplicationGroup" && /^chat messages$/i.test(norm(n.text)));
  if (i < 0) return null;
  const d = typeof nodes[i].depth === "number" ? nodes[i].depth : 0;
  const region = [];
  for (let k = i + 1; k < nodes.length; k++) {
    const n = nodes[k];
    if (n && typeof n.depth === "number" && n.depth <= d) break;       // left the message list (the draft box is after it)
    region.push(n);
  }
  return region;
}

function roleOf(block, headingText) {
  if (/^(you|human|me)\b/i.test(headingText)) return "user";
  if (/^(claude|assistant)\b/i.test(headingText)) return "assistant";
  const doms = block.map((n) => String((n && n.dom) || "")).join(" ");
  if (doms.includes("group/bubble")) return "user";
  if (doms.includes("group/message-row") || doms.includes("group/status")) return "assistant";
  return "";
}

export function claudeTurns(nodes) {
  if (!Array.isArray(nodes) || !nodes.some((n) => n && n.dom)) return null;
  const region = messagesRegion(nodes);
  if (!region) return null;

  const blocks = [];
  for (const n of region) {
    if (!n) continue;
    if (isArticle(n)) blocks.push([]);
    else if (blocks.length) blocks[blocks.length - 1].push(n);         // anything before the first message marker is not a message
  }

  const turns = [];
  for (const block of blocks) {
    const heading = block.find((n) => n.role === "AXHeading" && String(n.dom || "").includes("sr-only"));
    const headingText = norm(heading && heading.text);
    const role = roleOf(block, headingText);
    if (!role) continue;
    const labels = new Set(block.filter((n) => (n.role === "AXButton" || n.role === "AXHeading") && norm(n.text)).map((n) => norm(n.text)));
    const parts = block
      .filter((n) => n.role === "AXStaticText" && norm(n.text))
      .map((n) => norm(n.text))
      .filter((t) => t !== headingText && !labels.has(t) && !TIME.test(t));
    const text = parts.join("\n");
    if (norm(text)) turns.push({ role, text });
  }
  return { turns, composer: "" };
}
