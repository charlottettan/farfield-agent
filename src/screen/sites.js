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

// Browsers add their own name (and sometimes the profile) to the end of a window title:
//   "Chat - Claude - Google Chrome - Charlotte (Person 1)"   (seen on a real Mac)
// Everything from the last "<separator> <browser name>" onward is removed, so the page's own title is what is matched.
const BROWSER_NAMES = "Google Chrome|Chromium|Brave|Microsoft Edge|Mozilla Firefox|Firefox|Safari|Arc|Opera|Vivaldi";
export function stripBrowserSuffix(t) {
  const re = new RegExp(`\\s[-–—|]\\s(?:${BROWSER_NAMES})(?=\\s[-–—|]\\s|$)`, "ig");
  let at = -1, m;
  while ((m = re.exec(t))) at = m.index;
  return at >= 0 ? t.slice(0, at).trim() : t;
}

// Chrome also adds status notices to the end of a window title, before its own name: a heavy tab shows
//   "Chat - Claude - High memory usage - 1.9 GB - Google Chrome - Charlotte (Person 1)"   (the first one seen on a real Mac)
// Those notices are removed too, after the browser name and profile, so the page's own title is what is matched.
// "Audio playing", "Camera recording" and "Microphone recording" are plausible ones that have not been seen yet.
const STATUS_NOTICE = /\s[-–—|]\s(?:High memory usage(?:\s[-–—|]\s\d+(?:\.\d+)?\s?[KMGT]?B)?|Audio playing|Camera recording|Microphone recording)\s*$/i;
export function stripStatusNotices(t) {
  let prev;
  do { prev = t; t = t.replace(STATUS_NOTICE, "").trim(); } while (t !== prev);
  return t;
}

// The chat's own title: the window title with the browser's tail, status notices and the tool's name removed. Empty for a new, untitled chat.
const DEFAULT_TITLES = /^(new chat|untitled|untitled chat|new conversation|chat|home|claude|chatgpt|gemini|google gemini|copilot|microsoft copilot)$/i;
export function chatTitle(win, tool) {
  let t = stripStatusNotices(stripBrowserSuffix(cleanTitle(win && win.title)));
  const names = (tool && (tool.names || [tool.name])) || [];
  if (names.length) t = t.replace(new RegExp(`\\s*[-–—|:]\\s*(?:${names.map(esc).join("|")})\\s*$`, "i"), "").trim();
  return DEFAULT_TITLES.test(t) ? "" : t;
}

// The shape of a title: names of AI tools, browsers and a few common apps are kept, every other word becomes a pattern of letters and
// digits. It shows whether a title looks like "<something> - Claude - Google Chrome" without keeping what the something is.
const KEEP_WORDS = new Set("claude chatgpt gemini copilot google microsoft openai chrome safari firefox edge brave arc opera vivaldi mozilla chromium gmail docs sheets slides outlook word excel powerpoint terminal iterm finder slack teams zoom notion code".split(" "));
export function titleShape(t) {
  return cleanTitle(t).replace(/[A-Za-z]+/g, (w) => (KEEP_WORDS.has(w.toLowerCase()) ? w : w[0] === w[0].toUpperCase() && w.length > 1 ? "X" + "x".repeat(w.length - 1) : "x".repeat(w.length))).replace(/[0-9]/g, "9").slice(0, 120);
}

// Shows a title with any hidden or unusual characters spelled out, for diagnosing a title that does not match.
export function showTitle(t) {
  return String(t || "").replace(/[^\x20-\x7E]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const BROWSERS = /chrome|edge|safari|firefox|brave|arc|opera|chromium/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Email apps whose draft box Farfield may read, to see how a person changed AI text before sending it. Off unless turned on
// separately from chat reading (screen email on --agree). Only the draft box is ever read, never the inbox or the thread.
export const EMAIL_APPS = [
  { id: "gmail", name: "Gmail", names: ["Gmail"], hosts: ["mail.google.com"], surface: "Gmail" },
];

// Works out whether a window is an allowed email app. Gmail's tab titles end in "- Gmail" ("Inbox (3) - you@example.com - Gmail",
// "Compose Mail - you@example.com - Gmail"), so the name has to end the title and the app has to be a browser.
export function identifyEmail(win, allowed) {
  const ids = Array.isArray(allowed) ? allowed : [];
  if (!ids.length) return null;
  const url = String((win && win.url) || "");
  if (url) {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { host = ""; }
    const hit = EMAIL_APPS.find((t) => ids.includes(t.id) && t.hosts.includes(host));
    return hit ? { ...hit, basis: "address" } : null;
  }
  const title = stripStatusNotices(stripBrowserSuffix(cleanTitle(win && win.title)));
  const app = cleanTitle(win && win.app);
  if (!BROWSERS.test(app)) return null;
  for (const t of EMAIL_APPS) {
    if (!ids.includes(t.id)) continue;
    const alt = t.names.map(esc).join("|");
    if (new RegExp(`(?:^|[-|–—]\\s*)(${alt})\\s*$`, "i").test(title)) return { ...t, basis: "title" };
  }
  return null;
}

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
  const title = stripStatusNotices(stripBrowserSuffix(cleanTitle(win && win.title)));
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
