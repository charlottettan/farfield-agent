/*
 * Farfield shared analysis logic.
 * Loaded by the Gmail content script, the background service worker, and the
 * dashboard, so classification, routing and pattern ranking stay consistent.
 */
(function (root) {
  "use strict";

  const CATEGORIES = {
    FACTUAL: "Factual/Data Correction",
    CONTENT: "Content Addition/Removal",
    TERM: "Terminology/Context Mismatch",
    TONE: "Tone/Style Edit",
  };

  const ROUTES = {
    INSTRUCTION: "Instruction change",
    ENGINEERING: "Engineering ticket",
    JUDGMENT: "Human judgment",
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  const COST_MULTIPLIER = {};
  COST_MULTIPLIER[CATEGORIES.FACTUAL] = 1.5;
  COST_MULTIPLIER[CATEGORIES.CONTENT] = 1.2;
  COST_MULTIPLIER[CATEGORIES.TERM] = 1.1;
  COST_MULTIPLIER[CATEGORIES.TONE] = 0.8;

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------
  function normalizeText(s) {
    return String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(text) {
    return normalizeText(text)
      .toLowerCase()
      .split(/\s+/)
      .map(function (w) {
        return w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "");
      })
      .filter(Boolean);
  }

  function extractNumbers(text) {
    return (String(text).match(/[$€£]?\d[\d,]*(?:\.\d+)?%?/g) || []).map(function (n) {
      return n.replace(/,/g, "");
    });
  }

  // Acronyms, mixed-case names and capitalized words that are not sentence starts.
  function properTerms(text) {
    const raw = normalizeText(text).split(/\s+/).filter(Boolean);
    const terms = [];
    raw.forEach(function (w, i) {
      const clean = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!clean || /^\d/.test(clean)) return;
      const prev = i > 0 ? raw[i - 1] : "";
      const sentenceStart = i === 0 || /[.!?]["')\]]?$/.test(prev);
      const isAcronym = /^(?=.*[A-Z].*[A-Z])[A-Z0-9&]+$/.test(clean);
      const isCapitalized = /^[A-Z][a-z]/.test(clean) && !sentenceStart;
      const isMixed = /[a-z][A-Z]/.test(clean);
      if (isAcronym || isCapitalized || isMixed) terms.push(clean);
    });
    return terms;
  }

  function countMap(list) {
    const m = new Map();
    list.forEach(function (item) {
      m.set(item, (m.get(item) || 0) + 1);
    });
    return m;
  }

  // How many items in `target` are not covered by `base` (multiset difference).
  function excessCount(target, base) {
    const baseMap = countMap(base);
    const targetMap = countMap(target);
    let excess = 0;
    targetMap.forEach(function (count, key) {
      excess += Math.max(0, count - (baseMap.get(key) || 0));
    });
    return excess;
  }

  function excessList(target, base) {
    const baseMap = countMap(base);
    const seen = new Map();
    const out = [];
    target.forEach(function (t) {
      const used = (seen.get(t) || 0) + 1;
      seen.set(t, used);
      if (used > (baseMap.get(t) || 0) && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }

  // Shows the region that changed, with a little context either side.
  function diffSnippets(a, b) {
    const max = Math.min(a.length, b.length);
    let p = 0;
    while (p < max && a[p] === b[p]) p++;
    let s = 0;
    while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

    const CONTEXT = 45;
    const LIMIT = 240;

    function cut(t, start, end) {
      let from = Math.max(0, start - CONTEXT);
      let to = Math.min(t.length, end + CONTEXT);
      if (from > 0) {
        const sp = t.indexOf(" ", from);
        if (sp !== -1 && sp < start) from = sp + 1;
      }
      if (to < t.length) {
        const sp = t.lastIndexOf(" ", to);
        if (sp > end) to = sp;
      }
      let out = t.slice(from, to).trim();
      let truncated = false;
      if (out.length > LIMIT) {
        out = out.slice(0, LIMIT - 1).trimEnd();
        truncated = true;
      }
      return (from > 0 ? "… " : "") + out + (truncated || to < t.length ? " …" : "");
    }

    return {
      original: cut(a, p, a.length - s),
      edited: cut(b, p, b.length - s),
    };
  }

  function estimateMinutes(category, wordsAdded, wordsRemoved) {
    const raw = (2 + (wordsAdded + wordsRemoved) * 0.3) * (COST_MULTIPLIER[category] || 1);
    return Math.min(60, Math.max(1, Math.round(raw)));
  }

  // ---------------------------------------------------------------------------
  // Classification + cost estimate (simple heuristics)
  //
  //  1. Numbers changed, overall length barely moved   -> Factual/Data
  //  2. No numbers changed, proper terms/acronyms
  //     added or removed, small length change          -> Terminology/Context
  //  3. Length changed noticeably (>=12% or >=10 words)-> Content Add/Remove
  //  4. Everything else                                -> Tone/Style
  // ---------------------------------------------------------------------------
  function analyzeEdit(original, finalText) {
    const oldWords = tokenize(original);
    const newWords = tokenize(finalText);
    const wordsAdded = excessCount(newWords, oldWords);
    const wordsRemoved = excessCount(oldWords, newWords);

    const oldNums = extractNumbers(original);
    const newNums = extractNumbers(finalText);
    const numbersChanged = excessCount(newNums, oldNums) + excessCount(oldNums, newNums) > 0;

    const oldTerms = properTerms(original);
    const newTerms = properTerms(finalText);
    const termsAdded = excessList(newTerms, oldTerms);
    const termsRemoved = excessList(oldTerms, newTerms);
    const termsChanged = termsAdded.length + termsRemoved.length > 0;

    const lengthDiff = Math.abs(newWords.length - oldWords.length);
    const ratio = lengthDiff / Math.max(oldWords.length, 1);

    let category;
    if (numbersChanged && ratio < 0.25 && lengthDiff < 15) {
      category = CATEGORIES.FACTUAL;
    } else if (!numbersChanged && termsChanged && lengthDiff <= 6) {
      category = CATEGORIES.TERM;
    } else if (ratio >= 0.12 || lengthDiff >= 10) {
      category = CATEGORIES.CONTENT;
    } else {
      category = CATEGORIES.TONE;
    }

    const estimatedMinutes = estimateMinutes(category, wordsAdded, wordsRemoved);
    const snippets = diffSnippets(normalizeText(original), normalizeText(finalText));

    return {
      category: category,
      wordsAdded: wordsAdded,
      wordsRemoved: wordsRemoved,
      estimatedMinutes: estimatedMinutes,
      termsAdded: termsAdded,
      termsRemoved: termsRemoved,
      originalSnippet: snippets.original,
      editedSnippet: snippets.edited,
    };
  }

  // Privacy modes: "full" | "redacted" | "none"
  function applyPrivacy(text, mode) {
    if (mode === "none") return "[text not stored]";
    if (mode === "redacted") {
      return String(text)
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
        .replace(/\d/g, "#");
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Routing: who can fix this pattern?
  // ---------------------------------------------------------------------------
  function routeFor(category, count) {
    if (category === CATEGORIES.FACTUAL) return ROUTES.ENGINEERING;
    if (category === CATEGORIES.TONE && count < 3) return ROUTES.JUDGMENT;
    return ROUTES.INSTRUCTION;
  }

  function proposalFor(p) {
    const route = routeFor(p.category, p.openCount);
    const mins = Math.round(p.openMinutes);
    const evidence = p.openCount + " corrections, about " + mins + " minutes of human cleanup";

    if (p.category === CATEGORIES.FACTUAL) {
      return {
        route: route,
        kind: "ticket",
        headline: "Figures are wrong. This is a data problem, not a wording problem.",
        text:
          "Title: " + p.agent + " returns incorrect figures\n" +
          "Impact: " + evidence + " in this period.\n" +
          "Likely cause: figures are generated from memory or stale sources instead of a live feed.\n" +
          "Suggested fix: connect the agent to the market data feed for index levels, prices and yields, " +
          "and add a step that rechecks every number against the source before the draft is shown.\n" +
          "Evidence: " + p.openCount + " captured before/after examples in Farfield.",
      };
    }

    if (p.category === CATEGORIES.CONTENT) {
      return {
        route: route,
        kind: "instruction",
        headline: "Required content is being left out or misexplained.",
        text:
          "Before drafting, check the economic calendar for every same-day and next-day data release, " +
          "central bank event and major earnings report, and include them in the summary. " +
          "When explaining why a market moved, state a cause only if the data or a cited source supports it; " +
          "otherwise say the move coincided with the event instead of implying causation.\n\n" +
          "Evidence: " + evidence + ". If the agent cannot see the calendar, this becomes an engineering ticket instead.",
      };
    }

    if (p.category === CATEGORIES.TERM) {
      const terms = p.terms && p.terms.length ? p.terms.join(", ") : "see captured examples";
      return {
        route: route,
        kind: "instruction",
        headline: "The agent uses terms differently from this team.",
        text:
          "Add a glossary to the agent's instructions. Terms people keep adding or changing: " + terms + ". " +
          "Define each term the way this team uses it, and always use the defined term in drafts.\n\n" +
          "Evidence: " + evidence + ".",
      };
    }

    if (route === ROUTES.INSTRUCTION) {
      return {
        route: route,
        kind: "instruction",
        headline: "Style keeps getting rewritten.",
        text:
          "Use a concise, neutral, client-ready tone. Avoid hype words and filler, keep sentences short, " +
          "and follow the desk's house style. Add two or three approved past messages as style examples.\n\n" +
          "Evidence: " + evidence + ".",
      };
    }

    return {
      route: route,
      kind: "note",
      headline: "These look like individual preference, not an agent defect.",
      text:
        "No instruction change recommended yet (" + evidence + "). " +
        "Revisit if the same style edit is made by several people or the count grows.",
    };
  }

  // ---------------------------------------------------------------------------
  // Patterns and before/after
  // ---------------------------------------------------------------------------
  function minutesOf(c, basis) {
    return basis === "measured" ? (Number(c.activeSeconds) || 0) / 60 : Number(c.estimatedMinutes) || 0;
  }

  function buildPatterns(corrections, fixes, basis) {
    const groups = new Map();
    corrections.forEach(function (c) {
      const key = c.agent + "||" + c.category;
      if (!groups.has(key)) groups.set(key, { key: key, agent: c.agent, category: c.category, items: [] });
      groups.get(key).items.push(c);
    });

    const out = [];
    groups.forEach(function (g) {
      const related = fixes
        .filter(function (f) { return f.agent === g.agent && f.category === g.category; })
        .sort(function (a, b) { return b.approvedAt - a.approvedAt; });
      const fix = related[0] || null;
      const open = fix
        ? g.items.filter(function (c) { return c.timestamp >= fix.approvedAt; })
        : g.items.slice();

      const termCounts = new Map();
      open.forEach(function (c) {
        (c.termsAdded || []).concat(c.termsRemoved || []).forEach(function (t) {
          termCounts.set(t, (termCounts.get(t) || 0) + 1);
        });
      });
      const terms = Array.from(termCounts.entries())
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 4)
        .map(function (e) { return e[0]; });

      out.push({
        key: g.key,
        agent: g.agent,
        category: g.category,
        totalCount: g.items.length,
        totalMinutes: g.items.reduce(function (s, c) { return s + minutesOf(c, basis); }, 0),
        openCount: open.length,
        openMinutes: open.reduce(function (s, c) { return s + minutesOf(c, basis); }, 0),
        fix: fix,
        terms: terms,
      });
    });
    return out;
  }

  function rankOpenPatterns(patterns) {
    return patterns
      .filter(function (p) { return p.openCount > 0; })
      .sort(function (a, b) {
        return b.openMinutes - a.openMinutes || b.openCount - a.openCount;
      });
  }

  // Correction rate for the fix's category, per AI draft sent, before vs after approval.
  function beforeAfter(fix, sends, windowDays) {
    const win = (windowDays || 14) * DAY_MS;
    const agentSends = sends.filter(function (s) { return s.agent === fix.agent; });
    const before = agentSends.filter(function (s) {
      return s.t < fix.approvedAt && s.t >= fix.approvedAt - win;
    });
    const after = agentSends.filter(function (s) { return s.t >= fix.approvedAt; });
    function rate(arr) {
      if (!arr.length) return null;
      return arr.filter(function (s) { return s.category === fix.category; }).length / arr.length;
    }
    return {
      before: { n: before.length, rate: rate(before) },
      after: { n: after.length, rate: rate(after) },
    };
  }

  // ---------------------------------------------------------------------------
  // Sanitizers: used for anything arriving from outside the extension
  // (the Word/Excel add-in bridge and the dashboard import box).
  // ---------------------------------------------------------------------------
  function clampStr(v, n) {
    return typeof v === "string" ? v.slice(0, n) : "";
  }

  function categoryValues() {
    return Object.keys(CATEGORIES).map(function (k) { return CATEGORIES[k]; });
  }

  function boundedNumber(v, max) {
    const n = Number(v);
    return isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
  }

  function cleanList(list) {
    return Array.isArray(list)
      ? list.slice(0, 10).map(function (t) { return clampStr(t, 40); }).filter(Boolean)
      : [];
  }

  function sanitizeCorrection(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (categoryValues().indexOf(raw.category) === -1) return null;
    const ts = Number(raw.timestamp);
    if (!isFinite(ts) || ts <= 0) return null;
    const out = {
      id: clampStr(raw.id, 60) || "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      timestamp: ts,
      agent: clampStr(raw.agent, 80) || "Unassigned agent",
      category: raw.category,
      surface: clampStr(raw.surface, 20),
      subject: clampStr(raw.subject, 200),
      originalSnippet: clampStr(raw.originalSnippet, 400),
      editedSnippet: clampStr(raw.editedSnippet, 400),
      wordsAdded: Math.round(boundedNumber(raw.wordsAdded, 100000)),
      wordsRemoved: Math.round(boundedNumber(raw.wordsRemoved, 100000)),
      estimatedMinutes: boundedNumber(raw.estimatedMinutes, 600),
      activeSeconds: Math.round(boundedNumber(raw.activeSeconds, 86400)),
      timeSource: clampStr(raw.timeSource, 30),
      termsAdded: cleanList(raw.termsAdded),
      termsRemoved: cleanList(raw.termsRemoved),
      source: raw.source === "seed" ? "seed" : "live",
    };
    if (typeof raw.workflow === "string" && raw.workflow) out.workflow = clampStr(raw.workflow, 120);
    if (typeof raw.file === "string" && raw.file) out.file = clampStr(raw.file, 160);
    if (raw.totalCells !== undefined) {
      out.flaggedCount = Math.round(boundedNumber(raw.flaggedCount, 1000000));
      out.reviewedCells = Math.round(boundedNumber(raw.reviewedCells, 10000000));
      out.totalCells = Math.round(boundedNumber(raw.totalCells, 10000000));
    }
    return out;
  }

  function sanitizeSend(raw) {
    if (!raw || typeof raw !== "object") return null;
    const t = Number(raw.t);
    if (!isFinite(t) || t <= 0) return null;
    const cat = raw.category === null || raw.category === undefined ? null : raw.category;
    if (cat !== null && categoryValues().indexOf(cat) === -1) return null;
    return {
      t: t,
      agent: clampStr(raw.agent, 80) || "Unassigned agent",
      category: cat,
      surface: clampStr(raw.surface, 20),
    };
  }

  // ---------------------------------------------------------------------------
  // AI chat sessions (re-prompting). Counts and timing only: no prompt text.
  //   attempts = prompts sent + regenerations; retries = attempts - 1
  //   gapSeconds = time between consecutive attempts (gaps over 10 minutes are ignored)
  // ---------------------------------------------------------------------------
  const AI_IDLE_MS = 30 * 60 * 1000;
  const AI_GAP_CAP_MS = 10 * 60 * 1000;

  function newAiSession(id, site, workflow, now) {
    return {
      id: id, site: site, workflow: workflow || "Unassigned workflow",
      startedAt: now, lastAt: now, attempts: 0, regens: 0, gapSeconds: 0,
      done: false, source: "live",
    };
  }

  function applyAiEvent(session, kind, now) {
    if (session.attempts > 0) {
      const gap = now - session.lastAt;
      if (gap > 0 && gap < AI_GAP_CAP_MS) session.gapSeconds += Math.round(gap / 1000);
    }
    session.attempts += 1;
    if (kind === "regen") session.regens += 1;
    session.lastAt = now;
    return session;
  }

  function aiSessionExpired(session, now) {
    return !session || session.done || now - session.lastAt > AI_IDLE_MS;
  }

  function summarizeAiSessions(sessions) {
    const list = (sessions || []).filter(function (s) { return s && s.attempts > 0; });
    const hist = [0, 0, 0, 0, 0, 0];
    let attempts = 0, retries = 0, gap = 0;
    const tools = {};
    const flows = {};

    function bucket(map, name) {
      if (!map[name]) map[name] = { name: name, sessions: 0, attempts: 0, retries: 0, gapSeconds: 0 };
      return map[name];
    }

    list.forEach(function (s) {
      const r = Math.max(s.attempts - 1, 0);
      attempts += s.attempts; retries += r; gap += s.gapSeconds || 0;
      hist[Math.min(s.attempts, 6) - 1]++;
      [bucket(tools, s.site), bucket(flows, s.workflow)].forEach(function (b) {
        b.sessions++; b.attempts += s.attempts; b.retries += r; b.gapSeconds += s.gapSeconds || 0;
      });
    });

    function finish(map) {
      return Object.keys(map).map(function (k) {
        const b = map[k];
        b.avgAttempts = b.sessions ? b.attempts / b.sessions : 0;
        b.retryHours = b.gapSeconds / 3600;
        return b;
      }).sort(function (a, b) { return b.gapSeconds - a.gapSeconds || b.avgAttempts - a.avgAttempts; });
    }

    return {
      sessions: list.length, attempts: attempts, retries: retries,
      avgAttempts: list.length ? attempts / list.length : 0,
      retryHours: gap / 3600, hist: hist,
      byTool: finish(tools), byWorkflow: finish(flows),
    };
  }

  // ---------------------------------------------------------------------------
  // Re-prompt corrections: the follow-up instructions people give an AI tool.
  // Only follow-ups that look like corrections are kept, never the first prompt, and the text is
  // stored only when the person opts in (modes: "off", "redacted", "full").
  // ---------------------------------------------------------------------------
  const PROMPT_CATS = {
    TERM: "Terminology",
    WORDING: "Required wording",
    FACTS: "Facts and missing content",
    LENGTH: "Length",
    FORMAT: "Formatting",
    STYLE: "Style and tone",
    OTHER: "Other correction",
    REGEN: "Regenerated without instructions",
    UNSORTED: "Follow-up (not categorized)",
    PASTE: "Pasted material (not an instruction)",
  };

  const PROMPT_RULES = [
    { cat: PROMPT_CATS.TERM, re: /\b(call (it|them|this)|the term|we say|refer to|should be called|known as)\b/ },
    { cat: PROMPT_CATS.WORDING, re: /\b(disclaimer|disclosure|word for word|verbatim|exactly as|exact wording|approved wording)\b/ },
    { cat: PROMPT_CATS.FACTS, re: /\b(wrong|incorrect|not right|inaccurate|mistake|re-?check|verify|figures?|numbers?|price|prices|yield|source|missed|missing|left out|forgot|add|include|also mention|cover)\b/ },
    { cat: PROMPT_CATS.FORMAT, re: /\b(bullets?|table|markdown|headers?|headings?|paragraphs?|format)\b/ },
    { cat: PROMPT_CATS.LENGTH, re: /\b(shorter|short|concise|brief|tighten|too long|longer|wordy|half the length|one page)\b/ },
    { cat: PROMPT_CATS.STYLE, re: /\b(tone|sounds? like|reads? like|robotic|adjectives?|casual|formal|voice|punchy|fluff|stiff|natural|human|conversational|generic)\b/ },
    { cat: PROMPT_CATS.OTHER, re: /\b(don'?t|do not|stop|never|avoid|without|instead|rather|change|fix|rewrite|redo|again|not what|that'?s not|too |should)\b/ },
  ];

  function classifyPrompt(text) {
    const t = " " + String(text || "").toLowerCase().replace(/\s+/g, " ") + " ";
    for (let i = 0; i < PROMPT_RULES.length; i++) {
      if (PROMPT_RULES[i].re.test(t)) return { isCorrection: true, category: PROMPT_RULES[i].cat };
    }
    return { isCorrection: false, category: null };
  }

  // Masks digits, email addresses, and capitalised words that are not at the start of a sentence.
  function redactPrompt(text) {
    const words = String(text || "").replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]").split(/(\s+)/);
    let sentenceStart = true;
    return words.map(function (w) {
      if (/^\s+$/.test(w) || w === "") return w;
      const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      let out = w.replace(/\d/g, "#");
      if (!sentenceStart && /^[A-Z]/.test(core) && core.length > 1) out = out.replace(core.replace(/\d/g, "#"), "[name]");
      sentenceStart = /[.!?]["')\]]?$/.test(w);
      return out;
    }).join("");
  }

  const SECONDS_CAP = 600;
  function capSeconds(v) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.min(Math.round(n), SECONDS_CAP) : 0;
  }

  // ---------------------------------------------------------------------------
  // Telling an instruction apart from material the person pasted for the AI to work on.
  // A long message with no request in it (an email draft, a data table) is "material", not a re-prompt.
  // ---------------------------------------------------------------------------
  const REQUEST_START = /^(please\s+)?(can|could|would|will)\s+you\b|^(please|make|add|remove|delete|rewrite|rephrase|reword|shorten|lengthen|expand|cut|trim|tighten|fix|correct|change|update|include|exclude|use|keep|stop|avoid|don'?t|do not|never|always|write|draft|summari[sz]e|translate|convert|turn|reduce|replace|check|recheck|recompute|recalculate|verify|format|reformat|restructure|reorder|move|split|merge|combine|simplify|clarify|improve|polish|edit|redo|try|give|show|list|explain|generate|create|build|put|insert)\b|^(i want you to|i need you to|i'd like you to|i would like you to|i need it to|i want it to)\b/i;

  function splitPrompt(text) {
    const t = String(text || "").replace(/\r/g, "").trim();
    if (!t) return { instruction: "", material: "", kind: "empty" };
    const flat = t.replace(/\s+/g, " ");
    if (flat.length <= 300) return { instruction: flat, material: "", kind: "instruction" };
    const sents = t.split(/(?<=[.!?])\s+|\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    const instr = [], rest = [];
    sents.forEach(function (sn) {
      if (REQUEST_START.test(sn)) {
        const ci = sn.indexOf(": ");
        if (ci > 3 && ci < 120 && REQUEST_START.test(sn.slice(0, ci))) { instr.push(sn.slice(0, ci)); rest.push(sn.slice(ci + 2)); }
        else if (sn.length <= 300) instr.push(sn);
        else rest.push(sn);
      } else rest.push(sn);
    });
    if (!instr.length) return { instruction: "", material: flat, kind: "material" };
    const material = rest.join(" ");
    return { instruction: instr.slice(0, 3).join(" ").slice(0, 300), material: material, kind: material.length > 200 ? "mixed" : "instruction" };
  }

  // The short instruction behind a saved re-prompt (old records are worked out from their text).
  function instructionOf(r) {
    if (!r || r.kind === "regen") return "";
    return typeof r.instruction === "string" ? r.instruction : splitPrompt(r.text).instruction;
  }
  function isMaterialOnly(r) {
    if (!r || r.kind === "regen") return false;
    if (r.category === PROMPT_CATS.PASTE) return true;
    return typeof r.instruction === "string" ? false : splitPrompt(r.text).kind === "material";
  }

  // Only offered when the person's own words already read like a clean, short request.
  function draftRule(text) {
    const t = String(text || "").trim();
    return t.length > 0 && t.length <= 140 && REQUEST_START.test(t) && !/\d/.test(t) ? t : "";
  }

  function categorize(text) {
    const parts = splitPrompt(text);
    if (parts.kind === "material") return { category: PROMPT_CATS.PASTE, looks: false, instruction: "", parts: parts };
    const c = classifyPrompt(parts.instruction);
    return { category: c.isCorrection ? c.category : PROMPT_CATS.UNSORTED, looks: c.isCorrection, instruction: parts.instruction, parts: parts };
  }

  // Re-runs the sorting on saved prompts with the current rules. The text itself is never changed.
  function recategorize(list) {
    let changed = 0;
    const out = (list || []).map(function (r) {
      if (!r || r.kind === "regen" || typeof r.text !== "string" || !r.text) return r;
      const c = categorize(r.text);
      if (r.category === c.category && r.instruction === c.instruction) return r;
      changed++;
      return Object.assign({}, r, { category: c.category, looksLikeCorrection: c.looks, instruction: c.instruction.slice(0, 300) });
    });
    return { list: out, changed: changed };
  }

  // Every follow-up prompt is kept (when saving is on), so nothing you send silently disappears.
  // A follow-up that does not match a known correction pattern is stored as "not categorized".
  // Returns null only when saving is off.
  function buildRePrompt(o) {
    if (!o || o.mode === "off" || !o.mode) return null;
    let category, text, looks = true, unreadable = false, instruction = "";
    if (o.kind === "regen") {
      category = PROMPT_CATS.REGEN;
      text = "";
    } else {
      const c = categorize(o.text);
      looks = c.looks;
      category = c.category;
      instruction = c.instruction.slice(0, 300);
      text = String(o.text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
      unreadable = text === "";
      if (o.mode === "redacted") { text = redactPrompt(text); instruction = redactPrompt(instruction); }
    }
    return {
      id: o.id, sessionId: o.sessionId, timestamp: o.now, site: o.site, workflow: o.workflow,
      attemptIndex: o.attemptIndex, kind: o.kind === "regen" ? "regen" : "followup",
      text: text, instruction: instruction, category: category, user: o.user || "You", looksLikeCorrection: looks, unreadable: unreadable,
      reviewSeconds: capSeconds(o.reviewSec), writeSeconds: o.kind === "regen" ? 0 : capSeconds(o.writeSec),
      source: o.source || "live",
    };
  }

  // ---- clustering similar corrections (simple text similarity; a language model would do better) ----
  const STOPWORDS = new Set(("a an the and or but if then so to of in on at for with from by as is are was were be been it its it's this that " +
    "these those you your i me my we our they them their he she his her not no do does did done dont don't please thanks thank again just " +
    "make made using use used keep only more most too very much many one per into out up down over than also about like reads read sounds sound " +
    "should would could can will have has had need needs want wants").split(/\s+/));

  const CANON = {
    shorter: "short", concise: "short", brief: "short", tighten: "short", wordy: "short", lengthy: "short", long: "short", trim: "short",
    incorrect: "wrong", inaccurate: "wrong", "not": "wrong", mistaken: "wrong", recheck: "check", "re-check": "check", verify: "check", figures: "figure", numbers: "figure", number: "figure",
    missed: "missing", forgot: "missing", right: "wrong", "left": "missing", add: "include", included: "include",
    bullets: "bullet", headers: "heading", headings: "heading", header: "heading", markdown: "heading", paragraphs: "paragraph",
    stacked: "stack", pile: "stack", piled: "stack", adjectives: "adjective", reword: "change", reworded: "change", changed: "change",
    junk: "wrongterm", term: "wrongterm", "say": "wrongterm",
  };

  function promptTokens(text) {
    return String(text || "").toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean)
      .filter(function (w) { return !STOPWORDS.has(w) && w.length > 1; })
      .map(function (w) {
        let c = CANON[w] || w;
        if (!CANON[w] && c.length > 4 && /s$/.test(c) && !/ss$/.test(c)) c = c.slice(0, -1);
        return c;
      });
  }

  function vectorize(tokenLists) {
    const df = {};
    tokenLists.forEach(function (toks) { Object.keys(toks.reduce(function (m, t) { m[t] = 1; return m; }, {})).forEach(function (t) { df[t] = (df[t] || 0) + 1; }); });
    const n = tokenLists.length;
    return tokenLists.map(function (toks) {
      const tf = {};
      toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      const v = {};
      let norm = 0;
      Object.keys(tf).forEach(function (t) { const w = tf[t] * (Math.log((n + 1) / (df[t] + 0.5)) + 1); v[t] = w; norm += w * w; });
      norm = Math.sqrt(norm) || 1;
      Object.keys(v).forEach(function (t) { v[t] /= norm; });
      return v;
    });
  }

  function cosine(a, b) {
    let dot = 0;
    Object.keys(a).forEach(function (t) { if (b[t]) dot += a[t] * b[t]; });
    return dot;
  }

  function addInto(sum, v) { Object.keys(v).forEach(function (t) { sum[t] = (sum[t] || 0) + v[t]; }); }

  function normalizeVec(v) {
    let norm = 0;
    Object.keys(v).forEach(function (t) { norm += v[t] * v[t]; });
    norm = Math.sqrt(norm) || 1;
    const out = {};
    Object.keys(v).forEach(function (t) { out[t] = v[t] / norm; });
    return out;
  }

  const CLUSTER_THRESHOLD = 0.2;
  const CLUSTER_MAX_ITEMS = 400;

  // Average-link grouping: the two groups whose members are, on average, most similar are merged
  // until no pair is similar enough. This avoids long chains of loosely related corrections.
  // The category is added as an extra word so corrections of the same kind lean together.
  function clusterPrompts(items, threshold) {
    const t = typeof threshold === "number" ? threshold : CLUSTER_THRESHOLD;
    const withText = items.filter(function (x) { return x.text; }).slice(-CLUSTER_MAX_ITEMS);
    const vecs = vectorize(withText.map(function (x) {
      return promptTokens(x.text).concat(["cat_" + String(x.category).replace(/\W+/g, "_")]);
    }));
    const n = withText.length;
    const sim = [];
    for (let i = 0; i < n; i++) {
      sim.push(new Array(n).fill(0));
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) { const c = cosine(vecs[i], vecs[j]); sim[i][j] = c; sim[j][i] = c; }
    }
    let groups = withText.map(function (_, i) { return [i]; });
    for (;;) {
      let best = -1, bi = -1, bj = -1;
      for (let a = 0; a < groups.length; a++) {
        for (let b = a + 1; b < groups.length; b++) {
          let total = 0;
          groups[a].forEach(function (i) { groups[b].forEach(function (j) { total += sim[i][j]; }); });
          const avg = total / (groups[a].length * groups[b].length);
          if (avg > best) { best = avg; bi = a; bj = b; }
        }
      }
      if (best < t || bi === -1) break;
      groups[bi] = groups[bi].concat(groups[bj]);
      groups.splice(bj, 1);
    }
    return groups.map(function (g) {
      const sum = {};
      const members = g.map(function (i) { addInto(sum, vecs[i]); return { item: withText[i], vec: vecs[i] }; });
      return { members: members, sum: sum };
    });
  }

  function summarizePromptClusters(rePrompts) {
    const all = (rePrompts || []).filter(Boolean);
    const material = all.filter(isMaterialOnly);
    const timed = all.filter(function (r) { return r.reviewSeconds > 0 || r.writeSeconds > 0; });
    const sumReview = timed.reduce(function (s, r) { return s + r.reviewSeconds; }, 0);
    const sumWrite = timed.reduce(function (s, r) { return s + r.writeSeconds; }, 0);

    const clusterable = all.filter(function (r) { return !isMaterialOnly(r) && instructionOf(r); })
      .map(function (r) { return Object.assign({}, r, { fullText: r.text, text: instructionOf(r) }); });
    const clusters = clusterPrompts(clusterable).map(function (c) {
      const items = c.members.map(function (m) { return m.item; });
      const centroid = normalizeVec(c.sum);
      const rep = c.members.slice().sort(function (a, b) { return cosine(b.vec, centroid) - cosine(a.vec, centroid); })[0].item;
      const catCount = {};
      items.forEach(function (r) { catCount[r.category] = (catCount[r.category] || 0) + 1; });
      const category = Object.keys(catCount).sort(function (a, b) { return catCount[b] - catCount[a]; })[0];
      const users = {};
      items.forEach(function (r) { users[r.user || "You"] = true; });
      const review = items.reduce(function (s, r) { return s + r.reviewSeconds; }, 0);
      const write = items.reduce(function (s, r) { return s + r.writeSeconds; }, 0);
      const examples = [];
      items.slice().sort(function (a, b) { return a.text.length - b.text.length; }).forEach(function (r) {
        if (examples.length < 3 && examples.indexOf(r.text) === -1) examples.push(r.text);
      });
      return {
        category: category, count: items.length, users: Object.keys(users), userCount: Object.keys(users).length,
        reviewSeconds: review, writeSeconds: write, totalSeconds: review + write,
        representative: rep.text, examples: examples,
        items: items.slice().sort(function (a, b) { return b.timestamp - a.timestamp; }),
      };
    }).sort(function (a, b) { return b.totalSeconds - a.totalSeconds || b.count - a.count; });

    return {
      total: all.length,
      pastedCount: material.length,
      pasted: material,
      regens: all.filter(function (r) { return r.kind === "regen"; }).length,
      avgReviewSeconds: timed.length ? sumReview / timed.length : 0,
      avgWriteSeconds: timed.length ? sumWrite / timed.length : 0,
      totalSeconds: sumReview + sumWrite,
      clusters: clusters,
    };
  }

  // ---------------------------------------------------------------------------
  // Backup, restore and sample-data handling
  // ---------------------------------------------------------------------------
  function srcOf(raw) { return raw && raw.source === "seed" ? "seed" : "live"; }
  function str(v, n) { return typeof v === "string" ? v.slice(0, n) : ""; }
  function posNum(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; }

  function sanitizeAiSession(raw) {
    if (!raw || typeof raw !== "object" || !str(raw.id, 60)) return null;
    const started = posNum(raw.startedAt);
    if (!started) return null;
    return {
      id: str(raw.id, 60), site: str(raw.site, 40) || "Unknown", workflow: str(raw.workflow, 120) || "Unassigned workflow",
      startedAt: started, lastAt: posNum(raw.lastAt) || started,
      attempts: Math.round(boundedNumber(raw.attempts, 100000)), regens: Math.round(boundedNumber(raw.regens, 100000)),
      gapSeconds: Math.round(boundedNumber(raw.gapSeconds, 31536000)), done: !!raw.done, source: srcOf(raw), imported: raw.imported === true,
    };
  }

  function sanitizeRePrompt(raw) {
    if (!raw || typeof raw !== "object" || !str(raw.id, 60)) return null;
    const ts = posNum(raw.timestamp);
    const cats = Object.keys(PROMPT_CATS).map(function (k) { return PROMPT_CATS[k]; });
    if (!ts || cats.indexOf(raw.category) === -1) return null;
    return {
      id: str(raw.id, 60), sessionId: str(raw.sessionId, 60), timestamp: ts, site: str(raw.site, 40) || "Unknown",
      workflow: str(raw.workflow, 120) || "Unassigned workflow", attemptIndex: Math.round(boundedNumber(raw.attemptIndex, 100000)),
      kind: raw.kind === "regen" ? "regen" : "followup", text: str(raw.text, 1000), category: raw.category,
      user: str(raw.user, 20) || "You", reviewSeconds: capSeconds(raw.reviewSeconds), writeSeconds: capSeconds(raw.writeSeconds), source: srcOf(raw),
      looksLikeCorrection: raw.looksLikeCorrection !== false, unreadable: raw.unreadable === true,
      imported: raw.imported === true, gapSeconds: capSeconds(raw.gapSeconds),
      instruction: typeof raw.instruction === "string" ? raw.instruction.slice(0, 300) : undefined,
    };
  }

  function sanitizeFix(raw) {
    if (!raw || typeof raw !== "object" || !str(raw.id, 60)) return null;
    const at = posNum(raw.approvedAt);
    if (!at || categoryValues().indexOf(raw.category) === -1) return null;
    return {
      id: str(raw.id, 60), agent: str(raw.agent, 80) || "Unassigned agent", category: raw.category, approvedAt: at,
      version: Math.round(boundedNumber(raw.version, 1000)) || 2, instruction: str(raw.instruction, 2000), source: srcOf(raw),
      problem: str(raw.problem, 140).trim() || undefined,
      destination: ["instructions", "data", "review"].indexOf(raw.destination) === -1 ? undefined : raw.destination,
      owner: str(raw.owner, 80).trim() || undefined,
      status: raw.status === "with_owner" ? "with_owner" : undefined,
      handoffAt: posNum(raw.handoffAt) || undefined,
      publishedAt: posNum(raw.publishedAt) || undefined,
    };
  }

  function sanitizeSettings(raw) {
    if (!raw || typeof raw !== "object") return null;
    function list(v) { return Array.isArray(v) ? v.slice(0, 50).map(function (x) { return str(x, 120); }).filter(Boolean) : []; }
    const out = { agents: list(raw.agents), workflows: list(raw.workflows) };
    if (str(raw.currentAgent, 120)) out.currentAgent = str(raw.currentAgent, 120);
    if (str(raw.currentWorkflow, 120)) out.currentWorkflow = str(raw.currentWorkflow, 120);
    if (raw.mode === "auto" || raw.mode === "manual") out.mode = raw.mode;
    if (raw.workflowMode === "perChat" || raw.workflowMode === "fixed") out.workflowMode = raw.workflowMode;
    if (["full", "redacted", "none"].indexOf(raw.privacy) !== -1) out.privacy = raw.privacy;
    if (typeof raw.aiTracking === "boolean") out.aiTracking = raw.aiTracking;
    if (["off", "redacted", "full"].indexOf(raw.promptCapture) !== -1) out.promptCapture = raw.promptCapture;
    if (raw.theme === "light" || raw.theme === "dark") out.theme = raw.theme;
    if (raw.agentTeams && typeof raw.agentTeams === "object" && !Array.isArray(raw.agentTeams)) {
      out.agentTeams = {};
      Object.keys(raw.agentTeams).slice(0, 100).forEach(function (k) { const v = str(raw.agentTeams[k], 60); if (v) out.agentTeams[str(k, 80)] = v; });
    }
    if (raw.workflowTeams && typeof raw.workflowTeams === "object" && !Array.isArray(raw.workflowTeams)) {
      out.workflowTeams = {};
      Object.keys(raw.workflowTeams).slice(0, 200).forEach(function (k) { const v = str(raw.workflowTeams[k], 60); if (v) out.workflowTeams[str(k, 120)] = v; });
    }
    if (isFinite(Number(raw.targetHoursPerWeek)) && Number(raw.targetHoursPerWeek) > 0) out.targetHoursPerWeek = Math.min(100000, Number(raw.targetHoursPerWeek));
    if (isFinite(Number(raw.hourlyRate)) && Number(raw.hourlyRate) > 0) out.hourlyRate = Math.min(10000, Number(raw.hourlyRate));
    return out;
  }

  const DATA_KEYS = ["corrections", "sends", "fixes", "aiSessions", "rePrompts", "fileRuns"];

  // Accepts either a Farfield export file or the raw output of chrome.storage.local.get(null).
  function extractData(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const d = parsed.farfieldExport && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    const known = DATA_KEYS.concat(["settings"]).some(function (k) { return d[k] !== undefined; });
    return known ? d : null;
  }

  function buildExport(current, version) {
    const data = {};
    DATA_KEYS.forEach(function (k) { data[k] = Array.isArray(current[k]) ? current[k] : []; });
    data.settings = current.settings || {};
    return { farfieldExport: 1, version: version || "", exportedAt: new Date().toISOString(), data: data };
  }

  const IMPORT_TYPES = [
    { key: "corrections", clean: sanitizeCorrection, id: function (x) { return x.id; }, live: function (x) { return x.source !== "seed"; } },
    // Sample sends were created without a surface; real ones always carry Gmail, Word or Excel.
    { key: "sends", clean: sanitizeSend, id: function (x) { return [x.t, x.agent, x.category, x.surface].join("|"); }, live: function (x) { return !!x.surface; } },
    { key: "fixes", clean: sanitizeFix, id: function (x) { return x.id; }, live: function (x) { return x.source !== "seed"; } },
    { key: "aiSessions", clean: sanitizeAiSession, id: function (x) { return x.id; }, live: function (x) { return x.source !== "seed"; } },
    { key: "rePrompts", clean: sanitizeRePrompt, id: function (x) { return x.id; }, live: function (x) { return x.source !== "seed"; } },
    { key: "fileRuns", clean: function (r) { return sanitizeFileRun(r); }, id: function (x) { return x.id; }, live: function (x) { return x.source !== "seed"; } },
  ];

  function union(a, b) {
    const out = [];
    (a || []).concat(b || []).forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
    return out;
  }

  // Works out what an import would do, without changing anything.
  // opts: { liveOnly, mode: "merge" | "replace", takeSettings }
  function planImport(current, parsed, opts) {
    opts = opts || {};
    const data = extractData(parsed);
    if (!data) return { error: "This does not look like Farfield data. Use an export from Farfield, or the output of the v2.4 console snippet." };
    const counts = {}, result = {};
    IMPORT_TYPES.forEach(function (t) {
      const raws = Array.isArray(data[t.key]) ? data[t.key] : [];
      let cleaned = [], invalid = 0, skipped = 0, dup = 0;
      raws.forEach(function (r) { const c = t.clean(r); if (c) cleaned.push(c); else invalid++; });
      if (opts.liveOnly) cleaned = cleaned.filter(function (x) { if (t.live(x)) return true; skipped++; return false; });
      const base = opts.mode === "replace" ? [] : (Array.isArray(current[t.key]) ? current[t.key].slice() : []);
      const seen = {};
      base.forEach(function (x) { seen[t.id(x)] = 1; });
      const added = [];
      cleaned.forEach(function (x) { const k = t.id(x); if (seen[k]) dup++; else { seen[k] = 1; added.push(x); } });
      result[t.key] = base.concat(added);
      counts[t.key] = { found: raws.length, invalid: invalid, skippedSample: skipped, duplicates: dup, added: added.length, total: result[t.key].length };
    });

    const inc = sanitizeSettings(data.settings), cur = current.settings || {};
    const merged = Object.assign({}, cur);
    const seenNames = [];
    ["corrections", "sends", "fixes"].forEach(function (k) { result[k].forEach(function (x) { if (x.agent) seenNames.push(x.agent); }); });
    merged.agents = union(union(cur.agents, inc ? inc.agents : []), seenNames);
    const flowNames = result.aiSessions.map(function (x) { return x.workflow; });
    merged.workflows = union(union(cur.workflows, inc ? inc.workflows : []), flowNames);
    if (inc && opts.takeSettings) {
      ["currentAgent", "currentWorkflow", "mode", "workflowMode", "privacy", "aiTracking", "promptCapture", "theme", "hourlyRate", "targetHoursPerWeek"].forEach(function (k) { if (inc[k] !== undefined) merged[k] = inc[k]; });
      if (inc.workflowTeams) merged.workflowTeams = Object.assign({}, cur.workflowTeams || {}, inc.workflowTeams);
      if (inc.agentTeams) merged.agentTeams = Object.assign({}, cur.agentTeams || {}, inc.agentTeams);
    }
    result.settings = merged;
    counts.settings = { found: inc ? 1 : 0, tookValues: !!(inc && opts.takeSettings) };
    return { counts: counts, result: result, mode: opts.mode === "replace" ? "replace" : "merge", liveOnly: !!opts.liveOnly };
  }

  function isSampleRecord(key, x) { return key === "sends" ? !x.surface : x.source === "seed"; }

  function removeSample(current) {
    const out = {}, removed = {};
    DATA_KEYS.forEach(function (k) {
      const list = Array.isArray(current[k]) ? current[k] : [];
      out[k] = list.filter(function (x) { return !isSampleRecord(k, x); });
      removed[k] = list.length - out[k].length;
    });
    return { result: out, removed: removed };
  }

  function sampleCounts(current) {
    let total = 0;
    DATA_KEYS.forEach(function (k) { (Array.isArray(current[k]) ? current[k] : []).forEach(function (x) { if (isSampleRecord(k, x)) total++; }); });
    return total;
  }

  // ---------------------------------------------------------------------------
  // Workflows: a workflow is simply the name stored on a chat session and its re-prompts.
  // Every new chat gets its own automatically; renaming to an existing name merges them.
  // ---------------------------------------------------------------------------
  function autoWorkflowName(site, ts) {
    const when = new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return (site || "AI") + " chat, " + when;
  }

  function uniqueName(base, taken) {
    if (taken.indexOf(base) === -1) return base;
    let i = 2;
    while (taken.indexOf(base + " (" + i + ")") !== -1) i++;
    return base + " (" + i + ")";
  }

  function listWorkflows(current) {
    const map = {};
    function row(name) {
      if (!map[name]) map[name] = { name: name, sessions: 0, attempts: 0, rePrompts: 0, files: 0, reviewSeconds: 0, writeSeconds: 0, lastAt: 0, live: 0, sample: 0 };
      return map[name];
    }
    (current.aiSessions || []).forEach(function (x) {
      const r = row(x.workflow); r.sessions++; r.attempts += x.attempts || 0; r.lastAt = Math.max(r.lastAt, x.lastAt || 0);
      if (x.source === "seed") r.sample++; else r.live++;
    });
    (current.rePrompts || []).forEach(function (x) {
      const r = row(x.workflow); r.rePrompts++; r.reviewSeconds += x.reviewSeconds || 0; r.writeSeconds += x.writeSeconds || 0; r.lastAt = Math.max(r.lastAt, x.timestamp || 0);
      if (x.source === "seed") r.sample++; else r.live++;
    });
    (current.fileRuns || []).forEach(function (x) {
      const r = row(x.workflow || "Unlinked files"); r.files++; r.lastAt = Math.max(r.lastAt, x.createdAt || 0);
      if (x.source === "seed") r.sample++; else r.live++;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.lastAt - a.lastAt; });
  }

  // Renaming to a name that already exists merges the two workflows.
  function renameWorkflow(current, from, to) {
    const name = String(to || "").trim().slice(0, 120);
    if (!name || name === from) return null;
    let s = 0, r = 0;
    const aiSessions = (current.aiSessions || []).map(function (x) { if (x.workflow === from) { s++; return Object.assign({}, x, { workflow: name }); } return x; });
    const rePrompts = (current.rePrompts || []).map(function (x) { if (x.workflow === from) { r++; return Object.assign({}, x, { workflow: name }); } return x; });
    const fileRuns = (current.fileRuns || []).map(function (x) { return x.workflow === from ? Object.assign({}, x, { workflow: name }) : x; });
    const exists = (current.aiSessions || []).concat(current.rePrompts || [], current.fileRuns || []).some(function (x) { return x.workflow === name; });
    return { aiSessions: aiSessions, rePrompts: rePrompts, fileRuns: fileRuns, sessions: s, rePromptCount: r, merged: exists };
  }

  // Gives every chat in one workflow its own workflow, named by tool and start time.
  function splitWorkflow(current, from) {
    const taken = (current.aiSessions || []).concat(current.rePrompts || []).map(function (x) { return x.workflow; }).filter(function (n) { return n !== from; });
    const names = {};
    const aiSessions = (current.aiSessions || []).map(function (x) {
      if (x.workflow !== from) return x;
      const name = uniqueName(autoWorkflowName(x.site, x.startedAt), taken);
      taken.push(name); names[x.id] = name;
      return Object.assign({}, x, { workflow: name });
    });
    const rePrompts = (current.rePrompts || []).map(function (x) {
      if (x.workflow !== from) return x;
      return names[x.sessionId] ? Object.assign({}, x, { workflow: names[x.sessionId] }) : x;
    });
    // a file stays with the chat that was most recent when it was saved
    const mine = (current.aiSessions || []).filter(function (x) { return names[x.id]; }).sort(function (a, b) { return a.startedAt - b.startedAt; });
    const fileRuns = (current.fileRuns || []).map(function (f) {
      if (f.workflow !== from || !mine.length) return f;
      let pick = mine[mine.length - 1];
      mine.forEach(function (x) { if (x.startedAt <= f.createdAt) pick = x; });
      return Object.assign({}, f, { workflow: names[pick.id] });
    });
    return { aiSessions: aiSessions, rePrompts: rePrompts, fileRuns: fileRuns, created: Object.keys(names).length };
  }

  // ---------------------------------------------------------------------------
  // File runs: the changes a person made to an AI-produced Excel, Word or PowerPoint file.
  // ---------------------------------------------------------------------------
  function sanitizeFileRun(raw) {
    if (!raw || typeof raw !== "object" || !str(raw.id, 60)) return null;
    const at = posNum(raw.createdAt);
    if (!at) return null;
    const type = ["xlsx", "docx", "pptx"].indexOf(raw.type) !== -1 ? raw.type : "xlsx";
    const changes = (Array.isArray(raw.changes) ? raw.changes : []).slice(0, 200).map(function (c) {
      return c && typeof c === "object" ? { addr: str(c.addr, 160), before: str(c.before, 160), after: str(c.after, 160) } : null;
    }).filter(Boolean);
    return {
      id: str(raw.id, 60), workflow: str(raw.workflow, 120), fileName: str(raw.fileName, 160), type: type,
      surface: type === "docx" ? "Word" : type === "pptx" ? "PowerPoint" : "Excel", createdAt: at,
      totalCells: Math.round(boundedNumber(raw.totalCells, 10000000)), changedCells: Math.round(boundedNumber(raw.changedCells, 10000000)),
      formulaEdits: Math.round(boundedNumber(raw.formulaEdits, 10000000)), unchangedPct: Math.min(100, Math.round(boundedNumber(raw.unchangedPct, 100))),
      estimatedMinutes: boundedNumber(raw.estimatedMinutes, 600), minutesSource: raw.minutesSource === "entered" ? "entered" : "estimated",
      elapsedSeconds: Math.round(boundedNumber(raw.elapsedSeconds, 1209600)), category: str(raw.category, 60),
      changes: changes, corrId: str(raw.corrId, 60), source: srcOf(raw),
    };
  }

  function rpSeconds(r) { return (r.reviewSeconds || 0) + (r.writeSeconds || 0) || (r.gapSeconds || 0); }

  // Everything about one workflow in order: chats, re-prompts, the output file, the person's edits, and the totals.
  function traceWorkflow(current, name) {
    const sessions = (current.aiSessions || []).filter(function (x) { return x.workflow === name; }).sort(function (a, b) { return a.startedAt - b.startedAt; });
    const rePrompts = (current.rePrompts || []).filter(function (x) { return x.workflow === name; }).sort(function (a, b) { return a.timestamp - b.timestamp; });
    const fileRuns = (current.fileRuns || []).filter(function (x) { return x.workflow === name; }).sort(function (a, b) { return a.createdAt - b.createdAt; });
    const sites = [];
    sessions.forEach(function (x) { if (sites.indexOf(x.site) === -1) sites.push(x.site); });
    rePrompts.forEach(function (x) { if (sites.indexOf(x.site) === -1) sites.push(x.site); });
    const attempts = sessions.reduce(function (n, x) { return n + (x.attempts || 0); }, 0);
    const promptSeconds = rePrompts.reduce(function (n, r) { return n + rpSeconds(r); }, 0);
    const editMinutes = fileRuns.reduce(function (n, f) { return n + (f.estimatedMinutes || 0); }, 0);
    const cells = fileRuns.reduce(function (n, f) { return n + (f.totalCells || 0); }, 0);
    const changed = fileRuns.reduce(function (n, f) { return n + Math.min(f.changedCells || 0, f.totalCells || 0); }, 0);
    return {
      name: name, sessions: sessions, rePrompts: rePrompts, fileRuns: fileRuns, sites: sites, attempts: attempts,
      promptMinutes: promptSeconds / 60, editMinutes: editMinutes, totalMinutes: promptSeconds / 60 + editMinutes,
      totalCells: cells, changedCells: changed, unchangedPct: cells ? Math.max(0, Math.round((1 - changed / cells) * 100)) : null,
      hasFile: fileRuns.length > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Teams and time series: who is fixing AI output, how much, and is it going down?
  // ---------------------------------------------------------------------------
  function weekStart(ts) {
    const d = new Date(ts); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  function addWeeks(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + 7 * n); return d.getTime(); }

  function teamOf(item, settings) {
    if (item && item.team) return item.team;
    const m = settings && settings.agentTeams;
    return (m && item && m[item.agent]) || "Unassigned";
  }
  function corrMinutes(c, basis) { return basis === "measured" ? (c.activeSeconds || 0) / 60 : (c.estimatedMinutes || 0); }

  // Buckets corrections, drafts and fixes into the given bucket start times (weeks or days).
  function bucketSeries(current, starts, labelOf, opts, partialLast) {
    const settings = current.settings || {}, group = opts.group || "total";
    const inTeam = function (x) { return !opts.team || teamOf(x, settings) === opts.team; };
    const corr = (current.corrections || []).filter(inTeam), sends = (current.sends || []).filter(inTeam), fixes = (current.fixes || []).filter(inTeam);
    const weeks = starts.map(function (t) { return { start: t, label: labelOf(t) }; });
    const idx = function (ts) {
      if (ts < starts[0]) return -1;
      let i = starts.length - 1;
      while (i > 0 && starts[i] > ts) i--;
      return i;
    };
    const endAll = starts[starts.length - 1] + (opts.bucketMs || 7 * DAY_MS);
    const map = {}, order = [];
    const row = function (key, team) {
      if (!map[key]) {
        const z = function () { return starts.map(function () { return 0; }); };
        map[key] = { key: key, team: team, corrections: z(), minutes: z(), drafts: z(), edited: z(), rate: [] };
        order.push(key);
      }
      return map[key];
    };
    const keyOf = function (x) { return group === "total" ? "All" : group === "team" ? teamOf(x, settings) : x.agent; };
    corr.forEach(function (c) { if (c.timestamp >= endAll) return; const i = idx(c.timestamp); if (i < 0) return; const r = row(keyOf(c), teamOf(c, settings)); r.corrections[i]++; r.minutes[i] += corrMinutes(c, opts.basis); });
    sends.forEach(function (x) { if (x.t >= endAll) return; const i = idx(x.t); if (i < 0) return; const r = row(keyOf(x), teamOf(x, settings)); r.drafts[i]++; if (x.category) r.edited[i]++; });
    if (!order.length) row(group === "total" ? "All" : "No data", "Unassigned");
    order.forEach(function (k) { const r = map[k]; r.rate = r.drafts.map(function (d, i) { return d ? r.edited[i] / d : null; }); });
    const events = fixes.map(function (f) { return { id: f.id, ts: f.approvedAt, week: idx(f.approvedAt), agent: f.agent, team: teamOf(f, settings), category: f.category, label: String(f.instruction || f.category).slice(0, 90) }; })
      .filter(function (e) { return e.week >= 0 && e.ts < endAll; }).sort(function (a, b) { return a.ts - b.ts; });
    return { weeks: weeks, series: order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.minutes.reduce(sum, 0) - a.minutes.reduce(sum, 0); }), events: events, partialLast: partialLast };
  }

  const WEEK_LABEL = function (t) { return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  const DAY_LABEL = function (t) { const d = new Date(t); return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate(); };

  // opts: { now, weeks (max, default 26), group: "total" | "team" | "agent", team (filter), basis }
  function weeklySeries(current, opts) {
    opts = opts || {};
    const settings = current.settings || {}, now = opts.now || Date.now(), maxWeeks = opts.weeks || 26;
    const inTeam = function (x) { return !opts.team || teamOf(x, settings) === opts.team; };
    const last = weekStart(now);
    let first = Infinity;
    (current.corrections || []).filter(inTeam).forEach(function (c) { first = Math.min(first, c.timestamp); });
    (current.sends || []).filter(inTeam).forEach(function (x) { first = Math.min(first, x.t); });
    const floor = addWeeks(last, -(maxWeeks - 1));
    first = isFinite(first) ? Math.max(weekStart(first), floor) : last;
    const starts = [];
    for (let t = first; t <= last; t = addWeeks(t, 1)) starts.push(t);
    return bucketSeries(current, starts, WEEK_LABEL, opts, starts[starts.length - 1] + 7 * DAY_MS > now);
  }

  // ---------------------------------------------------------------------------
  // Time periods: last week, last 4 weeks, last 13 weeks, everything, or chosen dates
  // ---------------------------------------------------------------------------
  function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }

  // preset: "week" | "4w" | "13w" | "all" | "custom".  opts: { first (earliest data), from, to (dates for custom) }
  function periodRange(preset, now, opts) {
    opts = opts || {};
    const wk = weekStart(now);
    let from, to, bucket = "week", label, prevLabel;
    if (preset === "week") { from = addWeeks(wk, -1); to = wk; bucket = "day"; label = "last week"; prevLabel = "the week before"; }
    else if (preset === "4w") { from = addWeeks(wk, -4); to = wk; label = "the last 4 weeks"; prevLabel = "the 4 weeks before"; }
    else if (preset === "13w") { from = addWeeks(wk, -12); to = now + 1; label = "the last 13 weeks"; prevLabel = "the 13 weeks before"; }
    else if (preset === "custom") {
      let f = startOfDay(opts.from || now), t = startOfDay(opts.to || now);
      if (t < f) { const x = f; f = t; t = x; }
      from = f; to = addDays(t, 1);
      bucket = (to - from) <= 21 * DAY_MS ? "day" : "week"; label = "the chosen dates"; prevLabel = "the same length of time before";
    } else {
      from = weekStart(isFinite(opts.first) ? opts.first : now); to = now + 1; label = "all time"; prevLabel = "";
    }
    const prevFrom = preset === "all" ? null : preset === "week" ? addWeeks(from, -1) : preset === "4w" ? addWeeks(from, -4) : preset === "13w" ? addWeeks(from, -13) : from - (to - from);
    return { preset: preset || "all", from: from, to: to, prevFrom: prevFrom, prevTo: preset === "all" ? null : from, bucket: bucket, label: label, prevLabel: prevLabel, weeks: Math.max((to - from) / (7 * DAY_MS), 1 / 7) };
  }

  function periodSeries(current, range, opts) {
    opts = Object.assign({}, opts || {});
    const starts = [];
    if (range.bucket === "day") for (let t = startOfDay(range.from); t < range.to; t = addDays(t, 1)) starts.push(t);
    else for (let t = weekStart(range.from); t < range.to; t = addWeeks(t, 1)) starts.push(t);
    if (!starts.length) starts.push(startOfDay(range.from));
    opts.bucketMs = range.bucket === "day" ? DAY_MS : 7 * DAY_MS;
    const now = opts.now || Date.now();
    const lastEnd = starts[starts.length - 1] + opts.bucketMs;
    return bucketSeries(current, starts, range.bucket === "day" ? DAY_LABEL : WEEK_LABEL, opts, lastEnd > now);
  }

  // Totals for a period and the period right before it.
  function periodSummary(current, range, opts) {
    opts = opts || {};
    const settings = current.settings || {}, rate = opts.hourlyRate || 60;
    const inTeam = function (x) { return !opts.team || teamOf(x, settings) === opts.team; };
    const tally = function (a, b) {
      const o = { minutes: 0, corrections: 0, drafts: 0, edited: 0 };
      if (a === null) return o;
      (current.corrections || []).forEach(function (c) { if (c.timestamp >= a && c.timestamp < b && inTeam(c)) { o.corrections++; o.minutes += corrMinutes(c, opts.basis); } });
      (current.sends || []).forEach(function (x) { if (x.t >= a && x.t < b && inTeam(x)) { o.drafts++; if (x.category) o.edited++; } });
      return o;
    };
    const cur = tally(range.from, range.to), prev = tally(range.prevFrom, range.prevTo);
    const hours = cur.minutes / 60, prevHours = prev.minutes / 60, perWeek = hours / range.weeks;
    const rateOf = function (o) { return o.drafts ? o.edited / o.drafts : null; };
    const baseline = opts.baselineHours > 0 ? opts.baselineHours : null;
    const saved = baseline !== null ? Math.max(0, baseline - perWeek) : 0;
    const pushed = (current.fixes || []).filter(function (f) { return inTeam(f) && f.approvedAt >= range.from && f.approvedAt < range.to; });
    return {
      hours: hours, prevHours: prevHours, hoursChange: range.prevFrom !== null && prevHours > 0 ? (hours - prevHours) / prevHours : null, perWeekHours: perWeek,
      corrections: cur.corrections, prevCorrections: prev.corrections, drafts: cur.drafts, rate: rateOf(cur), prevRate: rateOf(prev),
      ratePoints: rateOf(cur) !== null && rateOf(prev) !== null ? rateOf(cur) - rateOf(prev) : null, hasPrev: range.prevFrom !== null && prev.drafts > 0,
      baselineHours: baseline, weeklyHoursSaved: saved, annualSavings: saved * 52 * rate, hourlyRate: rate, fixesPushed: pushed.length, pushed: pushed,
    };
  }

  // When did weekly hours first drop to the target and stay there? (complete weeks only)
  function targetStatus(ser, target, opts) {
    opts = opts || {};
    const n = ser.minutes.length - (opts.keepPartial ? 0 : 1);
    const hours = ser.minutes.slice(0, Math.max(n, 0)).map(function (m) { return m / 60; });
    const out = { target: target, reachedIndex: -1, reachedStart: null, current: hours.length ? hours[hours.length - 1] : null, startedAbove: hours.length ? hours[0] > target : false };
    if (!hours.length || !(target > 0)) return out;
    for (let i = 0; i < hours.length; i++) {
      if (hours[i] <= target && (i + 1 >= hours.length || hours[i + 1] <= target) && hours.slice(0, i).some(function (h) { return h > target; })) { out.reachedIndex = i; break; }
    }
    return out;
  }

  function sum(a, b) { return a + b; }
  function mean(arr) { return arr.length ? arr.reduce(sum, 0) / arr.length : 0; }

  // The headline for executives: first weeks versus the most recent complete weeks.
  function execSummary(ser, opts) {
    opts = opts || {};
    const rate = opts.hourlyRate || 60;
    const n = ser.minutes.length - (opts.keepPartial ? 0 : 1);
    const k = Math.min(opts.k || 3, Math.floor(n / 2));
    if (n < 4 || k < 1) return { enough: false, weeks: Math.max(n, 0) };
    const hours = ser.minutes.map(function (m) { return m / 60; });
    const part = function (arr, a, b) { return arr.slice(a, b); };
    const baseH = mean(part(hours, 0, k)), curH = mean(part(hours, n - k, n));
    const rateOf = function (a, b) { const d = part(ser.drafts, a, b).reduce(sum, 0), e = part(ser.edited, a, b).reduce(sum, 0); return d ? e / d : null; };
    const baseR = rateOf(0, k), curR = rateOf(n - k, n);
    const saved = Math.max(0, baseH - curH);
    return {
      enough: true, k: k, weeks: n, baselineHours: baseH, currentHours: curH, changePct: baseH ? (curH - baseH) / baseH : 0,
      baselineRate: baseR, currentRate: curR, ratePoints: baseR !== null && curR !== null ? curR - baseR : null,
      baselineCorrections: mean(part(ser.corrections, 0, k)), currentCorrections: mean(part(ser.corrections, n - k, n)),
      weeklyHoursSaved: saved, annualSavings: saved * 52 * rate, hourlyRate: rate,
    };
  }

  // Teams, and the sub-agents inside them, over the last few complete weeks versus the first few.
  function teamRollup(current, opts) {
    opts = opts || {};
    const settings = current.settings || {}, W = opts.windowWeeks || 4;
    const ag = weeklySeries(current, { group: "agent", now: opts.now, basis: opts.basis, weeks: opts.weeks });
    const n = ag.weeks.length - (ag.partialLast ? 1 : 0);
    const w = Math.max(1, Math.min(W, Math.floor(n / 2)));
    const win = function (arr, a, b) { return arr.slice(a, b).reduce(sum, 0); };
    const cutFrom = n > 0 ? ag.weeks[Math.max(0, n - w)].start : 0, cutTo = ag.weeks.length ? addWeeks(ag.weeks[n - 1 > 0 ? n - 1 : 0].start, 1) : 0;
    const topCategory = function (agent) {
      const by = {};
      (current.corrections || []).forEach(function (c) { if (c.agent === agent && c.timestamp >= cutFrom && c.timestamp < cutTo) by[c.category] = (by[c.category] || 0) + corrMinutes(c, opts.basis); });
      const k = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; })[0];
      return k || "";
    };
    const R = opts.range || null, tally = {};
    if (R) {
      const bump = function (a) { return tally[a] || (tally[a] = { dC: 0, eC: 0, hC: 0, c: 0, dB: 0, eB: 0, hB: 0 }); };
      (current.corrections || []).forEach(function (c) {
        const m = corrMinutes(c, opts.basis) / 60;
        if (c.timestamp >= R.from && c.timestamp < R.to) { const t = bump(c.agent); t.c++; t.hC += m; }
        else if (R.prevFrom !== null && c.timestamp >= R.prevFrom && c.timestamp < R.prevTo) bump(c.agent).hB += m;
      });
      (current.sends || []).forEach(function (x) {
        if (x.t >= R.from && x.t < R.to) { const t = bump(x.agent); t.dC++; if (x.category) t.eC++; }
        else if (R.prevFrom !== null && x.t >= R.prevFrom && x.t < R.prevTo) { const t = bump(x.agent); t.dB++; if (x.category) t.eB++; }
      });
    }
    const stat = function (s) {
      if (R) {
        const t = tally[s.key] || { dC: 0, eC: 0, hC: 0, c: 0, dB: 0, eB: 0, hB: 0 };
        return { drafts: t.dC, corrections: t.c, hours: t.hC, rate: t.dC ? t.eC / t.dC : null, baselineHours: t.hB, baselineRate: t.dB ? t.eB / t.dB : null,
          changePct: t.hB ? (t.hC - t.hB) / t.hB : null, spark: s.minutes.slice(0, n).map(function (m) { return m / 60; }) };
      }
      const dB = win(s.drafts, 0, w), eB = win(s.edited, 0, w), dC = win(s.drafts, n - w, n), eC = win(s.edited, n - w, n);
      const hB = win(s.minutes, 0, w) / 60, hC = win(s.minutes, n - w, n) / 60;
      return { drafts: dC, corrections: win(s.corrections, n - w, n), hours: hC, rate: dC ? eC / dC : null, baselineHours: hB, baselineRate: dB ? eB / dB : null,
        changePct: hB ? (hC - hB) / hB : null, spark: s.minutes.slice(0, n).map(function (m) { return m / 60; }) };
    };
    const teams = {};
    ag.series.forEach(function (s) {
      const t = s.team || "Unassigned";
      if (!teams[t]) teams[t] = { name: t, agents: [], sparkMinutes: s.minutes.map(function () { return 0; }), acc: { dB: 0, eB: 0, dC: 0, eC: 0, hB: 0, hC: 0, c: 0 } };
      const st = stat(s); st.name = s.key; st.topCategory = topCategory(s.key);
      st.fixes = (current.fixes || []).filter(function (f) { return f.agent === s.key; }).length;
      teams[t].agents.push(st);
      s.minutes.forEach(function (m, i) { teams[t].sparkMinutes[i] += m; });
      const a = teams[t].acc;
      if (R) { const tt = tally[s.key] || { dC: 0, eC: 0, dB: 0, eB: 0 }; a.dB += tt.dB; a.eB += tt.eB; a.dC += tt.dC; a.eC += tt.eC; }
      else { a.dB += win(s.drafts, 0, w); a.eB += win(s.edited, 0, w); a.dC += win(s.drafts, n - w, n); a.eC += win(s.edited, n - w, n); }
      a.hB += st.baselineHours; a.hC += st.hours; a.c += st.corrections;
    });
    const out = Object.keys(teams).map(function (t) {
      const g = teams[t], a = g.acc;
      g.agents.sort(function (x, y) { return y.hours - x.hours; });
      return { name: t, agents: g.agents, drafts: a.dC, corrections: a.c, hours: a.hC, baselineHours: a.hB, rate: a.dC ? a.eC / a.dC : null, baselineRate: a.dB ? a.eB / a.dB : null,
        changePct: a.hB ? (a.hC - a.hB) / a.hB : null, spark: g.sparkMinutes.slice(0, n).map(function (m) { return m / 60; }), fixes: g.agents.reduce(function (x, y) { return x + y.fixes; }, 0) };
    }).sort(function (a, b) { return b.hours - a.hours; });
    return { teams: out, weeks: ag.weeks, windowWeeks: w, completeWeeks: n, label: R ? R.label : "the last " + w + " weeks", compareLabel: R ? (R.prevLabel || "") : "the first " + w + " weeks", ranged: !!R };
  }

  // How much each rolled-out fix reduced the corrections it targeted (4 weeks before versus up to 4 weeks after),
  // and when those corrections first stayed under the goal (default: half the "before" level).
  function fixEffects(current, opts) {
    opts = opts || {};
    const now = opts.now || Date.now(), span = 28 * DAY_MS, settings = current.settings || {}, goal = opts.targetPct || 0.5, lastComplete = weekStart(now);
    return (current.fixes || []).slice().sort(function (a, b) { return a.approvedAt - b.approvedAt; }).map(function (f) {
      const mine = (current.corrections || []).filter(function (c) { return c.agent === f.agent && c.category === f.category; });
      const before = mine.filter(function (c) { return c.timestamp >= f.approvedAt - span && c.timestamp < f.approvedAt; }).length / 4;
      const afterDays = Math.min(span, now - f.approvedAt);
      const after = afterDays >= 7 * DAY_MS ? mine.filter(function (c) { return c.timestamp >= f.approvedAt && c.timestamp < f.approvedAt + span; }).length / (afterDays / (7 * DAY_MS)) : null;
      // weekly counts for each complete week after the push
      let reachedAt = null, weeksToGoal = null;
      if (before >= 1) {
        const limit = before * (1 - goal), pushWeek = weekStart(f.approvedAt), counts = [];
        for (let w = addWeeks(pushWeek, 1); addWeeks(w, 1) <= lastComplete; w = addWeeks(w, 1)) {
          const e = addWeeks(w, 1);
          counts.push({ start: w, n: mine.filter(function (c) { return c.timestamp >= w && c.timestamp < e; }).length });
        }
        for (let i = 0; i < counts.length; i++) {
          if (counts[i].n <= limit && (i + 1 >= counts.length || counts[i + 1].n <= limit)) { reachedAt = counts[i].start; weeksToGoal = i + 1; break; }
        }
      }
      return { fix: f, team: teamOf(f, settings), pushedAt: f.approvedAt, beforePerWeek: before, afterPerWeek: after, changePct: after !== null && before > 0 ? (after - before) / before : null, pending: after === null, reachedAt: reachedAt, weeksToGoal: weeksToGoal, goalPct: goal };
    });
  }

  // ---------------------------------------------------------------------------
  // One workflow: its team, and the fixes worth making for it
  // ---------------------------------------------------------------------------
  function workflowTeam(current, name) {
    const settings = current.settings || {};
    if (settings.workflowTeams && settings.workflowTeams[name]) return settings.workflowTeams[name];
    const sites = {};
    (current.aiSessions || []).concat(current.rePrompts || []).forEach(function (x) { if (x.workflow === name && x.site) sites[x.site] = (sites[x.site] || 0) + 1; });
    const top = Object.keys(sites).sort(function (a, b) { return sites[b] - sites[a]; })[0];
    return top ? teamOf({ agent: top }, settings) : "Unassigned";
  }

  const THEMES = {
    "Length": { title: "People keep asking for a shorter version", rule: "Keep drafts short: cut introductions, repetition and filler, and stop at the length people end up asking for.", route: ROUTES.INSTRUCTION },
    "Formatting": { title: "People keep changing the format", rule: "Use the team's preferred format (for example short paragraphs instead of bullets) from the first draft.", route: ROUTES.INSTRUCTION },
    "Style and tone": { title: "People keep rewriting the tone", rule: "Use a neutral, professional tone. Avoid stacked adjectives, intensifiers and informal phrases.", route: ROUTES.INSTRUCTION },
    "Terminology": { title: "The agent uses different terms from the team", rule: "Add a glossary to the instructions and always use the team's defined terms.", route: ROUTES.INSTRUCTION },
    "Required wording": { title: "Required wording keeps getting changed", rule: "Include the required wording exactly as approved (for example the standard disclaimer) and never reword it.", route: ROUTES.INSTRUCTION },
    "Facts and missing content": { title: "People keep adding or correcting facts", rule: "Take facts from the approved source and include the items people keep adding, instead of writing from memory.", route: ROUTES.ENGINEERING },
  };
  const FILE_THEMES = {};
  FILE_THEMES[CATEGORIES.FACTUAL] = { title: "Numbers are being corrected by hand", rule: "Connect the figures in this deliverable to the source data, and recheck every number against it before the draft is shown.", route: ROUTES.ENGINEERING };
  FILE_THEMES[CATEGORIES.CONTENT] = { title: "Content is being added or removed by hand", rule: "Include the content people keep adding by hand, and check the required sections before finishing the draft.", route: ROUTES.INSTRUCTION };
  FILE_THEMES[CATEGORIES.TERM] = { title: "Wording is being changed to the team's terms", rule: "Add a glossary to the instructions and always use the defined terms.", route: ROUTES.INSTRUCTION };
  FILE_THEMES[CATEGORIES.TONE] = { title: "Tone is being rewritten by hand", rule: "Use a concise, neutral, client-ready tone and follow the house style.", route: ROUTES.INSTRUCTION };

  // Plain-English description of a re-prompt that does not quote anyone.
  function themeWording(category) {
    const map = { "Length": "Asked for a shorter version", "Formatting": "Asked to change the format", "Style and tone": "Asked to change the tone or style", "Terminology": "Asked to use different terms",
      "Required wording": "Asked to restore required wording", "Facts and missing content": "Asked to correct or add facts" };
    map[PROMPT_CATS.REGEN] = "Regenerated without instructions"; map[PROMPT_CATS.UNSORTED] = "Follow-up request"; map[PROMPT_CATS.PASTE] = "Pasted material";
    return map[category] || "Follow-up request";
  }

  // "You" stays "You"; everyone else becomes Person A, Person B... so a leader sees patterns, not people.
  function personLabels(rePrompts) {
    const out = {}; let n = 0;
    (rePrompts || []).forEach(function (r) {
      const u = r.user || "You";
      if (out[u]) return;
      out[u] = u === "You" ? "You" : "Person " + String.fromCharCode(65 + (n++ % 26));
    });
    return out;
  }

  function workflowFixes(current, name, opts) {
    opts = opts || {};
    const t = traceWorkflow(current, name), out = [];
    const by = {};
    t.rePrompts.forEach(function (r) {
      if (r.kind === "regen" || isMaterialOnly(r) || !r.category || r.category === PROMPT_CATS.UNSORTED) return;
      const g = by[r.category] || (by[r.category] = { count: 0, seconds: 0, users: {} });
      g.count++; g.seconds += rpSeconds(r); g.users[r.user || "You"] = 1;
    });
    Object.keys(by).forEach(function (cat) {
      const g = by[cat], th = THEMES[cat];
      if (!th) return;
      out.push({ key: "rp|" + cat, source: "re-prompts", category: cat, title: th.title, route: th.route, rule: th.rule, count: g.count, people: Object.keys(g.users).length, minutes: g.seconds / 60,
        evidence: g.count + (g.count === 1 ? " re-prompt" : " re-prompts") + " by " + Object.keys(g.users).length + (Object.keys(g.users).length === 1 ? " person" : " people") });
    });
    const fb = {};
    t.fileRuns.forEach(function (f) {
      if (!f.category || !f.changedCells) return;
      const g = fb[f.category] || (fb[f.category] = { cells: 0, minutes: 0, files: 0 });
      g.cells += f.changedCells; g.minutes += f.estimatedMinutes || 0; g.files++;
    });
    Object.keys(fb).forEach(function (cat) {
      const g = fb[cat], th = FILE_THEMES[cat];
      if (!th) return;
      out.push({ key: "file|" + cat, source: "file edits", category: cat, title: th.title, route: routeFor(cat, g.cells), rule: th.rule, count: g.cells, people: 0, minutes: g.minutes,
        evidence: g.cells + (g.cells === 1 ? " change" : " changes") + " made by hand to the output file" + (g.files > 1 ? "s" : "") });
    });
    out.sort(function (a, b) { return b.minutes - a.minutes; });
    return out.slice(0, opts.limit || 6);
  }

  // Every workflow with its team, tools, people and human time, in one pass over the data.
  function workflowIndex(current) {
    const settings = current.settings || {}, map = {};
    const row = function (n) { return map[n] || (map[n] = { name: n, sessions: 0, attempts: 0, rePrompts: 0, files: 0, lastAt: 0, live: 0, sample: 0, sites: {}, people: {}, minutes: 0 }); };
    (current.aiSessions || []).forEach(function (x) {
      const r = row(x.workflow); r.sessions++; r.attempts += x.attempts || 0; r.lastAt = Math.max(r.lastAt, x.lastAt || 0);
      if (x.site) r.sites[x.site] = (r.sites[x.site] || 0) + 1;
      if (x.source === "seed") r.sample++; else r.live++;
    });
    (current.rePrompts || []).forEach(function (x) {
      const r = row(x.workflow); r.rePrompts++; r.minutes += rpSeconds(x) / 60; r.lastAt = Math.max(r.lastAt, x.timestamp || 0); r.people[x.user || "You"] = 1;
      if (x.site) r.sites[x.site] = (r.sites[x.site] || 0) + 1;
      if (x.source === "seed") r.sample++; else r.live++;
    });
    (current.fileRuns || []).forEach(function (x) {
      const r = row(x.workflow || "Unlinked files"); r.files++; r.minutes += x.estimatedMinutes || 0; r.lastAt = Math.max(r.lastAt, x.createdAt || 0);
      if (x.source === "seed") r.sample++; else r.live++;
    });
    return Object.keys(map).map(function (k) {
      const r = map[k], sites = Object.keys(r.sites).sort(function (a, b) { return r.sites[b] - r.sites[a]; });
      r.tools = sites; r.peopleCount = Object.keys(r.people).length;
      r.team = settings.workflowTeams && settings.workflowTeams[k] ? settings.workflowTeams[k] : sites.length ? teamOf({ agent: sites[0] }, settings) : "Unassigned";
      return r;
    }).sort(function (a, b) { return b.lastAt - a.lastAt; });
  }

  const api = {
    CATEGORIES: CATEGORIES,
    ROUTES: ROUTES,
    analyzeEdit: analyzeEdit,
    estimateMinutes: estimateMinutes,
    applyPrivacy: applyPrivacy,
    routeFor: routeFor,
    proposalFor: proposalFor,
    buildPatterns: buildPatterns,
    rankOpenPatterns: rankOpenPatterns,
    beforeAfter: beforeAfter,
    normalizeText: normalizeText,
    PROMPT_CATS: PROMPT_CATS,
    classifyPrompt: classifyPrompt,
    splitPrompt: splitPrompt,
    instructionOf: instructionOf,
    isMaterialOnly: isMaterialOnly,
    draftRule: draftRule,
    recategorize: recategorize,
    redactPrompt: redactPrompt,
    buildRePrompt: buildRePrompt,
    clusterPrompts: clusterPrompts,
    summarizePromptClusters: summarizePromptClusters,
    newAiSession: newAiSession,
    applyAiEvent: applyAiEvent,
    aiSessionExpired: aiSessionExpired,
    summarizeAiSessions: summarizeAiSessions,
    AI_IDLE_MS: AI_IDLE_MS,
    periodRange: periodRange,
    periodSeries: periodSeries,
    periodSummary: periodSummary,
    targetStatus: targetStatus,
    workflowTeam: workflowTeam,
    workflowIndex: workflowIndex,
    workflowFixes: workflowFixes,
    themeWording: themeWording,
    personLabels: personLabels,
    weekStart: weekStart,
    addWeeks: addWeeks,
    teamOf: teamOf,
    weeklySeries: weeklySeries,
    execSummary: execSummary,
    teamRollup: teamRollup,
    fixEffects: fixEffects,
    sanitizeFileRun: sanitizeFileRun,
    traceWorkflow: traceWorkflow,
    autoWorkflowName: autoWorkflowName,
    uniqueName: uniqueName,
    listWorkflows: listWorkflows,
    renameWorkflow: renameWorkflow,
    splitWorkflow: splitWorkflow,
    sanitizeAiSession: sanitizeAiSession,
    sanitizeRePrompt: sanitizeRePrompt,
    sanitizeFix: sanitizeFix,
    sanitizeSettings: sanitizeSettings,
    extractData: extractData,
    buildExport: buildExport,
    planImport: planImport,
    removeSample: removeSample,
    sampleCounts: sampleCounts,
    sanitizeCorrection: sanitizeCorrection,
    sanitizeSend: sanitizeSend,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldAnalysis = api;
})(typeof self !== "undefined" ? self : globalThis);
