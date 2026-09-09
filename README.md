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
- **Cmd+Shift+U** (Mac) / **Ctrl+Shift+U** (Win/Linux) — **scan** the page's interactive surface

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

### Scanning the interactive surface

**Cmd+Shift+U** inventories what the page appears to let a user do — buttons,
links, form controls, ARIA-interactive elements, and elements that are merely
styled as clickable. Each is reported with the evidence it was detected by and a
confidence score derived from that combination.

Listeners added with `addEventListener` are **not** detectable from an extension
content script, and frameworks delegate handlers at a root node anyway, so
"has a listener" is neither necessary nor sufficient for "is interactive". The
scanner combines semantic, accessibility, focusability and styling signals
instead, and reports which fired so a weak detection can be judged rather than
silently trusted.

| Signal | Weight |
|---|--:|
| native interactive element | 0.75 |
| explicit ARIA role | 0.55 |
| inline handler attribute | 0.35 |
| focusable via tabindex | 0.20 |
| `cursor: pointer` only | 0.15 |

Same-origin iframes are skipped and counted rather than silently omitted. Scans
stop after 20,000 nodes and report `truncated: true` instead of hanging the tab.

### Watchpoints with expectations

A watchpoint asserts what an action did. Pick an element with **Cmd+Shift+Y**,
name it, and say what you expect of it:

- **changes** — this must move when the action runs. An effect that did not
  happen is the usual bug.
- **stable** — this must *not* move. Catches the change nobody asked for, which
  is the kind a test suite normally misses entirely.
- **blank** — observe without asserting.

Choose what to watch: `text`, `structure`, `attributes`, `state`. Only the
aspects you name decide whether it changed, so watching text does not fire
because a class attribute moved. `attributes` and `state` deliberately exclude
`class` and `style` — frameworks rewrite those constantly, and a watchpoint that
fires on every re-render asserts nothing.

```bash
bun run watch baseline   # before the action
bun run watch check      # after it
```

```
  PASS  cart-total  (expects changes)
         changed as expected: text
  FAIL  nav-menu  (expects stable)
         expected no change, but text moved
    ?   sidebar  (observing)
         observed a change in text
```

A watchpoint with no expectation is never a failure — it reports what moved and
passes no judgement. A watchpoint whose element has vanished violates `stable`,
but is `unknown` for `changes`, since whether disappearing counts as changing is
genuinely unclear.

Watchpoints resolve by CSS path first, then fall back to role and accessible
name, so one survives the page re-wrapping the element around it.

Also available over MCP as `agent_eyes_mark_baseline` and
`agent_eyes_check_watchpoints`.

### Diffing snapshots

```bash
bun run diff --list                    # ids and health
bun run diff <before-id> <after-id>
```

Reports added, removed, renamed and changed actions, most prominent first, so a
report leads with a primary control disappearing rather than a footer link
moving. Renames are paired rather than shown as a removal plus an addition —
semantic ids include the label, so without pairing every rename makes a small
change look like a large one.

A diff is always produced. When the snapshots are poorly comparable the warnings
are printed above the counts rather than the diff being withheld: a virtualised
table whose ids are mostly position-dependent is hard to diff and still worth
looking at.

**Known limitation:** inserting one item at the top of a list is reported as many
renames, because rows below it shift. The report is right row-by-row and wrong
as an account of the change.

### Ranking

Each action also records the **landmark** it sits in and a **prominence** score,
and `list_actions` returns the most prominent first.

This is separate from confidence on purpose. Confidence answers *is this
interactive*; a footer link unambiguously is, and keeps a high score. Prominence
answers *does this matter here*. Without it, a scan of a GitHub repository page
answered "Skip to content, Terms, Privacy, Security, Status, Community, Docs" —
correct, and useless. With it: the repository name, Fork, star, Code, Readme.

| landmark | weight |
|---|--:|
| `main` | 1.0 |
| `region` / `form` / `search` | 0.9 |
| no landmark declared | 0.7 |
| `navigation` | 0.5 |
| `banner` | 0.4 |
| `complementary` | 0.3 |
| `contentinfo` | 0.1 |

The landmark reported is the innermost one, but the weight comes from the least
prominent on the chain — a `region` inside a footer is still in the footer.
Generic labels ("Learn more", "Terms") are demoted wherever they appear.

### Action identity

Each action carries an id derived from semantics, never from CSS classes.
Filtering "generated" classes would need a new heuristic per styling framework
(Tailwind utilities, CSS-modules hashes, styled-components), and being wrong is
silent — so classes are simply never consulted.

| strategy | derived from | durability |
|---|---|---|
| `testid` | `data-testid` and friends | survives even a label change |
| `semantic` | role, normalized name, ancestor role path, ordinal | survives restyling and re-wrapping |
| `positional` | DOM path | **expected to churn** — reported so it can be discounted |

Labels are normalized before hashing, so `Cart (3)` and `Cart (12)` are the same
action. Repeated controls are anchored by the row or card they sit in, so three
"Add to cart" buttons are told apart by product rather than by position.

A row or card is found semantically first (`li`, `tr`, `article`, or an ARIA
role), and otherwise **structurally**: the nearest ancestor that is one of three
or more siblings sharing a shape. Shape means tag names, never classes — the
same reason classes are not used for identity. This is what recognises a card in
a `div` grid, a comment in a custom element, and a row in a virtualised table,
none of which use semantic markup.

Ordinals remain as a last resort, and any id that needed one is marked
`ordinalDisambiguated` so it can be discounted.

Changes that *should* alter identity still do: renaming a control, or moving it
into a different landmark, both produce a new id — those are real capability
changes and hiding them would defeat the purpose.

### Measuring churn

```bash
bun run scripts/make-corpus.ts corpus   # fixtures, for a smoke test
bun run churn --corpus corpus           # exits non-zero above a 5% budget
bun run churn before.json after.json    # a single pair
```

The metric is **false churn**: actions that are clearly the same capability yet
got a different id. Raw "ids changed" is not useful, because a release genuinely
adds and removes things.

Fixtures currently report 0%. That is a smoke test, not evidence — **fixtures are
the easy case and will flatter the identity function.** A real corpus means
scans captured from an actual application across actual releases, which is the
only thing that can tell a good identity function from a bad one.

### Saving snapshots

**Save a snapshot…** in the popup names the current surface and stores it. It
rescans first, so a snapshot named for a release describes the page now rather
than whenever someone last pressed the scan shortcut.

Snapshots live on disk at `~/.agenteyes/snapshots/`, not in the extension's
IndexedDB. The consumer that needs them most is the Agent Bridge — a separate
process that already reads this directory — and disk makes export, backup and
version control free.

Each snapshot records **identity health** alongside the actions:

```json
{ "actions": 326, "positionalRate": 0.025, "ordinalRate": 0.859,
  "lowConfidenceRate": 0.586, "truncated": false }
```

That matters because a comparison is only meaningful between snapshots of
similar quality. Diffing a page where 86% of ids depend on document order
against one where 5% do produces noise, and `agent_eyes_check_comparable`
reports why rather than returning a verdict:

```
different completeness: text-only vs dom-actions
ordinal-dependent rate differs sharply: 5% vs 86%
a scan was truncated; its inventory is partial
```

The popup lists saved snapshots with their action count and unstable-id share,
highlighted when a snapshot is shaky enough that a later diff would be
unreliable. **open** shows the saved JSON; **×** moves it to `.trash`, which is
recoverable, so there is no confirmation prompt.

### Resources

Watched elements are exposed as resources with subscriptions, so a harness is
*told* when the surface changed rather than polling for it.

| URI | Contents |
|---|---|
| `agenteyes://context` | URL, title, capture time |
| `agenteyes://watch` | list of active watchpoints |
| `agenteyes://watch/{id}` | one watchpoint's text and freshness |
| `agenteyes://actions` | the most recent interactive-surface scan |
| `agenteyes://snapshots` | saved snapshots, newest first |
| `agenteyes://snapshots/{id}` | one saved snapshot in full |

### Tools

| Tool | Returns |
|---|---|
| `agent_eyes_get_context` | where the observation came from |
| `agent_eyes_get_surface` | normalized snapshot — check `completeness` |
| `agent_eyes_list_actions` | discovered actions, filterable by `minConfidence` |
| `agent_eyes_get_text` | raw extracted text |
| `agent_eyes_list_watchpoints` | active watchpoints |
| `agent_eyes_get_watchpoint` | one watchpoint's state |
| `agent_eyes_save_snapshot` | persist the current surface under a name |
| `agent_eyes_list_snapshots` | saved snapshots with their identity health |
| `agent_eyes_get_snapshot` | one snapshot by id |
| `agent_eyes_check_comparable` | why two snapshots may not be comparable |
| `agent_eyes_get_staleness` | how old the observation is, and whether to trust it |

`get_surface` reports `completeness: "text-only"` until a scan has been taken,
then `"dom-actions"`. An empty `actions` array therefore never has to be guessed
at: with `text-only` it means nothing looked, with `dom-actions` it means nothing
was found. `list_actions` returns an explicit error rather than an empty list
when no scan exists, for the same reason.

### Configuration

| Env var | Default | Meaning |
|---|--:|---|
| `AGENT_EYES_MODE` | `read` | `readwrite` enables the write plane (not implemented yet) |
| `AGENT_EYES_STALE_AFTER` | `30` | seconds before an observation is reported stale |
| `AGENT_EYES_DIR` | `~/.agenteyes` | capture directory; override to run instances side by side |
| `AGENT_EYES_SERVER` | `http://127.0.0.1:8765` | server the bridge writes snapshots through |

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
