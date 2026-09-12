import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { TaskActionsScreen } from '@/screens/TaskActionsScreen';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockParams: { taskId?: string; projectId?: string } = { taskId: 'task-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, back: mockBack, push: jest.fn() }),
}));

const mockOpenURL = jest.fn().mockResolvedValue(true);
jest.mock('expo-linking', () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

const mockArchiveTask = jest.fn().mockResolvedValue(undefined);
const mockDeleteTaskFromBoard = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  archiveTask: (input: unknown) => mockArchiveTask(input),
  deleteTaskFromBoard: (input: unknown) => mockDeleteTaskFromBoard(input),
}));

/** `withDoneColumn` decides whether Archive is even possible - it is a move into a done-role column. */
function seedBoard({
  withDoneColumn,
  task = {},
}: {
  withDoneColumn: boolean;
  task?: Partial<BoardTaskWire>;
}): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
          ...(withDoneColumn ? [boardColumnFixture({ id: 'lane-done', name: 'Done', position: 1, role: 'done' })] : []),
        ],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', swimlane_id: 'lane-todo', ...task }),
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

function renderTaskActions(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <TaskActionsScreen />
    </ThemeProvider>,
  );
}

describe('TaskActionsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard({ withDoneColumn: true });
  });

  describe('View pull request', () => {
    const linkedPr = {
      pr_number: 42,
      pr_url: 'https://github.com/Kangentic/kangentic-mobile/pull/42',
      pr_state: 'open',
      pr_merge_readiness: 'conflicting',
    } satisfies Partial<BoardTaskWire>;

    it('is absent when the task has no linked PR', () => {
      renderTaskActions();
      expect(screen.queryByTestId('task-action-view-pr')).toBeNull();
    });

    it('opens the PR through the OS handler, so an installed GitHub app gets the handoff', () => {
      seedBoard({ withDoneColumn: true, task: linkedPr });
      renderTaskActions();

      fireEvent.press(screen.getByTestId('task-action-view-pr'));

      // Assert the argument, not merely that it fired: a row wired to the
      // wrong task's URL would still "work" under a bare toHaveBeenCalled.
      expect(mockOpenURL).toHaveBeenCalledWith('https://github.com/Kangentic/kangentic-mobile/pull/42');
    });

    it('captions itself with the PR number and the same verdict word the card chip uses', () => {
      seedBoard({ withDoneColumn: true, task: linkedPr });
      renderTaskActions();

      expect(screen.getByText('#42 - conflicts')).toBeTruthy();
    });

    it('captions a merged PR without leaking its stale verdict', () => {
      seedBoard({
        withDoneColumn: true,
        task: { ...linkedPr, pr_state: 'merged', pr_merge_readiness: 'ready' },
      });
      renderTaskActions();

      expect(screen.getByText('#42 - merged')).toBeTruthy();
    });

    it('drops the number rather than captioning "#null" when a PR was linked before number tracking', () => {
      seedBoard({ withDoneColumn: true, task: { ...linkedPr, pr_number: null } });
      renderTaskActions();

      expect(screen.getByText('conflicts')).toBeTruthy();
    });

    it('accepts an uppercase scheme, which is case-insensitive, without lowercasing the path', () => {
      seedBoard({
        withDoneColumn: true,
        task: { ...linkedPr, pr_url: 'HTTPS://github.com/Kangentic/Kangentic-Mobile/pull/42' },
      });
      renderTaskActions();

      fireEvent.press(screen.getByTestId('task-action-view-pr'));

      expect(mockOpenURL).toHaveBeenCalledWith('HTTPS://github.com/Kangentic/Kangentic-Mobile/pull/42');
    });

    it('keeps the sheet open with the reason when the OS refuses to open the pull request', async () => {
      // The `.catch` on `Linking.openURL` had no test at all - the mock was a
      // permanent `mockResolvedValue(true)`, never made to reject. Mirrors the
      // archive-failure test below for the same handler shape.
      seedBoard({ withDoneColumn: true, task: linkedPr });
      mockOpenURL.mockRejectedValueOnce(new Error('No app can handle this link'));
      renderTaskActions();

      await act(async () => {
        fireEvent.press(screen.getByTestId('task-action-view-pr'));
      });

      expect(screen.getByText('No app can handle this link')).toBeTruthy();
      expect(mockBack).not.toHaveBeenCalled();
    });

    it.each([
      ['javascript:alert(1)'],
      ['http://github.com/Kangentic/kangentic-mobile/pull/42'],
      ['not a url at all'],
      ['https://'],
      [' https://github.com/x/y/pull/1'],
    ])('refuses to render a row for %s rather than handing it to the opener', (prUrl) => {
      seedBoard({ withDoneColumn: true, task: { ...linkedPr, pr_url: prUrl } });
      renderTaskActions();

      expect(screen.queryByTestId('task-action-view-pr')).toBeNull();
      expect(mockOpenURL).not.toHaveBeenCalled();
    });
  });

  it('titles itself with the task and offers the full lifecycle', () => {
    renderTaskActions();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByTestId('task-action-move')).toBeTruthy();
    expect(screen.getByTestId('task-action-edit')).toBeTruthy();
    expect(screen.getByTestId('task-action-archive')).toBeTruthy();
    expect(screen.getByTestId('task-action-delete')).toBeTruthy();
  });

  /**
   * REPLACE, not push: dismissing the sheet these open should return to the
   * board, not to a menu the user has already finished with.
   */
  it('replaces itself with the move and edit sheets rather than stacking on them', () => {
    renderTaskActions();

    fireEvent.press(screen.getByTestId('task-action-move'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });

    fireEvent.press(screen.getByTestId('task-action-edit'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/edit-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  it('archives and dismisses', async () => {
    renderTaskActions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(mockArchiveTask).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mockBack).toHaveBeenCalled();
  });

  /** Archive is a move into the done column, so a board without one cannot offer it. */
  it('disables archive on a board with no done column, and says why', () => {
    seedBoard({ withDoneColumn: false });
    renderTaskActions();
    expect(screen.getByTestId('task-action-archive').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('No Done column on this board')).toBeTruthy();
  });

  /** Delete also kills the task's live desktop session, so one tap must never fire it. */
  it('requires a second tap to delete', async () => {
    renderTaskActions();

    fireEvent.press(screen.getByTestId('task-action-delete'));
    expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();
    expect(screen.getByText('Removes the task and stops its session on your desktop')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });
    expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mockBack).toHaveBeenCalled();
  });

  /**
   * The armed confirmation must NOT expire on a clock.
   *
   * It used to relax after ten seconds, and the E2E flow caught it the only
   * way it could: Maestro spent 14.8s between the two tap gestures (6.2s of
   * that waiting for the view hierarchy to settle), so the confirm tap landed
   * on a row that had quietly disarmed and merely re-armed it. No delete_task
   * ever reached the desktop and the sheet showed no reason. A human who
   * stops to read "Removes the task and stops its session on your desktop"
   * hits the same wall. The old test could not see any of this because it
   * pressed twice in the same tick.
   */
  it('still deletes on the second tap long after the first, with no confirmation deadline', async () => {
    jest.useFakeTimers();
    try {
      renderTaskActions();

      fireEvent.press(screen.getByTestId('task-action-delete'));
      expect(screen.getByTestId('task-action-delete-confirm')).toBeTruthy();

      // Well past both the removed 10s window and any successor to it.
      act(() => {
        jest.advanceTimersByTime(120_000);
      });
      expect(screen.getByTestId('task-action-delete-confirm')).toBeTruthy();
      expect(screen.queryByTestId('task-action-delete')).toBeNull();

      await act(async () => {
        fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
      });
      expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A destructive row that no-ops in silence is its own defect: the user
   * cannot tell a refusal from a broken app. Route params should always be
   * there, so this is a defect path - which is exactly why it must speak.
   */
  it('says why instead of doing nothing when the route params are missing', async () => {
    mockParams = {};
    renderTaskActions();

    fireEvent.press(screen.getByTestId('task-action-delete'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });

    expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();
    expect(screen.getByTestId('task-action-error')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('keeps the sheet open with the reason when an action fails', async () => {
    mockArchiveTask.mockRejectedValueOnce(new Error('The desktop refused'));
    renderTaskActions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(screen.getByText('The desktop refused')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });
});
