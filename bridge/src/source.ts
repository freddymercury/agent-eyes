import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Action,
  ScanStats,
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
        target: { selector: d.selector },
        observe: ["text"],
      },
      state: {
        watchpointId: id,
        contentHash: contentHash(text),
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

export async function readStaleness(staleAfterSeconds: number): Promise<SurfaceStaleness> {
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
