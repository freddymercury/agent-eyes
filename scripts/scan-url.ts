#!/usr/bin/env bun
/**
 * Run the scanner against a public URL in headless Chrome.
 *
 * This is a corpus-building convenience, not a substitute for the extension:
 * headless has no session, so anything behind a login must still be scanned
 * from the real browser. Some sites also serve bot-detection pages to
 * headless, which is why the page title is always reported — a scan of an
 * "are you a robot" interstitial looks superficially fine.
 *
 *   bun run scripts/scan-url.ts youtube https://www.youtube.com
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const [name, url] = Bun.argv.slice(2);
if (!name || !url) throw new Error("usage: scan-url.ts <name> <url>");

const src = await Bun.file(`${import.meta.dir}/../extension/background.js`).text();
const scannerSrc = src.slice(src.indexOf("function scanSurface("), src.indexOf("// ---- watch kit:"));

// Use the installed Chrome rather than a Playwright build: it avoids a
// download, and it is the same engine the extension runs in.
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // Let client-rendered content settle; most of these pages are empty at
  // domcontentloaded and a scan then would measure the skeleton.
  await page.waitForTimeout(6000);

  const scan = await page.evaluate(
    ([code, max]) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`${code}; return scanSurface;`)();
      return fn(max);
    },
    [scannerSrc, 20000] as [string, number],
  );

  await mkdir(`${import.meta.dir}/../scans`, { recursive: true });
  await Bun.write(`${import.meta.dir}/../scans/${name}.json`, JSON.stringify(scan, null, 2));
  const s = scan as { title: string; actions: unknown[]; stats: { durationMs: number } };
  console.log(`  ${name}: ${s.actions.length} actions, ${s.stats.durationMs}ms — "${s.title}"`);
} finally {
  await browser.close();
}
