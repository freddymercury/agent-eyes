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

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
if (!fs.existsSync(CAPTURES_DIR)) fs.mkdirSync(CAPTURES_DIR, { recursive: true });

let latest = null;

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
        writeFiles(data);
        console.log(`[agenteyes] received: ${data.title} (${data.text.length} chars)`);
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
        endpoints: ["POST /context", "GET /context", "GET /context.md"],
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
});
