/*
 * Reads Excel (.xlsx), Word (.docx) and PowerPoint (.pptx) files on this device and works out what a person changed
 * between the version an AI produced and their final version. Only the list of changes is ever saved, never the files.
 */
(function (root) {
  "use strict";
  var A = root.FarfieldAnalysis || (typeof require !== "undefined" ? require("./analysis.js") : null);
  var L = root.FarfieldOffice || (typeof require !== "undefined" ? require("./office-logic.js") : null);
  var MAX_CHANGES_SAVED = 200;

  // ------------------------------------------------------------------ zip
  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
  async function defaultInflate(bytes) {
    var ds = new root.DecompressionStream("deflate-raw");
    var w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new root.Response(ds.readable).arrayBuffer());
  }
  // Returns { name: text } for every entry the predicate accepts.
  async function unzipEntries(buffer, accept, inflate) {
    var inf = inflate || defaultInflate, d = new Uint8Array(buffer), eocd = -1;
    for (var i = d.length - 22; i >= Math.max(0, d.length - 70000); i--) { if (u32(d, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("This does not look like an Office file (it is not a zip archive).");
    var count = u16(d, eocd + 10), off = u32(d, eocd + 16), dec = new root.TextDecoder("utf-8"), out = {};
    for (var n = 0; n < count; n++) {
      if (u32(d, off) !== 0x02014b50) throw new Error("The file is damaged.");
      var method = u16(d, off + 10), csize = u32(d, off + 20), nlen = u16(d, off + 28), xlen = u16(d, off + 30), clen = u16(d, off + 32), lho = u32(d, off + 42);
      var name = dec.decode(d.subarray(off + 46, off + 46 + nlen));
      off += 46 + nlen + xlen + clen;
      if (!accept(name)) continue;
      var start = lho + 30 + u16(d, lho + 26) + u16(d, lho + 28), comp = d.subarray(start, start + csize);
      var raw = method === 0 ? comp : method === 8 ? await inf(comp) : null;
      if (!raw) throw new Error("This file uses a compression method that cannot be read here.");
      out[name] = dec.decode(raw);
    }
    return out;
  }

  // ------------------------------------------------------------------ xml helpers (no DOM needed)
  function decodeXml(s) {
    return String(s).replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(Number(d)); })
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  function attr(tag, name) { var m = new RegExp("(?:^|\\s)" + name + '="([^"]*)"').exec(tag); return m ? decodeXml(m[1]) : null; }
  function textRuns(xml) {
    var out = "", re = /<(?:[a-z]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-z]+:)?t>/g, m;
    while ((m = re.exec(xml))) out += decodeXml(m[1]);
    return out;
  }
  function modifiedOf(files) {
    var m = /<dcterms:modified[^>]*>([^<]+)<\/dcterms:modified>/.exec(files["docProps/core.xml"] || "");
    var t = m ? Date.parse(m[1]) : NaN;
    return isNaN(t) ? null : t;
  }
  function colIndex(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n - 1; }
  function normNumber(v) { var n = Number(v); return v !== "" && isFinite(n) ? String(n) : v; }

  // ------------------------------------------------------------------ xlsx
  function parseSharedStrings(xml) {
    var list = [];
    (String(xml || "").match(/<si\b[\s\S]*?<\/si>|<si\s*\/>/g) || []).forEach(function (si) { list.push(textRuns(si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""))); });
    return list;
  }

  function sheetPaths(files) {
    var wb = files["xl/workbook.xml"] || "", rels = files["xl/_rels/workbook.xml.rels"] || "", target = {};
    (rels.match(/<Relationship\b[^>]*>/g) || []).forEach(function (r) { var id = attr(r, "Id"), t = attr(r, "Target"); if (id && t) target[id] = t.charAt(0) === "/" ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""); });
    var out = [];
    (wb.match(/<sheet\b[^>]*>/g) || []).forEach(function (s, i) {
      var rid = (/r:id="([^"]*)"/.exec(s) || [])[1];
      var path = rid && target[rid] ? target[rid] : "xl/worksheets/sheet" + (i + 1) + ".xml";
      if (files[path] !== undefined) out.push({ name: attr(s, "name") || "Sheet" + (i + 1), path: path });
    });
    if (!out.length) Object.keys(files).filter(function (k) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(k); }).sort().forEach(function (k, i) { out.push({ name: "Sheet" + (i + 1), path: k }); });
    return out;
  }

  function parseSheet(xml, strings) {
    var cells = {}, shared = {}, re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, m;
    while ((m = re.exec(xml))) {
      var a = m[1], inner = m[2] || "", ref = attr(a, "r"), t = attr(a, "t");
      if (!ref) continue;
      var rc = /^([A-Z]+)(\d+)$/.exec(ref); if (!rc) continue;
      var f = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner), typed = "";
      if (f) {
        var ftext = f[2] !== undefined ? decodeXml(f[2]) : "", si = attr(f[1], "si");
        if (ftext && si !== null) shared[si] = ftext;
        if (!ftext && si !== null) ftext = shared[si] || "";
        typed = "=" + ftext;
      } else if (t === "inlineStr") typed = textRuns(inner);
      else {
        var v = /<v>([\s\S]*?)<\/v>/.exec(inner), raw = v ? decodeXml(v[1]) : "";
        if (t === "s") typed = strings[Number(raw)] !== undefined ? strings[Number(raw)] : "";
        else if (t === "b") typed = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
        else if (t === "str" || t === "e") typed = raw;
        else typed = normNumber(raw);
      }
      if (typed !== "") cells[colIndex(rc[1]) + "," + (Number(rc[2]) - 1)] = typed;
    }
    return cells;
  }

  async function readXlsx(buffer, inflate) {
    var files = await unzipEntries(buffer, function (n) { return /^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)|docProps\/core\.xml)$/.test(n); }, inflate);
    if (!files["xl/workbook.xml"]) throw new Error("This does not look like an Excel workbook.");
    var strings = parseSharedStrings(files["xl/sharedStrings.xml"]), map = {}, sheets = [], count = 0;
    sheetPaths(files).forEach(function (s) {
      var cells = parseSheet(files[s.path], strings), n = 0;
      Object.keys(cells).forEach(function (k) { var rc = k.split(","); map[L.keyOf(s.name, Number(rc[1]), Number(rc[0]))] = cells[k]; n++; });
      sheets.push({ name: s.name, cells: n }); count += n;
    });
    return { kind: "xlsx", surface: "Excel", sheets: sheets, map: map, cellCount: count, modified: modifiedOf(files) };
  }

  // ------------------------------------------------------------------ docx / pptx
  async function readDocx(buffer, inflate) {
    var files = await unzipEntries(buffer, function (n) { return n === "word/document.xml" || n === "docProps/core.xml"; }, inflate);
    if (!files["word/document.xml"]) throw new Error("This does not look like a Word document.");
    var paras = [];
    (files["word/document.xml"].match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).forEach(function (p) { var t = textRuns(p).replace(/\s+/g, " ").trim(); if (t) paras.push(t); });
    return { kind: "docx", surface: "Word", units: paras, unitLabel: "Paragraph", cellCount: paras.length, modified: modifiedOf(files) };
  }

  async function readPptx(buffer, inflate) {
    var files = await unzipEntries(buffer, function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n) || n === "docProps/core.xml"; }, inflate);
    var names = Object.keys(files).filter(function (k) { return /^ppt\/slides\/slide\d+\.xml$/.test(k); }).sort(function (a, b) { return Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]); });
    if (!names.length) throw new Error("This does not look like a PowerPoint file.");
    var units = [], labels = [];
    names.forEach(function (nm, si) {
      (files[nm].match(/<a:p\b[\s\S]*?<\/a:p>/g) || []).forEach(function (p) { var t = textRuns(p).replace(/\s+/g, " ").trim(); if (t) { units.push(t); labels.push("Slide " + (si + 1)); } });
    });
    return { kind: "pptx", surface: "PowerPoint", units: units, labels: labels, unitLabel: "Slide text", cellCount: units.length, modified: modifiedOf(files) };
  }

  async function readOfficeFile(buffer, name, inflate) {
    var n = String(name || "").toLowerCase();
    if (/\.xlsx$|\.xlsm$/.test(n)) return readXlsx(buffer, inflate);
    if (/\.docx$/.test(n)) return readDocx(buffer, inflate);
    if (/\.pptx$/.test(n)) return readPptx(buffer, inflate);
    throw new Error("Choose an Excel (.xlsx), Word (.docx) or PowerPoint (.pptx) file. Older .xls, .doc and .ppt files are not supported.");
  }

  // ------------------------------------------------------------------ comparing
  function sameValue(x, y) {
    if (x === y) return true;
    var a = Number(x), b = Number(y);
    return x !== "" && y !== "" && isFinite(a) && isFinite(b) && a === b;
  }
  function clip(s) { return String(s).length > 160 ? String(s).slice(0, 159) + "\u2026" : String(s); }

  function diffCells(a, b) {
    var keys = {}, changes = [], multi = false, sheetSeen = {};
    Object.keys(a.map).concat(Object.keys(b.map)).forEach(function (k) { keys[k] = 1; sheetSeen[L.parseKey(k).sheet] = 1; });
    multi = Object.keys(sheetSeen).length > 1 || a.sheets.length > 1 || b.sheets.length > 1;
    Object.keys(keys).forEach(function (k) {
      var x = a.map[k] || "", y = b.map[k] || "";
      if (sameValue(x, y)) return;
      var p = L.parseKey(k);
      changes.push({ sheet: p.sheet, r: p.r, c: p.c, addr: (multi ? p.sheet + "!" : "") + L.colName(p.c) + (p.r + 1), before: x, after: y });
    });
    var order = {};
    b.sheets.concat(a.sheets).forEach(function (sh) { if (order[sh.name] === undefined) order[sh.name] = Object.keys(order).length; });
    changes.sort(function (p, q) { return (order[p.sheet] - order[q.sheet]) || p.r - q.r || p.c - q.c; });
    return changes;
  }

  function diffUnits(a, b) {
    var x = a.units, y = b.units, n = x.length, m = y.length, i, j, T = [];
    for (i = 0; i <= n; i++) T.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) T[i][j] = x[i] === y[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    var dels = [], adds = []; i = 0; j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) dels.push(i++); else adds.push(j++); }
    while (i < n) dels.push(i++);
    while (j < m) adds.push(j++);
    // pair removed and added units in order so an edited paragraph reads as before -> after
    var changes = [], k = Math.max(dels.length, adds.length);
    for (var q = 0; q < k; q++) {
      var di = dels[q], ai = adds[q];
      var label = (b.labels && ai !== undefined ? b.labels[ai] : a.labels && di !== undefined ? a.labels[di] : a.unitLabel) + " " + ((ai !== undefined ? ai : di) + 1);
      changes.push({ addr: b.labels ? (ai !== undefined ? b.labels[ai] : a.labels[di]) + ", item " + ((ai !== undefined ? ai : di) + 1) : label, before: di !== undefined ? x[di] : "", after: ai !== undefined ? y[ai] : "" });
    }
    return changes;
  }

  // opts: { workflow, agent, minutes (entered, optional), aiModified, finalModified (ms), fileName, now }
  function compareFiles(before, after, opts) {
    opts = opts || {};
    if (before.kind !== after.kind) throw new Error("The two files are different kinds (" + before.surface + " and " + after.surface + "). Choose the AI's version and your final version of the same file.");
    var now = opts.now || Date.now(), changes, built, formulaEdits = 0, total = before.cellCount, correction = null;
    var ctx = { agent: opts.agent || "AI tool", privacy: "full", activeSeconds: 0, now: now };
    if (before.kind === "xlsx") {
      changes = diffCells(before, after);
      built = L.buildExcelCorrectionFromChanges(changes, ctx);
      formulaEdits = built.formulaEdits || 0;
    } else {
      changes = diffUnits(before, after);
      var tb = before.units.join("\n"), ta = after.units.join("\n");
      built = L.buildWordCorrection(tb, ta, ctx);
    }
    correction = built.correction;
    var elapsed = 0;
    if (opts.aiModified && opts.finalModified && opts.finalModified > opts.aiModified && opts.finalModified - opts.aiModified < 14 * 86400000) elapsed = Math.round((opts.finalModified - opts.aiModified) / 1000);
    var entered = Number(opts.minutes);
    var minutesSource = isFinite(entered) && entered > 0 ? "entered" : "estimated";
    if (correction) {
      correction.surface = after.surface; correction.workflow = opts.workflow || ""; correction.file = opts.fileName || "";
      if (minutesSource === "entered") correction.estimatedMinutes = Math.min(600, entered);
      correction.timeSource = minutesSource;
      correction.id = "f_" + now + "_" + Math.random().toString(36).slice(2, 8);
    }
    var changed = changes.length;
    var run = {
      id: "fr_" + now + "_" + Math.random().toString(36).slice(2, 8), workflow: opts.workflow || "", fileName: opts.fileName || "", type: before.kind, surface: after.surface, createdAt: now,
      totalCells: total, changedCells: changed, formulaEdits: formulaEdits, unchangedPct: total ? Math.max(0, Math.round((1 - Math.min(changed, total) / total) * 100)) : 100,
      estimatedMinutes: correction ? correction.estimatedMinutes : 0, minutesSource: minutesSource, elapsedSeconds: elapsed,
      category: correction ? correction.category : "", changes: changes.slice(0, MAX_CHANGES_SAVED).map(function (c) { return { addr: clip(c.addr), before: clip(c.before), after: clip(c.after) }; }),
      corrId: correction ? correction.id : "", source: "live",
    };
    return { run: run, correction: correction, send: built.send, changes: changes, totals: { total: total, changed: changed, formulaEdits: formulaEdits } };
  }

  var api = { readOfficeFile: readOfficeFile, readXlsx: readXlsx, readDocx: readDocx, readPptx: readPptx, compareFiles: compareFiles, unzipEntries: unzipEntries, MAX_CHANGES_SAVED: MAX_CHANGES_SAVED };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldFiles = api;
})(typeof self !== "undefined" ? self : globalThis);
