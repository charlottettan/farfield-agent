/* Farfield look for the desktop app: the few presentation touches that styles alone cannot do.
 * Loaded only by the desktop app (the server adds it to dashboard.html), next to farfield-look.css.
 * It only rearranges what the dashboard already shows; it never changes any number or what is stored.
 *
 *  - The Overview headline becomes one line with its key figure in italics; the rest moves to a quiet line underneath.
 *  - Figures get their unit set smaller ("6.1 h" -> 6.1 h, with "h" small), "$19k" becomes "$19K", and word values
 *    ("Reached") are set smaller than numbers.
 *  - Up / down changes get a small arrow instead of a sign ("-60%" -> arrow 60%).
 *  - The Light / Dark switch moves from the main navigation into Data and settings.
 */
(function () {
  "use strict";
  var MARK = "ffDone";

  // every headline sentence on any tab (not the bold titles inside fix-queue items, which share the class)
  function splitHeadlines() {
    document.querySelectorAll(".tabpanel p.headline").forEach(function (h, i) {
      if (h.closest(".queue-item")) return;
      splitHeadline(h, i);
    });
  }
  function splitHeadline(h, i) {
    if (!h || !h.textContent.trim() || h.dataset[MARK] === h.textContent) return;
    var text = h.textContent.trim();
    var cut = text.search(/\.\s+(?=[A-Z0-9])/);                         // the end of the first sentence
    var first = cut > 0 ? text.slice(0, cut + 1) : text, rest = cut > 0 ? text.slice(cut + 2).trim() : "";
    h.textContent = "";
    var m = /\d[\d.,]*(?:%|\s?(?:h|hours?)\b)/.exec(first);           // the key figure, set in italics
    if (m) {
      h.appendChild(document.createTextNode(first.slice(0, m.index)));
      var em = document.createElement("em"); em.textContent = m[0]; h.appendChild(em);
      h.appendChild(document.createTextNode(first.slice(m.index + m[0].length)));
    } else h.textContent = first;
    h.dataset[MARK] = h.textContent;
    var more = h.nextElementSibling && h.nextElementSibling.classList.contains("ff-headline-more") ? h.nextElementSibling : null;
    if (!more) { more = document.createElement("p"); more.className = "ff-headline-more"; h.insertAdjacentElement("afterend", more); }
    more.textContent = rest;
    more.hidden = !rest;
  }

  // big figures elsewhere (Fixes, Implementation): thousands separators ("1350" -> "1,350")
  function separators() {
    document.querySelectorAll(".stat-value, .pstep .big, .kpi b").forEach(function (v) {
      if (v.children.length) return;
      var t = v.textContent.trim();
      if (/^\d{4,}$/.test(t)) v.textContent = Number(t).toLocaleString("en-US");
    });
  }

  function figures() {
    document.querySelectorAll(".figures .val").forEach(function (v) {
      if (v.dataset[MARK] === v.textContent) return;
      var t = v.textContent.trim(), m;
      v.classList.remove("ff-word");
      if ((m = /^(-?[\d.,]+)\s?(h|hours|%)$/.exec(t))) {
        v.textContent = m[1];
        var u = document.createElement("span"); u.className = "ff-unit" + (m[2] === "%" ? " ff-pct" : ""); u.textContent = m[2] === "%" ? "%" : "h"; v.appendChild(u);
      } else if ((m = /^\$([\d.,]+)([kmb])$/i.exec(t))) v.textContent = "$" + m[1] + m[2].toUpperCase();
      else if (!/\d/.test(t)) v.classList.add("ff-word");
      v.dataset[MARK] = v.textContent;
    });
  }

  function arrows(root) {
    (root || document).querySelectorAll(".down, .up").forEach(function (n) {
      if (n.dataset[MARK] === n.textContent || n.children.length) return;
      var t = n.textContent.trim(), m = /^([−+\-])\s?(.*)$/.exec(t);
      if (!m) return;
      n.textContent = "";
      var a = document.createElement("span"); a.className = "ff-arrow"; a.setAttribute("aria-hidden", "true");
      a.textContent = m[1] === "+" ? "▲" : "▼";
      n.appendChild(a);
      n.appendChild(document.createTextNode(m[2]));
      n.setAttribute("aria-label", (m[1] === "+" ? "up " : "down ") + m[2]);
      n.dataset[MARK] = n.textContent;
    });
  }

  function moveThemeSwitch() {
    var seg = document.querySelector('.top-controls .seg[aria-label="Theme"]'), data = document.getElementById("tab-data");
    if (!seg || !data) return;
    var row = document.createElement("div"); row.className = "ff-appearance";
    var lab = document.createElement("span"); lab.textContent = "Appearance";
    row.appendChild(lab); row.appendChild(seg);
    data.insertBefore(row, data.firstChild);
  }

  var queued = false;
  function polish() {
    queued = false;
    try { splitHeadlines(); figures(); separators(); arrows(); } catch (e) { if (window.console) console.error("farfield look", e); }
  }
  function soon() { if (!queued) { queued = true; requestAnimationFrame(polish); } }

  function start() {
    try { moveThemeSwitch(); } catch (e) { if (window.console) console.error("farfield look", e); }
    polish();
    new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
