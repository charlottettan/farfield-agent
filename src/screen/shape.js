// Describes what a saved window dump looks like WITHOUT its content, so it can be shared safely.
// Short texts (up to 14 characters, like button labels and "You") are shown as they are, because the labels are what
// matter. Longer texts are shown only as a length and a pattern of letters and digits. Review the output before sharing.
const SHORT = 14;
const mask = (t) => String(t).replace(/[A-Z]/g, "X").replace(/[a-z]/g, "x").replace(/[0-9]/g, "9");

// What gets saved by default: short texts (labels) kept, anything longer reduced to its length and a letter pattern.
export function maskNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    const text = String((n && n.text) || "");
    const base = { role: n.role, ...(n.sub ? { sub: n.sub } : {}), ...(typeof n.depth === "number" ? { depth: n.depth } : {}), ...(n.dom ? { dom: String(n.dom).slice(0, 120) } : {}) };
    if (!text) return base;
    return text.length <= SHORT ? { ...base, text } : { ...base, textLength: text.length, textShape: mask(text.slice(0, 20)) };
  });
}

export function shapeDump(dump, { lines = 150 } = {}) {
  const nodes = Array.isArray(dump && dump.nodes) ? dump.nodes : [];
  const roles = {};
  nodes.forEach((n) => { const k = (n.role || "?") + (n.sub ? "/" + n.sub : ""); roles[k] = (roles[k] || 0) + 1; });
  const out = [];
  out.push(`app: ${dump && dump.win ? dump.win.app : "?"}   items: ${nodes.length}   engine: ${(dump && dump.engine) || "?"}`);
  out.push("kinds: " + Object.entries(roles).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} x${v}`).join(", "));
  out.push("");
  let shown = 0;
  for (const n of nodes) {
    if (shown >= lines) { out.push(`... ${nodes.length - shown} more items not shown`); break; }
    const text = String(n.text || "");
    const depth = typeof n.depth === "number" ? Math.min(n.depth, 14) : 0;
    const label = (n.role || "?") + (n.sub ? "/" + n.sub : "");
    let t = "";
    if (n.textLength) t = `len=${n.textLength} ${n.textShape || ""}…`;                  // already reduced when it was saved
    else if (text) t = text.length <= SHORT ? JSON.stringify(text) : `len=${text.length} ${mask(text.slice(0, 20))}…`;
    out.push("  ".repeat(depth) + label + (n.dom ? " [" + String(n.dom).slice(0, 80) + "]" : "") + (t ? " " + t : ""));
    shown++;
  }
  return out.join("\n");
}
