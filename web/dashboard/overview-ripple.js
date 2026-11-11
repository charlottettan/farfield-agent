/* Overview ripple.
 *
 * A faint grid of square cells sits behind the top of the Overview. Moving the pointer over it sends out
 * a ring in light gray. The ring starts as solid cells and breaks up as it spreads and ages, the way the
 * reference page's pattern dissolves: solid cell, hatched cell, hollow circle, plus, small square, nothing.
 *
 * It never takes clicks, is hidden on every other tab, stops drawing when nothing is moving, and is off
 * for people who ask their system for reduced motion (the grid stays, nothing moves).
 * Colours come from the page's own variables, so it follows light and dark themes.
 */
(function (root) {
  "use strict";

  var CELL = 28;            // px per grid cell
  var SPEED = 380;          // px per second that the front of a ring travels
  var LIFE = 2.2;           // seconds for a ring to run its course
  var SPAWN_MS = 150;       // at most one new ring this often while the pointer moves
  var SPAWN_PX = 44;        // and only after the pointer has moved this far
  var MAX_RINGS = 7;
  var HEIGHT = 520;         // px of grid below the top bar
  var FRONT = 0.18;         // seconds a cell stays part of the solid leading ring after the ring reaches it
  var FADE_FROM = 0.62;     // the grid and the ripple fade to nothing over the bottom part of its height

  var STAGES = ["solid", "hatch", "circle", "plus", "dot"];
  var CUTS = [0.14, 0.32, 0.50, 0.68, 0.84];   // phase at which each stage ends; beyond the last, the cell is empty

  // a stable pseudo-random number for each cell, so the break-up looks organic but never flickers
  function hash(i, j) {
    var h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // how far a cell has come through its break-up: later in time and further from the centre means more broken
  function phaseOf(age, dist, i, j) {
    return age / LIFE + (dist / 900) * 0.5 + (hash(i, j) - 0.5) * 0.22;
  }
  function stageOf(phase) {
    for (var k = 0; k < CUTS.length; k++) if (phase < CUTS[k]) return STAGES[k];
    return null;
  }
  // later and further out, fewer cells survive, so the ripple breaks into scattered pieces rather than a solid patch
  function keepOf(phase, dist, front) { return front ? Math.max(0.12, 1 - (dist / 900) * 0.85) : Math.max(0, 1 - phase * 0.95); }
  function fadeOf(phase) { return phase < 0.70 ? 1 : Math.max(0, 1 - (phase - 0.70) / 0.14); }
  function edgeOf(y, h) {
    var start = h * FADE_FROM;
    return y <= start ? 1 : Math.max(0, 1 - (y - start) / (h - start));
  }

  // every cell that has something drawn in it right now, for a list of rings ({x, y, t0} with t0 in ms)
  function cellsFor(rings, now, w, h) {
    var cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL), out = [];
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var cx = i * CELL + CELL / 2, cy = j * CELL + CELL / 2, best = null;
        for (var r = 0; r < rings.length; r++) {
          var t = (now - rings[r].t0) / 1000;
          if (t < 0 || t > LIFE + 1) continue;
          var dist = Math.sqrt((cx - rings[r].x) * (cx - rings[r].x) + (cy - rings[r].y) * (cy - rings[r].y));
          var age = t - dist / SPEED;            // seconds since the front reached this cell
          if (age < 0) continue;
          var front = age < FRONT, phase = phaseOf(age, dist, i, j);
          if (front) phase = Math.min(phase, 0.08);                       // the leading ring is made of solid cells
          if (hash(i + 4099, j + 7919) > keepOf(phase, dist, front)) continue;   // this cell has already dropped out
          if (best === null || phase < best) best = phase;
        }
        if (best === null) continue;
        var stage = stageOf(best);
        if (!stage) continue;
        var alpha = fadeOf(best) * edgeOf(cy, h);
        if (alpha <= 0.01) continue;
        out.push({ i: i, j: j, stage: stage, alpha: alpha, phase: best });
      }
    }
    return out;
  }

  // add a ring where the pointer is, if it has moved far enough and long enough since the last one
  function spawn(rings, last, x, y, now) {
    if (last && (now - last.t < SPAWN_MS || Math.sqrt((x - last.x) * (x - last.x) + (y - last.y) * (y - last.y)) < SPAWN_PX)) return false;
    rings.push({ x: x, y: y, t0: now });
    while (rings.length > MAX_RINGS) rings.shift();
    if (last) { last.x = x; last.y = y; last.t = now; }
    return true;
  }
  function prune(rings, now) {
    for (var k = rings.length - 1; k >= 0; k--) if ((now - rings[k].t0) / 1000 > LIFE + 1) rings.splice(k, 1);
  }
  function motionAllowed(mq) { return !(mq && mq.matches); }

  var api = { FRONT: FRONT, keepOf: keepOf, CELL: CELL, SPEED: SPEED, LIFE: LIFE, STAGES: STAGES, CUTS: CUTS, HEIGHT: HEIGHT, MAX_RINGS: MAX_RINGS, SPAWN_MS: SPAWN_MS, SPAWN_PX: SPAWN_PX, hash: hash, phaseOf: phaseOf, stageOf: stageOf, fadeOf: fadeOf, edgeOf: edgeOf, cellsFor: cellsFor, spawn: spawn, prune: prune, motionAllowed: motionAllowed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FarfieldRipple = api;

  // ---------------------------------------------------------------- the browser part
  function init() {
    var doc = root.document;
    if (!doc || !doc.getElementById) return;
    var canvas = doc.getElementById("rippleBg"), panel = doc.getElementById("tab-overview");
    if (!canvas || !panel || String(canvas.tagName).toUpperCase() !== "CANVAS" || typeof canvas.getContext !== "function") return;
    var g = canvas.getContext("2d");
    if (!g) return;
    var mq = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var rings = [], last = null, raf = 0, W = 0, H = HEIGHT, dpr = 1, colors = null;

    function readColors() {
      var cs = root.getComputedStyle(doc.documentElement);
      var pick = function (n, d) { var v = cs.getPropertyValue(n).trim(); return v || d; };
      colors = { grid: pick("--line", "#E4E6EA"), fill: pick("--soft2", "#ECEEF2"), mark: pick("--line2", "#C9CED6") };
    }
    function size() {
      W = Math.max(doc.documentElement.clientWidth, 320);
      dpr = Math.min(root.devicePixelRatio || 1, 2);
      canvas.style.height = H + "px";
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function drawGrid() {
      // one path per row (its horizontal line plus the short vertical pieces under it), so the whole grid fades out toward the bottom
      g.strokeStyle = colors.grid; g.lineWidth = 1;
      var rows = Math.ceil(H / CELL);
      for (var j = 0; j <= rows; j++) {
        var y = j * CELL, a = 0.8 * edgeOf(y, H);
        if (a <= 0.01) continue;
        g.globalAlpha = a; g.beginPath();
        g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5);
        if (j < rows) for (var x = 0; x <= W; x += CELL) { g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, Math.min(y + CELL, H)); }
        g.stroke();
      }
    }
    function mark(c) {
      var x0 = c.i * CELL, y0 = c.j * CELL, cx = x0 + CELL / 2, cy = y0 + CELL / 2;
      g.globalAlpha = c.alpha;
      if (c.stage === "solid") { g.fillStyle = colors.fill; g.fillRect(x0 + 1, y0 + 1, CELL - 1, CELL - 1); }
      else if (c.stage === "hatch") {
        g.save(); g.beginPath(); g.rect(x0 + 1, y0 + 1, CELL - 1, CELL - 1); g.clip();
        g.globalAlpha = c.alpha * 0.6; g.strokeStyle = colors.mark; g.lineWidth = 1; g.beginPath();
        for (var k = -CELL; k < CELL; k += 5) { g.moveTo(x0 + k, y0 + CELL); g.lineTo(x0 + k + CELL, y0); }
        g.stroke(); g.restore();
      } else if (c.stage === "circle") { g.strokeStyle = colors.mark; g.lineWidth = 1.2; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke(); }
      else if (c.stage === "plus") { g.strokeStyle = colors.mark; g.lineWidth = 1.2; g.beginPath(); g.moveTo(cx - 4, cy); g.lineTo(cx + 4, cy); g.moveTo(cx, cy - 4); g.lineTo(cx, cy + 4); g.stroke(); }
      else { g.fillStyle = colors.mark; g.fillRect(cx - 1.5, cy - 1.5, 3, 3); }
    }
    function draw(now) {
      g.clearRect(0, 0, W, H);
      g.globalAlpha = 1;
      drawGrid();
      var cells = cellsFor(rings, now, W, H);
      for (var n = 0; n < cells.length; n++) mark(cells[n]);
      g.globalAlpha = 1;
    }
    function frame() {
      raf = 0;
      var now = root.performance.now();
      prune(rings, now);
      draw(now);
      if (rings.length) raf = root.requestAnimationFrame(frame);   // nothing is scheduled while the page is still
    }
    function wake() { if (!raf && !canvas.hidden) raf = root.requestAnimationFrame(frame); }
    function onMove(e) {
      if (canvas.hidden || !motionAllowed(mq)) return;
      var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      if (!last) last = { x: -1e6, y: -1e6, t: -1e6 };
      if (spawn(rings, last, x, y, root.performance.now())) wake();
    }
    function sync() {
      var show = !panel.hidden;
      canvas.hidden = !show;
      if (show) { size(); draw(root.performance.now()); if (rings.length) wake(); } else { rings.length = 0; }
    }

    readColors(); size(); sync();
    doc.addEventListener("mousemove", onMove, { passive: true });
    root.addEventListener("resize", function () { if (!canvas.hidden) { size(); draw(root.performance.now()); } });
    new root.MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    new root.MutationObserver(function () { readColors(); if (!canvas.hidden) draw(root.performance.now()); }).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  try { init(); } catch (err) { if (root.console) root.console.error("overview ripple", err); }
})(typeof window !== "undefined" ? window : this);
