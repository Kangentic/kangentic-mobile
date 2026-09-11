/**
 * terminalFeed: retained-only buffering, byte-capped ring eviction,
 * seed-vs-chunk listener events, and zero-cost non-retained appends.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendChunk,
  getBufferedData,
  getTerminalDimensions,
  getTerminalFeedStats,
  getUnbufferedListenerSessionIds,
  hasBufferedFrame,
  isTerminalRetained,
  releaseTerminal,
  resetTerminalFeed,
  retainTerminal,
  seedScrollback,
  setTerminalDimensions,
  subscribeChunks,
  type TerminalFeedEvent,
} from '@/state/terminalFeed';

describe('terminalFeed', () => {
  beforeEach(() => {
    resetTerminalFeed();
  });

  it('appends are dropped for non-retained sessions', () => {
    appendChunk('sess-1', 'ignored');
    expect(getBufferedData('sess-1')).toBe('');
    expect(isTerminalRetained('sess-1')).toBe(false);
  });

  it('buffers appends for retained sessions and joins them in order', () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello ');
    appendChunk('sess-1', 'world');
    expect(getBufferedData('sess-1')).toBe('hello world');
  });

  it('seedScrollback replaces the buffer and notifies listeners with kind seed', () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'stale');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));

    seedScrollback('sess-1', 'fresh snapshot');
    appendChunk('sess-1', ' + live');

    expect(getBufferedData('sess-1')).toBe('fresh snapshot + live');
    expect(events).toEqual([
      { kind: 'seed', data: 'fresh snapshot' },
      { kind: 'chunk', data: ' + live' },
    ]);
  });

  it('evicts oldest chunks past the byte cap but always keeps the newest', () => {
    retainTerminal('sess-1');
    const bigChunk = 'x'.repeat(100 * 1024);
    appendChunk('sess-1', bigChunk);
    appendChunk('sess-1', 'y'.repeat(40 * 1024));
    // 140KB > 128KB cap: the first chunk is evicted.
    const buffered = getBufferedData('sess-1');
    expect(buffered).toBe('y'.repeat(40 * 1024));

    // A single oversized chunk is kept (the cap never evicts the last chunk).
    seedScrollback('sess-1', 'z'.repeat(200 * 1024));
    expect(getBufferedData('sess-1')).toHaveLength(200 * 1024);
  });

  it('releaseTerminal drops the ring, and nothing is buffered or delivered until it is retained again', () => {
    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));
    releaseTerminal('sess-1');

    appendChunk('sess-1', 'after release');
    expect(getBufferedData('sess-1')).toBe('');
    expect(events).toEqual([]);
  });

  /**
   * THE ORDERING BUG THIS MODULE EXISTS TO NOT HAVE.
   *
   * React runs child effects before parent effects in the same commit, so on a
   * session swap TerminalPane resubscribes to the successor BEFORE
   * SessionScreen's effect retains its ring. When listeners lived on the ring,
   * subscribeChunks found none, returned a no-op unsubscribe, and every later
   * byte landed in a ring with zero listeners: the terminal went black and
   * stayed black until an unrelated re-render happened to re-run the effect.
   *
   * Listeners are keyed on the sessionId and outlive the ring precisely so
   * that attaching first is ordinary rather than fatal.
   */
  it('delivers to a listener that attached before the session was retained', () => {
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-successor', (event) => events.push(event));
    expect(isTerminalRetained('sess-successor')).toBe(false);

    retainTerminal('sess-successor');
    seedScrollback('sess-successor', 'successor frame');
    appendChunk('sess-successor', ' + live');

    expect(events).toEqual([
      { kind: 'seed', data: 'successor frame' },
      { kind: 'chunk', data: ' + live' },
    ]);
  });

  it('keeps a listener attached across a release and re-retain of the same session', () => {
    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));

    releaseTerminal('sess-1');
    retainTerminal('sess-1');
    seedScrollback('sess-1', 'fresh');

    expect(events).toEqual([{ kind: 'seed', data: 'fresh' }]);
  });

  it('subscribing does not retain, so an idle consumer never starts buffering bytes', () => {
    // CompletedTaskScreen renders ConversationTab for a finished session and
    // deliberately never calls openSessionScreen. Retaining on subscribe would
    // buffer for it forever, and flip the isTerminalRetained gate that
    // storeFeed and peekLastTerminalLine both read.
    subscribeChunks('sess-archived', () => undefined);
    expect(isTerminalRetained('sess-archived')).toBe(false);
    expect(getTerminalFeedStats()).toEqual([]);
    expect(getUnbufferedListenerSessionIds()).toEqual(['sess-archived']);
  });

  it('reports the listener count per retained ring', () => {
    retainTerminal('sess-1');
    const unsubscribeFirst = subscribeChunks('sess-1', () => undefined);
    subscribeChunks('sess-1', () => undefined);
    expect(getTerminalFeedStats()).toEqual([expect.objectContaining({ sessionId: 'sess-1', listeners: 2 })]);

    unsubscribeFirst();
    expect(getTerminalFeedStats()).toEqual([expect.objectContaining({ sessionId: 'sess-1', listeners: 1 })]);
  });

  it('hasBufferedFrame is false until the session has bytes or a known grid', () => {
    expect(hasBufferedFrame('sess-1')).toBe(false);
    retainTerminal('sess-1');
    // Retained but empty: re-initialising the WebView from this would paint an
    // empty grid over whatever good frame is on screen.
    expect(hasBufferedFrame('sess-1')).toBe(false);

    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    expect(hasBufferedFrame('sess-1')).toBe(true);

    releaseTerminal('sess-1');
    retainTerminal('sess-1');
    expect(hasBufferedFrame('sess-1')).toBe(false);
    seedScrollback('sess-1', 'frame');
    expect(hasBufferedFrame('sess-1')).toBe(true);
  });

  it('records dims for retained sessions and notifies listeners only on change', () => {
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 }); // not retained: dropped
    expect(getTerminalDimensions('sess-1')).toBeNull();

    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));

    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 }); // unchanged: no event
    setTerminalDimensions('sess-1', { cols: 48, rows: 26 });

    expect(getTerminalDimensions('sess-1')).toEqual({ cols: 48, rows: 26 });
    expect(events).toEqual([
      { kind: 'dims', cols: 120, rows: 30 },
      { kind: 'dims', cols: 48, rows: 26 },
    ]);

    // A pre-0.4.0 desktop reports nothing: null clears silently.
    setTerminalDimensions('sess-1', null);
    expect(getTerminalDimensions('sess-1')).toBeNull();
    expect(events).toHaveLength(2);
  });

  it('unsubscribe stops delivery without touching the buffer', () => {
    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    const unsubscribe = subscribeChunks('sess-1', (event) => events.push(event));
    appendChunk('sess-1', 'one');
    unsubscribe();
    appendChunk('sess-1', 'two');

    expect(events).toEqual([{ kind: 'chunk', data: 'one' }]);
    expect(getBufferedData('sess-1')).toBe('onetwo');
  });
});
