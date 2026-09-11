/**
 * SubscriptionManager: desired-state flush on established, full resubscribe
 * after a transport drop + fresh handshake, rejection pruning, and the
 * debounced board refresh. Runs over the real loopback + stub initiator.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  generateX25519KeyPair,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
  type ReadBoardView,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { VerbClient, type CapabilityError } from '@/channel/verbClient';
import { SubscriptionManager, type SubscriptionSnapshotSinks } from '@/channel/subscriptionManager';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardSnapshotFixture, diffFileListFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

interface Harness {
  session: SessionManager;
  stub: StubSessionInitiator;
  manager: SubscriptionManager;
  requests: CapabilityRequestMessage[];
  sinkCalls: {
    streamSnapshots: string[];
    streamRejections: { sessionId: string; error: CapabilityError }[];
    boardSnapshots: string[];
    diffFileLists: string[];
    diffFetchFailures: { taskId: string; scope: string }[];
  };
}

function defaultResponder(request: CapabilityRequestMessage): CapabilityResponseMessage {
  const payload = request.payload as { sessionId?: string; projectId?: string; taskId?: string; action?: string; view?: ReadBoardView };
  if (payload.action === 'unsubscribe') return { type: 'capability-response', requestId: request.requestId, ok: true };
  switch (request.verb) {
    case 'read-stream':
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: streamSnapshotFixture() as unknown as JsonValue };
    case 'read-board':
      return {
        type: 'capability-response',
        requestId: request.requestId,
        ok: true,
        // Echoes the requested view, as a 0.9.0 desktop does.
        payload: boardSnapshotFixture({
          projectId: payload.projectId ?? 'project-1',
          ...(payload.view !== undefined ? { view: payload.view } : {}),
        }) as unknown as JsonValue,
      };
    case 'read-diff':
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: diffFileListFixture() as unknown as JsonValue };
    default:
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: `unexpected verb ${request.verb}` };
  }
}

async function harness(
  respond: (request: CapabilityRequestMessage) => CapabilityResponseMessage | null = defaultResponder,
): Promise<Harness> {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  await phoneTransport.connect();
  await desktopTransport.connect();
  const phoneIdentity = generateX25519KeyPair();
  const desktopIdentity = generateX25519KeyPair();
  const session = new SessionManager({
    identity: phoneIdentity,
    remoteStaticPublicKey: desktopIdentity.publicKey,
    transport: phoneTransport,
  });
  session.start();
  const stub = new StubSessionInitiator(desktopTransport, {
    desktopStatic: desktopIdentity,
    phoneStaticPublicKey: phoneIdentity.publicKey,
  });

  const requests: CapabilityRequestMessage[] = [];
  stub.setRequestHandler((request) => {
    requests.push(request);
    return respond(request);
  });

  const sinkCalls: Harness['sinkCalls'] = {
    streamSnapshots: [],
    streamRejections: [],
    boardSnapshots: [],
    diffFileLists: [],
    diffFetchFailures: [],
  };
  const sinks: SubscriptionSnapshotSinks = {
    onStreamSnapshot: (sessionId) => sinkCalls.streamSnapshots.push(sessionId),
    onStreamRejected: (sessionId, error) => sinkCalls.streamRejections.push({ sessionId, error }),
    onBoardSnapshot: (snapshot) => sinkCalls.boardSnapshots.push(snapshot.projectId),
    onDiffFileList: (taskId) => sinkCalls.diffFileLists.push(taskId),
    onDiffFetchFailed: (taskId, scope) => sinkCalls.diffFetchFailures.push({ taskId, scope }),
  };
  const verbs = new VerbClient(new CapabilityClient(session));
  const manager = new SubscriptionManager({ session, verbs, sinks });
  return { session, stub, manager, requests, sinkCalls };
}

async function flushLoopback(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('SubscriptionManager', () => {
  it('flushes desired sets declared before the first handshake once established', async () => {
    const { stub, manager, sinkCalls } = await harness();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setDesiredStreams(new Set(['sess-1', 'sess-2']));
    expect(sinkCalls.boardSnapshots).toEqual([]);

    stub.beginHandshake();
    await flushLoopback();

    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);
    expect([...sinkCalls.streamSnapshots].sort()).toEqual(['sess-1', 'sess-2']);
  });

  /**
   * The feed discards PTY bytes on arrival, and on a live board that discard
   * measured ~13MB an hour with no terminal on screen. So a stream is
   * subscribed list-only by default, and only a session screen asks for the
   * bytes. `terminal` absent would mean "send them" to the desktop, so the
   * false must actually be on the wire, not merely omitted.
   */
  it('subscribes streams list-only until a screen asks for the terminal', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();

    const subscribes = requests.filter((request) => request.verb === 'read-stream');
    expect(subscribes).toHaveLength(1);
    expect((subscribes[0].payload as { terminal?: boolean }).terminal).toBe(false);

    manager.setStreamWantsTerminal('sess-1', true);
    await flushLoopback();

    const afterOpen = requests.filter((request) => request.verb === 'read-stream');
    expect(afterOpen).toHaveLength(2);
    expect((afterOpen[1].payload as { terminal?: boolean }).terminal).toBe(true);
  });

  it('drops back to list-only when the screen closes', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    manager.setStreamWantsTerminal('sess-1', true);
    await flushLoopback();
    const countAfterOpen = requests.length;

    manager.setStreamWantsTerminal('sess-1', false);
    await flushLoopback();

    const afterClose = requests.slice(countAfterOpen).filter((request) => request.verb === 'read-stream');
    expect(afterClose).toHaveLength(1);
    expect((afterClose[0].payload as { terminal?: boolean }).terminal).toBe(false);
  });

  /**
   * openSessionScreen trusts this return value to decide whether it still
   * needs its own refreshStream call (see tests/unit/openSessionScreen.test.ts):
   * true means setStreamWantsTerminal's own re-subscribe already fetched a
   * fresh frame, false means nothing was issued and the caller must ask
   * itself. If this drifted to always-true (or always-false), the caller's
   * own tests are mocking the return value and would never catch it - only
   * asserting the REAL return value here does.
   */
  it('setStreamWantsTerminal returns true only when it actually issues a re-subscribe', async () => {
    const { stub, manager } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();

    // Changed, desired, and established: this call IS the re-subscribe.
    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(true);
    await flushLoopback();

    // Same value as already set: nothing to do, nothing issued.
    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(false);

    // A session nobody has declared desired: the flag is recorded, but
    // there is no active subscription to re-issue.
    expect(manager.setStreamWantsTerminal('sess-2', true)).toBe(false);
  });

  it('setStreamWantsTerminal returns false for a desired stream before the handshake establishes', async () => {
    const { manager } = await harness();
    // Declared before any handshake - exactly the openSessionScreen case of
    // opening a screen while still connecting.
    manager.setDesiredStreams(new Set(['sess-1']));

    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(false);
  });

  it('does not re-subscribe when the terminal mode is set to what it already is', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();
    const countAfterSubscribe = requests.length;

    manager.setStreamWantsTerminal('sess-1', false);
    await flushLoopback();

    expect(requests).toHaveLength(countAfterSubscribe);
  });

  /**
   * The phone watches every project's board to find live sessions, but only
   * draws the tasks that have one. Measured across 15 projects, the full
   * boards were 63kB compressed against 12kB for the projection, repeated on
   * every board change - so 'sessions' is the default and 'full' is asked for
   * only where a whole board is rendered.
   */
  it('subscribes boards with the sessions projection until a board screen asks for the full one', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredBoards(new Set(['project-1', 'project-2']));
    await flushLoopback();

    const subscribes = requests.filter((request) => request.verb === 'read-board');
    expect(subscribes).toHaveLength(2);
    expect(subscribes.every((request) => (request.payload as { view?: string }).view === 'sessions')).toBe(true);

    manager.setBoardWantsFull('project-1');
    await flushLoopback();

    const afterOpen = requests.filter((request) => request.verb === 'read-board');
    expect(afterOpen).toHaveLength(3);
    expect((afterOpen[2].payload as { projectId?: string; view?: string })).toMatchObject({
      projectId: 'project-1',
      view: 'full',
    });
  });

  /**
   * The two subscribes above, WITHOUT the flush between them - which is the
   * only arrangement that reaches the race. Bootstrap asks for 'sessions' and
   * the Board tab focuses and asks for 'full' before the first answer comes
   * back, so two read-boards for one project are in flight at once and the
   * responses can land in either order.
   *
   * A late 'sessions' snapshot must not be applied: applyBoardSnapshot replaces
   * tasksById wholesale, so it would erase every task without a live session
   * from a Board tab that had already rendered them, strand the screen back on
   * its skeleton, and leave any optimistic move over one of those tasks with
   * nothing to commit against.
   */
  it('ignores a board response whose view is no longer the one wanted', async () => {
    const heldSessionsRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, requests, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-board' && (request.payload as { view?: ReadBoardView }).view === 'sessions') {
        heldSessionsRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredBoards(new Set(['project-1']));
    manager.setBoardWantsFull('project-1');
    await flushLoopback();

    // Both went out; only the 'full' one has been answered so far.
    expect(requests.filter((request) => request.verb === 'read-board')).toHaveLength(2);
    expect(heldSessionsRequests).toHaveLength(1);
    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);

    // Release the stale answer, out of issue order.
    for (const held of heldSessionsRequests) stub.send(defaultResponder(held));
    await flushLoopback();

    // Not applied to the store...
    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);
    // ...and the LANDED view is still 'full', which setBoardWantsFull proves by
    // declining to re-issue (it only re-issues while the upgrade has not landed).
    const countBeforeRefocus = requests.length;
    manager.setBoardWantsFull('project-1');
    await flushLoopback();
    expect(requests).toHaveLength(countBeforeRefocus);
  });

  /**
   * The same race on the terminal flag: opening a session screen and closing it
   * again before the first subscribe answers leaves two read-streams in flight
   * with opposite `terminal` values.
   */
  it('ignores a stream response whose terminal mode is no longer the one wanted', async () => {
    const heldListOnlyRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, requests, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-stream' && (request.payload as { terminal?: boolean }).terminal === false) {
        heldListOnlyRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-1']));
    manager.setStreamWantsTerminal('sess-1', true);
    await flushLoopback();

    expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(2);
    expect(sinkCalls.streamSnapshots).toEqual(['sess-1']);

    for (const held of heldListOnlyRequests) stub.send(defaultResponder(held));
    await flushLoopback();

    expect(sinkCalls.streamSnapshots).toEqual(['sess-1']);
  });

  /**
   * Upgrade-only, deliberately. A full board is small, and downgrading one
   * back to 'sessions' would let a snapshot drop a task that an optimistic
   * move/edit/removal is still pending on, leaving the rollback nothing to
   * restore.
   */
  it('keeps a board on the full projection across a re-handshake, and never asks twice', async () => {
    const { session, stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setBoardWantsFull('project-1');
    await flushLoopback();
    const countAfterUpgrade = requests.length;

    manager.setBoardWantsFull('project-1');
    await flushLoopback();
    expect(requests).toHaveLength(countAfterUpgrade);

    session.reset();
    stub.beginHandshake();
    await flushLoopback();

    const afterReconnect = requests.slice(countAfterUpgrade).filter((request) => request.verb === 'read-board');
    expect(afterReconnect).toHaveLength(1);
    expect((afterReconnect[0].payload as { view?: string }).view).toBe('full');
  });

  /**
   * The upgrade-permanence guarantee above is scoped to a project that STAYS
   * desired. Once a project drops out of the desired set entirely (the
   * project list refreshed without it), its full-board upgrade is gone too -
   * a later re-add is a fresh board and starts back at the feed projection,
   * with the Board tab upgrading it again only if it is opened.
   */
  it('a board dropped from the desired set and later re-added starts back at the sessions projection', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setBoardWantsFull('project-1');
    await flushLoopback();

    const readBoardSubscribeRequests = (): CapabilityRequestMessage[] =>
      requests.filter((request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe');
    expect((readBoardSubscribeRequests().at(-1)?.payload as { view?: string }).view).toBe('full');

    manager.setDesiredBoards(new Set());
    await flushLoopback();
    // Only the requests issued AFTER the re-add count: an earlier subscribe
    // still in flight can land on the stub out of issue order, which would
    // make `.at(-1)` over the whole list a coin flip.
    const countBeforeReadd = requests.length;
    manager.setDesiredBoards(new Set(['project-1']));
    await flushLoopback();

    const afterReadd = requests
      .slice(countBeforeReadd)
      .filter((request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe');
    expect(afterReadd).toHaveLength(1);
    expect(afterReadd[0].payload).toMatchObject({ projectId: 'project-1', view: 'sessions' });
  });

  it('re-issues every desired subscription after a transport drop and fresh handshake', async () => {
    const { session, stub, manager, requests, sinkCalls } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setDesiredStreams(new Set(['sess-1']));
    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    await flushLoopback();
    const requestCountBeforeDrop = requests.length;

    // Transport drop: ChannelController would call session.reset(); the
    // desktop then re-initiates a handshake on reconnect.
    session.reset();
    stub.beginHandshake();
    await flushLoopback();

    const requestsAfterDrop = requests.slice(requestCountBeforeDrop);
    const verbsAfterDrop = requestsAfterDrop.map((request) => request.verb).sort();
    expect(verbsAfterDrop).toEqual(['read-board', 'read-diff', 'read-stream']);
    expect(sinkCalls.boardSnapshots).toEqual(['project-1', 'project-1']);
    expect(sinkCalls.streamSnapshots).toEqual(['sess-1', 'sess-1']);
    expect(sinkCalls.diffFileLists).toEqual(['task-1', 'task-1']);
  });

  it('prunes a stream the desktop rejects and reports it through the sink', async () => {
    const { stub, manager, sinkCalls, requests } = await harness((request) => {
      if (request.verb === 'read-stream') {
        return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No such session: sess-dead' };
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-dead']));
    await flushLoopback();

    expect(sinkCalls.streamRejections).toHaveLength(1);
    expect(sinkCalls.streamRejections[0].sessionId).toBe('sess-dead');
    expect(sinkCalls.streamRejections[0].error.message).toMatch(/No such session/);

    // Pruned: re-declaring an unrelated desired set must not retry sess-dead.
    const requestCount = requests.length;
    manager.setDesiredStreams(new Set(['sess-dead']));
    await flushLoopback();
    // Re-declaring DOES retry (it is a fresh desired set)...
    expect(requests.length).toBe(requestCount + 1);
  });

  /**
   * A refused diff fetch used to be swallowed whole. The Changes tab's only
   * other state is its loading skeleton, so the pane sat on it forever, and
   * DiffFetchStatus's 'error' member had no writer anywhere in the app.
   *
   * The SCOPE matters as much as the taskId: the store keys status by scope,
   * so reporting the failure without it would let a scope switch mid-flight
   * mark the wrong one failed.
   */
  it('reports a refused diff fetch through the sink, with the scope it was for', async () => {
    const { stub, manager, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-diff') {
        return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No worktree for task-1' };
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'branch' });
    await flushLoopback();

    expect(sinkCalls.diffFetchFailures).toEqual([{ taskId: 'task-1', scope: 'branch' }]);
    expect(sinkCalls.diffFileLists).toEqual([]);
  });

  it('does not report a diff failure for a watch that has since been dropped', async () => {
    const { stub, manager, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-diff') {
        return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No worktree for task-1' };
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    // Dropped before the refusal comes back: the screen has moved on, and a
    // late error must not reopen an error state on a pane nobody is watching.
    manager.setDesiredDiff('task-1', null);
    await flushLoopback();

    expect(sinkCalls.diffFetchFailures).toEqual([]);
  });

  /**
   * The other half of the same staleness guard: a watch that has since been
   * RE-SCOPED rather than dropped. The Changes tab flips scope (working ->
   * branch) while the old fetch is still in flight; when it finally rejects,
   * the desired entry is a fresh { projectId, scope: 'branch' } object, so a
   * comparison keyed on it (`this.desiredDiffsByTaskId.get(taskId) !==
   * desired`) must reject the STALE 'working' closure. Without that, the late
   * rejection would fire onDiffFetchFailed for the CURRENT (branch) watch and
   * mark a fetch that actually succeeded as errored.
   */
  it('does not report a diff failure, or mark the new scope errored, for a watch that has since been re-scoped', async () => {
    const heldWorkingRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-diff' && (request.payload as { scope?: string }).scope === 'working') {
        heldWorkingRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    await flushLoopback();
    expect(heldWorkingRequests).toHaveLength(1);

    // Re-scoped while the 'working' fetch is still outstanding. This issues
    // its own subscribeDiff for 'branch', which the default responder answers
    // successfully.
    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'branch' });
    await flushLoopback();
    expect(sinkCalls.diffFileLists).toEqual(['task-1']);

    // The stale 'working' fetch finally rejects.
    for (const held of heldWorkingRequests) {
      stub.send({ type: 'capability-response', requestId: held.requestId, ok: false, error: 'No worktree for task-1' });
    }
    await flushLoopback();

    // Must not report the stale rejection, and must not disturb the
    // already-successful 'branch' watch's state.
    expect(sinkCalls.diffFetchFailures).toEqual([]);
    expect(sinkCalls.diffFileLists).toEqual(['task-1']);
  });

  it('removing a desired stream unsubscribes it', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();

    manager.setDesiredStreams(new Set());
    await flushLoopback();

    const unsubscribeRequests = requests.filter(
      (request) => request.verb === 'read-stream' && (request.payload as { action?: string }).action === 'unsubscribe',
    );
    expect(unsubscribeRequests).toHaveLength(1);
    expect((unsubscribeRequests[0].payload as { sessionId?: string }).sessionId).toBe('sess-1');
  });

  it('refreshBoard debounces bursts into one re-subscribe', async () => {
    vi.useFakeTimers();
    try {
      const { stub, manager, requests } = await harness();
      stub.beginHandshake();
      await vi.runAllTimersAsync();
      manager.setDesiredBoards(new Set(['project-1']));
      await vi.runAllTimersAsync();
      const boardRequestCount = (): number => requests.filter((request) => request.verb === 'read-board').length;
      const countAfterInitial = boardRequestCount();

      manager.refreshBoard('project-1');
      manager.refreshBoard('project-1');
      manager.refreshBoard('project-1');
      await vi.runAllTimersAsync();

      expect(boardRequestCount()).toBe(countAfterInitial + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('diff scope change re-subscribes; blur unsubscribes with the projectId', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    await flushLoopback();
    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'branch' });
    await flushLoopback();
    manager.setDesiredDiff('task-1', null);
    await flushLoopback();

    const diffRequests = requests.filter((request) => request.verb === 'read-diff');
    expect(diffRequests.map((request) => (request.payload as { scope?: string; action?: string }).scope ?? (request.payload as { action?: string }).action)).toEqual([
      'working',
      'branch',
      'unsubscribe',
    ]);
    expect((diffRequests[2].payload as { projectId?: string }).projectId).toBe('project-1');
  });
});
