import { useEffect, useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import {
  consumePendingNavigation,
  getPendingNavigation,
  subscribePendingNavigation,
  type PendingNavigation,
} from './pendingNavigation';

/**
 * Performs the navigation published to the pending slot, from INSIDE the
 * mounted navigator. See `pendingNavigation.ts` for why nothing outside React
 * may call the router directly.
 *
 * WHY THERE IS NO `navigationRef.isReady()` GUARD HERE. It would look like the
 * obvious safety check and it would break this: react-navigation registers the
 * focus listener that `isReady()` tests inside a PASSIVE effect
 * (useFocusedListenersChildrenAdapter), on the root navigator, which is an
 * ANCESTOR of the root layout. Passive effects run child-first, so at this
 * component's effect `isReady()` is still false on the very commit the
 * navigator mounts - a blocking guard here would defer with no retry signal and
 * silently drop the navigation.
 *
 * Calling the router here is nonetheless correct: expo-router's drain effect
 * lives further up the tree than this component, so it runs AFTER the
 * navigator's own effect in the same commit and re-checks readiness itself.
 * Correctness comes from tree position, not from a runtime predicate - which is
 * why this must stay a descendant of the navigation container, rendered after
 * the navigator itself.
 */

/**
 * The server snapshot is always empty, never the live slot: the slot is module
 * state, and under a static render that state is shared across requests.
 * Navigation published by a device event has no meaning on a server pass.
 */
function getServerPendingNavigation(): null {
  return null;
}

function performPendingNavigation(navigation: PendingNavigation): void {
  if (navigation.kind === 'reset-to-root') {
    // dismissAll enqueues a POP_TO_TOP, which the drain dispatches without the
    // readiness assertion; navigate is the call that would have thrown.
    if (router.canDismiss()) router.dismissAll();
    router.navigate('/');
    return;
  }
  router.push({
    pathname: '/task/[taskId]',
    params: {
      taskId: navigation.taskId,
      projectId: navigation.projectId,
      sessionId: navigation.sessionId,
      mode: 'chat',
    },
  });
}

export function usePendingNavigation(): void {
  const pending = useSyncExternalStore(
    subscribePendingNavigation,
    getPendingNavigation,
    getServerPendingNavigation,
  );

  useEffect(() => {
    if (!pending) return;
    // Cleared inside the effect, so the slot cannot be performed twice. This
    // costs one extra render with a null pending value, which no-ops. Do not
    // move the consume out of the effect to avoid it: that reintroduces the
    // double navigation.
    //
    // PERFORM WHAT CONSUME RETURNS, NEVER THE CLOSED-OVER `pending`. The two
    // differ whenever a newer intent is published between this render's commit
    // and the passive-effect flush: consume would clear the NEWER value while
    // this performed the older one, inverting the slot's "a newer intent
    // supersedes an older one" invariant. A revocation reset landing just
    // behind a notification tap is the real case - it would be swallowed, and
    // the user left on a task screen for a pairing that no longer exists.
    const consumed = consumePendingNavigation();
    if (!consumed) return;
    performPendingNavigation(consumed);
  }, [pending]);
}

/**
 * Rendered in `app/_layout.tsx` as a SIBLING of the root `Stack`, immediately
 * after it, so the hook above runs only once a navigator has mounted. Not a
 * child of `Stack` - its children are route declarations. Renders nothing.
 */
export function PendingNavigationRunner(): null {
  usePendingNavigation();
  return null;
}
