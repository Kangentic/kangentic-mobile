import { bytesToHex, randomBytes, type CapabilityResponseMessage, type CapabilityVerb, type JsonValue } from '@kangentic/protocol';
import type { SessionManager } from './sessionManager';

interface PendingRequest {
  resolve: (response: CapabilityResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The transport left `connected` (or the client was disposed) with this
 * request in flight. A normal phone condition, not a defect: the
 * handled-error door in src/observability excludes it by NAME, which is why
 * the name is a literal and must stay in step with that list.
 */
export class ChannelDisconnectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ChannelDisconnectedError';
  }
}

/**
 * The desktop did not answer within the verb's timeout. Carries the verb as
 * a field so the handled-error door can tag it without reading the message.
 */
export class CapabilityTimeoutError extends Error {
  readonly verb: CapabilityVerb;

  constructor(verb: CapabilityVerb) {
    super(`Capability request "${verb}" timed out`);
    this.name = 'CapabilityTimeoutError';
    this.verb = verb;
  }
}

/**
 * Request/response correlation over a SessionManager's BridgeMessage
 * stream. Request ids do not survive a fresh handshake (see
 * SessionManager.reset()) - callers should re-issue a request after a
 * reconnect rather than expect it to resume.
 */
export class CapabilityClient {
  private readonly sessionManager: SessionManager;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribeMessage: () => void;

  constructor(sessionManager: SessionManager, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.sessionManager = sessionManager;
    this.timeoutMs = timeoutMs;
    this.unsubscribeMessage = sessionManager.onMessage((message) => {
      if (message.type === 'capability-response') this.resolvePending(message);
    });
  }

  /**
   * `timeoutMs` overrides this client's default for ONE request. Most verbs
   * are a desktop lookup and answer in milliseconds, but a few block on real
   * work: a `move-task` is answered when the DB row commits on a current
   * desktop, and on an older one only after the whole move - suspend, worktree
   * removal, respawn - which measured a 24.4s tail against a 10s default, so a
   * move the desktop had completed was reported to the user as a failure and
   * rolled back on the board.
   */
  request(verb: CapabilityVerb, payload: JsonValue, options?: { timeoutMs?: number }): Promise<CapabilityResponseMessage> {
    const requestId = bytesToHex(randomBytes(16));
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    return new Promise<CapabilityResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CapabilityTimeoutError(verb));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });

      try {
        this.sessionManager.send({ type: 'capability-request', requestId, verb, payload });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Rejects every in-flight request - call this when the transport drops, since a fresh handshake invalidates all pending request ids. */
  rejectAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new ChannelDisconnectedError(reason));
    }
    this.pending.clear();
  }

  dispose(): void {
    this.rejectAllPending('CapabilityClient disposed');
    this.unsubscribeMessage();
  }

  private resolvePending(message: CapabilityResponseMessage): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.pending.delete(message.requestId);
    entry.resolve(message);
  }
}
