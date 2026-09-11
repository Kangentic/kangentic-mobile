import React, { useEffect } from 'react';
import { LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ThemeProvider, useTheme } from '@/components';
import { startConnectionLifecycle } from '@/connection/connectionManager';
import { initializeNotifications } from '@/notifications';
import { PendingNavigationRunner } from '@/navigation/PendingNavigationRunner';
import { AppErrorBoundaryScreen } from '@/screens/AppErrorBoundaryScreen';
import { useSettingsStore } from '@/state/settingsStore';

/**
 * expo-router wraps this route in `<Try catch={ErrorBoundary}>`, so exporting
 * it here puts one boundary around the whole route tree. See the screen for
 * what it deliberately does NOT cover.
 */
export { AppErrorBoundaryScreen as ErrorBoundary };

// Hold the native splash until settings hydrate, then fade it out instead
// of the default hard cut - the brand mark hands off to the themed UI.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden (fast refresh): nothing to hold.
});
SplashScreen.setOptions({ fade: true, duration: 220 });

// Store-screenshot capture only: silence LogBox so its banner cannot land in a
// listing image.
//
// Deliberately its OWN flag rather than riding on the mock flag. Mock mode is
// the everyday UI-iteration rig, and hiding warnings there would turn a visible
// mistake into an invisible one - the opposite of what a dev build is for.
//
// Set by exactly two things, one per platform, and it needs both: the iOS
// capture job (`build-ios.yml`) and `npm run dev:shots` (the Android capture
// rig). Android went without it at first, so the same warning banner the iOS
// job was careful to suppress could still land in a Play frame. `__DEV__` keeps
// the call out of production either way.
if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_SHOTS === '1') {
  LogBox.ignoreAllLogs(true);
}

// Dev-only inspect loop: the route probe mirrors the current router
// location for `mobileInspect state route`. The compile-time-false gate in
// production strips the lazy module from the bundle entirely.
const LazyInspectRouteProbe =
  __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1'
    ? React.lazy(() => import('@/devsupport/InspectRouteProbe'))
    : null;

export default function RootLayout(): React.JSX.Element {
  useEffect(() => {
    // Idempotent backstop: the real registration point is index.js (entry
    // scope, outside React, present in headless launches too).
    initializeNotifications();
    startConnectionLifecycle();
    void useSettingsStore
      .getState()
      .hydrate()
      .finally(() => {
        void SplashScreen.hideAsync().catch(() => undefined);
      });
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <RootStack />
          {LazyInspectRouteProbe ? (
            <React.Suspense fallback={null}>
              <LazyInspectRouteProbe />
            </React.Suspense>
          ) : null}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootStack(): React.JSX.Element {
  const theme = useTheme();
  /**
   * Shared options for every sheet in the app. NATIVE form sheets, not
   * hand-rolled Modals: the platform owns the presentation, the backdrop and
   * keyboard avoidance, so there is no translucent-Dialog window whose insets
   * can land a frame late (which is what made the old custom sheet open one
   * tab-bar-height off the bottom until the keyboard forced a relayout).
   *
   * 'fitToContents' sizes the sheet to its form, so nothing inside may use
   * flex: 1. Android form sheets render no native header, so each screen puts
   * its own title in content.
   */
  const formSheetOptions = {
    presentation: 'formSheet',
    headerShown: false,
    sheetAllowedDetents: 'fitToContents',
    sheetCornerRadius: theme.radii.lg,
    sheetGrabberVisible: true,
  } as const;
  // Every sheet shares the options above, the writing ones included.
  // Fractional detents were tried for those two and reverted: a fixed-fraction
  // sheet does not shrink when the keyboard opens, so its lower third went
  // unreachable. See CreateTaskScreen's comment for the reasoning that stuck.
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.textPrimary,
          contentStyle: { backgroundColor: theme.colors.background },
          // Chevron only, no back label, so the title keeps the header's
          // width (Android never shows one; this aligns iOS with it and
          // with our own TaskHeader's bare chevron).
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        {/* The headerShown:false routes still declare a title. iOS borrows
            the PREVIOUS route's title for the back button - since 'minimal'
            above it feeds only the long-press menu and accessibility label,
            not a visible text label - and with no title those surfaces get
            the literal route path: the back button read "(tabs)" on Settings
            and Pair on every iPhone. Locked by tests/unit/routeTitles.test.ts. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Kangentic' }} />
        <Stack.Screen name="task/[taskId]/index" options={{ headerShown: false, title: 'Session' }} />
        <Stack.Screen name="task/[taskId]/changes" options={{ headerShown: false, title: 'Changes' }} />
        <Stack.Screen name="create-task" options={formSheetOptions} />
        <Stack.Screen name="move-task" options={formSheetOptions} />
        <Stack.Screen name="edit-task" options={formSheetOptions} />
        <Stack.Screen name="project-picker" options={formSheetOptions} />
        <Stack.Screen name="task-actions" options={formSheetOptions} />
        {/* Renders its own TaskHeader, exactly as the session screen does, so the
            two kinds of task open into the same chrome. */}
        <Stack.Screen name="completed-task" options={{ headerShown: false, title: 'Completed task' }} />
        <Stack.Screen name="file-diff" options={{ title: 'Changes' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair a device' }} />
        <Stack.Screen name="pair-confirm" options={{ title: 'Confirm pairing' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        {/* Singular: one phone, one desktop trust anchor. See SettingsScreen's row. */}
        <Stack.Screen name="devices" options={{ title: 'Paired desktop' }} />
        <Stack.Screen name="+not-found" options={{ title: 'Not found' }} />
      </Stack>
      {/* Performs navigation published from outside React (a notification tap,
          a desktop revocation), because those callers run where expo-router's
          imperative router cannot safely be called.

          POSITION IS THE CORRECTNESS ARGUMENT, so keep it exactly here: a
          SIBLING of <Stack>, rendered AFTER it, inside the root layout. Passive
          effects flush child-first and in sibling order, so the Stack's
          navigator has mounted and registered its focus listener before this
          component's effect runs. It is NOT a child of <Stack> and must not be
          moved inside one - <Stack> children are route declarations.
          See src/navigation/pendingNavigation.ts. */}
      <PendingNavigationRunner />
    </>
  );
}
