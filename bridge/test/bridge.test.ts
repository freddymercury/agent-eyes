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

const writeSurface = (actions: unknown[]) =>
  writeFile(
    join(root, "surface.json"),
    JSON.stringify({
      kind: "surface", title: "Test Page", url: "https://example.test/app",
      capturedAt: new Date().toISOString(), actions,
      stats: { nodesVisited: 120, actionsFound: actions.length, durationMs: 8,
               truncated: false, shadowRootsTraversed: 0, iframesSkipped: 1 },
    }),
  );

test("F2: list_actions explains itself when no scan has been taken", async () => {
  const out = await client.callTool({ name: "agent_eyes_list_actions", arguments: {} });
  const r = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  // An empty list would be indistinguishable from "this page has no actions".
  expect(r.error).toContain("no surface scan");
  expect(r.hint).toContain("Cmd+Shift+U");
});

test("F2: scanned actions are listed and filterable by confidence", async () => {
  await writeSurface([
    { id: "a0", label: "Save", kind: "activate", confidence: 0.95,
      evidence: { nativeDom: true }, enabled: true,
      domExposure: { domPath: "body > button", tagName: "button" } },
    { id: "a1", label: "Styled only", kind: "activate", confidence: 0.15,
      evidence: { pointerCursor: true }, enabled: true,
      domExposure: { domPath: "body > div", tagName: "div" } },
  ]);

  let out = await client.callTool({ name: "agent_eyes_list_actions", arguments: {} });
  let r = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  expect(r.actions).toHaveLength(2);
  expect(r.stats.iframesSkipped).toBe(1);

  out = await client.callTool({ name: "agent_eyes_list_actions", arguments: { minConfidence: 0.5 } });
  r = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  expect(r.actions).toHaveLength(1);
  expect(r.actions[0].label).toBe("Save");
});

test("F2: completeness flips to dom-actions only once a scan exists", async () => {
  const out = await client.callTool({ name: "agent_eyes_get_surface", arguments: {} });
  const snap = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
  expect(snap.completeness).toBe("dom-actions");
  expect(snap.actions.length).toBeGreaterThan(0);
  expect(snap.scanStats.nodesVisited).toBe(120);
});

test("F4: snapshots are listed and readable through the bridge", async () => {
  const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
  const snapDir = join(root, "snapshots");
  await mk(snapDir, { recursive: true });
  await wf(
    join(snapDir, "snap-one.json"),
    JSON.stringify({
      schemaVersion: 1,
      meta: {
        id: "snap-one", name: "before release", createdAt: "2026-09-09T10:00:00Z",
        url: "https://example.test/app", title: "App", completeness: "dom-actions",
        health: { actions: 12, positionalRate: 0.05, ordinalRate: 0.1, lowConfidenceRate: 0, truncated: false },
        release: { version: "1.4.0" },
      },
      snapshot: { schemaVersion: 1, id: "s", context: {}, completeness: "dom-actions", actions: [], webmcpTools: [], watchpoints: [] },
    }),
  );

  const list = await client.callTool({ name: "agent_eyes_list_snapshots", arguments: {} });
  const metas = JSON.parse((list.content as Array<{ text: string }>)[0]!.text);
  expect(metas).toHaveLength(1);
  expect(metas[0].name).toBe("before release");
  expect(metas[0].release.version).toBe("1.4.0");

  const one = await client.callTool({ name: "agent_eyes_get_snapshot", arguments: { id: "snap-one" } });
  expect((one.content as Array<{ text: string }>)[0]!.text).toContain("before release");

  const res = await client.readResource({ uri: "agenteyes://snapshots/snap-one" });
  expect((res.contents[0] as { text: string }).text).toContain("dom-actions");
});

test("F4: a bad snapshot id is refused rather than traversing the filesystem", async () => {
  const out = await client.callTool({ name: "agent_eyes_get_snapshot", arguments: { id: "../../context" } });
  expect((out.content as Array<{ text: string }>)[0]!.text).toContain("no snapshot");
});

test("F4: comparability warnings surface through the bridge", async () => {
  const out = await client.callTool({
    name: "agent_eyes_check_comparable",
    arguments: { a: "snap-one", b: "missing" },
  });
  expect((out.content as Array<{ text: string }>)[0]!.text).toContain("no snapshot");
});
