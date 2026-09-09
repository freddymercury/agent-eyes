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
// Loopback only. listen(PORT) with no host binds every interface, which put
// every capture and snapshot on the local network — readable, writable and
// deletable by anyone sharing the wifi.
const HOST = process.env.AGENT_EYES_HOST || "127.0.0.1";
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
const TRASH_DIR = path.join(DIR, "snapshots", ".trash");
// The hashes each watchpoint had when the baseline was marked. Everything a
// watchpoint asserts is relative to this.
const BASELINE_FILE = path.join(DIR, "watch-baseline.json");

// A watcher that has stopped reporting is not a watcher, whatever its file
// says. Tombstones are best-effort — a browser crash, a disabled extension or
// a killed tab can all skip them — so silence itself has to be the signal.
const WATCH_STALE_SECONDS = Number(process.env.AGENT_EYES_WATCH_STALE || 60);
const WATCH_EXPIRE_SECONDS = Number(process.env.AGENT_EYES_WATCH_EXPIRE || 900);
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
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
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

function watcherAgeSeconds(data) {
  const t = Date.parse(data && data.capturedAt);
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 1000;
}

/**
 * Delete watcher files nobody is feeding any more.
 *
 * Without this the directory only grows, and every consumer has to invent its
 * own staleness rule — which is how a frozen watcher went on driving
 * recommendations for five rounds of a live draft.
 */
function sweepWatchers() {
  let removed = 0;
  for (const f of fs.readdirSync(WATCH_DIR)) {
    if (!f.endsWith(".json") || f === "latest.json") continue;
    const p = path.join(WATCH_DIR, f);
    try {
      if (watcherAgeSeconds(JSON.parse(fs.readFileSync(p, "utf8"))) > WATCH_EXPIRE_SECONDS) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {
      fs.unlinkSync(p); // unreadable is not useful either
      removed++;
    }
  }
  if (removed) console.log(`[agenteyes] swept ${removed} expired watcher(s)`);
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

/**
 * Only the extension may read cross-origin.
 *
 * "*" let any website the user visited read their captures from JavaScript:
 * browse to a hostile page while the last capture was a mailbox or an internal
 * tool, and its contents were one fetch away. Requests without an Origin —
 * curl, the bridge, anything server-side — are unaffected, since CORS only
 * governs browsers.
 */
function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin.startsWith("chrome-extension://")) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function send(res, status, body, contentType = "application/json") {
  // Read the origin off the response's own request rather than threading it
  // through every call site — or worse, stashing it in a shared variable,
  // which would race between concurrent requests.
  const allow = allowedOrigin(res.req && res.req.headers ? res.req.headers.origin : null);
  res.writeHead(status, {
    "Content-Type": contentType,
    ...(allow ? { "Access-Control-Allow-Origin": allow, Vary: "Origin" } : {}),
    // DELETE matters: the popup's delete button issues one, and a browser
    // fails the preflight if it is not advertised here. curl does not enforce
    // CORS, so this only breaks in the UI.
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
        if (data.watchId && data.removed) {
          // Retired deliberately — by the popup, or by the worker noticing its
          // tab closed. Remove the file rather than leaving a tombstone that
          // every reader must learn to recognise.
          for (const f of fs.readdirSync(WATCH_DIR)) {
            if (f.startsWith(`${data.watchId}_`)) fs.unlinkSync(path.join(WATCH_DIR, f));
          }
          console.log(`[agenteyes] watcher ${data.watchId} retired: ${data.reason || "removed"}`);
          return send(res, 200, JSON.stringify({ ok: true, retired: data.watchId }));
        }

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
        // Include a slug of the name so the directory is readable at a glance;
        // the timestamp keeps it unique and sortable. Slugified to the same
        // charset the id guard accepts, so a crafted name cannot escape.
        const slug = String(data.meta.name || "snapshot")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "snapshot";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const id = `${stamp}_${slug}`;
        const stored = { schemaVersion: 1, meta: { ...data.meta, id, createdAt: new Date().toISOString() }, snapshot: data.snapshot };
        fs.writeFileSync(snapshotPath(id), JSON.stringify(stored, null, 2), "utf8");
        const file = snapshotPath(id);
        console.log(`[agenteyes] snapshot saved: ${stored.meta.name} — ${stored.meta.health?.actions ?? "?"} actions`);
        console.log(`[agenteyes]   ${file}`);
        // Both forms: the absolute path for the filesystem, and a URL that
        // actually opens — file:// is blocked from an extension popup unless
        // the user has granted file access, http always works.
        send(
          res,
          200,
          JSON.stringify({
            ok: true,
            id,
            meta: stored.meta,
            path: file,
            fileUrl: `file://${encodeURI(file)}`,
            url: `http://localhost:${PORT}/snapshot/${id}`
          })
        );
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
      // Move to a trash directory rather than unlinking. Snapshots are
      // deliberate user artifacts and a delete is easy to issue by accident,
      // including from a script.
      if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR, { recursive: true });
      const dest = path.join(TRASH_DIR, `${id}.json`);
      fs.renameSync(file, dest);
      console.log(`[agenteyes] snapshot trashed: ${id}`);
      console.log(`[agenteyes]   recoverable at ${dest}`);
      return send(res, 200, JSON.stringify({ ok: true, trashed: dest }));
    }
  }

  if (req.method === "GET" && req.url === "/surface") {
    if (!fs.existsSync(SURFACE_FILE)) {
      return send(res, 404, JSON.stringify({ ok: false, error: "no surface scan yet" }));
    }
    return send(res, 200, fs.readFileSync(SURFACE_FILE, "utf8"));
  }

  if (req.method === "POST" && req.url === "/watch/baseline") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const baseline = { markedAt: new Date().toISOString(), watchpoints: JSON.parse(body || "{}") };
        fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), "utf8");
        const n = Object.keys(baseline.watchpoints).length;
        console.log(`[agenteyes] baseline marked for ${n} watchpoint(s)`);
        send(res, 200, JSON.stringify({ ok: true, markedAt: baseline.markedAt, count: n }));
      } catch (err) {
        send(res, 400, JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/watch/baseline") {
    if (!fs.existsSync(BASELINE_FILE)) {
      return send(res, 404, JSON.stringify({ ok: false, error: "no baseline marked" }));
    }
    return send(res, 200, fs.readFileSync(BASELINE_FILE, "utf8"));
  }

  if (req.method === "DELETE" && req.url === "/watch/baseline") {
    if (fs.existsSync(BASELINE_FILE)) fs.unlinkSync(BASELINE_FILE);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (req.method === "GET" && req.url === "/watch") {
    sweepWatchers();
    // Report staleness rather than making every consumer derive it.
    const live = [];
    for (const f of fs.readdirSync(WATCH_DIR)) {
      if (!f.endsWith(".json") || f === "latest.json") continue;
      try {
        const w = JSON.parse(fs.readFileSync(path.join(WATCH_DIR, f), "utf8"));
        const age = watcherAgeSeconds(w);
        live.push({
          watchId: w.watchId, label: w.label, selector: w.selector,
          capturedAt: w.capturedAt, chars: (w.text || "").length,
          ageSeconds: Math.round(age), stale: age > WATCH_STALE_SECONDS
        });
      } catch { /* skip unreadable */ }
    }
    return send(res, 200, JSON.stringify({ ok: true, staleAfterSeconds: WATCH_STALE_SECONDS, watchers: live }));
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
          "POST /watch/baseline", "GET /watch/baseline", "DELETE /watch/baseline",
        ],
        file: JSON_FILE,
        capturesDir: CAPTURES_DIR
      })
    );
  }

  send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`[agenteyes] listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`[agenteyes] writing to ${JSON_FILE}`);
  console.log(`[agenteyes] history in ${CAPTURES_DIR}`);
  console.log(`[agenteyes] watchers in ${WATCH_DIR}`);
  console.log(`[agenteyes] snapshots in ${SNAP_DIR}`);
});
