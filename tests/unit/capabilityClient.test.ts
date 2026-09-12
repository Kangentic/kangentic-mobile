import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityClient, CapabilityTimeoutError, ChannelDisconnectedError } from '@/channel/capabilityClient';
import type { SessionManager } from '@/channel/sessionManager';

/**
 * The two typed rejections the handled-error door relies on. Without a class
 * for the mid-request socket drop, the door would have nothing to exclude for
 * the single most common normal condition on a phone, and a message match
 * would creep back in; without one for the timeout, the verb it carries could
 * only be read out of the message. Messages stay byte-for-byte what they were.
 */

/** Only the two members CapabilityClient touches; the rest of SessionManager is irrelevant here. */
function stubSessionManager(): SessionManager {
  const stub: Pick<SessionManager, 'onMessage' | 'send'> = {
    onMessage: vi.fn(() => () => undefined),
    send: vi.fn(),
  };
  return stub as SessionManager;
}

describe('CapabilityClient typed rejections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a timed-out request with CapabilityTimeoutError carrying the verb', async () => {
    const client = new CapabilityClient(stubSessionManager(), 50);
    const request = client.request('read-board', {});
    // Attach the handler before the timer fires, so the rejection is observed
    // rather than reported as unhandled.
    const outcome = request.then(
      () => 'resolved',
      (error: unknown) => error,
    );

    vi.advanceTimersByTime(50);
    const error = await outcome;

    expect(error).toBeInstanceOf(CapabilityTimeoutError);
    expect(error).toBeInstanceOf(Error);
    expect((error as CapabilityTimeoutError).verb).toBe('read-board');
    expect((error as Error).name).toBe('CapabilityTimeoutError');
    expect((error as Error).message).toBe('Capability request "read-board" timed out');
  });

  it('rejects every in-flight request with ChannelDisconnectedError when the transport drops', async () => {
    const client = new CapabilityClient(stubSessionManager());
    const outcomes = [client.request('read-board', {}), client.request('move-task', {})].map((request) =>
      request.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
    );

    client.rejectAllPending('Channel disconnected');
    const errors = await Promise.all(outcomes);

    for (const error of errors) {
      expect(error).toBeInstanceOf(ChannelDisconnectedError);
      expect((error as Error).name).toBe('ChannelDisconnectedError');
      expect((error as Error).message).toBe('Channel disconnected');
    }
  });
});
