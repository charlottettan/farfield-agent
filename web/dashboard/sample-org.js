/*
 * Sample organization for demos: three teams, two sub-agents each, 13 weeks of AI drafts and the corrections people made.
 * Corrections decline as fixes roll out. Everything it makes is marked source "seed" (sample data).
 * Deterministic, so the same numbers appear every time.
 */
(function (root) {
  "use strict";
  var A = root.FarfieldAnalysis || (typeof require !== "undefined" ? require("./analysis.js") : null);
  var C = A.CATEGORIES;
  var WEEKS = 13;
  var DAY = 86400000;

  var TEAMS = { "Research": ["Market Summary Agent", "Earnings Note Agent"], "Compliance": ["Disclosure Drafter", "Policy Checker"], "Client Service": ["Client Update Agent", "Deck Builder"] };
  var LEGACY = {}; // (the hand-written two-week sample simply adds a little on top of the last two weeks)

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function money(n) { return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function between(r, lo, hi) { return lo + r() * (hi - lo); }

  var P = [
    { id: 1, agent: "Market Summary Agent", cat: C.FACTUAL, rate: 0.20, min: [4, 8], make: function (r) { var a = between(r, 5100, 5700), b = a + between(r, 3, 40) * (r() < 0.5 ? -1 : 1), pa = between(r, 0.1, 1.4), pb = pa + between(r, 0.1, 0.5); return { orig: "The S&P 500 closed at " + money(a) + ", up " + pa.toFixed(1) + "% on the day.", edit: "The S&P 500 closed at " + money(b) + ", up " + pb.toFixed(1) + "% on the day." }; } },
    { id: 2, agent: "Market Summary Agent", cat: C.CONTENT, rate: 0.16, min: [6, 11], make: function () { return { orig: "Treasuries were little changed ahead of fresh data.", edit: "Treasuries were little changed ahead of the 8:30 a.m. ET CPI release and the 2:00 p.m. ET FOMC minutes." }; } },
    { id: 3, agent: "Market Summary Agent", cat: C.TERM, rate: 0.12, min: [2, 5], make: function () { return { orig: "Spreads on junk bonds widened 12 bps.", edit: "Spreads on high-yield credit (CDX HY) widened 12 bps.", tAdded: ["high-yield", "CDX"], tRemoved: ["junk", "bonds"] }; } },
    { id: 4, agent: "Market Summary Agent", cat: C.TONE, rate: 0.12, min: [3, 6], make: function () { return { orig: "We are extremely bullish and expect a massive rally.", edit: "We see upside and expect further gains." }; } },
    { id: 5, agent: "Earnings Note Agent", cat: C.FACTUAL, rate: 0.18, min: [4, 9], make: function (r) { var x = between(r, 1.5, 3.5), y = x + between(r, 0.1, 0.4), c = x - between(r, 0.05, 0.2); return { orig: "EPS of $" + x.toFixed(2) + " beat consensus of $" + c.toFixed(2) + ".", edit: "EPS of $" + y.toFixed(2) + " beat consensus of $" + c.toFixed(2) + "." }; } },
    { id: 6, agent: "Earnings Note Agent", cat: C.CONTENT, rate: 0.15, min: [6, 12], make: function () { return { orig: "Revenue rose 8% year over year.", edit: "Revenue rose 8% year over year, and management guided full-year growth to 6-7%." }; } },
    { id: 7, agent: "Earnings Note Agent", cat: C.TONE, rate: 0.10, min: [3, 6], make: function () { return { orig: "A fantastic, blowout quarter for the company.", edit: "A solid quarter for the company." }; } },
    { id: 8, agent: "Disclosure Drafter", cat: C.CONTENT, rate: 0.30, min: [5, 9], make: function () { return { orig: "This summary is for information only.", edit: "This summary is for information only and does not constitute investment advice. Past performance is not indicative of future results." }; } },
    { id: 9, agent: "Disclosure Drafter", cat: C.TERM, rate: 0.18, min: [2, 4], make: function () { return { orig: "Our customers have been notified of the change.", edit: "Our clients have been notified of the change.", tAdded: ["clients"], tRemoved: ["customers"] }; } },
    { id: 10, agent: "Policy Checker", cat: C.CONTENT, rate: 0.10, min: [3, 6], make: function () { return { orig: "Highlights include Acme Corp and Globex.", edit: "Highlights include Globex.", tRemoved: ["Acme", "Corp"] }; } },
    { id: 11, agent: "Policy Checker", cat: C.FACTUAL, rate: 0.18, min: [4, 8], make: function (r) { var a = (4 + Math.floor(r() * 3)) + "." + Math.floor(r() * 9), b = (4 + Math.floor(r() * 3)) + "." + (Math.floor(r() * 9) + 0); if (a === b) b = a + "1"; return { orig: "Policy " + a + " requires annual review of limits.", edit: "Policy " + b + " requires annual review of limits." }; } },
    { id: 12, agent: "Policy Checker", cat: C.TERM, rate: 0.14, min: [2, 5], make: function () { return { orig: "KYC must be redone yearly for all accounts.", edit: "KYC must follow the periodic review schedule for all accounts.", tAdded: ["periodic", "review"], tRemoved: ["redone", "yearly"] }; } },
    { id: 13, agent: "Client Update Agent", cat: C.TONE, rate: 0.28, min: [2, 4], make: function () { return { orig: "Hi Dana, just wanted to circle back!! Thanks so much!!", edit: "Hi Dana, following up on your request. Thank you." }; } },
    { id: 14, agent: "Client Update Agent", cat: C.CONTENT, rate: 0.12, min: [3, 6], make: function () { return { orig: "The portfolio returned 3.1% this quarter.", edit: "The portfolio returned 3.1% this quarter, net of fees, versus 2.8% for the benchmark." }; } },
    { id: 15, agent: "Deck Builder", cat: C.TERM, rate: 0.20, min: [2, 4], make: function () { return { orig: "Benchmark: the index.", edit: "Benchmark: MSCI World Index (net).", tAdded: ["MSCI", "World"], tRemoved: [] }; } },
    { id: 16, agent: "Deck Builder", cat: C.CONTENT, rate: 0.18, min: [3, 6], make: function () { return { orig: "Performance chart, Q3.", edit: "Performance chart, Q3. Source: internal performance system; returns net of fees." }; } },
    { id: 17, agent: "Deck Builder", cat: C.FACTUAL, rate: 0.12, min: [3, 6], make: function (r) { var x = Math.round(between(r, 400, 3000)); return { orig: "AUM $" + x.toLocaleString("en-US") + " thousand.", edit: "AUM $" + x.toLocaleString("en-US") + " million." }; } },
  ];

  // fixes that were rolled out, by week number (0 is the oldest of the 13 weeks); `covers` are the pattern ids they stop
  var FIXES = [
    { week: 3, agent: "Disclosure Drafter", cat: C.CONTENT, covers: [8], text: "End every client-facing summary with: \"This summary is for information only and does not constitute investment advice. Past performance is not indicative of future results.\"" },
    { week: 6, agent: "Client Update Agent", cat: C.TONE, covers: [13], text: "Write client emails in a calm, professional tone: no exclamation marks, and never \"circle back\" or \"just wanted to\". Use \"following up\" and \"thank you\"." },
    { week: 7, agent: "Earnings Note Agent", cat: C.CONTENT, covers: [6], text: "Include management's full-year guidance, with the guided range, in every earnings note." },
    { week: 8, agent: "Disclosure Drafter", cat: C.TERM, covers: [9], text: "Say \"clients\", never \"customers\"." },
    { week: 8, agent: "Policy Checker", cat: C.CONTENT, covers: [10], text: "Never mention names on the restricted list. Check the restricted-list file before drafting." },
    { week: 9, agent: "Deck Builder", cat: C.TERM, covers: [15], text: "Name the benchmark from the client's mandate, for example \"MSCI World Index (net)\", instead of \"the index\"." },
    { week: 9, agent: "Deck Builder", cat: C.CONTENT, covers: [16], text: "Add a source line under every chart: the source system, and whether returns are net of fees." },
    { week: 9, agent: "Market Summary Agent", cat: C.FACTUAL, covers: [1], text: "Pull every figure from the approved market-data feed instead of writing numbers from memory. Routed to engineering: connect the feed." },
    { week: 9, agent: "Earnings Note Agent", cat: C.FACTUAL, covers: [5], text: "Pull EPS and consensus from the approved data feed instead of writing numbers from memory. Routed to engineering: connect the feed." },
    { week: 9, agent: "Policy Checker", cat: C.FACTUAL, covers: [11], text: "Look up policy numbers in the policy library instead of recalling them. Routed to engineering: connect the library." },
    { week: 9, agent: "Deck Builder", cat: C.FACTUAL, covers: [17], text: "Read units from the data source's metadata. Routed to engineering: expose units in the feed." },
    { week: 10, agent: "Market Summary Agent", cat: C.TERM, covers: [3], text: "Spell out credit shorthand: write \"high-yield credit (CDX HY)\", not \"junk bonds\" or \"HY\"." },
    { week: 10, agent: "Market Summary Agent", cat: C.TONE, covers: [4], text: "Describe market moves in neutral language. Avoid \"massive\", \"extremely\" and similar intensifiers." },
  ];

  function addDays(ts, n) { var d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
  function words(s) { return String(s).split(/\s+/).filter(Boolean); }

  function generateOrg(now) {
    now = now || Date.now();
    var r = rng(20261101), monday = A.weekStart(now), starts = [];
    for (var i = 0; i < WEEKS; i++) starts.push(addDays(monday, -7 * (WEEKS - 1 - i)));
    var factor = function (pid, week) {
      var f = 1;
      FIXES.forEach(function (fx) {
        if (fx.covers.indexOf(pid) === -1) return;
        if (week === fx.week + 1) f *= 0.35; else if (week >= fx.week + 2) f *= 0.15;
      });
      return f;
    };
    var cutoffLegacy = now - 14 * DAY, corrections = [], sends = [], k = 0;
    Object.keys(TEAMS).forEach(function (team) {
      TEAMS[team].forEach(function (agent) {
        var mine = P.filter(function (p) { return p.agent === agent; });
        var volume = team === "Compliance" ? 62 : team === "Research" ? 52 : 46;
        for (var w = 0; w < WEEKS; w++) {
          var n = Math.round(volume - 5 + r() * 10);
          for (var j = 0; j < n; j++) {
            var ts = addDays(starts[w], Math.floor(r() * 5)) + (9 + Math.floor(r() * 9)) * 3600000 + Math.floor(r() * 60) * 60000;
            if (ts > now - 3600000) continue;
            if (LEGACY[agent] && ts > cutoffLegacy) continue;
            var fired = null;
            for (var q = 0; q < mine.length && !fired; q++) if (r() < mine[q].rate * factor(mine[q].id, w)) fired = mine[q];
            if (!fired) { sends.push({ t: ts, agent: agent, category: null }); continue; }
            var m = fired.make(r), minutes = fired.min[0] + Math.floor(r() * (fired.min[1] - fired.min[0] + 1));
            var ow = words(m.orig), ew = words(m.edit);
            corrections.push({
              id: "org_c_" + (++k), timestamp: ts, agent: agent, category: fired.cat, subject: "Client summary", originalSnippet: m.orig, editedSnippet: m.edit,
              wordsAdded: ew.filter(function (x) { return ow.indexOf(x) === -1; }).length, wordsRemoved: ow.filter(function (x) { return ew.indexOf(x) === -1; }).length,
              estimatedMinutes: minutes, activeSeconds: Math.round(minutes * 60 * (0.5 + r() * 0.3)), timeSource: "seed",
              termsAdded: m.tAdded || [], termsRemoved: m.tRemoved || [], source: "seed", surface: "Gmail", team: team,
            });
            sends.push({ t: ts, agent: agent, category: fired.cat });
          }
        }
      });
    });
    var fixes = FIXES.map(function (fx, i) {
      return { id: "org_fix_" + (i + 1), agent: fx.agent, category: fx.cat, approvedAt: addDays(starts[fx.week], 3) + 17 * 3600000, version: 2, instruction: fx.text, source: "seed" };
    });
    var agentTeams = {};
    Object.keys(TEAMS).forEach(function (t) { TEAMS[t].forEach(function (a) { agentTeams[a] = t; }); });
    return { corrections: corrections, sends: sends, fixes: fixes, agentTeams: agentTeams, teams: TEAMS };
  }

  var api = { generateOrg: generateOrg, TEAMS: TEAMS, PATTERNS: P, FIXES: FIXES, WEEKS: WEEKS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldSample = api;
})(typeof self !== "undefined" ? self : globalThis);
