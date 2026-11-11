"""Chats captured from two different tools show up as two separate workflows in the real dashboard (Chromium)."""
import json, os, re, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed, failed = 0, []
def check(name, cond, info=""):
    global passed
    if cond: passed += 1; print("PASS ", name)
    else: failed.append(name); print("FAIL ", name, info)

root = tempfile.mkdtemp(prefix="ff-chats-"); home = root + "/home"; os.makedirs(home)
# records made the way the watcher makes them, for one Gemini chat and one Claude chat
gen = subprocess.run(["node", "-e", """
import('./src/screen/observer.js').then(({ createObserver }) => {
  let t = Date.now() - 600000; const o = createObserver({ now: () => t, mode: 'redacted' });
  const L = (...p) => p.flatMap(([w, x]) => [{ role: 'AXStaticText', text: w }, { role: 'AXStaticText', text: x }]);
  const out = { rePrompts: [], aiSessions: [] };
  const add = (r) => { out.rePrompts.push(...r.rePrompts); for (const s of r.sessions) { const i = out.aiSessions.findIndex((x) => x.id === s.id); if (i >= 0) out.aiSessions[i] = s; else out.aiSessions.push(s); } };
  for (const [tool, who] of [[{ id: 'gemini', name: 'Gemini' }, 'Gemini'], [{ id: 'claude', name: 'Claude' }, 'Claude']]) {
    const base = L(['You', 'Summarize the Q3 earnings call for Acme Corp'], [who, 'Revenue was 1.2 billion.']);
    add(o.feed({ nodes: base }, tool)); t += 40000;
    add(o.feed({ nodes: [...base, ...L(['You', 'Make it shorter and more formal'])] }, tool)); t += 1000;
  }
  process.stdout.write(JSON.stringify(out));
});"""], cwd=AGENT, capture_output=True, text=True)
data = json.loads(gen.stdout)
json.dump(data, open(home + "/data.json", "w"))
json.dump({"folders": [root], "depth": 1, "pollSeconds": 5, "baselineDays": 14, "agentName": "AI-generated file", "paused": False}, open(home + "/config.json", "w"))
proc = subprocess.Popen(["node", "src/cli.js", "app", "--no-open", "--port", "0"], cwd=AGENT, env={**os.environ, "FARFIELD_HOME": home}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
link = None
for _ in range(80):
    m = re.search(r"(http://127\.0\.0\.1:\d+/\?t=[a-f0-9]+)", proc.stdout.readline() or "")
    if m: link = m.group(1); break
BASE = link.split("/?")[0]
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); c = b.new_context(viewport={"width": 1280, "height": 1200}); pg = c.new_page(); pg.goto(link)
        check("the records have one workflow per tool", sorted({r["workflow"] for r in data["rePrompts"]}) == ["Claude chat", "Gemini chat"], str({r["workflow"] for r in data["rePrompts"]}))
        dash = c.new_page(); dash.goto(BASE + "/dashboard.html#/trace")
        end = time.time() + 15
        while time.time() < end and "Claude chat" not in dash.inner_text("body"): time.sleep(0.3)
        text = dash.inner_text("body")
        check("the Workflows tab lists the Gemini chat", "Gemini chat" in text)
        check("the Workflows tab lists the Claude chat", "Claude chat" in text)
        check("and no longer lumps them into 'Unassigned workflow'", "Unassigned workflow" not in text)
        row = text[text.find("Claude chat"):][:160]
        check("the Claude chat is shown with its re-prompt", "1 re-prompt" in row, row)
        b.close()
finally:
    proc.terminate()
print(f"\n{passed} checks passed, {len(failed)} failed", failed)
sys.exit(1 if failed else 0)
