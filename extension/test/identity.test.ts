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

test("non-Latin and accented labels keep their identity", () => {
  // An ASCII-only normalizer empties these, which silently sends an entire
  // non-English application to positional ids.
  const scan = render(`<main>
    <button>購入する</button>
    <button>Заказать</button>
    <button>Café</button>
    <button>Épingler</button>
  </main>`);
  expect(scan.actions).toHaveLength(4);
  for (const a of scan.actions) {
    expect(a.identityStrategy).toBe("semantic");
    // the key must actually carry the name, not an empty slot
    expect(a.identityKey).not.toMatch(/^button\|\|/);
  }
  // and distinct labels must not collide
  expect(new Set(scan.actions.map((a: any) => a.id)).size).toBe(4);
});

test("accented characters are preserved, not stripped", () => {
  const a = render(`<main><button>Café</button></main>`).actions[0];
  const b = render(`<main><button>Cafe</button></main>`).actions[0];
  expect(a.identityKey).toContain("café");
  expect(a.id).not.toBe(b.id);
});

test("long labels sharing a prefix do not collide", () => {
  // Commit lists, article titles and file paths routinely share their first
  // 60 characters; truncating alone merges them and hands the work to ordinals.
  const a = "Discover the page's interactive surface and add a scanner that inventories controls";
  const b = "Discover the page's interactive surface and add a scanner that skips iframes";
  const scan = render(`<main><a href="/1">${a}</a><a href="/2">${b}</a></main>`);
  expect(scan.actions).toHaveLength(2);
  const [x, y] = scan.actions;
  expect(x.id).not.toBe(y.id);
  // and neither should have needed an ordinal to be distinguished
  expect(x.ordinalDisambiguated).toBe(false);
  expect(y.ordinalDisambiguated).toBe(false);
});

test("identical long labels still collapse to an ordinal, as they should", () => {
  const long = "A repeated label that is definitely longer than the sixty character bound";
  const scan = render(`<main><a href="/1">${long}</a><a href="/2">${long}</a></main>`);
  expect(scan.actions[1].ordinalDisambiguated).toBe(true);
});

test("repeated controls in a list are scoped by their card, not by position", () => {
  // The shape that made eBay 35.5% ordinal-dependent: identical buttons, one
  // per product. Ordinals alone churn whenever the grid reorders.
  const scan = render(`<main><ul>
    <li><h3>Blue widget</h3><button>Add to cart</button></li>
    <li><h3>Red widget</h3><button>Add to cart</button></li>
    <li><h3>Green widget</h3><button>Add to cart</button></li>
  </ul></main>`);
  const carts = scan.actions.filter((a: any) => a.label === "Add to cart");
  expect(carts).toHaveLength(3);
  // none should have needed an ordinal — the card name distinguishes them
  expect(carts.every((a: any) => a.ordinalDisambiguated === false)).toBe(true);
  expect(new Set(carts.map((a: any) => a.id)).size).toBe(3);
});

test("a reordered list keeps each item's identity", () => {
  const item = (n: string) => `<li><h3>${n}</h3><button>Add to cart</button></li>`;
  const before = render(`<main><ul>${item("Blue")}${item("Red")}${item("Green")}</ul></main>`);
  const after = render(`<main><ul>${item("Green")}${item("Blue")}${item("Red")}</ul></main>`);
  const idFor = (scan: any, card: string) => {
    const key = scan.actions.find(
      (a: any) => a.label === "Add to cart" && a.identityKey.includes(card.toLowerCase()),
    );
    return key?.id;
  };
  // Reordering the grid must not change which id belongs to which product.
  for (const card of ["Blue", "Red", "Green"]) {
    expect(idFor(before, card)).toBe(idFor(after, card));
  }
});

test("meaningful numbers are kept; only counts and badges are normalized", () => {
  // Amazon's price filters are entirely digits — collapsing them makes
  // genuinely different capabilities collide.
  const scan = render(`<main>
    <a href="/1">Under $50</a>
    <a href="/2">Under $100</a>
    <a href="/3">Under $150</a>
  </main>`);
  const ids = scan.actions.map((a: any) => a.id);
  expect(new Set(ids).size).toBe(3);
  expect(scan.actions.every((a: any) => a.ordinalDisambiguated === false)).toBe(true);
});

test("a volatile count in parentheses still normalizes away", () => {
  const a = render(`<main><button>Cart (3)</button></main>`).actions[0];
  const b = render(`<main><button>Cart (147)</button></main>`).actions[0];
  expect(a.id).toBe(b.id);
});

test("scanning the same markup twice yields byte-identical ids", () => {
  // The reload-stability property, as a unit test so a regression is caught
  // without needing a live page.
  const html = `<main>
    <button>Save</button>
    <a href="/next">Next</a>
    <ul>
      <li><h3>Blue widget</h3><button>Add to cart</button></li>
      <li><h3>Red widget</h3><button>Add to cart</button></li>
    </ul>
    <button data-testid="del">Delete</button>
  </main>`;
  const a = render(html);
  const b = render(html);
  expect(a.actions.map((x: any) => x.id)).toEqual(b.actions.map((x: any) => x.id));
  // and ids must be unique within a scan, or "stable" means nothing
  expect(new Set(a.actions.map((x: any) => x.id)).size).toBe(a.actions.length);
});

test("data-table rows are scoped by cell text, not just headings", () => {
  // The Yahoo draft client shape: a table of unnamed action buttons, one per
  // row, where the distinguishing text is a plain cell rather than a heading.
  const row = (name: string) =>
    `<tr><td><div><button></button></div></td><td><div>${name}</div></td><td><div>RB</div></td></tr>`;
  const scan = render(`<main><table><tbody>
    ${row("J. Gibbs")}${row("B. Robinson")}${row("P. Nacua")}
  </tbody></table></main>`);
  const buttons = scan.actions.filter((a: any) => a.domExposure.tagName === "button");
  expect(buttons).toHaveLength(3);
  expect(new Set(buttons.map((b: any) => b.id)).size).toBe(3);
  // the point: none needed an ordinal
  expect(buttons.every((b: any) => b.ordinalDisambiguated === false)).toBe(true);
});

test("a shared testid is separated by name rather than by position", () => {
  // GitHub reuses data-testid="commit-row-item" on every commit; X reuses
  // testid:reply on every post. Discarding the name in favour of the testid
  // throws away the only thing that distinguishes them.
  const scan = render(`<main><ul>
    <li><a href="/1" data-testid="row">Fix the parser</a></li>
    <li><a href="/2" data-testid="row">Add a scanner</a></li>
  </ul></main>`);
  const rows = scan.actions.filter((a: any) => a.identityStrategy === "testid");
  expect(rows).toHaveLength(2);
  expect(rows.every((r: any) => r.ordinalDisambiguated === false)).toBe(true);
  expect(new Set(rows.map((r: any) => r.id)).size).toBe(2);
});
