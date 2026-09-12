/**
 * The NSE probe's known vectors, and its build-time gate.
 *
 * `build-ios.yml -f nse_probe=true` proves that the iOS Notification Service
 * Extension decrypts a push on a CI simulator: the app seeds these two vectors
 * into the shared Keychain (through the production write path), the runner
 * seals a push with the same vectors, `simctl push`es it, and the app reads
 * back what the OS displayed. A delivered notification alone cannot prove the
 * extension ran, because the placeholder renders on every failure by design
 * (.claude/rules/e2e-notification-privacy.md); a changed title can only come
 * from a decrypt.
 *
 * PUBLIC TEST DATA, not secrets. The vectors are duplicated as literals in
 * scripts/sealNseProbePush.mjs (plain Node cannot import this TypeScript), and
 * tests/unit/nseProbe.test.ts pins the two copies equal - the same
 * duplicated-constant pattern as the Swift category copy. This module is kept
 * pure (no notifee, no SecureStore) so that test can import it in the
 * plain-Node tier.
 *
 * Gated exactly like the crash-test rig: `EXPO_PUBLIC_*` is inlined at bundle
 * time, so the probe is inert in every build not dispatched with the flag on,
 * and build-ios.yml refuses the flag together with a TestFlight submission.
 */
export const NSE_PROBE_PUSH_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

/** Read at call time, not import time, so a test can flip it the way the crash-test tests do. */
export function nseProbeEnabled(): boolean {
  return process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE === '1';
}
