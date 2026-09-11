import { create } from 'zustand';
import type {
  BoardColumnWire,
  BoardTaskWire,
  ReadBoardArchivedResponsePayload,
  ReadBoardProjectGroup,
  ReadBoardProjectSummary,
  ReadBoardSnapshotResponsePayload,
  ReadBoardView,
  SessionSummaryWire,
} from '@kangentic/protocol';

export interface ProjectBoard {
  columns: BoardColumnWire[];
  tasksById: Record<string, BoardTaskWire>;
  /** Epoch ms when this snapshot was applied. */
  snapshotAt: number;
  /** The desktop's Layout "Ticket Numbers" setting; absent on the wire (pre-0.6.0 desktop) means true, the desktop default. */
  showTicketNumbers: boolean;
  /**
   * Which projection `tasksById` holds. 'sessions' carries only the tasks
   * with an agent on them, which is all the Agents feed draws; the Board tab
   * needs 'full' and must not paint until it has one. A pre-0.9.0 desktop
   * sends no `view` at all and always means a full board.
   */
  view: ReadBoardView;
  /**
   * Whole-column task counts from a 'sessions' snapshot, where `tasksById` is
   * filtered and counting it would undercount. Empty under 'full', where the
   * local task list is both complete and fresher (it carries pending
   * optimistic moves).
   */
  taskCountsByColumnId: Record<string, number>;
}

/**
 * A project's completed tasks, held apart from `ProjectBoard` because they
 * arrive on their own one-shot read rather than with the board snapshot, and
 * a snapshot must never clear them.
 */
export interface ArchivedTasks {
  /** Newest-archived first, as the desktop ordered them. */
  tasks: BoardTaskWire[];
  /** Total in the project, which exceeds `tasks.length` until every page is in. */
  totalCount: number;
  /** Sparse: a task archived without ever running an agent has no summary. */
  summariesByTaskId: Record<string, SessionSummaryWire>;
  /**
   * Offset the NEXT page should ask for: how many rows the desktop has handed
   * over, which is not the same as how many are held.
   *
   * Tracked separately because pages are de-duplicated on arrival, so
   * `tasks.length` can grow by less than a page. Deriving the offset from it
   * would then re-request ground already covered, and a page that happened to
   * be entirely duplicates would leave the offset frozen - paging stuck with
   * rows still unfetched, refiring on every scroll to the end.
   */
  nextOffset: number;
  /** True while a page request is in flight, so the column can show it. */
  loading: boolean;
}

export interface PendingMove {
  moveId: string;
  projectId: string;
  taskId: string;
  fromSwimlaneId: string;
  fromPosition: number;
  toSwimlaneId: string;
  toPosition: number;
}

export interface PendingTaskEdit {
  editId: string;
  projectId: string;
  taskId: string;
  previousTitle: string;
  previousDescription: string;
  nextTitle: string | null;
  nextDescription: string | null;
}

export interface PendingTaskRemoval {
  removalId: string;
  projectId: string;
  removedTask: BoardTaskWire;
}

interface BoardStoreState {
  projects: ReadBoardProjectSummary[];
  boardsByProjectId: Record<string, ProjectBoard>;
  /**
   * Latched true the first time any board snapshot lands. Bootstrap flips
   * `channelStore.established` before the first snapshot arrives, so the
   * home feed gates its "All quiet" empty state on this flag too - otherwise
   * it flashes "All quiet" during the window between channel-up and
   * first-snapshot. Reset alongside the rest of the board on `reset()`
   * (unpair), so a fresh pairing gets the same cold-start gating.
   */
  hasHydratedSnapshot: boolean;
  /**
   * Which project the Board tab is showing, or null to fall back to the first.
   *
   * Store state rather than BoardScreen's own useState because the project
   * picker is a form sheet ROUTE now, and a route cannot reach into another
   * screen's local state to set it.
   */
  selectedProjectId: string | null;
  pendingMoves: PendingMove[];
  pendingEdits: PendingTaskEdit[];
  pendingRemovals: PendingTaskRemoval[];
  /** Completed tasks per project, filled on demand by the Done column. */
  archivedByProjectId: Record<string, ArchivedTasks>;
  /** Desktop project groups in display order; empty against a pre-0.11.0 desktop, which means one flat list. */
  projectGroups: ReadBoardProjectGroup[];
  applyProjectList: (projects: ReadBoardProjectSummary[], groups?: ReadBoardProjectGroup[]) => void;
  selectProject: (projectId: string) => void;
  applyBoardSnapshot: (snapshot: ReadBoardSnapshotResponsePayload) => void;
  setArchivedLoading: (projectId: string, loading: boolean) => void;
  applyArchivedPage: (page: ReadBoardArchivedResponsePayload, options: { append: boolean }) => void;
  applyOptimisticMove: (move: { projectId: string; taskId: string; toSwimlaneId: string; toPosition: number }) => string | null;
  commitMove: (moveId: string) => void;
  rollbackMove: (moveId: string) => void;
  applyOptimisticTaskEdit: (edit: { projectId: string; taskId: string; title?: string; description?: string }) => string | null;
  commitTaskEdit: (editId: string) => void;
  rollbackTaskEdit: (editId: string) => void;
  applyOptimisticRemoval: (removal: { projectId: string; taskId: string }) => string | null;
  commitRemoval: (removalId: string) => void;
  rollbackRemoval: (removalId: string) => void;
  reset: () => void;
}

/** Shared empty value, so a project with no page yet still has a shape to read. */
const EMPTY_ARCHIVED: ArchivedTasks = { tasks: [], totalCount: 0, summariesByTaskId: {}, nextOffset: 0, loading: false };

let nextMoveSequence = 0;
let nextEditSequence = 0;
let nextRemovalSequence = 0;

function moveTaskInBoard(board: ProjectBoard, taskId: string, toSwimlaneId: string, toPosition: number): ProjectBoard {
  const task = board.tasksById[taskId];
  if (!task) return board;
  const movedTask: BoardTaskWire = { ...task, swimlane_id: toSwimlaneId, position: toPosition };
  const tasksById: Record<string, BoardTaskWire> = { ...board.tasksById, [taskId]: movedTask };
  // Shift positions in the target column so the moved task slots in without
  // duplicate positions; the authoritative ordering arrives with the next
  // snapshot refresh, this only has to look right until then.
  for (const otherTask of Object.values(board.tasksById)) {
    if (otherTask.id === taskId) continue;
    if (otherTask.swimlane_id === toSwimlaneId && otherTask.position >= toPosition) {
      tasksById[otherTask.id] = { ...otherTask, position: otherTask.position + 1 };
    }
  }
  return { ...board, tasksById };
}

function editTaskInBoard(board: ProjectBoard, taskId: string, fields: { title: string | null; description: string | null }): ProjectBoard {
  const task = board.tasksById[taskId];
  if (!task) return board;
  const editedTask: BoardTaskWire = {
    ...task,
    ...(fields.title !== null ? { title: fields.title } : {}),
    ...(fields.description !== null ? { description: fields.description } : {}),
  };
  return { ...board, tasksById: { ...board.tasksById, [taskId]: editedTask } };
}

function removeTaskFromBoard(board: ProjectBoard, taskId: string): ProjectBoard {
  if (!(taskId in board.tasksById)) return board;
  const tasksById = { ...board.tasksById };
  delete tasksById[taskId];
  return { ...board, tasksById };
}

export const useBoardStore = create<BoardStoreState>((set, get) => ({
  projects: [],
  boardsByProjectId: {},
  hasHydratedSnapshot: false,
  selectedProjectId: null,
  pendingMoves: [],
  pendingEdits: [],
  pendingRemovals: [],
  archivedByProjectId: {},
  projectGroups: [],

  applyProjectList: (projects, groups) => set({ projects, projectGroups: groups ?? [] }),

  selectProject: (projectId) => set({ selectedProjectId: projectId }),

  setArchivedLoading: (projectId, loading) =>
    set((state) => ({
      archivedByProjectId: {
        ...state.archivedByProjectId,
        [projectId]: { ...(state.archivedByProjectId[projectId] ?? EMPTY_ARCHIVED), loading },
      },
    })),

  applyArchivedPage: (page, options) =>
    set((state) => {
      const existing = state.archivedByProjectId[page.projectId] ?? EMPTY_ARCHIVED;
      // Appending de-duplicates by id rather than concatenating blindly: a
      // task archived between two page requests shifts every later row down
      // by one, so the next page legitimately re-sends a row already held.
      const tasks = options.append
        ? [...existing.tasks, ...page.archivedTasks.filter((task) => !existing.tasks.some((held) => held.id === task.id))]
        : page.archivedTasks;
      return {
        archivedByProjectId: {
          ...state.archivedByProjectId,
          [page.projectId]: {
            tasks,
            totalCount: page.archivedTotalCount,
            summariesByTaskId: options.append
              ? { ...existing.summariesByTaskId, ...page.summariesByTaskId }
              : page.summariesByTaskId,
            // Advanced by what the desktop RETURNED, so a page thinned by
            // de-duplication still moves the cursor forward by a full page.
            nextOffset: (options.append ? existing.nextOffset : 0) + page.archivedTasks.length,
            loading: false,
          },
        },
      };
    }),

  applyBoardSnapshot: (snapshot) =>
    set((state) => {
      let board: ProjectBoard = {
        columns: snapshot.columns,
        tasksById: Object.fromEntries(snapshot.tasks.map((task) => [task.id, task])),
        snapshotAt: Date.now(),
        showTicketNumbers: snapshot.showTicketNumbers ?? true,
        // A desktop that echoes no view predates the projection and always
        // sends the whole board - absent means full, never "filtered, unknown".
        view: snapshot.view ?? 'full',
        taskCountsByColumnId: snapshot.taskCountsByColumnId ?? {},
      };
      // Re-apply in-flight optimistic mutations on top, so a snapshot racing
      // one does not visibly bounce the card before the mutation commits.
      for (const pendingMove of state.pendingMoves) {
        if (pendingMove.projectId === snapshot.projectId) {
          board = moveTaskInBoard(board, pendingMove.taskId, pendingMove.toSwimlaneId, pendingMove.toPosition);
        }
      }
      for (const pendingEdit of state.pendingEdits) {
        if (pendingEdit.projectId === snapshot.projectId) {
          board = editTaskInBoard(board, pendingEdit.taskId, { title: pendingEdit.nextTitle, description: pendingEdit.nextDescription });
        }
      }
      for (const pendingRemoval of state.pendingRemovals) {
        if (pendingRemoval.projectId === snapshot.projectId) {
          board = removeTaskFromBoard(board, pendingRemoval.removedTask.id);
        }
      }
      return {
        boardsByProjectId: { ...state.boardsByProjectId, [snapshot.projectId]: board },
        hasHydratedSnapshot: true,
      };
    }),

  applyOptimisticMove: (move) => {
    const state = get();
    const board = state.boardsByProjectId[move.projectId];
    const task = board?.tasksById[move.taskId];
    if (!board || !task) return null;
    nextMoveSequence += 1;
    const pendingMove: PendingMove = {
      moveId: `move-${nextMoveSequence}`,
      projectId: move.projectId,
      taskId: move.taskId,
      fromSwimlaneId: task.swimlane_id,
      fromPosition: task.position,
      toSwimlaneId: move.toSwimlaneId,
      toPosition: move.toPosition,
    };
    set({
      pendingMoves: [...state.pendingMoves, pendingMove],
      boardsByProjectId: {
        ...state.boardsByProjectId,
        [move.projectId]: moveTaskInBoard(board, move.taskId, move.toSwimlaneId, move.toPosition),
      },
    });
    return pendingMove.moveId;
  },

  commitMove: (moveId) =>
    set((state) => ({ pendingMoves: state.pendingMoves.filter((pendingMove) => pendingMove.moveId !== moveId) })),

  rollbackMove: (moveId) =>
    set((state) => {
      const pendingMove = state.pendingMoves.find((candidate) => candidate.moveId === moveId);
      if (!pendingMove) return state;
      const board = state.boardsByProjectId[pendingMove.projectId];
      const restoredBoard = board
        ? moveTaskInBoard(board, pendingMove.taskId, pendingMove.fromSwimlaneId, pendingMove.fromPosition)
        : board;
      return {
        pendingMoves: state.pendingMoves.filter((candidate) => candidate.moveId !== moveId),
        ...(restoredBoard ? { boardsByProjectId: { ...state.boardsByProjectId, [pendingMove.projectId]: restoredBoard } } : {}),
      };
    }),

  applyOptimisticTaskEdit: (edit) => {
    const state = get();
    const board = state.boardsByProjectId[edit.projectId];
    const task = board?.tasksById[edit.taskId];
    if (!board || !task) return null;
    nextEditSequence += 1;
    const pendingEdit: PendingTaskEdit = {
      editId: `edit-${nextEditSequence}`,
      projectId: edit.projectId,
      taskId: edit.taskId,
      previousTitle: task.title,
      previousDescription: task.description,
      nextTitle: edit.title ?? null,
      nextDescription: edit.description ?? null,
    };
    set({
      pendingEdits: [...state.pendingEdits, pendingEdit],
      boardsByProjectId: {
        ...state.boardsByProjectId,
        [edit.projectId]: editTaskInBoard(board, edit.taskId, { title: pendingEdit.nextTitle, description: pendingEdit.nextDescription }),
      },
    });
    return pendingEdit.editId;
  },

  commitTaskEdit: (editId) =>
    set((state) => ({ pendingEdits: state.pendingEdits.filter((pendingEdit) => pendingEdit.editId !== editId) })),

  rollbackTaskEdit: (editId) =>
    set((state) => {
      const pendingEdit = state.pendingEdits.find((candidate) => candidate.editId === editId);
      if (!pendingEdit) return state;
      const board = state.boardsByProjectId[pendingEdit.projectId];
      const restoredBoard = board
        ? editTaskInBoard(board, pendingEdit.taskId, { title: pendingEdit.previousTitle, description: pendingEdit.previousDescription })
        : board;
      return {
        pendingEdits: state.pendingEdits.filter((candidate) => candidate.editId !== editId),
        ...(restoredBoard ? { boardsByProjectId: { ...state.boardsByProjectId, [pendingEdit.projectId]: restoredBoard } } : {}),
      };
    }),

  applyOptimisticRemoval: (removal) => {
    const state = get();
    const board = state.boardsByProjectId[removal.projectId];
    const task = board?.tasksById[removal.taskId];
    if (!board || !task) return null;
    nextRemovalSequence += 1;
    const pendingRemoval: PendingTaskRemoval = {
      removalId: `removal-${nextRemovalSequence}`,
      projectId: removal.projectId,
      removedTask: task,
    };
    set({
      pendingRemovals: [...state.pendingRemovals, pendingRemoval],
      boardsByProjectId: {
        ...state.boardsByProjectId,
        [removal.projectId]: removeTaskFromBoard(board, removal.taskId),
      },
    });
    return pendingRemoval.removalId;
  },

  commitRemoval: (removalId) =>
    set((state) => ({ pendingRemovals: state.pendingRemovals.filter((pendingRemoval) => pendingRemoval.removalId !== removalId) })),

  rollbackRemoval: (removalId) =>
    set((state) => {
      const pendingRemoval = state.pendingRemovals.find((candidate) => candidate.removalId === removalId);
      if (!pendingRemoval) return state;
      const board = state.boardsByProjectId[pendingRemoval.projectId];
      const restoredBoard = board
        ? { ...board, tasksById: { ...board.tasksById, [pendingRemoval.removedTask.id]: pendingRemoval.removedTask } }
        : board;
      return {
        pendingRemovals: state.pendingRemovals.filter((candidate) => candidate.removalId !== removalId),
        ...(restoredBoard ? { boardsByProjectId: { ...state.boardsByProjectId, [pendingRemoval.projectId]: restoredBoard } } : {}),
      };
    }),

  reset: () =>
    set({
      projects: [],
      boardsByProjectId: {},
      hasHydratedSnapshot: false,
      selectedProjectId: null,
      pendingMoves: [],
      pendingEdits: [],
      pendingRemovals: [],
      archivedByProjectId: {},
      projectGroups: [],
    }),
}));

/**
 * Visible columns in board order (archived and ghost columns are
 * desktop-internal).
 *
 * The done lane is the deliberate exception: it carries `is_archived` because
 * it ARCHIVES what lands in it, not because it is hidden, and the desktop
 * draws it like any other column. Its own config builder spells the
 * distinction out - `if (lane.is_archived && lane.role !== 'done')` is what
 * marks a column hidden. Reading the flag without that carve-out is what kept
 * completed work off the phone entirely.
 */
export function selectColumnsOrdered(board: ProjectBoard): BoardColumnWire[] {
  return board.columns
    .filter((column) => (!column.is_archived || isDoneColumn(column)) && !column.is_ghost)
    .sort((first, second) => first.position - second.position);
}

/**
 * The two SYSTEM roles the desktop assigns; every other column carries null.
 *
 * `BoardColumnWire.role` is an open `string | null` on the wire, so these
 * literals are matched by convention at every call site and a typo is silent.
 * Routing them through here keeps the strings in one place until the protocol
 * package narrows the field itself (which is where the fix belongs - see
 * .claude/rules/protocol-types-from-package.md; a local union here would be
 * exactly the parallel shape that rule forbids).
 *
 * What each one MEANS, which is why callers care:
 * - `done` archives what lands in it, and deletes the task's worktree.
 * - `todo` is a full reset: session killed, worktree removed, no successor.
 */
export function isDoneRole(role: string | null): boolean {
  return role === 'done';
}

export function isTodoRole(role: string | null): boolean {
  return role === 'todo';
}

/** True for the lane that holds completed work; its cards come from the archive, not the board. */
export function isDoneColumn(column: BoardColumnWire): boolean {
  return isDoneRole(column.role);
}

/** A project's completed tasks; a stable empty value until its first page lands. */
export function selectArchived(
  state: { archivedByProjectId: Record<string, ArchivedTasks> },
  projectId: string | null,
): ArchivedTasks {
  return (projectId !== null ? state.archivedByProjectId[projectId] : undefined) ?? EMPTY_ARCHIVED;
}

/** Finds a completed task and its summary across every project's archive. */
export function findArchivedTaskById(
  state: { archivedByProjectId: Record<string, ArchivedTasks> },
  taskId: string,
): { projectId: string; task: BoardTaskWire; summary: SessionSummaryWire | null } | null {
  for (const [projectId, archived] of Object.entries(state.archivedByProjectId)) {
    const task = archived.tasks.find((candidate) => candidate.id === taskId);
    if (task) return { projectId, task, summary: archived.summariesByTaskId[task.id] ?? null };
  }
  return null;
}

/** Non-archived tasks of one column, by position. */
export function selectTasksForColumn(board: ProjectBoard, swimlaneId: string): BoardTaskWire[] {
  return Object.values(board.tasksById)
    .filter((task) => task.swimlane_id === swimlaneId && task.archived_at === null)
    .sort((first, second) => first.position - second.position);
}

/**
 * How many tasks a column really holds - the position a card takes when it is
 * appended to the end of that column.
 *
 * Under a 'sessions' board the local task list is filtered, so counting it
 * would drop the card into the middle of the column (the desktop writes the
 * position it is given and shifts everything at or above it). The snapshot's
 * whole-column count is the only correct source there. Under a 'full' board
 * the local list wins: it is complete AND carries pending optimistic moves the
 * snapshot has not caught up with.
 */
export function selectColumnTaskCount(board: ProjectBoard, swimlaneId: string): number {
  if (board.view === 'sessions') return board.taskCountsByColumnId[swimlaneId] ?? 0;
  return selectTasksForColumn(board, swimlaneId).length;
}

/** The union of live session ids across every cached board - the bootstrap's stream desired-set source. */
export function selectLiveSessionIds(state: { boardsByProjectId: Record<string, ProjectBoard> }): Set<string> {
  const liveSessionIds = new Set<string>();
  for (const board of Object.values(state.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id !== null && task.archived_at === null) liveSessionIds.add(task.session_id);
    }
  }
  return liveSessionIds;
}

/**
 * The project's desktop-provided accent color, or null when absent or not a
 * string. The protocol's ReadBoardProjectSummary does not carry a color field
 * yet (it ships as an additive `color`/`projectColor` field in a later
 * protocol release), so this narrows defensively with `in` + typeof checks:
 * it compiles and passes through cleanly against desktops that never send it.
 * Hex validation is NOT done here; the theme layer's projectAccent guardrails
 * own rejecting unusable values.
 */
export function selectProjectAccentColor(
  state: { projects: ReadBoardProjectSummary[] },
  projectId: string,
): string | null {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  if ('color' in project && typeof project.color === 'string' && project.color.length > 0) {
    return project.color;
  }
  if ('projectColor' in project && typeof project.projectColor === 'string' && project.projectColor.length > 0) {
    return project.projectColor;
  }
  return null;
}

/** Locates a task (and its project) by id across cached boards - the task screen's param fallback. */
export function findTaskById(
  state: { boardsByProjectId: Record<string, ProjectBoard> },
  taskId: string,
): { task: BoardTaskWire; projectId: string } | null {
  for (const [projectId, board] of Object.entries(state.boardsByProjectId)) {
    const task = board.tasksById[taskId];
    if (task) return { task, projectId };
  }
  return null;
}

/**
 * The column a located task sits in, or null when no cached board holds the
 * task or its swimlane_id names no column in that board's snapshot.
 *
 * Safe as a Zustand selector, unlike findTaskById's fresh object: the return
 * value is the column ELEMENT inside the store's own columns array, so for a
 * given state the reference is stable. Raw board.columns deliberately, not
 * selectColumnsOrdered: a task parked in an archived or ghost column must
 * still resolve (its column is status, hidden or not), and the ordered
 * variant returns a fresh sorted array, which would loop useSyncExternalStore
 * anyway. An optimistic move swaps the task's swimlane_id under an unchanged
 * columns array, so the selector re-labels instantly; a re-snapshot replaces
 * the array and repaints.
 */
export function selectTaskColumn(
  state: { boardsByProjectId: Record<string, ProjectBoard> },
  taskId: string,
): BoardColumnWire | null {
  const located = findTaskById(state, taskId);
  if (!located) return null;
  const board = state.boardsByProjectId[located.projectId];
  if (!board) return null;
  return board.columns.find((column) => column.id === located.task.swimlane_id) ?? null;
}
