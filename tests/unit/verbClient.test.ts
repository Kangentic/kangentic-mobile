/**
 * VerbClient: typed request payloads per verb, ok:false -> CapabilityError,
 * malformed response payloads -> CapabilityError via the protocol parsers.
 * Runs over the real loopback + stub initiator so the whole encode/seal/
 * decode path is exercised, not a mocked CapabilityClient.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  generateX25519KeyPair,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { CapabilityError, VerbClient } from '@/channel/verbClient';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardSnapshotFixture, diffFileListFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

interface Harness {
  verbs: VerbClient;
  stub: StubSessionInitiator;
  requests: CapabilityRequestMessage[];
}

async function establishedHarness(
  respond: (request: CapabilityRequestMessage) => CapabilityResponseMessage | null,
): Promise<Harness> {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  await phoneTransport.connect();
  await desktopTransport.connect();
  const phoneIdentity = generateX25519KeyPair();
  const desktopIdentity = generateX25519KeyPair();
  const session = new SessionManager({
    identity: phoneIdentity,
    remoteStaticPublicKey: desktopIdentity.publicKey,
    transport: phoneTransport,
  });
  session.start();
  const stub = new StubSessionInitiator(desktopTransport, {
    desktopStatic: desktopIdentity,
    phoneStaticPublicKey: phoneIdentity.publicKey,
  });
  stub.beginHandshake();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const requests: CapabilityRequestMessage[] = [];
  stub.setRequestHandler((request) => {
    requests.push(request);
    return respond(request);
  });
  return { verbs: new VerbClient(new CapabilityClient(session)), stub, requests };
}

function okResponse(request: CapabilityRequestMessage, payload: JsonValue): CapabilityResponseMessage {
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload };
}

describe('VerbClient', () => {
  it('readStreamSubscribe sends the typed payload and parses the snapshot', async () => {
    const snapshot = streamSnapshotFixture({ awaitedPromptId: 'sess-1:tool-1' });
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, snapshot as unknown as JsonValue));

    const parsed = await verbs.readStreamSubscribe('sess-1');

    expect(requests[0].verb).toBe('read-stream');
    expect(requests[0].payload).toEqual({ sessionId: 'sess-1', action: 'subscribe' });
    expect(parsed.scrollback).toBe('initial scrollback');
    expect(parsed.awaitedPromptId).toBe('sess-1:tool-1');
    expect(parsed.activity.state).toBe('thinking');
  });

  it('throws CapabilityError carrying the desktop error on ok:false', async () => {
    const { verbs } = await establishedHarness((request) => ({
      type: 'capability-response',
      requestId: request.requestId,
      ok: false,
      error: 'No such session: sess-ghost',
    }));

    await expect(verbs.readStreamSubscribe('sess-ghost')).rejects.toThrowError(CapabilityError);
    await expect(verbs.readStreamSubscribe('sess-ghost')).rejects.toThrow(/No such session/);
  });

  it('throws CapabilityError when a response payload fails its parse guard', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, { scrollback: 42 }));
    await expect(verbs.readStreamSubscribe('sess-1')).rejects.toThrow(/scrollback/);
  });

  it('readProjectList and readBoardSubscribe discriminate list vs snapshot', async () => {
    const snapshot = boardSnapshotFixture();
    const { verbs, requests } = await establishedHarness((request) => {
      const payload = request.payload as { projectId?: string };
      return okResponse(
        request,
        payload.projectId ? (snapshot as unknown as JsonValue) : { projects: [{ id: 'project-1', name: 'Alpha' }] },
      );
    });

    const projectList = await verbs.readProjectList();
    expect(projectList.projects).toEqual([{ id: 'project-1', name: 'Alpha' }]);
    expect(requests[0].payload).toEqual({});

    const board = await verbs.readBoardSubscribe('project-1', { view: 'sessions' });
    expect(requests[1].payload).toEqual({ projectId: 'project-1', action: 'subscribe', view: 'sessions' });
    expect(board.projectId).toBe('project-1');
    expect(board.tasks).toHaveLength(1);
  });

  it('readDiffFileList vs readDiffFileContent discriminate on "files"', async () => {
    const fileList = diffFileListFixture();
    const { verbs, requests } = await establishedHarness((request) => {
      const payload = request.payload as { filePath?: string };
      return okResponse(
        request,
        payload.filePath
          ? { original: 'old', modified: 'new', language: 'typescript' }
          : (fileList as unknown as JsonValue),
      );
    });

    const list = await verbs.readDiffFileList({ taskId: 'task-1', projectId: 'project-1', scope: 'working' });
    expect(list.files).toHaveLength(2);
    expect(requests[0].payload).toEqual({ taskId: 'task-1', projectId: 'project-1', scope: 'working' });

    const content = await verbs.readDiffFileContent({ taskId: 'task-1', projectId: 'project-1', filePath: 'src/auth/login.ts' });
    expect(content).toEqual({ original: 'old', modified: 'new', language: 'typescript' });
  });

  it('writeInteractiveTerminal sends a write-action payload (the phone never resizes the desktop)', async () => {
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, { written: true }));

    await expect(verbs.writeInteractiveTerminal('sess-1', 'ls\r')).resolves.toEqual({ written: true });
    expect(requests[0].verb).toBe('interactive-terminal');
    expect(requests[0].payload).toEqual({ sessionId: 'sess-1', action: 'write', data: 'ls\r' });
  });

  it('write verbs send their typed payloads and parse boolean results', async () => {
    const { verbs, requests } = await establishedHarness((request) => {
      switch (request.verb) {
        case 'send-user-message':
          return okResponse(request, { delivered: true });
        case 'move-task':
          return okResponse(request, { ok: true });
        case 'answer-permission-prompt':
          return okResponse(request, { answered: true });
        case 'interactive-terminal':
          return okResponse(request, { written: true });
        default:
          return okResponse(request, { result: { created: 'task-2' } });
      }
    });

    await expect(verbs.sendUserMessage('sess-1', 'keep going')).resolves.toEqual({ delivered: true });
    await expect(
      verbs.moveTask({ taskId: 'task-1', targetSwimlaneId: 'lane-doing', targetPosition: 0, projectId: 'project-1' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verbs.answerPermissionPrompt({ sessionId: 'sess-1', promptId: 'sess-1:tool-1', keystrokes: '1\r' }),
    ).resolves.toEqual({ answered: true });
    await expect(verbs.writeInteractiveTerminal('sess-1', '\x1b')).resolves.toEqual({ written: true });
    await expect(verbs.boardToolWrite('create_task', { title: 'New', description: '', column: 'To Do' })).resolves.toEqual({
      created: 'task-2',
    });

    expect(requests.map((request) => request.verb)).toEqual([
      'send-user-message',
      'move-task',
      'answer-permission-prompt',
      'interactive-terminal',
      'board-tool-write',
    ]);
    expect(requests[4].payload).toEqual({ tool: 'create_task', params: { title: 'New', description: '', column: 'To Do' } });
  });

  /**
   * move-task is the one verb whose answer waits on real desktop work rather
   * than a lookup. An older desktop awaits the whole of handleTaskMove - PTY
   * suspend, worktree removal, respawn - and 9% of measured task:move calls ran
   * past the shared 10s default, slowest 24.4s. Those rejected as a plain
   * timeout, which MoveTaskScreen shows as "Move failed - check the
   * connection" while moveTaskOptimistic rolls the card back, for a move the
   * desktop had already committed.
   */
  it('gives move-task a longer timeout than every other verb', async () => {
    // Harness first, on real timers: the handshake flush needs them.
    const { verbs } = await establishedHarness(() => null); // the desktop never answers
    vi.useFakeTimers();
    try {
      const moveSettled = verbs
        .moveTask({ taskId: 'task-1', targetSwimlaneId: 'lane-doing', targetPosition: 0, projectId: 'project-1' })
        .then(() => 'resolved', () => 'rejected');
      const messageSettled = verbs.sendUserMessage('sess-1', 'keep going').then(() => 'resolved', () => 'rejected');
      let moveHasSettled = false;
      void moveSettled.then(() => {
        moveHasSettled = true;
      });

      // Past the shared default: the ordinary verb is already gone.
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(messageSettled).resolves.toBe('rejected');
      expect(moveHasSettled).toBe(false);

      // And past the measured desktop tail it does eventually give up, rather
      // than hanging forever.
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(moveSettled).resolves.toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('registerPush sends the typed registration payload and parses the boolean result', async () => {
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, { registered: true }));

    const pushKeyBase64 = 'a'.repeat(43);
    await expect(
      verbs.registerPush({ action: 'register', expoPushToken: 'ExponentPushToken[test]', pushKeyBase64, platform: 'android' }),
    ).resolves.toEqual({ registered: true });
    expect(requests[0].verb).toBe('register-push');
    expect(requests[0].payload).toEqual({
      action: 'register',
      expoPushToken: 'ExponentPushToken[test]',
      pushKeyBase64,
      platform: 'android',
    });
  });

  it('registerPush rejects a response missing the registered flag', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, { ok: true }));
    await expect(verbs.registerPush({ action: 'unregister' })).rejects.toThrow(/registered/);
  });
});
