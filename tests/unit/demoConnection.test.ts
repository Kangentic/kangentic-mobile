/**
 * The reviewer/demo pairing, driven through the REAL connection lifecycle with
 * `__DEV__` stubbed FALSE.
 *
 * That stub is the point of this file. Every other route to the in-process
 * desktop peer (the dev rig's `EXPO_PUBLIC_KANGENTIC_MOCK`, dev-pairing mode)
 * is behind `__DEV__ &&`, which Metro constant-folds away before it even walks
 * dependencies, so none of it exists in a release bundle. The demo branch is
 * the one path that ships, and "it works in the dev rig" says nothing about
 * whether it works in the binary a reviewer installs. Asserting it here, under
 * the production condition, is the closest thing to that binary reachable
 * without building one.
 *
 * What is proved: a persisted demo trust anchor brings the app up paired,
 * establishes a real encrypted session against the in-process peer, populates
 * the board the reviewer lands on, and never constructs a RelayTransport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@kangentic/protocol';

import { reconnectNow, startConnectionLifecycle, stopConnectionLifecycle } from '@/connection/connectionManager';
import { DEMO_DESKTOP_STATIC, DEMO_RELAY_ADDRESS } from '@/demo/demoIdentity';
import { useChannelStore } from '@/state/channelStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { waitUntil } from '../helpers/async';

/** Counted, not stubbed: a non-zero count is the failure this file exists to catch. */
const relayTransportMocks = vi.hoisted(() => ({ constructions: 0 }));

vi.mock('@/channel/relayTransport', () => {
  class FakeRelayTransport {
    readonly state = 'idle';
    constructor() {
      relayTransportMocks.constructions += 1;
    }
    connect(): Promise<void> {
      return Promise.reject(new Error('FakeRelayTransport: the demo must never reach a relay'));
    }
    send(): void {}
    close(): void {}
    onFrame(): () => void {
      return () => {};
    }
    onStateChange(): () => void {
      return () => {};
    }
  }
  return { RelayTransport: FakeRelayTransport };
});

vi.mock('@/notifications/pushRegistration', () => ({
  unregisterPushWithDesktop: vi.fn(async () => undefined),
  registerPushWithDesktop: vi.fn(async () => undefined),
  resetPushRegistrationProcessState: vi.fn(),
}));
vi.mock('@/notifications/pushKeys', () => ({ clearPushRegistration: vi.fn(async () => undefined) }));
vi.mock('@/notifications/channels', () => ({
  refreshNotificationPermission: vi.fn(async () => undefined),
  requestNotificationPermission: vi.fn(async () => undefined),
}));

// The handled-error door: its real module imports @sentry/react-native, whose
// wrapper reads NativeModules.RNSentry at import time - absent from the
// minimal react-native stub below - so it is stubbed inert here.
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: vi.fn() }));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'android' },
}));

/** A Keychain holding exactly what a completed demo ceremony leaves behind. */
const secureStoreMocks = vi.hoisted(() => ({ items: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreMocks.items.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreMocks.items.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStoreMocks.items.delete(key);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

// PRODUCTION, not the dev rig. If this were true the assertions below would
// still pass while proving nothing about a shipped build.
vi.stubGlobal('__DEV__', false);

function writeDemoAnchor(): void {
  secureStoreMocks.items.set('trust.desktopStaticPublicKey', bytesToHex(DEMO_DESKTOP_STATIC.publicKey));
  secureStoreMocks.items.set('trust.relayAddress', DEMO_RELAY_ADDRESS);
  secureStoreMocks.items.set('trust.pairedAt', '2026-08-25T12:00:00.000Z');
}

beforeEach(() => {
  secureStoreMocks.items.clear();
  relayTransportMocks.constructions = 0;
  useChannelStore.getState().reset();
  useChannelStore.getState().setPairedState('unknown');
});

afterEach(() => {
  stopConnectionLifecycle();
});

describe('a demo trust anchor, in a production-shaped build', () => {
  it('comes up paired and establishes a real session against the in-process desktop', async () => {
    writeDemoAnchor();

    startConnectionLifecycle();

    await waitUntil(() => useChannelStore.getState().established, {
      label: 'demo session establishes',
      timeoutMs: 5000,
    });
    expect(useChannelStore.getState().pairedState).toBe('paired');
    // A real Noise KK handshake completed over the loopback: `established` is
    // set by the session manager's onEstablished, which only fires after both
    // sides split.
    expect(useChannelStore.getState().established).toBe(true);
    expect(useChannelStore.getState().relayUrl).toBe(DEMO_RELAY_ADDRESS);
  });

  it('populates the board the reviewer lands on', async () => {
    writeDemoAnchor();

    startConnectionLifecycle();

    // Bootstrap runs the real capability verbs over the real feed router, so
    // this is the whole read path, not a store poke.
    await waitUntil(() => useBoardStore.getState().projects.length > 0, {
      label: 'demo board content arrives',
      timeoutMs: 5000,
    });
    expect(useBoardStore.getState().projects.length).toBeGreaterThan(0);
  });

  it('never constructs a RelayTransport', async () => {
    writeDemoAnchor();

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { timeoutMs: 5000 });

    expect(relayTransportMocks.constructions).toBe(0);
  });

  it('leaves a real pairing alone: a non-demo anchor still dials the relay', async () => {
    // The other half of the branch, and the one that would catch
    // `isDemoAnchor` being loosened into something that matches everything.
    // A real anchor must still take the relay path, which the fake rejects.
    secureStoreMocks.items.set('trust.desktopStaticPublicKey', bytesToHex(new Uint8Array(32).fill(9)));
    secureStoreMocks.items.set('trust.relayAddress', 'wss://relay.example.com');
    secureStoreMocks.items.set('trust.pairedAt', '2026-08-25T12:00:00.000Z');

    startConnectionLifecycle();

    await waitUntil(() => relayTransportMocks.constructions > 0, {
      label: 'a real anchor dials the relay',
      timeoutMs: 5000,
    });
    expect(relayTransportMocks.constructions).toBe(1);
    expect(useChannelStore.getState().established).toBe(false);
  });

  it('shows the pairing CTA when there is no anchor at all', async () => {
    startConnectionLifecycle();

    await waitUntil(() => useChannelStore.getState().pairedState === 'unpaired', {
      label: 'unpaired state resolves',
    });
    expect(relayTransportMocks.constructions).toBe(0);
  });

  it('never registers push or requests the notification permission, so the demo stays networkless', async () => {
    // Hydrated with a mode that WOULD otherwise reach both dynamic imports on
    // a real (non-demo) connection - proves the isDemoAnchor gate is what
    // stops them, not merely settings never being ready. Without this, the
    // assertions below would pass vacuously: hydrated defaults false, and
    // maybeRequestNotificationPermission returns before importing
    // '@/notifications/channels' at all whenever settings are unhydrated.
    useSettingsStore.setState({
      hydrated: true,
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: false,
    });
    writeDemoAnchor();

    startConnectionLifecycle();

    await waitUntil(() => useChannelStore.getState().established, {
      label: 'demo session establishes',
      timeoutMs: 5000,
    });
    // One more turn for the (skipped) fire-and-forget dynamic imports to have
    // resolved, so a negative assertion is not merely racing a promise that
    // has not settled yet.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { registerPushWithDesktop } = await import('@/notifications/pushRegistration');
    const { requestNotificationPermission } = await import('@/notifications/channels');
    expect(registerPushWithDesktop).not.toHaveBeenCalled();
    expect(requestNotificationPermission).not.toHaveBeenCalled();

    useSettingsStore.setState({ hydrated: false, backgroundNotificationsMode: 'foreground-service', hasRequestedNotificationPermission: false });
  });
});

/**
 * connectionManager.ts's pushRegistrationDesktopKeyHex cache: the unpair flow
 * resets pushRegistration's process-global idempotence bookkeeping explicitly,
 * but a re-pair that never goes through unpair (reconnectNow(), the exact call
 * a completed pairing makes) does not - so this module has to notice the
 * desktop key changed and drop that cache itself, or the new desktop never
 * receives this device's push key until the next app restart.
 *
 * Exercised through the demo anchor (a real, working connection with no relay
 * to dial) and a real anchor (whose FakeRelayTransport rejects immediately,
 * which is fine: the key-hex check runs BEFORE the transport is even
 * constructed).
 *
 * RESIDUE WARNING: pushRegistrationDesktopKeyHex is connectionManager.ts's own
 * module-level variable, not exported and not reset by beforeEach here, so it
 * carries across every test in this file. The second case below deliberately
 * leaves it pointed at a non-demo key (Uint8Array(32).fill(9)) - harmless
 * today because this is the last describe block in the file, but a test
 * appended AFTER it that opens the demo anchor and asserts
 * resetPushRegistrationProcessState was NOT called would see a spurious reset
 * from that leftover key, with no exported state to explain why. Keep this
 * block last, or have a new test open the demo anchor once (unasserted)
 * before relying on "same key as last time".
 */
describe('the push-registration desktop-key cache, across a reconnect that never goes through unpair', () => {
  it('does not reset when a reconnect brings back the SAME desktop key', async () => {
    writeDemoAnchor();
    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, {
      label: 'first demo session establishes',
      timeoutMs: 5000,
    });

    const { resetPushRegistrationProcessState } = await import('@/notifications/pushRegistration');
    vi.mocked(resetPushRegistrationProcessState).mockClear();

    // Still the demo anchor: same desktop key as the open above.
    reconnectNow();
    await waitUntil(() => useChannelStore.getState().established, {
      label: 'reconnect re-establishes against the same desktop',
      timeoutMs: 5000,
    });

    expect(resetPushRegistrationProcessState).not.toHaveBeenCalled();
  });

  it('resets when a reconnect picks up a CHANGED desktop key, the re-pair-without-unpair shape', async () => {
    writeDemoAnchor();
    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, {
      label: 'first demo session establishes',
      timeoutMs: 5000,
    });

    const { resetPushRegistrationProcessState } = await import('@/notifications/pushRegistration');
    vi.mocked(resetPushRegistrationProcessState).mockClear();

    // A different desktop key, written the way a completed re-pairing
    // ceremony leaves the trust anchor - never touching unpair's own reset.
    secureStoreMocks.items.set('trust.desktopStaticPublicKey', bytesToHex(new Uint8Array(32).fill(9)));
    secureStoreMocks.items.set('trust.relayAddress', 'wss://relay.example.com');
    secureStoreMocks.items.set('trust.pairedAt', '2026-08-25T12:05:00.000Z');

    reconnectNow();
    await waitUntil(() => relayTransportMocks.constructions > 0, {
      label: 'the new (non-demo) desktop key dials the relay',
      timeoutMs: 5000,
    });

    expect(resetPushRegistrationProcessState).toHaveBeenCalledTimes(1);
  });
});
