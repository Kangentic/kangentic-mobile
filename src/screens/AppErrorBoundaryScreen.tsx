import React, { useEffect } from 'react';
import type { ErrorBoundaryProps } from 'expo-router';
import { Button, Screen, Stack, Text, ThemeProvider } from '@/components';
import { reportCaughtError } from '@/observability/crashReporting';

/**
 * The app's only error boundary, exported as `ErrorBoundary` from
 * `app/_layout.tsx` so expo-router wraps the whole route tree in it.
 *
 * Before this, an uncaught render or effect throw anywhere in a screen took the
 * process down: nothing in the repo implemented `componentDidCatch` or
 * `getDerivedStateFromError`, and expo-router's own try/catch wraps only
 * `registerRootComponent`, not renders.
 *
 * WHAT THIS DOES NOT COVER, stated because it is tempting to assume otherwise:
 * the crash this was added alongside - a notification tap navigating before the
 * navigator mounted - throws inside expo-router's routing-queue drain effect,
 * which sits ABOVE every route error boundary. No boundary can catch it; that
 * one is fixed at its source in `src/navigation/pendingNavigation.ts`. This is
 * general resilience for throws inside the route tree, not a net under that
 * class of bug.
 *
 * It renders its own ThemeProvider because a boundary replaces the output of
 * the route it guards: when the root layout is what threw, the provider tree it
 * would have rendered does not exist. `useTheme` would still resolve (the
 * context defaults to the dark theme), but relying on that would be relying on
 * an implementation detail.
 */
export function AppErrorBoundaryScreen({ error, retry }: ErrorBoundaryProps): React.JSX.Element {
  useEffect(() => {
    // A caught error never reaches ErrorUtils, so the global handler never sees
    // it. Without this call, adding a boundary would trade a visible crash for
    // an invisible one - in a build where Sentry is initialised, which is the
    // one that matters here. Without a DSN this is a no-op and React's own
    // console/LogBox output is still the dev signal.
    reportCaughtError(error, 'root-layout');
  }, [error]);

  return (
    <ThemeProvider>
      <Screen testID="app-error-boundary">
        <Stack gap="md">
          <Text variant="title">Something went wrong</Text>
          <Text variant="body" color="secondary">
            The screen failed to load. Retrying usually clears it.
          </Text>
          <Button label="Try again" onPress={() => void retry()} testID="app-error-boundary-retry" />
        </Stack>
      </Screen>
    </ThemeProvider>
  );
}
