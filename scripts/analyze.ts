#!/usr/bin/env bun
/**
 * Health check for surface scans taken from real pages.
 *
 * Fixtures cannot answer these questions — they are the easy case, written to
 * exercise the very function under test. These three numbers are what say
 * whether identity actually holds up:
 *
 *   strategy mix      how much of a real page falls back to positional ids
 *   scan cost         duration, and whether the node budget truncated it
 *   duplicate density where ordinals are doing the work, and how hard
 *
 *   bun run scripts/analyze.ts scan1.json scan2.json ...
 *   bun run scripts/analyze.ts --stability a.json b.json   # same page, twice
 */
import type { Action, IdentityStrategy, ScanStats } from "@agent-eyes/protocol";

interface Scan {
  url?: string;
  title?: string;
  actions: Action[];
  stats?: ScanStats;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

function report(path: string, s: Scan) {
  const n = s.actions.length;
  const strat = { testid: 0, semantic: 0, positional: 0 } as Record<IdentityStrategy, number>;
  for (const a of s.actions) strat[a.identityStrategy]++;

  const byKey = new Map<string, number>();
  for (const a of s.actions) {
    // "~" is the ordinal separator; "#" can appear inside a key legitimately.
    const base = a.identityKey.split("~")[0]!;
    byKey.set(base, (byKey.get(base) ?? 0) + 1);
  }
  const dupes = [...byKey.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  const inDupes = dupes.reduce((acc, [, c]) => acc + c, 0);

  const unnamed = s.actions.filter((a) => !a.domExposure.accessibleName).length;
  const lowConf = s.actions.filter((a) => a.confidence < 0.3).length;

  console.log(`\n── ${s.title || path}`);
  console.log(`   ${s.url ?? ""}`);
  console.log(`   actions          ${n}`);
  if (s.stats) {
    console.log(
      `   scan             ${s.stats.durationMs}ms over ${s.stats.nodesVisited} nodes` +
        (s.stats.truncated ? "   <-- TRUNCATED, inventory is partial" : ""),
    );
    console.log(
      `   skipped          ${s.stats.iframesSkipped} iframes, ` +
        `${s.stats.shadowRootsTraversed} shadow roots traversed`,
    );
  }
  console.log(
    `   identity         testid ${pct(strat.testid, n)}  ` +
      `semantic ${pct(strat.semantic, n)}  ` +
      `positional ${pct(strat.positional, n)}` +
      (strat.positional / (n || 1) > 0.25 ? "   <-- weak: >25% will churn" : ""),
  );
  console.log(`   unnamed          ${unnamed} (${pct(unnamed, n)}) — no accessible name to anchor to`);
  console.log(`   low confidence   ${lowConf} (${pct(lowConf, n)}) — cursor-only detections`);
  console.log(
    `   duplicates       ${inDupes} actions across ${dupes.length} collision groups` +
      (dupes[0] && dupes[0][1] > 20 ? `   <-- largest group ${dupes[0][1]}, ordinals are fragile here` : ""),
  );
  for (const [key, count] of dupes.slice(0, 3)) console.log(`     ${count}x  ${key}`);
}

/** Same page scanned twice with no change: any id movement is a pure bug. */
function stability(a: Scan, b: Scan) {
  const ida = a.actions.map((x) => x.id);
  const idb = b.actions.map((x) => x.id);
  const setB = new Set(idb);
  const moved = ida.filter((id) => !setB.has(id));
  console.log(`\n── reload stability`);
  console.log(`   actions   ${ida.length} → ${idb.length}`);
  console.log(
    `   unstable  ${moved.length} (${pct(moved.length, ida.length)})` +
      (moved.length ? "   <-- ids changed with no page change; this is a bug" : "   clean"),
  );
  for (const id of moved.slice(0, 5)) {
    const act = a.actions.find((x) => x.id === id)!;
    console.log(`     "${act.label}"  ${act.identityKey}  [${act.identityStrategy}]`);
  }
  return moved.length;
}

const args = Bun.argv.slice(2);
const load = async (p: string) => (await Bun.file(p).json()) as Scan;

if (args[0] === "--stability") {
  const [, x, y] = args;
  if (!x || !y) throw new Error("usage: analyze.ts --stability <a.json> <b.json>");
  const bad = stability(await load(x), await load(y));
  if (bad > 0) process.exit(1);
} else {
  if (!args.length) throw new Error("usage: analyze.ts <scan.json> [...]");
  for (const p of args) report(p, await load(p));
}
