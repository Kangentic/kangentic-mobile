import expoConfig from 'eslint-config-expo/flat.js';
import { defineConfig } from 'eslint/config';

// Hoisted because it has to appear in TWO config entries. Flat config's
// last-match-wins REPLACES a rule's options wholesale rather than merging them,
// so any later entry that sets `no-restricted-imports` for a file silently drops
// every earlier ban on it - and the crypto/push directory entry below overlaps
// the haptics glob. Restating it there keeps both live; sharing one array keeps
// the two copies from drifting.
const restrictedHapticsImportPaths = [
  {
    name: 'expo-haptics',
    message:
      "Call triggerHaptic(cue) from '@/lib/haptics' instead of expo-haptics directly - the HapticCue union is the app's closed vocabulary. See .claude/rules/motion-conventions.md.",
  },
];

// expo-router's imperative `router` singleton is confined to the directories
// that render inside a mounted navigator. Hoisted because it appears in THREE
// entries for the last-match-wins reason above.
//
// `router.push`/`navigate` do not navigate: they append to expo-router's
// routingQueue and return. The queue is drained inside a React effect that
// calls `store.assertIsReady()` and throws 'Attempted to navigate before
// mounting the Root Layout component' when no navigator has mounted. On a
// native cold start that window is real, the drain sits above every error
// boundary, and the throw aborts the process - the iOS 0.6.3 build 13
// TestFlight crash. A try/catch at the call site cannot help, because the call
// itself never throws.
//
// Note this catches STATIC imports only. `no-restricted-imports` never matches
// `require()` or a dynamic `import()`, and the second live instance of this bug
// reached the router via `await import('expo-router')`. That hole is covered by
// tests/unit/imperativeRouterConfinement.test.ts, not by this rule.
const restrictedRouterImportPaths = [
  {
    name: 'expo-router',
    importNames: ['router'],
    message:
      "Publish to the pending slot in '@/navigation/pendingNavigation' instead of calling expo-router's imperative router here - outside a mounted navigator it enqueues a navigation that throws fatally when drained. Hooks and components (Stack, Link, useRouter, useLocalSearchParams) are fine. See .claude/rules/imperative-router-inside-react.md.",
  },
];

// The two motion `no-restricted-syntax` bans, hoisted for the same reason as
// the haptics paths above: each appears in more than one entry, and a copy that
// drifts is a ban that quietly stops matching.
//
// Two selectors per ban, not one. `CallExpression[callee.name=...]` matches only
// an unqualified call, so a namespace import - `import * as Reanimated` then
// `Reanimated.useAnimatedProps(...)` - has a MemberExpression callee and slips
// straight through. That form is already the house style in this repo's test
// files, so it is a plausible thing to write in `src/` next. Verified with a
// probe file: the unqualified call errors, the namespaced one did not until the
// second selector was added.
const restrictedAnimatedPropsMessage =
  "useAnimatedProps re-renders the target library every frame (~8 CPU points per icon, measured). Animate a native view's transform/opacity via useAnimatedStyle instead, or add a narrow override for this file with the argument for the cost. See .claude/rules/motion-conventions.md.";
const restrictedAnimatedPropsSyntax = [
  { selector: "CallExpression[callee.name='useAnimatedProps']", message: restrictedAnimatedPropsMessage },
  { selector: "CallExpression[callee.property.name='useAnimatedProps']", message: restrictedAnimatedPropsMessage },
];
const restrictedBezierSyntax = [
  {
    selector: "CallExpression[callee.object.name='Easing'][callee.property.name='bezier']",
    message:
      "Use bezierEasing(theme token) from '@/components/motion/presets' instead of a raw Easing.bezier() spread - literals creep into hand-spelled control points. See .claude/rules/motion-conventions.md.",
  },
];

export default defineConfig([
  {
    // .kangentic/ holds the desktop app's live session state for this project
    // (gitignored, and its in-use files EPERM on scandir under Windows).
    // scripts/xterm-page/ holds the WebView page's glue fragments: plain
    // browser scripts that scripts/buildXtermHtml.mjs concatenates into ONE
    // IIFE, so their top-level vars are shared page state that a per-file
    // linter can only read as no-undef/no-var noise. They were unlintable
    // before too (the glue lived inside a template literal); the build's
    // per-module syntax compile and tests/unit/xtermPageScripts.test.ts are
    // what cover them.
    ignores: [
      'dist/**',
      'node_modules/**',
      '.expo/**',
      'ios/**',
      'android/**',
      '.kangentic/**',
      '.devrig.local.json',
      'scripts/xterm-page/**',
    ],
  },
  ...expoConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Crash reporting is a data-egress path, so it gets exactly one door.
    // src/observability/ owns the Sentry client and the only place its
    // privacy options can be set; anywhere else importing the SDK could
    // re-enable a default (console breadcrumbs, screenshots) that the init
    // deliberately turned off, or capture an event that never passes
    // through the configured scrubber.
    // See .claude/rules/crash-reporting-scope.md.
    // allowTypeImports because a `import type` is erased at compile time and
    // cannot capture anything at runtime - tests/unit/scrubEvent.test.ts needs
    // Sentry's Event/Breadcrumb types to build its fixtures, and redeclaring
    // them locally would let them drift from the SDK silently.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/observability/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              allowTypeImports: true,
              message:
                'Import Sentry only in src/observability/. Everywhere else, crash reporting is automatic via the global handler - see .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // index.js is the bundle entry and is plain JS, so it gets the base rule.
    // `.mjs` and `.cjs` are in the glob because scripts/ is entirely `.mjs`: a
    // `**/*.js` glob does not match it, which would leave ~15 build-time scripts
    // outside the "one door" ban while the rule file claims it is mechanical.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['src/observability/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              message:
                'Import Sentry only in src/observability/. Everywhere else, crash reporting is automatic via the global handler - see .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // Haptics go through the HapticCue union in src/lib/haptics.ts, never the
    // SDK directly: the union is what keeps every cue enumerable (and the
    // settings toggle able to silence all of them). The boundary already held
    // by convention; this makes it mechanical.
    // See .claude/rules/motion-conventions.md.
    //
    // This entry sits BEFORE the crypto/push directory ban below, not after.
    // Its glob (`src/**`, `app/**`) is a superset of that entry's directories,
    // and flat config's last-match-wins REPLACES a rule's options rather than
    // merging them - the same trap documented on the `no-restricted-syntax`
    // entries further down. Ordered the other way round, this block was the
    // last `no-restricted-imports` match for every file under src/pairing,
    // src/channel, src/demo, src/devsupport, src/notifications and
    // app/+native-intent.ts, and silently disabled the observability ban there.
    // tests/unit/eslintConfig.test.ts pins both directions.
    files: ['src/**/*.ts', 'src/**/*.tsx', 'app/**/*.ts', 'app/**/*.tsx'],
    ignores: ['src/lib/haptics.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...restrictedHapticsImportPaths, ...restrictedRouterImportPaths] },
      ],
    },
  },
  {
    // The crypto and push paths must never hand content to a third party.
    // src/notifications/pushDecrypt.ts states why the error MESSAGE itself
    // is unsafe there: it can echo attacker-controlled bytes. These
    // directories catch and discard without logging, and a deliberate
    // Sentry.captureException() would defeat that. The global handler still
    // reports genuine crashes originating here; what is banned is
    // hand-written capture calls.
    // See .claude/rules/e2e-notification-privacy.md.
    // src/demo runs a real pairing handshake of its own, so it sits on the
    // same error paths for the same reason. Its own key material is public,
    // but the ban is on the DIRECTORY's error surface, not on a judgement
    // about which bytes happen to be sensitive today. src/devsupport is in
    // the zone because the demo pulls its loopback transport and stub peer
    // into release builds, where they run the same handshake frames; and
    // app/+native-intent.ts because it feeds raw, attacker-typeable deep-link
    // URLs into the demo predicate before any error boundary exists.
    //
    // This is the LAST `no-restricted-imports` match for these directories, so
    // it carries the haptics AND imperative-router bans too: options replace
    // rather than merge, and dropping either `paths` entry here would exempt
    // these directories from it. src/notifications is exactly where the router
    // ban matters most - tapRouter.ts is where the crash came from.
    files: ['src/pairing/**', 'src/channel/**', 'src/demo/**', 'src/devsupport/**', 'src/notifications/**', 'app/+native-intent.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...restrictedHapticsImportPaths, ...restrictedRouterImportPaths],
          patterns: [
            {
              group: ['@sentry/*', '**/observability/*', '@/observability/*'],
              message:
                'src/pairing, src/channel, src/demo, src/devsupport, src/notifications and app/+native-intent.ts must not report to Sentry: their error messages can carry ciphertext, key material, or attacker-controlled bytes. See .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // The imperative router IS allowed here, because everything in these three
    // directories renders inside the mounted root navigator, which is the
    // condition that makes a router call safe. src/navigation is the one that
    // performs navigation published from outside React.
    //
    // Ordered AFTER both entries above and re-stating ONLY the haptics ban,
    // per the last-match-wins note at the top of this file: this is the last
    // `no-restricted-imports` match for these directories, so anything omitted
    // here is exempted, and anything still meant to apply has to be repeated.
    // These directories are not in the Sentry-ban list, so that one does not
    // belong here. tests/unit/eslintConfig.test.ts pins the ordering.
    files: ['src/screens/**', 'src/components/**', 'src/navigation/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: restrictedHapticsImportPaths }],
    },
  },
  // Two motion bans share the `no-restricted-syntax` rule, and flat config's
  // last-match-wins REPLACES a rule's options wholesale rather than merging
  // them - two separate entries left whichever came second as the only one
  // live (caught by the probe-file check, not assumed). So: one combined
  // entry carrying both selectors, then a narrow override per exception file
  // re-stating ONLY the selector that still applies there.
  //
  // The bans themselves (see .claude/rules/motion-conventions.md):
  // - useAnimatedProps into another library's props re-runs that library's
  //   rendering every frame - measured at ~8 CPU points per icon on a release
  //   build. Animate a native view's transform/opacity via useAnimatedStyle.
  // - a raw Easing.bezier() spread outside src/components/motion/ is where a
  //   literal control point eventually creeps in; bezierEasing() in presets.ts
  //   is the one place the four-argument spread is spelled.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'app/**/*.ts', 'app/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...restrictedAnimatedPropsSyntax, ...restrictedBezierSyntax],
    },
  },
  {
    // The single allowlisted useAnimatedProps call site: the inert march
    // genuinely moves a dash, a shape change a transform cannot express. The
    // bezier ban still applies here, so only that selector is re-stated.
    files: ['src/components/AgentStatusIcon.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...restrictedBezierSyntax],
    },
  },
  {
    // The motion directory owns bezierEasing, so the raw spread is legal here;
    // the useAnimatedProps ban still applies, so only that selector remains.
    files: ['src/components/motion/**/*.ts', 'src/components/motion/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...restrictedAnimatedPropsSyntax],
    },
  },
]);
