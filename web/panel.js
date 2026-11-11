// The employee panel. Everything shown that comes from files or the server goes through textContent, never innerHTML,
// so a file called "<img onerror=...>.xlsx" is just text.
(function () {
  "use strict";
  var H = { "content-type": "application/json", "x-farfield": "1" };
  function post(path, body) {
    return fetch(path, { method: "POST", headers: H, body: JSON.stringify(body || {}), credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : "Something went wrong."); return j; }); });
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var state = null;
  var preview = null;

  function mode(m) {
    if (m === "full") return "Full. The wording of what you changed is sent to your company.";
    if (m === "redacted") return "Redacted. Names, numbers and emails are masked on your computer before anything is sent.";
    if (m === "themes") return "Themes only. No wording is sent, only categories, counts and timing.";
    return "";
  }

  function draw(s) {
    state = s;
    $("dot").className = "dot " + (s.paused ? "paused" : s.running ? "on" : "");
    $("stateText").textContent = s.paused ? "Paused. Nothing is being read or sent." : s.running ? "Running" : "Not running";
    $("pauseBtn").textContent = s.paused ? "Resume" : "Pause";

    var f = $("folders"); clear(f);
    if (!s.folders.length) f.appendChild(el("p", "No folders yet. Farfield reads nothing until you add one.", "muted"));
    s.folders.forEach(function (dir) {
      var row = el("div", null, "folder");
      row.appendChild(el("span", dir));
      var b = el("button", "Remove"); b.type = "button";
      b.addEventListener("click", function () { post("/api/agent/folders", { action: "remove", path: dir }).then(draw, showFolderErr); });
      row.appendChild(b); f.appendChild(row);
    });

    var rec = s.recorded || { count: 0, latest: [] };
    $("foundText").textContent = rec.count
      ? rec.count + (rec.count === 1 ? " correction recorded from files." : " corrections recorded from files.") + " Only file names and counts are shown here."
      : "Nothing yet. When a new Excel, Word or PowerPoint file shows up in a watched folder and you save changes to it, it will appear here.";
    var ul = $("latest"); clear(ul);
    rec.latest.forEach(function (r) {
      ul.appendChild(el("li", r.file + " (" + r.surface + "): " + r.changedCells + " changed" + (r.changedCells === 1 ? " item" : " items")));
    });

    drawCompany(s);
    var co = s.company || {};
    $("collectText").textContent = co.joined
      ? "Privacy mode for " + co.org.name + ": " + mode(co.policy.privacyMode)
      : "You have not joined a company, so nothing leaves this computer.";
  }

  function drawCompany(s) {
    var v = $("companyView"); clear(v);
    var co = s.company || {};
    if (co.joined) {
      v.appendChild(el("p", "Joined " + co.org.name + " as " + co.user.role + "."));
      v.appendChild(el("p", s.pending ? s.pending + " records waiting to be sent." : "Everything has been sent.", "muted"));
      if (co.lastError) v.appendChild(el("p", "Last problem: " + co.lastError, "err"));
      var row = el("div", null, "row");
      var lv = el("button", "Leave"); lv.type = "button";
      var del = el("label", null); var cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "delData"; del.appendChild(cb); del.appendChild(document.createTextNode(" Also delete what was sent to the company"));
      lv.addEventListener("click", function () { post("/api/agent/leave", { deleteData: cb.checked }).then(draw, function (e) { v.appendChild(el("p", e.message, "err")); }); });
      row.appendChild(lv); v.appendChild(row); v.appendChild(del);
      return;
    }
    v.appendChild(el("p", "Not joined. This is optional. Without joining, everything stays on this computer.", "muted"));
    var server = document.createElement("input"); server.type = "text"; server.id = "jServer"; server.placeholder = "https://farfield.yourcompany.com";
    var code = document.createElement("input"); code.type = "text"; code.id = "jCode";
    var email = document.createElement("input"); email.type = "email"; email.id = "jEmail";
    [["Server address", server], ["Invite code", code], ["Work email", email]].forEach(function (p) { var l = el("label", p[0]); l.appendChild(p[1]); v.appendChild(l); });
    var msg = el("p", "", "err"); msg.setAttribute("role", "alert");
    var out = el("div");
    var check = el("button", "Review what is collected"); check.type = "button";
    check.addEventListener("click", function () {
      msg.textContent = ""; clear(out);
      post("/api/agent/join-preview", { server: server.value.trim(), code: code.value.trim() }).then(function (p) {
        preview = p;
        out.appendChild(el("p", "Joining " + (p.org && p.org.name) + " as " + p.role + "."));
        out.appendChild(el("p", mode(p.privacyMode)));
        out.appendChild(el("p", "Farfield reads only Excel, Word and PowerPoint files in your chosen folders. It does not read your screen, record keystrokes, or take screenshots.", "muted"));
        var l = el("label"); var cb = document.createElement("input"); cb.type = "checkbox"; l.appendChild(cb); l.appendChild(document.createTextNode(" I understand and agree"));
        var go = el("button", "Join"); go.type = "button"; go.className = "primary"; go.disabled = true;
        cb.addEventListener("change", function () { go.disabled = !cb.checked; });
        go.addEventListener("click", function () {
          post("/api/agent/join", { server: server.value.trim(), code: code.value.trim(), email: email.value.trim(), consent: true }).then(draw, function (e) { msg.textContent = e.message; });
        });
        out.appendChild(l); out.appendChild(go);
      }, function (e) { msg.textContent = e.message; });
    });
    v.appendChild(check); v.appendChild(msg); v.appendChild(out);
  }

  function showFolderErr(e) { $("folderMsg").textContent = e.message; }
  function load() { return fetch("/api/agent/status", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(draw); }

  $("pauseBtn").addEventListener("click", function () { post(state && state.paused ? "/api/agent/resume" : "/api/agent/pause").then(draw); });
  $("addFolder").addEventListener("click", function () {
    $("folderMsg").textContent = "";
    var v = $("folderInput").value.trim();
    if (!v) return;
    post("/api/agent/folders", { action: "add", path: v }).then(function (s) { $("folderInput").value = ""; draw(s); }, showFolderErr);
  });
  $("scanBtn").addEventListener("click", function () {
    $("scanMsg").textContent = "Checking…";
    post("/api/agent/scan").then(function (r) { $("scanMsg").textContent = "Done."; draw(r.status); }, function (e) { $("scanMsg").textContent = e.message; });
  });
  load(); setInterval(load, 5000);
})();
