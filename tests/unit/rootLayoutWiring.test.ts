/**
 * app/_layout.tsx's wiring for two invariants documented in
 * .claude/rules/imperative-router-inside-react.md and
 * src/navigation/pendingNavigation.ts, neither of which any existing test
 * touches at the one file where the wiring actually happens:
 *
 * - `<PendingNavigationRunner />` must render as a SIBLING of the root
 *   `<Stack>`, immediately AFTER it. Its correctness comes from tree
 *   position, not a runtime check (see the comment in
 *   PendingNavigationRunner.tsx): a navigator mounted BEFORE this
 *   component's effect runs is what makes calling the router here safe.
 *   Every existing test that exercises PendingNavigationRunner renders the
 *   component directly (tests/components/PendingNavigationRunner.test.tsx),
 *   so none of them can catch app/_layout.tsx itself regressing this - a
 *   layout that stopped rendering the runner at all, or moved it inside
 *   `<Stack>`, would leave every one of those tests green.
 * - `app/_layout.tsx` must export `AppErrorBoundaryScreen` as `ErrorBoundary`,
 *   which is how expo-router wraps the whole route tree in it (`<Try
 *   catch={ErrorBoundary}>`). Deleting that export line leaves
 *   tests/components/AppErrorBoundaryScreen.test.tsx green - it renders the
 *   component directly - while the shipped app installs no boundary at all.
 *
 * A source scan, not a render: standing up the real root layout needs a full
 * expo-router navigator tree, which this suite deliberately does not do (see
 * PendingNavigationRunner.test.tsx's note that the cold-start crash itself is
 * not reproducible under jest).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const rootLayoutSource = readFileSync(`${repositoryRoot}app/_layout.tsx`, 'utf8');

/**
 * Strips block comments, JSX-wrapped (`{/* ... *\/}`) or plain
 * (`/* ... *\/`), before any positional check below. The comment sitting
 * directly above `<PendingNavigationRunner />` explains this very invariant
 * in prose and contains the literal text `<Stack>` three times - so an
 * un-stripped `indexOf` could be satisfied or defeated by the comment rather
 * than the code. Same approach as tests/unit/routeTitles.test.ts, which
 * documents being bitten by this class of bug in both directions.
 */
function stripBlockComments(source: string): string {
  return source.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
}

const strippedSource = stripBlockComments(rootLayoutSource);

describe('app/_layout.tsx wiring', () => {
  it('is non-trivial and still contains the root Stack (vacuity guard on the comment strip)', () => {
    // If the strip regex ever over-matched (a stray `/*` in a string, say)
    // it could eat the whole file and every assertion below would pass
    // having checked nothing.
    expect(strippedSource.length).toBeGreaterThan(1000);
    expect(strippedSource).toContain('<Stack');
  });

  it('exports AppErrorBoundaryScreen as ErrorBoundary, which is how expo-router installs the app-wide boundary', () => {
    expect(strippedSource).toMatch(/export\s*\{\s*AppErrorBoundaryScreen\s+as\s+ErrorBoundary\s*\}/);
  });

  it('renders PendingNavigationRunner exactly once', () => {
    const occurrences = strippedSource.match(/<PendingNavigationRunner\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('renders PendingNavigationRunner as a sibling AFTER the root Stack closes, never inside or before it', () => {
    const stackCloseOccurrences = strippedSource.match(/<\/Stack>/g) ?? [];
    // Non-vacuity: a silent zero count here (the closing-tag text changing
    // shape) would make the position comparison below meaningless.
    expect(stackCloseOccurrences).toHaveLength(1);

    const stackCloseIndex = strippedSource.indexOf('</Stack>');
    const runnerIndex = strippedSource.indexOf('<PendingNavigationRunner');
    expect(stackCloseIndex).toBeGreaterThan(0);
    expect(runnerIndex).toBeGreaterThan(0);
    expect(runnerIndex).toBeGreaterThan(stackCloseIndex);
  });
});
