// Turns what is on screen (a list of text pieces with their accessibility roles) into the conversation: who said what.
// Anything it cannot attribute to a person or the assistant is dropped, never guessed.
const CHROME = new Set(["copy", "retry", "share", "edit", "regenerate", "read aloud", "good response", "bad response", "like", "dislike", "send", "send message", "attach", "search", "copy code", "new chat", "more actions", "try again", "show more", "show less", "thinking", "stop", "stop generating", "voice", "microphone"]);
const COMPOSER_ROLE = /textarea|textbox|text field|textfield|edit$|^edit|combo/i;
const USER_CUE = /^(you|you said|you:|me|me:|user|you wrote)\s*:?$/i;
const ASSISTANT_CUE = /^(chatgpt|claude|gemini|copilot|assistant)(\s+(said|responded|replied|wrote))?\s*:?$/i;
const MAX_TURN = 20000;
import { ADAPTERS } from "./adapters/index.js";

const norm = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export function extractTurns(snapshot, tool) {
  const nodes = Array.isArray(snapshot && snapshot.nodes) ? snapshot.nodes : [];
  // A reader written for this site's page structure is used first, when the page structure was captured.
  if (tool && ADAPTERS[tool.id]) {
    const r = ADAPTERS[tool.id](nodes);
    const turns = r ? r.turns.map((t) => ({ role: t.role, text: norm(t.text).slice(0, MAX_TURN), ...(t.index ? { index: t.index, total: t.total } : {}) })).filter((t) => t.text) : [];
    if (turns.some((t) => t.role === "user")) return { turns, composer: r.composer || "", basis: "adapter:" + tool.id };
  }
  let composer = "";
  const items = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const text = norm(n.text);
    if (!text) continue;
    if (COMPOSER_ROLE.test(String(n.role || "")) && !n.authorRole) { composer = text; continue; }   // a draft that has not been sent
    if (CHROME.has(text.toLowerCase())) continue;
    items.push({ text, authorRole: n.authorRole === "user" || n.authorRole === "assistant" ? n.authorRole : "" });
  }

  const turns = [];
  const push = (role, parts) => { const text = norm(parts.join("\n")).slice(0, MAX_TURN); if (text) turns.push({ role, text }); };

  if (items.some((i) => i.authorRole)) {
    // an adapter that knows the page structure said who wrote each piece
    let role = "", parts = [];
    for (const i of items) {
      if (!i.authorRole) continue;
      if (i.authorRole !== role) { if (role) push(role, parts); role = i.authorRole; parts = []; }
      parts.push(i.text);
    }
    if (role) push(role, parts);
    // a page with no message from the person is not a conversation (an app header that says "Claude" is not a reply)
    if (!turns.some((t) => t.role === "user")) return { turns: [], composer, basis: "none" };
    return { turns, composer, basis: "structure" };
  }

  // otherwise rely on the labels the page itself prints ("You said", "Claude")
  let role = "", parts = [];
  for (const i of items) {
    if (USER_CUE.test(i.text)) { if (role) push(role, parts); role = "user"; parts = []; continue; }
    if (ASSISTANT_CUE.test(i.text)) { if (role) push(role, parts); role = "assistant"; parts = []; continue; }
    if (role) parts.push(i.text);                 // text before the first label is not attributed to anyone
  }
  if (role) push(role, parts);
  if (!turns.some((t) => t.role === "user")) return { turns: [], composer, basis: "none" };
  return { turns, composer, basis: "labels" };
}
