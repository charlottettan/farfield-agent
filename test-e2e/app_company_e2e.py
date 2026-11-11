"""The local app joined to the real backend: join from the panel, a file correction syncs, the dashboard's company view loads through the proxy."""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.environ.get("FARFIELD_BACKEND", os.path.join(os.path.dirname(AGENT), "farfield-backend"))
FIX = os.path.join(AGENT, "test", "fixtures")
SHOTS = os.environ.get("SHOTS", "/tmp/shots_app"); os.makedirs(SHOTS, exist_ok=True)
passed, failed = 0, []
def check(name, cond, info=""):
    global passed
    if cond: passed += 1; print("PASS ", name)
    else: failed.append(name); print("FAIL ", name, info)
def wait_until(fn, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.25)
    return False

PORT = 8811; URL = f"http://127.0.0.1:{PORT}"
db = tempfile.mktemp(suffix=".db")
be = subprocess.Popen(["node", "src/main.ts"], cwd=BACKEND, env={**os.environ, "PORT": str(PORT), "DB_PATH": db, "FARFIELD_BOOTSTRAP_KEY": "k"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try: urllib.request.urlopen(URL + "/healthz", timeout=1); break
    except Exception: time.sleep(0.25)
req = urllib.request.Request(URL + "/v1/admin/orgs", method="POST", headers={"content-type": "application/json", "x-bootstrap-key": "k"}, data=json.dumps({"name": "Test Co", "adminEmail": "boss@test.co", "privacyMode": "full"}).encode())
invite = json.loads(urllib.request.urlopen(req).read())["adminInvite"]

root = tempfile.mkdtemp(prefix="ff-co-"); home, watch = root + "/home", root + "/Downloads"
os.makedirs(home); os.makedirs(watch)
json.dump({"folders": [watch], "depth": 1, "pollSeconds": 1, "baselineDays": 14, "agentName": "AI-generated file", "paused": False}, open(home + "/config.json", "w"))
app = subprocess.Popen(["node", "src/cli.js", "app", "--no-open", "--port", "0"], cwd=AGENT, env={**os.environ, "FARFIELD_HOME": home}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
link = None
for _ in range(80):
    m = re.search(r"(http://127\.0\.0\.1:\d+/\?t=[a-f0-9]+)", app.stdout.readline() or "")
    if m: link = m.group(1); break
BASE = link.split("/?")[0]
def put(n, f, k):
    p = watch + "/" + n; shutil.copy(FIX + "/" + f, p); t = time.time() + k * 60; os.utime(p, (t, t))

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page(); page.goto(link); page.wait_for_selector("#jServer")
        page.fill("#jServer", URL); page.fill("#jCode", invite); page.fill("#jEmail", "boss@test.co")
        page.click("text=Review what is collected")
        check("preview shows the org and the privacy mode before joining", wait_until(lambda: "Joining Test Co" in page.inner_text("#companyView") and "Full" in page.inner_text("#companyView"), 8), page.inner_text("#companyView")[:200])
        join = page.locator("button.primary", has_text="Join")
        check("Join stays disabled until the box is ticked", join.is_disabled())
        page.locator("#companyView input[type=checkbox]").check(); join.click()
        check("after joining, the panel shows the company", wait_until(lambda: "Joined Test Co" in page.inner_text("#companyView"), 8), page.inner_text("#companyView")[:200])
        check("and the collected-data text follows the org's privacy mode", "Full" in page.inner_text("#collectText"))

        time.sleep(2.5); put("Q3 review.xlsx", "1_ai_output.xlsx", 1); time.sleep(4.5); put("Q3 review.xlsx", "2_final_deliverable.xlsx", 2)
        check("the correction is found", wait_until(lambda: page.inner_text("#foundText").startswith("1 correction"), 20))
        check("and everything is sent (nothing waiting)", wait_until(lambda: "Everything has been sent" in page.inner_text("#companyView"), 20), page.inner_text("#companyView")[:200])

        dash = ctx.new_page(); errs = []
        dash.on("pageerror", lambda e: errs.append(str(e))); dash.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        dash.goto(BASE + "/dashboard.html"); wait_until(lambda: "Overview" in dash.inner_text("body"), 15)
        check("the dashboard shows the My data / Company switch once joined", dash.locator("#viewCompany").is_visible())
        dash.click("#viewCompany")
        ok = wait_until(lambda: "Test Co" in dash.inner_text("#companyText"), 15)
        check("company view loads from the real backend through the proxy", ok, dash.inner_text("#companyText")[:200])
        check("and says who you are", "admin" in dash.inner_text("#companyText").lower() or "Administrator" in dash.inner_text("#companyText"), dash.inner_text("#companyText")[:200])
        dash.screenshot(path=os.path.join(SHOTS, "dashboard_company.png"))
        check("no page errors in the company view", not errs, str(errs[:3]))

        def live_changes():
            return page.evaluate("fetch('/api/storage/get',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-farfield':'1'},body:JSON.stringify({keys:['fileRuns']})}).then(r=>r.json()).then(j=>JSON.stringify(j.data.fileRuns.filter(r=>r.source==='live').map(r=>r.changes)))")
        before = live_changes()
        page.click("#pauseBtn"); wait_until(lambda: page.inner_text("#stateText").startswith("Paused"), 5)
        put("Q3 review.xlsx", "3_second_save.xlsx", 3); time.sleep(5)
        check("while paused, a new save is not read", live_changes() == before)
        page.click("#pauseBtn"); wait_until(lambda: page.inner_text("#stateText") == "Running", 5)
        check("after resume, the same save is picked up", wait_until(lambda: live_changes() != before, 15))
        check("and it updated the one record instead of adding another", page.inner_text("#foundText").startswith("1 correction"))
        b.close()
finally:
    app.terminate(); be.terminate(); shutil.rmtree(root, ignore_errors=True)
print(f"\n{passed} checks passed, {len(failed)} failed", failed)
sys.exit(1 if failed else 0)
