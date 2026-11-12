"""Chats captured from two tools are grouped into workflows by the kind of task, in the real dashboard (Chromium)."""
import json, os, re, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed, failed = 0, []
def check(name, cond, info=""):
    global passed
    if cond: passed += 1; print("PASS ", name)
    else: failed.append(name); print("FAIL ", name, info)

root = tempfile.mkdtemp(prefix="ff-chats-"); home = root + "/home"; os.makedirs(home)
# records made the way the watcher makes them: a summary chat in Gemini, a summary chat in Claude, and an email chat in Claude
gen = subprocess.run(["node", "-e", """
import('./src/screen/observer.js').then(({ createObserver }) => {
  let t = Date.now() - 600000; const o = createObserver({ now: () => t, mode: 'redacted' });
  const L = (...p) => p.flatMap(([w, x]) => [{ role: 'AXStaticText', text: w }, { role: 'AXStaticText', text: x }]);
  const out = { rePrompts: [], aiSessions: [] };
  const add = (r) => { out.rePrompts.push(...r.rePrompts); for (const s of r.sessions) { const i = out.aiSessions.findIndex((x) => x.id === s.id); if (i >= 0) out.aiSessions[i] = s; else out.aiSessions.push(s); } };
  const chats = [
    [{ id: 'gemini', name: 'Gemini' }, 'Gemini', 'Summarize the Q3 earnings call for Acme Corp', 'Make it shorter and more formal'],
    [{ id: 'claude', name: 'Claude' }, 'Claude', 'Summarize the board meeting from last week', 'Use bullet points, not paragraphs'],
    [{ id: 'claude', name: 'Claude' }, 'Claude', 'Draft an email to the client about the delayed settlement', 'It is too stiff, make it warmer'],
  ];
  for (const [tool, who, first, fix] of chats) {
    const base = L(['You', first], [who, 'Here is a first version.']);
    add(o.feed({ nodes: base }, tool)); t += 40000;
    add(o.feed({ nodes: [...base, ...L(['You', fix])] }, tool)); t += 1000;
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
        names = sorted({r["workflow"] for r in data["rePrompts"]})
        check("the records name workflows by kind of task, not by tool", names == ["Email draft", "Summary"], str(names))
        dash = c.new_page(); dash.goto(BASE + "/dashboard.html#/trace")
        end = time.time() + 15
        while time.time() < end and "Email draft" not in dash.inner_text("body"): time.sleep(0.3)
        text = dash.inner_text("body")
        check("the Workflows tab lists a Summary workflow", "Summary" in text)
        check("and an Email draft workflow", "Email draft" in text)
        summary_row = text[text.find("Summary"):][:200]
        check("the Summary workflow holds the chats from both tools", "Gemini" in summary_row and "Claude" in summary_row, summary_row)
        check("it shows both re-prompts", "2 re-prompts" in summary_row, summary_row)
        check("and no longer lumps chats into 'Unassigned workflow' or one row per tool", "Unassigned workflow" not in text and "Claude chat" not in text and "Gemini chat" not in text)
        b.close()
finally:
    proc.terminate()
    try: proc.wait(timeout=10)
    except Exception: proc.kill()
print(f"\n{passed} checks passed, {len(failed)} failed", failed)
sys.exit(1 if failed else 0)
