import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * The picker and iframes.
 *
 * An iframe is a separate document, so a top-frame-only picker never receives
 * its mouse events: the highlight froze on the <iframe> box and the click was
 * consumed by the frame. Nothing was sent, nothing was logged, and it read as
 * flakiness rather than as a boundary.
 *
 * Injection now targets allFrames, so reachable frames handle their own clicks.
 * These tests cover what happens for the frames that remain unreachable —
 * cross-origin without host permission, or sandboxed without allow-scripts —
 * where the only honest behaviour is to say so.
 */

let win: Window | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

async function mountPicker(mode?: string) {
  win = new Window({ url: "https://example.test/p" });
  const doc = win.document;
  doc.title = "Frame fixture";
  doc.body.innerHTML = `
    <button id="ok">Real button</button>
    <iframe id="embed" src="https://other.test/widget"></iframe>
  `;

  const sent: any[] = [];
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.location = { href: "https://example.test/p" };
  g.chrome = { runtime: { sendMessage: (m: any) => sent.push(m) } };

  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function startElementPicker(");
  const end = src.indexOf("function scanSurface(");
  const startElementPicker = new Function(
    `${src.slice(start, end)}; return startElementPicker;`,
  )();
  startElementPicker(mode);
  return { doc, sent };
}

/** happy-dom has no layout, so give every element a box to highlight. */
function boxed(el: any) {
  el.getBoundingClientRect = () => ({ left: 0, top: 20, width: 100, height: 40 });
  return el;
}

function hover(doc: any, el: any) {
  boxed(el);
  el.dispatchEvent(new (globalThis as any).window.MouseEvent("mousemove", { bubbles: true, composed: true }));
}

test("hovering an unreachable frame says so instead of naming the element", async () => {
  const { doc } = await mountPicker();
  hover(doc, doc.getElementById("embed"));

  const label = [...doc.documentElement.querySelectorAll("div")].pop() as any;
  expect(label.textContent).toContain("cannot see inside");
  expect(label.textContent).not.toContain("iframe#embed");
});

test("hovering a normal element names it as before", async () => {
  const { doc } = await mountPicker();
  hover(doc, doc.getElementById("ok"));

  const label = [...doc.documentElement.querySelectorAll("div")].pop() as any;
  expect(label.textContent).toContain("button");
  expect(label.textContent).not.toContain("cannot see inside");
});

test("picking an unreachable frame reports why, and names the src", async () => {
  const { doc, sent } = await mountPicker();
  const frame = doc.getElementById("embed");
  hover(doc, frame);
  frame.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true, composed: true }));

  expect(sent).toHaveLength(1);
  const w = sent[0].data.warnings.join(" ");
  // The user must be able to tell "this frame is unreadable" from "this
  // element is empty" — before, both produced an empty capture and silence.
  expect(w).toContain("could not inject");
  expect(w).toContain("https://other.test/widget");
});

test("the worker can cancel this frame's picker from outside", async () => {
  const { doc } = await mountPicker();
  // Escape only ever reaches the focused frame, so cancellation has to be
  // reachable from the service worker for every other frame in the tab.
  expect(typeof (globalThis as any).window.__agenteyesPickerCancel).toBe("function");

  (globalThis as any).window.__agenteyesPickerCancel();
  expect((globalThis as any).window.__agenteyesPickerCancel).toBeNull();
  expect((globalThis as any).window.__agenteyesPickerActive).toBe(false);
});

test("a capture records whether it came from a subframe", async () => {
  const { doc, sent } = await mountPicker();
  const btn = doc.getElementById("ok");
  hover(doc, btn);
  btn.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true, composed: true }));

  expect(sent).toHaveLength(1);
  // false here because the fixture is a top-level document; the field existing
  // at all is what keeps an embedded widget's capture distinguishable from its
  // host's once allFrames is in play.
  expect(sent[0].data.inFrame).toBe(false);
});
