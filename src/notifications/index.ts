import { Platform } from 'react-native';
import { createNotificationChannels, refreshNotificationPermission } from './channels';
import { registerBackgroundPushTask } from './backgroundPushTask';
import { registerForegroundServiceRunner, stopOrphanedForegroundServiceAtBoot } from './foregroundService';
import { registerNotificationTapHandlers } from './tapRouter';

export { openSystemNotificationSettings, refreshNotificationPermission, requestNotificationPermission } from './channels';
export {
  notificationPermissionGranted,
  notificationPermissionStatus,
  type NotificationPermissionStatus,
} from './permissionCache';
export { getBackgroundPushTaskStatus, type BackgroundPushTaskStatus } from './backgroundPushTask';
export { decryptPushBlob, PUSH_PLACEHOLDER_BODY, PUSH_PLACEHOLDER_TITLE, type DecryptedPushNotification } from './pushDecrypt';
export { setActivePushIdentityPublicKey } from './pushIdentity';
export {
  getPushRegistrationStatus,
  registerPushWithDesktop,
  unregisterPushWithDesktop,
  type PushRegistrarVerbs,
  type PushRegistrationStatus,
} from './pushRegistration';
export { clearPushRegistration } from './pushKeys';
export { startLocalNotifier } from './localNotifier';
export {
  reassertConnectedForegroundService,
  setConnectedForegroundServiceDesired,
} from './foregroundService';

let initialized = false;

/**
 * One-shot notification bootstrap, called from index.js at bundle-entry
 * scope (so the notifee background handler and the expo background task
 * are registered outside React, including in headless killed-app task
 * launches) and defensively from the root layout.
 *
 * Split by what is ACTUALLY Android-only rather than gating the lot. This
 * whole function used to return early off Android, which is how iOS ended up
 * with no permission state and no tap routing on top of never being asked for
 * authorization at all. Tap routing is cross-platform (see tapRouter), and the
 * permission cache is what Settings reads to tell an iOS user their
 * notifications are blocked.
 *
 * Still Android-only, by nature: notifee channels (an Android concept), the
 * FCM data-message task, and the foreground service. Rich iOS notification
 * CONTENT still needs the Notification Service Extension, which is a separate
 * slice - until it ships, an iOS push renders as the generic placeholder.
 */
export function initializeNotifications(): void {
  if (initialized) return;
  initialized = true;
  registerNotificationTapHandlers();
  // Seeds the permission cache. Read synchronously by the background-keepalive
  // gate (Android) and by the Settings blocked-notice (both platforms).
  // Refreshed again on every foreground.
  void refreshNotificationPermission().catch(() => {
    // Leaves the cache at null, which the gate treats as "unknown", not
    // "denied" - a failed read must not disable the keepalive.
  });
  if (Platform.OS !== 'android') return;
  registerForegroundServiceRunner();
  // Process start, so nothing can have declared a keepalive yet: any dataSync
  // service alive right now was restarted by Android after a process death and
  // has nothing bounding it. That is one of the ways MOBILE-3 reaches its 6h
  // budget, and no in-process flag could ever see it.
  stopOrphanedForegroundServiceAtBoot();
  registerBackgroundPushTask();
  void createNotificationChannels().catch(() => {
    // Channel creation failing (no notification permission model applies
    // to channels, so this is exotic) must never block boot.
  });
}
