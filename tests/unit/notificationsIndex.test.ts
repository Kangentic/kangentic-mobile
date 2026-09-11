/**
 * initializeNotifications' platform split.
 *
 * registerNotificationTapHandlers and refreshNotificationPermission run on
 * EVERY platform; registerForegroundServiceRunner, registerBackgroundPushTask
 * and createNotificationChannels stay behind `if (Platform.OS !== 'android')
 * return`. This branch moved the first two ABOVE that gate - the function used
 * to return early off Android entirely, which is how iOS ended up with no tap
 * routing and no seeded permission cache on top of never being asked for
 * authorization at all (see connectionManager.ts's own history of that bug).
 * Nothing pinned the split before this file: a regression that pushed either
 * call back below the gate would silently re-break iOS with nothing here to
 * catch it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
vi.mock('react-native', () => ({ Platform: platformMock }));

// Pulled in transitively by index.ts's re-exports (pushKeys, pushIdentity,
// deviceIdentity) even though initializeNotifications never touches them.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));
// Pulled in transitively by index.ts's re-export of pushRegistration.
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(async () => null as unknown),
}));
vi.mock('expo-constants', () => ({ default: {} }));
// Pulled in transitively by index.ts's re-export of localNotifier, which
// imports notifee directly - unmocked, notifee throws at import time with no
// native module present.
vi.mock('@notifee/react-native', () => ({
  default: {
    onForegroundEvent: vi.fn(),
    onBackgroundEvent: vi.fn(),
    displayNotification: vi.fn(async () => 'notification-id'),
    createChannels: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => ({ authorizationStatus: 1 })),
    getNotificationSettings: vi.fn(async () => ({ authorizationStatus: 1 })),
  },
  EventType: { PRESS: 1 },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

const registerNotificationTapHandlersMock = vi.hoisted(() => vi.fn());
vi.mock('@/notifications/tapRouter', () => ({
  registerNotificationTapHandlers: registerNotificationTapHandlersMock,
}));

const refreshNotificationPermissionMock = vi.hoisted(() => vi.fn(async () => true));
const createNotificationChannelsMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/notifications/channels', () => ({
  refreshNotificationPermission: refreshNotificationPermissionMock,
  createNotificationChannels: createNotificationChannelsMock,
  requestNotificationPermission: vi.fn(async () => true),
  openSystemNotificationSettings: vi.fn(async () => undefined),
}));

const registerForegroundServiceRunnerMock = vi.hoisted(() => vi.fn());
const stopOrphanedForegroundServiceAtBootMock = vi.hoisted(() => vi.fn());
vi.mock('@/notifications/foregroundService', () => ({
  registerForegroundServiceRunner: registerForegroundServiceRunnerMock,
  stopOrphanedForegroundServiceAtBoot: stopOrphanedForegroundServiceAtBootMock,
  setConnectedForegroundServiceDesired: vi.fn(),
  reassertConnectedForegroundService: vi.fn(),
}));

const registerBackgroundPushTaskMock = vi.hoisted(() => vi.fn());
vi.mock('@/notifications/backgroundPushTask', () => ({
  registerBackgroundPushTask: registerBackgroundPushTaskMock,
}));

async function loadInitializeNotifications(): Promise<() => void> {
  const { initializeNotifications } = await import('@/notifications');
  return initializeNotifications;
}

describe('initializeNotifications platform split', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'android';
    registerNotificationTapHandlersMock.mockClear();
    refreshNotificationPermissionMock.mockClear();
    createNotificationChannelsMock.mockClear();
    registerForegroundServiceRunnerMock.mockClear();
    stopOrphanedForegroundServiceAtBootMock.mockClear();
    registerBackgroundPushTaskMock.mockClear();
  });

  it('runs all six on Android', async () => {
    const initializeNotifications = await loadInitializeNotifications();

    initializeNotifications();

    expect(registerNotificationTapHandlersMock).toHaveBeenCalledTimes(1);
    expect(refreshNotificationPermissionMock).toHaveBeenCalledTimes(1);
    expect(registerForegroundServiceRunnerMock).toHaveBeenCalledTimes(1);
    // Process start, so nothing can have declared a keepalive yet: a dataSync
    // service alive here was restarted by Android after a process death and has
    // nothing bounding it (MOBILE-3). No in-process flag could detect that, so
    // the sweep is unconditional and this assertion is the only thing pinning it.
    expect(stopOrphanedForegroundServiceAtBootMock).toHaveBeenCalledTimes(1);
    expect(registerBackgroundPushTaskMock).toHaveBeenCalledTimes(1);
    expect(createNotificationChannelsMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The TestFlight bug this split fixes: tap routing and the permission cache
   * seed have to survive the `Platform.OS !== 'android'` gate, while the three
   * genuinely Android-only pieces (notifee channels, the FCM data-message task,
   * the foreground service) stay behind it.
   */
  it('runs only the tap handlers and the permission refresh on iOS, never the three Android-only calls', async () => {
    platformMock.OS = 'ios';
    const initializeNotifications = await loadInitializeNotifications();

    initializeNotifications();

    expect(registerNotificationTapHandlersMock).toHaveBeenCalledTimes(1);
    expect(refreshNotificationPermissionMock).toHaveBeenCalledTimes(1);
    expect(registerForegroundServiceRunnerMock).not.toHaveBeenCalled();
    expect(stopOrphanedForegroundServiceAtBootMock).not.toHaveBeenCalled();
    expect(registerBackgroundPushTaskMock).not.toHaveBeenCalled();
    expect(createNotificationChannelsMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call runs nothing a second time', async () => {
    const initializeNotifications = await loadInitializeNotifications();

    initializeNotifications();
    initializeNotifications();

    expect(registerNotificationTapHandlersMock).toHaveBeenCalledTimes(1);
    expect(refreshNotificationPermissionMock).toHaveBeenCalledTimes(1);
    expect(registerForegroundServiceRunnerMock).toHaveBeenCalledTimes(1);
    expect(stopOrphanedForegroundServiceAtBootMock).toHaveBeenCalledTimes(1);
    expect(registerBackgroundPushTaskMock).toHaveBeenCalledTimes(1);
    expect(createNotificationChannelsMock).toHaveBeenCalledTimes(1);
  });
});
