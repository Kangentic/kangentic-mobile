import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { DevicesScreen } from '@/screens/DevicesScreen';
import { useChannelStore } from '@/state/channelStore';
import type { PairedDesktopInfoState } from '@/screens/usePairedDesktopInfo';
// Type-only, so it is erased before jest hoists the factory below and can be
// referenced inside it without tripping the out-of-scope-variable guard.
import type { ConnectionTeardownIntent } from '@/connection/connectionManager';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

let mockPairedState: PairedDesktopInfoState = { status: 'loading' };
jest.mock('@/screens/usePairedDesktopInfo', () => {
  const actual = jest.requireActual('@/screens/usePairedDesktopInfo');
  return {
    __esModule: true,
    usePairedDesktopInfo: () => mockPairedState,
    formatKeyFingerprint: actual.formatKeyFingerprint,
  };
});

// The screen itself no longer touches the anchor store, but the requireActual
// of usePairedDesktopInfo above still imports it - keep SecureStore out.
jest.mock('@/pairing/trustAnchor', () => ({
  TrustAnchorStore: jest.fn().mockImplementation(() => ({ clear: jest.fn() })),
}));

// The same requireActual imports the handled-error door; stubbed so the real
// Sentry SDK stays out of this test's module graph. Its own behaviour is
// covered in usePairedDesktopInfo.test.tsx.
jest.mock('@/observability/crashReporting', () => ({
  reportHandledError: jest.fn(),
}));

const mockUnpairLocally = jest.fn().mockResolvedValue(undefined);
const mockRevokePushRegistrationForUnpair = jest.fn().mockResolvedValue(undefined);
// The arrow defers the mock read past import-time hoisting - but it MUST forward
// its arguments. Written as `() => mockUnpairLocally()` the wrapper silently drops
// them, so any toHaveBeenCalledWith assertion fails against correct production
// code and a bare toHaveBeenCalled passes no matter what is passed. If a factory
// needs no hoisting dodge, prefer a bare `jest.fn()` (see PairingConfirmScreen.test.tsx).
jest.mock('@/connection/actions', () => ({
  unpairLocally: (intent: ConnectionTeardownIntent) => mockUnpairLocally(intent),
}));
jest.mock('@/connection/connectionManager', () => ({
  revokePushRegistrationForUnpair: () => mockRevokePushRegistrationForUnpair(),
}));

function renderDevices(): void {
  render(
    <ThemeProvider>
      <DevicesScreen />
    </ThemeProvider>,
  );
}

describe('DevicesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true, relayUrl: 'ws://127.0.0.1:8080' });
    mockPairedState = {
      status: 'paired',
      info: {
        desktopPublicKeyHex: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        relayAddress: 'ws://127.0.0.1:8080',
        pairedAt: '2026-07-14T00:00:00.000Z',
        phonePublicKeyHex: '1122334455667788990011223344556677889900112233445566778899001122',
      },
    };
  });

  it('renders the paired-desktop and this-phone cards with fingerprints', () => {
    renderDevices();
    expect(screen.getByTestId('devices-desktop-fingerprint').props.children).toBe('a1b2 c3d4 e5f6 0718');
    expect(screen.getByTestId('devices-phone-fingerprint').props.children).toBe('1122 3344 5566 7788');
    expect(screen.getByTestId('devices-connection-dot')).toBeTruthy();
  });

  it('unpairs only after the two-step confirm, announcing the departure', async () => {
    renderDevices();
    fireEvent.press(screen.getByTestId('devices-unpair'));
    expect(mockUnpairLocally).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('devices-unpair-confirm'));
    });
    expect(mockRevokePushRegistrationForUnpair).toHaveBeenCalled();
    // Unpair is a deliberate departure: the desktop should be told, so its
    // Mobile Devices panel reacts immediately.
    expect(mockUnpairLocally).toHaveBeenCalledWith('announce-departure');
    expect(mockBack).toHaveBeenCalled();
    // Push revocation happens BEFORE the anchor-clearing teardown, while the
    // channel (and thus the desktop connection to send "unregister" over)
    // is still up.
    expect(mockRevokePushRegistrationForUnpair.mock.invocationCallOrder[0]).toBeLessThan(mockUnpairLocally.mock.invocationCallOrder[0]);
  });

  /**
   * The armed confirmation must not expire on a clock. It used to relax after
   * five seconds, silently, so a confirm tap arriving late re-armed instead of
   * unpairing and the button read exactly as it had before the tap. The second
   * tap is the guard against an accidental press; the timer never was.
   */
  it('still unpairs on the second tap long after the first', async () => {
    jest.useFakeTimers();
    try {
      renderDevices();
      fireEvent.press(screen.getByTestId('devices-unpair'));

      act(() => {
        jest.advanceTimersByTime(120_000);
      });
      expect(screen.getByTestId('devices-unpair-confirm')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByTestId('devices-unpair-confirm'));
      });
      expect(mockUnpairLocally).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  /** Unpair had no failure path at all: it left the phone paired and said nothing. */
  it('says why when the unpair fails instead of silently staying paired', async () => {
    // A locked Keystore rejects the trust-anchor clear inside unpairLocally.
    mockUnpairLocally.mockRejectedValueOnce(new Error('Keystore is locked'));
    renderDevices();
    fireEvent.press(screen.getByTestId('devices-unpair'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('devices-unpair-confirm'));
    });
    expect(screen.getByText('Keystore is locked')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('shows the pairing CTA when nothing is paired', () => {
    mockPairedState = { status: 'unpaired' };
    renderDevices();
    expect(screen.getByTestId('devices-pair-cta')).toBeTruthy();
  });
});
