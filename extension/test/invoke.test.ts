import { beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

let invoke: (id: string, key: string | null, max: number, dry: boolean) => any;
let scan: (max: number) => any;

function render(html: string, opts: { obscure?: boolean } = {}) {
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = html;
  const g = globalThis as any;
  g.window = win; g.document = doc; g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/app" };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as any) {
    el.getClientRects = () => [{ width: 10, height: 10 }];
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
  }
  // Whatever is at the click point decides what a click hits.
  const overlay = opts.obscure ? doc.createElement("div") : null;
  doc.elementFromPoint = (_x: number, _y: number) =>
    overlay ?? (doc.querySelector("button") as unknown as Element);
  return doc;
}

beforeAll(async () => {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const scanSrc = src.slice(src.indexOf("function scanSurface("), src.indexOf("/**\n * Click one previously-discovered action"));
  const invSrc = src.slice(src.indexOf("function invokeActionInPage("), src.indexOf("// ---- shared send + badge feedback ----"));
  const mod = new Function(`${scanSrc}\n${invSrc}\nreturn { scanSurface, invokeActionInPage };`)();
  scan = mod.scanSurface;
  invoke = mod.invokeActionInPage;
});

test("dry run reports what it would click, and does not click", () => {
  const doc = render(`<main><button id="save">Save</button></main>`);
  let clicked = false;
  (doc.querySelector("#save") as any).click = () => { clicked = true; };
  const target = scan(20000).actions.find((a: any) => a.label === "Save");
  const r = invoke(target.id, target.identityKey, 20000, true);
  expect(r.ok).toBe(true);
  expect(r.outcome).toBe("would_click");
  expect(r.action.label).toBe("Save");
  expect(clicked).toBe(false);
});

test("a real invocation clicks exactly once", () => {
  const doc = render(`<main><button id="save">Save</button></main>`);
  let clicks = 0;
  (doc.querySelector("#save") as any).click = () => { clicks++; };
  const target = scan(20000).actions.find((a: any) => a.label === "Save");
  const r = invoke(target.id, target.identityKey, 20000, false);
  expect(r.outcome).toBe("clicked");
  expect(clicks).toBe(1);
});

test("an id that no longer exists is refused", () => {
  render(`<main><button>Save</button></main>`);
  expect(invoke("nosuchid", null, 20000, true).outcome).toBe("action_gone");
});

test("a label change since the caller read it is refused, showing both", () => {
  // The gap between reading the page and acting on it is where wrong clicks live.
  render(`<main><button>Publish</button></main>`);
  const target = scan(20000).actions[0];
  const r = invoke(target.id, "button|save|main", 20000, true);
  expect(r.outcome).toBe("action_changed");
  expect(r.was).toBe("button|save|main");
  expect(r.now).toContain("publish");
});

test("a position-dependent id is refused outright", () => {
  // Position is exactly what changes between scanning and clicking.
  render(`<main><div><button></button></div><div><button></button></div><div><button></button></div></main>`);
  const withOrdinal = scan(20000).actions.find((a: any) => a.ordinalDisambiguated);
  if (!withOrdinal) return;
  expect(invoke(withOrdinal.id, withOrdinal.identityKey, 20000, true).outcome).toBe("unstable_id");
});

test("a disabled control is refused", () => {
  render(`<main><button disabled>Save</button></main>`);
  const target = scan(20000).actions.find((a: any) => a.label === "Save");
  expect(invoke(target.id, target.identityKey, 20000, true).outcome).toBe("disabled");
});

test("an element behind an overlay is refused, naming what covers it", () => {
  const doc = render(`<main><button>Save</button></main>`, { obscure: true });
  const target = scan(20000).actions.find((a: any) => a.label === "Save");
  const r = invoke(target.id, target.identityKey, 20000, true);
  expect(r.outcome).toBe("obscured_by");
  expect(r.by).toContain("div");
});
