// Reads a Gemini conversation from the page's own structure. Written from a real Safari dump of gemini.google.com, where:
//   your message   = a heading with the class "screen-reader-user-query-label" ("You said"), then "query-text-line" groups
//                    (or a "query-bullet-list") holding the text
//   Gemini's reply = a group whose id starts with "model-response-message-content"
//   the draft box  = "ql-editor" (never a sent message)
// Everything else (buttons, "Good response", follow-up suggestions) is not part of a message.
// Messages that have scrolled out of view came back with empty text in that dump, so they are skipped, not guessed.
const norm = (s) => String(s || "").replace(/\r/g, "").trim();
const has = (n, s) => String(n.dom || "").includes(s);

// Rebuilds the nesting from the flat, depth-numbered list the reader produces (document order).
function buildTree(nodes) {
  const root = { children: [], depth: -1 };
  const stack = [root];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const d = typeof n.depth === "number" ? n.depth : 0;
    while (stack.length > 1 && stack[stack.length - 1].depth >= d) stack.pop();   // a gap in depth still attaches to the nearest shallower node
    const node = { ...n, depth: d, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

function staticTexts(node, out = []) {
  for (const c of node.children) {
    if (c.role === "AXStaticText" && norm(c.text)) out.push(norm(c.text));   // static text only: headings repeat their children's text
    staticTexts(c, out);
  }
  return out;
}

export function geminiTurns(nodes) {
  if (!Array.isArray(nodes) || !nodes.some((n) => n && n.dom)) return null;   // no page structure to go on
  const root = buildTree(nodes);
  const turns = [];
  let composer = "";
  let cur = null;
  const flushUser = () => {
    if (!cur) return;
    const text = (cur.lines.length ? cur.lines : cur.fallback).join("\n");
    if (norm(text)) turns.push({ role: "user", text });
    cur = null;
  };
  const startUser = () => { if (!cur) cur = { lines: [], fallback: [] }; };
  (function walk(n) {
    for (const c of n.children) {
      if (has(c, "ql-editor")) { composer = norm(c.text) || composer; continue; }            // the draft box, and everything in it
      if (has(c, "screen-reader-user-query-label")) { flushUser(); cur = { lines: [], fallback: staticTexts(c).filter((t) => !/^you said$/i.test(t)) }; continue; }
      if (has(c, "query-text-line") || has(c, "query-bullet-list")) { startUser(); cur.lines.push(...staticTexts(c)); continue; }
      if (has(c, "model-response-message-content")) {
        flushUser();
        const text = staticTexts(c).join("\n");
        if (norm(text)) turns.push({ role: "assistant", text });
        continue;
      }
      walk(c);
    }
  })(root);
  flushUser();
  return { turns, composer };
}
