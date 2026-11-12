// Reads the text of one Gmail draft from the draft box only.
//
// How the reader gets here: the native reader jumps straight to the element labelled "Message Body" (Gmail's own label for
// the box you type an email in) and reads only what is inside it. If there is no such box, nothing at all is read
// (--focus-only), so the inbox, the thread and the recipients are never looked at.
//
// Inside the box, Gmail keeps two things that are not what the person wrote for this email:
//   - the quoted earlier message in a reply or forward (class "gmail_quote", or the "gmail_extra" wrapper)
//   - the person's saved signature (class "gmail_signature")
// Both are skipped. These class names come from the HTML Gmail sends; they have NOT yet been checked against a real
// accessibility dump of the Gmail draft box. Run `screen dump --email` with a test draft to check them.
//
// Returns { body } with the draft's text, or null when there is no draft box to go on.
const norm = (s) => String(s || "").replace(/\r/g, "").replace(/ /g, " ");
// Yahoo Mail's equivalents (yahoo_quoted, signature) are included too; not yet checked on a real dump.
const SKIP = /gmail_quote|gmail_extra|gmail_signature|yahoo_quoted|\bsignature\b/;

// Rebuilds the nesting from the flat, depth-numbered list the reader produces (document order).
function buildTree(nodes) {
  const root = { children: [], depth: -1 };
  const stack = [root];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const d = typeof n.depth === "number" ? n.depth : 0;
    while (stack.length > 1 && stack[stack.length - 1].depth >= d) stack.pop();
    const node = { ...n, depth: d, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

// When the box has no child text (some pages expose a text box only as one value), the value is used, cut where the
// quoted message starts ("On Tue, Nov 11, 2026 at 9:02 AM Tim <tim@...> wrote:") or at a forwarded-message marker.
const QUOTE_START = /\n\s*(On .{4,200}wrote:|-{5,}\s*Forwarded message\s*-{5,})/i;
export function cutQuoted(text) {
  const t = norm(text);
  const m = QUOTE_START.exec("\n" + t);
  return (m ? t.slice(0, Math.max(0, m.index - 1)) : t).trim();
}

export function gmailDraft(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const root = buildTree(nodes);
  const box = root.children[0];                       // the reader starts at the "Message Body" box itself
  if (!box) return null;
  const lines = [];
  (function walk(n) {
    for (const c of n.children) {
      if (SKIP.test(String(c.dom || ""))) continue;   // quoted earlier mail, signature: not this person's edit
      if (c.role === "AXStaticText" && norm(c.text).trim()) lines.push(norm(c.text).trim());
      walk(c);
    }
  })(box);
  const body = lines.length ? lines.join("\n") : cutQuoted(box.text);
  return { body: body.trim() };
}
