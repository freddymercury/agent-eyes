---
name: agent-eyes
description: Reads live Chrome page or element captures from AgentEyes (~/.agenteyes/context.md). Use when the user mentions AgentEyes, "the page," "what I'm looking at," "what I just sent," a browser capture, or pointing at a DOM element.
---
# AgentEyes
The user has a local tool called AgentEyes. A Chrome extension captures the current page (or one picked element) and a local server writes it to disk.
Source repo: `~/dev/rsrc/agent-eyes`. Server: `cd ~/dev/rsrc/agent-eyes/server && node server.js` (port 8765). If captures are missing or stale, mention that the server may not be running.
## Where to look
- `~/.agenteyes/context.md` — latest capture, human-readable. Default for "the page" or "what I just sent."
- `~/.agenteyes/context.json` — same data, structured.
- `http://localhost:8765/context` — same JSON over HTTP.
- `~/.agenteyes/captures/` — history only. Check here if the user asks about an earlier send, not by default.
## Freshness
There is no push notification. Check `capturedAt` (or the "captured …" line). Treat the file as possibly stale unless the user just said they sent something. If it looks old relative to the conversation, say so instead of assuming it is the current page.
## Interpreting fields
- `elementPicked` true: one specific element (`tag`, `attrs`, `text`, `outerHTML`). Treat as narrow, scoped context, not a page summary.
- `elementPicked` absent: `text` is the highlighted selection when `usedSelection` is true, otherwise full visible page text.
- `context.md` / `context.json` hold only the latest capture. History lives in `captures/`.
## Do not assume
- A file existing does not mean it is the current page — check the timestamp.
- No screenshots yet — text and DOM only. Charts and canvas content will not be in the capture.
- Missing or clearly stale files usually mean `node server.js` is not running.
