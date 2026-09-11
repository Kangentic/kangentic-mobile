/**
 * createSnapshotSinks's onDiffFetchFailed wiring: a refused diff fetch must
 * mark the diff store 'error' for the SCOPE the fetch was for, not whatever
 * scope the store currently holds - a scope switch mid-flight must not mark
 * the new scope failed.
 *
 * subscriptionManager.test.ts covers the CALLER (a hand-rolled sink that just
 * records its arguments) and ChangesTab.test.tsx covers the CONSUMER given
 * fileListStatus: 'error' already on the store. Neither exercises this
 * wiring - the one place SubscriptionManager's sink call actually reaches
 * useDiffStore - so a dropped handler, or one wired to the wrong store action
 * or the wrong scope, would leave every existing test green.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import { createSnapshotSinks } from '@/connection/storeFeed';
import { useDiffStore } from '@/state/diffStore';
import { diffFileListFixture } from '@/devsupport/desktopFixtures';

describe('createSnapshotSinks onDiffFetchFailed', () => {
  afterEach(() => {
    useDiffStore.getState().reset();
  });

  it('marks the scope the fetch was FOR as errored, not the scope the store currently holds', () => {
    const sinks = createSnapshotSinks(() => ({}) as SubscriptionManager);
    // Seed a DIFFERENT scope already on the store first. A wiring bug that
    // reads the store's current scope (the same fallback onDiffFileList
    // uses) instead of the argument the caller passed would still write
    // fileListStatus: 'error', so asserting scope too is what catches it.
    useDiffStore.getState().applyFileList('task-1', 'branch', diffFileListFixture());

    sinks.onDiffFetchFailed('task-1', 'working');

    const taskDiff = useDiffStore.getState().byTaskId['task-1'];
    expect(taskDiff?.fileListStatus).toBe('error');
    expect(taskDiff?.scope).toBe('working');
  });

  it('creates an entry for a task the store has never seen, so a fetch that fails on the first look still reports', () => {
    const sinks = createSnapshotSinks(() => ({}) as SubscriptionManager);
    expect(useDiffStore.getState().byTaskId['task-new']).toBeUndefined();

    sinks.onDiffFetchFailed('task-new', 'working');

    const taskDiff = useDiffStore.getState().byTaskId['task-new'];
    expect(taskDiff?.fileListStatus).toBe('error');
    expect(taskDiff?.scope).toBe('working');
  });
});
