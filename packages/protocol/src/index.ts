/**
 * Agent Eyes — public domain protocol.
 *
 * This package is the integration contract. It must stay free of Chrome
 * concepts (tab ids, port names, execution contexts) so that harnesses never
 * depend on how observation happens to be implemented.
 */

export const PROTOCOL_VERSION = 1;

/** How much of the surface this build was actually able to see. */
export type SurfaceCompleteness = "text-only" | "dom-actions" | "dom+webmcp";

export interface SurfaceContext {
  url: string;
  title: string;
  routeKey?: string;
  capturedAt: string;
  /** Present for shape stability; not inferable before Phase 2. */
  release?: { version?: string; commitSha?: string; buildId?: string; environment?: string };
  principal?: { authState: "anonymous" | "authenticated" | "unknown" };
}

export interface WatchpointDescriptor {
  id: string;
  name: string;
  target: { selector?: string };
  observe: Array<"text">;
  expectation?: "changes" | "stable";
}

export interface WatchpointState {
  watchpointId: string;
  /**
   * Content hash — NOT the semantic surface fingerprint. Two different words
   * for two different guarantees; see docs/fingerprint-options.md.
   */
  contentHash: string;
  text: string;
  capturedAt: string;
  ageSeconds: number;
  /** False when the element's selector stopped matching (page re-rendered). */
  alive: boolean;
}

export interface SurfaceStaleness {
  ageSeconds: number;
  stale: boolean;
  staleAfterSeconds: number;
  reason?: "no_capture" | "tab_closed" | "age";
}

export type ActionKind =
  | "activate"
  | "input"
  | "navigate"
  | "submit"
  | "select"
  | "toggle"
  | "other";

/**
 * Why we believe this element is interactive.
 *
 * Kept as separate signals rather than collapsed into a boolean because they
 * disagree in practice: a native <button> is interactive with no listener at
 * all, while a clickable <div> has no semantics to detect. Confidence is
 * derived from the combination, and the caller can see what it was derived
 * from.
 */
export interface ActionEvidence {
  /** A natively interactive element: button, a[href], input, select… */
  nativeDom?: boolean;
  /** An explicit ARIA interactive role. */
  accessibility?: boolean;
  /** An inline handler attribute. Listeners added via addEventListener are
   *  NOT detectable from an extension content script — see docs. */
  inlineHandler?: boolean;
  /** Focusable via tabindex. */
  focusable?: boolean;
  /** Styled as clickable (cursor: pointer). Weakest signal. */
  pointerCursor?: boolean;
}

export interface DomExposure {
  /** Structural path. Diagnostic only — never used for identity. */
  domPath: string;
  /** Chain of ancestor roles; survives wrapper elements being introduced. */
  roleAncestorPath?: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
}

/**
 * How an action's id was derived, in descending order of durability.
 *
 * `positional` ids are expected to churn across releases and should be treated
 * as unreliable for comparison — surfacing this is the point.
 */
export type IdentityStrategy = "testid" | "semantic" | "positional";

export interface Action {
  /** Hash of `identityKey`. Stability depends on `identityStrategy`. */
  id: string;
  identityStrategy: IdentityStrategy;
  /**
   * True when an ordinal was needed to tell this apart from a sibling with the
   * same key. Such ids depend on document order and churn when a list
   * reorders — regardless of which strategy produced them.
   */
  ordinalDisambiguated?: boolean;
  /** The human-readable input the id was hashed from, for debugging churn. */
  identityKey: string;
  label: string;
  kind: ActionKind;
  evidence: ActionEvidence;
  domExposure: DomExposure;
  enabled?: boolean;
  /** 0-1, derived from the evidence combination: is this interactive? */
  confidence: number;
  /** The outermost landmark this action sits in, if the page declares one. */
  landmark?: string;
  /**
   * 0-1 structural importance: does this matter on this page?
   *
   * Separate from confidence on purpose. A footer link is unambiguously
   * interactive and unambiguously not the point of the page, and collapsing
   * both into one number makes each harder to reason about.
   */
  prominence?: number;
}

/** Reported alongside a scan so slow pages are visible rather than mysterious. */
export interface ScanStats {
  nodesVisited: number;
  actionsFound: number;
  durationMs: number;
  truncated: boolean;
  shadowRootsTraversed: number;
  /** Same-origin iframes are deliberately not traversed; see docs. */
  iframesSkipped: number;
}

export interface WebMcpExposure {
  toolName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface SurfaceSnapshot {
  schemaVersion: 1;
  id: string;
  context: SurfaceContext;
  /**
   * Without this a harness cannot tell "no actions on this page" from "this
   * build cannot see actions", and would confidently report the wrong thing.
   */
  completeness: SurfaceCompleteness;
  /** Absent until Phase 2 — see docs/fingerprint-options.md. */
  surfaceFingerprint?: string;
  actions: Action[];
  webmcpTools: WebMcpExposure[];
  watchpoints: WatchpointState[];
  text?: string;
  scanStats?: ScanStats;
}

/**
 * How trustworthy a snapshot's identity is.
 *
 * Stored with every snapshot because a comparison is only meaningful between
 * snapshots of similar quality. Diffing a page that was 85% ordinal-dependent
 * against one that was 5% produces noise, and F5 needs to be able to say so
 * rather than presenting the result as fact.
 */
export interface SnapshotHealth {
  actions: number;
  /** Share 0-1 whose ids fall back to DOM position. */
  positionalRate: number;
  /** Share 0-1 needing an ordinal, whatever their strategy. */
  ordinalRate: number;
  /** Share 0-1 detected only from cursor styling. */
  lowConfidenceRate: number;
  /** True when the node budget stopped the scan early. */
  truncated: boolean;
}

export interface SnapshotMeta {
  id: string;
  /** Human-chosen name. Not unique; the id is. */
  name: string;
  createdAt: string;
  url: string;
  title: string;
  completeness: SurfaceCompleteness;
  health: SnapshotHealth;
  release?: { version?: string; commitSha?: string; buildId?: string; environment?: string };
  notes?: string;
}

export interface StoredSnapshot {
  schemaVersion: 1;
  meta: SnapshotMeta;
  snapshot: SurfaceSnapshot;
}

/** Derive the health summary from a snapshot's actions. */
export function snapshotHealth(actions: Action[], truncated = false): SnapshotHealth {
  const n = actions.length;
  const rate = (k: number) => (n ? Math.round((k / n) * 1000) / 1000 : 0);
  return {
    actions: n,
    positionalRate: rate(actions.filter((a) => a.identityStrategy === "positional").length),
    ordinalRate: rate(actions.filter((a) => a.ordinalDisambiguated).length),
    lowConfidenceRate: rate(actions.filter((a) => a.confidence < 0.3).length),
    truncated,
  };
}

/**
 * Whether two snapshots can be meaningfully compared.
 *
 * Returns the reasons they cannot, rather than a boolean, so a caller can show
 * them instead of silently proceeding.
 */
export function comparabilityWarnings(a: SnapshotMeta, b: SnapshotMeta): string[] {
  const w: string[] = [];
  if (a.completeness !== b.completeness) {
    w.push(`different completeness: ${a.completeness} vs ${b.completeness}`);
  }
  if (a.url !== b.url) w.push(`different url: ${a.url} vs ${b.url}`);
  for (const [label, key] of [
    ["positional", "positionalRate"],
    ["ordinal-dependent", "ordinalRate"],
  ] as const) {
    const x = a.health[key];
    const y = b.health[key];
    if (Math.max(x, y) > 0.25 && Math.abs(x - y) > 0.15) {
      w.push(`${label} rate differs sharply: ${(x * 100).toFixed(0)}% vs ${(y * 100).toFixed(0)}%`);
    }
  }
  if (a.health.truncated || b.health.truncated) w.push("a scan was truncated; its inventory is partial");
  return w;
}

export type CapabilityMode = "read" | "readwrite";

export interface BridgeConfig {
  mode: CapabilityMode;
  writeAllowedOrigins: string[];
  confirmWrites: boolean;
  staleAfterSeconds: number;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  mode: "read",
  writeAllowedOrigins: ["http://localhost", "https://localhost", "file://"],
  confirmWrites: true,
  staleAfterSeconds: 30,
};

// --- resource URIs -----------------------------------------------------------

export const URI_CONTEXT = "agenteyes://context";
export const URI_ACTIONS = "agenteyes://actions";
export const URI_SNAPSHOTS = "agenteyes://snapshots";
export const snapshotUri = (id: string) => `agenteyes://snapshots/${id}`;
export const URI_WATCH_LIST = "agenteyes://watch";
export const watchUri = (id: string) => `agenteyes://watch/${id}`;
export const parseWatchUri = (uri: string): string | null =>
  /^agenteyes:\/\/watch\/(.+)$/.exec(uri)?.[1] ?? null;
