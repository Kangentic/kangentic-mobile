/**
 * Pins two real defects found in `eslint.config.mjs` on this branch (both
 * already fixed in the working tree), plus the three-way split of the
 * imperative-router ban described below. Nothing else in the repo checks that a
 * lint rule actually FIRES where it is supposed to - `tsc` cannot see a
 * misconfigured ESLint rule, and a config that "looks correct" but silently
 * stops matching is exactly the failure mode here. So this test drives real
 * ESLint (`ESLint#lintText`, the same engine `npm run lint` uses), not
 * `calculateConfigForFile`, which would only prove the options object looks
 * right without proving it resolves.
 *
 * Defect A: flat config's last-match-wins REPLACES a rule's options rather
 * than merging them. The `expo-haptics` `no-restricted-imports` entry has a
 * glob (`src/**\/*.ts` etc.) that is a superset of the crypto/push directory
 * entry's files (`src/pairing/**`, `src/channel/**`, ...), and used to sit
 * AFTER it - so it became the only live `no-restricted-imports` config for
 * those directories and silently disabled the `crash-reporting-scope.md`
 * observability ban there. Fixed by reordering the haptics entry before the
 * directory entry and restating the haptics `paths` inside the directory
 * entry.
 *
 * Defect B: the `useAnimatedProps` ban was a single selector
 * `CallExpression[callee.name='useAnimatedProps']`, which matches only an
 * unqualified call. `import * as Reanimated from 'react-native-reanimated'`
 * then `Reanimated.useAnimatedProps(...)` has a MemberExpression callee and
 * slipped straight through - and that namespaced form is already the house
 * style in this repo's own test files. Fixed by adding a second selector,
 * `CallExpression[callee.property.name='useAnimatedProps']`.
 *
 * Every case here asserts "does this rule actually fire", not "is this
 * option present in the resolved config" - a config that looks right and
 * does not resolve is the whole class of bug this file exists to catch.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_RESTRICTED_IMPORTS = 'no-restricted-imports';
const NO_RESTRICTED_SYNTAX = 'no-restricted-syntax';

// Real ESLint, discovering eslint.config.mjs the same way `npm run lint`
// does. Resolving the flat config (eslint-config-expo/flat.js pulls in
// react, react-hooks, import, jsx-a11y...) is the slow part of this file -
// a cold first lint took ~1.4s in a local run - so one shared instance,
// warmed once in beforeAll, keeps every `it()` fast.
let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT });
  await eslint.lintText('const warm = 1;\n', { filePath: 'src/components/warm.ts' });
}, 20000);

/**
 * Whether `ruleId` appears among the messages ESLint produces for `code` at
 * `filePath`. `filePath` need not exist on disk - it only drives which
 * config entries match - except where a case deliberately names a real file
 * whose config entry IS the point (`src/lib/haptics.ts`,
 * `src/components/AgentStatusIcon.tsx`).
 *
 * Other rules (`import/no-unresolved`, `react-hooks/rules-of-hooks`,
 * `@typescript-eslint/no-unused-vars`) fire on these synthetic snippets and
 * are noise; only the named rule id is checked.
 */
async function ruleFired(filePath: string, code: string, ruleId: string): Promise<boolean> {
  const results = await eslint.lintText(code, { filePath });
  const messages = results[0]?.messages ?? [];
  return messages.some((message) => message.ruleId === ruleId);
}

describe('eslint.config.mjs: no-restricted-imports ordering (defect A)', () => {
  it(
    'still bans an observability import from src/channel - the reordering must not silently drop the crash-reporting ban it used to carry',
    async () => {
      const fired = await ruleFired(
        'src/channel/probe.ts',
        "import { initCrashReporting } from '@/observability/crashReporting';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'still bans a direct expo-haptics import from src/channel - the mirror-image failure the reorder itself could introduce',
    async () => {
      const fired = await ruleFired(
        'src/channel/probe.ts',
        "import * as Haptics from 'expo-haptics';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'bans a direct expo-haptics import from an ordinary component file',
    async () => {
      const fired = await ruleFired(
        'src/components/probe.ts',
        "import * as Haptics from 'expo-haptics';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'does not ban expo-haptics inside its own allowlisted owner, src/lib/haptics.ts',
    async () => {
      const fired = await ruleFired(
        'src/lib/haptics.ts',
        "import * as Haptics from 'expo-haptics';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(false);
    },
    15000,
  );
});

describe('eslint.config.mjs: expo-router router import confinement (imperative-router-inside-react.md)', () => {
  it(
    'bans the router named import from src/notifications - tapRouter.ts is where the crash came from',
    async () => {
      const fired = await ruleFired(
        'src/notifications/probe.ts',
        "import { router } from 'expo-router';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'bans the router named import from src/connection, which is covered by the broad haptics-plus-router entry rather than the crypto/push directory entry',
    async () => {
      const fired = await ruleFired(
        'src/connection/probe.ts',
        "import { router } from 'expo-router';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'does not ban the router named import from src/navigation, the one place a published navigation is performed',
    async () => {
      const fired = await ruleFired(
        'src/navigation/probe.ts',
        "import { router } from 'expo-router';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(false);
    },
    15000,
  );

  it(
    'does not ban the router named import from src/screens, which renders inside the mounted navigator',
    async () => {
      const fired = await ruleFired(
        'src/screens/probe.ts',
        "import { router } from 'expo-router';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(false);
    },
    15000,
  );

  it(
    'still bans a direct expo-haptics import from src/navigation - the allow entry must restate the haptics ban, not drop it',
    async () => {
      const fired = await ruleFired(
        'src/navigation/probe.ts',
        "import * as Haptics from 'expo-haptics';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'still bans an observability import from src/notifications - the router ban must have been added there without dropping the Sentry ban',
    async () => {
      const fired = await ruleFired(
        'src/notifications/probe.ts',
        "import { reportCaughtError } from '@/observability/crashReporting';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'does not ban a non-router expo-router import, pinning that importNames: [\'router\'] is the whole precision of the rule',
    async () => {
      const fired = await ruleFired(
        'src/notifications/probe.ts',
        "import { Stack } from 'expo-router';\n",
        NO_RESTRICTED_IMPORTS,
      );
      expect(fired).toBe(false);
    },
    15000,
  );
});

describe('eslint.config.mjs: no-restricted-syntax useAnimatedProps selectors (defect B)', () => {
  it(
    'bans an unqualified useAnimatedProps() call',
    async () => {
      const fired = await ruleFired(
        'src/components/probe.ts',
        'function useProbe() {\n  return useAnimatedProps(() => ({}));\n}\n',
        NO_RESTRICTED_SYNTAX,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'bans a namespaced Reanimated.useAnimatedProps() call - the exact form defect B let through',
    async () => {
      const fired = await ruleFired(
        'src/components/probe.ts',
        "import * as Reanimated from 'react-native-reanimated';\n" +
          'function useProbe() {\n  return Reanimated.useAnimatedProps(() => ({}));\n}\n',
        NO_RESTRICTED_SYNTAX,
      );
      expect(fired).toBe(true);
    },
    15000,
  );

  it(
    'does not ban useAnimatedProps in AgentStatusIcon.tsx, the one deliberate allowlisted call site',
    async () => {
      const fired = await ruleFired(
        'src/components/AgentStatusIcon.tsx',
        'function useProbe() {\n  return useAnimatedProps(() => ({}));\n}\n',
        NO_RESTRICTED_SYNTAX,
      );
      expect(fired).toBe(false);
    },
    15000,
  );
});

describe('eslint.config.mjs: no-restricted-syntax Easing.bezier selector', () => {
  it(
    'does not ban a raw Easing.bezier() spread inside src/components/motion, which owns bezierEasing',
    async () => {
      const fired = await ruleFired(
        'src/components/motion/probe.ts',
        "import { Easing } from 'react-native-reanimated';\nconst curve = Easing.bezier(0.2, 0, 0, 1);\n",
        NO_RESTRICTED_SYNTAX,
      );
      expect(fired).toBe(false);
    },
    15000,
  );

  it(
    'bans a raw Easing.bezier() spread outside src/components/motion',
    async () => {
      const fired = await ruleFired(
        'src/components/probe.ts',
        "import { Easing } from 'react-native-reanimated';\nconst curve = Easing.bezier(0.2, 0, 0, 1);\n",
        NO_RESTRICTED_SYNTAX,
      );
      expect(fired).toBe(true);
    },
    15000,
  );
});
