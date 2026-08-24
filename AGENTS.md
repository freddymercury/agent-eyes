# AgentEyes — instructions for the agent reading this

The user has a local tool called AgentEyes. It lets them send you the page
they're currently looking at in Chrome — or one specific element they've pointed
at — without copy-pasting it into the conversation.

## How it works, briefly

A Chrome extension runs in their browser. When they click its icon, right-click
on a page, or use a keyboard shortcut, it captures either the whole page's text
or one specific DOM element and sends it to a small local server. That server
writes the capture to disk.

## Where to look

- `~/.agenteyes/context.md` — human-readable: title, url, captured
  timestamp, then the content. Always the **most recent** capture.
- `~/.agenteyes/context.json` — same data, structured.
- `http://localhost:8765/context` — same data over HTTP, if that's more
  convenient than reading the file.
- `~/.agenteyes/captures/` — every past capture, one file per send,
  never overwritten. Only check here if the user asks about something they
  sent earlier, not by default — for "the page" or "what I just sent," use
  `context.md`.

Read `context.md` (or the JSON, if you need the structured fields) whenever
the user references "the page," "what I'm looking at," "what I just sent," or
similar — that's your cue to check it rather than ask them to paste it.

## How to know if it's actually fresh

There is no push notification — nothing tells you a new capture has arrived.
Check the `capturedAt` field (or the "captured …" line in the .txt file) and
treat it as *possibly stale* unless the user has just told you they sent
something. If it looks old relative to the conversation, say so rather than
assuming it's the page they mean right now.

## Interpreting the fields

- If `elementPicked` is `true`: the user pointed at **one specific element**,
  not the whole page. `tag`, `attrs`, `text`, and `outerHTML` describe just
  that element — treat it as narrow, deliberately scoped context, not a
  summary of the page.
- If `elementPicked` is absent: `text` is either their highlighted selection
  (when `usedSelection` is `true`) or the full visible text of the page.
- Only **one** capture is reflected in `context.md`/`context.json` at a
  time — a new send overwrites those. Past captures aren't lost, though:
  they're kept in `captures/`, so if the user references something earlier
  in the conversation, it's fine to check there rather than assuming it's
  gone.

## What not to assume

- Don't assume you have the current page just because a file exists — check
  the timestamp.
- No screenshots or images yet — text and DOM structure only. If something on
  the page is purely visual (a chart, canvas content), the capture won't
  reflect it.
- If the file is missing or clearly stale, the likely cause is that the local
  server (`node server.js`) isn't running — mention that possibility rather
  than guessing at page content.

This is a rough, personal tool under active iteration — behavior may change
as it's extended (e.g. screenshots may be added later).
