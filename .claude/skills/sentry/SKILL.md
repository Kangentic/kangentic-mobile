---
description: Investigate a Sentry issue - retrieve the issue, latest event, stack trace, tags and breadcrumbs from the kangentic org's `mobile` project and diagnose it. Use when a task or the user says to investigate/look at/diagnose a Sentry issue or link, or to check what errors are arriving.
allowed-tools: Read, Glob, Grep, PowerShell(Invoke-RestMethod:*), Bash(curl:*), mcp__kangentic__kangentic_search_tasks, mcp__kangentic__kangentic_create_task, mcp__kangentic__kangentic_update_task
argument-hint: [issue id, Sentry URL, or "any new issues?"]
---

# Sentry

Retrieve and diagnose issues from the `kangentic` Sentry org (`kangentic.sentry.io`). This
repo's project is `mobile` (numeric id `4511808149651456`); the desktop app's project (`desktop`,
`4511996066660352`) belongs to the desktop repo's own copy of this skill. Crash reporting is
wired in `src/observability/crashReporting.ts`; `.claude/rules/crash-reporting-scope.md` and
`docs/security.md` describe what gets captured and how.

This skill and the desktop repo's `/sentry` are deliberately separate copies (different
projects, different symbolication stories). Do not try to unify them.

## Auth (never print the token)

Requests need a bearer token. Resolution order, Kangentic-scoped on purpose so another repo's
generic `SENTRY_AUTH_TOKEN` is never picked up by mistake:

1. `$env:KANGENTIC_SENTRY_TOKEN`, if set.
2. **On Windows, this is usually the one that actually fires.** A User-level registry write
   (`[Environment]::SetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN', <value>, 'User')`) is
   invisible to a running process's `$env:` until the process tree that spawned it restarts -
   Claude Code inherits the environment of the host app or terminal that launched it, not a
   live view of the registry (the same mechanism as the PATH gotcha in
   `docs/developer-guide.md`'s "Agent tooling (MCP servers)" section). So check the registry
   value explicitly:
   `[Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User')`.
3. The `token = ...` line in `~/.sentryclirc` (the CI sourcemap-upload token; reading issues
   with it usually 403s).

Read the token into a shell variable and pass it as a header in the SAME command; never echo
it, never write it to a file, never include it in a reply, a task, or a commit.

**Never `Read` `~/.sentryclirc`.** That would put the token in the transcript permanently.
Dereference it inside a single PowerShell expression instead - see the pattern below.

**The whole block runs as ONE PowerShell call, and that is forced.** Shell state does not
persist between tool calls, so a token resolved in one call is gone by the next; resolution and
the request have to share an invocation. The consequence is that the command starts with
`$token = ...` rather than with `Invoke-RestMethod`, so it does not prefix-match this skill's
`PowerShell(Invoke-RestMethod:*)` declaration and **may prompt for approval on first use. That
is expected, not a misconfiguration** - approve it rather than splitting the block to dodge the
prompt, which would either strand the token or force echoing it between calls. Every other
skill here declares a bare-cmdlet-first command because none of them carry a secret across
statements; this one does, and the declaration stays narrow deliberately.

Scopes needed: `event:read` + `project:read` + `org:read` (a User Auth Token from Settings >
Account > API > Auth Tokens; assigning and resolving issues additionally need `event:write`.
This skill assigns but never resolves - see Boundaries). A `403` from every endpoint means the
stored token is the CI-scoped one (`org:ci`, upload-only): stop and ask the user to mint a
read-scoped token rather than retrying. A `403` on the assign PUT alone means the token is
read-only: report the issues you could not mark and carry on, never let it block the triage.

## Retrieval

Parse the issue id from a pasted URL: `https://kangentic.sentry.io/issues/<ISSUE_ID>/?...` (a
`project=` query param, if present, is the numeric project id).

PowerShell pattern (one call per request, token resolved and dereferenced in the same
expression - substitute the endpoint):

```powershell
$token = $env:KANGENTIC_SENTRY_TOKEN
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User') }
if (-not $token) { $token = ((Get-Content "$env:USERPROFILE\.sentryclirc") | Where-Object { $_ -match '^token\s*=' }) -replace '^token\s*=\s*','' }
Invoke-RestMethod -Uri 'https://sentry.io/api/0/organizations/kangentic/issues/<ISSUE_ID>/' -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
```

macOS/Linux (Bash, one command): `curl -s -H "Authorization: Bearer $KANGENTIC_SENTRY_TOKEN" <url>`.

Endpoints, always by **numeric project id, never the slug** - the slug already renamed once
(`react-native` to `mobile`, 2026-08) and can again:

| What | Endpoint |
|---|---|
| Issue summary (title, culprit, count, userCount, firstSeen/lastSeen, level, substatus) | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/` |
| Latest event (stack trace, tags, breadcrumbs, contexts, release) | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/events/latest/` |
| All events for the issue | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/events/` |
| Search issues (mobile project) | `GET /api/0/organizations/kangentic/issues/?project=4511808149651456&query=is:unresolved&statsPeriod=90d&sort=date` |
| Assign an issue (the triage marker, see below) | `PUT /api/0/organizations/kangentic/issues/<ISSUE_ID>/` body `{"assignedTo":"user:<USER_ID>"}` |
| Org members (read `user.id` for the actor above) | `GET /api/0/organizations/kangentic/members/` |

The latest-event payload is large; extract what you need rather than dumping it: `entries`
with `type: "exception"` carries the stack frames, `type: "breadcrumbs"` the trail, `tags`
carries `environment`, `release`, and the per-install identifier under `user.id` (see
Diagnosis below - it is not always present, and its presence is itself diagnostic).

## The two flows

### "Any new issues?" (triage scan)

Query both tiers and treat them differently - conflating them hides real backlog:

1. `is:unresolved is:for_review` - Sentry's needs-triage bucket.
2. `is:unresolved` - the full open set.

**An empty tier-1 result does NOT mean nothing is wrong.** Issues age out of `is:for_review`
into `substatus: ongoing` while staying unresolved; tier 1 can be empty while tier 2 holds a
real, untracked backlog. The answer to "any new issues?" is **tier 2's untracked issues** (see
the duplicate guard below) - report that as the headline. State the tier-1 count as a separate
supporting line, never lead with it, and never report "0 new issues" off tier 1 alone.

Filter noise by environment. `crashReporting.ts` sets exactly three environment values, not
two: `development`, `e2e`, or `production`. A Maestro APK is release-shaped (`__DEV__` is
false) and reports as `e2e`, which is exactly as much noise as `development` - a dispatched
E2E run is not a user's device. Query with `&environment=production` to get user-facing issues
only. If dev/e2e issues are worth mentioning at all, report them in a clearly separate block,
never interleaved with production issues.

Verify the environment filter actually narrows the result before trusting it silently - the
same query with and without it can return an identical set for reasons other than the filter
being live (e.g. every current issue genuinely being production). If it looks inert, fall back
to reading `environment` off each issue's latest event instead of the query param.

Per-issue line: shortId, title, count, userCount (affected installs), firstSeen, level, and the
link (`https://kangentic.sentry.io/issues/<id>/`).

**The duplicate guard must search both shortId prefixes.** Sentry derives an issue's shortId
from the project's **current** slug, computed live, not fixed at creation time. This project's
slug renamed `react-native` to `mobile` in 2026-08, which silently rewrote every pre-rename
issue's shortId from `REACT-NATIVE-N` to `MOBILE-N`. Board tasks filed before the rename still
carry the old prefix in their titles (e.g. task #48 titles `REACT-NATIVE-3/4/5`, which Sentry
now reports as `MOBILE-3/4/5`). So for an issue Sentry reports as `MOBILE-N`, search
`kangentic_search_tasks` for **both** `MOBILE-N` and `REACT-NATIVE-N`; a hit on either prefix
means it is already tracked. Skipping this re-files every pre-rename issue as new. Note the
search covers completed tasks too - a completed task means the issue was already handled, so if
Sentry still shows it unresolved, say that explicitly rather than silently dropping it from the
report.

**Read `assignedTo` as the second half of that guard.** Assignment is this skill's triage
marker: an assigned issue has been looked at and has a board task. It is a cheap pre-filter that
survives the shortId rename problem entirely, since it lives on the issue rather than in a task
title. Do not let it replace the search, though. Assignment can be stale, and a task can exist
without one. An assigned issue is simply never reported as new.

A completed task plus a still-recurring issue is the case worth calling out loudest: check the
event releases against the build that carried the fix before saying it is handled. Task #48 is
the precedent - it fixed MOBILE-3, and MOBILE-3 crashed again on a later build that contained
the fix.

### "Investigate this issue" / "create a follow-up task"

Retrieve the issue and its latest event, diagnose it (below), and create a task **only when
asked**. Duplicate-guard first, both prefixes, exactly as above - never re-report or re-file an
issue a search already finds.

One task. Column **`To Do`** (this board has no Backlog column). Title:
`Fix MOBILE-N: <issue title, trimmed>`, using the issue's **actual, current** shortId - never
assume the prefix without checking. Description: the Sentry link, shortId, level, event and
affected-install counts, environment, release, the diagnosis, and only the specific stack
frames or tags that carry it, not a raw event dump (see Boundaries).

MCP gotcha, same as other skills that file tasks: when a `create_task` call carries both a long
description and `labels`, the labels can be dropped. Create the task first, then set labels in
a separate labels-only `kangentic_update_task` call.

**Then assign every issue the task covers**, using the PUT in the endpoint table above. Filing a
task and leaving the issue unassigned means the next sweep re-derives the whole cross-reference
from scratch, which is exactly what the marker exists to prevent. Rules:

- Assign after the task is created, never before, so a failed create cannot leave a false marker.
- One task can cover several issues. Assign all of them, not just the one that named the task.
- Assign issues covered by an EXISTING task too when a sweep turns one up unassigned. The signal
  is only useful if it is complete.
- Never assign an issue with no board task, and never assign `development` or `e2e` noise. An
  unassigned issue must keep meaning "nobody has dealt with this".
- Resolve nothing. Assignment leaves the issue in the unresolved stream where a recurrence stays
  visible, which is the point: a fix that does not hold shows up as new events on an assigned
  issue instead of disappearing.

No `attachments` step here, unlike a video-review task: a Sentry issue has no local artifact to
attach, and attaching a raw event export would violate the no-raw-payload rule below.

A `DESKTOP-*` issue is out of scope - it belongs to the desktop repo's own `/sentry` copy and
its own board.

## Diagnosis (mobile specifics)

- **Native vs JS, one-field discriminator.** A native-captured event carries `platform: java`
  and `mechanism: UncaughtExceptionHandler`, native auto-breadcrumbs (`app.lifecycle`,
  `device.event`, `network.event`), and a `user.id`. A JS-caught event has no `user`,
  `request`, `extra`, or `server_name` at all - `scrubEvent` strips them, and `beforeSend`
  never runs for a native-captured event in the first place. So: an event carrying `user` was
  captured natively; one without was captured in JS.
- **Symbolication is four independent paths, all gated on the build's `SENTRY_AUTH_TOKEN`.**
  JS frames (both platforms) resolve only for a release whose Hermes sourcemaps were uploaded
  by the `@sentry/react-native` build integration; an unsymbolicated frame shows the constant
  bundle name (`app:///index.android.bundle` / `app:///main.jsbundle`) - that is the reporting
  path working as designed, not a broken upload. Android Java/Kotlin frames resolve via the R8
  `mapping.txt`, uploaded by the Sentry Android Gradle Plugin. Android native (`.so`) symbols
  are **deliberately never uploaded** - an NDK frame will never resolve; do not read that as a
  failed upload. iOS dSYMs are wired but not yet round-trip verified against a real crash. A
  `development`-profile build is the debug variant where R8 never ran, so a readable Java frame
  there proves nothing about the mapping upload.
- **Two known signatures, worth recognizing rather than re-deriving:**
  - A GWP-ASan SIGSEGV (`gwp_asan::GuardedPoolAllocator::deallocate` under
    `android_unsafe_frame_pointer_chase`, `libhermesvm.so` frames beneath, zero app frames) is
    **not a detection** - it is the sampling allocator crashing during its own bookkeeping, not
    an error it found. Suppressed for the e2e APK only; whether it occurs at a meaningful rate
    on production `user` builds is still open.
  - An `OutOfMemoryError` whose Sentry grouping title mentions
    `JSApplicationIllegalArgumentException ... 'backgroundColor' ... RCTView` is a red herring -
    that is the third link in a `Caused by` chain, not the cause. The actual root cause (tracked
    as task #62 at time of writing): every session-screen open leaks its xterm WebView and view
    subtree, which nothing ever releases. Cross-check `firstSeen`/build version before assuming
    a fresh event is the same root cause - it may already be fixed.
- **Read the breadcrumbs before reasoning about the code.** On a native-captured event
  (`mechanism: UncaughtExceptionHandler`) sentry-android's own auto-breadcrumbs ride along
  unfiltered, so every such event carries a free **lifecycle timeline**: `app.lifecycle`
  foreground/background transitions, `ui.lifecycle` activity states, `device.event`
  (`SCREEN_ON`/`SCREEN_OFF`, `LOW_MEMORY`, battery), `device.orientation`, and `network.event`.
  `.claude/rules/crash-reporting-scope.md` documents these as a privacy LIMITATION; they are also
  the cheapest diagnostic available, and worth reading first on anything lifecycle-shaped (a
  background service, a startup crash, a leak). MOBILE-3 is the precedent: two builds were spent
  guessing at mechanisms, and the breadcrumbs settled it in minutes by showing the app went to
  background and never returned while the process stayed alive 7h10m and 14h14m. Note the
  timestamps come back in local time from the API - convert to UTC before subtracting, or the gap
  is wrong by the offset. A `device.orientation` breadcrumb also implies the display was ON, which
  is how that issue ruled out a timer-starvation theory.
- **Cross-reference locally before concluding.** `Grep` the screen or module named by the top
  frame and read it. `.claude/rules/crash-reporting-scope.md` documents this project's privacy
  controls and their known limitations in detail - read it rather than restating it here.

## Boundaries

- Diagnose and report; fix only when the task explicitly asks for a fix.
- Reads need no ceremony. **Writes are explicit-request-only, with one carve-out**: do not
  resolve, ignore, archive, edit alert rules, or trigger a Seer/autofix run on an issue unless
  the user asks for exactly that. This mirrors the Sentry MCP policy in `CLAUDE.md`'s
  cloud-spend section, which applies to this skill's direct API calls just as much as to the MCP.
- **The carve-out is assignment**, and only for an issue you just filed a board task for. That
  write is sanctioned and expected, no separate ask needed: it is the marker that makes the next
  triage sweep cheap. It is also the safest of the writes, since it hides nothing and changes no
  alerting.
- Create a follow-up board task only when asked ("create a follow-up task" style requests).
- **Never paste a raw event payload, or a `user.id` / `contexts.device.id` value, into a task,
  commit, PR, reply, or artifact.** Quote only the specific frames and fields that carry the
  diagnosis. Crash events are app data; a native-captured event's `user.id` is a per-install
  identifier that this app's own privacy documentation discloses rather than suppresses (see
  `.claude/rules/crash-reporting-scope.md`) - cite `userCount` (affected installs) instead of
  the identifier itself.
- This repo also has a Sentry **MCP** server wired (`.mcp.json`), which this skill deliberately
  does not use: it requires an interactive OAuth per session. Its URL is also slug-scoped rather
  than org-scoped, so it goes stale on a project rename - it was pinned to the pre-rename
  `react-native` slug, which task #63 corrects. **Read the URL out of `.mcp.json` before
  believing either state**, and do not "simplify" this skill by switching it to the MCP without
  re-checking both points.
