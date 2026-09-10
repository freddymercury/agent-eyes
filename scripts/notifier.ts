#!/usr/bin/env bun
/**
 * The AgentEyes notifier.
 *
 * Nothing wakes an idle agent — not a file changing, not an MCP notification,
 * not a hook. A session runs only when a message is submitted to it. So if
 * anyone is to learn that a capture arrived or that the server died, a separate
 * process has to watch and push.
 *
 * This used to be an agent holding a loop in its head. That is why it vanished
 * with its pane, could not be restarted, and left its config pointing at a
 * target nobody was listening to. It is a program now so it can be started,
 * killed, tested, and — via the heartbeat file — noticed when absent.
 *
 * Delivery is `herdr agent prompt`, which costs the receiver a full turn and
 * lands in its transcript as user input. Every gate below exists because of
 * that: a chatty monitor is expensive and drowns the signal it exists to carry.
 *
 * Usage:
 *   bun run scripts/notifier.ts              # send for real
 *   bun run scripts/notifier.ts --dry-run    # print what it would send
 *   bun run scripts/notifier.ts --once       # one tick, then exit (for tests)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".agenteyes");
const CONFIG_FILE = path.join(DIR, "notify-config.json");
const HEARTBEAT_FILE = path.join(DIR, "notifier.json");
const SERVER_URL = process.env.AGENT_EYES_SERVER ?? "http://127.0.0.1:8765";

const DRY_RUN = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");

/** Every period is in seconds, because that is how the config reads. */
interface Config {
  enabled: boolean;
  target: string;
  pollSeconds: number;
  routineGateSeconds: number;
  signalCooldownSeconds: number;
  criticalCooldownSeconds: number;
  staleWatcherSeconds: number;
  critical: Record<string, boolean>;
  signal: Record<string, boolean>;
  routine: Record<string, boolean>;
}

const DEFAULTS: Config = {
  enabled: true,
  target: "",
  pollSeconds: 5,
  routineGateSeconds: 300,
  // A capture is the thing the user asked to hear about, so it gets a short
  // cooldown of its own rather than sitting behind the routine gate.
  signalCooldownSeconds: 15,
  criticalCooldownSeconds: 60,
  staleWatcherSeconds: 600,
  // Tier by *who caused it*, not by how important it sounds. Anything the user
  // pressed a key for is something they are waiting on, so it goes in `signal`
  // and gets a short cooldown. `routine` is for things that happen on their
  // own, where nobody is standing there wondering if it worked.
  critical: { serverDown: true, serverRecovered: true, watcherStale: true },
  signal: { newCapture: true, newSurface: true, newSnapshot: true },
  routine: { watcherUpdate: false },
};

let config: Config = DEFAULTS;

/**
 * A monitor that goes silent because of a typo looks exactly like a monitor
 * with nothing to report, so a broken config keeps the last good one.
 */
function loadConfig(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    config = {
      ...DEFAULTS,
      ...raw,
      critical: { ...DEFAULTS.critical, ...(raw.critical ?? {}) },
      signal: { ...DEFAULTS.signal, ...(raw.signal ?? {}) },
      routine: { ...DEFAULTS.routine, ...(raw.routine ?? {}) },
    };
  } catch (e) {
    log(`config unreadable, keeping previous (${(e as Error).message})`);
  }
}

function log(msg: string): void {
  console.log(`[notifier ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------- delivery

type Tier = "critical" | "signal" | "routine";

const lastSentAt: Record<Tier, number> = { critical: 0, signal: 0, routine: 0 };
const pending: Record<Tier, string[]> = { critical: [], signal: [], routine: [] };

function gateFor(tier: Tier): number {
  return tier === "critical"
    ? config.criticalCooldownSeconds
    : tier === "signal"
      ? config.signalCooldownSeconds
      : config.routineGateSeconds;
}

function enqueue(tier: Tier, text: string): void {
  pending[tier].push(text);
  log(`queued ${tier}: ${text}`);
}

/**
 * Batch whatever is waiting per tier and deliver it. Batching matters more than
 * it looks: without it, five watcher updates in a second are five turns.
 */
async function flush(): Promise<void> {
  const now = Date.now();
  for (const tier of ["critical", "signal", "routine"] as Tier[]) {
    const items = pending[tier];
    if (!items.length) continue;
    if (now - lastSentAt[tier] < gateFor(tier) * 1000) continue;

    const body = items.length === 1 ? items[0]! : items.map((s) => `• ${s}`).join("\n");
    pending[tier] = [];
    lastSentAt[tier] = now;
    await deliver(`[agenteyes] ${body}`);
  }
}

async function deliver(text: string): Promise<void> {
  if (DRY_RUN) {
    log(`DRY RUN would send -> ${config.target}: ${text}`);
    return;
  }
  if (!config.target) {
    log(`no target configured; dropping: ${text}`);
    return;
  }
  if (!(await targetExists(config.target))) {
    // A dead target is the failure this whole thing exists to catch, so it is
    // worth saying loudly rather than failing to send into the void.
    log(`target ${config.target} is not in herdr agent list; dropping: ${text}`);
    return;
  }
  const proc = Bun.spawn(["herdr", "agent", "prompt", config.target, text], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    log(`herdr prompt failed (exit ${code}): ${await new Response(proc.stderr).text()}`);
  } else {
    log(`sent -> ${config.target}: ${text}`);
  }
}

async function targetExists(target: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["herdr", "agent", "list"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.includes(`"pane_id":"${target}"`);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ events

/**
 * Fire on transitions, not states. A dead server stays dead; reporting the
 * condition means reporting it every tick forever. Each of these tracks the
 * last value and only speaks when it changes.
 */
let serverWasUp: boolean | null = null;
const staleWatchers = new Set<string>();

async function checkServer(): Promise<void> {
  let up = false;
  try {
    const res = await fetch(`${SERVER_URL}/watch`, { signal: AbortSignal.timeout(3000) });
    up = res.ok;
  } catch {
    up = false;
  }
  if (serverWasUp === null) {
    serverWasUp = up;
    log(`server is ${up ? "up" : "DOWN"} at startup`);
    if (!up && config.critical.serverDown) enqueue("critical", "server is down at :8765");
    return;
  }
  if (up !== serverWasUp) {
    serverWasUp = up;
    if (!up && config.critical.serverDown) {
      enqueue("critical", "server went DOWN at :8765 — captures are being lost");
    } else if (up && config.critical.serverRecovered) {
      enqueue("critical", "server is back up at :8765");
    }
  }
}

/**
 * A watcher file is rewritten only when its element changes, so "old" is
 * ambiguous — the page may simply be quiet. This reports crossing the
 * threshold once, and clears when the file moves again.
 */
function checkWatcherStaleness(): void {
  const dir = path.join(DIR, "watch");
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const ageSec = (now - fs.statSync(path.join(dir, f)).mtimeMs) / 1000;
    const isStale = ageSec > config.staleWatcherSeconds;
    if (isStale && !staleWatchers.has(f)) {
      staleWatchers.add(f);
      if (config.critical.watcherStale) {
        enqueue("critical", `watcher "${label(f)}" has not changed in ${Math.round(ageSec / 60)}m — it may be reading a dead element`);
      }
    } else if (!isStale && staleWatchers.has(f)) {
      staleWatchers.delete(f);
      log(`watcher ${f} is live again`);
    }
  }
}

const label = (f: string) => f.replace(/\.json$/, "").split("_").slice(1).join("_") || f;

// ------------------------------------------------------------- fs watching

/**
 * fs.watch fires several times for one write, so collapse by path. Polling the
 * filesystem was never necessary — herdr's own subscription API taught us to
 * stop assuming it was.
 */
const debounce = new Map<string, ReturnType<typeof setTimeout>>();

function onChange(kind: string, file: string): void {
  const key = `${kind}:${file}`;
  clearTimeout(debounce.get(key));
  debounce.set(
    key,
    setTimeout(() => {
      debounce.delete(key);
      report(kind, file);
    }, 300),
  );
}

function report(kind: string, file: string): void {
  if (kind === "capture" && config.signal.newCapture) {
    let detail = "";
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, "context.json"), "utf8"));
      const what = d.elementPicked ? "element" : d.usedSelection ? "selection" : "page";
      detail = ` — ${what} from ${d.title ?? d.url ?? "unknown"} (${(d.text ?? "").length} chars)`;
    } catch {
      // The write may not have landed yet; the event still stands.
    }
    enqueue("signal", `new capture${detail}`);
  } else if (kind === "watcher" && config.routine.watcherUpdate) {
    enqueue("routine", `watcher "${label(file)}" updated`);
  } else if (kind === "snapshot" && config.signal.newSnapshot) {
    enqueue("signal", `new snapshot ${file}`);
  } else if (kind === "surface" && config.signal.newSurface) {
    enqueue("signal", "new interactive-surface scan");
  }
}

function watchPaths(): void {
  const watchDir = (sub: string, kind: string) => {
    const p = path.join(DIR, sub);
    if (!fs.existsSync(p)) return;
    fs.watch(p, (_e, fname) => {
      if (fname && fname.endsWith(".json") && !fname.startsWith(".")) onChange(kind, fname);
    });
    log(`watching ${p}`);
  };

  // context.json is rewritten in place, so watch the parent directory —
  // watching a file that does not exist yet silently never fires.
  fs.watch(DIR, (_e, fname) => {
    if (fname === "context.json") onChange("capture", fname);
    if (fname === "surface.json") onChange("surface", fname);
  });
  log(`watching ${DIR}`);

  watchDir("watch", "watcher");
  watchDir("snapshots", "snapshot");
}

// ---------------------------------------------------------------- lifecycle

function heartbeat(): void {
  fs.writeFileSync(
    HEARTBEAT_FILE,
    JSON.stringify({ pid: process.pid, startedAt, lastTick: new Date().toISOString(), target: config.target, dryRun: DRY_RUN }, null, 2),
  );
}

const startedAt = new Date().toISOString();

async function tick(): Promise<void> {
  loadConfig();
  if (!config.enabled) {
    heartbeat();
    return;
  }
  await checkServer();
  checkWatcherStaleness();
  await flush();
  heartbeat();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    try {
      fs.unlinkSync(HEARTBEAT_FILE);
    } catch {
      // never existed, or already gone
    }
    log("stopped");
    process.exit(0);
  });
}

loadConfig();
log(`starting${DRY_RUN ? " (dry run)" : ""}, target=${config.target || "(none)"}, poll=${config.pollSeconds}s`);
watchPaths();
await tick();

if (!ONCE) {
  setInterval(() => void tick(), Math.max(1, config.pollSeconds) * 1000);
}
