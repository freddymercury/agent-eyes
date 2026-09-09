import { expect, test } from "bun:test";
import { comparabilityWarnings, snapshotHealth } from "@agent-eyes/protocol";
import type { Action, SnapshotMeta } from "@agent-eyes/protocol";

const action = (over: Partial<Action> = {}): Action => ({
  id: "a", identityStrategy: "semantic", ordinalDisambiguated: false,
  identityKey: "button|x|main", label: "x", kind: "activate",
  evidence: { nativeDom: true }, confidence: 0.75,
  domExposure: { domPath: "body > button", tagName: "button" }, ...over,
});

const meta = (over: Partial<SnapshotMeta> = {}): SnapshotMeta => ({
  id: "s", name: "n", createdAt: "2026-09-09T00:00:00Z",
  url: "https://a.test", title: "t", completeness: "dom-actions",
  health: { actions: 10, positionalRate: 0, ordinalRate: 0, lowConfidenceRate: 0, truncated: false },
  ...over,
});

test("health summarises the qualities that decide if a diff is trustworthy", () => {
  const h = snapshotHealth([
    action(),
    action({ identityStrategy: "positional" }),
    action({ ordinalDisambiguated: true }),
    action({ confidence: 0.15 }),
  ]);
  expect(h.actions).toBe(4);
  expect(h.positionalRate).toBe(0.25);
  expect(h.ordinalRate).toBe(0.25);
  expect(h.lowConfidenceRate).toBe(0.25);
});

test("comparable snapshots produce no warnings", () => {
  expect(comparabilityWarnings(meta(), meta())).toEqual([]);
});

test("different pages are flagged", () => {
  const w = comparabilityWarnings(meta(), meta({ url: "https://b.test" }));
  expect(w.some((x) => x.includes("different url"))).toBe(true);
});

test("comparing a text-only snapshot against a scanned one is flagged", () => {
  // Otherwise every action looks removed, which reads as a catastrophic diff.
  const w = comparabilityWarnings(meta(), meta({ completeness: "text-only" }));
  expect(w.some((x) => x.includes("completeness"))).toBe(true);
});

test("sharply different identity quality is flagged", () => {
  // The Yahoo draft room at 86% ordinal-dependent against a page at 5% would
  // produce noise; the caller should be told rather than shown a diff.
  const bad = meta({ health: { ...meta().health, ordinalRate: 0.86 } });
  const w = comparabilityWarnings(meta(), bad);
  expect(w.some((x) => x.includes("ordinal-dependent"))).toBe(true);
});

test("similar quality is not flagged even when both are poor", () => {
  const a = meta({ health: { ...meta().health, ordinalRate: 0.85 } });
  const b = meta({ health: { ...meta().health, ordinalRate: 0.88 } });
  expect(comparabilityWarnings(a, b)).toEqual([]);
});

test("a truncated scan is always flagged as partial", () => {
  const t = meta({ health: { ...meta().health, truncated: true } });
  const w = comparabilityWarnings(meta(), t);
  expect(w.some((x) => x.includes("truncated"))).toBe(true);
});
