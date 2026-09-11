import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { bytesToHex } from '@kangentic/protocol';
import { ChannelController, SubscriptionManager, type VerbClient } from '@/channel';
import { DeviceIdentityManager } from '@/pairing/deviceIdentity';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
// Static, unlike the dev-only branches below, because this one ships: it is a
// pure predicate plus a 32-byte constant, and it has to be consulted on every
// open. The heavy half (mockDesktop and its fixtures) stays behind a dynamic
// import so it is not parsed on a launch that never reaches the demo.
import { DEMO_DESKTOP_STATIC, isDemoAnchor } from '@/demo/demoIdentity';
import { setActivePushIdentityPublicKey } from '@/notifications/pushIdentity';
import { notificationPermissionGranted, notificationPermissionStatus } from '@/notifications/permissionCache';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { bindFeedToStores, createSnapshotSinks } from './storeFeed';
import { runBootstrap } from './bootstrap';

// The notifee-backed notification modules (foreground service, local
// notifier, push registration, channels) load lazily: notifee throws at import
// time when its native module is absent (Jest component tests reach this file
// through actions.ts), and the lifecycle only needs them at established/
// background time anyway. pushIdentity and permissionCache stay static - both
// are pure TS, and the permission cache specifically MUST be readable
// synchronously on the background transition (see its own header).

/**
 * The app's one connection lifecycle owner, a module-level singleton
 * following the activePairing.ts pattern: a live ChannelController is a
 * stateful crypto object with a transport, not serializable UI state.
 * Screens read channelStore (which this feeds) and call actions.ts (which
 * reads the active connection from here).
 *
 * Lifecycle policy: connect while the app is foregrounded and paired.
 * On background it depends on settings: with backgroundNotificationsMode
 * 'foreground-service' (Android only), hydrated settings, an established
 * connection, and POST_NOTIFICATIONS not known-denied, the channel stays
 * alive under a notifee foreground service and the local notifier turns
 * activity transitions into notifications - for at most five minutes
 * (BACKGROUND_KEEPALIVE_MAX_MS), after which the service stops and the
 * channel is disposed, handing alerting over to remote push. In every other
 * case ('push-only', 'off', iOS, no established connection, settings not yet
 * hydrated, or a permission the user was asked for and refused) the
 * connection is disposed immediately as before (iOS suspends the socket
 * within seconds anyway, the desktop treats a vanished phone fine - relay
 * close tears its subscriptions down - and remote E2E push covers the
 * away-from-app case). iOS 'inactive' (app switcher, permission dialogs)
 * counts as still-active.
 *
 * This module composes pairing (trust anchor), channel, and stores, so it
 * lives in its own src/connection/ directory: src/channel/ stays a pure
 * protocol layer and src/pairing/ already imports channel, so parking the
 * composer in either would tangle the layering. It carries the same
 * accountless-core discipline as both (see .claude/rules/accountless-core.md).
 */

// Bootstrap retry backoff: 2s, 4s, 8s, ... capped at 30s, while the session
// stays established (see the retry comment inside openConnection).
const BOOTSTRAP_RETRY_BASE_MS = 2000;
const BOOTSTRAP_RETRY_MAX_MS = 30_000;

export interface ActiveConnection {
  controller: ChannelController;
  verbs: VerbClient;
  subscriptions: SubscriptionManager;
}

/**
 * Why a connection is being torn down, expressed as what the desktop is TOLD
 * rather than as a cause - because the causes do not sort cleanly. Unpairing
 * is deliberate and permanent; backgrounding is equally deliberate but the
 * phone intends to come back, and announcing on every foreground/background
 * cycle would flap the desktop's badge. An app kill or a dead network never
 * gets here at all.
 *
 * 'stay-silent' is the default everywhere on purpose: a new call site that
 * forgets to think about this falls back to today's behaviour (the desktop
 * infers departure from the dropped socket), never to a spurious goodbye.
 */
export type ConnectionTeardownIntent = 'announce-departure' | 'stay-silent';

const deviceIdentityManager = new DeviceIdentityManager();
const trustAnchorStore = new TrustAnchorStore();

let appStateSubscription: NativeEventSubscription | null = null;
let activeConnection: ActiveConnection | null = null;
let teardownActiveConnection: ((intent: ConnectionTeardownIntent) => void) | null = null;
let connectGeneration = 0;

export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to the desktop');
    this.name = 'NotConnectedError';
  }
}

export function getActiveConnection(): ActiveConnection | null {
  return activeConnection;
}

/** For action call sites: throws a typed error the UI maps to "reconnect first". */
export function requireVerbClient(): VerbClient {
  if (!activeConnection || !activeConnection.controller.session.isEstablished) throw new NotConnectedError();
  return activeConnection.verbs;
}

export function requireSubscriptions(): SubscriptionManager {
  if (!activeConnection) throw new NotConnectedError();
  return activeConnection.subscriptions;
}

/**
 * Unpairing must leave the old desktop unable to push: send the unregister
 * request while the channel is still up (called from DevicesScreen BEFORE
 * the trust anchor is cleared and the connection torn down), then wipe the
 * local push key so a stale key can never open a future envelope. Lives
 * here (not in the screen) so its dynamic imports follow this module's own
 * lazy-load convention (notifee/expo-notifications throw at import time
 * without their native module, which the Jest component tier hits with no
 * dynamic-import support). Best-effort: a failure here must never block
 * the rest of unpairing.
 */
export async function revokePushRegistrationForUnpair(): Promise<void> {
  // Two independent try blocks on purpose: the local key wipe is the half
  // that actually secures THIS device, so it must not be reachable only
  // when the network unregister succeeds. Sharing one block would let a
  // throw from the import or the verb call skip the wipe entirely and
  // leave a usable push key behind on an unpaired phone.
  try {
    const { unregisterPushWithDesktop } = await import('@/notifications/pushRegistration');
    await unregisterPushWithDesktop(activeConnection?.verbs ?? null);
  } catch {
    // Best-effort; the desktop's own roster revocation is the backstop.
  }
  try {
    const { clearPushRegistration } = await import('@/notifications/pushKeys');
    await clearPushRegistration();
  } catch {
    // Best-effort; see the doc comment above.
  }
}

/**
 * A desktop-side revoke, delivered as the session's Final frame. Final is
 * only ever sent on deliberate unpair - never on quit, sleep, backgrounding,
 * or reconnect (see docs/security.md) - so it is a certain signal: clear the
 * pairing and land the UI on the unpaired home. The push unregister here is
 * LOCAL-only, unlike revokePushRegistrationForUnpair: the desktop that just
 * revoked us has already dropped this device's registration, and the channel
 * an unregister request would ride is being torn down under us.
 */
let remoteRevocationInFlight = false;

async function handleDesktopRevocation(controller: ChannelController): Promise<void> {
  // Two Finals back-to-back would interleave at the awaits without this.
  if (remoteRevocationInFlight) return;
  // A Final racing a local unpair or a background teardown belongs to a
  // connection whose fate was already decided.
  if (activeConnection?.controller !== controller) return;
  remoteRevocationInFlight = true;
  try {
    // Flip the UI first: closeConnection's store reset preserves pairedState,
    // and the reopen re-derives 'unpaired' from the cleared anchor.
    useChannelStore.getState().setPairedState('unpaired');
    try {
      const { clearPushRegistration } = await import('@/notifications/pushKeys');
      await clearPushRegistration();
    } catch {
      // Best-effort, same as revokePushRegistrationForUnpair's local half.
    }
    try {
      const { unpairLocally } = await import('./actions');
      await unpairLocally('stay-silent');
    } catch {
      // A failed Keychain delete leaves a stale anchor behind; the desktop
      // no longer answers it, and Devices still offers a manual unpair.
    }
    try {
      const { router } = await import('expo-router');
      if (router.canDismiss()) router.dismissAll();
      router.navigate('/');
    } catch {
      // Navigator not mounted (a background revoke); the next launch renders
      // the unpaired home on its own.
    }
  } finally {
    remoteRevocationInFlight = false;
  }
}

/**
 * Re-sends the register-push payload after the user changes a category
 * toggle in Settings, so the desktop's filter reflects the new preference
 * immediately rather than waiting for the next reconnect. Fire-and-forget,
 * best-effort, and a no-op while disconnected (the next established
 * bootstrap already sends the current preference set). Lives here for the
 * same lazy-load reason as revokePushRegistrationForUnpair above.
 */
export async function resyncPushRegistrationCategories(): Promise<void> {
  try {
    const { registerPushWithDesktop } = await import('@/notifications/pushRegistration');
    await registerPushWithDesktop(activeConnection?.verbs ?? null);
  } catch {
    // Best-effort; the next established bootstrap retries.
  }
}

/**
 * Every call site invokes this as a bare `void openConnection()`, so a rejection
 * has nowhere to go. That is not merely untidy: `pairedState` starts at 'unknown'
 * and only leaves it inside openConnectionOrThrow, so a throw anywhere before that
 * point strands it at 'unknown' forever. TriageHomeScreen renders the pair CTA only
 * for 'unpaired', which means the user sits on "Connecting to your desktop..."
 * permanently with no error, no retry, and no route to pairing.
 *
 * Found on iOS by the CI simulator smoke test, where a fresh install never offered
 * to pair. Note the sibling bug task #14 fixed independently: a lost bootstrap
 * leaving a PAIRED app on the same screen. Two different paths, one dead end, which
 * is the real lesson - this screen has no state meaning "something failed, here is
 * how to recover".
 *
 * Falling back to 'unpaired' is deliberate over inventing an error state. It is
 * always recoverable (the pair CTA appears, and re-pairing overwrites the anchor),
 * and it is self-correcting: the next foreground calls this again, and a load that
 * now succeeds sets 'paired'. Only the stranded 'unknown' case is rescued; a failure
 * after 'paired' is already covered by the existing reconnect paths.
 */
async function openConnection(): Promise<void> {
  try {
    await openConnectionOrThrow();
  } catch (error: unknown) {
    if (useChannelStore.getState().pairedState === 'unknown') {
      useChannelStore.getState().setPairedState('unpaired');
    }
    if (__DEV__) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`[connection] open failed before the trust anchor resolved (${reason}); showing the pairing CTA`);
    }
  }
}

/**
 * Serializes opens, between the swallowing wrapper above and the work below.
 * performOpenConnection awaits secure storage before it can even tell whether
 * it should proceed, so two callers arriving in that window (the lifecycle's
 * initial connect and an AppState 'active', say) both saw no active connection
 * and both built one. Whichever finished last became `activeConnection` and the
 * other was orphaned while still connected - reconnecting on its own backoff
 * forever and writing its transport state into the shared channel store, which
 * presented as a status flickering between connected and reconnecting on a
 * phone whose session was fine. Concurrent callers now join the attempt already
 * running.
 */
let openAttempt: Promise<void> | null = null;

/**
 * The desktop key pushRegistration's process-global idempotence cache was
 * built against. The unpair flow resets that cache explicitly, but a re-pair
 * that never passes through unpair does not, so a key change observed here
 * must drop it - or the new desktop never receives this device's push key
 * until the next app restart.
 */
let pushRegistrationDesktopKeyHex: string | null = null;

function openConnectionOrThrow(): Promise<void> {
  if (activeConnection) return Promise.resolve();
  if (openAttempt) return openAttempt;
  const attempt = performOpenConnection().finally(() => {
    // Only clear if this attempt is still the current one: closeConnection
    // abandons it deliberately, and a newer attempt may already have taken
    // its place.
    if (openAttempt === attempt) openAttempt = null;
  });
  openAttempt = attempt;
  return attempt;
}

async function performOpenConnection(): Promise<void> {
  if (activeConnection) return;
  const generation = connectGeneration;

  // Dev-only mock desktop (the dev rig's mock mode sets
  // EXPO_PUBLIC_KANGENTIC_MOCK=1): the real channel stack runs against an
  // in-process fake desktop over a loopback transport - no relay, no
  // pairing, no trust anchor. Metro strips this branch and the dynamically
  // imported module from production bundles.
  let mockDesktop: import('./mockDesktop').MockDesktop | null = null;
  if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_MOCK === '1') {
    const { createMockDesktop } = await import('./mockDesktop');
    mockDesktop = createMockDesktop();
  }

  // Dev-only instant pairing (the dev rig's live mode): identity and the
  // pinned desktop key arrive via EXPO_PUBLIC_KANGENTIC_DEV_PAIRING and
  // the SecureStore trust anchor is bypassed entirely. See devPairing.ts.
  let devPairing: import('./devPairing').DevPairing | null = null;
  if (__DEV__ && !mockDesktop && process.env.EXPO_PUBLIC_KANGENTIC_DEV_PAIRING) {
    const { getDevPairing } = await import('./devPairing');
    devPairing = getDevPairing();
  }

  const anchor: { desktopStaticPublicKey: Uint8Array; relayAddress: string } | null = mockDesktop
    ? { desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey, relayAddress: 'loopback://mock-desktop' }
    : devPairing
      ? { desktopStaticPublicKey: devPairing.desktopStaticPublicKey, relayAddress: devPairing.relayAddress }
      : await trustAnchorStore.load();
  if (!anchor) {
    // Not paired (or a partial/legacy anchor): stay idle; the pairing flow
    // triggers a reconnect via reconnectNow() when it completes.
    useChannelStore.getState().setPairedState('unpaired');
    return;
  }

  // The reviewer/demo pairing, and the ONE path here that ships in production.
  //
  // It reaches this point with a real, persisted trust anchor written by a real
  // pairing ceremony, so everything above already treated it as paired - which
  // is the whole design: the demo IS a pairing, just to a peer that lives on
  // this device. All that remains is to route it to the in-process desktop
  // instead of dialing anchor.relayAddress, which is never a reachable relay.
  //
  // Ordered after the anchor load rather than beside the mock branch above
  // because the anchor is what identifies it; there is no env var and no build
  // flag involved. Unlike mock and dev-pairing modes, this branch is NOT
  // __DEV__-gated, so Metro keeps mockDesktop and its fixtures in the release
  // graph. That is deliberate and approved (see the demo module's header and
  // .github/scripts/capture-ios-screenshots.sh).
  if (!mockDesktop && !devPairing && isDemoAnchor(anchor)) {
    const { createMockDesktop } = await import('./mockDesktop');
    mockDesktop = createMockDesktop({
      identity: await deviceIdentityManager.getIdentity(),
      desktopStatic: DEMO_DESKTOP_STATIC,
    });
  }

  const anchorDesktopKeyHex = bytesToHex(anchor.desktopStaticPublicKey);
  if (pushRegistrationDesktopKeyHex !== null && pushRegistrationDesktopKeyHex !== anchorDesktopKeyHex) {
    // Best-effort like every other pushRegistration import in this file: a
    // failure here must degrade to the stale-registration behavior the cache
    // exists to fix, never kill the whole open. Unguarded, it was the ONLY
    // dynamic import in the open path without a catch, and it did kill the
    // open under vitest, where the real import chain reaches expo-constants.
    try {
      const { resetPushRegistrationProcessState } = await import('@/notifications/pushRegistration');
      resetPushRegistrationProcessState();
    } catch {
      // The process cache clears on the next app restart anyway.
    }
  }
  pushRegistrationDesktopKeyHex = anchorDesktopKeyHex;

  useChannelStore.getState().setPairedState('paired');
  const identity = mockDesktop ? mockDesktop.identity : devPairing ? devPairing.identity : await deviceIdentityManager.getIdentity();
  // The AAD every push envelope is sealed against - whichever identity
  // this connection actually pairs under (mock/dev identities included).
  setActivePushIdentityPublicKey(identity.publicKey);
  // A background/dispose (or a second open) raced our secure-store reads.
  if (generation !== connectGeneration || activeConnection) {
    mockDesktop?.dispose();
    return;
  }

  const controller = new ChannelController({
    identity,
    desktopStaticPublicKey: anchor.desktopStaticPublicKey,
    relayUrl: anchor.relayAddress,
    ...(mockDesktop ? { transport: mockDesktop.phoneTransport } : {}),
  });

  // The sinks need the manager back (board snapshots re-declare the stream
  // desired set), so hand them a lazy getter resolved after construction.
  let subscriptionsHolder: SubscriptionManager | null = null;
  const subscriptions: SubscriptionManager = new SubscriptionManager({
    session: controller.session,
    verbs: controller.verbs,
    sinks: createSnapshotSinks((): SubscriptionManager => {
      if (!subscriptionsHolder) throw new Error('SubscriptionManager sink resolved before construction completed');
      return subscriptionsHolder;
    }),
  });
  subscriptionsHolder = subscriptions;

  // Dev-only inspect loop: expose this connection's SubscriptionManager to
  // the state-dump bridge (dynamic import keeps it out of prod bundles).
  let inspectStateModule: typeof import('@/devsupport/inspectState') | null = null;
  if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1') {
    inspectStateModule = await import('@/devsupport/inspectState');
    inspectStateModule.setInspectSubscriptions(subscriptions);
  }

  const unbindFeed = bindFeedToStores(controller.feed, subscriptions);
  const unsubscribeTransportState = controller.transport.onStateChange((state) => {
    useChannelStore.getState().setTransportState(state);
    // The third non-Choreographer wake source, and the one that covers the most
    // likely shape of MOBILE-3: the desktop goes away (a closed laptop), the
    // transport drops and retries on its own backoff forever, and no rekey ever
    // arrives again. Without this the wall-clock ceiling check has nothing left
    // driving it and the service is back to relying on the timer alone.
    //
    // Deferred for the same reason the rekey listener is: this fires inside the
    // transport's own callback, and the teardown disposes that transport.
    queueMicrotask(onKeepaliveWakeSource);
  });

  // Bootstrap must eventually succeed while the session stays established.
  // The first attempt can die silently - the request can be lost in the
  // pairing-to-session transition or time out mid-rekey - and a QUIET rekey
  // never re-fires onEstablished (only a transport drop does), so without
  // this retry one lost bootstrap leaves the app on "Connecting..." with a
  // healthy channel until a manual pull-to-refresh.
  let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let bootstrapGeneration = 0;
  const runBootstrapWithRetry = (attempt: number, generation: number): void => {
    void runBootstrap(controller.verbs, subscriptions).catch((bootstrapError: unknown) => {
      if (generation !== bootstrapGeneration) return;
      if (!controller.session.isEstablished) return;
      const delayMs = Math.min(BOOTSTRAP_RETRY_MAX_MS, BOOTSTRAP_RETRY_BASE_MS * 2 ** attempt);
      if (__DEV__) {
        const reason = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
        console.log(`[bootstrap] attempt ${attempt + 1} failed (${reason}); retrying in ${delayMs}ms`);
      }
      bootstrapRetryTimer = setTimeout(() => runBootstrapWithRetry(attempt + 1, generation), delayMs);
    });
  };

  // The demo pairing must stay networkless: the App Review notes promise it
  // "requires no account, no desktop computer, and no network connection"
  // (docs/store-listing.md), and registerPushWithDesktop starts with
  // getExpoPushTokenAsync - an HTTPS call to Expo's push service - before its
  // request ever reaches the in-process peer. The permission prompt is skipped
  // with it: there is no real desktop behind the demo to push anything.
  const demoConnection = isDemoAnchor(anchor);

  const unsubscribeEstablished = controller.session.onEstablished(() => {
    useChannelStore.getState().markEstablished();
    if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
    bootstrapGeneration += 1;
    runBootstrapWithRetry(0, bootstrapGeneration);
    if (demoConnection) return;
    // Fire-and-forget push registration on every established handshake
    // (idempotent; re-hits the wire only on first run or token rotation).
    // Never fatal: registerPushWithDesktop records a status instead.
    if (useSettingsStore.getState().backgroundNotificationsMode !== 'off') {
      void import('@/notifications/pushRegistration')
        .then(({ registerPushWithDesktop }) => registerPushWithDesktop(controller.verbs))
        .catch(() => {
          // Registration is best-effort; the status surface stays 'pending'.
        });
    }
    maybeRequestNotificationPermission();
  });

  // The only observable that a rekey happened. Streams and subscriptions
  // survive it untouched, so nothing else here reacts.
  //
  // It is also the one thing that reliably runs JS on a backgrounded phone: an
  // inbound relay frame arrives through the bridge's own queue, not through the
  // Choreographer callback every setTimeout depends on. That makes the desktop's
  // ~2 minute rekey the backstop for the keepalive ceiling (MOBILE-3).
  const unsubscribeRekey = controller.session.onRekey(() => {
    useChannelStore.getState().noteRekey();
    // Deferred a microtask for the same reason onRemoteClosed below is: this
    // listener fires inside the session's own frame handling, and hitting the
    // ceiling tears that very session down.
    queueMicrotask(onKeepaliveWakeSource);
  });

  // The desktop's revoke goodbye (see handleDesktopRevocation). Deferred a
  // microtask because this listener fires inside the session's own frame
  // handling, and the revocation handler tears that very session down.
  const unsubscribeRemoteClosed = controller.session.onRemoteClosed(() => {
    queueMicrotask(() => {
      void handleDesktopRevocation(controller);
    });
  });

  const teardownThisAttempt = (intent: ConnectionTeardownIntent): void => {
    inspectStateModule?.setInspectSubscriptions(null);
    bootstrapGeneration += 1;
    if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
    unsubscribeTransportState();
    unsubscribeEstablished();
    unsubscribeRekey();
    unsubscribeRemoteClosed();
    unbindFeed();
    subscriptions.dispose();
    controller.dispose({ sendFinalFrame: intent === 'announce-departure' });
    mockDesktop?.dispose();
  };

  // The generation check at the top of this function guards the awaits BEFORE
  // the controller exists. Everything built since then has to be re-checked
  // here, because there are awaits in between (the inspect module's dynamic
  // import) and a close or a second open can land inside one.
  //
  // Dropping an attempt without this teardown does not leave it inert: its
  // transport is already dialing and reconnects on its own backoff forever,
  // and its onStateChange listener keeps writing into the shared channel
  // store. Two connections then fight over one store - the live one writing
  // 'connected' while the orphan writes 'reconnecting' - which is exactly the
  // status that was seen flickering on a phone whose session was fine. The
  // orphan can never recover either: the relay slot already holds the desktop
  // and the winning connection, so it is refused and loops.
  if (generation !== connectGeneration || activeConnection) {
    // This attempt never reached controller.connect(), so it has no session
    // to say goodbye on - silent by construction, not merely by guard.
    teardownThisAttempt('stay-silent');
    return;
  }

  useChannelStore.getState().setRelayUrl(anchor.relayAddress);
  activeConnection = { controller, verbs: controller.verbs, subscriptions };
  teardownActiveConnection = teardownThisAttempt;

  await controller.connect().catch(() => {
    // The transport keeps retrying with backoff on its own; channelStore
    // already reflects the connecting/reconnecting state.
  });
  // The desktop always initiates the KK handshake; the in-process fake one
  // is no exception.
  await mockDesktop?.start();
}

function closeConnection(intent: ConnectionTeardownIntent = 'stay-silent'): void {
  connectGeneration += 1;
  // Abandon any attempt still in flight rather than letting the next
  // openConnection join it: that attempt is bound to the OLD generation and
  // will bail, so joining it would return a connection that never opens.
  // It still tears itself down on the generation check.
  openAttempt = null;
  teardownActiveConnection?.(intent);
  teardownActiveConnection = null;
  activeConnection = null;
  useChannelStore.getState().reset();
}

/**
 * Ask for the runtime notification permission once, the first time a session
 * actually establishes. BOTH platforms: Android's POST_NOTIFICATIONS and iOS's
 * UNUserNotificationCenter authorization.
 *
 * Establishment IS the paired signal, which is what makes this one rule cover
 * both populations: an install that has been paired for weeks prompts on its
 * first establishment after updating (nothing else would ever reach it again),
 * and a fresh install prompts the moment pairing first connects rather than on
 * a cold first launch before the user knows what the app is.
 *
 * The permission was never requested anywhere before this - the function
 * existed and was exported, but its only callers were tests - so every Android
 * install ran with notifications silently undeliverable. iOS was worse and for
 * longer: this function returned early there, so iOS was NEVER asked, and the
 * failure was invisible because registration still succeeded.
 * getDevicePushTokenAsync only calls registerForRemoteNotifications(), which
 * yields an APNs token with no user authorization whatsoever - so the phone got
 * a token, the desktop sent, APNs delivered, and iOS discarded every alert.
 *
 * onEstablished re-fires on every reconnect, so the persisted flag is what
 * makes this once-ever, and it has to be read from a HYDRATED store:
 * startConnectionLifecycle runs before hydrate() resolves, and an
 * establishment that beats hydration would re-prompt someone who already
 * answered. (A rekey does NOT re-fire it - SessionManager routes an
 * already-established re-handshake to onRekey instead, as the bootstrap-retry
 * comment above also notes.)
 */
let notificationPermissionPromptInFlight = false;

function maybeRequestNotificationPermission(): void {
  // An open system dialog pauses the activity, which Android reports as a
  // background transition. In the modes where that transition closes the
  // channel ('push-only', or settings not yet hydrated) answering the prompt
  // reconnects and re-establishes, and that second onEstablished can land
  // before the persisted flag is written. This guard is what stops the user
  // being asked twice in a row. Under 'foreground-service' the keepalive holds
  // the channel open instead, so the race cannot arise there.
  if (notificationPermissionPromptInFlight) return;
  const settings = useSettingsStore.getState();
  if (!settings.hydrated) return;
  if (settings.backgroundNotificationsMode === 'off') return;
  // The persisted flag is the once-ever gate on Android, and the whole gate:
  // decided synchronously, nothing else to consult.
  //
  // On iOS the flag can OUTLIVE the authorization it describes. Keychain items
  // survive app deletion, so a reinstall starts with the flag still true while
  // iOS has reset authorization to NOT_DETERMINED - that install would never be
  // asked AND would be told in Settings that notifications are blocked. So iOS
  // falls through to ask the OS below instead of trusting the flag.
  const alreadyAsked = settings.hasRequestedNotificationPermission;
  if (alreadyAsked && Platform.OS !== 'ios') return;
  notificationPermissionPromptInFlight = true;
  void import('@/notifications/channels')
    .then(async ({ refreshNotificationPermission, requestNotificationPermission }) => {
      if (alreadyAsked) {
        // iOS only (Android returned above). READ THE OS, do not read the
        // cache: initializeNotifications seeds it fire-and-forget at bundle
        // entry, and nothing orders that against establishment, so a
        // synchronous read here can still be null - which would look like
        // "not not-determined" and silently skip the prompt on exactly the
        // reinstalled device this branch exists for. One extra native read per
        // establishment is the price, and it keeps the cache fresh besides.
        await refreshNotificationPermission();
        if (notificationPermissionStatus() !== 'not-determined') return;
      }
      // A denial resolves false rather than throwing, so the flag is still
      // written: neither platform re-shows the prompt after a refusal anyway
      // (Android stops after two dismissals, iOS asks exactly once ever), and
      // Settings carries the recovery route from there.
      await requestNotificationPermission();
      await useSettingsStore.getState().markNotificationPermissionRequested();
    })
    .catch(() => {
      // Leaving the flag unset retries on the next establishment, which is
      // the right side to fail on: a prompt that never appeared is worse
      // than one offered again.
    })
    .finally(() => {
      notificationPermissionPromptInFlight = false;
    });
}

/**
 * Hard ceiling on the background keepalive.
 *
 * Android 15+ gives a dataSync foreground service a 6h/24h budget
 * and kills the process with ForegroundServiceDidNotStopInTimeException when it
 * overruns; notifee 9.1.8 exposes no Service.onTimeout hook, so there is no
 * signal to react to and this timer is the only bound in the stack.
 *
 * It also bounds process LIFETIME, which is how it bears on the REACT-NATIVE-5
 * OOM. Do not read that as "the background path leaks": four measured probes
 * say it does not (see the developer guide). What an unbounded service did was
 * hold the process resident for hours, so ordinary FOREGROUND accumulation - a
 * session screen leaking a WebView per open - was never reset by an OS kill.
 * The ceiling makes the process reapable again; fixing the unmount is the
 * actual repair.
 *
 * Five minutes covers the case the keepalive is actually for - switched apps
 * for a moment. Anything longer is remote push's job, and push covers the same
 * alert categories: the desktop suppresses its own push only while this phone's
 * channel is established, so tearing the channel down hands alerting over
 * rather than dropping it.
 *
 * CORRECTION (MOBILE-3, which recurred on a build that already had this bound).
 * This comment used to reassure that exhausting the budget "would take 72
 * separate background stretches, each running the full five minutes, inside one
 * 24h window". That arithmetic answers a question which cannot arise. Android
 * resets the 6h counter whenever the user brings the app to the foreground, and
 * startBackgroundKeepalive has exactly one caller - the 'background' transition,
 * gated on an established connection, which needs an openConnection from
 * 'active'. So every new window is preceded by a foreground visit that resets
 * the counter, and accumulation across stretches is unreachable.
 *
 * The real constraint is stricter and different: overrunning needs ONE unbroken
 * ~6 hour background stretch in which the service never stopped. Both crash
 * events are exactly that - backgrounded with no foreground afterwards, and the
 * process still alive 7h10m and 14h14m later. So what matters is not how many
 * windows are armed, it is that a single window's teardown always lands. Which
 * is why the ceiling is now enforced two ways: this timer, and a wall-clock
 * check on wake sources that are not Choreographer-driven (see
 * enforceKeepaliveCeiling).
 */
const BACKGROUND_KEEPALIVE_MAX_MS = 5 * 60_000;

let stopLocalNotifier: (() => void) | null = null;
let backgroundKeepaliveActive = false;
let keepaliveGeneration = 0;
let keepaliveCeilingTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveStartedAtMs = 0;

/** Foreground service + local notifier while backgrounded with the channel alive (Android, mode 'foreground-service'). */
function startBackgroundKeepalive(): void {
  if (backgroundKeepaliveActive) return;
  backgroundKeepaliveActive = true;
  keepaliveGeneration += 1;
  keepaliveStartedAtMs = Date.now();
  const generation = keepaliveGeneration;
  keepaliveCeilingTimer = setTimeout(() => {
    keepaliveCeilingTimer = null;
    if (generation !== keepaliveGeneration) return;
    enforceKeepaliveCeiling();
  }, BACKGROUND_KEEPALIVE_MAX_MS);
  void import('@/notifications/foregroundService')
    .then(({ setConnectedForegroundServiceDesired }) => {
      // A foreground bounce can beat the import; never start a stale service.
      if (generation !== keepaliveGeneration) return;
      setConnectedForegroundServiceDesired(true);
    })
    .catch(() => {
      // Only the module import can reject here: the declaration itself is
      // synchronous and does not throw. A notification that fails to post
      // (permission denied) is caught and reasoned about inside the reconcile
      // loop, which is the only place that awaits the native call.
    });
  void import('@/notifications/localNotifier')
    .then(({ startLocalNotifier }) => {
      if (generation !== keepaliveGeneration) return;
      stopLocalNotifier = startLocalNotifier();
    })
    .catch(() => {
      // Without the notifier the channel still stays alive; store state
      // simply surfaces on the next foreground instead.
    });
}

function stopBackgroundKeepalive(): void {
  // Before the early return: a timer with no active keepalive behind it is
  // exactly the state worth clearing, not one worth skipping.
  if (keepaliveCeilingTimer) {
    clearTimeout(keepaliveCeilingTimer);
    keepaliveCeilingTimer = null;
  }
  if (!backgroundKeepaliveActive) return;
  backgroundKeepaliveActive = false;
  keepaliveGeneration += 1;
  stopLocalNotifier?.();
  stopLocalNotifier = null;
  void import('@/notifications/foregroundService')
    .then(({ setConnectedForegroundServiceDesired }) => setConnectedForegroundServiceDesired(false))
    .catch(() => {
      // Only the module import can reject here. The stop itself is retried by
      // the reconciler and stays owed until it lands - it is not swallowed,
      // which is how MOBILE-3 outlived this bound in the first place.
    });
}

/**
 * The ceiling, checked against the wall clock instead of trusted to a timer.
 *
 * RN services every setTimeout from a Choreographer frame callback (INFERRED
 * from RN's JSTimers/Timing internals, not measured on a device), so a JS timer
 * is only as reliable as frame delivery. Rather than settle what that does on a
 * locked phone, the ceiling is enforced from the two wake sources that reach JS
 * by another route: an inbound relay frame (the desktop rekeys roughly every
 * two minutes) and a transport state change. Worst case the service lives for
 * the ceiling plus one rekey interval instead of forever.
 *
 * Deliberately NOT an AppState transition, though onAppStateChange does drive
 * the other half of the recovery (reassertForegroundServiceState). A ceiling
 * check there would be dead code: the only transition that can arrive with the
 * keepalive still armed is 'active', and that branch already stops the
 * keepalive outright, ceiling or no ceiling.
 *
 * Order is load-bearing: stop THEN close. closeConnection() does not stop the
 * keepalive, so closing first would leave the foreground-service notification
 * posted with no channel behind it.
 */
function enforceKeepaliveCeiling(): void {
  if (!backgroundKeepaliveActive) return;
  if (Date.now() - keepaliveStartedAtMs < BACKGROUND_KEEPALIVE_MAX_MS) return;
  stopBackgroundKeepalive();
  closeConnection();
}

/**
 * Both halves of the recovery, for a wake source that is not a JS timer:
 * retire an expired keepalive, and re-issue a native stop the reconciler still
 * owes. The second is a no-op unless a previous stop failed outright.
 */
function onKeepaliveWakeSource(): void {
  enforceKeepaliveCeiling();
  reassertForegroundServiceState();
}

function reassertForegroundServiceState(): void {
  if (Platform.OS !== 'android') return;
  void import('@/notifications/foregroundService')
    .then(({ reassertConnectedForegroundService }) => reassertConnectedForegroundService())
    .catch(() => {
      // Nothing outstanding to retry, or the module is unavailable.
    });
}

function onAppStateChange(status: AppStateStatus): void {
  // Before the branches, and that order is load-bearing. A stop the reconciler
  // still owes has to be retried on every transition, and the 'active' branch
  // below cannot do it: stopBackgroundKeepalive returns early when the keepalive
  // is already inactive, which is exactly the state a failed stop leaves behind.
  reassertForegroundServiceState();
  if (status === 'active') {
    stopBackgroundKeepalive();
    void openConnection();
    // Keeps the permission cache current: the user can revoke the permission
    // from system settings at any time, and returning to the app is the only
    // moment we get to notice.
    //
    // CROSS-PLATFORM, deliberately. This was Android-only on the reasoning that
    // nothing on iOS read the cache and that refreshing there would drag notifee
    // into the iOS graph for nothing. Both halves stopped being true: the
    // Settings blocked-notice seeds itself from this cache synchronously on
    // mount on BOTH platforms, and initializeNotifications now seeds it on both
    // too, so notifee is already in the iOS graph. Leaving iOS out meant a
    // revoked authorization went unnoticed until the next establishment - and
    // never at all in 'off' mode, which returns before reaching any refresh -
    // so Settings could still show a stale "granted" and hide the very notice
    // that exists to explain the silence.
    void import('@/notifications/channels')
      .then(({ refreshNotificationPermission }) => refreshNotificationPermission())
      .catch(() => {
        // Cache keeps its previous value; the gate fails open either way.
      });
  } else if (status === 'background') {
    const settings = useSettingsStore.getState();
    const hasEstablishedConnection = activeConnection?.controller.session.isEstablished === true;
    // hydrated matters: startConnectionLifecycle runs before hydrate()
    // resolves, so an early background would otherwise read the in-memory
    // 'foreground-service' default and start a service a 'push-only' user
    // turned off. Unhydrated falls through to closeConnection, the safe side.
    //
    // A denied permission means the local notifier can display nothing, so the
    // service would burn the dataSync budget to deliver nothing at all.
    //
    // "Denied" has to mean ASKED AND REFUSED, which the cache alone cannot say:
    // Android has no NOT_DETERMINED status (notifee reports only DENIED or
    // AUTHORIZED there), so a permission nobody has requested yet reads exactly
    // like one the user refused. initializeNotifications seeds the cache at
    // boot, so on a never-granted install it holds `false` long before the
    // prompt fires - and gating on the cache alone would withdraw the keepalive
    // from every install that has not answered yet, which before this change
    // had it. The persisted flag is the only record of whether we ever asked.
    const notificationsKnownDenied =
      settings.hasRequestedNotificationPermission && notificationPermissionGranted() === false;
    const wantsKeepalive =
      Platform.OS === 'android' &&
      settings.hydrated &&
      settings.backgroundNotificationsMode === 'foreground-service' &&
      hasEstablishedConnection &&
      !notificationsKnownDenied;
    if (wantsKeepalive) {
      startBackgroundKeepalive();
    } else {
      closeConnection();
    }
  }
  // 'inactive' (iOS app switcher / permission dialog) is still-active.
}

/** Idempotent; called once from the root layout. */
export function startConnectionLifecycle(): void {
  if (appStateSubscription) return;
  // Dev-only inspect loop: the bridge dials the local inspect server once
  // per app boot and survives connection churn (it reads stores, not the
  // connection). Dynamic import keeps it out of prod bundles.
  if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1') {
    void import('@/devsupport/inspectBridge').then(({ startInspectBridge }) => startInspectBridge());
  }
  appStateSubscription = AppState.addEventListener('change', onAppStateChange);
  if (AppState.currentState === 'active' || AppState.currentState === 'unknown') void openConnection();
}

export function stopConnectionLifecycle(): void {
  appStateSubscription?.remove();
  appStateSubscription = null;
  stopBackgroundKeepalive();
  closeConnection();
}

/**
 * For the pairing flow: pick up a freshly saved trust anchor without an app
 * restart. Callers reacting to a CHANGED trust context (unpair, a completed
 * pairing) must call actions.ts's wipeDesktopContent() first - this only
 * swaps the connection, it does not clear the previous desktop's content.
 *
 * The intent describes the CLOSE half only, not the reopen that always
 * follows - 'announce-departure' tells the OLD desktop this phone is
 * deliberately leaving it, which is exactly unpair's situation.
 */
export function reconnectNow(intent: ConnectionTeardownIntent = 'stay-silent'): void {
  // closeConnection() does not own the keepalive, so this has to. Without it a
  // ceiling timer armed by an earlier background would still be holding the OLD
  // generation, and would fire against the connection opened just below - a
  // teardown of a live foreground session five minutes later.
  //
  // This is load-bearing, not merely defensive, and the comment used to say
  // otherwise ("today's callers are all foreground taps"). They are not:
  // handleDesktopRevocation reaches here through unpairLocally, and a revoke
  // goodbye is an inbound relay frame - which is precisely the thing that DOES
  // run JS on a backgrounded phone, the same premise the keepalive ceiling's
  // rekey wake source rests on. So a revocation can arrive with the keepalive
  // live, and this line is what retires it.
  stopBackgroundKeepalive();
  closeConnection(intent);
  void openConnection();
}
