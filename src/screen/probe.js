// The operating-system side of reading a chat window. It is deliberately two steps:
//   1. title(): the frontmost app and window title only (no content).
//   2. tree():  the window's text, which the caller asks for only when step 1 showed an allowed AI chat window.
//
// STATUS: written from the macOS and Windows documentation, NOT yet run on either. Expect to adjust it on a real machine.
// It only reads. It does not type, click, take screenshots, or log keystrokes.
//   macOS needs Accessibility permission for the app running this (System Settings > Privacy & Security > Accessibility).
//   Chrome only exposes page text to accessibility tools when its accessibility support is on (chrome://accessibility).
import { execFile } from "node:child_process";

const MAX_NODES = 3000, MAX_DEPTH = 30, MAX_OUTPUT = 4 * 1024 * 1024;

const MAC_TITLE = `
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
let title = "";
try { title = p.windows[0].name(); } catch (e) { title = ""; }
JSON.stringify({ app: p.name(), title: title });
`;

const MAC_TREE = `
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
const out = []; let count = 0;
function text(el) {
  for (const f of ["value", "title", "description"]) {
    try { const v = el[f](); if (typeof v === "string" && v.trim()) return v; } catch (e) {}
  }
  return "";
}
function walk(el, depth) {
  if (count >= ${MAX_NODES} || depth > ${MAX_DEPTH}) return;
  let kids = [];
  try { kids = el.uiElements(); } catch (e) {}
  for (const k of kids) {
    if (count >= ${MAX_NODES}) return;
    count++;
    let role = ""; try { role = k.role(); } catch (e) {}
    const t = text(k);
    if (t) out.push({ role: role, text: t });
    walk(k, depth + 1);
  }
}
try { walk(p.windows[0], 0); } catch (e) {}
JSON.stringify({ nodes: out });
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

const WIN_TREE = `
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

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(((stderr || "") + " " + (err.message || "")).trim().slice(0, 300)));
      try { resolve(JSON.parse(String(stdout).trim())); } catch { reject(new Error("The probe returned something that was not JSON.")); }
    });
  });
}

const ps = (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];

export function createProbe(platform = process.platform) {
  if (platform === "darwin") {
    return {
      title: () => run("osascript", ["-l", "JavaScript", "-e", MAC_TITLE], 8000),
      tree: () => run("osascript", ["-l", "JavaScript", "-e", MAC_TREE], 40000),
    };
  }
  if (platform === "win32") {
    return {
      title: () => run("powershell.exe", ps(WIN_TITLE), 10000),
      tree: () => run("powershell.exe", ps(WIN_TREE), 40000),
    };
  }
  const no = () => Promise.reject(new Error("Reading chat windows is only set up for macOS and Windows."));
  return { title: no, tree: no };
}
