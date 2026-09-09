import { expect, test } from "bun:test";
import { diffSurfaces } from "@agent-eyes/protocol";
import type { Action, SnapshotMeta } from "@agent-eyes/protocol";

const act = (over: Partial<Action> = {}): Action => ({
  id: "id", identityStrategy: "semantic", ordinalDisambiguated: false,
  identityKey: "button|save|main", label: "Save", kind: "activate",
  evidence: { nativeDom: true }, confidence: 0.75, prominence: 1,
  landmark: "main", domExposure: { domPath: "body > button", tagName: "button" }, ...over,
});

const meta = (over: Partial<SnapshotMeta> = {}): SnapshotMeta => ({
  id: "s", name: "n", createdAt: "2026-09-09T00:00:00Z", url: "https://a.test",
  title: "t", completeness: "dom-actions",
  health: { actions: 3, positionalRate: 0, ordinalRate: 0, lowConfidenceRate: 0, truncated: false },
  ...over,
});

test("an unchanged surface reports no changes", () => {
  const a = [act({ id: "1" }), act({ id: "2", label: "Cancel" })];
  const d = diffSurfaces(meta(), a, meta(), a);
  expect(d.counts).toMatchObject({ added: 0, removed: 0, renamed: 0, changed: 0, unchanged: 2 });
});

test("added and removed actions are reported", () => {
  const before = [act({ id: "1" })];
  const after = [act({ id: "1" }), act({ id: "2", label: "Publish" })];
  const d = diffSurfaces(meta(), before, meta(), after);
  expect(d.counts.added).toBe(1);
  expect(d.changes.find((c) => c.kind === "added")!.after!.label).toBe("Publish");
});

test("a renamed control is a rename, not a removal plus an addition", () => {
  // Semantic ids include the label, so renaming changes the id. Without pairing
  // them, every rename reads as an unrelated action vanishing and another
  // appearing — which is how a small change looks like a large one.
  const before = [act({ id: "old", identityStrategy: "testid", identityKey: "testid:save|save", label: "Save" })];
  const after = [act({ id: "new", identityStrategy: "testid", identityKey: "testid:save|save changes", label: "Save changes" })];
  const d = diffSurfaces(meta(), before, meta(), after);
  expect(d.counts).toMatchObject({ renamed: 1, added: 0, removed: 0 });
  expect(d.changes[0]!.fields).toContain("label");
});

test("disabling a control is a change, not a removal", () => {
  const before = [act({ id: "1", enabled: true })];
  const after = [act({ id: "1", enabled: false })];
  const d = diffSurfaces(meta(), before, meta(), after);
  expect(d.counts.changed).toBe(1);
  expect(d.changes[0]!.fields).toEqual(["enabled"]);
});

test("the report leads with what matters on the page", () => {
  // A footer link moving should not outrank a primary control disappearing.
  const before = [
    act({ id: "footer", label: "Terms", landmark: "contentinfo", prominence: 0.1 }),
    act({ id: "main", label: "Deploy", landmark: "main", prominence: 1 }),
  ];
  const d = diffSurfaces(meta(), before, meta(), []);
  expect(d.changes[0]!.before!.label).toBe("Deploy");
});

test("a poorly comparable pair still produces a diff, with warnings", () => {
  // Refusing outright would be useless on exactly the pages where a diff is
  // most wanted — a virtualised table whose ids are mostly positional.
  const shaky = meta({ health: { ...meta().health, ordinalRate: 0.86 } });
  const d = diffSurfaces(meta(), [act({ id: "1" })], shaky, []);
  expect(d.warnings.length).toBeGreaterThan(0);
  expect(d.warnings.some((w) => w.includes("ordinal-dependent"))).toBe(true);
  expect(d.counts.removed).toBe(1); // the diff is still there
});

test("renames are paired one-to-one, not many-to-one", () => {
  const mk = (id: string, label: string) =>
    act({ id, identityStrategy: "testid", identityKey: `testid:row|${label}`, label });
  const before = [mk("a", "One"), mk("b", "Two")];
  const after = [mk("c", "Uno"), mk("d", "Dos")];
  const d = diffSurfaces(meta(), before, meta(), after);
  expect(d.counts.renamed).toBe(2);
  expect(d.counts.added).toBe(0);
  expect(d.counts.removed).toBe(0);
});
