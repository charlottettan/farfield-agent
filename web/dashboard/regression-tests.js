/*
 * Turns captured corrections into an automatic test suite, and backtests it.
 *
 *  1. Capture:  a person fixed an AI draft (we have the AI's text and the corrected text).
 *  2. Fix:      work out what changed and propose an instruction that would have prevented it.
 *  3. Test:     turn the change into a check that FAILS on the AI's version and PASSES on the corrected one.
 *
 * Backtest: tests are written from the earliest corrections in each group and then run against the LATER
 * corrections. A test "would have caught" a later problem if it fails on the AI's version and passes on the
 * person's corrected version. Numbers cannot be checked without a data source, and the backtest says so.
 *
 * This replays captured before/after text. It does not re-run the AI agent.
 */
(function (root) {
  "use strict";
  var A = root.FarfieldAnalysis || (typeof require !== "undefined" ? require("./analysis.js") : null);
  var C = A.CATEGORIES;

  var STOP = { a: 1, an: 1, the: 1, and: 1, or: 1, versus: 1, of: 1, to: 1, in: 1, on: 1, at: 1, for: 1, with: 1, by: 1, is: 1, are: 1, was: 1, were: 1, be: 1, it: 1, this: 1, that: 1, as: 1, from: 1, our: 1, your: 1, their: 1, but: 1 };
  var TONE_WORDS = ["extremely", "massive", "fantastic", "blowout", "amazing", "awesome", "huge", "super", "incredible", "bullish", "bearish", "stunning", "terrific"];
  var TONE_PAIRS = ["circle back", "just wanted", "so much", "touch base", "reach out"];
  var TIME_ZONES = { ET: 1, AM: 1, PM: 1, EST: 1, EDT: 1, UTC: 1, GMT: 1, USD: 1 };

  // ------------------------------------------------------------------ words and diff
  function strip(t) { return t.replace(/^[("'\u201c\u2018\[]+|[)"'\u201d\u2019\].,;:]+$/g, ""); }
  function tokens(s) {
    return String(s || "").replace(/([!?]{1,})/g, " $1 ").split(/\s+/).filter(Boolean).map(function (raw) { var n = strip(raw); return { raw: raw, norm: n.toLowerCase() }; }).filter(function (t) { return t.norm; });
  }
  function diffBlocks(a, b) {
    var x = tokens(a), y = tokens(b), n = x.length, m = y.length, i, j;
    var T = [];
    for (i = 0; i <= n; i++) T.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) T[i][j] = x[i].norm === y[j].norm ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    var blocks = [], cur = null;
    i = 0; j = 0;
    function flush() { if (cur) { blocks.push(cur); cur = null; } }
    while (i < n || j < m) {
      if (i < n && j < m && x[i].norm === y[j].norm) { flush(); i++; j++; continue; }
      if (!cur) cur = { del: [], add: [] };
      if (j >= m || (i < n && T[i + 1][j] >= T[i][j + 1])) cur.del.push(x[i++]); else cur.add.push(y[j++]);
    }
    flush();
    return blocks;
  }
  function trimStops(list) {
    var a = 0, b = list.length;
    while (a < b && STOP[list[a].norm] && !/[!?]/.test(list[a].raw)) a++;
    while (b > a && STOP[list[b - 1].norm]) b--;
    return list.slice(a, b);
  }
  function pw(t) { return t.raw.replace(/^[("'\u201c\u2018\[]+|[)"'\u201d\u2019\].,;]+$/g, ""); }
  function hasNum(t) { return /\d/.test(t.norm); }
  function uniq(arr) { var o = []; arr.forEach(function (v) { if (o.indexOf(v) === -1) o.push(v); }); return o; }

  // ------------------------------------------------------------------ matching
  function normText(s) { return " " + String(s || "").toLowerCase().replace(/[()\[\]"\u201c\u201d\u2018\u2019;:]/g, " ").replace(/[.,!?]+(?=\s|$)/g, "").replace(/\s+/g, " ").trim() + " "; }
  function has(text, phrase) {
    if (phrase === "!!") return /!!/.test(text);
    if (phrase === "!") return /!/.test(text);
    var p = normText(phrase).trim();
    return p.length > 0 && normText(text).indexOf(" " + p + " ") !== -1;
  }

  // ------------------------------------------------------------------ making tests from one correction
  function sentenceCut(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) { out.push(list[i]); if (/[.!?;]$/.test(list[i].raw)) break; }
    return out;
  }
  function requiredPhrases(add) {
    var acr = uniq(add.map(function (t) { return strip(t.raw); }).filter(function (w) { return /^[A-Z][A-Z0-9]{1,}$/.test(w) && !TIME_ZONES[w]; }));
    if (acr.length) return acr.slice(0, 3);
    var run = sentenceCut(add), k = run.findIndex(hasNum);
    if (k >= 2) run = run.slice(0, k);
    run = trimStops(run).slice(0, 6);
    var p = run.map(pw).join(" ");
    return p.length >= 4 ? [p] : [];
  }
  function toneForbidden(del) {
    var words = del.map(function (t) { return t.norm; }), found = [];
    del.forEach(function (t) { if (/^!+$/.test(t.raw)) found.push("!!"); });
    TONE_PAIRS.forEach(function (p) { if (words.join(" ").indexOf(p) !== -1) found.push(p); });
    words.forEach(function (w) { if (TONE_WORDS.indexOf(w) !== -1 && !found.some(function (f) { return f.indexOf(w) !== -1; })) found.push(w); });
    return uniq(found);
  }

  function testsFromCorrection(c) {
    var blocks = diffBlocks(c.originalSnippet, c.editedSnippet), out = [];
    if (!blocks.length) return out;
    if (c.category === C.FACTUAL) {
      var wrong = [], right = [];
      blocks.forEach(function (b) { b.del.filter(hasNum).forEach(function (t) { wrong.push(strip(t.raw)); }); b.add.filter(hasNum).forEach(function (t) { right.push(strip(t.raw)); }); });
      if (wrong.length) return [{ kind: "data", wrong: uniq(wrong), right: uniq(right) }];
    }
    if (c.category === C.TONE) {
      var allDel = [];
      blocks.forEach(function (b) { allDel = allDel.concat(b.del); });
      var f = toneForbidden(allDel);
      if (f.length) return [{ kind: "forbidden", phrases: f }];
    }
    blocks.forEach(function (b) {
      var del = trimStops(b.del), add = trimStops(b.add);
      if (del.length && add.length && del.length <= 4 && add.length <= 3 * del.length + 2) {
        out.push({ kind: "replace", old: del.map(pw).join(" "), neu: add.map(pw).join(" ") });
      } else if (add.length) {
        var req = requiredPhrases(add);
        if (req.length) out.push({ kind: "required", phrases: req });
      } else if (del.length) {
        out.push({ kind: "forbidden", phrases: [del.slice(0, 4).map(pw).join(" ")] });
      }
    });
    return out;
  }

  // ------------------------------------------------------------------ running a test
  function evalTest(t, text) {
    if (t.kind === "data") return { pass: !t.wrong.some(function (w) { return has(text, w); }) };
    if (t.kind === "forbidden") return { pass: !t.phrases.some(function (p) { return has(text, p); }) };
    if (t.kind === "required") return { pass: t.phrases.some(function (p) { return has(text, p); }) };
    if (t.kind === "replace") return { pass: !has(text, t.old) && has(text, t.neu) };
    return { pass: true };
  }
  function keyOf(t) { return [t.kind, (t.phrases || []).join("|"), t.old || "", t.neu || "", (t.wrong || []).join("|")].join("~").toLowerCase(); }
  function describe(t) {
    if (t.kind === "replace") return "Output must say \u201c" + t.neu + "\u201d, not \u201c" + t.old + "\u201d.";
    if (t.kind === "required") return "Output must include " + t.phrases.map(function (p) { return "\u201c" + p + "\u201d"; }).join(" or ") + ".";
    if (t.kind === "forbidden") return "Output must not contain " + t.phrases.map(function (p) { return "\u201c" + p + "\u201d"; }).join(", ") + ".";
    return "Figures must match the source data. Seen wrong: " + t.wrong.slice(0, 3).map(function (w) { return "\u201c" + w + "\u201d"; }).join(", ") + ".";
  }
  function fixText(tests) {
    var lines = [];
    tests.forEach(function (t) {
      if (t.kind === "replace") lines.push("Write \u201c" + t.neu + "\u201d instead of \u201c" + t.old + "\u201d.");
      else if (t.kind === "required") lines.push("Always include " + t.phrases.map(function (p) { return "\u201c" + p + "\u201d"; }).join(" or ") + " where it applies.");
      else if (t.kind === "forbidden") lines.push("Never write " + t.phrases.map(function (p) { return "\u201c" + p + "\u201d"; }).join(", ") + ".");
      else lines.push("Pull figures from the source data instead of writing them from memory. This needs an engineering ticket to connect the source.");
    });
    return uniq(lines).join(" ");
  }

  // ------------------------------------------------------------------ the suite and its backtest
  // opts: { trainShare (default 0.3), minTrain (2), minGroup (4), settings }
  function backtest(corrections, opts) {
    opts = opts || {};
    var share = opts.trainShare || 0.3, minTrain = opts.minTrain || 2, minGroup = opts.minGroup || 4, settings = opts.settings || {};
    var by = {};
    (corrections || []).forEach(function (c) { if (c && c.originalSnippet && c.editedSnippet) { var k = c.agent + "\u0001" + c.category; (by[k] = by[k] || []).push(c); } });
    var groups = [];
    Object.keys(by).forEach(function (k) {
      var list = by[k].slice().sort(function (a, b) { return a.timestamp - b.timestamp; });
      if (list.length < minGroup) return;
      var trainN = Math.max(minTrain, Math.ceil(list.length * share)), train = list.slice(0, trainN), hold = list.slice(trainN);
      var seen = {}, tests = [];
      train.forEach(function (c) {
        testsFromCorrection(c).forEach(function (t) {
          var key = keyOf(t);
          if (!seen[key]) { seen[key] = t; t.key = key; t.support = 0; t.agent = c.agent; t.category = c.category; tests.push(t); }
          seen[key].support++;
        });
      });
      // Pinned wrong numbers: one test per group (the examples seen so far), since a new wrong number never matches an old one.
      var dataTests = tests.filter(function (t) { return t.kind === "data"; });
      if (dataTests.length > 1) {
        var merged = { kind: "data", wrong: [], right: [], support: 0, agent: list[0].agent, category: list[0].category };
        dataTests.forEach(function (t) { t.wrong.forEach(function (w) { if (merged.wrong.indexOf(w) === -1 && merged.wrong.length < 6) merged.wrong.push(w); }); t.right.forEach(function (w) { if (merged.right.indexOf(w) === -1 && merged.right.length < 6) merged.right.push(w); }); merged.support += t.support; });
        merged.key = keyOf(merged);
        tests = tests.filter(function (t) { return t.kind !== "data"; }).concat([merged]);
      }
      if (!tests.length) return;
      var caught = 0, missed = 0, falseAlarms = 0, minutes = 0, example = null;
      hold.forEach(function (c) {
        var flagged = tests.some(function (t) { return !evalTest(t, c.originalSnippet).pass; });
        var clean = tests.every(function (t) { return evalTest(t, c.editedSnippet).pass; });
        if (!clean) falseAlarms++;
        else if (flagged) { caught++; minutes += c.estimatedMinutes || 0; if (!example) example = c; }
        else missed++;
      });
      var needsData = tests.every(function (t) { return t.kind === "data"; });
      var recall = hold.length ? caught / hold.length : 0;
      var status = needsData && recall < 0.5 ? "data" : falseAlarms / Math.max(hold.length, 1) > 0.1 ? "review" : recall >= 0.8 ? "ready" : recall >= 0.4 ? "partial" : "weak";
      var team = A.teamOf(list[0], settings);
      groups.push({
        id: k.replace(/\W+/g, "_"), agent: list[0].agent, team: team, category: list[0].category, total: list.length, trainCount: train.length, heldOut: hold.length,
        tests: tests, caught: caught, missed: missed, falseAlarms: falseAlarms, recall: recall, minutesPrevented: minutes, status: status, needsData: needsData,
        fix: fixText(tests), example: example ? { original: example.originalSnippet, edited: example.editedSnippet } : { original: train[0].originalSnippet, edited: train[0].editedSnippet },
        heldOutIds: hold.map(function (c) { return c.id; }),
      });
    });
    groups.sort(function (a, b) { return b.minutesPrevented - a.minutesPrevented || b.heldOut - a.heldOut; });
    var held = groups.reduce(function (n, g) { return n + g.heldOut; }, 0), caughtAll = groups.reduce(function (n, g) { return n + g.caught; }, 0);
    return {
      groups: groups, summary: {
        groups: groups.length, tests: groups.reduce(function (n, g) { return n + g.tests.length; }, 0), heldOut: held, caught: caughtAll, coverage: held ? caughtAll / held : 0,
        minutesPrevented: groups.reduce(function (n, g) { return n + g.minutesPrevented; }, 0), falseAlarms: groups.reduce(function (n, g) { return n + g.falseAlarms; }, 0),
        ready: groups.filter(function (g) { return g.status === "ready"; }).length, needData: groups.filter(function (g) { return g.status === "data"; }).length,
      },
    };
  }

  // Simulate a release check for one sub-agent.
  //   "good":  candidate outputs are what people ended up sending (the corrected versions)
  //   "risky": candidate outputs reintroduce the old problems (the AI's original versions)
  function simulateRelease(bt, corrections, agent, mode) {
    var byId = {}; (corrections || []).forEach(function (c) { byId[c.id] = c; });
    var results = [], candidates = 0, flaggedCandidates = 0;
    bt.groups.filter(function (g) { return g.agent === agent; }).forEach(function (g) {
      var failures = 0;
      g.heldOutIds.forEach(function (id) {
        var c = byId[id]; if (!c) return;
        var text = mode === "risky" ? c.originalSnippet : c.editedSnippet;
        var bad = g.tests.some(function (t) { return !evalTest(t, text).pass; });
        candidates++; if (bad) { failures++; flaggedCandidates++; }
      });
      results.push({ group: g, candidates: g.heldOutIds.length, failures: failures, enforced: g.status === "ready" || g.status === "partial" });
    });
    var enforcedFailures = results.filter(function (r) { return r.enforced && r.failures > 0; });
    return { agent: agent, mode: mode, results: results, candidates: candidates, flagged: flaggedCandidates, blocked: enforcedFailures.length > 0, failingTests: enforcedFailures.reduce(function (n, r) { return n + r.group.tests.length; }, 0), regressions: enforcedFailures.reduce(function (n, r) { return n + r.failures; }, 0) };
  }

  var api = { testsFromCorrection: testsFromCorrection, evalTest: evalTest, describe: describe, fixText: fixText, backtest: backtest, simulateRelease: simulateRelease, diffBlocks: diffBlocks };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldTests = api;
})(typeof self !== "undefined" ? self : globalThis);
