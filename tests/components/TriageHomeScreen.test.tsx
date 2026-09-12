import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TriageHomeScreen } from '@/screens/TriageHomeScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { boardColumnFixture, boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { peekLastAssistantMessage } from '@/connection/actions';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

// The AppHeader reads the status-bar inset.
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-safe-area-context/jest/mock').default,
);

const mockFlashListScrollToOffset = jest.fn();
// Wraps the REAL FlashList (every other test in this file keeps exercising
// its actual virtualization and layout behavior) and only intercepts
// scrollToOffset on the ref, so the top-anchor test below can assert on it
// without reaching into native scroll-command dispatch.
jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  const ActualFlashListModule = jest.requireActual('@shopify/flash-list');
  const RealFlashList = ActualFlashListModule.FlashList;
  const SpyingFlashList = ReactModule.forwardRef(function SpyingFlashList(
    props: object,
    forwardedRef: React.Ref<{ scrollToOffset: (params: { offset: number; animated?: boolean }) => void }>,
  ) {
    const innerRef = ReactModule.useRef(null);
    ReactModule.useImperativeHandle(forwardedRef, () => ({
      scrollToOffset: (params: { offset: number; animated?: boolean }) => {
        mockFlashListScrollToOffset(params);
        innerRef.current?.scrollToOffset(params);
      },
    }));
    return ReactModule.createElement(RealFlashList, { ...props, ref: innerRef });
  });
  return { ...ActualFlashListModule, FlashList: SpyingFlashList };
});

const mockPeekAwaitedPrompt = jest.fn();
// Only what this screen still calls. The task-mutation actions (archive,
// delete, move, edit) left with the long-press sheets: the feed navigates to
// the actions-hub ROUTE now and performs none of them itself.
jest.mock('@/connection/actions', () => ({
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
  peekAwaitedPrompt: (sessionId: string, promptId: string) => mockPeekAwaitedPrompt(sessionId, promptId),
  peekLastAssistantMessage: jest.fn().mockResolvedValue(null),
  peekLastTerminalLine: jest.fn().mockResolvedValue(null),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
}));

function seedStores(): void {
  useSettingsStore.setState({ collapsedTriageSection: null });
  useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    hasHydratedSnapshot: true,
    boardsByProjectId: {
      'project-1': {
        columns: [],
        tasksById: {
          'task-1': {
            id: 'task-1',
            display_id: 1,
            title: 'Fix the login bug',
            description: '',
            swimlane_id: 'lane-1',
            position: 0,
            agent: 'claude',
            session_id: 'sess-1',
            worktree_path: null,
            branch_name: null,
            pr_number: null,
            pr_url: null,
            pr_state: null,
            pr_merge_readiness: null,
            base_branch: null,
            labels: [],
            priority: 0,
            attachment_count: 0,
            archived_at: null,
            created_at: '2026-07-13T00:00:00.000Z',
            updated_at: '2026-07-13T00:00:00.000Z',
          },
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
  useActivityStore.getState().reset();
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore.getState().applyActivityEvent({
    kind: 'activity',
    sessionId: 'sess-1',
    taskId: 'task-1',
    payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: true },
  });
}

function renderHome(): void {
  render(
    <ThemeProvider>
      <TriageHomeScreen />
    </ThemeProvider>,
  );
}

/**
 * Two paired projects, each with its own board - unlike BoardScreen (one
 * screen-level projectId), the Triage feed spans every paired project at
 * once, so every long-press target carries its OWN projectId. Sess-2/task-2
 * lives in project-2, never project-1, so any test that long-presses it and
 * then asserts the action call's `projectId` catches a crossed-project bug
 * (e.g. a screen-level default sneaking back in).
 */
function seedTwoProjectBoards(): void {
  useSettingsStore.setState({ collapsedTriageSection: null });
  useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
  useBoardStore.setState({
    projects: [
      { id: 'project-1', name: 'Alpha' },
      { id: 'project-2', name: 'Beta' },
    ],
    hasHydratedSnapshot: true,
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'p1-todo', name: 'To Do', role: 'todo', position: 0 }),
          boardColumnFixture({ id: 'p1-done', name: 'Done', role: 'done', position: 1 }),
        ],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', swimlane_id: 'p1-todo', session_id: 'sess-1' }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
      'project-2': {
        columns: [
          boardColumnFixture({ id: 'p2-todo', name: 'Backlog', role: 'todo', position: 0 }),
          // Two tasks already parked here so the "append to bottom" position
          // this suite pins is non-zero - a target column count of 0 cannot
          // distinguish a correct `.length` computation from a regressed
          // hardcoded 0.
          boardColumnFixture({ id: 'p2-doing', name: 'In Progress', role: null, position: 1 }),
          boardColumnFixture({ id: 'p2-done', name: 'Shipped', role: 'done', position: 2 }),
        ],
        tasksById: {
          'task-2': boardTaskFixture({ id: 'task-2', title: 'Ship the beta banner', swimlane_id: 'p2-todo', session_id: 'sess-2' }),
          'task-2b': boardTaskFixture({ id: 'task-2b', title: 'Existing card A', swimlane_id: 'p2-doing', position: 0, session_id: null }),
          'task-2c': boardTaskFixture({ id: 'task-2c', title: 'Existing card B', swimlane_id: 'p2-doing', position: 1, session_id: null }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
  useActivityStore.getState().reset();
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore.getState().registerSession('sess-2', 'task-2', 'project-2');
}

describe('TriageHomeScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockPeekAwaitedPrompt.mockReset();
    mockPeekAwaitedPrompt.mockResolvedValue(null);
    // Reset here, not just at the end of the tests that override it: a test
    // that throws before its own cleanup line would otherwise leak a stale
    // resolved value into whichever test runs next.
    jest.mocked(peekLastAssistantMessage).mockReset();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
    mockFlashListScrollToOffset.mockClear();
    seedStores();
  });

  it('files prompt-pending rows under Idle (the user\'s move) and hides empty sections', () => {
    renderHome();
    // The lone session is prompt-pending: desktop semantics count it in the
    // idle bucket, so its row sits under one Idle header - styled exactly
    // like every other idle row - and the empty Thinking section renders
    // nothing.
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
    expect(screen.getAllByText('Idle')).toHaveLength(1);
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByText('Needs you')).toBeNull();
  });

  it('prompt-pending rows carry no inline controls or status filler and route to chat on tap', () => {
    renderHome();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    // No filler status lines and no inline answering: the section + icon
    // say the state, the snippet teases the decision, and answering lives
    // in the session's own prompt card.
    expect(screen.queryByText('Waiting for your approval')).toBeNull();
    expect(screen.queryByTestId('permission-approve')).toBeNull();
    expect(screen.queryByText('Review and approve')).toBeNull();

    fireEvent.press(screen.getByTestId('activity-row-sess-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1', mode: 'chat' },
    });
  });

  it('renders board-card parity (project name, no ticket number) and the context-usage bar', () => {
    renderHome();
    // The project name shares the title row as quiet muted text.
    expect(screen.getByTestId('activity-row-sess-1-project')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    // No ticket number here: a triage feed cares about status/title/last
    // message/recency, not the ticket ID - the board is that view.
    expect(screen.queryByTestId('activity-row-sess-1-display-id')).toBeNull();
    // No usage yet: the bar stays hidden rather than showing an untrusted 0%.
    expect(screen.queryByTestId('activity-row-sess-1-usage')).toBeNull();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: {
          type: 'usage',
          usage: {
            contextWindow: { usedPercentage: 47, usedTokens: 94000, cacheTokens: 0, totalInputTokens: 94000, totalOutputTokens: 4000, contextWindowSize: 200000 },
            cost: { totalCostUsd: 2.5, totalDurationMs: 120000 },
            model: { id: 'claude-sonnet-5', displayName: 'Sonnet 5' },
          },
        },
      });
    });
    expect(screen.getByTestId('activity-row-sess-1-usage')).toBeTruthy();
    expect(screen.getByText('Sonnet 5')).toBeTruthy();
    expect(screen.getByText('47%')).toBeTruthy();
  });

  it('falls back to a minimal card when a session outlives its board task entry', () => {
    useBoardStore.setState((state) => ({
      boardsByProjectId: { ...state.boardsByProjectId, 'project-1': { ...state.boardsByProjectId['project-1'], tasksById: {} } },
    }));
    renderHome();
    expect(screen.getByText('Untitled task')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-sess-1-display-id')).toBeNull();
  });

  it('reacts to store changes (a session moving sections re-renders)', () => {
    renderHome();
    expect(screen.getAllByText('Idle')).toHaveLength(1);

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } },
      });
    });
    expect(screen.getAllByText('Thinking')).toHaveLength(1);
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('tapping the section header collapses its rows (but keeps the header and its count visible), and tapping again re-expands', () => {
    renderHome();
    // needs-you and idle share the "Idle" title; our lone permission-pending
    // session lands in needs-you, so that is the section kind whose header
    // actually gets emitted.
    expect(screen.getByTestId('section-header-idle').props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
    expect(within(screen.getByTestId('section-header-idle')).getByText('1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('section-header-idle'));

    expect(screen.getByTestId('section-header-idle').props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByTestId('activity-row-sess-1')).toBeNull();
    // The count stays visible while collapsed - collapsing hides the rows, not the fact that there are some.
    expect(within(screen.getByTestId('section-header-idle')).getByText('1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('section-header-idle'));

    expect(screen.getByTestId('section-header-idle').props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
  });

  it('shows the all-quiet state when connected with no sessions', () => {
    useActivityStore.getState().reset();
    renderHome();
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
  });

  it('shows the connecting state (Overseer, not a void) while paired but not established', () => {
    useActivityStore.getState().reset();
    useChannelStore.setState({ established: false, transportState: 'connecting' });
    renderHome();
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('all-quiet-empty-state')).toBeNull();
  });

  it('stays on Connecting (not a flash of All quiet) once established but before the first board snapshot lands', () => {
    // The exact bootstrap-ordering window: channel-established flips true
    // before any board snapshot has arrived, so hasHydratedSnapshot is
    // still false even though established is already true.
    useActivityStore.getState().reset();
    useBoardStore.setState({ hasHydratedSnapshot: false });
    renderHome();
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('all-quiet-empty-state')).toBeNull();

    act(() => {
      useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', columns: [], tasks: [] }));
    });
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('connecting-empty-state')).toBeNull();
  });

  /**
   * The bootstrap declares EVERY project's board desired and each answers in
   * its own round-trip, so the feed used to paint after the first snapshot
   * and then grow once per remaining project - agents flickering in, the
   * list re-sorting and re-anchoring under the thumb. It now reveals once,
   * when the declared set is complete.
   */
  it('waits for every declared board before revealing the feed', () => {
    useActivityStore.getState().reset();
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
      boardsByProjectId: {},
      hasHydratedSnapshot: false,
    });
    renderHome();
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();

    // First of two boards answers: still incomplete, so nothing is revealed
    // (and in particular no premature "All quiet").
    act(() => {
      useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', columns: [], tasks: [] }));
    });
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('all-quiet-empty-state')).toBeNull();

    act(() => {
      useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-2', columns: [], tasks: [] }));
    });
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('connecting-empty-state')).toBeNull();
  });

  /**
   * FEED_REVEAL_DEADLINE_MS is only a FLOOR under a project whose board is
   * slow or never answers - allBoardsAnswered is the normal completion
   * signal. If the deadline fallback regressed (feedReady tied to
   * allBoardsAnswered alone), a board that never answers would strand the
   * feed on "Connecting" forever instead of revealing what it does have.
   */
  it('reveals the feed past the deadline even when a declared board never answers', () => {
    jest.useFakeTimers();
    try {
      useActivityStore.getState().reset();
      useBoardStore.setState({
        projects: [
          { id: 'project-1', name: 'Alpha' },
          { id: 'project-2', name: 'Beta' },
        ],
        boardsByProjectId: {},
        hasHydratedSnapshot: false,
      });
      renderHome();
      expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();

      // project-1 answers; project-2 never does - allBoardsAnswered stays
      // false for the rest of the test.
      act(() => {
        useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', columns: [], tasks: [] }));
      });
      expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();

      // FEED_REVEAL_DEADLINE_MS (2500ms): the only other path to feedReady.
      act(() => {
        jest.advanceTimersByTime(2500);
      });

      expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
      expect(screen.queryByTestId('connecting-empty-state')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * SNIPPET_SETTLE_MS (350ms): a burst of unreadCount bumps (an actively
   * working session's engine events land back-to-back) must settle to ONE
   * refetch of the LAST state, not one paint per bump - each bump restarts
   * the settle timer. If the debounce regressed to fetching on every bump,
   * the mid-burst assertion below (no fetch yet) is what catches it; a test
   * that only checked "a fetch eventually happens" would not.
   */
  it('debounces a burst of unreadCount bumps into one refetch after the burst settles', async () => {
    jest.useFakeTimers();
    try {
      jest.mocked(peekLastAssistantMessage).mockClear();
      jest.mocked(peekLastAssistantMessage).mockResolvedValue('Latest.');
      // seedStores leaves sess-1 awaiting a prompt (the prompt-peek path);
      // resolve it so the row peeks the message path this test is pinning.
      act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'sess-1',
          taskId: 'task-1',
          payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: false },
        });
      });

      renderHome();
      // The first peek (this row's pre-warm plus its own mount) has no
      // burst to settle and fires immediately - capture that count as the
      // baseline rather than assuming it is exactly one call.
      await act(async () => {});
      const callsAfterMount = jest.mocked(peekLastAssistantMessage).mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      for (let bumpIndex = 0; bumpIndex < 4; bumpIndex += 1) {
        await act(async () => {
          useActivityStore.getState().applyActivityEvent({
            kind: 'activity',
            sessionId: 'sess-1',
            taskId: 'task-1',
            payload: { type: 'event', event: { ts: bumpIndex, type: 'tool_start', tool: 'Bash' } },
          });
          jest.advanceTimersByTime(200);
        });
      }
      // Still inside the 350ms settle window of the last bump: nothing has
      // refetched yet, which is the debounce itself, not just its outcome.
      expect(jest.mocked(peekLastAssistantMessage).mock.calls.length).toBe(callsAfterMount);

      await act(async () => {
        jest.advanceTimersByTime(350);
      });

      // The burst settled to exactly ONE additional fetch, not one per bump.
      expect(jest.mocked(peekLastAssistantMessage).mock.calls.length).toBe(callsAfterMount + 1);
    } finally {
      jest.useRealTimers();
      jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
    }
  });

  /**
   * The agent snippet is a per-session transcript fetch that can take seconds
   * on a long-running session, so the card falls back to the task description
   * that already rode in on the board snapshot. Before this, the feed revealed
   * with every description slot empty and filled them a beat later, which read
   * as a second load.
   */
  it('shows the task description until the agent snippet resolves', async () => {
    useBoardStore.setState((state) => ({
      boardsByProjectId: {
        ...state.boardsByProjectId,
        'project-1': {
          ...state.boardsByProjectId['project-1'],
          tasksById: {
            ...state.boardsByProjectId['project-1'].tasksById,
            'task-1': {
              ...state.boardsByProjectId['project-1'].tasksById['task-1'],
              description: '## Heading\n\nRepro the auth redirect loop.',
            },
          },
        },
      },
    }));

    renderHome();

    // Markdown decoration is collapsed the same way a live snippet is.
    expect(screen.getByText('Heading Repro the auth redirect loop.')).toBeTruthy();
  });

  it('replaces the description with the agent snippet once it lands', async () => {
    // Not `Once`: the screen pre-warms every known session's snippet before
    // the rows mount, so a single-use mock is consumed before render.
    jest.mocked(peekLastAssistantMessage).mockResolvedValue('Fixed the redirect, running tests.');
    // seedStores leaves sess-1 awaiting a prompt, which takes the prompt-peek
    // path instead; clear it so the row peeks the agent's last message.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: false },
    });
    useBoardStore.setState((state) => ({
      boardsByProjectId: {
        ...state.boardsByProjectId,
        'project-1': {
          ...state.boardsByProjectId['project-1'],
          tasksById: {
            ...state.boardsByProjectId['project-1'].tasksById,
            'task-1': {
              ...state.boardsByProjectId['project-1'].tasksById['task-1'],
              description: 'Repro the auth redirect loop.',
            },
          },
        },
      },
    }));

    renderHome();

    expect((await screen.findAllByText('Fixed the redirect, running tests.')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Repro the auth redirect loop.')).toBeNull();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
  });

  /**
   * A 0.8.0+ desktop pushes the preview on the activity feed the app already
   * receives. The row must then render it AND stop fetching its own, which is
   * where the per-session transcript requests (2.3-34.6 KB each) go away.
   */
  it('renders the desktop-pushed preview and fetches no snippet of its own', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    // seedStores leaves sess-1 in the permission state, whose body is the
    // pending decision rather than the preview; move it back to idle.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'message-preview', text: 'Pushed straight from the desktop.' },
    });

    renderHome();

    expect(screen.getByText('Pushed straight from the desktop.')).toBeTruthy();
    await act(async () => {});
    expect(peekLastAssistantMessage).not.toHaveBeenCalled();
  });

  /**
   * A prompt-pending row's body is the pending DECISION, which the preview
   * does not describe, so that row keeps peeking even when a preview exists.
   */
  it('still peeks for a prompt-pending row despite a pushed preview', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'message-preview', text: 'Not what this row should show.' },
    });

    renderHome();
    await act(async () => {});

    expect(mockPeekAwaitedPrompt).toHaveBeenCalled();
    expect(screen.queryByText('Not what this row should show.')).toBeNull();
  });

  /**
   * The warm-on-register effect (TriageHomeScreen's own pre-warm, separate
   * from each row's own peek effect) must not re-fetch, over the wire, the
   * exact line a 0.8.0+ desktop already pushed on the activity feed. A
   * session with no preview still needs warming, or its card would arrive
   * blank until its row mounts and peeks for itself.
   */
  it('skips the warm-on-register peek for an idle session with a pushed preview, but still warms one with none', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    useActivityStore.getState().registerSession('sess-idle-no-preview', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-idle-no-preview',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });
    useActivityStore.getState().registerSession('sess-idle-with-preview', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-idle-with-preview',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-idle-with-preview',
      taskId: 'task-1',
      payload: { type: 'message-preview', text: 'Already pushed by the desktop.' },
    });

    renderHome();
    await act(async () => {});

    expect(peekLastAssistantMessage).toHaveBeenCalledWith('sess-idle-no-preview', 0);
    expect(peekLastAssistantMessage).not.toHaveBeenCalledWith('sess-idle-with-preview', 0);
  });

  /**
   * Body preference: the desktop's pushed preview outranks this row's own
   * transcript peek (cheapest first - the preview already rode in on a feed
   * the app receives). Constructed so BOTH exist and differ: the row peeks
   * its own snippet before any preview exists, the desktop preview then
   * arrives, and the earlier peeked snippet is still held (never cleared on
   * a refetch) - so only the PREFERENCE, not merely which one is present,
   * decides which text renders.
   */
  it('prefers the desktop-pushed preview over an already-resolved fetched snippet', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue('Older fetched snippet.');
    // seedStores leaves sess-1 awaiting a prompt (the prompt-peek path);
    // move it to idle with no preview yet so it peeks its own message first.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });

    renderHome();
    expect(await screen.findByText('Older fetched snippet.')).toBeTruthy();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'message-preview', text: 'Newer pushed preview.' },
      });
    });

    expect(screen.getByText('Newer pushed preview.')).toBeTruthy();
    expect(screen.queryByText('Older fetched snippet.')).toBeNull();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
  });

  it('shows the pairing CTA when unpaired', () => {
    useChannelStore.setState({ pairedState: 'unpaired' });
    renderHome();
    expect(screen.getByTestId('triage-pair-cta')).toBeTruthy();
  });

  /**
   * With 8+ agents, FlashList v2's maintainVisibleContentPosition held
   * whatever row it first anchored while higher-priority rows inserted
   * ABOVE it, so the feed opened parked at the bottom - showing the working
   * sessions and hiding the ones waiting on you. The fix re-anchors to the
   * top on every insertion while the user is resting there, and the anchor
   * is derived from the live scroll offset on each onScroll (not a one-way
   * latch that, once tripped, could never resume pinning).
   */
  it('re-anchors the feed to the top on every insertion while resting there, and resumes after scrolling back (not a one-way latch)', async () => {
    renderHome();
    const list = screen.getByTestId('triage-home-list');

    function scrollTo(offsetFromTop: number): void {
      fireEvent.scroll(list, { nativeEvent: { contentOffset: { x: 0, y: offsetFromTop } } });
    }

    // Fresh mount: resting at the top, so a row insertion re-anchors.
    fireEvent(list, 'contentSizeChange', 400, 800);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(1);
    expect(mockFlashListScrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });

    // Still within the 8px tolerance: another insertion re-anchors again -
    // this is NOT a one-shot "anchor once on mount" behavior.
    scrollTo(8);
    fireEvent(list, 'contentSizeChange', 400, 900);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(2);

    // Scrolled past the tolerance: a later insertion must not yank the list
    // back out from under the user.
    scrollTo(400);
    fireEvent(list, 'contentSizeChange', 400, 1000);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(2);

    // Scrolling back to the top resumes anchoring - proves this reads the
    // live offset each time rather than latching "the user scrolled away"
    // permanently.
    scrollTo(0);
    fireEvent(list, 'contentSizeChange', 400, 1100);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(3);

    // The lone row is prompt-pending, which kicks off an async snippet peek;
    // let it settle so it does not bleed into the next test.
    await act(async () => {});
  });

  describe('long-press action hub', () => {
    beforeEach(() => {
      seedTwoProjectBoards();
    });

    /**
     * The hub is a native form sheet ROUTE now, so all this screen does is
     * navigate. What still matters HERE - and is the whole reason this feed
     * differs from the board - is that it hands over the ROW'S OWN project:
     * the feed spans every paired project at once, so a screen-level default
     * would open the hub against the wrong board (wrong columns to move into,
     * wrong answer for whether archive is even possible).
     *
     * The hub's own behaviour (replace-not-push, the archive gate, the
     * two-step delete, failure messages) is in
     * tests/components/TaskActionsScreen.test.tsx.
     */
    it("long-press navigates to the actions hub with the row's own project", () => {
      renderHome();

      // task-2/sess-2 lives in project-2, not project-1.
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');

      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/task-actions',
        params: { taskId: 'task-2', projectId: 'project-2' },
      });
      expect(screen.queryByTestId('task-actions-sheet')).toBeNull();
    });
  });
});
