import type { JsonValue, ReadDiffScope } from '@kangentic/protocol';
import { collapseToSnippetText, findAwaitedToolUse, lastAssistantText, type AwaitedToolUse } from '@/conversation/pendingPromptSummary';
import { useActivityStore } from '@/state/activityStore';
import { isDoneColumn, useBoardStore } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useReadingViewStore } from '@/state/readingViewStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { isTerminalRetained, releaseTerminal, resetTerminalFeed, retainTerminal } from '@/state/terminalFeed';
import { lastContentLineFromScrollback } from '@/terminal/liveTail';
import {
  getActiveConnection,
  reconnectNow,
  requireSubscriptions,
  requireVerbClient,
  type ConnectionTeardownIntent,
} from './connectionManager';
import { runBootstrap } from './bootstrap';

/**
 * The imperative API screens call - they never touch VerbClient or
 * SubscriptionManager directly. Everything here throws NotConnectedError
 * (or CapabilityError) for the caller's inline error state.
 */

export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  await requireVerbClient().sendUserMessage(sessionId, text);
}

export async function answerPermissionPrompt(sessionId: string, promptId: string, keystrokes: string): Promise<void> {
  await requireVerbClient().answerPermissionPrompt({ sessionId, promptId, keystrokes });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  await requireVerbClient().writeInteractiveTerminal(sessionId, data);
}

export async function moveTaskOptimistic(input: {
  projectId: string;
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
}): Promise<void> {
  const moveId = useBoardStore.getState().applyOptimisticMove({
    projectId: input.projectId,
    taskId: input.taskId,
    toSwimlaneId: input.targetSwimlaneId,
    toPosition: input.targetPosition,
  });
  try {
    await requireVerbClient().moveTask({
      taskId: input.taskId,
      targetSwimlaneId: input.targetSwimlaneId,
      targetPosition: input.targetPosition,
      projectId: input.projectId,
    });
    if (moveId) useBoardStore.getState().commitMove(moveId);
    // Authoritative positions arrive via the BoardEvent-triggered snapshot refresh.
  } catch (error) {
    if (moveId) useBoardStore.getState().rollbackMove(moveId);
    throw error;
  }
}

export async function createTask(input: { projectId: string; title: string; description: string; column: string }): Promise<void> {
  // create_task resolves the column by NAME desktop-side ("Backlog" creates
  // a backlog item); the board feed push shows the new card.
  const params: JsonValue = {
    project: input.projectId,
    title: input.title,
    description: input.description,
    column: input.column,
  };
  await requireVerbClient().boardToolWrite('create_task', params);
}

/** Edits a task's title and/or description (board-tool-write update_task), optimistically applied. */
export async function updateTaskFields(input: {
  projectId: string;
  taskId: string;
  title?: string;
  description?: string;
}): Promise<void> {
  const editId = useBoardStore.getState().applyOptimisticTaskEdit(input);
  try {
    const params: JsonValue = {
      project: input.projectId,
      taskId: input.taskId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    await requireVerbClient().boardToolWrite('update_task', params);
    if (editId) useBoardStore.getState().commitTaskEdit(editId);
  } catch (error) {
    if (editId) useBoardStore.getState().rollbackTaskEdit(editId);
    throw error;
  }
}

/** Deletes a task (board-tool-write delete_task; the desktop also kills its live session PTY), optimistically removed. */
export async function deleteTaskFromBoard(input: { projectId: string; taskId: string }): Promise<void> {
  const removalId = useBoardStore.getState().applyOptimisticRemoval(input);
  try {
    const params: JsonValue = { project: input.projectId, taskId: input.taskId };
    await requireVerbClient().boardToolWrite('delete_task', params);
    if (removalId) useBoardStore.getState().commitRemoval(removalId);
  } catch (error) {
    if (removalId) useBoardStore.getState().rollbackRemoval(removalId);
    throw error;
  }
}

/**
 * Archives a task the way the desktop does: a move into the board's
 * done-role column (archive is not a board-tool command; the desktop's
 * cross-column move handler owns the archive semantics). Throws when the
 * board has no done column.
 *
 * Matched on `role` alone, exactly as the desktop's own lookup does
 * (`task-archive.ts`: `swimlanes.list().find((l) => l.role === 'done')`).
 * A `!is_archived` guard here looks defensive but is fatal: the done lane
 * ships with `is_archived: 1` precisely BECAUSE it is the lane that archives
 * what lands in it, so the guard matched nothing and every archive threw.
 */
export async function archiveTask(input: { projectId: string; taskId: string }): Promise<void> {
  const board = useBoardStore.getState().boardsByProjectId[input.projectId];
  const doneColumn = board?.columns.find((column) => isDoneColumn(column) && !column.is_ghost);
  if (!doneColumn) throw new Error('This board has no Done column to archive into');
  await moveTaskOptimistic({
    projectId: input.projectId,
    taskId: input.taskId,
    targetSwimlaneId: doneColumn.id,
    targetPosition: 0,
  });
}

/** Page size for the Done column. One screenful plus headroom, so the common board needs a single round trip. */
export const ARCHIVED_PAGE_SIZE = 25;

/**
 * Loads a page of a project's completed tasks into the board store.
 *
 * One-shot by design: completed work is not part of either board projection,
 * and subscribing to it would re-send an ever-growing list on every board
 * change. `append: false` refreshes from the top, `true` pages further back.
 */
export async function loadArchivedTasks(input: { projectId: string; append?: boolean }): Promise<void> {
  const append = input.append ?? false;
  const board = useBoardStore.getState();
  const alreadyHeld = board.archivedByProjectId[input.projectId];
  if (alreadyHeld?.loading) return;
  // Paging past the end is a no-op rather than a wasted round trip. Measured
  // against the fetch cursor, not the held rows: those two diverge whenever a
  // page arrives carrying a row already held, and a full archive would then
  // never satisfy this guard.
  if (append && alreadyHeld && alreadyHeld.nextOffset >= alreadyHeld.totalCount) return;

  board.setArchivedLoading(input.projectId, true);
  try {
    const page = await requireVerbClient().readBoardArchived(input.projectId, {
      limit: ARCHIVED_PAGE_SIZE,
      offset: append ? (alreadyHeld?.nextOffset ?? 0) : 0,
    });
    useBoardStore.getState().applyArchivedPage(page, { append });
  } catch (error) {
    useBoardStore.getState().setArchivedLoading(input.projectId, false);
    throw error;
  }
}

/** Sets the Changes tab's live diff watch (scope changes re-subscribe); pass null on blur. */
export function setDiffWatch(taskId: string, input: { projectId: string; scope: ReadDiffScope } | null): void {
  const connection = getActiveConnection();
  if (!connection) return;
  if (input) {
    useDiffStore.getState().setStatus(taskId, input.scope, 'loading');
    connection.subscriptions.setDesiredDiff(taskId, input);
  } else {
    connection.subscriptions.setDesiredDiff(taskId, null);
    useDiffStore.getState().clearTask(taskId);
  }
}

export async function fetchDiffFileContent(input: {
  taskId: string;
  projectId: string;
  filePath: string;
  scope: ReadDiffScope;
}): Promise<void> {
  const cached = useDiffStore.getState().byTaskId[input.taskId]?.contentByPath[input.filePath];
  if (cached) return;
  const content = await requireVerbClient().readDiffFileContent(input);
  useDiffStore.getState().applyFileContent(input.taskId, input.filePath, content);
}

/** Initial window size on screen open - enough to fill the list a few screens deep; older pages load on scroll-up. */
const TRANSCRIPT_INITIAL_WINDOW = 60;
const TRANSCRIPT_PAGE_SIZE = 60;

/**
 * Fetches the newest transcript window for a retained session - the
 * screen-open bootstrap and the self-heal path whenever the store flags
 * `needsTailFetch` (reset signal, delta gap, delta before any window).
 */
const tailFetchesInFlight = new Map<string, Promise<void>>();

export async function loadTranscriptTail(sessionId: string): Promise<void> {
  // openSessionScreen fires one of these, and the screen's needsTailFetch
  // self-heal effect mounts while it is still in flight and fires a second.
  // Both resolved with the same window and each applied it wholesale, so the
  // feed's cell identity was replaced twice mid-layout for no gain.
  const inFlight = tailFetchesInFlight.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const fetch = (async () => {
    const window = await requireVerbClient().readTranscriptWindow(sessionId, { limit: TRANSCRIPT_INITIAL_WINDOW });
    useTranscriptStore.getState().applyWindow(sessionId, window);
  })();
  const tracked = fetch.finally(() => {
    tailFetchesInFlight.delete(sessionId);
  });
  tailFetchesInFlight.set(sessionId, tracked);
  return tracked;
}

/** Scroll-up pagination: prepends the next older window above the current one. */
export async function loadOlderTranscript(sessionId: string): Promise<void> {
  const session = useTranscriptStore.getState().bySessionId[sessionId];
  if (!session || session.startIndex === 0) return;
  const window = await requireVerbClient().readTranscriptWindow(sessionId, {
    beforeIndex: session.startIndex,
    limit: TRANSCRIPT_PAGE_SIZE,
  });
  useTranscriptStore.getState().applyWindow(sessionId, window);
}

/**
 * A task screen opened a session: retain its transcript + terminal buffers,
 * re-subscribe the stream so fresh scrollback (and delta flow) resume even
 * though payloads were being dropped while unwatched, and fetch the newest
 * transcript window (the desktop never pushes whole transcripts).
 */
export function openSessionScreen(sessionId: string): void {
  useTranscriptStore.getState().retainSession(sessionId);
  retainTerminal(sessionId);
  useActivityStore.getState().markRead(sessionId);
  const connection = getActiveConnection();
  // This is the only screen that renders PTY bytes, so it is the only place
  // that asks for them. The flip already re-subscribes, and that IS the fetch
  // of the fresh scrollback the terminal seeds itself from - so only ask for
  // a refresh when the flag was already set (reopening a screen that never
  // closed), or the open costs two round trips and seeds the WebView twice.
  const resubscribed = connection?.subscriptions.setStreamWantsTerminal(sessionId, true) ?? false;
  if (!resubscribed) connection?.subscriptions.refreshStream(sessionId);
  void loadTranscriptTail(sessionId).catch(() => {
    // Not connected yet or a transient failure: the store keeps
    // needsTailFetch set, and the screen retries when it sees the flag.
  });
}

/**
 * The Board tab is looking at a project: upgrade that board to the full
 * projection. Every other board stays on the feed projection, which carries
 * only the tasks an agent is actually running.
 */
export function openProjectBoard(projectId: string): void {
  getActiveConnection()?.subscriptions.setBoardWantsFull(projectId);
}

export function closeSessionScreen(sessionId: string): void {
  // Transcript retention is LRU-capped rather than released on close, so
  // backing out and returning is instant; the terminal ring is released
  // (raw PTY bytes are the heavy part).
  releaseTerminal(sessionId);
  // Stop the desktop SENDING those bytes too. Releasing the ring only stopped
  // us keeping them; the relay was still carrying every one.
  getActiveConnection()?.subscriptions.setStreamWantsTerminal(sessionId, false);
  useActivityStore.getState().markRead(sessionId);
}

/** How many newest transcript entries a prompt peek scans; the awaited tool_use is almost always in the last one. */
const PROMPT_PEEK_WINDOW = 12;
const PROMPT_PEEK_CACHE_CAP = 100;
const awaitedPromptPeekCache = new Map<string, AwaitedToolUse | null>();

/**
 * One-shot lookup of the awaited prompt's tool_use for a session the Home
 * feed is NOT retaining a transcript for: fetches a small newest window
 * directly (no store writes) and caches by promptId so a list re-render
 * never refetches. The needs-you card renders a generic Approve/Deny
 * immediately (answering needs only the promptId) and upgrades when this
 * resolves.
 */
export async function peekAwaitedPrompt(sessionId: string, awaitedPromptId: string): Promise<AwaitedToolUse | null> {
  const cached = awaitedPromptPeekCache.get(awaitedPromptId);
  if (cached !== undefined) return cached;
  const transcriptWindow = await requireVerbClient().readTranscriptWindow(sessionId, { limit: PROMPT_PEEK_WINDOW });
  const awaitedToolUse = findAwaitedToolUse(transcriptWindow.entries, sessionId, awaitedPromptId);
  if (awaitedPromptPeekCache.size >= PROMPT_PEEK_CACHE_CAP) awaitedPromptPeekCache.clear();
  awaitedPromptPeekCache.set(awaitedPromptId, awaitedToolUse);
  return awaitedToolUse;
}

/**
 * The message peek scans fewer entries than the prompt peek: the last
 * assistant text is nearly always within the newest few, and window
 * entries are heavy (full tool inputs and results ride along).
 */
const MESSAGE_PEEK_WINDOW = 8;

interface SnippetPeekRecord {
  fetchedAtMs: number;
  text: string | null;
}

const lastMessagePeekBySession = new Map<string, SnippetPeekRecord>();
const inFlightMessagePeeks = new Map<string, Promise<string | null>>();

/**
 * Inbox snippet for an Agents-feed row: the last assistant text from a
 * session the feed is NOT retaining a transcript for. THROTTLED per
 * session: an actively-working session bumps its unread counter on every
 * engine event, and a long-lived session's transcript window can run to
 * megabytes, so the caller passes `minFreshnessMs` - a result younger
 * than that is returned without a wire fetch (pass 0 to force fresh, the
 * idle-row case where the final message just landed). Concurrent calls
 * share one in-flight fetch.
 */
export async function peekLastAssistantMessage(sessionId: string, minFreshnessMs: number): Promise<string | null> {
  // A session the user has opened is RETAINED, and its transcript deltas
  // already stream into transcriptStore live. Read the newest message from
  // there: free, no wire round trip, and always current - the throttled
  // fetch below could otherwise show text up to minFreshnessMs old while
  // the agent was visibly producing newer messages.
  //
  // Unless the store knows it fell behind: a delta that arrived with a gap
  // leaves `entries` deliberately stale and sets needsTailFetch, and only a
  // mounted chat screen re-fetches. For a retained-but-unmounted session that
  // stale text would otherwise be pinned on the feed indefinitely, so fall
  // through to the wire fetch instead.
  const localSession = useTranscriptStore.getState().bySessionId[sessionId];
  if (localSession !== undefined && !localSession.needsTailFetch && localSession.entries.length > 0) {
    const localSnippet = lastAssistantText(localSession.entries);
    if (localSnippet !== null) return localSnippet;
  }
  const record = lastMessagePeekBySession.get(sessionId);
  if (record !== undefined && minFreshnessMs > 0 && Date.now() - record.fetchedAtMs < minFreshnessMs) {
    return record.text;
  }
  const inFlight = inFlightMessagePeeks.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const fetchPromise = (async () => {
    const transcriptWindow = await requireVerbClient().readTranscriptWindow(sessionId, { limit: MESSAGE_PEEK_WINDOW });
    const snippet = lastAssistantText(transcriptWindow.entries);
    if (lastMessagePeekBySession.size >= PROMPT_PEEK_CACHE_CAP) lastMessagePeekBySession.clear();
    lastMessagePeekBySession.set(sessionId, { fetchedAtMs: Date.now(), text: snippet });
    return snippet;
  })();
  inFlightMessagePeeks.set(sessionId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightMessagePeeks.delete(sessionId);
  }
}

const TERMINAL_LINE_SNIPPET_MAX_LENGTH = 200;

const lastTerminalLinePeekBySession = new Map<string, SnippetPeekRecord>();
const inFlightTerminalLinePeeks = new Map<string, Promise<string | null>>();

/**
 * Snippet fallback for TRANSCRIPT-LESS sessions (codex-style agents): the
 * last readable line of the session's PTY scrollback, from a fresh
 * read-stream snapshot (re-subscribe is replace semantics desktop-side,
 * so this never duplicates the feed). Skipped while the session screen
 * retains the terminal - that surface owns the live feed. Throttled per
 * session exactly like peekLastAssistantMessage.
 *
 * This is the ONE place outside a session screen that has to ask for PTY
 * bytes: the scrollback IS the snippet, and a list-only subscribe returns an
 * empty one. Because the desktop's subscribe replaces whatever that session
 * was subscribed with, the one-shot leaves PTY streaming armed for a session
 * showing no terminal - the exact ~13MB/hour cost the `terminal` flag exists
 * to remove - so it is put straight back to list-only afterwards.
 */
export async function peekLastTerminalLine(sessionId: string, minFreshnessMs: number): Promise<string | null> {
  if (isTerminalRetained(sessionId)) return null;
  const record = lastTerminalLinePeekBySession.get(sessionId);
  if (record !== undefined && minFreshnessMs > 0 && Date.now() - record.fetchedAtMs < minFreshnessMs) {
    return record.text;
  }
  const inFlight = inFlightTerminalLinePeeks.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const fetchPromise = (async () => {
    const snapshot = await requireVerbClient().readStreamSubscribe(sessionId, { terminal: true });
    // Put the subscription straight back to list-only. The desktop replaces a
    // session's subscription on every subscribe, so without this the one-shot
    // above leaves PTY bytes streaming to a feed row that discards them.
    getActiveConnection()?.subscriptions.refreshStream(sessionId);
    // Content, not chrome: skip status/spinner lines and context bars so
    // the snippet reads like the agent's most recent message, and collapse
    // decoration so a separator run never renders as literal lines.
    const contentLine = lastContentLineFromScrollback(snapshot.scrollback);
    const collapsedLine = contentLine !== null ? collapseToSnippetText(contentLine) : '';
    const snippet = collapsedLine.length > 0 ? collapsedLine.slice(0, TERMINAL_LINE_SNIPPET_MAX_LENGTH) : null;
    if (lastTerminalLinePeekBySession.size >= PROMPT_PEEK_CACHE_CAP) lastTerminalLinePeekBySession.clear();
    lastTerminalLinePeekBySession.set(sessionId, { fetchedAtMs: Date.now(), text: snippet });
    return snippet;
  })();
  inFlightTerminalLinePeeks.set(sessionId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightTerminalLinePeeks.delete(sessionId);
  }
}

/**
 * Re-subscribe one session's stream for a fresh serialized frame (replace
 * semantics desktop-side). The terminal refit button's "unstick" half: a
 * mirror wedged by a missed resize or a corrupted seed re-seeds from truth.
 */
export function refreshTerminalStream(sessionId: string): void {
  getActiveConnection()?.subscriptions.refreshStream(sessionId);
}

/**
 * Clear EVERYTHING the phone holds from the paired desktop: board, activity,
 * transcripts, diffs, terminal ring buffers, the cleaned reading view, the
 * module-level peek caches (prompt options, message and terminal-line
 * snippets), and settings keyed by the old desktop's own task IDs. Unpairing
 * revokes trust; content fetched under that trust must not outlive it on an
 * unlocked phone, so the unpair and pairing-completion paths call this right
 * before reconnectNow(). In-flight peeks need no cancellation - the
 * connection they ride is being torn down, so they reject and cache nothing.
 */
export function wipeDesktopContent(): void {
  useBoardStore.getState().reset();
  useActivityStore.getState().reset();
  useTranscriptStore.getState().reset();
  useDiffStore.getState().reset();
  useReadingViewStore.getState().reset();
  resetTerminalFeed();
  awaitedPromptPeekCache.clear();
  lastMessagePeekBySession.clear();
  lastTerminalLinePeekBySession.clear();
  // Fire-and-forget like openSessionScreen's tail fetch: the in-memory clear
  // above already ran synchronously; this only persists the empty map. A
  // rejected write leaves a stale, non-secret lens map that the next lens
  // pick or wipe overwrites, so the failure is safe to swallow.
  void useSettingsStore.getState().clearDesktopScopedPreferences().catch(() => {});
}

/**
 * The local half of unpairing, shared by both ways a pairing ends: the
 * user's own Unpair button (DevicesScreen, 'announce-departure') and a
 * desktop-side revoke arriving as the session's Final frame
 * (connectionManager's revocation handler, 'stay-silent' - the desktop
 * already knows). Clears the trust anchor, wipes everything fetched under
 * it, and swaps the connection so the reopen lands on the unpaired path.
 * The push unregister stays with the callers - only a local unpair still
 * has a channel to send it over - and navigation is the caller's concern.
 *
 * The clear goes first (a reconnect before it would redial the old
 * desktop), but the wipe and the teardown must not hinge on it: a locked
 * Keystore rejecting the delete still rethrows to the caller's error
 * surface, while the finally guarantees no content fetched under the old
 * trust outlives the unpair and no stale channel keeps running. A stale
 * anchor is the recoverable half - Devices still offers a retry - whereas
 * un-wiped content on a remotely revoked phone is not.
 */
export async function unpairLocally(intent: ConnectionTeardownIntent): Promise<void> {
  try {
    // Lazy on purpose: many unit suites import actions.ts while mocking
    // connectionManager but not expo-secure-store, and trustAnchor.ts reads
    // the keychain-accessibility constant at module scope - a static import
    // here would force every one of those suites to stub it.
    const { TrustAnchorStore } = await import('@/pairing/trustAnchor');
    await new TrustAnchorStore().clear();
  } finally {
    wipeDesktopContent();
    reconnectNow(intent);
  }
}

/** Pull-to-refresh: re-run the bootstrap (re-subscribes replace desktop-side, so this is snapshot refresh everywhere). */
export async function refreshSnapshots(): Promise<void> {
  const connection = getActiveConnection();
  if (!connection || !connection.controller.session.isEstablished) return;
  await runBootstrap(connection.verbs, requireSubscriptions());
}
