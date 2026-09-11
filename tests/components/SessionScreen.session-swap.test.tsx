import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionScreen } from '@/screens/task/SessionScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { boardColumnFixture, boardTaskFixture, userEntryFixture } from '@/devsupport/desktopFixtures';
import { closeSessionScreen, loadArchivedTasks, openSessionScreen } from '@/connection/actions';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

let mockParams: { taskId: string; sessionId?: string; projectId?: string; mode?: string } = { taskId: 'task-1' };
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: mockPush }),
  // The real one throws outside a navigator. Everything mounted here is
  // focused for its whole life, so a plain effect is the faithful stand-in.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

jest.mock('@/connection/actions', () => ({
  openSessionScreen: jest.fn(),
  closeSessionScreen: jest.fn(),
  moveTaskOptimistic: jest.fn().mockResolvedValue(undefined),
  // Resolves without writing anything: these tests seed archivedByProjectId
  // directly, so the fetch is a no-op and the screen's routing is driven by
  // the store read, which is the coupling worth pinning.
  loadArchivedTasks: jest.fn().mockResolvedValue(undefined),
}));

// The panes and the input bar are heavy (FlashList transcript, xterm
// WebView, composer with dictation); this test is about SESSION BINDING and
// MODE state, so each becomes a light marker that records its props.
jest.mock('@/screens/task/ChatPane', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ChatPane: (props: { sessionId: string | null }) =>
      ReactModule.createElement(View, { testID: 'stub-chat-pane', accessibilityLabel: props.sessionId ?? 'none' }),
  };
});

jest.mock('@/screens/task/TerminalTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    // accessibilityState.selected carries cleanFeedEnabled: selectChatLens is
    // the ONE answer both this screen and ChatPane read, so this mock exposes
    // exactly what SessionScreen forwards rather than ignoring it.
    TerminalTab: (props: { sessionId: string | null; cleanFeedEnabled?: boolean }) =>
      ReactModule.createElement(View, {
        testID: 'stub-terminal-tab',
        accessibilityLabel: props.sessionId ?? 'none',
        accessibilityState: { selected: props.cleanFeedEnabled === true },
      }),
  };
});

jest.mock('@/screens/task/SessionInputBar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    SessionInputBar: (props: { sessionId: string | null; mode: string }) =>
      props.sessionId === null
        ? null
        : ReactModule.createElement(View, { testID: 'stub-session-input-bar', accessibilityLabel: props.mode }),
  };
});

const openSessionScreenMock = openSessionScreen as jest.Mock;
const closeSessionScreenMock = closeSessionScreen as jest.Mock;
const loadArchivedTasksMock = loadArchivedTasks as jest.Mock;

function seedTaskWithSession(sessionId: string | null): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

/**
 * The board a `view: 'sessions'` projection returns once the task's session
 * ended: the task is not reported with a null session_id, it is absent.
 */
function seedBoardWithoutTask(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture()],
        tasksById: {},
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'sessions',
        taskCountsByColumnId: { 'lane-todo': 0 },
      },
    },
    pendingMoves: [],
  });
}

function pushSessionEnded(sessionId: string): void {
  useActivityStore.getState().applyActivityEvent({
    kind: 'activity',
    sessionId,
    taskId: 'task-1',
    payload: { type: 'session-ended', intentional: true },
  });
}

function renderSessionScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <SessionScreen />
    </ThemeProvider>,
  );
}

describe('SessionScreen session binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  it('binds to the param session before the board locates the task', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-param' };
    renderSessionScreen();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-param');
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
  });

  it('re-binds to the successor session when the board swaps the task session', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-a');

    act(() => {
      seedTaskWithSession('sess-b');
    });

    expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-a');
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');
    const closeOrder = closeSessionScreenMock.mock.invocationCallOrder[0];
    const reopenOrder = openSessionScreenMock.mock.invocationCallOrder[1];
    expect(closeOrder).toBeLessThan(reopenOrder);
    // A live successor means no ended state flashed.
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
  });

  it('shows the ended state (and hides the input bar) when the located task loses its session', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar')).toBeTruthy();

    act(() => {
      seedTaskWithSession(null);
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-a');
    expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
  });

  it('recovers from the ended state when a successor session appears', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    act(() => {
      seedTaskWithSession('sess-c');
    });

    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-c');
  });

  /**
   * Caught by the session-ended-state E2E flow, which went red the moment the
   * 0.9.0 board projection landed. Under `view: 'sessions'` the ended task is
   * filtered out of the board entirely, so `taskLocated` goes false and the
   * board-says-no-session signal above can never fire; reconcileSessionsFromBoards
   * then prunes the activity entry, taking `feedStatus: 'ended'` with it a few
   * hundred milliseconds later. Both signals the screen used to rely on are gone
   * within one round trip of the end, and the ended state appeared and vanished.
   */
  it('keeps the ended state after the sessions projection drops the task and the entry is pruned', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
    renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar')).toBeTruthy();

    act(() => {
      pushSessionEnded('sess-a');
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    // What lands next: the board refetch drops the task, and the reconciler
    // prunes the activity entry behind it.
    act(() => {
      seedBoardWithoutTask();
      useActivityStore.getState().removeSession('sess-a');
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
  });

  /**
   * The same collapse, entered from the board rather than a triage row, so
   * there is no sessionId param either. With the task gone nothing can name
   * the dead session but the binding the screen already made.
   */
  it('keeps the ended state with no sessionId param to fall back on', () => {
    mockParams = { taskId: 'task-1' };
    seedTaskWithSession('sess-a');
    useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
    renderSessionScreen();
    expect(screen.queryByTestId('session-ended-state')).toBeNull();

    act(() => {
      pushSessionEnded('sess-a');
      seedBoardWithoutTask();
      useActivityStore.getState().removeSession('sess-a');
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });

  it('does not show the ended state for a task that never had a session', () => {
    seedTaskWithSession(null);
    renderSessionScreen();
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(openSessionScreenMock).not.toHaveBeenCalled();
  });

  it('declares the session dead when its feed stays rejected past the grace window', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();

      act(() => {
        useActivityStore.getState().markRejected('sess-a');
      });
      // Inside the grace window: no flash.
      expect(screen.queryByTestId('session-ended-state')).toBeNull();

      act(() => {
        jest.advanceTimersByTime(1600);
      });
      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('defaults to terminal mode and honors the mode=chat entry param', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    const first = renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('terminal');
    first.unmount();

    mockParams = { taskId: 'task-1', sessionId: 'sess-a', mode: 'chat' };
    renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('chat');
  });

  it('changes is an inline pane, not a header chip or pushed route', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    // No header chip anymore; the pane is mounted alongside the others (the
    // footer switcher, stubbed in this suite, switches to it in place). The
    // header's COLUMN chip is different in kind - a command, not a surface -
    // and only navigates on press, so nothing here has pushed.
    expect(screen.queryByTestId('task-header-changes')).toBeNull();
    // includeHiddenElements because an inactive pane is deliberately removed
    // from the accessibility tree (asserted below). The default query honours
    // that the way a screen reader would, so the structural check has to opt
    // in explicitly - it is asking "is it mounted", not "is it readable".
    expect(screen.getByTestId('session-pane-changes', { includeHiddenElements: true })).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps every pane mounted but hides the inactive ones from accessibility', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    // All three surfaces stay mounted so the xterm WebView never reloads and
    // the conversation keeps its scroll position. That makes hiding the
    // inactive two from the accessibility tree load-bearing: without it a
    // screen reader walks all three and reads the terminal while the user is
    // looking at Chat. Terminal is the default lens here.
    const paneVisibility = (testID: string) => {
      const pane = screen.getByTestId(testID, { includeHiddenElements: true });
      return {
        hidden: pane.props.accessibilityElementsHidden,
        android: pane.props.importantForAccessibility,
        pointerEvents: pane.props.pointerEvents,
      };
    };
    expect(paneVisibility('session-pane-terminal')).toEqual({
      hidden: false,
      android: 'auto',
      pointerEvents: 'auto',
    });
    for (const hiddenPane of ['session-pane-chat', 'session-pane-changes']) {
      expect(paneVisibility(hiddenPane)).toEqual({
        hidden: true,
        android: 'no-hide-descendants',
        pointerEvents: 'none',
      });
    }
  });

  /**
   * Move is a native form sheet ROUTE, so the screen only navigates. The
   * sheet's own behaviour (current column disabled, append position, failure
   * message) lives in tests/components/MoveTaskScreen.test.tsx. No projectId
   * param on purpose: the chip resolves the project from the board that
   * actually holds the task.
   */
  it('tapping the header column chip navigates to the move-task form sheet with the task and project', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();

    fireEvent.press(screen.getByTestId('task-header-column'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
    expect(screen.queryByTestId('move-task-sheet')).toBeNull();
  });

  /**
   * Without a located task there is no board to move within, and navigating
   * would open an empty dead sheet. The affordance is absent, not inert -
   * absence IS the guard.
   */
  it('renders no move affordance before the board has located the task', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    renderSessionScreen();

    expect(screen.queryByTestId('task-header-column')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('offers Move task in the ended state while the task is still on a full board', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    fireEvent.press(screen.getByTestId('session-ended-move-task'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  /**
   * Under the sessions projection an ended task is dropped from the board, so
   * MoveTaskScreen could not locate it either: the Move button hides while
   * View changes stays (diffs outlive the session).
   */
  it('hides Move task when the sessions projection dropped the task', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
    renderSessionScreen();

    act(() => {
      pushSessionEnded('sess-a');
      seedBoardWithoutTask();
      useActivityStore.getState().removeSession('sess-a');
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    expect(screen.queryByTestId('session-ended-move-task')).toBeNull();
    expect(screen.getByTestId('session-ended-view-changes')).toBeTruthy();
  });

  /**
   * The regression the paired `session-ended-state` flow caught and every
   * required check missed.
   *
   * When the pager became absolutely-positioned siblings, the panes gained
   * `zIndex: 1` while this overlay had none - so the visible pane stacked
   * ABOVE it. On device, "Session ended" bled through the gaps between
   * transcript cards and BOTH overlay buttons were dead, because React Native
   * hands a tap to the topmost view rather than letting it fall through to an
   * occluded sibling.
   *
   * No `fireEvent.press` test can see this. `fireEvent` invokes the handler
   * directly and never consults hit testing, which is exactly why the two
   * press tests above stayed green all the way through the bug. The closest a
   * JS tier can get is asserting the MECHANISM - that the overlay outranks the
   * visible pane - so that is what this does. The real proof stays the paired
   * Maestro flow.
   */
  it('stacks the ended-state overlay above the visible pane, so its buttons can be tapped', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });

    const overlayZIndex = StyleSheet.flatten(screen.getByTestId('session-ended-state').props.style)?.zIndex;
    // Terminal is the default mode, so that is the pane carrying paneVisible.
    const visiblePaneZIndex = StyleSheet.flatten(screen.getByTestId('session-pane-terminal').props.style)?.zIndex;

    // Both must be real numbers: an undefined zIndex on either side is the bug
    // (an implicit auto lost the contest), not a passing comparison.
    expect(typeof overlayZIndex).toBe('number');
    expect(typeof visiblePaneZIndex).toBe('number');
    expect(overlayZIndex).toBeGreaterThan(visiblePaneZIndex);
  });

});

/**
 * A column move that restarts the agent is a session SWAP: the desktop
 * suspends the old session - which pushes `session-ended` - and spawns the
 * successor only after the worktree work, a measured median 2.3s later and up
 * to 24.4s at the tail. Declaring the task dead in that gap is wrong, and the
 * REJECTED_FEED_GRACE_MS window does not cover it (that one guards a refused
 * SUBSCRIBE, not a delivered ended push).
 *
 * The ordering these pin is the PHONE-INITIATED one, deliberately:
 * applyOptimisticMove writes the new swimlane the instant the user confirms,
 * so by the time the ended push lands the column change is old news. A design
 * that compares the column against "what it was last render" never sees it.
 * The desktop-initiated ordering (snapshot, then ended) passes either way and
 * would prove nothing about that.
 */
describe('SessionScreen across a column move', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  /**
   * A board shaped like a real one: To Do and Done carry their system roles,
   * the working columns in between carry none. boardColumnFixture defaults to
   * role 'todo', so an id-only override would give every column the role that
   * means "no successor is coming" and quietly disable the whole window.
   */
  function seedRoledBoard(sessionId: string | null, swimlaneId = 'lane-todo'): void {
    useBoardStore.setState({
      projects: [{ id: 'project-1', name: 'Alpha' }],
      boardsByProjectId: {
        'project-1': {
          columns: [
            boardColumnFixture(),
            boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 }),
            boardColumnFixture({ id: 'lane-review', name: 'Review', role: null, position: 2 }),
            boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 3 }),
          ],
          tasksById: {
            'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId, swimlane_id: swimlaneId }),
          },
          snapshotAt: 0,
          showTicketNumbers: true,
          view: 'full',
          taskCountsByColumnId: {},
        },
      },
      pendingMoves: [],
    });
  }

  function moveTaskToColumn(targetSwimlaneId: string): void {
    useBoardStore.getState().applyOptimisticMove({
      projectId: 'project-1',
      taskId: 'task-1',
      toSwimlaneId: targetSwimlaneId,
      toPosition: 0,
    });
  }

  it('shows the switching state, not the ended state, while a move is in flight', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();

    // The user confirms the move: the card lands in the new column at once.
    act(() => {
      moveTaskToColumn('lane-doing');
    });
    // Seconds later the desktop's suspend reaches the phone. The successor
    // does not exist yet.
    act(() => {
      pushSessionEnded('sess-a');
    });

    // The ended assertion runs FIRST, deliberately: it is the reported bug
    // (the overlay flashing mid-move), and a missing switching testID would
    // otherwise mask it as "the component is not there" rather than "the
    // screen declared the task dead".
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(screen.getByTestId('session-switching-state')).toBeTruthy();
    // Nothing to type into between two sessions.
    expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
  });

  it('clears the switching state when the successor session binds', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();
    act(() => {
      moveTaskToColumn('lane-doing');
    });
    act(() => {
      pushSessionEnded('sess-a');
    });
    expect(screen.getByTestId('session-switching-state')).toBeTruthy();

    // The desktop spawned the successor and the settled snapshot carries it.
    act(() => {
      seedRoledBoard('sess-b', 'lane-doing');
    });

    expect(screen.queryByTestId('session-switching-state')).toBeNull();
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');
  });

  it('falls back to the ended state when no successor arrives within the grace window', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-doing');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      expect(screen.getByTestId('session-switching-state')).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(20_001);
      });

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A move to To Do is a full reset - the session is killed and the worktree
   * removed - so there is no successor to wait for and the honest answer is
   * immediate. `boardColumnFixture` defaults to the todo role.
   */
  it('shows the ended state immediately for a move to the To Do column', () => {
    // Starts in Doing, so the move to To Do is a real column change.
    seedRoledBoard('sess-a', 'lane-doing');
    renderSessionScreen();

    act(() => {
      moveTaskToColumn('lane-todo');
    });
    act(() => {
      pushSessionEnded('sess-a');
    });

    expect(screen.queryByTestId('session-switching-state')).toBeNull();
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });

  /**
   * Done deletes the worktree and archives the task, so the session screen has
   * nowhere good to stand: the ended state offers "View changes" for a diff
   * read-diff would answer from the PROJECT checkout, and its Move button
   * disappears with the card. The completed view is the destination the board
   * already uses for an archived task.
   */
  it('replaces itself with the completed-task view once the task is archived', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();

    act(() => {
      pushSessionEnded('sess-a');
      // The desktop archived the task: it leaves the board snapshot entirely
      // (every board query filters archived_at IS NULL) and arrives in the
      // archive page the screen asked for.
      seedBoardWithoutTask();
      useBoardStore.setState({
        archivedByProjectId: {
          'project-1': {
            tasks: [
              boardTaskFixture({
                id: 'task-1',
                session_id: null,
                archived_at: '2026-09-11T00:00:00.000Z',
              }),
            ],
            totalCount: 1,
            summariesByTaskId: {},
            nextOffset: 1,
            loading: false,
          },
        },
      });
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/completed-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  /**
   * The first look is legitimately too early. A move to Done writes the task
   * into the done column OPTIMISTICALLY, seconds before the desktop archives
   * anything, so that page comes back without it. A plain "fetched once" guard
   * would then never look again and the screen would sit under the ended state
   * for a task that completed.
   */
  it('asks for the archive again once the task actually leaves the board', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();
    expect(loadArchivedTasksMock).not.toHaveBeenCalled();

    // Optimistic: the card is in Done, the desktop has not archived yet.
    act(() => {
      moveTaskToColumn('lane-done');
    });
    expect(loadArchivedTasksMock).toHaveBeenCalledTimes(1);

    // Authoritative: the archive row exists, so the task is gone from the board.
    act(() => {
      seedBoardWithoutTask();
    });
    expect(loadArchivedTasksMock).toHaveBeenCalledTimes(2);
    expect(loadArchivedTasksMock).toHaveBeenLastCalledWith({ projectId: 'project-1' });
  });

  it('does not redirect a task that is still on the board', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();

    act(() => {
      pushSessionEnded('sess-a');
      // A stale archive page from an earlier visit, for a task that has since
      // been moved back out of Done and is live on the board again.
      useBoardStore.setState({
        archivedByProjectId: {
          'project-1': {
            tasks: [boardTaskFixture({ id: 'task-1', archived_at: '2026-09-01T00:00:00.000Z' })],
            totalCount: 1,
            summariesByTaskId: {},
            nextOffset: 1,
            loading: false,
          },
        },
      });
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });
});

/**
 * selectChatLens (src/state/transcriptStore.ts) exists because this screen and
 * ChatPane used to compute the chat lens with two different inline rules and
 * diverged: the terminal was told to start its clean-feed parser while the
 * pane still showed "Loading conversation...", which re-keys TerminalPane's
 * init and re-initialises the WebView for nothing. tests/unit/transcriptStore
 * .test.ts pins the pure selector; these pin that SessionScreen actually
 * forwards its answer to TerminalTab as `cleanFeedEnabled`, so a reintroduced
 * second inline predicate here fails a test instead of nothing.
 */
describe('SessionScreen terminal clean-feed forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  it('does not enable the clean feed before a transcript window has landed', () => {
    seedTaskWithSession('sess-a');
    renderSessionScreen();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityState).toEqual({ selected: false });
  });

  it('enables the clean feed once the window lands empty (the reading-view lens)', () => {
    seedTaskWithSession('sess-a');
    useTranscriptStore.getState().retainSession('sess-a');
    useTranscriptStore.getState().applyWindow('sess-a', { revision: 1, totalEntries: 0, startIndex: 0, entries: [] });
    renderSessionScreen();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityState).toEqual({ selected: true });
  });

  it('disables the clean feed once the window carries real entries (a structured transcript)', () => {
    seedTaskWithSession('sess-a');
    useTranscriptStore.getState().retainSession('sess-a');
    useTranscriptStore.getState().applyWindow('sess-a', {
      revision: 1,
      totalEntries: 1,
      startIndex: 0,
      entries: [userEntryFixture()],
    });
    renderSessionScreen();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityState).toEqual({ selected: false });
  });
});
