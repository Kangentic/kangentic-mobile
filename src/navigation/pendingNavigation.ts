/**
 * A one-slot queue of navigation the app wants to perform, published from
 * OUTSIDE React and performed from inside it.
 *
 * WHY THIS EXISTS. expo-router's imperative `router` singleton is unsafe to
 * call from module scope, a bundle-entry handler, or any other non-React
 * caller. `router.push`/`navigate` do not navigate: they append to
 * expo-router's routingQueue and return. The queue is drained inside a React
 * effect in NavigationContainerInner, which calls `store.assertIsReady()` and
 * THROWS 'Attempted to navigate before mounting the Root Layout component'
 * when no navigator child has mounted yet.
 *
 * On a native cold start that window is real: expo-router wraps its content in
 * a SafeAreaProvider with no `initialMetrics`, and that provider renders null
 * children until the OS reports insets, while the navigation container above it
 * has already attached its ref. The drain effect sits above every route error
 * boundary, so the throw reaches the global handler and aborts the process.
 * That was the iOS TestFlight cold-start crash on 0.6.3 build 13, reached by a
 * notification tap.
 *
 * A try/catch at the call site cannot help, because the call itself never
 * throws - the throw happens later, on a different stack. The only fix is to
 * not call the router until a navigator exists, which is what publishing here
 * and consuming in `PendingNavigationRunner` achieves.
 *
 * The platforms differed only in how the same defect surfaced:
 * `getInitialURLWithTimeout` is synchronous on iOS and a Promise on Android, so
 * iOS mounted the container (ref set, not ready) and threw, while Android
 * early-returned its fallback (ref null) and silently DROPPED the navigation.
 * Publishing here fixes both.
 *
 * One slot, not a list: every intent here is "where the app should be now", so
 * a newer one supersedes an older one rather than replaying behind it.
 */

export type PendingNavigation =
  | {
      readonly kind: 'open-task';
      readonly taskId: string;
      readonly projectId: string;
      readonly sessionId: string;
    }
  | { readonly kind: 'reset-to-root' };

let pendingNavigation: PendingNavigation | null = null;
const pendingNavigationSubscribers = new Set<() => void>();

export function publishPendingNavigation(next: PendingNavigation | null): void {
  pendingNavigation = next;
  for (const subscriber of pendingNavigationSubscribers) subscriber();
}

export function subscribePendingNavigation(onStoreChange: () => void): () => void {
  pendingNavigationSubscribers.add(onStoreChange);
  return () => {
    pendingNavigationSubscribers.delete(onStoreChange);
  };
}

/**
 * The `useSyncExternalStore` snapshot. Returns the stored reference itself and
 * never a fresh object: a snapshot that allocates on every call makes
 * useSyncExternalStore re-render forever.
 */
export function getPendingNavigation(): PendingNavigation | null {
  return pendingNavigation;
}

export function consumePendingNavigation(): PendingNavigation | null {
  const consumed = pendingNavigation;
  if (consumed !== null) publishPendingNavigation(null);
  return consumed;
}
