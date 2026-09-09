import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEFAULT_BRIDGE_CONFIG,
  URI_CONTEXT,
  URI_WATCH_LIST,
  watchUri,
  type BridgeConfig,
  type SurfaceSnapshot,
} from "@agent-eyes/protocol";
import { readContext, readStaleness, readText, readWatchers, type Watcher } from "./source";

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
    "agent_eyes_get_surface",
    {
      title: "Get surface",
      description:
        "Normalized surface snapshot. Check `completeness`: this build reports text-only, " +
        "so an empty `actions` array means actions were never inspected, not that none exist.",
    },
    async () => {
      const [ctx, watchers] = await Promise.all([readContext(), readWatchers()]);
      const snapshot: SurfaceSnapshot = {
        schemaVersion: 1,
        id: `surface-${Date.now()}`,
        context: ctx ?? { url: "", title: "", capturedAt: "" },
        completeness: "text-only",
        actions: [],
        webmcpTools: [],
        watchpoints: watchers.map((w) => w.state),
        text: (await readText()) ?? undefined,
      };
      return json(snapshot);
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
