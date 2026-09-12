/**
 * Sentry is reached through one door, `src/observability/`, and never from
 * the directories whose error messages can carry ciphertext, key material or
 * peer-controlled bytes (`.claude/rules/crash-reporting-scope.md`).
 *
 * WHY A SCAN AND NOT JUST THE LINT ZONES. `eslint.config.mjs` bans the static
 * imports, but `no-restricted-imports` matches import SYNTAX only - never
 * `require()` and never a dynamic `import()`. The rule file has named that
 * hole since the zones landed (`metro.config.js` legitimately does
 * `require('@sentry/react-native/metro')`, so the pattern is live in this
 * repo), and `tests/unit/imperativeRouterConfinement.test.ts` closed the same
 * hole for the router after a real bug reached it through `await import()`.
 * This closes it for Sentry across `src/` and `app/`; `metro.config.js` sits
 * outside both by design.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The one door. Keep in step with the `ignores` of the SDK zones in eslint.config.mjs. */
const SDK_DOOR = 'src/observability/';

/**
 * Directories (and the one file) that may not reach the SDK OR the door by
 * any route. Keep in step with the directory entry in eslint.config.mjs and
 * the rule's second bullet.
 */
const BANNED_PREFIXES = ['src/pairing/', 'src/channel/', 'src/demo/', 'src/devsupport/', 'src/notifications/', 'app/+native-intent.ts'];

/** Any non-static route to the SDK: require() or a dynamic import(). */
const SDK_DYNAMIC_ROUTES = [/require\(\s*['"]@sentry\//, /import\(\s*['"]@sentry\//];

/** Every route to the SDK or the wrapper: static, require(), or dynamic import(). */
const ANY_OBSERVABILITY_ROUTE = [
  /from\s*['"]@sentry\//,
  /from\s*['"]@\/observability\//,
  /from\s*['"][^'"]*\/observability\//,
  /require\(\s*['"]@sentry\//,
  /require\(\s*['"]@\/observability\//,
  /import\(\s*['"]@sentry\//,
  /import\(\s*['"]@\/observability\//,
];

function collectSourceFiles(directory: string, collected: string[]): void {
  for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectSourceFiles(relativePath, collected);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      collected.push(relativePath);
    }
  }
}

function sourceFiles(): string[] {
  const collected: string[] = [];
  collectSourceFiles('src', collected);
  collectSourceFiles('app', collected);
  return collected;
}

function normalized(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('crash-reporting confinement', () => {
  it('finds source files to scan at all', () => {
    // Guards the scan itself: a glob that silently matches nothing would make
    // every assertion below vacuously true.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it('never reaches the Sentry SDK through require() or a dynamic import() outside src/observability', () => {
    const offenders = sourceFiles()
      .filter((relativePath) => !normalized(relativePath).startsWith(SDK_DOOR))
      .filter((relativePath) => SDK_DYNAMIC_ROUTES.some((pattern) => pattern.test(readSource(relativePath))));

    expect(offenders).toEqual([]);
  });

  it('never reaches the SDK or the observability wrapper from the banned directories by any route', () => {
    const offenders = sourceFiles()
      .filter((relativePath) => BANNED_PREFIXES.some((prefix) => normalized(relativePath).startsWith(prefix)))
      .filter((relativePath) => ANY_OBSERVABILITY_ROUTE.some((pattern) => pattern.test(readSource(relativePath))));

    expect(offenders).toEqual([]);
  });

  it('scans every banned directory the rule names, so a renamed directory cannot drop out silently', () => {
    const scanned = sourceFiles().map(normalized);
    for (const prefix of BANNED_PREFIXES) {
      expect(scanned.some((relativePath) => relativePath.startsWith(prefix)), `${prefix} matched no source file`).toBe(true);
    }
  });
});
