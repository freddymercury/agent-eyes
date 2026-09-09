import { beforeAll, beforeEach, expect, test } from "bun:test";

let install: (limit: number) => boolean;
let read: (clear: boolean) => any;

beforeAll(async () => {
  const src = await Bun.file(`${import.meta.dir}/../background.js`).text();
  const start = src.indexOf("function installTelemetry(");
  const end = src.indexOf("// ---- watch kit:");
  const mod = new Function(`${src.slice(start, end)}; return { installTelemetry, readTelemetry };`)();
  const g = globalThis as any;
  g.window = g;
  g.addEventListener = () => {};
  install = mod.installTelemetry;
  read = mod.readTelemetry;
});

// installTelemetry is idempotent by design, so each test needs a clean realm.
beforeEach(() => {
  (globalThis as any).__agentEyesTelemetry = undefined;
});

test("console calls are captured and still reach the real console", () => {
  const seen: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => seen.push(String(a[0]));
  install(200);
  console.log("hello", { a: 1 });
  console.log = original;

  const t = read(true);
  expect(t.installed).toBe(true);
  expect(t.console[0].level).toBe("log");
  expect(t.console[0].args[0]).toBe("hello");
  // Patching must not swallow output — the page's own logging keeps working.
  expect(seen).toContain("hello");
});

test("fetch is recorded with method, status and duration", async () => {
  const g = globalThis as any;
  g.fetch = async () => ({ status: 204 });
  install(200);
  await g.fetch("https://api.test/thing", { method: "POST" });

  const t = read(true);
  const call = t.network.find((n: any) => n.url.includes("api.test"));
  expect(call.method).toBe("POST");
  expect(call.status).toBe(204);
  expect(typeof call.ms).toBe("number");
});

test("a failed fetch is recorded and the error still propagates", async () => {
  const g = globalThis as any;
  g.fetch = async () => { throw new Error("network down"); };
  install(200);
  await expect(g.fetch("https://api.test/fail")).rejects.toThrow("network down");

  const t = read(true);
  const call = t.network.find((n: any) => n.url.includes("api.test"));
  expect(call.status).toBe(0);
  expect(call.error).toContain("network down");
});

test("the buffer is bounded, keeping the most recent", () => {
  // Silence *before* installing: replacing console.log afterwards would
  // overwrite the hook rather than quieten it.
  const original = console.log;
  console.log = () => {};
  install(5);
  for (let i = 0; i < 20; i++) console.log(`line ${i}`);
  console.log = original;

  const t = read(true);
  // A page that logs in a loop must not grow this without bound.
  expect(t.console).toHaveLength(5);
  expect(t.console[4].args[0]).toBe("line 19");
});

test("unserialisable arguments do not break capture", () => {
  const original = console.log;
  console.log = () => {};
  install(200);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  console.log(cyclic);
  console.log = original;

  const t = read(true);
  expect(t.console[0].args[0]).toBe("[unserialisable]");
});

test("reading clears the buffer only when asked", () => {
  (globalThis as any).__agentEyesTelemetry = undefined;
  const original = console.log;
  console.log = () => {};
  install(200);
  console.log("kept");
  console.log = original;

  expect(read(false).console).toHaveLength(1);
  expect(read(false).console).toHaveLength(1);
  expect(read(true).console).toHaveLength(1);
  expect(read(false).console).toHaveLength(0);
});
