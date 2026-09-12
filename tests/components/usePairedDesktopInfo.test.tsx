import { renderHook, waitFor } from '@testing-library/react-native';
import { bytesToHex } from '@kangentic/protocol';
import { usePairedDesktopInfo } from '@/screens/usePairedDesktopInfo';

/**
 * A Keychain read failing here renders the Devices screen as "not paired",
 * which is the recoverable answer for the user and a lie for the developer.
 * The handled-error door is what tells the two apart, so the failure path
 * must call it with the failure and the no-anchor path must not.
 */

const mockLoad = jest.fn();
const mockGetIdentity = jest.fn();
const mockReportHandledError = jest.fn();

// Both stores are instantiated at module scope by the hook's module, so the
// factories below have to exist before it is imported; jest hoists them.
jest.mock('@/pairing/trustAnchor', () => ({
  TrustAnchorStore: jest.fn().mockImplementation(() => ({ load: () => mockLoad() })),
}));
jest.mock('@/pairing/deviceIdentity', () => ({
  DeviceIdentityManager: jest.fn().mockImplementation(() => ({ getIdentity: () => mockGetIdentity() })),
}));
// The arrow forwards its arguments so the failure INSTANCE can be asserted.
jest.mock('@/observability/crashReporting', () => ({
  reportHandledError: (site: string, error: unknown) => mockReportHandledError(site, error),
}));

const phonePublicKey = new Uint8Array(32).fill(7);
const desktopPublicKey = new Uint8Array(32).fill(9);

describe('usePairedDesktopInfo', () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockGetIdentity.mockReset();
    mockReportHandledError.mockClear();
    mockGetIdentity.mockResolvedValue({ publicKey: phonePublicKey });
  });

  it('reports a failed Keychain read through the door and renders it as unpaired', async () => {
    const failure = new Error('keychain unavailable');
    mockLoad.mockRejectedValue(failure);

    const { result } = renderHook(() => usePairedDesktopInfo());

    await waitFor(() => expect(result.current.status).toBe('unpaired'));
    expect(mockReportHandledError).toHaveBeenCalledWith('devices-paired-info', failure);
  });

  it('reports nothing when there is simply no anchor', async () => {
    // The non-vacuity half: an honest "unpaired" is not a failure.
    mockLoad.mockResolvedValue(null);

    const { result } = renderHook(() => usePairedDesktopInfo());

    await waitFor(() => expect(result.current.status).toBe('unpaired'));
    expect(mockReportHandledError).not.toHaveBeenCalled();
  });

  it('resolves the paired info from the anchor and the identity', async () => {
    mockLoad.mockResolvedValue({
      desktopStaticPublicKey: desktopPublicKey,
      relayAddress: 'wss://relay.example.test',
      pairedAt: '2026-09-11T00:00:00.000Z',
    });

    const { result } = renderHook(() => usePairedDesktopInfo());

    await waitFor(() => expect(result.current.status).toBe('paired'));
    expect(result.current).toEqual({
      status: 'paired',
      info: {
        desktopPublicKeyHex: bytesToHex(desktopPublicKey),
        relayAddress: 'wss://relay.example.test',
        pairedAt: '2026-09-11T00:00:00.000Z',
        phonePublicKeyHex: bytesToHex(phonePublicKey),
      },
    });
    expect(mockReportHandledError).not.toHaveBeenCalled();
  });
});
