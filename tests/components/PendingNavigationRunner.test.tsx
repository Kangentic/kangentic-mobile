/**
 * The React half of navigation published from outside React.
 *
 * Callers that cannot safely touch expo-router (a notification tap handler at
 * bundle-entry scope, a desktop revocation in the connection lifecycle) publish
 * to a module-level slot; this component consumes it from inside the mounted
 * navigator and performs the call. That split exists because `router.push` and
 * `router.navigate` only ENQUEUE: the queue is drained by a React effect that
 * throws when no navigator has mounted yet, which crashed iOS on a cold-start
 * notification tap in 0.6.3 build 13.
 *
 * NOTE the crash itself cannot be reproduced at this tier. expo-router supplies
 * INITIAL_METRICS when NODE_ENV === 'test' (ExpoRoot.js), so the
 * SafeAreaProvider gate that opens the window on device does not exist here.
 * These cases therefore pin the INVARIANT - one publish performs exactly once,
 * and only from inside React - which is what makes the fix non-regressible.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { PendingNavigationRunner } from '@/navigation/PendingNavigationRunner';
import { consumePendingNavigation, publishPendingNavigation } from '@/navigation/pendingNavigation';
import { routeFromPushResponse } from '@/notifications/tapRouter';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockRouterPush = jest.fn();
const mockRouterNavigate = jest.fn();
const mockRouterDismissAll = jest.fn();
const mockRouterCanDismiss = jest.fn();
// Delegates rather than capturing: the factory is evaluated during import
// hoisting, before the consts above are initialised, so a direct reference
// binds undefined.
jest.mock('expo-router', () => ({
  router: {
    push: (href: unknown) => mockRouterPush(href),
    navigate: (href: unknown) => mockRouterNavigate(href),
    dismissAll: () => mockRouterDismissAll(),
    canDismiss: () => mockRouterCanDismiss(),
  },
}));

// tapRouter pulls these in at module scope; neither has a usable native side
// under jest, and neither is exercised here.
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { onForegroundEvent: jest.fn(), onBackgroundEvent: jest.fn() },
  EventType: { PRESS: 1 },
}));
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(null)),
}));

const mockDecryptPushBlob = jest.fn();
jest.mock('@/notifications/pushDecrypt', () => ({
  ...jest.requireActual('@/notifications/pushDecrypt'),
  decryptPushBlob: (blob: string) => mockDecryptPushBlob(blob),
}));

const DECRYPTED = {
  title: 'Agent needs your input',
  body: 'Ship the release',
  category: 'input-required',
  data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
};

const EXPECTED_PUSH = {
  pathname: '/task/[taskId]',
  params: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', mode: 'chat' },
};

/**
 * Publishes through the REAL tapRouter rather than writing the slot directly,
 * so the subscriber notification these cases depend on is the shipping one.
 * Platform independent: routeFromPushResponse is not behind the Platform gate
 * that registerNotificationTapHandlers is, which matters because jest runs this
 * file under both the ios and android projects.
 */
async function publishTap(identifier: string): Promise<void> {
  await routeFromPushResponse({
    notification: { request: { identifier, content: { data: { blob: 'sealed-blob' } } } },
  } as unknown as Parameters<typeof routeFromPushResponse>[0]);
}

/**
 * Publishes a second, newer intent from a `useLayoutEffect`, which React runs
 * before any passive effect in the same commit. Rendered as a sibling of
 * `PendingNavigationRunner` so this lands in the exact window between the
 * runner's render (which still closes over whatever was in the slot at render
 * time) and its `useEffect` flush (which reads the slot fresh via
 * `consumePendingNavigation()`).
 */
function PublishNewerIntentDuringLayout(): null {
  React.useLayoutEffect(() => {
    publishPendingNavigation({ kind: 'reset-to-root' });
  }, []);
  return null;
}

describe('PendingNavigationRunner', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterNavigate.mockClear();
    mockRouterDismissAll.mockClear();
    mockRouterCanDismiss.mockReset();
    mockRouterCanDismiss.mockReturnValue(false);
    mockDecryptPushBlob.mockReset();
    mockDecryptPushBlob.mockResolvedValue(DECRYPTED);
    // The slot is module state and vitest-style resetModules is not in play
    // here, so drain anything a previous case left behind.
    //
    // HAZARD for anyone adding a case: this drains the SLOT, but it does not
    // and cannot reset tapRouter's dedupe latch, which is separate module state
    // keyed on the notification identifier. Reuse an identifier across cases and
    // the publish is silently swallowed, which reads as a broken consumer rather
    // than a test-setup mistake. Give every case its own identifier.
    consumePendingNavigation();
  });

  /**
   * The cold-start shape: the tap was delivered and published while the bundle
   * was still evaluating, so the value is already waiting when React mounts.
   */
  it('performs a navigation published before it mounted, exactly once', async () => {
    await publishTap('cold-start-notification');

    render(<PendingNavigationRunner />);

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(EXPECTED_PUSH);
  });

  /**
   * The slot has to be CLEARED on consumption, not merely read. A plain
   * re-render cannot show this - the effect is keyed on the pending value and
   * its reference is stable, so it never re-fires - but a remount runs the
   * effect again against module state that outlives the component. Leaving the
   * value in place pushes the same task screen a second time, costing the user
   * an extra back press.
   */
  it('does not perform the same navigation again when it remounts', async () => {
    await publishTap('remount-notification');

    render(<PendingNavigationRunner />).unmount();
    render(<PendingNavigationRunner />);

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
  });

  /**
   * The warm shape, and a genuinely different path: the component is already
   * mounted with an empty slot, so routing depends on the publisher's notify
   * loop reaching useSyncExternalStore. A refactor that dropped the
   * notification would leave the cold-start case above still green.
   */
  it('performs a navigation published while it is already mounted', async () => {
    render(<PendingNavigationRunner />);

    expect(mockRouterPush).not.toHaveBeenCalled();

    await act(async () => {
      await publishTap('warm-notification');
    });

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(EXPECTED_PUSH);
  });

  /**
   * The second publisher: a desktop revocation resets to root. This used to
   * call router.navigate('/') directly from connectionManager, behind a
   * try/catch whose comment named the one case it could not handle.
   */
  it('resets to root for a reset-to-root intent, dismissing an open sheet first', () => {
    mockRouterCanDismiss.mockReturnValue(true);
    publishPendingNavigation({ kind: 'reset-to-root' });

    render(<PendingNavigationRunner />);

    expect(mockRouterDismissAll).toHaveBeenCalledTimes(1);
    expect(mockRouterNavigate).toHaveBeenCalledWith('/');
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('skips dismissAll when there is nothing to dismiss', () => {
    mockRouterCanDismiss.mockReturnValue(false);
    publishPendingNavigation({ kind: 'reset-to-root' });

    render(<PendingNavigationRunner />);

    expect(mockRouterDismissAll).not.toHaveBeenCalled();
    expect(mockRouterNavigate).toHaveBeenCalledWith('/');
  });

  /**
   * The lost-update regression. A newer intent published in the window
   * between this render's commit and the passive-effect flush must be what
   * gets performed, not the older intent this render closed over - the slot's
   * documented "a newer intent supersedes an older one" invariant. Fixed by
   * performing what `consumePendingNavigation()` RETURNS inside the effect,
   * never the render's closed-over `pending`; see the comment in
   * `usePendingNavigation`. The real case: a desktop revocation reset landing
   * just behind a notification tap must not be swallowed by the tap's stale
   * task screen.
   *
   * Publishes the superseded intent directly through `publishPendingNavigation`
   * rather than through `publishTap`, so this case is about the runner's
   * consume/perform ordering, not about tapRouter's own dedupe latch.
   */
  it('performs a newer reset-to-root published mid-commit, not the older open-task it superseded', () => {
    mockRouterCanDismiss.mockReturnValue(false);
    publishPendingNavigation({
      kind: 'open-task',
      taskId: 'superseded-task',
      projectId: 'superseded-project',
      sessionId: 'superseded-session',
    });

    render(
      <>
        <PendingNavigationRunner />
        <PublishNewerIntentDuringLayout />
      </>,
    );

    expect(mockRouterNavigate).toHaveBeenCalledWith('/');
    expect(mockRouterNavigate).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('navigates nowhere when nothing was ever published', () => {
    render(<PendingNavigationRunner />);

    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterNavigate).not.toHaveBeenCalled();
  });
});
