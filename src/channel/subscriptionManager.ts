import type {
  DiffFileListWire,
  ReadBoardSnapshotResponsePayload,
  ReadBoardView,
  ReadDiffScope,
  ReadStreamResponsePayload,
  Unsubscribe,
} from '@kangentic/protocol';
import type { SessionManager } from './sessionManager';
import { CapabilityError, type VerbClient } from './verbClient';

const BOARD_REFRESH_DEBOUNCE_MS = 300;
const DIFF_REFRESH_DEBOUNCE_MS = 500;
const STREAM_RETRY_DELAY_MS = 2000;

export interface SubscriptionSnapshotSinks {
  onStreamSnapshot(sessionId: string, snapshot: ReadStreamResponsePayload): void;
  /** A stream subscribe the desktop rejected (e.g. "No such session") - the id is pruned from the desired set before this fires. */
  onStreamRejected(sessionId: string, error: CapabilityError): void;
  onBoardSnapshot(snapshot: ReadBoardSnapshotResponsePayload): void;
  onDiffFileList(taskId: string, fileList: DiffFileListWire): void;
  /** A diff fetch that failed, so the Changes pane can stop waiting and say so. */
  onDiffFetchFailed(taskId: string, scope: ReadDiffScope): void;
}

interface DesiredDiff {
  projectId: string;
  scope: ReadDiffScope;
}

export interface SubscriptionManagerOptions {
  session: SessionManager;
  verbs: VerbClient;
  sinks: SubscriptionSnapshotSinks;
}

/**
 * A desired-state reconciler over the verb client: screens and the
 * bootstrap declare WHAT should be live (stream sessions, board projects,
 * at most a screenful of diff watches) and this owns WHEN to (re)issue the
 * subscribe requests.
 *
 * Key desktop facts this leans on:
 * - `SubscriptionRegistry.set` desktop-side replaces-and-tears-down a prior
 *   subscription under the same key, so re-issuing a subscribe is always
 *   safe and doubles as "refresh the snapshot".
 * - `SessionManager.onEstablished` fires only on the null-to-established
 *   transition: a routine ~2 minute desktop rekey does NOT reset streams
 *   (the desktop keeps its registry across rekeys), while a transport drop
 *   runs `ChannelController`'s `session.reset()`, so the next handshake
 *   fires it - exactly when the desktop may have torn subscriptions down
 *   and a fresh snapshot is wanted anyway. Resubscribe-on-established is
 *   both necessary and sufficient.
 *
 * Every subscribe result flows through the sinks, making first-subscribe
 * and resubscribe one code path: stores always get snapshots from sinks
 * and deltas from FeedRouter.
 */
export class SubscriptionManager {
  private readonly session: SessionManager;
  private readonly verbs: VerbClient;
  private readonly sinks: SubscriptionSnapshotSinks;
  private readonly unsubscribeEstablished: Unsubscribe;

  private desiredStreamIds = new Set<string>();
  private desiredBoardIds = new Set<string>();
  private readonly desiredDiffsByTaskId = new Map<string, DesiredDiff>();

  private readonly activeStreamIds = new Set<string>();
  /**
   * Sessions whose subscription must carry live PTY bytes - the ones with a
   * terminal on screen. Everything else subscribes list-only: the feed needs
   * activity, not output it discards on arrival.
   */
  private readonly terminalStreamIds = new Set<string>();
  private readonly activeBoardIds = new Set<string>();
  /**
   * Which projection each board is subscribed with. Boards start at
   * 'sessions' (the feed watches every project but only draws the tasks with
   * an agent on them) and are upgraded to 'full' when the Board tab opens
   * one. The upgrade is permanent for the life of the pairing: a full board
   * is at most a few tens of kB, and downgrading would let a snapshot drop a
   * task that an optimistic move/edit/removal is still pending on, leaving
   * the rollback with nothing to restore.
   */
  private readonly boardViewByProjectId = new Map<string, ReadBoardView>();
  /**
   * The projection each board's last SUCCESSFUL subscribe actually returned,
   * as opposed to the one wanted above. Kept apart so a failed upgrade can be
   * retried: recording the intent as if it had landed would make every later
   * request a no-op, and the Board tab would wait on a snapshot nobody was
   * going to ask for again.
   */
  private readonly activeBoardViewByProjectId = new Map<string, ReadBoardView>();
  private readonly activeDiffTaskIds = new Set<string>();

  private readonly boardRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly diffRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly streamRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(options: SubscriptionManagerOptions) {
    this.session = options.session;
    this.verbs = options.verbs;
    this.sinks = options.sinks;
    this.unsubscribeEstablished = this.session.onEstablished(() => this.onEstablished());
  }

  setDesiredStreams(sessionIds: ReadonlySet<string>): void {
    const previousDesired = this.desiredStreamIds;
    this.desiredStreamIds = new Set(sessionIds);

    for (const sessionId of previousDesired) {
      if (!this.desiredStreamIds.has(sessionId)) this.dropStream(sessionId);
    }
    if (!this.session.isEstablished) return;
    for (const sessionId of this.desiredStreamIds) {
      if (!this.activeStreamIds.has(sessionId) && !this.streamRetryTimers.has(sessionId)) {
        void this.subscribeStream(sessionId);
      }
    }
  }

  setDesiredBoards(projectIds: ReadonlySet<string>): void {
    const previousDesired = this.desiredBoardIds;
    this.desiredBoardIds = new Set(projectIds);

    for (const projectId of previousDesired) {
      if (!this.desiredBoardIds.has(projectId)) this.dropBoard(projectId);
    }
    if (!this.session.isEstablished) return;
    for (const projectId of this.desiredBoardIds) {
      if (!this.activeBoardIds.has(projectId)) void this.subscribeBoard(projectId);
    }
  }

  /**
   * Upgrade one project's board to the full projection - the Board tab, which
   * renders every column and every card, not just the ones with an agent on
   * them. Never reversed (see boardViewByProjectId).
   *
   * Safe to call repeatedly, and the Board tab does on every focus: while the
   * upgrade has not actually landed this re-issues it, so a request lost to a
   * rekey or a timeout is retried by leaving the tab and coming back rather
   * than stranding the screen on its loading state.
   */
  setBoardWantsFull(projectId: string): void {
    this.boardViewByProjectId.set(projectId, 'full');
    if (this.activeBoardViewByProjectId.get(projectId) === 'full') return;
    if (!this.desiredBoardIds.has(projectId) || !this.session.isEstablished) return;
    void this.subscribeBoard(projectId);
  }

  /** At most a screenful of these exist (the Changes tab sets one on focus, null on blur) - the desktop fs-watcher is the scarce resource. */
  setDesiredDiff(taskId: string, input: DesiredDiff | null): void {
    if (input === null) {
      const previous = this.desiredDiffsByTaskId.get(taskId);
      this.desiredDiffsByTaskId.delete(taskId);
      if (this.activeDiffTaskIds.has(taskId) && previous) this.dropDiff(taskId, previous.projectId);
      return;
    }
    const previous = this.desiredDiffsByTaskId.get(taskId);
    this.desiredDiffsByTaskId.set(taskId, input);
    const scopeChanged = previous !== undefined && (previous.scope !== input.scope || previous.projectId !== input.projectId);
    if (!this.session.isEstablished) return;
    // A scope change is a re-subscribe (the desktop keys the watch by task
    // only and replaces it); an unchanged active watch needs nothing.
    if (!this.activeDiffTaskIds.has(taskId) || scopeChanged) void this.subscribeDiff(taskId, input);
  }

  /** Debounced re-subscribe: the BoardEvent delta carries ids only, so reconciliation is a fresh snapshot. */
  refreshBoard(projectId: string): void {
    if (!this.desiredBoardIds.has(projectId)) return;
    const existingTimer = this.boardRefreshTimers.get(projectId);
    if (existingTimer) return;
    this.boardRefreshTimers.set(
      projectId,
      setTimeout(() => {
        this.boardRefreshTimers.delete(projectId);
        if (this.session.isEstablished && this.desiredBoardIds.has(projectId)) void this.subscribeBoard(projectId);
      }, BOARD_REFRESH_DEBOUNCE_MS),
    );
  }

  /**
   * Declare whether this session's subscription needs live PTY bytes. A
   * session screen turns it on when it opens and off when it closes; the feed
   * never turns it on. Flipping it re-subscribes, which is also what fetches
   * the fresh scrollback a newly-opened terminal needs to seed itself.
   *
   * Returns whether it issued that re-subscribe, so a caller that also wants
   * a fresh frame knows whether it still needs to ask for one.
   */
  setStreamWantsTerminal(sessionId: string, wantsTerminal: boolean): boolean {
    const previous = this.terminalStreamIds.has(sessionId);
    if (previous === wantsTerminal) return false;
    if (wantsTerminal) this.terminalStreamIds.add(sessionId);
    else this.terminalStreamIds.delete(sessionId);
    if (!this.desiredStreamIds.has(sessionId) || !this.session.isEstablished) return false;
    void this.subscribeStream(sessionId);
    return true;
  }

  /** Immediate re-subscribe for one stream - the fresh-scrollback path when a session screen opens. */
  refreshStream(sessionId: string): void {
    if (!this.desiredStreamIds.has(sessionId) || !this.session.isEstablished) return;
    void this.subscribeStream(sessionId);
  }

  /** Debounced diff refetch after a DiffEvent (the event is a payload-less "re-fetch" signal). */
  refreshDiff(taskId: string): void {
    if (!this.desiredDiffsByTaskId.has(taskId)) return;
    if (this.diffRefreshTimers.has(taskId)) return;
    this.diffRefreshTimers.set(
      taskId,
      setTimeout(() => {
        this.diffRefreshTimers.delete(taskId);
        const desired = this.desiredDiffsByTaskId.get(taskId);
        if (desired && this.session.isEstablished) void this.subscribeDiff(taskId, desired);
      }, DIFF_REFRESH_DEBOUNCE_MS),
    );
  }

  /** Read-only copies of the desired/active sets, for the dev inspect bridge. */
  debugSnapshot(): {
    desiredStreams: string[];
    activeStreams: string[];
    desiredBoards: string[];
    activeBoards: string[];
    fullBoards: string[];
    desiredDiffTaskIds: string[];
    activeDiffTaskIds: string[];
  } {
    return {
      desiredStreams: [...this.desiredStreamIds].sort(),
      activeStreams: [...this.activeStreamIds].sort(),
      desiredBoards: [...this.desiredBoardIds].sort(),
      activeBoards: [...this.activeBoardIds].sort(),
      fullBoards: [...this.boardViewByProjectId.entries()].filter(([, view]) => view === 'full').map(([projectId]) => projectId).sort(),
      desiredDiffTaskIds: [...this.desiredDiffsByTaskId.keys()].sort(),
      activeDiffTaskIds: [...this.activeDiffTaskIds].sort(),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeEstablished();
    for (const timer of this.boardRefreshTimers.values()) clearTimeout(timer);
    this.boardRefreshTimers.clear();
    for (const timer of this.diffRefreshTimers.values()) clearTimeout(timer);
    this.diffRefreshTimers.clear();
    for (const timer of this.streamRetryTimers.values()) clearTimeout(timer);
    this.streamRetryTimers.clear();
  }

  private onEstablished(): void {
    // The previous connection's actives are meaningless on a fresh
    // handshake (the desktop tore its registry down on disconnect).
    this.activeStreamIds.clear();
    this.activeBoardIds.clear();
    this.activeBoardViewByProjectId.clear();
    this.activeDiffTaskIds.clear();
    for (const projectId of this.desiredBoardIds) void this.subscribeBoard(projectId);
    for (const sessionId of this.desiredStreamIds) void this.subscribeStream(sessionId);
    for (const [taskId, desired] of this.desiredDiffsByTaskId) void this.subscribeDiff(taskId, desired);
  }

  private async subscribeStream(sessionId: string, isRetry = false): Promise<void> {
    const wantsTerminal = this.terminalStreamIds.has(sessionId);
    try {
      const snapshot = await this.verbs.readStreamSubscribe(sessionId, { terminal: wantsTerminal });
      if (this.disposed || !this.desiredStreamIds.has(sessionId)) return;
      // Same staleness guard as subscribeBoard. Opening and immediately
      // closing a session screen flips the flag twice, so two subscribes are
      // in flight with opposite terminal values; whichever landed last would
      // otherwise decide the bookkeeping regardless of which is current.
      // Dropping the stale one loses nothing: the flag only ever changes on a
      // path that issues its own subscribe, so a fresher one is always coming.
      if (this.terminalStreamIds.has(sessionId) !== wantsTerminal) return;
      this.activeStreamIds.add(sessionId);
      this.sinks.onStreamSnapshot(sessionId, snapshot);
    } catch (error) {
      if (this.disposed || !this.desiredStreamIds.has(sessionId)) return;
      if (error instanceof CapabilityError) {
        // The desktop said no (session gone) - prune; the next board
        // snapshot reconcile re-adds it if it comes back.
        this.desiredStreamIds.delete(sessionId);
        this.sinks.onStreamRejected(sessionId, error);
        return;
      }
      // Timeout / transient transport failure: retry once after a beat,
      // then leave it to the next reconcile (established or board-driven).
      if (!isRetry && !this.streamRetryTimers.has(sessionId)) {
        this.streamRetryTimers.set(
          sessionId,
          setTimeout(() => {
            this.streamRetryTimers.delete(sessionId);
            if (this.session.isEstablished && this.desiredStreamIds.has(sessionId)) void this.subscribeStream(sessionId, true);
          }, STREAM_RETRY_DELAY_MS),
        );
      }
    }
  }

  private async subscribeBoard(projectId: string): Promise<void> {
    const view = this.boardViewByProjectId.get(projectId) ?? 'sessions';
    try {
      const snapshot = await this.verbs.readBoardSubscribe(projectId, { view });
      if (this.disposed || !this.desiredBoardIds.has(projectId)) return;
      // A response that answers a view we no longer want is stale, and
      // applying it would UNDO a newer one. Two subscribes for the same
      // project are legitimately in flight together (bootstrap asks for
      // 'sessions', the Board tab focusing then asks for 'full'), and
      // responses can land out of issue order. Without this, a late
      // 'sessions' snapshot overwrites the landed 'full' one: applyBoardSnapshot
      // replaces tasksById wholesale, so every task without a live session
      // vanishes from the Board tab, any optimistic move over one of them has
      // nothing left to commit against, and the screen strands on its skeleton
      // until the tab is re-focused. Mirrors the check subscribeDiff makes.
      if ((this.boardViewByProjectId.get(projectId) ?? 'sessions') !== view) return;
      this.activeBoardIds.add(projectId);
      this.activeBoardViewByProjectId.set(projectId, view);
      this.sinks.onBoardSnapshot(snapshot);
    } catch {
      // Board subscribe failures are recovered by the next reconcile
      // (established, refreshBoard, a desired-set change, or the Board tab
      // re-focusing, which re-issues an upgrade that has not landed).
    }
  }

  private async subscribeDiff(taskId: string, desired: DesiredDiff): Promise<void> {
    try {
      const fileList = await this.verbs.readDiffFileList({ taskId, projectId: desired.projectId, scope: desired.scope });
      if (this.disposed || this.desiredDiffsByTaskId.get(taskId) !== desired) return;
      this.activeDiffTaskIds.add(taskId);
      this.sinks.onDiffFileList(taskId, fileList);
    } catch {
      // Screen-driven, and the Changes tab can re-trigger via setDesiredDiff -
      // but it can only show the failure if it is TOLD about it. Swallowing
      // here left `fileListStatus` on 'loading' forever, so a refused or
      // timed-out diff rendered as a skeleton that never resolved, and
      // DiffFetchStatus's 'error' member had no writer at all.
      //
      // Same staleness guard as the success path: a watch that has since been
      // dropped or re-scoped must not write over the current one's state.
      if (this.disposed || this.desiredDiffsByTaskId.get(taskId) !== desired) return;
      this.sinks.onDiffFetchFailed(taskId, desired.scope);
    }
  }

  private dropStream(sessionId: string): void {
    const retryTimer = this.streamRetryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.streamRetryTimers.delete(sessionId);
    }
    // terminalStreamIds is NOT cleared here: it is screen-owned state, set by
    // openSessionScreen and cleared by closeSessionScreen. A stream can drop
    // out of the desired set while its screen stays mounted (the task gets
    // archived desktop-side, say), and clearing the flag would bring the
    // session back list-only, leaving a mounted terminal permanently frozen.
    //
    // Nothing leaks: closeSessionScreen is the CLEANUP of SessionScreen's
    // mount effect, so it runs on every unmount path, not just the back
    // button - and a process death takes this manager with it.
    if (!this.activeStreamIds.has(sessionId)) return;
    this.activeStreamIds.delete(sessionId);
    if (this.session.isEstablished) void this.verbs.readStreamUnsubscribe(sessionId).catch(() => undefined);
  }

  private dropBoard(projectId: string): void {
    const refreshTimer = this.boardRefreshTimers.get(projectId);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      this.boardRefreshTimers.delete(projectId);
    }
    // The project left the desired set entirely; a later re-add starts back at
    // the feed projection and the Board tab upgrades it again if opened. Both
    // maps go, or a stale 'full' active would make that upgrade a no-op.
    this.boardViewByProjectId.delete(projectId);
    this.activeBoardViewByProjectId.delete(projectId);
    if (!this.activeBoardIds.has(projectId)) return;
    this.activeBoardIds.delete(projectId);
    if (this.session.isEstablished) void this.verbs.readBoardUnsubscribe(projectId).catch(() => undefined);
  }

  private dropDiff(taskId: string, projectId: string): void {
    this.activeDiffTaskIds.delete(taskId);
    if (this.session.isEstablished) {
      void this.verbs.readDiffUnsubscribe({ taskId, projectId }).catch(() => undefined);
    }
  }
}
