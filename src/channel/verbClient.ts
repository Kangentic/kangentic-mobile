import {
  parseReadBoardResponsePayload,
  parseReadDiffResponsePayload,
  parseReadStreamResponsePayload,
  parseTranscriptWindowResponsePayload,
  type AnswerPermissionPromptRequestPayload,
  type AnswerPermissionPromptResponsePayload,
  type BoardToolReadName,
  type BoardToolWriteName,
  type CapabilityResponseMessage,
  type CapabilityVerb,
  type DiffFileContentWire,
  type DiffFileListWire,
  type InteractiveTerminalRequestPayload,
  type JsonValue,
  type MoveTaskRequestPayload,
  type MoveTaskResponsePayload,
  type ReadBoardArchivedResponsePayload,
  type ReadBoardProjectListResponsePayload,
  type ReadBoardSnapshotResponsePayload,
  type ReadBoardView,
  type ReadDiffScope,
  type ReadStreamRequestPayload,
  type ReadStreamResponsePayload,
  type RegisterPushRequestPayload,
  type RegisterPushResponsePayload,
  type SendUserMessageRequestPayload,
  type SendUserMessageResponsePayload,
  type TranscriptWindowResponsePayload,
  isRecord,
} from '@kangentic/protocol';
import type { CapabilityClient } from './capabilityClient';

/**
 * Envelope-boundary cast for an already-shape-checked request payload:
 * interfaces have no implicit index signature, so a typed payload does not
 * assign to JsonValue structurally even though it always is one (the same
 * cast the desktop's wire-mappers centralize as toWireJson).
 */
function asRequestJson(payload: unknown): JsonValue {
  return payload as JsonValue;
}

/**
 * `move-task` gets its own, far longer timeout: it is the one verb whose
 * answer waits on real work rather than a lookup.
 *
 * A current desktop answers when the board row commits, which is fast. An
 * older one awaits the whole of handleTaskMove - the PTY suspend, the worktree
 * removal on a Done move, the respawn on an auto-spawn column. Measured across
 * a week of desktop IPC logs, 9% of task:move calls ran past 10s and the
 * slowest took 24.4s, so the shared default turned moves the desktop had
 * already completed into "Move failed", with the card rolled back underneath
 * the user. 45s clears that measured tail with headroom while still failing
 * eventually rather than hanging.
 */
const MOVE_TASK_TIMEOUT_MS = 45_000;

/** A capability request the desktop answered with ok:false (or whose response payload failed its parse guard). */
export class CapabilityError extends Error {
  readonly verb: CapabilityVerb;

  constructor(verb: CapabilityVerb, message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.verb = verb;
  }
}

export interface ReadDiffFileListInput {
  taskId: string;
  projectId: string;
  scope?: ReadDiffScope;
}

export interface ReadDiffFileContentInput extends ReadDiffFileListInput {
  filePath: string;
}

/**
 * Typed per-verb methods over CapabilityClient's raw request/response
 * correlation - the only API stores and actions call for one-shots. Every
 * method builds the verb's typed request payload, throws CapabilityError
 * on ok:false, and runs the protocol package's response parser before
 * returning, so nothing above this file ever handles a raw JsonValue.
 *
 * Live feed events are deliberately NOT here - they arrive unsolicited as
 * EventMessages and are FeedRouter's job; a subscription verb's response
 * here is only its initial snapshot.
 */
export class VerbClient {
  private readonly capabilities: CapabilityClient;

  constructor(capabilities: CapabilityClient) {
    this.capabilities = capabilities;
  }

  /**
   * `terminal: false` subscribes to everything the session list renders -
   * activity, usage, permission, transcript - without the live PTY bytes.
   * The feed discards those bytes anyway (see storeFeed's terminal handler),
   * and on a live board they measured ~13MB an hour with no terminal open.
   * A pre-0.8.0 desktop ignores the flag and keeps sending, which is exactly
   * the behaviour we had before.
   */
  async readStreamSubscribe(sessionId: string, options: { terminal?: boolean } = {}): Promise<ReadStreamResponsePayload> {
    const payload: ReadStreamRequestPayload = {
      sessionId,
      action: 'subscribe',
      ...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
    };
    const response = await this.requireOk('read-stream', asRequestJson(payload));
    return this.parsePayload('read-stream', response, parseReadStreamResponsePayload);
  }

  async readStreamUnsubscribe(sessionId: string): Promise<void> {
    const payload: ReadStreamRequestPayload = { sessionId, action: 'unsubscribe' };
    await this.requireOk('read-stream', asRequestJson(payload));
  }

  /**
   * One-shot windowed transcript read: the newest `limit` entries strictly
   * before `beforeIndex` (or the tail when omitted). The desktop may
   * return fewer entries than asked to keep the frame small - page again
   * from the returned startIndex. Live updates ride TranscriptEvent deltas.
   */
  async readTranscriptWindow(sessionId: string, options: { beforeIndex?: number; limit?: number } = {}): Promise<TranscriptWindowResponsePayload> {
    const payload: ReadStreamRequestPayload = {
      sessionId,
      action: 'transcript-window',
      ...(options.beforeIndex !== undefined ? { beforeIndex: options.beforeIndex } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
    const response = await this.requireOk('read-stream', asRequestJson(payload));
    return this.parsePayload('read-stream', response, parseTranscriptWindowResponsePayload);
  }

  async readProjectList(): Promise<ReadBoardProjectListResponsePayload> {
    const response = await this.requireOk('read-board', {});
    const parsed = this.parsePayload('read-board', response, parseReadBoardResponsePayload);
    if (!('projects' in parsed)) throw new CapabilityError('read-board', 'Expected a project list, received a board snapshot');
    return parsed;
  }

  /**
   * `view` picks the projection: 'sessions' for the feed's cross-project
   * watch, 'full' for the one board the user has open. A pre-0.9.0 desktop
   * ignores it and answers with a full board carrying no `view` echo.
   */
  async readBoardSubscribe(projectId: string, options: { view: ReadBoardView }): Promise<ReadBoardSnapshotResponsePayload> {
    const response = await this.requireOk('read-board', { projectId, action: 'subscribe', view: options.view });
    const parsed = this.parsePayload('read-board', response, parseReadBoardResponsePayload);
    // Narrowed against BOTH other shapes. A snapshot is the only one carrying
    // `columns`, so testing for that identifies it positively rather than by
    // elimination - which is what stops the next response shape added to this
    // union from silently passing through here as a snapshot.
    if (!('columns' in parsed)) {
      throw new CapabilityError('read-board', 'Expected a board snapshot, received a different read-board response');
    }
    return parsed;
  }

  async readBoardUnsubscribe(projectId: string): Promise<void> {
    await this.requireOk('read-board', { projectId, action: 'unsubscribe' });
  }

  /**
   * One page of a project's COMPLETED tasks, newest first, with each one's
   * lifetime session summary (protocol 0.10.0).
   *
   * A one-shot read, not a subscription: neither board projection carries
   * archived tasks, and folding them into the snapshot would re-send an
   * ever-growing list on every board change.
   */
  async readBoardArchived(
    projectId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<ReadBoardArchivedResponsePayload> {
    const response = await this.requireOk('read-board', {
      projectId,
      action: 'archived',
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });
    const parsed = this.parsePayload('read-board', response, parseReadBoardResponsePayload);
    // A pre-0.10.0 desktop does not know the 'archived' action. Its parser
    // rejects the request outright, so this narrowing only has to catch the
    // shapes a 0.10.0 desktop can legitimately return.
    if (!('archivedTasks' in parsed)) {
      throw new CapabilityError('read-board', 'Expected an archived page, received a different read-board response');
    }
    return parsed;
  }

  /** Fetches the diff file list AND (desktop-side) subscribes the task's diff watch; DiffEvents follow until readDiffUnsubscribe. */
  async readDiffFileList(input: ReadDiffFileListInput): Promise<DiffFileListWire> {
    const response = await this.requireOk('read-diff', {
      taskId: input.taskId,
      projectId: input.projectId,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    const parsed = this.parsePayload('read-diff', response, parseReadDiffResponsePayload);
    if (!('files' in parsed)) throw new CapabilityError('read-diff', 'Expected a diff file list, received file content');
    return parsed;
  }

  /** One-shot single-file content fetch; never affects the diff watch. */
  async readDiffFileContent(input: ReadDiffFileContentInput): Promise<DiffFileContentWire> {
    const response = await this.requireOk('read-diff', {
      taskId: input.taskId,
      projectId: input.projectId,
      filePath: input.filePath,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    const parsed = this.parsePayload('read-diff', response, parseReadDiffResponsePayload);
    if ('files' in parsed) throw new CapabilityError('read-diff', 'Expected file content, received a diff file list');
    return parsed;
  }

  async readDiffUnsubscribe(input: { taskId: string; projectId: string }): Promise<void> {
    await this.requireOk('read-diff', { taskId: input.taskId, projectId: input.projectId, action: 'unsubscribe' });
  }

  async sendUserMessage(sessionId: string, text: string): Promise<SendUserMessageResponsePayload> {
    const payload: SendUserMessageRequestPayload = { sessionId, text };
    const response = await this.requireOk('send-user-message', asRequestJson(payload));
    return this.parsePayload('send-user-message', response, (value) => {
      if (!isRecord(value) || typeof value.delivered !== 'boolean') throw new Error('send-user-message response is missing "delivered"');
      return { delivered: value.delivered };
    });
  }

  async moveTask(input: MoveTaskRequestPayload): Promise<MoveTaskResponsePayload> {
    const response = await this.requireOk('move-task', asRequestJson(input), { timeoutMs: MOVE_TASK_TIMEOUT_MS });
    return this.parsePayload('move-task', response, (value) => {
      if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('move-task response is missing "ok"');
      return { ok: value.ok };
    });
  }

  async answerPermissionPrompt(input: AnswerPermissionPromptRequestPayload): Promise<AnswerPermissionPromptResponsePayload> {
    const response = await this.requireOk('answer-permission-prompt', asRequestJson(input));
    return this.parsePayload('answer-permission-prompt', response, (value) => {
      if (!isRecord(value) || typeof value.answered !== 'boolean') throw new Error('answer-permission-prompt response is missing "answered"');
      return { answered: value.answered };
    });
  }

  /**
   * The one thing the phone writes to the terminal: raw keystrokes. The phone
   * is a faithful mirror and deliberately never RESIZES the desktop PTY (the
   * protocol's resize/release actions exist for the desktop, not this client) -
   * a shared session must not be reshaped by the phone.
   */
  async writeInteractiveTerminal(sessionId: string, data: string): Promise<{ written: boolean }> {
    const payload: InteractiveTerminalRequestPayload = { sessionId, action: 'write', data };
    const response = await this.requireOk('interactive-terminal', asRequestJson(payload));
    return this.parsePayload('interactive-terminal', response, (value) => {
      if (!isRecord(value) || typeof value.written !== 'boolean') throw new Error('interactive-terminal response is missing "written"');
      return { written: value.written };
    });
  }

  /** Registers (or unregisters) this device for E2E-encrypted push; see src/notifications/pushRegistration.ts. */
  async registerPush(payload: RegisterPushRequestPayload): Promise<RegisterPushResponsePayload> {
    const response = await this.requireOk('register-push', asRequestJson(payload));
    return this.parsePayload('register-push', response, (value) => {
      if (!isRecord(value) || typeof value.registered !== 'boolean') throw new Error('register-push response is missing "registered"');
      return { registered: value.registered };
    });
  }

  async boardToolRead(tool: BoardToolReadName, params: JsonValue): Promise<JsonValue> {
    const response = await this.requireOk('board-tool-read', { tool, params });
    return this.parsePayload('board-tool-read', response, (value) => {
      if (!isRecord(value) || !('result' in value)) throw new Error('board-tool response is missing "result"');
      return value.result;
    });
  }

  async boardToolWrite(tool: BoardToolWriteName, params: JsonValue): Promise<JsonValue> {
    const response = await this.requireOk('board-tool-write', { tool, params });
    return this.parsePayload('board-tool-write', response, (value) => {
      if (!isRecord(value) || !('result' in value)) throw new Error('board-tool response is missing "result"');
      return value.result;
    });
  }

  private async requireOk(
    verb: CapabilityVerb,
    payload: JsonValue,
    options?: { timeoutMs?: number },
  ): Promise<CapabilityResponseMessage> {
    const response = await this.capabilities.request(verb, payload, options);
    if (!response.ok) throw new CapabilityError(verb, response.error ?? `The desktop rejected the ${verb} request`);
    return response;
  }

  private parsePayload<Parsed>(
    verb: CapabilityVerb,
    response: CapabilityResponseMessage,
    parse: (payload: JsonValue) => Parsed,
  ): Parsed {
    if (response.payload === undefined) throw new CapabilityError(verb, `The ${verb} response carried no payload`);
    try {
      return parse(response.payload);
    } catch (error) {
      throw new CapabilityError(verb, error instanceof Error ? error.message : String(error));
    }
  }
}
