import React from 'react';
import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import type { BackgroundPushTaskStatus, PushRegistrationStatus } from '@/notifications';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

// Drives the AppState 'active' transition NotificationPermissionNotice listens
// for. Spied on the real AppState (registered in beforeEach) rather than
// mocked as a module: react-native re-exports it lazily, so replacing the
// module leaves the component with an undefined AppState.
const appStateListeners = new Set<(nextStatus: AppStateStatus) => void>();

function emitAppState(nextStatus: AppStateStatus): void {
  for (const listener of appStateListeners) listener(nextStatus);
}

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// The notifications barrel statically pulls notifee, which throws at import
// time without its native module; the screen only reads the status snapshot.
const mockOpenSystemNotificationSettings = jest.fn().mockResolvedValue(undefined);
const mockRefreshNotificationPermission = jest.fn().mockResolvedValue(true);
const mockNotificationPermissionStatus = jest
  .fn<'granted' | 'denied' | 'not-determined' | null, []>()
  .mockReturnValue('granted');
// Typed from the real exports rather than re-spelled unions: a renamed status
// should break this mock, not quietly drift from the code under test. Type-only
// imports are erased, so this does not defeat the jest.mock below.
const mockGetPushRegistrationStatus = jest.fn<PushRegistrationStatus, []>().mockReturnValue('not-connected');
const mockGetBackgroundPushTaskStatus = jest.fn<BackgroundPushTaskStatus, []>().mockReturnValue('registered');
jest.mock('@/notifications', () => ({
  getPushRegistrationStatus: () => mockGetPushRegistrationStatus(),
  getBackgroundPushTaskStatus: () => mockGetBackgroundPushTaskStatus(),
  notificationPermissionStatus: () => mockNotificationPermissionStatus(),
  openSystemNotificationSettings: () => mockOpenSystemNotificationSettings(),
  refreshNotificationPermission: () => mockRefreshNotificationPermission(),
}));

const mockResyncPushRegistrationCategories = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/connectionManager', () => ({
  resyncPushRegistrationCategories: () => mockResyncPushRegistrationCategories(),
}));

// Only the two crash triggers are stubbed; `crashTestEnabled` stays real so
// the visibility tests below still exercise the actual env gating. Stubbing
// matters here beyond assertion convenience: the real `crashNatively` calls
// `Sentry.nativeCrash()`, and the real `throwTestError` schedules a throw on
// a timer that would surface as an unhandled error in a later test.
// The NSE probe module reaches notifee and the push-key store, so it is stubbed
// whole; its own behaviour is covered in tests/unit/nseProbe.test.ts and
// pushKeys.test.ts. The flag is a mock rather than an env var because the
// module, not the screen, owns the env read.
const mockNseProbeEnabled = jest.fn().mockReturnValue(false);
const mockSeedNseProbe = jest.fn().mockResolvedValue({ permissionGranted: true });
const mockReadNseProbeResult = jest.fn().mockResolvedValue('Agent needs your input | NSE probe - decrypted on device');
jest.mock('@/devsupport/nseProbe', () => ({
  nseProbeEnabled: () => mockNseProbeEnabled(),
  seedNseProbe: () => mockSeedNseProbe(),
  readNseProbeResult: () => mockReadNseProbeResult(),
}));

const mockThrowTestError = jest.fn();
const mockCrashNatively = jest.fn();
const mockReportHandledTestError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  ...jest.requireActual('@/observability/crashReporting'),
  throwTestError: () => mockThrowTestError(),
  crashNatively: () => mockCrashNatively(),
  reportHandledTestError: () => mockReportHandledTestError(),
}));

function renderSettings(): void {
  render(
    <ThemeProvider>
      <SettingsScreen />
    </ThemeProvider>,
  );
}

function setCrashTestFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;
  else process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST = value;
}

describe('SettingsScreen', () => {
  const originalCrashTestFlag = process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;

  beforeEach(() => {
    mockPush.mockClear();
    useSettingsStore.setState({
      dictationMode: 'auto-send',
      hasSeenSessionModeHint: false,
      hapticsEnabled: true,
      backgroundNotificationsMode: 'foreground-service',
      // The real defaults, spawn-stalled included: "slow starts" is off unless
      // the user asks for it, and the rows below assert that shows in the UI.
      pushCategoriesEnabled: {
        'input-required': true,
        'turn-complete': true,
        'session-failed': true,
        'plan-complete': true,
        'spawn-stalled': false,
      },
      // The steady state for these tests: the app has already asked for
      // POST_NOTIFICATIONS at some point. The never-asked case is a distinct
      // branch of the blocked notice and has its own test below.
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true, relayUrl: 'ws://127.0.0.1:8080' });
    setCrashTestFlag(undefined);
    mockThrowTestError.mockClear();
    mockCrashNatively.mockClear();
    mockOpenSystemNotificationSettings.mockClear();
    mockRefreshNotificationPermission.mockClear();
    mockRefreshNotificationPermission.mockResolvedValue(true);
    mockNotificationPermissionStatus.mockReturnValue('granted');
    mockGetPushRegistrationStatus.mockReturnValue('not-connected');
    mockGetBackgroundPushTaskStatus.mockReturnValue('registered');
    appStateListeners.clear();
    // Re-installed fresh every test (idempotent over jest.spyOn), never
    // restored in afterEach: restoring here would strip every OTHER mock in
    // this file too (jest.restoreAllMocks() is global, not scoped to this
    // one spy), which the next test's own beforeEach reconfiguration would
    // mask today but is exactly the kind of setup a later test could rely on
    // without re-declaring.
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener): NativeEventSubscription => {
      const appStateListener = listener as (nextStatus: AppStateStatus) => void;
      appStateListeners.add(appStateListener);
      return { remove: () => appStateListeners.delete(appStateListener) } as unknown as NativeEventSubscription;
    });
  });

  afterEach(() => {
    setCrashTestFlag(originalCrashTestFlag);
  });

  it('renders the connection section with live status and relay', () => {
    renderSettings();
    expect(screen.getByTestId('settings-connection-label').props.children).toBe('Connected');
    expect(screen.getByTestId('settings-relay-url')).toBeTruthy();
  });

  it('navigates to the devices screen from the paired-devices row', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-devices-row'));
    expect(mockPush).toHaveBeenCalledWith('/devices');
  });

  it('persists the background notifications mode selection', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-notifications-push-only'));
    expect(useSettingsStore.getState().backgroundNotificationsMode).toBe('push-only');
  });

  /**
   * The notice is the only recovery path once the OS has stopped showing the
   * runtime prompt, so it must appear on a denial and stay out of the way
   * otherwise - a permanently-visible warning would train the user past it.
   *
   * Cross-platform NOW, which is the fix: it used to bail on
   * `Platform.OS !== 'android'`, so an iOS user whose authorization was denied
   * saw a screen full of enabled-looking toggles and nothing else. That is
   * exactly the state the bug reporter was in.
   */
  it('offers a route to system settings when the notification permission is denied', () => {
    mockNotificationPermissionStatus.mockReturnValue('denied');
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-open-notification-settings'));
    expect(mockOpenSystemNotificationSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * The cache is seeded once at mount and otherwise never updates on its own,
   * so returning from the system settings screen (which fires AppState
   * 'active') is the only moment a grant made outside the app becomes visible
   * here. Without this listener, a user who grants the permission from system
   * settings and comes back would see "Notifications are blocked" forever,
   * with nothing left to re-check and clear it. The listener registration used
   * to be Android-gated too, so on iOS the notice could never clear.
   */
  it('clears the blocked notice once the permission reads back granted after returning to the app', async () => {
    mockNotificationPermissionStatus.mockReturnValue('denied');
    renderSettings();

    expect(screen.getByTestId('settings-open-notification-settings')).toBeTruthy();

    mockRefreshNotificationPermission.mockResolvedValue(true);
    mockNotificationPermissionStatus.mockReturnValue('granted');
    act(() => {
      emitAppState('active');
    });

    await waitFor(() => expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull());
    expect(mockRefreshNotificationPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The notice's two conditions are asymmetric ON PURPOSE:
   * `if (status !== 'denied') return null;` then
   * `if (Platform.OS === 'android' && !hasRequestedNotificationPermission) return null;`.
   * On iOS, a denial shows the notice REGARDLESS of the persisted flag - only
   * Android additionally requires it. Every denied-status test above leaves
   * hasRequestedNotificationPermission at its beforeEach default of true, so
   * iOS's independence from that flag was never actually exercised: a
   * regression that added the flag check to iOS too would pass every existing
   * test in this file.
   */
  it('shows the blocked notice on iOS independent of the persisted flag, but keeps it hidden on Android', () => {
    mockNotificationPermissionStatus.mockReturnValue('denied');
    useSettingsStore.setState({ hasRequestedNotificationPermission: false });
    renderSettings();

    if (Platform.OS === 'ios') {
      expect(screen.getByTestId('settings-open-notification-settings')).toBeTruthy();
    } else {
      expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
    }
  });

  it('hides the blocked-notifications notice when the permission is granted or unknown', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();

    // null is "nothing has looked yet", which must read as unknown rather than
    // as a denial - otherwise every cold start flashes a blocked warning.
    mockNotificationPermissionStatus.mockReturnValue(null);
    renderSettings();
    expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
  });

  /**
   * How each platform answers "have we asked yet?", and why the notice needs
   * two conditions rather than one. Branches on the platform because
   * jest.config.js runs this file under BOTH the ios and android projects.
   *
   * Android has no NOT_DETERMINED status - notifee reports plain DENIED, and
   * initializeNotifications seeds the cache at boot - so a never-asked install
   * looks identical to a refused one, and only the persisted flag separates
   * them. Keying the notice on the cache alone therefore told a brand-new user
   * "Notifications are blocked" before the app had ever asked them.
   *
   * iOS says so directly, which is the more trustworthy source there: Keychain
   * items survive app deletion, so the persisted flag can outlive the
   * authorization it describes.
   */
  it('does not claim notifications are blocked before the app has ever asked', () => {
    if (Platform.OS === 'android') {
      mockNotificationPermissionStatus.mockReturnValue('denied');
      useSettingsStore.setState({ hasRequestedNotificationPermission: false });
    } else {
      mockNotificationPermissionStatus.mockReturnValue('not-determined');
      // Deliberately left TRUE: on iOS a stale flag must not be what decides
      // this, or a reinstall shows a blocked notice it has no business showing.
      useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    }
    renderSettings();

    expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
  });

  /**
   * "Stay connected" is the Android background keepalive, and the gate that
   * starts it requires Platform.OS === 'android' - so on iOS the option is
   * inert and offering it misdescribes what the app will do.
   */
  it('offers the background-keepalive mode on Android only', () => {
    renderSettings();

    if (Platform.OS === 'android') {
      expect(screen.getByTestId('settings-notifications-foreground-service')).toBeTruthy();
      return;
    }

    expect(screen.queryByTestId('settings-notifications-foreground-service')).toBeNull();
    // The stored value is 'foreground-service' (set in beforeEach) and is left
    // alone; it simply reads as push-only here, which is what actually happens.
    expect(screen.getByTestId('settings-notifications-push-only').props.accessibilityState.selected).toBe(true);
    expect(useSettingsStore.getState().backgroundNotificationsMode).toBe('foreground-service');
  });

  it('flips the haptics toggle', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-haptics-toggle'));
    expect(useSettingsStore.getState().hapticsEnabled).toBe(false);
  });

  it('keeps the dictation radios working', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-dictation-off'));
    expect(useSettingsStore.getState().dictationMode).toBe('off');
  });

  it('toggles a push category without disturbing the others', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-category-turn-complete'));
    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': true,
      'turn-complete': false,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': false,
    });
  });

  /** The default lands in the UI, not just the store: the row reads as off. */
  it('shows the slow-starts category switched off by default', () => {
    renderSettings();
    expect(screen.getByTestId('settings-category-spawn-stalled').props.accessibilityState.checked).toBe(false);
  });

  it('resyncs the desktop registration when a category toggle changes', async () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-category-spawn-stalled'));
    // waitFor, not a bare `await fireEvent.press`: the resync fires after
    // setPushCategoryEnabled's awaited SecureStore write resolves, so a
    // single-microtask await couples this assertion to the exact number of
    // promise hops in the implementation and goes red on a harmless refactor.
    await waitFor(() => expect(mockResyncPushRegistrationCategories).toHaveBeenCalled());
  });

  it('round-trips a category switch off then on, on both the store and the row accessibilityState', () => {
    renderSettings();
    // SwitchRow's inner native Switch is presentational (pointerEvents="none",
    // hidden from the a11y tree); the wrapping Pressable owns the switch
    // role AND accessibilityState, so assert against the element carrying
    // the testID, not a nested Switch node.
    const row = screen.getByTestId('settings-category-spawn-stalled');
    expect(row.props.accessibilityState.checked).toBe(false);

    fireEvent.press(row);
    expect(useSettingsStore.getState().pushCategoriesEnabled['spawn-stalled']).toBe(true);
    expect(screen.getByTestId('settings-category-spawn-stalled').props.accessibilityState.checked).toBe(true);

    fireEvent.press(screen.getByTestId('settings-category-spawn-stalled'));
    expect(useSettingsStore.getState().pushCategoriesEnabled['spawn-stalled']).toBe(false);
    expect(screen.getByTestId('settings-category-spawn-stalled').props.accessibilityState.checked).toBe(false);
  });

  it('hides the crash-test section by default', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-section-crash-test')).toBeNull();
    expect(screen.queryByTestId('settings-crash-test-js')).toBeNull();
    expect(screen.queryByTestId('settings-crash-test-native')).toBeNull();
    expect(screen.queryByTestId('settings-crash-test-handled')).toBeNull();
  });

  it('reveals the crash-test rows only when EXPO_PUBLIC_KANGENTIC_CRASHTEST is "1"', () => {
    setCrashTestFlag('1');
    renderSettings();
    expect(screen.getByTestId('settings-section-crash-test')).toBeTruthy();
    expect(screen.getByTestId('settings-crash-test-js')).toBeTruthy();
    expect(screen.getByTestId('settings-crash-test-native')).toBeTruthy();
    expect(screen.getByTestId('settings-crash-test-handled')).toBeTruthy();
  });

  // Visibility alone would still pass with the handlers swapped, which is the
  // one mistake that makes the whole affordance lie: the row labelled "Crash
  // natively" is the only way to exercise the path a JS `beforeSend` cannot
  // filter, so wiring it to the JS throw would silently verify nothing, and
  // the handled-error row is the only way to verify the door's redaction
  // against a delivered payload.
  it('wires each crash-test row to its own trigger', () => {
    setCrashTestFlag('1');
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-crash-test-js'));
    expect(mockThrowTestError).toHaveBeenCalledTimes(1);
    expect(mockCrashNatively).not.toHaveBeenCalled();
    expect(mockReportHandledTestError).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('settings-crash-test-native'));
    expect(mockCrashNatively).toHaveBeenCalledTimes(1);
    expect(mockThrowTestError).toHaveBeenCalledTimes(1);
    expect(mockReportHandledTestError).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('settings-crash-test-handled'));
    expect(mockReportHandledTestError).toHaveBeenCalledTimes(1);
    expect(mockThrowTestError).toHaveBeenCalledTimes(1);
    expect(mockCrashNatively).toHaveBeenCalledTimes(1);
  });

  it('hides the NSE probe section by default', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-section-nse-probe')).toBeNull();
    expect(screen.queryByTestId('settings-nse-probe-seed')).toBeNull();
    expect(screen.queryByTestId('settings-nse-probe-read')).toBeNull();
  });

  it('reveals the NSE probe rows only when the probe flag is on', () => {
    mockNseProbeEnabled.mockReturnValueOnce(true);
    renderSettings();
    expect(screen.getByTestId('settings-section-nse-probe')).toBeTruthy();
    expect(screen.getByTestId('settings-nse-probe-seed')).toBeTruthy();
    expect(screen.getByTestId('settings-nse-probe-read')).toBeTruthy();
  });

  it('seeds the probe keys and shows the outcome, including the permission answer', async () => {
    mockNseProbeEnabled.mockReturnValue(true);
    mockSeedNseProbe.mockClear();
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-nse-probe-seed'));

    expect(await screen.findByTestId('settings-nse-probe-seeded')).toBeTruthy();
    expect(screen.getByText(/permission granted/)).toBeTruthy();
    expect(mockSeedNseProbe).toHaveBeenCalledTimes(1);
    mockNseProbeEnabled.mockReturnValue(false);
  });

  it('shows a seed failure by its message, so an entitlement error is readable on the screenshot', async () => {
    // The Maestro flow waits for the seeded id, so a failure is a timeout plus
    // this text in the failure screenshot: errSecMissingEntitlement reads
    // differently from a decrypt failure, which is the point.
    mockNseProbeEnabled.mockReturnValue(true);
    mockSeedNseProbe.mockRejectedValueOnce(new Error('A required entitlement is not present (errSecMissingEntitlement)'));
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-nse-probe-seed'));

    expect(await screen.findByTestId('settings-nse-probe-seed-error')).toBeTruthy();
    expect(screen.getByText(/errSecMissingEntitlement/)).toBeTruthy();
    expect(screen.queryByTestId('settings-nse-probe-seeded')).toBeNull();
    mockNseProbeEnabled.mockReturnValue(false);
  });

  it('reads the delivered notification into the result row', async () => {
    mockNseProbeEnabled.mockReturnValue(true);
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-nse-probe-read'));

    expect(await screen.findByTestId('settings-nse-probe-result')).toBeTruthy();
    expect(screen.getByText('Agent needs your input | NSE probe - decrypted on device')).toBeTruthy();
    mockNseProbeEnabled.mockReturnValue(false);
  });

  /**
   * This surface was rendered but asserted NOWHERE in any tier, so a dropped
   * label or a stopped render was invisible. It is the only place the app tells
   * a user whether remote push actually works.
   */
  describe('remote push status', () => {
    it('reports the registration status while the receive task is healthy', () => {
      mockGetPushRegistrationStatus.mockReturnValue('registered');
      mockGetBackgroundPushTaskStatus.mockReturnValue('registered');
      renderSettings();

      expect(screen.getByTestId('settings-push-status')).toBeTruthy();
      expect(screen.getByText('Remote push: registered')).toBeTruthy();
    });

    /**
     * The two halves fail independently: the token can register with the
     * desktop perfectly while the headless task that would DISPLAY the result
     * never registered, so pushes are sent, delivered, and silently never seen.
     * "Remote push: registered" is the one label that is actively wrong there,
     * so the task status has to outrank it.
     */
    it('overrides a registered status when the receive task never registered', () => {
      mockGetPushRegistrationStatus.mockReturnValue('registered');
      mockGetBackgroundPushTaskStatus.mockReturnValue('unavailable');
      renderSettings();

      expect(screen.getByText('Remote push: unavailable on this device')).toBeTruthy();
      expect(screen.queryByText('Remote push: registered')).toBeNull();
    });

    /**
     * THE PAIRING THAT ACTUALLY HAPPENS. A build with no google-services.json
     * fails the token fetch AND the task registration, so these two land
     * together. The no-FCM label must survive: it names the consequence (with
     * no push, alerting genuinely stops when the background keepalive hits its
     * five-minute ceiling rather than handing off), which a generic
     * "unavailable" line does not. An unconditional override would replace the
     * good copy with the vague copy in exactly the case the good copy is for.
     */
    it('keeps the no-FCM label when both halves fail together', () => {
      mockGetPushRegistrationStatus.mockReturnValue('unavailable-no-fcm');
      mockGetBackgroundPushTaskStatus.mockReturnValue('unavailable');
      renderSettings();

      expect(screen.getByText('Remote push: off on this build - brief background alerts only')).toBeTruthy();
      expect(screen.queryByText('Remote push: unavailable on this device')).toBeNull();
    });

    /**
     * iOS never registers the task at all (it is Android-only by design), so
     * 'pending' must read as "nothing to report", not as a failure.
     */
    it('leaves the registration status alone while the task status is pending', () => {
      mockGetPushRegistrationStatus.mockReturnValue('capability-denied');
      mockGetBackgroundPushTaskStatus.mockReturnValue('pending');
      renderSettings();

      expect(screen.getByText('Remote push: not granted by your desktop')).toBeTruthy();
    });

    /**
     * THE STEADY STATE OF EVERY WORKING iOS INSTALL, and the case that pins the
     * override's PRECISION rather than its existence. Registration succeeds
     * while the receive task stays 'pending' forever, because it is only ever
     * registered on Android.
     *
     * The case above cannot catch this: it pairs 'pending' with a registration
     * status that already fails the second half of the guard, so it passes even
     * if the task status were ignored entirely. Loosen the guard from
     * `=== 'unavailable'` to `!== 'registered'` - the obvious simplification -
     * and every other test here still passes while every working iOS user is
     * told push is broken.
     */
    it('reports a registered status on iOS, where the task stays pending forever', () => {
      mockGetPushRegistrationStatus.mockReturnValue('registered');
      mockGetBackgroundPushTaskStatus.mockReturnValue('pending');
      renderSettings();

      expect(screen.getByText('Remote push: registered')).toBeTruthy();
      expect(screen.queryByText('Remote push: unavailable on this device')).toBeNull();
    });
  });
});
