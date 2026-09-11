/**
 * Covers plugins/withAndroidPushService.ts, the Android half of the notification
 * manifest: the three permissions and the foregroundServiceType on notifee's
 * service.
 *
 * It had no test at all, while the iOS extension's entitlement ORDER is pinned
 * on the other platform. The gap that matters is the service TYPE. Android 14+
 * requires an FGS to declare a type and crashes at startForeground when the
 * manifest and the runtime call disagree, and the runtime half lives in a
 * different file and a different language layer entirely
 * (AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC in
 * src/notifications/foregroundService.ts). Nothing connected the two, so a
 * rename on either side produced a green repo and a crash on launch. The
 * agreement test at the bottom is the point of this file.
 *
 * `expo prebuild --platform android` runs this plugin in CI but asserts nothing
 * about what came out of it, which is why the mutation is invisible there too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AndroidConfig } from '@expo/config-plugins';
import { describe, expect, it } from 'vitest';

import {
  FOREGROUND_SERVICE_TYPE,
  NOTIFEE_FOREGROUND_SERVICE,
  PUSH_PERMISSIONS,
  applyPushServiceManifest,
} from '../../plugins/withAndroidPushService';

/** @expo/config-plugins does not export this one, so derive it rather than restate it. */
type ManifestService = NonNullable<AndroidConfig.Manifest.ManifestApplication['service']>[number];

/** The shape prebuild hands the plugin, trimmed to what it reads. */
function createManifest(services: ManifestService[] = []): AndroidConfig.Manifest.AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      'uses-permission': [],
      queries: [],
      application: [{ $: { 'android:name': '.MainApplication' }, service: services }],
    },
  };
}

function permissionNames(manifest: AndroidConfig.Manifest.AndroidManifest): string[] {
  return (manifest.manifest['uses-permission'] ?? []).map((entry) => entry.$['android:name']);
}

function notifeeService(
  manifest: AndroidConfig.Manifest.AndroidManifest,
): ManifestService | undefined {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  return (application.service ?? []).find(
    (service) => service.$?.['android:name'] === NOTIFEE_FOREGROUND_SERVICE,
  );
}

describe('withAndroidPushService manifest', () => {
  it('declares the three permissions the notification stack needs', () => {
    const manifest = applyPushServiceManifest(createManifest());

    // Named individually rather than compared against PUSH_PERMISSIONS: looping
    // the constant would pass whatever the constant says, so dropping an entry
    // from it would stay green - the same reasoning the keepalive ceiling is
    // held as a literal for.
    expect(permissionNames(manifest)).toEqual(
      expect.arrayContaining([
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      ]),
    );
  });

  it('adds notifee\'s service with its type when the manifest has none', () => {
    const manifest = applyPushServiceManifest(createManifest());

    expect(notifeeService(manifest)?.$['android:foregroundServiceType']).toBe('dataSync');
  });

  it('sets the type on an existing service entry rather than duplicating it', () => {
    // What prebuild actually produces: notifee's own manifest merge contributes
    // the service without a type, and this plugin has to amend it in place. A
    // second <service> for the same class is a manifest merge failure.
    const manifest = applyPushServiceManifest(
      createManifest([{ $: { 'android:name': NOTIFEE_FOREGROUND_SERVICE } }]),
    );

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const notifeeEntries = (application.service ?? []).filter(
      (service) => service.$?.['android:name'] === NOTIFEE_FOREGROUND_SERVICE,
    );
    expect(notifeeEntries).toHaveLength(1);
    expect(notifeeEntries[0].$['android:foregroundServiceType']).toBe('dataSync');
  });

  it('is idempotent, because prebuild can run over its own output', () => {
    const manifest = applyPushServiceManifest(applyPushServiceManifest(createManifest()));

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    expect(application.service).toHaveLength(1);
    expect(permissionNames(manifest).filter((name) => name === 'android.permission.FOREGROUND_SERVICE')).toHaveLength(1);
  });

  it('declares the same service type the runtime asks notifee for', () => {
    // THE assertion this file exists for. Android 14+ crashes at
    // startForeground when the manifest type and the displayNotification type
    // disagree, and the two live in different files with nothing linking them.
    //
    // Read as TEXT, not by importing notifee: the package ships untranspiled RN
    // source and blows up in this tier ("Unexpected token 'typeof'"). Mocking it
    // instead would assert the mock. Reading the runtime file from disk is the
    // same technique iosNotificationServiceExtension.test.ts uses for the
    // entitlements, and a rename on either side still breaks it.
    const runtime = readFileSync(
      join(__dirname, '..', '..', 'src', 'notifications', 'foregroundService.ts'),
      'utf8',
    );

    expect(FOREGROUND_SERVICE_TYPE).toBe('dataSync');
    expect(runtime).toContain('FOREGROUND_SERVICE_TYPE_DATA_SYNC');
    // And the permission that grants it, which Android requires by name.
    expect(PUSH_PERMISSIONS).toContain('android.permission.FOREGROUND_SERVICE_DATA_SYNC');
  });
});
