import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../src/agent.js";
import { saveConfig, defaults } from "../src/config.js";
import { createFileStorage } from "../src/storage.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DAY = 86400000;

function setup(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-agent-"));
  const home = path.join(root, "home"), watch = path.join(root, "Downloads");
  fs.mkdirSync(watch, { recursive: true });
  saveConfig(home, { ...defaults(), folders: [watch], ...over });
  const clock = { t: Date.UTC(2026, 10, 9, 12, 0, 0) };
  const mk = () => createAgent({ home, now: () => clock.t, fetch: async () => { throw new Error("no network in this test"); } });
  const put = (name, fixture, dir = watch) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, fs.readFileSync(path.join(FIX, fixture)));
    clock.t += 60000;
    fs.utimesSync(p, new Date(clock.t), new Date(clock.t));
    return p;
  };
  const scan = async (agent, n = 1) => { let r; for (let i = 0; i < n; i++) { clock.t += 5000; r = await agent.scanOnce(); } return r; };
  const data = async (agent, k) => (await agent.storage.local.get(k))[k];
  return { root, home, watch, clock, mk, put, scan, data };
}

test("files already in a folder when the agent starts are left alone, even if edited later", async () => {
  const s = setup(); const a = s.mk();
  const p = s.put("old.xlsx", "1_ai_output.xlsx");
  await s.scan(a, 2);
  s.put("old.xlsx", "2_final_deliverable.xlsx");
  const r = await s.scan(a, 3);
  assert.equal(r.recorded, 0);
  assert.equal(((await s.data(a, "fileRuns")) || []).length, 0);
  const st = (await s.data(a, "agent")).files;
  assert.equal(Object.values(st)[0].state, "ignored");
  assert.ok(fs.existsSync(p));
});

test("a new file is followed, and saving it with changes records one correction", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);                                  // first look: nothing there yet
  s.put("Q3 review.xlsx", "1_ai_output.xlsx");
  const r1 = await s.scan(a, 2);                    // seen, then stable: a private copy is kept
  assert.equal(r1.baselined, 1);
  assert.equal(r1.tracking, 1);
  assert.equal(fs.readdirSync(path.join(s.home, "baselines")).length, 1);
  s.put("Q3 review.xlsx", "2_final_deliverable.xlsx");
  const r2 = await s.scan(a, 2);
  assert.equal(r2.recorded, 1);
  const runs = await s.data(a, "fileRuns");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].surface, "Excel");
  assert.equal(runs[0].workflow, "Q3 review");
  assert.equal(runs[0].fileName, "Q3 review.xlsx");
  assert.ok(runs[0].changedCells > 0 && runs[0].changes.length > 0);
  assert.equal(runs[0].source, "live");
  assert.equal(runs[0].corrId, (await s.data(a, "corrections"))[0].id);
  assert.equal((await s.data(a, "sends")).length, 1);
});

test("saving again updates the same record instead of adding another", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  s.put("report.xlsx", "1_ai_output.xlsx"); await s.scan(a, 2);
  s.put("report.xlsx", "2_final_deliverable.xlsx"); await s.scan(a, 2);
  const first = (await s.data(a, "fileRuns"))[0];
  s.put("report.xlsx", "3_second_save.xlsx"); await s.scan(a, 2);
  const runs = await s.data(a, "fileRuns");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, first.id);
  assert.equal(runs[0].createdAt, first.createdAt);
  assert.equal((await s.data(a, "corrections")).length, 1);
  assert.equal((await s.data(a, "sends")).length, 1);
});

test("saving without changing anything, or changing back, records nothing new", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  s.put("r.xlsx", "1_ai_output.xlsx"); await s.scan(a, 2);
  s.put("r.xlsx", "1_ai_output.xlsx");               // re-saved, identical content
  assert.equal((await s.scan(a, 2)).recorded, 0);
  s.put("r.xlsx", "2_final_deliverable.xlsx"); await s.scan(a, 2);
  s.put("r.xlsx", "1_ai_output.xlsx");               // changed back to the AI version
  assert.equal((await s.scan(a, 2)).recorded, 0);
  assert.equal((await s.data(a, "fileRuns")).length, 1);
});

test("a file still being written is not read until it stops changing", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  const p = s.put("slow.xlsx", "1_ai_output.xlsx");
  const r = await s.scan(a, 1);
  assert.equal(r.baselined, 0);
  s.put("slow.xlsx", "1_ai_output.xlsx");           // touched again
  assert.equal((await s.scan(a, 1)).baselined, 0);
  assert.equal((await s.scan(a, 1)).baselined, 1);
  assert.ok(fs.existsSync(p));
});

test("temporary, hidden and unsupported files are never followed", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  s.put("~$report.xlsx", "1_ai_output.xlsx");
  s.put("report.xlsx.tmp", "1_ai_output.xlsx");
  s.put(".hidden.xlsx", "1_ai_output.xlsx");
  fs.writeFileSync(path.join(s.watch, "notes.txt"), "hello");
  fs.writeFileSync(path.join(s.watch, "legacy.xls"), "old format");
  await s.scan(a, 4);
  assert.deepEqual(Object.keys((await s.data(a, "agent")).files), []);
});

test("a file that is not really an Office file is dropped after a few tries", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  fs.writeFileSync(path.join(s.watch, "broken.xlsx"), "this is not a zip");
  await s.scan(a, 12);
  const rec = Object.values((await s.data(a, "agent")).files)[0];
  assert.equal(rec.state, "ignored");
  assert.equal((await s.data(a, "fileRuns") || []).length, 0);
});

test("only the chosen folders are read, to the chosen depth", async () => {
  const s = setup({ depth: 1 }); const a = s.mk();
  await s.scan(a);
  const outside = path.join(s.root, "Documents");
  s.put("elsewhere.xlsx", "1_ai_output.xlsx", outside);
  s.put("sub.xlsx", "1_ai_output.xlsx", path.join(s.watch, "client"));
  s.put("deep.xlsx", "1_ai_output.xlsx", path.join(s.watch, "client", "deeper"));
  await s.scan(a, 3);
  const names = Object.values((await s.data(a, "agent")).files).map((r) => path.basename(r.path)).sort();
  assert.deepEqual(names, ["sub.xlsx"]);
});

test("a paused agent reads nothing and stores nothing", async () => {
  const s = setup({ paused: true }); const a = s.mk();
  s.put("r.xlsx", "1_ai_output.xlsx");
  const r = await s.scan(a, 3);
  assert.equal(r.paused, true);
  assert.equal(await s.data(a, "agent"), undefined);
  assert.equal(fs.existsSync(path.join(s.home, "baselines")), false);
});

test("it picks up where it left off after a restart", async () => {
  const s = setup(); const a1 = s.mk();
  await s.scan(a1);
  s.put("r.xlsx", "1_ai_output.xlsx"); await s.scan(a1, 2);
  const a2 = s.mk();                                 // a new process, same folders on disk
  s.put("r.xlsx", "2_final_deliverable.xlsx");
  assert.equal((await s.scan(a2, 2)).recorded, 1);
});

test("old followed files expire and their private copies are deleted", async () => {
  const s = setup({ baselineDays: 14 }); const a = s.mk();
  await s.scan(a);
  s.put("r.xlsx", "1_ai_output.xlsx"); await s.scan(a, 2);
  assert.equal(fs.readdirSync(path.join(s.home, "baselines")).length, 1);
  s.clock.t += 15 * DAY;
  s.put("r.xlsx", "2_final_deliverable.xlsx");
  const r = await s.scan(a, 2);
  assert.equal(r.recorded, 0);
  assert.equal(fs.readdirSync(path.join(s.home, "baselines")).length, 0);
  assert.equal(Object.values((await s.data(a, "agent")).files)[0].state, "expired");
});

test("a file that is deleted stops being followed and its private copy is removed", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  const p = s.put("r.xlsx", "1_ai_output.xlsx"); await s.scan(a, 2);
  fs.unlinkSync(p);
  await s.scan(a, 4);
  assert.equal(Object.values((await s.data(a, "agent")).files)[0].state, "gone");
  assert.equal(fs.readdirSync(path.join(s.home, "baselines")).length, 0);
});

test("two files that started identical stay separate records", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  s.put("a.xlsx", "1_ai_output.xlsx"); s.put("b.xlsx", "1_ai_output.xlsx"); await s.scan(a, 2);
  assert.equal(fs.readdirSync(path.join(s.home, "baselines")).length, 1);   // one private copy, shared
  s.put("a.xlsx", "2_final_deliverable.xlsx"); s.put("b.xlsx", "2_final_deliverable.xlsx"); await s.scan(a, 2);
  const runs = await s.data(a, "fileRuns");
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].id, runs[1].id);
});

test("Word files work the same way", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  s.put("Weekly summary.docx", "4_ai_summary.docx"); await s.scan(a, 2);
  s.put("Weekly summary.docx", "5_edited_summary.docx");
  assert.equal((await s.scan(a, 2)).recorded, 1);
  const run = (await s.data(a, "fileRuns"))[0];
  assert.equal(run.surface, "Word");
  assert.ok(run.changedCells >= 1);
});

test("the data file is private to the user on systems that support it", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(s.home, "data.json")).mode & 0o077, 0);
});

test("the storage stand-in behaves like chrome.storage.local", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ff-st-")), "d.json");
  const st = createFileStorage(f);
  await st.local.set({ a: { x: 1 }, b: [1, 2] });
  assert.deepEqual(await st.local.get("a"), { a: { x: 1 } });
  assert.deepEqual(await st.local.get(["a", "zzz"]), { a: { x: 1 } });
  assert.deepEqual(await st.local.get({ zzz: 5 }), { zzz: 5 });
  const again = createFileStorage(f);
  assert.deepEqual((await again.local.get(null)).b, [1, 2]);
  await again.local.remove(["a"]);
  assert.deepEqual(await again.local.get("a"), {});
});

test("status shows what was recorded as counts and file names, never the wording", async () => {
  const s = setup(); const a = s.mk();
  await s.scan(a);
  s.put("Q3 review.xlsx", "1_ai_output.xlsx"); await s.scan(a, 2);
  assert.equal((await a.status()).recorded.count, 0);
  s.put("Q3 review.xlsx", "2_final_deliverable.xlsx"); await s.scan(a, 2);
  const st = await a.status();
  assert.equal(st.recorded.count, 1);
  assert.equal(st.recorded.latest[0].file, "Q3 review.xlsx");
  assert.ok(st.recorded.latest[0].changedCells > 0);
  const wording = (await s.data(a, "fileRuns"))[0].changes.map((c) => c.after).find((v) => v && v.length > 3);
  assert.ok(!JSON.stringify(st).includes(wording));
});

test("two copies of the agent sharing one data file never erase each other's changes", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ff-st2-")), "d.json");
  const a = createFileStorage(f), b = createFileStorage(f);
  await a.local.set({ company: { token: "t" } });
  await b.local.set({ agent: { files: {} } });            // b was opened before a wrote, and must not drop a's login
  await a.local.set({ fileRuns: [{ id: "x" }] });         // a must not drop b's state either
  const all = await createFileStorage(f).local.get(null);
  assert.deepEqual(Object.keys(all).sort(), ["agent", "company", "fileRuns"]);
});

test("status does not count sample rows as things this computer found", async () => {
  const s = setup(); const a = s.mk();
  await a.storage.local.set({ fileRuns: [{ id: "s1", source: "seed", fileName: "sample.xlsx", surface: "Excel", changedCells: 9 }] });
  const st = await a.status();
  assert.equal(st.recorded.count, 0);
  assert.deepEqual(st.recorded.latest, []);
});
