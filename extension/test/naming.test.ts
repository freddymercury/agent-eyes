import { beforeAll, expect, test } from "bun:test";

let suggest: (url: string) => string;

beforeAll(async () => {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function suggestSnapshotName(");
  const end = src.indexOf("/**\n * Save the current surface");
  suggest = new Function(`${src.slice(start, end)}; return suggestSnapshotName;`)() as (u: string) => string;
});

test("names come from the URL, not the title", () => {
  // document.title carries unread counts and badges — "(2) Home / X" — so two
  // snapshots of the same page would otherwise get different names.
  const n = suggest("https://github.com/freddymercury/agent-eyes");
  expect(n).toContain("github-com");
  expect(n).toContain("freddymercury-agent-eyes");
});

test("www is dropped and a bare host still names cleanly", () => {
  expect(suggest("https://www.amazon.com/")).toMatch(/^amazon-com-\d{8}-\d{4}$/);
});

test("a timestamp keeps repeated snapshots of one page distinct", () => {
  expect(suggest("https://a.test/x")).toMatch(/-\d{8}-\d{4}$/);
});

test("query strings and fragments are excluded", () => {
  const n = suggest("https://mail.google.com/mail/u/0/#inbox?tab=x");
  expect(n).not.toContain("#");
  expect(n).not.toContain("tab");
  expect(n).toContain("mail-google-com");
});

test("deep paths are bounded rather than unbounded", () => {
  const n = suggest("https://a.test/" + Array.from({ length: 20 }, (_, i) => `seg${i}`).join("/"));
  expect(n.length).toBeLessThan(100);
});

test("an unparseable url still yields a usable name", () => {
  expect(suggest("not a url")).toMatch(/^page-\d{8}-\d{4}$/);
});
