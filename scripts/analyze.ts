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
  const strat = { testid: 0, semantic: 0, container: 0, positional: 0 } as Record<IdentityStrategy, number>;
  for (const a of s.actions) strat[a.identityStrategy]++;

  const byKey = new Map<string, number>();
  for (const a of s.actions) {
    // "~" is the ordinal separator; "#" can appear inside a key legitimately.
    const base = a.identityKey.split("~")[0]!;
    byKey.set(base, (byKey.get(base) ?? 0) + 1);
  }
  const dupes = [...byKey.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  const inDupes = dupes.reduce((acc, [, c]) => acc + c, 0);

  const ordinal = s.actions.filter((a) => a.ordinalDisambiguated).length;
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
      `container ${pct(strat.container, n)}  ` +
      `positional ${pct(strat.positional, n)}` +
      (strat.positional / (n || 1) > 0.25 ? "   <-- weak: >25% will churn" : ""),
  );
  console.log(
    `   ordinal-dep      ${ordinal} (${pct(ordinal, n)}) — position-dependent whatever the strategy` +
      (ordinal / (n || 1) > 0.3 ? "   <-- fragile in a reordering list" : ""),
  );
  console.log(`   unnamed          ${unnamed} (${pct(unnamed, n)}) — no accessible name to anchor to`);
  console.log(`   low confidence   ${lowConf} (${pct(lowConf, n)}) — cursor-only detections`);
  console.log(
    `   duplicates       ${inDupes} actions across ${dupes.length} collision groups` +
      (dupes[0] && dupes[0][1] > 20 ? `   <-- largest group ${dupes[0][1]}, ordinals are fragile here` : ""),
  );
  for (const [key, count] of dupes.slice(0, 3)) console.log(`     ${count}x  ${key}`);
}

/**
 * Same page scanned twice. Ids that vanish are only a bug if the *thing* is
 * still there — a rotating carousel genuinely serves different content between
 * loads, and counting that as instability makes the check useless on any real
 * page. Classify by label: present under a different id is churn, absent
 * entirely is the page changing underneath us.
 */
function stability(a: Scan, b: Scan) {
  const idsB = new Set(b.actions.map((x) => x.id));
  const labelsB = new Map<string, string>();
  for (const x of b.actions) if (!labelsB.has(x.label.trim())) labelsB.set(x.label.trim(), x.id);

  const keyA = new Map(a.actions.map((x) => [x.id, x.identityKey]));
  const keyB = new Map(b.actions.map((x) => [x.id, x.identityKey]));

  const churned: Array<{ label: string; from: string; to: string }> = [];
  let contentChanged = 0;
  for (const x of a.actions) {
    if (idsB.has(x.id)) continue;
    const hit = labelsB.get(x.label.trim());
    if (hit) churned.push({ label: x.label, from: x.id, to: hit });
    else contentChanged++;
  }

  // An id that survives but now describes something else is the worst case:
  // silently wrong rather than visibly missing.
  let remapped = 0;
  for (const [id, k] of keyA) if (keyB.has(id) && keyB.get(id) !== k) remapped++;

  const dupA = a.actions.length - new Set(a.actions.map((x) => x.id)).size;
  const dupB = b.actions.length - new Set(b.actions.map((x) => x.id)).size;
  const ordDep = a.actions.filter((x) => x.ordinalDisambiguated).length;

  console.log(`\n-- reload stability`);
  console.log(`   actions          ${a.actions.length} -> ${b.actions.length}`);
  console.log(`   ordinal-dep      ${ordDep} (${pct(ordDep, a.actions.length)}) — the ids most at risk`);
  console.log(`   content changed  ${contentChanged} — label gone from the page, not a churn`);
  console.log(`   duplicate ids    A=${dupA} B=${dupB}${dupA + dupB > 0 ? "   <-- ids are not unique" : ""}`);
  console.log(
    `   REMAPPED         ${remapped}${remapped ? "   <-- an id now describes a different action" : ""}`,
  );
  console.log(
    `   CHURNED          ${churned.length} (${pct(churned.length, a.actions.length)})` +
      (churned.length ? "   <-- same thing, new id: a bug" : "   clean"),
  );
  for (const c of churned.slice(0, 5)) console.log(`     "${c.label.slice(0, 50)}"  ${c.from} -> ${c.to}`);
  return churned.length + remapped + dupA + dupB;
}

/** One row per scan, for comparing many sites at a glance. */
function table(rows: Array<{ path: string; scan: Scan }>) {
  const cell = (v: string, w: number) => v.padEnd(w);
  const num = (v: string, w: number) => v.padStart(w);
  console.log(
    `\n${cell("site", 22)} ${num("acts", 5)} ${num("ms", 5)} ${num("nodes", 6)} ` +
      `${num("testid", 7)} ${num("seman", 6)} ${num("contnr", 6)} ${num("posit", 6)} ${num("ord-dep", 8)} ${num("lowconf", 8)} ${num("shadow", 7)}`,
  );
  console.log("-".repeat(94));
  for (const { path, scan } of rows) {
    const n = scan.actions.length || 1;
    const st = { testid: 0, semantic: 0, container: 0, positional: 0 } as Record<IdentityStrategy, number>;
    for (const a of scan.actions) st[a.identityStrategy]++;
    const ord = scan.actions.filter((a) => a.ordinalDisambiguated).length;
    const low = scan.actions.filter((a) => a.confidence < 0.3).length;
    const name = (path.split("/").pop() ?? path).replace(/\.json$/, "");
    console.log(
      `${cell(name.slice(0, 22), 22)} ${num(String(scan.actions.length), 5)} ` +
        `${num(String(scan.stats?.durationMs ?? "?"), 5)} ${num(String(scan.stats?.nodesVisited ?? "?"), 6)} ` +
        `${num(pct(st.testid, n), 7)} ${num(pct(st.semantic, n), 6)} ${num(pct(st.container, n), 6)} ${num(pct(st.positional, n), 6)} ` +
        `${num(pct(ord, n), 8)} ${num(pct(low, n), 8)} ${num(String(scan.stats?.shadowRootsTraversed ?? 0), 7)}` +
        (scan.stats?.truncated ? "  TRUNCATED" : ""),
    );
  }
  console.log("\n  posit  = ids that will churn      ord-dep = position-dependent whatever the strategy");
  console.log("  lowconf = cursor-only detections   shadow = shadow roots traversed");
}

const args = Bun.argv.slice(2);
const load = async (p: string) => (await Bun.file(p).json()) as Scan;

if (args[0] === "--table") {
  const paths = args.slice(1);
  if (!paths.length) throw new Error("usage: analyze.ts --table <scan.json> [...]");
  table(await Promise.all(paths.map(async (p) => ({ path: p, scan: await load(p) }))));
} else if (args[0] === "--stability") {
  const [, x, y] = args;
  if (!x || !y) throw new Error("usage: analyze.ts --stability <a.json> <b.json>");
  const bad = stability(await load(x), await load(y));
  if (bad > 0) process.exit(1);
} else {
  if (!args.length) throw new Error("usage: analyze.ts <scan.json> [...]");
  for (const p of args) report(p, await load(p));
}
