// Company sync. Sends your corrections to your company's Farfield server, but only after you join with an invite and agree to what is
// collected. Works alongside the local-only mode: if you never join, none of this runs.
//
//  - Only your own real records are sent: never sample data, and only what changed since the last successful send.
//  - The organization's privacy mode is applied here first (the server applies it again), so wording the mode doesn't allow never leaves the device.
//  - The token lives only in chrome.storage.local on this device.
(function (root) {
  "use strict";

  var KINDS = ["corrections", "sends", "aiSessions", "rePrompts", "fileRuns"];
  var BATCH = 400;

  function fnv(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }

  // https only (plain http is accepted for a server on this same computer, for development).
  function normalizeServer(input) {
    var u;
    try { u = new URL(String(input || "").trim()); } catch (e) { return null; }
    var local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password) return null;
    return u.origin;
  }

  function createSync(env) {
    var chrome_ = env.chrome, fetch_ = env.fetch, now = env.now || Date.now, A = env.A;
    var running = null;

    function get(keys) { return chrome_.storage.local.get(keys); }
    function set(obj) { return chrome_.storage.local.set(obj); }

    function mask(s) { return A && A.redactPrompt ? A.redactPrompt(String(s == null ? "" : s)) : String(s == null ? "" : s).replace(/\d/g, "#"); }
    function handle(v, mode) { return mode === "themes" ? "" : mode === "redacted" ? mask(v) : String(v == null ? "" : v); }
    // The same rules as the server: full keeps wording, redacted masks names, numbers and emails, themes keeps no wording at all.
    function scrub(kind, rec, mode) {
      if (!mode || mode === "full") return rec;
      var o = Object.assign({}, rec);
      if (kind === "rePrompts") {
        o.text = handle(rec.text, mode);
        if (typeof rec.instruction === "string") o.instruction = mode === "themes" ? undefined : handle(rec.instruction, mode);
      } else if (kind === "corrections") {
        ["originalSnippet", "editedSnippet", "subject"].forEach(function (f) { o[f] = handle(rec[f], mode); });
        ["termsAdded", "termsRemoved"].forEach(function (f) { o[f] = mode === "themes" ? [] : (Array.isArray(rec[f]) ? rec[f] : []).map(mask); });
      } else if (kind === "fileRuns") {
        o.changes = (Array.isArray(rec.changes) ? rec.changes : []).map(function (c) { return { addr: c.addr, before: handle(c.before, mode), after: handle(c.after, mode) }; });
      }
      return o;
    }

    function isLive(kind, r) { return kind === "sends" ? !!(r && r.surface) : !!r && r.source !== "seed"; }

    // Everything that should be on the server, keyed so we can tell what has changed since the last send.
    function candidates(data, mode) {
      var out = [];
      KINDS.forEach(function (kind) {
        var list = Array.isArray(data[kind]) ? data[kind] : [], seen = {};
        list.forEach(function (raw) {
          if (!raw || typeof raw !== "object" || !isLive(kind, raw)) return;
          var rec = scrub(kind, raw, mode), id;
          if (kind === "sends") {
            var key = [raw.t, raw.agent, raw.category, raw.surface].join("|");
            seen[key] = (seen[key] || 0) + 1;
            id = "s_" + fnv(key) + "_" + (seen[key] - 1);
            rec = Object.assign({}, rec, { id: id });
          } else id = String(raw.id || "");
          if (!id) return;
          out.push({ kind: kind, id: id, rec: rec, sig: fnv(JSON.stringify(rec)) });
        });
      });
      return out;
    }

    async function http(server, method, path, token, body, timeoutMs) {
      var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 20000) : null;
      var res;
      try {
        res = await fetch_(server + path, {
          method: method, signal: ctl ? ctl.signal : undefined,
          headers: Object.assign({}, body !== undefined ? { "Content-Type": "application/json" } : {}, token ? { Authorization: "Bearer " + token } : {}),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        var err = new Error(e && e.name === "AbortError" ? "The server took too long to answer." : "Couldn't reach the server.");
        err.network = true;
        throw err;
      } finally { if (timer) clearTimeout(timer); }
      var json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      if (!res.ok) {
        var e2 = new Error((json && json.error && json.error.message) || "The server said no (" + res.status + ").");
        e2.status = res.status; e2.code = json && json.error && json.error.code; e2.retryAfter = Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 0;
        throw e2;
      }
      return json;
    }

    async function company() { var d = await get(["company"]); return d.company && d.company.token ? d.company : null; }

    async function preview(serverInput, code) {
      var server = normalizeServer(serverInput);
      if (!server) throw new Error("Enter the server address, starting with https://");
      var p = await http(server, "GET", "/v1/invite/preview?code=" + encodeURIComponent(String(code || "").trim()), null, undefined);
      return Object.assign({ server: server }, p);
    }

    async function join(o) {
      var server = normalizeServer(o.server);
      if (!server) throw new Error("Enter the server address, starting with https://");
      if (o.consent !== true) throw new Error("You need to agree to what Farfield collects before joining.");
      var j = await http(server, "POST", "/v1/join", null, { code: String(o.code || "").trim(), email: String(o.email || "").trim(), name: o.name || "", consent: true, deviceLabel: o.deviceLabel || "Chrome extension" });
      var co = { server: server, token: j.token, user: j.user, org: j.org, policy: j.policy, joinedAt: now() };
      await set({ company: co, syncState: { sent: {}, failures: 0 }, lastServer: server });
      return co;
    }

    async function leave(o) {
      var co = await company();
      var result = { server: "skipped" };
      if (co) {
        try { result = await http(co.server, "POST", "/v1/me/leave", co.token, { deleteData: !!(o && o.deleteData) }); }
        catch (e) { if (e.status !== 401) { var err = new Error("Couldn't reach the server, so you haven't left yet. Try again when you're online."); err.network = true; throw err; } }
      }
      await chrome_.storage.local.remove(["company", "syncState", "viewMode"]);
      return result;
    }

    async function status() {
      var d = await get(["company", "syncState"]);
      var co = d.company && d.company.token ? d.company : null;
      if (!co) return { joined: false };
      var st = d.syncState || {};
      return { joined: true, server: co.server, org: co.org, user: co.user, policy: co.policy, signedOut: !!co.signedOut, lastOkAt: st.lastOkAt || 0, lastError: st.lastError || "", nextTryAt: st.nextTryAt || 0 };
    }

    async function pending() {
      var d = await get(["company", "syncState"].concat(KINDS));
      var co = d.company && d.company.token ? d.company : null;
      if (!co) return 0;
      var sent = (d.syncState && d.syncState.sent) || {};
      return candidates(d, co.policy && co.policy.privacyMode).filter(function (c) { return !(sent[c.kind] && sent[c.kind][c.id] === c.sig); }).length;
    }

    function fail(co, st, e) {
      st.failures = (st.failures || 0) + 1; st.lastError = e.message || "Sync failed.";
      st.nextTryAt = now() + (e.retryAfter ? e.retryAfter * 1000 : Math.min(15 * 60000, 30000 * Math.pow(2, st.failures - 1)));
    }

    // Send what's new or changed. Safe to call as often as you like, and from several places at once.
    function syncNow(opts) {
      if (running) return running;
      running = (async function () {
        var d = await get(["company", "syncState"].concat(KINDS));
        var co = d.company && d.company.token ? d.company : null;
        if (!co) return { ok: false, skipped: "not_joined" };
        if (co.signedOut) return { ok: false, skipped: "signed_out" };
        var st = d.syncState || { sent: {}, failures: 0 };
        st.sent = st.sent || {};
        if (!(opts && opts.force) && st.nextTryAt && st.nextTryAt > now()) return { ok: false, skipped: "backoff" };
        var sentCount = {}, total = 0;
        try {
          // The mode may have been tightened since we last looked, and our role may have changed.
          var me = await http(co.server, "GET", "/v1/me", co.token);
          if (JSON.stringify(me.policy) !== JSON.stringify(co.policy) || me.role !== co.user.role) {
            co = Object.assign({}, co, { policy: me.policy, user: Object.assign({}, co.user, { role: me.role }) });
            await set({ company: co });
          }
          var todo = candidates(d, co.policy && co.policy.privacyMode).filter(function (c) { return !(st.sent[c.kind] && st.sent[c.kind][c.id] === c.sig); });
          for (var i = 0; i < todo.length; i += BATCH) {
            var chunk = todo.slice(i, i + BATCH), records = {};
            chunk.forEach(function (c) { (records[c.kind] = records[c.kind] || []).push(c.rec); });
            var res = await http(co.server, "POST", "/v1/ingest", co.token, { records: records });
            chunk.forEach(function (c) {
              // a record the server refused as invalid is remembered too, so we don't retry it forever
              (st.sent[c.kind] = st.sent[c.kind] || {})[c.id] = c.sig;
              sentCount[c.kind] = (sentCount[c.kind] || 0) + 1; total++;
            });
            st.lastOkAt = now(); st.failures = 0; st.lastError = ""; st.nextTryAt = 0;
            await set({ syncState: st });
            void res;
          }
          if (!todo.length) { st.lastOkAt = now(); st.failures = 0; st.lastError = ""; st.nextTryAt = 0; await set({ syncState: st }); }
          return { ok: true, sent: sentCount, total: total };
        } catch (e) {
          if (e.status === 401) {
            await set({ company: Object.assign({}, co, { signedOut: true }), syncState: Object.assign({}, st, { lastError: "Your access to this company was removed. Join again with a new invite." }) });
            return { ok: false, skipped: "signed_out", error: e.message };
          }
          fail(co, st, e);
          await set({ syncState: st });
          return { ok: false, error: e.message, network: !!e.network, sent: sentCount, total: total };
        }
      })().finally(function () { running = null; });
      return running;
    }

    // The company's data as this person is allowed to see it (used by the dashboard).
    async function fetchOrgData() {
      var co = await company();
      if (!co) throw new Error("Not joined to a company.");
      if (co.signedOut) { var s = new Error("Your access to this company was removed."); s.status = 401; throw s; }
      try { return await http(co.server, "GET", "/v1/org/data", co.token, undefined, 15000); }
      catch (e) { if (e.status === 401) await set({ company: Object.assign({}, co, { signedOut: true }) }); throw e; }
    }

    // Any other authenticated call (fix approvals and the like).
    async function api(method, path, body) {
      var co = await company();
      if (!co) throw new Error("Not joined to a company.");
      return http(co.server, method, path, co.token, body, 20000);
    }

    return { preview: preview, join: join, leave: leave, status: status, pending: pending, syncNow: syncNow, fetchOrgData: fetchOrgData, api: api, scrub: scrub, candidates: candidates };
  }

  var out = { createSync: createSync, normalizeServer: normalizeServer, fnv: fnv, KINDS: KINDS };
  if (typeof module !== "undefined" && module.exports) module.exports = out;
  root.FarfieldSyncFactory = out;
  if (typeof chrome !== "undefined" && chrome.storage && typeof fetch === "function") root.FarfieldSync = createSync({ chrome: chrome, fetch: fetch.bind(root), A: root.FarfieldAnalysis });
})(typeof self !== "undefined" ? self : this);
