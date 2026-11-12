# Farfield desktop agent (v0.8.0, prototype)

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
- **First real result (a Mac, the Gemini app):** the window title and permission checks worked. The first, slow reader took 38 seconds for about 800 items and found only a sidebar of chats and buttons: no "You" or "Gemini" labels, so 0 messages. A faster native reader failed on that Mac ("Ref has incompatible type") and is opt-in only. The Gemini Mac app showed only its sidebar (an outline of chats) and buttons: its conversation is not exposed to accessibility, at least not to this method. `screen shape` prints a window's structure without its long text so it can be shared safely.
- **Claude desktop app (a Mac):** with nothing special it returned an empty shell. With VoiceOver on, two web areas appeared but only a heading and the page title came through, no message text. That suggests Chrome-based apps build their accessibility tree only when asked. `--enable-accessibility` on `screen dump` asks the app to build it (as VoiceOver does), but it has not yet been confirmed to work and it changes the other app's state until it is quit.
- **Asking the app to build its tree works:** on a real Mac, macOS accepted `AXManualAccessibility` and `AXEnhancedUserInterface` on the Claude app. Whether that makes a chat's messages readable is not yet known, because the window tested turned out to be a coding session, not a chat.
- **Chrome (a Mac):** the first test read the wrong window (Chrome had 4, and the first one was an untitled helper with no content), so it found nothing. Window choice now prefers the main, titled window with content. Chrome accepted `AXEnhancedUserInterface`; `AXManualAccessibility` is not supported there. Whether Chrome then exposes a chat's messages is not yet known.
- **Safari (a Mac):** the title was `... - Google Gemini`, which the matcher did not know (fixed). The read looked at only 2 items and kept none, because only items with text were kept. It now keeps the top levels of structure and records any errors the window gives, so the next run shows what those 2 items are.
- **Safari (a Mac), second run:** the page is exposed: a web area, the Gemini sidebar links, and a heading that is probably the start of the conversation. The slow reader (System Events) was refused five times ("Can't get object") before reaching the messages. A native reader, `src/screen/ax.swift`, calls the Accessibility API directly and also reads the page's own element ids and class names. Try it with `--engine native`. It is compiled once with Swift (from Apple's command line tools) into `~/.farfield-agent/bin`. It has never been compiled or run. Shipping it to employees would mean a signed program.
- **Native reader, first compile attempt (a Mac):** the compile failed, and the part of the error that was shown looked like the Swift standard library being rebuilt, which usually means Apple's command line tools do not match the macOS version. The error report now shows the compiler's own error lines, recognises that case with advice, and saves the full output to `~/.farfield-agent/bin/compile.log`.
- **Native reader, the cause (a Mac):** the compiler was Swift 6.3.3 while the SDK in the command line tools was built with Swift 6.4, so it could not read Apple's own system files and never reached `ax.swift` (so whether `ax.swift` compiles is still unknown). Farfield now retries with the older SDKs installed in the same folder (newest first, never the one that was refused), and otherwise says to install a Command Line Tools update.
- **First conversation read on a real Mac (Safari + gemini.google.com):** the native reader exposed the whole page structure. Gemini marks your messages with a heading of class `screen-reader-user-query-label` ("You said") and `query-text-line` groups, its replies with a group whose id starts `model-response-message-content`, and the draft box with `ql-editor`. `src/screen/adapters/gemini.js` reads a conversation from those markers (tested against a structure copied from the real dump, with invented wording). Messages scrolled out of view came back with empty text, so only what is on screen is read. Whether Chrome and Firefox expose the same markers is not known yet. Other tools (Claude, ChatGPT, Copilot) have no adapter yet.
- **The native reader reads the web page only,** not the browser's tab bar, address bar or favourites (a whole-window dump included every open tab's title). `--scope window` reads the whole window.
- **To try it:** `node src/cli.js screen build` (once; compiles `ax.swift`, retrying older SDKs if needed), `node src/cli.js screen dump --delay 5` with the Gemini chat in front (it should report the messages it found, by `adapter:gemini`), then `screen on --agree` and `node src/cli.js app`.
- **Chrome + claude.ai (a Mac):** the native reader exposed the page (767 items in 3.5 seconds, the right window picked out of four) even though both accessibility requests reported failures. Claude puts every message inside one flat "Chat messages" group (no nesting), each starting with a "Message N of M" item; who said it comes from a hidden heading ("You said:" / "Claude responded:", wording inferred from a masked dump) or, failing that, the `group/bubble` (you) and `group/message-row` (Claude) classes. `src/screen/adapters/claude.js` splits by those markers and drops the status line, time labels and buttons. Not yet run live. The draft box is outside the list, so it is never read.
- **Long chats (a Mac, Chrome + claude.ai):** on a long conversation the first run read 800 items and stopped in the sidebar, before the messages (the read itself took 0.4 seconds, so the limit was far too low). The reader can now jump to a labelled element and read only the end of its children: for Claude it goes to "Chat messages" and keeps the last 1500 items, so a very long chat costs the same as a short one. The first message in that part may be cut off mid-way; it is ignored until the next "Message N of M" marker. Size limits are now 6000 items for `screen dump` and the watcher. If the label is not found it reads the whole page from the top and says so.
- **Two tools, one dashboard:** every captured chat used to be labelled "Unassigned workflow", so a Gemini chat and a Claude chat merged into one row. Each tool now gets its own ("Gemini chat", "Claude chat"). The watcher only reads the window in front, and only its active tab, so the chat has to stay visible for a few seconds after a message is sent. `screen log` prints the last 40 looks (when, which tool, how many messages were on screen, how many were new, how many counted; never message text or titles) so a missing capture can be explained. The panel shows the same for the last look.
- **`screen log` is more explicit:** each entry shows its time span, the front app by name, and a pattern of the window title (AI tool, browser and common app names kept, every other word masked, so `Xxxxx - Claude - Google Chrome - Xx` shows the format without the content). The header says whether chat reading is on, and how long ago the last look was, and asks if `app` is still running when nothing has been logged for a while.
- **Chrome status notices in titles (found with `screen log`):** a heavy tab's window title is `... - Claude - High memory usage - 1.9 GB - Google Chrome - Charlotte (Person 1)` (the notice's wording is inferred from a masked pattern, `Xxxx xxxxxx xxxxx - 9.9 Xx`). After the browser name and profile, trailing notices (`High memory usage - <size>`, plus the unseen `Audio playing`, `Camera recording`, `Microphone recording`) are removed before matching. Before this, a long Claude chat in Chrome was never recognised, because the title no longer ended in "Claude".
- **Chrome window titles:** Chrome appends its own name and the profile (`... - Claude - Google Chrome - Charlotte (Person 1)`), so the browser tail is removed before matching. Whether Chrome exposes the same page structure as Safari is being tested.
- **Hidden characters in titles:** Gemini's page name starts with an invisible direction mark, so window titles are cleaned (invisible characters removed, non-breaking spaces turned into spaces) before matching. A title that still does not match is printed with hidden characters spelled out.
- **Saved dumps keep structure only** by default (`--keep-text` saves the raw text). `screen forget` deletes them.
- **Step one on a real machine:** open a test chat (nothing private) and run `node src/cli.js screen dump --delay 5`, then switch to the chat window. It saves what Farfield can see to `dumps/` and prints what it understood. Send that file and the fitting can be done properly.

**How it tells a correction from a new request.** See `src/screen/classify.js`. It is a scoring rule that gives reasons for every decision, not a model. On made-up finance chats it scored 33 of 33 on the set it was tuned on, which means nothing, and 12 of 16 on a second set written afterwards, finding 3 of 6 real corrections and wrongly flagging none. It misses corrections that do not reuse the AI's words (for example "Too many acronyms, spell them out"), so rework is more likely to be under-counted than over-counted. Real accuracy is unknown until it is checked on real, labelled chats.

## Keeping a chat together (restarts, long chats, scrolling)
The watcher recognises a chat in three ways, strongest first: messages on screen that it has seen before (matched by a **salted one-way fingerprint**, never by text), a fingerprint of the chat's **title**, or neither (a new chat). It remembers only fingerprints, counts and times, kept on this computer, so a restarted watcher still recognises a chat it knew, even when the first message has scrolled out of view. `screen forget --memory` clears that memory. Limits: 400 fingerprints per chat, 30 chats, nothing older than a week.
Whether a message is a **first prompt** (never counted as a re-prompt): when the page numbers its messages (Claude: "Message 3 of 8") message 1 is; otherwise the first message of a chat it has never seen, unless a reply comes before it on screen (then the chat began earlier). With no earlier message to compare against, the classifier relies on the message's own wording only, and a weak cue alone is not counted.
Not solved: Gemini does not number its messages, so a chat the watcher has never seen, whose top-of-screen message is the person's own, is still treated as new.

## Naming and grouping workflows
Every task in a chat (a chat with two tasks gives two) becomes a workflow, named from the message that started it. `node src/cli.js screen naming <task|tool|first-prompt>` chooses how:
- **task (default):** the kind of task it opened with: Summary, Email draft, Spreadsheet help, Slides, Code, Job application, Social post or announcement, Memo or report, Compliance writing, Meeting prep, Research and analysis, Editing, Brainstorming, Advice and decisions, Planning. Only the label is kept, never the message, and the same kind of task lands in one workflow across tools. Once chats are synced to a company, that is what lets Farfield say "several people made the same correction on summaries". It is a keyword rule (`src/screen/task.js`), checked only on made-up prompts (23 of 23, but written together with the rules, so that figure is optimistic); an unrecognised task is named "<Tool> chat (unsorted)", so a catch-all is never mistaken for a real group.
- **tool:** "<Tool> chat" for every task, on purpose. Nothing groups across tools.
- **first-prompt:** the opening line of the task, masked or not according to the privacy mode (a mode that keeps no wording falls back to the task label). More descriptive, but chats rarely group, and the opening line is kept (masked redaction is a heuristic and misses lowercase names).
A new task started inside an existing chat gets its own workflow and is never counted as a re-prompt. That covers a request that says so ("Separately, draft an email...") and one that asks for a new piece of work of a different kind ("Great. Now draft an email to the board" in a summary chat starts "Email draft"). Fixes to the AI's answer ("that's wrong", "make it shorter", "can you make it less formal?", "that throws a TypeError") are re-prompts in the task they fix, and more work on the same task that points at the output ("write a test for this function") is neither. A chat that began before the watcher saw it has no known start, so it is "<Tool> chat (unsorted)".
On the dashboard's Workflows tab, each row says how its chats were grouped (by kind of task, by tool, by name, or unsorted), and an unsorted row can be split and each chat renamed or merged. A change of setting applies to tasks started afterwards.
Tested against the real backend: two people's chats about the same kind of task arrive as one workflow with two people.

## Reading Gmail drafts (edits to AI-written emails) — prototype, first real-Mac run passed
Off by default, and separate from chat reading. `node src/cli.js screen email on --agree` turns it on (chat reading must be on too). After changing `ax.swift`, run `screen build` again.

How it works (`src/screen/email.js`, `src/screen/adapters/gmail.js`):
1. While chat reading is on, each AI reply seen in a chat is held **in memory only** (the last 20, for 3 hours). Never written to disk.
2. When Gmail is the window in front, the native reader jumps to the box labelled "Message Body" and reads only inside it (`--focus-only`). If there is no draft box, it reads nothing. The inbox, thread, recipients and subject are never read. Gmail's quoted earlier email (`gmail_quote`) and signature (`gmail_signature`) are skipped.
3. A draft is followed only if it clearly comes from one of those AI replies (at least 6 three-word phrases in common, and at least a quarter of the draft). Anything else is dropped at once. The "AI version" is only the part of the reply the draft was built from (a reply with a preamble and three options is cut to the option used).
4. When the draft box goes away, or after 3 minutes unseen (so an email sent just before switching to another window is still recorded soon), the last version is compared with the AI version (the Word comparison) and saved as one correction with surface `Gmail` and workflow "Email draft", in the chat reading's storage mode. It appears on the dashboard like the extension's Gmail corrections. A draft seen again after that is followed again and its record updated in place (same id and start time), so one email is never counted twice.
5. On the dashboard, the workflow's page (Workflows tab, "Email draft") has an "Edits to the email before sending" section with each edit, what the AI wrote against what was sent, and a notice while a draft is being followed and not yet recorded. The workflow list shows "1 Gmail edit". Email edits are also in the Fixes tab.

First real run (a Mac, Chrome, a Google Workspace school account, claude.ai): Claude drafted an email, it was pasted into a Gmail draft, edited and closed, and one Gmail correction was recorded. What that run found and fixed:
- Workspace accounts' tab titles end in "<Org> Mail", not "Gmail". Any "<address> - ... Mail" title now counts as Gmail (Yahoo, AOL, Outlook and similar excluded). Yahoo Mail is its own entry, not yet tried.
- Gmail's draft box is exposed with the label "Message Body" (confirmed). With a reply box and a new-email pop-up both open, the one being typed in is read first, and each box is told apart by its page id (`:qk`), so closing one is noticed even when another stays open.
- Claude can put a drafted email in an email card (Subject field, body text box, "Open in Mail"). Its text box is now part of Claude's reply; before, only the line around it was kept and no draft could link.
- `screen dump --email` ignored `--delay`; fixed. `screen log` now explains, in numbers only, why a draft was not linked.
Not verified yet: the `gmail_quote` / `gmail_signature` classes on a real reply; Yahoo Mail; ChatGPT and Gemini replies feeding email matching. Check a draft box with `node src/cli.js screen dump --email --delay 5`.
Known gaps: it cannot tell a sent email from a discarded one; edits in the last few seconds before sending can be missed (it looks about every 10 seconds); when several draft boxes are open, the one being typed in is read (otherwise the first one); the AI text has to be seen in a chat on this computer first (Gmail's own "Help me write" is not matched); it needs the native Mac reader (refused on Windows and with the slow reader, so it never falls back to reading the whole page).

## Starting it, and what "continuous" means
- **Start:** double-click `Start Farfield.command` (it opens Terminal and runs `node src/cli.js app`), or run that command yourself. It uses Terminal's Accessibility permission, which is why it is started from Terminal and not as a hidden background program (a background program would need its own permission, and a signed app, which does not exist yet).
- **It is continuous while it runs.** Every few seconds it looks at the window in front; a new chat is picked up on its own, so nothing needs restarting for a new chat. Restart it only after installing an update, after a reboot, or after closing its Terminal window. A Mac that is asleep captures nothing.
- **Start at login:** add `Start Farfield.command` under System Settings > General > Login Items (the exact menu wording may differ by macOS version; it has not been tried).
- **What it can and cannot see:** only the window in front and only its visible tab (not background tabs or windows), and only about every 10 seconds. A message needs to be on screen for a few seconds to be caught. First prompts are never saved; follow-ups are.

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
- **Email: Gmail (including Workspace) and Yahoo Mail drafts, off by default, one successful real-Mac run with Claude** (see "Reading Gmail drafts" above). No Outlook, Apple Mail or Windows. The Chrome extension also captures Gmail, so the same email can be counted twice if both are on.
- **No installer, auto-start, code signing or tray icon.** You start it from a terminal. The running indicator and pause button exist on the page, but only while that page is open.
- **The page must be opened from the terminal link.** It works once. Closing the terminal stops the agent.
- `data.json` holds the changed cell text as plain JSON on disk, as the extension does in Chrome storage. It is not encrypted.
- It checks folders every 5 seconds. A save is noticed within roughly 10 to 15 seconds.

## Security
See `SECURITY_CONTROLS.md` for where each security control stands.
