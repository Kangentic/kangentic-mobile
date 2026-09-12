/**
 * connectionManager's Android background keepalive, and the hard ceiling on it.
 *
 * Backgrounding with backgroundNotificationsMode 'foreground-service' keeps the
 * relay socket and Noise session alive under a notifee dataSync foreground
 * service. Android 15+ gives that service a 6h/24h budget and kills the process
 * when it overruns, and notifee 9.1.8 exposes no Service.onTimeout hook to catch
 * the signal - so an app-side ceiling is the only bound that exists in this
 * stack. Unbounded, the service also kept the Java heap growing until it hit its
 * 256MB limit and the app froze in GC thrash on resume.
 *
 * That counter resets whenever the app is foregrounded, and every keepalive
 * window is preceded by a foreground visit, so overrunning needs ONE unbroken
 * ~6h background stretch in which the service never stopped - not many short
 * ones adding up. Which is why the ceiling is enforced twice here: the timer,
 * and a wall-clock check driven by a desktop rekey. Note what the fake-timer
 * tests below CANNOT cover: whether the real Android timer fires at all. RN
 * services setTimeout from a Choreographer frame callback, and a fake clock
 * always fires. Only the rekey test keeps the timer inert on purpose.
 *
 * The harness is lifted from connectionManagerBootstrapRetry.test.ts, which
 * already reaches a REAL established session (real SessionManager KK handshake
 * over the loopback transport) with Platform.OS 'android'. That file forces
 * backgroundNotificationsMode to 'off' in every beforeEach, which is why it only
 * ever exercises the closeConnection() branch - this file takes the other one.
 *
 * The ceiling is asserted as a LITERAL here, deliberately not imported from
 * connectionManager. Importing the constant would make the test track whatever
 * the constant says, so raising the ceiling back to hours would keep it green -
 * which is precisely the regression this file exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, type AppStateStatus } from 'react-native';
import type { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import type { LoopbackTransport } from '@/devsupport/loopbackTransport';
import { useSettingsStore } from '@/state/settingsStore';
import { useChannelStore } from '@/state/channelStore';
// Safe to import statically: permissionCache has no imports at all, which is
// the whole point of it being separate from channels.ts.
import { notificationPermissionGranted, setNotificationPermissionStatus } from '@/notifications/permissionCache';
import { flushMicrotasks, waitUntil } from '../helpers/async';

/** Must match BACKGROUND_KEEPALIVE_MAX_MS. Held separately on purpose - see the file header. */
const EXPECTED_KEEPALIVE_CEILING_MS = 5 * 60_000;

/**
 * A promise this file resolves by hand, for pinning the notification-permission
 * in-flight guard: the guard only matters in the window where the first
 * requestPermission() call has not settled yet, and vitest's normal awaits give
 * no way to hold a call open on demand.
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

// With the mode off 'off', onEstablished fires its push-registration import.
// Unmocked, that pulls expo-notifications' native module into this node run.
const pushRegistrationMocks = vi.hoisted(() => ({
  registerPushWithDesktop: vi.fn(async () => undefined),
  unregisterPushWithDesktop: vi.fn(async () => undefined),
  resetPushRegistrationProcessState: vi.fn(),
}));
vi.mock('@/notifications/pushRegistration', () => pushRegistrationMocks);

// The union of the notifee surface the keepalive path touches:
// foregroundService.ts (displayNotification / stopForegroundService), its
// channels.ts import (createChannels, AndroidImportance, AuthorizationStatus at
// module scope) and localNotifier.ts (displayNotification).
const notifeeMocks = vi.hoisted(() => ({
  displayNotification: vi.fn(async () => 'notification-id'),
  registerForegroundService: vi.fn(),
  stopForegroundService: vi.fn(async () => undefined),
  createChannels: vi.fn(async () => undefined),
  requestPermission: vi.fn(async () => ({ authorizationStatus: 1 })),
  getNotificationSettings: vi.fn(async () => ({ authorizationStatus: 1 })),
  openNotificationSettings: vi.fn(async () => undefined),
}));
vi.mock('@notifee/react-native', () => ({
  default: notifeeMocks,
  AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

const mockDesktopSeam = vi.hoisted(() => ({ stub: null as unknown, phoneTransport: null as unknown }));

vi.mock('@/connection/mockDesktop', async () => {
  const { createLoopbackPair } = await import('@/devsupport/loopbackTransport');
  const { StubSessionInitiator: RealStubSessionInitiator } = await import('@/devsupport/stubDesktopPeer');
  const { generateX25519KeyPair } = await import('@kangentic/protocol');
  return {
    createMockDesktop: () => {
      const [phoneTransport, desktopTransport] = createLoopbackPair();
      const identity = generateX25519KeyPair();
      const desktopStatic = generateX25519KeyPair();
      const stub = new RealStubSessionInitiator(desktopTransport, {
        desktopStatic,
        phoneStaticPublicKey: identity.publicKey,
      });
      mockDesktopSeam.stub = stub;
      mockDesktopSeam.phoneTransport = phoneTransport;
      return {
        identity,
        desktopStaticPublicKey: desktopStatic.publicKey,
        phoneTransport,
        async start(): Promise<void> {
          await desktopTransport.connect();
          stub.beginHandshake();
        },
        dispose(): void {
          stub.dispose();
          desktopTransport.close();
        },
      };
    },
  };
});

/**
 * Mutable so the iOS cases can flip it. connectionManager reads Platform.OS
 * inside the functions under test, never at module scope, so reassigning the
 * field between tests is enough - no module re-import needed.
 */
const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

// The handled-error door: its real module imports @sentry/react-native, whose
// wrapper reads NativeModules.RNSentry at import time - absent from the
// minimal react-native stub below - so it is stubbed inert here.
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: vi.fn() }));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: platformMock,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

/**
 * Establishes a real session and returns the AppState handler the lifecycle
 * just registered. The react-native mock never clears between tests, so
 * addEventListener's calls accumulate - .at(-1) is THIS test's handler.
 *
 * All of this runs on REAL timers, deliberately before any vi.useFakeTimers():
 * the handshake's await chain resolves the ordinary way rather than fighting a
 * fake clock it was never meant to interact with.
 *
 * It also PRE-WARMS the two modules startBackgroundKeepalive reaches through
 * dynamic import. This is load-bearing, and the reason is the same fact that
 * makes the ceiling testable at all: the ceiling timer is armed synchronously
 * inside startBackgroundKeepalive, so the background transition has to happen
 * with the fake clock already engaged or the timer is a real one the fake clock
 * will never fire. Backgrounding under fake timers in turn means the dynamic
 * imports have to be pure microtask work by then - a fake clock cannot drive
 * vite-node's module loading. Warming them here buys exactly that.
 */
async function establishAndWarm(): Promise<(status: AppStateStatus) => void> {
  const { startConnectionLifecycle } = await import('@/connection/connectionManager');
  startConnectionLifecycle();
  await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });

  await import('@/notifications/foregroundService');
  await import('@/notifications/localNotifier');

  const onAppStateChange = vi.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
  if (!onAppStateChange) throw new Error('expected an AppState change handler to be registered');
  return onAppStateChange;
}

describe('connectionManager background keepalive ceiling', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    // hasRequestedNotificationPermission is set explicitly, not left to the
    // store default: establishAndWarm() fires maybeRequestNotificationPermission
    // as a side effect, which flips this flag partway through the first test and
    // leaves it set for the rest of the file. That made the denied-permission
    // test below depend on declaration order rather than on its own setup, since
    // "denied" means asked AND refused.
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    mockDesktopSeam.phoneTransport = null;
    // Module-level state: without this reset the denied-permission test below
    // would leak into whatever runs after it.
    setNotificationPermissionStatus('granted');
    notifeeMocks.displayNotification.mockClear();
    notifeeMocks.stopForegroundService.mockClear();
    // Restores the resolving implementation, not just the call history: the
    // reassert-retry test below installs a rejecting one, and without this a
    // failure partway through that test would leak a rejecting stop into
    // every later test in this file (and the two describes after it).
    notifeeMocks.stopForegroundService.mockResolvedValue(undefined);
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    // Also clears the ceiling timer - a survivor would fire into a later test.
    stopConnectionLifecycle();
    vi.useRealTimers();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({
      backgroundNotificationsMode: 'off',
      hasRequestedNotificationPermission: false,
      hydrated: false,
    });
    useChannelStore.getState().reset();
  });

  it('tears the channel down once the keepalive hits its ceiling', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity checkpoint: prove the foreground service actually posted
      // before any meaningful timer advance. Without it, a harness that quietly
      // took the closeConnection() branch instead would make the straddle below
      // pass for entirely the wrong reason.
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      // The off-by-one straddle pins the exact ceiling: a merely
      // shorter-than-forever bound would not survive both halves.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS - 1);
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.stopForegroundService).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(getActiveConnection()).toBeNull();
      // stopBackgroundKeepalive reaches the service through a dynamic import,
      // so the stop lands a microtask after the synchronous teardown above.
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    // The acceptance-criterion path, and now the default one for every user:
    // coming back after the ceiling has fired must reconnect, not sit dead.
    // The handshake needs real timers, hence outside the block above.
    onAppStateChange('active');
    await waitUntil(() => useChannelStore.getState().established, { label: 're-established after the ceiling' });
    expect(getActiveConnection()).not.toBeNull();
  });

  /**
   * The wall-clock half of the ceiling, and the reason MOBILE-3 outlived the
   * timer half on real devices.
   *
   * RN services every setTimeout from a Choreographer frame callback, so the
   * ceiling timer above is only ever as reliable as frame delivery to a
   * backgrounded phone. Both crash events show what that costs: the app went to
   * background, never came back, and the process was still alive 7h10m and
   * 14h14m later with the dataSync service still running.
   *
   * So this test fakes setTimeout and then NEVER ADVANCES IT. The ceiling timer
   * is armed and cannot fire. Only the wall clock moves, and the only thing that
   * gets JS running again is a desktop rekey - an inbound relay frame, which
   * reaches JS through the bridge's own queue rather than through Choreographer.
   *
   * Date.now is spied separately rather than letting the fake clock own it, the
   * same split localNotifier.test.ts uses and for the same reason: one clock
   * driving both would mean advancing past the ceiling also fires the very timer
   * this test has to keep inert, and the assertion would prove nothing.
   *
   * Dropping enforceKeepaliveCeiling() from the rekey listener makes this fail
   * with a live connection. The ceiling test above stays green either way, which
   * is why this one exists separately.
   */
  it('tears the keepalive down on a desktop rekey when the ceiling timer never fires', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const handshakeRoundsBefore = stub.establishedCount;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    // Only the timer functions. Date stays under the spy above, and nothing
    // else in this path needs a fake clock - the loopback transport the rekey
    // travels over is queueMicrotask-driven end to end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity: the service really is up, so there is something to retire.
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      // Wall clock past the ceiling; the armed timer is never advanced to it.
      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS);
      stub.beginHandshake();
      for (let round = 0; round < 20 && getActiveConnection() !== null; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      // The rekey landed, so the teardown below is the rekey's doing and not a
      // handshake that quietly failed and dropped the connection instead.
      expect(stub.establishedCount).toBeGreaterThan(handshakeRoundsBefore);
      expect(getActiveConnection()).toBeNull();
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  /**
   * The negative case neither wall-clock test above pins. Both jump Date.now()
   * straight to the ceiling before firing their wake source, so nothing proves
   * enforceKeepaliveCeiling's own guard
   * (`Date.now() - keepaliveStartedAtMs < BACKGROUND_KEEPALIVE_MAX_MS`) still
   * points the right way. Inverting it, or dropping it outright, would tear
   * down every backgrounded connection on the desktop's first rekey - about two
   * minutes in, well short of the five-minute ceiling - and every other test in
   * this file would stay green, since none of them ever rekeys this early.
   */
  it('does not tear the keepalive down on a desktop rekey well before the ceiling', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const handshakeRoundsBefore = stub.establishedCount;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    // Same split as the rekey test above: only the timer functions are faked,
    // Date stays under the spy, and the loopback transport the rekey travels
    // over is queueMicrotask-driven end to end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity checkpoint: the service really is up before the rekey below.
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      // Clearly short of the ceiling, unlike the two tests above.
      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS / 2);
      stub.beginHandshake();
      for (let round = 0; round < 20 && stub.establishedCount === handshakeRoundsBefore; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      // The loop above watches the DESKTOP stub's counter, which is the far
      // side of the loopback from onRekey's queueMicrotask(onKeepaliveWakeSource).
      // One more drain closes that gap so the negatives below cannot pass
      // merely because that microtask was still queued.
      await vi.advanceTimersByTimeAsync(0);

      // The rekey actually landed, so a still-alive connection below is not
      // merely because the wake source never fired.
      expect(stub.establishedCount).toBeGreaterThan(handshakeRoundsBefore);
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.stopForegroundService).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  /**
   * The rekey backstop above has a gap this one closes: it needs the desktop to
   * still be there. Close the laptop and no rekey ever arrives again, while the
   * phone's transport drops and retries on its own backoff forever with the
   * foreground service still up. That is the most likely real shape of MOBILE-3
   * - an overnight stretch with nothing left driving the ceiling but the timer
   * that demonstrably did not fire.
   *
   * simulateReconnect is deliberately the blip path ('reconnecting' then back to
   * 'connected', never through 'closed'), which loopbackTransport's own comment
   * calls out as the one code watching only for 'closed' treats as if nothing
   * happened. Any state change counts as a wake source, so even a blip that
   * recovers gives the wall-clock check its chance.
   *
   * Same fake-timer split as above: setTimeout is faked and never advanced, so
   * the ceiling timer is armed and inert, and only Date.now moves. Dropping the
   * queueMicrotask(onKeepaliveWakeSource) from the transport listener makes this
   * fail with a live connection.
   */
  it('tears the keepalive down on a transport blip when the ceiling timer never fires', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS);
      phoneTransport.simulateReconnect();
      for (let round = 0; round < 20 && getActiveConnection() !== null; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(getActiveConnection()).toBeNull();
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  /**
   * The ceiling timer is armed on background and must not survive a foreground.
   * Left live, it would tear down a connection the user is actively looking at
   * - a worse bug than the one the ceiling fixes.
   *
   * Deliberately a BEHAVIOURAL assertion, not a mechanism one. Two independent
   * things stop the stale fire (stopBackgroundKeepalive's clearTimeout, and the
   * captured-generation check inside the handler), and removing either alone
   * leaves this green - verified by mutating each. That is defence in depth
   * working as intended, not a hole in the test; removing BOTH does fail it,
   * which is what makes it non-vacuous. Do not read a pass here as proof that
   * the clearTimeout specifically is still present.
   */
  it('does not tear down a foregrounded connection with a stale ceiling timer', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS / 2);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveConnection()).not.toBeNull();

      // Well past where the armed timer would have fired.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS);
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * closeConnection() does not own the keepalive (see reconnectNow's own
   * comment), so reconnectNow() has to stop it explicitly rather than relying
   * on a prior AppState 'active' transition to have already done so. Left
   * armed, a ceiling timer from an earlier background would still hold the
   * SAME keepalive generation and fire later against whatever connection is
   * active by then - tearing down the fresh session reconnectNow just opened,
   * not the backgrounded one the timer was meant for.
   *
   * The discriminating assertion is the one right after reconnectNow(), not
   * the survival one: dropping the stopBackgroundKeepalive() call from
   * reconnectNow leaves the original timer's generation untouched, so it
   * still fires on schedule and calls stopForegroundService from INSIDE the
   * ceiling handler instead - just five minutes later than this test expects.
   */
  it('stops the keepalive when reconnectNow is called, so a stale ceiling timer cannot fire later', async () => {
    const { reconnectNow } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);

      // Partway through the ceiling, well short of either edge.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS / 2);

      reconnectNow();
      // stopBackgroundKeepalive's own service-stop reaches notifee through a
      // dynamic import, landing a microtask after the synchronous call.
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalledTimes(1);

      // Past where the ORIGINAL ceiling timer would have fired had
      // reconnectNow left it armed. A second stop call here means it did.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS);
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * With POST_NOTIFICATIONS denied the local notifier can display nothing, so a
   * foreground service would spend the dataSync budget and the Java heap to
   * deliver exactly nothing. This is the state the crash reports were all
   * captured in: POST_NOTIFICATIONS not_granted, FOREGROUND_SERVICE_DATA_SYNC
   * granted, and the service demonstrably running.
   */
  it('does not start the keepalive when the notification permission is denied', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    setNotificationPermissionStatus('denied');
    onAppStateChange('background');

    expect(notifeeMocks.displayNotification).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });

  /**
   * The mirror of the test above, and the reason the gate consults the persisted
   * flag instead of the cache alone.
   *
   * Android has no NOT_DETERMINED authorization status - notifee reports plain
   * DENIED - and initializeNotifications seeds the cache at boot, so an install
   * that has never been ASKED caches exactly the same `false` as one that
   * refused. Gating on the cache alone therefore withdrew the keepalive from
   * every install that had not answered the prompt yet, which is all of them
   * until the prompt fires, and all of them forever if it never does.
   */
  it('still starts the keepalive when the permission was never asked for', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    setNotificationPermissionStatus('denied');
    useSettingsStore.setState({ hasRequestedNotificationPermission: false });
    onAppStateChange('background');
    // The service posts through a (pre-warmed) dynamic import, so it lands a
    // microtask after the synchronous gate decision.
    await flushMicrotasks();

    expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
    expect(getActiveConnection()).not.toBeNull();
  });

  /**
   * startConnectionLifecycle runs before hydrate() resolves, so an early
   * background reads the in-memory 'foreground-service' default rather than the
   * persisted value - and would start a service a 'push-only' user turned off.
   */
  it('does not start the keepalive before settings have hydrated', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    useSettingsStore.setState({ hydrated: false });
    onAppStateChange('background');

    expect(notifeeMocks.displayNotification).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });

  /**
   * The AppState 'active' handler refreshes the cached permission from the
   * OS (Android only), which is how a permission revoked from system
   * settings while the app was backgrounded becomes visible to the
   * background-keepalive gate again. Without it, a user who revoked
   * POST_NOTIFICATIONS while away would background right back into a
   * foreground service that can display nothing.
   */
  it('refreshes the permission cache on foreground and withholds the keepalive once it reads back denied', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    // The cache holds true from beforeEach; only a real refresh on 'active'
    // can flip it, since backgrounding alone reads whatever is already cached.
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });
    onAppStateChange('active');
    await waitUntil(() => notificationPermissionGranted() === false, {
      label: 'permission cache refreshed to denied',
    });

    onAppStateChange('background');

    expect(notifeeMocks.displayNotification).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });

  /**
   * The connectionManager side of the reassert wiring, not foregroundService's
   * own retry loop (that half is pinned in isolation by foregroundService.test.ts's
   * "retries a rejected stop" case). Every test above keeps stopForegroundService
   * resolving, so onAppStateChange's reassertForegroundServiceState() call - the
   * one that dynamic-imports reassertConnectedForegroundService() - is always a
   * silent no-op here. A broken import path or a dropped call would go unnoticed.
   */
  it('retries a stop that failed every attempt through the real reassert wiring on the next AppState transition', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    onAppStateChange('background');
    await waitUntil(() => notifeeMocks.displayNotification.mock.calls.length === 1, {
      label: 'foreground service posted',
    });
    // Non-vacuity checkpoint: the service really is up before the stop below.
    expect(getActiveConnection()).not.toBeNull();

    notifeeMocks.stopForegroundService.mockRejectedValue(new Error('native stop failed'));
    onAppStateChange('active');
    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 3, {
      label: 'all three stop attempts exhausted',
    });

    notifeeMocks.stopForegroundService.mockResolvedValue(undefined);
    // A SECOND 'active' transition is what has to carry the retry: nothing
    // else in this test declares a new desired state, so a 4th call can only
    // come from reassertForegroundServiceState -> reassertConnectedForegroundService.
    onAppStateChange('active');

    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 4, {
      label: 'stop retried through reassertForegroundServiceState',
    });
  });

  /**
   * onKeepaliveWakeSource's OTHER half, exercised through a wake source that is
   * not AppState. The test above only pins onAppStateChange's own
   * reassertForegroundServiceState() call; the rekey and transport-blip ceiling
   * tests above only exercise enforceKeepaliveCeiling(). Nothing in this file
   * previously proved that a rekey ALSO retries a stop the reconciler still
   * owes, and deleting `reassertForegroundServiceState();` from
   * onKeepaliveWakeSource breaks none of those tests.
   *
   * Deliberately mirrors the AppState test above almost line for line, with
   * exactly one difference: the retry's wake source is a rekey on the SAME
   * still-established connection (stub.beginHandshake()), not a second
   * onAppStateChange('active') call. The connection is never closed or
   * reopened here - 'active' only stops the keepalive, it does not tear down
   * the session - so the stub captured after establishment stays valid and
   * nothing here has to route back through closeConnection()/openConnection(),
   * which would introduce transport-state churn of its own. Deleting
   * `reassertForegroundServiceState();` from onKeepaliveWakeSource makes this
   * time out waiting for a 4th call instead of reaching it; the AppState test
   * above stays green either way, since it drives the retry through a
   * different call site entirely.
   */
  it('retries a stop that failed every attempt through a rekey wake source, not just AppState', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;

    onAppStateChange('background');
    await waitUntil(() => notifeeMocks.displayNotification.mock.calls.length === 1, {
      label: 'foreground service posted',
    });
    // Non-vacuity checkpoint: the service really is up before the stop below.
    expect(getActiveConnection()).not.toBeNull();

    notifeeMocks.stopForegroundService.mockRejectedValue(new Error('native stop failed'));
    onAppStateChange('active');
    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 3, {
      label: 'all three stop attempts exhausted',
    });

    notifeeMocks.stopForegroundService.mockResolvedValue(undefined);
    const establishedCountBefore = stub.establishedCount;
    // No AppState transition anywhere from here on: a 4th call can only come
    // from onKeepaliveWakeSource's own reassertForegroundServiceState(),
    // reached through the rekey listener on the still-live session.
    stub.beginHandshake();
    await waitUntil(() => stub.establishedCount > establishedCountBefore, { label: 'rekey landed' });

    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 4, {
      label: 'stop retried through the rekey wake source',
    });
  });
});

/**
 * POST_NOTIFICATIONS had no production caller at all before this: the request
 * function was written, exported and unit-tested, but nothing in the app ever
 * invoked it, so every install ran with notifications undeliverable - local
 * alerts and remote push alike. The crash reports bear that out, showing
 * POST_NOTIFICATIONS not_granted on a device paired for over ten days.
 */
describe('connectionManager notification permission prompt', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: false,
      hydrated: true,
    });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    mockDesktopSeam.phoneTransport = null;
    platformMock.OS = 'android';
    setNotificationPermissionStatus('granted');
    notifeeMocks.requestPermission.mockClear();
    notifeeMocks.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.useRealTimers();
    platformMock.OS = 'android';
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({ backgroundNotificationsMode: 'off', hasRequestedNotificationPermission: false, hydrated: false });
    useChannelStore.getState().reset();
  });

  it('asks once on the first establishment and not again on a re-establish', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, { label: 'permission requested' });
    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);

    // onEstablished re-fires on every reconnect. Without the persisted flag
    // this would re-prompt roughly every time the channel came back.
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The race this guard exists for: the open system dialog pauses the
   * activity, Android reports a background transition, the channel closes
   * and reconnects on answering the dialog, and that second onEstablished
   * can land before markNotificationPermissionRequested() has finished
   * persisting the first answer. Only notificationPermissionPromptInFlight
   * stops a second requestPermission() call in that window - the persisted
   * flag alone cannot, because it has not been written yet.
   */
  it('does not call requestPermission a second time while the first call is still pending', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');

    const firstPermissionRequest = createDeferred<{ authorizationStatus: number }>();
    notifeeMocks.requestPermission.mockImplementation(() => firstPermissionRequest.promise);

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.requestPermission.mock.calls.length === 1, {
      label: 'first permission request issued',
    });
    // Still pending: the persisted flag cannot be what suppresses a second
    // call below, because it has not been written yet.
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);

    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });

    // The second onEstablished fired while the first request was still
    // pending; only the in-flight guard can have stopped a second call here.
    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);

    firstPermissionRequest.resolve({ authorizationStatus: 1 });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, {
      label: 'permission requested',
    });
    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The iOS shape of the same in-flight race, and a different window than the
   * Android test above: on iOS with `alreadyAsked` true, the guard has to hold
   * across the FIRST await (`refreshNotificationPermission()`), before
   * `requestPermission()` is ever reached - not merely around requestPermission
   * itself. `notificationPermissionPromptInFlight` is set synchronously before
   * that await, so a second onEstablished landing while the refresh is still
   * pending must not start its own refresh/request sequence.
   *
   * The second half matters just as much: the `.finally()` has to reset the
   * flag once the first sequence settles, so a LATER establishment (not the
   * racing one) can still prompt. A guard that never resets would silently
   * stop asking forever after the first race.
   */
  it('does not start a second iOS prompt sequence while refreshNotificationPermission is still pending, and resets the guard afterwards', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    setNotificationPermissionStatus('granted');

    const firstRefresh = createDeferred<{ authorizationStatus: number }>();
    notifeeMocks.getNotificationSettings.mockImplementation(() => firstRefresh.promise);

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length === 1, {
      label: 'first refresh issued',
    });

    // The second onEstablished lands while the first refresh is still
    // pending - before requestPermission() was ever reached.
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });

    // Still only the one refresh call, and requestPermission never reached:
    // the second establishment did not start its own prompt sequence.
    expect(notifeeMocks.getNotificationSettings).toHaveBeenCalledTimes(1);
    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();

    // Resolve as "still granted", which returns early without ever calling
    // requestPermission - and, via .finally(), resets the in-flight guard.
    firstRefresh.resolve({ authorizationStatus: 1 });
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
    // Let the whole .then()/.catch()/.finally() chain settle before driving a
    // third establishment - otherwise the real handshake can re-establish
    // faster than that chain unwinds, and the third call would race the
    // .finally() reset rather than genuinely test it.
    await flushMicrotasks();

    // A THIRD establishment only starts a fresh refresh call if the guard was
    // actually reset; stuck at true, this would time out instead.
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 3, { label: 're-established again' });
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length === 2, {
      label: 'guard reset, second refresh issued',
    });

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
  });

  /**
   * "A prompt that never appeared is worse than one offered again": a
   * rejected requestPermission() must leave hasRequestedNotificationPermission
   * unset, so the next establishment retries instead of the app silently
   * never asking again.
   */
  it('leaves the flag unset when the request rejects, and asks again on the next establishment', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');

    notifeeMocks.requestPermission.mockRejectedValueOnce(new Error('permission request failed'));

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.requestPermission.mock.calls.length === 1, {
      label: 'permission request issued',
    });
    // Let the rejection's .catch()/.finally() run before reading the flag.
    await flushMicrotasks();
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);

    notifeeMocks.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, {
      label: 'permission requested',
    });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(2);
  });

  it('does not ask when notifications are switched off entirely', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1, { label: 'bootstrap ran' });
    await flushMicrotasks();

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);
  });

  /**
   * startConnectionLifecycle runs before hydrate() resolves, so an
   * establishment can beat it. Prompting off the pre-hydration default would
   * ask again someone who answered weeks ago.
   */
  it('does not ask before settings have hydrated', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    useSettingsStore.setState({ hydrated: false });

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1, { label: 'bootstrap ran' });
    await flushMicrotasks();

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
  });

  /**
   * The TestFlight bug. This function opened with `if (Platform.OS !== 'android')
   * return`, so iOS was never asked for authorization - and the failure was
   * invisible, because registration still succeeded:
   * getDevicePushTokenAsync only calls registerForRemoteNotifications(), which
   * yields an APNs token with no authorization behind it. The phone got a token,
   * the desktop sent, APNs delivered, and iOS discarded every alert.
   */
  it('asks on iOS too', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    setNotificationPermissionStatus('not-determined');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, { label: 'permission requested' });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * iOS Keychain items survive app deletion, so the persisted "we already asked"
   * flag can outlive the authorization it describes: reinstall, and the flag is
   * still true while iOS has reset authorization to NOT_DETERMINED. A flag-only
   * gate would leave that install never asked AND told in Settings that
   * notifications are blocked. When the OS says nobody has been asked, the OS wins.
   *
   * THE CACHE IS SEEDED STALE HERE ON PURPOSE. That is the production shape:
   * initializeNotifications refreshes the cache fire-and-forget at bundle entry
   * and nothing orders that against establishment, so whatever this reads
   * synchronously may not reflect the OS yet. Reading the cache instead of the
   * OS is the bug this pins - with a stale 'granted' in hand, a cache-based gate
   * decides "not not-determined" and never prompts the very device that needs it.
   */
  it('asks again on iOS when the OS reports not-determined, even against a stale cache', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    setNotificationPermissionStatus('granted');
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: -1 }); // NOT_DETERMINED

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.requestPermission.mock.calls.length === 1, { label: 'permission requested' });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The override above is scoped to not-determined, not to iOS generally: an iOS
   * user who was asked and refused must not be re-prompted on every establishment.
   */
  it('does not re-ask on iOS once the OS reports a real answer', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    setNotificationPermissionStatus('granted');
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 }); // DENIED

    startConnectionLifecycle();
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length >= 1, { label: 'permission re-read' });
    await flushMicrotasks();

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
  });
});

/**
 * onAppStateChange's 'active' branch used to wrap its refreshNotificationPermission
 * call in `if (Platform.OS === 'android')`. That gate is gone now, deliberately:
 * the Settings blocked-notice seeds itself from this cache on BOTH platforms, and
 * initializeNotifications already seeds the cache on both too, so leaving iOS out
 * meant a permission revoked from system settings while the app was away went
 * unnoticed there, and Settings could keep showing a stale "granted" with no
 * explanation for the silence. The existing foreground-refresh test in the
 * keepalive describe above only ever runs with this file's default Platform.OS
 * ('android'), so the cross-platform half was never actually exercised.
 */
describe('connectionManager foreground permission refresh (cross-platform)', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    mockDesktopSeam.phoneTransport = null;
    setNotificationPermissionStatus('granted');
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    platformMock.OS = 'android';
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({ backgroundNotificationsMode: 'off', hasRequestedNotificationPermission: false, hydrated: false });
    useChannelStore.getState().reset();
  });

  it('refreshes the permission cache on an active transition on iOS, not just Android', async () => {
    platformMock.OS = 'ios';
    const onAppStateChange = await establishAndWarm();
    // Establishment itself fires a refresh on iOS (maybeRequestNotificationPermission's
    // alreadyAsked branch); let that settle before driving the transition under test,
    // so the assertion below can only be satisfied by the 'active' handler's own call.
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length >= 1, {
      label: 'establishment-time refresh settled',
    });

    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 }); // DENIED
    onAppStateChange('active');

    await waitUntil(() => notificationPermissionGranted() === false, {
      label: 'iOS permission cache refreshed to denied on an active transition',
    });
  });
});
