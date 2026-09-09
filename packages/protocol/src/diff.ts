import type { Action, SnapshotMeta } from "./index";
import { comparabilityWarnings } from "./index";

export type ChangeKind = "added" | "removed" | "renamed" | "changed";

export interface ActionChange {
  kind: ChangeKind;
  /** Prominence of whichever side exists, for ranking the report. */
  prominence: number;
  before?: Action;
  after?: Action;
  /** What differed, for `changed` and `renamed`. */
  fields?: string[];
}

export interface SurfaceDiff {
  /** Reasons the comparison may not mean what it appears to. Never empty-checked
   *  away: a diff is reported alongside its caveats, not withheld. */
  warnings: string[];
  counts: { added: number; removed: number; renamed: number; changed: number; unchanged: number };
  changes: ActionChange[];
}

/**
 * Anchor an action independently of its label.
 *
 * Semantic identity includes the name, so renaming a control produces a
 * different id and would otherwise read as one action removed and an unrelated
 * one added. Matching on what did not change — kind, landmark, and the app's own
 * testid or the container it sits in — recovers the rename.
 */
function renameAnchor(a: Action): string | null {
  const testid = a.identityStrategy === "testid" ? a.identityKey.split("|")[0] : null;
  const container = a.identityKey.includes("@") ? a.identityKey.split("@")[1] : null;
  const anchor = testid ?? container;
  return anchor ? `${a.kind}|${a.landmark ?? ""}|${anchor}` : null;
}

function changedFields(before: Action, after: Action): string[] {
  const f: string[] = [];
  if (before.label !== after.label) f.push("label");
  if (before.enabled !== after.enabled) f.push("enabled");
  if (before.kind !== after.kind) f.push("kind");
  if ((before.landmark ?? "") !== (after.landmark ?? "")) f.push("landmark");
  return f;
}

const prom = (a?: Action, b?: Action) => Math.max(a?.prominence ?? 0.7, b?.prominence ?? 0.7);

/**
 * Compare two snapshots.
 *
 * Always returns a diff. When the snapshots are poorly comparable the warnings
 * say so and the caller decides — refusing outright would be useless on exactly
 * the pages where a diff is most wanted, such as a virtualised table whose ids
 * are mostly position-dependent.
 */
export function diffSurfaces(
  beforeMeta: SnapshotMeta,
  beforeActions: Action[],
  afterMeta: SnapshotMeta,
  afterActions: Action[],
): SurfaceDiff {
  const warnings = comparabilityWarnings(beforeMeta, afterMeta);

  const beforeById = new Map(beforeActions.map((a) => [a.id, a]));
  const afterById = new Map(afterActions.map((a) => [a.id, a]));

  const changes: ActionChange[] = [];
  let unchanged = 0;

  const survivedBefore = new Set<string>();
  const survivedAfter = new Set<string>();

  for (const [id, before] of beforeById) {
    const after = afterById.get(id);
    if (!after) continue;
    survivedBefore.add(id);
    survivedAfter.add(id);
    const fields = changedFields(before, after);
    if (fields.length) {
      changes.push({ kind: "changed", prominence: prom(before, after), before, after, fields });
    } else {
      unchanged++;
    }
  }

  const goneList = beforeActions.filter((a) => !survivedBefore.has(a.id));
  const newList = afterActions.filter((a) => !survivedAfter.has(a.id));

  // Pair likely renames before reporting anything as added or removed.
  const newByAnchor = new Map<string, Action[]>();
  for (const a of newList) {
    const k = renameAnchor(a);
    if (k) newByAnchor.set(k, [...(newByAnchor.get(k) ?? []), a]);
  }
  const claimed = new Set<Action>();

  for (const before of goneList) {
    const k = renameAnchor(before);
    const candidate = k ? (newByAnchor.get(k) ?? []).find((c) => !claimed.has(c)) : undefined;
    if (candidate) {
      claimed.add(candidate);
      changes.push({
        kind: "renamed",
        prominence: prom(before, candidate),
        before,
        after: candidate,
        fields: changedFields(before, candidate),
      });
    } else {
      changes.push({ kind: "removed", prominence: prom(before), before });
    }
  }
  for (const after of newList) {
    if (claimed.has(after)) continue;
    changes.push({ kind: "added", prominence: prom(undefined, after), after });
  }

  // Most prominent first: a diff should lead with what matters on the page, not
  // with whichever footer link happened to move.
  changes.sort((x, y) => y.prominence - x.prominence);

  const counts = { added: 0, removed: 0, renamed: 0, changed: 0, unchanged };
  for (const c of changes) counts[c.kind]++;
  return { warnings, counts, changes };
}
