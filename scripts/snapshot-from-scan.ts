#!/usr/bin/env bun
/**
 * Save an existing scan file as a snapshot.
 *
 * Useful for building before/after pairs from scans already taken, without
 * needing the page to still be open.
 *
 *   bun run scripts/snapshot-from-scan.ts scans/gh-before.json gh-before
 */
import { snapshotHealth } from "@agent-eyes/protocol";
import type { Action, ScanStats } from "@agent-eyes/protocol";

const [file, name] = Bun.argv.slice(2);
if (!file || !name) throw new Error("usage: snapshot-from-scan.ts <scan.json> <name>");

const s = (await Bun.file(file).json()) as {
  url: string; title: string; capturedAt: string; actions: Action[]; stats?: ScanStats;
};

const meta = {
  name,
  url: s.url,
  title: s.title,
  completeness: "dom-actions" as const,
  health: snapshotHealth(s.actions, s.stats?.truncated ?? false),
};
const snapshot = {
  schemaVersion: 1 as const,
  id: `surface-${Date.now()}`,
  context: { url: s.url, title: s.title, capturedAt: s.capturedAt },
  completeness: "dom-actions" as const,
  actions: s.actions,
  webmcpTools: [],
  watchpoints: [],
  scanStats: s.stats,
};

const res = await fetch(`${process.env.AGENT_EYES_SERVER ?? "http://127.0.0.1:8765"}/snapshot`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ meta, snapshot }),
});
const body = (await res.json()) as { id?: string; error?: string };
console.log(res.ok ? `  saved ${name}: ${body.id}` : `  failed: ${body.error}`);
