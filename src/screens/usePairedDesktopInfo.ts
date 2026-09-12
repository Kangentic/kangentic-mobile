import { useEffect, useState } from 'react';
import { bytesToHex } from '@kangentic/protocol';
import { reportHandledError } from '@/observability/crashReporting';
import { DeviceIdentityManager } from '@/pairing/deviceIdentity';
import { TrustAnchorStore } from '@/pairing/trustAnchor';

export interface PairedDesktopInfo {
  /** Hex of the desktop's static public key (the pairing trust anchor). */
  desktopPublicKeyHex: string;
  relayAddress: string;
  /** ISO timestamp recorded at pairing. */
  pairedAt: string;
  /** Hex of this phone's identity public key (the desktop's roster deviceId). */
  phonePublicKeyHex: string;
}

export type PairedDesktopInfoState =
  | { status: 'loading' }
  | { status: 'unpaired' }
  | { status: 'paired'; info: PairedDesktopInfo };

const trustAnchorStore = new TrustAnchorStore();
const deviceIdentityManager = new DeviceIdentityManager();

/**
 * One-shot load of the paired-desktop pointer + this phone's identity for
 * the Devices screen. Dev-pairing and mock modes bypass the trust anchor,
 * so those report 'unpaired' here by design (the screen says so).
 */
export function usePairedDesktopInfo(): PairedDesktopInfoState {
  const [state, setState] = useState<PairedDesktopInfoState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [anchor, identity] = await Promise.all([trustAnchorStore.load(), deviceIdentityManager.getIdentity()]);
        if (cancelled) return;
        if (!anchor) {
          setState({ status: 'unpaired' });
          return;
        }
        setState({
          status: 'paired',
          info: {
            desktopPublicKeyHex: bytesToHex(anchor.desktopStaticPublicKey),
            relayAddress: anchor.relayAddress,
            pairedAt: anchor.pairedAt,
            phonePublicKeyHex: bytesToHex(identity.publicKey),
          },
        });
      } catch (error: unknown) {
        // A Keychain read failing renders as "not paired", which is the
        // recoverable answer for the user and a lie for the developer: the
        // door is what tells the two apart. The message never leaves.
        reportHandledError('devices-paired-info', error);
        if (!cancelled) setState({ status: 'unpaired' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/** Groups a long hex key into readable 4-char clusters, truncated for display. */
export function formatKeyFingerprint(publicKeyHex: string, groups = 4): string {
  const clusters: string[] = [];
  for (let index = 0; index < groups; index += 1) {
    clusters.push(publicKeyHex.slice(index * 4, index * 4 + 4));
  }
  return clusters.join(' ');
}
