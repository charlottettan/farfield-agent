// A tiny stand-in for chrome.storage.local, backed by one JSON file. It lets the agent reuse the extension's own
// sync code unchanged, so both clients join, scrub and send in exactly the same way.
import fs from "node:fs";
import path from "node:path";

export function createFileStorage(file) {
  let data = {};
  // Re-read the file before every operation, so two copies of the agent (for example `run` in one window and `join` in
  // another) never overwrite each other's changes with a stale in-memory copy.
  function load() { try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; } }
  load();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return {
    file,
    local: {
      async get(keys) {
        load();
        const out = {};
        const list = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        for (const k of list) if (k in data) out[k] = clone(data[k]);
        if (keys && typeof keys === "object" && !Array.isArray(keys)) for (const k of Object.keys(keys)) if (!(k in out)) out[k] = keys[k];
        return out;
      },
      async set(obj) { load(); for (const k of Object.keys(obj)) data[k] = clone(obj[k]); save(); },
      async remove(keys) { load(); for (const k of [].concat(keys)) delete data[k]; save(); },
    },
  };
}
