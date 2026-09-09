import { beforeAll, afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * The scanner is plain JS injected into the page, so it is loaded as source and
 * evaluated against a DOM rather than imported.
 */
let scanSurface: (maxNodes: number) => any;
let win: Window;

const FIXTURE = `
  <button id="save">Save</button>
  <a href="/next">Next page</a>
  <input type="text" aria-label="Search query">
  <input type="submit" value="Submit form">
  <select><option>One</option></select>
  <div role="button" tabindex="0">Custom button</div>
  <div class="clickable">Styled only</div>
  <span>Just text, not interactive</span>
  <button disabled>Disabled</button>
  <input type="hidden" value="csrf">
  <iframe src="/embed"></iframe>
`;

beforeAll(async () => {
  win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = FIXTURE;
  doc.title = "Fixture";

  // happy-dom does not lay out, so every element reports no client rects and
  // the scanner's visibility filter would reject the whole page. Report a box
  // for real elements; keep the styled-only div's cursor:pointer meaningful.
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/app" };
  g.getComputedStyle = (el: any) => ({
    cursor: el.className === "clickable" ? "pointer" : "auto",
    visibility: "visible",
    display: "block",
  });
  for (const el of doc.querySelectorAll("*") as any) {
    el.getClientRects = () => [{ width: 10, height: 10 }];
  }

  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function scanSurface(");
  const end = src.indexOf("// ---- watch kit:");
  scanSurface = new Function(`${src.slice(start, end)}; return scanSurface;`)();
});

afterAll(() => win?.close?.());

test("finds native, ARIA and styled-only interactive elements", () => {
  const r = scanSurface(20000);
  const labels = r.actions.map((a: any) => a.label);
  expect(labels).toContain("Save");
  expect(labels).toContain("Next page");
  expect(labels).toContain("Search query");
  expect(labels).toContain("Custom button");
  expect(labels).toContain("Styled only");
});

test("ignores non-interactive text and hidden inputs", () => {
  const r = scanSurface(20000);
  const labels = r.actions.map((a: any) => a.label);
  expect(labels).not.toContain("Just text, not interactive");
  expect(labels.some((l: string) => l === "csrf")).toBe(false);
});

test("confidence reflects how much evidence fired", () => {
  const r = scanSurface(20000);
  const byLabel = (l: string) => r.actions.find((a: any) => a.label === l);
  // native button: strong single signal
  expect(byLabel("Save").confidence).toBeGreaterThan(0.7);
  // role + tabindex: two corroborating signals
  expect(byLabel("Custom button").confidence).toBeGreaterThan(byLabel("Styled only").confidence);
  // cursor alone must not look trustworthy
  expect(byLabel("Styled only").confidence).toBeLessThan(0.3);
});

test("records evidence so a weak detection can be judged", () => {
  const r = scanSurface(20000);
  const custom = r.actions.find((a: any) => a.label === "Custom button");
  expect(custom.evidence.accessibility).toBe(true);
  expect(custom.evidence.focusable).toBe(true);
  expect(custom.evidence.nativeDom).toBeUndefined();
});

test("kinds are classified, not all 'activate'", () => {
  const r = scanSurface(20000);
  const kinds = Object.fromEntries(r.actions.map((a: any) => [a.label, a.kind]));
  expect(kinds["Next page"]).toBe("navigate");
  expect(kinds["Submit form"]).toBe("submit");
  expect(kinds["Search query"]).toBe("input");
  expect(kinds["Save"]).toBe("activate");
});

test("disabled state is reported", () => {
  const r = scanSurface(20000);
  expect(r.actions.find((a: any) => a.label === "Disabled").enabled).toBe(false);
  expect(r.actions.find((a: any) => a.label === "Save").enabled).toBe(true);
});

test("iframes are skipped and counted, not silently ignored", () => {
  const r = scanSurface(20000);
  expect(r.stats.iframesSkipped).toBe(1);
});

test("node budget truncates rather than hanging, and says so", () => {
  const r = scanSurface(3);
  expect(r.stats.truncated).toBe(true);
  expect(r.stats.nodesVisited).toBeLessThanOrEqual(3);
});

test("a cursor-only descendant of a detected action is not counted twice", () => {
  // GitHub's nav shape: the label lives in a <span> inside the <a>, and both
  // would otherwise qualify — doubling the inventory with phantom actions.
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = `<nav><a href="/code"><span class="label">Code</span></a></nav>`;
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.location = { href: "https://example.test/app" };
  g.CSS = { escape: (s: string) => s };
  g.getComputedStyle = (el: any) => ({
    cursor: el.tagName === "SPAN" ? "pointer" : "auto",
    visibility: "visible",
    display: "block",
  });
  for (const el of doc.querySelectorAll("*") as any) el.getClientRects = () => [{ width: 10, height: 10 }];

  const r = scanSurface(20000);
  expect(r.actions).toHaveLength(1);
  expect(r.actions[0].domExposure.tagName).toBe("a");
});

test("the ordinal separator cannot collide with a normalized label", () => {
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  // Bare numeric labels normalize to a placeholder; the ordinal suffix must
  // still be distinguishable from it.
  doc.body.innerHTML = `<main><button>0</button><button>0</button></main>`;
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.location = { href: "https://example.test/app" };
  g.CSS = { escape: (s: string) => s };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as any) el.getClientRects = () => [{ width: 10, height: 10 }];

  const r = scanSurface(20000);
  const keys = r.actions.map((a: any) => a.identityKey);
  expect(new Set(keys).size).toBe(2);
  expect(keys[1]).toContain("~");
  expect(r.actions[0].id).not.toBe(r.actions[1].id);
});
