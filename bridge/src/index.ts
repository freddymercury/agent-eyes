#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig, type CapabilityMode } from "@agent-eyes/protocol";
import { createServer, startInvalidationLoop } from "./server";

function configFromEnv(): BridgeConfig {
  const mode = process.env.AGENT_EYES_MODE;
  const stale = Number(process.env.AGENT_EYES_STALE_AFTER);
  return {
    ...DEFAULT_BRIDGE_CONFIG,
    mode: mode === "readwrite" ? ("readwrite" as CapabilityMode) : "read",
    staleAfterSeconds: Number.isFinite(stale) && stale > 0 ? stale : DEFAULT_BRIDGE_CONFIG.staleAfterSeconds,
  };
}

const config = configFromEnv();
const server = createServer(config);
const stop = startInvalidationLoop(server);

// stdout is the MCP channel — anything logged there corrupts the protocol.
console.error(`[agent-eyes] bridge starting (mode=${config.mode}, staleAfter=${config.staleAfterSeconds}s)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
