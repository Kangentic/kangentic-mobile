/**
 * Notification tap routing, and specifically the iOS half.
 *
 * The iOS Notification Service Extension rewrites a push's title and body
 * before the OS renders it, but deliberately never touches `userInfo`, so the
 * tapped notification still carries only the sealed blob. The router decrypts
 * it on tap - which is what keeps taskId out of the OS-visible payload, per
 * e2e-notification-privacy.md. The failure path matters as much as the happy
 * one: a blob that will not decrypt must route NOWHERE rather than guess,
 * leaving the user on Home.
 *
 * This module publishes a resolved target to the shared pending-navigation slot
 * and NEVER navigates; PendingNavigationRunner performs the navigation from
 * inside the mounted navigator. The assertions below are written against that
 * slot, and one of them pins the negative directly (see 'never navigates from
 * module scope'), because calling expo-router's imperative router from
 * bundle-entry scope is what crashed iOS on a cold-start tap in 0.6.3 build 13.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushMicrotasks } from '../helpers/async';

const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn(), canDismiss: vi.fn(), dismissAll: vi.fn() }));
const notifeeMock = vi.hoisted(() => ({ onForegroundEvent: vi.fn(), onBackgroundEvent: vi.fn() }));
const expoNotificationsMock = vi.hoisted(() => ({
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(async () => null as unknown),
}));
const decryptPushBlobMock = vi.hoisted(() => vi.fn<(blob: string) => Promise<unknown>>());

// pushDecrypt reaches expo-secure-store for the push key, and importActual
// below pulls that in for real; unmocked it drags expo-modules-core into this
// node run and dies on a missing __DEV__.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('react-native', () => ({ Platform: platformMock }));
// tapRouter must NOT import expo-router any more. The mock stays so the
// 'never navigates from module scope' case can prove that as a negative
// rather than merely asserting the slot was written.
vi.mock('expo-router', () => ({ router: routerMock }));
vi.mock('@notifee/react-native', () => ({
  default: notifeeMock,
  EventType: { PRESS: 1 },
}));
vi.mock('expo-notifications', () => expoNotificationsMock);
vi.mock('@/notifications/pushDecrypt', async () => {
  const actual = await vi.importActual<typeof import('@/notifications/pushDecrypt')>('@/notifications/pushDecrypt');
  return { ...actual, decryptPushBlob: decryptPushBlobMock };
});

type TapRouterModule = typeof import('@/notifications/tapRouter');
type PendingNavigationModule = typeof import('@/navigation/pendingNavigation');
type PendingNavigation = NonNullable<ReturnType<PendingNavigationModule['getPendingNavigation']>>;

/**
 * Both modules are loaded together and AFTER `vi.resetModules()`, so they share
 * one fresh module registry - tapRouter's own import of the slot resolves to
 * the same instance this returns. Loading them in separate turns would hand the
 * test a different slot than the one under test.
 */
async function loadModules(): Promise<{
  tapRouter: TapRouterModule;
  pendingNavigation: PendingNavigationModule;
}> {
  const tapRouter = await import('@/notifications/tapRouter');
  const pendingNavigation = await import('@/navigation/pendingNavigation');
  return { tapRouter, pendingNavigation };
}

/**
 * Every published navigation, in order. The slot holds only the latest value,
 * so counting publishes needs the subscription rather than a read - which is
 * also the mechanism the React consumer depends on, so a broken notify loop
 * fails here rather than only on device.
 */
function recordPublished(pendingNavigation: PendingNavigationModule): PendingNavigation[] {
  const published: PendingNavigation[] = [];
  pendingNavigation.subscribePendingNavigation(() => {
    const pending = pendingNavigation.getPendingNavigation();
    if (pending) published.push(pending);
  });
  return published;
}

/**
 * `identifier` is optional because most cases here do not care about it. The
 * de-duplication guard only engages on a non-empty string, so omitting it keeps
 * every single-tap case routing exactly as it reads.
 */
function pushResponse(data: unknown, identifier?: string): Parameters<TapRouterModule['routeFromPushResponse']>[0] {
  return { notification: { request: { identifier, content: { data } } } } as Parameters<
    TapRouterModule['routeFromPushResponse']
  >[0];
}

const DECRYPTED = {
  title: 'Agent needs your input',
  body: 'Ship the release',
  category: 'input-required',
  data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
};

const DECRYPTED_TARGET = {
  kind: 'open-task',
  taskId: 'task-1',
  projectId: 'project-1',
  sessionId: 'sess-1',
};

describe('tapRouter - iOS push responses', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'ios';
    routerMock.push.mockClear();
    routerMock.navigate.mockClear();
    notifeeMock.onForegroundEvent.mockClear();
    notifeeMock.onBackgroundEvent.mockClear();
    expoNotificationsMock.addNotificationResponseReceivedListener.mockClear();
    expoNotificationsMock.getLastNotificationResponseAsync.mockClear();
    expoNotificationsMock.getLastNotificationResponseAsync.mockResolvedValue(null);
    decryptPushBlobMock.mockReset();
    decryptPushBlobMock.mockResolvedValue(DECRYPTED);
  });

  it('decrypts the tapped blob and publishes the task open in chat mode', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(published).toEqual([DECRYPTED_TARGET]);
    expect(pendingNavigation.getPendingNavigation()).toEqual(DECRYPTED_TARGET);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. `router.push` does not navigate, it
   * appends to expo-router's routing queue; the queue is drained by a React
   * effect that throws 'Attempted to navigate before mounting the Root Layout
   * component' when no navigator has mounted. On a native cold start that
   * window is real, the effect sits above every error boundary, and the throw
   * aborts the process - which is the 0.6.3 build 13 TestFlight crash. A
   * try/catch cannot help, because push itself never throws.
   *
   * So the invariant is structural: nothing in this module may navigate.
   */
  it('never navigates from module scope, publishing a pending open instead', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(pendingNavigation.getPendingNavigation()).toEqual(DECRYPTED_TARGET);
  });

  /**
   * The snapshot feeds useSyncExternalStore, which re-renders forever if the
   * getter allocates. Identity, not deep equality, is the assertion.
   */
  it('returns a stable snapshot reference between publishes', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(pendingNavigation.getPendingNavigation()).toBe(pendingNavigation.getPendingNavigation());
  });

  it('clears the slot when consumed, so one tap cannot route twice', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(pendingNavigation.consumePendingNavigation()).toEqual(DECRYPTED_TARGET);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
    expect(pendingNavigation.consumePendingNavigation()).toBeNull();
  });

  /** Expo wraps the data payload as a JSON string on some delivery paths. */
  it('reads the blob out of the JSON-wrapped payload shape too', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ body: JSON.stringify({ blob: 'wrapped-blob' }) }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('wrapped-blob');
    expect(published).toHaveLength(1);
  });

  it('routes nowhere when the blob cannot be decrypted', async () => {
    decryptPushBlobMock.mockResolvedValue(null);
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'tampered-blob' }));

    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  it('routes nowhere when the payload carries no blob at all', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ someOtherKey: 'value' }));

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('routes nowhere for a null response (no cold-start tap)', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(null);

    expect(published).toHaveLength(0);
  });

  /**
   * The cold-start read and the warm listener are two independent deliveries of
   * the SAME tap, and expo-notifications can surface one tap through both (its
   * own useLastNotificationResponse de-duplicates by request identifier for
   * exactly this reason). Routing both would push the task screen twice, so the
   * user needs two back presses to leave it.
   */
  it('routes one tap once when both deliveries carry the same notification identifier', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));

    expect(published).toHaveLength(1);
    expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of the guard: de-duplication must not swallow a genuinely
   * different tap, which is the failure mode that would silently break routing.
   */
  it('still routes a second tap carrying a different notification identifier', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-2'));

    expect(published).toHaveLength(2);
  });

  /**
   * The de-dup guard is deliberately keyed on `typeof identifier === 'string'
   * && identifier.length > 0`, not on blind equality against the last-routed
   * value. A payload that carries no identifier at all must still route EVERY
   * time - dropping a real tap is worse than a rare double - so two separate
   * taps that both omit an identifier are two separate routes, not a dedup
   * pair. Blind equality would compare `undefined === undefined` on the
   * second call and silently swallow it.
   */
  it('routes every tap that omits a notification identifier, never deduping them against each other', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(published).toHaveLength(2);
  });

  /**
   * A cold-start tap happened before any listener existed, so the warm listener
   * alone would drop it. Both paths have to be wired, and neither may reach for
   * notifee, whose events only ever fire for notifications notifee itself
   * displayed - which on iOS is none of them.
   */
  it('registers both the warm listener and the cold-start read, and no notifee handlers', async () => {
    const { tapRouter } = await loadModules();

    tapRouter.registerNotificationTapHandlers();

    expect(expoNotificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    expect(notifeeMock.onForegroundEvent).not.toHaveBeenCalled();
    expect(notifeeMock.onBackgroundEvent).not.toHaveBeenCalled();
  });

  /**
   * The test above only proves getLastNotificationResponseAsync was CALLED,
   * not that its resolution actually reaches routeFromPushResponse. A broken
   * `.then((response) => routeFromPushResponse(response))` - a dropped
   * argument, a typo - would leave every cold-start tap silently unrouted
   * while that assertion still passed.
   */
  it('routes a cold-start tap through the getLastNotificationResponseAsync resolution', async () => {
    expoNotificationsMock.getLastNotificationResponseAsync.mockResolvedValue(
      pushResponse({ blob: 'sealed-blob' }, 'cold-start-notification'),
    );
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    tapRouter.registerNotificationTapHandlers();
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(published[0]).toEqual(DECRYPTED_TARGET);
    // Even the cold-start path, the one that runs earliest of all, must not
    // reach the router itself.
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  /**
   * The other failure shape of the same wiring: no cold-start response at all
   * (a fresh install) resolves the module unavailable and getLastNotificationResponseAsync
   * rejects. The `.catch()` after the `.then()` has to swallow it - an
   * unswallowed rejection would surface as an unhandled rejection rather than
   * a quiet "nothing to route".
   */
  it('swallows a rejected cold-start read without throwing or routing', async () => {
    expoNotificationsMock.getLastNotificationResponseAsync.mockRejectedValue(new Error('module unavailable'));
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    expect(() => tapRouter.registerNotificationTapHandlers()).not.toThrow();
    // Give the rejected promise's .catch() a turn to run.
    await flushMicrotasks();

    expect(published).toHaveLength(0);
  });

  it('registers the notifee handlers on Android instead, and never the expo listener', async () => {
    platformMock.OS = 'android';
    const { tapRouter } = await loadModules();

    tapRouter.registerNotificationTapHandlers();

    expect(notifeeMock.onForegroundEvent).toHaveBeenCalledTimes(1);
    expect(notifeeMock.onBackgroundEvent).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
  });

  it('registers once however many times it is called', async () => {
    const { tapRouter } = await loadModules();

    tapRouter.registerNotificationTapHandlers();
    tapRouter.registerNotificationTapHandlers();

    expect(expoNotificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
  });
});

describe('tapRouter - Android notifee presses', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'android';
    routerMock.push.mockClear();
    routerMock.navigate.mockClear();
    notifeeMock.onForegroundEvent.mockClear();
    notifeeMock.onBackgroundEvent.mockClear();
    decryptPushBlobMock.mockReset();
  });

  /**
   * Android notifications are posted by notifee AFTER decryption, so the ids
   * are already on the notification and nothing is decrypted a second time.
   */
  it('opens the task straight from the notification data, without decrypting', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(published).toEqual([
      { kind: 'open-task', taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' },
    ]);
  });

  /**
   * Android reaches the same unmounted-navigator window on its second commit,
   * so the no-navigation invariant is not an iOS-only concern.
   */
  it('never navigates from the notifee press handler either', async () => {
    const { tapRouter } = await loadModules();
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('ignores a press carrying no taskId', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 1, detail: { notification: { data: {} } } });

    expect(published).toHaveLength(0);
  });

  it('ignores non-press events', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 0, detail: { notification: { data: { taskId: 'task-9' } } } });

    expect(published).toHaveLength(0);
  });
});
