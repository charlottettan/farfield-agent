// Lets the extension's dashboard run as an ordinary web page. It provides the few chrome.* features the dashboard
// uses, backed by the local Farfield app instead of a browser extension.
(function () {
  "use strict";
  var HEADERS = { "content-type": "application/json", "x-farfield": "1" };
  function post(path, body) {
    return fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body || {}), credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("Farfield app " + r.status); return r.json(); });
  }
  var realFetch = window.fetch.bind(window);

  // Requests to another site (the company server) go through the local app, which only allows the joined company's address.
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    var abs;
    try { abs = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
    if (abs.origin === location.origin) return realFetch(input, init);
    init = init || {};
    var headers = {};
    if (init.headers) { new Headers(init.headers).forEach(function (v, k) { headers[k] = v; }); }
    return post("/api/proxy", { url: abs.href, method: init.method || "GET", headers: headers, body: typeof init.body === "string" ? init.body : undefined })
      .then(function (r) {
        return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType || "application/json" } });
      });
  };

  var snapshot = null;       // key -> JSON text, to work out which keys changed
  var listeners = [];
  function fire(changed) {
    var keys = Object.keys(changed);
    if (!keys.length) return;
    var obj = {};
    keys.forEach(function (k) { obj[k] = { newValue: changed[k] }; });
    listeners.slice().forEach(function (fn) { try { fn(obj, "local"); } catch (e) { console.error(e); } });
  }
  function diffAgainst(all) {
    var changed = {};
    var next = {};
    Object.keys(all).forEach(function (k) {
      var t = JSON.stringify(all[k]);
      next[k] = t;
      if (snapshot && snapshot[k] !== t) changed[k] = all[k];
    });
    if (snapshot) Object.keys(snapshot).forEach(function (k) { if (!(k in next)) changed[k] = undefined; });
    snapshot = next;
    fire(changed);
  }
  function refresh() { return post("/api/storage/get", { keys: null }).then(function (r) { diffAgainst(r.data || {}); }); }

  var local = {
    get: function (keys) { return post("/api/storage/get", { keys: keys == null ? null : keys }).then(function (r) { return r.data; }); },
    set: function (items) { return post("/api/storage/set", { items: items }).then(refresh).then(function () {}); },
    remove: function (keys) { return post("/api/storage/remove", { keys: keys }).then(refresh).then(function () {}); },
  };

  // Changes made by the agent in the background (a new correction was found) show up by polling.
  var lastStamp = null;
  function poll() {
    if (document.hidden) return;
    post("/api/storage/stamp").then(function (r) {
      var changed = lastStamp !== null && r.stamp !== lastStamp;
      lastStamp = r.stamp;
      return changed ? refresh() : null;
    }).catch(function () {});
  }

  function sendMessage(message, cb) {
    var p = post("/api/message", message).catch(function () { return { ok: false }; });
    if (typeof cb === "function") { p.then(function (r) { cb(r); }); return undefined; }
    return p;
  }

  window.chrome = window.chrome || {};
  window.chrome.storage = { local: local, onChanged: { addListener: function (fn) { listeners.push(fn); } } };
  window.chrome.runtime = { sendMessage: sendMessage, lastError: undefined, getManifest: function () { return { version: "desktop app" }; }, getURL: function (p) { return "/" + p; } };
  window.chrome.permissions = { request: function () { return Promise.resolve(false); }, contains: function () { return Promise.resolve(false); } };

  refresh().then(function () { post("/api/storage/stamp").then(function (r) { lastStamp = r.stamp; }); setInterval(poll, 1500); }, function () {});

  // A small always-visible status, so it is clear Farfield is running and can be paused from any page. On the dashboard it
  // sits in the top bar (styled by farfield-look.css); anywhere else it is a small pill in the corner.
  function pill() {
    var bar = document.querySelector(".top-controls");
    var box = document.createElement(bar ? "span" : "div");
    box.setAttribute("role", "status");
    if (bar) return inBar(bar, box);
    box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.45);background:Canvas;color:CanvasText;font:12px/1.2 Inter,-apple-system,'Segoe UI',Roboto,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.15)";
    var dot = document.createElement("span"); dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#999";
    var label = document.createElement("span"); label.textContent = "Farfield";
    var btn = document.createElement("button"); btn.type = "button"; btn.style.cssText = "font:inherit;padding:2px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;cursor:pointer";
    var link = document.createElement("a"); link.href = "/panel.html"; link.textContent = "Panel"; link.style.cssText = "color:inherit";
    box.appendChild(dot); box.appendChild(label); box.appendChild(btn); box.appendChild(link);
    document.body.appendChild(box);
    var paused = false;
    function draw(s) {
      paused = !!s.paused;
      dot.style.background = paused ? "#c98a00" : s.running ? "#2e9d57" : "#999";
      label.textContent = paused ? "Farfield is paused" : s.running ? "Farfield is running" : "Farfield is not running";
      btn.textContent = paused ? "Resume" : "Pause";
    }
    function load() { fetch("/api/agent/status", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(draw, function () {}); }
    btn.addEventListener("click", function () { post(paused ? "/api/agent/resume" : "/api/agent/pause").then(draw, function () {}); });
    load(); setInterval(load, 5000);
  }
  function inBar(bar, box) {
    box.className = "ff-status";
    var dot = document.createElement("span"); dot.className = "ff-dot";
    var label = document.createElement("span"); label.textContent = "Farfield";
    var btn = document.createElement("button"); btn.type = "button";
    var sep = document.createElement("span"); sep.className = "ff-sep"; sep.setAttribute("aria-hidden", "true");
    var link = document.createElement("a"); link.href = "/panel.html"; link.textContent = "Panel";
    box.appendChild(dot); box.appendChild(label); box.appendChild(btn); box.appendChild(sep); box.appendChild(link);
    bar.insertBefore(box, bar.firstChild);
    var paused = false;
    function draw(s) {
      paused = !!s.paused;
      dot.style.background = paused ? "#E0A53A" : s.running ? "#5CC58A" : "#8A909C";
      label.textContent = paused ? "Paused" : s.running ? "Running" : "Not running";
      btn.textContent = paused ? "Resume" : "Pause";
    }
    function load() { fetch("/api/agent/status", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(draw, function () {}); }
    btn.addEventListener("click", function () { post(paused ? "/api/agent/resume" : "/api/agent/pause").then(draw, function () {}); });
    load(); setInterval(load, 5000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", pill); else pill();
})();
