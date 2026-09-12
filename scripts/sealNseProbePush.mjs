/**
 * Seals the NSE probe push for `build-ios.yml -f nse_probe=true`.
 *
 * The app seeds two known vectors into the shared Keychain (see
 * src/devsupport/nseProbeVectors.ts); this script seals an envelope with the
 * SAME vectors and wraps it in the APNs payload shape `xcrun simctl push`
 * delivers. The alert is the generic placeholder and nothing else, exactly as
 * the desktop sends it (.claude/rules/e2e-notification-privacy.md), and
 * `mutable-content: 1` is what makes APNs, and the simulator, invoke the
 * Notification Service Extension at all. If the extension decrypts, the
 * delivered title is the category's real title; if it does not, the
 * placeholder stays, which is the difference the probe exists to observe.
 *
 * The vectors are duplicated here as literals because plain Node cannot
 * import the app's TypeScript; tests/unit/nseProbe.test.ts pins the two copies
 * equal. Public test data, not secrets.
 *
 * Run: node scripts/sealNseProbePush.mjs --out <payload.json>
 * (prints the payload to stdout without --out).
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hexToBytes, openPushEnvelope, sealPushEnvelope } from '@kangentic/protocol';

export const PROBE_PUSH_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const PROBE_IDENTITY_PUBLIC_KEY_HEX = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
export const PROBE_TASK_TITLE = 'NSE probe';
export const PROBE_DETAIL = 'decrypted on device';

/** Mirrors PUSH_PLACEHOLDER_TITLE / PUSH_PLACEHOLDER_BODY in src/notifications/pushDecrypt.ts; the unit test pins them. */
const PLACEHOLDER_TITLE = 'Kangentic';
const PLACEHOLDER_BODY = 'Agent needs attention';

/**
 * The payload `simctl push` delivers. `sentAt` is the moment of sealing so the
 * extension's 24-hour freshness window is comfortably satisfied; seal
 * immediately before pushing, never ahead of time.
 */
export function buildProbePayload(nowMilliseconds = Date.now()) {
  const plaintext = {
    category: 'input-required',
    projectId: 'nse-probe-project',
    taskId: 'nse-probe-task',
    sessionId: 'nse-probe-session',
    taskTitle: PROBE_TASK_TITLE,
    detail: PROBE_DETAIL,
    sentAt: nowMilliseconds,
  };
  const pushKey = hexToBytes(PROBE_PUSH_KEY_HEX);
  const identityPublicKey = hexToBytes(PROBE_IDENTITY_PUBLIC_KEY_HEX);
  const blob = sealPushEnvelope(pushKey, identityPublicKey, plaintext);
  // The envelope must genuinely open with the protocol's own reader, so a
  // sealing mistake cannot masquerade as an extension failure on the runner.
  const opened = openPushEnvelope(pushKey, identityPublicKey, blob);
  if (opened.taskTitle !== PROBE_TASK_TITLE) {
    throw new Error('The probe envelope does not round-trip through openPushEnvelope.');
  }
  return {
    aps: {
      alert: { title: PLACEHOLDER_TITLE, body: PLACEHOLDER_BODY },
      'mutable-content': 1,
      sound: 'default',
    },
    blob,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outFlagIndex = process.argv.indexOf('--out');
  const outputPath = outFlagIndex === -1 ? null : process.argv[outFlagIndex + 1];
  const payloadJson = `${JSON.stringify(buildProbePayload(), null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, payloadJson, 'utf8');
    console.log(`Wrote the NSE probe payload to ${outputPath}`);
  } else {
    process.stdout.write(payloadJson);
  }
}
