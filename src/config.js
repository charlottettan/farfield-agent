// Where the agent keeps its files, and the settings a person can change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function homeDir(env = process.env) {
  if (env.FARFIELD_HOME) return env.FARFIELD_HOME;
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Farfield");
  return path.join(os.homedir(), ".farfield-agent");
}

export function defaults() {
  return {
    // Only these folders are ever looked at. Nothing else on the computer is read.
    folders: [path.join(os.homedir(), "Downloads")],
    depth: 1,            // 0 = the folder itself; 1 = also its sub-folders
    pollSeconds: 5,
    baselineDays: 14,    // how long a file is followed after it first appears
    agentName: "AI-generated file",
    paused: false,
    // Reading AI chat windows (ChatGPT, Claude, Gemini, Copilot) to catch re-prompts. Off until someone turns it on.
    screen: { enabled: false, storeMode: "redacted", intervalSeconds: 10, tools: ["chatgpt", "claude", "gemini", "copilot"], workflowNames: "task" },
  };
}

export function loadConfig(home) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); } catch { saved = {}; }
  const cfg = { ...defaults(), ...saved };
  cfg.folders = (Array.isArray(cfg.folders) ? cfg.folders : []).filter((f) => typeof f === "string" && f).map((f) => path.resolve(f));
  return cfg;
}

export function saveConfig(home, cfg) {
  fs.mkdirSync(home, { recursive: true });
  const tmp = path.join(home, "config.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(home, "config.json"));
}
