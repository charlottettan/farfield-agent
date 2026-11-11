// Which windows Farfield is allowed to read at all. Everything else is dropped before any content is looked at.
export const TOOLS = [
  { id: "chatgpt", name: "ChatGPT", names: ["ChatGPT"], hosts: ["chatgpt.com", "chat.openai.com"] },
  { id: "claude", name: "Claude", names: ["Claude"], hosts: ["claude.ai"] },
  { id: "gemini", name: "Gemini", names: ["Gemini", "Google Gemini"], hosts: ["gemini.google.com"] },
  { id: "copilot", name: "Copilot", names: ["Copilot", "Microsoft Copilot", "Microsoft 365 Copilot"], hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365.cloud.microsoft"] },
];

// Window titles can carry invisible characters (Gemini's page name starts with a left-to-right mark), and non-breaking
// spaces. They are removed before matching so a title that looks right also matches.
export function cleanTitle(t) {
  return String(t || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Shows a title with any hidden or unusual characters spelled out, for diagnosing a title that does not match.
export function showTitle(t) {
  return String(t || "").replace(/[^\x20-\x7E]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const BROWSERS = /chrome|edge|safari|firefox|brave|arc|opera|chromium/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Works out whether a window is an AI chat tool, from its address (best) or its title (a guess).
// Browser window titles look like "Chat name - Claude", so the tool's name has to start or end the title.
export function identify(win, allowed) {
  const ids = Array.isArray(allowed) && allowed.length ? allowed : TOOLS.map((t) => t.id);
  const url = String((win && win.url) || "");
  if (url) {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { host = ""; }
    const hit = TOOLS.find((t) => ids.includes(t.id) && t.hosts.some((h) => host === h || host.endsWith("." + h)));
    return hit ? { ...hit, basis: "address" } : null;
  }
  const title = cleanTitle(win && win.title);
  const app = cleanTitle(win && win.app);
  if (!title && !app) return null;
  for (const t of TOOLS) {
    if (!ids.includes(t.id)) continue;
    const n = esc(t.name);
    // The tool's name on its own, or "Some chat - Claude" / "Some chat - Google Gemini" (the second was seen in Safari on a real Mac).
    // A title that merely starts with the name ("Claude vs GPT - Google Docs") does not count.
    const alt = (t.names || [t.name]).map(esc).join("|");
    const looksLike = new RegExp(`^(${alt})$|[-|–—:]\\s*(${alt})\\s*$`, "i").test(title);
    // An app that is itself named after the tool ("Gemini") is the tool, whatever its window title says (seen on a real Mac:
    // the title was "Gemini — <chat name>"). In a browser the title has to look like the tool's own tab title.
    const desktopApp = new RegExp(`^${n}$`, "i").test(app);
    if (desktopApp) return { ...t, basis: "app" };
    if (looksLike && BROWSERS.test(app)) return { ...t, basis: "title" };
  }
  return null;
}
