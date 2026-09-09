import { beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

let scanSurface: (maxNodes: number) => any;

function render(html: string) {
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = html;
  const g = globalThis as any;
  g.window = win; g.document = doc; g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/app" };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as any) el.getClientRects = () => [{ width: 10, height: 10 }];
  return scanSurface(20000);
}

beforeAll(async () => {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  scanSurface = new Function(
    `${src.slice(src.indexOf("function scanSurface("), src.indexOf("// ---- watch kit:"))}; return scanSurface;`,
  )();
});

const PAGE = `
  <header><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
  <main><button>Create repository</button><a href="/issues">Issues</a></main>
  <footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a></footer>`;

test("the page's own controls outrank its furniture", () => {
  // The failure this exists for: a GitHub scan returned Terms, Privacy and
  // Contact as its top high-confidence actions, and nothing about the repo.
  const scan = render(PAGE);
  const top = [...scan.actions].sort((a: any, b: any) => b.prominence - a.prominence)[0];
  expect(top.label).toBe("Create repository");
});

test("footer actions rank below main, while staying high confidence", () => {
  const scan = render(PAGE);
  const terms = scan.actions.find((a: any) => a.label === "Terms");
  const create = scan.actions.find((a: any) => a.label === "Create repository");
  expect(terms.prominence).toBeLessThan(create.prominence);
  // confidence answers a different question, and still says "yes, interactive"
  expect(terms.confidence).toBeGreaterThan(0.7);
});

test("landmarks are recorded", () => {
  const scan = render(PAGE);
  expect(scan.actions.find((a: any) => a.label === "Terms").landmark).toBe("contentinfo");
  expect(scan.actions.find((a: any) => a.label === "Home").landmark).toBe("navigation");
  expect(scan.actions.find((a: any) => a.label === "Create repository").landmark).toBe("main");
});

test("generic labels are demoted wherever they sit", () => {
  const scan = render(`<main><a href="/1">Learn more</a><button>Deploy to production</button></main>`);
  const generic = scan.actions.find((a: any) => a.label === "Learn more");
  const real = scan.actions.find((a: any) => a.label === "Deploy to production");
  expect(generic.prominence).toBeLessThan(real.prominence);
});

test("a page with no landmarks does not bury everything", () => {
  // Most pages never mark up their main content; assuming the worst would
  // flatten the whole inventory to the floor.
  const scan = render(`<div><button>Save</button></div>`);
  expect(scan.actions[0].prominence).toBeGreaterThan(0.5);
  expect(scan.actions[0].landmark).toBeUndefined();
});

test("a region inside a footer is still footer-ranked", () => {
  // Taking the innermost landmark's weight would promote it to 0.9.
  const scan = render(`
    <main><button>Primary</button></main>
    <footer><section><a href="/x">Buried link</a></section></footer>`);
  const buried = scan.actions.find((a: any) => a.label === "Buried link");
  const primary = scan.actions.find((a: any) => a.label === "Primary");
  expect(buried.landmark).toBe("region");
  expect(buried.prominence).toBeLessThan(primary.prominence);
  expect(buried.prominence).toBeLessThanOrEqual(0.1);
});
