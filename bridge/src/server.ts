import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEFAULT_BRIDGE_CONFIG,
  comparabilityWarnings,
  snapshotUri,
  URI_ACTIONS,
  URI_SNAPSHOTS,
  URI_CONTEXT,
  URI_WATCH_LIST,
  watchUri,
  type BridgeConfig,
  type SurfaceSnapshot,
} from "@agent-eyes/protocol";
import {
  readContext,
  readStaleness,
  listSnapshots,
  readSnapshot,
  readSurfaceScan,
  saveSnapshot,
  readText,
  readWatchers,
  type Watcher,
} from "./source";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

/** URIs a client has asked to be notified about. */
const subscriptions = new Set<string>();

export function createServer(config: BridgeConfig = DEFAULT_BRIDGE_CONFIG) {
  const server = new McpServer(
    { name: "agent-eyes", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        // subscribe is the point of this bridge: it lets a harness be told the
        // surface changed instead of polling and guessing.
        resources: { subscribe: true, listChanged: true },
      },
    },
  );

  // Declaring the `subscribe` capability is not enough — McpServer does not
  // implement these, and without them subscribe fails with "Method not found".
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });

  // --- resources ------------------------------------------------------------

  server.registerResource(
    "context",
    URI_CONTEXT,
    { title: "Current surface context", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await readContext(), null, 2) }],
    }),
  );

  server.registerResource(
    "watchpoints",
    URI_WATCH_LIST,
    { title: "Active watchpoints", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify((await readWatchers()).map((w) => w.descriptor), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "watchpoint",
    new ResourceTemplate("agenteyes://watch/{id}", {
      list: async () => ({
        resources: (await readWatchers()).map((w) => ({
          uri: watchUri(w.id),
          name: w.descriptor.name,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Watchpoint state", mimeType: "application/json" },
    async (uri, vars) => {
      const id = String(vars.id);
      const w = (await readWatchers()).find((x) => x.id === id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(w ? w.state : { error: `no watchpoint ${id}` }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "actions",
    URI_ACTIONS,
    { title: "Discovered interactive actions", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await readSurfaceScan(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "snapshots",
    URI_SNAPSHOTS,
    { title: "Saved surface snapshots", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: JSON.stringify(await listSnapshots(), null, 2) },
      ],
    }),
  );

  server.registerResource(
    "snapshot",
    new ResourceTemplate("agenteyes://snapshots/{id}", {
      list: async () => ({
        resources: (await listSnapshots()).map((m) => ({
          uri: snapshotUri(m.id),
          name: `${m.name} (${m.createdAt.slice(0, 16)})`,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Saved snapshot", mimeType: "application/json" },
    async (uri, vars) => {
      const snap = await readSnapshot(String(vars.id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(snap ?? { error: `no snapshot ${vars.id}` }, null, 2),
          },
        ],
      };
    },
  );

  // --- tools ----------------------------------------------------------------

  server.registerTool(
    "agent_eyes_get_context",
    { title: "Get surface context", description: "URL, title and capture time of the observed page." },
    async () => json(await readContext()),
  );

  server.registerTool(
    "agent_eyes_get_staleness",
    {
      title: "Get staleness",
      description: "How old the observation is, and whether it should be trusted.",
    },
    async () => json(await readStaleness(config.staleAfterSeconds)),
  );

  server.registerTool(
    "agent_eyes_list_watchpoints",
    { title: "List watchpoints", description: "Elements currently being watched on the page." },
    async () => json((await readWatchers()).map((w) => w.descriptor)),
  );

  server.registerTool(
    "agent_eyes_get_watchpoint",
    {
      title: "Get watchpoint",
      description: "Current text and freshness of one watched element.",
      inputSchema: { id: z.string().describe("Watchpoint id, from list_watchpoints") },
    },
    async ({ id }: { id: string }) => {
      const w = (await readWatchers()).find((x) => x.id === id);
      return w ? json(w.state) : json({ error: `no watchpoint ${id}` });
    },
  );

  server.registerTool(
    "agent_eyes_get_text",
    {
      title: "Get page text",
      description: "Raw extracted text. Distinct from get_surface, which returns a normalized surface.",
      inputSchema: { watchId: z.string().optional().describe("Omit for the freshest capture") },
    },
    async ({ watchId }: { watchId?: string }) => {
      const text = await readText(watchId);
      return text === null ? json({ error: "no capture available" }) : { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "agent_eyes_list_actions",
    {
      title: "List interactive actions",
      description:
        "Everything the page appears to let a user do, with the evidence each was " +
        "detected by and a confidence score. Requires a scan (Cmd+Shift+U in the " +
        "extension); returns an explicit error if none has been taken. " +
        "Ids are positional and not stable across page loads.",
      inputSchema: {
        minConfidence: z.number().optional().describe("Filter out weaker detections, 0-1"),
        order: z
          .enum(["prominence", "document"])
          .optional()
          .describe("prominence (default) puts the page's own controls first; document is source order"),
        limit: z.number().optional().describe("Return only the first N"),
      },
    },
    async ({
      minConfidence,
      order,
      limit,
    }: {
      minConfidence?: number;
      order?: "prominence" | "document";
      limit?: number;
    }) => {
      const scan = await readSurfaceScan();
      if (!scan) {
        return json({
          error: "no surface scan available",
          hint: "run a scan from the extension (Cmd+Shift+U) first",
        });
      }
      const min = minConfidence ?? 0;
      let actions = scan.actions.filter((a) => a.confidence >= min);
      // Default to prominence: an agent asking an open question should see the
      // page's own controls, not whatever the document happens to list first —
      // which on most sites is the header and footer.
      if ((order ?? "prominence") === "prominence") {
        actions = [...actions].sort((a, b) => (b.prominence ?? 0.7) - (a.prominence ?? 0.7));
      }
      if (limit && limit > 0) actions = actions.slice(0, limit);
      return json({
        capturedAt: scan.capturedAt,
        ageSeconds: scan.ageSeconds,
        stats: scan.stats,
        order: order ?? "prominence",
        actions,
      });
    },
  );

  server.registerTool(
    "agent_eyes_get_surface",
    {
      title: "Get surface",
      description:
        "Normalized surface snapshot. Check `completeness`: this build reports text-only, " +
        "so an empty `actions` array means actions were never inspected, not that none exist.",
    },
    async () => {
      const [ctx, watchers, scan] = await Promise.all([
        readContext(),
        readWatchers(),
        readSurfaceScan(),
      ]);
      const snapshot: SurfaceSnapshot = {
        schemaVersion: 1,
        id: `surface-${Date.now()}`,
        context: ctx ?? { url: "", title: "", capturedAt: "" },
        // Only claim dom-actions when a scan actually exists, so an empty
        // actions array is never ambiguous between "none found" and "never looked".
        completeness: scan ? "dom-actions" : "text-only",
        actions: scan?.actions ?? [],
        webmcpTools: [],
        watchpoints: watchers.map((w) => w.state),
        text: (await readText()) ?? undefined,
        scanStats: scan?.stats,
      };
      return json(snapshot);
    },
  );

  server.registerTool(
    "agent_eyes_save_snapshot",
    {
      title: "Save a surface snapshot",
      description:
        "Persist the current surface under a name, with release metadata. Records " +
        "identity health alongside it so a later comparison can tell whether it is " +
        "trustworthy. Writes only to Agent Eyes' own store — it does not act on the page.",
      inputSchema: {
        name: z.string().describe("A name for this snapshot"),
        version: z.string().optional().describe("Release version, if known"),
        commitSha: z.string().optional(),
        environment: z.string().optional().describe("local, dev, staging, production"),
        notes: z.string().optional(),
      },
    },
    async ({
      name,
      version,
      commitSha,
      environment,
      notes,
    }: {
      name: string;
      version?: string;
      commitSha?: string;
      environment?: string;
      notes?: string;
    }) => {
      const r = await saveSnapshot(name, { version, commitSha, environment }, notes);
      return json(r.ok ? { saved: r.meta } : { error: r.error });
    },
  );

  server.registerTool(
    "agent_eyes_list_snapshots",
    { title: "List saved snapshots", description: "Every saved snapshot, newest first, with its identity health." },
    async () => json(await listSnapshots()),
  );

  server.registerTool(
    "agent_eyes_get_snapshot",
    {
      title: "Get a saved snapshot",
      description: "Read one snapshot in full by id.",
      inputSchema: { id: z.string().describe("Snapshot id, from list_snapshots") },
    },
    async ({ id }: { id: string }) => {
      const snap = await readSnapshot(id);
      return snap ? json(snap) : json({ error: `no snapshot ${id}` });
    },
  );

  server.registerTool(
    "agent_eyes_check_comparable",
    {
      title: "Check two snapshots can be compared",
      description:
        "Report why two snapshots may not be meaningfully comparable — different pages, " +
        "different completeness, or sharply different identity quality. Returns warnings " +
        "rather than a verdict, so they can be shown rather than silently acted on.",
      inputSchema: { a: z.string(), b: z.string() },
    },
    async ({ a, b }: { a: string; b: string }) => {
      const [x, y] = await Promise.all([readSnapshot(a), readSnapshot(b)]);
      if (!x || !y) return json({ error: `no snapshot ${!x ? a : b}` });
      const warnings = comparabilityWarnings(x.meta, y.meta);
      return json({ comparable: warnings.length === 0, warnings });
    },
  );

  // In read mode write tools are absent rather than present-and-failing: an
  // agent should not be offered a capability it cannot use.
  if (config.mode === "readwrite") {
    server.registerTool(
      "agent_eyes_invoke_action",
      { title: "Invoke action (not implemented)", description: "Reserved for Phase 2." },
      async () => json({ error: "write plane not implemented; see docs/roadmap.md F8" }),
    );
  }

  return server;
}

/**
 * Watch the capture files and emit invalidation.
 *
 * Nothing pushes to an agent, so the bridge's job is to make sure that whenever
 * a harness does look, the answer is current — and to tell subscribers when it
 * stopped being so.
 */
export function startInvalidationLoop(server: McpServer, intervalMs = 1000): () => void {
  let previous = new Map<string, string>();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const watchers: Watcher[] = await readWatchers();
      const next = new Map(watchers.map((w) => [w.id, w.state.contentHash]));

      // Only notify what was actually subscribed to, per the MCP spec.
      const notify = (uri: string) => {
        if (subscriptions.has(uri)) void server.server.sendResourceUpdated({ uri });
      };
      for (const [id, hash] of next) {
        if (previous.get(id) !== hash) {
          notify(watchUri(id));
          notify(URI_CONTEXT);
        }
      }
      const added = [...next.keys()].some((id) => !previous.has(id));
      const removed = [...previous.keys()].some((id) => !next.has(id));
      if (added || removed) server.sendResourceListChanged();

      previous = next;
    } catch {
      // never let observation errors kill the loop
    }
  };

  const handle = setInterval(tick, intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
