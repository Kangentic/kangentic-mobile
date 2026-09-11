import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components';
import { findArchivedTaskById, findTaskById, isDoneRole, isTodoRole, useBoardStore } from '@/state/boardStore';
import { selectSessionEnded, useActivityStore } from '@/state/activityStore';
import { useSettingsStore } from '@/state/settingsStore';
import { selectChatLens, useTranscriptStore } from '@/state/transcriptStore';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { closeSessionScreen, loadArchivedTasks, openSessionScreen } from '@/connection/actions';
import { TaskHeader } from './TaskHeader';
import { ChatPane } from './ChatPane';
import { ChangesTab } from './ChangesTab';
import { TerminalTab } from './TerminalTab';
import { SessionEndedState } from './SessionEndedState';
import { SessionSwitchingState } from './SessionSwitchingState';
import { SessionInputBar } from './SessionInputBar';
import { ModeToggleHint } from './ModeToggleHint';
import { resolveCurrentSessionId } from './sessionResolution';
import type { SessionMode } from './SessionModeToggle';

/**
 * How long a 'rejected' stream feed must persist before the screen declares
 * the session dead. A respawn races the board snapshot against the old
 * stream's rejection; the grace window keeps the ended state from flashing
 * when the successor sessionId is about to arrive.
 */
const REJECTED_FEED_GRACE_MS = 1500;

/**
 * How long a column move may keep the screen in the "switching session" state
 * before it gives up and declares the session ended.
 *
 * A move that restarts the agent suspends the old session (which pushes
 * `session-ended`) and spawns the successor after the worktree work, so the
 * gap is the whole desktop-side move. Measured on the desktop's own IPC log:
 * cross-column `task:move` runs a median 2.3s with a 24.4s tail, and the
 * successor's board snapshot normally closes this window in ~2-3s. 20s covers
 * the common tail without leaving a wrong "switching" label up indefinitely
 * when nothing is coming.
 */
const SESSION_SWAP_GRACE_MS = 20_000;

/**
 * The task's SESSION view: one live session, three surfaces. Terminal (the
 * raw 1:1 desktop mirror, the default), Chat (the readable feed), and
 * Changes (the diff) are absolutely-positioned siblings with only the active
 * one visible - all stay mounted so the xterm WebView never reloads and the
 * conversation keeps scroll position; switching is tap-only via the mode pill
 * in the footer (swipe belongs to the terminal's pan). The footer is
 * mode-aware: quick keys + dictation in Terminal (typing happens directly in
 * the terminal - tap it for the keyboard), the composer in Chat, nothing
 * extra in Changes.
 */
export function SessionScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ taskId: string; sessionId?: string; projectId?: string; mode?: string }>();
  const router = useRouter();
  const taskId = params.taskId;

  // Select primitives, never the object findTaskById builds: returning a
  // fresh { task, projectId } from a Zustand selector changes identity every
  // render and drives useSyncExternalStore into an infinite re-render loop.
  const locatedTaskTitle = useBoardStore((state) => findTaskById(state, taskId)?.task.title ?? null);
  const locatedDisplayId = useBoardStore((state) => {
    const located = findTaskById(state, taskId);
    if (!located) return null;
    return (state.boardsByProjectId[located.projectId]?.showTicketNumbers ?? true) ? located.task.display_id : null;
  });
  const locatedProjectId = useBoardStore((state) => findTaskById(state, taskId)?.projectId ?? null);
  const locatedSessionId = useBoardStore((state) => findTaskById(state, taskId)?.task.session_id ?? null);
  const taskLocated = useBoardStore((state) => findTaskById(state, taskId) !== null);
  const locatedSwimlaneId = useBoardStore((state) => findTaskById(state, taskId)?.task.swimlane_id ?? null);
  // The role of the column the task is in RIGHT NOW, optimistic overlay
  // included. Reading the optimistic value is what makes the Done check below
  // fire the instant the user confirms the move rather than a round trip
  // later - "fixing" this to read only authoritative snapshots reintroduces a
  // full "Switching session" window on every move to Done.
  const locatedColumnRole = useBoardStore((state) => {
    const located = findTaskById(state, taskId);
    if (!located) return null;
    const board = state.boardsByProjectId[located.projectId];
    return board?.columns.find((column) => column.id === located.task.swimlane_id)?.role ?? null;
  });
  const taskTitle = locatedTaskTitle ?? 'Task';
  const projectId = params.projectId && params.projectId.length > 0 ? params.projectId : locatedProjectId;
  const paramSessionId = params.sessionId && params.sessionId.length > 0 ? params.sessionId : null;
  // The board is authoritative once it has located the task (a respawn swaps
  // the task's session_id under a mounted screen); the param only bridges the
  // gap before the first board snapshot. See sessionResolution.ts.
  const sessionId = resolveCurrentSessionId({ taskLocated, locatedSessionId, paramSessionId });

  // Mode priority: an explicit route param (needs-you rows land on chat)
  // beats the task's remembered lens beats the terminal default. The
  // remembered lens is read once at mount - later store writes must not
  // yank the surface the user is looking at.
  const [mode, setMode] = useState<SessionMode>(() => {
    if (params.mode === 'chat' || params.mode === 'changes') return params.mode;
    return useSettingsStore.getState().preferredSessionLensByTaskId[taskId] ?? 'terminal';
  });

  useEffect(() => {
    if (!sessionId) return;
    openSessionScreen(sessionId);
    return () => closeSessionScreen(sessionId);
  }, [sessionId]);

  // SESSION-DEATH DETECTION. Three signals, all scoped to the CURRENT binding:
  // 1. The board located the task but reports no session, after this screen
  //    had one: the session ended with no successor (authoritative). Only
  //    fires for a board fetched as `view: 'full'` - the 'sessions' projection
  //    drops such a task rather than reporting it with a null session_id.
  // 2. The desktop pushed `session-ended` for the bound session (see below).
  // 3. The stream feed for the bound session sits 'rejected' past a grace
  //    window: the desktop refused the subscribe (dead session on a desktop
  //    that predates the session-ended event) and no successor arrived.
  // "Had one before" is state adjusted during render (the sanctioned
  // derive-from-props pattern), not a ref read in render.
  const [lastBoundSessionId, setLastBoundSessionId] = useState<string | null>(null);
  // The column the task sat in when the CURRENT session bound, and a latch
  // that opens when it changes. A column move that restarts the agent is a
  // session swap, and `session-ended` for the old session arrives seconds
  // before the successor exists - without this the screen declares the task
  // dead in the middle of its own move.
  //
  // The latch is a LATCH, not a re-derived predicate. For a phone-initiated
  // move applyOptimisticMove writes the new swimlane the instant the user
  // confirms, long before the ended push; and under the board's 'sessions'
  // projection the task leaves the snapshot entirely once its session dies,
  // taking `locatedSwimlaneId` to null. Either way the evidence of the move is
  // gone by the time it is needed, so it is captured when it appears and held.
  const [swimlaneIdWhenSessionBound, setSwimlaneIdWhenSessionBound] = useState<string | null>(null);
  // The column the open window is waiting on (null = closed), and the column
  // whose window has already been spent. Both are ids rather than booleans so
  // an expired window cannot re-open: the task is STILL in the column it moved
  // to, so a plain boolean latch re-armed on the very next render and the
  // screen never reached the ended state at all.
  const [swapWindowSwimlaneId, setSwapWindowSwimlaneId] = useState<string | null>(null);
  const [spentSwapSwimlaneId, setSpentSwapSwimlaneId] = useState<string | null>(null);
  const swapWindowOpen = swapWindowSwimlaneId !== null;
  if (sessionId !== null && sessionId !== lastBoundSessionId) {
    setLastBoundSessionId(sessionId);
    // A successor bound: this column is the new baseline, and the move is over.
    setSwimlaneIdWhenSessionBound(locatedSwimlaneId);
    setSwapWindowSwimlaneId(null);
    setSpentSwapSwimlaneId(null);
  } else if (sessionId !== null && swimlaneIdWhenSessionBound === null && locatedSwimlaneId !== null) {
    // The board located the task after this screen bound its session from the
    // nav param: adopt the column as the baseline, never read it as a change.
    setSwimlaneIdWhenSessionBound(locatedSwimlaneId);
  } else if (
    swapWindowSwimlaneId === null &&
    swimlaneIdWhenSessionBound !== null &&
    locatedSwimlaneId !== null &&
    locatedSwimlaneId !== swimlaneIdWhenSessionBound &&
    locatedSwimlaneId !== spentSwapSwimlaneId &&
    // Two destinations promise no successor, so neither gets a grace window:
    // a move to To Do is a full reset (session killed, worktree removed), and
    // a move to Done archives the task, which routes to the completed view.
    !isTodoRole(locatedColumnRole) &&
    !isDoneRole(locatedColumnRole)
  ) {
    setSwapWindowSwimlaneId(locatedSwimlaneId);
  }
  useEffect(() => {
    if (swapWindowSwimlaneId === null) return;
    const waitingOnSwimlaneId = swapWindowSwimlaneId;
    const swapTimer = setTimeout(() => {
      setSpentSwapSwimlaneId(waitingOnSwimlaneId);
      setSwapWindowSwimlaneId(null);
    }, SESSION_SWAP_GRACE_MS);
    return () => clearTimeout(swapTimer);
  }, [swapWindowSwimlaneId]);
  const feedStatus = useActivityStore((state) =>
    sessionId !== null ? (state.bySessionId[sessionId]?.feedStatus ?? null) : null,
  );
  // The grace flag records WHICH session outlived the window, so leaving the
  // rejected state needs no synchronous reset: the derived check below simply
  // stops matching.
  const [gracePassedForSessionId, setGracePassedForSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (feedStatus !== 'rejected' || sessionId === null) return;
    const rejectedSessionId = sessionId;
    const graceTimer = setTimeout(() => setGracePassedForSessionId(rejectedSessionId), REJECTED_FEED_GRACE_MS);
    return () => clearTimeout(graceTimer);
  }, [feedStatus, sessionId]);
  // Signal 2: the desktop said outright that this screen's session is over.
  // Read from the store's ended-id set rather than the entry's feedStatus,
  // because the entry does not survive: the ended session leaves the board's
  // 'sessions' projection in the next snapshot and the reconciler prunes it.
  // Keyed on lastBoundSessionId as well as the current one - once the task is
  // off the board there is nothing left to resolve a sessionId from except the
  // navigation param, which a board-entered screen never has.
  const boundSessionEnded = useActivityStore((state) =>
    selectSessionEnded(state, sessionId ?? lastBoundSessionId),
  );
  const sessionEnded =
    (taskLocated && sessionId === null && lastBoundSessionId !== null) ||
    // Needs no grace window: unlike a refused subscribe, which can be a
    // transient race with the desktop's registry, this is the desktop telling
    // us the session it was streaming is gone. It is also the only signal a
    // session that dies while subscribed produces - markRejected fires from a
    // refused subscribe, which that path never hits.
    boundSessionEnded ||
    (sessionId !== null && feedStatus === 'rejected' && gracePassedForSessionId === sessionId);

  /**
   * COMPLETED TASKS LEAVE THIS SCREEN.
   *
   * A move to Done suspends the agent and deletes the worktree, so the ended
   * state's copy ("if it starts a new one, this screen reconnects") is wrong,
   * its Move button vanishes with the card, and its View changes button opens
   * a diff of a worktree that no longer exists - read-diff falls back to the
   * PROJECT path once `worktree_path` is cleared, which renders the main
   * checkout's working diff as if it were this task's work.
   *
   * Keyed on the ARCHIVE rather than on who moved the card, so a move made
   * from the desktop lands the same way. The archive page is requested once
   * the session looks over, and the navigation is driven by a reactive read
   * of the store rather than by that request resolving: loadArchivedTasks
   * early-returns while any page is in flight, so a BoardScreen fetch racing
   * this one would otherwise make the request a silent no-op and the screen
   * would sit on the ended state forever.
   */
  const maybeArchived =
    sessionEnded || isDoneRole(locatedColumnRole) || (!taskLocated && lastBoundSessionId !== null);
  /**
   * Not a single one-shot: the first look can legitimately be too early.
   * Moving to Done writes the task into the done column optimistically, so
   * `locatedColumnRole` says 'done' before the desktop has archived anything -
   * that page comes back without the task, and a plain "fetched once" guard
   * would then never look again. So the fetch is keyed on WHY it fired, and
   * the task leaving the board (the authoritative signal, emitted in the same
   * tick as the archive row) is a second, decisive look.
   */
  const archiveFetchKey =
    maybeArchived && projectId !== null ? `${projectId}:${taskLocated ? 'located' : 'gone'}` : null;
  // A ref, not state: this only guards the fetch from repeating, and nothing
  // renders from it. As state it is a setState inside an effect - a cascading
  // render for no visible change, and an eslint error.
  const archiveFetchedForKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (archiveFetchKey === null || projectId === null) return;
    if (archiveFetchedForKeyRef.current === archiveFetchKey) return;
    const fetchedForKey = archiveFetchKey;
    archiveFetchedForKeyRef.current = fetchedForKey;
    void loadArchivedTasks({ projectId }).catch(() => {
      // Offline, or the desktop refused: the screen stays on the ended state,
      // which is the honest answer when we cannot tell that it completed.
      //
      // Give the slot back, though. A failed look must not consume the one
      // chance this key had, or a single dropped connection strands a
      // completed task under the ended overlay for the life of the screen.
      if (archiveFetchedForKeyRef.current === fetchedForKey) archiveFetchedForKeyRef.current = null;
    });
  }, [archiveFetchKey, projectId]);
  // Select the STORED slice and derive from it: findArchivedTaskById builds a
  // fresh object per call, so calling it inside the selector hands
  // useSyncExternalStore a new snapshot every render and loops it.
  const archivedByProjectId = useBoardStore((state) => state.archivedByProjectId);
  const archivedProjectId = useMemo(
    () => findArchivedTaskById({ archivedByProjectId }, taskId)?.projectId ?? null,
    [archivedByProjectId, taskId],
  );
  // `!taskLocated` as well as the archive hit: an archive page held from an
  // earlier visit must not bounce a task that has since been moved back out of
  // Done and is live on the board again.
  const completedTaskProjectId = !taskLocated ? archivedProjectId : null;
  useFocusEffect(
    // Focus-gated, and that is load bearing: the move sheet dismisses itself
    // with router.back() on success, and an unguarded replace from underneath
    // races that dismissal and intermittently leaves the sheet on screen.
    useCallback(() => {
      if (completedTaskProjectId === null) return;
      router.replace({
        pathname: '/completed-task',
        params: { taskId, projectId: completedTaskProjectId },
      });
    }, [completedTaskProjectId, router, taskId]),
  );
  // A task on its way to Done is not "switching" to anything: it is finishing,
  // and the redirect above is what it is waiting for.
  const sessionSwitching = sessionEnded && swapWindowOpen && completedTaskProjectId === null;

  // The Chat segment's needs-you dot: a prompt is pending and the user is
  // looking at the terminal. Never auto-switch a surface someone types into.
  const awaitedPromptId = useActivityStore((state) =>
    sessionId !== null ? (state.bySessionId[sessionId]?.awaitedPromptId ?? null) : null,
  );
  const chatAttention = mode === 'terminal' && awaitedPromptId !== null;

  // Chat-fallback predicate (agent-agnostic): a loaded-but-empty transcript
  // means this agent has no structured feed, so the chat lens shows the
  // cleaned reading view and the WebView runs its clean-feed parser. A
  // structured session flips over automatically when its first entry lands.
  // ONE predicate, shared with ChatPane: the parser has to be on exactly when
  // the reading view is on, and computing it twice put them out of step while
  // the window was still loading, re-initialising the WebView for nothing.
  const chatFallbackActive = useTranscriptStore(
    (state) => selectChatLens(state, sessionId) === 'reading-view',
  );
  const agentLabel = useBoardStore((state) => findTaskById(state, taskId)?.task.agent ?? null);

  const hasSeenSessionModeHint = useSettingsStore((state) => state.hasSeenSessionModeHint);
  const settingsHydrated = useSettingsStore((state) => state.hydrated);
  const showModeHint = settingsHydrated && !hasSeenSessionModeHint && !sessionEnded && sessionId !== null;
  const dismissModeHint = useCallback(() => {
    void useSettingsStore.getState().markSessionModeHintSeen();
  }, []);

  // Deep chat content (the prompt cards' "Answer in terminal" escape
  // hatch) raises a one-shot mode request through the terminal UI store.
  // Subscription-callback form: the store is the external system, setState
  // fires only inside its change callback, and the request is consumed
  // exactly once. Cards only render inside this mounted screen, so a
  // pre-mount request cannot exist.
  useEffect(() => {
    if (sessionId === null) return;
    const boundSessionId = sessionId;
    return useTerminalUiStore.subscribe((state) => {
      const requested = state.requestedModeBySessionId[boundSessionId];
      if (requested === undefined) return;
      useTerminalUiStore.getState().consumeRequestedMode(boundSessionId);
      setMode(requested);
    });
  }, [sessionId]);

  const onModeChange = useCallback(
    (nextMode: SessionMode) => {
      setMode(nextMode);
      dismissModeHint();
      // Remember the task's lens (terminal/chat only: Changes is a
      // destination the user visits, not a preferred way to watch the
      // agent).
      if (nextMode === 'terminal' || nextMode === 'chat') {
        void useSettingsStore.getState().setPreferredSessionLens(taskId, nextMode);
      }
    },
    [dismissModeHint, taskId],
  );

  const openChanges = useCallback(() => {
    onModeChange('changes');
  }, [onModeChange]);

  /**
   * BOTH overlays yield to the Changes pane.
   *
   * They cover the whole pane area at zIndex 2, so switching the mode
   * underneath is not enough: an overlay that kept rendering left the user
   * looking at the same panel they had just tapped out of, and "View changes"
   * read as a dead button. No tier caught it - `session-ended-state.yaml`
   * asserts `changes-scope` becomes visible, but all three panes are always
   * mounted and only their ACCESSIBILITY visibility follows the mode, so that
   * assertion passed with the pane fully covered. It is the mirror of the
   * zIndex bug in SessionEndedState's own docblock: that one surfaced because
   * a TAP was swallowed, which is the only way a stacking fault ever shows.
   *
   * Diffs outlive the session, so Changes is exactly where an ended or
   * switching task still has something to say.
   */
  const overlaysYieldToChanges = mode === 'changes';
  const showSwitchingState = sessionSwitching && !overlaysYieldToChanges;
  const showEndedState = sessionEnded && !sessionSwitching && !overlaysYieldToChanges;
  // The footer comes back with them, because in `changes` mode it is only the
  // mode pill (no composer, no quick keys - see SessionInputBar). Without it
  // Changes is a one-way trip out of the ended state with nothing but the
  // system Back button to leave by.
  const showInputBar = !sessionEnded || overlaysYieldToChanges;

  // Move is a native form sheet ROUTE (app/move-task.tsx): this screen only
  // navigates. locatedProjectId, not the param fallback: MoveTaskScreen needs
  // the board that actually HOLDS the task.
  const openMoveSheet = useCallback(() => {
    if (!locatedProjectId) return;
    router.push({ pathname: '/move-task', params: { taskId, projectId: locatedProjectId } });
  }, [router, taskId, locatedProjectId]);

  return (
    <Screen testID="session-screen">
      <TaskHeader taskTitle={taskTitle} sessionId={sessionId} displayId={locatedDisplayId} taskId={taskId} />
      {/* behavior="padding" on BOTH platforms: edge-to-edge Android never
          resizes the window for the soft keyboard, so without JS-side
          padding the keyboard fully covers the composer (send button
          unreachable while typing). */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={styles.flex}>
          {/* All three panes stay mounted (the xterm WebView must never reload
              and the conversation keeps its scroll position), so they are
              absolutely-positioned siblings with only the active one visible
              rather than pages of a pager. This replaced a PagerView that was
              configured scrollEnabled={false}, so it contributed no scrolling
              at all - only page management, which `mode` already does. The
              pager also retained its ViewPager2 through a static
              Choreographer callback in PagerViewViewManagerImpl, which is the
              session-screen retention this change was made to fix. */}
          {/* collapsable={false} keeps this wrapper as a real native view.
              Android view flattening would otherwise dissolve a plain flex
              View, promoting the three panes into the parent alongside the
              SessionEndedState overlay - one stacking context, where a
              pane's zIndex: 1 outranks the overlay and swallows its taps.
              The overlay now sets zIndex: 2 as well, so the fix holds under
              either reading; this keeps the next overlay added over these
              panes out of the same trap. */}
          <View style={styles.flex} collapsable={false}>
            <View
              style={[styles.pane, mode === 'terminal' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'terminal' ? 'auto' : 'none'}
              // A hidden pane is still in the view tree, so it has to be taken
              // out of the accessibility tree explicitly - otherwise a screen
              // reader walks all three surfaces and reads the terminal while
              // the user is looking at Chat. Both platforms need their own
              // prop; neither one covers the other.
              accessibilityElementsHidden={mode !== 'terminal'}
              importantForAccessibility={mode === 'terminal' ? 'auto' : 'no-hide-descendants'}
              testID="session-pane-terminal"
            >
              <TerminalTab sessionId={sessionId} active={mode === 'terminal'} cleanFeedEnabled={chatFallbackActive} />
            </View>
            <View
              style={[styles.pane, mode === 'chat' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'chat' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'chat'}
              importantForAccessibility={mode === 'chat' ? 'auto' : 'no-hide-descendants'}
              testID="session-pane-chat"
            >
              <ChatPane taskId={taskId} sessionId={sessionId} projectId={projectId} agentLabel={agentLabel} />
            </View>
            <View
              style={[styles.pane, mode === 'changes' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'changes' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'changes'}
              importantForAccessibility={mode === 'changes' ? 'auto' : 'no-hide-descendants'}
              testID="session-pane-changes"
            >
              <ChangesTab taskId={taskId} projectId={projectId} isActive={mode === 'changes'} />
            </View>
          </View>

          {/* Mid-swap the session is over but the TASK is not, so the
              transitional scrim stands in for the ended state rather than
              rendering beside it: two overlays on the same box would fight
              for the same stacking slot. */}
          {showSwitchingState ? <SessionSwitchingState onViewChanges={openChanges} /> : null}
          {showEndedState ? (
            <SessionEndedState
              onViewChanges={openChanges}
              onMoveTask={locatedProjectId !== null ? openMoveSheet : null}
            />
          ) : null}
        </View>

        {showModeHint ? <ModeToggleHint onDismiss={dismissModeHint} /> : null}
        {showInputBar ? (
          <SessionInputBar
            sessionId={sessionId}
            mode={mode}
            onModeChange={onModeChange}
            chatAttention={chatAttention}
          />
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  // Absolutely positioned so all three panes occupy the same box and stay
  // mounted. Visibility is opacity + zIndex rather than `display: 'none'`,
  // which would drop the WebView's surface and force the terminal to
  // re-create its GL context on every lens switch.
  pane: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  paneVisible: {
    opacity: 1,
    zIndex: 1,
  },
  paneHidden: {
    opacity: 0,
    zIndex: 0,
  },
});
