/*
 * Optional, opt-in smart grouping of saved re-prompts using Claude, with the person's own API key.
 * It never changes the saved prompts: the results are a separate layer (promptAnalysis) that can be thrown away.
 * Nothing is sent unless the person presses "Analyze", and text is masked first by default.
 *
 * Step 1 (per batch): for each message, say whether it is an instruction, pasted material, or both, and
 *                     extract the short instruction, the kind of change, and a short theme.
 * Step 2 (once):      group the extracted instructions into named clusters and write one clean standing rule each.
 */
(function (root) {
  "use strict";
  var A = root.FarfieldAnalysis || (typeof require !== "undefined" ? require("./analysis.js") : null);

  var API_URL = "https://api.anthropic.com/v1/messages";
  var DEFAULT_MODEL = "claude-haiku-5-5";
  var BATCH = 20, MAX_ITEMS = 400, TEXT_LIMIT = 1500;
  var TYPES = ["instruction", "pasted_material", "mixed"];
  var CHANGES = ["Length", "Tone and style", "Formatting", "Add information", "Remove information", "Fix an error", "Change the output type", "Restructure", "Terminology", "New request", "Other"];
  var ONE_OFF = "One-off requests";

  // ------------------------------------------------------------------ prompts
  function buildExtractionPrompt(items) {
    return [
      "You are analyzing follow-up messages a person sent to an AI chat assistant after the first prompt of a chat.",
      "For each message decide:",
      '- "type": "instruction" (the person tells the AI what to change or do), "pasted_material" (mostly text the person pasted for the AI to work on, with no clear request), or "mixed" (pasted material plus a request).',
      '- "instruction": what the person is asking the AI to do, as a standalone imperative of at most 20 words, for example "Make the writing shorter". Use an empty string if there is no request. Never copy pasted material into it.',
      '- "change": exactly one of ' + JSON.stringify(CHANGES) + ".",
      '- "theme": two to five lowercase words naming the recurring thing being asked, for example "shorter writing".',
      "",
      "Return ONLY a JSON array with one object per message, in the same order, shaped like:",
      '[{"id":"...","type":"...","instruction":"...","change":"...","theme":"..."}]',
      "",
      "Messages:",
      JSON.stringify(items.map(function (i) { return { id: i.id, text: String(i.text).slice(0, TEXT_LIMIT) }; })),
    ].join("\n");
  }

  function buildClusterPrompt(rows) {
    return [
      "Below are instructions a person gave an AI assistant across many chats, each with an id, a theme and a kind of change.",
      "Group them into at most 12 clusters. A cluster is one underlying, repeatable request (for example, make writing shorter).",
      "For each cluster write:",
      '- "name": three to six words.',
      '- "rule": ONE clear standing instruction, written as an imperative sentence, that could be added to an AI assistant\'s instructions so the person would not have to ask again. Generalize it. Do not include names, numbers, or details of any single task.',
      '- "ids": the ids in the cluster.',
      'Every id must appear in exactly one cluster. Put requests that do not repeat in a cluster named "' + ONE_OFF + '" whose rule is an empty string.',
      "",
      'Return ONLY JSON shaped like {"clusters":[{"name":"...","rule":"...","ids":["..."]}]}.',
      "",
      "Instructions:",
      JSON.stringify(rows),
    ].join("\n");
  }

  // ------------------------------------------------------------------ parsing and validation
  function parseJsonLoose(text) {
    var t = String(text || "").trim();
    t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(t); } catch (e) { /* look for the JSON inside the text */ }
    var a = t.indexOf("["), b = t.lastIndexOf("]"), c = t.indexOf("{"), d = t.lastIndexOf("}");
    var arr = a !== -1 && b > a ? t.slice(a, b + 1) : null, obj = c !== -1 && d > c ? t.slice(c, d + 1) : null;
    // Try whichever structure starts first, so an object that contains a list is not mistaken for the list.
    var tries = a !== -1 && (c === -1 || a < c) ? [arr, obj] : [obj, arr];
    for (var i = 0; i < tries.length; i++) { if (!tries[i]) continue; try { return JSON.parse(tries[i]); } catch (e2) { /* next */ } }
    throw new Error("The reply was not valid JSON.");
  }

  function cleanStr(v, n) { return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : ""; }

  function validateExtraction(parsed, items) {
    if (!Array.isArray(parsed)) throw new Error("The reply did not contain a list.");
    var want = {}; items.forEach(function (i) { want[i.id] = true; });
    var out = {};
    parsed.forEach(function (x) {
      if (!x || typeof x !== "object" || !want[x.id] || out[x.id]) return;
      var type = TYPES.indexOf(x.type) !== -1 ? x.type : "instruction";
      var instruction = cleanStr(x.instruction, 200);
      if (type === "pasted_material") instruction = "";
      out[x.id] = { type: type, instruction: instruction, change: CHANGES.indexOf(x.change) !== -1 ? x.change : "Other", theme: cleanStr(x.theme, 60).toLowerCase() };
    });
    return out;
  }

  function validateClusters(parsed, ids) {
    var list = parsed && Array.isArray(parsed.clusters) ? parsed.clusters : Array.isArray(parsed) ? parsed : null;
    if (!list) throw new Error("The reply did not contain clusters.");
    var known = {}; ids.forEach(function (i) { known[i] = true; });
    var used = {}, clusters = [];
    list.forEach(function (c, i) {
      if (!c || typeof c !== "object") return;
      var members = (Array.isArray(c.ids) ? c.ids : []).filter(function (id) { if (!known[id] || used[id]) return false; used[id] = true; return true; });
      if (!members.length) return;
      var name = cleanStr(c.name, 80) || "Group " + (i + 1);
      clusters.push({ id: "llm_" + clusters.length, name: name, rule: name === ONE_OFF ? "" : cleanStr(c.rule, 300), memberIds: members });
    });
    var missing = ids.filter(function (id) { return !used[id]; });
    if (missing.length) {
      var one = clusters.filter(function (c) { return c.name === ONE_OFF; })[0];
      if (one) one.memberIds = one.memberIds.concat(missing);
      else clusters.push({ id: "llm_" + clusters.length, name: ONE_OFF, rule: "", memberIds: missing });
    }
    return clusters;
  }

  // ------------------------------------------------------------------ calling the API
  function describeError(status, body) {
    var msg = body && body.error && body.error.message ? body.error.message : "";
    if (status === 401 || status === 403) return "The API key was rejected. Check that it is correct and has access to the model.";
    if (status === 404) return "The model was not found. Check the model name." + (msg ? " (" + msg + ")" : "");
    if (status === 429) return "Rate limited. Wait a minute and press Analyze again; finished batches are kept.";
    if (status >= 500) return "The service had a problem (" + status + "). Try again shortly.";
    return "The request failed (" + status + ")" + (msg ? ": " + msg : ".");
  }

  async function callClaude(fetchFn, apiKey, model, prompt, maxTokens) {
    var res;
    try {
      res = await fetchFn(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: model, max_tokens: maxTokens || 4000, messages: [{ role: "user", content: prompt }] }),
      });
    } catch (e) { throw new Error("Could not reach the service. Check your connection."); }
    var body = null;
    try { body = await res.json(); } catch (e2) { /* non-JSON body */ }
    if (!res.ok) throw new Error(describeError(res.status, body));
    var text = body && Array.isArray(body.content) ? body.content.filter(function (b) { return b && b.type === "text"; }).map(function (b) { return b.text; }).join("") : "";
    if (!text) throw new Error("The service returned an empty reply.");
    return text;
  }

  async function withRetry(fn) {
    try { return await fn(false); } catch (e) { if (/valid JSON|did not contain/.test(e.message)) return fn(true); throw e; }
  }

  // ------------------------------------------------------------------ the whole run
  // opts: { fetch, apiKey, model, rePrompts, existing (previous promptAnalysis), redact, onProgress }
  async function runAnalysis(opts) {
    var fetchFn = opts.fetch, model = opts.model || DEFAULT_MODEL, redact = opts.redact !== false;
    var existing = opts.existing && opts.existing.items ? opts.existing.items : {};
    var candidates = (opts.rePrompts || []).filter(function (r) { return r && r.kind !== "regen" && r.text; }).slice(-MAX_ITEMS);
    var todo = candidates.filter(function (r) { return !existing[r.id]; });
    var items = Object.assign({}, existing);
    var sent = 0, calls = 0;
    var progress = opts.onProgress || function () {};

    for (var i = 0; i < todo.length; i += BATCH) {
      var batch = todo.slice(i, i + BATCH).map(function (r) { return { id: r.id, text: redact ? A.redactPrompt(r.text) : r.text }; });
      progress("Reading prompts " + Math.min(i + BATCH, todo.length) + " of " + todo.length + "\u2026");
      var got = await withRetry(async function (strict) {
        calls++;
        var prompt = buildExtractionPrompt(batch) + (strict ? "\n\nYour last reply was not valid JSON. Reply with the JSON array only, no other text." : "");
        return validateExtraction(parseJsonLoose(await callClaude(fetchFn, opts.apiKey, model, prompt, 4000)), batch);
      });
      Object.keys(got).forEach(function (id) { items[id] = got[id]; });
      sent += batch.length;
      if (opts.onPartial) await opts.onPartial({ version: 1, model: model, at: Date.now(), redacted: redact, items: Object.assign({}, items), clusters: (opts.existing && opts.existing.clusters) || [] });
    }

    var forClusters = candidates.filter(function (r) { var x = items[r.id]; return x && x.type !== "pasted_material" && x.instruction; });
    var clusters = [];
    if (forClusters.length) {
      progress("Grouping " + forClusters.length + " requests\u2026");
      var rows = forClusters.map(function (r) { var x = items[r.id]; return { id: r.id, instruction: x.instruction, theme: x.theme, change: x.change }; });
      var ids = rows.map(function (r) { return r.id; });
      clusters = await withRetry(async function (strict) {
        calls++;
        var prompt = buildClusterPrompt(rows) + (strict ? "\n\nYour last reply was not valid JSON. Reply with the JSON only, no other text." : "");
        return validateClusters(parseJsonLoose(await callClaude(fetchFn, opts.apiKey, model, prompt, 6000)), ids);
      });
    }
    return { analysis: { version: 1, model: model, at: Date.now(), redacted: redact, items: items, clusters: clusters }, stats: { analyzed: sent, calls: calls, clustered: forClusters.length } };
  }

  var api = { runAnalysis: runAnalysis, buildExtractionPrompt: buildExtractionPrompt, buildClusterPrompt: buildClusterPrompt, parseJsonLoose: parseJsonLoose,
    validateExtraction: validateExtraction, validateClusters: validateClusters, callClaude: callClaude, DEFAULT_MODEL: DEFAULT_MODEL, API_URL: API_URL, ONE_OFF: ONE_OFF, CHANGES: CHANGES, BATCH: BATCH };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldLLM = api;
})(typeof self !== "undefined" ? self : globalThis);
