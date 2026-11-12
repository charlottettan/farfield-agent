"use strict";

const A = window.FarfieldAnalysis;
const C = A.CATEGORIES;
const R = A.ROUTES;
const C_REGEN = "Regenerated without instructions";

const store = {
  corrections: [],
  sends: [],
  fixes: [],
  aiSessions: [],
  rePrompts: [],
  settings: { agents: [] },
  agentFilter: "all",
  team: "all",
  period: { preset: "all", from: "", to: "" },
  tab: "overview",
  rate: 60,
  openTeams: {},
  fixNotice: null,
  view: "mine", company: null, me: null, companyActive: false, companyError: "", companyOrg: null, loadSeq: 0, wasCompany: false,
  openTests: {},
  gate: { good: null, risky: null },
  basis: "estimated",
  rpTheme: "all",
  openRpIds: {},
  openFix: {},
  rolloutAll: false,
  openClusters: {},
  openWf: {},
  impConvs: [],
  llmKey: "",
  fileRuns: [],
  traceWf: "",
  outWf: "",
  outA: null,
  outB: null,
  outRes: null,
  promptAnalysis: null,
  preferLocal: false,
  llmBusy: false,
  impNotes: [],
  impPlan: null,
  plan: null,
  firstRender: true,
};

// ---------------------------------------------------------------------------
// Company view. When you have joined a company, the dashboard can show its data instead of yours. It is read-only for your local data:
// nothing from the company is ever written to this device, and nothing here changes what is on the server except fix approvals.
// ---------------------------------------------------------------------------
const CAN_ROLES = { approveFix: ["manager", "ops_leader", "admin"], publishFix: ["engineering", "admin"], editFix: ["manager", "ops_leader", "engineering", "admin"] };
const inCompany = () => store.companyActive === true;
function can(action) { return !inCompany() || (CAN_ROLES[action] || []).indexOf(store.me && store.me.role) !== -1; }
function localWrite(obj) {
  if (inCompany() && Object.keys(obj).some((k) => k !== "llmKey")) return Promise.resolve();   // company view: never touch local data
  return chrome.storage.local.set(obj);
}
const ROLE_LABEL = { member: "a member", manager: "a manager", ops_leader: "an operations leader", engineering: "in engineering", admin: "an admin" };
function companyNote(role) {
  if (role === "member") return "You see only your own work.";
  if (role === "engineering") return "You can read the wording behind each pattern, never who wrote it.";
  return "Other people's wording is hidden: you see themes, counts and time.";
}


function $(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tagClass(category) {
  if (category === C.FACTUAL) return "tag-factual";
  if (category === C.CONTENT) return "tag-content";
  if (category === C.TERM) return "tag-term";
  if (category === C.TONE) return "tag-tone";
  return "tag-other";
}

function routeClass(route) {
  if (route === R.ENGINEERING) return "route-engineering";
  if (route === R.INSTRUCTION) return "route-instruction";
  return "route-judgment";
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtMinutes(m) {
  if (m < 1) return m > 0 ? "<1 min" : "0 min";
  return Math.round(m) + " min";
}

function fmtPct(r) {
  return r === null ? "n/a" : Math.round(r * 100) + "%";
}

function minutesOf(c) {
  return store.basis === "measured" ? (Number(c.activeSeconds) || 0) / 60 : Number(c.estimatedMinutes) || 0;
}

function visible(list) {
  return list.filter((x) => (store.agentFilter === "all" || x.agent === store.agentFilter) && (store.team === "all" || A.teamOf(x, store.settings) === store.team));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAgentFilter() {
  const select = $("agentFilter");
  const names = new Set();
  const inTeamNow = (n) => store.team === "all" || A.teamOf({ agent: n }, store.settings) === store.team;
  (store.settings.agents || []).forEach((n) => { if (inTeamNow(n)) names.add(n); });
  store.corrections.concat(store.sends, store.fixes).forEach((x) => x.agent && inTeamNow(x.agent) && names.add(x.agent));
  const current = store.agentFilter;
  select.textContent = "";
  const all = el("option", "", "All sub-agents");
  all.value = "all";
  select.appendChild(all);
  Array.from(names).forEach((n) => {
    const o = el("option", "", n);
    o.value = n;
    select.appendChild(o);
  });
  select.value = current === "all" || names.has(current) ? current : "all";
  store.agentFilter = select.value;
}

function renderStats(corrections, ranked) {
  const total = corrections.length;
  const totalMinutes = corrections.reduce((s, c) => s + minutesOf(c), 0);
  const openMinutes = ranked.reduce((s, p) => s + p.openMinutes, 0);
  const top = ranked[0] || null;

  $("statTotal").textContent = String(total);
  $("statHours").textContent = (totalMinutes / 60).toFixed(1);
  $("statHoursSub").textContent = Math.round(totalMinutes) + " min of human cleanup";
  $("statTopCount").textContent = top ? String(top.openCount) : "0";
  $("statTopName").textContent = top ? top.category + " · " + top.agent : "No open pattern";
  $("statTopPct").textContent = top && openMinutes > 0 ? Math.round((top.openMinutes / openMinutes) * 100) + "%" : "0%";
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  });
}

// Where a fix goes, and who carries it out. Approving hands it over; it counts as live once it is published.
const DEST = {
  instructions: { label: "The AI tool's instructions", owner: "AI admin" },
  data: { label: "The data feed or knowledge source", owner: "Engineering" },
  review: { label: "A human review step", owner: "Team manager" },
};
function handoffFor(route, category) {
  const key = route === R.ENGINEERING ? "data" : route === R.JUDGMENT ? "review" : route === R.INSTRUCTION ? "instructions" : category === C.FACTUAL ? "data" : "instructions";
  return { key: key, label: DEST[key].label, owner: DEST[key].owner };
}
function fixHandoff(f) {   // also works for older fixes that were saved before this existed
  const key = DEST[f.destination] ? f.destination : f.category === C.FACTUAL ? "data" : "instructions";
  return { key: key, label: DEST[key].label, owner: f.owner || DEST[key].owner };
}
const isLive = (f) => f.status !== "with_owner";   // sample and older fixes count as already published
function liveFixes(list) {
  return list.filter(isLive).map((f) => (f.publishedAt ? Object.assign({}, f, { approvedAt: f.publishedAt, approvalAt: f.approvedAt }) : f));
}
function daysText(from, to) {
  const n = Math.floor((to - from) / 86400000);
  return n <= 0 ? "since today" : n === 1 ? "for 1 day" : "for " + n + " days";
}
function statusText(f) {
  const h = fixHandoff(f);
  if (f.status === "with_owner") return "Approved " + fmtDate(f.approvedAt) + ". Waiting on " + h.owner + " " + daysText(f.handoffAt || f.approvedAt, Date.now()) + ".";
  if (f.publishedAt) {
    const gap = Math.floor((f.publishedAt - f.approvedAt) / 86400000);
    return "Approved " + fmtDate(f.approvedAt) + ". Published " + fmtDate(f.publishedAt) + (gap >= 1 ? ", " + gap + (gap === 1 ? " day" : " days") + " later." : ".");
  }
  return "Live since " + fmtDate(f.approvedAt) + ".";
}

// A readable name for a fix you approve yourself: the proposal's headline (first sentence) plus the agent
function problemName(headline, agent) {
  const first = String(headline || "").split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "").trim();
  return first ? first + " (" + agent + ")" : "";
}

async function companyApprove(pattern, proposal) {
  const h = handoffFor(proposal.route, pattern.category);
  try {
    const fix = await FarfieldSync.api("POST", "/v1/fixes", { agent: pattern.agent, category: pattern.category, instruction: proposal.text, problem: problemName(proposal.headline, pattern.agent) || undefined, destination: h.key });
    store.fixNotice = { id: fix.id, text: "Approved: " + fixProblem(fix) + ". Handed to " + fix.owner + " (" + h.label.charAt(0).toLowerCase() + h.label.slice(1) + "). It counts on the Overview once it is published." };
  } catch (e) {
    store.fixNotice = { id: "", text: "Couldn't approve that: " + e.message };
  }
  await load();
}

async function approve(pattern, proposal) {
  if (inCompany()) return companyApprove(pattern, proposal);
  const forAgent = store.fixes.filter((f) => f.agent === pattern.agent).length;
  const h = handoffFor(proposal.route, pattern.category), now = Date.now();
  const fix = {
    id: "fix_" + now,
    agent: pattern.agent,
    category: pattern.category,
    approvedAt: now,
    version: forAgent + 2,
    instruction: proposal.text,
    problem: problemName(proposal.headline, pattern.agent) || undefined,
    source: "live",
    destination: h.key,
    owner: h.owner,
    status: "with_owner",
    handoffAt: now,
    publishedAt: null,
  };
  store.fixes.push(fix);
  store.fixNotice = { id: fix.id, text: "Approved: " + fixProblem(fix) + ". Handed to " + h.owner + " (" + h.label.charAt(0).toLowerCase() + h.label.slice(1) + "). It counts on the Overview once it is published." };
  await localWrite({ fixes: store.fixes });
  render();
}

async function publishFix(id) {
  if (inCompany()) {
    try { await FarfieldSync.api("POST", "/v1/fixes/" + encodeURIComponent(id) + "/publish"); store.fixNotice = null; }
    catch (e) { store.fixNotice = { id: "", text: "Couldn't publish that: " + e.message }; }
    return load();
  }
  const f = store.fixes.find((x) => x.id === id);
  if (!f) return;
  f.status = "published";
  f.publishedAt = Date.now();
  store.fixNotice = null;
  await localWrite({ fixes: store.fixes });
  render();
}

async function setFixOwner(id, name) {
  if (inCompany()) {
    try { await FarfieldSync.api("PATCH", "/v1/fixes/" + encodeURIComponent(id), { owner: String(name || "") }); }
    catch (e) { store.fixNotice = { id: "", text: "Couldn't change the owner: " + e.message }; }
    return load();
  }
  const f = store.fixes.find((x) => x.id === id);
  if (!f) return;
  f.owner = String(name || "").trim().slice(0, 80) || fixHandoff(Object.assign({}, f, { owner: "" })).owner;
  await localWrite({ fixes: store.fixes });
  render();
}

function renderQueue(ranked) {
  const box = $("queue");
  box.textContent = "";
  const nb = $("fixNotice");
  nb.textContent = "";
  nb.hidden = !store.fixNotice;
  if (store.fixNotice) {
    const c = el("div", "capture-note");
    c.appendChild(el("span", "", store.fixNotice.text));
    const see = el("button", "link-btn", "See it");
    see.addEventListener("click", () => goTab("fixes", "monitor"));
    const x = el("button", "link-btn", "Dismiss");
    x.addEventListener("click", () => { store.fixNotice = null; render(); });
    c.appendChild(see); c.appendChild(x);
    nb.appendChild(c);
  }
  if (ranked.length === 0) {
    box.appendChild(el("div", "empty", "No open patterns. Edit an AI draft in Gmail and send it to see one appear."));
    return;
  }

  ranked.forEach((p, i) => {
    const proposal = A.proposalFor(p);
    const card = el("div", "card queue-item");

    const head = el("div", "q-head");
    head.appendChild(el("div", "rank", String(i + 1)));
    head.appendChild(el("span", "tag " + tagClass(p.category), p.category));
    head.appendChild(el("span", "agent-chip", p.agent));
    head.appendChild(el("span", "route " + routeClass(proposal.route), proposal.route));
    const cost = el("div", "q-cost", fmtMinutes(p.openMinutes) + " ");
    cost.appendChild(el("span", "", "· " + p.openCount + (p.openCount === 1 ? " correction" : " corrections")));
    head.appendChild(cost);
    card.appendChild(head);

    card.appendChild(el("div", "headline", proposal.headline));

    if (proposal.kind !== "note") {
      card.appendChild(
        el("div", "proposal-label", proposal.kind === "ticket" ? "Draft engineering ticket" : "Proposed instruction change")
      );
    }
    card.appendChild(el("div", "proposal", proposal.text));

    if (proposal.kind !== "note") {
      const h = p.fix ? fixHandoff(p.fix) : handoffFor(proposal.route, p.category);
      const line = el("div", "handoff");
      line.appendChild(document.createTextNode("Goes to: "));
      line.appendChild(el("b", "", h.label));
      line.appendChild(document.createTextNode(". Owner: "));
      line.appendChild(el("b", "", h.owner));
      line.appendChild(document.createTextNode(p.fix ? ". " + statusText(p.fix) : ". Approve it to hand it over and start the record."));
      card.appendChild(line);
    }

    const actions = el("div", "actions");
    if (!can("approveFix") && (proposal.kind === "instruction" || proposal.kind === "ticket")) {
      actions.appendChild(el("span", "note", "Only a manager, operations leader or admin can approve fixes."));
    } else if (proposal.kind === "instruction") {
      const approveBtn = el("button", "btn", "Approve change");
      approveBtn.addEventListener("click", () => approve(p, proposal));
      actions.appendChild(approveBtn);
      const copyBtn = el("button", "btn secondary", "Copy instruction");
      copyBtn.addEventListener("click", () => copyText(copyBtn, proposal.text));
      actions.appendChild(copyBtn);
    } else if (proposal.kind === "ticket") {
      const handBtn = el("button", "btn", "Hand to engineering");
      handBtn.addEventListener("click", () => approve(p, proposal));
      actions.appendChild(handBtn);
      const copyBtn = el("button", "btn secondary", "Copy ticket");
      copyBtn.addEventListener("click", () => copyText(copyBtn, proposal.text));
      actions.appendChild(copyBtn);
    }
    if (p.fix) {
      actions.appendChild(
        el("span", "approved-note", "v" + p.fix.version + " approved " + fmtDate(p.fix.approvedAt) + ", " + p.openCount + " since")
      );
    }
    if (actions.childNodes.length) card.appendChild(actions);
    if (p.terms && p.terms.length) {
      card.appendChild(el("div", "note", "Terms involved: " + p.terms.join(", ")));
    }

    box.appendChild(card);
  });
}

function renderMonitor(fixes, sends) {
  const box = $("monitor");
  box.textContent = "";
  if (fixes.length === 0) {
    box.appendChild(el("div", "empty", "No approved fixes yet. Approve one in the queue and it appears here with its owner and status."));
    return;
  }
  const waiting = fixes.filter((f) => !isLive(f));
  if (waiting.length) box.appendChild(el("div", "capture-note", waiting.length + (waiting.length === 1 ? " approved fix is" : " approved fixes are") + " waiting to be published. " + (waiting.length === 1 ? "It counts" : "They count") + " on the Overview once " + (waiting.length === 1 ? "it is." : "they are.")));
  fixes
    .slice()
    .sort((a, b) => b.approvedAt - a.approvedAt)
    .forEach((f) => {
      const pending = !isLive(f), h = fixHandoff(f);
      const card = el("div", "card ba-card");
      card.appendChild(el("div", "ba-title", fixProblem(f)));
      card.appendChild(el("div", "ba-meta", f.agent + " · " + f.category));
      const hl = el("div", "handoff");
      hl.appendChild(document.createTextNode("Goes to: "));
      hl.appendChild(el("b", "", h.label));
      hl.appendChild(document.createTextNode(". Owner: "));
      hl.appendChild(el("b", "", h.owner));
      hl.appendChild(document.createTextNode("."));
      card.appendChild(hl);
      card.appendChild(el("div", "ba-meta", statusText(f)));

      if (pending) {
        const ctl = el("div", "actions");
        if (can("editFix")) {
          const lab = el("label", "inl", "Owner ");
          const inp = el("input", "");
          inp.type = "text"; inp.value = f.owner || h.owner; inp.setAttribute("aria-label", "Owner of this fix"); inp.style.width = "180px";
          inp.addEventListener("change", (e) => setFixOwner(f.id, e.target.value));
          lab.appendChild(inp);
          ctl.appendChild(lab);
        }
        if (can("publishFix")) {
          const pub = el("button", "btn", "Mark as published");
          pub.addEventListener("click", () => publishFix(f.id));
          ctl.appendChild(pub);
        } else ctl.appendChild(el("span", "note", "Waiting for " + h.owner + " to publish it."));
        card.appendChild(ctl);
        card.appendChild(el("div", "note", "Measuring starts when it is published."));
        box.appendChild(card);
        return;
      }

      const ba = A.beforeAfter(f.publishedAt ? Object.assign({}, f, { approvedAt: f.publishedAt }) : f, sends, 14);
      const row = el("div", "ba-row");
      row.appendChild(el("div", "ba-num before", fmtPct(ba.before.rate)));
      row.appendChild(el("div", "ba-arrow", "\u2192"));
      row.appendChild(el("div", "ba-num after", fmtPct(ba.after.rate)));
      row.appendChild(
        el("div", "ba-meta", "of drafts needed this fix: " + ba.before.n + " drafts before, " + ba.after.n + " after")
      );
      card.appendChild(row);

      if (ba.before.n < 10 || ba.after.n < 10) {
        card.appendChild(el("div", "note", "Small sample: treat this as directional, not proof."));
      }
      box.appendChild(card);
    });
}

function renderRecent(corrections) {
  const box = $("correctionList");
  box.textContent = "";
  if (corrections.length === 0) {
    box.appendChild(el("div", "empty", "No corrections yet."));
    return;
  }
  corrections
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 25)
    .forEach((c) => {
      const card = el("div", "card correction");
      const head = el("div", "c-head");
      head.appendChild(el("span", "c-time", fmtDate(c.timestamp)));
      head.appendChild(el("span", "agent-chip", (c.surface || "Gmail") + " · " + (c.agent || "Unassigned agent")));
      head.appendChild(el("span", "tag " + tagClass(c.category), c.category));
      const est = "~" + (Number(c.estimatedMinutes) || 0) + " min est.";
      const measured = c.activeSeconds ? " · " + c.activeSeconds + "s active" : "";
      head.appendChild(el("span", "c-mins", est + measured));
      head.appendChild(el("span", "", "+" + (c.wordsAdded || 0) + " / -" + (c.wordsRemoved || 0) + " words"));
      head.appendChild(el("span", c.source === "seed" ? "sample-badge" : "live-badge", c.source === "seed" ? "Sample" : "Live"));
      if (c.totalCells) {
        const pct = Math.round(((c.reviewedCells || 0) / c.totalCells) * 100);
        head.appendChild(el("span", "", "Reviewed " + pct + "% of cells · " + (c.flaggedCount || 0) + " flagged"));
      }
      card.appendChild(head);

      const compare = el("div", "compare");
      const orig = el("div", "side orig");
      orig.appendChild(el("div", "side-label", "Original (AI draft)"));
      orig.appendChild(el("div", "side-text", c.originalSnippet || "(empty)"));
      compare.appendChild(orig);
      const edit = el("div", "side edit");
      edit.appendChild(el("div", "side-label", "Edited (sent)"));
      edit.appendChild(el("div", "side-text", c.editedSnippet || "(empty)"));
      compare.appendChild(edit);
      card.appendChild(compare);

      box.appendChild(card);
    });
}

function renderReprompt() {
  const sum = A.summarizeAiSessions(store.aiSessions);
  const stats = $("aiStats");
  stats.textContent = "";
  [
    ["AI chat sessions", String(sum.sessions), "Chats that produced a deliverable"],
    ["Average attempts", sum.avgAttempts.toFixed(1), "Prompts plus regenerations per session"],
    ["Retries", String(sum.retries), "Attempts after the first one"],
    ["Hours between attempts", sum.retryHours.toFixed(1), "Time spent re-prompting"],
  ].forEach((c) => {
    const card = el("div", "card");
    card.appendChild(el("div", "stat-label", c[0]));
    card.appendChild(el("div", "stat-value", c[1]));
    card.appendChild(el("div", "stat-sub", c[2]));
    stats.appendChild(card);
  });

  function fill(boxId, rows) {
    const box = $(boxId);
    box.textContent = "";
    if (!rows.length) { box.appendChild(el("div", "empty", "No sessions yet.")); return; }
    rows.forEach((r) => {
      const row = el("div", "mini-row");
      row.appendChild(el("span", "", r.name));
      row.appendChild(el("span", "", r.avgAttempts.toFixed(1) + " attempts avg, " + r.retryHours.toFixed(1) + " h, " + r.sessions + " sessions"));
      box.appendChild(row);
    });
  }
  fill("aiFlows", sum.byWorkflow);
  fill("aiTools", sum.byTool);

  const hist = $("aiHist");
  hist.textContent = "";
  const max = Math.max.apply(null, sum.hist) || 1;
  sum.hist.forEach((n, i) => {
    const col = el("div", "col");
    col.style.height = Math.max(2, (n / max) * 80) + "px";
    const wrap = el("div", "hist-col");
    wrap.appendChild(el("span", "", String(n)));
    wrap.appendChild(col);
    wrap.appendChild(el("span", "", i === 5 ? "6+" : String(i + 1)));
    hist.appendChild(wrap);
  });
}

function fmtSecs(sec) {
  sec = Math.round(sec);
  if (sec < 90) return sec + "s";
  const m = Math.round(sec / 6) / 10;
  return m + " min";
}

function promptTagClass(category) {
  if (category === "Follow-up (not categorized)" || category === "Pasted material (not an instruction)") return "tag-other";
  if (category === "Terminology") return "tag-term";
  if (category === "Style and tone") return "tag-tone";
  if (category === "Facts and missing content") return "tag-factual";
  return "tag-content";
}

function sourceBadge(source) {
  return el("span", source === "seed" ? "sample-badge" : "live-badge", source === "seed" ? "Sample" : "Live");
}

function clusterCard(c) {
  const open = !!store.openClusters[c.key];
  const card = el("div", "card cluster");
  const head = el("div", "cl-head");
  if (c.tagClass) head.appendChild(el("span", "tag " + c.tagClass, c.tag));
  head.appendChild(el("span", "cl-title", c.title));
  if (c.cost !== undefined) head.appendChild(el("span", "cl-cost", fmtSecs(c.cost)));
  card.appendChild(head);
  if (c.meta) card.appendChild(el("div", "stat-sub", c.meta));
  c.examples.forEach((ex) => card.appendChild(el("div", "quote", "\u201c" + ex + "\u201d")));
  if (c.review !== undefined && c.review + c.write > 0) {
    const total = c.review + c.write || 1;
    const split = el("div", "split");
    const rv = el("span"); rv.style.width = (c.review / total * 100) + "%"; rv.style.background = "var(--accent)";
    const wr = el("span"); wr.style.width = (c.write / total * 100) + "%"; wr.style.background = "var(--accent)";
    split.appendChild(rv); split.appendChild(wr);
    card.appendChild(split);
    card.appendChild(el("div", "stat-sub", "Reviewing " + fmtSecs(c.review) + ", writing " + fmtSecs(c.write)));
  }
  if (c.rule) card.appendChild(el("div", "rule", c.ruleLabel + " " + c.rule));
  const actions = el("div", "actions");
  if (c.rule) {
    const copy = el("button", "btn secondary", "Copy rule");
    copy.addEventListener("click", () => copyText(copy, c.rule));
    actions.appendChild(copy);
  }
  if (c.members.length) {
    const toggle = el("button", "btn secondary", open ? "Hide the prompts" : "Show all " + c.members.length + " prompts");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.addEventListener("click", () => { store.openClusters[c.key] = !open; renderRePrompts(); });
    actions.appendChild(toggle);
  }
  if (c.note) actions.appendChild(el("span", "note", c.note));
  card.appendChild(actions);
  if (open) {
    const list = el("div", "expand-row");
    c.members.forEach((m) => {
      const row = el("div", "quote", "\u201c" + m.text + "\u201d");
      row.appendChild(el("span", "note", "  " + fmtDate(m.ts) + ", " + m.site + ", " + m.user + " "));
      row.appendChild(sourceBadge(m.source));
      if (m.original) row.appendChild(el("div", "note", "Original message: " + (m.original.length > 220 ? m.original.slice(0, 220) + "\u2026" : m.original)));
      list.appendChild(row);
    });
    card.appendChild(list);
  }
  return card;
}

function memberOf(r, text) {
  const full = r.fullText || r.text || "";
  return { text: text || full, original: text && full && full !== text ? full : "", ts: r.timestamp, site: r.site, user: r.user || "You", source: r.source };
}

function pastedCard(records) {
  const shown = records.slice().sort((a, b) => b.timestamp - a.timestamp);
  return clusterCard({
    key: "pasted", title: "Pasted material, not instructions", meta: shown.length + (shown.length === 1 ? " message" : " messages") + " that were mostly text you pasted for the AI to work on. They are kept out of the groups and rules above.",
    examples: shown.slice(0, 2).map((r) => { const t = r.text || ""; return t.length > 140 ? t.slice(0, 140) + "\u2026" : t; }),
    members: shown.map((r) => memberOf(r)),
  });
}

function llmClusters() {
  const a = store.promptAnalysis, byId = {};
  store.rePrompts.forEach((r) => { byId[r.id] = r; });
  const out = [], oneOffs = [];
  a.clusters.forEach((c) => {
    const recs = c.memberIds.map((id) => byId[id]).filter(Boolean);
    if (!recs.length) return;
    const users = {}; recs.forEach((r) => { users[r.user || "You"] = 1; });
    const review = recs.reduce((n, r) => n + (r.reviewSeconds || 0), 0), write = recs.reduce((n, r) => n + (r.writeSeconds || 0), 0);
    const insOf = (r) => (a.items[r.id] && a.items[r.id].instruction) || A.instructionOf(r) || r.text;
    const uniq = []; recs.forEach((r) => { const t = insOf(r); if (uniq.indexOf(t) === -1) uniq.push(t); });
    const isOne = c.name === "One-off requests";
    const card = {
      key: "llm|" + c.name, title: c.name, meta: recs.length + (recs.length === 1 ? " time" : " times") + ", " + Object.keys(users).length + (Object.keys(users).length === 1 ? " person" : " people"),
      cost: review + write, review: review, write: write, examples: uniq.slice(0, 3),
      rule: isOne ? "" : c.rule, ruleLabel: "Draft rule from Claude (edit before publishing):",
      members: recs.slice().sort((x, y) => y.timestamp - x.timestamp).map((r) => memberOf(r, insOf(r))),
    };
    (isOne ? oneOffs : out).push(card);
  });
  out.sort((x, y) => y.cost - x.cost || y.members.length - x.members.length);
  return out.concat(oneOffs);
}

function renderRePrompts() {
  const sum = A.summarizePromptClusters(store.rePrompts);
  const stats = $("rpStats");
  stats.textContent = "";
  [
    ["Re-prompts saved", String(sum.total), sum.regens + " were Regenerate clicks with no instructions"],
    ["Time reviewing before a re-prompt", fmtSecs(sum.avgReviewSeconds), "Average, from finished answer to first keystroke"],
    ["Time writing the re-prompt", fmtSecs(sum.avgWriteSeconds), "Average, from first keystroke to send"],
    ["Total time on re-prompts", (sum.totalSeconds / 3600).toFixed(1) + " h", "Reviewing plus writing"],
  ].forEach((c) => {
    const card = el("div", "card");
    card.appendChild(el("div", "stat-label", c[0]));
    card.appendChild(el("div", "stat-value", c[1]));
    card.appendChild(el("div", "stat-sub", c[2]));
    stats.appendChild(card);
  });

  const note = $("llmNote");
  note.textContent = "";
  const box = $("rpClusters");
  box.textContent = "";
  const a = store.promptAnalysis;

  if (a && !store.preferLocal) {
    const done = a.items || {};
    const fresh = store.rePrompts.filter((r) => r.kind !== "regen" && r.text && !done[r.id]).length;
    const n = el("div", "capture-note");
    n.appendChild(el("span", "", "Grouped by Claude (" + a.model + ") on " + fmtDate(a.at) + ", " + (a.redacted ? "names and numbers masked" : "text not masked") + "." + (fresh ? " " + fresh + " newer re-prompts are not included yet; press Analyze again to add them." : "")));
    const sw = el("button", "btn secondary", "Use the built-in grouping instead");
    sw.addEventListener("click", () => { store.preferLocal = true; renderRePrompts(); });
    n.appendChild(sw);
    note.appendChild(n);
    const cards = llmClusters();
    if (!cards.length) box.appendChild(el("div", "empty", "Claude found no instructions to group yet."));
    cards.forEach((c) => box.appendChild(clusterCard(c)));
    const pasted = store.rePrompts.filter((r) => (done[r.id] ? done[r.id].type === "pasted_material" : A.isMaterialOnly(r)));
    if (pasted.length) box.appendChild(pastedCard(pasted));
    return;
  }
  if (a && store.preferLocal) {
    const n = el("div", "capture-note");
    n.appendChild(el("span", "", "Showing the built-in word-matching groups."));
    const sw = el("button", "btn secondary", "Use Claude's grouping");
    sw.addEventListener("click", () => { store.preferLocal = false; renderRePrompts(); });
    n.appendChild(sw);
    note.appendChild(n);
  }

  if (sum.clusters.length === 0 && !sum.pastedCount) {
    box.appendChild(el("div", "empty", "No grouped re-prompts yet. Groups appear once prompt text has been saved."));
    return;
  }
  sum.clusters.slice(0, 8).forEach((c) => {
    const users = c.userCount;
    const rule = A.draftRule(c.representative);
    box.appendChild(clusterCard({
      key: c.category + "|" + c.representative, tag: c.category, tagClass: promptTagClass(c.category),
      title: c.count + " times by " + users + (users === 1 ? " person" : " people"), cost: c.totalSeconds, review: c.reviewSeconds, write: c.writeSeconds,
      examples: c.examples, rule: rule, ruleLabel: "Draft rule from your own wording (edit before using):",
      note: rule ? "" : "No clean rule yet. Claude's grouping can write one.",
      members: c.items.map((r) => memberOf(r, r.text)),
    }));
  });
  if (sum.pastedCount) box.appendChild(pastedCard(sum.pasted));
}

// ---------------------------------------------------------------------------
// Re-prompts: shown per workflow, each one opens in place
// ---------------------------------------------------------------------------
async function setSetting(patch) {
  const d = await chrome.storage.local.get("settings");
  await localWrite({ settings: Object.assign({}, d.settings || {}, patch) });
}

// Whether prompt text is being saved, and why a chat might not be showing up (Data > Capture status)
function renderCaptureStatus() {
  const mode = store.settings.promptCapture || "off";
  const note = $("rpCaptureNote");
  note.textContent = "";
  if (mode === "off") {
    const b = el("div", "capture-note");
    b.appendChild(el("span", "", "Saving prompt text is off, so re-prompts are counted but not listed."));
    const a = el("button", "btn", "Turn on (names and numbers masked)");
    a.addEventListener("click", () => setSetting({ promptCapture: "redacted" }));
    const c = el("button", "btn secondary", "Turn on (full text)");
    c.addEventListener("click", () => setSetting({ promptCapture: "full" }));
    b.appendChild(a); b.appendChild(c);
    note.appendChild(b);
  } else {
    note.appendChild(el("div", "capture-note", "Saving every follow-up prompt (" + (mode === "full" ? "full text" : "names and numbers masked") + "), on this device only."));
  }
  const diag = $("rpDiag");
  diag.textContent = "";
  const liveSessions = store.aiSessions.filter((x) => x.source !== "seed");
  const counted = liveSessions.reduce((n, x) => n + Math.max((x.attempts || 0) - 1, 0), 0);
  const savedLive = store.rePrompts.filter((r) => r.source !== "seed").length;
  if (liveSessions.length === 0) {
    diag.appendChild(el("div", "capture-note", "No live chat seen yet. Refresh your ChatGPT, Claude or Gemini tab and look for the small Farfield button."));
  } else if (counted > savedLive) {
    diag.appendChild(el("div", "capture-note", "Counted " + counted + " follow-ups but saved " + savedLive + "; the rest were sent while saving was off."));
  }
}

async function renameWorkflowTo(from, to) {
  const plan = A.renameWorkflow(currentData(), from, to);
  if (!plan) { $("wfStatus").textContent = "Type a different name to rename it."; return; }
  if (plan.merged && !confirm("\u201c" + to + "\u201d already exists. Merge \u201c" + from + "\u201d into it? " + plan.sessions + " chats and " + plan.rePromptCount + " re-prompts move there. Nothing is deleted.")) return;
  store.openWf[from] = false;
  await localWrite({ aiSessions: plan.aiSessions, rePrompts: plan.rePrompts, fileRuns: plan.fileRuns });
  $("wfStatus").textContent = plan.merged ? "Merged into \u201c" + to + "\u201d." : "Renamed to \u201c" + to + "\u201d.";
}

async function splitWorkflowByChat(from) {
  const plan = A.splitWorkflow(currentData(), from);
  if (!plan.created) return;
  if (!confirm("Give each of the " + plan.created + " chats in \u201c" + from + "\u201d its own workflow? Names come from the tool and the time each chat started. Nothing is deleted, and you can rename or merge them afterwards.")) return;
  await localWrite({ aiSessions: plan.aiSessions, rePrompts: plan.rePrompts, fileRuns: plan.fileRuns });
  $("wfStatus").textContent = "Created " + plan.created + " workflows, one per chat.";
}

// How a workflow row came to hold its chats, read from its name, so a row never shows chats grouped together without saying why.
// Keep TASK_KINDS in step with KINDS in src/screen/task.js.
const TASK_KINDS = ["Spreadsheet help", "Slides", "Code", "Email draft", "Summary", "Job application", "Social post or announcement", "Memo or report",
  "Compliance writing", "Meeting prep", "Research and analysis", "Editing", "Brainstorming", "Advice and decisions", "Planning"];
function groupingNote(w) {
  const tools = listJoin(w.sites || []);
  if (TASK_KINDS.indexOf(w.name) >= 0)
    return { cls: "kind", text: "Grouped by kind of task: every task that began with " + (/^[aeiou]/i.test(w.name) ? "an " : "a ") + w.name.toLowerCase() + " request" + (tools ? ", from " + tools : "") + ". Only this label is kept, never the message." };
  const m = /^(.+) chat \(unsorted\)$/.exec(w.name);
  if (m) return { cls: "unsorted", text: "Not a real group. " + (w.sessions > 1 ? "These " + m[1] + " chats" : "This " + m[1] + " chat") + " could not be sorted: the opening request matched no kind of task, or the chat began before the watcher saw it. " + (w.sessions > 1 ? "Split them, then rename or merge each one." : "Rename it, or merge it into the right workflow.") };
  if (/^(.+) chat$/.test(w.name)) return { cls: "tool", text: "Grouped by tool only: every " + w.name.replace(/ chat$/, "") + " chat, whatever the task (the watcher\u2019s \u201ctool\u201d naming)." };
  return { cls: "named", text: w.sessions > 1 ? "Grouped by name: these chats share a name you gave them, an opening line, or a merge." : "One chat, named after its tool and start time, its opening line, or by you." };
}

function renderWorkflows() {
  const mode = store.settings.workflowMode === "fixed" ? "fixed" : "perChat";
  $("wfSub").textContent = mode === "perChat"
    ? "Chats are grouped by their workflow\u2019s name, and each row says how it got that name. The desktop watcher names a chat by its kind of task (\u201cSummary\u201d, \u201cEmail draft\u201d), so the same kind of task shares a row across tools and people, and a new request in the same chat starts its own row. Fixes to the AI\u2019s answer are counted as re-prompts, not new rows. The browser extension opens a new workflow for every chat. Rename a row to describe the job, or give two the same name to group them."
    : "Fixed mode: every new AI chat goes into the workflow chosen in the popup. Switch the popup to automatic to open a new workflow for each chat.";
  const rows = A.listWorkflows(currentData());
  const dl = $("wfnames");
  dl.textContent = "";
  rows.slice(0, 80).forEach((w) => { const o = el("option"); o.value = w.name; dl.appendChild(o); });
  const box = $("wfList");
  box.textContent = "";
  if (!rows.length) { box.appendChild(el("div", "empty", "No workflows yet. One opens automatically with your first AI chat.")); return; }
  rows.forEach((w) => {
    const card = el("div", "card wf-card");
    const top = el("div", "wf-top");
    top.appendChild(el("span", "wf-name", w.name));
    top.appendChild(el("span", w.live ? "live-badge" : "sample-badge", w.live ? "Live" : "Sample"));
    card.appendChild(top);
    const why = groupingNote(w);
    card.appendChild(el("div", "wf-why wf-why-" + why.cls, why.text));
    const secs = w.reviewSeconds + w.writeSeconds;
    card.appendChild(el("div", "wf-meta", w.sessions + (w.sessions === 1 ? " chat, " : " chats, ") + w.attempts + " attempts, " + w.rePrompts + (w.rePrompts === 1 ? " re-prompt saved" : " re-prompts saved") + (w.files ? ", " + w.files + (w.files === 1 ? " output file" : " output files") : "") + (secs ? ", " + fmtSecs(secs) + " reviewing and writing" : "") + (w.lastAt ? ", last used " + fmtDate(w.lastAt) : "")));
    const actions = el("div", "actions");
    const open = !!store.openWf[w.name];
    const edit = el("button", "btn secondary", open ? "Cancel" : "Rename or merge");
    edit.setAttribute("aria-expanded", open ? "true" : "false");
    edit.addEventListener("click", () => { store.openWf[w.name] = !open; renderWorkflows(); });
    actions.appendChild(edit);
    if (w.sessions > 1) {
      const split = el("button", "btn secondary", "Split into one workflow per chat");
      split.addEventListener("click", () => splitWorkflowByChat(w.name));
      actions.appendChild(split);
    }
    card.appendChild(actions);
    if (open) {
      const row = el("div", "wf-edit");
      const inp = el("input"); inp.type = "text"; inp.value = w.name; inp.setAttribute("list", "wfnames"); inp.setAttribute("aria-label", "New name for " + w.name);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") renameWorkflowTo(w.name, inp.value); });
      const save = el("button", "btn", "Save");
      save.addEventListener("click", () => renameWorkflowTo(w.name, inp.value));
      row.appendChild(inp); row.appendChild(save);
      row.appendChild(el("span", "note", "Pick an existing name from the list to merge them."));
      card.appendChild(row);
    }
    box.appendChild(card);
  });
}

function render() {
  renderCompanyChrome();
  renderTeamFilter();
  renderAgentFilter();
  const corrections = visible(store.corrections);
  const fixes = visible(store.fixes);
  const sends = visible(store.sends);

  const patterns = A.buildPatterns(corrections, fixes, store.basis);
  const ranked = A.rankOpenPatterns(patterns);

  renderStats(corrections, ranked);
  renderQueue(ranked);
  renderMonitor(fixes, sends);
  renderRecent(corrections);
  renderReprompt();
  renderWorkflows();
  renderTrace();
  renderOutputs();
  renderCaptureStatus();
  renderRePrompts();
  renderLlmPanel();
  renderSampleBanner();
  renderExec();
  renderTeams();
  renderAssign();
  renderTests();
  syncThemeButtons();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function load() {
  const seq = ++store.loadSeq;
  const data = await chrome.storage.local.get(["corrections", "sends", "fixes", "settings", "aiSessions", "rePrompts", "fileRuns", "llmKey", "promptAnalysis", "company", "viewMode"]);
  if (seq !== store.loadSeq) return;   // a newer load has started; let it win
  const arr = (x) => (Array.isArray(x) ? x : []);
  store.llmKey = typeof data.llmKey === "string" ? data.llmKey : "";
  store.promptAnalysis = data.promptAnalysis && data.promptAnalysis.items ? data.promptAnalysis : null;
  const localSettings = data.settings || { agents: [] };
  store.company = data.company && data.company.token ? data.company : null;
  store.view = store.company && data.viewMode === "company" ? "company" : "mine";
  let useCompany = false;
  if (store.view === "company") {
    if (store.company.signedOut) store.companyError = "Your access to this company was removed. Open the extension popup to join again.";
    else if (!window.FarfieldSync) store.companyError = "Company sync isn't available here.";
    else {
      try {
        const d = await window.FarfieldSync.fetchOrgData();
        if (seq !== store.loadSeq) return;
        ["corrections", "sends", "fixes", "aiSessions", "rePrompts", "fileRuns"].forEach((k) => { store[k] = arr(d.data[k]); });
        const cs = d.settings || {};
        store.settings = Object.assign({}, localSettings, { agents: arr(cs.agents), agentTeams: cs.agentTeams || {}, hourlyRate: cs.hourlyRate || 60 });
        if (cs.targetHoursPerWeek) store.settings.targetHoursPerWeek = cs.targetHoursPerWeek; else delete store.settings.targetHoursPerWeek;
        store.rate = Number(cs.hourlyRate) > 0 ? Number(cs.hourlyRate) : 60;
        store.me = d.me; store.companyOrg = d.org; store.companyError = ""; useCompany = true;
      } catch (e) {
        if (seq !== store.loadSeq) return;
        store.companyError = e && e.status === 401 ? "Your access to this company was removed. Open the extension popup to join again." : (e && e.message) || "Couldn't load company data.";
      }
    }
  } else store.companyError = "";
  store.companyActive = useCompany;
  if (!useCompany) {
    ["corrections", "sends", "fixes", "aiSessions", "rePrompts", "fileRuns"].forEach((k) => { store[k] = arr(data[k]); });
    store.settings = localSettings;
    if (store.firstRender || store.wasCompany) store.rate = Number(store.settings.hourlyRate) > 0 ? Number(store.settings.hourlyRate) : 60;
  }
  render();
  if (store.firstRender) {
    store.firstRender = false;
    const h = parseHash();
    showTab(h.tab, h.anchor, h.sub);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  // The background sync updates its own bookkeeping every minute; that alone shouldn't redraw the page.
  if (area === "local" && Object.keys(changes).some((k) => k !== "syncState" && k !== "lastServer")) load();
});
setInterval(() => { if (store.view === "company" && !document.hidden) load(); }, 60000);

$("agentFilter").addEventListener("change", (e) => {
  store.agentFilter = e.target.value;
  render();
});

$("basis").addEventListener("change", (e) => {
  store.basis = e.target.value;
  render();
});

$("viewMine").addEventListener("click", () => chrome.storage.local.set({ viewMode: "mine" }));
$("viewCompany").addEventListener("click", () => chrome.storage.local.set({ viewMode: "company" }));
$("companyRefresh").addEventListener("click", () => load());

$("resetBtn").addEventListener("click", () => {
  if (inCompany()) return;
  if (!confirm("Replace all data with the sample demo data?")) return;
  chrome.runtime.sendMessage({ type: "RESET_DEMO_DATA" }, () => {
    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message);
  });
});

$("clearBtn").addEventListener("click", () => {
  if (inCompany()) return;
  if (!confirm("Delete all corrections, sends and approved fixes?")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_DATA" }, () => {
    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message);
  });
});

$("importBtn").addEventListener("click", async () => {
  const status = $("importStatus");
  let parsed;
  try {
    parsed = JSON.parse($("importText").value);
  } catch (e) {
    status.textContent = "That is not valid JSON.";
    return;
  }
  const incomingCorrections = (Array.isArray(parsed.corrections) ? parsed.corrections : [])
    .map((c) => A.sanitizeCorrection(c))
    .filter(Boolean);
  const incomingSends = (Array.isArray(parsed.sends) ? parsed.sends : [])
    .map((s) => A.sanitizeSend(s))
    .filter(Boolean);

  const haveIds = new Set(store.corrections.map((c) => c.id));
  const haveSendKeys = new Set(store.sends.map((s) => s.t + "|" + s.agent));
  const newCorrections = incomingCorrections.filter((c) => !haveIds.has(c.id));
  const newSends = incomingSends.filter((s) => !haveSendKeys.has(s.t + "|" + s.agent));

  const agents = new Set(store.settings.agents || []);
  newSends.forEach((s) => agents.add(s.agent));
  const settings = Object.assign({}, store.settings, { agents: Array.from(agents) });

  await localWrite({
    corrections: store.corrections.concat(newCorrections),
    sends: store.sends.concat(newSends),
    settings: settings,
  });
  status.textContent = "Imported " + newCorrections.length + " corrections and " + newSends.length + " draft records.";
  $("importText").value = "";
});


// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function syncThemeButtons() {
  const t = window.FarfieldTheme ? window.FarfieldTheme.current() : "light";
  $("themeLight").setAttribute("aria-pressed", t === "light" ? "true" : "false");
  $("themeDark").setAttribute("aria-pressed", t === "dark" ? "true" : "false");
}
$("themeLight").addEventListener("click", () => { window.FarfieldTheme.set("light").then(syncThemeButtons); syncThemeButtons(); });
$("themeDark").addEventListener("click", () => { window.FarfieldTheme.set("dark").then(syncThemeButtons); syncThemeButtons(); });

// ---------------------------------------------------------------------------
// Sample data, export and import
// ---------------------------------------------------------------------------
function currentData() {
  return { corrections: store.corrections, sends: store.sends, fixes: store.fixes, aiSessions: store.aiSessions, rePrompts: store.rePrompts, fileRuns: store.fileRuns, settings: store.settings };
}

function renderCompanyChrome() {
  const joined = !!store.company;
  $("viewSeg").hidden = !joined;
  $("viewMine").setAttribute("aria-pressed", store.view === "company" ? "false" : "true");
  $("viewCompany").setAttribute("aria-pressed", store.view === "company" ? "true" : "false");
  document.body.classList.toggle("company", inCompany());
  const bar = $("companyBar");
  bar.hidden = !(joined && store.view === "company");
  if (!bar.hidden) {
    $("companyText").textContent = inCompany()
      ? store.companyOrg.name + ". " + (store.companyOrg.synthetic ? "All of it is sample data. " : "") + "You are " + (ROLE_LABEL[store.me.role] || store.me.role) + ". " + companyNote(store.me.role) + " "
      : (store.companyError || "Couldn't load company data.") + " Showing your own data instead. ";
  }
  // the company's rate and target are set by the company; your own are yours
  if (inCompany()) {
    $("execRate").disabled = true; $("execTarget").disabled = true;
    $("execRate").value = String(store.rate);
    $("execTarget").value = store.settings.targetHoursPerWeek ? String(store.settings.targetHoursPerWeek) : "";
    store.wasCompany = true;
    if (store.tab === "data") goTab("overview");
  } else {
    $("execRate").disabled = false; $("execTarget").disabled = false;
    if (store.wasCompany) { $("execRate").value = String(store.rate); $("execTarget").value = store.settings.targetHoursPerWeek ? String(store.settings.targetHoursPerWeek) : ""; store.wasCompany = false; }
  }
}

function renderSampleBanner() {
  if (inCompany()) {
    // The company bar carries the label (and says so when the company is the synthetic demo one), so there is no second banner.
    $("sampleBanner").hidden = true;
    $("removeSampleBtn").hidden = true; $("hideSampleBtn").hidden = true;
    return;
  }
  $("removeSampleBtn").hidden = false; $("hideSampleBtn").hidden = false;
  const n = A.sampleCounts(currentData());
  const live = store.corrections.concat(store.rePrompts, store.aiSessions).filter((x) => x.source !== "seed").length;
  const noticeOn = store.settings.hideSampleNotice !== true;
  $("sampleBanner").hidden = n === 0 || !noticeOn;
  $("sampleNoticeToggle").checked = noticeOn;
  $("sampleBannerText").textContent = live
    ? "Your own data is shown alongside " + n + " sample records. Remove the sample records to see only yours."
    : "Everything here is sample data for now. Your own data appears as you use Gmail and AI chat sites.";
  $("sampleInfo").textContent = n
    ? n + " sample records are included so the dashboard is not empty. Removing them never touches your own data."
    : "No sample data is present.";
  $("removeSampleBtn2").disabled = n === 0;
}

async function removeSampleData() {
  const n = A.sampleCounts(currentData());
  if (!n) return;
  if (!confirm("Remove " + n + " sample records? Your own data is not touched.")) return;
  const r = A.removeSample(currentData());
  await localWrite(r.result);
}
$("removeSampleBtn").addEventListener("click", removeSampleData);
$("hideSampleBtn").addEventListener("click", () => setSetting({ hideSampleNotice: true }));
$("sampleNoticeToggle").addEventListener("change", (e) => setSetting({ hideSampleNotice: !e.target.checked }));
$("removeSampleBtn2").addEventListener("click", removeSampleData);

$("exportBtn").addEventListener("click", () => {
  const payload = A.buildExport(currentData(), chrome.runtime.getManifest().version);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "farfield-data-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  $("exportStatus").textContent = "Downloaded " + store.corrections.length + " corrections, " + store.rePrompts.length + " re-prompts and " + store.aiSessions.length + " chat sessions.";
});

$("importFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $("dataText").value = String(reader.result || ""); previewImport(); };
  reader.readAsText(file);
});

function readOptions() {
  return { liveOnly: $("optLive").checked, mode: $("optMode").value, takeSettings: $("optSettings").checked };
}

function planLine(label, c) {
  const bits = [c.added + " to add"];
  if (c.duplicates) bits.push(c.duplicates + " already here");
  if (c.skippedSample) bits.push(c.skippedSample + " sample skipped");
  if (c.invalid) bits.push(c.invalid + " unreadable");
  const row = el("div", "plan-line");
  row.appendChild(el("span", "", label + " (" + c.found + " in file)"));
  row.appendChild(el("span", "", bits.join(", ")));
  return row;
}

function previewImport() {
  const box = $("dataStatus");
  box.hidden = false;
  box.textContent = "";
  store.plan = null;
  $("dataApply").disabled = true;
  let parsed;
  try { parsed = JSON.parse($("dataText").value); } catch (e) { box.textContent = "That is not valid JSON. Choose the exported file or paste its full contents."; return; }
  const plan = A.planImport(currentData(), parsed, readOptions());
  if (plan.error) { box.textContent = plan.error; return; }
  const c = plan.counts;
  box.appendChild(el("div", "", plan.mode === "replace" ? "Replace mode: what is here now will be replaced." : "Add mode: nothing here is removed or changed."));
  box.appendChild(planLine("Corrections", c.corrections));
  box.appendChild(planLine("Re-prompts", c.rePrompts));
  box.appendChild(planLine("AI chat sessions", c.aiSessions));
  box.appendChild(planLine("Draft sends", c.sends));
  box.appendChild(planLine("Approved fixes", c.fixes));
  const total = Object.keys(c).filter((k) => k !== "settings").reduce((n, k) => n + c[k].added, 0);
  box.appendChild(el("div", "note", total ? total + " records will be added." : "Nothing new to import with these options."));
  store.plan = plan;
  $("dataApply").disabled = plan.mode !== "replace" && total === 0;
}

$("dataPreview").addEventListener("click", previewImport);
["optLive", "optMode", "optSettings"].forEach((id) => $(id).addEventListener("change", () => { if ($("dataText").value.trim()) previewImport(); }));

$("dataApply").addEventListener("click", async () => {
  if (!store.plan) return;
  if (store.plan.mode === "replace" && !confirm("Replace everything currently stored with the contents of this file? Export a backup first if you are unsure.")) return;
  const plan = store.plan;
  await localWrite(plan.result);
  const c = plan.counts;
  const added = Object.keys(c).filter((k) => k !== "settings").reduce((n, k) => n + c[k].added, 0);
  $("dataStatus").textContent = "Imported " + added + " records. Corrections: " + c.corrections.added + ", re-prompts: " + c.rePrompts.added + ", chat sessions: " + c.aiSessions.added + ".";
  $("dataApply").disabled = true;
  $("dataText").value = "";
  store.plan = null;
});

$("copySnippet").addEventListener("click", () => {
  const text = "chrome.storage.local.get(null).then(d => { const a = document.createElement(\"a\"); a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], {type: \"application/json\"})); a.download = \"farfield-v24-data.json\"; a.click(); })";
  const done = () => { $("snippetStatus").textContent = "Copied."; };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
});

// ---------------------------------------------------------------------------
// Import past chats (ChatGPT / Claude exports, or pasted text)
// ---------------------------------------------------------------------------
function readFileAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("Could not read the file."));
    if (how === "buffer") r.readAsArrayBuffer(file); else r.readAsText(file);
  });
}

async function readChatFiles(files) {
  const CI = window.FarfieldChatImport, convs = [], notes = [];
  let unknown = 0;
  for (const f of files) {
    try {
      let texts;
      if (/\.zip$/i.test(f.name) || f.type === "application/zip") {
        const entries = await CI.unzipConversations(await readFileAs(f, "buffer"));
        if (!entries.length) { notes.push(f.name + ": no conversations file was found inside this zip."); continue; }
        texts = entries.map((e) => e.text);
      } else texts = [await readFileAs(f, "text")];
      texts.forEach((t) => { const p = CI.parseChatExport(CI.parseFileText(t)); p.conversations.forEach((c) => convs.push(c)); unknown += p.unknown; });
    } catch (e) { notes.push(f.name + ": " + e.message); }
  }
  if (unknown) notes.push(unknown + " entries were not recognized as ChatGPT or Claude conversations and were skipped.");
  return { convs: convs, notes: notes };
}

function impOptions() {
  return { mode: $("impMode").value, nameFrom: $("impTitles").checked ? "title" : "auto", includeSingle: $("impSingles").checked };
}

function previewChatImport() {
  const box = $("impStatus");
  box.hidden = false; box.textContent = "";
  store.impPlan = null; $("impApply").disabled = true;
  store.impNotes.forEach((n) => box.appendChild(el("div", "note", n)));
  if (!store.impConvs.length) { box.appendChild(el("div", "", "No conversations found yet. Choose an export file, or paste a conversation and press Read the pasted text.")); return; }
  const plan = window.FarfieldChatImport.planChatImport(store.impConvs, currentData(), impOptions());
  const s = plan.summary;
  const platforms = Object.keys(s.byPlatform).map((k) => s.byPlatform[k] + " from " + k).join(", ");
  box.appendChild(el("div", "", "Found " + s.chats + (s.chats === 1 ? " chat." : " chats.")));
  const line = (a, b) => { const r = el("div", "plan-line"); r.appendChild(el("span", "", a)); r.appendChild(el("span", "", b)); box.appendChild(r); };
  line("Will import", s.imported + " chats" + (platforms ? " (" + platforms + ")" : "") + ", " + s.rePrompts + " re-prompts");
  if (s.noFollowUps) line("Skipped, no follow-up prompts", s.noFollowUps + " chats (tick the option above to include them)");
  if (s.duplicates) line("Already imported", s.duplicates + " chats");
  if (s.truncated) line("Over the limit of 3000 chats per import", s.truncated + " not read");
  plan.preview.forEach((p) => { const r = el("div", "plan-line"); r.appendChild(el("span", "", p.workflow + " (" + p.platform + ")")); r.appendChild(el("span", "", p.followUps + (p.followUps === 1 ? " re-prompt" : " re-prompts") + (p.sample ? ": " + p.sample : ""))); box.appendChild(r); });
  if (s.imported > plan.preview.length) box.appendChild(el("div", "note", "and " + (s.imported - plan.preview.length) + " more."));
  store.impPlan = plan;
  $("impApply").disabled = s.imported === 0;
  if (s.imported === 0) box.appendChild(el("div", "note", "Nothing new to import with these options."));
}

$("chatFiles").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  $("impReading").textContent = "Reading " + files.length + (files.length === 1 ? " file" : " files") + "\u2026";
  const r = await readChatFiles(files);
  store.impConvs = r.convs; store.impNotes = r.notes;
  $("impReading").textContent = "";
  previewChatImport();
});

$("pasteRead").addEventListener("click", () => {
  const text = $("pasteText").value;
  const t = window.FarfieldChatImport.parseTranscript(text, { platform: $("pasteTool").value, when: Date.now() });
  store.impNotes = [];
  if (!t.conversation.messages.length) { store.impConvs = []; store.impNotes.push("Nothing to read yet. Paste a conversation or some prompts first."); previewChatImport(); return; }
  store.impNotes.push(t.mode === "roles" ? "Read it as a conversation with speaker labels." : "No speaker labels found, so each paragraph (or each block between --- lines) is treated as one of your prompts.");
  store.impConvs = [t.conversation];
  const name = $("pasteName").value.trim();
  store.impPasteName = name;
  previewChatImport();
});

["impTitles", "impSingles", "impMode"].forEach((id) => $(id).addEventListener("change", () => { if (store.impConvs.length) previewChatImport(); }));

$("impApply").addEventListener("click", async () => {
  if (!store.impPlan) return;
  let plan = store.impPlan;
  if (store.impConvs.length === 1 && store.impConvs[0].convId.indexOf("paste_") === 0 && store.impPasteName) {
    plan = window.FarfieldChatImport.planChatImport(store.impConvs, currentData(), Object.assign(impOptions(), { workflow: store.impPasteName }));
  }
  await localWrite(plan.result);
  const s = plan.summary;
  $("impStatus").textContent = "Imported " + s.imported + (s.imported === 1 ? " chat" : " chats") + " and " + s.rePrompts + " re-prompts. Open the chat's workflow to read them.";
  $("impApply").disabled = true;
  store.impConvs = []; store.impPlan = null; store.impPasteName = "";
  $("pasteText").value = "";
});

// ---------------------------------------------------------------------------
// Re-sorting saved prompts, and the optional Claude analysis
// ---------------------------------------------------------------------------
$("recatBtn").addEventListener("click", async () => {
  const r = A.recategorize(store.rePrompts);
  if (!r.changed) { $("recatStatus").textContent = "Nothing needed changing."; return; }
  await localWrite({ rePrompts: r.list });
  $("recatStatus").textContent = "Re-sorted " + r.changed + " saved prompts. Pasted material is now listed separately. Your saved text was not changed.";
});

function renderLlmPanel() {
  $("llmKeyStatus").textContent = store.llmKey ? "Key saved (ends in " + store.llmKey.slice(-4) + ")." : "No key saved.";
  $("llmRemove").disabled = !store.llmKey;
  $("llmRun").disabled = store.llmBusy;
}

$("llmSave").addEventListener("click", async () => {
  const k = $("llmKey").value.trim();
  if (!k) { $("llmKeyStatus").textContent = "Paste your API key first."; return; }
  await localWrite({ llmKey: k });
  $("llmKey").value = "";
});

$("llmRemove").addEventListener("click", async () => {
  await localWrite({ llmKey: "" });
});

$("llmRun").addEventListener("click", async () => {
  const status = $("llmStatus");
  if (!store.llmKey) { status.textContent = "Save your API key first."; return; }
  const redact = $("llmRedact").checked;
  const model = $("llmModel").value.trim() || window.FarfieldLLM.DEFAULT_MODEL;
  const done = store.promptAnalysis && store.promptAnalysis.items ? store.promptAnalysis.items : {};
  const todo = store.rePrompts.filter((r) => r.kind !== "regen" && r.text && !done[r.id]).length;
  if (!todo && !store.rePrompts.some((r) => r.kind !== "regen" && r.text)) { status.textContent = "There are no saved prompts to analyze yet."; return; }
  if (todo && !confirm("This sends " + Math.min(todo, 400) + " saved prompts to Anthropic's API using your key (" + (redact ? "names, numbers and emails masked" : "NOT masked") + "), then groups them. Continue?")) return;
  try {
    if (chrome.permissions && chrome.permissions.request) {
      const granted = await chrome.permissions.request({ origins: ["https://api.anthropic.com/*"] });
      if (!granted) { status.textContent = "Permission to contact api.anthropic.com was not granted, so nothing was sent."; return; }
    }
    store.llmBusy = true; renderLlmPanel();
    const r = await window.FarfieldLLM.runAnalysis({
      fetch: (u, i) => fetch(u, i), apiKey: store.llmKey, model: model, rePrompts: store.rePrompts, existing: store.promptAnalysis, redact: redact,
      onProgress: (m) => { status.textContent = m; },
      onPartial: (partial) => localWrite({ promptAnalysis: partial }),
    });
    await localWrite({ promptAnalysis: r.analysis });
    store.preferLocal = false;
    status.textContent = "Done. Read " + r.stats.analyzed + " new prompts and grouped " + r.stats.clustered + " requests into " + r.analysis.clusters.length + " groups.";
  } catch (e) {
    status.textContent = e.message || "Something went wrong.";
  } finally {
    store.llmBusy = false; renderLlmPanel();
  }
});
// ---------------------------------------------------------------------------
// Output files: what you changed between the AI's version and your final version
// ---------------------------------------------------------------------------
function fmtMin(m) {
  if (!m || m < 0.05) return "0 min";
  if (m < 1) return "<1 min";
  if (m >= 90) return (m / 60).toFixed(1) + " h";
  return Math.round(m) + " min";
}

function fillSelect(sel, options, current) {
  const key = options.map((o) => o.value + "\u0001" + o.label).join("\u0002");
  if (sel.dataset.key !== key) {
    sel.textContent = "";
    options.forEach((o) => { const op = el("option", "", o.label); op.value = o.value; sel.appendChild(op); });
    sel.dataset.key = key;
  }
  sel.value = options.some((o) => o.value === current) ? current : (options[0] ? options[0].value : "");
}

function pickDefaultWorkflow(rows) {
  const r = rows.find((x) => x.files && x.live) || rows.find((x) => x.live && x.sessions) || rows.find((x) => x.files) || rows[0];
  return r ? r.name : "";
}

function chgNode(c) {
  const row = el("div", "chg");
  row.appendChild(el("span", "a", c.addr + "  "));
  if (c.before) row.appendChild(el("span", "b", c.before));
  row.appendChild(el("span", "a", c.before && c.after ? "  \u2192  " : c.after ? "added  " : "removed"));
  if (c.after) row.appendChild(el("span", "c", c.after));
  return row;
}

function step(n, title, nodes, empty) {
  const sec = el("div", "stepsec" + (empty ? " empty-step" : ""));
  const h = el("h4");
  h.appendChild(el("span", "n", String(n)));
  h.appendChild(document.createTextNode(title));
  sec.appendChild(h);
  nodes.forEach((x) => { if (x) sec.appendChild(x); });
  return sec;
}

function listJoin(a) { return a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
function toolsShort(a) { return a.slice(0, 2).join(", ") + (a.length > 2 ? " +" + (a.length - 2) : ""); }

function renderWorkflowList(rows) {
  const box = $("wfItems");
  box.textContent = "";
  const q = ($("wfSearch").value || "").trim().toLowerCase();
  const shown = rows.filter((r) => !q || r.name.toLowerCase().indexOf(q) !== -1 || r.team.toLowerCase().indexOf(q) !== -1);
  if (!shown.length) box.appendChild(el("div", "note", rows.length ? "No workflow matches your search." : "No workflows yet."));
  shown.forEach((r) => {
    const b = el("button", "wf-item");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", r.name === store.traceWf ? "true" : "false");
    b.appendChild(el("b", "", r.name));
    b.appendChild(el("span", "", r.team + (r.tools.length ? " \u00b7 " + toolsShort(r.tools) : "")));
    const bits = [r.rePrompts + (r.rePrompts === 1 ? " re-prompt" : " re-prompts")];
    if (r.files) bits.push(r.files + (r.files === 1 ? " file" : " files"));
    bits.push(fmtMin(r.minutes) + " human time");
    if (!r.live) bits.push("Sample");
    b.appendChild(el("span", "", bits.join(" \u00b7 ")));
    b.addEventListener("click", () => { store.traceWf = r.name; renderTrace(); });
    box.appendChild(b);
  });
}

function renderWorkflowSide(t) {
  // recommended fixes
  const fx = $("wfFixes");
  fx.textContent = "";
  fx.appendChild(el("h3", "", "Recommended fixes"));
  const fixes = A.workflowFixes(currentData(), t.name);
  if (!fixes.length) fx.appendChild(el("div", "note", "No recurring pattern yet. A fix is suggested once the same kind of correction keeps happening."));
  fixes.forEach((f) => {
    const c = el("div", "fixcard");
    const h = el("div", "fh");
    h.appendChild(el("span", "route " + routeClass(f.route), f.route));
    h.appendChild(el("span", "", "from " + f.source));
    h.appendChild(el("span", "", fmtMin(f.minutes) + " of human time"));
    c.appendChild(h);
    c.appendChild(el("div", "ft", f.title));
    c.appendChild(el("div", "fe", f.evidence));
    const full = el("div", "fr");
    full.hidden = true;
    full.appendChild(el("div", "", (f.route === R.ENGINEERING ? "Suggested ticket: " : "Proposed instruction: ") + f.rule));
    const cp = el("button", "link-btn", "Copy");
    cp.addEventListener("click", () => copyText(cp, f.rule));
    full.appendChild(cp);
    const tg = el("button", "link-btn", f.route === R.ENGINEERING ? "Show the suggested ticket" : "Show the proposed instruction");
    tg.setAttribute("aria-expanded", "false");
    tg.addEventListener("click", () => { full.hidden = !full.hidden; tg.setAttribute("aria-expanded", full.hidden ? "false" : "true"); });
    c.appendChild(tg);
    c.appendChild(full);
    fx.appendChild(c);
  });
  const all = el("button", "link-btn", "See every fix for the whole team");
  all.style.marginTop = "6px";
  all.addEventListener("click", () => goTab("fixes"));
  fx.appendChild(all);

  // re-prompts: each one opens in place
  const labels = A.personLabels(t.rePrompts), people = Object.keys(labels).length;
  const others = t.rePrompts.some((r) => (r.user || "You") !== "You") && !(inCompany() && store.me && store.me.role === "engineering");
  $("wfRpNote").textContent = t.rePrompts.length
    ? t.rePrompts.length + (t.rePrompts.length === 1 ? " re-prompt" : " re-prompts") + " by " + people + (people === 1 ? " person" : " people") + "." + (others ? " Other people's wording is shown as themes only." : "")
    : "";
  const themeOf = (r) => (r.kind === "regen" ? A.themeWording(C_REGEN) : A.isMaterialOnly(r) ? A.themeWording("Pasted material (not an instruction)") : A.themeWording(r.category));
  const counts = {};
  t.rePrompts.forEach((r) => { const k = themeOf(r); counts[k] = (counts[k] || 0) + 1; });
  const themes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  fillSelect($("wfTheme"), [{ value: "all", label: "All themes (" + t.rePrompts.length + ")" }].concat(themes.map((k) => ({ value: k, label: k + " (" + counts[k] + ")" }))), store.rpTheme);
  store.rpTheme = $("wfTheme").value;
  $("wfTheme").hidden = themes.length < 2;
  const frame = $("wfRePrompts");
  frame.textContent = "";
  if (!t.rePrompts.length) frame.appendChild(el("div", "note", "No re-prompts were saved for this workflow.")).style.padding = "10px 12px";
  const shown = t.rePrompts.filter((r) => store.rpTheme === "all" || themeOf(r) === store.rpTheme);
  shown.slice(0, 300).forEach((r) => {
    const own = (r.user || "You") === "You";
    const seeText = own || (inCompany() && store.me && store.me.role === "engineering");
    const wrap = el("div", "rp");
    let text;
    if (r.kind === "regen") text = "Regenerated without instructions";
    else if (A.isMaterialOnly(r)) text = "Pasted material (not an instruction)";
    else if (seeText) text = A.instructionOf(r) || r.text || "Text not stored.";
    else text = A.themeWording(r.category);
    const times = [];
    if (r.reviewSeconds) times.push("reviewed " + fmtSecs(r.reviewSeconds));
    if (r.writeSeconds) times.push("wrote " + fmtSecs(r.writeSeconds));
    if (!times.length && r.gapSeconds) times.push("sent " + fmtSecs(r.gapSeconds) + " after the reply");
    const open = !!store.openRpIds[r.id];
    const btn = el("button", "rp-row");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.appendChild(el("span", "chev"));
    const col = el("span", "col");
    col.appendChild(el("span", "rt", text));
    col.appendChild(el("span", "tm", "Attempt " + r.attemptIndex + (times.length ? " \u00b7 " + times.join(", ") : "")));
    btn.appendChild(col);
    const detail = el("div", "rp-detail");
    detail.hidden = !open;
    const kv = el("dl", "kv");
    const row = (a, b) => { kv.appendChild(el("dt", "", a)); kv.appendChild(el("dd", "", b)); };
    row("Who", labels[r.user || "You"]);
    row("Theme", themeOf(r));
    row("When", fmtDate(r.timestamp) + " in " + (r.site || "an AI tool"));
    if (r.reviewSeconds) row("Looked at the answer", fmtSecs(r.reviewSeconds));
    if (r.writeSeconds) row("Wrote the prompt", fmtSecs(r.writeSeconds));
    if (!r.reviewSeconds && !r.writeSeconds && r.gapSeconds) row("Sent after the reply", fmtSecs(r.gapSeconds));
    row("Source", r.imported ? "Imported from a past chat" : r.source === "seed" ? "Sample data" : "Captured live");
    detail.appendChild(kv);
    if (seeText && r.kind !== "regen" && r.text) { const w = el("p", "wording", r.text); detail.appendChild(w); }
    else if (!seeText && r.kind !== "regen") detail.appendChild(el("p", "note", "The wording is hidden in the executive view. Only the theme is shown."));
    btn.addEventListener("click", () => {
      const nowOpen = detail.hidden;
      detail.hidden = !nowOpen;
      btn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
      store.openRpIds[r.id] = nowOpen;
    });
    wrap.appendChild(btn); wrap.appendChild(detail);
    frame.appendChild(wrap);
  });
  if (shown.length > 300) { const m = el("div", "note", "Showing the first 300 of " + shown.length + "."); m.style.padding = "8px 12px"; frame.appendChild(m); }
}

function renderTrace() {
  const idx = A.workflowIndex(currentData());
  const rows = idx.filter((r) => store.team === "all" || r.team === store.team);
  const body = $("traceBody");
  body.textContent = "";
  if (!rows.length) {
    renderWorkflowList(rows);
    body.appendChild(el("div", "empty", store.team === "all" ? "No workflows yet. One opens automatically with your first AI chat, and you can link an output file under Link an output file." : "No workflows for this team yet."));
    $("wfFixes").textContent = ""; $("wfRePrompts").textContent = ""; $("wfRpNote").textContent = "";
    return;
  }
  if (!rows.some((r) => r.name === store.traceWf)) store.traceWf = pickDefaultWorkflow(rows);
  renderWorkflowList(rows);
  const row = rows.find((r) => r.name === store.traceWf);
  const t = A.traceWorkflow(currentData(), store.traceWf);

  const head = el("div", "wf-head");
  head.appendChild(el("h3", "", t.name));
  const chips = el("div", "legend");
  chips.style.marginTop = "0";
  chips.appendChild(el("span", "tag tag-other", row.team));
  if (row.tools.length) chips.appendChild(el("span", "", listJoin(row.tools)));
  if (row.peopleCount) chips.appendChild(el("span", "", row.peopleCount + (row.peopleCount === 1 ? " person" : " people")));
  chips.appendChild(el("span", row.live ? "live-badge" : "sample-badge", row.live ? "Live" : "Sample"));
  head.appendChild(chips);
  body.appendChild(head);

  // 1. the chat
  const chat = [];
  if (t.sessions.length || t.rePrompts.length) {
    chat.push(el("div", "note", t.sessions.length + (t.sessions.length === 1 ? " chat" : " chats") + " in " + (listJoin(t.sites) || "an AI tool") + ", " + t.attempts + " attempts. First prompts are never saved."));
  } else chat.push(el("div", "note", "No AI chat is linked to this workflow. Choose the chat when you upload the file."));
  body.appendChild(step(1, "The AI chat", chat, !(t.sessions.length || t.rePrompts.length)));

  // 2. re-prompts, summarised by theme (the full list is in the frame on the right)
  const rp = [];
  if (!t.rePrompts.length) rp.push(el("div", "note", "No re-prompts were saved for this workflow."));
  else {
    const themes = {};
    t.rePrompts.forEach((r) => { const k = r.kind === "regen" ? A.themeWording(C_REGEN) : A.isMaterialOnly(r) ? A.themeWording("Pasted material (not an instruction)") : A.themeWording(r.category); themes[k] = (themes[k] || 0) + 1; });
    const keys = Object.keys(themes).sort((a, b) => themes[b] - themes[a]), top = themes[keys[0]];
    keys.slice(0, 6).forEach((k) => {
      const line = el("div", "trow");
      line.appendChild(el("span", "tt", k));
      line.appendChild(el("span", "note", themes[k] + (themes[k] === 1 ? " time" : " times")));
      rp.push(line);
      const bar = el("div", "rbar"); const fill = el("i"); fill.style.width = Math.round(themes[k] / top * 100) + "%"; bar.appendChild(fill); rp.push(bar);
    });
    rp.push(el("div", "note", "Time spent re-prompting: " + fmtMin(t.promptMinutes) + "."));
  }
  body.appendChild(step(2, "Re-prompts (" + t.rePrompts.length + ")", rp, !t.rePrompts.length));

  // 3. the output file
  const files = [];
  if (!t.hasFile) {
    const c = el("div", "callout");
    c.appendChild(el("span", "", "No output file is linked yet. Upload the AI's version and your final version to see what you changed."));
    const b = el("button", "btn secondary", "Link a file");
    b.addEventListener("click", () => goTab("trace", "outputs"));
    c.appendChild(b);
    files.push(c);
  }
  t.fileRuns.forEach((f) => {
    const frow = el("div", "trow");
    frow.appendChild(el("span", "tag tag-content", f.surface));
    frow.appendChild(el("span", "tt", f.fileName || "(unnamed file)"));
    frow.appendChild(el("span", "note", f.totalCells + (f.type === "xlsx" ? " filled cells" : f.type === "docx" ? " paragraphs" : " pieces of text") + " in the AI's version"));
    frow.appendChild(el("span", f.source === "seed" ? "sample-badge" : "live-badge", f.source === "seed" ? "Sample" : "Live"));
    files.push(frow);
  });
  body.appendChild(step(3, "The output file", files, !t.hasFile));

  // 4. your edits
  const edits = [];
  if (!t.hasFile) edits.push(el("div", "note", "Nothing to show until a file is linked."));
  t.fileRuns.forEach((f) => {
    const hd = el("div", "trow");
    hd.appendChild(el("span", "tt", f.changedCells === 0 ? "No changes: the AI's output was used as it is." : f.changedCells + (f.changedCells === 1 ? " change" : " changes") + (f.formulaEdits ? ", " + f.formulaEdits + " to formulas" : "") + " in " + (f.fileName || "the file")));
    if (f.category) hd.appendChild(el("span", "tag " + (f.category === "Factual/Data Correction" ? "tag-factual" : f.category === "Terminology/Context Mismatch" ? "tag-term" : f.category === "Tone/Style Edit" ? "tag-tone" : "tag-content"), f.category));
    hd.appendChild(el("span", "note", fmtMin(f.estimatedMinutes) + (f.minutesSource === "entered" ? " (you entered this)" : " (estimated)") + (f.elapsedSeconds ? ", saved " + fmtSecs(f.elapsedSeconds) + " after the AI's version" : "")));
    edits.push(hd);
    f.changes.slice(0, 8).forEach((c) => { const r2 = el("div", "trow"); r2.appendChild(chgNode(c)); edits.push(r2); });
    if (f.changedCells > 8) edits.push(el("div", "note", "and " + (f.changedCells - 8) + " more."));
  });
  body.appendChild(step(4, "Your edits to the file", edits, !t.hasFile));

  // 5. the final deliverable
  const kp = el("div", "kpis");
  function kpi(value, label, cls) { const dd = el("div", "kpi" + (cls ? " " + cls : "")); dd.appendChild(el("b", "", value)); dd.appendChild(el("span", "", label)); kp.appendChild(dd); }
  kpi(String(t.rePrompts.length), "re-prompts to get a usable output");
  kpi(fmtMin(t.promptMinutes), "time spent re-prompting");
  kpi(t.hasFile ? t.changedCells + " of " + t.totalCells : "No file", "cells or paragraphs you changed by hand");
  kpi(t.unchangedPct === null ? "No file" : t.unchangedPct + "%", "left exactly as the AI wrote it");
  kpi(t.hasFile ? fmtMin(t.editMinutes) : "No file", "time editing the file");
  kpi(fmtMin(t.totalMinutes), "total human time on this deliverable", "total");
  body.appendChild(step(5, "Final deliverable", [kp], false));

  renderWorkflowSide(t);
}

function describeParsed(p) {
  if (p.kind === "xlsx") return p.cellCount + " filled cells in " + p.sheets.length + (p.sheets.length === 1 ? " sheet" : " sheets");
  if (p.kind === "docx") return p.cellCount + " paragraphs";
  return p.cellCount + " pieces of slide text";
}

function outOptions() {
  const wf = $("outWorkflow").value;
  const t = wf ? A.traceWorkflow(currentData(), wf) : null;
  return { workflow: wf || "Unlinked files", agent: t && t.sites[0] ? t.sites[0] : "AI tool", minutes: $("outMinutes").value.trim(), fileName: store.outB ? store.outB.name : "",
    aiModified: store.outA ? store.outA.modified : null, finalModified: store.outB ? store.outB.modified : null };
}

function renderOutPlan() {
  const box = $("outPlan"), st = $("outStatus");
  box.textContent = "";
  $("outSave").disabled = true;
  store.outRes = null;
  if (!store.outA || !store.outB) { box.hidden = true; st.textContent = "Choose both files and the changes appear below."; return; }
  let res;
  try { res = window.FarfieldFiles.compareFiles(store.outA.parsed, store.outB.parsed, outOptions()); }
  catch (e) { box.hidden = false; box.textContent = e.message; st.textContent = ""; return; }
  store.outRes = res;
  box.hidden = false;
  const line = (a, b) => { const r = el("div", "plan-line"); r.appendChild(el("span", "", a)); r.appendChild(el("span", "", b)); box.appendChild(r); };
  const run = res.run;
  line("File", run.surface + ", " + run.totalCells + (run.type === "xlsx" ? " filled cells" : run.type === "docx" ? " paragraphs" : " pieces of text") + " in the AI's version");
  line("Changed by you", res.totals.changed + " (" + run.unchangedPct + "% left as the AI wrote it)" + (res.totals.formulaEdits ? ", " + res.totals.formulaEdits + " to formulas" : ""));
  if (run.category) line("Kind of change", run.category);
  line("Time editing", fmtMin(run.estimatedMinutes) + (run.minutesSource === "entered" ? " (you entered this)" : " (estimated from the size of the changes)"));
  if (run.elapsedSeconds) line("Between the two versions", "your final file was saved " + fmtSecs(run.elapsedSeconds) + " after the AI's version");
  if (!res.totals.changed) box.appendChild(el("div", "note", "No differences found. Saving records that the AI's output was used as it is."));
  res.changes.slice(0, 12).forEach((c) => { const r = el("div", "trow"); r.appendChild(chgNode(c)); box.appendChild(r); });
  if (res.changes.length > 12) box.appendChild(el("div", "note", "and " + (res.changes.length - 12) + " more."));
  $("outSave").disabled = false;
  st.textContent = "Review the changes, then save.";
}

async function loadOutFile(which, file) {
  const info = $(which === "A" ? "aiFileInfo" : "finalFileInfo");
  const key = which === "A" ? "outA" : "outB";
  info.textContent = "Reading\u2026";
  try {
    const buf = await readFileAs(file, "buffer");
    const parsed = await window.FarfieldFiles.readOfficeFile(buf, file.name);
    store[key] = { name: file.name, parsed: parsed, modified: file.lastModified || parsed.modified || null };
    info.textContent = file.name + ": " + describeParsed(parsed) + ".";
  } catch (e) {
    store[key] = null;
    info.textContent = file.name + ": " + e.message;
  }
  renderOutPlan();
}

function renderOutputs() {
  const rows = A.listWorkflows(currentData()).filter((r) => r.sessions || r.rePrompts);
  fillSelect($("outWorkflow"), rows.map((r) => ({ value: r.name, label: r.name + " (" + r.rePrompts + (r.rePrompts === 1 ? " re-prompt)" : " re-prompts)") })).concat([{ value: "", label: "Not linked to a chat" }]), store.outWf || pickDefaultWorkflow(rows));
  store.outWf = $("outWorkflow").value;
  const box = $("outList");
  box.textContent = "";
  const runs = store.fileRuns.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (!runs.length) { box.appendChild(el("div", "empty", "No output files linked yet.")); return; }
  runs.forEach((f) => {
    const card = el("div", "card runcard");
    const top = el("div", "wf-top");
    top.appendChild(el("span", "wf-name", f.fileName || "(unnamed file)"));
    top.appendChild(el("span", "tag tag-content", f.surface));
    top.appendChild(el("span", f.source === "seed" ? "sample-badge" : "live-badge", f.source === "seed" ? "Sample" : "Live"));
    card.appendChild(top);
    card.appendChild(el("div", "wf-meta", "In workflow \u201c" + f.workflow + "\u201d. " + f.changedCells + " of " + f.totalCells + " changed (" + f.unchangedPct + "% unchanged), " + fmtMin(f.estimatedMinutes) + (f.minutesSource === "entered" ? " entered" : " estimated") + ", saved " + fmtDate(f.createdAt)));
    const actions = el("div", "actions");
    const view = el("button", "btn secondary", "Open the trace");
    view.addEventListener("click", () => { store.traceWf = f.workflow; renderTrace(); goTab("trace", "trace"); });
    actions.appendChild(view);
    const rm = el("button", "btn secondary", "Remove");
    rm.addEventListener("click", async () => {
      if (!confirm("Remove the record of your edits to \u201c" + f.fileName + "\u201d? The files themselves are not stored, so nothing else is affected.")) return;
      await localWrite({
        fileRuns: store.fileRuns.filter((x) => x.id !== f.id),
        corrections: store.corrections.filter((c) => c.id !== f.corrId),
        sends: store.sends.filter((x) => !(x.t === f.createdAt && x.surface === f.surface)),
      });
    });
    actions.appendChild(rm);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

$("wfSearch").addEventListener("input", () => renderTrace());
$("wfTheme").addEventListener("change", (e) => { store.rpTheme = e.target.value; renderTrace(); });
$("aiFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) loadOutFile("A", f); });
$("finalFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) loadOutFile("B", f); });
$("outWorkflow").addEventListener("change", (e) => { store.outWf = e.target.value; renderOutPlan(); });
$("outMinutes").addEventListener("input", () => renderOutPlan());

$("outSave").addEventListener("click", async () => {
  if (!store.outRes) return;
  const res = window.FarfieldFiles.compareFiles(store.outA.parsed, store.outB.parsed, Object.assign(outOptions(), { now: Date.now() }));
  const corrections = store.corrections.slice(), sends = store.sends.slice();
  if (res.correction) corrections.push(res.correction);
  sends.push(res.send);
  const fileRuns = store.fileRuns.concat([res.run]);
  store.traceWf = res.run.workflow;
  await localWrite({ corrections: corrections, sends: sends, fileRuns: fileRuns });
  $("outStatus").textContent = "Saved. The trace above now shows this file and your edits.";
  $("outSave").disabled = true;
  goTab("trace", "trace");
});

renderLlmPanel();

syncThemeButtons();


// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ["overview", "trace", "fixes", "tests", "data"];
// each busy tab is split into small views; these are the page blocks that belong to each view
const SUBS = {
  trace: { trace: ["trace"], link: ["outputs"], manage: ["workflows"] },
  fixes: { queue: ["fixstats", "fixes"], patterns: ["groups", "chat-sessions"], monitor: ["monitor-sec"], recent: ["corrections"] },
  tests: { suite: ["tests"], gate: ["gate"] },
  data: { chats: ["import-chats"], backup: ["data"], capture: ["capture"], assign: ["assign"], addin: ["addin"], demo: ["demo-data"] },
};
// where a link to a section should land: [tab, view]
const ANCHOR = { exec: ["overview"], rollouts: ["overview"], pipeline: ["overview"], teams: ["overview"], assign: ["data", "assign"],
  trace: ["trace", "trace"], reprompts: ["trace", "trace"], outputs: ["trace", "link"], workflows: ["trace", "manage"],
  fixes: ["fixes", "queue"], groups: ["fixes", "patterns"], "chat-sessions": ["fixes", "patterns"], monitor: ["fixes", "monitor"], corrections: ["fixes", "recent"],
  tests: ["tests", "suite"], gate: ["tests", "gate"],
  "import-chats": ["data", "chats"], data: ["data", "backup"], capture: ["data", "capture"], addin: ["data", "addin"], "demo-data": ["data", "demo"] };
store.sub = { trace: "trace", fixes: "queue", tests: "suite", data: "chats" };

function parseHash() {
  const raw = String(location.hash || "").replace(/^#/, "");
  if (raw.charAt(0) === "/") { const t = raw.slice(1); return { tab: TABS.indexOf(t) !== -1 ? t : "overview", anchor: "" }; }
  if (ANCHOR[raw]) return { tab: ANCHOR[raw][0], sub: ANCHOR[raw][1], anchor: raw };
  return { tab: "overview", anchor: "" };
}

function showSub(tab, sub) {
  if (!SUBS[tab] || !SUBS[tab][sub]) return;
  store.sub[tab] = sub;
  Object.keys(SUBS[tab]).forEach((k) => {
    SUBS[tab][k].forEach((id) => { const e = $(id); if (e) e.hidden = k !== sub; });
    $("subbtn-" + tab + "-" + k).setAttribute("aria-selected", k === sub ? "true" : "false");
  });
}

function showTab(tab, anchor, sub) {
  store.tab = tab;
  TABS.forEach((k) => { $("tab-" + k).hidden = k !== tab; $("tabbtn-" + k).setAttribute(k === "data" ? "aria-pressed" : "aria-selected", k === tab ? "true" : "false"); });
  if (SUBS[tab]) showSub(tab, sub || store.sub[tab]);
  const target = anchor ? document.getElementById(anchor) : null;
  if (target && target.scrollIntoView) target.scrollIntoView();
  else if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
}

function goTab(tab, anchor) {
  const a = anchor ? ANCHOR[anchor] : null;
  showTab(tab, anchor, a && a[0] === tab ? a[1] : undefined);
  try { location.hash = anchor && anchor !== tab ? "#" + anchor : "#/" + tab; } catch (e) { /* ignore */ }
}

Object.keys(SUBS).forEach((tab) => Object.keys(SUBS[tab]).forEach((sub) => $("subbtn-" + tab + "-" + sub).addEventListener("click", () => showSub(tab, sub))));
TABS.forEach((k) => $("tabbtn-" + k).addEventListener("click", () => goTab(k)));
if (typeof window.addEventListener === "function") window.addEventListener("hashchange", () => { const h = parseHash(); if (h.tab !== store.tab || h.anchor) showTab(h.tab, h.anchor, h.sub); });

// ---------------------------------------------------------------------------
// Team filter and the data every team-aware view uses
// ---------------------------------------------------------------------------
function allTeams() {
  const set = new Set();
  Object.keys(store.settings.agentTeams || {}).forEach((a) => set.add(store.settings.agentTeams[a]));
  store.corrections.forEach((c) => set.add(A.teamOf(c, store.settings)));
  store.fixes.forEach((f) => set.add(A.teamOf(f, store.settings)));
  store.sends.slice(-400).forEach((x) => set.add(A.teamOf(x, store.settings)));
  return Array.from(set).sort();
}

function renderTeamFilter() {
  const teams = allTeams();
  fillSelect($("teamFilter"), [{ value: "all", label: "All teams" }].concat(teams.map((t) => ({ value: t, label: t }))), store.team);
  store.team = $("teamFilter").value;
}

$("teamFilter").addEventListener("change", (e) => { store.team = e.target.value; store.agentFilter = "all"; render(); });

function inTeam(x) { return store.team === "all" || A.teamOf(x, store.settings) === store.team; }
function overviewData() {   // what the Overview shows: only published fixes, dated from when they were published
  const d = teamData();
  return Object.assign({}, d, { fixes: liveFixes(d.fixes) });
}

function teamData() {
  return { corrections: store.corrections.filter(inTeam), sends: store.sends.filter(inTeam), fixes: store.fixes.filter(inTeam), aiSessions: store.aiSessions, rePrompts: store.rePrompts, fileRuns: store.fileRuns, settings: store.settings };
}

let btCache = { key: "", value: null };
function getBacktest() {
  const d = teamData(), last = d.corrections[d.corrections.length - 1] || {};
  const key = d.corrections.length + "|" + last.id + "|" + store.team + "|" + JSON.stringify(store.settings.agentTeams || {});
  if (btCache.key !== key) btCache = { key: key, value: window.FarfieldTests.backtest(d.corrections, { settings: store.settings }) };
  return btCache.value;
}

// ---------------------------------------------------------------------------
// Small drawing helpers (SVG built with the DOM, no libraries)
// ---------------------------------------------------------------------------
const SVGNS = "http://www.w3.org/2000/svg";
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
  if (text !== undefined) n.textContent = text;
  return n;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v))), f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}
function fmtHours(h) { return h < 10 ? h.toFixed(1) + " h" : Math.round(h) + " h"; }
function fmtMoney(n) { return n >= 10000 ? "$" + Math.round(n / 1000) + "k" : n >= 1000 ? "$" + (n / 1000).toFixed(1) + "k" : "$" + Math.round(n); }
function fmtChange(r) { return r === null || r === undefined ? "n/a" : (r > 0 ? "+" : r < 0 ? "\u2212" : "") + Math.abs(Math.round(r * 100)) + "%"; }
function changeClass(r) { return r === null || r === undefined ? "" : r < 0 ? "down" : r > 0 ? "up" : ""; }

function drawChart(box, weeks, lines, events, opts) {
  box.textContent = "";
  const W = 1000, H = 330, L = 56, Rm = 18, T = 30, Bm = 38, n = weeks.length;
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": opts.label });
  const xs = (i) => L + (n <= 1 ? (W - L - Rm) / 2 : i * (W - L - Rm) / (n - 1));
  let max = 0;
  lines.forEach((l) => l.values.forEach((v) => { if (v !== null && v > max) max = v; }));
  if (opts.target) max = Math.max(max, opts.target * 1.1);
  const top = niceMax(max), ys = (v) => T + (1 - v / top) * (H - T - Bm);
  for (let g = 0; g <= 4; g++) {
    const v = top * g / 4, y = ys(v);
    svg.appendChild(svgEl("line", { x1: L, x2: W - Rm, y1: y, y2: y, class: "gl" }));
    svg.appendChild(svgEl("text", { x: L - 8, y: y + 4, "text-anchor": "end", class: "ax" }, opts.fmt(v)));
  }
  const every = Math.max(1, Math.ceil(n / 9));
  weeks.forEach((w, i) => { if (i % every === 0 || i === n - 1) svg.appendChild(svgEl("text", { x: xs(i), y: H - 14, "text-anchor": "middle", class: "ax" }, w.label)); });
  if (opts.target) {
    const y = ys(opts.target);
    svg.appendChild(svgEl("line", { x1: L, x2: W - Rm, y1: y, y2: y, class: "tgl" }));
    svg.appendChild(svgEl("text", { x: W - Rm - 4, y: y - 6, "text-anchor": "end", class: "tgt" }, "Target " + opts.fmt(opts.target) + " h"));
  }
  if (opts.hit && opts.hit.index >= 0 && opts.hit.index < n) {
    const x = xs(opts.hit.index);
    svg.appendChild(svgEl("line", { x1: x, x2: x, y1: T, y2: H - Bm, class: "hit" }));
    svg.appendChild(svgEl("text", { x: x, y: H - Bm - 6, "text-anchor": "middle", class: "tgt" }, opts.hit.label));
  }
  // a small diamond where a fix went live; hover it to see which fix (fixes in the same bucket share one)
  const marks = [];
  (events || []).forEach((e) => {
    const g = marks.find((m) => m.week === e.week), line = shortDate(e.ts) + ": " + (e.title || "A fix went live");
    if (g) g.names.push(line); else marks.push({ week: e.week, names: [line] });
  });
  marks.forEach((m) => {
    const x = xs(m.week);
    svg.appendChild(svgEl("line", { x1: x, x2: x, y1: T - 3, y2: H - Bm, class: "ev" }));
    const dia = svgEl("rect", { x: x - 4.5, y: T - 12, width: 9, height: 9, transform: "rotate(45 " + x + " " + (T - 7.5) + ")", class: "evd" });
    dia.appendChild(svgEl("title", {}, m.names.join("\n")));
    svg.appendChild(dia);
  });
  lines.forEach((l) => {
    let d = "", gap = true;
    l.values.forEach((v, i) => { if (v === null) { gap = true; return; } d += (gap ? "M" : "L") + xs(i).toFixed(1) + " " + ys(v).toFixed(1) + " "; gap = false; });
    svg.appendChild(svgEl("path", { d: d, fill: "none", style: "stroke:" + l.color + ";stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round" }));
    l.values.forEach((v, i) => {
      if (v === null) return;
      const partial = opts.partialLast && i === n - 1;
      svg.appendChild(svgEl("circle", { cx: xs(i), cy: ys(v), r: partial ? 4 : 3, style: partial ? "fill:var(--bg);stroke:" + l.color + ";stroke-width:2" : "fill:" + l.color }));
    });
  });
  box.appendChild(svg);
}

function sparkline(values, color) {
  const w = 170, h = 38, n = values.length, max = Math.max.apply(null, values.concat([0.0001]));
  const svg = svgEl("svg", { viewBox: "0 0 " + w + " " + h, class: "spark", role: "img", "aria-label": "Weekly trend" });
  let d = "";
  values.forEach((v, i) => { d += (i ? "L" : "M") + (n <= 1 ? w / 2 : 2 + i * (w - 4) / (n - 1)).toFixed(1) + " " + (h - 4 - (v / max) * (h - 8)).toFixed(1) + " "; });
  svg.appendChild(svgEl("path", { d: d, fill: "none", style: "stroke:" + color + ";stroke-width:2;stroke-linejoin:round;stroke-linecap:round" }));
  return svg;
}

// ---------------------------------------------------------------------------
// Overview: the executive view
// ---------------------------------------------------------------------------
function pipelineStrip(box) {
  box.textContent = "";
  const d = teamData(), bt = getBacktest();
  const drafts = d.sends.length, edited = d.sends.filter((x) => x.category).length;
  const open = A.rankOpenPatterns(A.buildPatterns(d.corrections, d.fixes, store.basis)).length;
  const steps = [
    { n: "1  Capture", big: d.corrections.length.toLocaleString(), label: "corrections captured", sm: drafts ? "From " + drafts.toLocaleString() + " AI drafts. " + Math.round(edited / drafts * 100) + "% needed a fix." : "From Gmail, Excel, Word, PowerPoint and AI chats." },
    { n: "2  Fix", big: String(liveFixes(d.fixes).length), label: "fixes rolled out", sm: open + " open patterns are waiting, each routed to an instruction change or an engineering ticket." },
    { n: "3  Verify", big: String(bt.summary.tests), label: "automatic checks written", sm: bt.summary.ready + " ready to enforce. They would have caught " + Math.round(bt.summary.coverage * 100) + "% of the problems that came later." },
  ];
  steps.forEach((st) => {
    const c = el("div", "pstep");
    c.appendChild(el("div", "pn", st.n));
    c.appendChild(el("span", "big", st.big));
    c.appendChild(el("div", "", st.label));
    c.appendChild(el("div", "sm", st.sm));
    box.appendChild(c);
  });
}

function earliestTs(d) {
  let f = Infinity;
  d.corrections.forEach((c) => { if (c.timestamp < f) f = c.timestamp; });
  d.sends.forEach((x) => { if (x.t < f) f = x.t; });
  return f;
}
function dateVal(v) { return v ? new Date(v + "T00:00:00").getTime() : null; }
function toInputDate(ts) { const d = new Date(ts), m = d.getMonth() + 1, day = d.getDate(); return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day; }
function currentRange(d) {
  const p = store.period;
  return A.periodRange(p.preset, Date.now(), { first: earliestTs(d), from: dateVal(p.from), to: dateVal(p.to) });
}
function targetValue(baseline) {
  const t = Number(store.settings.targetHoursPerWeek);
  if (t > 0) return t;
  return baseline > 0 ? Math.max(0.5, Math.round(baseline * 0.5 * 2) / 2) : 0;
}
const PERIODS = [["week", "Last week"], ["4w", "Last 4 weeks"], ["13w", "Last 13 weeks"], ["all", "All time"], ["custom", "Choose dates"]];
function syncPeriodButtons() {
  PERIODS.forEach((p) => {
    $("per-" + p[0]).setAttribute("aria-pressed", store.period.preset === p[0] ? "true" : "false");
  });
  $("customDates").hidden = store.period.preset !== "custom";
}
function setPeriod(p) {
  store.period.preset = p;
  if (p === "custom" && (!store.period.from || !store.period.to)) { const now = Date.now(); store.period.to = toInputDate(now - 86400000); store.period.from = toInputDate(now - 7 * 86400000); }
  $("execFrom").value = store.period.from; $("execTo").value = store.period.to;
  render();
}
function shortDate(ts) { return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
function capital(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
// A readable title for a fix: its first sentence, shortened
function fixTitle(text) {
  const t = String(text || "").trim().split(/(?<=[.!?])\s/)[0] || "";
  return t.length > 92 ? t.slice(0, 89).trimEnd() + "\u2026" : t;
}

// What each fix was for, in plain words (the instruction itself opens on request)
const SAMPLE_PROBLEMS = {
  seed_fix_1: "Economic releases left out of the market summary",
  org_fix_1: "Disclaimer dropped from client summaries", org_fix_2: "Client emails sound too casual", org_fix_3: "Full-year guidance missing from earnings notes",
  org_fix_4: "\u201cCustomers\u201d used instead of \u201cclients\u201d", org_fix_5: "Restricted-list names mentioned", org_fix_6: "Benchmark shown as \u201cthe index\u201d",
  org_fix_7: "Chart source line missing", org_fix_8: "Market figures written from memory", org_fix_9: "EPS and consensus figures wrong", org_fix_10: "Wrong policy numbers cited",
  org_fix_11: "AUM shown in the wrong units", org_fix_12: "Credit shorthand left unexplained", org_fix_13: "Hype words in market commentary",
};
function fixProblem(f) {
  if (f.problem) return f.problem;
  if (SAMPLE_PROBLEMS[f.id]) return SAMPLE_PROBLEMS[f.id];
  const agent = f.agent || "the agent";
  if (f.category === C.FACTUAL) return "Wrong figures in " + agent + " output";
  if (f.category === C.CONTENT) return "Required content left out of " + agent + " output";
  if (f.category === C.TERM) return "Terminology differs from the team's in " + agent + " output";
  if (f.category === C.TONE) return "Tone rewritten in " + agent + " output";
  return fixTitle(f.instruction);
}

function renderExec() {
  syncPeriodButtons();
  const d = overviewData(), group = $("execGroup").value || "team", metric = $("execMetric").value || "hours";
  const waitingFixes = store.fixes.filter(inTeam).filter((f) => !isLive(f)), wn = $("rolloutWaiting");
  wn.textContent = "";
  wn.hidden = waitingFixes.length === 0;
  if (waitingFixes.length) {
    wn.appendChild(document.createTextNode(waitingFixes.length + (waitingFixes.length === 1 ? " approved fix is" : " approved fixes are") + " waiting to be published. "));
    const seeBtn = el("button", "link-btn", waitingFixes.length === 1 ? "See it" : "See them");
    seeBtn.addEventListener("click", () => goTab("fixes", "monitor"));
    wn.appendChild(seeBtn);
  }
  const range = currentRange(d), all = store.period.preset === "all";
  const allSer = A.weeklySeries(d, { group: "total", basis: store.basis });
  const base = A.execSummary(allSer.series[0], { hourlyRate: store.rate });
  const sum = A.periodSummary(d, range, { hourlyRate: store.rate, baselineHours: base.enough ? base.baselineHours : null, basis: store.basis });
  const target = targetValue(base.enough ? base.baselineHours : 0), ts = target > 0 ? A.targetStatus(allSer.series[0], target) : null;
  const haveTarget = ts && allSer.series[0].minutes.length && allSer.weeks.length >= 3;
  const dir = (r) => (r < 0 ? "down" : r > 0 ? "up" : "unchanged");

  // the headline, in plain words
  let line;
  if (all) {
    if (!base.enough) line = "There is not enough history yet for a trend. Keep capturing for a few weeks.";
    else {
      line = "Over the last " + base.k + " full weeks, people spent about " + fmtHours(base.currentHours) + " a week fixing AI output, " + (base.changePct < 0 ? "down from " : base.changePct > 0 ? "up from " : "the same as ") + fmtHours(base.baselineHours) + " a week when this data begins.";
      if (haveTarget && ts.startedAbove) line += ts.reachedIndex >= 0 ? " The " + target + " hour target was first met in the week of " + allSer.weeks[ts.reachedIndex].label + "." : " That is still about " + fmtHours(Math.max(ts.current - target, 0)) + " a week above the " + target + " hour target.";
    }
  } else {
    line = capital(range.label) + ", people spent " + fmtHours(sum.hours) + " fixing AI output" + (sum.hoursChange === null ? "" : ", " + dir(sum.hoursChange) + " " + Math.abs(Math.round(sum.hoursChange * 100)) + "% on " + range.prevLabel) + ". " + (sum.fixesPushed === 0 ? "No fixes went live in that time." : sum.fixesPushed === 1 ? "One fix went live in that time." : sum.fixesPushed + " fixes went live in that time.");
  }
  $("execHeadline").textContent = line;

  // four figures
  const k = $("execKpis");
  k.textContent = "";
  const fig = (label, value, sub) => { const c = el("div"); c.appendChild(el("div", "lab", label)); c.appendChild(el("div", "val", value)); c.appendChild(el("div", "sub", sub)); k.appendChild(c); };
  if (all) {
    if (!base.enough) {
      fig("Hours a week fixing AI output", "n/a", "Needs at least four full weeks of data.");
      fig("Drafts that needed a fix", "n/a", ""); fig("Estimated time saved a year", "n/a", "");
    } else {
      fig("Hours a week fixing AI output", fmtHours(base.currentHours), fmtHours(base.baselineHours) + " at the start, " + fmtChange(base.changePct));
      fig("Drafts that needed a fix", base.currentRate === null ? "n/a" : Math.round(base.currentRate * 100) + "%", base.baselineRate === null ? "" : Math.round(base.baselineRate * 100) + "% at the start");
      fig("Estimated time saved a year", fmtMoney(base.annualSavings), "About " + Math.round(base.weeklyHoursSaved * 52) + " hours at $" + store.rate + " an hour");
    }
  } else {
    const multi = range.weeks > 1.5;
    fig("Hours spent fixing AI output", fmtHours(sum.hours), (sum.hoursChange === null ? "No earlier period to compare" : fmtChange(sum.hoursChange) + " on " + range.prevLabel) + (multi ? ", about " + fmtHours(sum.perWeekHours) + " a week" : ""));
    fig("Drafts that needed a fix", sum.rate === null ? "n/a" : Math.round(sum.rate * 100) + "%", sum.ratePoints === null ? sum.drafts.toLocaleString() + " drafts" : (sum.ratePoints < 0 ? "Down " : "Up ") + Math.abs(Math.round(sum.ratePoints * 100)) + " points on " + range.prevLabel);
    fig("Estimated time saved a year", sum.baselineHours === null ? "n/a" : fmtMoney(sum.annualSavings), sum.baselineHours === null ? "Needs a few weeks of history" : "If every week looked like " + range.label + ", against about " + fmtHours(sum.baselineHours) + " a week at the start");
  }
  if (!haveTarget) fig("Weekly target", "n/a", "Needs a few weeks of history.");
  else if (!ts.startedAbove) fig("Weekly target", "Under target", "Weekly hours were already at or under " + target + " h when the data starts.");
  else if (ts.reachedIndex >= 0) fig("Weekly target", "Reached", "Hours first stayed at or under " + target + " h in the week of " + allSer.weeks[ts.reachedIndex].label + ".");
  else fig("Weekly target", fmtHours(ts.current) + " of " + target + " h", "About " + fmtHours(Math.max(ts.current - target, 0)) + " a week still to go.");
  $("execTarget").placeholder = base.enough ? "Auto (" + targetValue(base.baselineHours) + ")" : "Auto";

  // the chart
  const bucketMs = (range.bucket === "day" ? 1 : 7) * 86400000;
  let ser = A.periodSeries(d, range, { group: group, basis: store.basis });
  let justStarted = false;
  if (ser.partialLast && ser.weeks.length > 1 && (Date.now() - ser.weeks[ser.weeks.length - 1].start) / bucketMs < 0.3) {
    const keep = ser.weeks.length - 1;
    ser = { weeks: ser.weeks.slice(0, keep), events: ser.events.filter((e) => e.week < keep), partialLast: false,
      series: ser.series.map((s2) => ({ key: s2.key, team: s2.team, corrections: s2.corrections.slice(0, keep), minutes: s2.minutes.slice(0, keep), drafts: s2.drafts.slice(0, keep), edited: s2.edited.slice(0, keep), rate: s2.rate.slice(0, keep) })) };
    justStarted = true;
  }
  const fixById = {};
  d.fixes.forEach((f) => { fixById[f.id] = f; });
  ser.events.forEach((e) => { e.title = fixById[e.id] ? fixProblem(fixById[e.id]) : ""; });
  const lines = ser.series.slice(0, group === "agent" ? 8 : 6).map((s2, i) => ({
    key: s2.key, color: SERIES[i % SERIES.length],
    values: metric === "hours" ? s2.minutes.map((m) => m / 60) : metric === "corrections" ? s2.corrections.slice() : s2.rate.map((r) => (r === null ? null : r * 100)),
  }));
  const fmt = metric === "hours" ? (v) => (v < 10 ? v.toFixed(v % 1 ? 1 : 0) : String(Math.round(v))) : metric === "rate" ? (v) => Math.round(v) + "%" : (v) => String(Math.round(v));
  const label = metric === "hours" ? (range.bucket === "day" ? "Hours a day spent fixing AI output" : "Hours a week spent fixing AI output") : metric === "corrections" ? (range.bucket === "day" ? "Corrections a day" : "Corrections a week") : (range.bucket === "day" ? "Share of drafts corrected, by day" : "Share of drafts corrected, by week");
  $("chartTitle").textContent = label;
  const showTarget = metric === "hours" && group === "total" && target > 0 && range.bucket === "week";
  let hit = null;
  if (showTarget && ts && ts.reachedIndex >= 0) { const start = allSer.weeks[ts.reachedIndex].start, at = ser.weeks.findIndex((w) => w.start === start); if (at >= 0) hit = { index: at, label: "Target reached" }; }
  drawChart($("execChart"), ser.weeks, lines, ser.events, { fmt: fmt, label: label, partialLast: ser.partialLast, target: showTarget ? target : 0, hit: hit });
  store.teamColors = {};
  if (group === "team") lines.forEach((l) => { store.teamColors[l.key] = l.color; });
  const lg = $("execLegend");
  lg.textContent = "";
  if (group === "agent") lines.forEach((l) => { const sp = el("span", ""); const i2 = el("i"); i2.setAttribute("style", "background:" + l.color); sp.appendChild(i2); sp.appendChild(document.createTextNode(l.key)); lg.appendChild(sp); });
  if (ser.events.length) lg.appendChild(el("span", "", "Diamonds: a fix went live. Hover one to see which."));
  if (showTarget) lg.appendChild(el("span", "", "Green: the target" + (hit ? " and the week it was reached" : "")));
  $("periodNote").textContent = "Showing " + range.label + ": " + shortDate(range.from) + " to " + shortDate(range.to - 1) + (range.prevFrom !== null ? ", compared with " + range.prevLabel : "") + ".";
  $("execNote").textContent = (ser.partialLast ? "The last point is this week so far. " : "") + (justStarted ? "The " + (range.bucket === "day" ? "day" : "week") + " that has just started is not shown yet. " : "") + (metric === "hours" && group !== "total" ? "Choose \u201cAll together\u201d to see the target line. " : "") + (A.sampleCounts(store) > 0 ? "Includes sample data." : "");

  // the fixes that went live, newest first
  const eff = A.fixEffects(d, {});
  const box = $("rolloutTable");
  box.textContent = "";
  const shown = eff.map((e, n) => Object.assign({ n: n + 1 }, e)).filter((e) => all || (e.pushedAt < range.to && (e.pushedAt >= range.from || (e.reachedAt && e.reachedAt >= range.from && e.reachedAt < range.to)))).sort((a, b) => b.pushedAt - a.pushedAt);
  const more = $("rolloutMore");
  more.hidden = true;
  $("rolloutNote").textContent = eff.length ? (all ? eff.length + (eff.length === 1 ? " fix" : " fixes") + ", newest first." : shown.length + " pushed or reaching their goal in this period.") : "";
  if (!eff.length) { box.appendChild(el("div", "empty", "No fixes are live yet. Approve one in the Fixes tab and publish it, and its effect appears here.")); return; }
  if (!shown.length) { box.appendChild(el("div", "empty", "No fix was pushed, and none reached its goal, in this period.")); return; }
  const LIMIT = 6, visibleRows = store.rolloutAll ? shown : shown.slice(0, LIMIT);
  const t = el("table", "table");
  const hr = el("tr");
  ["Pushed", "The fix", "What it did", "Reached the goal"].forEach((h, i) => hr.appendChild(el("th", i === 2 ? "num" : "", h)));
  t.appendChild(hr);
  visibleRows.forEach((e) => {
    const open = !!store.openFix[e.fix.id];
    const r = el("tr", open ? "open" : "");
    const c1 = el("td"); c1.appendChild(document.createTextNode(shortDate(e.fix.approvedAt))); r.appendChild(c1);
    const c2 = el("td");
    const rb = el("button", "rowbtn"); rb.setAttribute("aria-expanded", open ? "true" : "false");
    rb.appendChild(el("span", "chev"));
    const lab = el("span"); lab.appendChild(el("b", "", fixProblem(e.fix))); lab.appendChild(el("span", "sm", e.fix.agent + " \u00b7 " + e.team));
    rb.appendChild(lab);
    rb.addEventListener("click", () => { store.openFix[e.fix.id] = !open; renderExec(); });
    c2.appendChild(rb); r.appendChild(c2);
    const c3 = el("td", "num " + changeClass(e.changePct));
    c3.appendChild(document.createTextNode(e.pending ? "Too early" : fmtChange(e.changePct)));
    if (!e.pending) c3.appendChild(el("span", "sm", e.beforePerWeek.toFixed(1) + " to " + e.afterPerWeek.toFixed(1) + " a week"));
    r.appendChild(c3);
    r.appendChild(el("td", e.reachedAt ? "down" : "", e.pending ? "Too early to tell" : e.reachedAt ? "Week of " + shortDate(e.reachedAt) + " (" + e.weeksToGoal + (e.weeksToGoal === 1 ? " week" : " weeks") + " after)" : e.beforePerWeek < 1 ? "Too few corrections to measure" : "Not yet"));
    t.appendChild(r);
    if (open) {
      const dr = el("tr", "detail"); const td = el("td"); td.colSpan = 4;
      const kv = el("dl", "kv");
      const row = (a, b) => { kv.appendChild(el("dt", "", a)); kv.appendChild(el("dd", "", b)); };
      row("What it tells the agent", String(e.fix.instruction || ""));
      row("Issue it targets", e.fix.category);
      row("Sub-agent", e.fix.agent + " (" + e.team + ")");
      row("Pushed", new Date(e.fix.approvedAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }));
      if (!e.pending) row("Corrections a week", e.beforePerWeek.toFixed(1) + " in the 4 weeks before, " + e.afterPerWeek.toFixed(1) + " since");
      td.appendChild(kv); dr.appendChild(td); t.appendChild(dr);
    }
  });
  const wrap = el("div", "tbl-wrap"); wrap.appendChild(t); box.appendChild(wrap);
  if (shown.length > LIMIT) { more.hidden = false; more.textContent = store.rolloutAll ? "Show fewer" : "Show all " + shown.length + " fixes"; }
}

["execMetric", "execGroup"].forEach((id) => $(id).addEventListener("change", () => renderExec()));
PERIODS.forEach((p) => $("per-" + p[0]).addEventListener("click", () => setPeriod(p[0])));
$("rolloutMore").addEventListener("click", () => { store.rolloutAll = !store.rolloutAll; renderExec(); });
["execFrom", "execTo"].forEach((id) => $(id).addEventListener("change", (e) => { store.period[id === "execFrom" ? "from" : "to"] = e.target.value; render(); }));
$("execTarget").addEventListener("input", (e) => {
  const raw = String(e.target.value).replace(/[\s]/g, "");
  const next = Object.assign({}, store.settings);
  if (raw === "") delete next.targetHoursPerWeek;
  else { const v = Number(raw); if (!isFinite(v) || v <= 0) return; next.targetHoursPerWeek = v; }
  localWrite({ settings: next });
});
$("execRate").addEventListener("input", (e) => {
  const v = Number(String(e.target.value).replace(/[$,\s]/g, ""));
  if (!isFinite(v) || v <= 0) return;
  store.rate = v;
  renderExec();
  const next = Object.assign({}, store.settings, { hourlyRate: v });
  localWrite({ settings: next });
});

// ---------------------------------------------------------------------------
// Teams tab
// ---------------------------------------------------------------------------
function renderTeams() {
  const box = $("teamCards");
  box.textContent = "";
  const td = overviewData();
  const roll = A.teamRollup(td, { basis: store.basis, range: store.period.preset === "all" ? null : currentRange(td) });
  if (!roll.teams.length || (!roll.ranged && roll.completeWeeks < 2)) {
    box.appendChild(el("div", "empty", roll.teams.length ? "Trends need at least two full weeks of data." : "No data yet."));
    if (!roll.teams.length) return;
  }
  const head = el("div", "team-head");
  head.appendChild(el("span")); head.appendChild(el("span", "", "Team"));
  ["AI drafts, " + roll.label, "Needed a fix", "Hours spent fixing", roll.compareLabel ? "Change vs " + roll.compareLabel : "Change"].forEach((h) => head.appendChild(el("span", "", h)));
  head.appendChild(el("span", "", "Weekly trend"));
  box.appendChild(head);
  roll.teams.forEach((t, ti) => {
    const d = el("details", "team");
    d.open = store.openTeams[t.name] !== undefined ? store.openTeams[t.name] : false;
    d.addEventListener("toggle", () => { store.openTeams[t.name] = d.open; });
    const sm = el("summary");
    sm.appendChild(el("span", "chev"));
    const tn = el("div", "tn");
    if (store.teamColors && store.teamColors[t.name]) { const sw = el("i", "swatch"); sw.setAttribute("style", "background:" + store.teamColors[t.name]); tn.appendChild(sw); }
    tn.appendChild(document.createTextNode(t.name));
    sm.appendChild(tn);
    const kp = (value, cls) => { const x = el("div", "tk"); x.appendChild(el("b", cls || "", value)); sm.appendChild(x); };
    kp(t.drafts.toLocaleString());
    kp(t.rate === null ? "n/a" : Math.round(t.rate * 100) + "%");
    kp(fmtHours(t.hours));
    kp(fmtChange(t.changePct), changeClass(t.changePct));
    sm.appendChild(sparkline(t.spark, "var(--accent)"));
    d.appendChild(sm);

    const inner = el("div", "inner");
    const wrap = el("div", "tbl-wrap");
    const tb = el("table", "table");
    const hr = el("tr");
    ["Sub-agent", "AI drafts", "Needed a fix", "Hours fixing", "Change", "Most time lost on", "Fixes live", "Weekly trend"].forEach((h, i) => hr.appendChild(el("th", i >= 1 && i <= 4 ? "num" : "", h)));
    tb.appendChild(hr);
    t.agents.forEach((a) => {
      const r = el("tr");
      r.appendChild(el("td", "", a.name));
      r.appendChild(el("td", "num", a.drafts.toLocaleString()));
      r.appendChild(el("td", "num", a.rate === null ? "n/a" : Math.round(a.rate * 100) + "%"));
      r.appendChild(el("td", "num", fmtHours(a.hours)));
      r.appendChild(el("td", "num " + changeClass(a.changePct), fmtChange(a.changePct)));
      const tc = el("td"); if (a.topCategory) tc.appendChild(el("span", "tag " + tagClass(a.topCategory), a.topCategory)); r.appendChild(tc);
      r.appendChild(el("td", "", String(a.fixes)));
      const sp = el("td"); sp.appendChild(sparkline(a.spark, "var(--s2)")); r.appendChild(sp);
      tb.appendChild(r);
    });
    wrap.appendChild(tb);
    inner.appendChild(wrap);
    const actions = el("div", "actions");
    const go = el("button", "link-btn", "See this team's open fixes");
    go.addEventListener("click", () => { store.team = t.name; store.agentFilter = "all"; render(); goTab("fixes"); });
    const go2 = el("button", "link-btn", "See its success checks");
    go2.addEventListener("click", () => { store.team = t.name; store.agentFilter = "all"; render(); goTab("tests"); });
    actions.appendChild(go); actions.appendChild(go2);
    inner.appendChild(actions);
    d.appendChild(inner);
    box.appendChild(d);
  });
}

function renderAssign() {
  const body = $("assignBody");
  body.textContent = "";
  const names = new Set(store.settings.agents || []);
  store.corrections.concat(store.fixes).forEach((x) => x.agent && names.add(x.agent));
  store.aiSessions.concat(store.rePrompts).forEach((x) => x.site && names.add(x.site));
  const teams = allTeams().filter((t) => t !== "Unassigned");
  const dl = el("datalist"); dl.id = "teamNames";
  teams.forEach((t) => { const o = el("option"); o.value = t; dl.appendChild(o); });
  body.appendChild(dl);
  const tb = el("table", "table");
  const hr = el("tr"); ["Agent or AI tool", "Team"].forEach((h) => hr.appendChild(el("th", "", h))); tb.appendChild(hr);
  Array.from(names).sort().forEach((n) => {
    const r = el("tr"); r.appendChild(el("td", "", n));
    const td = el("td"); const inp = el("input"); inp.type = "text"; inp.value = (store.settings.agentTeams || {})[n] || ""; inp.placeholder = "Unassigned"; inp.setAttribute("list", "teamNames"); inp.setAttribute("aria-label", "Team for " + n);
    const save = async () => {
      const map = Object.assign({}, store.settings.agentTeams || {}), v = inp.value.trim().slice(0, 60);
      if (v) map[n] = v; else delete map[n];
      if ((store.settings.agentTeams || {})[n] === (v || undefined)) return;
      await setSetting({ agentTeams: map });
    };
    inp.addEventListener("change", save);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    td.appendChild(inp); r.appendChild(td); tb.appendChild(r);
  });
  body.appendChild(tb);
}

// ---------------------------------------------------------------------------
// Tests tab: corrections become tests, and the tests are backtested
// ---------------------------------------------------------------------------
const STATUS = { ready: "Ready to enforce", partial: "Partly effective", data: "Needs a data source", review: "Needs review", weak: "Too little evidence" };

function renderTests() {
  const bt = getBacktest(), s = bt.summary;
  pipelineStrip($("pipelineStrip"));
  const st = $("testStats");
  st.textContent = s.heldOut
    ? "If these checks had been in place, they would have caught " + Math.round(s.coverage * 100) + "% of the " + s.heldOut.toLocaleString() + " corrections that came after they were written, about " + fmtHours(s.minutesPrevented / 60) + " of rework. " + s.ready + " of " + s.groups + " are ready to enforce" + (s.needData ? "; " + s.needData + " cover number errors and need a data source." : ".")
    : "Checks are written once an issue has been corrected at least four times.";

  const box = $("testList");
  box.textContent = "";
  if (!bt.groups.length) { box.appendChild(el("div", "empty", "Checks are written once an issue has been corrected at least four times. Keep capturing corrections and they appear here.")); renderGateOptions(bt); return; }
  const t = el("table", "table");
  const hr = el("tr");
  ["Status", "Sub-agent", "Check", "Written from", "Later cases", "Would have caught", "False alarms"].forEach((h, i) => hr.appendChild(el("th", i >= 3 ? "num" : "", h)));
  t.appendChild(hr);
  bt.groups.forEach((g) => {
    const r = el("tr");
    const c1 = el("td"); c1.appendChild(el("span", "chip " + g.status, STATUS[g.status])); r.appendChild(c1);
    const c2 = el("td"); c2.appendChild(el("div", "", g.agent)); c2.appendChild(el("div", "note", g.team)); r.appendChild(c2);
    const c3 = el("td"); c3.appendChild(el("div", "", g.tests.map(window.FarfieldTests.describe).join(" "))); c3.appendChild(el("span", "tag " + tagClass(g.category), g.category));
    const open = !!store.openTests[g.id];
    const more = el("button", "link-btn", open ? "Hide details" : "Fix and example");
    more.style.marginLeft = "10px"; more.setAttribute("aria-expanded", open ? "true" : "false");
    more.addEventListener("click", () => { store.openTests[g.id] = !open; renderTests(); });
    c3.appendChild(more); r.appendChild(c3);
    r.appendChild(el("td", "num", g.trainCount + " corrections"));
    r.appendChild(el("td", "num", String(g.heldOut)));
    r.appendChild(el("td", "num", g.needData ? g.caught + " (" + Math.round(g.recall * 100) + "%)" : g.caught + " (" + Math.round(g.recall * 100) + "%)"));
    r.appendChild(el("td", "num", g.needData ? "n/a" : String(g.falseAlarms)));
    t.appendChild(r);
    if (open) {
      const dr = el("tr"); const td = el("td"); td.colSpan = 7;
      td.appendChild(el("div", "proposal-label", "Proposed fix (instruction)"));
      td.appendChild(el("div", "proposal", g.fix));
      if (g.needData) td.appendChild(el("div", "note", "These checks only catch the exact wrong numbers already seen, so they caught " + Math.round(g.recall * 100) + "% of later cases. New wrong numbers can only be caught by checking against the source data, which is an engineering ticket."));
      const ex = el("div", "ex");
      const a = el("div", "f"); a.appendChild(el("b", "", "The AI's version (fails)")); a.appendChild(document.createTextNode(g.example.original));
      const b = el("div", "p"); b.appendChild(el("b", "", "What the person sent (passes)")); b.appendChild(document.createTextNode(g.example.edited));
      ex.appendChild(a); ex.appendChild(b); td.appendChild(ex);
      dr.appendChild(td); t.appendChild(dr);
    }
  });
  box.appendChild(t);
  renderGateOptions(bt);
  renderGate();
}

function renderGateOptions(bt) {
  const agents = Array.from(new Set(bt.groups.map((g) => g.agent))).sort();
  fillSelect($("gateAgent"), agents.map((a) => ({ value: a, label: a })), $("gateAgent").value);
  $("gateGood").disabled = $("gateRisky").disabled = !agents.length;
}

function runGate(mode) {
  const bt = getBacktest();
  const agent = $("gateAgent").value;
  if (!agent) return;
  store.gate[mode] = window.FarfieldTests.simulateRelease(bt, teamData().corrections, agent, mode);
  renderGate();
}

function renderGate() {
  const box = $("gateResult");
  box.textContent = "";
  [["good", "Safe change"], ["risky", "Risky change"]].forEach((pair) => {
    const r = store.gate[pair[0]];
    const c = el("div", "res" + (r ? (r.blocked ? " block" : " pass") : ""));
    c.appendChild(el("h3", "", pair[1]));
    if (!r) { c.appendChild(el("div", "note", pair[0] === "good" ? "Keeps every fix in place: the new outputs look like what people ended up sending." : "Brings the old problems back: the new outputs look like the AI's original drafts.")); box.appendChild(c); return; }
    c.appendChild(el("div", "stat-value", r.blocked ? "Release blocked" : "Release allowed"));
    c.appendChild(el("div", "stat-sub", r.agent + ": " + (r.blocked ? r.regressions + " of " + r.candidates + " outputs failed, so the old problems are back. " + r.failingTests + " checks failed." : "All " + r.candidates + " outputs pass every check.")));
    r.results.filter((x) => x.failures).forEach((x) => c.appendChild(el("div", "note", x.failures + " failed: " + x.group.tests.map(window.FarfieldTests.describe).join(" "))));
    box.appendChild(c);
  });
}

$("gateGood").addEventListener("click", () => runGate("good"));
$("gateRisky").addEventListener("click", () => runGate("risky"));
$("gateAgent").addEventListener("change", () => { store.gate = { good: null, risky: null }; renderGate(); });

load();
