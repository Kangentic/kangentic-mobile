import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { FlashList } from '@shopify/flash-list';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { AppHeader, ConnectionBanner, EmptyState, IconButton, Screen, SkeletonCard, Stack, useTheme, type AgentStatusKind } from '@/components';
import { collapseToSnippetText } from '@/conversation/pendingPromptSummary';
import { ColumnChipBar } from '@/components/board/ColumnChipBar';
import { TaskCard } from '@/components/board/TaskCard';
import {
  isDoneColumn,
  selectArchived,
  selectColumnsOrdered,
  selectTasksForColumn,
  useBoardStore,
  type ProjectBoard,
} from '@/state/boardStore';
import { useActivityStore, sectionForEntry } from '@/state/activityStore';
import { ARCHIVED_PAGE_SIZE, loadArchivedTasks, openProjectBoard, refreshSnapshots } from '@/connection/actions';
import { reportHandledError } from '@/observability/crashReporting';

/** One shared empty array so a task-less column does not hand FlashList a new `data` identity per render. */
const NO_TASKS: BoardTaskWire[] = [];

/**
 * The archived read is allowed to fail without taking the board down - a
 * desktop older than 0.10.0 rejects the action outright, and an empty Done
 * column is the right answer there. Silence is NOT the right answer to the
 * developer, though: an empty column looks identical whether the desktop said
 * "no completed tasks" or "I do not know that verb", and telling those apart
 * by hand costs an afternoon. The console line is dev-only; the handled-error
 * door is what a shipped build sends, and a CapabilityError with verb
 * `read-board` is the old-desktop signature its `verb` tag counts.
 */
function reportArchivedFetchFailure(error: unknown): void {
  reportHandledError('board-archived-read', error);
  if (__DEV__) console.warn('[board] archived tasks unavailable:', error);
}

/** Placeholder cards shown for the one round trip that upgrades a board to the full projection. */
const BOARD_SKELETON_CARDS = ['board-skeleton-1', 'board-skeleton-2', 'board-skeleton-3'];

export function BoardScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const projects = useBoardStore((state) => state.projects);
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  // Store state, not local: the project picker is a form sheet route now and
  // cannot reach in here to set it.
  const selectedProjectId = useBoardStore((state) => state.selectedProjectId);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const pagerRef = useRef<PagerView>(null);

  const projectId = selectedProjectId ?? projects[0]?.id ?? null;
  // Switching project starts at its first column rather than carrying over an
  // index from the board the user just left. Owned here rather than by the
  // picker, which no longer has a way to reach this screen's state. Adjusted
  // during render (the sanctioned derive-from-state pattern, as SessionScreen
  // does) rather than in an effect, which would cascade an extra render.
  const [previousProjectId, setPreviousProjectId] = useState<string | null>(projectId);
  if (projectId !== previousProjectId) {
    setPreviousProjectId(projectId);
    setActiveColumnId(null);
  }
  const board: ProjectBoard | null = projectId ? (boardsByProjectId[projectId] ?? null) : null;
  const archived = useBoardStore((state) => selectArchived(state, projectId));
  // Every other screen reads the feed projection, which carries only the tasks
  // with an agent on them. This one draws every column and every card, so it
  // asks the desktop to upgrade the project it is showing - on focus, so a
  // board the user never opens is never fetched in full.
  useFocusEffect(
    useCallback(() => {
      if (!projectId) return;
      openProjectBoard(projectId);
      // Completed work rides its own one-shot read: it is in neither board
      // projection, so without this the Done column has nothing to draw. A
      // failure here leaves that one column empty and must not take the rest
      // of the board down with it.
      //
      // Skipped once the user has paged past the first page. This read is
      // append:false, which REPLACES the held rows and rewinds the cursor to
      // one page, so refetching on every focus would throw their paging away
      // on a gesture as ordinary as switching to Home and back. Pull-to-refresh
      // is the deliberate way to re-read the archive from the top.
      const heldArchive = useBoardStore.getState().archivedByProjectId[projectId];
      if (heldArchive === undefined || heldArchive.nextOffset <= ARCHIVED_PAGE_SIZE) {
        void loadArchivedTasks({ projectId }).catch(reportArchivedFetchFailure);
      }
    }, [projectId]),
  );
  // ...and it does not paint until that upgrade lands. Rendering a 'sessions'
  // board here would show a two-card board that fills in a beat later, which
  // is the staggered cold start this release exists to remove.
  const fullBoard = board !== null && board.view === 'full' ? board : null;
  const awaitingFullBoard = board !== null && fullBoard === null;
  const columns = useMemo(() => (fullBoard ? selectColumnsOrdered(fullBoard) : []), [fullBoard]);
  // Derived once per board/column change, not per render: selectTasksForColumn
  // filters + sorts the whole task map, and calling it inline in the render
  // body handed every column's FlashList a brand-new `data` array on every
  // unrelated BoardScreen state change (opening a sheet, pull-to-refresh).
  // The counts read off the same map rather than repeating the derivation.
  const tasksByColumnId = useMemo(() => {
    const byColumnId = new Map<string, BoardTaskWire[]>();
    for (const column of columns) {
      const boardTasks = fullBoard ? selectTasksForColumn(fullBoard, column.id) : [];
      if (!isDoneColumn(column)) {
        byColumnId.set(column.id, boardTasks);
        continue;
      }
      // The done lane draws BOTH: the archive is its real content (the desktop
      // archives a task the moment it lands there, so every board projection
      // has already dropped it), but a task sitting in the lane un-archived is
      // real too. That is the optimistic window after a move from this phone -
      // without the board half, confirming a move to Done makes the card
      // vanish from the old column and never appear in the new one.
      const archivedIds = new Set(archived.tasks.map((task) => task.id));
      byColumnId.set(column.id, [...boardTasks.filter((task) => !archivedIds.has(task.id)), ...archived.tasks]);
    }
    return byColumnId;
  }, [columns, fullBoard, archived.tasks]);
  const taskCounts = useMemo(
    () =>
      columns.map((column) => {
        const held = tasksByColumnId.get(column.id)?.length ?? 0;
        if (!isDoneColumn(column)) return held;
        // The archive's TOTAL, not the loaded page's length, so the chip does
        // not read "25" on a board holding two hundred completed tasks. Plus
        // whatever is in the lane un-archived, which the total does not count.
        return archived.totalCount + Math.max(0, held - archived.tasks.length);
      }),
    [columns, tasksByColumnId, archived.totalCount, archived.tasks.length],
  );
  const projectName = projects.find((project) => project.id === projectId)?.name ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // The archive is in neither board projection, so refreshSnapshots does not
    // touch it. Without this second read, pulling to refresh ON the Done column
    // refreshes every column except the one under the user's thumb, and a task
    // archived from the desktop stays invisible until the tab is left and
    // re-entered. append:false, so it also rewinds the cursor to page one -
    // which is what a pull-to-refresh should mean.
    void Promise.all([
      refreshSnapshots(),
      projectId ? loadArchivedTasks({ projectId }).catch(reportArchivedFetchFailure) : undefined,
    ])
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [projectId]);

  const activeColumnIndex = Math.max(
    0,
    columns.findIndex((candidate) => candidate.id === activeColumnId),
  );

  // The column set changed under the active id (add/remove/reorder while
  // viewing): follow the same column when it still exists, otherwise fall
  // back to the first column instead of stranding the pager on a stale index.
  // Adjusted synchronously during render (comparing against the previous
  // render's columns) rather than in an effect - React re-renders immediately
  // on a setState called this way, without committing the stale frame first.
  const [prevColumns, setPrevColumns] = useState(columns);
  if (columns !== prevColumns) {
    setPrevColumns(columns);
    if (columns.length > 0 && !columns.some((column) => column.id === activeColumnId)) {
      setActiveColumnId(columns[0]?.id ?? null);
    }
  }

  // Chip tap only sets intent; the sync effect below is the sole setPage
  // caller, so a tap and a swipe converge on the exact same code path.
  const selectColumn = useCallback(
    (columnIndex: number) => {
      const column = columns[columnIndex];
      if (column) setActiveColumnId(column.id);
    },
    [columns],
  );

  // Swipe -> chip sync. Reads the CURRENT columns (not a stale closure) so a
  // swipe lands on the right column even if the set changed underneath.
  const onPageSelected = useCallback(
    (event: { nativeEvent: { position: number } }) => {
      const column = columns[event.nativeEvent.position];
      if (column) setActiveColumnId(column.id);
    },
    [columns],
  );

  // Chip tap -> pager sync (the only setPage call site). The jest mock
  // forwards the ref to a plain View with no imperative API; on-device it
  // always has one. After a real swipe this is a no-op (the pager already
  // shows activeColumnIndex).
  useEffect(() => {
    const pager = pagerRef.current;
    if (pager && typeof pager.setPage === 'function') pager.setPage(activeColumnIndex);
  }, [activeColumnIndex]);

  // Stable identity: an inline arrow here would be a fresh prop on every
  // BoardScreen render, which defeats BoardTaskCard's React.memo for every
  // visible card in every column.
  const onLongPressTask = useCallback(
    (task: BoardTaskWire) => {
      if (!projectId) return;
      router.push({ pathname: '/task-actions', params: { taskId: task.id, projectId } });
    },
    [router, projectId],
  );

  return (
    <Screen testID="board-screen" edges={['left', 'right']}>
      {/* The header title IS the project switcher: the board is always
          "some project's board", so the current project stays visible and
          tappable even before a second project exists. */}
      <AppHeader
        title={projectName ?? 'Board'}
        subtitle={projectName ? 'Board' : undefined}
        onTitlePress={projects.length > 0 ? () => router.push('/project-picker') : undefined}
        divider={columns.length === 0}
        testID="board-header"
      />
      <ConnectionBanner />

      {awaitingFullBoard ? (
        <Stack gap="sm" style={{ padding: theme.spacing.lg }} testID="board-loading">
          {BOARD_SKELETON_CARDS.map((cardKey) => (
            <SkeletonCard key={cardKey} />
          ))}
        </Stack>
      ) : columns.length === 0 ? (
        <EmptyState
          testID="board-empty-state"
          title={projects.length === 0 ? 'No board yet' : 'No columns yet'}
          caption={projects.length === 0 ? 'Connect to your desktop to see the board.' : 'Add columns from the desktop.'}
          overseerSize={54}
          overseerAnimate="blink-loop"
        />
      ) : (
        <>
          {/* The chip row extends the header block: same surface, and it
              carries the divider so header + chips read as one anchored
              navigation surface (Material app-bar-with-tabs). */}
          <View
            style={{
              paddingTop: theme.spacing.xs,
              paddingBottom: theme.spacing.sm,
              backgroundColor: theme.colors.surface,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border,
            }}
          >
            <ColumnChipBar columns={columns} taskCounts={taskCounts} activeIndex={activeColumnIndex} onSelect={selectColumn} />
          </View>
          <PagerView
            ref={pagerRef}
            key={projectId}
            testID="board-list"
            style={styles.flex}
            initialPage={activeColumnIndex}
            offscreenPageLimit={1}
            onPageSelected={onPageSelected}
          >
            {columns.map((column) => (
              <View key={column.id} testID={`board-column-${column.id}`} style={styles.flex}>
                <ColumnPage
                  column={column}
                  tasks={tasksByColumnId.get(column.id) ?? NO_TASKS}
                  projectId={projectId ?? ''}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  onLongPressTask={onLongPressTask}
                />
              </View>
            ))}
          </PagerView>
        </>
      )}

      <View style={[styles.fabContainer, { right: theme.spacing.lg, bottom: theme.spacing.xl }]}>
        <IconButton
          iconName="add"
          variant="fab"
          onPress={() => {
            if (!projectId) return;
            router.push({ pathname: '/create-task', params: { projectId } });
          }}
          testID="board-create-task"
          accessibilityLabel="Create a task"
        />
      </View>

    </Screen>
  );
}

/**
 * One board page: a column's tasks, or a styled empty state when it has
 * none. Pull-to-refresh works on both branches - the FlashList and the
 * empty-state ScrollView call the same global refreshSnapshots(), so an
 * empty column is not a dead end for the gesture.
 */
function ColumnPage({
  column,
  tasks,
  projectId,
  refreshing,
  onRefresh,
  onLongPressTask,
}: {
  column: BoardColumnWire;
  tasks: BoardTaskWire[];
  projectId: string;
  refreshing: boolean;
  onRefresh: () => void;
  onLongPressTask: (task: BoardTaskWire) => void;
}): React.JSX.Element {
  const theme = useTheme();
  // Stable across renders so FlashList's row components keep their memo:
  // an inline renderItem rebuilds every row's props on every parent render.
  const renderTask = useCallback(
    ({ item }: { item: BoardTaskWire }) => (
      <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
        <BoardTaskCard task={item} projectId={projectId} onLongPressTask={onLongPressTask} />
      </View>
    ),
    [theme.spacing.md, theme.spacing.sm, projectId, onLongPressTask],
  );
  // Paging the archive. loadArchivedTasks itself no-ops once every page is
  // in, so this does not need to know how much is left.
  const onEndReached = useCallback(() => {
    if (projectId) void loadArchivedTasks({ projectId, append: true }).catch(reportArchivedFetchFailure);
  }, [projectId]);
  const refreshControl = (
    // tintColor styles iOS; colors + progressBackgroundColor style Android
    // (stock is a white circle, jarring on the warm theme).
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={theme.colors.textSecondary}
      colors={[theme.colors.accent]}
      progressBackgroundColor={theme.colors.surfaceOverlay}
    />
  );

  const isDone = isDoneColumn(column);

  if (tasks.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.flex} refreshControl={refreshControl}>
        <EmptyState
          testID={`board-column-${column.id}-empty`}
          title={isDone ? 'Nothing completed yet' : 'No tasks'}
          caption={isDone ? 'Finished tasks land here.' : 'Move a task here or add one from the desktop.'}
          overseerSize={54}
          overseerAnimate="blink-loop"
        />
      </ScrollView>
    );
  }

  return (
    <FlashList<BoardTaskWire>
      testID={`board-column-${column.id}-list`}
      data={tasks}
      keyExtractor={(task) => task.id}
      getItemType={() => 'task'}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxl }}
      renderItem={renderTask}
      // Only the done column pages: every other column's tasks arrive whole
      // with the snapshot, so there is nothing further to fetch.
      onEndReached={isDone ? onEndReached : undefined}
      onEndReachedThreshold={0.5}
    />
  );
}

const CARD_DESCRIPTION_LINES = 2;

/**
 * The board's per-item connector: reads the session's activity/usage and
 * the project's ticket-number setting, then hands off to the shared
 * TaskCard (@/components/board/TaskCard) - the exact same card the Agents
 * feed renders, minus its extra project row (the board already establishes
 * project context by which board you're viewing).
 */
const BoardTaskCard = React.memo(function BoardTaskCard({
  task,
  projectId,
  onLongPressTask,
}: {
  task: BoardTaskWire;
  projectId: string;
  onLongPressTask: (task: BoardTaskWire) => void;
}): React.JSX.Element {
  const router = useRouter();
  // Built here rather than per-row in renderItem: the parent hands down one
  // stable callback, so this card's props stay identical between renders.
  const onLongPress = useCallback(() => onLongPressTask(task), [onLongPressTask, task]);
  const activityEntry = useActivityStore((state) => (task.session_id ? (state.bySessionId[task.session_id] ?? null) : null));
  const showTicketNumbers = useBoardStore((state) => state.boardsByProjectId[projectId]?.showTicketNumbers ?? true);

  // Desktop parity (TaskCard.handleClick): a task with no session on it opens
  // straight into the edit form. Keyed on the session, not the column, because
  // that is what the desktop keys on - a task parked in Testing with no agent
  // is as sessionless as one in To Do, and a column check would send it to an
  // empty session shell. Moving to To Do hard-resets a task (the desktop kills
  // the session, worktree and branch), so that column can never have one.
  const openTask = useCallback(() => {
    // Checked before the session test, not after: an archived task ALWAYS has
    // a null session_id (the move to Done suspends the agent and clears it),
    // so the sessionless branch would otherwise swallow every completed task
    // and offer to edit finished work instead of showing what it did.
    if (task.archived_at !== null) {
      router.push({ pathname: '/completed-task', params: { taskId: task.id, projectId } });
      return;
    }
    if (task.session_id === null) {
      router.push({ pathname: '/edit-task', params: { taskId: task.id, projectId } });
      return;
    }
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId: task.id, sessionId: task.session_id, projectId },
    });
  }, [router, task.id, task.session_id, task.archived_at, projectId]);

  // Desktop TaskCard parity: spinner while thinking, mail while the
  // session waits on the user (permission or idle).
  const statusKind: AgentStatusKind | null = activityEntry
    ? sectionForEntry(activityEntry) === 'working'
      ? 'working'
      : sectionForEntry(activityEntry) === 'needs-you' || activityEntry.unreadCount > 0
        ? 'idle-unread'
        : 'idle'
    : null;
  const descriptionPreview = task.description.length > 0 ? collapseToSnippetText(task.description) : '';

  return (
    <TaskCard
      testID={`board-card-${task.id}`}
      task={task}
      statusKind={statusKind}
      showTicketNumbers={showTicketNumbers}
      usage={activityEntry?.usage ?? null}
      bodyText={descriptionPreview}
      bodyNumberOfLines={CARD_DESCRIPTION_LINES}
      onPress={openTask}
      onLongPress={onLongPress}
    />
  );
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  fabContainer: {
    position: 'absolute',
  },
});
