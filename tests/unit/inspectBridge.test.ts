import { beforeEach, describe, expect, it } from 'vitest';
import type { SubscriptionManager } from '../../src/channel/subscriptionManager';
import { buildInspectPayload } from '../../src/devsupport/inspectBridge';
import type { InspectRequestKind } from '../../src/devsupport/inspectProtocol';
import { setInspectRoute, setInspectSubscriptions, setInspectTerminal } from '../../src/devsupport/inspectState';
import { useActivityStore } from '../../src/state/activityStore';
import { useBoardStore } from '../../src/state/boardStore';
import { useChannelStore } from '../../src/state/channelStore';
import { useDiffStore } from '../../src/state/diffStore';
import { appendChunk, resetTerminalFeed, retainTerminal, subscribeChunks } from '../../src/state/terminalFeed';
import { useTranscriptStore } from '../../src/state/transcriptStore';

function payloadFor(kind: InspectRequestKind, argument?: string): Promise<unknown> {
  return buildInspectPayload({ kind, argument });
}

describe('buildInspectPayload', () => {
  beforeEach(() => {
    useChannelStore.getState().reset();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useDiffStore.getState().reset();
    resetTerminalFeed();
    setInspectRoute(null);
    setInspectSubscriptions(null);
    setInspectTerminal(null);
  });

  it('summarizes the connection state', async () => {
    useChannelStore.getState().setPairedState('paired');
    useChannelStore.getState().setTransportState('connected');
    useChannelStore.getState().markEstablished();
    await expect(payloadFor('connection')).resolves.toEqual({
      transportState: 'connected',
      established: true,
      rekeyCount: 0,
      relayUrl: null,
      pairedState: 'paired',
    });
  });

  it('summarizes stores as counts and statuses, never full payloads', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    const payload = (await payloadFor('stores')) as {
      activity: { sessionId: string; feedStatus: string }[];
      transcript: unknown[];
      board: { projects: string[] };
      diff: unknown[];
    };
    expect(payload.activity).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', taskId: 'task-1', feedStatus: 'pending' }),
    ]);
    expect(payload.transcript).toEqual([]);
    expect(payload.board.projects).toEqual([]);
    expect(payload.diff).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('entries":');
  });

  it('reports terminal feed ring stats, and listeners with no ring behind them', async () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello world');
    // A pane that has rebound to a successor the screen has not retained yet:
    // normal for a moment mid-swap, a leaked subscription if it persists.
    subscribeChunks('sess-successor', () => undefined);
    await expect(payloadFor('feed-stats')).resolves.toEqual({
      rings: [{ sessionId: 'sess-1', chunks: 1, totalBytes: 11, dims: null, listeners: 0 }],
      unbufferedListeners: ['sess-successor'],
    });
  });

  it('answers subscriptions from the registered manager and errors without one', async () => {
    await expect(payloadFor('subscriptions')).rejects.toThrow(/No active connection/);
    const snapshot = {
      desiredStreams: ['sess-1'],
      activeStreams: [],
      desiredBoards: ['project-1'],
      activeBoards: ['project-1'],
      desiredDiffTaskIds: [],
      activeDiffTaskIds: [],
    };
    setInspectSubscriptions({ debugSnapshot: () => snapshot } as unknown as SubscriptionManager);
    await expect(payloadFor('subscriptions')).resolves.toEqual(snapshot);
  });

  it('answers the route from the probe registry and errors without one', async () => {
    await expect(payloadFor('route')).rejects.toThrow(/Route probe/);
    setInspectRoute({ pathname: '/task/task-1', params: { taskId: 'task-1' } });
    await expect(payloadFor('route')).resolves.toEqual({ pathname: '/task/task-1', params: { taskId: 'task-1' } });
  });

  describe('terminal', () => {
    const probeState = { buildId: 'abc123', gridHeightPx: 640, rows: 48 };
    const writeStats = { attempts: 7, failures: 2, lastError: 'not connected', lastAttemptAt: 1000 };

    function registerTerminal(expectedBuildId: string): string[] {
      const seenExpressions: string[] = [];
      setInspectTerminal({
        sessionId: 'sess-1',
        expectedBuildId,
        evaluate: (expression: string) => {
          seenExpressions.push(expression);
          return Promise.resolve(probeState);
        },
        writeStats: () => ({ ...writeStats }),
      });
      return seenExpressions;
    }

    it('errors when no terminal pane is mounted', async () => {
      await expect(payloadFor('terminal')).rejects.toThrow(/No terminal pane mounted/);
      await expect(payloadFor('terminal-eval', '1 + 1')).rejects.toThrow(/No terminal pane mounted/);
    });

    it('joins the page probe with the write outcomes RN owns', async () => {
      const seenExpressions = registerTerminal('abc123');
      const payload = await payloadFor('terminal');
      expect(seenExpressions).toEqual(['window.__kangenticTerminal.probe()']);
      expect(payload).toEqual({
        sessionId: 'sess-1',
        expectedBuildId: 'abc123',
        loadedBuildId: 'abc123',
        buildIdMatches: true,
        writes: writeStats,
        page: probeState,
      });
    });

    it('flags a stale page when the loaded build id is not the expected one', async () => {
      registerTerminal('def456');
      const payload = (await payloadFor('terminal')) as { buildIdMatches: boolean; loadedBuildId: unknown };
      expect(payload.buildIdMatches).toBe(false);
      expect(payload.loadedBuildId).toBe('abc123');
    });

    it('passes an eval expression through untouched and rejects an empty one', async () => {
      const seenExpressions = registerTerminal('abc123');
      await expect(payloadFor('terminal-eval', 'window.innerHeight')).resolves.toEqual(probeState);
      expect(seenExpressions).toEqual(['window.innerHeight']);
      await expect(payloadFor('terminal-eval')).rejects.toThrow(/needs an expression/);
    });
  });
});
