"""Real Chromium against the real local app: panel, dashboard (through the shim), a live file correction, and attacks from another site."""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time, http.server
from playwright.sync_api import sync_playwright

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(AGENT, "test", "fixtures")
SHOTS = os.environ.get("SHOTS", "/tmp/shots_app"); os.makedirs(SHOTS, exist_ok=True)
passed, failed = 0, []
def wait_until(fn, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.25)
    return False
def check(name, cond, info=""):
    global passed
    if cond: passed += 1; print("PASS ", name)
    else: failed.append(name); print("FAIL ", name, info)

root = tempfile.mkdtemp(prefix="ff-e2e-")
home, watch = os.path.join(root, "home"), os.path.join(root, "Downloads")
os.makedirs(home); os.makedirs(watch)
json.dump({"folders": [watch], "depth": 1, "pollSeconds": 1, "baselineDays": 14, "agentName": "AI-generated file", "paused": False}, open(os.path.join(home, "config.json"), "w"))

proc = subprocess.Popen(["node", "src/cli.js", "app", "--no-open", "--port", "0"], cwd=AGENT, env={**os.environ, "FARFIELD_HOME": home}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
link = None
for _ in range(80):
    line = proc.stdout.readline()
    m = re.search(r"(http://127\.0\.0\.1:\d+/\?t=[a-f0-9]+)", line or "")
    if m: link = m.group(1); break
assert link, "app did not start"
BASE = link.split("/?")[0]

def put(name, fixture):
    p = os.path.join(watch, name)
    shutil.copy(os.path.join(FIX, fixture), p)
    t = time.time() + put.n * 60; put.n += 1
    os.utime(p, (t, t))
put.n = 1

# a page on a different local port, standing in for any website the person might visit
class Evil(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("<html><body><script>"
                "window.results = {};"
                f"fetch('{BASE}/api/agent/pause', {{method:'POST', credentials:'include', headers:{{'x-farfield':'1','content-type':'application/json'}}, body:'{{}}'}}).then(r=>window.results.custom='sent:'+r.status).catch(e=>window.results.custom='blocked');"
                f"fetch('{BASE}/api/agent/pause', {{method:'POST', credentials:'include', mode:'no-cors', headers:{{'content-type':'text/plain'}}, body:'{{}}'}}).then(r=>window.results.simple='sent').catch(e=>window.results.simple='blocked');"
                f"fetch('{BASE}/api/storage/get', {{method:'POST', credentials:'include', headers:{{'content-type':'application/json'}}, body:'{{}}'}}).then(r=>r.text()).then(t=>window.results.read='read:'+t.length).catch(e=>window.results.read='blocked');"
                "</script></body></html>").encode()
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
evil = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Evil)
threading.Thread(target=evil.serve_forever, daemon=True).start()

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        errors = []
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))

        # --- the one-time link
        page.goto(link)
        page.wait_for_selector("#stateText")
        check("the one-time link lands on the panel", page.url.endswith("/panel.html"))
        wait_until(lambda: page.inner_text("#stateText") == "Running", 8)
        check("panel says Farfield is running", page.inner_text("#stateText") == "Running")
        check("panel lists the watched folder", watch in page.inner_text("#folders"))
        check("panel says what it reads and what it doesn't", "does not read your screen" in page.inner_text("body"))
        check("with no company, panel says nothing leaves this computer", "nothing leaves this computer" in page.inner_text("#collectText"))
        second = ctx.new_page(); second.goto(link)
        check("the same link a second time is refused", "already used" in second.inner_text("body")); second.close()

        # --- pause and resume from the panel
        page.click("#pauseBtn"); wait_until(lambda: page.inner_text("#stateText").startswith("Paused"), 5)
        check("pause: panel shows paused and says nothing is read or sent", "Nothing is being read or sent" in page.inner_text("#stateText"))
        page.click("#pauseBtn"); check("resume works", wait_until(lambda: page.inner_text("#stateText") == "Running", 5))
        page.screenshot(path=os.path.join(SHOTS, "panel.png"))

        # --- the dashboard through the shim
        dash = ctx.new_page()
        dash.on("console", lambda m: errors.append("dash: " + m.text) if m.type == "error" else None)
        dash.on("pageerror", lambda e: errors.append("dash pageerror: " + str(e)))
        dash.goto(BASE + "/dashboard.html")
        wait_until(lambda: len(dash.inner_text("body")) > 800, 15)
        txt = dash.inner_text("body")
        check("dashboard renders with the Overview", "Overview" in txt)
        check("dashboard shows the sample company and says it is sample", "ample" in txt)
        check("dashboard has the status pill", "Farfield is running" in txt)
        dash.screenshot(path=os.path.join(SHOTS, "dashboard_overview.png"))
        check("no console errors or CSP violations while loading the dashboard", not errors, str(errors[:4]))

        # --- a live file correction shows up without reloading
        dash.goto(BASE + "/dashboard.html#/trace")                 # the Workflows tab lists each workflow by name
        wait_until(lambda: "Workflow view" in dash.inner_text("body"), 10)
        check("before the edit, the Workflows tab has no 'Q3 review'", "Q3 review" not in dash.inner_text("body"))
        time.sleep(2.5)                                         # first scan done: files from here on are "new"
        put("Q3 review.xlsx", "1_ai_output.xlsx"); time.sleep(4.5)
        put("Q3 review.xlsx", "2_final_deliverable.xlsx")
        check("panel: a correction was recorded", wait_until(lambda: page.inner_text("#foundText").startswith("1 correction"), 20), page.inner_text("#foundText"))
        check("panel: the edit was recorded and shows the file name", "Q3 review.xlsx" in page.inner_text("#latest"))
        check("dashboard: the new workflow appears on the open page without a reload", wait_until(lambda: "Q3 review" in dash.inner_text("body"), 20))
        check("and it is listed as a file correction", "1 file" in dash.inner_text("body").split("Q3 review", 1)[1][:120], dash.inner_text("body").split("Q3 review", 1)[1][:120])
        dash.screenshot(path=os.path.join(SHOTS, "dashboard_live.png"))
        runs = page.evaluate("fetch('/api/storage/get',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-farfield':'1'},body:JSON.stringify({keys:['fileRuns']})}).then(r=>r.json()).then(j=>j.data.fileRuns)")
        live = [r for r in runs if r.get("fileName") == "Q3 review.xlsx"]
        check("the real correction is stored as live, next to the sample rows", len(live) == 1 and live[0].get("source") == "live" and any(r.get("source") == "seed" for r in runs), str(live)[:200])

        # --- a hostile file name is shown as text only
        evil_name = "<img src=x onerror=window.__pwn=1>.xlsx"
        put(evil_name, "1_ai_output.xlsx"); time.sleep(4.5); put(evil_name, "2_final_deliverable.xlsx")
        wait_until(lambda: page.inner_text("#foundText").startswith("2 corrections"), 20)
        check("a hostile file name appears as plain text", "<img src=x" in page.inner_text("#latest"))
        check("and nothing in it ran", page.evaluate("window.__pwn === undefined") and page.locator("#latest img").count() == 0)

        # --- a page on another site cannot do anything
        other = ctx.new_page()
        other.goto(f"http://127.0.0.1:{evil.server_address[1]}/")
        wait_until(lambda: other.evaluate("Object.keys(window.results).length") == 3, 8)
        res = other.evaluate("window.results")
        check("another site cannot send a request with the custom header (blocked by the browser)", res["custom"] == "blocked", str(res))
        check("another site cannot read the data API", res["read"] == "blocked", str(res))
        st = page.evaluate("fetch('/api/agent/status',{credentials:'same-origin'}).then(r=>r.json())")
        check("none of those attempts paused or changed anything", st["paused"] is False)
        # a fresh browser profile has no cookie at all
        c2 = browser.new_context(); p2 = c2.new_page(); r2 = p2.goto(BASE + "/panel.html")
        check("a browser without the cookie gets nothing", r2.status == 401)
        c2.close()
        browser.close()
finally:
    proc.terminate(); evil.shutdown()
    shutil.rmtree(root, ignore_errors=True)

print(f"\n{passed} checks passed, {len(failed)} failed", failed)
sys.exit(1 if failed else 0)
