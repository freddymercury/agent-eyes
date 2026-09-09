import { beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * F3's whole question: does an action's id survive the kinds of change a
 * release actually makes? Each case here is a real edit that should NOT alter
 * identity, or one that legitimately should.
 */
let scanSurface: (maxNodes: number) => any;

function render(html: string) {
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = html;
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/app" };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as any) {
    el.getClientRects = () => [{ width: 10, height: 10 }];
  }
  return scanSurface(20000);
}

const idOf = (scan: any, label: string) =>
  scan.actions.find((a: any) => a.label.toLowerCase().includes(label.toLowerCase()))?.id;

beforeAll(async () => {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function scanSurface(");
  const end = src.indexOf("// ---- watch kit:");
  scanSurface = new Function(`${src.slice(start, end)}; return scanSurface;`)();
});

test("restyling does not change identity", () => {
  const before = render(`<main><button class="btn-primary x7f2">Save</button></main>`);
  const after = render(`<main><button class="Button_root__a91b tw-px-4">Save</button></main>`);
  expect(idOf(before, "Save")).toBe(idOf(after, "Save"));
});

test("a new wrapper element does not change identity", () => {
  const before = render(`<main><button>Save</button></main>`);
  const after = render(`<main><div><div class="wrap"><button>Save</button></div></div></main>`);
  expect(idOf(before, "Save")).toBe(idOf(after, "Save"));
});

test("volatile counts in a label do not change identity", () => {
  const before = render(`<main><button>Cart (3)</button></main>`);
  const after = render(`<main><button>Cart (12)</button></main>`);
  expect(idOf(before, "Cart")).toBe(idOf(after, "Cart"));
});

test("data-testid survives even a label change", () => {
  const before = render(`<main><button data-testid="save-btn">Save</button></main>`);
  const after = render(`<main><section><button data-testid="save-btn">Save changes</button></section></main>`);
  const b = before.actions.find((a: any) => a.identityStrategy === "testid");
  const a = after.actions.find((x: any) => x.identityStrategy === "testid");
  expect(b.id).toBe(a.id);
  expect(b.identityStrategy).toBe("testid");
});

test("duplicate labels get distinct but reproducible ids", () => {
  const html = `<main><ul>
    <li><button>Edit</button></li>
    <li><button>Edit</button></li>
    <li><button>Edit</button></li>
  </ul></main>`;
  const first = render(html);
  const second = render(html);
  const ids = (s: any) => s.actions.filter((a: any) => a.label === "Edit").map((a: any) => a.id);
  expect(new Set(ids(first)).size).toBe(3);
  expect(ids(first)).toEqual(ids(second));
});

test("moving into a different landmark DOES change identity", () => {
  // Same control in a different region is arguably a different capability;
  // the diff should show it rather than hide it.
  const before = render(`<main><button>Delete</button></main>`);
  const after = render(`<nav><button>Delete</button></nav>`);
  expect(idOf(before, "Delete")).not.toBe(idOf(after, "Delete"));
});

test("a real label change DOES change identity", () => {
  const before = render(`<main><button>Save</button></main>`);
  const after = render(`<main><button>Publish</button></main>`);
  expect(idOf(before, "Save")).not.toBe(idOf(after, "Publish"));
});

test("unnamed controls are marked positional, not passed off as stable", () => {
  const scan = render(`<main><div role="button" tabindex="0"></div></main>`);
  const a = scan.actions[0];
  expect(a.identityStrategy).toBe("positional");
});

test("identityKey is human-readable for debugging churn", () => {
  const scan = render(`<main><button>Save</button></main>`);
  const a = scan.actions.find((x: any) => x.label === "Save");
  expect(a.identityKey).toContain("button");
  expect(a.identityKey).toContain("save");
});
