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

A second agent can watch the server and push notifications instead of the user
polling. Rules live in `~/.agenteyes/notify-config.json`, re-read every tick, so
edits apply without a restart. It distinguishes **critical** (server down,
watcher not alive, server errors) from **routine** (new snapshot, stale watcher),
each with its own gate.

Start it in its own pane and address it with herdr:

```
herdr agent list                      # find the pane
herdr agent prompt <id> "<message>"   # send it work
herdr agent read <id>                 # read its output
```

Set `target` in the notify config to the pane that should receive alerts.

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
