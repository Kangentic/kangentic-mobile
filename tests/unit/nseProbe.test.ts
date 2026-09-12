/**
 * The NSE probe's two halves have to agree without sharing code: the app seeds
 * known vectors into the shared Keychain (TypeScript, Metro-bundled) and the
 * runner seals an envelope with the same vectors (`scripts/sealNseProbePush.mjs`,
 * plain Node, which cannot import the app's TypeScript). A drift between the
 * two would decrypt to nothing and read exactly like an extension that never
 * ran - the ambiguity the probe exists to remove. Same duplicated-constant
 * pattern, and same reason, as tests/unit/nseConstantsParity.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hexToBytes, openPushEnvelope } from '@kangentic/protocol';
import {
  NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX,
  NSE_PROBE_PUSH_KEY_HEX,
  nseProbeEnabled,
} from '@/devsupport/nseProbeVectors';
import {
  buildProbePayload,
  PROBE_DETAIL,
  PROBE_IDENTITY_PUBLIC_KEY_HEX,
  PROBE_PUSH_KEY_HEX,
  PROBE_TASK_TITLE,
} from '../../scripts/sealNseProbePush.mjs';

/**
 * Read as text rather than imported: pushDecrypt.ts reaches expo-secure-store
 * on import, which this plain-Node tier cannot load. Same technique as
 * nseConstantsParity.test.ts.
 */
const pushDecryptSource = readFileSync(join(__dirname, '..', '..', 'src', 'notifications', 'pushDecrypt.ts'), 'utf8');

function placeholderConstant(name: string): string {
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(pushDecryptSource);
  if (match === null) throw new Error(`${name} not found in pushDecrypt.ts`);
  return match[1];
}

describe('NSE probe vectors', () => {
  it('the app and the seal script carry the same probe vectors', () => {
    expect(PROBE_PUSH_KEY_HEX).toBe(NSE_PROBE_PUSH_KEY_HEX);
    expect(PROBE_IDENTITY_PUBLIC_KEY_HEX).toBe(NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX);
  });

  it('the vectors are 32-byte hex, which is what the extension length-checks', () => {
    expect(NSE_PROBE_PUSH_KEY_HEX).toMatch(/^[0-9a-f]{64}$/);
    expect(NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX).toMatch(/^[0-9a-f]{64}$/);
    expect(NSE_PROBE_PUSH_KEY_HEX).not.toBe(NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX);
  });
});

describe('nseProbeEnabled', () => {
  const originalFlag = process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE;
    else process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE = originalFlag;
  });

  it('is true only for the exact string "1", like the crash-test flag', () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE;
    expect(nseProbeEnabled()).toBe(false);
    process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE = 'true';
    expect(nseProbeEnabled()).toBe(false);
    process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE = '1';
    expect(nseProbeEnabled()).toBe(true);
  });
});

describe('sealNseProbePush.mjs', () => {
  it('builds an APNs payload the extension will be invoked for, with the placeholder alert', () => {
    // APNs will not run a service extension for a push with no alert, and the
    // OS-visible alert must be the generic placeholder and nothing else
    // (.claude/rules/e2e-notification-privacy.md).
    const payload = buildProbePayload();
    expect(payload.aps['mutable-content']).toBe(1);
    expect(payload.aps.alert).toEqual({
      title: placeholderConstant('PUSH_PLACEHOLDER_TITLE'),
      body: placeholderConstant('PUSH_PLACEHOLDER_BODY'),
    });
    expect(typeof payload.blob).toBe('string');
    // No plaintext field anywhere outside the blob.
    expect(JSON.stringify(payload)).not.toContain(PROBE_TASK_TITLE);
    expect(JSON.stringify(payload)).not.toContain(PROBE_DETAIL);
  });

  it('seals a blob the protocol opens with the probe vectors, fresh at the time of sealing', () => {
    const now = Date.now();
    const payload = buildProbePayload(now);
    const opened = openPushEnvelope(hexToBytes(PROBE_PUSH_KEY_HEX), hexToBytes(PROBE_IDENTITY_PUBLIC_KEY_HEX), payload.blob);
    expect(opened.category).toBe('input-required');
    expect(opened.taskTitle).toBe(PROBE_TASK_TITLE);
    expect(opened.detail).toBe(PROBE_DETAIL);
    expect(opened.sentAt).toBe(now);
  });

  it('seals for the probe recipient only: a different identity key cannot open it', () => {
    const payload = buildProbePayload();
    const otherIdentity = new Uint8Array(32).fill(0x42);
    expect(() => openPushEnvelope(hexToBytes(PROBE_PUSH_KEY_HEX), otherIdentity, payload.blob)).toThrow();
  });
});
