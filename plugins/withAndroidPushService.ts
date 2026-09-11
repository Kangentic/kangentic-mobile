// '@expo/config-plugins', not 'expo/config-plugins': the latter subpath does not
// exist in SDK 57 (verified against expo@57.0.4 and 57.0.8, neither has the
// export). `expo prebuild` resolved it anyway through Expo CLI's own loader,
// which is why CI stayed green, but `eas build` imports this file as plain Node
// ESM and strictly honours package exports, so an iOS build failed with
// ERR_MODULE_NOT_FOUND while every Android prebuild passed.
import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from '@expo/config-plugins';

/**
 * Android manifest additions for the notification stack (CNG: never
 * hand-edit android/):
 * - POST_NOTIFICATIONS (Android 13+ runtime permission; requested in-app on
 *   the first session establishment, see connectionManager's
 *   maybeRequestNotificationPermission. Declaring it here does NOT request it,
 *   and for a while nothing did: the request function existed with no caller
 *   but tests, so every install ran with notifications undeliverable.)
 * - FOREGROUND_SERVICE + FOREGROUND_SERVICE_DATA_SYNC (the background
 *   "stay connected" service that keeps the secure channel alive). That service
 *   is bounded to five minutes per background stretch, but nothing here
 *   enforces it, and the bound has two halves in two files:
 *   BACKGROUND_KEEPALIVE_MAX_MS in connectionManager.ts decides WHEN to stop
 *   (a timer plus a wall-clock check, since a JS timer alone did not hold -
 *   see MOBILE-3), and foregroundService.ts owns whether the stop actually
 *   LANDS. Declaring the permission grants no time budget of its own.
 * - foregroundServiceType="dataSync" on notifee's foreground service
 *   (mandatory on Android 14+: an FGS must declare its type or crash at
 *   startForeground time)
 */
const PUSH_PERMISSIONS = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
];

const NOTIFEE_FOREGROUND_SERVICE = 'app.notifee.core.ForegroundService';

const withAndroidPushService: ConfigPlugin = (config) => {
  return withAndroidManifest(config, (manifestConfig) => {
    const androidManifest = manifestConfig.modResults;

    for (const permission of PUSH_PERMISSIONS) {
      AndroidConfig.Permissions.addPermission(androidManifest, permission);
    }

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
    const services = application.service ?? [];
    const existingService = services.find(
      (service) => service.$?.['android:name'] === NOTIFEE_FOREGROUND_SERVICE,
    );
    if (existingService) {
      existingService.$['android:foregroundServiceType'] = 'dataSync';
    } else {
      services.push({
        $: {
          'android:name': NOTIFEE_FOREGROUND_SERVICE,
          'android:foregroundServiceType': 'dataSync',
        },
      });
    }
    application.service = services;

    return manifestConfig;
  });
};

export default withAndroidPushService;
