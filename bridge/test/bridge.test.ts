import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let root: string;
let watchDir: string;
let client: Client;

const writeWatcher = (id: string, label: string, text: string, extra: Record<string, unknown> = {}) =>
  writeFile(
    join(watchDir, `${id}_${label.replace(/\s+/g, "-")}.json`),
    JSON.stringify({
      watchId: id, label, title: "Test Page", url: "https://example.test/app",
      selector: "div#main", text, capturedAt: new Date().toISOString(), ...extra,
    }),
  );

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agenteyes-test-"));
  watchDir = join(root, "watch");
  await mkdir(watchDir, { recursive: true });
  await writeWatcher("w1", "available players", "Alpha\nBravo");

  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [join(import.meta.dir, "..", "src", "index.ts")],
      env: { ...process.env, AGENT_EYES_DIR: root },
    }),
  );
});

afterAll(async () => {
  await client.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

test("AC1: tools are listed and staleness never throws", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain("agent_eyes_get_context");
  expect(names).toContain("agent_eyes_get_surface");
  expect(names).toContain("agent_eyes_get_staleness");
  // read mode must not advertise a write capability
  expect(names).not.toContain("agent_eyes_invoke_action");
});

test("AC2: a registered watcher is listed and readable", async () => {
  const list = await client.callTool({ name: "agent_eyes_list_watchpoints", arguments: {} });
  const text = (list.content as Array<{ text: string }>)[0]!.text;
  expect(text).toContain("available players");

  const res = await client.readResource({ uri: "agenteyes://watch/w1" });
  expect((res.contents[0] as { text: string }).text).toContain("Alpha");
});

test("get_surface reports completeness so empty actions are not misread", async () => {
  const out = await client.callTool({ name: "agent_eyes_get_surface", arguments: {} });
  const snap = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  expect(snap.completeness).toBe("text-only");
  expect(snap.actions).toEqual([]);
  expect(snap.watchpoints).toHaveLength(1);
});

test("AC3: subscribers are notified when watched text changes", async () => {
  const seen: string[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/resources/updated") {
      seen.push((n.params as { uri: string }).uri);
    }
  };
  await client.subscribeResource({ uri: "agenteyes://watch/w1" });

  await writeWatcher("w1", "available players", "Alpha\nBravo\nCharlie");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !seen.some((u) => u.includes("watch/w1"))) {
    await Bun.sleep(200);
  }
  expect(seen.some((u) => u.includes("watch/w1"))).toBe(true);
});

test("AC5: a watcher whose element vanished is reported not alive", async () => {
  await writeWatcher("w2", "roster", "gone", { alive: false });
  const out = await client.callTool({ name: "agent_eyes_get_watchpoint", arguments: { id: "w2" } });
  const state = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  expect(state.alive).toBe(false);
});

test("AC4: removing a watcher retires it (tombstone honoured)", async () => {
  await writeWatcher("w3", "temp", "here");
  let out = await client.callTool({ name: "agent_eyes_list_watchpoints", arguments: {} });
  expect((out.content as Array<{ text: string }>)[0]!.text).toContain("temp");

  // the extension POSTs a tombstone rather than deleting the file
  await writeWatcher("w3", "temp", "", { removed: true });
  out = await client.callTool({ name: "agent_eyes_list_watchpoints", arguments: {} });
  expect((out.content as Array<{ text: string }>)[0]!.text).not.toContain("temp");
});

test("AC6 regression: the bridge never mutates the capture directory", async () => {
  const { readdir, stat } = await import("node:fs/promises");
  const snapshot = async () => {
    const files = (await readdir(watchDir)).sort();
    const out: Record<string, number> = {};
    for (const f of files) out[f] = (await stat(join(watchDir, f))).mtimeMs;
    return out;
  };
  const before = await snapshot();

  // exercise every read path
  for (const name of [
    "agent_eyes_get_context",
    "agent_eyes_get_surface",
    "agent_eyes_get_staleness",
    "agent_eyes_list_watchpoints",
    "agent_eyes_get_text",
  ]) {
    await client.callTool({ name, arguments: {} });
  }
  await client.readResource({ uri: "agenteyes://watch" });
  await client.readResource({ uri: "agenteyes://context" });

  // The file interface is a public contract other tools read directly; the
  // bridge is strictly an additional reader of it.
  expect(await snapshot()).toEqual(before);
});

test("AC7: reports staleness rather than crashing with no captures at all", async () => {
  const { rm: rmFile, readdir } = await import("node:fs/promises");
  for (const f of await readdir(watchDir)) await rmFile(join(watchDir, f));
  const out = await client.callTool({ name: "agent_eyes_get_staleness", arguments: {} });
  const st = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  expect(st.reason).toBe("no_capture");
  expect(st.stale).toBe(true);
});
