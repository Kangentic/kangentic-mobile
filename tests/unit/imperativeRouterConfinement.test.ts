/**
 * expo-router's imperative `router` singleton must only be reached from code
 * that renders inside the mounted root navigator.
 *
 * `router.push`/`navigate` do not navigate. They append to expo-router's
 * routingQueue and return; the queue is drained inside a React effect that
 * calls `store.assertIsReady()` and throws 'Attempted to navigate before
 * mounting the Root Layout component' when no navigator child has mounted. On a
 * native cold start that window is real, the drain effect sits above every
 * route error boundary, and the throw aborts the process. That was the iOS
 * TestFlight cold-start crash on 0.6.3 build 13, reached by a notification tap.
 *
 * WHY A SCAN AND NOT JUST THE LINT RULE. `eslint.config.mjs` bans the static
 * `import { router } from 'expo-router'` outside the allowed directories, but
 * `no-restricted-imports` matches import SYNTAX only - never `require()` and
 * never a dynamic `import()`. That is not hypothetical here: the second live
 * instance of this bug, in `connectionManager.ts`, reached the router via
 * `await import('expo-router')` and would have sailed past the lint rule
 * completely. The same hole is already documented for the Sentry ban in
 * `.claude/rules/crash-reporting-scope.md`.
 *
 * See `.claude/rules/imperative-router-inside-react.md`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Everything in these directories renders inside the mounted root navigator,
 * which is the condition that makes a router call safe. Keep this list in step
 * with the allow entry in eslint.config.mjs.
 */
const ALLOWED_DIRECTORIES = ['src/screens/', 'src/components/', 'src/navigation/'];

/** Any non-static route to the module: require() or a dynamic import(). */
const DYNAMIC_ROUTES = [/require\(\s*['"]expo-router['"]\s*\)/, /import\(\s*['"]expo-router['"]\s*\)/];

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

function isAllowed(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return ALLOWED_DIRECTORIES.some((directory) => normalized.startsWith(directory));
}

describe('imperative router confinement', () => {
  it('finds source files to scan at all', () => {
    // Guards the scan itself: a glob that silently matches nothing would make
    // every assertion below vacuously true.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it('never reaches expo-router through require() or a dynamic import() outside the navigator directories', () => {
    const offenders = sourceFiles()
      .filter((relativePath) => !isAllowed(relativePath))
      .filter((relativePath) => {
        const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
        return DYNAMIC_ROUTES.some((pattern) => pattern.test(source));
      });

    expect(offenders).toEqual([]);
  });

  /**
   * Belt and braces over the lint rule, so the invariant survives someone
   * reordering eslint.config.mjs and silently dropping the ban (a documented
   * trap in that file: flat config REPLACES a rule's options rather than
   * merging them).
   */
  it('never statically imports the router singleton outside the navigator directories', () => {
    const staticRouterImport = /import\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*['"]expo-router['"]/;
    const offenders = sourceFiles()
      .filter((relativePath) => !isAllowed(relativePath))
      .filter((relativePath) => {
        const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
        return staticRouterImport.test(source);
      });

    expect(offenders).toEqual([]);
  });
});
