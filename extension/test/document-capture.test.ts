import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * Document capture.
 *
 * The point of this mode is that the expensive tier never reaches an agent's
 * context by accident: `summary` is always cheap, `extracted` is structured,
 * and the raw markup goes to disk. These tests cover what `innerText` threw
 * away — JSON-LD, meta tags, image URLs — plus the two behaviours that matter
 * more than the extraction itself: refusing rather than truncating, and
 * removing password values.
 */

let win: Window | undefined;

async function loadExtract(): Promise<(maxBytes: number) => any> {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function extractDocument(");
  const end = src.indexOf("// ---- element picker:");
  return new Function(`${src.slice(start, end)}; return extractDocument;`)();
}

const FIXTURE = `
  <meta name="description" content="A product page">
  <meta property="og:image" content="/og.png">
  <link rel="canonical" href="https://shop.test/p/1">
  <script type="application/ld+json">
    {"@type":"Product","name":"Widget","offers":{"price":"19.99"}}
  </script>
  <script type="application/ld+json">{ not valid json }</script>
  <h1>Widget</h1>
  <img src="/img/a.jpg" alt="front">
  <img src="https://cdn.test/b.jpg" alt="back">
  <img src="/img/a.jpg" alt="duplicate of front">
  <form><input type="password" value="hunter2"><input type="hidden" value="csrf-abc"></form>
`;

function mount(html: string): void {
  win = new Window({ url: "https://shop.test/p/1" });
  const doc = win.document;
  doc.title = "Widget — Shop";
  doc.head.innerHTML = "";
  doc.body.innerHTML = html;
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.location = { href: "https://shop.test/p/1" };
  g.URL = URL;
}

afterEach(() => {
  win?.close?.();
  win = undefined;
});

test("keeps the three things innerText throws away", async () => {
  mount(FIXTURE);
  const out = (await loadExtract())(5_000_000);

  // JSON-LD, parsed
  const ok = out.extracted.jsonld.filter((b: any) => b.ok);
  expect(ok).toHaveLength(1);
  expect(ok[0].data["@type"]).toBe("Product");
  expect(ok[0].data.offers.price).toBe("19.99");

  // meta tags
  expect(out.extracted.meta.description).toBe("A product page");
  expect(out.extracted.meta["og:image"]).toBe("/og.png");

  // image urls, absolutised and deduped
  const srcs = out.extracted.images.map((i: any) => i.src);
  expect(srcs).toContain("https://shop.test/img/a.jpg");
  expect(srcs).toContain("https://cdn.test/b.jpg");
  expect(srcs.filter((s: string) => s.endsWith("a.jpg"))).toHaveLength(1);

  // and the raw document is there, untruncated
  expect(out.truncated).toBe(false);
  expect(out.html).toContain("<h1>Widget</h1>");
});

test("malformed JSON-LD is reported, not dropped", async () => {
  mount(FIXTURE);
  const out = (await loadExtract())(5_000_000);
  const bad = out.extracted.jsonld.filter((b: any) => !b.ok);
  expect(bad).toHaveLength(1);
  expect(bad[0].error).toBeTruthy();
  expect(bad[0].raw).toContain("not valid json");
});

test("summary is cheap and answers the obvious questions", async () => {
  mount(FIXTURE);
  const out = (await loadExtract())(5_000_000);
  expect(out.summary.jsonldBlocks).toBe(2);
  expect(out.summary.images).toBe(2);
  expect(out.summary.description).toBe("A product page");
  expect(out.summary.bytes).toBeGreaterThan(0);
  // Cheap means cheap: no arrays of URLs hiding in here.
  expect(JSON.stringify(out.summary).length).toBeLessThan(600);
});

test("password values are removed from the markup", async () => {
  mount(FIXTURE);
  const out = (await loadExtract())(5_000_000);
  expect(out.html).not.toContain("hunter2");
  expect(out.html).toContain("[redacted]");
  expect(out.summary.passwordsRedacted).toBe(1);
  // The DOM must be left as it was found — this runs in the user's live page.
  expect(win!.document.querySelector('input[type="password"]')!.getAttribute("value")).toBe("hunter2");
});

test("what cannot be scrubbed is warned about instead of pretended away", async () => {
  mount(FIXTURE);
  const out = (await loadExtract())(5_000_000);
  // The hidden CSRF field survives, on purpose: a scrub that misses some is
  // worse than none, because it makes the file look safe.
  expect(out.html).toContain("csrf-abc");
  expect(out.warnings.join(" ")).toContain("CSRF");
});

test("refuses rather than truncating when over the cap", async () => {
  mount(FIXTURE);
  const out = (await loadExtract())(100);
  expect(out.truncated).toBe(true);
  expect(out.html).toBeNull();
  expect(out.warnings[0]).toContain("over the 100 limit");
  // The structured tiers stay complete — that is the point of extracting first.
  expect(out.summary.jsonldBlocks).toBe(2);
  expect(out.extracted.images).toHaveLength(2);
});
