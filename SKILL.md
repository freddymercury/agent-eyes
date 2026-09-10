---
name: agent-eyes
description: Look at the user's live Chrome tab via AgentEyes — page and element captures, watchers, interactive-surface scans, snapshots. Also starts the AgentEyes server and its monitoring worker. Use when the user mentions AgentEyes, "the page", "what I'm looking at", "what I just sent", a browser capture, a picked DOM element, watchers, or asks to start/restart the server or worker.
---

# AgentEyes

A Chrome extension captures the user's live tab and POSTs it to a local server
(`127.0.0.1:8765`, loopback only), which writes to `~/.agenteyes/`.

**Paths below assume the repo is at `~/dev/rsrc/agenteyes`** — the only
machine-specific value in this file. If it is cloned elsewhere, adjust the
`cd`/`-c` arguments in §2 accordingly; everything under `~/.agenteyes/` is fixed
by the server and does not move.

## 1. Check state before anything else

```
curl -s -m 3 -o /dev/null -w "server %{http_code}\n" http://localhost:8765/context
lsof -ti :8765 | xargs -r ps -o pid=,ppid=,lstart=,command=
```

- `200` — server up, a capture exists.
- `404` — **server up, nothing captured yet.** Not an error. `latest` is held in
  memory, so a restart empties it while `captures/` on disk stays intact.
- no response — server down. Start it (§2).
- `ppid` of `1` — the server was orphaned by a closed pane. It still works, but
  nobody sees its logs. Restart it into a pane (§2).

## 2. Start the server as a visible worker

Never start it bare in the background — that is how it gets orphaned. Put it in
a pane that owns its lifetime:

```
tmux has-session -t agenteyes 2>/dev/null || \
  tmux new-session -d -s agenteyes -n server -c ~/dev/rsrc/agenteyes/server
tmux send-keys -t agenteyes:server 'bun server.js' Enter
```

Verify it bound, and say so — a silent failure here looks exactly like "nothing
has been captured yet":

```
sleep 2; tmux capture-pane -p -t agenteyes:server | tail -5
```

The user attaches with `tmux attach -t agenteyes`. Kill any orphan holding 8765
first, or the new process fails to bind.

## 3. The monitoring worker (optional)

Nothing wakes an idle agent — not a file changing, not an MCP notification, not
a hook. A session runs only when a message is submitted to it. So if the user
wants to be told when something in `~/.agenteyes/` changes or breaks, a second
agent has to watch and push.

It is a program — `scripts/notifier.ts` — not an agent holding a loop in its
head. Start it in its own pane alongside the server:

```
tmux new-window -t agenteyes -n notifier -c ~/dev/rsrc/agenteyes
tmux send-keys -t agenteyes:notifier 'bun run notify' Enter
```

`bun run notify --dry-run` prints what it would send instead of sending;
`--once` runs a single tick and exits. It writes `~/.agenteyes/notifier.json`
each tick with its pid and `lastTick`, so **check that file to tell "nothing has
happened" from "the notifier is dead"** — the absence it exists to detect
applies to itself.

Rules live in `~/.agenteyes/notify-config.json`, re-read every tick so edits
apply without a restart. Three tiers, each with its own gate:

| tier | events | gate |
|---|---|---|
| `critical` | `serverDown`, `serverRecovered`, `watcherStale` | `criticalCooldownSeconds` |
| `signal` | `newCapture`, `newSurface`, `newSnapshot` | `signalCooldownSeconds` |
| `routine` | `watcherUpdate` | `routineGateSeconds` |

**Tier by who caused it, not by how important it sounds.** Anything the user
pressed a key for is something they are standing there waiting on, so it belongs
in `signal`. `routine` is for events that happen on their own. Getting this
backwards is silent: the notice is queued rather than dropped, so the user sees
nothing, presses the key again, and has no way to tell the difference from a
dead notifier. Check the pane log for `queued … ` lines with no matching
`sent` before concluding anything is broken.

Events fire **on transition, not on state**. A dead server stays dead; reporting
the condition would report it every tick forever. `watcherUpdate` is off by
default — watchers fire every few seconds and would drown everything else.

### Addressing another agent

```
herdr agent list                      # addressable panes, and their state
herdr agent prompt <pane> "<text>"    # submits a prompt — starts a turn there
herdr agent read <pane> --lines 25    # read its terminal
```

Set `target` in the notify config to the pane that should receive alerts. Check
it still exists — `herdr agent list` — before trusting that anything is
listening. A worker that died leaves the config behind, pointing at a target
nobody is watching.

### Four things that govern what can be built here

- **`agent prompt` costs the receiver a full turn** and lands in its transcript
  as if the user typed it. Notify on "something is broken and I would otherwise
  carry on not knowing", never on routine activity.
- **The receiver is not preemptible.** The message arrives instantly and is
  processed when the target's current turn ends — minutes, potentially. Never
  put anything time-critical on this path.
- **The payload is scraped terminal text.** No schema, no types.
- **Delivery is reliable; action is not.** This is a prompt, not an RPC. The
  receiving agent may ignore or misread it.

### Push instead of polling, for pane events

herdr has a socket subscription API — no CLI, so this needs a small client
against `$HERDR_SOCKET_PATH` (`~/.config/herdr/herdr.sock`). Send
`events.subscribe` with a `pane.output_matched`, `pane.agent_status_changed` or
`pane.scroll_changed` subscription and events are pushed as they occur.

`OutputMatch` is `{"type": "substring"|"regex", "value": "…"}` — the field is
**`value`**, not `pattern`. Full schema: `herdr api schema --json`.

This does **not** cover `~/.agenteyes/` — herdr observes terminals, not files.
Watch the filesystem with fs events; use `pane.output_matched` on the target
pane if the worker needs to confirm its message landed.

Beware self-match: a broad pattern will hit the agent's own UI chrome and its
prose about the pattern. Use a sentinel that cannot occur in either.

## 4. Reading captures

Prefer the MCP tools when the `agent-eyes` bridge is connected — they carry
staleness and comparability warnings the raw files do not:

`agent_eyes_get_context`, `agent_eyes_get_staleness`, `agent_eyes_get_text`,
`agent_eyes_list_watchpoints`, `agent_eyes_get_watchpoint`,
`agent_eyes_list_actions`, `agent_eyes_get_surface`, `agent_eyes_save_snapshot`,
`agent_eyes_list_snapshots`, `agent_eyes_get_snapshot`,
`agent_eyes_check_comparable`, `agent_eyes_mark_baseline`,
`agent_eyes_check_watchpoints`, `agent_eyes_diff_snapshots`,
`agent_eyes_invoke_action`.

Falling back to files or HTTP:

| what | file | HTTP |
|---|---|---|
| latest capture | `~/.agenteyes/context.md` / `.json` | `GET /context`, `/context.md` |
| live watchers | `~/.agenteyes/watch/<id>_<label>.json` | `GET /watch` |
| interactive surface | `~/.agenteyes/surface.json` | `GET /surface` |
| saved snapshots | `~/.agenteyes/snapshots/` | `GET /snapshots` |
| capture history | `~/.agenteyes/captures/` | — |

**Watchers beat `context.md`.** A watcher file is rewritten in place whenever its
element changes, so it is current by construction — no staleness check needed.
`context.md` is pull-based and holds only the most recent send. Check `capturedAt`
and say so if it looks old rather than assuming it is the page the user means.
Use `captures/` only when the user references something they sent earlier.

## 5. Interpreting a capture

- `elementPicked: true` — the user pointed at **one element**. `tag`, `attrs`,
  `text`, `outerHTML` describe just that. Narrow, deliberate scope, not a page
  summary.
- `elementPicked` absent — `text` is their selection when `usedSelection` is
  true, otherwise the page's full visible text.
- A watcher's label is the user's own words and is the main signal for what it
  holds. Fall back to content when labels are ambiguous.

## 6. What not to assume

- **A file existing does not mean it is current.** Check the timestamp.
- **Nothing in this system errors loudly.** A stale watcher reads exactly like a
  live one; a stopped server reads as "no captures yet". When something looks
  empty, distinguish "not running" from "nothing sent" before reporting.
- A watcher whose file stops changing usually means the page re-rendered its
  element away. The popup shows a red dot; the user must re-pick it. Not
  repairable from here.
- **No screenshots** — text and DOM only. Charts and canvas content are absent.
