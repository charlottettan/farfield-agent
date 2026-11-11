// Which windows Farfield is allowed to read at all. Everything else is dropped before any content is looked at.
export const TOOLS = [
  { id: "chatgpt", name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] },
  { id: "claude", name: "Claude", hosts: ["claude.ai"] },
  { id: "gemini", name: "Gemini", hosts: ["gemini.google.com"] },
  { id: "copilot", name: "Copilot", hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365.cloud.microsoft"] },
];

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
  const title = String((win && win.title) || "").trim();
  const app = String((win && win.app) || "");
  if (!title) return null;
  for (const t of TOOLS) {
    if (!ids.includes(t.id)) continue;
    const n = esc(t.name);
    // "Claude" on its own, or "Some chat - Claude". A title that merely starts with the name ("Claude vs GPT - Google Docs") does not count.
    const looksLike = new RegExp(`^${n}$|[-|–—:]\\s*${n}\\s*$`, "i").test(title);
    const desktopApp = new RegExp(`^${n}$`, "i").test(app);
    if (looksLike && (BROWSERS.test(app) || desktopApp)) return { ...t, basis: "title" };
  }
  return null;
}
