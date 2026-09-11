import type { TerminalDimensionsWire, Unsubscribe } from '@kangentic/protocol';

/**
 * Per-session raw PTY buffering, deliberately NOT a Zustand store: chunks
 * arrive every ~50ms while an agent streams, and raw ANSI bytes are not
 * renderable React state - pushing each chunk through a store would
 * re-render subscribers on every chunk. Consumers (the conversation
 * live-tail glue and the xterm WebView pane) mount with getBufferedData()
 * and then attach subscribeChunks() for the live tail.
 *
 * Only RETAINED sessions buffer anything: triage subscribes read-stream for
 * every live session (it needs activity), and the terminal payloads riding
 * that subscription for sessions the user is not looking at are dropped
 * here at zero cost. The ring cap bounds a retained session's memory.
 */
const TERMINAL_RING_CAPACITY_BYTES = 128 * 1024;

export type TerminalFeedEvent =
  /**
   * 'chunk' appends to what the consumer already rendered; 'seed' REPLACES
   * it (a fresh read-stream subscribe superseded the buffer - reset the
   * view, then render the data).
   */
  | { kind: 'chunk' | 'seed'; data: string }
  /** The desktop PTY's grid changed (or was first learned); the bytes that follow are laid out for it. */
  | { kind: 'dims'; cols: number; rows: number };

interface TerminalRing {
  chunks: string[];
  totalBytes: number;
  /** The PTY grid the buffered bytes are laid out for; null until the desktop reports one (or never, pre-0.4.0). */
  dims: TerminalDimensionsWire | null;
}

const ringsBySessionId = new Map<string, TerminalRing>();

type TerminalFeedListener = (event: TerminalFeedEvent) => void;

/**
 * Listeners live OUTSIDE the ring, and deliberately outlive it.
 *
 * Retention owns the BUFFER; a subscriber owns its LISTENER. Keeping the two
 * together made subscribe order load-bearing, and React runs child effects
 * before parent effects in the same commit: on a session swap the pane
 * resubscribed to the successor before SessionScreen's effect had retained
 * its ring, subscribeChunks silently returned a no-op, and every later byte
 * landed in a ring with zero listeners. The terminal stayed black until an
 * unrelated re-render (a theme or clean-feed flip) happened to re-run the
 * effect, which is why it read as "can happen" rather than "always".
 *
 * With the sets keyed on sessionId instead, attaching before the ring exists
 * is ordinary: the seed that arrives once the ring is retained reaches the
 * listener that was already waiting for it.
 */
const listenersBySessionId = new Map<string, Set<TerminalFeedListener>>();

/** Copies the set before iterating: a listener may unsubscribe from inside its own callback. */
function emit(sessionId: string, event: TerminalFeedEvent): void {
  const listeners = listenersBySessionId.get(sessionId);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(event);
}

function evictPastCapacity(ring: TerminalRing): void {
  while (ring.totalBytes > TERMINAL_RING_CAPACITY_BYTES && ring.chunks.length > 1) {
    const evicted = ring.chunks.shift();
    if (evicted === undefined) break;
    ring.totalBytes -= evicted.length;
  }
}

export function retainTerminal(sessionId: string): void {
  if (!ringsBySessionId.has(sessionId)) {
    ringsBySessionId.set(sessionId, { chunks: [], totalBytes: 0, dims: null });
  }
}

/** Drops the buffered bytes. Subscribers keep their listeners - see listenersBySessionId. */
export function releaseTerminal(sessionId: string): void {
  ringsBySessionId.delete(sessionId);
}

export function isTerminalRetained(sessionId: string): boolean {
  return ringsBySessionId.has(sessionId);
}

/** Replaces the ring with a fresh scrollback snapshot (a new read-stream subscribe supersedes everything buffered). */
export function seedScrollback(sessionId: string, scrollback: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return;
  ring.chunks = scrollback.length > 0 ? [scrollback] : [];
  ring.totalBytes = scrollback.length;
  evictPastCapacity(ring);
  emit(sessionId, { kind: 'seed', data: scrollback });
}

/** No-op unless the session is retained. */
export function appendChunk(sessionId: string, data: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring || data.length === 0) return;
  ring.chunks.push(data);
  ring.totalBytes += data.length;
  evictPastCapacity(ring);
  emit(sessionId, { kind: 'chunk', data });
}

export function getBufferedData(sessionId: string): string {
  const ring = ringsBySessionId.get(sessionId);
  return ring ? ring.chunks.join('') : '';
}

/**
 * True when re-initialising the WebView from this session would paint
 * something: the ring exists and holds bytes or a known grid. False for a
 * successor whose first snapshot has not landed yet, where an init would
 * paint an EMPTY grid over a perfectly good last frame.
 */
export function hasBufferedFrame(sessionId: string): boolean {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return false;
  return ring.chunks.length > 0 || ring.dims !== null;
}

/**
 * Records the authoritative PTY grid (snapshot's ptyDimensions or a
 * terminal-resize event) and notifies listeners on change. No-op unless
 * the session is retained, like every other write here.
 */
export function setTerminalDimensions(sessionId: string, dims: TerminalDimensionsWire | null): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return;
  if (dims === null) {
    ring.dims = null;
    return;
  }
  if (ring.dims && ring.dims.cols === dims.cols && ring.dims.rows === dims.rows) return;
  ring.dims = { cols: dims.cols, rows: dims.rows };
  emit(sessionId, { kind: 'dims', cols: dims.cols, rows: dims.rows });
}

/** The PTY grid the buffered bytes are laid out for, or null when unknown (pre-0.4.0 desktop, or not yet reported). */
export function getTerminalDimensions(sessionId: string): TerminalDimensionsWire | null {
  const ring = ringsBySessionId.get(sessionId);
  return ring?.dims ? { ...ring.dims } : null;
}

/**
 * Live feed. The listener receives each append as a 'chunk' and each
 * scrollback re-seed as a 'seed' after it lands in the ring; call
 * getBufferedData() first for the backlog.
 *
 * Attaching to a session that is not retained YET is fine and deliberate: the
 * listener simply hears nothing until a ring exists, then receives that ring's
 * first seed. Nothing here depends on the caller's effect running after the
 * screen's retain.
 */
export function subscribeChunks(sessionId: string, listener: TerminalFeedListener): Unsubscribe {
  let listeners = listenersBySessionId.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    listenersBySessionId.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    const currentListeners = listenersBySessionId.get(sessionId);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    // Drop the empty set rather than leaving one per session ever watched.
    if (currentListeners.size === 0) listenersBySessionId.delete(sessionId);
  };
}

export interface TerminalFeedStats {
  sessionId: string;
  chunks: number;
  totalBytes: number;
  dims: TerminalDimensionsWire | null;
  listeners: number;
}

/**
 * Per-retained-session ring stats, for the dev inspect bridge. Enumerates
 * RINGS, so the list stays "what is buffered"; a listener attached to a
 * session with no ring is reported by getUnbufferedListenerSessionIds().
 */
export function getTerminalFeedStats(): TerminalFeedStats[] {
  return [...ringsBySessionId.entries()].map(([sessionId, ring]) => ({
    sessionId,
    chunks: ring.chunks.length,
    totalBytes: ring.totalBytes,
    dims: ring.dims ? { ...ring.dims } : null,
    listeners: listenersBySessionId.get(sessionId)?.size ?? 0,
  }));
}

/**
 * Sessions with a live listener but no ring - normal and brief mid-swap (the
 * pane has rebound to the successor, the screen has not retained it yet), and
 * a leak if one persists. For the dev inspect bridge.
 */
export function getUnbufferedListenerSessionIds(): string[] {
  return [...listenersBySessionId.keys()].filter((sessionId) => !ringsBySessionId.has(sessionId));
}

export function resetTerminalFeed(): void {
  ringsBySessionId.clear();
  listenersBySessionId.clear();
}
