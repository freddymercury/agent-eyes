import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { diffSurfaces } from "../../packages/protocol/src/diff";
import type { Action, SnapshotMeta } from "../../packages/protocol/src/index";

/**
 * Form state, in the scanner and in the diff.
 *
 * Before this, a checkbox going from unchecked to checked produced two scans
 * whose actions were identical in every field the differ compared — label,
 * kind, landmark, identity key, prominence — so the diff reported nothing
 * changed. On an app-like page that is most of what ever changes, which made
 * "what changed and whether it mattered" blind to its commonest subject.
 */

let win: Window | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

async function scan(html: string, mutate?: (doc: any) => void): Promise<any> {
  win = new Window({ url: "https://example.test/f" });
  const doc = win.document;
  doc.title = "Form fixture";
  doc.body.innerHTML = html;
  mutate?.(doc);

  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/f" };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as any) el.getClientRects = () => [{ width: 10, height: 10 }];

  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function scanSurface(");
  const end = src.indexOf("// ---- watch kit:");
  const scanSurface = new Function(`${src.slice(start, end)}; return scanSurface;`)();
  return scanSurface(20000);
}

const FORM = `
  <label for="tos">Accept terms</label><input id="tos" type="checkbox">
  <label for="size">Size</label><select id="size"><option>Small</option><option>Large</option></select>
  <label for="q">Search</label><input id="q" type="text" aria-label="Search query">
  <label for="pw">Password</label><input id="pw" type="password" aria-label="Password">
  <div role="button" aria-expanded="false" tabindex="0">Details</div>
  <button>Submit</button>
`;

const meta = (id: string): SnapshotMeta => ({
  id,
  name: id,
  createdAt: new Date().toISOString(),
  url: "https://example.test/f",
  title: "Form fixture",
  completeness: { truncated: false } as SnapshotMeta["completeness"],
  health: { actions: 6, positionalRate: 0, ordinalRate: 0, lowConfidenceRate: 0, truncated: false },
});

test("captures checkbox, select, text and ARIA state", async () => {
  const r = await scan(FORM, (doc) => {
    doc.getElementById("tos").checked = true;
    doc.getElementById("size").value = "Large";
    doc.getElementById("q").value = "hello";
  });
  const by = (label: string) => r.actions.find((a: Action) => a.label === label);

  expect(by("Accept terms")?.state?.checked).toBe(true);
  expect(by("Size")?.state?.selected).toBe("Large");
  expect(by("Search query")?.state?.value).toBe("hello");
  expect(by("Details")?.state?.["aria-expanded"]).toBe("false");
});

test("passwords are never captured, in any state", async () => {
  const r = await scan(FORM, (doc) => {
    doc.getElementById("pw").value = "hunter2";
  });
  const pw = r.actions.find((a: Action) => a.label === "Password");
  expect(pw?.state?.value).toBe("[redacted]");
  expect(JSON.stringify(r)).not.toContain("hunter2");
});

test("stateless controls carry no state at all", async () => {
  const r = await scan(FORM);
  const submit = r.actions.find((a: Action) => a.label === "Submit");
  expect(submit?.state).toBeUndefined();
});

test("a ticked checkbox is a diff, where before it was silence", async () => {
  const before = await scan(FORM);
  const after = await scan(FORM, (doc) => {
    doc.getElementById("tos").checked = true;
  });

  const d = diffSurfaces(meta("a"), before.actions, meta("b"), after.actions);
  expect(d.counts.state).toBe(1);
  const change = d.changes.find((c) => c.kind === "state");
  expect(change?.fields).toEqual(["state.checked"]);
  expect(change?.after.label).toBe("Accept terms");
});

test("state changes are reported apart from structural ones", async () => {
  // A renamed button and a ticked checkbox are different events: one is the
  // page doing its job, the other is the page becoming a different page.
  const before = await scan(FORM);
  const after = await scan(FORM.replace(">Submit<", ">Send<"), (doc) => {
    doc.getElementById("tos").checked = true;
  });

  const d = diffSurfaces(meta("a"), before.actions, meta("b"), after.actions);
  expect(d.counts.state).toBe(1);
  expect(d.changes.some((c) => c.kind === "state")).toBe(true);
  // The structural change is still visible and not buried under the state one.
  expect(d.changes.some((c) => c.kind !== "state")).toBe(true);
});

test("an unchanged form is still reported as unchanged", async () => {
  const before = await scan(FORM);
  const after = await scan(FORM);
  const d = diffSurfaces(meta("a"), before.actions, meta("b"), after.actions);
  expect(d.counts.state).toBe(0);
  expect(d.counts.changed).toBe(0);
});
