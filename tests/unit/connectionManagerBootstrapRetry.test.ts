/**
 * connectionManager's bootstrap retry: on a failed runBootstrap, while the
 * session stays established, openConnection retries at 2s, 4s, 8s...
 * capped at 30s, guarded by a bootstrapGeneration counter so a stale retry
 * chain cannot fire after a fresh onEstablished superseded it. This exercises
 * the REAL openConnection/startConnectionLifecycle path - unlike
 * tests/unit/connectionManager.test.ts, whose own comment documents that it
 * deliberately never reaches this code (it only covers the two lazy-loaded
 * push-registration hooks with the module-level activeConnection staying
 * null throughout).
 *
 * Also covers connectionManager's OTHER wiring onto this same real
 * established session: controller.session.onRekey -> channelStore.noteRekey
 * (see the 'rekey wiring' describe block below). Reusing this file's
 * harness rather than a new one, since a real rekey needs the same real
 * SessionManager-over-loopback machinery this file already builds.
 *
 * Reaching a real established connection needs neither a relay nor a
 * SecureStore trust anchor: '@/connection/mockDesktop' is mocked here with a
 * minimal stand-in over the SAME real loopback transport + StubSessionInitiator
 * helpers tests/unit/subscriptionManager.test.ts uses, so the REAL
 * SessionManager (KK handshake, onEstablished) runs for real. Only
 * '@/connection/bootstrap' is mocked, since that is the failure this file
 * pins the retry behavior around.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from 'react-native';
import { SessionManager } from '@/channel';
import type { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { useSettingsStore } from '@/state/settingsStore';
import { useChannelStore } from '@/state/channelStore';
import { waitUntil } from '../helpers/async';

const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

// The open path lazy-imports pushRegistration (the desktop-key-change reset,
// and the fire-and-forget registration on establish). The REAL module's import
// chain reaches expo-constants, which throws outside a react-native runtime -
// and each test here opens with a fresh random anchor, so from the second test
// on the key-change branch fires. Stubbed inert; this file asserts nothing
// about push registration.
vi.mock('@/notifications/pushRegistration', () => ({
  registerPushWithDesktop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  unregisterPushWithDesktop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  resetPushRegistrationProcessState: vi.fn<() => void>(),
}));

// The seam the test uses to reach into the mock desktop's own stub
// initiator (to drive a SECOND handshake later) - vi.mock factories can
// only close over vi.hoisted state, never a plain outer-scope variable.
const mockDesktopSeam = vi.hoisted(() => ({ stub: null as unknown }));

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

// The handled-error door: its real module imports @sentry/react-native, whose
// wrapper reads NativeModules.RNSentry at import time - absent from the
// minimal react-native stub below - so it is stubbed inert here.
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: vi.fn() }));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
}));

// deviceIdentity.ts/trustAnchor.ts are statically imported by
// connectionManager.ts, but the mock-desktop path (exercised here) never
// calls either - identity and the anchor both come from mockDesktop
// instead. Still mocked so the module resolves with no native SecureStore.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

// waitUntil polls on REAL timers - every call below deliberately runs BEFORE
// vi.useFakeTimers() is engaged, so the handshake's own microtask/await chain
// (openConnection's several `await`s, the loopback transport's queued
// microtask delivery) resolves the ordinary way rather than fighting a fake
// clock it was never meant to interact with. See tests/helpers/async.ts.

describe('connectionManager bootstrap retry', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    // Skips the fire-and-forget push-registration import on establishment -
    // irrelevant to this file and, left at its 'foreground-service'
    // default, would pull in notifee's native module in this node run.
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });
    mockRunBootstrap.mockReset();
    mockDesktopSeam.stub = null;
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.useRealTimers();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useChannelStore.getState().reset();
  });

  it('retries a failed bootstrap at 2s/4s/8s/16s, capped at 30s, while the session stays established', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    const pendingRejectors: ((error: Error) => void)[] = [];
    mockRunBootstrap.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          pendingRejectors.push(reject);
        }),
    );

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1);
    // Checkpoint: if the handshake never actually established under this
    // harness, everything below would be vacuous - so this is asserted
    // before any timer advances, not folded into a later expectation.
    expect(mockRunBootstrap).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      async function rejectPendingAndAssertNextDelay(delayMs: number, callCountBeforeReject: number): Promise<void> {
        const reject = pendingRejectors.shift();
        if (!reject) throw new Error('no pending bootstrap attempt to reject');
        reject(new Error('bootstrap failed'));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(mockRunBootstrap).toHaveBeenCalledTimes(callCountBeforeReject);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockRunBootstrap).toHaveBeenCalledTimes(callCountBeforeReject + 1);
      }

      await rejectPendingAndAssertNextDelay(2000, 1);
      await rejectPendingAndAssertNextDelay(4000, 2);
      await rejectPendingAndAssertNextDelay(8000, 3);
      await rejectPendingAndAssertNextDelay(16000, 4);
      // attempt 4's own delay is min(30000, 2000 * 2^4) = min(30000, 32000):
      // the cap, not the doubled value - this is what tells a dropped
      // Math.min apart from a merely-slow-but-uncapped backoff.
      await rejectPendingAndAssertNextDelay(30000, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A retry scheduled under one bootstrapGeneration must never fire after a
   * FRESH onEstablished (not a teardown - session.reset() + a new handshake
   * keeps controller.session.isEstablished true throughout) has moved the
   * generation on. Isolated from the OTHER guard the same catch handler
   * checks (`!controller.session.isEstablished`): teardown would trip that
   * one too and mask a deleted generation check, so this test never tears
   * the connection down - only the generation counter can be what suppresses
   * the stale chain here.
   */
  it('a stale retry chain does not fire after a fresh re-establish moves the bootstrap generation on', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');
    let rejectFirstAttempt: ((error: Error) => void) | null = null;
    // A persistent never-resolving default UNDERNEATH the one-shot below:
    // if the guard this test pins were deleted, the stale chain would call
    // runBootstrap a 3rd time and land here rather than throwing on a
    // missing mock implementation, so the test's own assertion is what
    // fails, not an incidental TypeError from running out of queued mocks.
    mockRunBootstrap.mockImplementation(() => new Promise<void>(() => undefined));
    mockRunBootstrap.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstAttempt = reject;
        }),
    );

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1);
    expect(mockRunBootstrap).toHaveBeenCalledTimes(1);
    expect(rejectFirstAttempt).not.toBeNull();

    // A fresh re-establish BEFORE the first attempt is ever resolved: the
    // stale chain's own promise is still pending when this crosses the
    // generation boundary. The second attempt (from the fresh onEstablished)
    // falls to the never-resolving default set above - this test only cares
    // whether the STALE (first) chain retries, not this one.
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2);
    expect(mockRunBootstrap).toHaveBeenCalledTimes(2);
    // The session re-established (not torn down): isEstablished stays true,
    // so it cannot be what suppresses the stale chain below.
    expect(activeConnection.controller.session.isEstablished).toBe(true);

    vi.useFakeTimers();
    try {
      // Reject the STALE first attempt now that the generation has moved on.
      if (!rejectFirstAttempt) throw new Error('unreachable');
      (rejectFirstAttempt as (error: Error) => void)(new Error('stale attempt failed'));
      await vi.advanceTimersByTimeAsync(0);
      // Comfortably past even the 30s cap: if the stale chain's generation
      // check were deleted, its own retry would have fired well before this.
      await vi.advanceTimersByTimeAsync(35_000);

      expect(mockRunBootstrap).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('connectionManager teardown intent', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useChannelStore.getState().reset();
  });

  it('announces departure on an unpair-style reconnect and stays silent by default', async () => {
    const { startConnectionLifecycle, reconnectNow } = await import('@/connection/connectionManager');
    const sendFinalFrameSpy = vi.spyOn(SessionManager.prototype, 'sendFinalFrame');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    reconnectNow();
    expect(sendFinalFrameSpy).not.toHaveBeenCalled();

    await waitUntil(() => useChannelStore.getState().established);

    reconnectNow('announce-departure');
    expect(sendFinalFrameSpy).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the app is merely backgrounded', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');
    const sendFinalFrameSpy = vi.spyOn(SessionManager.prototype, 'sendFinalFrame');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    // That file's own mock never calls vi.clearAllMocks(), so
    // addEventListener's calls accumulate across every test that has run
    // startConnectionLifecycle() so far - .at(-1), not [0], is the handler
    // THIS test's lifecycle actually registered.
    const onAppStateChange = vi.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
    if (!onAppStateChange) throw new Error('expected an AppState change handler to be registered');

    onAppStateChange('background');

    expect(sendFinalFrameSpy).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });

  /**
   * stopConnectionLifecycle is the deliberate-shutdown entry point, and the
   * tempting change is to make it announce. It must not: it has no production
   * caller (app/_layout.tsx only ever calls start), while this file calls it
   * from afterEach and tests/unit/connectionManager.test.ts calls it from
   * beforeEach - so an announcing version would seal a Final around every
   * single test in both files.
   */
  it('stays silent when the lifecycle is stopped', async () => {
    const { startConnectionLifecycle, stopConnectionLifecycle, getActiveConnection } = await import(
      '@/connection/connectionManager'
    );
    const sendFinalFrameSpy = vi.spyOn(SessionManager.prototype, 'sendFinalFrame');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    stopConnectionLifecycle();

    expect(sendFinalFrameSpy).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });
});

describe('connectionManager rekey wiring', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });
    mockRunBootstrap.mockReset();
    mockDesktopSeam.stub = null;
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.useRealTimers();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useChannelStore.getState().reset();
  });

  /**
   * connectionManager wires controller.session.onRekey -> useChannelStore's
   * noteRekey (src/connection/connectionManager.ts, near the onEstablished
   * listener). This is the only place that wiring runs for real: noteRekey
   * alone (tests/unit/channelStore.test.ts) cannot prove the store method is
   * ever actually called by the app.
   */
  it('wires SessionManager.onRekey to channelStore.noteRekey on a real established session', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    mockRunBootstrap.mockResolvedValue(undefined);

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1);
    expect(useChannelStore.getState().established).toBe(true);
    expect(useChannelStore.getState().rekeyCount).toBe(0);

    // A rekey: the stub initiator starts a SECOND handshake WITHOUT
    // resetting the phone's session first, so the phone's streams stay
    // non-null when the reply lands - the exact condition SessionManager
    // uses to fire onRekey instead of re-firing onEstablished.
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const establishedCountBeforeRekey = stub.establishedCount;
    stub.beginHandshake();
    await waitUntil(() => stub.establishedCount === establishedCountBeforeRekey + 1);

    expect(useChannelStore.getState().rekeyCount).toBe(1);
    // onRekey deliberately does not re-fire onEstablished's bootstrap retry -
    // still just the one call from the initial establishment.
    expect(mockRunBootstrap).toHaveBeenCalledTimes(1);

    stub.beginHandshake();
    await waitUntil(() => stub.establishedCount === establishedCountBeforeRekey + 2);
    expect(useChannelStore.getState().rekeyCount).toBe(2);
  });
});
