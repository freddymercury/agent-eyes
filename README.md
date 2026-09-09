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
`elementPicked`. It is the harness-neutral convention, and most CLI agents
read it automatically when it sits in the project root.

If your agent looks for a different filename, symlink it rather than copying,
so the two can't drift apart:

```bash
ln -s AGENTS.md CLAUDE.md    # or whatever filename your harness expects
```

`CLAUDE.md` ships as exactly that symlink. Point additional names at
`AGENTS.md` the same way; there is only ever one file to edit.

Without this, the agent has no framing for the file — it'll just see raw
text with no idea it's a live capture from your browser.

## Agent Bridge (MCP)

The bridge exposes what the extension sees to any MCP-capable harness, so an
agent can pull the *current* page instead of reading a file written at some
unknown past moment.

```bash
bun install
bun run bridge      # stdio MCP server
```

For Claude Code, `.mcp.json` in this repo already registers it. Other harnesses
take the same command: `bun run bridge/src/index.ts`.

### Resources

Watched elements are exposed as resources with subscriptions, so a harness is
*told* when the surface changed rather than polling for it.

| URI | Contents |
|---|---|
| `agenteyes://context` | URL, title, capture time |
| `agenteyes://watch` | list of active watchpoints |
| `agenteyes://watch/{id}` | one watchpoint's text and freshness |

### Tools

| Tool | Returns |
|---|---|
| `agent_eyes_get_context` | where the observation came from |
| `agent_eyes_get_surface` | normalized snapshot — check `completeness` |
| `agent_eyes_get_text` | raw extracted text |
| `agent_eyes_list_watchpoints` | active watchpoints |
| `agent_eyes_get_watchpoint` | one watchpoint's state |
| `agent_eyes_get_staleness` | how old the observation is, and whether to trust it |

`get_surface` currently reports `completeness: "text-only"`, and its `actions`
array is empty because this build does not inspect actions yet — not because the
page has none. That distinction is the point of the field.

### Configuration

| Env var | Default | Meaning |
|---|--:|---|
| `AGENT_EYES_MODE` | `read` | `readwrite` enables the write plane (not implemented yet) |
| `AGENT_EYES_STALE_AFTER` | `30` | seconds before an observation is reported stale |
| `AGENT_EYES_DIR` | `~/.agenteyes` | capture directory; override to run instances side by side |

In `read` mode write tools are **absent** from the tool list rather than present
and failing — an agent should not be offered a capability it cannot use.

The bridge only ever reads. `~/.agenteyes/` stays a public interface that other
tools read directly, and a test asserts the bridge never mutates it.

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
