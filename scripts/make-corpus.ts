#!/usr/bin/env bun
/**
 * Generate a corpus from the fixture pages so `churn` can be exercised without
 * a real application. A real corpus should be captured from actual releases —
 * see docs; fixtures are the easy case and will flatter the identity function.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";

const OUT = Bun.argv[2] ?? "corpus";
const src = await Bun.file(`${import.meta.dir}/../extension/background.js`).text();
const scanSurface = new Function(
  `${src.slice(src.indexOf("function scanSurface("), src.indexOf("// ---- watch kit:"))}; return scanSurface;`,
)() as (n: number) => unknown;

function scan(html: string) {
  const win = new Window({ url: "https://example.test/app" });
  const doc = win.document;
  doc.body.innerHTML = html;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = doc;
  g.CSS = { escape: (s: string) => s };
  g.location = { href: "https://example.test/app" };
  g.getComputedStyle = () => ({ cursor: "auto", visibility: "visible", display: "block" });
  for (const el of doc.querySelectorAll("*") as unknown as Iterable<Record<string, unknown>>) {
    el.getClientRects = () => [{ width: 10, height: 10 }];
  }
  return scanSurface(20000);
}

const BASE = `
  <header><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
  <main>
    <form><input type="text" aria-label="Search"><button type="submit">Search</button></form>
    <section>
      <button class="btn btn-primary">Save</button>
      <button class="btn">Cancel</button>
      <button data-testid="delete">Delete</button>
    </section>
    <ul><li><button>Edit</button></li><li><button>Edit</button></li></ul>
  </main>`;

const CASES: Record<string, [string, string]> = {
  restyle: [BASE, BASE.replace(/class="btn[^"]*"/g, 'class="Button_root__9fa2 tw-px-4")')],
  "added-wrappers": [BASE, BASE.replace(/<button/g, "<span><button").replace(/<\/button>/g, "</button></span>")],
  "volatile-counts": [BASE.replace("Search<", "Search (3)<"), BASE.replace("Search<", "Search (147)<")],
  "real-change": [BASE, BASE.replace(">Cancel<", ">Duplicate<").replace(">Save<", ">Save changes<")],
};

for (const [name, [before, after]] of Object.entries(CASES)) {
  const dir = join(OUT, name);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "before.json"), JSON.stringify(scan(before), null, 2));
  await Bun.write(join(dir, "after.json"), JSON.stringify(scan(after), null, 2));
  console.log(`  wrote ${dir}`);
}
