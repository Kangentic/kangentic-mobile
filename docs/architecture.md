# Architecture

Kangentic Mobile is a companion app that remote-controls agent sessions running in the desktop
[Kangentic](https://github.com/Kangentic/kangentic) app. This document describes the
architecture as of App Phase 2 (the core remote-control experience); see `CLAUDE.md`'s Project
Structure for the current layout. The durable research behind these decisions lives in the desktop repo's
[`docs/research/mobile-companion-app.md`](https://github.com/Kangentic/kangentic/blob/main/docs/research/mobile-companion-app.md);
this document is the implementation-facing summary and is authoritative where the two disagree
(notably the pairing ceremony, see below).

## Overview

```
  Desktop (Kangentic)                            Phone (Kangentic Mobile)
  mobile-bridge module                           Expo / React Native app
  - device identity + roster    QR pairing       - device identity (Keychain/
  - capability router          <=============>     Keystore)
  - session/board/diff feeds    (token-PSK + SAS) - board + conversation UI
        |                                                |
        |  outbound WSS                    outbound WSS  |
        +-----------> [ blind relay ] <------------------+
        |             (ciphertext only,                  |
        |              self-hostable: relay)              |
        +===== Noise KK secure channel (E2E) =============+
        +---- Expo Push (E2E-encrypted blob -> NSE / Notifee handler) -->+
```

A later phase adds a WebRTC data channel upgrade for direct P2P; the relay remains the permanent
fallback for the networks that cannot punch through.

## Repos and boundaries

- **`kangentic`** (desktop, this app's counterpart): hosts a `mobile-bridge` module that exposes
  session, board, diff, and activity feeds to paired devices, and is the source of truth for the
  `@kangentic/protocol` npm package.
- **`@kangentic/protocol`**: the wire schema, the shared Noise KK implementation, capability
  verbs, and transcript/board/activity event types. Published from the desktop repo; this app
  never forks or redeclares these types (see `.claude/rules/protocol-types-from-package.md`).
- **`relay`** (separate, open-source repo): a stateless, self-hostable blind
  byte-forwarder. It authenticates nothing and reads nothing beyond ciphertext framing.
- **`mobile`** (this repo): the Expo/React Native client.

The pairing, transport, and capability layer is **accountless** by design: it works identically
self-hosted or on a Kangentic-hosted relay, and a Kangentic account is only ever relevant to
using the hosted relay past a free cap. See `.claude/rules/accountless-core.md`.

## Pairing

The desktop displays a QR code; the phone scans it. The desktop is the trust root. The QR
carries, and nothing more:

1. The desktop's static X25519 public key.
2. A short-lived (~10 minute), single-use, high-entropy (>=128-bit) pairing token.
3. The relay address.
4. The protocol version.

It never carries a long-lived secret. The token is mixed into the Noise handshake as a
**pre-shared key (PSK)**; see `docs/security.md` for why this is deliberately not a PAKE. The
token stays in the QR and goes nowhere else: the relay slot both peers dial is *derived* from
it (`derivePairingSlotId`), never the token itself, because the slot travels in cleartext in
the relay URL. After the handshake, both sides derive a **Short Authentication String (SAS)**
from the transcript hash and display it on both screens; the user confirms the two match before
the pairing completes. On success, the desktop signs the phone's public key into a device roster with a
per-device capability set. The roster, not the relay, is the source of truth for who is paired.

## Secure channel

Every session runs a **Noise KK** handshake (`Noise_KK_25519_ChaChaPoly_BLAKE2s`): both static
keys are pre-messages from pairing, so there is no trust-on-first-use and neither identity ever
travels on the wire in the clear. The desktop always initiates the handshake and owns the ~2
minute rekey timer; the phone is the responder, reacting identically to the very first handshake
and to every later peer-initiated rekey.

- Version negotiation is bound into the Noise prologue; a differing prologue fails the handshake
  outright, closing downgrade attacks.
- No state-changing command may ride the first Noise message (it is replayable pre-ephemeral).
- Sessions rekey roughly every 2 minutes (WireGuard's `REKEY_AFTER_TIME`) for bounded
  post-compromise security.
- Per-direction 64-bit counter nonces reject anything at or below the last seen value.
- A **deliberate** teardown (unpairing, on either side) seals an empty `FrameTag.Final` frame
  before the socket closes, and receiving one is acted on as revocation: the desktop drops the
  phone from its roster immediately, and the phone clears its pairing and returns to the
  unpaired home (`connectionManager`'s remote-close handler). Backgrounding and reconnects stay
  silent on purpose - the phone intends to return - and an involuntary teardown (killed app,
  dead network) cannot announce anything at all.
- Crypto library: `@kangentic/protocol` is pure TypeScript on `@noble/curves`/`@noble/hashes`/
  `@noble/ciphers` - no native crypto module. The exact same handshake and `secretstream`-style
  AEAD framing code runs on Node (the desktop) and on Hermes (this app), tested once against
  official Noise test vectors. The app adds only `react-native-get-random-values` (Hermes has no
  built-in `crypto.getRandomValues`, which the protocol's key generation needs) and
  `@bacons/text-decoder` (Hermes has `TextEncoder` but not `TextDecoder`).

## Capability allowlist

The encrypted channel proves *which* device is connected; a separate, desktop-enforced layer
decides *what* it may do:

| Verb | Purpose |
|------|---------|
| `read-stream` | Subscribe one session's live feeds: raw PTY tail, activity/usage/permission telemetry, and chunked transcript deltas; its `transcript-window` action serves byte-budgeted history pages (the subscribe response carries the scrollback snapshot and the outstanding `awaitedPromptId`). `transcript-window` alone needs no LIVE session (protocol 0.10.0): it reads session records plus their on-disk JSONL, which is what lets a completed task's conversation be read after its agent is gone. Every other action still requires one. |
| `read-board` | Project list (no `projectId`, carrying the desktop's project groups since 0.11.0), a board snapshot + live board-change subscription, or - via the `archived` action (0.10.0) - a one-shot page of COMPLETED tasks with each one's lifetime session summary. Archived tasks are deliberately not in the snapshot: a board subscription re-snapshots on every change, and the archive only grows. |
| `read-diff` | A task's diff file list (+ a live change-signal watch) or one file's old/new content |
| `send-user-message` | Send a composed message into an agent session (bracketed paste desktop-side) |
| `move-task` | Move a task between board columns |
| `answer-permission-prompt` | Respond to an outstanding agent permission prompt |
| `interactive-terminal` | Raw keystroke write to the session PTY (full terminal parity) |
| `board-tool-read` | The allowlisted read half of the desktop's task/backlog command registry (search, stats, transcripts, ...) |
| `board-tool-write` | The allowlisted mutate half (create/update/delete task, backlog CRUD, link PR, ...) |
| `register-push` | Register/unregister this device's Expo push token plus its 32-byte notification-decrypt key with the desktop's push notifier (it only lets the desktop send the device ciphertext) |

**There is no shell, file-read, or arbitrary-command verb in the protocol.** It is absent, not
filtered. `answer-permission-prompt` is the most sensitive verb: the phone renders exactly what
is being approved, and the desktop enforces that the response binds to a specific outstanding
prompt id (`${sessionId}:${toolUseId}`, also covering `AskUserQuestion`/`ExitPlanMode` pauses,
which ride the same permission machinery). The default pairing grant is ALL TEN verbs
(`DEFAULT_PAIRING_CAPABILITIES` in the desktop's `pairing-service.ts`): pairing proves
possession of both devices, so pairing is the approval, and the desktop's Mobile Devices
settings narrow a device per-verb after the fact. The `board-tool-*` surface is NOT
MCP: the `tool` name is the desktop's internal command-registry key, dispatched as a direct
function call against a hand-classified allowlist (raw-SQL and code-execution tools are
excluded desktop-side, and the protocol package's `BOARD_TOOL_READ_NAMES`/
`BOARD_TOOL_WRITE_NAMES` tuples keep both sides in lockstep).

## App structure

```
app/              # expo-router route wrappers (thin - render the src/screens/ implementation)
  task/[taskId]/  # index = the Session view (terminal/chat lenses; the header's column chip
                  #   opens the move-task sheet); changes = the diff destination;
                  #   file-diff.tsx hosts the per-file diff on the stack
src/
  screens/        # TriageHome (+ home/ needs-you cards), Board, task/ (SessionScreen + lenses),
                  #   FileDiff, Pairing (Scan/Confirm), Settings, Devices
  components/      # Design system + conversation/ cells and prompt cards, terminal/ pane +
                  #   quick keys, board/ sheets, composer/, diff/ line cells
  pairing/         # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/         # Relay WebSocket transport, KK session manager (responder), slot derivation,
                  #   capability client, typed verb client, feed router, subscription manager
  connection/      # The lifecycle composer: AppState-driven connect/dispose, bootstrap,
                  #   store feed glue, the actions API screens call
  conversation/    # Pure transcript-cell flattener, prompt keystrokes, pending-prompt summary
  terminal/        # Pure liveTail PTY cleaner, key sequences, WebView bridge protocol,
                  #   the generated self-contained xterm.html asset
  diff/            # Pure unified-diff line computation (jsdiff) + path display helpers
  notifications/   # Push registration, E2E blob decrypt, notifee channels, local notifier,
                  #   foreground service, background push task, tap routing (tap routing
                  #   and rich display are cross-platform; the iOS half decrypts in
                  #   the Notification Service Extension under targets/nse/)
  state/           # Zustand stores (activity/board/transcript/diff/channel/settings) +
                  #   the non-Zustand terminalFeed PTY ring buffers
  voice/           # Dictation hook over the OS speech engines
  observability/   # Sentry crash reporting: the ONLY module allowed to import the SDK, plus
                  #   the pure event/breadcrumb scrubber (lint-enforced, crash-reporting-scope.md)
  lib/             # Shared pure utilities (crypto polyfills)
```

Route files under `app/` are thin wrappers that render the matching `src/screens/` implementation
(e.g. `app/pair.tsx` renders `PairingScanScreen`); this keeps the documented `src/` layout as the
place screen logic actually lives while still getting expo-router's file-based routing. In Phase 1
the pairing on-ramp is the in-app camera scan (or the paste-link fallback) inside
`PairingScanScreen`. OS-level deep-link routing of a REAL `kangentic-pair://` URI is still not
wired. The pairing payload is a base64url blob in the URI authority (not a `/pair` path), so
routing it needs a handler that feeds the captured URL through the same `validateScannedQr` then
`beginPairing` path; that lands in a later phase, and deliberately so - a real payload carries an
attacker-chosen desktop key and relay address, both of which pairing pins for every later session,
so honouring one from an arbitrary web page or message is a capability that needs its own threat
model rather than a few lines of plumbing.

`app/+native-intent.ts` DOES exist and handles exactly one URL: the reviewer/demo code
`kangentic-pair://demo`, which it rewrites to `/pair?demo=1`. That is safe under the paragraph
above precisely because it carries no attacker-controlled data - it is a compile-time constant,
it is refused when the phone is already paired, and it can only ever show on-device fixture
content. See `src/demo/demoIdentity.ts`.

Navigation: an activity-triage home (Needs you / Working / Idle) plus a swipeable Board tab,
both live off the channel feeds. Opening a task is full-screen with a bottom tab bar
(Conversation-terminal / Terminal / Changes) and the active tab's input pinned at the bottom
(the composer on Conversation, the quick-key bar + terminal input row on Terminal). All three
tab pages stay mounted as absolutely-positioned siblings, only the active one visible, so the
terminal WebView never reloads and the conversation keeps scroll position; tab switching is
tap-only. This replaced a `PagerView` that was configured `scrollEnabled={false}` and so
contributed no scrolling at all, only page management that the screen's `mode` state already
does. Visibility is opacity plus zIndex rather than `display: 'none'`, which would drop the
WebView's surface and force the terminal to re-create its GL context on every lens switch, and
each hidden pane is taken out of the accessibility tree explicitly.

The connection lifecycle (`src/connection/connectionManager.ts`) connects while the app is
foregrounded and paired, and disposes on background: iOS suspends sockets within seconds
anyway, and remote E2E push covers the away-from-app case. The one exception is Android with
`backgroundNotificationsMode: 'foreground-service'` (the default): with an established
connection, backgrounding keeps the channel alive under a notifee foreground service and starts
the local notifier instead of disposing.

**That keepalive is bounded to five minutes** (`BACKGROUND_KEEPALIVE_MAX_MS`), after which it
stops the service and disposes the channel, handing alerting to remote push. Three reasons, and
the bound is not tunable upward without revisiting all three. Android 15+ gives a `dataSync`
foreground service a 6h/24h budget and kills the process on overrun; notifee 9.1.8
exposes no `Service.onTimeout` hook, so there is no signal to react to and a JS timer is the only
bound available; and an unbounded service held the process resident for hours at a time, which is
how it bears on the REACT-NATIVE-5 OOM. Note what that third reason is NOT: the background path
does not leak, and four measured probes in the developer guide say so. The leak is in the
FOREGROUND path (a session screen retains its native view subtree per open), and an
always-resident process is simply what stopped an OS kill from ever resetting that accumulation.
The ceiling makes the process reapable again.

**The bound is enforced twice, because once was not enough.** MOBILE-3 recurred on a build that
already had the timer above (it has shipped since versionCode 5), and the two crash events say
plainly what happened: the app went to background, never returned, and the process was still alive
7h10m and 14h14m later with the service running. RN services every `setTimeout` from a
Choreographer frame callback, so the ceiling timer is only ever as reliable as frame delivery to a
backgrounded app. The ceiling is therefore also checked against the **wall clock**
(`enforceKeepaliveCeiling`) from wake sources that reach JS by another route: the desktop's ~2
minute rekey, which arrives as an inbound relay frame, and AppState transitions. Worst case the
service lives for the ceiling plus one rekey interval rather than forever.

**Correction, same issue: the budget does not accumulate across background stretches.** This
section and `connectionManager.ts` both used to reason about exhausting the 6h budget over many
short stretches ("72 separate background stretches"). Android resets that counter whenever the user
brings the app to the foreground, and `startBackgroundKeepalive` has exactly one caller - the
`'background'` transition, gated on an established connection, which needs an `openConnection()`
from `'active'`. Every window is preceded by a foreground visit that resets the counter, so
accumulation is unreachable. The real constraint is stricter: overrunning needs ONE unbroken ~6
hour background stretch in which the service never stopped. What matters is not how many windows
are armed, it is that a single window's teardown always lands - which is why
`src/notifications/foregroundService.ts` owns the native state behind one serialized reconcile
loop, retries a stop rather than swallowing it, and issues an unconditional stop at process start
for a service Android restarted with nothing in JS tracking it.

**Not "fixing the unmount": React unmounts correctly.** This sentence used to end "fixing the
unmount is the real repair", which named the wrong cause. Measured on 2026-08-29, six pops produce
six clean React unmounts and the native views are retained anyway - by Fabric's mount-item
machinery, not by `TerminalPane`, the WebView, `PagerView`, or `react-native-screens`, each of
which is eliminated by experiment. The WebView is the expensive passenger, not the cause: the
subtree still leaks with no WebView in the tree. See the REACT-NATIVE-5 section of
[docs/developer-guide.md](developer-guide.md) for the measurements.
Nothing is lost by the handover on a build that HAS remote push: the desktop suppresses its own
push only while this phone's channel is established, so the same alert categories keep firing
through push instead.

**Known consequence for builds without FCM.** A build with no `google-services.json` reports
`unavailable-no-fcm` (`pushRegistration.ts`) and has no remote push at all, so for those installs
- self-hosted, built from source - background alerting now ends with the keepalive rather than
continuing indefinitely. The ceiling is deliberately NOT relaxed for them: Android enforces its
own, harder cap on the same service regardless of whether push exists, so an exemption would hand
the least-supported configuration the one most likely to be killed mid-use. The honest summary is
that an unbounded foreground service was never a supported alerting channel, it just had not been
stopped yet.

The keepalive also does not start unless settings have **hydrated** (an early background would
otherwise read the in-memory `'foreground-service'` default over a persisted `'push-only'`) and
`POST_NOTIFICATIONS` is not known-denied - with the permission denied the local notifier can
display nothing, so the service would spend the budget to deliver nothing. "Known-denied" means
asked AND refused, and needs both the cache and the persisted
`hasRequestedNotificationPermission` flag to establish: Android has no `NOT_DETERMINED`
authorization status, so a permission never requested reads back exactly like one the user
turned down. Reconnects re-subscribe
and
re-snapshot everything (the wire has no cursors by design); the triage home follows board
snapshots - every task with a non-null `session_id` gets a `read-stream` subscription, and
terminal bytes for sessions not open on screen are dropped at the phone's buffer boundary.

## Rendering

The primary session view renders the **transcript styled as a terminal**: it reflows to phone
width (a client-side re-layout of the parsed transcript text, independent of the PTY grid),
streams the in-progress turn token-by-token, and renders `AskUserQuestion`/permission prompts as
tappable cards. It is
built on FlashList v2 block cells (see `.claude/rules/ui-conventions.md`): the phone holds a
contiguous transcript WINDOW, never the whole conversation - the newest page loads on screen
open via the `transcript-window` action, older pages load on scroll-up, and settled content
streams in as indexed delta upserts (protocol v2: changed/new entries only, chunked under a
byte budget and deflate-compressed on the wire, merged identity-preservingly so unchanged rows
never re-render). The live in-progress turn is a cleaned tail of the raw PTY stream
(`src/terminal/liveTail.ts` interprets only line-identity control bytes, filters spinner/frame
chrome, and resets on full-screen redraws), shown while the session is thinking and replaced
when settled entries land at the window's end. Markdown renders through the `MarkdownBlock`
adapter (react-native-enriched-markdown, swappable in one file).

The raw interactive terminal is the full-fidelity view: xterm.js bundled offline in a WebView
(`src/terminal/xterm.html`, assembled by `scripts/buildXtermHtml.mjs` from the page fragments
under `scripts/xterm-page/`, CSP-locked to
inline-only), fed the scrollback snapshot plus live PTY chunks over a small postMessage bridge
(`src/terminal/terminalBridge.ts`). The desktop reports its PTY grid (`ptyDimensions` on the
snapshot, `terminal-resize` events on change), so the phone renders at the exact grid the bytes
were laid out for instead of inferring a width. It is a **faithful read-only mirror**: it renders
that grid 1:1 with horizontal pan, follow-the-cursor and pinch-zoom, and sizes the font so the
grid's ROWS fill the phone's height (a wider-than-screen grid then overflows and pans). It
**never resizes the desktop PTY** - a shared session must not be reshaped by the phone, so the
only thing sent upstream is typed input. The protocol carries `resize` and `release-size` actions
on the `interactive-terminal` verb, but they exist for the desktop: `src/channel/verbClient.ts`
exposes `write` alone, and nothing in `src/` sends the other two. (A phone-requested grid for
desktop-parked sessions was built, verified live end to end, and removed the same day: the
phone-fitted narrow grid read WORSE than the desktop's own layout, whose rules and boxes are
drawn for a wide frame - `docs/terminal-ownership-design.md` records the full arc. The durable
fix is desktop-side: unwatched sessions rest at a detail-shaped 210x48 grid, so the mirror is
identical whether a desktop surface shows the session or not.) A pre-0.4.0 desktop that reports
no grid falls back to inferring the column count from the scrollback. Arrow keys track the
terminal's DECCKM mode (CSI vs SS3); the quick-key bar (Esc / Tab / arrows / Enter / Ctrl-C /
slash) plus a text input row write through `interactive-terminal`.

## Composer and voice dictation

The conversation composer sends through `send-user-message` (the desktop injects it as a
bracketed paste, exactly like its own Send box). Dictation uses the OS speech engines via
`expo-speech-recognition` (iOS `SFSpeechRecognizer`, Android `SpeechRecognizer` - free, no
per-message cost), isolated in `src/voice/useDictation.ts`. Partial results stream into the
composer; on a final result the default mode **auto-sends**, configurable in Settings to
review-before-sending or off (`src/state/settingsStore.ts`, key `settings.dictationMode`).

## Notification pipeline

1. The desktop POSTs directly to Expo's push API (no maintainer server in the data path). FCM
   and APNs credentials live only in the maintainer's EAS account.
2. The phone's `ExponentPushToken` is exchanged over the paired E2E channel and treated as a
   per-device bearer secret.
3. The payload is ciphertext plus a generic placeholder (see `.claude/rules/e2e-notification-privacy.md`).
   On iOS, a Notification Service Extension (`targets/nse/`, injected at prebuild by
   `plugins/withIosNotificationServiceExtension.ts`, no eject) decrypts and rewrites the
   notification on-device. On Android, a high-priority data-only FCM message is received
   by a headless `expo-task-manager` task (registered through `Notifications.registerTaskAsync`),
   which decrypts it and hands the rich local notification to Notifee to display. Notifee owns
   display and press events, not receipt.
   **The placeholder `title`/`body` are sent to iOS devices only.** The desktop branches on the
   registration's `platform`: Android gets a data-only message, because expo-notifications
   presents any push carrying a title or body itself, natively, ON TOP of the decrypted one the
   background task posts - which showed every Android alert twice. Omitting both suppresses the
   native render while the task still runs. **iOS keeps them, and that is now load bearing rather
   than a fallback:** APNs invokes a service extension only for a push carrying
   `mutable-content: 1` AND an alert, so making iOS data-only to match Android would silently
   stop the extension running and leave iOS permanently on the placeholder.

   **`channelId` counts as visible content and must be omitted too**, which is the sharp edge of
   the rule above. Expo attaches an FCM `android.notification` block to any message carrying it,
   and that block is what decides who renders: with one present, and the app BACKGROUNDED OR
   KILLED (the case this pipeline exists for), the FCM SDK draws the tray item ITSELF and does not
   call `onMessageReceived`, so the background task never runs. Sending `channelId` with no title
   or body therefore produces the worst of both - a blank OS-drawn row (SystemUI substitutes
   "Expand to view" for a notification with no renderable content) and a silently dropped payload.
   Nothing is lost by omitting it: the channel is chosen on the phone by
   `channelIdForCategory(decrypted.category)` after decryption, which is strictly better because
   only the phone knows the category. The desktop sent it until 2026-08-20, which is how this was
   found: every Android push rendered as a blank tray row and its payload was dropped in silence.
   Fixed on the desktop send path (`mobile-bridge/push/push-notifier.ts`), which no longer sends
   `channelId` at all.

   Two halves of that claim have different evidence, which is worth stating because the whole
   section and the debugging recipe in [developer-guide.md](developer-guide.md) rest on it. The
   CLIENT-side half (an `android.notification` block moves rendering to the FCM SDK for a
   backgrounded or killed app) is documented FCM behaviour. A foregrounded app is the exception -
   FCM calls `onMessageReceived` there whatever the payload shape - which does not change the
   conclusion, since a foregrounded phone is separately suppressed by presence logic. The
   SERVER-side half (that Expo attaches that block for any message carrying `channelId`) happens
   at `exp.host`, outside this repo, and has NOT been verified against Expo's push-service source;
   it is consistent with community reports and with `expo-notifications` modelling `channelId`
   under `FirebaseRemoteMessageNotification` rather than the data object.
4. Presence suppression: when the app is foregrounded with the channel up, the desktop notifies
   over the socket and skips the push. The phone re-checks this on receipt too, gating on app
   state AND channel state together, each with a deliberately different polarity. App state
   suppresses only when provably `'active'` (never "not background": a killed-app launch has no
   resumed Activity, and reports whatever the native module gives a paused context - most likely
   `'background'`, possibly `null`/`'unknown'` - so the gate deliberately treats every non-`'active'`
   value alike rather than testing for one). Channel state suppresses unless the channel is
   provably DOWN - `transportState` of `'idle'` or `'closed'` with nothing established. A bare
   `established` read would be wrong, because it drops on every transport blip, so a momentary
   reconnect would fire a notification over the top of the UI.

   Be precise about how much that second half actually lets through. `RelayTransport` only reaches
   `'closed'` on an explicit `close()`, and only sits at `'idle'` before its first dial; a
   foreground outage retries forever, cycling `'connecting'`/`'reconnecting'`. So a foregrounded
   phone in a dead zone still reads as watching, and the let-through case is really
   before-first-connect or after-a-deliberate-teardown, not foregrounded-but-disconnected in
   general. Separating a blip from a sustained outage would need a time-in-state the store does not
   carry, and a foregrounded user already has the connection banner telling them the link is down,
   so this is accepted rather than fixed.

Phone side (`src/notifications/`; rich display, registration, the permission request, tap
routing, and the permission-state surface in Settings are all cross-platform now that the iOS
Notification Service Extension has shipped, though the two platforms decrypt in different
processes - Notifee's background handler on Android, a separate extension process on iOS): the
32-byte push key is
generated on-device and exchanged via the `register-push` verb on every established bootstrap,
alongside the device's enabled `categories` (`pushRegistration.ts` - idempotent, re-sent on Expo
token rotation or a category-preference change, and non-fatal without FCM credentials or against
an older desktop; `getPushRegistrationStatus()` feeds the Settings UI). Preferences are enforced
**desktop-side**: the desktop filters outgoing notifications to the device's registered set
before sealing, so the iOS Notification Service Extension never needs to know about them.
`pushDecrypt.ts` opens envelopes with the phone's static public key as the AAD and maps the five
categories (`categoryCopy.ts` - `input-required` / `turn-complete` / `session-failed` /
`plan-complete` / `spawn-stalled`, named for cross-vendor task-lifecycle vocabulary rather than
any one agent's terms) onto four notifee channels (needs-attention / completions / failures /
stalls); any failure degrades to the generic placeholder.

**What "degrades to the placeholder" does and does not promise.** It is a statement about what is
RENDERED: a decrypt that fails for any reason (missing key, wrong key, wrong recipient AAD, tamper,
malformed, stale `sentAt`), or a rich notification that fails to post, still shows the generic
"Kangentic / Agent needs attention" rather than ciphertext or plaintext. It is not a delivery
guarantee, and since the Android message became data-only it cannot be read as one: there is no
OS-drawn notification behind the task any more, so anything that stops the headless JS from running
at all produces silence rather than a placeholder. The receive path therefore degrades at each step
it can reach - a failed rich display falls through to the placeholder instead of escaping,
`createNotificationChannels()` is awaited so a cold launch cannot outrun it, and a failed
`registerTaskAsync` is recorded and surfaced in Settings rather than swallowed. **Doze and
app-standby throttling of a headless launch remain outside what JS can address**, and are accepted
residual risk rather than a covered case.

| Category | Title (`titleForCategory`) | Default |
|----------|----------------------------|---------|
| `input-required` | "Agent needs your input" | on |
| `turn-complete` | "Agent went idle" | on |
| `session-failed` | "Session stopped" | on |
| `plan-complete` | "Plan complete" | on |
| `spawn-stalled` | "Still preparing" | **off** |

`spawn-stalled` ("slow starts") is the one default-off category. It stays in the protocol, the
Settings list, and the `stalls` channel - defaulted off, not removed, so re-enabling it sticks.
The defaults live in `PUSH_CATEGORY_DEFAULTS` (`src/state/settingsStore.ts`) as a
`Record<PushCategory, boolean>` literal, so a category added to the protocol is a compile error
rather than a silent default. Because `setPushCategoryEnabled` persists the whole map, a bare
default change could not reach installs that had ever touched a toggle; the store therefore reads
a `settings.pushCategoriesEnabled.v2` key and, when it is absent, migrates the v1 map by forcing
`spawn-stalled` false and copying every other category through unchanged.

`turn-complete` is **settle-debounced on both sides**, and its name is now historical: it reports
a session going quiet, not a turn ending. Every exchange in a conversation ends in idle, so firing
on each `thinking -> idle` transition produced one alert per reply (20+ for a single trivial
task). Both producers now arm a ~45s timer on reaching idle, cancel it if the session returns to
`thinking` or `permission` (or exits), and re-check the live state when it fires: the desktop in
`push-notifier.ts` (mirroring its 2s permission debounce) and the phone in `localNotifier.ts`.
On the phone, "still idle" means `state === 'idle'` **and** `feedStatus !== 'ended'`: a
`session-ended` event sets `feedStatus` and leaves `state` untouched, so checking `state` alone
would let a pending settle outlive the session and fire "Agent went idle" 45s after
`session-failed` - or, for a deliberate stop, fire an alert where the design is to send none.
Both are needed - the desktop suppresses remote push for any device with a live bridge session, so
during the five-minute background keepalive the local notifier is the only thing firing.

Killed-app data messages run through a
headless expo-notifications background task (`backgroundPushTask.ts`, registered from `index.js`
outside React). While backgrounded in foreground-service mode, `localNotifier.ts` turns
activity-store transitions into the same notifications locally (three of the five categories have
an activity-store signal to fire from; 30s per-session-per-category cooldown, suppressed while
foregrounded, and gated by the same per-category Settings toggle as remote push), and
`foregroundService.ts` owns the ongoing LOW-importance connection notification, and with it the
service's native state: callers declare a desired state and one serialized reconcile loop applies
it, so a start and a stop can never interleave into an orphaned service (MOBILE-3).

Taps route to the task screen via `tapRouter.ts`, differently per platform because the two carry
task identity differently. Android reads `{ taskId, projectId, sessionId }` straight off the
notification, which Notifee posted after decrypting. On iOS the tapped notification carries only
the sealed blob, and deliberately still does: the Notification Service Extension rewrites the
title and body but never touches `userInfo`, so no task identity is stored in the OS-visible
object. The router decrypts it **on tap**, when the app is running and the
push key is reachable, and routes from the plaintext (`addNotificationResponseReceivedListener`
for a warm tap, `getLastNotificationResponseAsync()` for a cold start). That is what keeps
`taskId` out of the OS-visible payload; a plaintext routing id in `data` would be the easy version
and is what `e2e-notification-privacy.md` forbids. A failed decrypt routes nowhere and the app
opens to Home.

Those two iOS deliveries are independent, and one tap can arrive through both, so the router
de-duplicates on `notification.request.identifier` and routes a given tap once. This mirrors
expo-notifications' own `useLastNotificationResponse`, which reads the cached response and
subscribes to the listener and then compares the same field (`determineNextResponse`); the
package's changelog records a fixed iOS bug where the response listener emitted duplicate
events. Without the guard the same task screen is pushed twice and the user needs two back
presses to leave it. The guard engages only on a non-empty string identifier, so a payload
without one still routes: dropping a real tap is worse than a rare double.

The runtime notification permission - Android 13+'s `POST_NOTIFICATIONS` and iOS's
`UNUserNotificationCenter` authorization, both via `notifee.requestPermission()` - is requested
once, the first time a session establishes. Establishment is the paired signal, so the one rule
reaches both a fresh install (prompted when pairing first connects, not on a cold launch) and an
install paired long before the prompt existed (prompted on its first establishment after
updating). `settings.hasRequestedNotificationPermission` makes it once-ever, since
`onEstablished` re-fires on every reconnect (a rekey does not - an already-established
re-handshake routes to `onRekey` instead). Two further guards: a user whose mode is `'off'` is
never prompted at all, and an in-flight guard covers the window where an open system dialog
backgrounds the app and the reconnect re-establishes before the flag is persisted.

**iOS was never asked at all until this landed**, and the failure was silent rather than loud:
`getDevicePushTokenAsync` only calls `registerForRemoteNotifications()`, which yields an APNs
token with no user authorization behind it - so the phone got a token, registration reported
success, the desktop sent, APNs delivered, and iOS discarded every alert.

The last known state is cached in `permissionCache.ts` - deliberately notifee-free, because the
keepalive gate must read it synchronously on the background transition and an awaited read there
is what causes `ForegroundServiceDidNotStartInTimeException`. It is a **tri-state**
(`granted` / `denied` / `not-determined`) because the platforms differ in what they can express.
iOS reports `NOT_DETERMINED`, so "nobody has been asked" is directly readable there - and it must
be preferred over the persisted flag, since iOS Keychain items survive app deletion and the flag
can outlive the authorization it describes: the prompt therefore fires on iOS whenever the OS
reports not-determined, whatever the flag says. Android has no such status (notifee reports plain
`DENIED`), so there the persisted flag remains the only record that the app ever asked, and both
the keepalive gate and the Settings notice still pair the two. Once denied twice, Android stops
showing the runtime prompt entirely, so Settings offers a route to the system notification
settings instead - on both platforms, since an iOS user with a denied authorization needs exactly
the same recovery route.

Unpairing sends `register-push` with `action: 'unregister'` while
the channel is still up and wipes the local push key (`pushKeys.clearPushRegistration()`), so the
previously paired desktop can no longer push anything this phone can decrypt - delivery through
Expo/FCM still reaches the OS-level token, but every attempt now degrades to the generic
placeholder, on the same failure path as a tampered or wrong-key blob.

## Later phases (future, not built yet)

- **WebRTC data channel upgrade**: direct P2P for the majority of network pairs, with signaling
  over the already-secure channel and DTLS fingerprints pinned at pairing time. The relay
  remains the permanent fallback.
- **Tailscale "bring your own network"** detection for users who already run a tailnet.

## See Also

- [docs/security.md](security.md) - threat model, the pairing ceremony's crypto detail, key
  storage.
- [docs/developer-guide.md](developer-guide.md) - setup, build system, testing tiers.
