import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * Capture paths and shadow DOM.
 *
 * `innerText` and `outerHTML` do not cross a shadow boundary, so a page that
 * renders into a shadow root used to capture as an empty string and report
 * success — indistinguishable from a page that really is empty. That is the
 * failure these tests exist to prevent: not the missing content so much as the
 * missing signal.
 *
 * Like the scanner tests, the capture functions are plain JS injected into the
 * page, so they are loaded as source and evaluated against a DOM.
 */

let win: Window | undefined;

async function loadExtract(): Promise<() => any> {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function extractPageContent(");
  const end = src.indexOf("// ---- element picker:");
  return new Function(`${src.slice(start, end)}; return extractPageContent;`)();
}

function mount(html: string, build?: (doc: any) => void): void {
  win = new Window({ url: "https://example.test/p" });
  const doc = win.document;
  doc.title = "Fixture";
  doc.body.innerHTML = html;
  build?.(doc);
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.location = { href: "https://example.test/p" };
}

afterEach(() => {
  win?.close?.();
  win = undefined;
});

test("captures text from inside an open shadow root", async () => {
  mount(`<h1>visible heading</h1><div id="host"></div>`, (doc) => {
    doc
      .getElementById("host")
      .attachShadow({ mode: "open" }).innerHTML = "<p>content behind the boundary</p>";
  });

  const out = (await loadExtract())();
  expect(out.text).toContain("visible heading");
  expect(out.text).toContain("content behind the boundary");
  expect(out.shadowRootsTraversed).toBe(1);
  expect(out.warnings).toEqual([]);
});

test("traverses nested shadow roots", async () => {
  mount(`<div id="outer"></div>`, (doc) => {
    const outer = doc.getElementById("outer").attachShadow({ mode: "open" });
    outer.innerHTML = `<div id="inner"></div>`;
    outer
      .querySelector("#inner")
      .attachShadow({ mode: "open" }).innerHTML = "<p>two levels down</p>";
  });

  const out = (await loadExtract())();
  expect(out.text).toContain("two levels down");
  expect(out.shadowRootsTraversed).toBe(2);
});

test("warns rather than silently succeeding when nothing is readable", async () => {
  // A closed root is unreachable from a content script. The content cannot be
  // recovered, so the only correct behaviour is to say the capture is empty.
  mount(`<div id="host"></div>`, (doc) => {
    doc
      .getElementById("host")
      .attachShadow({ mode: "closed" }).innerHTML = "<p>unreachable</p>";
  });

  const out = (await loadExtract())();
  expect(out.text.trim()).toBe("");
  expect(out.warnings.length).toBeGreaterThan(0);
  expect(out.warnings[0]).toContain("empty");
});

test("ordinary pages are unaffected", async () => {
  mount(`<h1>Plain</h1><p>No shadow anywhere</p>`);

  const out = (await loadExtract())();
  expect(out.text).toContain("Plain");
  expect(out.text).toContain("No shadow anywhere");
  expect(out.shadowRootsTraversed).toBe(0);
  expect(out.warnings).toEqual([]);
});
