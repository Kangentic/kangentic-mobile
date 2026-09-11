# Kangentic Mobile

Mobile companion app that remote-controls agent sessions running in the desktop Kangentic app.

## Tech Stack

- **Framework:** Expo SDK 55+, React Native New Architecture, TypeScript strict mode
- **State:** Zustand
- **Lists:** FlashList (transcript feed, board, chat-style streaming)
- **Crypto:** `@kangentic/protocol` (pure TypeScript on `@noble/curves`/`@noble/hashes`/`@noble/ciphers` -
  no native crypto module; the same handshake code runs on Node and Hermes), plus
  `react-native-get-random-values` (CSPRNG polyfill) and `@bacons/text-decoder` (Hermes has no
  built-in `TextDecoder`)
- **Storage:** expo-secure-store (Keychain / Android Keystore)
- **Notifications:** Expo Push, Notifee (Android), a native iOS Notification Service Extension via config plugin
- **Build:** GitHub Actions on free runners for both platforms (Gradle for Android, `xcodebuild` on
  a macOS runner for iOS). EAS is the credential source and the fallback, not the build path.
  Continuous Native Generation (no checked-in native projects)
- **Testing:** vitest (unit), Jest + React Native Testing Library (components), Maestro (E2E, Windows + Android emulator locally and on a CI emulator; on iOS it runs only the store-capture flow on a CI simulator, which navigates but barely asserts, so **there is no iOS E2E suite**), Playwright via react-native-web (later)

## Project Structure

**App Phase 2 (core experience).** `app/` holds thin expo-router route wrappers; the actual
screen implementations and everything else live under `src/`. If the layout changes, update
this tree and the rule `paths:` globs together.

```
app.config.ts                 # Expo config; CNG - config plugins only, no checked-in native projects
eas.json                      # EAS Build/Submit/Workflows profiles (development/preview/e2e/production)
app/                           # expo-router route wrappers (thin - render the src/screens/ implementation)
  _layout.tsx, (tabs)/         # root Stack + native bottom Tabs (Home, Board); boots connection + notifications + splash
  task/[taskId]/               # index.tsx = the SESSION view (terminal/chat/changes segments)
  file-diff.tsx                 # per-file unified diff, pushed over the session's changes segment
  completed-task.tsx            # a finished task's transcript + run summary
  create-task.tsx, edit-task.tsx, move-task.tsx, task-actions.tsx, project-picker.tsx
                                #   native form-sheet routes (they replaced the custom board sheets)
  pair.tsx, pair-confirm.tsx    # pairing flow routes; pair.tsx renders the scan/paste screen
  +native-intent.ts             # deep links; routes ONLY the demo code (kangentic-pair://demo).
                                #   OS routing of a REAL kangentic-pair:// payload is still a later
                                #   phase, deliberately: an arbitrary link must not be able to start
                                #   a ceremony against an attacker-chosen relay
  settings.tsx, devices.tsx
assets/brand/                 # Synced identity rasters (icon/splash/adaptive, the iOS Board tab
                              #   glyph) - scripts/syncBranding.mjs owns them
plugins/                      # Local Expo config plugins (withAndroidPushService: notification
                              #   permissions + FGS type; withIosManualSigning: App Store signing on
                              #   the app target only, inert outside CI;
                              #   withAndroidE2eGwpAsanOff: disables GWP-ASan for the e2e APK only,
                              #   inert unless EXPO_PUBLIC_KANGENTIC_E2E=1;
                              #   withAndroidCmakeBuildStaging: relocates CMake's .cxx staging to a
                              #   short absolute root so Android builds from any path depth,
                              #   Windows-gated inside the generated Gradle;
                              #   withAndroidGradleHeap: raises the Gradle daemon heap past the
                              #   template's 2048m so R8 survives a four-ABI production build;
                              #   withIosPodsUuidCollisionGuard: injects a collision-safe UUID
                              #   generator into the generated Podfile's post_install hook so an
                              #   SPM object cannot take the Pods root object's UUID, droppable
                              #   when Expo or CocoaPods fixes the generator upstream;
                              #   withIosNotificationServiceExtension: creates the NSE target from
                              #   targets/nse/ and adds the shared keychain-access-group to the
                              #   app, so the extension can read the push key. Must be registered
                              #   BEFORE withIosManualSigning, which signs the target it creates;
                              #   withAndroidProfileable: adds <profileable android:shell="true"/>
                              #   so simpleperf can sample a RELEASE build, inert unless
                              #   EXPO_PUBLIC_KANGENTIC_PROFILEABLE=1 - see the /profile skill)
patches/                      # patch-package patches, applied by the `postinstall` script.
                              #   react-native-enriched-markdown+0.7.4.patch removes an
                              #   accessibility OnGlobalLayoutListener the library leaves on the
                              #   WINDOW's ViewTreeObserver, which retained a whole session screen
                              #   per open. Filed upstream as software-mansion/enriched-markdown
                              #   issue #730 and PR #731; drop the patch once that ships in a
                              #   release we depend on. The filename pins the version, so a bump
                              #   drops the patch silently: re-measure with the retention probe
                              #   (EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE=1) before accepting one.
                              #   CI's node_modules cache is keyed on package-lock.json ALONE and
                              #   `npm ci` (so `postinstall`, so patch-package) runs only on a
                              #   miss, so editing a .patch without touching the lockfile restores
                              #   a cache holding the OLD patch. Bump something in the lockfile, or
                              #   clear the cache, whenever a patch changes on its own
targets/nse/                  # iOS Notification Service Extension source (Swift), copied into the
                              #   generated Xcode project by the plugin above, never into ios/.
                              #   Decrypts the push envelope before iOS renders the alert; vendors
                              #   no crypto (HChaCha20 by hand, then CryptoKit's ChaChaPoly), so it
                              #   needs no Pods entry. Cross-checked against @kangentic/protocol by
                              #   the NSE crypto (swiftc) job in ci.yml
src/
  screens/        # TriageHome (+ home/ needs-you cards), Board, task/ (SessionScreen, mode toggle,
                  #   input bar, ChatPane, ChangesTab), CompletedTask, the form-sheet screens
                  #   (CreateTask/EditTask/MoveTask/TaskActions/ProjectPicker), FileDiff,
                  #   Pairing (Scan/Confirm), Settings, Devices
  components/     # Design system primitives (incl. the shared SegmentedSwitcher) + brand/ (Overseer,
                  #   Brandmark, EmptyState), motion/ (presets, Skeleton, PressScale), conversation/
                  #   cells and prompt cards, terminal/ xterm pane + quick keys, board/ cards and
                  #   column chips, composer/, diff/ cells
  brand/          # Generated brand data (brandmark XML, Overseer frames + motion sequences,
                  #   activity mark shapes + spin/march timing) - syncBranding.mjs owns them
  pairing/        # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/        # Relay WebSocket transport, KK session manager (responder), slot derivation,
                  #   capability client, typed verb client, feed router, subscription manager
  connection/     # Lifecycle composer: AppState connect/background policy, bootstrap, store feed glue,
                  #   the actions API screens call (accountless-core scoped), the
                  #   mockDesktop peer (dev rig via EXPO_PUBLIC_KANGENTIC_MOCK, and - since the
                  #   reviewer demo - also in PRODUCTION via a demo trust anchor, see src/demo/)
  navigation/     # The pending-navigation slot + PendingNavigationRunner: the ONLY place that
                  #   performs a navigation published from outside React. expo-router's
                  #   imperative router enqueues rather than navigates, and the queue drains in
                  #   an effect that throws fatally if no navigator has mounted - see
                  #   .claude/rules/imperative-router-inside-react.md
  conversation/   # Pure transcript-cell flattener, prompt keystrokes, pending-prompt summary
  demo/           # The permanent reviewer/demo pairing: fixed non-expiring code, in-process
                  #   IKpsk0 ceremony against StubPairingResponder, the isDemoAnchor
                  #   discriminator. Ships in release builds by design (App Review 2.1(a))
  devsupport/     # Loopback transport, protocol-faithful stub peer classes, wire fixtures, the
                  #   dev-only inspect bridge (EXPO_PUBLIC_KANGENTIC_INSPECT) - shared by tests +
                  #   rigs - plus claudeCapture*.ts: RECORDED real Claude Code PTY output the mock
                  #   terminal replays (generated, never hand-edited; see scripts/ below).
                  #   NOTE: no longer dev-only in the bundling sense - the demo pulls the
                  #   loopback transport, stub peer and fixtures into release builds
  terminal/       # Pure liveTail PTY cleaner, clean-feed differ, key sequences, WebView bridge,
                  #   generated xterm.html
  diff/           # Pure unified-diff lines (jsdiff) + path display
  notifications/  # Push key + registration, E2E envelope decrypt, notifee channels, background task,
                  #   local notifier, foreground service, sharedKeychain (permission, registration,
                  #   tap routing, Settings status and RICH display are all cross-platform; iOS
                  #   decrypts in the targets/nse/ extension, Android in the Notifee handler)
  state/          # Zustand stores (activity/board/transcript/diff/channel/settings/readingView, all
                  #   channel-fed, in-memory) + the non-Zustand terminalFeed PTY ring buffers
  voice/          # Dictation hook over the OS speech engines (expo-speech-recognition)
  observability/  # Sentry crash reporting - the only module allowed to import the SDK, plus the
                  #   pure event/breadcrumb scrubber (see crash-reporting-scope.md)
  lib/            # Shared pure utilities (crypto polyfills, haptics)
tests/
  unit/           # vitest (pure TS, no RN runtime) - includes the loopback-transport + stub-desktop-peer helpers
  components/     # Jest + React Native Testing Library
  helpers/        # Shared cross-tier test utilities (async waitUntil / flushMicrotasks)
  web/            # Playwright via react-native-web (later)
.maestro/         # Maestro E2E flows (smoke unpaired; paired/ flows need scripts/stubDesktopPeer.mjs)
scripts/          # bash-guard.js, dev.mjs, stubDesktopPeer.mjs, buildXtermHtml.mjs
                  #   (assembles xterm.html from the page fragments in xterm-page/),
                  #   xterm-page/ (the WebView glue as plain browser .js modules,
                  #   concatenated into one IIFE - shared top-level state, no imports),
                  #   captureClaudeFrames.mjs + buildTerminalFixture.mjs (record real Claude
                  #   Code PTY output and pack it into src/devsupport/claudeCapture*.ts; dev
                  #   utilities, not run in CI),
                  #   cmakeStaging.mjs (prune/verify the relocated CMake staging root),
                  #   generateNseCryptoFixtures.mjs (seals push envelopes with the protocol
                  #   package so the Swift NSE crypto can be cross-checked by swiftc in CI;
                  #   regenerate with `node scripts/generateNseCryptoFixtures.mjs`),
                  #   mobileInspect.mjs, syncBranding.mjs, easProfile.mjs (CI reads eas.json
                  #   profiles through it), androidAbis.mjs, checkInstallDrift.mjs (the
                  #   pretypecheck stale-node_modules guard), the store preflights
                  #   checkPlayVersionCode.mjs / checkAppStoreBuild.mjs, storeScreenshots.mjs
                  #   (listing captures, driven by /store-screenshots),
                  #   build-review-pack.mjs (gathers the /code-review diff once into a
                  #   gitignored pack every finder reads instead of re-gathering; kept in
                  #   step with the desktop repo's copy, which owns the divergence list)
                  #   + repo scripts
store/screenshots/            # Committed Play + App Store listing images, one set per shelf
```

## Commands

- `npm install` - Install dependencies
- `npx expo start --dev-client` (`npm start`) - Start the dev server against a dev-client build
- `npm run dev:mock` / `dev:shots` / `dev:live` / `dev:pair` / `dev:stub` / `dev:doctor` - The local dev rig
  (`scripts/dev.mjs`): emulator + adb reverse + relay + Metro in one command, in mock
  (in-app fake desktop), live (real desktop dev instance), pair (pairing-ceremony testing),
  or stub (Maestro E2E rig) mode; doctor is a read-only preflight. `dev:shots` is mock plus
  the store-capture flag, which silences LogBox so a warning cannot land in a listing image -
  capture only, never UI iteration. See
  [docs/developer-guide.md](docs/developer-guide.md)'s Local Dev Rig section.
- `npx expo run:android` (`npm run android`) - Build, install, and launch the dev client on the
  Android emulator (rebuilds native code; use this after a native dependency or config plugin
  change, or the first time on a fresh emulator)
- `gh workflow run build-android.yml -f profile=<development|preview|e2e|production>` - **The
  normal way to build.** Runs `expo prebuild` + Gradle on a free GitHub runner, spends no EAS
  cloud credit, and uploads the APK/AAB as a run artifact. Add `-f submit_track=internal` to queue
  a Play upload (gated behind an approval). See the CI builds section of
  [docs/developer-guide.md](docs/developer-guide.md).
- `gh workflow run build-ios.yml` - **The normal way to build for iOS.** Runs on a free macOS
  runner. Defaults to an unsigned simulator compile check, which needs no Apple Developer account
  and no signing. Add `-f target=device` for a signed `.ipa`, and `-f submit=testflight` to upload
  it to App Store Connect. The upload talks to Apple directly with `xcrun altool`, so an EAS Submit
  outage cannot block it. See the CI builds section of
  [docs/developer-guide.md](docs/developer-guide.md).
- The `eas build` wrappers below are **cloud** builds that each spend one of the 15 free monthly
  builds per platform and enter a low-priority queue that can take hours. Prefer the workflows above;
  use these only when a runner will not do:
  - `eas build --profile development --platform android` (`npm run build:dev`) - dev-client build
  - `eas build --profile preview --platform android` (`npm run build:preview`) - internal
    distribution build
  - `eas build --profile production --platform android` (`npm run build:prod`) - store-release build
  - `eas build --profile production --platform ios` - App Store build (cloud, no Mac needed). The
    fallback if the runner path breaks; `build-ios.yml -f target=device` is the path.
- `npm run typecheck` - `tsc --noEmit`. A `pretypecheck` hook runs
  `scripts/checkInstallDrift.mjs` first, which fails fast when this checkout resolves
  `@kangentic/protocol` from **another** checkout's `node_modules` (every worktree lives inside
  the main one, so Node walks up and finds it) or at a version outside the declared range. That
  drift presents as a wall of "has no exported member" errors in files nobody touched, and the
  obvious way to check them - stash, re-run, "same before and after, so pre-existing" - confirms
  the wrong answer, because both runs resolve the same stale package. Fix: `npm install`.
  Run it alone with `npm run check:install`.
- `npm run clean:staging` / `verify:staging` - prune and check the relocated CMake staging root
  (`%SystemDrive%\kangentic\android`). `withAndroidCmakeBuildStaging` moves each module's `.cxx`
  out of the checkout so a build works from any path depth, at the cost of output that survives
  `gradlew clean` and accumulates one tree per branch. `verify:staging` is the only check that
  proves the object-path flag reached CMake rather than merely reaching `settings.gradle`.
- `npm run lint` - `eslint . --max-warnings 0`
- `npm run test:unit` - Unit Tests (`vitest run tests/unit`)
- `npm run test:components` - Component Tests (`jest tests/components`)
- `maestro --device <serial> test .maestro/smoke.yaml` - the unpaired smoke flow against the
  Android emulator. The paired suite is a separate command with setup:
  `maestro --device <serial> test .maestro/paired` needs a relay plus
  `scripts/stubDesktopPeer.mjs` and a completed pairing first, which `/e2e` sequences for you.
  **Never `maestro test .maestro/`**: the bare root sweeps in the `setup/` rig fixture, which
  fails for lacking a `PAIRING_URI` and reads as a broken pairing screen rather than a
  misconfigured command.
- `eas update` - Push a JS-only OTA update

## Cloud-spend and public-write MCP tools

Four MCP servers are wired in: `context7`, `firebase` and `sentry` from `.mcp.json`, plus the
official Expo plugin from `enabledPlugins` in `.claude/settings.json`. `context7` is
documentation-only and unguarded; the Expo plugin, `firebase` and `sentry` expose tools with
consequences outside this machine, gated by `permissions.ask` in `.claude/settings.json` (a
prompt on every call in every normal permission mode; a bypass mode skips it, so this section,
not the prompt, is the real guard) - never call these without an explicit user request, and
re-check this list against `/mcp` when any server is upgraded.

**The Maestro MCP server was removed deliberately** (2026-07-25). It is `maestro mcp`, a wrapper
over the same CLI, so it added no capability: `run`/`inspect_screen`/`list_devices`/`run_on_cloud`
are `maestro test`/`hierarchy`/`list-devices`/`cloud`. It did add a second device driver that
contended with the dev rig's and then hung rather than erroring (over two minutes on calls as
small as `cheat_sheet`, while the CLI answered in seconds), ten tool schemas of context per
session, and a cloud-spend tool this section had to guard in prose. Drive Maestro with the CLI;
see `.claude/rules/e2e-maestro-runs.md`.

- **Never without an explicit request - spends money or quota:** `build_run`, `build_submit`,
  `workflow_run` (Expo MCP). `maestro cloud` on the CLI bills Maestro Cloud minutes and carries
  the same bar. `build_run` spends one of the Expo Free allowance of 15 iOS + 15 Android **cloud**
  builds per month, and it is no longer how this project builds:
  `.github/workflows/build-android.yml` runs `expo prebuild` plus Gradle on a free GitHub runner,
  so a normal build costs no EAS credit at all. Reach for the workflow, not `build_run`. EAS is
  still the path for a manual `eas submit`, so `build_submit` is "explicit request only" rather
  than "never our path". Note the Expo MCP authenticates as the individual developer's
  **personal** Expo account via `/mcp` OAuth, and CI holds no Expo credential whatsoever, so
  anything the MCP fires is both off-path and attributed to a personal identity (see the auth
  table in [docs/developer-guide.md](docs/developer-guide.md)'s Agent tooling section).
- **Never without an explicit request, higher bar - posts publicly and is effectively
  irreversible:** `appstore_reply_review`, `appstore_delete_review_response`,
  `playstore_reply_review` (Expo MCP). These write to real App Store and Play Store listings
  under the company identity. Confirm the exact text with the user before posting, every time.
- **Never without an explicit request, higher bar - reaches real devices:**
  `messaging_send_message` (Firebase MCP). This delivers an FCM push to real installs. It also
  cannot satisfy `.claude/rules/e2e-notification-privacy.md`, which requires every payload to be
  ciphertext plus a generic placeholder: a console-style FCM send is plaintext by construction.
  Use it only to debug delivery mechanics with the user's explicit say-so, never as a way to
  send app content.
- **Never without an explicit request - creates or mutates cloud resources:**
  `firebase_create_project`, `firebase_create_app`, `firebase_create_android_sha`,
  `firebase_deploy`, `firebase_init`, `firebase_update_environment` (Firebase MCP). The Firebase
  MCP is scoped to `--only core,messaging` in `.mcp.json` because this app uses Firebase solely
  for FCM. Widen that list only when a feature is actually adopted. Note `firebase_init` writes
  a `firebase.json` into the repo, which this project deliberately does not have.
- **Reads are fine, writes need an explicit request - mutates a shared issue tracker:** the
  Sentry MCP (remote HTTP, `https://mcp.sentry.dev/mcp/kangentic/mobile`, OAuth as the
  individual developer's personal Sentry account). Querying issues, events, and stack traces is
  ordinary read-only debugging and needs no ceremony. Anything that WRITES - resolving or
  ignoring an issue, editing alert rules, creating or deleting a project or team, or triggering
  a Seer/autofix run that spends quota - is explicit-request-only, because the issue stream is
  the project's shared record of what is broken and a bulk resolve is tedious to undo. The one
  exception is ASSIGNING an issue that a board task was just filed for: `/sentry` does that on
  its own as a triage marker, so a later sweep can see at a glance what has been looked at. It
  hides nothing and changes no alerting. The URL is deliberately scoped to the one project
  rather than the org: it narrows the
  blast radius and drops the org-wide discovery tools from context. Note that crash events
  themselves are app data; treat anything read out of them as covered by
  `.claude/rules/crash-reporting-scope.md` and never paste an event payload into a public
  artifact. To actually investigate an issue, reach for `/sentry` rather than this MCP: it hits
  the REST API by numeric project id, so a project rename cannot silently point it at nothing,
  and it carries the diagnosis and duplicate-guard steps this bullet does not.

## Architecture

Full detail lives in [docs/architecture.md](docs/architecture.md) and
[docs/security.md](docs/security.md); this is the always-visible summary.

- **Pairing:** the desktop displays a QR (its static public key, a short-lived single-use
  high-entropy token, a relay address, a protocol version), the phone scans it. The token is
  mixed into the Noise handshake as a **pre-shared key**, not used in a PAKE - this is a
  deliberate deviation from the original research doc's SPAKE2 recommendation; see
  `docs/security.md` for why a high-entropy scanned token makes a PAKE unnecessary. After the
  handshake, both sides confirm a transcript-derived SAS (Short Authentication String) before
  the pairing completes.
- **Secure channel:** every session runs a fresh Noise KK handshake
  (`Noise_KK_25519_ChaChaPoly_BLAKE2s`) over a blind, self-hostable relay
  (`relay`, a separate repo) that forwards ciphertext only. The desktop always
  initiates the KK handshake and owns the ~2 minute rekey timer; the phone is the responder.
  Version negotiation is bound into the prologue to close downgrade attacks.
- **Capability allowlist:** the channel proves which device is connected; a desktop-enforced
  allowlist decides what it may do. Ten verbs (`read-stream`, `read-board`, `read-diff`,
  `send-user-message`, `move-task`, `answer-permission-prompt`, `interactive-terminal`,
  `board-tool-read`, `board-tool-write`, `register-push`); **the default pairing grant is all
  ten** (`DEFAULT_PAIRING_CAPABILITIES` in the desktop's `pairing-service.ts` - pairing proves
  possession of both devices, so pairing is the approval). The per-verb allowlist exists to
  NARROW a device from the desktop's devices panel, not as a default-deny gate.
  **There is no shell, file, or arbitrary-command verb in the protocol - absent, not filtered.**
- **Session view (three surfaces):** a task's screen is one SESSION with a full-width segmented
  switcher as its primary navigation - Terminal (the raw mirror, the default), Chat (the
  readable feed), and Changes - all three absolutely-positioned siblings of the one screen with
  only the active one visible, not pushed destinations. Chat renders the structured transcript when the agent
  has one, and degrades agent-agnostically to a cleaned live reading view derived from the
  terminal (a headless xterm in the WebView) when it does not.
- **Transcript-terminal rendering:** the chat lens renders the transcript styled as a
  terminal, reflowed to phone width, with `AskUserQuestion`/permission prompts as tappable
  cards; the in-progress turn streams token-by-token as a cleaned tail of the raw PTY feed
  (`src/terminal/liveTail.ts`), replaced when the next transcript revision lands. The raw
  interactive terminal (xterm.js in a WebView, quick-key bar, `interactive-terminal` writes)
  renders at the desktop's reported PTY grid and is a **faithful read-only mirror**: it mirrors
  that grid 1:1 with pan and pinch-zoom, sizing the font so the grid's rows fill the screen
  height, and it **never resizes the desktop PTY** - a shared session must not be reshaped by the
  phone. Typed input is the only thing the phone sends. The protocol's `resize` / `release-size`
  actions exist for the desktop, not this client (`src/channel/verbClient.ts`); a phone-requested
  grid was built, live-tested, and removed the same day as LESS readable than the desktop's own
  layout (see `docs/terminal-ownership-design.md`). Instead, the desktop rests unwatched
  sessions at a detail-shaped 210x48 grid, so the mirror looks the same whether a desktop
  surface shows the session or not.
- **E2E push:** payloads are ciphertext plus a generic placeholder only; decryption happens
  on-device (iOS Notification Service Extension / Android Notifee). Every failure degrades to
  the placeholder, never to plaintext. That is a floor on WHAT IS RENDERED, not a promise that
  something always renders: the Android message is data-only (no `title`, no `body`, and no
  `channelId` - any of the three makes FCM draw the notification itself and skip the app's
  handler entirely), so if the on-device handler never runs there is no OS fallback behind it.
- **Accountless core:** pairing, transport, and capability code never depend on any Kangentic
  account or entitlement layer. The open-core split (this app is open source and self-hostable;
  a Kangentic-operated hosted relay is the paid product) depends on this separation holding.
- **CNG:** native config flows through `app.config.ts` and Expo config plugins under `plugins/`.
  `ios/` and `android/` are gitignored prebuild artifacts, never hand-edited or committed.

## Testing

Four tiers, chosen for the fastest tier that proves the behavior. Full detail:
[docs/developer-guide.md](docs/developer-guide.md).

**Always fine:**
- `npm run typecheck` - run freely at any point.
- Running tests you just added or modified, scoped to those files.

**Never run unless the user explicitly asks, or `/test` is executing:**
- An unscoped full-tier run - `npx vitest run` with no path, or either Maestro suite in full
  (`.maestro/smoke.yaml`, `.maestro/paired`).

If a run would execute tests you did not add or modify, it is a full-tier run regardless of
mechanism: stop and let `/test` handle it.

**Maestro note:** `.maestro/smoke.yaml` runs against a fresh (unpaired) install; the flows under
`.maestro/paired/` need a running relay plus `node scripts/stubDesktopPeer.mjs` and a completed
pairing first (each flow's header documents the setup). Run flows with the **CLI**
(`maestro --device <serial> test <path>`), one rig mode at a time, and read
`.claude/rules/e2e-maestro-runs.md` before touching a flow - the dev client imposes several
non-obvious constraints and each one fails as a full-timeout hang rather than an error.

**Which stage owns which verification.** CI is the enforced gate, not the local machine:
`.github/workflows/ci.yml` and `e2e.yml` run on every PR and are required on `main`. So do NOT run
the Maestro suite locally before opening a pull request. Two reasons: E2E is single-tenant (one
emulator, one relay port, one paired identity), so it serialises every task on the board; and it
duplicates the gate that actually cannot be bypassed.

**Performance is MEASURED, on a release build, or it is not known.** The dev client is not a
weaker signal, it is a misleading one: the same commit measures 24.73% janky frames on dev and
0.11% on release, 1003 MB PSS against 483 MB. Never accept, report, or act on a performance claim
sourced from a dev client, including your own impressions of one. Build a real one with
`npx expo run:android --variant release --no-bundler` (a few minutes, no signing setup, installs as
an upgrade so the pairing survives). Three commands answer three different questions, and mixing
them up is how the last investigation chased the wrong cause for two weeks:

- **Frames:** `adb shell dumpsys gfxinfo <pkg> reset`, exercise, read back. Janky %, percentiles.
  GPU at 1 ms with high jank means the UI/JS thread, never the GPU.
- **CPU:** `adb shell top -b -n 4 -d 2 -q -o CMD,%CPU -p $(pidof <pkg>)`. An idle screen should not
  cost a core. `dumpsys gfxinfo` will call an app perfectly smooth while it burns one. **Pair every
  CPU sample with a frame count over the same window** (reset gfxinfo first): high CPU at ZERO
  frames is non-drawing work - on this app that is Reanimated's per-vsync mapper walk, which costs
  ~0.5 CPU points per REGISTERED mapper, dirty or not. Count mounted animated hooks before blaming
  anything else; `/profile` carries the procedure.
- **Memory:** `adb shell dumpsys meminfo <pkg>` - `Views`/`WebViews` from the **Objects** block,
  `Heap Alloc` from the **Dalvik Heap** row, never `Java Heap` from App Summary (that is PSS).
  **Force a GC before reading any delta**: `Views` climbing right after a pop is the normal state
  of a freshly popped screen, and only what survives collection counts. `am dumpheap` forces one on
  a debuggable build; backgrounding the app and waiting works on release. **Take TWO samples and
  trust the second** - one reading called a clean screen a +220-view leak that the next reading
  showed fully reclaimed.

Isolate with an A/B on the same screen (collapse a section, drop a subtree) rather than reasoning
about which component "looks expensive" - that is what turned a two-week-old wrong diagnosis into a
measured one. **Bisect from ONE build, not one build per hypothesis**: a release APK embeds its JS
bundle, so rebuilding per variant costs an APK each AND compares different installs against
different content. `src/devsupport/retentionProbe.ts` puts the variants behind a Settings switch
(`EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE=1`); extend it rather than editing components. Full worked
examples in the REACT-NATIVE-5 section of [docs/developer-guide.md](docs/developer-guide.md).

**Local Android builds work from any path**, including a task worktree.
`plugins/withAndroidCmakeBuildStaging.ts` relocates each module's CMake staging directory to a
short absolute root (`%SystemDrive%\kangentic\android`), which removes checkout depth from the
equation. **Never create a drive-root build directory to work around a path problem**, and never
create one at all without asking: if a build hits MAX_PATH, fix the plugin.

An APK is bound to the dependency tree that built it, and that has not changed: **run `npm
install` in the worktree before building.** A worktree starts with `node_modules` as a junction to
the main checkout, and a dev client whose native libs came from a different checkout dies as a
native `SIGABRT` in `libworklets.so` with no JS error. See `docs/developer-guide.md`'s "Local
Android builds work from any path", which `/preview` routes through.

What IS in scope while implementing: `npm run typecheck`, the tests you touched, and - if the
change touches a screen a flow already covers - that **single flow**, which takes well under a
minute. One targeted flow is scoped work, not a full-tier run. The suite is `/test`'s job.

## Conventions

Enforceable standards live as focused, auto-loaded rules in `.claude/rules/`. Rules without a
`paths:` header load every session; rules with one load when you touch matching files. Each rule
names its enforcement (live now, or planned where mechanical coverage does not exist yet).

**Always-on rules:**
- `bash-single-command.md` - one command per Bash tool call; no `&&` `||` `|` `;` or redirects.
- `text-formatting.md` - no em-dashes (U+2014) or `--` as punctuation in authored text.
- `typescript-style.md` - TypeScript strict mode; no `any` types; full descriptive names.
- `no-personal-info.md` - no usernames, emails, or machine paths in committed code (repo is public).

**Path-scoped rules (load with their subsystem):**
- `protocol-types-from-package.md` - wire/crypto/capability types come only from
  `@kangentic/protocol`, never redeclared (`src/**`).
- `accountless-core.md` - pairing/transport/capability code has no account/entitlement imports
  (`src/pairing/`, `src/channel/`, `src/connection/`, `src/demo/`, `src/devsupport/`,
  `src/notifications/`, `app/+native-intent.ts`).
- `e2e-notification-privacy.md` - push payloads are ciphertext plus placeholder only
  (`src/notifications/`, `plugins/`, `targets/`).
- `crash-reporting-scope.md` - Sentry imports confined to `src/observability/` and banned outright
  from the pairing/channel/demo/devsupport/notification paths; privacy controls set at the source
  because a JS `beforeSend` cannot filter native crashes (`src/observability/`, `src/pairing/`,
  `src/channel/`, `src/demo/`, `src/devsupport/`, `src/notifications/`, `app/+native-intent.ts`).
- `expo-cng.md` - no hand-edited `ios/`/`android/`; native config via config plugins; SDK-resolved
  dependency installs via `expo install` (`app.json`, `app.config.*`, `eas.json`, `plugins/`,
  `ios/`, `android/`, `package.json`, `package-lock.json`).
- `secure-storage.md` - long-lived secrets in `expo-secure-store`, never AsyncStorage; the NSE's
  shared Keychain group, its entitlement ORDER, and the per-item accessibility split
  (`src/pairing/`, `src/channel/`, `src/notifications/`, `src/state/`, `plugins/`, `targets/`).
- `ui-conventions.md` - shared primitives, font floor, FlashList, testIDs (`src/screens/`,
  `src/components/`).
- `motion-conventions.md` - the frequency gate, `MotionTokens`/`useMotionPresets` vocabulary,
  transform-and-opacity only, **never `useAnimatedProps` into another library's props** (measured
  at ~8 points of CPU per spinning icon; now lint-gated to an allowlist), **register animated hooks
  only on the branch that animates** (a hook above an early return registers a mapper on EVERY
  branch, and idle CPU scales with registered mappers at ~0.5 points each, dirty or not), a
  conditional mount is what makes a transform safe on a recycled row, no `entering` on a FlashList
  item root, an animation that never stops holds the app at full frame rate, reduced motion ships
  with the animation, haptics through the `HapticCue` union (lint-gated to `src/lib/haptics.ts`)
  (`src/components/`, `src/screens/`).
- `ui-copy-brevity.md` - labels name the action, context names the object; one-line
  descriptions; a11y labels exempt (`src/screens/`, `src/components/`).
- `imperative-router-inside-react.md` - expo-router's imperative `router` is only called from
  inside the mounted navigator; everything else publishes to `src/navigation/pendingNavigation.ts`.
  `router.push` merely ENQUEUES, and the queue drains in a React effect that throws fatally above
  every error boundary when no navigator has mounted (the iOS 0.6.3 build 13 cold-start crash); a
  try/catch at the call site cannot catch it, and an `isReady()` guard in the runner is a bug
  (`src/navigation/`, `src/notifications/`, `src/connection/`, `src/channel/`, `src/demo/`, `app/`).
- `e2e-maestro-runs.md` - Maestro through the CLI, one rig mode, testID selectors, the dev-client
  constraints (`.maestro/`, `scripts/stubDesktopPeer.mjs`, `scripts/dev.mjs`).
- `performance-claims-are-measured.md` - release build or it is not known; label measured vs read
  vs inferred; a control taken the same way; two meminfo samples; an A/B in ONE process; a delta
  smaller than the run-to-run spread is not a result (`src/**`, `plugins/**`,
  `docs/developer-guide.md`, `docs/architecture.md`).
- `regression-tests-fail-first.md` - watch a regression test fail against the unfixed code (mutate,
  run, restore) before trusting it; assert the mechanism when the bug is invisible in output
  (`tests/**`).
- `docs-stay-in-sync.md` - update docs when changing anchor source files.

**Local overrides:** there is no per-rule local file. Put machine-specific instruction overrides
in a gitignored `CLAUDE.local.md` at the project root.

**Other conventions (workflow, not extracted to rules):**
- Prefer editing existing files over creating new ones.
- A plain **local commit** goes through `/commit`: it stages and commits on the current branch
  only, with no push and no rebase. A bare request to "commit" means `/commit`.
- **Landing changes goes through a PR by default.** The board drives it: the **Tests** column
  runs `/pull-request` (commit, conventional branch, push, create the PR, drive its CI checks to
  green), and the **Ship It** column runs `/merge-pull-request` (merge the green PR, pull back to
  local `main`). For a deliberate direct quick-push that bypasses the PR gate, use `/merge-back`.
  Only push, land, or merge when the user explicitly asks.
- `/commit`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all write conventional-commit
  messages.
- `/sync-docs` keeps `docs/` aligned with source; the doc-anchor check runs inside `/pull-request`
  (commit time) and `/merge-pull-request` (merge time), and `/merge-back` for direct pushes.
- `/store-screenshots` re-captures the Play and App Store listing images across all four shelves.
  Run it whenever the captured screens, the mock content, or the tab bar change - the copy is IN
  the frames, so all four shelves drift together. It sequences the platforms deliberately: iOS
  costs ~45 minutes on a macOS runner per attempt, Android ~6 minutes each locally.
- `/sentry` retrieves and diagnoses issues from the `mobile` Sentry project, and files a
  follow-up board task when asked.
- `/profile` measures Android runtime performance on a release build: idle CPU, frame timing,
  view retention, and the `simpleperf` sample that names the hot code. Reach for it on any lag,
  jank, battery or leak report - it carries the measurement discipline (two meminfo samples,
  matched process state across an A/B, bisect from one build) that this repo learned expensively.

### Authoring a rule

When you codify a new convention, add it as a `.claude/rules/*.md` file following the existing
ones:

1. **One concern per file**, with a descriptive kebab-case filename.
2. **Decide loading, and keep always-on rules few.** Always-on rules (no frontmatter) load every
   session and cost context every session, so reserve them for universal, file-independent
   conventions. Everything subsystem-specific gets `paths:` frontmatter. Treat ~4 always-on as
   a soft ceiling.
3. **Mind the read-trigger gap.** A path-scoped rule loads when a matching file is read into
   context, not when Claude creates a new file in that path. So (a) any convention that must
   hold at file-creation time belongs in an always-on rule or a hook, never path-scoped-only;
   and (b) every path-scoped rule should have a backstop (a future test, or a review-time
   auditor agent) so a missed load is still caught.
4. **Structure:** a one-paragraph context (the problem / the bug it prevents), `## The rule`
   (prescriptive), `## Enforcement (self-maintaining)`, and `## Scope`.
5. **Name an enforcement, strongest available.** A hook blocks 100%; a test or lint rule runs in
   CI; a review-time auditor agent or `/code-review` is the probabilistic fallback. Flag
   explicitly where mechanical coverage is missing - the harness exists (vitest, Jest + RNTL,
   Maestro, ESLint, `tsc`, all gated in `ci.yml`), so "planned" now means not yet written, not
   impossible. Only a few conventions (shorthand names, UI copy brevity) resist mechanization
   outright and stay review-only by design.
6. **Update the index above** with a one-line pointer, and add a backlink from the enforcing
   agent or skill so the rule stays the single source of truth.
7. **Route agents deliberately.** When authoring or updating a skill, decide whether it needs a
   fresh context (a review or audit skill) or should fork the current session (continuing an
   in-flight task); never route a mutating skill to a read-only agent type.

**Linting:** live. `.github/workflows/ci.yml` runs each check as its own parallel job, and each
job name is a required status check on the protected `main`: `Lint (ESLint)`, `Type check (tsc)`,
`Unit Tests (Vitest)`, `Component Tests (Jest)`, `Native config (prebuild)`,
`NSE crypto (swiftc)`, and
`Release counters (stores)` (pull requests only). Renaming a job
renames the required check, so main's branch protection must be updated in the same change.
Conventions with no mechanical check of their own (shorthand names, em-dashes, personal info, UI
copy brevity) remain enforced by review (`/code-review`, `crypto-pairing-auditor`,
`expo-rn-reviewer`) rather than mechanically.
