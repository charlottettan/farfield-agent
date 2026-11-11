// Light/dark theme for the popup and dashboard. Light is the default.
// The choice is mirrored in localStorage so the page paints in the right theme immediately,
// and saved in chrome.storage.local (settings.theme) so the Gmail and AI-chat widgets match.
(function () {
  "use strict";
  var KEY = "ff_theme";

  function apply(t) {
    document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
  }
  function remember(t) { try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ } }

  var start = "light";
  try { start = localStorage.getItem(KEY) || "light"; } catch (e) { /* ignore */ }
  apply(start);

  try {
    chrome.storage.local.get("settings").then(function (d) {
      var v = d.settings && d.settings.theme === "dark" ? "dark" : "light";
      apply(v); remember(v);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.settings) {
        var v = changes.settings.newValue && changes.settings.newValue.theme === "dark" ? "dark" : "light";
        apply(v); remember(v);
      }
    });
  } catch (e) { /* storage unavailable */ }

  window.FarfieldTheme = {
    current: function () { return document.documentElement.getAttribute("data-theme") || "light"; },
    set: function (t) {
      var v = t === "dark" ? "dark" : "light";
      apply(v); remember(v);
      return chrome.storage.local.get("settings").then(function (d) {
        var s = Object.assign({}, d.settings || {});
        s.theme = v;
        return chrome.storage.local.set({ settings: s });
      });
    },
  };
})();
