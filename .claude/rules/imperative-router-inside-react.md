---
paths:
  - "src/navigation/**"
  - "src/notifications/**"
  - "src/connection/**"
  - "src/channel/**"
  - "src/demo/**"
  - "app/**"
---

# Rule: only code inside the mounted navigator calls the imperative router

`router.push` and `router.navigate` do not navigate. They append to
expo-router's `routingQueue` and return (`expo-router/build/global-state/router.js`). The queue is
drained inside a React effect in `NavigationContainerInner`
(`expo-router/build/imperative-api.js`), where `getNavigateAction` calls `store.assertIsReady()`
and throws *"Attempted to navigate before mounting the Root Layout component"* whenever no
navigator child has mounted yet. `isReady()` is literally `listeners.focus[0] != null`, i.e. "a
navigator has mounted and run its effect", not "the container exists".

On a native cold start that window is real and routinely hit: `ExpoRoot` wraps its content in a
`SafeAreaProvider` with no `initialMetrics`, and that provider renders **null children until the
OS reports insets**, while the navigation container above it has already attached its ref. So a
navigation enqueued before the first insets arrive is drained against a container that is mounted
but not ready. The drain effect sits above every route error boundary, so the throw reaches the
global handler and aborts the process. That was the iOS TestFlight cold-start crash on 0.6.3
build 13 (a notification tap, 452 ms into the process). **A `try/catch` at the call site cannot
help**, because the call itself never throws: the throw happens later, on a different stack. Two
separate call sites shipped exactly that catch, each with a comment claiming it handled the very
case it could not.

The platforms differ only in how the same defect surfaces. `getInitialURLWithTimeout` is
synchronous on iOS and a Promise on Android, so iOS mounts the container (ref set, not ready) and
**throws**, while Android early-returns its `fallback` (ref null) and **silently drops the
navigation**. An Android result therefore proves nothing about iOS here, and "it works on Android"
is not evidence.

## The rule

- **Never call expo-router's imperative `router` from outside the mounted navigator**: not from
  module scope, not from a bundle-entry handler, not from a notifee or expo-notifications
  callback, not from a lifecycle manager or a store subscription.
- **Publish the intent instead.** Add a variant to `PendingNavigation` in
  `src/navigation/pendingNavigation.ts` and call `publishPendingNavigation(...)`.
  `PendingNavigationRunner`, rendered in `app/_layout.tsx` as a sibling of the root `Stack`
  immediately after it, performs it from inside React.
- **Keep the runner a descendant of the navigation container, rendered after the navigator.** Its
  correctness comes from tree position, and from two facts: expo-router's drain effect lives
  further up the tree, so it runs after the navigator's own effect in the same commit; and passive
  effects flush child-first and in sibling order, so a sibling placed after `<Stack>` runs once
  the navigator has registered its focus listener. Moving the runner above the navigator
  reintroduces the crash. It is NOT a child of `<Stack>` and must not become one - `<Stack>`
  children are route declarations.
- **Do not add a `navigationRef.isReady()` guard to the runner.** It reads `false` there and
  always will: react-navigation registers the focus listener `isReady()` tests in a PASSIVE effect
  (`useFocusedListenersChildrenAdapter`) on the root navigator, an ANCESTOR of the root layout, and
  passive effects run child-first. A blocking guard would defer with no retry signal and drop the
  navigation. This looks like an obvious safety check and is a bug.
- **Consume the slot inside the effect that performs the navigation**, so a remount cannot perform
  it twice. The extra render with a null value is intended. **Perform the value the consume
  RETURNS, never the value closed over by the render**: a newer intent published between that
  render's commit and the passive-effect flush would otherwise be cleared by the consume while the
  older one is performed, inverting the slot's newer-supersedes-older invariant.
- Hooks and components are unaffected: `Stack`, `Link`, `useRouter`, `useLocalSearchParams`,
  `useNavigationContainerRef` are all fine anywhere they can legally render.

## Enforcement (self-maintaining)

- **Lint (live now):** `eslint.config.mjs` bans the `router` named import from `expo-router`
  outside `src/screens/**`, `src/components/**` and `src/navigation/**` (`no-restricted-imports`,
  `importNames: ['router']`). `Lint (ESLint)` is a required status check on `main`. Verified to
  fire by probe file in all four directions (banned dir errors; `src/notifications/**` keeps the
  router, Sentry and haptics bans simultaneously; `src/navigation/**` permits the router while
  still refusing Sentry and haptics), not assumed. **Mind the flat-config trap documented at the
  top of `eslint.config.mjs`:** options REPLACE rather than merge, so the allow entry for the
  three navigator directories must stay ordered last and must re-state every other ban that still
  applies there.
- **Test (live now):** `tests/unit/imperativeRouterConfinement.test.ts` scans `src/**` and
  `app/**`. It exists because `no-restricted-imports` matches import SYNTAX only, never
  `require()` and never a dynamic `import()` - and the second live instance of this bug reached
  the router through `await import('expo-router')`, which the lint rule cannot see. The scan
  covers both the dynamic routes and the static import, and asserts it found files to scan at all
  so a broken glob cannot pass vacuously.
- **Test (live now):** `tests/components/PendingNavigationRunner.test.tsx` pins that one publish
  performs exactly once, survives a remount, and works both when published before mount
  (cold start) and while already mounted (warm). Note the crash itself is NOT reproducible at any
  JS tier: expo-router supplies `INITIAL_METRICS` when `NODE_ENV === 'test'`, so the
  SafeAreaProvider gate that opens the window does not exist under jest. The tests pin the
  invariant, not the crash.
- **Review (live now):** the `expo-rn-reviewer` agent carries this rule as checklist item 10, so
  a call site the lint glob and the scan both miss is still caught at `/code-review` time. That
  backstop matters because a path-scoped rule loads when a matching file is READ, not when a new
  file is created in one of these directories.

## Scope

Authored code under `src/**` and `app/**` that is not rendered inside the root navigator.
`src/screens/**` and `src/components/**` render inside it by construction and are exempt;
`src/navigation/**` is the one place allowed to perform a published navigation. Does not govern
`app/+native-intent.ts`'s `redirectSystemPath`, whose timing expo-router owns (it must still not
throw - see the comment in that file).
