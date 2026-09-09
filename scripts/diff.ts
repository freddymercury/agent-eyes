#!/usr/bin/env bun
/**
 * Diff two saved snapshots.
 *
 *   bun run scripts/diff.ts <before-id> <after-id>
 *   bun run scripts/diff.ts --list
 */
import { diffSurfaces } from "@agent-eyes/protocol";
import { listSnapshots, readSnapshot } from "../bridge/src/source";

const args = Bun.argv.slice(2);

if (args[0] === "--list" || !args.length) {
  for (const m of await listSnapshots()) {
    const h = m.health;
    console.log(`${m.id}\n   ${m.name} — ${h.actions} actions, ${Math.round(h.ordinalRate * 100)}% unstable`);
  }
} else {
  const [beforeId, afterId] = args;
  const [a, b] = await Promise.all([readSnapshot(beforeId!), readSnapshot(afterId!)]);
  if (!a || !b) throw new Error(`no snapshot ${!a ? beforeId : afterId}`);
  const d = diffSurfaces(a.meta, a.snapshot.actions, b.meta, b.snapshot.actions);

  console.log(`\n${a.meta.name}\n  -> ${b.meta.name}\n`);
  // Warnings first: the counts below mean less, or nothing, if these are bad.
  if (d.warnings.length) {
    console.log("  WARNINGS — read these before the numbers");
    for (const w of d.warnings) console.log(`    ! ${w}`);
    console.log("");
  }
  const c = d.counts;
  console.log(`  +${c.added} added   -${c.removed} removed   ~${c.renamed} renamed   ${c.changed} changed   ${c.unchanged} unchanged\n`);

  const sym = { added: "+", removed: "-", renamed: "~", changed: "*" } as const;
  for (const ch of d.changes.slice(0, 30)) {
    const a2 = ch.after ?? ch.before!;
    const where = a2.landmark ?? "—";
    const label = (ch.after ?? ch.before!).label.slice(0, 46);
    const extra =
      ch.kind === "renamed" ? `  (was "${ch.before!.label.slice(0, 30)}")`
      : ch.kind === "changed" ? `  [${ch.fields!.join(", ")}]`
      : "";
    console.log(`  ${sym[ch.kind]} ${String(ch.prominence).padEnd(5)} ${where.padEnd(13)} ${JSON.stringify(label)}${extra}`);
  }
  if (d.changes.length > 30) console.log(`  … ${d.changes.length - 30} more`);
}
