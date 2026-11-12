// Runs the agent against the real Farfield backend (started as a child process on a free port).
// Skipped when the backend folder isn't next to this one. Set FARFIELD_BACKEND to point at it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults } from "../src/config.js";
import { hasToken } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
const BACKEND = process.env.FARFIELD_BACKEND || path.resolve(HERE, "..", "..", "farfield-backend");
const HAVE = fs.existsSync(path.join(BACKEND, "src", "main.ts"));

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function startBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-be-"));
  const port = await freePort();
  const dbPath = path.join(dir, "farfield.db");
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: BACKEND, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, FARFIELD_BOOTSTRAP_KEY: "test-bootstrap-key" },
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("backend did not start")), 15000);
    child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(to); resolve(); } });
    child.on("exit", (c) => { clearTimeout(to); reject(new Error("backend exited " + c)); });
  });
  const url = "http://127.0.0.1:" + port;
  return { url, dbPath, stop: () => new Promise((r) => { child.on("exit", r); child.kill("SIGTERM"); }) };
}

async function newOrg(url, privacyMode, adminEmail) {
  const r = await fetch(url + "/v1/admin/orgs", { method: "POST", headers: { "content-type": "application/json", "x-bootstrap-key": "test-bootstrap-key" }, body: JSON.stringify({ name: "Test " + privacyMode, adminEmail, privacyMode }) });
  assert.equal(r.status, 201);
  return (await r.json()).adminInvite;
}

function agentEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-ag-"));
  const home = path.join(root, "home"), watch = path.join(root, "Downloads");
  fs.mkdirSync(watch, { recursive: true });
  saveConfig(home, { ...defaults(), folders: [watch] });
  const clock = { t: Date.now() };
  const agent = createAgent({ home, now: () => clock.t });
  const put = (name, fixture) => { const p = path.join(watch, name); fs.writeFileSync(p, fs.readFileSync(path.join(FIX, fixture))); clock.t += 60000; fs.utimesSync(p, new Date(clock.t), new Date(clock.t)); };
  const tick = async (n = 1) => { let r; for (let i = 0; i < n; i++) { clock.t += 5000; r = await agent.tick(); } return r; };
  return { agent, put, tick, home };
}

function dbText(dbPath) {
  const db = new DatabaseSync(dbPath);
  let all = "";
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    for (const row of db.prepare(`SELECT * FROM "${t.name}"`).all()) all += JSON.stringify(row) + "\n";
  }
  db.close();
  return all;
}

test("agent joins, records a file edit, and the server receives it (full mode keeps wording)", { skip: !HAVE && "backend folder not found" }, async (t) => {
  const be = await startBackend(); t.after(be.stop);
  const code = await newOrg(be.url, "full", "me@firm.com");
  const { agent, put, tick } = agentEnv();
  await agent.sync.join({ server: be.url, code, email: "me@firm.com", consent: true, deviceLabel: agent.deviceLabel });
  await tick();                                         // first look
  put("Q3 review.xlsx", "1_ai_output.xlsx"); await tick(2);
  put("Q3 review.xlsx", "2_final_deliverable.xlsx");
  const r = await tick(2);
  assert.equal(r.scan.recorded, 1);
  assert.equal(r.synced.ok, true, JSON.stringify(r.synced));
  assert.ok(r.synced.sent.fileRuns >= 1);
  const local = (await agent.storage.local.get("fileRuns")).fileRuns[0];
  const wording = local.changes.map((c) => c.after).filter((x) => x && x.length > 2).sort((a, b) => b.length - a.length)[0];
  assert.ok(wording, "the fixture should change at least one cell to a visible value");
  assert.ok(hasToken(dbText(be.dbPath), wording), "full mode stores the wording: " + wording);
  // sending again changes nothing
  const again = await agent.sync.syncNow();
  assert.equal(again.total, 0);
  // saving a second time updates the same record on the server (no duplicate)
  put("Q3 review.xlsx", "3_second_save.xlsx"); await tick(2);
  const org = await agent.sync.fetchOrgData();
  assert.equal((org.data || org).fileRuns.length, 1);
});

test("themes-only mode: the wording of a file change never reaches the server", { skip: !HAVE && "backend folder not found" }, async (t) => {
  const be = await startBackend(); t.after(be.stop);
  const code = await newOrg(be.url, "themes", "me@firm.com");
  const { agent, put, tick } = agentEnv();
  await agent.sync.join({ server: be.url, code, email: "me@firm.com", consent: true, deviceLabel: agent.deviceLabel });
  await tick();
  put("Q3 review.xlsx", "1_ai_output.xlsx"); await tick(2);
  put("Q3 review.xlsx", "2_final_deliverable.xlsx");
  const r = await tick(2);
  assert.equal(r.synced.ok, true, JSON.stringify(r.synced));
  const local = (await agent.storage.local.get("fileRuns")).fileRuns[0];
  const wordings = local.changes.flatMap((c) => [c.before, c.after]).filter((x) => x && x.length > 3);
  assert.ok(wordings.length > 0);
  const stored = dbText(be.dbPath);
  for (const w of wordings) assert.ok(!hasToken(stored, w), "leaked: " + w);
  // the record itself did arrive (so "no leak" is not just "nothing was sent")
  const org = await agent.sync.fetchOrgData();
  assert.equal((org.data || org).fileRuns.length, 1);
});

test("after leaving, the agent stops sending and keeps nothing of the login", { skip: !HAVE && "backend folder not found" }, async (t) => {
  const be = await startBackend(); t.after(be.stop);
  const code = await newOrg(be.url, "full", "me@firm.com");
  const { agent, put, tick } = agentEnv();
  await agent.sync.join({ server: be.url, code, email: "me@firm.com", consent: true, deviceLabel: agent.deviceLabel });
  await agent.sync.leave({ deleteData: true });
  assert.equal((await agent.sync.status()).joined, false);
  await tick();
  put("a.xlsx", "1_ai_output.xlsx"); await tick(2);
  put("a.xlsx", "2_final_deliverable.xlsx");
  const r = await tick(2);
  assert.equal(r.scan.recorded, 1);                      // still recorded on this computer
  assert.equal(r.synced.skipped, "not_joined");          // but nothing is sent
});

// Two different people, each with their own computer, chat about the same kind of task. Once synced, the company sees ONE workflow with two people.
async function personAgent(be, adminToken, email) {
  const r = await fetch(be.url + "/v1/admin/invites", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + adminToken }, body: JSON.stringify({ role: "member", email }) });
  assert.equal(r.status, 201);
  const code = (await r.json()).code;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-person-"));
  const home = path.join(root, "home"); fs.mkdirSync(home, { recursive: true });
  saveConfig(home, { ...defaults(), folders: [], screen: { enabled: true, storeMode: "full", intervalSeconds: 2, tools: ["claude", "gemini"] } });
  const clock = { t: Date.now() };
  const state = { win: { app: "Google Chrome", title: "x - Claude - Google Chrome - Me" }, nodes: [] };
  const probe = { title: async () => state.win, tree: async () => ({ nodes: state.nodes }) };
  const agent = createAgent({ home, now: () => clock.t, probe });
  await agent.sync.join({ server: be.url, code, email, consent: true, deviceLabel: agent.deviceLabel });
  return { agent, state, clock };
}
const Ln = (...p) => p.flatMap(([w, x]) => [{ role: "AXStaticText", text: w }, { role: "AXStaticText", text: x }]);

test("two people's chats about the same kind of task become one workflow with two people in the company's data", { skip: !HAVE && "backend folder not found" }, async (t) => {
  const be = await startBackend(); t.after(be.stop);
  const adminCode = await newOrg(be.url, "full", "boss@firm.com");
  const boss = createAgent({ home: (() => { const h = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ff-boss-")), "home"); fs.mkdirSync(h, { recursive: true }); saveConfig(h, { ...defaults(), folders: [] }); return h; })() });
  await boss.sync.join({ server: be.url, code: adminCode, email: "boss@firm.com", consent: true, deviceLabel: boss.deviceLabel });
  const adminToken = (await boss.storage.local.get("company")).company.token;

  const people = [];
  for (const [email, tool, win, topic] of [["ana@firm.com", "Claude", "Q3 notes - Claude - Google Chrome - Ana", "Summarize the Q3 earnings call for Acme Corp"], ["raj@firm.com", "Gemini", "Board recap - Google Gemini", "Summarize the board meeting from last week"]]) {
    const p = await personAgent(be, adminToken, email);
    p.state.win = { app: "Google Chrome", title: win };
    p.state.nodes = Ln(["You", topic], [tool, "Here is a first version."]);
    p.who = tool;
    people.push(p);
  }
  for (const p of people) { await p.agent.tick(); p.clock.t += 40_000; }
  people[0].state.nodes = [...people[0].state.nodes, ...Ln(["You", "Make it shorter and more formal"])];
  people[1].state.nodes = [...people[1].state.nodes, ...Ln(["You", "Use bullet points, not paragraphs"])];
  for (const p of people) { const r = await p.agent.tick(); assert.equal(r.synced.ok, true, JSON.stringify(r.synced)); }

  const org = await boss.sync.fetchOrgData();
  const data = org.data || org;
  const workflows = new Set(data.rePrompts.filter((r) => r.source !== "seed").map((r) => r.workflow));
  assert.deepEqual([...workflows], ["Summary"], "both chats are the same workflow");
  const sites = new Set(data.aiSessions.map((s) => s.site));
  assert.deepEqual([...sites].sort(), ["Claude", "Gemini"]);
  const authors = new Set(data.rePrompts.map((r) => r.user));
  assert.equal(authors.size, 2, "two different people, shown by their pseudonyms");
});
