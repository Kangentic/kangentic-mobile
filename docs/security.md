# Security

Kangentic Mobile pairs to, and then remotely steers, agent sessions running on a desktop machine
that can edit code and execute commands. This document is the threat model and the security
design; an auditable core is treated as a feature, not a nice-to-have. See
[SECURITY.md](../SECURITY.md) for how to report a vulnerability.

## Threat model

**Assets:** the device identity key (X25519, per device), the pairing token, the signed device
roster, and transcript/board content in transit.

**Adversaries:**
- A network attacker who can observe or inject traffic to and from the relay.
- A malicious or compromised relay operator (including a self-hosted relay run by an untrusted
  third party, or Kangentic's own hosted relay if it were ever compromised).
- An attacker who photographs or otherwise captures the pairing QR code.
- An attacker with physical access to a lost or stolen phone.

**Blast radius:** the channel this app establishes can steer an agent that edits code and runs
commands on the paired desktop. A compromise here is not "read someone's chat", it is closer to
a remote-access compromise, and the design is held to that bar.

## Pairing ceremony

The desktop displays a QR code; the phone scans it. The QR carries the desktop's static public
key, a short-lived (~10 minute) single-use pairing token, a relay address, and a protocol
version. It never carries a long-lived secret (this is the mistake in Happy's `handy://` QR
scheme, which embeds the raw 32-byte master secret).

**This is a token-bound Noise PSK, deliberately NOT a PAKE.** The pairing token is a high-entropy
(>=128-bit), single-use, machine-generated value, mixed into the Noise handshake as a pre-shared
key in PSK mode. A PAKE (SPAKE2, CPace) exists to defend a *low-entropy, human-typed* code
against offline dictionary grinding; that property is irrelevant here because the token is
already high-entropy and scanned, not typed. Reusing the token as a Noise PSK gives the same
practical guarantee a PAKE would (an attacker who intercepts the pairing traffic gets exactly one
online guess, gated by the relay, and nothing to grind offline), while keeping exactly one
audited crypto primitive (Noise) across both pairing and ongoing sessions, and without depending
on a maintained, audited JavaScript SPAKE2 implementation (none currently exists; the one
published package is years-stale, targets an old draft, and is Node-only, which would also break
React Native parity). If a human-typeable short-code pairing path is ever added, a PAKE becomes
relevant again and should be revisited at that time.

## SAS confirmation

After the handshake, both sides derive a **Short Authentication String** (a 6-digit or emoji
code, Matrix-style) from the transcript hash, using commitment-before-reveal so neither side can
choose a value after seeing the other's. The user confirms the two codes match on both screens.
This defeats a photographed or relayed QR: an attacker who intercepts the QR and races to pair
first cannot also make both SAS values agree, because the SAS is bound to the actual handshake
transcript with the real desktop.

## Transport

Every session runs a fresh **Noise KK** handshake
(`Noise_KK_25519_ChaChaPoly_BLAKE2s`): both static keys are pre-messages exchanged during
pairing, so there is mutual authentication by construction and neither identity is ever sent on
the wire.

- **Downgrade protection:** the protocol version is bound into the Noise prologue; a mismatched
  prologue fails the handshake rather than silently negotiating down.
- **No state-changing command in the first payload:** Noise KK message 1 is replayable
  pre-ephemeral, so nothing that changes state may ride it.
- **Rekeying:** sessions rekey roughly every 2 minutes (WireGuard's `REKEY_AFTER_TIME`), bounding
  the damage of a compromised session key.
- **Replay protection:** per-direction 64-bit counter nonces reject anything at or below the last
  seen value.
- **A goodbye is a courtesy, not a proof.** A `FrameTag.Final`-tagged frame is only ever sent on
  a deliberate unpair - the phone's own Unpair button, or the desktop revoking the device - and
  never on quit, sleep, backgrounding, or reconnect. That exclusivity is what lets a received
  Final be acted on as revocation: the phone clears its trust anchor, push key, and cached
  desktop content and returns to the unpaired home (`connectionManager`'s remote-close handler),
  and the desktop drops the device from its roster. A Final's *absence* still proves nothing:
  anyone who can drop the socket can suppress it. The desktop's presence probing stays
  load-bearing, and a missing Final must never be read as evidence a device is still there.
- **No Double Ratchet.** Double Ratchet solves offline, asynchronous message queuing, which this
  interactive link does not have; adding it would be unjustified complexity.
- **Relay scheme enforcement:** the relay address arrives inside a scanned QR, so it is
  attacker controllable, and `activePairing` persists it to the trust anchor for every later
  session. A crafted payload naming a plaintext host would therefore route the whole ceremony,
  and everything after it, through that host. The phone (`src/pairing/qr.ts`) refuses to pair
  through any relay address that isn't `wss://`, carving out only loopback (`ws://localhost`,
  `127.0.0.1`, `::1`) for a local dev relay.

  This rule predates protocol 0.12.0 and used to be justified by a second exposure that no
  longer exists: the pairing token was dialed verbatim as the relay's `?slot=` parameter while
  also serving as the Noise PSK, so a plaintext connection put the PSK on the wire. The slot is
  a derived routing label now (`derivePairingSlotId`, see Relay slots below) and the token never
  leaves the QR. The address-pinning reason above is untouched by that, which is why the
  restriction stays.

  **That carve-out is decided by parsing the address's AUTHORITY, never by prefix matching.**
  A prefix test can only ask what an address starts with, which says nothing about the host it
  resolves to, and it accepted two impostors: `ws://127.0.0.1:8080@evil.test`, where everything
  before the `@` is userinfo so the real host is `evil.test`; and `ws://[::1]evil.com`, where
  truncating at the closing bracket read the host as `[::1]`. Either would have run the whole
  ceremony through an attacker-chosen host, and `activePairing` would then have persisted that
  host to the trust anchor for every later session. The same rules live in
  `@kangentic/protocol`'s `relay-address.ts` (0.11.1), which the desktop reads through
  `src/shared/relay.ts`, so both ends enforce one definition. Two build shapes additionally
  accept `ws://10.0.2.2`, the Android emulator's NAT alias for the host's loopback interface, so
  a rig relay is reachable without an `adb reverse`: a `__DEV__` bundle, and a build from the
  **`e2e` EAS profile**, which sets `EXPO_PUBLIC_KANGENTIC_E2E=1`. E2E needs a release-shaped
  binary (Maestro tests the
  final bundled app, and a dev client drags in a dev menu, a Metro dependency, and a bundle URL
  that `pm clear` wipes), and without the flag that binary refuses the local relay.

  A release-shaped build additionally needs Android's own permission to speak cleartext at all:
  the platform refuses a `ws://` socket before any of our code runs, which surfaces as "Relay
  connection closed before it opened (code 1006)". The `e2e` profile therefore also sets
  `usesCleartextTraffic` (via `expo-build-properties` in `app.config.ts`), gated on the same
  `EXPO_PUBLIC_KANGENTIC_E2E` flag, so it travels with that profile and no other. The dev client
  never needed it because a debug build ships a network-security-config that permits cleartext.

  Both gates are decided at BUILD time and both fold to a constant: `__DEV__` and every
  `EXPO_PUBLIC_*` value are substituted as literals by Metro, so a `production` bundle contains
  neither branch. There is no runtime flag, setting, or intent that can widen an installed app's
  accepted relay addresses. The `e2e` profile is `distribution: internal` and is never the
  profile that ships. Note the gate is on the BUILD, not the device: an `e2e` or dev build
  installed on a physical phone would accept `10.0.2.2`, where it is an ordinary private address
  rather than a loopback alias, so neither belongs on a phone that pairs with anything real.

## Relay slots

A slot id is the rendezvous label two peers dial to find each other (`${relayUrl}?slot=<hex>`).
Both are derived in `@kangentic/protocol` and mirrored by `src/channel/slot.ts`, which the
desktop matches byte for byte:

| Slot | Derivation | Shape |
|---|---|---|
| Pairing | `derivePairingSlotId(pairingToken)` | labeled BLAKE2s, 16 bytes / 32 hex |
| Session | `deriveSessionSlotId(desktopStaticPublicKey, phoneStaticPublicKey)` | labeled BLAKE2s, 16 bytes / 32 hex |

**A slot is a routing label, never key material.** It rides in a URL query string, the
most-logged part of a request, so anything secret placed there is published to every hop that
can read a request URI. Before protocol 0.12.0 the pairing slot was the hex of the pairing
token itself, which published it: the same 32 bytes were also the Noise `IKpsk0` pre-shared
key, so on a hosted relay whatever terminates TLS saw the PSK, and `IKpsk0` degraded to plain
`IK` against such an observer. Deriving the slot keeps the label public and the PSK secret; the
token now never leaves the QR. Its 128 bits are sized to defeat blind enumeration, which is all
a rendezvous label has to do.

**A slot derivation is a wire-breaking change.** The slot is a zero-negotiation value, so peers
computing it differently never meet, and the symptom is a hang until the relay's park timeout
rather than an error. `PROTOCOL_VERSION` is therefore bumped whenever a derivation changes (v3
introduced the derived pairing slot), and `validateScannedQr` compares it before anything
dials, turning that hang into an explicit `version-incompatible` result at QR-scan time. The
message names neither side as the stale one, because a bump leaves a current phone ahead of an
old desktop and an un-updated phone behind a current one, and the phone cannot tell which it is.

Because the version is also bound into the KK **session** prologue, such a bump takes every
existing pairing offline until both ends run matching software. It does not invalidate the
pairing: no protocol version is stored beside the pinned identity on either side, and the
session slot derives from the two static keys alone, so the pinned keys reconnect once the
software matches, with no repeat of the QR/SAS ceremony.

## Authorization

The encrypted channel proves *which* device is talking; a desktop-enforced capability allowlist
decides *what* it may do (see `docs/architecture.md` for the ten-verb table). **There is no
shell, file-read, or arbitrary-command verb in the protocol at all: it is absent, not filtered.**
This follows the lesson of Chrome Remote Desktop and VS Code tunnels, which are identity-gated
but capability-unscoped, and of the SSH forced-command pattern, which shows that a filter on an
otherwise-general command channel is the wrong shape.

The default pairing grant is **all ten verbs** (`DEFAULT_PAIRING_CAPABILITIES` in the desktop's
`pairing-service.ts` spreads `CAPABILITY_VERBS` whole). This is deliberate: the pairing ceremony
proves possession of both devices, so pairing is the approval, and the per-verb allowlist in the
desktop's Mobile Devices settings exists to NARROW a device after the fact rather than as a
default-deny gate. The load-bearing guarantee is the previous paragraph's - the verbs a grant
can contain are the ten above, with no shell, file, or arbitrary-command verb to grant.
`interactive-terminal` is deliberately
raw keystrokes to one session's PTY - powerful, but scoped to the agent session the desktop is
already running, never a new shell. Its resize/release actions (the phone sizing that PTY to the
phone screen) ride the same grant rather than a new verb: a device already trusted to type raw
bytes into the PTY gains nothing from resizing it, and the desktop restores its own dimensions
the moment the phone releases, disconnects, or is revoked. The `board-tool-*` verbs dispatch into a hand-classified
allowlist of the desktop's task/backlog command registry; the raw-SQL escape hatch and every
code-execution tool family are excluded desktop-side.

**Revocation is removal from the signed roster, announced over the live channel.** When the
desktop revokes a device it sends the Final goodbye over the established session before
disposing it, so a connected phone clears its own pairing (trust anchor, push key, cached
content) immediately and lands on the unpaired home. A phone that is offline at that moment
gets no Final - nothing can carry it - and instead observes the relay accepting its socket
while the desktop never initiates a handshake again; the phone escalates that sustained silence
in the UI with a route to unpair locally, but its trust anchor survives until the user acts.
The rekey half (rotating the desktop's static key so a removed device cannot even answer a
future handshake) is desktop Phase 3 scope and not yet shipped; a device also ages out via a
per-device key expiry, so a lost phone is not trusted forever even if revocation is missed.

## Key storage

- **iOS:** `expo-secure-store`, backed by the Keychain. The Secure Enclave only supports P-256,
  so the app's X25519 identity keys cannot be enclave-resident; they get Keychain protection
  instead. This is stated plainly rather than worked around.
- **Android:** `expo-secure-store`, backed by the Keystore (StrongBox-backed where the device
  supports it).
- **No attestation requirement.** Play Integrity and App Attest would break sideloaded and
  F-Droid-style builds of an open-source app, and buy little against this threat model, so this
  app does not require them.
- **Device-bound, not backup-portable.** The identity key (`src/pairing/deviceIdentity.ts`),
  the pinned trust anchor (`src/pairing/trustAnchor.ts` - the desktop's static key, the relay
  address under `trust.relayAddress`, and the paired-at timestamp), and the push secrets
  (`src/notifications/pushKeys.ts` and `src/notifications/sharedKeychain.ts` - the 32-byte
  push-decrypt key under `push.decrypt.key`, the last-registered Expo push token, itself a
  per-device bearer secret, under `push.expoToken.lastRegistered`, and `push.identity.pk`, a copy
  of this phone's static PUBLIC key that the Notification Service Extension needs as the
  envelope's AAD) are all `THIS_DEVICE_ONLY`, so none of it is included in an
  encrypted iOS device backup or restorable onto different hardware. Restoring a backup onto a
  new phone cannot reconstitute a working paired client; the device must re-pair. The only other
  secure-store values are the non-secret user preferences (`src/state/settingsStore.ts`),
  stored there because AsyncStorage is banned in `src/state/**`. Those preferences are the one
  exception to the sentence above: they pass no options at all, so they take
  expo-secure-store's default `WHEN_UNLOCKED` and ARE backup-portable. That is deliberate -
  they hold no secret - but it means "device-bound" describes the keys, not the whole store.

- **Two accessibility classes, and the difference is deliberate.** The identity key, the trust
  anchor and the last-registered Expo push token use
  `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY`: nothing outside
  the app reads them, so they can require an unlocked device. The two items the iOS Notification
  Service Extension reads - the push-decrypt key and `push.identity.pk` - use
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` instead (`src/notifications/sharedKeychain.ts`).
  **This is a real trade-off, stated rather than buried:** those two items are readable by the
  extension process while the phone is locked. The alternative was not a more secure app but a
  non-functional feature, because an NSE runs at delivery time, which is usually while the phone
  is locked, and iOS never re-renders an already-delivered notification. Under `WHEN_UNLOCKED`
  the decrypted title would essentially never appear. Both items remain `THIS_DEVICE_ONLY`, so
  the backup-portability property above is unchanged, and the identity SECRET key is deliberately
  NOT among them.

- **The extension reads through a shared Keychain access group, never a copy of the key.**
  The app declares `keychain-access-groups` with its own application-identifier group **first**
  and `<bundle id>.shared` second; the extension declares only the shared group
  (`plugins/withIosNotificationServiceExtension.ts`, `targets/nse/Kangentic-NSE.entitlements`).
  The order is load bearing: once that entitlement exists, an unqualified Keychain write lands in
  the first entry rather than the implicit application-identifier group, and the identity key,
  trust anchor and settings store all write unqualified. The extension can therefore reach the
  push-decrypt key and the identity public key and nothing else. The group string is composed at
  build time from the provisioning profile's team id and injected as
  `EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP`, so no Apple team identifier is committed.

## Relay metadata honesty statement

A blind relay forwards ciphertext only, but it still sees source and destination IP addresses,
connection timing, frame sizes and frequency, and the pairing graph (which devices talk to which
relay slot). This app does not claim otherwise. Mitigations: self-hosting your own
`relay` instance, single-use pairing tokens, and relay slot tokens so only paired
devices can consume relay capacity at all.

One frame size is worth naming rather than leaving under "frame sizes". The deliberate-teardown
goodbye seals an EMPTY plaintext, so it is the only frame either peer ever sends at the
secretstream minimum (a tag byte plus the Poly1305 tag); every ordinary `BridgeMessage` is
encoded JSON and far larger. A relay operator can therefore tell a deliberate unpair - from
either side - from a dropped socket by length alone, without breaking anything. That is a departure signal, not
content, and it is information the operator would get from the slot going quiet moments later
anyway - but it is newly precise, so it is stated here rather than implied.

## Push privacy

Push notifications are ciphertext plus a generic placeholder only (see
`.claude/rules/e2e-notification-privacy.md`); every failure mode degrades to the placeholder,
never to plaintext or raw ciphertext shown to the user. That is a floor on WHAT IS RENDERED, not
a delivery guarantee: the Android message is data-only, so there is no OS-drawn notification
behind our handler, and anything that stops it running at all produces silence rather than a
placeholder. See the notification pipeline in [architecture.md](architecture.md) for the full
treatment. On-device decrypt lives in
`src/notifications/pushDecrypt.ts`: the envelope is sealed with a device-generated push key and
this phone's static public key as the AAD, opened with a 24h staleness / 5min future-skew
window, and any failure (missing key, wrong key, wrong recipient, tamper, malformed, stale)
returns the placeholder. Decrypted content is never logged.

Both platforms decrypt before display now. Android does it in a headless `expo-task-manager`
task that hands the result to Notifee to display, Notifee owning display rather than receipt
(`src/notifications/backgroundPushTask.ts`); iOS does it in a Notification Service Extension
(`targets/nse/`, injected at prebuild by `plugins/withIosNotificationServiceExtension.ts`). The
extension re-implements XChaCha20-Poly1305 in Swift because CryptoKit ships only the
96-bit-nonce IETF variant: XChaCha20-Poly1305 is HChaCha20 for a subkey followed by that
variant, so only HChaCha20 is hand-written and the AEAD itself is CryptoKit's. No third-party
crypto is vendored. Agreement with `@kangentic/protocol` is not assumed: the `NSE crypto
(swiftc)` job in `ci.yml` opens envelopes sealed by the protocol package's own
`sealPushEnvelope` and checks that the tamper, wrong-key, wrong-AAD and staleness paths all
reject.

The extension mutates only the notification's title and body. It never writes to `userInfo`,
and in particular never puts the decrypted `taskId` there: tap routing re-derives it by
decrypting on tap (`src/notifications/tapRouter.ts`), so task identity never enters the
OS-visible object. It logs nothing, on any path. Every failure - a missing key, a Keychain read
that returns nothing because the device is locked or the entitlement is absent, a decrypt
failure, an unknown category, or simply running out of execution time - delivers the placeholder
exactly as it arrived.

One dependency worth naming: **APNs invokes a service extension only for a push that carries
`mutable-content: 1` AND an alert.** The desktop deliberately sends iOS a placeholder title and
body for that reason, while sending Android a data-only message. Making iOS data-only to match
Android would silently disable on-device decryption there.

Unpairing revokes push, not just trust: `DevicesScreen` calls
`connectionManager.revokePushRegistrationForUnpair()` while the channel is still up, which sends
`register-push` with `action: 'unregister'` and then wipes the local push key
(`pushKeys.clearPushRegistration()`) before the trust anchor is cleared. Without this, an
unpaired desktop would retain a valid `(expoPushToken, pushKey)` pair and could still push
notifications this phone would decrypt and display. A desktop-side revoke covers the same
property from the other end: the desktop drops the device's push registration itself as the
first step of its revoke, so the phone's revocation handler only wipes the local key - no
unregister request is needed over a channel the desktop is tearing down.

### Expo is in the delivery path, deliberately

`src/notifications/pushRegistration.ts` calls `Notifications.getExpoPushTokenAsync()`, so the
token registered with the desktop is an `ExponentPushToken`, not a raw FCM token. Delivery is
therefore **desktop -> Expo push service -> FCM/APNs -> device**, and Expo relays on our behalf
using an FCM V1 service-account key uploaded to the Expo project's Android credentials.

This is a conscious trade, not an oversight, and it is worth stating plainly because it sits
awkwardly next to `.claude/rules/accountless-core.md`:

- **What Expo cannot see:** notification content. Payloads are ciphertext plus a generic
  placeholder, which is the whole point of the rule above. This holds regardless of who relays.
- **What Expo can see:** metadata. Which device receives a notification, when, and how often.
  Expo also holds a credential that can push to every install of the app.
- **What it costs a self-hoster:** an Expo account, and uploading their own FCM key to Expo, for
  remote push to work at all. Everything else in the pairing, transport, and capability path is
  genuinely accountless. Push is one of two places a third party sits in a path at all; crash
  reporting, below, is the other, and it costs a self-hoster nothing because it is inert without
  a build secret they will not have.
- **Why we accept it:** Expo Push is free (no per-notification charge, no paid plan required) and
  covers Android and iOS through one token and one API. Going direct means implementing FCM v1
  *and* APNs separately, and APNs is the expensive half.
- **Degradation:** push is optional. Without any of this the app records
  `unavailable-no-fcm` and works fully, minus remote notifications.

The exit path, if the metadata exposure or the account requirement ever becomes unacceptable:
switch to `getDevicePushTokenAsync()` for a raw FCM token and have the desktop call FCM v1
directly. That is a `@kangentic/protocol` change first (`RegisterPushRequestPayload.expoPushToken`),
per `.claude/rules/protocol-types-from-package.md`, then desktop send-path work, then APNs for iOS.

## Crash reporting

Official builds report crashes to [Sentry](https://sentry.io). Like Expo push above, this is a
conscious trade rather than an oversight, and it sits next to the same accountless-core rule, so
it gets the same plain accounting.

The controls are set at their source rather than in a filter, because **a JavaScript `beforeSend`
hook does not filter native events**: a hard iOS or Android crash is captured and sent by
sentry-cocoa / sentry-android without passing through the JS layer at all. JS breadcrumbs are
also synced into the native scope, so a console breadcrumb recorded in JS would ride a native
crash past any JS scrubber. Anything that must not be sent is therefore never collected, rather
than collected and stripped. `src/observability/crashReporting.ts` is the single place this is
configured, and `.claude/rules/crash-reporting-scope.md` is the rule that keeps it that way.

- **What Sentry cannot see:** session content. No screenshots, no view hierarchy, no console
  output, no captured network requests, no JS network breadcrumbs, no Session Replay, no
  performance traces, no structured logs, no PII, and no message text from a failure the app
  caught and showed you - each disabled explicitly, several of them ON by default in the SDK.
  Screenshots and view hierarchy are the two that reach native, and both are off there too.
  Transcripts, terminal output, diff content, board data, pairing material and notification
  payloads are never collected, and `src/pairing/`, `src/channel/`, `src/demo/`,
  `src/devsupport/`, `src/notifications/` and `app/+native-intent.ts` are forbidden by lint (and
  by a source scan that also covers `require()` and dynamic `import()`) from reporting to Sentry
  at all, because their error messages can echo ciphertext, key material, or
  attacker-controlled bytes (see `src/notifications/pushDecrypt.ts`).
- **What Sentry can see:** that this app crashed, where in the code, and on what kind of device.
  A stack trace, the exception type and message, app version, and the SDK's standard device and
  OS context. For a failure the app caught and handled, strictly less: which part of the app
  caught it (a fixed site label), the error's class name, the capability verb if one was
  involved, and the stack frames - never the message, which is replaced by the site label
  before the SDK sees it (`reportHandledError` in `src/observability/crashReporting.ts`).
  That context is wider than model and OS version alone: it is the platform's normal
  diagnostic block, and includes things like battery level, free memory and storage, screen
  resolution, orientation, and device timezone. None of it is session content, none of it is an
  account, and it is not used to profile a user, but "device model and OS" understates it and
  this document would rather be exact.
  A crash is by definition an unplanned state, so a message could in principle carry a fragment
  of app data; the exception is code that runs on the paths above, which cannot report.
- **What the native SDKs still record, which JS cannot turn off.** The breadcrumb controls in
  `Sentry.init()` are JavaScript-side only: `@sentry/react-native` strips `beforeSend`,
  `beforeBreadcrumb` and `integrations` out of the options before handing them to the native SDK
  (`node_modules/@sentry/react-native/dist/js/wrapper.js`), so sentry-android keeps its own
  default breadcrumbs and those ride a NATIVE crash. **Observed directly** (a crash-test build, a
  real native crash, the delivered event read back through the Sentry MCP - not inferred from
  source): `app.lifecycle` (foreground/background), `device.event` (battery level, charging,
  screen on/off), and `network.event`, which carries `action`, `network_type`, `vpn_active`,
  `signal_strength`, `download_bandwidth`, and `upload_bandwidth` - more detail than "coarse
  app-lifecycle timing" suggested before this was verified. None of it is session content.
  Closing this needs native configuration through a config plugin, not a JS option; it is a named
  gap, not an oversight. The same native breadcrumbs also rode a JS-captured event on iOS
  (`started` and `ui.lifecycle`, observed on the first iOS event the project received, 2026-09-12),
  because the SDK merges the native scope's breadcrumbs into every JS event before `beforeSend`;
  that half IS reachable from JS, so `scrubEvent` now applies the same default-deny allowlist to
  the event's breadcrumb list, on both platforms. iOS app-hang and watchdog-termination reporting
  are likewise left at their native defaults (on), deliberately: a hang and an out-of-memory kill
  are the app breaking, which is what this reports.
- **What the native SDK sends that `sendDefaultPii: false` does not stop: a per-install
  identifier, on a crash the OS catches rather than the app's own code.** sentry-android always
  populates `contexts.device.id` (a random UUID generated once per app install - not
  `Secure.ANDROID_ID`, not an advertising ID) and, on the uncaught-exception path, promotes that
  same value into `user.id` before `beforeSend` ever runs - `beforeSend` does not run for a
  native-captured event at all. Confirmed with two real delivered events off the same install: a
  JS-caught throw carried `Users: 0` (`scrubEvent` strips `user`), the OS-caught crash carried
  `Users: 1` with `user.id` equal to that event's `contexts.device.id`.
  `Sentry.setUser(null)` was tried as a suppression, called immediately after `Sentry.init()`,
  and did not visibly suppress it - a fresh native crash with that call in place still carried
  `user.id` equal to `contexts.device.id`. There is no known JS-reachable fix. This identifier is
  declared in the Play and App Store Connect privacy answers (`docs/store-listing.md`) and
  described, not denied, in `docs/privacy-policy.md`.
  **Not tested:** a real native (NDK/signal-handler) crash on Android - every Android observation
  above came from `Sentry.nativeCrash()`, a Java-uncaught `RuntimeException`, not a SIGSEGV
  caught by sentry-android's NDK handler. iOS native crash reporting WAS verified on 2026-09-12,
  on the CI simulator (`build-ios.yml -f crash_test=true`): there `Sentry.nativeCrash()` is a
  mach `EXC_BREAKPOINT` caught by sentry-cocoa's signal handler, and its delivered event carried
  `user.id` and the native `started`/`ui.lifecycle` breadcrumbs exactly as the Android account
  above predicts. Hardware remains unverified.
- **What it costs a self-hoster:** nothing. The DSN is injected at build time from a GitHub
  repository variable (`vars.SENTRY_DSN`, not a secret: a DSN ships inside the published bundle
  and is write-only, so it is not confidential) and is never committed, so a build made from this
  repository never calls `Sentry.init()`, starts no native SDK, and sends nothing. This is deliberate twice over: it keeps self-hosted builds free of any
  Kangentic-operated service, and it stops a fork's crashes consuming this project's free-tier
  quota.
- **Why we accept it:** the alternative is shipping blind. The app has no logger and no other
  diagnostics, so before this a production crash was simply invisible. Store dashboards (Play
  Console, App Store Connect) report crash counts but no JavaScript frames, which for a React
  Native app is most of the story. The app does now have one error boundary
  (`src/screens/AppErrorBoundaryScreen.tsx`, wired as the root `ErrorBoundary` in
  `app/_layout.tsx`), and that makes reporting MORE load-bearing rather than less: React hands a
  caught error to the boundary instead of to `ErrorUtils`, so the global handler never sees it.
  `reportCaughtError` in `src/observability/crashReporting.ts` is the capture path that stops a
  boundary trading a visible crash for an invisible one. `reportHandledError`, beside it, is the
  door for failures the app catches and shows the user (a failed send, a failed create, an
  archived read the desktop refused, a Keychain read that fell back to "unpaired"): before it
  existed, a "Create failed" the user saw was invisible here, and every deliberate catch in the
  app swallowed. It forwards no message text, only the site, the class name, a verb and the
  frames.
- **Degradation:** entirely optional and entirely absent when unconfigured. There is no runtime
  dependency on it, no user-facing behaviour attached to it, and no failure mode if Sentry is
  unreachable.

Four things are deliberately off and are worth naming because they would each be a defensible
default elsewhere; all four were re-confirmed as keep-off by the 2026-09-11 capture audit, whose
per-control consequences are recorded in the crash reporting section of
`docs/developer-guide.md`. **Session tracking** is disabled: it produces crash-free rate, a
genuinely useful stability metric, but it is a per-foreground ping and therefore usage
telemetry, which this app tells users it does not collect. **A user identifier** is stripped
from every JS-captured event (`scrubEvent`); the native per-install identifier above is
disclosed, not added to. **Captured failed requests** are off, because the capture carries
request URLs. **Sampling** is not used; every error is sent, because the volume is low and the
free tier's budget is better spent on completeness than on smoothing.

The exit path, if this ever becomes unacceptable: delete the `SENTRY_DSN` repository variable
(GitHub Settings, Variables rather than Secrets) and the SDK goes inert across every build with
no code change. Removing the dependency outright is four edits, not one: drop it from
`package.json`, delete `src/observability/` and its call in `index.js`, revert `metro.config.js`
to `getDefaultConfig`, and remove the conditional plugin entry from `app.config.ts`. The last two
matter, because leaving either behind after uninstalling the package breaks Metro startup and
prebuild respectively.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).

## See Also

- [docs/architecture.md](architecture.md) - system overview, the capability verb table, the
  notification pipeline.
- [docs/developer-guide.md](developer-guide.md) - setup and testing.
