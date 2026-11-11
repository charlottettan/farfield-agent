/*
 * Pure logic for the Word/Excel add-in. No Office.js calls in here, so it can be tested
 * outside Office. Two Excel modes share it:
 *   - snapshot mode: compare "before" and "after" grids (also used by Word text compare)
 *   - live mode: a session holds the AI-generated baseline and is updated as cells change
 *
 * Cell contents are what is TYPED: the formula for formula cells, the constant otherwise.
 * That way formula edits are caught even when the displayed result is unchanged, and cells
 * that merely recalculate are not mistaken for human edits.
 */
(function (root) {
  "use strict";

  const A = root.FarfieldAnalysis || (typeof require !== "undefined" ? require("./analysis.js") : null);
  const SEP = "\u0001"; // separates sheet name from cell coordinates inside keys

  function colName(c) {
    let n = c + 1;
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function keyOf(sheet, r, c) {
    return sheet + SEP + r + "," + c;
  }

  function parseKey(key) {
    const i = key.indexOf(SEP);
    const sheet = key.slice(0, i);
    const rc = key.slice(i + 1).split(",").map(Number);
    return { sheet: sheet, r: rc[0], c: rc[1] };
  }

  function typed(v) {
    return v === null || v === undefined ? "" : String(v);
  }

  function makeChange(key, before, after) {
    const p = parseKey(key);
    return {
      sheet: p.sheet,
      r: p.r,
      c: p.c,
      addr: (p.sheet ? p.sheet + "!" : "") + colName(p.c) + (p.r + 1),
      before: before,
      after: after,
    };
  }

  function sortChanges(changes) {
    return changes.sort(function (a, b) {
      return a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : a.r - b.r || a.c - b.c;
    });
  }

  // ---------------------------------------------------------------------------
  // Snapshot mode
  // ---------------------------------------------------------------------------
  function toMap(snap, sheet) {
    const m = {};
    (snap.values || []).forEach(function (row, ri) {
      row.forEach(function (v, ci) {
        const s = typed(v);
        if (s !== "") m[keyOf(sheet || "", snap.r0 + ri, snap.c0 + ci)] = s;
      });
    });
    return m;
  }

  function excelChanges(before, after) {
    const b = toMap(before);
    const a = toMap(after);
    const keys = {};
    Object.keys(b).forEach(function (k) { keys[k] = true; });
    Object.keys(a).forEach(function (k) { keys[k] = true; });
    const changes = [];
    Object.keys(keys).forEach(function (k) {
      const x = b[k] || "";
      const y = a[k] || "";
      if (x !== y) changes.push(makeChange(k, x, y));
    });
    return sortChanges(changes);
  }

  // ---------------------------------------------------------------------------
  // Live mode
  // ---------------------------------------------------------------------------
  function newSession(id, agent, baseMap, sheetIds) {
    const cur = {};
    Object.keys(baseMap).forEach(function (k) { cur[k] = baseMap[k]; });
    return {
      id: id,
      agent: agent,
      host: "Excel",
      status: "active",
      startedAt: Date.now(),
      base: baseMap,
      cur: cur,
      ids: sheetIds || {},
      changed: {},
      flags: [],
      reviewed: {},
      activeMs: 0,
      last: null,
      total: Object.keys(baseMap).length,
    };
  }

  // Apply a freshly read grid (typed contents) for one sheet region to the session.
  function applyRange(session, sheet, r0, c0, grid) {
    grid.forEach(function (row, ri) {
      row.forEach(function (v, ci) {
        const key = keyOf(sheet, r0 + ri, c0 + ci);
        const s = typed(v);
        if (s === "") delete session.cur[key];
        else session.cur[key] = s;
        if ((session.base[key] || "") !== (session.cur[key] || "")) session.changed[key] = true;
        else delete session.changed[key];
      });
    });
  }

  function sessionChanges(session) {
    return sortChanges(
      Object.keys(session.changed).map(function (k) {
        return makeChange(k, session.base[k] || "", session.cur[k] || "");
      })
    );
  }

  function markReviewed(session, sheet, r0, c0, rows, cols, cap) {
    const limit = cap || 10000;
    let added = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (added >= limit) return added;
        const key = keyOf(sheet, r0 + r, c0 + c);
        if (!session.reviewed[key]) {
          session.reviewed[key] = 1;
          added++;
        }
      }
    }
    return added;
  }

  function reviewStats(session) {
    const baseKeys = Object.keys(session.base);
    let reviewed = 0;
    baseKeys.forEach(function (k) {
      if (session.reviewed[k]) reviewed++;
    });
    const total = baseKeys.length;
    return {
      totalCells: total,
      reviewedCells: reviewed,
      coveragePct: total ? Math.round((reviewed / total) * 100) : 0,
      flaggedCount: session.flags.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Building records (same shape the Gmail extension writes)
  // ---------------------------------------------------------------------------
  function makeRecords(analysis, snippets, ctx, surface) {
    const now = ctx.now || Date.now();
    const privacy = ctx.privacy || "full";
    const agent = ctx.agent || "Unassigned agent";
    const activeSeconds = Math.round(ctx.activeSeconds || 0);

    let correction = null;
    if (analysis) {
      correction = {
        id: "o_" + now + "_" + Math.random().toString(36).slice(2, 8),
        timestamp: now,
        agent: agent,
        category: analysis.category,
        surface: surface,
        subject: "",
        originalSnippet: A.applyPrivacy(snippets.original, privacy),
        editedSnippet: A.applyPrivacy(snippets.edited, privacy),
        wordsAdded: analysis.wordsAdded,
        wordsRemoved: analysis.wordsRemoved,
        estimatedMinutes: analysis.estimatedMinutes,
        activeSeconds: activeSeconds,
        timeSource: "measured+estimated",
        termsAdded: privacy === "full" ? analysis.termsAdded : [],
        termsRemoved: privacy === "full" ? analysis.termsRemoved : [],
        source: "live",
      };
      if (ctx.review) {
        correction.flaggedCount = ctx.review.flaggedCount;
        correction.reviewedCells = ctx.review.reviewedCells;
        correction.totalCells = ctx.review.totalCells;
      }
    }
    const send = { t: now, agent: agent, category: analysis ? analysis.category : null, surface: surface };
    return { correction: correction, send: send };
  }

  function cellList(changes, key) {
    const shown = changes.slice(0, 4).map(function (c) {
      return c.addr + ": " + (c[key] === "" ? "(empty)" : c[key]);
    });
    return shown.join(" · ") + (changes.length > 4 ? " · +" + (changes.length - 4) + " more cells" : "");
  }

  function buildExcelCorrectionFromChanges(changes, ctx) {
    if (changes.length === 0) return makeRecords(null, null, ctx, "Excel");

    const originalText = changes.map(function (c) { return c.before; }).join(" ");
    const editedText = changes.map(function (c) { return c.after; }).join(" ");
    const analysis = A.analyzeEdit(originalText, editedText);

    // Any change that involves a formula is a logic/calculation fix, so treat it as Factual/Data.
    const formulaEdits = changes.filter(function (c) {
      return c.before.charAt(0) === "=" || c.after.charAt(0) === "=";
    }).length;
    if (formulaEdits > 0 && analysis.category !== A.CATEGORIES.FACTUAL) {
      analysis.category = A.CATEGORIES.FACTUAL;
      analysis.estimatedMinutes = A.estimateMinutes(analysis.category, analysis.wordsAdded, analysis.wordsRemoved);
    }

    const snippets = { original: cellList(changes, "before"), edited: cellList(changes, "after") };
    const out = makeRecords(analysis, snippets, ctx, "Excel");
    out.changedCells = changes.length;
    out.formulaEdits = formulaEdits;
    return out;
  }

  function buildExcelCorrection(before, after, ctx) {
    return buildExcelCorrectionFromChanges(excelChanges(before, after), ctx);
  }

  function buildWordCorrection(original, current, ctx) {
    const a = A.normalizeText(original);
    const b = A.normalizeText(current);
    if (a === b) return makeRecords(null, null, ctx, "Word");
    const analysis = A.analyzeEdit(a, b);
    return makeRecords(analysis, { original: analysis.originalSnippet, edited: analysis.editedSnippet }, ctx, "Word");
  }

  // Heuristic: files written by code libraries carry the library name as the author.
  function looksMachineGenerated(author) {
    return /openpyxl|xlsxwriter|python-docx|pandas|apache poi|sheetjs|exceljs/i.test(String(author || ""));
  }

  const api = {
    colName: colName,
    keyOf: keyOf,
    parseKey: parseKey,
    excelChanges: excelChanges,
    newSession: newSession,
    applyRange: applyRange,
    sessionChanges: sessionChanges,
    markReviewed: markReviewed,
    reviewStats: reviewStats,
    buildExcelCorrection: buildExcelCorrection,
    buildExcelCorrectionFromChanges: buildExcelCorrectionFromChanges,
    buildWordCorrection: buildWordCorrection,
    looksMachineGenerated: looksMachineGenerated,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldOffice = api;
})(typeof self !== "undefined" ? self : globalThis);
