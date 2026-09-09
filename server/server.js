// AgentEyes — local server
// No dependencies. Run with: node server.js
//
// Receives the current page/selection from the extension and makes it
// available two ways for whatever agent you point at it:
//   - a file on disk:  ~/.agenteyes/context.json  and  context.md  (always the latest)
//   - an HTTP endpoint: http://localhost:8765/context
//
// Every capture is also appended to ~/.agenteyes/captures/ as its own
// timestamped file, so sending a new page doesn't erase the last one.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 8765;
const DIR = path.join(os.homedir(), ".agenteyes");
const JSON_FILE = path.join(DIR, "context.json");
const MD_FILE = path.join(DIR, "context.md");
const CAPTURES_DIR = path.join(DIR, "captures");
// One file per named watcher, so several watchers on the same page don't
// overwrite each other the way the single context.json does.
const WATCH_DIR = path.join(DIR, "watch");
// Snapshots live on disk rather than in the extension's IndexedDB, which is
// what the technical spec proposed. IndexedDB is reachable only from the
// extension, and the consumer that needs snapshots most is the Agent Bridge —
// a separate process that already reads this directory. Disk also makes
// export, backup and version control free. The cost is that snapshots are no
// longer confined to the browser profile.
const SNAP_DIR = path.join(DIR, "snapshots");
// Latest interactive-surface scan. Overwritten rather than appended: it is a
// current-state file, like context.json, not a history.
const SURFACE_FILE = path.join(DIR, "surface.json");

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
if (!fs.existsSync(CAPTURES_DIR)) fs.mkdirSync(CAPTURES_DIR, { recursive: true });
if (!fs.existsSync(WATCH_DIR)) fs.mkdirSync(WATCH_DIR, { recursive: true });
if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

let latest = null;
const watchers = new Map();

function slug(str) {
  return String(str || "watcher").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "watcher";
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

// Filesystem-safe timestamp: 2026-08-23T14-32-01
function safeTimestamp(iso) {
  return iso.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
}

function toMarkdown(data) {
  if (data.elementPicked) {
    return [
      `# ${data.title}`,
      ``,
      `- **url:** ${data.url}`,
      `- **captured:** ${data.capturedAt}`,
      `- **picked element:** \`<${data.tag}>\``,
      ``,
      `## Text`,
      ``,
      data.text,
      ``,
      `## outerHTML`,
      ``,
      "```html",
      data.outerHTML,
      "```",
      ``
    ].join("\n");
  }
  return [
    `# ${data.title}`,
    ``,
    `- **url:** ${data.url}`,
    `- **captured:** ${data.capturedAt}`,
    data.usedSelection ? `- **scope:** selection only` : `- **scope:** full page`,
    ``,
    `## Text`,
    ``,
    data.text,
    ``
  ].join("\n");
}

function snapshotPath(id) {
  // Ids are generated here, never taken from the request, so a crafted id
  // cannot escape the directory.
  return path.join(SNAP_DIR, `${id}.json`);
}

function listSnapshots() {
  return fs
    .readdirSync(SNAP_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), "utf8")).meta;
      } catch {
        return null; // a half-written file should not break the listing
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function writeSurface(data) {
  fs.writeFileSync(SURFACE_FILE, JSON.stringify(data, null, 2), "utf8");
}

function writeWatcher(data) {
  // Named watchers get their own stable file and are *not* appended to the
  // capture history — they fire every few seconds and would flood it.
  const name = `${data.watchId}_${slug(data.label)}`;
  watchers.set(data.watchId, data);
  fs.writeFileSync(path.join(WATCH_DIR, `${name}.json`), JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(path.join(WATCH_DIR, "latest.json"), JSON.stringify(data, null, 2), "utf8");
}

function writeFiles(data) {
  const md = toMarkdown(data);

  // Always-latest files — unchanged behavior, still the simple path for
  // anything that just wants "what did the user just send."
  fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(MD_FILE, md, "utf8");

  // Append-only history — one file per capture, never overwritten.
  const domain = domainFromUrl(data.url);
  const stamp = safeTimestamp(data.capturedAt);
  const kind = data.elementPicked ? "element" : "page";
  const filename = `${stamp}_${domain}_${kind}.md`;
  fs.writeFileSync(path.join(CAPTURES_DIR, filename), md, "utf8");
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, {
    "Content-Type": contentType,
    // Extension background pages send fetches with an origin the server
    // should just accept — this is a single-user localhost tool.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "POST" && req.url === "/context") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        latest = data;
        if (data.kind === "surface") {
          writeSurface(data);
          const st = data.stats || {};
          console.log(
            `[agenteyes] surface scan: ${st.actionsFound} actions, ` +
              `${st.nodesVisited} nodes, ${st.durationMs}ms` +
              (st.truncated ? " (TRUNCATED)" : "")
          );
        } else if (data.watchId) {
          writeWatcher(data);
          console.log(`[agenteyes] watch ${data.watchId} "${data.label}" (${data.text.length} chars)`);
        } else {
          writeFiles(data);
          console.log(`[agenteyes] received: ${data.title} (${data.text.length} chars)`);
        }
        send(res, 200, JSON.stringify({ ok: true }));
      } catch (err) {
        send(res, 400, JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/context") {
    if (!latest) return send(res, 404, JSON.stringify({ ok: false, error: "no page sent yet" }));
    return send(res, 200, JSON.stringify(latest));
  }

  if (req.method === "POST" && req.url === "/snapshot") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!data || !data.snapshot || !data.meta) {
          return send(res, 400, JSON.stringify({ ok: false, error: "expected { meta, snapshot }" }));
        }
        const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
        const stored = { schemaVersion: 1, meta: { ...data.meta, id, createdAt: new Date().toISOString() }, snapshot: data.snapshot };
        fs.writeFileSync(snapshotPath(id), JSON.stringify(stored, null, 2), "utf8");
        console.log(`[agenteyes] snapshot saved: ${stored.meta.name} (${id}) — ${stored.meta.health?.actions ?? "?"} actions`);
        send(res, 200, JSON.stringify({ ok: true, id, meta: stored.meta }));
      } catch (err) {
        send(res, 400, JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/snapshots") {
    return send(res, 200, JSON.stringify({ ok: true, snapshots: listSnapshots() }));
  }

  if (req.url && req.url.startsWith("/snapshot/")) {
    const id = decodeURIComponent(req.url.slice("/snapshot/".length));
    // Reject anything that is not a plain id, so no request can traverse out.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return send(res, 400, JSON.stringify({ ok: false, error: "bad id" }));
    }
    const file = snapshotPath(id);
    if (!fs.existsSync(file)) return send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
    if (req.method === "GET") return send(res, 200, fs.readFileSync(file, "utf8"));
    if (req.method === "DELETE") {
      fs.unlinkSync(file);
      console.log(`[agenteyes] snapshot deleted: ${id}`);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
  }

  if (req.method === "GET" && req.url === "/surface") {
    if (!fs.existsSync(SURFACE_FILE)) {
      return send(res, 404, JSON.stringify({ ok: false, error: "no surface scan yet" }));
    }
    return send(res, 200, fs.readFileSync(SURFACE_FILE, "utf8"));
  }

  if (req.method === "GET" && req.url === "/watch") {
    return send(res, 200, JSON.stringify({
      ok: true,
      watchers: Array.from(watchers.values()).map((w) => ({
        watchId: w.watchId, label: w.label, selector: w.selector,
        capturedAt: w.capturedAt, chars: (w.text || "").length
      }))
    }));
  }

  if (req.method === "GET" && req.url === "/context.md") {
    if (!fs.existsSync(MD_FILE)) return send(res, 404, "no page sent yet", "text/markdown");
    return send(res, 200, fs.readFileSync(MD_FILE, "utf8"), "text/markdown");
  }

  if (req.method === "GET" && req.url === "/") {
    return send(
      res,
      200,
      JSON.stringify({
        status: "running",
        endpoints: [
          "POST /context", "GET /context", "GET /context.md", "GET /watch", "GET /surface",
          "POST /snapshot", "GET /snapshots", "GET /snapshot/:id", "DELETE /snapshot/:id",
        ],
        file: JSON_FILE,
        capturesDir: CAPTURES_DIR
      })
    );
  }

  send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`[agenteyes] listening on http://localhost:${PORT}`);
  console.log(`[agenteyes] writing to ${JSON_FILE}`);
  console.log(`[agenteyes] history in ${CAPTURES_DIR}`);
  console.log(`[agenteyes] watchers in ${WATCH_DIR}`);
  console.log(`[agenteyes] snapshots in ${SNAP_DIR}`);
});
