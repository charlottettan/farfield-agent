# Farfield desktop agent (v0.3.2, prototype)

Watches the folders you choose for new Excel, Word and PowerPoint files. When a new file appears, it keeps a private
copy as the "AI version". When the file is later saved with changes, it records what changed. If you have joined a
company, the changes are sent to that company's Farfield server, with the company's privacy mode applied first.

It reuses the browser extension's own file-comparison and sync code (`vendor/`), so both behave the same way.

## What it reads, and what it doesn't
- Reads: `.xlsx`, `.xlsm`, `.docx`, `.pptx` files in the folders you add, and only files that appeared **after** the agent started.
- Does not: read the screen, log keystrokes, take screenshots, or open anything outside the chosen folders.
- Skips: Office lock files (`~$...`), `.tmp` files, hidden files, files over 50 MB, older `.xls/.doc/.ppt`.

## The Farfield app (a local page, no Chrome extension)
`node src/cli.js app` starts watching and opens a page in your normal browser (Safari, Edge, Chrome, Firefox):
- **Panel** (`/panel.html`): a "Farfield is running / paused" indicator, a Pause button, the folders it reads (add or remove), what it has found (file names and counts only), join or leave a company, and a plain-language "what is collected" statement.
- **Dashboard** (`/dashboard.html`): the same Overview, Workflows, Fixes and Implementation views as the extension, running as a web page. A small status pill (Pause, link to the panel) stays visible on every page. A new file correction appears in the open page within a few seconds. The first run adds the sample company so the dashboard is not empty; real corrections sit next to it and are never sent to a company.
- A brand-new company with one real correction shows "not enough history yet". To demo a populated company view, join a backend org created with its synthetic seed.

How the local page is protected (it only listens on 127.0.0.1, but any website you visit can try to reach it):
- The link printed in the terminal works **once**, then is swapped for an HttpOnly, SameSite=Strict session cookie. Nothing is served without it.
- Requests with a foreign Host header are refused (DNS rebinding). Anything that changes data needs a custom header and a matching Origin, and the server never answers CORS preflights, so another site's request is blocked by the browser.
- Only the app's own files are served (an allow-list), never the data file. Strict content security policy. File names are shown as text only.
- The proxy to the company server only reaches the address of the company you joined.
- Tested in real Chromium, including a page on another local port attacking it. Not yet tested in Safari or Edge.

The dashboard files are copies of the extension's. `scripts/sync-from-extension.sh <extension folder>` refreshes them. The sample data comes from the extension's own `background.js`, run in a sandbox, so there is no second copy to drift.

## Reading AI chat windows (re-prompts without the extension) — prototype
Off by default. `node src/cli.js screen on --agree` turns it on. While it is on, every few seconds Farfield asks the operating system **only** for the front window's app and title. If that is an allowed AI chat (ChatGPT, Claude, Gemini, Copilot), it then reads that window's text. Any other window is never read (tested). It does not take screenshots, record keystrokes, or keep unsent text or window titles.

What it produces: the same records as the browser extension. Each task in a chat becomes its own session, and each follow-up that is a correction becomes a re-prompt, shown on the dashboard. Questions, "also add...", new requests and thanks are not counted as rework. The wording is kept masked by default (`screen.storeMode` in `config.json`: `redacted`, `full` or `off`).

**What is verified and what is not**
- Verified here (56 tests): which windows are allowed, extracting who said what from labelled text, ignoring unsent drafts, splitting one chat into tasks, not double-counting, redaction, and never reading a window that is not allowed.
- **Not verified: the part that talks to macOS and Windows** (`src/screen/probe.js`). It was written from the platform documentation and has never run on a real machine. Chrome may only expose page text when its accessibility support is on (`chrome://accessibility`).
- **Not verified: that real ChatGPT, Claude, Gemini or Copilot pages show "You" and the tool's name as labels.** The turn reader depends on that. If a page does not, it finds nothing rather than guessing.
- **First real result (a Mac, the Gemini app):** the window title and permission checks worked. The first, slow reader took 38 seconds for about 800 items and found only a sidebar of chats and buttons: no "You" or "Gemini" labels, so 0 messages. A faster native reader is in 0.3.2 but has not run on a real Mac yet. `screen shape` prints a window's structure without its long text so it can be shared safely.
- **Step one on a real machine:** open a test chat (nothing private) and run `node src/cli.js screen dump --delay 5`, then switch to the chat window. It saves what Farfield can see to `dumps/` and prints what it understood. Send that file and the fitting can be done properly.

**How it tells a correction from a new request.** See `src/screen/classify.js`. It is a scoring rule that gives reasons for every decision, not a model. On made-up finance chats it scored 33 of 33 on the set it was tuned on, which means nothing, and 12 of 16 on a second set written afterwards, finding 3 of 6 real corrections and wrongly flagging none. It misses corrections that do not reuse the AI's words (for example "Too many acronyms, spell them out"), so rework is more likely to be under-counted than over-counted. Real accuracy is unknown until it is checked on real, labelled chats.

## Try it on Windows (PowerShell)
1. Install Node.js 22 or newer. No other installs are needed.
2. Unzip this folder, then in PowerShell: `cd` into it.
3. Choose a folder to watch: `node src\cli.js watch add "$env:USERPROFILE\Downloads"`
4. (Optional) join your test company. It first shows what is collected, then asks you to repeat with `--agree`:
   `node src\cli.js join --server http://127.0.0.1:8787 --code YOUR-CODE --email you@company.com`
5. Start it and leave the window open: `node src\cli.js run`
6. In your browser, have an AI tool produce an Excel file and download it. Wait about 15 seconds.
7. Open the file in Excel, change a few cells, and **save**. Wait about 15 seconds.
8. In a second PowerShell window: `node src\cli.js status`. You should see one file `tracking`, `recorded.count` of 1 once you have saved a change, and, if joined, nothing pending.

To use the browser app instead of `run`: `node src\cli.js app` and open the link it prints.
Other commands: `watch list|remove`, `scan`, `pause`, `resume`, `leave [--delete-data]`, `where`.
Settings and records live in `%APPDATA%\Farfield` (`config.json`, `data.json`, `baselines\`).

## Tests
`npm test` runs 56 tests: 53 on their own and 3 that start the real backend (these skip unless the `farfield-backend` folder sits next to this one, or `FARFIELD_BACKEND` points at it).
Browser tests (need Python Playwright with Chromium): `python3 test-e2e/app_e2e.py` (24 checks) and `python3 test-e2e/app_company_e2e.py` (13 checks, starts the backend).

## Known limits (be honest about these)
- **Tested only on Linux so far.** Windows file locking, OneDrive-synced folders, and Excel's save behaviour are unverified.
- **Moving or renaming a file out of a watched folder loses it.** The moved file looks new, so its first version is taken as the baseline.
- **A new file in a watched folder is assumed to be AI output.** Any xlsx/docx/pptx that lands there is followed.
- **Edits made inside an AI feature (Copilot in Excel, for example) are not seen.** Only saved files are compared.
- **Re-prompts are captured from the screen only if you turn that on, and that part has not run on a real machine** (see above). The browser extension is still the tested way to capture them.
- **No Outlook or email drafts.**
- **No installer, auto-start, code signing or tray icon.** You start it from a terminal. The running indicator and pause button exist on the page, but only while that page is open.
- **The page must be opened from the terminal link.** It works once. Closing the terminal stops the agent.
- `data.json` holds the changed cell text as plain JSON on disk, as the extension does in Chrome storage. It is not encrypted.
- It checks folders every 5 seconds. A save is noticed within roughly 10 to 15 seconds.

## Security
See `SECURITY_CONTROLS.md` for where each security control stands.
