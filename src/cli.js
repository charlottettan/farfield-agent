#!/usr/bin/env node
// Farfield desktop agent: command line.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { homeDir, loadConfig, saveConfig } from "./config.js";
import { createAgent } from "./agent.js";
import fs from "node:fs";
import { startApp } from "./app.js";
import { createProbe, ensureNative } from "./screen/probe.js";
import { identify, showTitle } from "./screen/sites.js";
import { extractTurns } from "./screen/turns.js";
import { hintsFor } from "./screen/adapters/index.js";
import { shapeDump, maskNodes } from "./screen/shape.js";

const USAGE = `Farfield desktop agent

  farfield-agent watch add <folder>     Start watching a folder (only chosen folders are ever read)
  farfield-agent watch remove <folder>
  farfield-agent watch list
  farfield-agent join --server <https://...> --code <invite> --email <you@company.com> [--agree]
  farfield-agent app [--port 4317] [--no-open]   Start the Farfield app: watching plus a page in your browser
  farfield-agent run                    Watch continuously, with no page (leave this running)
  farfield-agent scan                   Look once, then send anything new
  farfield-agent status                 What it watches, what it has, what is waiting to be sent
  farfield-agent pause | resume         Stop or restart watching without leaving
  farfield-agent leave [--delete-data]  Leave the company (optionally delete what was sent)
  farfield-agent screen on --agree      Also read AI chat windows (ChatGPT, Claude, Gemini, Copilot) to catch re-prompts
  farfield-agent screen off
  farfield-agent screen dump [--delay 5] [--any] [--max-nodes 800] [--timeout 60] [--engine native|slow] [--scope window] [--enable-accessibility] [--keep-text]   Save the structure of one chat window (text only with --keep-text; test chat only)
  farfield-agent screen build           Compile the native Mac reader once (needed before screen on works at full speed)
  farfield-agent screen log             What chat reading has seen lately (no message text), to find out why something was not captured
  farfield-agent screen forget          Delete every saved window dump
  farfield-agent screen shape [file]    Print the saved window's structure without its long text, safe to share after you read it
  farfield-agent where                  Show where its files live on this computer
`;

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "agree" || k === "delete-data" || k === "no-open" || k === "any" || k === "enable-accessibility" || k === "keep-text") flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

function say(s) { process.stdout.write(s + "\n"); }

export async function main(argv, env = process.env, deps = {}) {
  const { pos, flags } = parse(argv);
  const cmd = pos[0];
  const home = homeDir(env);
  if (!cmd || cmd === "help" || cmd === "--help") { say(USAGE); return 0; }

  if (cmd === "where") {
    say("Settings and records: " + home);
    say("  config.json  what to watch");
    say("  data.json    changes found in files, and the company login (keep this private)");
    say("  baselines/   private copies of the AI version of followed files");
    return 0;
  }

  if (cmd === "watch") {
    const cfg = loadConfig(home);
    const sub = pos[1], dir = pos[2] ? path.resolve(pos[2]) : "";
    if (sub === "list") { cfg.folders.forEach((f) => say(f)); if (!cfg.folders.length) say("Not watching any folder yet."); return 0; }
    if (!dir) { say("Give a folder, for example: farfield-agent watch add C:\\Users\\you\\Downloads"); return 1; }
    if (sub === "add") { if (!cfg.folders.includes(dir)) cfg.folders.push(dir); saveConfig(home, cfg); say("Watching " + dir); return 0; }
    if (sub === "remove") { cfg.folders = cfg.folders.filter((f) => f !== dir); saveConfig(home, cfg); say("No longer watching " + dir); return 0; }
    say(USAGE); return 1;
  }

  if (cmd === "pause" || cmd === "resume") {
    const cfg = loadConfig(home); cfg.paused = cmd === "pause"; saveConfig(home, cfg);
    say(cmd === "pause" ? "Paused. Nothing is being read or sent." : "Resumed.");
    return 0;
  }

  if (cmd === "screen") {
    const cfg = loadConfig(home);
    const sub = pos[1];
    if (sub === "on") {
      say("Farfield will read the text of an AI chat window (ChatGPT, Claude, Gemini or Copilot) only while that window is in front.");
      say("Any other window is never read. It does not take screenshots, record keystrokes, or keep unsent text.");
      say("What it keeps: the follow-up messages you send, shown in the mode below, and counts per task. Mode: " + ((cfg.screen && cfg.screen.storeMode) || "redacted") + " (names, numbers and emails masked).");
      if (process.platform === "darwin") say("On a Mac you will also need to allow Terminal under System Settings > Privacy & Security > Accessibility, and run `screen build` once so reading is fast.");
      if (!flags.agree) { say("\nRun the same command with --agree to turn it on."); return 0; }
      cfg.screen = { ...(cfg.screen || {}), enabled: true }; saveConfig(home, cfg); say("Chat reading is on."); return 0;
    }
    if (sub === "off") { cfg.screen = { ...(cfg.screen || {}), enabled: false }; saveConfig(home, cfg); say("Chat reading is off."); return 0; }
    if (sub === "dump") {
      const delay = Number(flags.delay || 0);
      if (delay > 0) { say(`Switch to the chat window now. Reading it in ${delay} seconds...`); await new Promise((r) => setTimeout(r, delay * 1000)); }
      const probe = deps.probe || createProbe(process.platform, undefined, undefined, { binDir: path.join(home, "bin") });
      const win = await probe.title();
      const tool = identify(win, cfg.screen && cfg.screen.tools);
      say(`Front window: app "${win.app}", title "${win.title}". Recognised as: ${tool ? tool.name + " (by " + tool.basis + ")" : "not an allowed AI chat"}.`);
      if (!tool) say(`Title as Farfield sees it (hidden characters spelled out): "${showTitle(win.title)}"`);
      if (!tool && !flags.any) { say("Not reading it. Switch to an AI chat window (use --delay 5 to get time), or add --any to read this window anyway."); return 1; }
      say("This reads the text on that window. Use a test chat with nothing private in it.");
      try { const c = await probe.check(); if (c && c.windows !== undefined) {
        say(`Permission check passed: ${c.windows} window(s); using window ${c.chosen + 1}, which has ${c.top} top-level items.`);
        if (Array.isArray(c.candidates)) say("Windows seen: " + c.candidates.map((w, i) => `#${i + 1} ${w.sub || "?"}${w.main ? " main" : ""}${w.named ? "" : " no-title"} ${w.items} items`).join("; "));
      } }
      catch (e) { say("Permission check failed: " + e.message); return 1; }
      const maxNodes = Number(flags["max-nodes"] || 6000), timeoutMs = Number(flags.timeout || 60) * 1000;
      say(`Reading up to ${maxNodes} items (limit ${timeoutMs / 1000} seconds). Larger windows are slow on a Mac.`);
      const started = Date.now();
      let tree;
      if (flags["enable-accessibility"]) say("Asking the app to build its accessibility tree, as VoiceOver would. It stays on in that app until you quit it and can use more memory there. Waiting a few seconds for it.");
      try { tree = await probe.tree({ maxNodes, timeoutMs, engine: flags.engine || "auto", enableAccessibility: flags["enable-accessibility"] === true, scope: flags.scope === "window" ? "window" : "web", ...(tool ? hintsFor(tool.id) : {}) }); }
      catch (e) { say("Could not read the window: " + e.message); return 1; }
      say(`Read took ${((Date.now() - started) / 1000).toFixed(1)} seconds, using the ${tree.engine || "default"} reader${tree.fellBack ? " (the fast one failed: " + tree.fellBack + ")" : ""}.`);
      if (tree.accessibility) say("What macOS accepted when asked to build the tree: " + Object.entries(tree.accessibility).map(([k, v]) => `${k}: ${v}`).join("; "));
      if (Array.isArray(tree.errors) && tree.errors.length) say(`The window reported problems when asked for its contents (so the picture may be incomplete): ${tree.errors.join(" | ")}`);
      if (tree.focus === "found") say(`Jumped to the message list and read only its last part (${tree.skipped} earlier items skipped).`);
      if (tree.focus === "missing") say("Could not find the message list by its label, so it read the whole page from the top.");
      if (typeof tree.visited === "number") say(`Looked at ${tree.visited} items${tree.visited >= maxNodes ? " (hit the limit, so there may be more: try a higher --max-nodes)" : " (the whole window, so what it shows is everything the app exposes)"}.`);
      const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
      const dir = path.join(home, "dumps"); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "dump-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
      // By default only the structure is saved: long text is reduced to a length and a letter pattern. Raw text needs --keep-text.
      const keep = flags["keep-text"] === true;
      fs.writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), platform: process.platform, engine: tree.engine, visited: tree.visited, errors: tree.errors, accessibility: tree.accessibility, enableAccessibility: flags["enable-accessibility"] === true, masked: !keep, win, nodes: keep ? nodes : maskNodes(nodes) }, null, 2), { mode: 0o600 });
      const roles = {}; nodes.forEach((n) => { roles[n.role] = (roles[n.role] || 0) + 1; });
      const t = extractTurns({ nodes }, tool);
      say(`Read ${nodes.length} pieces of text. Most common kinds: ` + Object.entries(roles).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} x${v}`).join(", "));
      say(`Farfield found ${t.turns.length} messages (${t.turns.filter((x) => x.role === "user").length} from you, ${t.turns.filter((x) => x.role === "assistant").length} from the AI), by ${t.basis}.`);
      if (keep) t.turns.slice(0, 8).forEach((x) => say(`  ${x.role}: ${x.text.slice(0, 70).replace(/\n/g, " ")}`));
      say(keep ? "Saved to " + file + " WITH the text that was on the window. Look through it before sharing it, and delete it when done (screen forget)." : "Saved to " + file + ". Only the structure was saved: long text is reduced to a length and a letter pattern.");
      return 0;
    }
    if (sub === "build") {
      say("Compiling the native reader with Swift. The first time can take a few minutes.");
      const bin = await (deps.ensureNative || ensureNative)({ binDir: path.join(home, "bin") });
      say("Ready: " + bin);
      return 0;
    }
    if (sub === "log") {
      const a = createAgent({ home });
      const log = ((await a.storage.local.get("screenLog")).screenLog || []).slice(-Number(flags.lines || 20));
      if (!log.length) { say("Nothing logged yet. Turn on chat reading (screen on --agree), run `app`, and keep an AI chat in front for about 30 seconds."); return 0; }
      const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
      const cfgNow = loadConfig(home);
      const lastAt = ((await a.storage.local.get("screenLast")).screenLast || {}).at || 0;
      const ago = lastAt ? Math.round((Date.now() - lastAt) / 1000) : 0;
      say(`Chat reading is ${cfgNow.screen && cfgNow.screen.enabled ? "ON" : "OFF"}${cfgNow.paused ? " (paused)" : ""}. Latest activity logged ${lastAt ? hhmmss(lastAt) + ", " + (ago < 120 ? ago + " seconds" : Math.round(ago / 60) + " minutes") + " ago" : "never"}.`);
      if (lastAt && ago > 150) say("Nothing has been logged for a while. Is `node src/cli.js app` still running in a terminal window?");
      log.forEach((e) => {
        let what;
        if (e.skipped === "not_allowed") what = `the window in front was ${e.app || "an unknown app"}${e.titleShape ? ` (title pattern: ${e.titleShape})` : ""}, which does not look like an AI chat, so nothing was read`;
        else if (e.skipped === "probe_error") what = "could not read the window: " + (e.error || "unknown problem");
        else if (e.skipped) what = "skipped: " + e.skipped;
        else what = `${e.tool}: ${e.seen} message(s) on screen, ${e.labels} new follow-up(s), ${e.rePrompts} counted as corrections` + (e.engine ? ` [${e.engine}]` : "");
        say(`${hhmmss(e.at)}${e.lastAt && e.lastAt - e.at > 60000 ? "-" + hhmmss(e.lastAt) : ""}  ${what}`);
      });
      return 0;
    }
    if (sub === "forget") {
      const dir = path.join(home, "dumps");
      const all = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      all.forEach((f) => fs.unlinkSync(path.join(dir, f)));
      say(all.length ? `Deleted ${all.length} saved file(s) from ${dir}.` : "No saved window dumps to delete.");
      return 0;
    }
    if (sub === "shape") {
      const dir = path.join(home, "dumps");
      let file = pos[2];
      if (!file) { const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []; if (!all.length) { say("No saved dump yet. Run: screen dump --delay 5"); return 1; } file = path.join(dir, all[all.length - 1]); }
      const text = shapeDump(JSON.parse(fs.readFileSync(file, "utf8")), { lines: Number(flags.lines || 150) });
      fs.writeFileSync(file.replace(/\.json$/, ".shape.txt"), text, { mode: 0o600 });
      say(text);
      say("\nThis shows labels and structure, not long text. Read it through before you share it.");
      return 0;
    }
    say("Use: screen on --agree | screen off | screen dump | screen build | screen log | screen shape [file] | screen forget"); return 1;
  }

  if (cmd === "app") {
    const port = flags.port ? Number(flags.port) : 4317;
    const app = await startApp({ home, port, open: !flags["no-open"], log: say });
    say("Farfield is running. Open this link in your browser (it works once):");
    say("  " + app.url);
    say("Press Ctrl+C to stop.");
    await new Promise((resolve) => process.on("SIGINT", resolve));
    await app.stop();
    return 0;
  }

  const agent = createAgent({ home });

  if (cmd === "join") {
    if (!flags.server || !flags.code || !flags.email) { say("Needs --server, --code and --email."); return 1; }
    const p = await agent.sync.preview(flags.server, flags.code);
    say(`Joining ${p.org && p.org.name} as ${p.role}. Privacy mode: ${p.privacyMode}. Kept for ${p.retentionDays || "an unlimited number of"} days.`);
    say("");
    say("The agent reads only Excel, Word and PowerPoint files in the folders you chose, and only files that appeared after it started.");
    say("It records which cells or paragraphs changed. It does not read your screen, record keystrokes, or take screenshots.");
    say(p.privacyMode === "full" ? "In this mode the wording of those changes is sent to your company." : p.privacyMode === "redacted" ? "In this mode names, numbers and emails are masked before anything is sent." : "In this mode no wording is sent, only categories, counts and timing.");
    if (!flags.agree) { say("\nRun the same command again with --agree to confirm and join."); return 0; }
    const co = await agent.sync.join({ server: flags.server, code: flags.code, email: flags.email, name: flags.name || "", consent: true, deviceLabel: agent.deviceLabel });
    say("Joined " + co.org.name + ". Add a folder with `watch add`, then `run`.");
    return 0;
  }

  if (cmd === "scan") { const r = await agent.tick(); say(JSON.stringify(r)); return 0; }
  if (cmd === "status") { say(JSON.stringify(await agent.status(), null, 2)); return 0; }
  if (cmd === "leave") { const r = await agent.sync.leave({ deleteData: !!flags["delete-data"] }); say("Left. " + JSON.stringify(r)); return 0; }

  if (cmd === "run") {
    const cfg = loadConfig(home);
    if (!cfg.folders.length) { say("Not watching any folder. Add one first: farfield-agent watch add <folder>"); return 1; }
    say("Watching: " + cfg.folders.join(", "));
    say("Press Ctrl+C to stop.");
    let stop = false;
    process.on("SIGINT", () => { stop = true; });
    while (!stop) {
      try { await agent.tick(); } catch (e) { say("Problem: " + ((e && e.message) || e)); }
      const wait = Math.max(1, loadConfig(home).pollSeconds) * 1000;
      for (let waited = 0; waited < wait && !stop; waited += 250) await new Promise((r) => setTimeout(r, 250));
    }
    return 0;
  }

  say(USAGE);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c || 0), (e) => { process.stderr.write("Error: " + ((e && e.message) || e) + "\n"); process.exit(1); });
}
