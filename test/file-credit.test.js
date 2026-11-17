import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults } from "../src/config.js";
import { categoriesOf, mainCategory, FORMULA } from "../src/edits.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
// The three changes from the first live comps test (Nov 17 2026).
const COMPS = [
  { addr: "Comps!H4", before: "EV / EBITDA", after: "EV / LTM EBITDA" },
  { addr: "Comps!G8", before: "201270", after: "202222" },
  { addr: "Comps!J11", before: "=AVERAGE(J5:J9)", after: "=AVERAGE(J5:J8)" },
];

test("formula fixes get their own label; the main label stays one the sync accepts", () => {
  const kinds = categoriesOf(COMPS);
  assert.deepEqual(kinds, [FORMULA, "Factual/Data Correction", "Terminology/Context Mismatch"]);
  assert.equal(mainCategory(kinds), "Factual/Data Correction");
  assert.equal(mainCategory(categoriesOf([COMPS[2]])), "Factual/Data Correction");          // a formula-only fix routes like a factual one
  assert.equal(mainCategory(categoriesOf([COMPS[0]])), "Terminology/Context Mismatch");
  assert.deepEqual(categoriesOf([{ before: "=SUM(B2:B9)", after: "=SUM(B2:B9)" }]), []);   // unchanged formula: nothing
});

function setup(screen) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-credit-"));
  const home = path.join(root, "home"), watch = path.join(root, "Downloads");
  fs.mkdirSync(watch, { recursive: true });
  saveConfig(home, { ...defaults(), folders: [watch], screen: { ...defaults().screen, enabled: true, intervalSeconds: 2, tools: ["claude"], ...screen } });
  const clock = { t: Date.UTC(2026, 10, 17, 12, 0, 0) };
  const state = { win: { app: "Google Chrome", title: "Comps table - Claude - Google Chrome" } };
  const line = (who, text) => [{ role: "AXStaticText", text: who }, { role: "AXStaticText", text }];
  const probe = {
    title: async () => state.win,
    tree: async () => ({ engine: "native", nodes: [...line("You", "Build a comparable companies analysis as an .xlsx for five tech companies with EV/EBITDA and P/E"), ...line("Claude", "Here is your comparable companies spreadsheet with EV/EBITDA and P/E for the five companies.")] }),
  };
  const a = createAgent({ home, now: () => clock.t, probe, fetch: async () => { throw new Error("offline"); } });
  const put = (name, fixture) => { const p = path.join(watch, name); fs.writeFileSync(p, fs.readFileSync(path.join(FIX, fixture))); clock.t += 60000; fs.utimesSync(p, new Date(clock.t), new Date(clock.t)); };
  const scan = async (n = 1) => { let r; for (let i = 0; i < n; i++) { clock.t += 5000; r = await a.scanOnce(); } return r; };
  const runs = async () => (await a.storage.local.get("fileRuns")).fileRuns.filter((r) => r.source === "live");
  const corrs = async () => (await a.storage.local.get("corrections")).corrections.filter((c) => c.source === "live");
  return { a, clock, state, put, scan, runs, corrs };
}

test("a file that arrives just after an AI chat is credited to that AI and filed with that chat", async () => {
  const s = setup();
  await s.a.tick();                                    // first look: the folder is empty, and a Claude chat with a reply is on screen
  s.clock.t += 30_000;
  s.put("comps.xlsx", "1_ai_output.xlsx");             // the download arrives
  await s.scan(2);
  s.put("comps.xlsx", "2_final_deliverable.xlsx");     // edited and saved in Excel
  await s.scan(2);
  const run = (await s.runs())[0], corr = (await s.corrs())[0];
  assert.equal(run.agent, "Claude");
  assert.equal(corr.agent, "Claude");
  assert.equal(run.workflow, "Research and analysis"); // the chat's task (not the file's name "comps"), so the file sits with its chat
  assert.equal(run.fileName, "comps.xlsx");
  const agents = ((await s.a.storage.local.get("settings")).settings || {}).agents || [];
  assert.ok(agents.includes("Claude"));
});

test("a file with no AI chat recently on screen keeps the generic name", async () => {
  const s = setup();
  await s.a.tick();                                    // a Claude chat seen...
  s.clock.t += 40 * 60_000;                            // ...40 minutes before the file arrives
  s.put("budget.xlsx", "1_ai_output.xlsx");
  await s.scan(2);
  s.put("budget.xlsx", "2_final_deliverable.xlsx");
  await s.scan(2);
  const run = (await s.runs())[0];
  assert.notEqual(run.agent, "Claude");
  assert.equal((await s.corrs())[0].agent, defaults().agentName);
  assert.equal(run.workflow, "budget");
});
