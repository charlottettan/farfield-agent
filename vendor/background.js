// Farfield Correction Tracker - background service worker.
// Seeds demo data on install and handles reset/clear requests.

importScripts("analysis.js", "sample-org.js", "sync.js");

const C = self.FarfieldAnalysis.CATEGORIES;
const MARKET = "Market Summary Agent";
const CLIENT = "Client Update Agent";

function at(daysAgo, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return Math.min(d.getTime(), Date.now());
}

function seedCorrections() {
  const subject = "Daily Market Summary";
  function row(id, agent, ts, category, orig, edit, added, removed, est, active, tAdded, tRemoved) {
    return {
      id: id, timestamp: ts, agent: agent, category: category, subject: agent === MARKET ? subject : "Client follow-up",
      originalSnippet: orig, editedSnippet: edit, wordsAdded: added, wordsRemoved: removed,
      estimatedMinutes: est, activeSeconds: active, timeSource: "seed",
      termsAdded: tAdded || [], termsRemoved: tRemoved || [], source: "seed", surface: "Gmail",
    };
  }
  return [
    row("seed_1", MARKET, at(13, 8, 50), C.FACTUAL,
      "…with the S&P 500 closing at 5,421.03 (+0.4%) and the Nasdaq Composite at 17,208.51.",
      "…with the S&P 500 closing at 5,432.60 (+0.6%) and the Nasdaq Composite at 17,243.18.", 3, 3, 6, 95),
    row("seed_2", MARKET, at(12, 9, 2), C.CONTENT,
      "Treasuries were little changed as traders waited for fresh inflation data.",
      "Treasuries were little changed as traders waited for fresh inflation data, with the 8:30 a.m. ET September CPI print due tomorrow and the 2:00 p.m. ET FOMC minutes later today.", 20, 0, 10, 150),
    row("seed_3", MARKET, at(11, 8, 44), C.CONTENT,
      "Energy shares rallied because the S&P 500 hit a record high, pushing crude prices up.",
      "Energy shares rallied as crude climbed 2.1% on reports of a surprise drawdown in U.S. inventories, which lifted the sector and helped the S&P 500 to a record high.", 19, 5, 11, 210),
    row("seed_4", MARKET, at(10, 9, 10), C.TERM,
      "Spreads on HY widened 12 bps after the Fed's comments.",
      "Spreads on high-yield credit (CDX HY) widened 12 bps after the Fed's comments.", 3, 0, 3, 60, ["CDX"], []),
    row("seed_5", MARKET, at(9, 8, 55), C.FACTUAL,
      "Gold rose to $2,318.40 an ounce while WTI crude settled at $78.12 a barrel.",
      "Gold rose to $2,341.70 an ounce while WTI crude settled at $81.45 a barrel.", 2, 2, 5, 80),
    row("seed_6", MARKET, at(8, 9, 20), C.CONTENT,
      "Futures point to a flat open ahead of a busy morning of earnings from the big banks.",
      "Futures point to a flat open ahead of a busy morning, with 8:30 a.m. ET initial jobless claims and the Philadelphia Fed manufacturing index, plus earnings from the big banks.", 14, 1, 8, 120),
    row("seed_7", MARKET, at(5, 8, 48), C.FACTUAL,
      "The 10-year Treasury yield settled at 4.31%, down 4 bps.",
      "The 10-year Treasury yield settled at 4.27%, down 8 bps.", 2, 2, 5, 70),
    row("seed_8", MARKET, at(4, 9, 5), C.TONE,
      "We are extremely bullish on the energy complex and expect a massive rally.",
      "We see upside in the energy complex and expect further gains.", 5, 7, 4, 55),
    row("seed_9", MARKET, at(3, 8, 40), C.CONTENT,
      "The dollar was steady ahead of the Fed decision.",
      "The dollar was steady ahead of the 2:00 p.m. ET Fed decision and the 2:30 p.m. press conference.", 9, 0, 6, 110),
    row("seed_10", MARKET, at(1, 8, 52), C.TERM,
      "The Agg gained 0.3% as duration rallied.",
      "The Bloomberg US Aggregate gained 0.3% as duration rallied.", 3, 1, 4, 65, ["Bloomberg", "US", "Aggregate"], ["Agg"]),
    row("seed_11", CLIENT, at(7, 10, 15), C.TONE,
      "Hi Dana, just wanted to circle back on the proposal.",
      "Hi Dana, following up on the proposal.", 2, 5, 3, 40),
    row("seed_12", CLIENT, at(2, 10, 40), C.TONE,
      "Thanks so much for your patience!!",
      "Thank you for your patience.", 2, 3, 3, 35),
  ];
}


const FLOWS = ["Weekly compliance review summary", "Daily market summary", "Client performance deck"];

function seedAiSessions() {
  // Deterministic sample re-prompting sessions (counts and timing only).
  let a = 20261030;
  function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const plans = [
    { flow: FLOWS[0], n: 12, sites: ["Claude", "ChatGPT", "ChatGPT", "Copilot"], min: 2, max: 6 },
    { flow: FLOWS[1], n: 18, sites: ["ChatGPT", "ChatGPT", "Claude", "Gemini"], min: 1, max: 4 },
    { flow: FLOWS[2], n: 8, sites: ["Claude", "Gemini", "ChatGPT"], min: 3, max: 7 },
  ];
  const out = [];
  plans.forEach(function (pl) {
    for (let i = 0; i < pl.n; i++) {
      const attempts = pl.min + Math.floor(rnd() * (pl.max - pl.min + 1));
      const regens = Math.floor(rnd() * Math.min(attempts, 3));
      let gap = 0;
      for (let k = 1; k < attempts; k++) gap += Math.round(60 + rnd() * 300);
      const day = Math.floor(rnd() * 28);
      const start = at(day, 8 + Math.floor(rnd() * 9), Math.floor(rnd() * 60));
      out.push({
        id: "ai_seed_" + out.length, site: pl.sites[Math.floor(rnd() * pl.sites.length)], workflow: pl.flow,
        startedAt: start, lastAt: start + gap * 1000, attempts: attempts, regens: regens,
        gapSeconds: gap, done: true, source: "seed",
      });
    }
  });
  return out;
}

const THEMES = [
  { cat: "Style and tone", flow: 0, users: [0, 1, 2, 3, 5, 6, 7], n: 14, phrases: [
    "Stop using three adjectives in a row, it reads like AI.", "Too many adjectives stacked together, cut them back.",
    "Don't pile adjectives on adjectives. Keep one per noun.", "Remove the stacked adjectives, it sounds robotic." ] },
  { cat: "Required wording", flow: 0, users: [0, 1, 2, 4, 6, 7], n: 12, phrases: [
    "Use the exact approved disclaimer, don't reword it.", "You changed the disclaimer wording. Keep it word for word.",
    "End with the standard disclaimer exactly as written." ] },
  { cat: "Facts and missing content", flow: 1, users: [9, 10, 11, 12, 14], n: 20, phrases: [
    "The closing price is wrong, recheck it against the source.", "These figures look wrong, check them again.",
    "That index number is incorrect. Verify the figures." ] },
  { cat: "Facts and missing content", flow: 1, users: [9, 10, 11, 12, 13, 14], n: 15, phrases: [
    "Add today's economic calendar events, you left out the CPI release.", "You missed the Fed minutes, include the economic calendar.",
    "Include the data releases scheduled for tomorrow, the calendar is missing." ] },
  { cat: "Length", flow: 1, users: [9, 10, 11, 12, 13, 14, 0, 1], n: 11, phrases: [
    "Make it shorter, about half the length.", "Too long. Tighten it to one page.", "Shorter please, keep only the key points." ] },
  { cat: "Formatting", flow: 2, users: [15, 16, 18, 19], n: 9, phrases: [
    "No bullet points, write it as short paragraphs.", "Remove the bullets and headings, use plain paragraphs.",
    "Don't use markdown headers, keep it as an email." ] },
  { cat: "Terminology", flow: 2, users: [15, 17, 19], n: 8, phrases: [
    "Call it high-yield credit, not junk bonds.", "Use the term high-yield credit instead of junk.",
    "We say benchmark, not index, in client materials." ] },
];
const SAMPLE_PEOPLE = ["AK", "BM", "CR", "DL", "EO", "FS", "GT", "HV", "IY", "JN", "KP", "LQ", "MW", "NX", "OZ", "PA", "QB", "RC", "SD", "TE"];

function seedRePrompts() {
  // Sample re-prompt corrections, written to illustrate clustering. Not real user data.
  let a = 20261031;
  function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const sites = ["ChatGPT", "Claude", "Gemini", "Copilot"];
  const out = [];
  THEMES.forEach(function (th) {
    for (let i = 0; i < th.n; i++) {
      const user = SAMPLE_PEOPLE[th.users[Math.floor(rnd() * th.users.length)]];
      const ts = at(Math.floor(rnd() * 28), 8 + Math.floor(rnd() * 9), Math.floor(rnd() * 60));
      out.push({
        id: "rp_seed_" + out.length, sessionId: "ai_seed_" + (out.length % 38), timestamp: ts,
        site: sites[Math.floor(rnd() * sites.length)], workflow: FLOWS[th.flow], attemptIndex: 2 + Math.floor(rnd() * 3),
        kind: "followup", text: th.phrases[Math.floor(rnd() * th.phrases.length)], category: th.cat, user: user,
        reviewSeconds: Math.round(20 + rnd() * 120), writeSeconds: Math.round(8 + rnd() * 60), source: "seed",
      });
    }
  });
  return out.sort(function (x, y) { return x.timestamp - y.timestamp; });
}

function seedFileRuns() {
  // Sample "your edits to the AI's file" so the workflow trace is not empty before you have your own.
  function ch(a, b, c) { return { addr: a, before: b, after: c }; }
  return [
    {
      id: "fr_seed_1", workflow: FLOWS[1], fileName: "daily_market_summary.xlsx", type: "xlsx", surface: "Excel", createdAt: at(2, 16, 40),
      totalCells: 60, changedCells: 9, formulaEdits: 1, unchangedPct: 85, estimatedMinutes: 7, minutesSource: "estimated", elapsedSeconds: 1380,
      category: "Factual/Data Correction", corrId: "", source: "seed",
      changes: [ch("Prices!B2", "5421.03", "5432.6"), ch("Prices!B3", "17208.51", "17243.18"), ch("Prices!B4", "4.31", "4.27"), ch("Prices!C2", "0.4", "0.6"),
        ch("Prices!C3", "0.4", "0.5"), ch("Prices!B6", "2318.4", "2341.7"), ch("Prices!B7", "78.12", "81.45"), ch("Prices!D9", "=SUM(D2:D7)", "=SUM(D2:D8)"), ch("Notes!A2", "Prepared by the AI assistant", "Reviewed by the desk")],
    },
    {
      id: "fr_seed_2", workflow: FLOWS[0], fileName: "weekly_compliance_summary.docx", type: "docx", surface: "Word", createdAt: at(3, 11, 5),
      totalCells: 38, changedCells: 5, formulaEdits: 0, unchangedPct: 87, estimatedMinutes: 9, minutesSource: "estimated", elapsedSeconds: 2460,
      category: "Terminology/Context Mismatch", corrId: "", source: "seed",
      changes: [ch("Paragraph 12", "This disclosure is provided for information.", "This summary does not constitute investment advice."), ch("Paragraph 13", "Restricted names: Acme Corp.", ""),
        ch("Paragraph 20", "The policy was reviewed in March.", "The policy was reviewed on 14 March 2026."), ch("Paragraph 31", "", "Source: compliance policy library."), ch("Paragraph 33", "Strong, robust controls were observed.", "Controls were observed.")],
    },
  ];
}

function seedFixes() {
  return [
    {
      id: "seed_fix_1",
      agent: MARKET,
      category: C.CONTENT,
      approvedAt: at(6, 17, 0),
      version: 2,
      instruction:
        "Before drafting, check the economic calendar for every same-day and next-day data release, central bank event and major earnings report, and include them in the summary. State a cause for a market move only if the data or a cited source supports it.",
      source: "seed",
    },
  ];
}

function seedSends(corrections) {
  const edited = corrections.map(function (c) {
    return { t: c.timestamp, agent: c.agent, category: c.category };
  });
  // [agent, daysAgo, hour, minute] drafts that were sent without any edit
  const clean = [
    [MARKET, 13, 14, 0], [MARKET, 12, 11, 0], [MARKET, 11, 13, 0], [MARKET, 10, 15, 0],
    [MARKET, 9, 12, 0], [MARKET, 8, 14, 0], [MARKET, 7, 10, 0], [MARKET, 7, 15, 0],
    [MARKET, 6, 18, 30], [MARKET, 5, 11, 0], [MARKET, 4, 15, 0], [MARKET, 3, 10, 0],
    [MARKET, 3, 16, 0], [MARKET, 2, 9, 30], [MARKET, 2, 14, 0], [MARKET, 1, 13, 0],
    [MARKET, 0, 9, 0], [MARKET, 0, 10, 30],
    [CLIENT, 9, 11, 0], [CLIENT, 8, 12, 0], [CLIENT, 6, 10, 0], [CLIENT, 5, 13, 0],
    [CLIENT, 3, 11, 0], [CLIENT, 1, 10, 0],
  ].map(function (r) {
    return { t: at(r[1], r[2], r[3]), agent: r[0], category: null };
  });
  return edited.concat(clean).sort(function (a, b) { return a.t - b.t; });
}

function sampleWorkflowTeams() {
  const m = {}; m[FLOWS[0]] = "Compliance"; m[FLOWS[1]] = "Research"; m[FLOWS[2]] = "Client Service"; return m;
}

function orgSample() { return self.FarfieldSample.generateOrg(Date.now()); }

function defaultSettings() {
  const org = orgSample();
  return {
    agents: [MARKET, CLIENT].concat(Object.keys(org.agentTeams).filter(function (a) { return a !== MARKET && a !== CLIENT; })),
    currentAgent: MARKET, mode: "auto", privacy: "full",
    workflows: ["General"].concat(FLOWS), currentWorkflow: "General", workflowMode: "perChat", aiTracking: true, promptCapture: "off", theme: "light",
    agentTeams: org.agentTeams, hourlyRate: 60,
    workflowTeams: sampleWorkflowTeams(),
  };
}

async function seedAll() {
  const corrections = seedCorrections();
  const org = orgSample();
  await chrome.storage.local.set({
    corrections: corrections.concat(org.corrections).sort(function (a, b) { return a.timestamp - b.timestamp; }),
    sends: seedSends(corrections).concat(org.sends).sort(function (a, b) { return a.t - b.t; }),
    fixes: seedFixes().concat(org.fixes),
    aiSessions: seedAiSessions(),
    rePrompts: seedRePrompts(),
    fileRuns: seedFileRuns(),
    promptAnalysis: null,
  });
}

chrome.runtime.onInstalled.addListener(async function (details) {
  try {
    if (details.reason === "install") {
      await seedAll();
      await chrome.storage.local.set({ settings: defaultSettings() });
      return;
    }
    const data = await chrome.storage.local.get(["corrections", "sends", "fixes", "settings", "aiSessions", "rePrompts", "fileRuns"]);
    if (!Array.isArray(data.corrections) || !Array.isArray(data.sends) || !Array.isArray(data.fixes)) {
      await seedAll();
    } else {
      if (!Array.isArray(data.aiSessions)) await chrome.storage.local.set({ aiSessions: seedAiSessions() });
      if (!Array.isArray(data.rePrompts)) await chrome.storage.local.set({ rePrompts: seedRePrompts() });
      if (!Array.isArray(data.fileRuns)) await chrome.storage.local.set({ fileRuns: self.FarfieldAnalysis.sampleCounts(data) > 0 ? seedFileRuns() : [] });
      // v3.1: add the sample organization (teams and sub-agents) for people who still have sample data
      const hasOrg = data.corrections.some(function (c) { return c && typeof c.id === "string" && c.id.indexOf("org_c_") === 0; });
      if (!hasOrg && self.FarfieldAnalysis.sampleCounts(data) > 0) {
        const org = orgSample();
        await chrome.storage.local.set({
          corrections: data.corrections.concat(org.corrections).sort(function (a, b) { return a.timestamp - b.timestamp; }),
          sends: data.sends.concat(org.sends).sort(function (a, b) { return a.t - b.t; }),
          fixes: data.fixes.concat(org.fixes),
        });
        const st = Object.assign({}, data.settings || {});
        st.agentTeams = Object.assign({}, org.agentTeams, st.agentTeams || {});
        st.agents = (st.agents || []).concat(Object.keys(org.agentTeams).filter(function (a) { return (st.agents || []).indexOf(a) === -1; }));
        if (!st.hourlyRate) st.hourlyRate = 60;
        await chrome.storage.local.set({ settings: st });
      }
    }
    if (!data.settings) {
      await chrome.storage.local.set({ settings: defaultSettings() });
    }
    // v3.2: which team each sample workflow belongs to (only for people who still have sample data)
    const cur = await chrome.storage.local.get("settings");
    if (cur.settings && !cur.settings.workflowTeams && self.FarfieldAnalysis.sampleCounts(data) > 0) {
      await chrome.storage.local.set({ settings: Object.assign({}, cur.settings, { workflowTeams: sampleWorkflowTeams() }) });
    }
  } catch (err) {
    console.error("[Farfield] Seeding failed:", err);
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false;

  if (message.type === "RESET_DEMO_DATA") {
    (async function () {
      await seedAll();
      const data = await chrome.storage.local.get("settings");
      const settings = Object.assign(defaultSettings(), data.settings || {});
      Object.keys(settings.agentTeams || {}).concat([MARKET, CLIENT]).forEach(function (a) {
        if (settings.agents.indexOf(a) === -1) settings.agents.push(a);
      });
      settings.agentTeams = Object.assign({}, orgSample().agentTeams, settings.agentTeams || {});
      await chrome.storage.local.set({ settings: settings });
      sendResponse({ ok: true });
    })().catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
    return true;
  }

  if (message.type === "OPEN_DASHBOARD") {
    const hash = ["#reprompts", "#data", "#corrections", "#chat-sessions"].indexOf(message.hash) !== -1 ? message.hash : "";
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") + hash });
    return false;
  }

  if (message.type === "CLEAR_DATA") {
    chrome.storage.local
      .set({ corrections: [], sends: [], fixes: [], aiSessions: [], rePrompts: [], fileRuns: [], promptAnalysis: null })
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
    return true;
  }

  return false;
});

// Corrections sent from the Word/Excel add-in (served from https://localhost:3000).
chrome.runtime.onMessageExternal.addListener(function (message, sender, sendResponse) {
  let origin = sender && sender.origin ? sender.origin : "";
  if (!origin && sender && sender.url) {
    try { origin = new URL(sender.url).origin; } catch (e) { origin = ""; }
  }
  if (origin !== "https://localhost:3000") {
    sendResponse({ ok: false, error: "origin not allowed" });
    return false;
  }
  if (!message || message.type !== "FARFIELD_LOG") {
    sendResponse({ ok: false, error: "unknown message" });
    return false;
  }

  (async function () {
    const send = self.FarfieldAnalysis.sanitizeSend(message.send);
    if (!send) throw new Error("invalid send record");
    const correction = message.correction ? self.FarfieldAnalysis.sanitizeCorrection(message.correction) : null;
    if (message.correction && !correction) throw new Error("invalid correction");

    const data = await chrome.storage.local.get(["corrections", "sends", "settings"]);
    const corrections = Array.isArray(data.corrections) ? data.corrections : [];
    const sends = Array.isArray(data.sends) ? data.sends : [];
    if (correction) corrections.push(correction);
    sends.push(send);

    const settings = Object.assign(defaultSettings(), data.settings || {});
    if (settings.agents.indexOf(send.agent) === -1) settings.agents.push(send.agent);

    await chrome.storage.local.set({ corrections: corrections, sends: sends, settings: settings });
    sendResponse({ ok: true });
  })().catch(function (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); });
  return true;
});

// ---------------------------------------------------------------------------
// Company sync (only does anything once the person has joined a company).
// ---------------------------------------------------------------------------
function runSync() {
  if (!self.FarfieldSync) return;
  self.FarfieldSync.syncNow().catch(function (e) { console.warn("Farfield sync:", e && e.message); });
}
function ensureSyncAlarm() {
  chrome.alarms.get("farfield-sync", function (a) {
    if (!a) chrome.alarms.create("farfield-sync", { periodInMinutes: 1, delayInMinutes: 1 });
  });
}
ensureSyncAlarm();
chrome.runtime.onStartup.addListener(function () { ensureSyncAlarm(); runSync(); });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === "farfield-sync" || alarm.name === "farfield-sync-soon") runSync();
});
// New work gets sent within about half a minute, without sending on every keystroke.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  var data = ["corrections", "sends", "aiSessions", "rePrompts", "fileRuns"].some(function (k) { return k in changes; });
  if (data) chrome.alarms.get("farfield-sync-soon", function (a) { if (!a) chrome.alarms.create("farfield-sync-soon", { delayInMinutes: 0.5 }); });
});
