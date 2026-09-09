#!/usr/bin/env bun
/**
 * Assert what an action did.
 *
 *   bun run scripts/watch.ts baseline   # before the action
 *   bun run scripts/watch.ts check      # after it
 */
import { evaluateWatchpoint } from "@agent-eyes/protocol";
import { markBaseline, readBaseline, readWatchers } from "../bridge/src/source";

const cmd = Bun.argv[2] ?? "check";

if (cmd === "baseline") {
  const r = await markBaseline();
  console.log(r.ok ? `  baseline marked for ${r.count} watchpoint(s) at ${r.markedAt}` : `  failed: ${r.error}`);
} else if (cmd === "check") {
  const [watchers, baseline] = await Promise.all([readWatchers(), readBaseline()]);
  if (!watchers.length) {
    console.log("  no watchpoints — pick some with Cmd+Shift+Y first");
  } else {
    console.log(baseline ? `\n  baseline marked ${baseline.markedAt}\n` : "\n  no baseline marked\n");
    const sym = { met: "PASS", violated: "FAIL", unknown: "  ? " } as const;
    for (const w of watchers) {
      const r = evaluateWatchpoint(
        w.descriptor,
        baseline?.watchpoints[w.id],
        w.state.hashes ?? { text: w.state.contentHash },
        w.state.alive,
      );
      const exp = r.expectation ? `expects ${r.expectation}` : "observing";
      console.log(`  ${sym[r.verdict]}  ${r.name}  (${exp})`);
      console.log(`         ${r.reason}`);
    }
  }
} else {
  console.error("usage: watch.ts <baseline|check>");
  process.exit(1);
}
