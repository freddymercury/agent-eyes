# AgentEyes

Sends whatever page you're looking at (or just your text selection) straight to a local agent, no copy-paste.

Two modes: **on demand** (press a key, one capture lands) or **watchers** (point
at one or more elements and each re-sends itself every 5 seconds, but only when
its content actually changed).

## 1. Start the server

```
cd server
node server.js
```

No install step — it only uses Node's built-in `http` module. Leave this running in a terminal tab.

## 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select the `extension/` folder
4. Pin it to the toolbar if you want it visible

## 3. Use it

Four ways in, all doing the same two things — send the page, or pick an element:

- **Click the extension icon** — opens a small popup with two buttons: *Send this page* and *Pick an element…*
- **Right-click anywhere on a page** — same two options in the context menu, right where your cursor already is
- **Cmd+Shift+L** (Mac) / **Ctrl+Shift+L** (Win/Linux) — sends the whole page straight away, or just your selection if you've highlighted text
- **Cmd+Shift+K** (Mac) / **Ctrl+Shift+K** (Win/Linux) — jumps straight into picker mode
- **Cmd+Shift+Y** (Mac) / **Ctrl+Shift+Y** (Win/Linux) — pick an element to **watch** continuously

**Picker mode** (from any entry point): hover to highlight whatever's under your cursor — a label shows its tag/id/class — click to send just that element. **Esc** cancels without sending anything.

**Watch mode** (Cmd+Shift+Y): same picker, but the element you click is added to
a watch list and re-sent whenever its text changes. Name it when prompted. Add
as many as you like — a list and a roster, say — and each gets its own file. The
popup shows them all with a **×** to remove one, or "Remove all".

A red dot next to a watcher means its selector stopped matching: the page
re-rendered that element away, so re-pick it. Watchers live in the page, so
closing the tab stops them.

The icon flashes a teal check on success, red `!` if it failed (usually means the server isn't running).

## 4. Reading it from your agent

Whatever you build next can pull the latest page in either form:

- **File on disk** — always the latest capture:
  - `~/.agenteyes/context.json` (structured: title, url, text, capturedAt)
  - `~/.agenteyes/context.md` (markdown, good for just `cat`-ing into a prompt)
- **HTTP** — `GET http://localhost:8765/context` returns the same JSON
- **Watchers** — `~/.agenteyes/watch/<watchId>_<label>.json`, one file per
  active watcher, rewritten in place on every change so each is always current.
  `GET http://localhost:8765/watch` lists what's live. Watchers are deliberately
  *not* added to `captures/` — they fire every few seconds and would flood it.
- **History** — every capture is also kept at `~/.agenteyes/captures/`,
  one file per send, named `<timestamp>_<domain>_<page|element>.md`, so
  sending a new page never erases the last one. Nothing reads from here
  automatically — it's there if you want to grep or `ls` back through what
  you've sent.

Example, from a shell-based agent or script:

```bash
cat ~/.agenteyes/context.md
```

Example, from anything that can do HTTP:

```bash
curl http://localhost:8765/context
```

### Telling the agent about this tool

`AGENTS.md` in this project root explains the bridge to the agent itself —
what the files mean, how to tell if a capture is fresh, how to interpret
`elementPicked`. Many CLI agents (Codex, others) read `AGENTS.md`
automatically if it's in the project. For **Claude Code** specifically, copy
or symlink it to `CLAUDE.md`:

```bash
cp AGENTS.md CLAUDE.md
```

Without this, the agent has no framing for the file — it'll just see raw
text with no idea it's a live capture from your browser.

## Notes / known rough edges

- On-demand captures send nothing until you click or hit a shortcut. Watchers do
  poll, every 5s, but only POST when the watched element's text actually changed.
- The polling interval runs **in the page**, not the service worker — MV3 workers
  are evicted when idle and `chrome.alarms` floors at 30s, too slow to track
  anything live.
- One page (or element) at a time for on-demand captures — sending a new one
  overwrites `context.md` / `context.json`. Watchers each keep their own file
  and don't clobber each other. Every capture is also kept, one file per
  send, in `~/.agenteyes/captures/` if you want to look something up
  later — nothing reads from there automatically.
- Text and structure, no vision — the element picker gives you the target's `outerHTML` alongside its flattened text, but nothing is screenshotted. Good enough for "let the agent read the specific thing I'm pointing at" without pulling in the bigger sensing/tool-building design.
- Runs only on `localhost:8765` — nothing leaves your machine.
