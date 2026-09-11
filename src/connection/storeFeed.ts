import type { ActivityEvent, TranscriptEvent, Unsubscribe } from '@kangentic/protocol';
import type { FeedRouter, SubscriptionManager, SubscriptionSnapshotSinks } from '@/channel';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore, selectLiveSessionIds } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import {
  appendChunk,
  getTerminalDimensions,
  isTerminalRetained,
  seedScrollback,
  setTerminalDimensions,
} from '@/state/terminalFeed';

/**
 * The single place feed events and subscription snapshots meet store
 * actions - pure mapping, no policy. Reconciliation policy (which streams
 * to want, when to refresh) lives in SubscriptionManager + the board-diff
 * logic below; screens read stores and call actions.ts.
 */

function sessionOwnerFor(sessionId: string): { taskId: string; projectId: string } | null {
  const boardState = useBoardStore.getState();
  for (const [projectId, board] of Object.entries(boardState.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id === sessionId) return { taskId: task.id, projectId };
    }
  }
  return null;
}

/**
 * After each board snapshot: register every live session with its owning
 * task (the triage card needs taskId/projectId), drop activity entries for
 * sessions no board claims anymore, and re-declare the desired stream set.
 */
function reconcileSessionsFromBoards(subscriptions: SubscriptionManager): void {
  const boardState = useBoardStore.getState();
  const liveSessionIds = selectLiveSessionIds(boardState);

  for (const [projectId, board] of Object.entries(boardState.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id !== null && task.archived_at === null) {
        useActivityStore.getState().registerSession(task.session_id, task.id, projectId);
      }
    }
  }
  for (const sessionId of Object.keys(useActivityStore.getState().bySessionId)) {
    if (!liveSessionIds.has(sessionId)) useActivityStore.getState().removeSession(sessionId);
  }

  subscriptions.setDesiredStreams(liveSessionIds);
}

export function createSnapshotSinks(getSubscriptions: () => SubscriptionManager): SubscriptionSnapshotSinks {
  return {
    onStreamSnapshot: (sessionId, snapshot) => {
      const owner = sessionOwnerFor(sessionId);
      useActivityStore.getState().applySnapshot(sessionId, owner?.taskId ?? '', owner?.projectId ?? '', snapshot);
      if (isTerminalRetained(sessionId)) {
        // Dims land BEFORE the seed so the pane's re-init reads the grid the
        // fresh scrollback was laid out for.
        setTerminalDimensions(sessionId, snapshot.ptyDimensions ?? null);
        seedScrollback(sessionId, snapshot.scrollback);
      }
    },
    onStreamRejected: (sessionId) => {
      useActivityStore.getState().markRejected(sessionId);
    },
    onBoardSnapshot: (snapshot) => {
      useBoardStore.getState().applyBoardSnapshot(snapshot);
      reconcileSessionsFromBoards(getSubscriptions());
    },
    onDiffFileList: (taskId, fileList) => {
      const scope = useDiffStore.getState().byTaskId[taskId]?.scope ?? 'working';
      useDiffStore.getState().applyFileList(taskId, scope, fileList);
    },
    onDiffFetchFailed: (taskId, scope) => {
      // The scope the FETCH was for, not whatever the store happens to hold:
      // a scope switch mid-flight must not mark the new scope failed.
      useDiffStore.getState().setStatus(taskId, scope, 'error');
    },
  };
}

/**
 * Coalesce window for transcript deltas. They arrive many times per second
 * while an agent streams (the settled tail entry grows token by token), and
 * each one re-copies the window array AND re-runs ConversationTab's O(n)
 * conversation-cell flatten - so a firehose costs O(n * deltas/sec) of
 * main-thread work that worsens as the transcript grows. Batching a burst into
 * one apply per window collapses that to one flatten+render per window. The
 * settled transcript does not need per-token freshness: the 250ms live-tail
 * carries the token-by-token streaming feel.
 */
const TRANSCRIPT_COALESCE_MS = 100;

/**
 * Coalesce window for usage (token-accounting) activity events. They stream
 * frequently during a turn but only bump a counter, yet each one produces a new
 * activity map and re-renders TriageHome (which subscribes to the whole map and
 * stays mounted behind the task screen). Only the latest usage per session
 * matters, so we keep the newest and apply it per window. Meaningful
 * transitions (state / event / permission) still apply immediately.
 */
const USAGE_COALESCE_MS = 500;

export function bindFeedToStores(feed: FeedRouter, subscriptions: SubscriptionManager): Unsubscribe {
  // A desktop-side PTY resize reflows the desktop terminal, so the phone's
  // ring holds scrollback laid out for the OLD grid - mixing it with
  // new-width deltas renders garble. Re-subscribing fetches a fresh
  // serialized frame at the new grid (replace semantics desktop-side) and
  // the pane re-seeds. Debounced per session: a drag-resize emits a burst.
  const RESIZE_RESEED_DEBOUNCE_MS = 300;
  const resizeReseedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  let pendingTranscriptEvents: TranscriptEvent[] = [];
  let transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTranscriptEvents = (): void => {
    transcriptFlushTimer = null;
    if (pendingTranscriptEvents.length === 0) return;
    const events = pendingTranscriptEvents;
    pendingTranscriptEvents = [];
    // Applied in arrival order; revisions are monotonic so this equals applying
    // each delta as it arrived. React batches the resulting store updates into a
    // single render, so the O(n) flatten runs once for the whole batch.
    const store = useTranscriptStore.getState();
    for (const event of events) store.applyTranscript(event);
  };

  const latestUsageEventBySession = new Map<string, ActivityEvent>();
  let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushUsageEvents = (): void => {
    usageFlushTimer = null;
    if (latestUsageEventBySession.size === 0) return;
    const events = [...latestUsageEventBySession.values()];
    latestUsageEventBySession.clear();
    const store = useActivityStore.getState();
    for (const event of events) store.applyActivityEvent(event);
  };

  const unsubscribers: Unsubscribe[] = [
    feed.on('transcript', (event) => {
      pendingTranscriptEvents.push(event);
      if (transcriptFlushTimer === null) {
        transcriptFlushTimer = setTimeout(flushTranscriptEvents, TRANSCRIPT_COALESCE_MS);
      }
    }),
    feed.on('terminal', (event) => {
      // Dropped at the terminalFeed boundary unless the session is retained
      // (a task screen has it open) - triage needs activity, not PTY bytes.
      appendChunk(event.sessionId, event.payload.data);
    }),
    feed.on('terminal-resize', (event) => {
      // An event that repeats the dims the ring already holds means the
      // desktop terminal never reflowed, so the buffered bytes are still
      // laid out correctly and the live chunks stay coherent - skip the
      // re-seed rather than pay a serialized-frame round trip to repaint an
      // identical view. The desktop DOES emit such no-ops: its resize() has
      // no same-dims guard, and a task-detail remount (a project switch
      // away and back) re-sends the detail's unchanged fit. A null baseline
      // still re-seeds - with no known layout, the fresh frame is the truth.
      const previousDimensions = getTerminalDimensions(event.sessionId);
      setTerminalDimensions(event.sessionId, event.payload);
      if (
        previousDimensions !== null &&
        previousDimensions.cols === event.payload.cols &&
        previousDimensions.rows === event.payload.rows
      ) {
        return;
      }
      if (isTerminalRetained(event.sessionId)) {
        const existingTimer = resizeReseedTimers.get(event.sessionId);
        if (existingTimer !== undefined) clearTimeout(existingTimer);
        resizeReseedTimers.set(
          event.sessionId,
          setTimeout(() => {
            resizeReseedTimers.delete(event.sessionId);
            subscriptions.refreshStream(event.sessionId);
          }, RESIZE_RESEED_DEBOUNCE_MS),
        );
      }
    }),
    feed.on('activity', (event) => {
      if (event.payload.type === 'usage') {
        // Keep only the newest usage per session; flush per window so a token
        // firehose does not re-render TriageHome on every tick.
        latestUsageEventBySession.set(event.sessionId, event);
        if (usageFlushTimer === null) {
          usageFlushTimer = setTimeout(flushUsageEvents, USAGE_COALESCE_MS);
        }
        return;
      }
      useActivityStore.getState().applyActivityEvent(event);
    }),
    feed.on('board', (event) => {
      // BoardEvents carry ids only; reconciliation is a debounced re-snapshot.
      subscriptions.refreshBoard(event.projectId);
    }),
    feed.on('diff', (event) => {
      useDiffStore.getState().markStale(event.taskId);
      subscriptions.refreshDiff(event.taskId);
    }),
  ];
  return () => {
    for (const reseedTimer of resizeReseedTimers.values()) clearTimeout(reseedTimer);
    resizeReseedTimers.clear();
    if (transcriptFlushTimer !== null) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
    }
    flushTranscriptEvents();
    if (usageFlushTimer !== null) {
      clearTimeout(usageFlushTimer);
      usageFlushTimer = null;
    }
    flushUsageEvents();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
