---
paths:
  - "src/observability/**"
  - "src/pairing/**"
  - "src/channel/**"
  - "src/demo/**"
  - "src/devsupport/**"
  - "src/notifications/**"
  - "app/+native-intent.ts"
---
# Rule: crash reporting reports crashes, never content

Sentry is the only path by which this app's data reaches a third party that is not the relay or
the push network. The app tells users their session content never leaves the device in cleartext
(`docs/privacy-policy.md`, `docs/security.md`), so a crash reporter that captured a console line,
a screenshot, or a request URL would quietly make that untrue. The default configuration of
`@sentry/react-native` does capture all three.

The load-bearing fact is that **a JavaScript `beforeSend` hook does not filter native events**. A
hard iOS or Android crash is captured and sent by sentry-cocoa / sentry-android without ever
passing through the JS layer. Worse, JS breadcrumbs are synced into the native scope, so a
console breadcrumb recorded in JS rides a native crash straight past every JS scrubber. A
scrubber is therefore a second line of defence, never the control itself.

## The rule

- **One door.** `src/observability/` is the only place that may import `@sentry/react-native`.
  Everywhere else, crash reporting is automatic through the global handler. This exists so that
  no other module can re-enable a default the init deliberately turned off, or capture an event
  that bypasses the configured scrubber. Behind the door there are exactly two capture calls:
  `reportCaughtError` (the root error boundary; the message is kept, because a render throw's
  message is app-authored and is what makes the event diagnosable) and `reportHandledError` (the
  handled-error door, next bullet but one; the message is never sent). Nothing else calls
  `captureException`.
- **`src/pairing/**`, `src/channel/**`, `src/demo/**`, `src/devsupport/**`,
  `src/notifications/**`, and `app/+native-intent.ts` must not report
  to Sentry at all**, neither the SDK nor the `src/observability/` wrapper. Their error messages can carry
  ciphertext, key material, or attacker-controlled bytes (`src/devsupport/` holds the loopback
  transport and stub peer the shipped demo runs its handshake against, and `app/+native-intent.ts`
  receives raw deep-link URLs before any error boundary exists):
  `src/notifications/pushDecrypt.ts` states it directly, and swallows without logging for
  exactly this reason (see `e2e-notification-privacy.md`). The global handler still reports a
  genuine crash originating in these directories; what is banned is a hand-written
  `captureException` call.
- **Handled failures go through `reportHandledError(site, error)`, and only the door decides
  what leaves.** Call it where the user is shown a failure or a wrong-but-plausible state: an
  inline error note, a silently empty column, a fallback to the pairing CTA. Never for an
  expected best-effort catch (a dropped keystroke, a permission refresh, a snippet pre-warm, a
  retried bootstrap), and never for a pairing or handshake failure even from a screen
  (`PairingScanScreen`, `PairingConfirmScreen`): the door strips the message, but a ceremony
  failure's existence and timing is itself information about a pairing attempt, and
  `src/pairing/`'s convention is silence. `site` is a member of the `HandledErrorSite` union, a
  literal and never computed, and it is the only thing a caller supplies besides the error. The
  door forwards no message text and no `cause`; it tags `site`, `errorName` and, for a
  capability error, `verb`, keeps the stack frames, fingerprints on those three, drops
  `NotConnectedError` and `ChannelDisconnectedError` by name and the transport-noise patterns by
  the ORIGINAL message, and rate-limits per key (one a minute, ten a launch). `scrubEvent`
  re-redacts every exception value on any event tagged `site`, as the second line. Adding a site
  means adding the literal and asserting the call in that surface's component test, on failure
  and not on success. Sites still owed: MoveTask, EditTask, TaskActions, the Devices unpair,
  FileDiff, and `settingsStore.readSetting` (its import graph reaches a dozen test files; do it
  once a shared vitest mock for the door exists). `usePromptAnswer` matches on message text today
  and needs a typed stale-prompt error at the verb layer, not a door call.
- **Every privacy control is set at its source, not in `beforeSend`.** Turning a capture off
  means removing the integration or disabling the feature in `Sentry.init()`. Specifically:
  no screenshots, no view hierarchy, no console breadcrumbs, no network (`xhr`/`fetch`)
  breadcrumbs, no captured failed requests, no structured logs, no session tracking, no
  performance tracing, no Session Replay, no PII, no message text from a handled catch. This
  list is the canonical enumeration;
  `docs/security.md` mirrors it, so an addition here has to land there in the same change.
- **JS breadcrumbs are allowlisted, not denylisted.** An unanticipated category must be dropped
  by default, because a future SDK version can add one this repo never reviewed. Read the
  breadcrumb entry under Known limitations before assuming this covers a native crash: it does
  not.
- **The DSN is never committed.** It arrives as `EXPO_PUBLIC_SENTRY_DSN` from the `SENTRY_DSN`
  GitHub repository **variable** (deliberately a variable, not a secret: a DSN ships inside the
  published bundle and is write-only, so keeping it out of the repo is about fork quota, not
  confidentiality). Absent, `Sentry.init()` is never called, so a build from source collects
  nothing. This is what keeps the app self-hostable without routing a fork's crashes into
  Kangentic's Sentry project.
- **Changing any of the above changes what leaves a user's device**, so it also requires
  updating `docs/privacy-policy.md` and `docs/security.md`, and re-checking the Play Data Safety
  and App Store privacy declarations.
- **The crash-test affordance (`crashTestEnabled`, `throwTestError`, `crashNatively`,
  `reportHandledTestError` in `crashReporting.ts`) exists to verify the above against a real
  delivered payload, not to relax it.** `EXPO_PUBLIC_KANGENTIC_CRASHTEST` follows the DSN's own
  rule: dispatch-only (`build-android.yml`'s and `build-ios.yml`'s `crash_test` inputs), never
  in `eas.json`, defaults off, forced off on a tag build. Note the tag clause is the weaker half:
  this project releases by DISPATCH (`-f submit_track=internal`, `-f submit=testflight`), not by
  tag, so the gates that actually matter are Android's `plan` job refusing any dispatch that sets
  both `crash_test` and a real `submit_track`, backed by `submit-play`'s own
  `inputs.crash_test != true`, and the refusal step at the top of both iOS build jobs plus
  `submit-testflight`'s own clause. All are pinned by `tests/unit/buildWorkflow.test.ts`. A
  crash-test build reports to its own Sentry environment, `crash-test`, because it carries the
  SAME release string as the shipped build cut from that version. The flag also gates
  `debug: true`, which DOES reach native (`initNativeSdk` does not strip it) - see the crash
  reporting section of `docs/developer-guide.md`. The third row, `reportHandledTestError`, is
  how the door's redaction is checked against a delivered event: its canary message must not
  arrive.

## Known limitations, deliberately not papered over

**Stack frames cannot be scoped by source file on-device.** Under Expo,
`createReactNativeRewriteFrames()` rewrites every frame's `filename` to a single constant bundle
name (`app:///index.android.bundle` / `app:///main.jsbundle`) before `beforeSend` runs; real
paths are resolved server-side from the uploaded source map. So a rule like "redact the message
if the crash came from `src/pairing/`" is not implementable in the SDK, and is not attempted -
a check that can never fire is worse than none, because it reads as protection.

**The breadcrumb controls are JavaScript-side only.** This is the sharpest edge of the
`beforeSend`-cannot-reach-native fact above, and it cuts the other way too:
`@sentry/react-native` destructures `beforeSend`, `beforeBreadcrumb` and `integrations` out of
the options object before passing the rest to `initNativeSdk`
(`node_modules/@sentry/react-native/dist/js/wrapper.js`), and neither `RNSentryModuleImpl.java`
nor `RNSentry.mm` bridges a replacement. So `breadcrumbsIntegration({ console: false, ... })`
and `allowlistBreadcrumb` govern the JS scope only. sentry-android keeps its own default
auto-breadcrumbs and those ride a NATIVE crash unfiltered. **Observed directly** (a
crash-test build with `debug: true`, a real native crash, the delivered event read back through
the Sentry MCP - not inferred from source): `app.lifecycle` (foreground/background transitions),
`device.event` (battery level, charging state, screen on/off), and `network.event`, which is
more detailed than "coarse app-lifecycle timing" suggests - it carries `action`,
`network_type`, `vpn_active`, `signal_strength`, `download_bandwidth`, and `upload_bandwidth`.
None of it is session content, but "the allowlist is default-deny" is true of the JS path and
not of the native one. Closing it needs native configuration through a config plugin (Android
reads `io.sentry.breadcrumbs.*` manifest meta-data; iOS has no equivalent plist switch), which
is a larger change than this rule should smuggle in. Say "JS breadcrumbs are allowlisted", not
"breadcrumbs are allowlisted".

**A crash caught by the operating system, not by the app's own code, carries a per-install
identifier in `user.id` - `sendDefaultPii: false` does not stop it.** sentry-android always
populates `contexts.device.id` (a random UUID generated once per app install, unrelated to
`Secure.ANDROID_ID` or any advertising ID; confirmed against docs.sentry.io) in the device
context, and on the uncaught-exception path it additionally promotes that same value into
`user.id` before the JS layer, and `scrubEvent`, ever sees the event - `beforeSend` does not run
for a native-captured event at all. Confirmed with two real delivered events off the same
install: a JS-caught throw carried `Users: 0` (`scrubEvent` strips `user`), the OS-caught crash
carried `Users: 1` with `user.id` identical to that event's `contexts.device.id`. This is the
sharpest instance of "`beforeSend` cannot reach native" in the whole file: it is not a missing
breadcrumb, it is an identifier. **`Sentry.setUser(null)` was tried as a suppression, called
immediately after `Sentry.init()`, and did not visibly suppress it**: a fresh native crash with
that call in place still carried `user.id` equal to `contexts.device.id`. `setUser` does bridge
to the native scope (`RNSentry.setUser`, a runtime call, unlike an init option destructured out
in wrapper.js) and Sentry's own docs describe `contexts.device.id` as populated by the device
context independent of the user scope, which is the likely reason nulling the user did not
touch it - but that explanation was not confirmed by reading sentry-android's source in this
session, and the probe run also crossed a fresh app install (a new `device.id` on its own), so
the observation does not isolate `setUser(null)` as cleanly as a controlled before/after would.
There is no known JS-reachable way to suppress this identifier; the control point is disclosure,
not removal. `docs/privacy-policy.md` and `docs/store-listing.md` describe this identifier
rather than claim it does not exist.

**What was NOT tested: a real native (NDK/signal-handler) crash.** Every native-path observation
above came from `Sentry.nativeCrash()`, which is `RNSentryModuleImpl.crash()` throwing a
`RuntimeException` caught by Android's `UncaughtExceptionHandler` - `platform: java`,
`mechanism: UncaughtExceptionHandler`. That is the Java-uncaught path, not a SIGSEGV or other
signal caught by sentry-android's NDK handler. The two paths share the same auto-breadcrumb and
`user.id` machinery in sentry-android, so there is no specific reason to expect them to differ,
but that is an inference, not an observation, and this file says so rather than implying full
coverage.

**Channel-origin exception messages reach Sentry on the UNCAUGHT path.** The handled-error door
removes them from every deliberate catch that reports, and the import ban stops
`src/pairing/`, `src/channel/` and `src/notifications/` making a deliberate capture call; neither
does anything about an error from those directories propagating out uncaught and being picked
up by the global handler. That is not hypothetical: `EXPECTED_TRANSPORT_NOISE` in
`crashReporting.ts` exists precisely because `src/channel/relayTransport.ts` errors do arrive,
and `CapabilityError` (`src/channel/verbClient.ts`) puts the desktop-supplied `response.error`
string verbatim into its message. `scrubEvent` deliberately never touches `exception.value` on
an uncaught event - reporting the message is the point of a crash reporter - so such a message
ships as-is. Truncating or genericizing peer-supplied error text at its construction site is
the fix if this ever matters; until then it is a named gap, not an unbroken invariant.

**The door trades diagnosability for the redaction, deliberately.** Every bare `Error` caught at
one site shares one issue (the fingerprint is site, class name, verb), so a Keychain error and a
JSON error at the same site are told apart only by their stack frames inside it. The fix is a
typed error at the throw site, which `ChannelDisconnectedError` and `CapabilityTimeoutError` in
`src/channel/capabilityClient.ts` began; never a message allowlist.

**Counts read out of Sentry for a handled site are lower bounds.** The door reports at most one
event per site, class and verb per minute and ten per launch, and the SDK's default Dedupe
integration drops back-to-back identical events besides. Use them to see THAT a site fails, not
how often.

## Enforcement (self-maintaining)

- **Lint (live now):** `eslint.config.mjs` declares three `no-restricted-imports` zones - two
  confining `@sentry/*` to `src/observability/` (one for `.ts`/`.tsx` with `allowTypeImports`,
  one for `.js`/`.mjs`/`.cjs`), and one banning both the SDK and the wrapper from the pairing,
  channel, demo, devsupport, and notification directories plus `app/+native-intent.ts`.
  `Lint (ESLint)` is a required status check on `main`,
  so this is mechanical rather than review-only. Each zone was verified to fire by probe file,
  not merely assumed, and `tests/unit/eslintConfig.test.ts` pins BOTH directions: every banned
  entry refuses the door, and `src/screens`, `src/components`, `src/connection` and `src/state`
  may import it, so a reordered zone cannot silently ban the door from every screen and read as
  "nothing calls it". **Its one hole is closed by a scan for `src/` and `app/`:**
  `no-restricted-imports` matches `import` syntax only, never `require()` or a dynamic
  `import()`, and `metro.config.js` legitimately does `require('@sentry/react-native/metro')`,
  so the pattern is live in this repo. `tests/unit/crashReportingConfinement.test.ts` scans
  every source file for a `require()` or `import()` of the SDK outside `src/observability/`,
  and for any route at all to the SDK or the wrapper from the banned directories;
  `metro.config.js` sits outside the scan by design.
- **Test (live now):** `tests/unit/scrubEvent.test.ts` locks the scrubber, the `site`-keyed
  redaction and the breadcrumb allowlist, including its default-deny behaviour.
  `tests/unit/crashReporting.test.ts` locks the door's contract (a synthetic error, frames only,
  the three tags, the fingerprint, the exclusions, the cooldown and cap) and the four
  environments. `tests/unit/buildWorkflow.test.ts` locks the pre-prebuild ordering of the Sentry
  env export on both platforms, the crash-test gates, and asserts no DSN is committed. One
  mechanical consequence for the vitest tier: a test that loads a module importing the door
  while stubbing `react-native` without `NativeModules` must
  `vi.mock('@/observability/crashReporting')`, because `@sentry/react-native`'s wrapper reads
  `NativeModules.RNSentry` at import time.
- **Review (live now):** the `crypto-pairing-auditor` agent should treat any new Sentry call
  site, or any relaxation of an init option above, as in scope during `/code-review`.
- **Skill (live now):** `/sentry` (`.claude/skills/sentry/SKILL.md`) reads arriving issues and
  defers to this rule for the privacy controls and their known limitations rather than
  restating them. Its no-raw-payload boundary (never paste an event payload or a `user.id` into
  a task, PR, or reply) is this rule's "Known limitations" section applied at retrieval time, so
  the two move together.

## Scope

`src/observability/**` and the directories (plus `app/+native-intent.ts`) banned from reporting.
Does not govern what the desktop or relay log about themselves.
