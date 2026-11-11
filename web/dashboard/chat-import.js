/*
 * Reads past AI chats so their follow-up prompts can join the re-prompt log.
 *   - ChatGPT export (conversations.json, a tree of messages) and Claude export (chat_messages list)
 *   - the .zip you download, a plain .json/.jsonl file, or text pasted from a chat
 * Only your own messages are kept (the first prompt of each chat is never stored). Assistant replies are
 * used for timestamps only and are discarded.
 */
(function (root) {
  "use strict";
  var A = root.FarfieldAnalysis || (typeof require !== "undefined" ? require("./analysis.js") : null);
  var MAX_CONVERSATIONS = 3000;
  var GAP_CAP_MS = 10 * 60 * 1000;

  function toMs(v) {
    if (typeof v === "number" && isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    if (typeof v === "string") { var t = Date.parse(v); return isNaN(t) ? null : t; }
    return null;
  }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }
  function keyOf(platform) { return String(platform || "other").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  // ---------------------------------------------------------------- ChatGPT / Claude exports
  function chatgptText(content) {
    if (!content) return "";
    if (Array.isArray(content.parts)) return content.parts.filter(function (p) { return typeof p === "string"; }).join("\n");
    return typeof content.text === "string" ? content.text : "";
  }

  function fromChatGPT(c) {
    var nodes = c.mapping, ids = [];
    if (c.current_node && nodes[c.current_node]) {
      // Follow the branch that is actually shown: regenerated or edited alternatives are skipped.
      var seen = {};
      for (var id = c.current_node; id && nodes[id] && !seen[id]; id = nodes[id].parent) { seen[id] = 1; ids.push(id); }
      ids.reverse();
    } else {
      ids = Object.keys(nodes).filter(function (k) { return nodes[k] && nodes[k].message; })
        .sort(function (a, b) { return (nodes[a].message.create_time || 0) - (nodes[b].message.create_time || 0); });
    }
    var messages = [];
    ids.forEach(function (id) {
      var m = nodes[id] && nodes[id].message;
      if (!m || !m.author) return;
      var role = m.author.role;
      if (role !== "user" && role !== "assistant") return;
      var meta = m.metadata || {};
      if (meta.is_visually_hidden_from_conversation || meta.is_user_system_message) return;
      var text = chatgptText(m.content);
      if (!text.trim()) return;
      messages.push({ id: String(m.id || id), role: role, t: toMs(m.create_time), text: text });
    });
    var created = toMs(c.create_time);
    var convId = String(c.id || c.conversation_id || "") || "t" + hash(String(c.title || "") + String(created));
    return { platform: "ChatGPT", convId: convId, title: String(c.title || ""), createdAt: created, messages: messages };
  }

  function fromClaude(c) {
    var messages = [];
    c.chat_messages.forEach(function (m, i) {
      if (!m) return;
      var role = m.sender === "human" || m.role === "user" ? "user" : m.sender === "assistant" || m.role === "assistant" ? "assistant" : null;
      if (!role) return;
      var text = typeof m.text === "string" && m.text ? m.text
        : Array.isArray(m.content) ? m.content.filter(function (x) { return x && x.type === "text" && typeof x.text === "string"; }).map(function (x) { return x.text; }).join("\n") : "";
      if (!text.trim()) return;
      messages.push({ id: String(m.uuid || "m" + i), role: role, t: toMs(m.created_at), text: text });
    });
    var created = toMs(c.created_at);
    var convId = String(c.uuid || c.id || "") || "t" + hash(String(c.name || "") + String(created));
    return { platform: "Claude", convId: convId, title: String(c.name || c.title || ""), createdAt: created, messages: messages };
  }

  // parsed: the JSON from conversations.json (an array), or a single conversation object
  function parseChatExport(parsed) {
    var list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
    var out = [], unknown = 0;
    list.forEach(function (c) {
      if (c && c.mapping && typeof c.mapping === "object") out.push(fromChatGPT(c));
      else if (c && Array.isArray(c.chat_messages)) out.push(fromClaude(c));
      else unknown++;
    });
    return { conversations: out, unknown: unknown };
  }

  // A file may be a JSON array, a single object, or JSON Lines (one conversation per line).
  function parseFileText(text) {
    var t = String(text || "").trim();
    if (!t) throw new Error("The file is empty.");
    try { return JSON.parse(t); } catch (e) { /* maybe JSON Lines */ }
    var rows = [];
    t.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      rows.push(JSON.parse(line));
    });
    return rows;
  }

  // ---------------------------------------------------------------- pasted text
  var USER_MARK = /^(you said|you|user|human|me|prompt)\s*:\s*(.*)$/i;
  var AI_MARK = /^(chatgpt said|claude said|gemini said|copilot said|chatgpt|claude|gemini|copilot|assistant|ai|model|bot)\s*:\s*(.*)$/i;

  function parseTranscript(text, opts) {
    opts = opts || {};
    var src = String(text || "").replace(/\r\n?/g, "\n").trim();
    var messages = [], mode = "prompts";
    var lines = src.split("\n"), cur = null, sawMarker = false;
    lines.forEach(function (line) {
      var t = line.trim(), u = USER_MARK.exec(t), a = AI_MARK.exec(t);
      if (u) { sawMarker = true; cur = { role: "user", text: u[2] }; messages.push(cur); }
      else if (a) { sawMarker = true; cur = { role: "assistant", text: a[2] }; messages.push(cur); }
      else if (cur) cur.text += "\n" + line;
    });
    if (sawMarker) {
      mode = "roles";
      messages = messages.map(function (m, i) { return { id: "m" + i, role: m.role, t: null, text: m.text.trim() }; }).filter(function (m) { return m.text; });
    } else {
      mode = "prompts";
      var chunks = /^\s*-{3,}\s*$/m.test(src) ? src.split(/^\s*-{3,}\s*$/m) : src.split(/\n\s*\n/);
      messages = chunks.map(function (c) { return c.trim(); }).filter(Boolean).map(function (c, i) { return { id: "m" + i, role: "user", t: null, text: c }; });
    }
    var platform = opts.platform || "Other";
    return { mode: mode, conversation: { platform: platform, convId: "paste_" + hash(src), title: String(opts.title || ""), createdAt: opts.when || null, messages: messages } };
  }

  // ---------------------------------------------------------------- zip (the export you download)
  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }

  async function defaultInflate(bytes) {
    var ds = new root.DecompressionStream("deflate-raw");
    var w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new root.Response(ds.readable).arrayBuffer());
  }

  // Returns [{ name, text }] for every conversations*.json / .jsonl inside the zip.
  async function unzipConversations(buffer, inflate) {
    var inf = inflate || defaultInflate;
    var d = new Uint8Array(buffer), eocd = -1;
    for (var i = d.length - 22; i >= Math.max(0, d.length - 70000); i--) { if (u32(d, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("This does not look like a zip file.");
    var count = u16(d, eocd + 10), off = u32(d, eocd + 16);
    if (off === 0xffffffff || count === 0xffff) throw new Error("This zip is too large to read here (zip64). Unzip it and choose conversations.json instead.");
    var dec = new root.TextDecoder("utf-8"), out = [];
    for (var n = 0; n < count; n++) {
      if (u32(d, off) !== 0x02014b50) throw new Error("The zip file is damaged.");
      var method = u16(d, off + 10), csize = u32(d, off + 20), nlen = u16(d, off + 28), xlen = u16(d, off + 30), clen = u16(d, off + 32), lho = u32(d, off + 42);
      var name = dec.decode(d.subarray(off + 46, off + 46 + nlen));
      off += 46 + nlen + xlen + clen;
      if (!/(^|\/)conversations(-\d+)?\.jsonl?$/i.test(name)) continue;
      if (u32(d, lho) !== 0x04034b50) throw new Error("The zip file is damaged.");
      var start = lho + 30 + u16(d, lho + 26) + u16(d, lho + 28), comp = d.subarray(start, start + csize);
      var raw = method === 0 ? comp : method === 8 ? await inf(comp) : null;
      if (!raw) throw new Error("This zip uses a compression method that cannot be read here. Unzip it and choose conversations.json.");
      out.push({ name: name, text: dec.decode(raw) });
    }
    return out;
  }

  // ---------------------------------------------------------------- turning chats into records
  // opts: { mode: "full" | "redacted", nameFrom: "title" | "auto", includeSingle, now, workflow }
  function planChatImport(convs, current, opts) {
    opts = opts || {};
    var mode = opts.mode === "redacted" ? "redacted" : "full";
    var haveSession = {}, haveRp = {}, taken = [];
    (current.aiSessions || []).forEach(function (s) { haveSession[s.id] = 1; if (s.workflow && taken.indexOf(s.workflow) === -1) taken.push(s.workflow); });
    (current.rePrompts || []).forEach(function (r) { haveRp[r.id] = 1; if (r.workflow && taken.indexOf(r.workflow) === -1) taken.push(r.workflow); });
    var summary = { chats: convs.length, imported: 0, noFollowUps: 0, duplicates: 0, rePrompts: 0, byPlatform: {}, truncated: Math.max(0, convs.length - MAX_CONVERSATIONS) };
    var sessions = [], rePrompts = [], preview = [];
    var fallbackNow = opts.now || Date.now();

    convs.slice(0, MAX_CONVERSATIONS).forEach(function (c) {
      var users = c.messages.filter(function (m) { return m.role === "user"; });
      if (!users.length) return;
      if (users.length < 2 && !opts.includeSingle) { summary.noFollowUps++; return; }
      var pkey = keyOf(c.platform), sid = "imp_" + pkey + "_" + c.convId;
      if (haveSession[sid]) { summary.duplicates++; return; }

      var firstT = null;
      c.messages.forEach(function (m) { if (firstT === null && m.t) firstT = m.t; });
      var baseTs = firstT || c.createdAt || opts.when || fallbackNow;

      var base;
      if (opts.workflow) base = String(opts.workflow);
      else if (opts.nameFrom === "title" && c.title.trim()) base = c.title.trim();
      else base = A.autoWorkflowName(c.platform, baseTs);
      if (mode === "redacted") base = A.redactPrompt(base);
      var wf = A.uniqueName(base.slice(0, 120), taken); taken.push(wf);

      var gapTotal = 0, lastT = null, userIdx = 0, lastTs = baseTs, newRp = [];
      c.messages.forEach(function (m) {
        var gap = m.t && lastT ? m.t - lastT : null;
        if (m.t) lastT = m.t;
        if (m.role !== "user") return;
        var idx = userIdx++;
        if (m.t) lastTs = m.t;
        if (idx === 0) return; // the first prompt of a chat is never stored
        var gapOk = gap !== null && gap > 0 && gap < GAP_CAP_MS;
        if (gapOk) gapTotal += Math.round(gap / 1000);
        var rid = "imp_" + pkey + "_" + c.convId + "_" + m.id;
        if (haveRp[rid]) return;
        var rec = A.buildRePrompt({ id: rid, sessionId: sid, site: c.platform, workflow: wf, attemptIndex: idx + 1, kind: "followup", text: m.text,
          mode: mode, reviewSec: 0, writeSec: 0, now: m.t || baseTs + idx * 1000, source: "live" });
        rec.imported = true;
        rec.gapSeconds = gapOk ? Math.min(Math.round(gap / 1000), 600) : 0;
        newRp.push(rec);
      });

      sessions.push({ id: sid, site: c.platform, workflow: wf, startedAt: baseTs, lastAt: lastTs, attempts: users.length, regens: 0, gapSeconds: gapTotal, done: true, source: "live", imported: true });
      newRp.forEach(function (r) { rePrompts.push(r); });
      summary.imported++; summary.rePrompts += newRp.length;
      summary.byPlatform[c.platform] = (summary.byPlatform[c.platform] || 0) + 1;
      if (preview.length < 6) preview.push({ workflow: wf, platform: c.platform, followUps: newRp.length, when: baseTs, sample: newRp[0] ? newRp[0].text.slice(0, 90) : "" });
    });

    return {
      summary: summary, preview: preview,
      result: { aiSessions: (current.aiSessions || []).concat(sessions), rePrompts: (current.rePrompts || []).concat(rePrompts) },
    };
  }

  var api = { parseChatExport: parseChatExport, parseFileText: parseFileText, parseTranscript: parseTranscript, unzipConversations: unzipConversations, planChatImport: planChatImport, toMs: toMs };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldChatImport = api;
})(typeof self !== "undefined" ? self : globalThis);
