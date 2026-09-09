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

test("div-based grids get anchored, with no li or tr in sight", () => {
  // Commerce grids: every card is a div, every button says the same thing.
  const card = (name: string) =>
    `<div class="card"><div class="title">${name}</div><div class="act"><button>Add to cart</button></div></div>`;
  const scan = render(`<div class="grid">${card("Blue widget")}${card("Red widget")}${card("Green widget")}</div>`);
  const carts = scan.actions.filter((a: any) => a.label === "Add to cart");
  expect(carts).toHaveLength(3);
  expect(carts.every((c: any) => c.ordinalDisambiguated === false)).toBe(true);
  expect(new Set(carts.map((c: any) => c.id)).size).toBe(3);
});

test("custom elements are recognised as repeated units", () => {
  // YouTube's comments are ytd-comment-thread-renderer, not li — which is why
  // twenty "Reply" buttons were separated only by position.
  const comment = (author: string) =>
    `<ytd-comment-thread-renderer><div><span>${author}</span></div>` +
    `<div><button>Reply</button><button>Dislike this comment</button></div></ytd-comment-thread-renderer>`;
  const scan = render(`<main>${comment("Ana")}${comment("Bruno")}${comment("Chen")}</main>`);
  const replies = scan.actions.filter((a: any) => a.label === "Reply");
  expect(replies).toHaveLength(3);
  expect(replies.every((r: any) => r.ordinalDisambiguated === false)).toBe(true);
});

test("reordering a div grid keeps each card's identity", () => {
  const card = (name: string) =>
    `<div><div>${name}</div><div><button>Add to cart</button></div></div>`;
  const idFor = (scan: any, name: string) =>
    scan.actions.find((a: any) => a.label === "Add to cart" && a.identityKey.includes(name.toLowerCase()))?.id;
  const before = render(`<div>${card("Blue")}${card("Red")}${card("Green")}</div>`);
  const after = render(`<div>${card("Green")}${card("Blue")}${card("Red")}</div>`);
  for (const n of ["Blue", "Red", "Green"]) expect(idFor(before, n)).toBe(idFor(after, n));
});

test("two similar siblings are not treated as a repeated unit", () => {
  // Three is the smallest count that distinguishes a repeated unit from a
  // coincidental pair; a two-column layout must not be read as a list.
  const scan = render(`<div><div><button>Left</button></div><div><button>Right</button></div></div>`);
  expect(scan.actions.every((a: any) => !a.identityKey.includes("@"))).toBe(true);
});

test("a semantic container still wins when one exists", () => {
  const scan = render(`<main><ul>
    <li><h3>First</h3><button>Go</button></li>
    <li><h3>Second</h3><button>Go</button></li>
    <li><h3>Third</h3><button>Go</button></li></ul></main>`);
  const gos = scan.actions.filter((a: any) => a.label === "Go");
  expect(gos.every((g: any) => g.ordinalDisambiguated === false)).toBe(true);
  expect(gos[0].identityKey).toContain("first");
});
