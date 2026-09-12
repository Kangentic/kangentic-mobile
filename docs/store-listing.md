# Store listing copy

Draft copy for the Play Console (and later App Store) listing. Placeholder-grade but real text,
ready to paste.

**The en-US listing was completed on 2026-07-29** and no longer blocks the closed track: title,
short description, full description, 4 phone screenshots, 4 seven-inch, 4 ten-inch, the icon, and
the feature graphic are all uploaded (read back from `edits.listings` and `edits.images`). It is
still unsubmitted, like every other declaration - see the Data safety section below.

**Those uploaded screenshots are STALE and must be replaced before submitting.** They were
captured before the mock fixtures were rewritten (`src/connection/mockDesktop.ts`), and the
earlier fixtures were written about Kangentic's own backlog - so the frames currently sitting in
the Console advertise our engineering status as if it were a customer's: a relay self-host guide,
a capability-scoped push token migration, a flaky pairing flow. Re-upload from
`store/screenshots/`, which is the current set and now carries six per shelf rather than four.

The two Play Console image uploads are produced by `@kangentic/branding` and are not bundled
into the app - upload them by hand from `node_modules/@kangentic/branding/resources/mobile/`
(run `npm install` first; both are absent from an out-of-date install):

- `android-playstore-512.png` - the store listing icon.
- `android-feature-graphic-1024x500.png` - the feature graphic, required by Google Play for
  every track beyond internal testing.

## Screenshots

**Produced and tracked**, in [`store/screenshots/`](../store/screenshots/README.md). Every shelf
below carries the same six raw device captures, so both listings tell one story:

| Shelf | Size | Directory | Captured by |
|---|---|---|---|
| Play phone | 1080x1920 | `store/screenshots/android/phone/` | `node scripts/storeScreenshots.mjs all` |
| Play 7-inch tablet | 1080x1920 | `store/screenshots/android/seven-inch/` | the same command |
| Play 10-inch tablet | 1440x2560 | `store/screenshots/android/ten-inch/` | the same command |
| App Store 6.9-inch iPhone | 1320x2868 | `store/screenshots/ios/iphone-6.9/` | `gh workflow run build-ios.yml -f screenshots=true` |

All three Play shelves are required in the listing form as long as the app is distributed to
tablets. Restricting **Test and release -> Advanced settings -> Form factors** to phone should
drop the two tablet requirements; the tablet captures exist either way, so that is a reach
decision rather than a blocker. `ios.supportsTablet` is `false`, so App Store Connect wants the
single 6.9-inch shelf. Apple's minimum there is **one** (its upload help: "you're only required to
provide a single screenshot"), the cap is 10, and only the first 3 appear on install sheets - so
the "minimum three" an earlier version of this file claimed was the number Apple DISPLAYS, not the
number it requires. Six are tracked.

Upload the iPhone set through **Media Manager**, targeting **6.9"**. That is the source slot, and
App Store Connect derives 6.5", 6.3" and smaller from it - their controls are greyed out. The
version page happens to list the derived 6.5" slot first, which misleadingly reads as though 6.5"
is what it wants.

The Android shelves are captured locally against an emulator. The iOS shelf cannot be captured
from Windows and runs on a free macOS runner instead, at roughly 45 minutes per attempt.

Read `store/screenshots/README.md` before regenerating: Play demands exactly 16:9 or 9:16 on
every shelf including tablets, which is why the capture sets resolution and density
independently rather than using the emulator's own geometry.

## Play Console advisories - standing decisions

Play raises "For your next release" notes under **User experience**. They are advice, not gates,
and two of them are permanent fixtures rather than work items. Both were investigated on
2026-08-06 against release 0.3.0. **Read this section before acting on either warning**: the
obvious response to each is wrong, and both look like one-line fixes.

### "Your app uses deprecated APIs or parameters for edge-to-edge" - upstream, no action

Flags `Window.getStatusBarColor`, `setStatusBarColor`, `setNavigationBarColor`. **Every flagged
call site is framework code**, none of it ours:

- React Native: `WindowUtil.kt`'s `Window.enableEdgeToEdge()` assigns both colors under
  `@Suppress("DEPRECATION")`, and `StatusBarModule.kt`'s `getTypedExportedConstants` reads
  `window.statusBarColor` on module init regardless of what JS does.
- Material Components 1.13.0 (`BottomSheetDialog` / `EdgeToEdgeUtils`, R8-renamed to
  `bottomsheet.a` and `internal.c`), which arrives via `react-native-screens`, `expo-router`,
  `@expo/ui` and `@expo/log-box`. 1.13.0 is current.

App code touches none of it. The only status-bar usage is `<StatusBar style="light" />` from
`expo-status-bar` (`app/_layout.tsx`), which drives bar appearance through `WindowInsetsController`
rather than colors. The APIs are deprecated and already no-op at targetSdk 35 and above, and this
app targets 36 - Play's scan is static, so it flags the DEX reference whether or not the code can
run.

**Re-check after the next React Native, Expo SDK, or Material bump and expect it to clear itself.
Do not attempt an app-level workaround**; there is no app-level call to remove.

### "Remove resizability and orientation restrictions ... large screen devices" - deliberate, permanent

Flags `MainActivity` and ML Kit's `GmsBarcodeScanningDelegateActivity`, both
`android:screenOrientation="PORTRAIT"`. `MainActivity`'s comes from `orientation: 'portrait'` in
`app.config.ts`. **The lock stays.** `tests/unit/appConfigOrientation.test.ts` pins it so the
one-line "fix" fails loudly.

The reasoning, because the warning implies a deadline that does not exist:

- **Large screens already adapt, and have since 0.3.0 shipped.** The app targets SDK 36 - not
  inferred from the Expo default but read off the generated `AndroidManifest.xml` at HEAD, and
  corroborated by the emulator reporting `v36` - so Android 16 already ignores `screenOrientation`,
  `resizeableActivity` and aspect-ratio limits on any display at sw600dp or wider, with no
  pillarboxing. What the advisory asks for is already the live behaviour on the devices it is
  about.
- **Phones are never forced.** Android 17 (API 37) removes the temporary opt-out property but
  **keeps the sw600dp threshold**: restrictions are ignored only on displays wider than 600dp.
  Screens under sw600dp, and apps categorised as games, stay exempt in 16 and 17 alike. There is
  no announced plan to extend this to phones, so "be adaptive before targetSdk 37" is not the
  situation.
- **Removing the lock would cost more than it buys.** It would newly expose phone landscape:
  the four capped `fitToContents` form sheets (`MoveTaskScreen`, `ProjectPickerScreen`,
  `CreateTaskScreen`, `EditTaskScreen`) now derive their caps from the window height
  (`src/lib/sheetContentHeights.ts`), so a ~360dp-tall window shrinks the capped region to its
  floor instead of overflowing - but a keyboard-up writing sheet still cannot fit that window,
  and every screen would need a visual pass with no forcing function behind it.

So the advisory will fire on every release, forever. That is the correct signal: we do
deliberately restrict phones to portrait.

**Closed doors - do not re-propose:**

- **`PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`.** Not merely that it expires at targetSdk 37:
  it restores compatibility mode, which **pillarboxes tablets that render fine today** at 617dp and
  720dp per our own shelf captures. It is a visible regression on the exact devices it claims to
  protect, and whether it even silences Play's static manifest scan is unverified.
- **`orientation: 'default'`.** Does not remove the attribute. `@expo/config-plugins`
  (`build/android/Orientation.js`) writes `unspecified` instead, so the manifest still carries
  `android:screenOrientation`. It would also flip iOS, since `orientation` is the cross-platform
  key that writes `UISupportedInterfaceOrientations` too.
- **A `tools:replace` plugin for the ML Kit activity.** It would strip the lock from
  `GmsBarcodeScanningDelegateActivity`, which is genuinely dead code here (`PairingScanScreen` uses
  the in-view `CameraView`, never `launchScanner`). But while `MainActivity` keeps its lock the
  advisory still fires, so the plugin buys nothing and adds a manifest-merge surface that only a
  real Gradle build can validate. Revisit only if `MainActivity`'s lock ever goes.
- **The `expo.camera.barcode-scanner-enabled` Gradle property.** Setting it `false` flips both
  `play-services-code-scanner` and `com.google.mlkit:barcode-scanning` to `compileOnly` from the
  same `build.gradle` line, which removes the ML Kit activity **and** breaks in-view QR scanning -
  the pairing ceremony.
- **Restricting Play's Form factors to phone.** Would drop tablet users, and would not silence
  this advisory anyway: it is a manifest scan, not a distribution check.

**What would reopen this.** If phone landscape ever becomes a supported shape, the known first
blocker is the keyboard-up writing sheets: the caps now derive from the window height and shrink
to their floors on a short window, but a ~360dp-tall landscape window minus a keyboard cannot
host even the floored Create/Edit sheets. Then `/store-screenshots` plus the Play large-screen
listing come into scope. Nothing about the shelves changes otherwise: Play requires 9:16 on all three Android
shelves, tablets included, so the captures are portrait by rule.

## App title

Kangentic

## Short description (Play Console limit: 80 characters)

Remote control for your Kangentic agent sessions, from your phone.

(66 characters)

## Full description

Kangentic Mobile is the companion app for Kangentic, the desktop tool for running coding agent
sessions. Pair your phone with your desktop once, then check on your agents, read their progress,
answer prompts, and review diffs from wherever you are.

Key features:

- Live session view: read the agent's transcript as a clean chat feed, or mirror the raw terminal
  when you need the full picture.
- Answer permission prompts and questions the agent raises, right from your phone.
- Review file changes with a per-file diff view before they land.
- Push notifications when a session needs your attention.
- End-to-end encrypted connection between your phone and desktop. No account required, and no
  Kangentic server ever sees your session content.

Kangentic Mobile requires the Kangentic desktop app running on the same network (or reachable
through a relay) to pair with.

## Notes for reviewers / app access

The app has no login and no account. Ordinarily it pairs with the Kangentic desktop app by
scanning a QR the desktop generates, which a reviewer has no way to obtain: **every real pairing
code is single-use and expires within minutes**, because the code is a one-time token mixed into
the encryption handshake as a pre-shared key. That is why a code shown in a screenshot or a video
is always dead by the time it is opened, and it is what iOS App Review hit three times on
Guideline 2.1(a) with 0.5.1 (build 9).

**A permanent demo code exists for exactly this.** It never expires, needs no desktop, and needs
no network connection.

### Paste this into App Review Information -> Notes, verbatim

> This app normally pairs with our desktop app by scanning a QR code. Pairing codes are
> single-use and expire after a few minutes for security, so we cannot give you a working one in
> advance. Instead we have built a permanent demo mode. It requires no account, no desktop
> computer, and no network connection.
>
> To use it, either:
>
> 1. Open the app, tap "Pair", and point the camera at the attached QR image
>    (demo-pairing-qr.png); or
> 2. Open the app, tap "Pair", and type this one word into the "Or paste a pairing link" field,
>    then tap "Pair":
>
>        demo
>
>    (The field shows "kangentic-pair://..." as a hint for normal pairing codes. You do not need
>    to type that prefix for the demo - the single word "demo" is enough.)
>
> Either way the app runs its normal pairing flow, shows a confirmation screen with a
> verification code, and after you tap "Confirm" it opens a fully populated, interactive demo
> containing simulated projects, tasks, agent conversations, a live terminal view, and code
> diffs. All of that content is simulated and generated on the device. Nothing connects to a
> server.
>
> The demo stays active if you close and reopen the app. To leave it, open Settings -> Paired
> desktop and tap "Unpair" twice.
>
> Camera access is used only to scan pairing QR codes. If you prefer not to grant it, use the
> typed code in option 2, which needs no camera.

The QR image to attach lives at `store/review/demo-pairing-qr.png`, and encodes the full,
correctly-formatted pairing URI (not the short code). Rebuild and verify it with
`node scripts/buildDemoPairingQr.mjs`, which refuses to write if the committed URI and the
derived one disagree.

### What the demo actually is

Not a mocked-out screen set: it runs the real pairing ceremony (a genuine Noise IKpsk0 handshake
with real SAS digits) and the real channel stack against an in-process peer over a loopback
transport, then pins a real trust anchor. Only the peer is local. See `src/demo/demoIdentity.ts`
for the design and `tests/unit/demoPairingHandshake.test.ts` for the proof it never touches a
relay.

Disclosing it here is what keeps a seamless in-app demo honest: the reviewer is told plainly that
the content is simulated, so the app not announcing it on every screen is presentation, not
deception.

## Data safety / App Privacy declarations

**Play's Data safety form was filled in on 2026-07-28 and had still not been submitted for review
on 2026-07-29**, and App Store Connect's App Privacy questionnaire is in progress with the same
two data types.

**Filled in is not submitted, and an earlier version of this file conflated them.** It claimed the
form was "submitted", which read as done. Publishing overview showed `Data safety - Complete Data
safety questionnaire` sitting under **Changes not yet submitted for review** the next day, along
with the store listing, content rating, target audience, ads declaration, privacy policy, health
apps declaration, and app category. Everything in that list is entered and none of it has reached
Google, because `Send app for review` stays disabled until the app dashboard reads 11 of 11. Check
Publishing overview before repeating a claim from this file: the Play API cannot see any of these
declarations, so the Console is the only source of truth for them.

The app collects two kinds of thing - crash
diagnostics and a per-install device identifier the crash SDK attaches on its own - so the
declarations stay short. The two stores slice those into a different number of boxes: Play takes
two entries, App Store Connect takes four, because Apple splits Diagnostics into three types and
`app.config.ts`'s iOS privacy manifest declares all three. Source of truth for the wording is
[privacy-policy.md](privacy-policy.md).

**Play Console - Data safety.** Declare two collected types:

- **Crash logs** (under *App info and performance*). Collected: **yes**.
  Purpose: **App functionality** and **Analytics**. Not advertising, not personalisation, not
  developer communications. Processed ephemerally: **no** (retained 30 days). Required or
  optional: **required**, because there is no in-app toggle. Encrypted in transit: **yes**.

  **Analytics is required here, and an earlier draft of this file got it wrong.** It read
  "App functionality / Diagnostics only - not analytics", which names a purpose the form does
  not offer: Play's purpose list is App functionality, Analytics, Developer communications,
  Advertising or marketing, Fraud prevention, Personalization, Account management. Diagnostics
  is a data TYPE in Play's taxonomy, sitting next to Crash logs, not a purpose. Crash reporting
  therefore has to be declared under App functionality plus Analytics, which is what the
  submitted form carries.

  Reports of failures the app caught and handled itself (`reportHandledError`, added by the
  2026-09-11 capture audit) fall under this same entry, and under Apple's Crash Data below: they
  are the same data class with strictly less content, since the error message is replaced by a
  fixed site label before it leaves the device. No new entry on either store is needed for them.
- **Device or other IDs.** Collected: **yes**. sentry-android attaches a per-install identifier
  on its own (`contexts.device.id`) and, on a crash the operating system catches rather than the
  app's own code, additionally promotes it into `user.id` - the `user.id` half confirmed by
  sending a real test crash from a release build and reading the delivered event back through the
  Sentry MCP; `sendDefaultPii: false` and this app's own
  `beforeSend` scrubber (`src/observability/scrubEvent.ts`) do not reach it, because neither runs
  on a native-captured event. Purpose: **App functionality** and **Analytics**, the same pair as
  Crash logs and for the same reason. Not linked to any other collected data, because there is
  none to link it to: no account, and no analytics or product-usage telemetry beyond the crash
  payload itself. Same transit/retention/required answers as Crash logs above.
- **The "shared with third parties" answer needs a deliberate read, not a guess.** Play defines
  sharing as transfer to a third party, but explicitly **excludes** transfer to a service
  provider processing data on the developer's behalf. Sentry is that kind of processor here, so
  the answer is most likely **no** - "collected, not shared" - for both types above. Nothing in
  the crash-payload verification touched Play's service-provider definition, so this stays a
  reading of the policy rather than a settled answer. Confirm against Play's current
  service-provider wording when filling the form rather than trusting this note: answering
  **yes** would be a conservative overstatement, and answering **no** incorrectly is a policy
  violation, so this is the one entry worth reading the guidance for.
- Declare **no** other type. In particular: no personal info, no approximate or precise location,
  no photos, no audio, no contacts, no app-usage analytics, and no "Diagnostics" beyond the two
  types above (performance tracing and session tracking are disabled). Note this is a statement
  about collected TYPES and does not contradict the Analytics PURPOSE above: the app ships no
  analytics product and gathers no usage telemetry, but Play models "why crash data is
  collected" with its Analytics purpose, which is the box the crash payload falls in.
- Data deletion: the app has no account, so there is no per-user deletion mechanism to declare.
  The device identifier is per-install and resets on reinstall; it is not tied to any user
  identity the app or Kangentic can look up.

**App Store Connect - App Privacy.** Under "Data Not Linked to You", declare:

- **Diagnostics -> Crash Data**, used for **App Functionality** and **Analytics**, and **not**
  used for tracking. Both purposes, matching the Play answer above and the
  `NSPrivacyCollectedDataTypePurposes` array in `app.config.ts`. Apple compares the questionnaire
  against the generated `PrivacyInfo.xcprivacy`, so answering App Functionality alone here while
  the manifest declares two would be a mismatch of Apple's own making.
- **Diagnostics -> Performance Data** and **Diagnostics -> Other Diagnostic Data**, same answers.
  These two are declared because `app.config.ts`'s `ios.privacyManifests` declares them (Sentry's
  own apple-privacy-manifest guidance lists all three Diagnostics types for its SDK), and Apple
  cross-checks the App Privacy answers against the generated `PrivacyInfo.xcprivacy`. Declaring
  them here is the conservative direction: over-declaring is allowed, under-declaring is the
  violation. Do not trim the manifest to two instead without deciding that as a compliance call -
  the two lists must move together, and `tests/unit/appConfigBrand.test.ts` pins the manifest half.
- **Identifiers -> Device ID**, used for **App Functionality** and **Analytics**, and **not** used
  for tracking. Same finding as the Play entry above: an OS-caught crash carries a per-install
  identifier sentry-android/sentry-cocoa attach independently of `sendDefaultPii`. Declared as
  Data Not Linked to You because there is no account or other data to link it to.
- Answer **No** to the tracking question for both (the app runs no ATT-relevant tracking and
  should not prompt for ATT).
- Declare nothing under "Data Linked to You" and nothing under "Data Used to Track You".
- Note for the encryption question: the existing `ITSAppUsesNonExemptEncryption: false` in
  `app.config.ts` carries its own caveat comment; that is a separate declaration from privacy and
  is flagged there for review before any public release.

**What was and was not verified.** The finding above comes from an Android release build
(`Sentry.nativeCrash()`, which is a Java-uncaught `RuntimeException`, not a real NDK/SIGSEGV
crash - see `.claude/rules/crash-reporting-scope.md`'s Known Limitations). sentry-cocoa was not
itself tested (no Mac, no iOS device available), but it is the same SDK family with the same
documented device-context behavior, so the ASC declaration above assumes parity rather than
absence. If a future iOS verification finds otherwise, narrow the declaration then, cited to
that finding.

Neither store's answer changes as long as the `Sentry.init()` options stay as configured. Turning
on session tracking, tracing, or Session Replay would each widen the Play answer beyond crash logs
and the Apple answer beyond Crash Data - see `.claude/rules/crash-reporting-scope.md`.
