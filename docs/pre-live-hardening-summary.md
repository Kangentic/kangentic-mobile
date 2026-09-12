# Pre-live hardening: what was verified, and what was not

Board task #14, branch `pre-live-hardening-t-bfaf877d`. This is the on-device baseline the task's
definition of done asks for: what is proven, what is reasoned, and what is still open. It is
deliberately explicit about the difference.

## Verified on real hardware

**Pixel 10 Pro, paired to the real desktop through the real QR + SAS ceremony**, over a local
relay at `ws://127.0.0.1:8080` via USB `adb reverse`.

- **The 0.9.0 board projection, end to end.** Across 15 projects the board holds 5 tasks - 3 + 1
  + 1 and zero elsewhere - exactly matching the 5 live sessions. Under the previous full
  projection that was 34 tasks. Measured payload: 15 projects **63 kB -> 12 kB** compressed, and
  the busiest project's per-board-change **17.7 kB -> 4.6 kB**.
- **The feed stays live with no terminal open.** All 5 sessions `feedStatus: "live"`, three
  thinking, unread counts climbing, on list-only subscriptions. This is the real-desktop
  counterpart to a `mockDesktop` bug fixed in this branch, where the same condition froze the
  entire simulated agent.
- **Terminal rendering on real hardware**, including the wide-park (308-col) case that broke the
  emulator: Pixel WebView `MAX_TEXTURE_SIZE` is 8192 against the emulator's 4096, the font cap
  provably engages, WebGL is active, and a full keystroke round-trip (up-arrow -> PTY ->
  `History 2/2` recalled -> redraw) works against a real TUI.
- **Native sheets, tabs and the rebuilt surface switcher**, exercised by hand during the
  migration.

**Android emulator, e2e release build, paired to the stub peer**

- **The paired Maestro suite: 11/11 in 8m 37s**, against a release-shaped e2e APK, not a dev
  client. `approve-permission`, `board-create-task`, `board-delete-task`, `board-edit-task`,
  `board-move`, `chat-fallback-reading-view`, `home-needs-you-approve`, `open-task-from-triage`,
  `session-ended-state`, `session-mode-toggle`, `session-respawn-recovery`. Two of these are
  load-bearing for this branch: **`session-ended-state`** is the regression that opened the task,
  now proven on a device for the first time, and **`session-mode-toggle`** covers the rebuilt
  surface switcher.
- **The pairing ceremony against a release-shaped binary** - paste link, submit, SAS accept, and
  the stub's session row landing on the Agents feed.

## Verified by test only, not on a device

- Everything under `tests/unit` (437) and `tests/components` (252).
- **One coverage boundary worth naming:** RNTL never fires `onLayout`. The session switcher's
  indicator reads its geometry from `onLayout`, so its mount behaviour is invisible to the
  component tier - a real bug there (the indicator sliding in from the wrong segment) was found
  by review, not by tests, and cannot be caught by them.

## NOT verified, and why

- **iOS: builds, launches, and renders - nothing beyond that.** Since this section was first
  written, iOS went from never-compiled to compiling, signing, and uploading on a free GitHub
  Actions macOS runner, and it has been seen launching and rendering in a simulator (screenshot
  evidence). What that does NOT cover is every iOS-specific runtime risk that matters here. The
  largest is the terminal, a `WKWebView` running xterm.js with WebGL, still entirely untested on
  the platform. Notifications remain Android-only by design (`src/notifications/index.ts` returns
  early off Android only for the genuinely Android-only pieces: the foreground service, the
  Notifee background task, and the channel definitions. The iOS Notification Service Extension
  (`targets/nse/`) has since shipped, so on-device decrypt now covers both platforms - though the
  extension has never run on a physical iPhone. Its crypto is proven against
  `@kangentic/protocol` in CI; delivery is not. No iOS device has
  ever paired, connected to a relay, or rendered a real session.
- **`expo-router/unstable-native-tabs`** carries a vendor warning that its API may change in a
  minor version. Adopted deliberately for iOS native feel.
- **Remote push** end to end, which needs FCM credentials and a real push round trip.
- **The desktop's per-device connection badge.** After a successful pairing the desktop lists the
  phone under Paired Devices but shows it as "Connecting..." while the session is established and
  serving board data. Same staleness the quick-pair entry shows ("Reconnecting..." over a healthy
  session). Desktop-side display only - the phone reports `established: true` and renders content
  fetched over that channel - so it is a `kangentic` repo fix, not a mobile one.
- **Network transitions.** Wifi to cellular handover, a long background, and phone-sleep
  reconnect have never been exercised against the hosted relay; all live testing so far kept the
  phone on USB.

## Fixed in this branch, worth knowing about

**Security.** `isSecureRelayAddress` accepted `ws://127.0.0.1:8080@evil.test`. Everything before
an `@` in a URL authority is userinfo, so that address dials **evil.test**. One crafted QR field
routed the whole ceremony through an attacker-chosen host, and `activePairing` then persisted
that host to the trust anchor for every later session. At the time it was worse still, because
the pairing token was also dialed verbatim as the relay slot while being the Noise PSK, so the
PSK went out in cleartext too; protocol 0.12.0 closed that second exposure by deriving the slot,
and the host-pinning problem this paragraph describes is the part that was never about the slot.
The loopback list was not behind the dev gate, so this applied to production builds. Now parses
the authority rather than prefix-matching. The same fix landed upstream in `@kangentic/protocol`
0.11.1 (`relay-address.ts`), which the desktop reads, so both ends enforce one definition; the
phone keeps its own copy only for the `10.0.2.2` emulator carve-out, which is mobile-only.

**Correctness.** A stale `read-board` response could revert an upgraded board to the filtered
projection (no post-await staleness guard, unlike `subscribeDiff`). `applySnapshot` could
resurrect a session already reported `ended`. The session screen lost its ended state entirely
once the 0.9.0 projection dropped the task from the board - the bug that opened this task.

**Platform.** `keyboardShouldPersistTaps` was missing on four scrollables, so the first tap on a
control was spent dismissing the keyboard - including **Approve/Deny on permission prompts**, the
single worst control in the app to need two taps.

## Deferred, with reasons

- **Native stack headers** (the last item of the native-migration pass). Evaluated, not done.
  The tab roots' header carries the brandmark and is deliberately merged with the board's column
  chips into one surface, which a native header cannot do; and the session header hosts live
  agent status. Defensible either way, and it needs on-device iOS judgement that is not
  available. Not a silent skip - a decision.
- **Left/right arrows in the terminal quick keys**, dropped for touch size (eight shares left
  40dp per key on a 360dp phone, under the 44pt minimum) and because they edit inside an input
  line, which is keyboard-up work anyway.
- **A sticky `Ctrl` modifier** (the Blink/Termius pattern). It would need the keyboard raised to
  press the letter, which is the wrong cost for an interrupt. `Ctrl+C` stays hardcoded, matching
  how TeamViewer treats Ctrl+Alt+Del.
- **`.maestro/paired/home-needs-you-approve.yaml` selects on copy text** (`"Approve:.*"`) rather
  than a testID. The Home row has no structural prompt-pending signal by design - uniform inbox
  styling is the product decision - so honouring the rule means adding a marker to production
  render purely for a test.

## Verified against the live desktop, after the bridge landed

- **The Done column**, showing real completed tasks newest-first with a count matching the
  desktop's own Completed list.
- **A completed task's summary**: timeline, agent-active duration, model, cost, tokens, files
  and lines changed, tool calls - checked against the desktop's SESSION SUMMARY panel.
- **A completed task's CONVERSATION**, rendered in full with no agent running. This was the
  load-bearing claim of the whole feature and the last one resting on reasoning.
- **The grouped project switcher**, mirroring the desktop sidebar's groups and membership, with
  per-project agent counts.

Three mobile-side defects sat between a working desktop and a working screen, all invisible from
the desktop end: a Zustand selector building a fresh object per call (infinite render loop),
nothing triggering the FIRST transcript fetch for a never-subscribed session, and
`transcriptStore.applyWindow` silently discarding any window whose session is not retained. That
last one is worth remembering: the desktop returned all 418 entries and the phone binned them,
which is indistinguishable from a desktop that returned nothing.

## The production pairing ceremony, verified on the hosted relay (and the two bugs that blocked it)

Desktop QR -> camera scan -> SAS confirm -> enrolled device -> established session, over
`wss://relay.kangentic.com` on a physical Pixel. This path had **never completed against a real
desktop**, and nothing in the suite could have said so: every green pairing result came either
from a stub that skipped the final step or from the dev quick-pair path that bypasses the
ceremony entirely.

1. **The phone never sent the confirm frame.** `PairingMachine.confirm()` set its own state to
   'paired', closed the transport, and sent nothing, while the desktop's `pairing-service.ts`
   waited in its `sas-pending` phase for a sealed frame it would never get. The handshake `split`
   needed to seal that frame was being computed and discarded. The phone pinned a trust anchor
   and declared success; the desktop never enrolled the device and never dialled the session, so
   the phone waited forever on "Connecting to your desktop".
2. **A dropped pairing socket looked like nothing at all.** The machine failed only on transport
   state `closed`, which `RelayTransport` reaches solely via an explicit `close()`. A socket that
   died mid-ceremony went `reconnecting` then `connected` again, unnoticed - and a pairing socket
   is not resumable, because the relay tears the peer down when either side drops and the token
   is single-use. The confirm frame went into an emptied slot and the phone reported success
   anyway.

Both are fixed and mutation-tested. `StubPairingResponder` and `scripts/stubDesktopPeer.mjs` now
require the confirm frame to arrive AND open, so the divergence that hid bug 1 cannot silently
return; `LoopbackTransport.simulateReconnect()` makes bug 2's `reconnecting` path expressible in
a test at all. The drop message now names the relay's close code, because "peer left" (4000),
"slot busy" (4409), "park timeout" (4408) and "idle timeout" (4410) present identically and have
unrelated causes.

## Verified against the HOSTED relay

The Pixel talking to the desktop over `wss://relay.kangentic.com`: session established three
times across restarts, a full board (15 projects) read over the wss channel, and the connection
holding across a rekey. This is the first evidence for anything off loopback - real TLS, real
latency, and the relay-address rules that the `ws://10.0.2.2` dev carve-out bypasses. Reached
via quick-pair, so the CEREMONY over that path remains unverified (see "NOT verified").

`rekeyCount` reading 0 was what exposed a defect in the gauge, not in the rekey. It was
incremented inside `markEstablished`, guarded on the session already being established - but
`markEstablished` only ever runs from `onEstablished`, which by design never re-fires on a rekey,
and a transport drop clears the flag before the next handshake. Both paths missed, so it read 0
forever and looked exactly like a re-handshake that never happened. `SessionManager.onRekey` now
carries the signal; it reached 1 over the hosted relay with the session intact.

## Protocol 0.10.0, 0.11.0, 0.11.1, 0.12.0 and 0.13.0 (published)

Desktop PR **#209** merged and `@kangentic/protocol` **0.10.0** published via the
`protocol-v0.10.0` tag. `read-board` gains an `archived` action returning a page of completed
tasks plus each one's lifetime session summary, and `read-stream`'s `transcript-window` no longer
requires a live session - it never used one, it merely sat below a live-session gate, which made
a finished conversation permanently unreadable.

**0.11.0** (PR #210) adds the desktop's project groups to the project listing, so the phone's
switcher mirrors the desktop sidebar instead of showing one flat list of every project on the
machine. **0.11.1** (PR #211) is the security fix below.

Additive throughout, so `PROTOCOL_VERSION` stayed at `2` across all of them and no handshake
changed. Mobile typechecks against the registry copy rather than the dev rig's local link,
which is what CI actually installs.

**0.12.0** (desktop PR #265) broke that streak, and is the reason the pin read `^0.12.0` for as
long as it did.
It derives the pairing relay slot from the pairing token (`derivePairingSlotId`) instead of
dialing the token verbatim as `?slot=`, because the token is simultaneously the Noise `IKpsk0`
pre-shared key: publishing it in a request URI meant whatever terminates TLS on a hosted relay
saw the PSK, degrading `IKpsk0` to plain `IK` for such an observer. A slot derivation is
zero-negotiation, so `PROTOCOL_VERSION` went `2` -> `3` to turn a silent never-rendezvous into
a `version-incompatible` result at QR-scan time. **That took every existing pairing offline
until both ends updated**, since the version is bound into the KK session prologue as well as
the pairing one. It did NOT invalidate them: no protocol version is stored beside the pinned
identity on either side, so the pinned keys reconnect once the software matches, with no repeat
of the QR/SAS ceremony. See `docs/security.md`'s Relay slots section, and the
`PROTOCOL_VERSION` discussion in `docs/developer-guide.md` for why the desktop's "must re-pair"
phrasing overstates it.

**No relay change was needed for any of them, 0.12.0 included.** The relay forwards ciphertext
only and never parses a capability payload; its slot pattern already accepts 32 hex characters,
which is what both derived slots now produce, and its frame cap sits far above these payloads.

**0.13.0** returns to additive: `BoardTaskWire.pr_merge_readiness` (a linked PR's normalized
merge verdict) and `BoardColumnWire.spawns_session`, with `PROTOCOL_VERSION` staying at `3`. The
pin now reads `^0.13.0`, which matters more than the version alone suggests: a caret on a `0.x`
version means `>=0.13.0 <0.14.0`, so `^0.12.0` EXCLUDED 0.13.0 outright. A local tarball in
`node_modules` satisfied the new field while `npm ci` in CI installed 0.12.0 without it, and
`npm run check:install` cannot see that split, because the installed version still sat inside the
declared range. The lockfile diff was the only evidence.

The version was also bumped in the desktop repo months before it was ever tagged, so the package
sat unpublished while mobile developed against that tarball. `/release-protocol` skips its own
version-bump step in exactly this case; what was missing was the changelog entry, the
`protocol-v0.13.0` tag, and the push that triggers `publish-protocol.yml`.

## The relay-address hole, closed at the source

`isSecureRelayAddress` accepted `ws://127.0.0.1:8080@evil.test`. This branch hardened the
phone's copy early on, but the shared module in `@kangentic/protocol` kept the flaw until
0.11.1 - and the desktop reads its half from there, so the desktop stayed exposed while the
phone was safe.

Fixing it upstream, the desktop's existing suite caught a REGRESSION in that first fix:
`hostWithoutPort` truncated at the closing bracket, so `ws://[::1]evil.com` read as the host
`[::1]`. Narrower than the original hole, same kind, and present in the mobile copy too - where
no test covered it, which is exactly why it survived there. Both ends now parse the authority
and both suites cover userinfo, the bracket boundary, and prefix lookalikes.

## Cross-repo work shipped

Desktop PR #205 merged and `@kangentic/protocol` **0.9.0** published: `read-board` takes
`view: 'full' | 'sessions'`, returns `taskCountsByColumnId`, and `backlog` became optional.

Two bugs handed to the desktop board: **#431** (Mobile Devices "Pair a device" no-ops after the
QR dialog is closed once) and **#432** (pairing UX and capability model).

## Tooling unblocked

**Local Android builds now work**, which they did not for most of this task. At the time, any
build from `.kangentic/worktrees/<branch>/` died on a Windows path-length limit at every variant,
and the workaround was to build from a separate checkout at a very short path.

This is what made the e2e APK - and therefore this document's Maestro results - possible at all.

> **Superseded 2026-07-31, and the recipe deliberately removed.** The separate short-path
> checkout is gone and must not be recreated: `plugins/withAndroidCmakeBuildStaging.ts` relocates
> CMake's staging directory out of the checkout, so a build runs from a normal task worktree at
> any depth. The diagnosis recorded at the time was also wrong in two ways. It named
> `react-native-screens` and `react-native-worklets`, which both build fine at 73 characters; the
> binding modules are `react-native-reanimated` and `expo-modules-core`. And it described one
> failure where there are two, the first being ninja stat-ing the prefab config through a `..`,
> which fails with `still dirty after 100 tries` and names nothing. Current account:
> `docs/developer-guide.md`'s "Local Android builds work from any path".
