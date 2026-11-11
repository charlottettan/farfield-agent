// The dashboard shows a sample company until real data exists. The extension creates that sample in background.js.
// To avoid keeping a second copy that could drift, this runs the extension's own background.js in a sandbox,
// asks it to seed an in-memory store, and merges the sample rows into the agent's data without touching real ones.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LISTS = ["corrections", "fixes", "aiSessions", "rePrompts", "fileRuns"];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function deepNoop() {
  const f = function () { return deepNoop(); };
  return new Proxy(f, { get: (_t, k) => (k === "then" ? undefined : deepNoop()), apply: () => deepNoop() });
}

const withFallback = (obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : deepNoop()) });

export async function buildSample() {
  const mem = {};
  const storage = {
    local: {
      async get(keys) {
        const out = {};
        const list = keys == null ? Object.keys(mem) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        list.forEach((k) => { if (k in mem) out[k] = clone(mem[k]); });
        return out;
      },
      async set(o) { Object.keys(o).forEach((k) => { mem[k] = clone(o[k]); }); },
      async remove(keys) { [].concat(keys).forEach((k) => { delete mem[k]; }); },
    },
  };
  const hooks = { installed: [] };
  const chromeStub = new Proxy({
    storage: withFallback(storage),
    runtime: withFallback({ onInstalled: { addListener: (f) => hooks.installed.push(f) }, getURL: (p) => p, getManifest: () => ({ version: "app" }) }),
  }, { get: (t, k) => (k in t ? t[k] : deepNoop()) });

  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, Date, Math, JSON, Object, Array, Number, String, Promise, RegExp, Error, Map, Set,
    TextEncoder, TextDecoder, Uint8Array,
    chrome: chromeStub,
    fetch: async () => { throw new Error("offline sandbox"); },
  });
  ctx.self = ctx;
  ctx.importScripts = (...names) => {
    for (const n of names) {
      const found = [path.join(ROOT, "vendor", n), path.join(ROOT, "web", "dashboard", n)].find((p) => fs.existsSync(p));
      if (!found) throw new Error("sample sandbox: missing " + n);
      vm.runInContext(fs.readFileSync(found, "utf8"), ctx, { filename: n });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "vendor", "background.js"), "utf8"), ctx, { filename: "background.js" });
  if (!hooks.installed.length) throw new Error("sample sandbox: background.js did not register its install step");
  for (const f of hooks.installed) await f({ reason: "install" });
  return mem;
}

const sendKey = (s) => [s.t, s.agent, s.category, s.surface].join("|");

// Adds sample rows next to whatever is already stored. Never changes or removes an existing row.
export function mergeSample(existing, sample) {
  const out = {};
  for (const k of LISTS) {
    const have = Array.isArray(existing[k]) ? existing[k] : [];
    const ids = new Set(have.map((x) => x && x.id));
    out[k] = have.concat((sample[k] || []).filter((x) => x && !ids.has(x.id)));
  }
  out.corrections.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const haveSends = Array.isArray(existing.sends) ? existing.sends : [];
  const keys = new Set(haveSends.map(sendKey));
  out.sends = haveSends.concat((sample.sends || []).filter((s) => !keys.has(sendKey(s)))).sort((a, b) => (a.t || 0) - (b.t || 0));

  const es = existing.settings || {}, ss = sample.settings || {};
  const agents = Array.from(new Set([].concat(es.agents || [], ss.agents || [])));
  out.settings = { ...ss, ...es, agents, agentTeams: { ...(ss.agentTeams || {}), ...(es.agentTeams || {}) }, workflowTeams: { ...(ss.workflowTeams || {}), ...(es.workflowTeams || {}) } };
  return out;
}

// Called when the app starts. Adds the sample company once; the flag stops it from coming back after "clear data".
export async function ensureSample(storage) {
  const cur = await storage.local.get(null);
  if (cur.sampleSeeded) return false;
  const merged = mergeSample(cur, await buildSample());
  await storage.local.set({ ...merged, sampleSeeded: true });
  return true;
}

// "Reset sample data" in the dashboard: remove every sample row, then add a fresh sample. Real rows are kept.
export async function resetSample(storage) {
  const cur = await storage.local.get(null);
  const keep = {};
  for (const k of LISTS.concat(["sends"])) keep[k] = (Array.isArray(cur[k]) ? cur[k] : []).filter((x) => !(k === "sends" ? !x.surface : x.source === "seed"));
  keep.settings = cur.settings || {};
  const merged = mergeSample(keep, await buildSample());
  await storage.local.set({ ...merged, sampleSeeded: true });
}

// "Delete all data" in the dashboard: clears every record, including the sample, and keeps the sample from returning.
export async function clearRecords(storage) {
  await storage.local.set({ corrections: [], sends: [], fixes: [], aiSessions: [], rePrompts: [], fileRuns: [], promptAnalysis: null, sampleSeeded: true });
}
