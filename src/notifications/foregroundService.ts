import notifee, { AndroidForegroundServiceType } from '@notifee/react-native';
import { ANDROID_NOTIFICATION_PRESENTATION, CONNECTION_CHANNEL_ID } from './channels';

/**
 * The Android "stay connected" foreground service: a LOW-importance
 * ongoing notification that lets the process keep the relay socket and
 * Noise session alive while backgrounded (backgroundNotificationsMode
 * 'foreground-service'). The service type is dataSync, matching the
 * manifest declaration in plugins/withAndroidPushService.ts (Android 14+
 * requires the two to agree or startForeground crashes).
 *
 * This module owns the NATIVE state, and callers only ever declare what they
 * want. That split is the repair for MOBILE-3. The previous shape exported a
 * bare start and a bare stop, and connectionManager called them through two
 * independent dynamic imports with no ordering between them, so a
 * background -> active -> background bounce could resolve the start's
 * `displayNotification` AFTER the stop had already run: a live dataSync
 * service with no ceiling timer behind it and JS believing it was stopped. A
 * stop that then failed was swallowed, leaving the same orphan. Both crash
 * events show the consequence - the app backgrounded, never returned, and the
 * process was still alive 7 and 14 hours later.
 *
 * So: one desired state, one serialized reconcile loop, and a stop that is
 * retried rather than swallowed. Start and stop cannot interleave because the
 * loop only ever has one native call in flight.
 */

const CONNECTION_NOTIFICATION_ID = 'kangentic-connection';

/**
 * Immediate retries, deliberately with no delay between them. A backoff would
 * need setTimeout, and a starved JS timer is one of the things this module has
 * to survive - see connectionManager's BACKGROUND_KEEPALIVE_MAX_MS. A stop that
 * fails all of these stays owed: the next reassert from a wake source that is
 * not Choreographer-driven picks it up.
 */
const STOP_ATTEMPTS = 3;

let runnerRegistered = false;
let resolveServiceRunner: (() => void) | null = null;

let desiredRunning = false;
/**
 * Bumped by every declaration, so every call is honoured with a real native
 * call rather than being skipped as "already in that state". The service can
 * stop existing without JS hearing about it (a process restart, an OS kill),
 * and an in-process boolean could never notice.
 */
let desiredSequence = 0;
let appliedSequence = 0;
/** Set when a stop exhausted its attempts, so the work stays owed rather than lost. */
let stopFailed = false;
let reconciling: Promise<void> | null = null;

/**
 * Must run at module/boot scope before the first desired-true declaration:
 * notifee requires the long-running task to be registered before the service
 * notification is displayed. The returned promise resolving is what actually
 * lets notifee's headless JS task finish, so the resolver is parked until the
 * stop.
 */
export function registerForegroundServiceRunner(): void {
  if (runnerRegistered) return;
  runnerRegistered = true;
  notifee.registerForegroundService(
    () =>
      new Promise<void>((resolve) => {
        // notifee invokes the runner once per service start, and the resolver
        // lives in a single module slot. A previous invocation whose resolver
        // was never called leaves its headless JS task parked forever, and RN
        // keeps servicing timers only while a headless task is active - so a
        // stranded one quietly changes the timer behaviour of the whole app.
        // Release it before parking the new one.
        resolveServiceRunner?.();
        if (!desiredRunning) {
          // This invocation belongs to a service nothing asked for: Android
          // restarted one after a process death, and the boot sweep is about to
          // stop it (or already has). Parking here would strand the headless
          // task against a service that no longer exists.
          resolve();
          resolveServiceRunner = null;
          return;
        }
        resolveServiceRunner = resolve;
      }),
  );
}

/**
 * Declare whether the connection foreground service should be running. Safe to
 * call repeatedly and in any order; the reconcile loop applies declarations in
 * the order they arrive, one native call at a time.
 */
export function setConnectedForegroundServiceDesired(running: boolean): void {
  desiredRunning = running;
  desiredSequence += 1;
  stopFailed = false;
  kickReconcileLoop();
}

/**
 * Re-run any native call the last declaration still owes. A no-op when there is
 * nothing outstanding, which is the normal case.
 *
 * The point is the abnormal case: a stop that failed every attempt stays owed,
 * and this is how it gets retried from a wake source that does not depend on a
 * JS timer (an inbound relay frame, an AppState transition).
 *
 * KNOWN GAP, stated rather than papered over. Hitting the ceiling closes the
 * channel, so after a failed stop there are no more rekeys and the only wake
 * source left is the user returning to the app. If that never happens the stop
 * stays owed until the next process start, where stopOrphanedForegroundServiceAtBoot
 * catches it. Closing that properly needs a native alarm (an AlarmManager-backed
 * notifee trigger), which is deliberately not built until a device probe shows
 * it is needed.
 */
export function reassertConnectedForegroundService(): void {
  if (!stopFailed) return;
  stopFailed = false;
  kickReconcileLoop();
}

/**
 * One unconditional stop at process start, before anything can have declared a
 * desired state. Android can restart a foreground service after a process death
 * with nothing in JS tracking it, and no in-process flag could ever detect
 * that; notifee's stopForegroundService is an unconditional native call, so
 * issuing it once costs nothing when there is no service to stop.
 */
export function stopOrphanedForegroundServiceAtBoot(): void {
  // Through the same stop the reconciler uses, not a bare native call: that one
  // also releases a parked runner resolver, so the headless task cannot outlive
  // the service it belongs to.
  void stopConnectedForegroundService().catch(() => {
    // Nothing was running, or notifee is not ready yet. Either way the normal
    // keepalive path owns the service from here.
  });
}

function hasOutstandingWork(): boolean {
  return appliedSequence !== desiredSequence;
}

function kickReconcileLoop(): void {
  if (reconciling) return;
  reconciling = runReconcileLoop().finally(() => {
    reconciling = null;
    // A declaration that arrived while the loop was winding down would
    // otherwise be lost: its kick saw a non-null `reconciling`, and the loop
    // had already made its last pass. That window is a microtask wide and it
    // swallowed the very first keepalive start.
    if (hasOutstandingWork() && !stopFailed) kickReconcileLoop();
  });
}

async function runReconcileLoop(): Promise<void> {
  while (hasOutstandingWork()) {
    const sequence = desiredSequence;
    const shouldRun = desiredRunning;
    if (shouldRun) {
      // Marked applied before the await on purpose: once displayNotification
      // has been issued the service may exist, so a later stop is owed whether
      // or not this call resolves.
      appliedSequence = sequence;
      try {
        await startConnectedForegroundService();
      } catch {
        // The service notification failing to post (permission denied) leaves
        // a plain background socket; the OS may reap it sooner, nothing worse.
      }
      continue;
    }
    if (await attemptStop()) {
      appliedSequence = sequence;
      continue;
    }
    // Every attempt failed. Leave the stop owed so reassert retries it, and
    // leave the loop rather than spinning against a native call that is not
    // currently working.
    stopFailed = true;
    return;
  }
}

async function attemptStop(): Promise<boolean> {
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    try {
      await stopConnectedForegroundService();
      return true;
    } catch {
      // Retried below; the last failure falls through to the caller.
    }
  }
  return false;
}

async function startConnectedForegroundService(): Promise<void> {
  await notifee.displayNotification({
    id: CONNECTION_NOTIFICATION_ID,
    title: 'Connected to your desktop',
    body: 'Keeping the secure channel alive for instant alerts.',
    android: {
      ...ANDROID_NOTIFICATION_PRESENTATION,
      channelId: CONNECTION_CHANNEL_ID,
      asForegroundService: true,
      ongoing: true,
      foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
      pressAction: { id: 'default', launchActivity: 'default' },
    },
  });
}

async function stopConnectedForegroundService(): Promise<void> {
  // Order is load-bearing: resolving the runner is what lets notifee's headless
  // JS task finish, and stopForegroundService is what tears the service down.
  resolveServiceRunner?.();
  resolveServiceRunner = null;
  await notifee.stopForegroundService();
}
