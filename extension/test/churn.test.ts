import { beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { churn } from "../../scripts/churn";

/**
 * The measurement F3 is gated on. Each pair is a change a release plausibly
 * makes; cosmetic ones must produce zero false churn, and real capability
 * changes must still show up.
 */
let scanSurface: (maxNodes: number) => any;

function scan(html: string) {
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = html;
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/app" };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as any) el.getClientRects = () => [{ width: 10, height: 10 }];
  return scanSurface(20000);
}

beforeAll(async () => {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function scanSurface(");
  const end = src.indexOf("// ---- watch kit:");
  scanSurface = new Function(`${src.slice(start, end)}; return scanSurface;`)();
});

const APP_V1 = `
  <header><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
  <main>
    <form>
      <input type="text" aria-label="Search">
      <button type="submit">Search</button>
    </form>
    <section>
      <button class="btn btn-primary">Save</button>
      <button class="btn">Cancel</button>
      <button data-testid="delete">Delete</button>
    </section>
    <ul>
      <li><button>Edit</button></li>
      <li><button>Edit</button></li>
    </ul>
  </main>`;

// Same app, restyled and re-wrapped: no capability changed.
const APP_V2_COSMETIC = `
  <header><nav><div><a href="/" class="Nav_link__9f2">Home</a><a href="/docs" class="Nav_link__9f2">Docs</a></div></nav></header>
  <main>
    <form>
      <div class="field"><input type="text" aria-label="Search"></div>
      <div class="actions"><button type="submit" class="tw-px-4 tw-bg-blue">Search</button></div>
    </form>
    <section class="Panel_root__aa1">
      <div><button class="Button_primary__x71">Save</button></div>
      <div><button class="Button_ghost__b22">Cancel</button></div>
      <div><button data-testid="delete" class="Button_danger__c93">Delete</button></div>
    </section>
    <ul>
      <li><span><button>Edit</button></span></li>
      <li><span><button>Edit</button></span></li>
    </ul>
  </main>`;

// A real release: "Cancel" removed, "Duplicate" added, "Save" renamed.
const APP_V3_REAL = `
  <header><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
  <main>
    <form>
      <input type="text" aria-label="Search">
      <button type="submit">Search</button>
    </form>
    <section>
      <button class="btn btn-primary">Save changes</button>
      <button>Duplicate</button>
      <button data-testid="delete">Delete</button>
    </section>
    <ul>
      <li><button>Edit</button></li>
      <li><button>Edit</button></li>
    </ul>
  </main>`;

test("cosmetic release produces ZERO false churn", () => {
  const r = churn(scan(APP_V1), scan(APP_V2_COSMETIC));
  expect(r.falseChurn).toBe(0);
  expect(r.falseChurnRate).toBe(0);
  // and nothing should look added or removed either
  expect(r.addedIds).toBe(0);
  expect(r.removedIds).toBe(0);
});

test("cosmetic release keeps every id stable", () => {
  const before = scan(APP_V1);
  const r = churn(before, scan(APP_V2_COSMETIC));
  expect(r.stableIds).toBe(before.actions.length);
});

test("a real capability change is still visible", () => {
  const r = churn(scan(APP_V1), scan(APP_V3_REAL));
  // Cancel gone, Duplicate added, Save renamed => genuine adds and removes
  expect(r.addedIds).toBeGreaterThan(0);
  expect(r.removedIds).toBeGreaterThan(0);
  // but untouched controls must not churn
  expect(r.falseChurnRate).toBeLessThan(0.05);
});

test("identity strategies are reported so coverage is visible", () => {
  const r = churn(scan(APP_V1), scan(APP_V2_COSMETIC));
  expect(r.strategies.testid).toBe(1);
  expect(r.strategies.semantic).toBeGreaterThan(5);
  expect(r.strategies.positional).toBe(0);
});
