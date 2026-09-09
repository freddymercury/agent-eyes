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
  /** Structural path. NOT a stable identity — that is F3. */
  domPath: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
}

export interface Action {
  /**
   * Positional and NOT stable across releases. F2 deliberately ships unstable
   * ids so that discovery can be judged before identity is solved; nothing
   * compares two captures yet.
   */
  id: string;
  label: string;
  kind: ActionKind;
  evidence: ActionEvidence;
  domExposure: DomExposure;
  enabled?: boolean;
  /** 0-1, derived from the evidence combination. */
  confidence: number;
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
export const URI_WATCH_LIST = "agenteyes://watch";
export const watchUri = (id: string) => `agenteyes://watch/${id}`;
export const parseWatchUri = (uri: string): string | null =>
  /^agenteyes:\/\/watch\/(.+)$/.exec(uri)?.[1] ?? null;
