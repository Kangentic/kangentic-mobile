# Developer Guide

Setup, build system, and testing for Kangentic Mobile. The Expo scaffold, `package.json`, and
test harness landed in App Phase 1; everything below reflects the current setup.

## Prerequisites

Windows-first: this project develops without a Mac in the loop.

- **Node 22** (see `.nvmrc`). On Windows, `nvm-windows` is the simplest way to pin it.
- **JDK 17** and **Android Studio** with an Android Virtual Device (emulator) configured. The
  emulator is the daily local target.
- **`eas-cli`** (`npm install -g eas-cli`), optional. Builds run on GitHub Actions
  (`.github/workflows/build-android.yml` and `build-ios.yml`), so `eas-cli` is needed only for
  managing Apple and Google credentials and as the cloud-build fallback.
- **Maestro CLI**, installable on Windows, for E2E flows against the emulator. See "Agent
  tooling (MCP servers)" below for the PATH setup and a gotcha worth reading before you hit it.
  The CLI is the only Maestro path: the Maestro MCP server was removed deliberately (see
  `CLAUDE.md`), so nothing drives Maestro but this binary.
- No Mac, no Xcode, no local iOS Simulator. Every iOS build runs on a free GitHub-hosted macOS
  runner, including the signed ones (see "iOS without a Mac" below). Note `expo prebuild --platform
  ios` refuses to run on Windows at all, so anything that inspects the generated iOS project has to
  happen on a runner.

## Quick Start

```
npm install
npx expo start --android
```

Requires a development build already installed on the emulator; see `/preview`'s notes on
building one with `eas build --profile development --platform android` or `npx expo run:android`.

For anything beyond a bare Metro session, use the dev rig below.

## Local Dev Rig

`scripts/dev.mjs` is one command that wires up everything a preview needs - emulator boot,
`adb reverse`, a local relay, optionally the stub desktop peer, and Metro:

| Command | What you get |
|---|---|
| `npm run dev:mock` | The app against an **in-app fake desktop** (real channel stack over an in-process loopback). No relay, no pairing, nothing touches a real board. UI/UX iteration and full-feature demos. |
| `npm run dev:shots` | `dev:mock` plus `EXPO_PUBLIC_KANGENTIC_SHOTS=1`, the bundle the **Play store capture** runs against. That flag silences LogBox so a warning banner cannot land in a listing image, which the iOS capture job has always done and the Android path did not. Capture only: warnings are hidden, so do not iterate on UI against this bundle. The flag is inlined at bundle time, so the rig forces a clean Metro cache when you switch either way. |
| `npm run dev:live` | The app connected to **your real running Kangentic desktop dev instance** through a local relay. The rig prints the one-time desktop checklist (enable the mobile bridge, relay URL `ws://127.0.0.1:8080`, pair once, grant verbs). |
| `npm run dev:pair` | Resets the app to unpaired (`pm clear`) so you can exercise the QR/paste + SAS **pairing ceremony**. Add `-- --stub` to pair against the stub peer instead of the live desktop. |
| `npm run dev:stub` | Relay + `scripts/stubDesktopPeer.mjs` - the Maestro E2E rig. Reuses the saved phone key for a session-only reconnect when it can (`-- --fresh` forces a re-pair). |
| `npm run dev:doctor` | Read-only preflight: adb/emulator/AVD, the `hw.keyboard=yes` typing check, relay repo and port states, dev-client install, Node version. |
| `npm run dev:emu` | Emulator hygiene: kill + reboot on host GPU, restore the adb reverses, relaunch the app foreground-verified. The cure for progressive emulator lag (a long-lived qemu process degrades under sustained WebGL load). |
| `npm run dev:adb` | adb-server wedge recovery: force-kill adb, fresh server, reverses, relaunch. The cure when the phone reconnect-loops while the relay and desktop are healthy (forwarding silently stops moving data). |
| `npm run dev:stop` | Stops the processes **the rig itself started**, this run's and any left by an interrupted earlier one, leaving the relay up. Starting any mode does this first, so it is only needed to hand the machine back clean - or to free Metro before switching rig mode, since only one mode can own port 8081. The **emulator survives by default** (slow to boot, usually wanted next run) but is now NAMED in the output when it does, because "stopped 1 rig process" while a phone window sits on screen reads as a clean stop and is not one. `-- --emulator` (or `--all`) shuts down the emulators the rig booted; `-- --dry-run` prints every target and kills nothing. |

Details worth knowing:

- **The rig only ever kills a process it started itself.** Every child it spawns is recorded
  synchronously to `.devrig-processes/` at the main checkout (one file per child: label, pid,
  and the identity the OS reported for that pid at spawn time). `dev:stop` reads only those
  records, re-queries each pid, and kills it **only if the identity still matches** - a pid the
  OS has since recycled belongs to a stranger, so its record is pruned and nothing is killed.
  Non-Windows falls back to a liveness check, where pids are not recycled aggressively.

  **Emulators are tracked by SERIAL, not pid**, in the same directory. `emulator.exe` is a
  launcher that hands off to a qemu child, so the pid the rig spawned is not reliably the process
  owning the window; the serial is, and `adb -s <serial> emu kill` addresses exactly that instance
  and shuts it down cleanly. The ownership question still gets answered, because a serial is a
  SLOT (`emulator-5554` is simply the first one) that the next emulator to boot inherits: the
  record carries the AVD name, and stop re-reads the live AVD off the console before killing
  anything. An emulator the rig merely **adopted** - already running when the rig started - is
  never recorded, so it is never a target. Both registries share one directory and an emulator
  record's filename parses cleanly as a process record, so `parseRecordFileName` excludes it
  explicitly; without that the process stop, which runs first, prunes the emulator record every
  run and the tracking silently evaporates.

  This replaced a scan that matched every `node.exe` on the machine against
  `dev\.mjs|stubDesktopPeer|expo(-cli)?.*start`. That pattern is far wider than it reads:
  `expo(-cli)?.*start` matches `--expose-gc ... start`, and even `--expose-internals ... --restart`
  (the "start" inside "--restart"). It killed a running Kangentic desktop and every agent session
  under it, twice. **Never reintroduce a kill target derived from a command line or a held port**
  - `tests/unit/rigProcessRegistry.test.ts` scans `scripts/dev.mjs` for exactly that and fails CI.

  The consequence to accept: a Metro or stub started **outside** the rig is invisible to it. The
  rig reports a foreign holder of port 8081 (in `dev:doctor`, and as a hard failure at start) and
  tells you the pid, rather than taking it. Stop it yourself, or pass `--no-metro` to use it -
  after checking it serves THIS repo, since an adopted bundler from another checkout serves the
  wrong bundle and every symptom then looks like an app bug.
- **Live-mode quick pair (dev-only hot path):** `dev:live` skips the in-app QR/SAS ceremony
  entirely. The desktop dev instance (bridge enabled, dev build) publishes its static public key
  and relay URL to its repo's gitignored `.kangentic/mobile-dev-pairing/desktop.json`; the rig
  answers with a persistent dev phone public key (`phone.json`) that the desktop adopts into its
  signed roster with all verbs granted, and hands the matching identity to the app via
  `EXPO_PUBLIC_KANGENTIC_DEV_PAIRING`. Only public keys cross the file boundary; both sides
  compile the path out of production builds; the ceremony remains the only pairing path for real
  devices (and `dev:pair` still exercises it). The kangentic repo resolves like the relay repo:
  `--kangentic-repo`, `KANGENTIC_REPO`, `kangenticRepoPath` in the state file, or the
  `../kangentic` sibling default. If the handshake file never appears (bridge disabled, or the
  desktop build predates dev-quick-pair), the rig falls back to the manual checklist.
- **Relay checkout:** the rig expects the `kangentic-relay` repo as a sibling directory
  (`../kangentic-relay`), overridable via `--relay-repo`, the `KANGENTIC_RELAY_REPO` env var, or
  `relayRepoPath` in the state file. It starts the relay's `npm run dev` with
  `SLOT_ID_PATTERN='^([0-9a-f]{32}|[0-9a-f]{64})$'`. **Both slots are 32 hex characters** as of
  protocol 0.12.0, which derives the pairing slot rather than dialing the 64-hex token verbatim;
  the 64-hex alternative is retained only so an older relay checkout or peer still rendezvouses.
  This now matches the relay's own default, so it is a no-op against a current checkout. When
  the rig adopts an already-running relay it probes for 32-hex acceptance and warns with the
  exact restart command if the pattern is too narrow - against a relay narrowed to 64-hex only,
  that now means nothing rendezvouses at all rather than the old "pairing works, every session
  400s at upgrade".
- **`.devrig.local.json`** (repo root, gitignored, safe to delete): `relayRepoPath`,
  `stubPhoneKey` (captured automatically from the stub's output after a pairing), `avdName`.
- **`adb reverse tcp:8080 tcp:8080`** is required for any relay connectivity - the app only
  accepts `ws://` for loopback hosts - and is wiped on every emulator reboot. The rig re-applies
  it on every run.
- **Lifecycle:** stub/Metro run as supervised children (Ctrl-C stops them; the emulator stays
  up). The **relay is spawned detached** and deliberately outlives the rig (its logs land in
  the OS temp dir as `kangentic-relay-dev.log`): the desktop's bridge and the phone both hold
  sessions through it, and a dev-loop restart must not sever them. Healthy already-running
  pieces are adopted, not restarted. Metro's interactive keys (`r`, `j`) pass through.
- **Stale stub pairing:** if `dev:stub` shows no `[session] established` within ~20s, the saved
  phone key or the stub identity (in the OS temp dir) is stale - `npm run dev:pair -- --stub`
  re-pairs fresh and re-captures the key.
- **Mock flag caveat:** `EXPO_PUBLIC_KANGENTIC_MOCK` is inlined at bundle time, so switching
  mock on or off needs a Metro restart with `--clear`.

## Mobile inspect loop

`scripts/mobileInspect.mjs` is the see-poke-interrogate CLI for the app on the attached
emulator/device, built so an agent (or a human) can verify UI changes in a tight loop:

```
node scripts/mobileInspect.mjs screenshot [--out <path>]   # adb screencap -> file, prints the path
node scripts/mobileInspect.mjs tap <x> <y>                 # adb input tap
node scripts/mobileInspect.mjs text "<string>"             # adb input text (spaces handled)
node scripts/mobileInspect.mjs key <ANDROID_KEYCODE>       # adb input keyevent
node scripts/mobileInspect.mjs logcat [--lines n] [--tag t]  # dumped ReactNativeJS log tail
node scripts/mobileInspect.mjs state <connection|stores|subscriptions|feed-stats|route|pairing|terminal>
node scripts/mobileInspect.mjs term <state|eval|font|refit|scroll|dragunits|swipe|pinch|hostmsg> [...]
node scripts/mobileInspect.mjs serve                       # long-lived server, logs app hellos
node scripts/mobileInspect.mjs relaunch                    # force-stop + launch, VERIFIED foregrounded
```

`relaunch` is the recovery command for a wedged app state: a dead Fast Refresh socket (edits
stop applying), a stale bundle, or a launch that raced onto the home screen. It force-stops,
fires the launcher intent, polls window focus, and RETRIES the launch until the app actually
holds the foreground - the blind `am force-stop` + `monkey` pair loses that race routinely.

`screenshot`/`tap`/`text`/`key`/`logcat` are plain adb and work even when the JS bundle is
broken. `state` interrogates the app's **dev-only inspect bridge**
(`src/devsupport/inspectBridge.ts`): the app dials out to `ws://127.0.0.1:8791` (the rig sets
`EXPO_PUBLIC_KANGENTIC_INSPECT=1` and the `adb reverse` in every mode) and answers with store
SUMMARIES - connection state, per-session activity/transcript-window/diff status, the
subscription manager's desired vs active sets, terminal ring stats, and the current route.
Production bundles never contain the bridge: the boot site is `__DEV__`-and-env gated and the
module loads via dynamic import, the same stripping arrangement as the mock desktop. Wire
shapes live in `src/devsupport/inspectProtocol.ts`; the script mirrors them by hand.

### The terminal harness (`term`)

When the TERMINAL looks wrong but every RN-side probe says the state is fine, the numbers that
decide its behaviour are all inside the WebView. `term` reads them and drives it:

```
node scripts/mobileInspect.mjs term state          # the probe, prefixed with a freshness verdict
node scripts/mobileInspect.mjs term eval "<expr>"  # anything, evaluated in the page
node scripts/mobileInspect.mjs term font <px>      # exactly what a pinch does
node scripts/mobileInspect.mjs term refit          # exactly what the reset button does
node scripts/mobileInspect.mjs term scroll <units> # a raw history burst, skipping the gesture
node scripts/mobileInspect.mjs term dragunits <px> # what a drag of N px WOULD compute
node scripts/mobileInspect.mjs term swipe <dy> [ms]  # a real one-finger drag via adb
node scripts/mobileInspect.mjs term pinch <scale> [--drag <dy>]   # EMULATOR ONLY, see below
node scripts/mobileInspect.mjs term hostmsg '<json>'  # inject a host->terminal bridge message
```

Every command also accepts `--port <n>` alongside `--serial`: it binds the inspect server on a
different HOST port for multi-device work. With two devices attached, both dial host 8791 and
whichever bridge connects first answers - which silently attributes one device's state to the
other (a phone answered for an emulator during the pinch verification, and the rig's
reverse-tunnel watchdog restores the phone's mapping within seconds, so removing it is not a
fix). Instead map the second device's fixed in-app 8791 to a spare host port and address it
directly:

```
adb -s emulator-5554 reverse tcp:8791 tcp:8793
node scripts/mobileInspect.mjs term state --serial emulator-5554 --port 8793
```

`hostmsg` closes the other reproduction gap: bridge messages that only the RN layer ever sends
(the `pinch` lifecycle) are otherwise unreachable from any script. It dispatches a window
MessageEvent, exactly how react-native-webview delivers real ones.

`font` posts the same message a pinch does, so a scripted zoom and a real one cannot diverge on
the FONT. `swipe` drives real MotionEvents (use a long duration - a fast swipe delivers too few
move samples for the drag handler to fire, which reads as "scrolling is broken" when it merely
had nothing to consume).

**Multi-touch works on the emulator only.** `adb shell input` has no multi-touch at all, and
`term pinch` writes raw protocol-B events to the touchscreen node, which needs root - so it
works on an EMULATOR (after `adb root`; reverses do not survive the adbd restart, re-apply
them) and fails cleanly on a production physical device. The replay is human-timed on purpose:
the pinch-lifecycle bridge messages cross to the WebView asynchronously, so a replay with no
delays finishes before they land and "fails" in a way no finger can reproduce.

One behavior is a PLATFORM FACT, not a bug: while RNGH's pinch is activated, Android delivers
the WebView no further touch events at all (measured: a 600ms 20-step post-pinch drag reached
the page as 4 touchmoves and 0 touchends). So a continuous pinch-keep-one-finger-drag cannot
scroll - the page never sees the drag. Lifting all fingers and dragging fresh works, and is the
gesture users actually make.

On a phone, dispatch the DOM sequence instead:

```
node scripts/mobileInspect.mjs term eval "(function(){var c=document.getElementById('scroll-container');...})()"
```

That covers everything inside the page but NOT the React Native gesture layer above it. It is
enough for most gesture bugs, because the page's own touch counters
(`probe().touchCounts`) tell you first whether the events reached the page at all - a handler
that ran and bailed is a completely different fault from touches that never arrived, and
guessing between the two is what made the pinch-then-scroll bug take several rounds.

The probe reports geometry, `lineHeight`, buffer type, the mouse tracking mode AND encoding,
which exit the last gesture took, and the PTY write attempt/failure counts. That last pair
closes a real blind spot: `writeTerminal` failures are swallowed at the call site, so a write
that silently stopped reaching the desktop used to look identical to a gesture that never
fired.

**"Cannot scroll up" is not always a bug.** Alt-screen scrolling is owned by the AGENT: the
phone only emits wheel reports, and a Claude Code sitting at a MODAL prompt (the session-resume
dialog after a desktop restart, a permission prompt, any select) repaints the same frame
instead of scrolling - for a desktop wheel exactly as much as for the phone. Verified live
2026-08-02 on a parked session showing the resume dialog: an injected drag moved every counter
(`scrollPostCount`, `netHistoryUnits`, the write attempts, even a stamped
`lastScrollRoundTripMs` - the TUI ANSWERED, with an identical frame) while before/after
screenshots stayed pixel-identical. The one-minute triage: `term state`, `term swipe`,
`term state` again, screenshots around it. Counters moving under an unchanged frame means the
TUI is refusing - answer its prompt (quick-key Enter) and scrolling returns. Counters NOT
moving is a phone-side fault worth debugging.

**Read the freshness verdict.** `xterm.html` is a Metro asset cached by content hash and
untouched by Fast Refresh, so the device can serve a stale page against a fresh bundle - which
looks exactly like a fix that did not work, and produced three false negatives in one session.
`buildXtermHtml.mjs` stamps a build id into both the page and `src/terminal/xtermBuildId.ts`;
`term state` compares them, and every other `term` command refuses to act on a mismatch
(`--force` overrides). A stale page is cleared by `relaunch`.

`term` needs the inspect bridge (so, a dev build and the rig). Its ground-truth companion needs
no app cooperation at all: `node scripts/webviewEval.mjs "<expression>"` evaluates JavaScript
inside the WebView over the Chrome DevTools Protocol (the dev build exposes a
`webview_devtools_remote` socket; the script discovers and forwards it). Reach for it when the
bridge itself is suspect, or when the JS bundle is too broken to answer - it is how the GPU
`MAX_TEXTURE_SIZE` canvas clamp was diagnosed. Both can call `window.__kangenticTerminal`,
which is where the page's own state is exposed.

## Store listing screenshots

`scripts/storeScreenshots.mjs` captures the Play listing images. It needs the MOCK rig
(`npm run dev:mock`) against a **dev build**, because `isMockDesktopEnabled()` is
`__DEV__ && EXPO_PUBLIC_KANGENTIC_MOCK === '1'` - a release APK started with that env var shows
an unpaired "Connecting to your desktop..." screen instead, and does so silently. Check the
install before trusting the screen:

> **A release build CAN now show mock content, by a different door.** The reviewer/demo pairing
> (`src/demo/`) reaches the same `createMockDesktop()` from a persisted trust anchor with no
> `__DEV__` gate, so entering `kangentic-pair://demo` on a production build lands in the same
> fixtures. That is a supported path for verifying a release binary and for capturing
> release-shaped screenshots, which `.github/scripts/capture-ios-screenshots.sh` documents three
> failed attempts at. It does NOT change the paragraph above: the env-var route is still
> dev-only, so a release build with `EXPO_PUBLIC_KANGENTIC_MOCK=1` and no demo anchor still shows
> the unpaired screen.

```
adb shell "dumpsys package com.kangentic.mobile | grep flags="   # wants DEBUGGABLE
node scripts/storeScreenshots.mjs all                            # phone, seven-inch, ten-inch
```

Two things about this are worth knowing before changing it.

**The geometry is not the emulator's.** Play requires exactly 16:9 or 9:16 on all three Android
shelves, tablets included, and a real tablet is not 9:16 (nor is a modern phone - the AVD is
1080x2400). Setting `wm size` and `wm density` INDEPENDENTLY satisfies both constraints at once:
1080x1920@480 is 360dp (phone), 1080x1920@280 is ~617dp (7-inch), 1440x2560@320 is 720dp
(10-inch). Because crossing 600dp is what triggers large-screen layout, reviewing the tablet
captures IS the tablet-layout verification - this app has no tablet-specific code, and these
captures were the first time it had been run at tablet width.

**Large screens rotate, and the portrait lock does not stop them.** The captures above are all
9:16, so they only ever exercised tablet PORTRAIT. The app targets SDK 36, so Android 16 ignores
`android:screenOrientation` on any display at sw600dp or wider - the tablet geometry above
qualifies, and tablet LANDSCAPE is therefore a shape that ships whether or not it was designed
for. It was checked at 1280x720dp on 2026-08-06: the home feed, the session terminal, the session
chat, the board, and the Create Task form sheet all hold up, and the board's column chips actually
fit on one row there. Not checked: the MoveTask and ProjectPicker sheets, which cap a scrollable
list rather than a text field, so they exercise a different mechanism from CreateTask's. The
sheet caps are no longer fixed 420s: `src/lib/sheetContentHeights.ts` derives each cap from the
window height, which means a short or landscape window now shrinks the capped region instead of
overflowing the sheet. 420 stays the ceiling, so tall windows render the two list sheets as
before; the Create/Edit description boxes additionally align the cap to the text line grid, so
their effective ceiling is 416. See the Play
Console advisories section of [store-listing.md](store-listing.md) for why the lock stays.

To reproduce, on an **API 36** emulator (the AVD used for the captures is API 35, where the lock
is still honoured and the check passes vacuously - and prefer the `default` system image over
`google_apis`, which starves the app):

```
adb shell settings put system accelerometer_rotation 0   # else user_rotation is ignored
adb shell settings put system user_rotation 1
adb shell am get-config                                  # want "land" at sw720dp
```

Run it at BOTH geometries and expect them to disagree - that disagreement is the check. At
1440x2560@320 (sw720dp) the display turns and the app fills 2560x1440 with no letterboxing; at
phone width (sw411dp) the same commands leave it `port`, because there the lock still wins. If
both legs agree, the setup is wrong and the result means nothing. Confirm `mResumedActivity` is
`com.kangentic.mobile/.MainActivity` first (`adb shell dumpsys activity activities`): the dev
client ships its own portrait-locked activities, and reading one of those instead is the easy way
to get a confident wrong answer.

**Turn expo-dev-menu's floating "Tools" button off** (dev menu -> bottom -> "Tools button"). It
is a dev-build overlay pinned over the app's top-right corner, so it lands in every frame as a
doubled settings icon. The script refuses to run while it is enabled, because the resulting
captures are still correctly sized and still pass verification - nothing else would catch it.

Output and per-shelf detail: [`store/screenshots/README.md`](../store/screenshots/README.md).
iOS is not covered: App Store Connect wants a 6.9-inch iPhone shelf (1320x2868, minimum three),
which needs a booted simulator and so cannot be captured from Windows.

## Agent tooling (MCP servers)

Agent sessions in this repo get MCP tools from two different mechanisms. `.mcp.json` wires three
servers: `context7` (library documentation lookup, no setup needed), `firebase` (the Firebase
CLI's built-in `firebase mcp` server), and `sentry` (a remote HTTP server at
`https://mcp.sentry.dev/mcp/kangentic/mobile`, scoped to the one project rather than the
org so it brings fewer discovery tools into context; needs a one-time OAuth via `/mcp`).
Separately, `.claude/settings.json`'s `enabledPlugins` turns on the official Expo plugin, enabled
in this repo only. `firebase`, `sentry`, and the Expo plugin each need one-time setup on a fresh
clone.

The `maestro` MCP server was removed deliberately on 2026-07-25 and is not in `.mcp.json`; drive
Maestro through the CLI instead. See `CLAUDE.md`'s MCP section for the reasoning and for which
tools on each server are gated behind an explicit user request.

- **Maestro CLI on PATH.** No longer an MCP server, but still a PATH requirement: every flow runs
  through the `maestro` CLI (`.claude/rules/e2e-maestro-runs.md`), and `scripts/dev.mjs` resolves
  it via PATH deliberately rather than an absolute path (an absolute path would violate
  `.claude/rules/no-personal-info.md`, which forbids machine-specific paths in committed files).
  Install the Maestro CLI, add its `bin` directory to PATH, and verify with `maestro --version`.
- **The gotcha that costs an evening.** Claude Code sessions inherit the environment of the
  desktop app (or terminal) that spawned them. After changing PATH, restart the **host app**, not
  just the Claude Code session, or a PATH-resolved MCP server keeps failing even though the CLI is
  installed and works in a fresh terminal. Symptom: `/mcp` shows `firebase` failed to connect, or
  a session-local CLI lookup fails while a brand-new terminal succeeds.
- **Never use `setx PATH "%PATH%;..."` on Windows to fix this.** `setx` truncates at 1024
  characters and silently overwrites the entire user `PATH`, not just appends to it - this has
  wiped a user PATH before. Snapshot the current value first, then use
  `[Environment]::SetEnvironmentVariable("Path", "<existing>;<new-entry>", "User")` in PowerShell.
- **Firebase CLI on PATH, and logged in.** `.mcp.json` starts it with `cmd /c firebase mcp`,
  PATH-resolved for the same reason `maestro` is. Install with `npm install -g firebase-tools`,
  then `firebase login`. The server reuses the CLI's own credentials, so there is nothing extra to
  configure and nothing committed.

  It is scoped to `--only core,messaging`, because this app uses Firebase solely for FCM. The
  flag matters: `--only` silently accepts an unrecognised feature name and simply exposes no tools
  for it, so a typo looks like a working config. Valid names are `apphosting`, `apptesting`,
  `auth`, `core`, `crashlytics`, `dataconnect`, `firestore`, `functions`, `messaging`,
  `realtime_database`, `remoteconfig`, `storage`. There is no read-only mode, which is why the
  write tools are listed under `permissions.ask` and in `CLAUDE.md`'s cloud-spend section.
- **Expo plugin OAuth.** Run `/mcp` and complete the Expo login flow. Each contributor
  authenticates individually as their own personal Expo account; no credentials are committed.
- **The Expo plugin also ships skills, and `expo-animation` is the one this repo leans on.** It
  is the animation construction skill (the frequency gate, Reanimated worklets, spring configs,
  gesture handoff, haptics), co-published with Emil Kowalski and identical to `animate-expo` in
  [emilkowalski/skills](https://github.com/emilkowalski/skills). Because `enabledPlugins` is
  committed, a fresh clone gets it with no setup, but it **first appeared in plugin version
  1.11.0** - a machine pinned to an older cached version will not list it. Check with `/plugin`
  if `expo-animation` is missing from the skill list. It is the construction reference;
  `.claude/rules/motion-conventions.md` is the binding bar for this codebase, and the rule wins
  where the two differ (notably: our `accelerate` curve is correct on exits, which the general
  "never ease-in" advice does not carve out). The other skills in that upstream repo are
  web-targeted (CSS, Framer Motion, Sonner) and deliberately not vendored here.
- **Expo credentials exist on developer machines only, never in CI:**

  | Path | Credential | Where |
  |------|-----------|-------|
  | Local agent tooling (Expo MCP) | Personal Expo account, via `/mcp` OAuth | Developer machine only |
  | Local `eas` CLI (submit, manual cloud build) | Personal Expo account, via `eas login` | Developer machine only |
  | CI (GitHub Actions) | **None.** No `EXPO_TOKEN`, no robot user, nothing Expo-side | CI builds with Gradle directly, so it never authenticates to Expo. See CI builds |

  An earlier plan had CI authenticating with an org-scoped `EXPO_TOKEN`. That is no longer the
  design: builds run on Gradle, so the smallest possible CI credential surface is no Expo
  credential at all.

- **Cost and public-write guard.** The Expo MCP's `build_run`/`build_submit`/`workflow_run` spend
  EAS cloud build credits, and its store-review-reply tools post publicly and irreversibly; on
  the CLI, `maestro cloud` bills Maestro Cloud minutes and carries the same bar (the Maestro
  MCP that used to expose it is gone). See `CLAUDE.md`'s "Cloud-spend and
  public-write MCP tools" section for the full list; it is backed by `permissions.ask` in
  `.claude/settings.json`, which prompts for confirmation on every call in every normal
  permission mode (a bypass mode skips the prompt, so the written policy is the real guard).
- **Optional:** set `MAESTRO_CLI_NO_ANALYTICS=1` to opt out of Maestro's anonymous CLI analytics.

## Developing @kangentic/protocol

`@kangentic/protocol` (the wire format, Noise handshakes, capability verbs, and event types) is
the one dependency shared by this app, the desktop `kangentic` app, and `kangentic-relay`
(see `.claude/rules/protocol-types-from-package.md`). Its source of truth is the **kangentic
monorepo** at `packages/protocol`; it is published to npm only at release milestones, not on
every change.

- **Committed dependency.** This app's `package.json` pins `@kangentic/protocol` to a published
  semver range (e.g. `^0.4.0`). That is what a fresh `npm install`, CI, and EAS cloud builds
  resolve, so the pinned version must be published before a cloud build that needs it.
- **Local iteration (no publish).** The dev rig builds the sibling monorepo's `packages/protocol`
  and links its packed output into this app's `node_modules` on every run (the rig's
  `ensureLocalProtocol`), so Metro and `tsc` track your local protocol checkout without an npm
  publish. It only touches `node_modules`, never the committed `package.json`; a change to the
  protocol source is detected by a content hash and forces a clean Metro cache. Pass
  `--no-protocol-link` to skip it (to test against exactly the installed package), and it skips
  itself gracefully when the sibling `../kangentic` checkout is absent.

Workflow for a protocol change:

1. Edit `packages/protocol/src` in the kangentic monorepo and bump its `package.json` version
   (minor for an additive, backward-compatible change; see wire compatibility below).
2. Open a PR against the monorepo and merge it to `main` - `main` is the protocol's source of
   truth, decoupled from npm publishing.
3. Locally, just re-run the dev rig (`npm run dev:live` / `dev:mock` / ...): it rebuilds and
   relinks the protocol automatically. The desktop app consumes `packages/protocol` as an
   in-repo workspace, so it only needs `npm run build --workspace packages/protocol` plus a
   desktop restart (its mobile-bridge runs in the Electron main process, which does not
   hot-reload).
4. Bump this app's pinned `^x.y.z` and publish `@kangentic/protocol@x.y.z` to npm only when the
   protocol is firmed up for a release, or a cloud build needs it.

**Wire compatibility.** Additive, backward-compatible changes keep `PROTOCOL_VERSION` the same,
so peers on different minor versions still interoperate (an older phone ignores unknown fields; a
newer desktop tolerates their absence). A breaking wire change bumps `PROTOCOL_VERSION`, which is
bound into the Noise prologue and forces all peers to upgrade in lockstep.

0.12.0 is the worked example, and it shows the cost. It derived the pairing slot
(`derivePairingSlotId`) instead of dialing the pairing token verbatim, which took
`PROTOCOL_VERSION` from `2` to `3` even though no message shape changed: a slot derivation
counts as wire-breaking because the slot is a zero-negotiation rendezvous value, so peers
deriving it differently never meet and simply hang until the relay's park timeout. Because the
version is bound into the KK **session** prologue and not only the pairing one, **every
already-paired device went dark until both ends ran matching software**, which is acceptable
only because the app has not rolled out. Budget for that outage whenever `PROTOCOL_VERSION`
moves.

Be precise about what that outage is, because the desktop's own PR #265 message says "must
re-pair" and that is loose: **the pairing itself survives a version bump.** Nothing stores a
protocol version alongside the pinned identity - not the phone's trust anchor
(`src/pairing/trustAnchor.ts`), not the desktop's roster (the desktop reads `PROTOCOL_VERSION`
only to mint the QR payload) - and `deriveSessionSlotId` takes no version, so both peers keep
meeting in the same session slot throughout. Once both ends update, the existing pinned keys
reconnect on their own: no second QR scan, no second SAS confirmation. What breaks in between is
session establishment, not the trust relationship.

## Project Structure

```
app.config.ts                # Expo config; CNG - config plugins only, no checked-in native projects
eas.json                     # EAS Build/Submit/Workflows profiles
plugins/                     # Local Expo config plugins: withAndroidPushService (notification
                             #   permissions + FGS type), withIosManualSigning (App Store signing,
                             #   inert outside CI), withAndroidE2eGwpAsanOff (e2e APK only),
                             #   withAndroidCmakeBuildStaging (relocates CMake's .cxx staging to a
                             #   short absolute root so Android builds from any path depth),
                             #   withAndroidGradleHeap (raises the Gradle daemon heap past the
                             #   template's 2048m so R8 survives a four-ABI production build),
                             #   withIosPodsUuidCollisionGuard (guards pod install against
                             #   CocoaPods' sequential-UUID collision corrupting Pods.xcodeproj;
                             #   droppable once fixed upstream),
                             #   withIosNotificationServiceExtension (creates the NSE target and
                             #   grants the app the shared keychain-access-group; must be
                             #   registered BEFORE withIosManualSigning, which signs that target),
                             #   withAndroidProfileable (adds
                             #   <profileable android:shell="true"/> so simpleperf can sample a
                             #   RELEASE build, gated on EXPO_PUBLIC_KANGENTIC_PROFILEABLE)
patches/                     # patch-package patches, applied by the postinstall script
targets/nse/                 # iOS Notification Service Extension source (Swift), copied into the
                             #   generated Xcode project at prebuild, never committed under ios/
app/                          # expo-router route wrappers (thin - render the src/screens/ implementation)
  task/[taskId].tsx           # full-screen task view; file-diff.tsx hosts the per-file diff
src/
  screens/        # TriageHome, Board, task/ (TaskScreen + Conversation/Terminal/Changes tabs),
                  #   FileDiff, Pairing (Scan/Confirm), Settings, Devices
  components/     # Design system + conversation/ cells and prompt cards, terminal/ xterm pane +
                  #   quick keys, board/ sheets, composer/, diff/ line cells
  pairing/        # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/        # Relay WebSocket transport, KK session manager (responder), slot derivation,
                  #   capability client, typed verb client, feed router, subscription manager
  connection/     # Lifecycle composer: connect/dispose, bootstrap, store feed glue, actions API,
                  #   dev-only mockDesktop peer (EXPO_PUBLIC_KANGENTIC_MOCK)
  conversation/   # Pure transcript-cell flattener, prompt keystrokes, pending-prompt summary
  devsupport/     # Loopback transport, protocol-faithful stub peer classes, wire fixtures -
                  #   shared by tests/unit and the mock desktop - plus claudeCapture*.ts
                  #   (RECORDED Claude Code PTY output, generated) and recordedTerminal.ts
                  #   (its replay player)
  terminal/       # Pure liveTail cleaner, key sequences, WebView bridge, generated xterm.html
  diff/           # Pure unified-diff lines (jsdiff) + path display
  notifications/  # Push key + registration, E2E blob decrypt, notifee channels, background task,
                  #   local notifier, foreground service, tap routing, permission cache,
                  #   sharedKeychain (rich display on both platforms: Notifee's background
                  #   handler on Android, the targets/nse/ extension on iOS)
  state/          # Zustand stores + the non-Zustand terminalFeed PTY ring buffers
  voice/          # Dictation hook over the OS speech engines
  observability/  # Sentry crash reporting - the only module allowed to import the SDK, plus the
                  #   pure event/breadcrumb scrubber (see crash-reporting-scope.md)
  lib/            # Shared pure utilities (crypto polyfills)
tests/unit/       # vitest
tests/components/ # Jest + RNTL
tests/helpers/    # Shared cross-tier test utilities (async waitUntil / flushMicrotasks)
tests/web/        # Playwright via react-native-web (later)
.maestro/         # Maestro E2E flows (smoke unpaired; paired/ needs scripts/stubDesktopPeer.mjs)
scripts/          # bash-guard.js, dev.mjs, stubDesktopPeer.mjs, buildXtermHtml.mjs
                  #   (assembles xterm.html from the page fragments in xterm-page/),
                  #   xterm-page/ (the WebView glue as plain browser .js modules,
                  #   concatenated into one IIFE - shared top-level state, no imports),
                  #   captureClaudeFrames.mjs + buildTerminalFixture.mjs (record real Claude
                  #   Code PTY output and pack it into src/devsupport/claudeCapture*.ts; dev
                  #   utilities, not run in CI),
                  #   storeScreenshots.mjs, syncBranding.mjs (npm run sync:branding pulls the
                  #   brand rasters, the Board tab glyph and the activity marks out of
                  #   @kangentic/branding; --check gates drift in CI),
                  #   cmakeStaging.mjs (npm run clean:staging prunes CMake staging trees whose
                  #   checkout is gone; --verify proves the object-path flag reached CMake),
                  #   build-review-pack.mjs (gathers the /code-review diff once into a
                  #   gitignored pack every finder reads instead of re-gathering; kept in step
                  #   with the desktop repo's copy)
                  #   + repo scripts
```

See `CLAUDE.md`'s Project Structure section; the tree there and this one move together.

## Build System

- **Continuous Native Generation (CNG):** native configuration flows through `app.config.ts` and
  Expo config plugins under `plugins/`. `ios/` and `android/` are prebuild artifacts, gitignored,
  and regenerated by `npx expo prebuild`; see `.claude/rules/expo-cng.md`.
- **Development builds** (`expo-dev-client`) from day one: Expo Go cannot run this app, since
  `expo-secure-store`, `expo-camera`, and (later) Notifee are all custom native modules.
- **Where builds run:** on GitHub Actions, with Gradle, on free runners. See CI builds below.
  EAS cloud builds still work and still cost one of the 15 free Android builds per month, so
  they are a fallback rather than the path.
- **EAS profiles:** `development` (dev-client, for local iteration), `preview` (internal
  distribution of a dev-signed build, not a Play track), `e2e` (release-shaped APK with
  `EXPO_PUBLIC_KANGENTIC_E2E=1`, the binary the Maestro paired suite runs against),
  `production` (store release; the Play internal track is reached by this profile plus
  `submit.production.android`, and it no longer auto-increments the version, see Android release
  and Google Play Console).

  `eas.json` stays the source of truth for these even though CI builds with Gradle:
  `scripts/easProfile.mjs` resolves a profile (following `extends`) and the workflow reads the
  `env` block and `android.buildType` from it. `tests/unit/buildWorkflow.test.ts` fails if the
  workflow's profile list and `eas.json` ever drift apart.

  | Profile | Artifact | Gradle task |
  |---|---|---|
  | `development` | APK (debug, dev client) | `:app:assembleDebug` |
  | `preview` | APK (release) | `:app:assembleRelease` |
  | `e2e` | APK (release) | `:app:assembleRelease` |
  | `production` | AAB (release) | `:app:bundleRelease` |

  Convenience scripts `npm run build:dev` / `build:preview` / `build:prod` still wrap
  `eas build --profile <profile> --platform android`, which is a **cloud** build and spends
  quota. Prefer the workflow.
- **R8 (minification and resource shrinking)** is on for the **release** variant, which the table
  above shows is `preview`, `e2e`, and `production` alike - only `development` is debug. One
  caveat on that mapping: `build-android.yml` also falls back to the debug variant for ANY profile
  when `ANDROID_KEYSTORE_BASE64` is absent, so a keystore-less run of `preview` or `production`
  produces an unminified artifact and no `mapping.txt`. That is the pre-existing degradation the
  release skill's preflight exists to catch. `e2e.yml` has no such fallback - it hard-fails
  without a keystore - so the PR gate is always the minified build. It is
  switched on by `enableMinifyInReleaseBuilds` and `enableShrinkResourcesInReleaseBuilds` in
  `app.config.ts`'s `expo-build-properties` block. Those are **gradle properties**: prebuild writes
  them to `android/gradle.properties`, and the generated release block reads them through
  `findProperty`, so `minifyEnabled true` never appears literally in `build.gradle`. Check
  `gradle.properties` when verifying, not `build.gradle`. `ci.yml` asserts both on every PR.

  Two consequences worth knowing before you debug something:

  1. **`e2e.yml` builds a minified APK on every PR that actually runs it**, so the Maestro suites
     are the gate that catches a class R8 stripped. (The build is skipped, not weakened, on a draft
     PR or a diff that touches no app code - `e2e.yml`'s `changes` job reports `draft` or
     `no-app-change`.) That is the reason minification is not restricted to
     `production`. It also means a stripping bug reddens a required check while looking exactly
     like an app bug - **suspect R8 first**, and fix it with `extraProguardRules` (which appends to
     the generated `proguard-rules.pro`) rather than by turning minification back off. React
     Native, Notifee, Reanimated, Worklets, and the Expo modules all ship their own consumer rules,
     so the repo deliberately carries no keep rules of its own until something proves it needs one.
  2. **Resource shrinking has no escape hatch through `expo-build-properties`.** Code stripping is
     fixed with an `extraProguardRules` string; a wrongly-dropped *resource* needs
     `res/raw/keep.xml`, which the plugin has no option for, so that fix would mean writing a
     config plugin. Two resources are named by string rather than by reference:

     | Resource | Named by | Anchored? |
     |---|---|---|
     | `notification_icon` drawable | `src/notifications/channels.ts` (Notifee ignores the manifest meta-data, so every `displayNotification` sets it explicitly) | **Yes.** The `expo-notifications` plugin block also emits a manifest `meta-data` entry pointing at it, and manifest-referenced resources are never shrunk |
     | `xterm.html` | `src/components/terminal/TerminalPane.tsx`'s `require('../../terminal/xterm.html')`, resolved through `Asset.fromModule` | **Not in the resource graph**, but its survival is now asserted on every build that runs the shrinker. Metro files every non-drawable asset under `res/raw` (`.html` is not in `@react-native/assets-registry`'s `drawableFileTypes`), and the name is resolved from the JS bundle at runtime, which the shrinker never scans |

     **Neither risk is caught by the Maestro flows.** No flow displays a notification, and none
     asserts WebView *content* - `.maestro/paired/session-mode-toggle.yaml`'s header says so
     outright ("WebView content is never asserted - only RN-side testIDs"). The RN-side chrome
     around the WebView stays visible whether or not the HTML loaded, so a dropped `xterm.html`
     would render the Terminal pane - the **default** view of the session screen - blank while
     every check stayed green.

     So the artifact is checked directly instead.
     **`.github/scripts/verify-android-assets.sh`** fails the build unless the artifact still
     carries an html resource the size of `src/terminal/xterm.html`. It runs unconditionally in
     `e2e.yml` (that job always builds a signed release APK, and fails outright without a
     keystore) and on **release variants only** in `build-android.yml`, which falls back to
     `assembleDebug` for any profile when no keystore is configured - a debug build runs no
     shrinker, so there is nothing there to guard. Note the limit at the far end too: on the
     `production` path this proves the **AAB CI produced**, not the split APK a device installs,
     because Play re-runs its own resource optimization at split time, after every check here.
     It matches on **size, not path**, and that is load bearing:
     `optimizeReleaseResources` renames resource files, so the shipped entry is
     `res/JU.html` rather than `res/raw/xterm.html` (measured on run 30506459459, byte for byte
     the 956707 of the source). A path check would go red on a *correct* build. It reads the
     expected size from the source file, so regenerating the page with
     `node scripts/buildXtermHtml.mjs` needs no change here.

     That covers the resource being PRESENT, which is the silent half. It does not prove the
     WebView renders, so a hand check on a `preview` build is still what proves the pane works
     end to end - and `notification_icon` has no equivalent artifact check, since a drawable that
     survives shrinking can still be the wrong one. If either breaks, the fix is a config plugin
     writing `res/raw/keep.xml`
     (`<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@raw/*"/>`), or
     turning `enableShrinkResourcesInReleaseBuilds` back off - minification, which is what Play's
     optimization rating mostly reads and what the `mapping.txt` work exists for, is independent
     of it.

  `build-android.yml` uploads `mapping.txt` as its own run artifact (`mapping-<artifact-name>`)
  alongside the APK/AAB. That is the file Play Console accepts for manual deobfuscation, and the
  fallback if the Sentry upload below ever fails. The step is gated on the release variant and
  then set to **fail** when the file is missing, rather than shrugging it off: a debug build has
  no mapping legitimately, but a release build without one is a break worth reddening the job for.

  iOS has no counterpart to any of this and needs no equivalent switch: it ships compiled machine
  code, and the LLVM optimizer and linker dead-stripping already run under `-configuration Release`.
  Bitcode, the one historical knob, was removed by Apple in Xcode 14.
- **EAS Update** for JS-only OTA updates (free tier, 1,000 MAU) once the app ships.
  `expo-updates` is not installed yet, so the `channel` field on each profile is currently inert.

## CI builds (GitHub Actions)

The build and test workflows in `.github/workflows/` (alongside `cla.yml`, the CLA bot):

| Workflow | Trigger | Runner | What it does |
|---|---|---|---|
| `ci.yml` | every PR, push to `main` | `ubuntu-latest` | lint (plus `sync:branding:check` for brand-asset drift), typecheck, the unit tier (unsharded) and the sharded component tier, native config, and the release-counter preflight on PRs |
| `e2e.yml` (workflow name: `Emulator`) | every PR, push to `main` | `ubuntu-latest` | builds the e2e APK, runs `.maestro/smoke.yaml` (the required gate) and `.maestro/paired` (advisory) on separate emulators |
| `build-android.yml` | `workflow_dispatch`, `v*` tags | `ubuntu-latest` | signed APK/AAB, optional Play submit |
| `build-ios.yml` | `workflow_dispatch` | `macos-latest` | unsigned simulator compile check, or a signed `.ipa` with an optional TestFlight upload. `-f screenshots=true` instead captures the App Store 6.9-inch listing frames on a booted simulator (experimental, ~45 min per attempt) |

### What each check on a PR means

A PR to `main` reports **15 check runs**, of which **9 are required**. GitHub prints a
"Required" badge on those and nothing on the rest, so the badge is the authority; this table is
what each one actually proves and roughly what it costs. Durations are measured, not estimated.

**Treat the count below as a snapshot, not a contract.** It has been wrong three times in a single
day: twice from renames, and once when `Release counters (stores)` was promoted to
required while an unrelated PR was in flight. `gh api repos/Kangentic/mobile/branches/main/protection/required_status_checks --jq '.contexts'`
is the only authority, which is why `/pull-request` reads it rather than trusting a list.

**The 9 required checks** (these, and only these, block a merge):

| Check | Workflow | What a green result proves | Typical |
|---|---|---|---|
| `Lint (ESLint)` | `ci.yml` | `eslint . --max-warnings 0`, plus `sync:branding:check` for brand-asset drift | 29s |
| `Type check (tsc)` | `ci.yml` | `tsc --noEmit`, behind the `checkInstallDrift.mjs` guard | 22s |
| `Unit Tests (Vitest)` | `ci.yml` | Runs the whole unit tier. Unsharded, so this job is both the work and the required check | 30s |
| `Component Tests (Jest)` | `ci.yml` | A thin gate: every `Component Tests (n/2)` shard passed, on **both** platforms | 2s |
| `Native config (prebuild)` | `ci.yml` | `expo install --check`, prebuild for iOS **and** Android, the Sentry plugin actually wiring itself in (including the Android Gradle Plugin that uploads the R8 mapping, and both generated `sentry.properties` files pinning `defaults.org=kangentic` / `defaults.project=mobile`, since a stale slug 404s the upload during a real release), R8 minification and resource shrinking being enabled, the E2E-only manifest carve-outs landing, the CMake staging block reaching `settings.gradle` and not stacking on a repeat prebuild, the Notification Service Extension target being injected exactly once with its sources and `NSExtensionPointIdentifier`, the app entitlements carrying the shared Keychain group with the application-identifier group **first**, and `android`/`ios` staying untracked | 25-33s |
| `NSE crypto (swiftc)` | `ci.yml` | Compiles the extension's Swift crypto on a macOS runner and opens push envelopes sealed by `@kangentic/protocol`'s own `sealPushEnvelope`, including the published HChaCha20 vector and the tamper / wrong-key / wrong-AAD / stale rejections. The only gate that proves the Swift XChaCha20-Poly1305 is *correct* rather than merely compiling | ~1-2 min |
| `Release counters (stores)` | `ci.yml` | The hand-managed `versionCode` and `buildNumber` have not been reused. Runs on `pull_request` only | ~15s |
| `E2E Tests (Maestro)` | `e2e.yml` | A thin gate: `E2E Tests (Smoke)` passed, **or** the suites were legitimately skipped (`no-app-change` or `draft`) and it says which | 3s |
| `cla` | `cla.yml` | The contributor has signed the CLA | 7s |

**The other 6 are not required, and that is deliberate.** They fall into two groups:

| Check | Workflow | Why it is not required | Typical |
|---|---|---|---|
| `Component Tests (1/2)`, `(2/2)` | `ci.yml` | Shards. An implementation detail behind the `Component Tests (Jest)` gate, so shard counts can be retuned without touching branch protection | 52-63s each |
| `Changes` | `e2e.yml` | Intermediate. It only classifies the diff. Note the gate now **fails closed** if this job does not succeed, so it cannot silently wave a PR through | 5s |
| `Build (APK)` | `e2e.yml` | Intermediate. Its failure reaches you as a red `E2E Tests (Maestro)`, because a skipped suite is not a pass | 6 to 9m |
| `E2E Tests (Smoke)` | `e2e.yml` | Intermediate. This is the suite the required gate reads | ~2m |
| `E2E Tests (Paired)` | `e2e.yml` | **Advisory**, and the only one here that is a real signal rather than plumbing. See below | ~9m |

Two consequences worth internalising:

- **A green `E2E Tests (Maestro)` means smoke coverage, not the paired suite.** Read `E2E Tests (Paired)`
  separately, every time. `/pull-request` reports it explicitly for this reason.
- **The required gate clears well before the workflow finishes.** Measured on PR #28: the seven
  required checks were green at 04:06:15 while `E2E Tests (Paired)` ran until 04:12:40. Waiting on
  the whole check list costs about six minutes of nothing, which is why `/pull-request` watches
  with `gh pr checks --required`.

**Naming convention, matching the kangentic desktop repo.** A workflow `name` is short Title Case
(`CI`, `Emulator`, `Build iOS`). Every job carries a lowercase key to reference plus an explicit
Title Case `name` with a parenthetical naming the tool or target (`Lint (ESLint)`,
`Device (signed .ipa)`, `Submit (Google Play)`); a matrix job interpolates its dimension
(`Build (${{ matrix.profile }})`). Without a `name` the Actions UI shows the raw key, which reads
like an internal detail.

**Every job is `<Subject> (<qualifier>)`, and the qualifier is written the way the thing it names
is normally written:**

| The qualifier is | Written as | Examples |
|---|---|---|
| A **tool** | Its own name, whatever case that is | `Lint (ESLint)`, `Type check (tsc)`, `Unit Tests (Vitest)`, `Native config (prebuild)`, `E2E Tests (Maestro)` |
| A **shard** | `n/m` | `Component Tests (1/2)`, `(2/2)` |
| Anything else | Sentence case prose | `E2E Tests (Smoke)`, `E2E Tests (Paired)`, `Release counters (stores)` |

`tsc` is lowercase because that is the binary's name, not because it is a lesser kind of job.
**A slug is never a qualifier:** `E2E Tests (smoke)` was `e2e.yml`'s matrix key leaking into the
checks list, and it read as a typo next to the capitalised gate it belongs to. The matrix now
carries a separate `label:` for display, so the artifact name can stay a slug while the check name
is prose.

**What the name deliberately does not encode: whether a row is a worker or the gate above it.**
Two attempts at that are recorded here so a third does not get made. The desktop repo does it by
case (`Unit Test (1/3)` for a shard against `Unit tests (Vitest)` for its gate); mobile then tried
lowercase suite names. Both spend a casing distinction on saying something GitHub's own "Required"
badge already says, in a column too narrow for one capital letter to survive a skim, and mobile had
already drifted off the desktop convention once, silently. `1/2` is self-evidently a piece of
something; the badge says the rest. It is the same argument `e2e.yml` uses for not writing
"advisory" into the paired job's name.

The E2E workflow is named `Emulator`, not `E2E`, for the same reason: GitHub renders a check as
`<workflow> / <job>`, so `E2E` plus `E2E Tests (Maestro)` would have stuttered. A workflow name is
not a protection context, so it was the free half of that pair to change.

**A stacked PR gets no CI.** `ci.yml` and `e2e.yml` both filter `pull_request` to
`branches: [main]`, so a PR whose base is another feature branch runs only the CLA check and reports
"all checks passed" having tested nothing. That is a trap, because a stacked PR is otherwise the right
shape for dependent work: it keeps the diff to just the new commits and GitHub retargets it to `main`
automatically when the parent merges. Two ways through it, and the second is better:

- Retarget to `main`. CI runs, but the diff swallows the parent branch's commits, which makes review
  harder for exactly the change that needed stacking.
- **Dispatch the gate directly at the branch:** `gh workflow run ci.yml --ref <branch>`. Both
  workflows accept `workflow_dispatch`, so this runs every job against the branch with no retargeting
  and no diff noise. Link the run from the PR so a reviewer can see the gate was actually exercised.

**A job name in `ci.yml` or `e2e.yml` is a branch-protection status-check context**, so renaming one
there silently breaks the gate on `main` until protection is updated in the same change. The build
workflows are free to rename because neither is a required check. Two further notes: the Actions
sidebar shows the workflow `name` from the **default branch**, so a rename appears stale until it
lands on `main`; and a `run` step with no `name` renders as its whole shell command, so name any step
whose script is longer than a line.

**The gate and the release are separate concerns by design.** `ci.yml` and `e2e.yml` gate every PR,
so `main` is always stable. `build-android.yml` and `build-ios.yml` are dispatch or tag triggered
only, so a release can be cut from `main` whenever wanted without waiting on E2E timing, and a
build workflow never blocks a PR. Do not add a build workflow to the required checks: it would
deadlock every PR on a check that never runs.

**A PR that cannot change the APK skips the E2E build.** `e2e.yml`'s `changes` job classifies the
diff and the expensive jobs are conditional on it. Skippable: markdown anywhere, `docs/`,
`.claude/`, **`tests/`**, `LICENSE`, `CLA.md`. It reports as `skip-reason=no-app-change`.

`tests/` is on that list because nothing under it ships in the binary, so a tests-only diff
produces a byte-identical APK and the suites could only re-confirm the previous run. The unit and
component tiers still run on it, since `ci.yml` has no path filter at all.

This is deliberately not `paths-ignore` on the trigger: `E2E Tests (Maestro)` is a required check,
and a workflow skipped by `paths-ignore` never reports its checks, so branch protection would wait
forever and the PR could never merge. The workflow always runs, the costly jobs are skipped, and
the gate treats a skipped suite as a pass. The fail-safe direction is to run: anything the
classifier cannot confidently place on that list builds. Changes under `.github/` always run,
because a workflow change must be exercised.

**That list is a fail-open surface**, so it is guarded. Everything on it means E2E does not run
while the required check reports green, so a careless addition would silently stop testing real app
changes rather than break anything visibly. `tests/unit/e2eGate.test.ts` extracts the pattern from
the workflow and runs it through the same `grep -qvE` the job uses, over 17 representative diffs.

**Two known costs, not yet paid down.** `e2e.yml` has its own build job that overlaps with
`build-android.yml`. `setup-gradle` scopes its cache per workflow, so the two do not share a warm
Gradle cache and the E2E build pays a cold one. Consolidating them behind `workflow_call` would fix
it; that was deferred so a change to the E2E path could not break the release path, and the hazard
to watch when doing it is the reusable workflow's concurrency group colliding with a direct
dispatch. (`profile=all` used to be the second entry here, "implemented but unmeasured"; it was
removed 2026-08-26 without ever being run - it could not submit, and its one-element matrix
wrapped every real build in a misleading "Matrix:" group in the Actions UI. Building several
profiles is now several dispatches, which the per-profile concurrency group already supports.)

### What is pinned, and what is deliberately not

A required status check can be reddened by a release in somebody else's repository, with no commit
here. `E2E Tests (Maestro)` depends on three such moving parts, and they are treated differently on
purpose.

- **The Maestro CLI is pinned.** `curl -Ls https://get.maestro.mobile.dev` installs
  `releases/latest` unless `MAESTRO_VERSION` is set, so every run used to install whatever shipped
  that morning - currently 2.7.0. It is now a workflow-level `env:` in `e2e.yml`, read by both
  emulator jobs, and repeated in `build-ios.yml`, which runs the same `.maestro/smoke.yaml` on a
  macOS runner. In `e2e.yml` only, a `Report the Maestro version` step **asserts** the installed
  version equals the pin rather than printing it for a human who is not reading. `build-ios.yml`
  has no such guard and only prints, so an installer change would go unnoticed on that path until
  a flow behaved oddly. Maestro is the thing whose behaviour
  against these specific flows can change under you, which is what earns it a pin.
- **The relay is pinned to a SHA**, for the same reason, one repository over.
- **`reactivecircus/android-emulator-runner@v2` is deliberately left floating.** Its surface is
  "boot an emulator and run a script", which is stable in a way a test runner's flow semantics are
  not, and pinning it to a SHA buys a maintenance chore against a risk that has not materialised.
  This is a judgement, not an oversight; revisit it if that action ever breaks a run.

`tests/unit/ciSafeMaestroFlows.test.ts` holds the pin in place: the value exists and is a bare
`x.y.z` (a `cli-` prefixed one would 404 at install time), no job shadows it with its own `env:`,
`build-ios.yml` agrees, and **the local recipe in `.claude/rules/e2e-maestro-runs.md` names the same
version**. That last one matters as much as the pin itself. Pinning CI alone just moves the problem:
a developer on a newer CLI writes a flow that passes locally and fails the gate, with nothing in
either place explaining why.

**GitHub Actions are kept off Node 20**, which GitHub is already force-running on Node 24 and will
eventually remove. `actions/setup-java@v5`, `android-actions/setup-android@v4` and
`gradle/actions/setup-gradle@v5` were the last three declaring `node20`. Two notes on those bumps:

- **`setup-gradle` is on v5 and must not be bumped to v6 casually.** v6 extracted this action's
  caching into `gradle-actions-caching`, a proprietary component that is not open source and is
  governed by Gradle's commercial Terms of Use, which upgrading accepts on the project's behalf.
  This repository is AGPLv3 and dual-licensed, so that is a licensing decision for a human. v6 also
  removed configuration-cache support pending a reimplementation inside that same component.
- **`setup-android@v4` also changes the default cmdline-tools to 20.0**, which is a behaviour
  change and not just a runtime bump. It is the only one of the three on the critical path, so if
  `Build (APK)` breaks shortly after, pin `cmdline-tools-version` rather than reverting to a
  runtime that is going away. It built green first time on run 30401393044.

**The `setup-gradle` bump was predicted to cost a cold cache. It did not, and the way that was
established is the point.** The action version feeds the cache key, so the first build after the
bump was expected to miss outright:

| Gradle action | `Build (APK)` samples | Task reuse |
|---|---|---|
| v4 | 7m 23s | `1055 actionable tasks: 640 executed, 415 from cache` |
| v5 | 7m 52s, 8m 14s, 8m 19s, 8m 28s | `1055 actionable tasks: 640 executed, 415 from cache` |

**Cache invalidation is ruled out, by the task line and not by any duration.** Reuse is
byte-identical: the Gradle User Home entry resolved through a **restore key** rather than an exact
one, and every sub-cache (dependencies, transforms, kotlin-dsl, wrapper) hit outright. Whatever the
version bump did, it did not reach a task. That is the settled part, and it was settled by a number
nobody would have checked once the stopwatch already agreed with the prediction.

**The durations say nothing, and the way that became clear is the more useful lesson.** This
paragraph was rewritten three times as samples arrived, and each rewrite was confidently wrong in a
new direction. First a cold cache was predicted and the first slow run appeared to confirm it. Then
"no evidence it cost anything", which two more samples made too strong. Then an argument built on
three v5 runs clustering within 14 seconds, which read as real signal until a fourth landed at
7m 52s and widened the range to 36s, putting its low end 29 seconds from the v4 sample.

Four v5 samples spanning 36 seconds against one v4 sample is not a comparison. Do not build one out
of it, and note that the temptation each time came from having *just enough* data to see a shape.
The bump is not optional anyway: v4 declares a Node runtime that is being removed.

The reason this is written up at all: the duration alone would have "confirmed" the prediction. The
run WAS 65 seconds slower, a comment in `e2e.yml` said to expect exactly that, and stopping there
would have written "measured" over a guess. The number that settles it is one nobody would have
looked at once the stopwatch already agreed.

**One required check still runs on Node 20, and there is no upgrade for it.** `cla` uses
`contributor-assistant/github-action@v2.6.1`, which declares `node20`, and v2.6.1 is the latest
release.
It passes today because GitHub force-runs it on Node 24. Watch it: when Node 20 is removed for
real, the fix is a fork, a replacement action, or dropping the bot, and none of those is a
five-minute job to discover under time pressure.

**Concurrency cancels superseded PR runs, never runs on `main`.** Both workflows use
`cancel-in-progress: ${{ github.event_name == 'pull_request' }}` rather than a blanket `true`.
A cache is only shared with every branch once it has been written from the **default** branch, so
the push-to-`main` run is what fills both the Gradle build cache (`setup-gradle` restores
everywhere but saves only on the default branch, which is where `Build (APK)`'s "415 from cache"
comes from) and the `node_modules` cache. Under a blanket `true`, two merges landing close together
cancelled the first `main` run mid-build and the cache it was about to write never landed, so the
next PR paid for it. PR runs use `refs/pull/N/merge` and were never in the same concurrency group
as a `main` run, so nothing about PR cancellation changes.

**The critical path to a merge is ~9m30**, and only three jobs are on it. Measured end to end on
run 30397988677:

| Job | Window | Cost |
|---|---|---|
| `Changes` | 20:49:13 to 20:49:18 | 5s |
| `Build (APK)` | 20:49:20 to 20:56:43 | 7m 23s |
| `E2E Tests (Smoke)` | 20:56:51 to 20:58:36 | 1m 45s |
| `E2E Tests (Maestro)` (the gate) | 20:58:39 to 20:58:41 | 2s |

`E2E Tests (Paired)` runs alongside smoke and finishes at 21:05:43, six to seven minutes after the
gate is already green. It is not on this path, which is exactly why `/pull-request` does not wait
for it, and why optimising it buys no merge latency.

**Where `Build (APK)`'s 7m 23s goes** (same run; Gradle itself reported `BUILD SUCCESSFUL in 6m 5s`,
`1055 actionable tasks: 640 executed, 415 from cache`):

| Phase | Cost |
|---|---|
| Job setup, checkout, Node deps (cache hit), JDK, Android SDK, prebuild | ~1m 05 |
| `setup-gradle` (Gradle cache restore) | 26s |
| Gradle configure and dependency resolution | ~1m 01 |
| Metro bundle, `Android Bundled 86307ms index.js (4282 modules)` | 1m 26 |
| Third-party CMake (`expo-modules-core`, `reanimated`, `gesture-handler`) | overlaps the above, tails ~1m 35 past it |
| `:app:buildCMakeRelWithDebInfo[x86_64]` | 1m 45 |
| `mergeReleaseNativeLibs` through `packageRelease` | 13s |

**Read that table as a graph, not a list.** An earlier version of it summed the phases and made
Metro look like the largest, at "~3m10". It is not: Metro runs *concurrently* with the third-party
CMake builds under `--parallel`, and the 3m10 was the two of them wall-clocked together. **Native
C++ compilation is the long pole**, roughly 3m20 of a 6m05 Gradle build once the dependency
modules and `:app:` are counted together. That matters because it changes where a speedup would
have to come from: not from Metro, and not from anything Gradle's own build cache can reach, since
external native build tasks are not cacheable. ccache is the only lever, and see below for why it
has not been pulled.

**That table predates R8, and two later measurements matter more than any single phase in it.**

*R8 is real and it stays.* `:app:minifyReleaseWithR8` measured 137.3s to 169.2s across runs and is
absent entirely from every pre-R8 log, which matches the +167s step-level delta arrived at
independently (pre-R8 mean 405s over 3 runs against 572s over 2). AGP 8 fuses code and resource
shrinking into that one task, so no log can split them; the experiment that can was run, and
resource shrinking turned out to cost nothing measurable (see the R8 section above).

*CACHE HEALTH DOMINATES EVERYTHING ELSE, and it is measured, not inferred.* Two `Build (APK)` runs
of **identical configuration** on the same commit:

| Run | Gradle | Task reuse |
|---|---|---|
| 30514455368 | **12m 39s** | `1029 actionable tasks: 883 executed, 146 from cache` |
| 30517929707 | **7m 01s** | `1029 actionable tasks: 638 executed, 391 from cache` |

**5m 38s apart with nothing changed but how much of the cache survived.** So the first thing to
check when this job looks slow is the `from cache` count, not the diff. A run at 146 was read as an
R8 regression before anyone looked at that number.

Read that pair as cache WARMING, not as a scoreboard for any cleanup: 30514455368 is the run that
*wrote* main's cache, and 30517929707 restored what it wrote. Nothing in
`.github/workflows/cache-cleanup.yml` is claimed to have produced those 5m 38s. What that workflow
buys is **headroom**, and the case for it is a capacity argument rather than a stopwatch one: the
cap is 10 GB, usage measured 9.86 GB, eviction is by last access across every ref, 1.92 GB sat on
refs `main` can never read, and eviction was observed happening live (39 entries to 37 between two
reads minutes apart). Whether any given slow run was caused by that specific 1.92 GB is not
something these numbers can say.

It also means **any A/B on this job needs the `from cache` line quoted on both sides**, and ideally
a normalisation against `buildCMakeRelWithDebInfo` plus `minifyReleaseWithR8`: those are identical
work in every run and still spanned 174.5s to 252.3s across four builds of the same code, which is
the runner-to-runner noise floor a claimed saving has to clear.

**Where the emulator job's time goes**, measured on run 30397988677's `E2E Tests (Smoke)`. The job
is 1m 45s and the emulator step is 1m 30s of it:

| Phase | Cost |
|---|---|
| SDK component installs (build tools, emulator, system image) | 29s |
| AVD create | 1s |
| Emulator start to `Emulator booted.` | 33s |
| Unlock, ABI probe, APK install | 6s |
| The flow itself (`1/1 Flow Passed in 8s`) | 17s |
| Teardown | ~1s |

**The "20 seconds to shutdown gracefully" line is not a cost.** Teardown prints `Wait for emulator
(pid N) 20 seconds to shutdown gracefully before kill; you can set environment variable
ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL...`, which reads like 20 seconds spent politely closing an
emulator nobody will use again. It is a **ceiling**. The emulator exits well inside it and the wait
ends: `emu kill` to the last teardown line was **1.0s** on smoke (20:58:33.83 to 20:58:34.86) and
**0.9s** on paired (21:05:38.70 to 21:05:39.58). Setting that variable would save nothing and would
introduce a hard kill on a process mid-write. Do not.

Likewise `ERROR | Failed to find ColorBuffer: <n>` in the paired log is swiftshader bookkeeping
noise on a headless GPU, not a failure. It appeared three times in an 11/11 green run.

**Where `E2E Tests (Paired)`'s non-flow time goes** (8m 58s job, `11/11 Flows Passed in 5m 48s`):
SDK install 30s, emulator boot 33s, APK install 5s, relay plus stub plus pairing URI 2s, and the
**pairing bootstrap at 1m 12s** - of which a single `Input text ${PAIRING_URI}` command is **40.7s**
(20:58:53.19 to 20:59:33.90). Maestro types the URI a character at a time over its driver, and the
URI is a public key plus a token plus a relay address. It reproduced at **40.5s** on run
30401393044, so this is a property of the command rather than the bursty `launchApp` stall
described below, which is what a single sample could not have told you.

That 40.7s is **not being fixed**, deliberately. Every route to it is worse than 40 seconds on a job
that is advisory and off the critical path: the clipboard cannot be set from adb on API 29+ without
a foreground app; `adb shell input text` also types character by character and would need the URI's
`//` escaped; and the deep-link route needs OS routing of `kangentic-pair://`, which is a later
phase. What is left is changing the pairing ceremony itself, which is the security-critical path
this suite exists to prove.

**AVD snapshot caching was considered here and rejected on those numbers.** The obvious move is to
cache `~/.android/avd` so the emulator boots from a snapshot, and the intuition was that boot
dominates. It does not: boot is 32s, snapshot restore might take it to ~10s, so the ceiling is
about 20 seconds off a ten-minute gate. It also costs a duplicated `android-emulator-runner` block
and a cache step **on both emulator jobs**, and the SDK install is an equally large 32s that
snapshot caching does not touch at all. Not worth the moving parts. Revisit only if the emulator
jobs ever land on the critical path for a merge, which today only smoke does.

The **JS bundle is not cacheable** in any case: its input is the app's own source, which is what
changed on every PR by definition.

And **caching `android/app/.cxx` does not work.** This was tried and measured on 2026-07-28 rather
than argued about, so the numbers are the answer. (The path is still right for CI, which builds on
Linux. On a Windows machine that directory no longer exists: `withAndroidCmakeBuildStaging`
relocates it out of the checkout. Different problem, and the caching verdict below is about ninja
mtimes, not path length.)

| | CMake task |
|---|---|
| cache MISS (run 30387646820) | 2m 07s |
| cache HIT (run 30389177999) | 1m 48s |

A genuine hit on a 16 MB entry, keyed on native inputs only and restored after prebuild, bought
**~19 seconds** of a possible ~2 minutes. `Build (APK)`'s own run-to-run spread is 6m 03s to
8m 37s, so that saving is inside the noise.

The reason is timestamps. `expo prebuild` regenerates `android/` fresh on every run, ninja is
mtime-driven, and it rebuilt nearly everything despite having every object file already present.
The correctness worry that made this look risky (a stale `.so` reaching the APK the E2E suite then
certifies) never even got a chance to matter, because nothing was reused.

The fix that would work is content-addressed rather than timestamp-driven: ccache, via
`CMAKE_C_COMPILER_LAUNCHER`. Under CNG that needs a config plugin plus a Gradle property, which is
real machinery for ~2 minutes on a job that is not on a merge's critical path. Worth revisiting
only with the mtime trap understood as the thing to solve.

**The node_modules cache deliberately has no `restore-keys`.** A partial restore would be
discarded anyway: the install step runs whenever `cache-hit != 'true'`, and `npm ci` deletes
`node_modules` before installing. Adding fallback keys would cost a download and an extraction to
produce a tree that is immediately thrown away.

**The emulator uses the `default` system image, NOT `google_apis`, and that is load-bearing.**
With Play Services the smoke flow failed three runs out of four, and the failure looked exactly like
an app bug: `Assertion is false: id: home-tab is visible`, surviving even a 45-second
`extendedWaitUntil`. It was not an app bug. Diagnostics proved the app process was **alive** with
`MainActivity` both resumed and focused, no ANR, no exception from our package: it had simply not
rendered. Meanwhile `ActivityManager` was killing and restarting `settings.intelligence`, gms
services were failing to bind, and gms churn refilled a freshly cleared logcat buffer within
seconds, so the app's own launch window was never even captured.

**Play Services was starving the app.** On the `default` image the same commit renders in **7
seconds**, against 16s on a quiet gms image and never within 45s on the failing runs. App code was
byte-identical across all of them.

Two things follow. Do not "fix" a flaky Maestro run by extending timeouts before checking whether
the process is alive and what is focused: a starved emulator and a hung app produce an identical
assertion failure. And when a paired suite that exercises remote push eventually needs
`google_apis`, add it as a **separate matrix entry** rather than putting every flow back on the
image that caused this.

**Two E2E suites, two jobs, one required.** `e2e.yml`'s `maestro` job runs `.maestro/smoke.yaml`
against a fresh unpaired install (no relay, no pairing) and is what the required
`E2E Tests (Maestro)` check actually gates on. The separate `maestro-paired` job runs the 11 flows
under `.maestro/paired/`: it checks out the public `Kangentic/relay` repo (pinned to a SHA), builds
and runs it on the runner, pairs the app to `scripts/stubDesktopPeer.mjs` over it - the same relay
and stub the local `dev:stub --pair` rig uses - and then runs the suite
(`.github/scripts/run-maestro-paired.sh`). The `usesCleartextTraffic` carve-out this depends on
(`app.config.ts`, gated on `EXPO_PUBLIC_KANGENTIC_E2E`) is on `main`.

`maestro-paired` is deliberately advisory: it reports its own check but is not read by the `e2e`
gate job, so a red run does not block a merge. A required check that cannot go green blocks every
merge, which is why only smoke was ever wired into the gate - and why the paired job stays outside
it until it has earned promotion.

**The promotion criteria, concretely.** "Green across several PRs" was too vague to act on, so:

1. **10 consecutive green `E2E Tests (Paired)` runs** across at least 5 distinct PRs. Consecutive
   means no red run in between, not 10 greens cherry-picked out of a longer history. The check was
   called `Maestro (paired)` before 2026-07-28, so a streak spanning that date shows under two
   names in the run history and is still one streak - the rename changed a display string, not the
   job, and does not reset the count.
2. **No re-runs among them.** A flow that passes on the second attempt is a flaky flow, and
   promoting a flaky suite to required is precisely the "cannot go green" hazard. A re-run resets
   the count to zero.
3. **No open `e2e-flow-doctor` verdict** against any of the 11 flows.

Check the streak with `gh run list --workflow=e2e.yml --limit 30 --json conclusion,headBranch,url`
and read the `E2E Tests (Paired)` job on each, because the run-level conclusion also reflects the
required jobs.

On meeting all three, promotion is a small deliberate edit, and every piece of it is meant to be
noticed:

- Add `maestro-paired` to the `e2e` gate job's `needs:`.
- Fold `needs.maestro-paired.result` into the gate's pass condition, next to
  `needs.maestro.result`.
- Update the gate's coverage table so the paired row reads "yes" rather than "no".
- Delete the assertion in `tests/unit/ciSafeMaestroFlows.test.ts` that pins `maestro-paired` out
  of the gate. That test failing is the intended cost of promotion, not an obstacle to it.
- Extend `tests/unit/e2eGate.test.ts`'s cases to cover the new input.

The required check's **name never changes**, so `main`'s branch protection is untouched. That is
the whole reason the gate is a thin job rather than the suite itself.

**Why this is free.** The repository is public, so standard GitHub-hosted runners are unmetered
on Linux and macOS alike. The build runs `npx expo prebuild` then Gradle on the runner, so it
never touches EAS servers and spends no EAS cloud build credit. Linux also has no Windows
path-length limit, though that is no longer a reason to prefer CI: see "Local Android builds work
from any path".

**Triggering an Android build.** Actions -> Build Android -> Run workflow, or
`gh workflow run build-android.yml -f profile=preview`. Inputs:

| Input | Meaning |
|---|---|
| `profile` | An `eas.json` build profile. Decides the artifact type, the Gradle task, and the `env` block. One dispatch builds one profile; run several dispatches for several profiles. |
| `artifact` | `auto` follows the profile; override to force `apk` or `aab`. |
| `abis` | Comma-separated ABI override. Leave empty to use the per-profile default below. |
| `submit_track` | `none` (default) builds only. Any other value queues a Play upload behind an approval gate. |

A `v*` tag build always produces a production AAB with every ABI.

The artifact lands on the run as `kangentic-<profile>-v<version>-vc<versionCode>-<sha>`, kept for
14 days. Version name, code, and the ABI set are printed in the run summary.

**Build speed: measured, and not where you would guess.** Three runs, all Android release APKs:

| Run | ABIs | Gradle cache | Gradle step | Total |
|---|---|---|---|---|
| cold, four ABIs | 4 | empty | 1665s | 29 min |
| warm, four ABIs | 4 | populated | 1011s | 19 min |
| warm, one ABI, `--parallel --build-cache` | 1 | populated | 695s | 13 min |

Two findings worth keeping, because both contradict the obvious guess:

- **The Gradle cache is worth about 11 minutes** (1665s to 1011s, a 39% cut). Native object files
  are not in `GRADLE_USER_HOME`, so it is tempting to assume the cache barely helps. Wrong: most of
  that first run was dependency resolution, the Gradle distribution, AGP artifacts, and Kotlin/Java
  compilation across the roughly 20 autolinked library modules.
- **Per-ABI native compilation is only about 105 seconds.** Dropping three of four ABIs saved 316s,
  not the 18 minutes a naive per-ABI estimate suggests. The ABI-independent portion is roughly
  590s and is the real bottleneck: JS bundling, resource processing, dexing, and module compilation.

So ABI reduction is worth having but is not the main lever, and a compiler cache (ccache) targets
the 105s rather than the 590s, which makes it much less valuable here than it first appears. The
levers that actually attack the 590s are the Gradle build cache (now enabled, effect not yet
measured on a second warm run) and potentially Gradle's configuration cache, which React Native
documents but which tends to break on AGP plus a nonstandard plugin set, so it is not enabled blind.

`scripts/androidAbis.mjs` gives each profile only the ABI its target actually runs, which is the
documented React Native approach (`-PreactNativeArchitectures`, see
https://reactnative.dev/docs/build-speed):

| Profile | Default ABIs | Why |
|---|---|---|
| `development`, `preview` | `arm64-v8a` | the maintainer's physical device |
| `e2e` | `x86_64` | the Android emulator's standard system images. An arm64-only APK will not install on it |
| `production`, `v*` tags | all four | Play serves real devices including 32-bit ARM and x86 Chromebooks, and an app bundle must carry every ABI for Play to split per device |

`.github/scripts/verify-android-abis.sh` then asserts the artifact carries exactly the ABIs that
were asked for, so neither a silently-dropped ABI nor a silently-ignored flag can pass.

Two more flags that cannot change the output, only the speed: `--parallel` (a React Native project
is many Gradle modules, one per autolinked library, so parallel project execution is a real win)
and `--build-cache` (`setup-gradle` caches `GRADLE_USER_HOME`, which includes the local build cache,
and Gradle keys entries on task inputs).

**Parallelism.** Selecting `all` fans the profiles out across runners rather than building them
back to back. A matrix over ABIs is deliberately **not** used: every parallel job would repeat the
whole ~590s ABI-independent portion, so with per-ABI cost at only ~105s it would trade a large
amount of duplicated work for very little wall clock. An app bundle must also be a single artifact
containing every ABI, so `production` could not be split that way regardless.

**Secrets.** All optional: the workflow degrades rather than failing when one is missing, so the
pipeline can be exercised before any of them exist. With no keystore it builds a debug-signed APK
smoke build and says so.

| Secret | Needed for | Source |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | a release-signed artifact | base64 of the upload keystore |
| `ANDROID_KEYSTORE_PASSWORD` | same | keystore credentials |
| `ANDROID_KEY_ALIAS` | same | `kangentic-upload` |
| `ANDROID_KEY_PASSWORD` | same | keystore credentials |
| `GOOGLE_SERVICES_JSON` | working remote push | base64 of the Firebase `google-services.json` |
| `PLAY_SERVICE_ACCOUNT_JSON` | submitting to Play | full JSON text of the `play-publisher` key |
| `IOS_DIST_CERT_BASE64` | a signed `.ipa` | base64 of the Apple Distribution `.p12` |
| `IOS_DIST_CERT_PASSWORD` | same | the `.p12` export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | same | base64 of the App Store `.mobileprovision`. Must carry the `com.kangentic.mobile.shared` Keychain group |
| `IOS_NSE_PROVISIONING_PROFILE_BASE64` | same | base64 of the App Store `.mobileprovision` for `com.kangentic.mobile.nse`, the Notification Service Extension. Must carry the same Keychain group |
| `ASC_API_KEY_BASE64` | uploading to App Store Connect | base64 of the `AuthKey_*.p8` |
| `ASC_KEY_ID` | same | the key's 10-character id |
| `ASC_ISSUER_ID` | same | the team's issuer UUID |
| `APPLE_ID` | fallback upload auth | the Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | same | generated at appleid.apple.com |
| `SENTRY_AUTH_TOKEN` | de-minified stack traces | a Sentry org auth token |

Plus one repository **variable**, `SENTRY_DSN` (crash reporting at runtime; from the Sentry
project's Client Keys page). It is a variable rather than a secret on purpose - it ships in the
published bundle, so it is not confidential, and a variable can be read back to verify which
project a build is wired to. Both are optional and gated together on a job-level `HAS_SENTRY`:
without both, the build ships with crash reporting inert and uploads no symbols, and says so in
the log. They are the only build-time env deliberately kept out of `eas.json` - see the Crash
reporting section for why.

The iOS secrets are optional in the same way: with none of them, dispatch with `target=simulator`
for the unsigned check. A `device` build fails immediately and says which secret is missing, rather
than degrading, because unlike Android there is no useful half-signed iOS artifact.

Nothing about the Apple team is committed. The team id, the profile UUID, and the bundle id are all
read out of the provisioning profile on the runner. That is not only tidiness: the team name on an
individual Apple Developer account is a person's legal name, which
`.claude/rules/no-personal-info.md` forbids in a public repo, and the EAS-issued profile name embeds
a timestamp that changes every time the profile is reissued, so a literal would rot as well as leak.

There is no `EXPO_TOKEN` and no Expo robot user. CI holds no Expo credential at all.

GitHub secrets are write-only once set. Keep a copy of every value somewhere durable outside
GitHub, or losing the maintainer machine means losing them permanently.

**Submitting is gated three ways** and never happens by accident: `submit_track` defaults to
`none`; the submit job is bound to the `google-play` GitHub Environment, which requires a
reviewer's approval; and the job refuses an artifact that is not signed with the upload key.
Before it uploads, `scripts/checkPlayVersionCode.mjs` asks the Play Developer API whether the
version code is already spent and fails fast if it is.

**Signing is verified, not assumed.** After Gradle finishes, the workflow runs `apksigner verify`
(APK) or `jarsigner -verify` (AAB) and fails if the artifact carries the Android debug key or no
signature. A green build that quietly produced an unsignable artifact is the expensive failure
mode, because Play only rejects it after a human has spent the upload.

**Triggering an iOS build.** Actions -> Build iOS -> Run workflow, or
`gh workflow run build-ios.yml -f target=device -f submit=testflight`. Two inputs:

| Input | Meaning |
|---|---|
| `target` | `simulator` (default) is the unsigned compile check, needs no secrets. `device` archives, signs, and exports an `.ipa`. `both` runs the two jobs in parallel. |
| `submit` | `none` (default) keeps the `.ipa` as a run artifact. `testflight` uploads it to App Store Connect. |

The two build jobs are deliberately independent rather than one matrix. The simulator check needs no
Apple account, so it is the only iOS signal available when a certificate has expired or a profile has
been revoked, and a signing problem must not be able to take it down too.

**The upload is a third job behind an approval gate**, mirroring the Play submit path:
`submit-testflight` is bound to the `app-store-connect` GitHub Environment, which requires a
reviewer, and it re-verifies the `.ipa` it downloads rather than trusting the build job. Splitting it
also makes an Apple-side failure cheap: re-running that one job retries the upload against the
already-verified artifact, with no rebuild and no new build number.

If that environment is ever deleted, **recreate it with a required reviewer before dispatching**.
GitHub silently auto-creates a missing environment with no protection rules, which would turn the
gate into a no-op without any error.

**The signed path never touches Expo, and that is the point.** `eas submit` uploads through Expo's
own servers, so an EAS Submit outage blocks a release even when Apple is healthy. That is not
hypothetical: on 2026-07-26 this project's first iOS submission attempt failed with EAS Build
reporting operational and EAS Submit degraded. `.github/scripts/upload-ios-testflight.sh` calls
`xcrun altool` from the runner, straight to Apple's delivery endpoints.

**Two upload auth mechanisms, and the fallback is the interesting one.** An App Store Connect API
key (`.p8` plus key id and issuer id, signed as an ES256 JWT) is preferred: non-interactive,
revocable, no expiring session. But minting one requires App Store Connect's Users and Access page,
which is exactly the surface that goes down during an ASC incident. An app-specific password comes
from appleid.apple.com, a different service, so it stays available when ASC does not. The script
prefers the API key and falls back to the Apple ID automatically, and refuses to retry an
authentication failure, which never fixes itself.

**Signing is verified, not assumed** - the same rule as Android, for the same reason.
`.github/scripts/verify-ios-signature.sh` unzips the `.ipa` and fails unless all of the following
hold: `embedded.mobileprovision` is present, `codesign --verify --deep --strict` passes, the signing
authority is an **Apple Distribution** certificate, `get-task-allow` is not true, the
`application-identifier` and `Info.plist` bundle id both match, and `aps-environment` is
`production`.

That last one is not paranoia. Remote push is the reason this app has an iOS build, and an app
signed without the push entitlement installs, launches, and silently never receives a notification -
a failure a tester would report as "the app is broken" with nothing in any log. It is fatal here
rather than a warning.

**Why the archive is signed rather than exported-then-signed.** Passing manual signing settings on
the `xcodebuild` command line applies them to every target including CocoaPods ones, which is the
classic source of "target does not support provisioning profiles". The usual dodge is to archive
unsigned and let `-exportArchive` do all the signing. This workflow does not, because an unsigned
archive carries no `archived-expanded-entitlements.xcent`, and the re-sign at export can then
silently drop custom entitlements - including `aps-environment`. A loud archive failure beats a
silent one. The Notification Service Extension has since landed and is handled: it has its own
App ID and profile, `withIosManualSigning` signs its target from `KANGENTIC_IOS_NSE_PROFILE_UUID`,
and its bundle id is in the `provisioningProfiles` dict in
`.github/scripts/export-ios-ipa.sh`. If that error appears for a NEW target, make the same two
additions. Do not fix it by archiving unsigned.

**The extension needs Apple-portal work that no amount of CI can substitute for.** Before a
device build can succeed there must be an App ID for `com.kangentic.mobile.nse`, a Keychain
Sharing group `com.kangentic.mobile.shared` on **both** App IDs, and regenerated distribution
profiles for both. `install-ios-signing.sh` fails the build with a named remediation if either
profile lacks the group, because the alternative is the worst failure mode this feature has: the
extension runs, the Keychain read returns nothing, and every notification shows the generic
placeholder, which looks exactly like an extension that was never installed.

**Build number preflight.** `scripts/checkAppStoreBuild.mjs` asks App Store Connect whether
`ios.buildNumber` is already used and fails before the archive starts, so a duplicate costs seconds
instead of a whole build followed by a rejection. It resolves the numeric app id from the bundle id
so nobody has to look it up, and it is skipped with a warning when no ASC API key is set.

**It has a blind spot, and the wording reflects that.** A build that has not registered is invisible
to the API, so the script reports what it checked ("no registered build uses this number") rather than
a verdict.

An earlier version of this section explained that absence as slow ingestion. **That was wrong, and
the correction is the most important thing in this section.** Builds 1 and 2 were not slow, they were
**rejected**: both uploaded successfully and were then refused in processing for ITMS-90683 (a missing
`NSPhotoLibraryUsageDescription`). A build Apple refuses does not appear as `INVALID` in the API; it
simply never becomes a Build resource at all. `/v1/builds` returned zero two hours later, which reads
identically to "still processing".

**So `UPLOAD SUCCEEDED` is not delivery.** There is a processing stage after the upload that can
refuse the binary, it reports only by email, and nothing in the pipeline could see it: `altool
--validate-app` passed, the upload reported success, and the submit job went green over a binary Apple
threw away. That is why `submit-testflight` now runs `checkAppStoreBuild.mjs --await-processing`, which
polls for the build and **fails when it never registers** rather than treating the silence as
patience. If a genuinely slow build ever trips it, the fix is a longer `--timeout-minutes`; the
opposite error is a green release over nothing.

**A rejected build number is spent.** Apple requires the next upload to use a higher one, exactly as
for a released build, so 1 and 2 are both gone.

The authority is the upload, not the preflight: altool rejects a duplicate and
`.github/scripts/upload-ios-testflight.sh` fails on that rejection. Which is worth stating because the
first version of that script did **not**: it treated Apple's `The bundle version must be higher`
rejection as success, alongside the "already exists" messages that genuinely do mean our binary
landed. Those two look similar and mean opposite things. The lenient branch is now gated on
`GITHUB_RUN_ATTEMPT > 1`, since only the attempt number distinguishes "our own retry" from "someone
else's binary holds that version", and `tests/unit/iosTestflightUpload.test.ts` runs the real script
against a stubbed `xcrun` to assert the exit codes.

**Signing is set on the app target, not on the xcodebuild command line.** Command-line build
settings apply to every target in the workspace, and a target that produces no signed bundle rejects
a provisioning profile outright. The first signed archive died on exactly that, on a **Swift Package**
target (`RaTeX_RaTeX`), not a CocoaPods one. Exempting offending targets by name is whack-a-mole
since the dependency graph decides how many there are, so `plugins/withIosManualSigning.ts` writes
the four properties into the app target's build settings during prebuild instead.

Two consequences worth knowing before touching that plugin:

- **Its `KANGENTIC_IOS_*` variables must be exported before `expo prebuild`**, not merely before the
  archive. A config plugin runs during prebuild and `GITHUB_ENV` only affects later steps, so
  exporting late leaves the project on automatic signing with nothing in the log to say so. Same trap
  as the `eas.json` env export on Android, and locked by the same kind of test. A
  `-showBuildSettings` step asserts the target really is on manual signing before the archive.
- **`tsc` cannot check the plugin's pbxproj call.** The `xcode` package ships no type declarations,
  so `XcodeProject` degrades to `any`. `tests/unit/iosManualSigning.test.ts` pins the argument shape
  instead, and the plugin declares a local interface for the one method it uses. There is also no way
  to run `expo prebuild --platform ios` on Windows to check it by hand.

**Measured build time: about 11 minutes**, which is faster than the Android release build, and not
where you would guess:

| Step | Time |
|---|---|
| Node + dependency cache restore | 20s |
| Certificate and profile install | 1s |
| `expo prebuild --platform ios` | 2s |
| `pod install` (cold CocoaPods cache) | 46s |
| Resolve workspace and scheme | 19s |
| **`xcodebuild archive`** | **8m 23s** |
| `-exportArchive` | 6s |
| Signature verification | 1s |
| Artifact upload (21 MB) | 2s |

So the archive is 76% of the run and everything else is noise. The CocoaPods cache was a miss on this
first run and will not be again, but at 46s it was never the lever. If iOS build time ever needs
attacking, it is the archive or nothing.

## Testing

Three tiers exist today, chosen for the fastest tier that proves the behavior. A fourth is
planned:

| Tier | Location | Runner | Scope |
|------|----------|--------|-------|
| Unit | `tests/unit/` | vitest | Pure TypeScript logic, no RN runtime |
| Component | `tests/components/` | Jest + React Native Testing Library v13+ | Screens and components, native modules mocked |
| E2E | `.maestro/` | Maestro | Full flows against a real build. `smoke.yaml` gates every PR; `paired/` also runs every PR (advisory) and locally |
| Web (NOT YET PRESENT) | `tests/web/` | Playwright via react-native-web | Cross-platform component behavior. The directory does not exist yet |

Commands: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:components`.

**There is no single command that runs every Maestro flow, and `maestro test .maestro/` is not
one.** A bare `.maestro/` root sweeps in `.maestro/setup/pairing-bootstrap.yaml`, which is a rig
fixture rather than a test: it needs a `PAIRING_URI` handed to it, so it fails for lacking one and,
per its own header, "reads as a broken pairing screen rather than a misconfigured workflow". It
would also run the 11 paired flows with no relay and no stub up. `tests/unit/ciSafeMaestroFlows.test.ts`
fails CI if a workflow ever points at the bare root, for the same reason. Run one suite at a time:

| Suite | Command | Setup needed |
|---|---|---|
| smoke | `maestro --device <serial> test .maestro/smoke.yaml` | A fresh, unpaired install. Nothing else |
| paired | `maestro --device <serial> test .maestro/paired` | A relay plus `scripts/stubDesktopPeer.mjs`, and a completed pairing. Use `/e2e`, which sequences it |

`npm run typecheck` runs `scripts/checkInstallDrift.mjs` first through a `pretypecheck` hook (also
available alone as `npm run check:install`). It fails fast when this checkout resolves
`@kangentic/protocol` out of ANOTHER checkout's `node_modules` - every worktree lives inside the
main one, so Node walks up and finds it - or at a version outside the declared range. That drift
presents as a wall of "has no exported member" errors in files nobody touched, and the obvious way
to check them (stash, re-run, "identical before and after, so pre-existing") confirms the wrong
answer, because both runs resolve the same stale package. The fix is `npm install`.

**Where each tier runs.** Unit and component run on every PR from `ci.yml`: unit as one unsharded
job, component split across two shards behind a thin gate. Android E2E
runs on every PR from `e2e.yml`: it builds a signed `e2e` APK and drives it on an emulator. Maestro
also runs natively on Windows against a local emulator, which is the right loop while implementing
a change (see the stage-ownership note in `CLAUDE.md` for why local E2E is deliberately *not* a
pre-PR gate).

**`E2E Tests (Maestro)` (the required check) only reflects `smoke.yaml`.** The 11 paired flows run in
CI too, in the separate `maestro-paired` job, but that job is advisory (see "Two E2E suites, two
jobs, one required" above) until it has been green across several PRs. A green required check is
smoke coverage; read the `E2E Tests (Paired)` check separately for the paired suite's result. It
carries no "Required" badge, which is how the checks list says it cannot block a merge.

**Maestro now runs on iOS in CI, but there is no iOS E2E *suite*.** An earlier version of this
section claimed EAS Workflows on cloud iOS simulators was "the only supported path to iOS E2E
without a Mac". That was never true in practice: there is no `.eas/workflows/` directory in this
repo on any branch, so nothing was ever wired. The route it dismissed is the one that works:
`build-ios.yml -f screenshots=true` boots a simulator on a free `macos-latest` runner with
`xcrun simctl` and drives `.maestro/screenshots/store-capture.yaml` through six screens by testID,
with no Apple Developer account and no EAS spend. That is how the WKWebView terminal was finally
executed on iOS, and it renders.

Be precise about what that does and does not buy. It is a **capture** flow: it navigates and
photographs, and the job fails when an expected shot is missing, so it catches a screen that will
not open at all. It asserts almost nothing about behaviour, and it cannot see anything drawn
inside the terminal's canvas (see the blank-terminal note in
`.claude/skills/store-screenshots/SKILL.md`). Treat it as proof the app runs on iOS and as the
existing harness to grow a real suite from, not as coverage.

### Running the E2E suite (the path that actually works)

**Drive Maestro through the CLI, not the MCP server.** The MCP server starts its own
`simulator-server` alongside whatever the rig and the CLI are already doing, and when those
collide it stops responding: observed hanging for over two minutes on calls as trivial as
`cheat_sheet` and `take_screenshot`, while the same work through `maestro test` returned in
seconds. Use the MCP server for authoring help (`inspect_screen` on a quiet device) and the CLI
to run anything.

**One rig, one mode.** `dev:live` and `dev:stub` both own Metro on 8081, so starting one kills
the other's bundler out from under the device. Pick the mode for the job and stay in it.

**Testing against a DEV CLIENT costs three workarounds**, all of them consequences of the dev
client rather than of our app:

1. `adb shell pm clear` wipes the saved Metro bundle URL along with the app data, so the next
   launch lands on the dev launcher and no JS loads. Re-point it first (the rig's
   `pointDevClientAtMetro`). For the same reason `launchApp: clearState: true` - the form the
   Maestro docs otherwise recommend - is wrong here: it would undo that re-pointing.
2. The dev client's first-run sheet is a separate window covering the whole screen. While it is
   up the app's view tree is absent from the hierarchy entirely, so no `testID` of ours resolves
   however visible the screen looks. It has to be dismissed first, and its "Continue" only
   dismisses the explainer - the dev menu proper opens behind it and needs closing too.
3. Metro has to be up for any of it.

**The `e2e` build profile removes all three.** Maestro's guidance is to test the final bundled
binary, and `eas.json`'s `e2e` profile builds exactly that: release-shaped, internal
distribution, APK, with `EXPO_PUBLIC_KANGENTIC_E2E=1`. That flag is the second gate on the
`ws://10.0.2.2` carve-out in `src/pairing/qr.ts` (see `docs/security.md`), so the binary can
still reach a local rig relay even though `__DEV__` is false. No dev menu, no Metro, no bundle
URL to lose:

```
eas build --profile e2e --platform android
maestro --device <serial> test .maestro/paired
```

Use the dev client only when you need Fast Refresh while writing a flow.

### Local Android builds work from any path

A local Android build runs from a normal `.kangentic/worktrees/<branch>/` checkout. It did not
until `plugins/withAndroidCmakeBuildStaging.ts` landed, and every recipe in this repo used to
route around it via a separate short-path checkout at the drive root. That workaround is gone.
**Do not recreate it:** if a build hits MAX_PATH, the plugin is not applying, and the fix is the
plugin.

```
npm install
npx expo prebuild --platform android --no-install
cd android
.\gradlew.bat app:assembleDebug -x lint -x test "-PreactNativeArchitectures=arm64-v8a,x86_64"
```

Swap `assembleDebug` for `assembleRelease` (with `EXPO_PUBLIC_KANGENTIC_E2E=1`) to produce the
`e2e` APK. For a dev client, `npx expo run:android` does the whole thing.

**Both ABIs, and the quotes, are deliberate.** The `kangentic_pixel` AVD is x86_64, so an
arm64-only APK installs with `Success` and then fails to render with nothing in logcat - drop
`x86_64` and the `e2e` APK you just built cannot run the Maestro suite. Trim the list only when
you know the target. See "Pass `-PreactNativeArchitectures`" below.

**If you already have an `android/` directory from before this landed, prebuild once.** The fix
is written into `android/settings.gradle` at prebuild time, and **`expo run:android` only
prebuilds when `android/` is missing** (it returns early otherwise, see `ensureNativeProject.js`).
So a stale native directory silently keeps the old behaviour and the build fails exactly as it
used to, with an error that names no file. One plain prebuild fixes it, no `--clean` required:

```
npx expo prebuild --platform android --no-install
```

Deleting `android/` works too. This is a one-time step per checkout, not something to repeat.

#### What was actually wrong

Worth reading before touching the plugin, because the cause was misdiagnosed for months and the
docs you may remember named the wrong modules. There are **two** failures, both MAX_PATH, and the
second is invisible until the first is cleared.

**1. Ninja stats the prefab config through a `..`.** The file exists, but ninja resolves it
relative to the build directory and Windows applies MAX_PATH to the composed string *before*
collapsing the `..`:

```
ninja explain: output ../prefab/arm64-v8a/prefab/lib/aarch64-linux-android/cmake/
               react-native-worklets/react-native-workletsConfigVersion.cmake
               of phony edge with no inputs doesn't exist
```

The stat fails, ninja re-runs CMake, CMake regenerates identically, and it ends at
`ninja: error: manifest 'build.ninja' still dirty after 100 tries`, **naming nothing**. The
binding module is `react-native-reanimated`, through the `react-native-worklets` prefab package
(a 121-character relative path, against 96 for `ReactAndroid`).

**2. CMake abandons hashing and emits the full mangled name.** CMake hashes leading path
components when an object path exceeds `CMAKE_OBJECT_PATH_MAX` (default 250), but when even its
fully hashed floor exceeds that, it gives up and emits the unshortened name:

```
ninja: error: Stat(EnrichedMarkdownTextSpec_autolinked_build/CMakeFiles/
react_codegen_EnrichedMarkdownTextSpec.dir/C_/Users/.../ComponentDescriptors.cpp.o):
Filename longer than 260 characters
```

Setting the limit to **259** (the real ceiling: MAX_PATH counts the terminating NUL) lets the
floor through. **Raising it to 1000 is exactly backwards** and was tested: that tells CMake never
to shorten, warnings went 402 to 0, and the build failed identically.

**Two corrections to what this section used to say.** It blamed `react-native-screens` and
`react-native-worklets`; both build fine at 73 characters, and the binding modules are
`react-native-reanimated` and `expo-modules-core`. It also claimed object paths "drop to roughly
108 characters" at a short root; the measured longest at a 5-character root was **248**.

**Enabling Windows long paths does not help and is not worth trying.** `ninja.exe` carries no
embedded manifest at all, and neither it nor `cmake.exe` declares `longPathAware`, so
`LongPathsEnabled` is inert for this toolchain.

#### How the fix works

`withAndroidCmakeBuildStaging.ts` appends a block to `android/settings.gradle` that, on Windows
only, points every module's CMake staging directory (AGP's `.cxx`) at
`%SystemDrive%\kangentic\android\<checkout-hash>\<module>` and passes
`-DCMAKE_OBJECT_PATH_MAX=259`. Relocating the output removes checkout depth from the equation
entirely, which is why it works at **any** path length rather than buying a fixed number of
characters.

Three things about the shape of it that are easy to get wrong:

- **It has to be `gradle.beforeProject`, not a root `subprojects {}` block.** AGP reads
  `buildStagingDirectory` during each module's own evaluation, so a root block throws
  `It is too late to set buildStagingDirectory`, and it never reaches `:app` at all.
- **The Windows gate lives in the Groovy, not in the TypeScript.** That keeps prebuild output
  identical on every platform, which is what lets `ci.yml`'s Native config job prove the block
  landed by prebuilding on Linux. A `process.platform` gate would leave CI able to verify only
  the no-op.
- **The hash keys the directory per checkout**, so parallel Kangentic worktrees never write the
  same object files.

Override the root with `KANGENTIC_CMAKE_STAGING_ROOT` if the default will not do.

**The measured budget, because it is spendable.** CMake's hash floor is what binds, not the
emitted path: measured across the 646 object files of a proven build, the worst floor at a
15-character prefix is **214** against the 259 cap, and it grows one-for-one with the staging
prefix. The shipped 21-character prefix leaves roughly 30 characters of headroom for a debug
build and **21 for a release one** (`RelWithDebInfo` is 9 longer than `Debug`).
`tests/unit/androidCmakeBuildStaging.test.ts` pins that budget so a later rename cannot quietly
spend it. `%LOCALAPPDATA%` was rejected on this measurement: it costs 37 more characters, putting
a release floor at 260, and its length varies with the user's name.

#### The cost: staging outlives the project directory

Output now escapes both `gradlew clean` and the checkout, and Kangentic mints a new hash per
branch, so the root grows one large tree per branch:

```
npm run clean:staging      # prune trees whose checkout is gone
npm run verify:staging     # prove the flag reached CMake on the last build
```

`verify:staging` is the only check that proves the flag reached **CMake** rather than merely
reaching `settings.gradle`, and it fails loudly rather than passing when it finds no files at
all. It checks only the trees belonging to the checkout you run it from, because the root is
shared: a sibling branch last built before the flag existed would otherwise fail your correct
build and name a file you have never seen.

Both commands identify a tree's checkout from the `-DPROJECT_ROOT_DIR` that AGP already records.
Two details there are load-bearing. They scan **every** module's
`metadata_generation_command.txt` rather than the first, because only the `app` module records
that flag at all - library modules configure through their own CMakeLists and record nothing, so
reading just the first file worked only as long as `app` sorted first in directory order. And
they check `<checkout>/package.json` rather than the recorded `<checkout>/android` path, because
`android/` is a gitignored artifact that `expo prebuild --clean` removes from a perfectly live
checkout. A tree whose checkout cannot be identified is kept, never deleted.

#### Give the worktree its own node_modules

**Treat a dev client as bound to the tree that built it**, and note that a worktree here starts
with `node_modules` as a **junction to the main checkout**. Node realpaths it, so a build through
the junction compiles against the main checkout's dependency tree, at the main checkout's path,
whatever branch it happens to be on. Run `npm install` in the worktree to materialise a real tree
before building. The APK's compiled native libs must match the JS Metro serves, and different
worktrees of this repo routinely resolve different `react-native` / `react-native-worklets` /
`react-native-reanimated` versions. The mismatch does NOT announce itself: the app launches, runs
a few seconds, and dies with a native `SIGABRT` inside `libworklets.so` on a JSI assertion
(`String facebook::jsi::Value::getString(...): assertion "isString()" failed`) with no JS error,
no red box, and nothing in `ReactNativeJS` logcat. It reads exactly like an app bug in whatever
you last edited.

The tell is in the abort message, which names the react-native the APK was compiled against:

```
adb logcat -d -t 800 -s DEBUG:* libc:* AndroidRuntime:*
# Abort message: '.../react-android-0.86.0-debug/prefab/modules/jsi/include/jsi/jsi.h:1987: ...'
```

Compare that against `node_modules/react-native/package.json` in the worktree serving Metro. This
bites hardest right after an `npm install` in a worktree whose `node_modules` was previously a
junction to the main checkout's: the install materialises a real tree at the versions
`package.json` actually pins, and a dev client built elsewhere is instantly stale. Rebuild rather
than trying to reconcile it from the JS side.

**Pass `-PreactNativeArchitectures`, and pick the ABIs deliberately.** A raw `gradlew` builds all
four, which is slow and was previously recorded as failing outright for 32-bit `armeabi-v7a`.
`expo run:android` passes this flag for you; a direct gradle call does not.

Use `"-PreactNativeArchitectures=arm64-v8a,x86_64"` (quote it in PowerShell, or the comma splits
the argument). A physical Pixel is **arm64-v8a**; the `kangentic_pixel` AVD is **x86_64**. An
arm64-only APK still reports `Success` when installed on the emulator and then fails to render,
with no crash in logcat - Maestro just reports the first `testID` missing. Confirm with
`adb -s <serial> shell dumpsys package com.kangentic.mobile`, which prints `primaryCpuAbi`.

> **Unverified since the staging fix:** the `armeabi-v7a` failure was attributed to the Windows
> path-length problem, on the evidence that the first unrestricted CI run on Linux built all four
> ABIs cleanly. If that attribution was right, the failure should be gone now, and the two
> consequences drawn from it below (keep the flag locally; never ship a locally built Windows AAB
> past the internal track) may no longer hold. Nobody has re-tested it, because every build since
> has passed the flag. Settling it costs one unrestricted four-ABI build. Until someone does,
> keep the flag and keep the shipping restriction.

**Why a run takes minutes:** every flow begins with `launchApp`, which force-stops and cold
boots, and then waits up to 60s for the channel to re-establish - roughly 70s of the runtime of
a flow whose actual assertions take seconds. `launchApp: stopApp: false` brings the backgrounded
app forward instead, keeping the channel up, at the cost of each flow having to navigate itself
to a known screen rather than relying on a fresh launch.

See `CLAUDE.md`'s Testing section for the scoped-run discipline (what to run while actively
working on a task vs. the full gate).

## iOS without a Mac

Every iOS build for this project happens on a GitHub-hosted macOS runner. There is no Mac in the
loop and no local iOS toolchain; day-to-day development happens on the Android emulator.

`.github/workflows/build-ios.yml` does both jobs (see the CI builds section for the inputs, the
secrets, and what is verified):

- `target=simulator` compiles unsigned for the simulator. No Apple Developer Program membership, no
  certificates, no secrets. The cheapest way to find out whether the iOS native tree still builds,
  and it produces nothing installable.
- `target=device` archives, signs, exports an `.ipa`, and optionally uploads it to App Store Connect.
  Needs the $99/yr Apple Developer Program and the five iOS secrets.

**Credentials were provisioned through EAS, then exported.** `eas credentials` is a genuinely good
interactive tool for the one-time work: registering the bundle identifier, creating the distribution
certificate, generating the provisioning profile, and minting the APNs key. That work was done once,
the resulting `.p12` and `.mobileprovision` were exported to `~/kangentic-secrets/apple/` and set as
GitHub secrets, and the build path is now Expo-free. Using EAS to obtain credentials is not the same
as depending on EAS to build with them.

`eas build --platform ios` still works from Windows and remains the fallback if the runner path ever
breaks. It costs one of the 15 free monthly iOS cloud builds and enters a low-priority queue that
can take hours, which is precisely why it is the fallback and not the path.

`cli.appVersionSource: "local"` is a CLI-wide setting, not an Android-only one, so `ios.buildNumber`
in `app.config.ts` is hand-bumped for the same reason `android.versionCode` is. App Store Connect
rejects a build number it has already seen, so bump it before every upload;
`scripts/checkAppStoreBuild.mjs` checks this before the archive rather than after.

## Android release and Google Play Console

Android release builds are off EAS cloud builds, so signing and versioning are handled by us
rather than by EAS. **The normal path is the `build-android.yml` workflow** (see CI builds); the
manual procedure below is the fallback for when you need a bundle without a runner.

- **`cli.appVersionSource: "local"`** in `eas.json` (not `"remote"`). `android.versionCode` in
  `app.config.ts` is a hand-bumped, code-reviewed integer, not a value EAS tracks server-side.
  Bump it before every Play upload; it must exceed whatever is currently live on the internal
  track. **Enforcement:** `tests/unit/appConfigBrand.test.ts` checks the value is a positive
  integer, and `scripts/checkPlayVersionCode.mjs` (run by the workflow's submit job) asks the Play
  Developer API whether the code is already spent and fails the submit if it is. Nothing can check
  this from a dev box offline, because the answer lives in Play Console.
- **Upload keystore.** A dedicated `kangentic-upload.jks` keystore (PKCS12 format) lives in a directory outside
  the repo (never committed - `.gitignore` also backstops `secrets/` and `*service-account*.json`
  in case a download lands in the wrong place). Treat `secrets/` as the real backstop and always
  move a freshly downloaded credential into it: Google Cloud names service-account keys
  `<project>-<hash>.json`, which the `*service-account*.json` glob does not match unless you
  rename the file. Losing the keystore means a Play support keystore-reset
  round-trip, so back it up outside the repo too. It is intentionally separate from any
  EAS-managed Android credentials: the `development` and `preview` dev-client builds are signed
  differently, so a device with one of those installed must uninstall it before installing a
  Play-internal-track build, or the install fails with a signature mismatch.
- **Building a signed release bundle.** `android/` is a gitignored CNG artifact; never hand-edit
  `android/app/build.gradle` to reference the keystore, and never patch the generated tree to get
  a failing build to pass. Fix `app.config.ts` or a config plugin and regenerate instead.
  Regenerate first, because a stale `android/` ships whatever `versionCode` it was generated with,
  not the one you just bumped:

  ```
  npx expo prebuild --platform android
  ```

  Then pass signing details as injected Gradle properties, which override the generated project
  without touching it (run from `android/`, where the generated `gradlew` wrapper lives):

  ```
  cd android
  gradlew :app:bundleRelease -PreactNativeArchitectures=arm64-v8a -Pandroid.injected.signing.store.file=<path to kangentic-upload.jks> -Pandroid.injected.signing.store.password=<password> -Pandroid.injected.signing.key.alias=kangentic-upload -Pandroid.injected.signing.key.password=<password>
  ```

  `-PreactNativeArchitectures=arm64-v8a` is a **Windows-only workaround**, and it is now known to
  be exactly that. An unscoped `gradlew` build compiles all four ABIs and fails on 32-bit
  `armeabi-v7a` on Windows, but the first unrestricted CI run on Linux built every ABI cleanly:
  `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, verified by inspecting `lib/` inside the artifact.
  So the failure was a symptom of the Windows path-length problem, not a real ABI constraint.

  Two consequences. Keep the flag for a local Windows build, where the failure is real. And do
  **not** ship a locally built Windows AAB past the internal track: it carries arm64-v8a code
  only, so 32-bit ARM and x86/x86_64 devices (older phones, Chromebooks, x86 emulators) cannot
  install it. A CI-built bundle has no such limitation, which is the supported path for any track
  beyond internal.

  Checkout path no longer matters (see "Local Android builds work from any path"). Passing
  passwords inline leaks them to shell history; prefer a user-level `gradle.properties` outside
  the repo, or `ORG_GRADLE_PROJECT_*` environment variables, for anything beyond a one-off build.
- **Submitting.** The normal path is the `build-android.yml` workflow's `submit_track` input,
  which uploads through the Play Developer API and holds behind the `google-play` environment's
  approval gate. For a manual submit from a dev box, `eas.json`'s `submit.production.android` sets
  `track: "internal"` and `releaseStatus: "completed"` but deliberately carries no
  `serviceAccountKeyPath`, because that path is machine-specific and the key must never be
  committed. Submit a locally built bundle with `eas submit --platform android --path <local .aab>`;
  `--path` names the bundle, not the key. That route authenticates to Expo; the workflow does not.
- **First upload is manual.** The Google Play Developer API (what `eas submit` and the workflow's
  submit job both call) only works once an app has at least one release; the very first AAB for a
  new package name has to go through the Play Console UI by hand. Do that one-off before using the
  submit job, so the workflow's first real run is not also the app's first-ever release.
- **Play Console service account.** A dedicated `play-publisher` service account (no GCP IAM
  roles) is granted app-scoped **View app information** and **Manage testing track releases**
  permissions in Play Console -> API access. Permission changes there can take up to 24 hours to
  propagate.
- See [docs/privacy-policy.md](privacy-policy.md) and [docs/store-listing.md](store-listing.md)
  for the store-facing text already prepared.

## Firebase and remote push

`app.config.ts` only sets `android.googleServicesFile` when `google-services.json` exists at the
repo root. The file is gitignored, so a build without it succeeds and simply ships with remote
push inert. That is deliberate: a missing Firebase config must never break a build.

To wire it up:

1. Create (or open) the Firebase project. It can attach to the existing `kangentic-mobile` Google
   Cloud project, which is where the `play-publisher` service account already lives.
2. Add an Android app with package name **`com.kangentic.mobile`**, matching `app.config.ts`.
3. Download `google-services.json` and drop it at the repo root. It stays gitignored.
4. For CI, store it base64-encoded as the `GOOGLE_SERVICES_JSON` GitHub secret:

   ```
   base64 -w 0 google-services.json
   ```

   On Windows PowerShell:

   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))
   ```

Delivering a push additionally needs the FCM V1 service-account key uploaded to the Expo project's
Android push credentials, because the app sends through Expo Push rather than talking to FCM
directly (see "Expo is in the delivery path" in [docs/security.md](security.md) for why, and what
Expo can and cannot see). Generate the key from the Firebase Admin SDK service account:

```
gcloud iam service-accounts keys create <output.json> --iam-account=firebase-adminsdk-fbsvc@kangentic-b43ff.iam.gserviceaccount.com --project kangentic-b43ff
```

Then register it with Expo. Use the CLI, not the dashboard:

```
eas credentials --platform android
```

and take this exact path, which is not obvious:

1. build profile: any (`production` is fine). The credential attaches to the application
   identifier, not the profile.
2. **Google Service Account** - *not* "Push Notifications (Legacy)", which manages the deprecated
   FCM legacy API key that Google is switching off.
3. **Manage your Google Service Account Key for Push Notifications (FCM V1)** - *not* the "for
   Play Store Submissions" entry directly above it. Same key type, different purpose.
4. **Set up a Google Service Account Key for Push Notifications (FCM V1)**, then give it the
   absolute path to the JSON.

Expect `Google Service Account Key assigned to com.kangentic.mobile for FCM V1`.

**Do not use the dashboard's "New Application Identifier" wizard for this.** It is the EAS Build
credentials flow, it hard-requires uploading an Android upload keystore ("You must upload a
keystore file"), and there is no skip. We do not build on EAS, so uploading `kangentic-upload.jks`
there would put a second copy of the Play signing key in a third party for no benefit. The CLI path
above reaches the FCM slot without touching the keystore, which is why it is the documented route.

Two service accounts stay deliberately separate: `firebase-adminsdk-fbsvc@kangentic-b43ff` is the
FCM V1 key held by Expo for push, and `play-publisher@kangentic-mobile` is the narrower Play
publishing key held only as a GitHub secret, with no FCM rights. Do not consolidate them, even
though the `eas credentials` prompt mentions both uses in one sentence.

Expo Push itself is free: no per-notification charge, no paid plan requirement, and a rate limit
(around 600 notifications/second/project) far above anything this app will produce.

Until all of this exists, `build-android.yml` emits a warning on every run and the resulting
binary cannot receive remote notifications.

### Verifying a push landed (Android)

A push has TWO ways to look delivered and be broken, and neither shows up in the app: the OS can
draw the notification instead of us, or nothing can run at all. One logcat line separates them, so
check it before debugging anything else.

#### First, get the phone into a state where a push can arrive

Three device states produce no notification for three completely different reasons, and **two of
them are not bugs**. Getting this wrong invalidates every conclusion below, so settle it first.

- **Force-stopped: no push is delivered at all.** `adb shell am force-stop` puts the app in
  Android's *stopped state*, which excludes it from broadcasts, so FCM never reaches it. Observed
  directly - every delivery attempt logged
  `W/GCM: broadcast intent callback: result=CANCELLED for Intent { act=com.google.android.c2dm.intent.RECEIVE ... pkg=com.kangentic.mobile }`
  and nothing else happened. **A working push is indistinguishable from no push here**, which makes
  force-stop the most misleading possible way to test the killed-app path, and it is the obvious
  thing to reach for. Use `adb shell am kill com.kangentic.mobile` instead: it ends the process
  without setting the stopped flag. `am kill` spares a process holding a foreground service, so the
  connection keepalive has to be gone first; confirm with `adb shell pidof com.kangentic.mobile`.
  Launching the app once clears the stopped flag again.
- **Foregrounded: the task runs and deliberately posts nothing.** The receive task suppresses its
  display whenever the app is provably active, so logcat shows
  `Finished task 'kangentic-background-push'` with no `notification_enqueue` after it. That is the
  gate working, not a failure. Observed: nine task runs, zero notifications, because the app was
  open on screen.
- **Backgrounded with the channel still established: the DESKTOP never sends.** It suppresses
  remote push to any device with a live bridge session, and `localNotifier.ts` fires over the
  socket instead. A real remote push needs the channel down, which means waiting out the
  five-minute `BACKGROUND_KEEPALIVE_MAX_MS` ceiling. **Wait it out with the screen ON.** The
  ceiling's timer half rides a Choreographer frame callback, and the wall-clock half only fires
  on a wake source that reaches JS - the desktop's ~2 minute rekey, or a transport state change.
  On a dark, idle phone the teardown can take the ceiling plus a rekey interval.

**Checking the foreground service directly**, which is the one reading that does not depend on
what JS believes: `adb shell dumpsys activity services com.kangentic.mobile`. It reports the
native service state, so it is how you tell "the ceiling fired" from "the ceiling fired and the
service survived it" - the distinction MOBILE-3 turned on. Pair it with `adb shell pidof
com.kangentic.mobile`: a process still alive well past the ceiling is the symptom. Note a phone on
USB never enters Doze, so use wireless adb (`adb tcpip 5555`, `adb connect`) for anything that has
to reproduce a genuinely idle device.

The state you want is: launched at least once since any force-stop, then backgrounded or killed
with `am kill`, with no established channel.

#### Then read the tag

`notification_enqueue` is an Android **EventLog** tag, so it is written to the `events` buffer, not
the default main/system/crash ones. Read it with the buffer named explicitly, or a working push
looks like no push at all:

```
adb logcat -b events
```

Use `-b all` to see it alongside the `TaskService` lines below in one stream. With the phone on USB
and that running, send a push and find the `notification_enqueue` event. **Read the notification
record's `tag` field** (the value in the event payload, not an `adb logcat -s` filter tag):

- **Tag `NULL`, with an integer id** - the app posted it through Notifee. This is the working path.
  The line that actually proves OUR task ran is
  `TaskService: Finished task 'kangentic-background-push' with eventId '<id>'.`
  (`expo-task-manager`'s `TaskService.java:213`). That is the one to grep for: it names the task, so
  it cannot be confused with any other headless work.

  Do not settle for the surrounding bracket. `TaskService: Started headless task <id> to keep JS
  timers alive for '<appScopeKey>'` and `Finished headless task <id> for '<appScopeKey>'`
  (`TaskService.java:663,704`) are the timer-keepalive pair, and neither carries a task name: they
  say a headless JS context started and stopped for this app, NOT that
  `kangentic-background-push` itself ran.
- **Tag `FCM-Notification:<number>`** - the FIREBASE SDK drew it, which means the message carried an
  FCM `android.notification` block, which means `onMessageReceived` was never called and our task
  never ran. The payload was silently dropped. The cause is on the DESKTOP send path: a `title`,
  `body`, or `channelId` on an Android message (see the notification pipeline in
  [architecture.md](architecture.md)).

This is exactly what a blank tray row is. A notification with no renderable content makes SystemUI
substitute the string "Expand to view", and expanding shows nothing, because there is nothing to
render. That string is not ours and greps to nothing in this repo, which is a good way to lose an
afternoon.

When a row looks empty, confirm what was actually posted:

```
adb shell dumpsys notification --noredact
```

Read `android.title`, `android.text`, `contentView`, `channelId`, and the record's `tag` for each
`NotificationRecord` belonging to `com.kangentic.mobile`. All-null title/text plus a
`FCM-Notification:*` tag is the failure above. Note FCM sets its own `timeout=PT72H`, so bad rows
linger for three days rather than clearing on their own.

Check which build you are actually looking at first - `adb shell dumpsys package com.kangentic.mobile`
for `versionName` / `versionCode` - because the notification stack's behaviour depends on the
`expo-notifications` version inside the APK, and a device on an older dependency tree invalidates
every conclusion above.

## Crash reporting (Sentry)

Like Firebase above, this is optional infrastructure that degrades to inert rather than breaking a
build. It is configured in exactly one place, `src/observability/crashReporting.ts`, and governed
by `.claude/rules/crash-reporting-scope.md`. **Investigating an arriving issue** goes through
`/sentry` (`.claude/skills/sentry/SKILL.md`), which retrieves and diagnoses issues from the
`mobile` project and can file a follow-up board task.

**Two secrets, two different jobs.** They are deliberately separate:

| Name | Kind | What it does | Absent means |
|---|---|---|---|
| `SENTRY_DSN` | repository **variable** | Exported to the bundle as `EXPO_PUBLIC_SENTRY_DSN`. Decides whether the app reports at runtime. | `Sentry.init()` is never called; the native SDK never starts; nothing is collected |
| `SENTRY_AUTH_TOKEN` | repository **secret** | Uploads source maps and debug symbols at build time, and is what makes `app.config.ts` include the Sentry config plugin at all. | The plugin entry is omitted, so if a DSN is set the reports still arrive, with every stack trace minified. With no DSN either, nothing is reported at all |

Both live on the GitHub repo, for the Sentry org `kangentic`, project `mobile`. **Neither
goes in `eas.json`**, which is the one deviation from "eas.json is the single source of truth for
build-time env": that file is committed to a public repo, and a DSN in it would route every
fork's crashes into this project's 5k/month quota. `build-android.yml` and `build-ios.yml` each
export them to `$GITHUB_ENV` *before* prebuild (the config plugin reads the token at
config-evaluation time), gated on a job-level `HAS_SENTRY` boolean that requires **both**.
`tests/unit/buildWorkflow.test.ts` locks that ordering.

**Four symbol paths, not one.** "Symbolication" is four independent mechanisms, and knowing which
one is broken saves re-deriving this from a stack trace. All four are gated on `SENTRY_AUTH_TOKEN`,
because without it the config plugin is omitted entirely.

| Frames | Mechanism | Wired by | Status |
|---|---|---|---|
| JavaScript, both platforms | Hermes source maps | `sentry.gradle` (Android) and an Xcode build phase (iOS) | working, round-trip verified |
| Android Java/Kotlin | R8 `mapping.txt` | the Sentry **Android Gradle Plugin**, enabled by `experimental_android.enableAndroidGradlePlugin` in `app.config.ts` | on; needed the moment R8 was enabled |
| Android native (`.so`) | NDK debug symbols | the same Gradle plugin, `uploadNativeSymbols` and `autoUploadNativeSymbols` | **deliberately off.** The defaults would upload every React Native `.so` on each dispatch build. Both properties flip together in `app.config.ts` if Android native symbolication is ever wanted |
| iOS native | dSYMs | the plugin's "Upload Debug Symbols to Sentry" Xcode phase | wired, and `build-ios.yml`'s `device` job asserts the Release configuration emits dSYMs (`DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`) so the phase cannot silently upload nothing. That runs on a `target=device` dispatch, not on a PR - `build-ios.yml` is dispatch-only by design. Not yet round-trip verified with a real iOS crash |

Only the second row is affected by R8. A common misreading is "R8 breaks Sentry"; it does not - it
renames the Java/Kotlin layer and nothing else, which is exactly what `mapping.txt` undoes.
`ci.yml` asserts the Gradle plugin is applied and that the generated block reads
`autoUploadProguardMapping = shouldSentryAutoUpload()`, because `withSentry.js` wraps that call in
a `try`/`catch` that only warns: a renamed option would leave prebuild green and silently stop
uploading mappings. Note the assertion matches the **enabled** form deliberately - the plugin
always writes the `autoUploadProguardMapping` line, with `false` as the value when the upload is
off, so grepping the property name alone would prove nothing.

**Why the DSN is a variable and not a secret.** A DSN is not confidential: it ships inside the
published app bundle, so anyone with the APK can read it, and Sentry displays it in plaintext in
the project's Client Keys page. It is write-only - it can submit an event and read nothing back.
Keeping it out of the repo is about fork quota and noise, not secrecy, and a variable achieves
that just as well while being **readable back** (`gh variable list --repo Kangentic/mobile`). A
secret cannot be read back, so a mistyped DSN would be undetectable: builds would report nowhere
and still look healthy. For the same reason the workflows mask the auth token in logs but
deliberately do not mask the DSN - a legible value lets a build log answer "which project did
this report to?".

Set them with:

```
gh variable set SENTRY_DSN --repo Kangentic/mobile
gh secret set SENTRY_AUTH_TOKEN --repo Kangentic/mobile
```

**Free tier, and why that shapes the config.** The plan is the free Developer tier: 5,000 errors
per month, 30-day retention, one seat. Nothing is sampled down, because at this app's volume
every error is worth having. Volume is controlled instead by not generating noise -
`ignoreErrors` drops expected transport churn (a phone loses its socket constantly), tracing and
session tracking are off, and Session Replay is absent. Two server-side backstops are worth
setting once in the Sentry UI and are not expressible in code:

1. **Spike Protection**, per project, so one user in a crash loop cannot drain the month.
2. A **per-key rate limit** on the Client Key (start around 500 events/hour).

**Testing it locally.** Put `EXPO_PUBLIC_SENTRY_DSN` in `.env` (gitignored) and rebuild. Events
land in the `development` environment, kept separate from `production` so dev noise does not
pollute real crash stats. Expect the frames to be unsymbolicated: without `SENTRY_AUTH_TOKEN`
also set, `app.config.ts` omits the Sentry plugin, so that build uploads no source map and every
frame shows the generic bundle name. That is the reporting path working, not a fault. Set both if
you specifically want to exercise symbolication. `sentry-cli` is not required for either; it is
only useful for manual source-map work, and `sentry-cli login` writes `~/.sentryclirc` outside
the repo.

**Verifying what a delivered crash report actually contains.** `Sentry.init()` options are a
claim, not an observation - a JS `beforeSend` cannot filter a native crash, so the only way to
know what sentry-cocoa / sentry-android actually send is to read a delivered event. Set
`EXPO_PUBLIC_KANGENTIC_CRASHTEST=1` (dispatch `build-android.yml` with `crash_test: true`, never
in `eas.json`) to reveal a "Crash reporting test" section in Settings with a JS-throw row and a
`Sentry.nativeCrash()` row, and to turn on the SDK's `debug: true` native logging. That native row
doubles as the R8 mapping test: `Sentry.nativeCrash()` reaches `RNSentryModuleImpl.crash()`, which
throws a **Java** `RuntimeException`, so its frames are precisely the ones `mapping.txt`
deobfuscates. A readable Java frame from a `preview` or `production` build is the only direct proof
the mapping upload works. The profile matters - `development` builds the debug variant, where R8
never ran, so a readable frame there proves nothing. A native crash
does not upload at crash time: sentry-android writes it to its outbox and flushes on the *next*
`Sentry.init()`, so relaunch the app and watch `adb logcat -s Sentry` across the relaunch, not
just the tap. You cannot dispatch a store-track build with this flag on: the `plan` job refuses a
run that sets both `crash_test` and a `submit_track`, and `submit-play` additionally will not run
for one. Dispatch them as two separate runs.

**What that verification actually found**, on a `preview`-profile (arm64-v8a, release-signed,
non-debuggable) install, cross-checked with `adb logcat`, mitmproxy on the same device, and the
delivered events read back through the Sentry MCP:

- On the JS-captured event: zero console, network/XHR, or unrecognized-category breadcrumbs; no
  `request`, `extra`, or `server_name`; no screenshot or view hierarchy; no `session` item in any
  envelope, checked across a cold launch, a background/foreground cycle, and the crash itself.
  The native path is different - see the next bullet.
- `environment` reads `production` on a `preview`-profile build, as designed.
- Stack frames arrive symbolicated - the source-map upload path works.
- The native path (`Sentry.nativeCrash()` - see the "not tested" note below for what this is and
  is not) DOES carry native auto-breadcrumbs and a per-install `user.id` that `beforeSend`
  cannot reach. `Sentry.setUser(null)` right after `Sentry.init()` was tried as a suppression:
  with it in place, a fresh native crash still carried `user.id` equal to `contexts.device.id`,
  so it did not visibly suppress the identifier. There is no known JS-reachable fix; see
  `.claude/rules/crash-reporting-scope.md`'s Known Limitations section for the full finding.
  `docs/privacy-policy.md` and `docs/store-listing.md` were updated to describe the identifier
  rather than claim it does not exist.
- A build with neither `EXPO_PUBLIC_SENTRY_DSN` nor `SENTRY_AUTH_TOKEN` set is genuinely silent:
  zero Sentry SDK log lines, zero network traffic to `*.ingest.us.sentry.io` (confirmed via a
  live mitmproxy tunnel, sanity-checked against a known request to rule out a dead proxy) even
  when a crash is deliberately triggered.
- A JS-thrown error produces exactly one delivered event, not two: sentry-android's own dedup
  drops the re-caught `com.facebook.react.common.JavascriptException` wrapper ("Event was
  dropped as the exception class ... is ignored") because the JS layer already sent it. Worth
  knowing before assuming a missing second event means the native path is broken - it means the
  SDK is not double-billing the free tier for one crash.
- **Not tested: a real native (NDK/signal-handler) crash.** `Sentry.nativeCrash()` throws a Java
  `RuntimeException` caught by Android's `UncaughtExceptionHandler` (`platform: java`,
  `mechanism: UncaughtExceptionHandler`) - it exercises the "bypasses `beforeSend`" property, but
  it is not a SIGSEGV or other signal caught by sentry-android's NDK handler. No specific reason
  to expect different breadcrumb/`user.id` behavior on that path, but it was not observed, and
  iOS native crash reporting was not verified at all (no Mac, no iOS device, and neither CI route
  produces an interactively-testable signed build).

**The `eas build` fallback is NOT wired for Sentry.** Both values are exported by
`build-android.yml` and `build-ios.yml` only. `eas.json` deliberately holds neither (that is the
whole point of keeping them out of a committed file), and nothing configures them as EAS
environment variables, so an `eas build` taken as the fallback when a runner path breaks ships
with crash reporting inert and no symbols uploaded - silently, with none of the `::notice::` the
GitHub workflows print. Wire them as EAS environment variables before relying on that fallback
for a release, or accept the gap knowingly.

**What it does and does not collect** is in [docs/security.md](security.md) and
[docs/privacy-policy.md](privacy-policy.md). Read those before changing any `Sentry.init()`
option: several defaults in the SDK (console breadcrumbs especially) capture things this app
promises it does not, and a JavaScript `beforeSend` cannot filter native crash events, so the
controls have to stay at the source.

**A native crash signature, now n=2 and suppressed for E2E only.** The app dies of a native
SIGSEGV under 1s after launch: GWP-ASan (`gwp_asan::GuardedPoolAllocator::deallocate`) under
`android_unsafe_frame_pointer_chase`, with `libhermesvm.so` frames beneath it and zero app frames.
Seen first on PR #27, then again on run 30308333829, where it presented as
`session-respawn-recovery` failing an `assertVisible` and read exactly like a product regression:
the failure screenshot was the AOSP launcher, because the app was already dead.

**It is not a detection**, which is the part that governs what to do about it.
`deallocate` calling `RecordBacktrace` is the routine bookkeeping path that records where a
guarded allocation was freed, not the error-reporting path, and no "GWP-ASan detected a memory
error" report appears anywhere in the artifacts. The sampling allocator crashed doing its own
housekeeping; nothing about our code was flagged.

`plugins/withAndroidE2eGwpAsanOff.ts` therefore sets `android:gwpAsanMode="never"`, **gated on
`EXPO_PUBLIC_KANGENTIC_E2E` so it reaches the `e2e` APK and nothing else**. That is not the same
decision as suppressing it on user devices, and it does not pre-empt it: because every paired flow
opens with `launchApp`, a sampled crash lands on whichever flow drew it, so leaving it on in CI
means an arbitrary flow reddens for a reason that has nothing to do with the flow. That is a test
harness problem, and it is worth solving separately from the product question.

**The shipping question is still open, and is the thing to answer next.** The tombstone proves
GWP-ASan was active on an AOSP `userdebug` x86_64 emulator. Whether the same default applies to
`user` builds on arm64 devices, where users would hit the same crash, is unverified. Now that the
DSN is live in production builds this exact signature would arrive in Sentry as a native crash, so
a real rate there is what would justify widening the opt-out. Do not widen it pre-emptively.

## The REACT-NATIVE-5 OOM: a leaked session screen, not a background leak

REACT-NATIVE-5 was an `OutOfMemoryError` against the **Java** heap's stock 256MB growth limit
after 5h31m of process uptime, with the app backgrounded under the keepalive foreground service
for most of it. The `JSApplicationIllegalArgumentException: ... 'backgroundColor' ... RCTView`
title Sentry groups it under is the third link in a `Caused by` chain and is a red herring: a
64-byte `LayerDrawable` allocation inside a Fabric `PreAllocateViewMountItem` was simply the one
that tipped a heap already at its ceiling. Any main-thread allocation would have done. The
`giving up on allocation because <1% of heap free after GC` clause is also the freeze the user
reported - continuous GC on the main thread before the throw.

**The leak is identified: every session-screen open retains its xterm WebView and view tree, and
nothing ever releases them.** Measured on the affected Pixel against the shipped Play build, from
a cold start, 1:1 with navigation:

```
open/close   Dalvik Heap Alloc   Views   WebViews
    0             7.5 MB           188       0
    1             9.5 MB           338       1
    3            10.5 MB           638       3
    6            14.0 MB          1090       6
```

Exactly one WebView and ~150 views leaked per open, ~1.07 MB of ART heap each, perfectly linear.
They survive a forced GC (`Views` and `WebViews` unchanged after collection, while
`Dalvik Heap Alloc` drops), so these are retained references, not uncollected garbage. From a
7.5 MB baseline that reaches the 256 MB growth limit in roughly **230 session opens** - an evening
of cycling between agents - and the ~4 MB of native heap per leak also explains the crash event's
`free_memory` of 740 MB against 2.2-2.8 GB in the REACT-NATIVE-3 events on the same phone.

**Where it is NOT - CORRECTED 2026-08-29, this section previously named the wrong cause.** The
earlier text reasoned that because `react-native-webview`'s `onDropViewInstance` calls
`cleanupCallbacksAndDestroy()` (`RNCWebViewManagerImpl.kt`), a surviving WebView proves the drop
never happened, and therefore "React is not unmounting the SessionScreen subtree". That was an
inference from reading library source, never a measurement, and **it is wrong twice over.**

The inference has a hole: the Objects-block `WebViews` counter decrements when the Java object is
**garbage collected**, not when `destroy()` is called. A correctly dropped and destroyed WebView
still counts for as long as anything retains the Java instance. So a surviving WebView proves
retention, not a missing drop.

Measured directly, with a mount/unmount counter in `TerminalPane`'s unmount effect and
`SessionScreen`'s open/close effect, on a Pixel 11 Pro against versionCode 10:

- **React unmounts every time.** Six pops produced six mounts and six unmounts, the live count
  returning to zero on each one. No Fabric mount-transaction abort appears in logcat either
  (`ReactNoCrashSoftException`, `Unable to find view for tag`, `Cannot remove child`,
  `SurfaceMountingManager` all absent).
- The native view tree is retained **after** that clean unmount. `dumpsys gfxinfo` shows the split
  from a second, independent counter: 308 views actually attached to the window against 922 live
  `View` objects.

Three suspects are eliminated by experiment rather than by argument, each by removing it and
re-running the same six cycles:

| Removed | Result |
|---|---|
| `PagerView` from the session screen | Views 334 -> 922, WebViews 3. No change. |
| The xterm WebView entirely | Views 334 -> **832**, WebViews 0. **Still leaks.** |
| **`ChatPane` + `ChangesTab`** (release build) | Views 327 -> **327**, WebViews 0. **Leak gone.** |
| (`TerminalPane` was already cleared in the 2026-08-09 pass) | - |

**The third row localises it.** With the two list-bearing panes dropped, six cycles retain nothing
at all, and the WebView - still mounted in that build, because only Chat and Changes were removed -
tears down cleanly. That is the direct proof that the WebView was a passenger: it survives only
while something else holds the subtree.

**Bisected to `ChatPane`.** Run against a REAL paired desktop (so all three rows share a board,
content and baseline - the demo's heavier sessions exaggerate the per-open cost and cannot be
compared against it):

| Session screen, 6 cycles, GC-forced, baseline 222 | Views | WebViews |
|---|---|---|
| Full app (control) | **+774** | **4** |
| `ChatPane` dropped, `ChangesTab` kept | +78 | 1 |

Dropping `ChatPane` removes roughly 90% of the retained views and three of the four WebViews. At
the time this read as `ChangesTab` being a second, lesser retainer. **It was not** - the fix below
takes the full app to zero retained views and zero WebViews, `ChangesTab` mounted and all. That
+78 was the one markdown view `PermissionPromptCard` renders, plus reading noise from single
`dumpsys` samples. Same component, same mechanism, no second bug.

### Narrowed to the native markdown view, by runtime bisect

**The retainer is `EnrichedMarkdownText` as rendered by `MarkdownCell`.** Replacing that one
component with a plain `<Text>` holds every counter flat over six open/close cycles.

The bisect was run from a **single release APK** carrying every variant behind a runtime switch
(`src/devsupport/retentionProbe.ts`, an `EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE` build, variants
chosen from Settings). That matters for more than convenience: a release build embeds its JS
bundle, so the obvious method - edit a component, rebuild, measure - spends one APK per hypothesis
AND compares different installs against different session content, which is exactly the confound
that spoiled the first `ChatPane` bisect. Retention is additive, so each variant is a DELTA over a
fresh GC-forced baseline taken immediately before its own cycles; views retained by an earlier
variant are a constant offset, not an error.

Pixel 11 Pro, release build, demo pairing (so control and variants share one install and one
board), six cycles per variant, GC forced by backgrounding for ~9s before every reading:

| Variant | Baseline | After 1 | After 3 | After 6 | Views/cycle | WebViews | Threads |
|---|---|---|---|---|---|---|---|
| Off (control) | 557 | 784 | 1232 | 1907 | **+225** | 1 -> 7 | 95 -> 121 |
| No conversation feed | 1907 | 1968 | 1966 | 1966 | **0** | 7 -> 8, flat | 124, flat |
| Plain cells | 2015 | 1992 | 1990 | 1992 | **0** | flat | 124, flat |
| Plain markdown | 1887 | 1887 | 1887 | 1887 | **0** | 7, flat | 124, flat |
| Markdown, not selectable | 1887 | 1890 | 2340 | 3015 | **+225** | 7 -> 12 | 124 -> 142 |

Read the rows in order and the search collapses in four steps: the whole chat pane leaks; the list
itself does not (plain cells is flat, so `FlashList`, `ConversationFeed` and the pane chrome are
innocent); of the cells, only the markdown one matters; and the leak is NOT selection.

**Three counters move together, which is what identifies a single retainer.** Views, WebViews and
THREADS all grow at a fixed rate per cycle in the leaking rows and are all flat in the fixed ones.
The WebView is confirmed a passenger for the third time: it stops leaking when a component in a
completely different pane is swapped out. And the thread column is the tell for a per-instance
native resource, because a retained leaf pins its parent, the parent pins every sibling, and one
reference therefore accounts for a whole ~225-view screen.

**The plan's two hypotheses were both wrong, and the disproofs are worth keeping.**

- *Selection / the `InputMethodManager.mServedView` leak.* `TextViewSetup.kt:14` calls
  `setTextIsSelectable(true)` unconditionally and the JS wrapper defaults `selectable = true`, so
  every markdown cell is a focusable, selectable `TextView` - the textbook IMM leak shape. It is
  not this one. Passing `selectable={false}` (verified to reach native: `@ReactProp defaultBoolean
  = true` -> `setIsSelectable` -> `applySelectableState` -> `setTextIsSelectable(false)`) leaks at
  the control's exact rate. The arithmetic said so in advance and is the cheaper check: **IMM holds
  ONE served view**, so a single-slot field cannot retain six independent subtrees. Linear growth
  per cycle means per-instance accumulation, which rules out every single-slot mechanism without
  building anything.
- *The per-view `ExecutorService` that is never shut down.* `EnrichedMarkdownText.kt:58` creates
  one and nothing in that file shuts it down, while the sibling component has
  `cleanup() { executor.shutdownNow() }` (`EnrichedMarkdown.kt:608`). The asymmetry is real and the
  thread column above measures its cost, but it cannot be the view retainer: follow the references
  and an idle pool holds `Thread -> Worker -> ThreadPoolExecutor -> (empty queue)`. The view holds
  the executor; nothing on that chain holds the view. A leaked thread is a leaked thread.

### The cause: an accessibility listener left on the window's ViewTreeObserver

**Fixed, and the fix is verified to the plan's bar: `Views` returns exactly to baseline and
`WebViews` to zero after six cycles.** It is one line of Kotlin, carried as a `patch-package`
patch (`patches/react-native-enriched-markdown+0.7.4.patch`, applied by the `postinstall` script).

`MarkdownAccessibilityHelper.invalidateAccessibilityItems()` rebuilds its TalkBack items
immediately when the view already has a `Layout`, and otherwise defers via
`schedulePostLayoutRebuild()`, which registers a `ViewTreeObserver.OnGlobalLayoutListener` that
removes itself in its own callback. Three things turn that into a per-instance leak:

1. **The deferred path is the normal path, not the edge case.** The JS wrapper always sends
   `accessibilityLabels` (resolved defaults), so the `labels` setter always runs and always calls
   `invalidateAccessibilityItems()` - at prop time, before the view has ever been laid out.
2. **The listener is registered on the WINDOW.** Before attach, `View.getViewTreeObserver()`
   hands back the view's own floating observer; on attach the framework MERGES that observer's
   listeners into `ViewRootImpl`'s. `ViewRootImpl` outlives every route and is a GC root.
3. **Only the listener's own callback ever removes it.** `removePendingLayoutListener()` is
   called from exactly one place: inside the listener. `invalidateAccessibilityItems()`'s other
   branch - the one taken once the view HAS a layout - rebuilds immediately and never clears a
   listener registered earlier, and nothing clears one on detach or drop.

**What is measured and what is inferred.** Measured: removing the listener on detach takes six
cycles from +225 views and 6 WebViews to 327 views and 0 WebViews, and a view that never renders
leaks identically. Read straight out of the source: points 1-3 above. NOT established: exactly
which sequence leaves the callback unfired in this app. A plausible one is that Fabric lays views
out by calling `View.layout()` from mount items while `onGlobalLayout` is dispatched by
`ViewRootImpl.performLayout`, which a mounted subtree need not trigger - but that was never
measured, and the fix does not depend on it. Point 3 is sufficient on its own.

The result is one strong chain per markdown view that outlives the route:
`ViewRootImpl.mTreeObserver -> listener -> MarkdownAccessibilityHelper -> the TextView -> mParent
-> the whole session screen`, the xterm WebView in a different pane included. That is why a leaf
component in the Chat pane retained the Terminal pane's WebView, and why three separate
investigations found the WebView "leaking" while removing it changed nothing.

**TalkBack is unaffected, and that is checkable rather than assumed.** `cleanup()` clears the
listener but leaves `needsRebuild` set, so the obvious worry is a view that re-attaches wanting a
rebuild with nothing left to service it. It cannot get stuck: `rebuildIfNeeded()` is the first
statement of `getVirtualViewAt`, `getVisibleVirtualViews` and `onPopulateNodeForHost`, so items
are built lazily whenever accessibility queries the view. The listener is a proactive optimisation
(it rebuilds early and calls `invalidateRoot()`), not the only path.

**The fix**: remove the listener in `onDetachedFromWindow()`, which is the last moment
`getViewTreeObserver()` still returns the window's observer rather than the view's floating one.
Doing it in `onDropViewInstance` would be too late and would silently remove from the wrong
observer. It goes in the shared base class, `AccessibleMarkdownTextView`, because that is where
the helper is created - so `EnrichedMarkdownInternalText` (and with it the `EnrichedMarkdown`
component) is covered by the same change rather than left to leak on its own.

```kotlin
// AccessibleMarkdownTextView.kt
override fun onDetachedFromWindow() {
  accessibilityHelper.cleanup()   // -> removePendingLayoutListener()
  super.onDetachedFromWindow()
}
```

**A minimal reproduction exists and is the thing to hand upstream.** With the probe's
`single-markdown` variant the whole chat pane is one `MarkdownBlock` - no list, no cells, no
recycling - and one open/close cycle still retains a whole screen:

| Six cycles, baseline 327 views / 0 WebViews | Views | WebViews | Threads |
|---|---|---|---|
| One markdown view, unpatched | 807 (+80/cycle) | 6 (+1/cycle) | 51 -> 95 |
| One markdown view, **never rendered** (`markdown=""`) | 1287 (+80/cycle) | +1/cycle | flat |
| One markdown view, patched | **327** | **0** | 51 -> 89 |
| One markdown view, never rendered, **patched** | **327** | **0** | flat |
| Full app, patched | **327** | **0** | flat |

Re-verified on the SHIPPING bundle - the patch applied by `postinstall`, no probe code compiled
in at all - six cycles from a 464-view baseline: 464, 464, 464, and `WebViews` 0 throughout. The
pre-collection samples on that run read 676, 690 and 694, which is the two-sample rule earning its
place: every one of those would have been reported as a leak.

The never-rendered rows are the pair that named the cause. An `EnrichedMarkdownText` created with
`markdown=""`, which returns from `setMarkdownContent` before `scheduleRender`, still leaks at the
identical rate - eliminating parsing, spans, `MeasurementStore`, the render executor and every
span-held reference in one reading. And the SAME variant is fixed by the accessibility patch,
which is what makes the argument tight: a component that renders nothing leaks, and removing the
listener stops it, so registration at prop-set time is the whole mechanism. It also settles by
measurement something that was otherwise an inference from the JS wrapper's defaults -
`invalidateAccessibilityItems()` does run on the prop path even for empty markdown, or there would
have been no listener for the patch to remove.

**The never-shut-down `ExecutorService` was a SYMPTOM, not a second bug.**
`Executors.newSingleThreadExecutor()` returns a `FinalizableDelegatedExecutorService` whose
`finalize()` shuts the pool down, so the thread dies once the view becomes collectable. The
thread column above shows it: threads climb while views are retained and go flat the moment the
retention is fixed. Relying on a finalizer is still poor practice worth raising upstream, but
there is nothing here to patch.

**The fix is Android-only, by construction.** `ViewTreeObserver` is an Android API and the patch
touches `android/src/main/java/**` and nothing else. iOS renders markdown through a separate
`NSAttributedString` implementation that has NOT been examined and for which this repo has no
retention measurement path at all (there is no iOS equivalent of `dumpsys meminfo` wired up here,
and no iOS E2E suite). So: the Android leak is fixed and measured to the bar; whether iOS has an
analogous one is unknown, and any claim that this unblocks App Review should say so.

**Upgrading does not fix it.** The library is at 0.7.4 here and 1.0.2 is current;
`MarkdownAccessibilityHelper.kt` is **byte-identical** between the two, and the same code is on
their `main`. Filed upstream with the measurements and the minimal reproduction as
[issue #730](https://github.com/software-mansion/enriched-markdown/issues/730) and
[PR #731](https://github.com/software-mansion/enriched-markdown/pull/731); drop
`patches/react-native-enriched-markdown+0.7.4.patch` once that ships in a version we depend on.

Until then the patch filename pins 0.7.4, so **re-run the probe after any bump of
`react-native-enriched-markdown`** - a version bump silently drops the patch. `patch-package` will
warn, but only the probe proves the leak is still fixed.

### Two dead ends worth not repeating

**Reanimated's `synchronouslyUpdateUIProps failed for tag` storm is not this leak.** Six hundred
of them per two cycles (`RetryableMountingLayerException: Unable to find SurfaceMountingManager`)
fire from inside the react-native-screens exit animation, and they correlate perfectly with
markdown being rendered - the tempting conclusion is that the transition races surface teardown.
It is not the retainer: disabling system animations entirely
(`settings put global window_animation_scale 0`, plus `transition_` and `animator_duration_`)
silences every one of those warnings and the leak continues at its exact 225 views per cycle.
Correlation, no causation. Restore the three settings afterwards - they are the user's phone.

**One `dumpsys` sample is not a reading.** A plain settings push looked like +220 retained views
until a second sample eight seconds later showed 327, the baseline exactly. Take two samples per
checkpoint and trust the second; a gap between them is GC lag, not retention. The probe driver
prints both.

**Take the control on the SAME pairing before removing anything.** The first attempt at this bisect
compared a `ChatPane`-dropped build on a real desktop against a full-app number from the demo, and
`+78 vs +892` looked like near-total elimination when the honest comparison was `+78 vs +774`. The
conclusion happened to survive; the reasoning did not deserve to.

Worth knowing before that bisect: FlashList is at 2.0.2, and **v2 ships no Android sources at all**
(there is no `android/` directory in the package), so there is no native ViewManager of its own to
retain anything. Whatever holds the subtree is either JS-side or in the RN views these panes
compose.

The second row is the load-bearing one: roughly 83 views leak per pop with no WebView in the tree
at all. **The WebView is a passenger, not the cause** - an expensive one, worth ~40 MB of GL
surface each, which is why it dominated the symptom and misdirected the first investigation.

A heap histogram diffed between two dumps of the same process names where it does live. Fabric's
mount-item machinery grows in lockstep, about 47 objects per cycle:
`FabricUIManager$2` +282, `MountItemDispatcher` lambdas +281, `IntBufferBatchMountItem` +280,
`EventEmitterWrapper` +280, `SurfaceMountingManager$ViewState` +279. An `IntBufferBatchMountItem`
is a mount transaction that should execute and be discarded; 280 of them alive, each holding
`ViewState` entries and therefore views, is the leak. `react-native-screens` is clean by the same
measurement (`Screen` +3, `ScreenStackFragment` +3 - steady state, not per-cycle), so the original
"start at the expo-router / react-native-screens boundary" pointed at the wrong library too.

**It is WORSE on a release build, not better.** A 2026-08-27 re-measurement on a dev client saw
only 3 of 6 pops retain a WebView and recorded the leak as having improved to "intermittent". That
was a dev-client artifact. No dependency in the retention path changed between the two dates
(`react-native-pager-view` has been pinned at 8.0.2 since App Phase 1; `react-native-screens` last
moved on 2026-07-27, before both). Measured on a release build of the same commit:

| | Release baseline | After 6 open/close cycles |
|---|---|---|
| Views | 327 | 1219 (+892) |
| WebViews | 0 | **5 of 6 pops** |
| GL mtrack | 115 MB | 172 MB |
| TOTAL PSS | 483 MB | 621 MB |

Those survive a GC (confirmed by backgrounding the app: Java Heap fell 65.7 MB -> 33.5 MB while
`Views` and `WebViews` did not move). Roughly 23 MB of PSS per session open is the number that
matters for the App Review path, where a reviewer opens many sessions in a row.

**A plain route is the control, and it does NOT leak.** Six push/pops of `settings` - no WebView,
no panes, no session - grow `Views` by ~101, and every one of them is reclaimed by a GC, returning
to the baseline 327 exactly. The same six cycles on the session screen leave +892 views and 5
WebViews that a GC does not touch. Same app, same procedure, opposite outcomes: this is not
"expo-router leaks every route", and any future theory has to explain why one route's subtree
survives collection and another's does not.

That control also shows why the pre-GC number is worthless on its own. `Views` climbing after a pop
is the NORMAL state of a freshly popped screen; only what survives a forced collection counts. Force
one (`am dumpheap` on a debuggable build, or background the app and wait) before reading anything
into a delta.

**Judge nothing about this leak, or about smoothness, on a dev client.** The same commit measured
1003 MB PSS on the dev build and 483 MB on release, and the jank figures differ by more than two
orders of magnitude (see the frame-timing note below).

**This reframes the keepalive's role in REACT-NATIVE-5.** The keepalive never leaked - the
background path is flat four ways (below). What it did was hold the process resident for 5h31m so
that ordinary foreground accumulation never got reset by an OS kill. The five-minute ceiling
therefore does fix the OOM, but by making the process reapable again, not by stopping a background
leak. Detaching the markdown library's window-level accessibility listener is the real repair (see
"The cause: an accessibility listener left on the window's ViewTreeObserver" above); the ceiling
only buys back the safety net. This sentence used to end "fixing the unmount is the real repair",
which named the wrong cause: React unmounts correctly, and six pops produce six clean unmounts
while the native views are retained anyway.

### Idle CPU: the app costs half a core doing nothing, and it is Reanimated's per-frame flush

**Open finding, measured but not fixed.** An idle Agents list on a release build costs **~50% of a
core** while rendering ~84 frames per second that nobody asked for. Jank is 0.11%, the GPU is at
1 ms, and `dumpsys gfxinfo` calls it perfectly smooth - which is exactly the blind spot the
frequency gate in `.claude/rules/motion-conventions.md` warns about.

The tool that named it is `simpleperf` against a **profileable release build**
(`plugins/withAndroidProfileable.ts`, and the `/profile` skill for the procedure). 99% of the
app's cycles sit under one call chain:

```
Looper.loop -> Choreographer.doFrame -> ReactChoreographer
  -> worklets.AnimationFrameQueue.executeQueue        (94% of frame callbacks)
    -> worklets::AnimationFrameCallback::onAnimationFrame
      -> Hermes (the UI-thread worklet runtime)
        -> reanimated::NativeProxy.maybeFlushUIUpdatesQueue
          -> NodesManager.performOperationsRespectingDrawPass
            -> a deep recursive walk, then Fabric's RawPropsParser
```

**The cost is not the animation math.** `libreanimated.so` is 1.87% of the profile. The expensive
part is what the frame loop drags behind it: Fabric parsing and applying props (`RawPropsKey`
comparisons, `RawPropsParser::at`), `libhwui` redrawing (16.5%), and the ioctl traffic to submit
frames. One never-ending animation keeps that entire pipeline running at display rate.

**The mapper pass is unconditional, which is why "what is animating" is the wrong question.**
Read `react-native-reanimated/src/mappers.ts`: `scheduledMapperRun` re-arms itself every frame
for the life of the process on native ("We always run mappers on native"), starting at init.
`useAnimatedStyle` registers one mapper per mounted component (`useAnimatedStyle.ts` ->
`startMapper`), `mapperRun()` skips clean mappers but calls `updateMappersOrder()` - a recursive
topological sort over ALL of them - whenever the mapper count changes, which FlashList recycling
does constantly.

| Idle Agents list, release build | Median CPU | Range |
|---|---|---|
| As shipped | ~50% | 45-57 |
| Activity rings + skeletons inert (in-process A/B) | 40% | 26.5-47.5 |
| OS reduced motion (nothing animates at all) | **6%** | 5-11 |

**RETRACTED, and the retraction is the useful part.** An earlier revision of this section put
`PressScale` at "roughly 19 of those points" and called press feedback on every card the
highest-value question left open. That number came from subtracting across two DIFFERENT builds.
Measured properly - one APK, one process, the card implementation swapped at runtime through the
probe - it does not reproduce:

| Idle Agents list, same process | Median | Range |
|---|---|---|
| Card on `Pressable`'s own pressed state (no mapper) | 51% | 48.5-56.5 |
| Card on `PressScale` (a mapper per row) | 53.5% | 48.5-60 |
| Card on `PressScale`, after forcing every row to re-render | **49.5%** | 45.5-57 |

The old implementation measured LOWER on the cleanest sample. `PressScale` on `Card` costs
nothing resolvable, the swap was reverted, and cards keep the eased press. **Cross-build
subtraction is not measurement**, and this is the fourth mechanism in this investigation that
looked obvious and did not survive an A/B (see also the render executor, the `InputMethodManager`
served view, and the Reanimated warning storm).

Note what that leaves: the ~44 points between "as shipped" and OS reduced motion was
**unattributed** when this paragraph was first written. It is now attributed - see "The residual
is the mapper walk" below: it is non-drawing main-thread work that scales almost linearly with the
number of REGISTERED Reanimated mappers, dirty or not.

**Things that are NOT the cause**, each eliminated by measurement rather than argument:

- **Not the count of visible spinners.** Collapsing the Thinking section (seven rows, three visible
  rings) moved 50.5% to 43%; collapsing *every* section, leaving no rows on screen at all, measured
  54% - higher, not lower.
- **Not screen identity.** Home 50%, Home fully collapsed 54%, Settings on top 50%, Board 66%.
- **Not the leak, and not fixed by fixing it.** This is orthogonal to the retention bug above.
- **Not the JS thread.** 96.8% of cycles are on the main thread; `mqt_v_js` is 1-3%.

### It is a known New Architecture regression, and one documented flag helps

This is not this app's invention. Reanimated's own
[Performance guide](https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/)
carries a "Performance Regressions on New Architecture" section, and two open issues match this
app's shape closely: [#6853](https://github.com/software-mansion/react-native-reanimated/issues/6853)
reports a `withRepeat` + `withTiming` spinner taking Android from ~20% to 100% CPU with **iOS
unaffected** (that is our activity ring, almost line for line), and
[#7435](https://github.com/software-mansion/react-native-reanimated/issues/7435) reports Android
degradation after the New Architecture migration persisting from 3.16 through 4.0.

Of the three static feature flags that guide recommends, `USE_COMMIT_HOOK_ONLY_FOR_REACT_COMMITS`
is already on by default in 4.5.1 and the other two were off. **`package.json` now enables the one
that targets this path:**

```json
"reanimated": { "staticFeatureFlags": { "ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS": true } }
```

It is a native build-time flag, so it needs a rebuild and cannot be A/B'd in one process - which
means this is a cross-build comparison, the shape this section warns about everywhere else. It is
reported anyway because two independent signals agree and one of them is qualitative:

| Idle Agents list | Flag off | Flag on |
|---|---|---|
| CPU median, two 40s samples each | 51%, 49.5% | **45.5%, 47.5%** |
| Cycles sampled over 12s | 7.58B | **3.51B** |
| `libreactnative.so` share | 19.2% | **1.2%** |
| `RawPropsKey ==` / `RawPropsParser::at` | top symbols | **absent** |

The CPU delta (~4 points, ~8%) is inside a single sample's spread and would not be reportable
alone. What makes it credible is the composition change: the Fabric prop-parsing path that
dominated every earlier profile is simply gone, which is exactly what a flag named "synchronously
update UI props" claims to do. Retention is unaffected (327 -> 327 views, 0 WebViews over six
cycles), and the screen renders identically.

**Do not read the flag-on percentages as "hwui became the new bottleneck."** With the flag on,
`libhwui.so` rose to 25.5% *of the profile* - but the profile's denominator halved, so in absolute
cycles hwui went DOWN ~30%. Nothing became a new bottleneck; the whole pie shrank. A shared-object
percentage table silently renormalises after any real win, and this one misled a reader of this
section into a compositing-cost diagnosis the next measurement disproved. Compare cycles/second
across runs, never bare percentages.

`DISABLE_COMMIT_PAUSING_MECHANISM` was NOT enabled: it is only useful alongside React Native's
`preventShadowTreeCommitExhaustion`, which requires building RN from source (patching a C++ header
and substituting the Gradle module). Disproportionate here, and recorded so nobody re-derives it.

### The residual is the mapper walk: idle CPU scales with REGISTERED mappers

**Attributed 2026-08-30, by two in-process experiments the earlier rounds never ran** - reading
frames alongside every CPU number, and varying registered-mapper count at runtime (the probe's
`extra-mappers` variant, `src/devsupport/MapperLoad.tsx`). Release build, Pixel 11 Pro, demo
pairing, Agents list, 40s samples:

| Arm (one process, toggled at runtime) | CPU median (range) | Frames / 40s |
|---|---|---|
| As shipped, visible, 7 spinners | 41% (34-50) | 3590 (~90fps) |
| Covered by Settings (spinners gated off by ScreenMotion) | **23% (22-25)** | **0** |
| +64 clean never-animating mappers, visible | **70% (59-76)** | ~display rate |
| Extra mappers removed again (drift control) | 39% (36-48) | - |

Two conclusions, each carried by one row:

1. **The residual is non-drawing main-thread work.** 23% of a core with ZERO frames rendered and
   the GPU histogram empty - compositing cannot be the cost when nothing composites. This is the
   measurement the "hwui share rose" percentage table appeared to contradict (see the
   denominator note above).
2. **Idle CPU scales almost linearly with the number of REGISTERED Reanimated mappers, dirty or
   not: ~0.47 points each.** 64 permanently-clean mappers (a shared value nothing ever changes)
   added ~30 points and removing them took it straight back. The per-vsync flush walks the
   registered set; "mapperRun skips clean mappers" is true of the callback body and false of the
   walk's cost. The jump landed mid-sample exactly as the FlashList rows re-rendered and mounted
   the mappers, which is as close to a signature as `top` gives.

**The fix that follows: register animated hooks only on the branch that animates.**
`AgentStatusIcon` used to call `useAnimatedProps` (an inert march) and `useAnimatedStyle` (the
spin) above its early returns, so every idle-envelope row registered two dead mappers. The hooks
now live in `SpinningMark`/`MarchingMark`, children mounted only while animating: an idle row
registers zero, a working row registers one. The mechanism is locked by the "registered mappers"
block in `tests/components/AgentStatusIcon.test.tsx` (red-green verified: restoring the
unconditional hooks fails all four). The remaining per-row mappers on the feed are `PressScale`
(one per card; measured unresolvable in the earlier swap A/B, consistent with ~0.5 points) and
the section-pulse overlay (one per row; gating it to mount only while pulsing fights the strict
react-hooks purity/set-state-in-effect lints and is left as a documented follow-up).

**What the fix is worth is NOT settled by a before/after of the shipped screen, and this section
does not claim one.** The post-fix build measured 46-47% (36-53) against the pre-fix 41% (34-50) -
a CROSS-BUILD pair, taken while the demo showed eight spinners against seven, on a screen whose
run-to-run spread is wider than the expected ~5-7 point saving (idle rows on screen x 2 mappers x
~0.47). Per `performance-claims-are-measured.md` that pair resolves nothing, and quoting it as a
win (or a regression) would repeat the exact mistake this section keeps correcting. The claim that
IS made: the mechanism is measured (the extra-mappers A/B), the reduction is proven (the test
block), and the arithmetic follows. A same-process probe variant toggling the split is the
experiment that would put a number on it, if one is ever needed.

The old "next step" here - patching Reanimated to count DIRTY mappers per pass - is superseded:
dirtiness was the wrong axis. The open upstream question is why walking clean mappers costs what
it does (issues #6853 / #7435 territory), which no app-side change answers.

Two rules earned the hard way, both now in `performance-claims-are-measured.md`: an A/B belongs in
ONE process, and a delta smaller than the run-to-run spread is not a result. The spread on this
screen is 45-57%, so nothing under ~12 points can be concluded from a single pair of runs.

Two smaller notes for whoever picks this up. The activity-ring gate
(`src/components/motion/ScreenMotion.tsx`) stops looping motion on a blurred screen: worth ~9
points when it fires, but its direct blurred-screen delta (50% against 47.5%) sits inside the
run-to-run spread, so treat it as correctness rather than a measured saving. And the Reanimated
`synchronouslyUpdateUIProps failed` storm during screen exits - ~385 warnings per close, each
building a 75-frame stack trace - was a **consequence of the retention leak** and disappeared when
that was fixed.

### Frame timing: the app is smooth on release, and only on release

Measured 2026-08-29 on a Pixel 11 Pro with `adb shell dumpsys gfxinfo com.kangentic.mobile`, same
commit, same screen (the Agents list with eight spinning activity marks):

| | Dev client | Release |
|---|---|---|
| Janky frames | 24.73% | **0.11%** |
| 50th percentile frame | 21 ms | **7 ms** |
| 99th percentile | 48 ms | **12 ms** |
| Slow UI thread | 2984 | **4** |
| Missed Vsync | 1469 | **1** |

GPU time is 1 ms at every percentile in both, so nothing here is GPU-bound: the dev-client cost is
entirely UI/JS thread, and it is the dev runtime rather than the app. **A "feels laggy" report
gathered on a dev client is not evidence about the shipped app.** Sitting idle on release measures
0.05% jank.

One real finding survives that comparison, and it is about **battery, not smoothness**: the idle
release build rendered 6131 frames in a 51-second window, which is continuous 120 Hz compositing
while nothing is happening. The app never goes idle.

### The activity spinners cost more than half a CPU core

Measured with `adb shell top -b -n 4 -d 2 -q -o CMD,%CPU -p $(pidof com.kangentic.mobile)` on the
release build, idle, no interaction, against the demo pairing:

| State | CPU |
|---|---|
| Backgrounded | ~24% |
| Agents list, Thinking section collapsed (no spinners rendered) | ~43% |
| Settings pushed over a collapsed Agents list | ~46% |
| **Settings pushed over an EXPANDED one (8 spinners animating, invisible)** | **~72%** |
| **Agents list, 8 spinners visible** | **~106%** |

Two independent wastes, both isolated by A/B on the same screen (collapsing the Thinking section
removes the spinners and changes nothing else):

1. **~63 points for eight visible spinners** - roughly 8 points per icon. **FIXED 2026-08-29.**
   `AgentStatusIcon` drove the spin through `useAnimatedProps` into an SVG `<G>`'s `matrix` prop,
   so every spinner re-rendered react-native-svg on every frame. The turn is now a
   `transform: [{ rotate }]` on the wrapping `Animated.View`, composited natively, with a static
   `<Svg>` inside. Measured on release, Agents list, eight spinners, idle:

   | | Before | After |
   |---|---|---|
   | CPU | ~106% | **~56%** |
   | Spinner-attributable cost | ~63 points | **~13 points** |
   | Janky frames | 0.11% | 0.06% |
   | GPU memory | 92.26 MB | **52.18 MB** |

   Rotating the whole `<Svg>` is exact rather than approximate because the only animated mark is a
   single circle at its viewBox centre; `tests/unit/activityMarks.test.ts` asserts that for every
   spinning mark so a future off-centre one fails the build. The wrapper is rendered ONLY on the
   spinning branch, which is what keeps the e4e5524 tilted-envelope bug fixed - a transform on a
   node that survives a working-to-idle rebind keeps whatever angle Reanimated last wrote, because
   Reanimated writes to the native view and React's prop diff never clears it.

2. **~26 points animating a screen nobody can see. STILL OPEN.** `freezeOnBlur` is not set
   anywhere, so a covered Agents list keeps its spinners running while Settings, a session, or a
   sheet sits on top (measured: Settings costs ~72% over an expanded list against ~46% over a
   collapsed one). Gating the animation on screen focus would be a pure win with no visual change.
   Be aware `freezeOnBlur` alone may not fix it - it suspends React rendering, while this cost is
   Reanimated driving a native transform, which continues regardless. Measure rather than assume.

Neither is a leak: the effects call `cancelAnimation` on unmount and the gating already covers
reduced motion and the mark's legibility floor.

**The demo is NOT what makes those numbers big - measured against a real desktop.** The obvious
suspicion is that the in-process mock desktop (a 1-second feed tick plus a PTY capture replaying on
its own recorded timing) inflates everything and a real user pays less. It does not. Same release
build, same handset, paired to a real desktop over the hosted relay:

| State | Demo pairing | Real desktop |
|---|---|---|
| Agents list, screen on | ~54% (8 spinners) | ~50-57% (**1** spinner) |
| Static Settings screen, screen on | ~46% | ~46% |
| **Screen OFF** | - | **0.0%, every thread** |
| Session screen, Terminal, streaming hard | - | ~100% |

Read that table with the correction below: only the screen-off row is a clean measurement.

Real is slightly WORSE than the demo while showing seven fewer spinning marks, so the live channel
costs at least what the simulator did.

**CORRECTION: there is no background CPU floor. The row above saying ~36% is wrong.** It was
measured seconds after pressing HOME, with the screen still on and the desktop actively streaming.
Measured properly - screen off, `top -H` per thread - **every thread reads 0.0% and the process
totals zero**, and it stays there through a deliberate 150-line burst of terminal output. The app
is well behaved at rest. Any earlier reading of a "floor" was load, not idle.

**What the screen-on numbers actually measure is the observer.** With the screen on, the app ranges
43-69%, and that range is NOT explained by what is displayed: a static Settings screen costs ~46%
against the Agents list's ~50%, and collapsing the only spinning mark made CPU go UP, not down. The
variable is how hard the desktop is streaming - which, when an agent session is the thing doing the
measuring, is the measurement itself. Every adb command run during a session streams its output to
the phone.

So a live pairing can answer exactly one question well: **does the app idle at zero when nothing is
happening?** It does. It cannot answer "what does surface X cost", because the load moves under the
comparison. For any marginal cost, use the DEMO, whose PTY capture replays on fixed timing - that is
what the demo is good for, and it is the opposite of the conclusion the previous revision of this
section drew.

The pure-TS `@noble` ChaCha20-Poly1305 hypothesis (no native crypto module, by design) is neither
supported nor refuted by any of this and remains untested.

**Two traps that cost measurements in the session that produced this table**, both of which
silently produce plausible numbers:

- **`top -p <app pid>` does not see the WebView.** Android runs WebView in a sandboxed renderer
  process (`com.google.android.webview:sandboxed_process*`), so any xterm rendering cost is
  invisible to a measurement scoped to the app. Sample the renderer too, and identify WHICH one is
  yours - several apps have their own.
- **Check the screen is actually on.** A locked phone reads as a low, believable foreground number.
  Two readings here had to be discarded for exactly that. Screenshot alongside the sample.

Also mind that a real desktop is an UNCONTROLLED load: these foreground figures move with whatever
the agents are doing. For a marginal cost (does the Terminal segment cost more than Chat?), A/B on
the DEMO, whose PTY capture replays on fixed timing; use the real pairing for the absolute floor.

Reproduce with `adb shell dumpsys meminfo com.kangentic.mobile`, reading `Views` and `WebViews`
from the Objects block and `Heap Alloc` from the **Dalvik Heap** row. Do not read `Java Heap` out
of the App Summary block: that is a PSS figure covering shared and zygote pages and it moves for
reasons unrelated to allocation - it showed 24-40 MB while the real ART allocation was 13 MB.

### What has been measured, and what it ruled out

`dumpsys meminfo` works on a non-debuggable app even though `am dumpheap` does not, so the
following ran against the **real Play build** (`0.4.0+4`) on the affected Pixel 10 Pro - paired,
with a live desktop session streaming, USB-powered so Doze stayed `ACTIVE` throughout, and with
the foreground service verified alive at every sample. It measures whether the Java heap grows,
and how fast; it cannot attribute growth to an allocator.

| Probe | Condition | Java heap |
|-------|-----------|-----------|
| Steady state, light path | Board screen, `terminal:false`, 24 min | Flat, 22.5-22.7 MB |
| Steady state, heavy path | Session screen, `terminal:true`, 24 min | Flat, 24.2-24.6 MB |
| Traffic burst | 5.1 MB / 40k lines of PTY output | GC'd DOWN to 21 MB, no growth |
| Cycle accumulation | 25 background/foreground round trips | Flat, 39.7-40.5 MB (+/-400 KB) |

Across all four, view count, `Activities` and `AppContexts` stayed constant (no view or context
leak), and total PSS *declined* as the system reclaimed backgrounded pages.

So three plausible mechanisms are ruled out at this granularity: **PTY bytes leaking Java-side**,
**OkHttp/`WebSocketModule` frames queueing while backgrounded**, and **per-cycle accumulation
across background/foreground transitions**. Steady-state Java heap sits around 24 MB backgrounded
and 40 MB freshly resumed, against a 256 MB growth limit - roughly a 6x gap that something would
have to close.

These four probes are what redirected the search to the foreground path. Read them as "the
background path is clean", not as "there was no bug" - they were run at PSS granularity over
24-minute windows, and it was the `Views`/`WebViews` object counts, not the heap figures, that
eventually made the real leak obvious.

**Do this against a build WITHOUT the ceiling.** With the keepalive stopping after five minutes,
heap growth stops with it, so a current build probably cannot reproduce the crash at all.

That does **not** make the soak urgent, which is worth stating because the opposite is the easy
assumption: `0494983` is the last pre-ceiling commit and git keeps it indefinitely, so the
unbounded build stays reproducible forever. Shipping the fix costs only the natural crash signal
in Sentry, and a REACT-NATIVE-5 event carries an OOM stack, not a heap dump - it was never going
to identify the allocator on its own. Run the soak when convenient; just run it from that commit
rather than from HEAD.

**Not the shipped Play build, though - it cannot be dumped.** `adb shell am dumpheap` requires the
target to be debuggable (or the device to be `userdebug`/rooted), and this project sets neither
`android:debuggable` nor `android:profileable` anywhere: the production build is a plain `user`
release, so the dump is refused. Discovering that after an overnight soak costs the whole night.

Use a **`development`-profile build from a commit before the bound landed** (`0494983` is the last
one). It is debuggable, so it dumps. Its absolute numbers are not release numbers - dev bundle, no
R8 - but the target here is *which retained set grows monotonically over hours*, and that survives
the difference. If release-accurate numbers turn out to matter, the next step up is a
release-buildType build with debuggable forced on for that one artifact, which needs a small config
plugin (follow `withAndroidE2eGwpAsanOff.ts`, which is gated to a single profile the same way) -
never a hand edit under `android/`.

1. Install that build on a physical device and pair it against a live desktop with an agent
   session actively streaming. `device.low_memory` was `false` in the crash, so the device being
   otherwise healthy is expected and not a reason to stop.
2. Baseline right after backgrounding:
   `adb shell am dumpheap com.kangentic.mobile /data/local/tmp/heap-baseline.hprof`
3. Leave it backgrounded for several hours. The reported crash took 5h31m of uptime; the
   REACT-NATIVE-3 timestamps cluster around overnight stretches.
4. Second dump, same command, `/data/local/tmp/heap-after.hprof`.
5. `adb pull` both, convert with `hprof-conv` if Android Studio asks, and diff the **dominators**
   in the Memory Profiler. The question is which retained set grew, not which class has the most
   instances.

**These dumps are app data, not just diagnostics.** This app's crypto is pure TypeScript on
Hermes, so Noise keys and decrypted transcript content live in the JS heap rather than behind a
native module. An `.hprof`, a Perfetto heap profile, or a bugreport taken from a paired build can
carry both, and `logcat` can carry transcript text. Keep captures local, never attach one to an
issue, a PR, or a CI artifact (the repo is public), and delete them from the device and the host
when the investigation is done.

Candidates considered and left open, none confirmed: OkHttp / `WebSocketModule` frames queueing
on the Java side while the JS thread is throttled; notifee notification objects; retained Fabric
view state across the background cycle; the xterm WebView. Note the in-JS buffers were checked
and are bounded (`src/state/terminalFeed.ts` caps each retained session's ring at 128KB), and
they live on the Hermes heap anyway, which is not the heap that died.

One targeted candidate worth knowing about before reading the dump: a session screen left open
while the app backgrounds keeps `terminal: true` on its stream subscription
(`subscriptionManager.ts`), so live PTY bytes keep arriving with no one watching. Dropping that on
background is a one-line change through the existing `setStreamWantsTerminal`, and it was
deliberately NOT made pre-emptively - a speculative fix landed before the dump would muddy exactly
the reading the dump exists to give.

## Credential inventory

Every credential this project uses, where it lives, and what happens if it is lost. No values here,
by design.

**They live OUTSIDE the repo**, in `%USERPROFILE%\kangentic-secrets\` on the maintainer's machine.
Do not move them in, even gitignored. This repo is public, so a `.gitignore` slip is a published
private key; `git clean -xfd` deletes ignored files and would destroy the only copy of the
keystore; the board's per-task worktrees under `.kangentic/worktrees/` would not see repo-root
files anyway; and `eas build` uploads the project directory, so an in-repo secret would reach
Expo's servers.

| Credential | Local copy | Also held by | If lost |
|---|---|---|---|
| `kangentic-upload.jks` (+ base64, + credentials) | `~/kangentic-secrets/android/` | GitHub secrets (write-only) | **Unrecoverable.** Play support keystore-reset round trip |
| Play publishing key (`play-publisher@kangentic-mobile`) | `~/kangentic-secrets/google-play/` | GitHub secret `PLAY_SERVICE_ACCOUNT_JSON` | Regenerate in Google Cloud, re-grant in Play Console |
| FCM V1 key (`firebase-adminsdk-fbsvc@kangentic-b43ff`) | `~/kangentic-secrets/firebase/` | Expo project credentials (FCM V1) | Regenerate with `gcloud`, re-upload via `eas credentials` |
| `google-services.json` (+ base64) | `~/kangentic-secrets/firebase/`, plus repo root (gitignored) | GitHub secret `GOOGLE_SERVICES_JSON` | Re-download from Firebase console |
| Apple distribution cert `.p12` (+ base64, + password) | `~/kangentic-secrets/apple/` | GitHub secrets `IOS_DIST_CERT_*`, Expo project credentials | Revoke and reissue via `eas credentials`; the profile must be regenerated with it |
| App Store provisioning profile (+ base64) | `~/kangentic-secrets/apple/` | GitHub secret `IOS_PROVISIONING_PROFILE_BASE64` | Regenerate via `eas credentials`. Expires 2027-07-26 regardless |
| Extension provisioning profile (+ base64) | `~/kangentic-secrets/apple/` | GitHub secret `IOS_NSE_PROVISIONING_PROFILE_BASE64` | Regenerate for the `com.kangentic.mobile.nse` App ID. Both profiles must carry the `com.kangentic.mobile.shared` Keychain group |
| APNs key (`.p8`) | Expo project credentials only | - | Revoke in the Apple portal and mint a new one |
| App Store Connect API key (`.p8`) | `~/kangentic-secrets/apple/` once created | GitHub secrets `ASC_*` | Revoke in App Store Connect and mint a new one |
| Sentry org auth token | `~/.sentryclirc` (written by `sentry-cli login`, outside the repo) | GitHub secret `SENTRY_AUTH_TOKEN` | Revoke and mint a new one in Sentry settings; nothing else breaks |
| Sentry DSN | GitHub **variable** `SENTRY_DSN` (readable back) | The Sentry Client Keys page, and every published app bundle | Re-copy from Sentry. Not a credential: write-only, and public by design |
| Sentry **read** token (`KANGENTIC_SENTRY_TOKEN`) | A User-level environment variable on the maintainer's machine, set with `[Environment]::SetEnvironmentVariable(..., 'User')` | Nothing. Local only, never in CI and never in the repo | Mint a new User Auth Token (`event:read` + `project:read` + `org:read`) in Sentry settings. Only `/sentry` breaks |

**The Apple certificate is recoverable but not free.** Reissuing the distribution certificate
invalidates the provisioning profile built against it, so both have to be regenerated together. The
provisioning profile also expires on its own, on 2027-07-26; a build after that date fails at the
archive with a signing error rather than anything that names expiry, so it is worth knowing in
advance.

**Android developer verification: already satisfied, no action pending.** Google auto-registered the
`com.kangentic.mobile` package on 2026-07-26 because it is already on Play, and confirmed it by email.
Nothing is required.

The same email carries a conditional "what you need to do" section about registering additional
signing keys and apps distributed **outside** Play, ahead of a September 2026 deadline. That is
addressed to developers shipping through other stores or by direct download. This project does not:
the only distribution channel is Play, and the `preview` and `e2e` APKs are sideloaded onto the
maintainer's own devices and CI emulators, which is self-testing rather than distribution.

Left here only so the next person reading that email does not re-derive it. If the project ever does
distribute outside Play, the upload key's fingerprint would need registering, and it is read with:

```
keytool -list -v -keystore <path to kangentic-upload.jks> -storepass <store password>
```

**Only the upload keystore is unrecoverable.** Everything else regenerates in minutes. GitHub
secrets are write-only once set, so they are not a backup: the local copy is the only readable
original. Back the keystore up off this machine (password manager or encrypted archive) - that is
the single point of failure in the whole setup.

**Two layers protect against committing one.** Filename globs in `.gitignore` (`*keystore*`,
`*service-account*.json`, `*.jks`, `secrets/`, `kangentic-secrets/`), and GitHub **secret scanning
with push protection**, which is enabled on this repo and matches on content rather than filename.
The second layer matters because the first is inherently leaky: Google Cloud names downloaded keys
`<project>-<hash>.json`, which no glob here matches. Verify a candidate filename with
`git check-ignore -v <name>` rather than assuming.

## Deployment tracks

### Android (Google Play)

The Play developer account is a **Personal** account created on 2026-07-20, which is after
Google's 13 November 2023 cutoff. That makes the closed-testing gate mandatory: **internal
testing does not count toward production access.**

| Track | Testers | Review | Status | Unlocks production? |
|---|---|---|---|---|
| Internal | up to 100, by email list | none, live in minutes | **v0.3.0 (vc3) released 2026-08-03**, one tester list | **No** |
| Closed (`alpha`) | 12+ required, opted in 14 continuous days | yes | not created | **Yes**, this is the gate |
| Open (`beta`) | unlimited, publicly discoverable | yes | not created | optional |
| Production | everyone | yes | locked until the closed test passes | n/a |

**"None, live in minutes" is the steady state, not the first time.** The first internal release on
a new app record is served under a temporary app name (`com.kangentic.mobile (unreviewed)`) while
the app is still `Draft`, and it can take hours to a couple of days before an opted-in tester can
actually install it. Verified 2026-07-29: the release read `Available to internal testers` in the
Console with the tester list saved and the correct account signed in on the device, and the Play
Store app still answered `Item not found`. Nothing in the Console fixes that window. Sideload a
`preview` APK if you need the build on a phone the same day, and note it is signed with a
different key than Play distributes, so the Play install needs the sideload uninstalled first.

The ladder, in order:

1. **Manual first upload.** A signed AAB through the Play Console UI by hand. Everything
   automated is blocked until this exists.
2. **Internal track.** Dispatch the workflow with `submit_track=internal`. Fast iteration with
   known devices.
3. **Closed track.** Requires every app-content declaration that internal testing lets you skip:
   store listing, content rating, data safety, target audience, ads, and a public privacy policy
   URL. **All of these were entered by 2026-07-29** (the en-US listing carries a 66-character short
   description, an 870-character full description, 4 phone plus 4 seven-inch plus 4 ten-inch
   screenshots, the icon, and the feature graphic; verified against `edits.listings` and
   `edits.images` rather than from memory). Entered is not submitted: they sit under
   **Changes not yet submitted for review** until `Send app for review` is pressed in Publishing
   overview, and that button stays disabled until the app dashboard reads 11 of 11.
   Build in CI, not locally on Windows, so the bundle carries every ABI.
   Then set the closed track's countries and regions and its tester list (neither is reachable
   through the Play API: `edits.testers` only exposes Google Groups, and Console email lists are
   invisible to it), promote the existing version code rather than cutting a new one, and recruit
   12+ testers and keep them opted in for 14 **continuous** days. Testers who opt out
   and back in reset the clock; the 14 days do not accumulate across gaps.
4. **Apply for production access.** Only after step 3 has genuinely held for 14 days. Play asks
   about the testing process and production readiness as part of the application.

Treat steps 3 and 4 as their own piece of work. The 14-day clock means production is at minimum
three weeks out from the day a closed test starts.

### iOS (App Store Connect)

Shorter and less gated than Play. There is no 12-tester, 14-day equivalent, and internal TestFlight
testing needs no review at all.

| Track | Testers | Review | Status |
|---|---|---|---|
| TestFlight internal | up to 100, must be App Store Connect users on the team | none | the target |
| TestFlight external | up to 10,000, by link or email | yes, a lighter Beta App Review | not started |
| App Store | everyone | yes, full App Review | not started |

The ladder:

1. **Upload a build.** `gh workflow run build-ios.yml -f target=device -f submit=testflight`. Unlike
   Play, the first upload can be automated: there is no "the API only works after a manual release"
   rule, only the requirement that the app record exists in App Store Connect, which
   `checkAppStoreBuild.mjs` checks for and names explicitly if it does not.
2. **Internal testing.** The build appears in TestFlight after Apple finishes processing, usually 5
   to 30 minutes. Internal testers can install it immediately.
3. **External testing** needs a Beta App Review, plus a description, feedback email, and beta test
   information.
4. **App Store submission** additionally needs screenshots, the privacy questionnaire, the age
   rating, and a resolved answer on export compliance.

Two things to settle before anything leaves internal testing:

- **`ITSAppUsesNonExemptEncryption` is set to `false` and that answer is not verified.** This app
  does not merely use OS-provided TLS; it implements its own Noise KK channel (X25519,
  ChaCha20-Poly1305, BLAKE2s) via `@noble`. Those are published standard algorithms, which is the
  usual basis for treating an app as exempt, but that is a reasoned default rather than a legal
  conclusion. TestFlight internal testing does not act on the value. See the comment in
  `app.config.ts`.
- **Remote push on iOS is unproven on hardware.** The Notification Service Extension now exists
  (`targets/nse/`) and its crypto is checked against `@kangentic/protocol` by the `NSE crypto
  (swiftc)` job, but that proves the decrypt, not the delivery. Nothing has yet confirmed that
  APNs invokes the extension on a real device, that the shared Keychain group resolves at
  runtime, or that the entitlement survived signing. Verify with a good blob FIRST - a changed
  title is self-evident proof the extension ran - and only then with a deliberately corrupt one,
  because a corrupt blob and an extension that never ran produce identical output.

## Environment Variables

Any variable prefixed `EXPO_PUBLIC_` is baked directly into the JS bundle at build time and is
**never** an appropriate place for a secret. There are no runtime secrets embedded in this app.
The one embedded credential is the Sentry DSN, and it is not a secret in this sense: a DSN is a
write-only ingest key that can submit a crash event and read nothing back. It is still kept out
of the repo, because a DSN committed to a public repo would route every fork's crashes into this
project's Sentry quota. See the Crash reporting section above.
Push credentials (FCM service account, APNs key) live only in the maintainer's EAS account,
uploaded at build time. The Android upload keystore and the Play Console service-account key live
in a directory outside the repo on the maintainer's machine, and are mirrored into GitHub Actions
secrets for CI release builds (see CI builds for the list). None of these ever land in the repo or
the shipped binary, and a GitHub secret is write-only once set, so the machine copies remain the
only readable original.

Build-time variables come from the `env` block of the `eas.json` build profile, resolved by
`scripts/easProfile.mjs`. That is the single source of truth for both a local `eas build` and the
CI workflow.

- `EXPO_PUBLIC_KANGENTIC_E2E=1` - set by the `e2e` profile. Marks the build as the Maestro E2E
  target.

Build-time variables that deliberately do NOT come from `eas.json`, because that file is
committed to a public repo (see Crash reporting above for why):

- `EXPO_PUBLIC_SENTRY_DSN` - from the `SENTRY_DSN` GitHub repository variable (a variable, not a
  secret: it ships in the bundle and is write-only). Unset means crash reporting is inert:
  `Sentry.init()` is never called and the native SDK never starts. Every build made from source
  is in that state.
- `SENTRY_AUTH_TOKEN` - from the GitHub secret of the same name. Not `EXPO_PUBLIC_`, so it is
  never inlined into the bundle. Read by `app.config.ts` at config-evaluation time to decide
  whether to include the Sentry config plugin, and by the plugin's Gradle/Xcode hooks to upload
  source maps.

Dev-only variables:

- `EXPO_PUBLIC_KANGENTIC_MOCK=1` - enables the in-app mock desktop peer (dev builds only; the
  code path is stripped from production bundles). Set by `npm run dev:mock`, not by hand.
- `EXPO_PUBLIC_KANGENTIC_E2E=1` - set by the `e2e` EAS profile, never by hand. It is the second
  build-time gate (alongside `__DEV__`) on accepting the Android emulator's `ws://10.0.2.2`
  host-loopback alias as a relay address, so a release-shaped Maestro build can pair with a
  local rig relay. It widens NOTHING else, and like every `EXPO_PUBLIC_*` value it is inlined at
  build time, so a `production` bundle has no such branch. See `docs/security.md`'s relay-scheme
  paragraph before touching it.
- `KANGENTIC_RELAY_REPO` - where `scripts/dev.mjs` finds the relay checkout; never read by
  the app bundle.

## Conventions

See `CLAUDE.md`'s Conventions section for the rules index (`.claude/rules/`).

## Documentation Maintenance

`/sync-docs` keeps `docs/` aligned with source once source exists; its targeted anchor check
also runs inside `/pull-request`. See `.claude/skills/sync-docs/SKILL.md`.
