#!/usr/bin/env bun
/**
 * Measure identity churn between two surface scans.
 *
 * The number that matters is not "how many ids changed" — a release genuinely
 * adds and removes capabilities. It is how many actions are *clearly the same*
 * and still got a different id. That is false churn, and it is what makes a
 * diff unreviewable.
 *
 *   bun run scripts/churn.ts before.json after.json
 *   bun run scripts/churn.ts --corpus corpus/     # each subdir: before/after.json
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Action, IdentityStrategy } from "@agent-eyes/protocol";

interface Scan {
  url?: string;
  actions: Action[];
}

/** Same capability by human judgement, independent of how the id was built. */
const semanticKey = (a: Action) =>
  [a.kind, a.domExposure.role ?? "", a.label.toLowerCase().replace(/\d+/g, "#").trim()].join("|");

export interface ChurnReport {
  before: number;
  after: number;
  stableIds: number;
  addedIds: number;
  removedIds: number;
  /** Same capability, different id — the metric that matters. */
  falseChurn: number;
  falseChurnRate: number;
  strategies: Record<IdentityStrategy, number>;
  examples: Array<{ label: string; beforeKey: string; afterKey: string }>;
}

export function churn(before: Scan, after: Scan): ChurnReport {
  const beforeIds = new Set(before.actions.map((a) => a.id));
  const afterIds = new Set(after.actions.map((a) => a.id));
  const stable = [...beforeIds].filter((id) => afterIds.has(id)).length;

  // Bucket by semantic key and pair the Nth occurrence with the Nth. Several
  // controls can be genuinely identical ("Edit" once per row); collapsing them
  // to one entry makes every duplicate after the first look churned.
  const afterBySem = new Map<string, Action[]>();
  for (const a of after.actions) {
    const k = semanticKey(a);
    afterBySem.set(k, [...(afterBySem.get(k) ?? []), a]);
  }
  const consumed = new Map<string, number>();

  let falseChurn = 0;
  const examples: ChurnReport["examples"] = [];
  for (const b of before.actions) {
    const k = semanticKey(b);
    const n = consumed.get(k) ?? 0;
    consumed.set(k, n + 1);
    const match = afterBySem.get(k)?.[n];
    if (match && match.id !== b.id) {
      falseChurn++;
      if (examples.length < 10) {
        examples.push({ label: b.label, beforeKey: b.identityKey, afterKey: match.identityKey });
      }
    }
  }

  const strategies = { testid: 0, semantic: 0, container: 0, positional: 0 } as Record<IdentityStrategy, number>;
  for (const a of after.actions) strategies[a.identityStrategy]++;

  return {
    before: before.actions.length,
    after: after.actions.length,
    stableIds: stable,
    addedIds: [...afterIds].filter((id) => !beforeIds.has(id)).length,
    removedIds: [...beforeIds].filter((id) => !afterIds.has(id)).length,
    falseChurn,
    falseChurnRate: before.actions.length ? falseChurn / before.actions.length : 0,
    strategies,
    examples,
  };
}

function print(name: string, r: ChurnReport) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\n-- ${name}`);
  console.log(`   actions      ${r.before} -> ${r.after}`);
  console.log(`   stable ids   ${r.stableIds}`);
  console.log(`   added        ${r.addedIds}    removed ${r.removedIds}`);
  console.log(
    `   FALSE CHURN  ${r.falseChurn}  (${pct(r.falseChurnRate)})` +
      (r.falseChurnRate > 0.05 ? "   <-- above 5% budget" : ""),
  );
  const total = Object.values(r.strategies).reduce((a, b) => a + b, 0) || 1;
  console.log(
    `   strategies   testid ${pct(r.strategies.testid / total)}  ` +
      `semantic ${pct(r.strategies.semantic / total)}  ` +
      `positional ${pct(r.strategies.positional / total)}`,
  );
  for (const e of r.examples) {
    console.log(`     churned: "${e.label}"`);
    console.log(`       before ${e.beforeKey}`);
    console.log(`       after  ${e.afterKey}`);
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const load = async (p: string) => (await Bun.file(p).json()) as Scan;

  if (args[0] === "--corpus") {
    const dir = args[1];
    if (!dir) throw new Error("usage: churn.ts --corpus <dir>");
    const cases = await readdir(dir, { withFileTypes: true });
    const reports: ChurnReport[] = [];
    for (const c of cases.filter((x) => x.isDirectory())) {
      const r = churn(
        await load(join(dir, c.name, "before.json")),
        await load(join(dir, c.name, "after.json")),
      );
      reports.push(r);
      print(c.name, r);
    }
    if (reports.length) {
      const rate = reports.reduce((a, r) => a + r.falseChurnRate, 0) / reports.length;
      console.log(`\n== corpus mean false churn: ${(rate * 100).toFixed(1)}% over ${reports.length} pairs`);
      // Release gate: identity that churns cannot support a reviewable diff.
      if (rate > 0.05) process.exit(1);
    }
  } else {
    const [a, b] = args;
    if (!a || !b) throw new Error("usage: churn.ts <before.json> <after.json>");
    print(`${a} -> ${b}`, churn(await load(a), await load(b)));
  }
}
