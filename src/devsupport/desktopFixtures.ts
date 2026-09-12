/**
 * Canned typed payloads shared across channel/store tests and the in-app
 * mock desktop peer - shaped exactly like the desktop's wire mappers
 * produce them (fixtures are data, exempt from the no-redeclare rule).
 */
import type {
  BoardColumnWire,
  BoardTaskWire,
  DiffFileListWire,
  ReadBoardSnapshotResponsePayload,
  ReadStreamResponsePayload,
  SessionUsageWire,
  TranscriptEntryWire,
} from '@kangentic/protocol';

export function usageFixture(overrides: Partial<SessionUsageWire> = {}): SessionUsageWire {
  return {
    contextWindow: { usedPercentage: 12, usedTokens: 2400, cacheTokens: 800, totalInputTokens: 3200, totalOutputTokens: 500, contextWindowSize: 200000 },
    cost: { totalCostUsd: 0.42, totalDurationMs: 90000 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    ...overrides,
  };
}

export function streamSnapshotFixture(overrides: Partial<ReadStreamResponsePayload> = {}): ReadStreamResponsePayload {
  return {
    scrollback: 'initial scrollback',
    activity: { state: 'thinking', reason: { kind: 'turn-active' } },
    usage: usageFixture(),
    awaitedPromptId: null,
    ptyDimensions: { cols: 120, rows: 30 },
    ...overrides,
  };
}

export function boardColumnFixture(overrides: Partial<BoardColumnWire> = {}): BoardColumnWire {
  return {
    id: 'lane-todo',
    name: 'To Do',
    description: null,
    role: 'todo',
    position: 0,
    color: '#3fb950',
    icon: null,
    is_archived: false,
    is_ghost: false,
    ...overrides,
  };
}

export function boardTaskFixture(overrides: Partial<BoardTaskWire> = {}): BoardTaskWire {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'Fix the login bug',
    description: '',
    swimlane_id: 'lane-todo',
    position: 0,
    agent: 'claude',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    base_branch: 'main',
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

export function boardSnapshotFixture(overrides: Partial<ReadBoardSnapshotResponsePayload> = {}): ReadBoardSnapshotResponsePayload {
  return {
    projectId: 'project-1',
    columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
    tasks: [boardTaskFixture()],
    // No backlog: a 0.9.0 desktop only sends one to a phone that named no
    // `view`, which no current code path does.
    ...overrides,
  };
}

export function userEntryFixture(overrides: Partial<Extract<TranscriptEntryWire, { kind: 'user' }>> = {}): TranscriptEntryWire {
  return { kind: 'user', uuid: 'entry-user-1', ts: 1000, text: 'hello agent', ...overrides };
}

export function assistantEntryFixture(overrides: Partial<Extract<TranscriptEntryWire, { kind: 'assistant' }>> = {}): TranscriptEntryWire {
  return {
    kind: 'assistant',
    uuid: 'entry-assistant-1',
    ts: 2000,
    blocks: [{ type: 'text', text: 'working on it' }],
    ...overrides,
  };
}

export function diffFileListFixture(overrides: Partial<DiffFileListWire> = {}): DiffFileListWire {
  return {
    files: [
      { path: 'src/auth/login.ts', status: 'M', insertions: 12, deletions: 3, binary: false },
      { path: 'src/auth/new-flow.ts', status: 'A', insertions: 40, deletions: 0, binary: false },
    ],
    totalInsertions: 52,
    totalDeletions: 3,
    ...overrides,
  };
}
