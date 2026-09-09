import { expect, test } from "bun:test";
import { evaluateWatchpoint } from "@agent-eyes/protocol";
import type { ObservedHashes, WatchpointDescriptor } from "@agent-eyes/protocol";

const wp = (over: Partial<WatchpointDescriptor> = {}): WatchpointDescriptor => ({
  id: "w1", name: "cart total", target: { selector: "#total" },
  observe: ["text"], ...over,
});
const H = (text: string, extra: ObservedHashes = {}): ObservedHashes => ({ text, ...extra });

test("expecting a change, and getting one, passes", () => {
  const r = evaluateWatchpoint(wp({ expectation: "changes" }), H("a"), H("b"), true);
  expect(r.verdict).toBe("met");
  expect(r.changed).toEqual(["text"]);
});

test("expecting a change and getting none is a failed effect", () => {
  // The usual bug: the button was pressed and nothing happened.
  const r = evaluateWatchpoint(wp({ expectation: "changes" }), H("a"), H("a"), true);
  expect(r.verdict).toBe("violated");
  expect(r.reason).toContain("expected a change");
});

test("expecting stability and getting a change is an unintended side effect", () => {
  // The kind of bug a test suite normally misses entirely.
  const r = evaluateWatchpoint(wp({ expectation: "stable" }), H("a"), H("b"), true);
  expect(r.verdict).toBe("violated");
  expect(r.reason).toContain("text");
});

test("only the observed aspects count", () => {
  // Watching text must not fire because an attribute moved.
  const before = H("same", { attributes: "1" });
  const after = H("same", { attributes: "2" });
  expect(evaluateWatchpoint(wp({ expectation: "stable", observe: ["text"] }), before, after, true).verdict).toBe("met");
  expect(evaluateWatchpoint(wp({ expectation: "stable", observe: ["attributes"] }), before, after, true).verdict).toBe("violated");
});

test("a watchpoint with no expectation is never a failure", () => {
  // Observing is not asserting; it reports what moved without judging.
  const r = evaluateWatchpoint(wp(), H("a"), H("b"), true);
  expect(r.verdict).toBe("unknown");
  expect(r.changed).toEqual(["text"]);
  expect(r.reason).toContain("observed a change");
});

test("no baseline yields unknown rather than a false pass", () => {
  const r = evaluateWatchpoint(wp({ expectation: "stable" }), undefined, H("a"), true);
  expect(r.verdict).toBe("unknown");
  expect(r.reason).toContain("no baseline");
});

test("a vanished element violates stable but is unknown for changes", () => {
  // Disappearing is unambiguously not "stable". Whether it satisfies "changes"
  // is genuinely unclear, so it is not guessed.
  expect(evaluateWatchpoint(wp({ expectation: "stable" }), H("a"), H("a"), false).verdict).toBe("violated");
  expect(evaluateWatchpoint(wp({ expectation: "changes" }), H("a"), H("a"), false).verdict).toBe("unknown");
});

test("multiple moved aspects are all reported", () => {
  const before = H("a", { structure: "s1", state: "st1" });
  const after = H("b", { structure: "s2", state: "st1" });
  const r = evaluateWatchpoint(
    wp({ expectation: "stable", observe: ["text", "structure", "state"] }), before, after, true,
  );
  expect(r.changed).toEqual(["text", "structure"]);
});
