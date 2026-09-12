/**
 * revokePushRegistrationForUnpair and resyncPushRegistrationCategories are
 * the two lazy-loaded push-registration hooks the connection manager owns
 * (see the doc comments on both in src/connection/connectionManager.ts).
 * This file mocks their heavy imports as inert stubs so the rest of the
 * module (channel, stores, bootstrap) can load for real in the node/vitest
 * tier - the same shape as tests/unit/wipeDesktopContent.test.ts (mocks
 * @/connection/bootstrap) and tests/unit/pushRegistration.test.ts (mocks
 * react-native).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resyncPushRegistrationCategories,
  revokePushRegistrationForUnpair,
  startConnectionLifecycle,
  stopConnectionLifecycle,
} from '@/connection/connectionManager';
import { useChannelStore } from '@/state/channelStore';

const pushRegistrationMocks = vi.hoisted(() => ({
  unregisterPushWithDesktop: vi.fn<(verbs: unknown) => Promise<void>>(),
  registerPushWithDesktop: vi.fn<(verbs: unknown) => Promise<void>>(),
  resetPushRegistrationProcessState: vi.fn<() => void>(),
}));
const pushKeysMocks = vi.hoisted(() => ({
  clearPushRegistration: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/notifications/pushRegistration', () => ({
  unregisterPushWithDesktop: pushRegistrationMocks.unregisterPushWithDesktop,
  registerPushWithDesktop: pushRegistrationMocks.registerPushWithDesktop,
  // Added alongside the hoisted mock above (resetPushRegistrationProcessState
  // was declared there but never exported here): openConnection's push-key
  // change check dynamically imports this export whenever
  // pushRegistrationDesktopKeyHex disagrees with the freshly loaded anchor, and
  // without this the call would resolve to undefined and throw
  // "not a function" instead of a clean assertion failure.
  resetPushRegistrationProcessState: pushRegistrationMocks.resetPushRegistrationProcessState,
}));
vi.mock('@/notifications/pushKeys', () => ({
  clearPushRegistration: pushKeysMocks.clearPushRegistration,
}));

// The handled-error door. Mocked for two reasons: openConnection's catch is
// asserted to call it (with the failure, not merely at all), and the real
// module imports @sentry/react-native, whose wrapper reads
// NativeModules.RNSentry at import time - absent from the minimal
// react-native stub below, so the real door cannot even load here.
const crashReportingMocks = vi.hoisted(() => ({
  reportHandledError: vi.fn<(site: string, error: unknown) => void>(),
}));
vi.mock('@/observability/crashReporting', () => ({
  reportHandledError: crashReportingMocks.reportHandledError,
}));

// connectionManager.ts imports AppState/Platform statically; neither
// revokePushRegistrationForUnpair nor resyncPushRegistrationCategories
// touches AppState, so a minimal stub is enough to let the module load.
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
}));

// deviceIdentity.ts and trustAnchor.ts (both statically imported by
// connectionManager.ts) read/write expo-secure-store at module use time,
// never at import time, but they still need the module to resolve.
// Hoisted so a test can make the trust-anchor read REJECT, which is the shape
// that stranded pairedState at 'unknown' on iOS.
const secureStoreMocks = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async () => null),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMocks.getItemAsync,
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

// React Native defines __DEV__ globally; the node/vitest tier does not. The
// earlier tests here never reached a line that reads it, but the lifecycle ones
// below do (the dev-only inspect bridge, and the dev log in openConnection's
// catch). False, because these assert production behaviour.
vi.stubGlobal('__DEV__', false);

/**
 * These tests never call openConnection/startConnectionLifecycle, so the
 * module-level activeConnection singleton stays null throughout - exactly
 * the "unpair before ever reconnecting" and "disconnected settings toggle"
 * shapes both exported functions exist for.
 */
describe('revokePushRegistrationForUnpair', () => {
  beforeEach(() => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockReset();
    pushKeysMocks.clearPushRegistration.mockReset();
  });

  it('still wipes the local push key even when unregisterPushWithDesktop rejects (regression guard: two independent try blocks)', async () => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockRejectedValue(new Error('relay unreachable'));
    pushKeysMocks.clearPushRegistration.mockResolvedValue(undefined);

    await revokePushRegistrationForUnpair();

    // Against the original single-try-block version, a throw from the
    // unregister call would have skipped this entirely and left a usable
    // push key behind on an unpaired phone.
    expect(pushKeysMocks.clearPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('calls unregisterPushWithDesktop before clearPushRegistration', async () => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockResolvedValue(undefined);
    pushKeysMocks.clearPushRegistration.mockResolvedValue(undefined);

    await revokePushRegistrationForUnpair();

    expect(pushRegistrationMocks.unregisterPushWithDesktop).toHaveBeenCalledTimes(1);
    expect(pushKeysMocks.clearPushRegistration).toHaveBeenCalledTimes(1);
    const unregisterCallOrder = pushRegistrationMocks.unregisterPushWithDesktop.mock.invocationCallOrder[0];
    const clearCallOrder = pushKeysMocks.clearPushRegistration.mock.invocationCallOrder[0];
    expect(unregisterCallOrder).toBeLessThan(clearCallOrder);
  });

  it('passes null, not undefined, to unregisterPushWithDesktop when no connection was ever opened', async () => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockResolvedValue(undefined);
    pushKeysMocks.clearPushRegistration.mockResolvedValue(undefined);

    await revokePushRegistrationForUnpair();

    expect(pushRegistrationMocks.unregisterPushWithDesktop).toHaveBeenCalledWith(null);
    // toHaveBeenCalledWith(null) alone would also pass a call with undefined
    // for some matcher implementations; assert the actual argument directly.
    expect(pushRegistrationMocks.unregisterPushWithDesktop.mock.calls[0][0]).toBe(null);
  });
});

describe('resyncPushRegistrationCategories', () => {
  beforeEach(() => {
    pushRegistrationMocks.registerPushWithDesktop.mockReset();
  });

  it('calls registerPushWithDesktop(null) exactly once while disconnected', async () => {
    pushRegistrationMocks.registerPushWithDesktop.mockResolvedValue(undefined);

    await resyncPushRegistrationCategories();

    expect(pushRegistrationMocks.registerPushWithDesktop).toHaveBeenCalledTimes(1);
    expect(pushRegistrationMocks.registerPushWithDesktop.mock.calls[0][0]).toBe(null);
  });

  it('swallows a rejection from registerPushWithDesktop without throwing', async () => {
    pushRegistrationMocks.registerPushWithDesktop.mockRejectedValue(new Error('transport closed'));

    await expect(resyncPushRegistrationCategories()).resolves.toBeUndefined();
  });
});

/**
 * The unpaired dead end.
 *
 * `pairedState` starts at 'unknown' and only leaves it inside openConnection, which
 * every call site invokes as a bare `void openConnection()`. So a rejection before
 * the trust anchor resolves is swallowed and the state is stranded at 'unknown'
 * forever. TriageHomeScreen renders the pair CTA only for 'unpaired', so the user
 * sits on "Connecting to your desktop..." permanently: no error, no retry, and no
 * way to reach pairing.
 *
 * Found on iOS by the CI simulator smoke test, where a fresh install never offered
 * to pair. Task #14 fixed the SIBLING of this independently (a lost bootstrap
 * stranding a PAIRED app on the same screen), which is corroboration rather than
 * coincidence: this screen has no state meaning "something failed, recover here".
 */
describe('openConnection failure leaves a route to pairing', () => {
  beforeEach(() => {
    stopConnectionLifecycle();
    useChannelStore.getState().setPairedState('unknown');
    secureStoreMocks.getItemAsync.mockReset();
    crashReportingMocks.reportHandledError.mockClear();
  });

  it('falls back to unpaired when the trust-anchor read rejects, and reports it through the door', async () => {
    // The regression. Without the catch, pairedState stays 'unknown' and the
    // screen shows "Connecting..." with no pair CTA, permanently. The
    // fallback is right for the user and silent for the developer, which is
    // what the handled-error door exists for (task #67).
    const failure = new Error('keychain unavailable');
    secureStoreMocks.getItemAsync.mockRejectedValue(failure);

    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));
    await vi.waitFor(() => expect(crashReportingMocks.reportHandledError).toHaveBeenCalledWith('connection-open', failure));
  });

  it('still reports unpaired normally when there is simply no anchor', async () => {
    // The non-vacuity half: the fallback must not become the only reason this ever
    // reads 'unpaired', or the test above would pass against a broken app. And an
    // honest "no anchor" is not a failure, so the door stays silent.
    secureStoreMocks.getItemAsync.mockResolvedValue(null);

    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));
    expect(crashReportingMocks.reportHandledError).not.toHaveBeenCalled();
  });

  it('does not overwrite an already-resolved paired state', async () => {
    // Only the stranded 'unknown' case is rescued. A failure after the anchor
    // resolved belongs to the reconnect paths, and clobbering 'paired' would send a
    // genuinely paired user to the pairing screen.
    secureStoreMocks.getItemAsync.mockRejectedValue(new Error('later failure'));
    useChannelStore.getState().setPairedState('paired');

    startConnectionLifecycle();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useChannelStore.getState().pairedState).toBe('paired');
  });
});
