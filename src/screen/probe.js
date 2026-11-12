// The operating-system side of reading a chat window. It is deliberately two steps:
//   1. title(): the frontmost app and window title only (no content).
//   2. tree():  the window's text, which the caller asks for only when step 1 showed an allowed AI chat window.
//
// STATUS: written from the macOS and Windows documentation, NOT yet run on either. Expect to adjust it on a real machine.
// It only reads. It does not type, click, take screenshots, or log keystrokes.
//   macOS needs Accessibility permission for the app running this (System Settings > Privacy & Security > Accessibility).
//   Chrome only exposes page text to accessibility tools when its accessibility support is on (chrome://accessibility).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_NODES = 3000, MAX_DEPTH = 30, MAX_OUTPUT = 32 * 1024 * 1024;

// Browsers keep several windows (helper windows with no title or content). Pick the one that is the real, main window.
export const PICK_SOURCE = `
function pickWindow(p) {
  let ws = [];
  try { ws = p.windows(); } catch (e) {}
  let best = null, bestScore = -1, bestIndex = -1;
  const info = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]; let score = 0, sub = "", main = false, named = false, items = 0;
    try { sub = String(w.subrole()); if (sub === "AXStandardWindow") score += 2; } catch (e) {}
    try { main = w.attributes.byName("AXMain").value() === true; if (main) score += 4; } catch (e) {}
    try { if (w.attributes.byName("AXFocused").value() === true) score += 4; } catch (e) {}
    try { named = !!w.name(); if (named) score += 1; } catch (e) {}
    try { items = w.uiElements.length; if (items > 0) score += 1; } catch (e) {}
    info.push({ sub: sub, main: main, named: named, items: items });
    score -= i * 0.01;
    if (score > bestScore) { best = w; bestScore = score; bestIndex = i; }
  }
  return { window: best, index: bestIndex, count: ws.length, info: info };
}
`;

const MAC_TITLE = `
${PICK_SOURCE}
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
const pick = pickWindow(p);
let title = "";
try { title = pick.window ? pick.window.name() : ""; } catch (e) { title = ""; }
JSON.stringify({ app: p.name(), title: title });
`;

// Asks the front app to build its accessibility tree, the same request VoiceOver makes. It stays on in that app until the
// app is quit, and can use more memory there. Run only when explicitly asked for, as its own step, and it reports what macOS
// accepted for each setting. STATUS: the first attempt, inside the reading script, failed with "Message not understood (-1708)".
const MAC_ENABLE = `
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
const res = {};
for (const name of ["AXManualAccessibility", "AXEnhancedUserInterface"]) {
  try { p.attributes.byName(name).value = true; res[name] = "set"; }
  catch (e) { res[name] = "failed: " + String(e).slice(0, 140); }
}
JSON.stringify({ attributes: res });
`;

const macTree = (MAX_NODES) => `
${PICK_SOURCE}
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
const out = []; let count = 0; const errs = [];
// "description" in System Events is the role description ("button", "group"), not content, so it is not used.
function text(el) {
  for (const f of ["value", "title", "accessibilityDescription", "name"]) {
    try { const v = el[f](); if (typeof v === "string" && v.trim()) return v; } catch (e) {}
  }
  return "";
}
const KEEP = { AXWebArea: 1, AXScrollArea: 1, AXOutline: 1, AXTextArea: 1, AXTextField: 1, AXSplitGroup: 1, AXList: 1, AXTable: 1, AXStaticText: 1 };
function walk(el, depth) {
  if (count >= ${MAX_NODES} || depth > ${MAX_DEPTH}) return;
  let kids = [];
  try { kids = el.uiElements(); } catch (e) { if (errs.length < 5) errs.push(String(e).slice(0, 120)); }
  for (const k of kids) {
    if (count >= ${MAX_NODES}) return;
    count++;
    let role = ""; try { role = k.role(); } catch (e) {}
    const t = text(k);
    if (t || KEEP[role] || depth <= 3) out.push({ role: role, depth: depth, text: t });
    walk(k, depth + 1);
  }
}
try { const pick = pickWindow(p); if (pick.window) walk(pick.window, 0); } catch (e) {}
JSON.stringify({ visited: count, errors: errs, nodes: out });
`;

const WIN_TITLE = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class FF { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
"@
$h = [FF]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512
[void][FF]::GetWindowText($h, $sb, 512); $pid2 = 0; [void][FF]::GetWindowThreadProcessId($h, [ref]$pid2)
$app = ""; try { $app = (Get-Process -Id $pid2).ProcessName } catch {}
@{ app = $app; title = $sb.ToString() } | ConvertTo-Json -Compress
`;

const winTree = (MAX_NODES) => `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public class FF2 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$root = [System.Windows.Automation.AutomationElement]::FromHandle([FF2]::GetForegroundWindow())
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$out = New-Object System.Collections.ArrayList; $count = 0
$queue = New-Object System.Collections.Queue; $queue.Enqueue(@($root, 0))
while ($queue.Count -gt 0 -and $count -lt ${MAX_NODES}) {
  $pair = $queue.Dequeue(); $el = $pair[0]; $d = $pair[1]
  $c = $walker.GetFirstChild($el)
  while ($c -ne $null -and $count -lt ${MAX_NODES}) {
    $count++
    $name = $c.Current.Name; $role = $c.Current.ControlType.ProgrammaticName
    $val = ""
    try { $vp = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $val = $vp.Current.Value } catch {}
    $t = if ($val) { $val } else { $name }
    if ($t) { [void]$out.Add(@{ role = $role; text = $t }) }
    if ($d -lt ${MAX_DEPTH}) { $queue.Enqueue(@($c, $d + 1)) }
    $c = $walker.GetNextSibling($c)
  }
}
@{ nodes = $out } | ConvertTo-Json -Compress -Depth 4
`;

// Turns a failed command into a sentence a person can act on. The script itself is never part of the message.
export function explain(err, stderr, timeoutMs) {
  const text = String(stderr || "").trim() || String((err && err.message) || "").split("\n").slice(1).join(" ").trim();
  if (err && (err.killed || err.signal === "SIGTERM") && !text) return `It took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. The window has a lot of content; try --max-nodes 300.`;
  if (/assistive|accessib|-25211|-1719|1002|not allowed/i.test(text)) return "macOS has not allowed this. Open System Settings > Privacy & Security > Accessibility, turn on Terminal (or the app you ran this from), then run it again. " + text.slice(-160);
  if (/-1743|not authorized|automation/i.test(text)) return "macOS asked for permission to control System Events and it was not granted. Open System Settings > Privacy & Security > Automation and allow it. " + text.slice(-160);
  return (text || "The probe failed with no message.").slice(-300);
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(explain(err, stderr, timeoutMs)));
      try { resolve(JSON.parse(String(stdout).trim())); } catch { reject(new Error("The probe returned something that was not JSON: " + String(stdout).slice(0, 120))); }
    });
  });
}

const ps = (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];


// Faster macOS reader: calls the Accessibility C functions directly instead of sending one Apple event per property,
// which was taking ~40 seconds for a few hundred items. STATUS: not yet run on a real Mac. If it fails for any reason
// other than a missing permission, createProbe() falls back to the slow reader.
const macTreeFast = (MAX_NODES) => `
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
function attr(el, name) {
  const ref = Ref();
  const err = $.AXUIElementCopyAttributeValue(el, $(name), ref);
  return err === 0 ? ref[0] : null;
}
function str(v) {
  if (v === null || v === undefined) return "";
  let u; try { u = ObjC.unwrap(v); } catch (e) { return ""; }
  return typeof u === "string" ? u : "";
}
const pid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
const app = $.AXUIElementCreateApplication(pid);
let win = attr(app, "AXFocusedWindow");
if (!win) { const ws = attr(app, "AXWindows"); if (ws) { const a = ObjC.unwrap(ws); if (a.length) win = a[0]; } }
const out = []; let visited = 0;
if (win) {
  const stack = [[win, 0]];
  while (stack.length && visited < ${MAX_NODES}) {
    const cur = stack.pop(); const el = cur[0], d = cur[1];
    visited++;
    const role = str(attr(el, "AXRole"));
    const sub = str(attr(el, "AXSubrole"));
    let text = str(attr(el, "AXValue")); if (!text) text = str(attr(el, "AXTitle")); if (!text) text = str(attr(el, "AXDescription"));
    if (text || d <= 6) out.push({ role: role, sub: sub, depth: d, text: text });
    if (d < ${MAX_DEPTH}) {
      const kids = attr(el, "AXChildren");
      if (kids) { const arr = ObjC.unwrap(kids); for (let i = arr.length - 1; i >= 0; i--) stack.push([arr[i], d + 1]); }
    }
  }
}
JSON.stringify({ engine: "native", visited: visited, nodes: out });
`;

const MAC_CHECK = `
${PICK_SOURCE}
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
const pick = pickWindow(p);
let top = 0; try { top = pick.window ? pick.window.uiElements.length : 0; } catch (e) {}
JSON.stringify({ windows: pick.count, chosen: pick.index, top: top, candidates: pick.info });
`;

// opts for tree(): { maxNodes, timeoutMs, enableAccessibility, scope, build, engine: "auto" (default: native, else slow) | "native" | "slow" | "fast" (failed on a real Mac) }.
// ---- The native macOS reader (src/screen/ax.swift): calls the Accessibility API directly, like a screen reader does.
// It is compiled once with the Swift compiler that comes with Apple's command line tools, then reused.
// STATUS: never compiled or run. Compile errors are returned in full so they can be fixed.
const AX_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ax.swift");

function runRaw(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { const full = String(stderr || err.message || ""); const e = new Error(full.slice(-1500)); e.full = full.slice(0, 200000); e.code = err.code; return reject(e); }
      resolve({ stdout, stderr });
    });
  });
}

const MISMATCH = /failed to build module 'Swift'|not supported by the compiler|different version of the compiler|compiled module was created|-module-name Swift/;
const SDK_DIR = "/Library/Developer/CommandLineTools/SDKs";
const versionOf = (name) => (/MacOSX(\d[\d.]*)\.sdk/.exec(name) || [0, "0"])[1].split(".").map(Number);
const newestFirst = (a, b) => { const x = versionOf(a), y = versionOf(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; } return 0; };

export function compileHelp(e) {
  const full = String((e && (e.full || e.message)) || "");
  if ((e && e.code === "ENOENT") || /xcrun: error|command not found|no developer tools|ENOENT/i.test(full)) {
    return "Swift was not found. In Terminal run: xcode-select --install, wait for it to finish, then try again.";
  }
  // Show the compiler's own error lines, not the long command line it prints around them.
  const errors = full.split("\n").filter((l) => /\berror:/.test(l)).slice(0, 10).map((l) => l.trim().slice(0, 300));
  const mismatch = MISMATCH.test(full);
  const head = mismatch
    ? "Swift is installed, but it does not match this Mac's system files (a command line tools update is needed)" + ((e && e.triedSdks && e.triedSdks.length) ? ", and older SDKs (" + e.triedSdks.join(", ") + ") did not work either" : "") + ". Open System Settings > General > Software Update and install any 'Command Line Tools' update. If there is none, in Terminal run: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install"
    : "Swift could not compile the reader.";
  return head + (errors.length ? "\nThe compiler's errors:\n" + errors.join("\n") : "\n" + full.slice(0, 600));
}

export async function ensureNative({ binDir, compile = runRaw, fsApi = fs, source = AX_SOURCE, sdkDir = SDK_DIR, build = true } = {}) {
  const hash = crypto.createHash("sha256").update(fsApi.readFileSync(source)).digest("hex").slice(0, 12);
  const bin = path.join(binDir, "farfield-ax-" + hash);          // a changed source gives a new name, so it is recompiled
  if (fsApi.existsSync(bin)) return bin;
  if (build === false) throw new Error("The native reader has not been built yet. Run: node src/cli.js screen build");
  fsApi.mkdirSync(binDir, { recursive: true });
  const args = (sdk) => [...(sdk ? ["-sdk", path.join(sdkDir, sdk)] : []), "-O", "-o", bin, source];
  let failure;
  try { await compile("swiftc", args(), 300000); return bin; } catch (e) { failure = e; }

  // A compiler older than the system files it finds (a half-updated command line tools install) cannot read them.
  // Older SDKs usually sit next to the newest one, so try those before giving up.
  const tried = [];
  const firstText = String((failure && (failure.full || failure.message)) || "");
  if (MISMATCH.test(firstText)) {
    const refused = (/SDKs\/(MacOSX[\d.]*\.sdk)/.exec(firstText) || [])[1];
    let names = []; try { names = fsApi.readdirSync(sdkDir); } catch { names = []; }
    // SDK folders often include shortcuts ("MacOSX27.sdk" -> "MacOSX27.0.sdk"). Skip anything that points at a place already refused or tried.
    const real = (n) => { try { return fsApi.realpathSync(path.join(sdkDir, n)); } catch { return path.join(sdkDir, n); } };
    const seen = new Set(refused ? [real(refused)] : []);
    const older = names.filter((n) => /^MacOSX\d[\d.]*\.sdk$/.test(n) && n !== refused).sort(newestFirst).filter((n) => { const r = real(n); if (seen.has(r)) return false; seen.add(r); return true; });
    for (const sdk of older) {
      tried.push(sdk);
      try { await compile("swiftc", args(sdk), 300000); return bin; } catch (e) { failure = e; }
    }
  }
  let where = "";
  try { const log = path.join(binDir, "compile.log"); fsApi.writeFileSync(log, String((failure && (failure.full || failure.message)) || "")); where = "\nThe full compiler output is saved in " + log; } catch { /* the message above still stands */ }
  const err = new Error(compileHelp(Object.assign(Object.create(failure || {}), { full: String((failure && (failure.full || failure.message)) || ""), message: failure && failure.message, code: failure && failure.code, triedSdks: tried })) + where);
  throw err;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProbe(platform = process.platform, runner = run, sleep = sleepMs, extra = {}) {
  const binDir = extra.binDir || path.join(os.homedir(), ".farfield-agent", "bin");
  if (platform === "darwin") {
    const slow = (o) => runner("osascript", ["-l", "JavaScript", "-e", macTree(o.maxNodes || DEFAULT_NODES)], o.timeoutMs || 40000).then((r) => ({ engine: "events", ...r }));
    const fast = (o) => runner("osascript", ["-l", "JavaScript", "-e", macTreeFast(o.maxNodes || DEFAULT_NODES)], o.timeoutMs || 40000);
    const native = async (o) => {
      const bin = await ensureNative({ binDir, compile: extra.compile, fsApi: extra.fsApi, build: o.build !== false });
      const args = ["--max", String(o.maxNodes || 2000), "--seconds", String(Math.max(5, Math.round((o.timeoutMs || 60000) / 1000) - 10))];
      if (o.enableAccessibility === true) args.push("--enable");
      if (o.scope === "window") args.push("--scope", "window");
      if (o.focus) args.push("--focus", String(o.focus), "--tail", String(o.tail || 1500));
      if (o.focus && o.focusOnly) args.push("--focus-only");      // no labelled element: read nothing, instead of the whole page
      return runner(bin, args, o.timeoutMs || 60000);
    };
    const slowRead = async (o) => {
      let accessibility;
      if (o.enableAccessibility === true) {
        const r = await runner("osascript", ["-l", "JavaScript", "-e", MAC_ENABLE], 15000);
        accessibility = r.attributes;
        await sleep(o.settleMs === undefined ? 3000 : o.settleMs);      // give the app time to build its tree
      }
      const out = await slow(o);
      return accessibility ? { ...out, accessibility } : out;
    };
    return {
      title: () => runner("osascript", ["-l", "JavaScript", "-e", MAC_TITLE], 8000),
      check: () => runner("osascript", ["-l", "JavaScript", "-e", MAC_CHECK], 15000),
      async tree(o = {}) {
        const engine = o.engine || "auto";
        // The fast reader failed on the first real Mac it ran on ("Ref has incompatible type"), so it is opt-in only.
        // A read limited to one labelled element (an email draft box) is only possible with the native reader. The others would read the whole page.
        if (o.focusOnly && engine !== "native") throw new Error("Reading only one labelled element needs the native reader (engine native).");
        if (engine === "fast") return fast(o);
        if (engine === "slow") return slowRead(o);
        if (engine === "native") return native(o);
        // auto: the native reader (it read a real Gemini conversation), falling back to the slow one if it cannot be built.
        try { return await native(o); }
        catch (e) {
          if (/Accessibility|Automation|longer than/.test(String(e.message))) throw e;      // a fallback cannot fix these
          const r = await slowRead(o);
          return { ...r, fellBack: String(e.message).split("\n")[0].slice(0, 200) };
        }
      },
    };
  }
  if (platform === "win32") {
    return {
      title: () => runner("powershell.exe", ps(WIN_TITLE), 10000),
      check: () => Promise.resolve({ ok: true }),
      tree: (o = {}) => (o.focusOnly ? Promise.reject(new Error("Reading only one labelled element is not available on Windows yet.")) : runner("powershell.exe", ps(winTree(o.maxNodes || DEFAULT_NODES)), o.timeoutMs || 40000)),
    };
  }
  const no = () => Promise.reject(new Error("Reading chat windows is only set up for macOS and Windows."));
  return { title: no, check: no, tree: no };
}
