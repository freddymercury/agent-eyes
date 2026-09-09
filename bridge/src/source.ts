import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { snapshotHealth } from "@agent-eyes/protocol";
import type {
  Action,
  Expectation,
  ObserveMode,
  ObservedHashes,
  ScanStats,
  SnapshotMeta,
  StoredSnapshot,
  SurfaceContext,
  SurfaceStaleness,
  WatchpointDescriptor,
  WatchpointState,
} from "@agent-eyes/protocol";

// Overridable so tests (and side-by-side instances) never touch the real
// capture directory.
export const AGENTEYES_DIR = process.env.AGENT_EYES_DIR ?? join(homedir(), ".agenteyes");
export const WATCH_DIR = join(AGENTEYES_DIR, "watch");
export const CONTEXT_FILE = join(AGENTEYES_DIR, "context.json");
export const SURFACE_FILE = join(AGENTEYES_DIR, "surface.json");
export const SNAP_DIR = join(AGENTEYES_DIR, "snapshots");
// Overridable alongside AGENT_EYES_DIR: with only the directory configurable,
// a bridge pointed at a temp dir would still write through to the real store.
export const SERVER_URL = process.env.AGENT_EYES_SERVER ?? "http://127.0.0.1:8765";

/** Shape the extension POSTs and the server persists. */
interface WatcherFile {
  watchId?: string;
  label?: string;
  title?: string;
  url?: string;
  text?: string;
  selector?: string;
  capturedAt?: string;
  /** Added by the extension in P1.4; absent on older captures. */
  revision?: number;
  alive?: boolean;
  removed?: boolean;
  role?: string;
  accessibleName?: string;
  tabId?: number;
  tabUrl?: string;
  tabTitle?: string;
  expectation?: Expectation;
  observe?: ObserveMode[];
  hashes?: ObservedHashes;
}

export interface Watcher {
  id: string;
  descriptor: WatchpointDescriptor;
  state: WatchpointState;
  url: string;
  title: string;
}

/** djb2 — we only need "did this change", not cryptographic strength. */
export function contentHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const ageOf = (iso?: string) =>
  iso && !Number.isNaN(Date.parse(iso)) ? (Date.now() - Date.parse(iso)) / 1000 : Number.POSITIVE_INFINITY;

export async function readWatchers(): Promise<Watcher[]> {
  let files: string[];
  try {
    files = (await readdir(WATCH_DIR)).filter((f) => f.endsWith(".json") && f !== "latest.json");
  } catch {
    return [];
  }

  const out: Watcher[] = [];
  for (const f of files) {
    let d: WatcherFile;
    try {
      d = (await Bun.file(join(WATCH_DIR, f)).json()) as WatcherFile;
    } catch {
      continue; // a half-written file is not an error worth surfacing
    }
    if (d.removed) continue;
    const id = d.watchId ?? f.replace(/\.json$/, "");
    const text = d.text ?? "";
    out.push({
      id,
      url: d.url ?? "",
      title: d.title ?? "",
      descriptor: {
        id,
        name: d.label ?? id,
        page: { handle: d.tabId, url: d.tabUrl ?? d.url, title: d.tabTitle ?? d.title },
        target: { selector: d.selector, role: d.role, accessibleName: d.accessibleName },
        observe: d.observe?.length ? d.observe : ["text"],
        expectation: d.expectation,
      },
      state: {
        watchpointId: id,
        contentHash: contentHash(text),
        hashes: d.hashes,
        text,
        capturedAt: d.capturedAt ?? "",
        ageSeconds: Math.round(ageOf(d.capturedAt)),
        // Older captures predate the `alive` flag; assume alive rather than
        // reporting a stale element as dead.
        alive: d.alive ?? true,
      },
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Newest watcher wins; falls back to the on-demand capture. */
export async function readContext(): Promise<SurfaceContext | null> {
  const watchers = await readWatchers();
  const freshest = watchers
    .filter((w) => w.state.capturedAt)
    .sort((a, b) => a.state.ageSeconds - b.state.ageSeconds)[0];
  if (freshest) {
    return { url: freshest.url, title: freshest.title, capturedAt: freshest.state.capturedAt };
  }
  try {
    const c = (await Bun.file(CONTEXT_FILE).json()) as WatcherFile;
    return { url: c.url ?? "", title: c.title ?? "", capturedAt: c.capturedAt ?? "" };
  } catch {
    return null;
  }
}

/**
 * Ask the server whether the watchers are stale.
 *
 * The server already sweeps and already publishes a threshold, so it is the
 * one place that knows. Recomputing here produced two answers to the same
 * question with different thresholds — 30s in the bridge, 60s in the server,
 * 10 minutes in draft-drift, none in the popup — which is exactly how a frozen
 * watcher went on driving advice for five rounds of a live draft.
 *
 * Falls back to local computation when the server is unreachable, since a
 * bridge that cannot answer at all is worse than one answering approximately.
 */
async function serverStaleness(): Promise<{ staleAfterSeconds: number; watchers: Array<{ ageSeconds: number; stale: boolean }> } | null> {
  try {
    const res = await fetch(`${SERVER_URL}/watch`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as { staleAfterSeconds: number; watchers: Array<{ ageSeconds: number; stale: boolean }> };
  } catch {
    return null;
  }
}

export async function readStaleness(fallbackSeconds: number): Promise<SurfaceStaleness> {
  const fromServer = await serverStaleness();
  if (fromServer && fromServer.watchers.length) {
    const staleAfterSeconds = fromServer.staleAfterSeconds;
    const age = Math.min(...fromServer.watchers.map((w) => w.ageSeconds));
    const allStale = fromServer.watchers.every((w) => w.stale);
    return {
      ageSeconds: age,
      stale: allStale,
      staleAfterSeconds,
      reason: allStale ? "age" : undefined,
    };
  }

  const staleAfterSeconds = fromServer?.staleAfterSeconds ?? fallbackSeconds;
  const watchers = await readWatchers();
  if (!watchers.length) {
    const ctx = await readContext();
    if (!ctx) {
      return { ageSeconds: -1, stale: true, staleAfterSeconds, reason: "no_capture" };
    }
    const age = Math.round(ageOf(ctx.capturedAt));
    return { ageSeconds: age, stale: age > staleAfterSeconds, staleAfterSeconds, reason: "age" };
  }
  const age = Math.min(...watchers.map((w) => w.state.ageSeconds));
  // Every watcher losing its element means the tab went away, which is a
  // different problem from a page that simply has not changed.
  const allDead = watchers.every((w) => !w.state.alive);
  return {
    ageSeconds: age,
    stale: allDead || age > staleAfterSeconds,
    staleAfterSeconds,
    reason: allDead ? "tab_closed" : age > staleAfterSeconds ? "age" : undefined,
  };
}

export interface SurfaceScan {
  actions: Action[];
  stats: ScanStats;
  url: string;
  title: string;
  capturedAt: string;
  ageSeconds: number;
}

/**
 * The most recent interactive-surface scan, if one has been taken.
 *
 * Scans are explicit and on-demand — unlike watchers, nothing refreshes this
 * automatically, so age matters more here and is always reported.
 */
export async function readSurfaceScan(): Promise<SurfaceScan | null> {
  try {
    const d = (await Bun.file(SURFACE_FILE).json()) as {
      actions?: Action[];
      stats?: ScanStats;
      url?: string;
      title?: string;
      capturedAt?: string;
    };
    if (!d.actions) return null;
    return {
      actions: d.actions,
      stats: d.stats ?? {
        nodesVisited: 0,
        actionsFound: d.actions.length,
        durationMs: 0,
        truncated: false,
        shadowRootsTraversed: 0,
        iframesSkipped: 0,
      },
      url: d.url ?? "",
      title: d.title ?? "",
      capturedAt: d.capturedAt ?? "",
      ageSeconds: Math.round(ageOf(d.capturedAt)),
    };
  } catch {
    return null;
  }
}

/** Raw text for one watcher, or the whole most recent capture. */
export async function readText(watchId?: string): Promise<string | null> {
  if (watchId) {
    const w = (await readWatchers()).find((x) => x.id === watchId);
    return w ? w.state.text : null;
  }
  const watchers = await readWatchers();
  if (watchers.length) {
    return watchers.sort((a, b) => a.state.ageSeconds - b.state.ageSeconds)[0]!.state.text;
  }
  try {
    return ((await Bun.file(CONTEXT_FILE).json()) as WatcherFile).text ?? null;
  } catch {
    return null;
  }
}


// --- snapshots ---------------------------------------------------------------

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  let files: string[];
  try {
    files = (await readdir(SNAP_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SnapshotMeta[] = [];
  for (const f of files) {
    try {
      out.push(((await Bun.file(join(SNAP_DIR, f)).json()) as StoredSnapshot).meta);
    } catch {
      // a half-written file should not break the listing
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readSnapshot(id: string): Promise<StoredSnapshot | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    return (await Bun.file(join(SNAP_DIR, `${id}.json`)).json()) as StoredSnapshot;
  } catch {
    return null;
  }
}

/**
 * Persist the current surface.
 *
 * Goes through the server rather than writing the file directly, so id
 * generation and the on-disk layout have exactly one owner.
 */
export async function saveSnapshot(
  name: string,
  release?: SnapshotMeta["release"],
  notes?: string,
): Promise<{ ok: boolean; meta?: SnapshotMeta; error?: string }> {
  const [fallbackCtx, watchers, scan] = await Promise.all([
    readContext(),
    readWatchers(),
    readSurfaceScan(),
  ]);

  // The scan is what is being snapshotted, so its page identifies the snapshot.
  // Taking the url from the freshest watcher or from context.json instead can
  // record a page that has nothing to do with the actions stored alongside it,
  // which would make two snapshots look like the same page — or different ones
  // — on evidence that never matched their contents.
  const ctx = scan
    ? { url: scan.url, title: scan.title, capturedAt: scan.capturedAt }
    : fallbackCtx;
  if (!ctx) return { ok: false, error: "nothing captured yet — scan or watch a page first" };

  const actions = scan?.actions ?? [];
  const meta = {
    name,
    url: ctx.url,
    title: ctx.title,
    completeness: scan ? ("dom-actions" as const) : ("text-only" as const),
    health: snapshotHealth(actions, scan?.stats.truncated ?? false),
    release,
    notes,
  };
  const snapshot = {
    schemaVersion: 1 as const,
    id: `surface-${Date.now()}`,
    context: ctx,
    completeness: meta.completeness,
    actions,
    webmcpTools: [],
    watchpoints: watchers.map((w) => w.state),
    text: (await readText()) ?? undefined,
    scanStats: scan?.stats,
  };

  try {
    const res = await fetch(`${SERVER_URL}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta, snapshot }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok: boolean; meta?: SnapshotMeta; error?: string };
    return res.ok ? { ok: true, meta: body.meta } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `cannot reach the AgentEyes server: ${(e as Error).message}` };
  }
}


// --- watchpoint baselines ----------------------------------------------------

export const BASELINE_FILE = join(AGENTEYES_DIR, "watch-baseline.json");

export interface Baseline {
  markedAt: string;
  watchpoints: Record<string, ObservedHashes>;
}

export async function readBaseline(): Promise<Baseline | null> {
  try {
    return (await Bun.file(BASELINE_FILE).json()) as Baseline;
  } catch {
    return null;
  }
}

/** Record what every watchpoint looks like now, as the thing to compare against. */
export async function markBaseline(): Promise<{ ok: boolean; count: number; markedAt?: string; error?: string }> {
  const watchers = await readWatchers();
  const payload: Record<string, ObservedHashes> = {};
  for (const w of watchers) payload[w.id] = w.state.hashes ?? { text: w.state.contentHash };
  try {
    const res = await fetch(`${SERVER_URL}/watch/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { markedAt?: string; error?: string };
    return res.ok
      ? { ok: true, count: watchers.length, markedAt: body.markedAt }
      : { ok: false, count: 0, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, count: 0, error: `cannot reach the AgentEyes server: ${(e as Error).message}` };
  }
}
