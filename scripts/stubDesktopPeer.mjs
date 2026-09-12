#!/usr/bin/env node
/**
 * A desktop counterpart to Kangentic Mobile's pairing + secure channel
 * client, run over a REAL WebSocket against a locally running
 * relay. This is a manual integration smoke, not part of the
 * automated test suite (that lives in tests/unit/, driven by the same
 * @kangentic/protocol code over an in-memory loopback transport).
 *
 * Usage:
 *   1. Run a local relay (see that repo's README), e.g. on
 *      ws://127.0.0.1:8080.
 *   2. node scripts/stubDesktopPeer.mjs --relay ws://127.0.0.1:8080
 *   3. Scan the printed kangentic-pair:// URI with the app, or paste it into
 *      the "paste pairing link" fallback (the camera can't see a terminal).
 *   4. Confirm the SAS shown here matches the phone's screen, then answer
 *      the prompt. On confirm, this script opens a second connection for the
 *      ongoing session and exchanges heartbeats.
 *
 * Because @kangentic/protocol is pure TypeScript on @noble/*, this script
 * runs the EXACT same handshake code the phone runs on Hermes - it is a
 * faithful desktop stand-in, not a mock.
 */
import readline from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bytesToHex,
  createKKHandshake,
  createPairingResponderHandshake,
  decodeMessage,
  derivePairingSlotId,
  deriveSecretstreamPair,
  deriveSessionSlotId,
  deriveShortAuthenticationString,
  encodeMessage,
  encodePairingQrPayload,
  FrameTag,
  generateX25519KeyPair,
  hexToBytes,
  openPairingConfirm,
  PROTOCOL_VERSION,
  randomBytes,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
} from '@kangentic/protocol';

// A silent stub death strands every paired Maestro flow behind it; always
// leave a stack trace so the crash is diagnosable from the rig log.
process.on('uncaughtException', (fatalError) => {
  console.error('[fatal] uncaught exception:', fatalError?.stack ?? fatalError);
  process.exit(1);
});
process.on('unhandledRejection', (fatalReason) => {
  console.error('[fatal] unhandled rejection:', fatalReason instanceof Error ? fatalReason.stack : fatalReason);
  process.exit(1);
});

// Persist the stub's static X25519 identity OUTSIDE the repo so restarting
// the stub (e.g. to pick up code changes, or after a phone reload) keeps the
// same desktop key the phone pinned at pairing - no re-pairing needed. The
// pairing token is still fresh per run (single-use); only the static key is
// stable. Delete this file to force a fresh identity.
const DEFAULT_IDENTITY_FILE = join(tmpdir(), 'kangentic-stub-desktop-identity.json');

function generateAndPersistDesktopStatic(identityFile) {
  const keypair = generateX25519KeyPair();
  writeFileSync(identityFile, JSON.stringify({ secretKey: bytesToHex(keypair.secretKey), publicKey: bytesToHex(keypair.publicKey) }));
  console.log(`[identity] generated a new stub desktop identity at ${identityFile}`);
  return keypair;
}

function loadOrCreateDesktopStatic(identityFile) {
  if (existsSync(identityFile)) {
    try {
      const stored = JSON.parse(readFileSync(identityFile, 'utf8'));
      return { secretKey: hexToBytes(stored.secretKey), publicKey: hexToBytes(stored.publicKey) };
    } catch (parseError) {
      console.log(`[identity] ignoring unreadable ${identityFile}: ${parseError.message}`);
    }
  }
  return generateAndPersistDesktopStatic(identityFile);
}

function parseArgs(argv) {
  const relayIndex = argv.indexOf('--relay');
  const relayUrl = relayIndex >= 0 ? argv[relayIndex + 1] : 'ws://127.0.0.1:8080';
  // --yes: skip the interactive SAS confirmation (Maestro flows and
  // agent-driven runs have no stdin). The SAS still prints for an eyeball
  // check against the phone; this stub trusts its own loopback rig.
  const autoConfirm = argv.includes('--yes');
  // --phone-key <hex>: skip pairing and open the ongoing session directly,
  // for a phone already paired to this stub's persisted identity (printed as
  // "Phone static key: ..." on the first pairing). Lets the stub restart
  // without a re-pair.
  const phoneKeyIndex = argv.indexOf('--phone-key');
  const phoneKeyHex = phoneKeyIndex >= 0 ? argv[phoneKeyIndex + 1] : null;
  // --identity-file <path>: this instance's persisted desktop identity.
  // Sharded rigs run one stub PER DEVICE, and each needs its own identity:
  // the pairing slot and the session slot both derive from the desktop
  // static key, so two stubs sharing one identity would collide on the
  // relay.
  const identityIndex = argv.indexOf('--identity-file');
  const identityFile = identityIndex >= 0 ? argv[identityIndex + 1] : DEFAULT_IDENTITY_FILE;
  // --advertise-relay <url>: the relay address baked into the pairing QR
  // (what the PHONE dials), when it differs from the address THIS process
  // dials. The emulator reaches host loopback as ws://10.0.2.2:8080 (its
  // NAT alias, no adb reverse involved), while the stub on the host dials
  // ws://127.0.0.1:8080 - same relay, two vantage points. CI uses the same
  // split.
  const advertiseIndex = argv.indexOf('--advertise-relay');
  const advertiseRelayUrl = advertiseIndex >= 0 ? argv[advertiseIndex + 1] : relayUrl;
  return { relayUrl, autoConfirm, phoneKeyHex, identityFile, advertiseRelayUrl };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => resolve(socket);
    socket.onerror = (event) => reject(new Error(`WebSocket error connecting to ${url}: ${event.message ?? 'unknown error'}`));
  });
}

function onFrame(socket, listener) {
  socket.onmessage = (event) => {
    const data = event.data;
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(0);
    listener(frame);
  };
}

/** How long the stub keeps re-parking its pairing socket. Matches the token's ~10 minute lifetime. */
const PAIRING_WAIT_MS = 10 * 60 * 1000;

async function runPairing(relayUrl, desktopStatic, pairingToken) {
  // Derived, never the token itself - the slot travels in cleartext in the
  // relay URL and the token is the Noise PSK. Mirrors the desktop's
  // startPairing() byte-for-byte.
  const slotId = derivePairingSlotId(pairingToken);
  const deadline = Date.now() + PAIRING_WAIT_MS;

  // The relay reaps a parked (peer-less) connection after PARK_TIMEOUT_MS
  // (60s default), so a stub waiting on a slow human would silently lose
  // its socket and exit 0 when the event loop drained. Reconnect the
  // pairing slot whenever it closes before the phone showed up.
  return new Promise((resolve, reject) => {
    let settled = false;

    const park = async () => {
      let socket;
      try {
        socket = await connect(`${relayUrl}?slot=${slotId}`);
      } catch (error) {
        if (Date.now() > deadline) {
          reject(new Error(`Gave up waiting for the phone: ${error.message}`));
          return;
        }
        setTimeout(park, 1000);
        return;
      }
      const handshake = createPairingResponderHandshake({ localStatic: desktopStatic, pairingToken });
      socket.onclose = () => {
        if (settled) return;
        if (Date.now() > deadline) {
          reject(new Error('Gave up waiting for the phone (pairing token expired)'));
          return;
        }
        console.log('[pairing] relay parked-connection timeout; reconnecting the pairing slot...');
        setTimeout(park, 500);
      };
      // Two phases, exactly like the real desktop's pairing-service: read
      // message 1 and answer it, THEN wait for the phone's sealed confirm
      // frame before treating the device as paired.
      let awaitingConfirm = null;
      onFrame(socket, (frame) => {
        if (awaitingConfirm) {
          // The AEAD open IS the SAS check: the frame only opens if both
          // sides ran the same handshake transcript. A failed open is a
          // failure, never a silent no-op.
          if (!openPairingConfirm(awaitingConfirm.initiatorToResponder, frame)) {
            settled = true;
            reject(new Error('Pairing confirm frame failed to open (transcript mismatch)'));
            return;
          }
          const { phoneStaticPublicKey, sas } = awaitingConfirm;
          settled = true;
          socket.onclose = null;
          resolve({ phoneStaticPublicKey, sas, socket });
          return;
        }

        try {
          handshake.readMessage(frame);
        } catch (error) {
          settled = true;
          reject(new Error(`Pairing handshake failed to authenticate: ${error.message}`));
          return;
        }
        const { message, split } = handshake.writeMessage(new Uint8Array(0));
        socket.send(message.slice().buffer);
        if (!split) {
          settled = true;
          reject(new Error('Pairing handshake did not split after message 2'));
          return;
        }

        const phoneStaticPublicKey = handshake.getRemoteStaticKey();
        const sas = deriveShortAuthenticationString(handshake.getHandshakeHash());
        // Printed BEFORE the wait so a human can compare digits while the
        // phone is still showing them.
        console.log(`[pairing] SAS ${sas.digits ?? sas}: waiting for the phone to confirm...`);
        awaitingConfirm = { phoneStaticPublicKey, sas, initiatorToResponder: split[0] };
      });
    };

    void park();
  });
}

/**
 * Canned Phase 2 data: one project, a small board, and one "live" session
 * that streams terminal chunks, flips activity states, and raises a
 * permission prompt after a while, so every phone surface (triage, board,
 * conversation, terminal, changes, prompt cards) has something real to
 * render without a desktop.
 */
const STUB_PROJECT = { id: 'stub-project', name: 'Stub Project' };
const STUB_SESSION_ID = 'stub-session-1';
const STUB_TASK_ID = 'stub-task-1';
const STUB_PROMPT_ID = `${STUB_SESSION_ID}:stub-tool-2`;
// A second, TRANSCRIPT-LESS session (agent: codex): exercises the chat
// reading-view fallback (mirrors mockDesktop.ts).
const STUB_CODEX_SESSION_ID = 'stub-session-codex';
const STUB_CODEX_TASK_ID = 'stub-task-codex';

/** A codex-style fullscreen TUI frame: cursor-home + full rewrite each paint. */
function codexTuiFrame(paintTick) {
  const spinnerGlyphs = ['|', '/', '-', '\\'];
  const spinner = spinnerGlyphs[paintTick % spinnerGlyphs.length];
  const statusLine = paintTick % 2 === 0 ? 'Refactoring src/billing/invoice.ts' : 'Running the affected tests';
  return (
    '\x1b[H\x1b[2J' +
    'codex session (stub)\r\n' +
    '╭────────────────────────╮\r\n' +
    `${statusLine} ${spinner}\r\n` +
    '╰────────────────────────╯\r\n' +
    `files touched: ${3 + (paintTick % 4)} · tests: ${12 + paintTick}\r\n`
  );
}

function nowIso() {
  return new Date().toISOString();
}

function stubColumns() {
  return [
    { id: 'lane-todo', name: 'To Do', description: null, role: 'todo', position: 0, color: '#3fb950', icon: null, is_archived: false, is_ghost: false },
    { id: 'lane-doing', name: 'Doing', description: null, role: null, position: 1, color: '#d29922', icon: null, is_archived: false, is_ghost: false },
    { id: 'lane-done', name: 'Done', description: null, role: 'done', position: 2, color: '#8957e5', icon: null, is_archived: false, is_ghost: false },
  ];
}

function stubTask(id, displayId, title, swimlaneId, position, sessionId) {
  return {
    id, display_id: displayId, title, description: 'Stubbed for manual integration testing.', swimlane_id: swimlaneId, position,
    agent: 'claude', session_id: sessionId, worktree_path: null, branch_name: sessionId ? 'feature/stub-work' : null,
    pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: [], priority: 0, attachment_count: 0,
    archived_at: null, created_at: nowIso(), updated_at: nowIso(),
  };
}

/**
 * Completed tasks, served only by the `archived` action (protocol 0.10.0).
 *
 * Deliberately NOT in the board snapshot, mirroring the desktop: a task is
 * archived the moment it lands in the done lane, so every board projection
 * has already dropped it. A stub that left these in the snapshot would let a
 * phone bug that reads the Done column from the wrong source pass here and
 * fail against a real desktop.
 *
 * The second task carries no summary, which is the sparse case the wire
 * contract allows: a task archived without ever running an agent has nothing
 * to summarize, and the phone must render it rather than treat it as an error.
 */
function stubArchivedTasks() {
  return [
    {
      ...stubTask('stub-task-archived-1', 4, 'Shipped: the completed stub task', 'lane-done', 0, null),
      archived_at: '2026-07-20T18:30:00.000Z',
    },
    {
      ...stubTask('stub-task-archived-2', 5, 'Closed without an agent', 'lane-done', 1, null),
      archived_at: '2026-07-19T09:15:00.000Z',
    },
  ];
}

function stubArchivedSummaries() {
  return {
    'stub-task-archived-1': {
      sessionId: 'stub-session-archived-1',
      totalCostUsd: 1.2345,
      totalInputTokens: 120_000,
      totalOutputTokens: 8_400,
      modelDisplayName: 'Sonnet 5',
      durationMs: 3_720_000,
      toolCallCount: 42,
      compactionCount: 1,
      linesAdded: 210,
      linesRemoved: 18,
      filesChanged: 7,
      taskCreatedAt: '2026-07-19T12:00:00.000Z',
      startedAt: '2026-07-20T17:00:00.000Z',
      exitedAt: '2026-07-20T18:02:00.000Z',
      exitCode: 0,
    },
  };
}

function stubBoardSnapshot(activeSessionId) {
  const codexTask = { ...stubTask(STUB_CODEX_TASK_ID, 3, 'Codex refactor (no structured transcript)', 'lane-doing', 1, STUB_CODEX_SESSION_ID), agent: 'codex' };
  return {
    projectId: STUB_PROJECT.id,
    columns: stubColumns(),
    tasks: [
      stubTask(STUB_TASK_ID, 1, 'Streaming stub session', 'lane-doing', 0, activeSessionId),
      stubTask('stub-task-2', 2, 'A quiet backlog-ish card', 'lane-todo', 0, null),
      codexTask,
    ],
    backlog: [],
  };
}

/**
 * Mirrors the desktop handler's projection rules (protocol 0.9.0): a request
 * that names a `view` gets no backlog, and 'sessions' gets only the tasks with
 * a session on them, plus whole-column counts taken BEFORE the filter.
 *
 * Applied after the stub's own board mutations, so a card created over the
 * wire is projected the same way a real one would be.
 */
function projectBoardSnapshot(snapshot, view) {
  if (view === undefined) return snapshot;
  const taskCountsByColumnId = {};
  for (const task of snapshot.tasks) {
    taskCountsByColumnId[task.swimlane_id] = (taskCountsByColumnId[task.swimlane_id] ?? 0) + 1;
  }
  const { backlog: _backlog, ...withoutBacklog } = snapshot;
  return {
    ...withoutBacklog,
    tasks: view === 'sessions' ? snapshot.tasks.filter((task) => task.session_id !== null) : snapshot.tasks,
    view,
    ...(view === 'sessions' ? { taskCountsByColumnId } : {}),
  };
}

function stubTranscript() {
  return [
    { kind: 'user', uuid: 'stub-user-1', ts: Date.now() - 60000, text: 'Fix the login redirect bug and add a regression test.' },
    {
      kind: 'assistant', uuid: 'stub-assistant-1', ts: Date.now() - 55000,
      blocks: [
        { type: 'text', text: 'Looking at the auth flow now. The redirect drops the `next` parameter on **expired-session** logins.' },
        { type: 'tool_use', id: 'stub-tool-1', name: 'Bash', input: { command: 'rg -n "next=" src/auth' } },
      ],
    },
    { kind: 'tool_result', uuid: 'stub-result-1', ts: Date.now() - 50000, toolUseId: 'stub-tool-1', content: 'src/auth/login.ts:42: redirect(`/login?next=${encodeURIComponent(path)}`)' },
  ];
}

function stubDiffFileList() {
  return {
    files: [
      { path: 'src/auth/login.ts', status: 'M', insertions: 8, deletions: 2, binary: false },
      { path: 'tests/auth-redirect.test.ts', status: 'A', insertions: 31, deletions: 0, binary: false },
    ],
    totalInsertions: 39,
    totalDeletions: 2,
  };
}

function stubDiffFileContent(filePath) {
  if (filePath === 'src/auth/login.ts') {
    return {
      original: 'export function loginRedirect(path) {\n  redirect("/login");\n}\n',
      modified: 'export function loginRedirect(path) {\n  const next = encodeURIComponent(path);\n  redirect(`/login?next=${next}`);\n}\n',
      language: 'typescript',
    };
  }
  return { original: '', modified: 'test("redirect keeps next", () => {\n  expect(loginRedirect("/boards")).toContain("next=");\n});\n', language: 'typescript' };
}

function runSession(relayUrl, desktopStatic, phoneStaticPublicKey) {
  const slotId = deriveSessionSlotId(desktopStatic.publicKey, phoneStaticPublicKey);
  return connect(`${relayUrl}?slot=${slotId}`).then((socket) => {
    let streams = null;
    let streamSubscribed = false;
    let permissionPending = false;
    let feedTimer = null;
    let feedTick = 0;
    // The stub's PTY grid: reported in the subscribe snapshot, overridden by
    // a fit-mode resize, restored by release-size. A scripted desktop-origin
    // refit fires at tick 30 so Maestro can exercise mirror-mode re-layout.
    const STUB_DESKTOP_DIMS = { cols: 120, rows: 30 };
    let ptyDimensions = { ...STUB_DESKTOP_DIMS };
    // Protocol v2: the transcript never ships wholesale. This array is the
    // stub's authoritative conversation; appends stream as indexed deltas
    // and history loads via the read-stream transcript-window action.
    let transcriptEntries = stubTranscript();
    let transcriptRevision = 1;
    // Session-lifecycle simulation (the /respawn and /end-session magic
    // composer commands): the streaming task's CURRENT session id, mirroring
    // the desktop respawning a task's agent under a fresh id.
    let activeSessionId = STUB_SESSION_ID;
    let respawnCounter = 1;
    let codexStreamSubscribed = false;
    // Board statefulness: mutations from board-tool-write / move-task overlay
    // the canned snapshot so Maestro can assert create/edit/move/delete.
    const boardMutations = { patches: new Map(), deleted: new Set(), created: [] };
    let createdTaskCounter = 0;

    /**
     * Back to the canned fixture. Called on every session establish, which is
     * exactly one Maestro flow (each opens with launchApp, which force-stops
     * the app and brings the session back up here).
     *
     * BOTH halves matter. The board half stops create/edit/move/delete piling
     * up across flows. The lifecycle half stops `/end-session` from ending the
     * run: it nulls activeSessionId, nothing restored it, and every later flow
     * then looked for a session row that no longer existed. That is why
     * session-respawn-recovery has been failing - it runs directly after
     * session-ended-state, and was never a product bug at all.
     */
    function resetStubFixture() {
      boardMutations.patches.clear();
      boardMutations.deleted.clear();
      boardMutations.created.length = 0;
      createdTaskCounter = 0;
      transcriptEntries = stubTranscript();
      transcriptRevision = 1;
      activeSessionId = STUB_SESSION_ID;
      respawnCounter = 1;
      codexStreamSubscribed = false;
    }

    function applyBoardMutations(snapshot) {
      const tasks = snapshot.tasks
        .filter((task) => !boardMutations.deleted.has(task.id))
        .map((task) => ({ ...task, ...(boardMutations.patches.get(task.id) ?? {}) }));
      const createdTasks = boardMutations.created.filter((task) => !boardMutations.deleted.has(task.id));
      return { ...snapshot, tasks: [...tasks, ...createdTasks] };
    }

    function send(message) {
      if (!streams) throw new Error('session not established yet');
      if (socket.readyState !== WebSocket.OPEN) throw new Error('session socket is closed');
      const frame = streams.send.seal(encodeMessage(message));
      socket.send(wrapSessionFrame(SessionFrameKind.Application, frame).slice().buffer);
    }

    /**
     * send() for fire-and-forget paths driven by timers or delayed pushes:
     * a tick can fire in the window between the socket closing and the
     * close handler clearing the timers, and that must drop the frame, not
     * crash the stub (the pre-hardening silent stub deaths were exactly
     * this throw escaping a timer callback).
     */
    function sendSafe(message, contextLabel) {
      try {
        send(message);
      } catch (sendError) {
        console.log(`[session] dropped ${contextLabel}: ${sendError.message}`);
      }
    }

    function sendEvent(event) {
      sendSafe({ type: 'event', event }, 'an event send');
    }

    function emitPtyResize() {
      if (!streamSubscribed || activeSessionId === null) return;
      sendEvent({ kind: 'terminal-resize', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { ...ptyDimensions } });
    }

    function appendTranscriptEntry(entry) {
      if (activeSessionId === null) return;
      transcriptEntries.push(entry);
      transcriptRevision += 1;
      if (!streamSubscribed) return;
      sendEvent({
        kind: 'transcript',
        sessionId: activeSessionId,
        taskId: STUB_TASK_ID,
        payload: {
          mode: 'delta',
          revision: transcriptRevision,
          totalEntries: transcriptEntries.length,
          upserts: [{ index: transcriptEntries.length - 1, entry }],
        },
      });
    }

    function emitBoardTaskUpdated() {
      sendEvent({ kind: 'board', projectId: STUB_PROJECT.id, taskId: STUB_TASK_ID, payload: { change: 'task-updated', ids: [STUB_TASK_ID] } });
    }

    // The /end-session magic command: the desktop stops running a session
    // for the task; subsequent subscribes to the dead id fail like the real
    // bridge once the registry entry is gone.
    function endActiveSession() {
      permissionPending = false;
      const endedSessionId = activeSessionId;
      // The real desktop pushes a session-ended ACTIVITY event immediately
      // before it tears the read-stream subscription down, and that event is
      // what the phone's ended state and its session-failed notification key
      // on. The stub only emitted the board change, so it exercised a path
      // the desktop does not rely on and left the real one untested.
      //
      // It matters more since the 0.9.0 board projection: under `view:
      // 'sessions'` a task whose session ended is filtered out of the board
      // entirely, so the phone cannot fall back to "the board says this task
      // has no session" - the task is simply gone. The event is now the
      // load-bearing signal.
      if (endedSessionId !== null) {
        sendEvent({
          kind: 'activity',
          sessionId: endedSessionId,
          taskId: STUB_TASK_ID,
          payload: { type: 'session-ended', intentional: true },
        });
      }
      activeSessionId = null;
      streamSubscribed = false;
      console.log('[lifecycle] /end-session: task now has no session');
      emitBoardTaskUpdated();
    }

    // The /respawn magic command: the desktop restarts the task's agent
    // under a FRESH session id (a model switch). The transcript resets with
    // a marker entry Maestro can assert on.
    function respawnActiveSession() {
      respawnCounter += 1;
      const successorSessionId = `stub-session-${respawnCounter}`;
      permissionPending = false;
      activeSessionId = successorSessionId;
      streamSubscribed = false;
      transcriptEntries = [
        {
          kind: 'assistant',
          uuid: `stub-respawn-marker-${respawnCounter}`,
          ts: Date.now(),
          blocks: [{ type: 'text', text: `Respawned session online (${successorSessionId}).` }],
        },
      ];
      transcriptRevision = 1;
      console.log(`[lifecycle] /respawn: task now runs ${successorSessionId}`);
      emitBoardTaskUpdated();
    }

    // A little agent-life simulator: terminal chunks stream continuously;
    // every ~12 ticks the transcript grows a turn (streamed as a delta); at
    // tick 20 a permission prompt raises and stays pending until answered.
    function startFeed() {
      if (feedTimer) return;
      feedTimer = setInterval(() => {
        if (!streams) return;
        feedTick += 1;
        if (codexStreamSubscribed && feedTick % 2 === 0) {
          sendEvent({ kind: 'terminal', sessionId: STUB_CODEX_SESSION_ID, taskId: STUB_CODEX_TASK_ID, payload: { data: codexTuiFrame(feedTick / 2) } });
        }
        if (!streamSubscribed || activeSessionId === null) return;
        sendEvent({ kind: 'terminal', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { data: `tick ${feedTick}: scanning src/auth for redirect handling...\r\n` } });
        if (feedTick % 12 === 0) {
          appendTranscriptEntry({
            kind: 'assistant',
            uuid: `stub-assistant-tick-${feedTick}`,
            ts: Date.now(),
            blocks: [{ type: 'tool_use', id: `stub-tool-tick-${feedTick}`, name: 'Bash', input: { command: 'npm run test:unit -- auth-redirect' } }],
          });
        }
        if (feedTick === 30 && ptyDimensions.cols === STUB_DESKTOP_DIMS.cols && ptyDimensions.rows === STUB_DESKTOP_DIMS.rows) {
          // Simulate the desktop user drag-resizing their pane: the phone's
          // mirror view should re-lay out without a reload.
          ptyDimensions = { cols: 100, rows: 28 };
          emitPtyResize();
          console.log('[feed] desktop pane resized to 100x28 (terminal-resize pushed)');
        }
        if (feedTick === 20 && !permissionPending) {
          permissionPending = true;
          // The awaited tool_use lands in the transcript first so the phone's
          // prompt card can show the exact command being approved.
          appendTranscriptEntry({
            kind: 'assistant',
            uuid: 'stub-assistant-2',
            ts: Date.now(),
            blocks: [{ type: 'tool_use', id: 'stub-tool-2', name: 'Bash', input: { command: 'npm run test:unit -- auth-redirect' } }],
          });
          sendEvent({ kind: 'activity', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { type: 'permission', promptId: STUB_PROMPT_ID, pending: true } });
          sendEvent({ kind: 'activity', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { type: 'activity', state: 'permission', reason: { kind: 'permission' } } });
          console.log('[feed] raised a permission prompt (answer it from the phone)');
        }
      }, 1000);
    }

    function answerCapabilityRequest(request) {
      const { requestId, verb, payload } = request;
      console.log(`[verb] ${verb}`, JSON.stringify(payload));
      const ok = (responsePayload) => sendSafe({ type: 'capability-response', requestId, ok: true, ...(responsePayload === undefined ? {} : { payload: responsePayload }) }, 'a capability response');
      const fail = (error) => sendSafe({ type: 'capability-response', requestId, ok: false, error }, 'a capability response');

      switch (verb) {
        case 'read-board': {
          if (!payload.projectId) return ok({ projects: [STUB_PROJECT] });
          if (payload.action === 'unsubscribe') return ok();
          if (payload.action === 'archived') {
            // One page, newest-archived first, honouring limit/offset so the
            // phone's paging cursor is exercised rather than assumed.
            const all = stubArchivedTasks();
            const offset = payload.offset ?? 0;
            const limit = payload.limit ?? 25;
            return ok({
              projectId: payload.projectId,
              archivedTasks: all.slice(offset, offset + limit),
              archivedTotalCount: all.length,
              summariesByTaskId: stubArchivedSummaries(),
            });
          }
          return ok(projectBoardSnapshot(applyBoardMutations(stubBoardSnapshot(activeSessionId)), payload.view));
        }
        case 'read-stream': {
          if (payload.action === 'unsubscribe') {
            if (payload.sessionId === STUB_CODEX_SESSION_ID) codexStreamSubscribed = false;
            else streamSubscribed = false;
            return ok();
          }
          if (payload.sessionId === STUB_CODEX_SESSION_ID) {
            if (payload.action === 'transcript-window') {
              // No structured transcript: the loaded-but-empty window flips
              // the phone's chat lens to the reading view.
              return ok({ revision: 1, totalEntries: 0, startIndex: 0, entries: [] });
            }
            codexStreamSubscribed = true;
            startFeed();
            return ok({
              scrollback: codexTuiFrame(0),
              activity: { state: 'thinking', reason: { kind: 'turn-active' } },
              usage: null,
              awaitedPromptId: null,
              ptyDimensions: { ...ptyDimensions },
            });
          }
          if (activeSessionId === null || payload.sessionId !== activeSessionId) return fail(`No such session: ${payload.sessionId}`);
          if (payload.action === 'transcript-window') {
            const end = Math.min(payload.beforeIndex ?? transcriptEntries.length, transcriptEntries.length);
            const start = Math.max(0, end - (payload.limit ?? 60));
            return ok({
              revision: transcriptRevision,
              totalEntries: transcriptEntries.length,
              startIndex: start,
              entries: transcriptEntries.slice(start, end),
            });
          }
          streamSubscribed = true;
          startFeed();
          return ok({
            scrollback: 'kangentic stub desktop\r\n$ claude\r\nWorking on the login redirect bug...\r\n',
            activity: { state: permissionPending ? 'permission' : 'thinking', reason: permissionPending ? { kind: 'permission' } : { kind: 'turn-active' } },
            usage: null,
            awaitedPromptId: permissionPending ? STUB_PROMPT_ID : null,
            ptyDimensions: { ...ptyDimensions },
          });
        }
        case 'read-diff':
          if (payload.action === 'unsubscribe') return ok();
          if (payload.filePath) return ok(stubDiffFileContent(payload.filePath));
          return ok(stubDiffFileList());
        case 'send-user-message':
          console.log(`[message] phone says: ${payload.text}`);
          if (payload.text.trim() === '/respawn') {
            respawnActiveSession();
            return ok({ delivered: true });
          }
          if (payload.text.trim() === '/end-session') {
            endActiveSession();
            return ok({ delivered: true });
          }
          return ok({ delivered: true });
        case 'move-task': {
          const movePatch = boardMutations.patches.get(payload.taskId) ?? {};
          movePatch.swimlane_id = payload.targetSwimlaneId;
          movePatch.position = payload.targetPosition;
          boardMutations.patches.set(payload.taskId, movePatch);
          setTimeout(() => sendEvent({ kind: 'board', projectId: STUB_PROJECT.id, taskId: payload.taskId, payload: { change: 'task-updated', ids: [payload.taskId] } }), 50);
          return ok({ ok: true });
        }
        case 'answer-permission-prompt':
          if (!permissionPending || payload.promptId !== STUB_PROMPT_ID) {
            return fail('promptId does not match the currently outstanding prompt (stale or already answered)');
          }
          permissionPending = false;
          console.log(`[prompt] answered with keystrokes ${JSON.stringify(payload.keystrokes)}`);
          setTimeout(() => {
            if (activeSessionId === null) return;
            sendEvent({ kind: 'activity', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { type: 'permission', promptId: STUB_PROMPT_ID, pending: false } });
            sendEvent({ kind: 'activity', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } } });
          }, 50);
          return ok({ answered: true });
        case 'interactive-terminal':
          if (payload.action === 'resize') {
            const colsChanged = payload.dimensions.cols !== ptyDimensions.cols;
            ptyDimensions = { cols: payload.dimensions.cols, rows: payload.dimensions.rows };
            console.log(`[pty] phone resized the grid to ${ptyDimensions.cols}x${ptyDimensions.rows}`);
            emitPtyResize();
            return ok({ resized: true, colsChanged });
          }
          if (payload.action === 'release-size') {
            ptyDimensions = { ...STUB_DESKTOP_DIMS };
            console.log('[pty] phone released the grid; restored desktop dims');
            emitPtyResize();
            return ok({ released: true });
          }
          console.log(`[pty] phone wrote ${JSON.stringify(payload.data)}`);
          if (activeSessionId === null) return fail('No active session');
          sendEvent({ kind: 'terminal', sessionId: activeSessionId, taskId: STUB_TASK_ID, payload: { data: payload.data.replace(/\r/g, '\r\n') } });
          return ok({ written: true });
        case 'board-tool-read':
          return ok({ result: { note: `stub answered ${payload.tool}` } });
        case 'board-tool-write': {
          console.log(`[board-tool] ${payload.tool}`, JSON.stringify(payload.params));
          const params = payload.params ?? {};
          if (payload.tool === 'create_task') {
            createdTaskCounter += 1;
            const created = stubTask(`stub-created-${createdTaskCounter}`, 100 + createdTaskCounter, String(params.title ?? 'Untitled stub task'), 'lane-todo', 0, null);
            created.description = String(params.description ?? '');
            boardMutations.created.push(created);
            setTimeout(() => sendEvent({ kind: 'board', projectId: STUB_PROJECT.id, taskId: created.id, payload: { change: 'task-created', ids: [created.id] } }), 50);
            return ok({ result: { created: created.id } });
          }
          if (payload.tool === 'update_task') {
            const patch = boardMutations.patches.get(params.taskId) ?? {};
            if (typeof params.title === 'string') patch.title = params.title;
            if (typeof params.description === 'string') patch.description = params.description;
            boardMutations.patches.set(params.taskId, patch);
            setTimeout(() => sendEvent({ kind: 'board', projectId: STUB_PROJECT.id, taskId: params.taskId, payload: { change: 'task-updated', ids: [params.taskId] } }), 50);
            return ok({ result: { updated: params.taskId } });
          }
          if (payload.tool === 'delete_task') {
            boardMutations.deleted.add(params.taskId);
            setTimeout(() => sendEvent({ kind: 'board', projectId: STUB_PROJECT.id, taskId: params.taskId, payload: { change: 'task-deleted', ids: [params.taskId] } }), 50);
            return ok({ result: { deleted: params.taskId } });
          }
          return ok({ result: { note: `stub answered ${payload.tool}` } });
        }
        default:
          return fail(`Stub has no handler for ${verb}`);
      }
    }

    // The current in-progress KK handshake (reassigned on each re-initiation),
    // read by the persistent frame handler below.
    let handshake = null;

    // The desktop always INITIATES the KK handshake: once on connect and
    // then on its ~2-minute rekey timer. Phone reloads are recovered by the
    // redial loop (runSessionWithRedial) initiating on the fresh socket,
    // exactly like the real desktop's reconnect-on-drop - NOT by a fast
    // rekey interval. A fast blind rekey is actively harmful here: while
    // the phone is away, every initiation accumulates in the relay's
    // parked-slot buffer and the whole pile flushes when the phone rejoins,
    // churning both sides through key generations and eating any
    // application frame (like the app's bootstrap) sent mid-storm.
    function initiateHandshake() {
      handshake = createKKHandshake({ initiator: true, localStatic: desktopStatic, remoteStatic: phoneStaticPublicKey });
      const { message } = handshake.writeMessage(new Uint8Array(0));
      socket.send(wrapSessionFrame(SessionFrameKind.Handshake, message).slice().buffer);
    }

    onFrame(socket, (frame) => {
      const { kind, payload } = unwrapSessionFrame(frame);
      if (kind === SessionFrameKind.Handshake) {
        if (!handshake) return;
        let result;
        try {
          result = handshake.readMessage(payload);
        } catch {
          // A reply to a since-superseded re-handshake attempt (the ~10s
          // rekey races the phone's response); drop it and wait for the
          // reply to the current handshake.
          return;
        }
        if (!result.split) return;
        streams = deriveSecretstreamPair(handshake.getChainingKey(), true);
        // The per-flow boundary: see resetStubFixture. Without it the stub
        // carried board mutations AND a killed session across flows, so a
        // suite run contaminated itself from the first mutating flow onward.
        resetStubFixture();
        console.log('[session] established');
        return;
      }
      if (!streams) return;
      let opened;
      try {
        opened = streams.receive.open(payload);
      } catch (openError) {
        // A frame sealed under a superseded rekey can arrive mid-transition; ignore it.
        console.log(`[session] dropped an application frame that failed to open: ${openError.message}`);
        return;
      }
      if (opened.tag === FrameTag.Final) {
        console.log('[session] remote closed');
        return;
      }
      let message;
      try {
        message = decodeMessage(opened.plaintext);
      } catch (decodeError) {
        console.log(`[session] dropped an undecodable application frame: ${decodeError.message}`);
        return;
      }
      if (message.type === 'capability-request') {
        answerCapabilityRequest(message);
      } else if (message.type !== 'heartbeat') {
        console.log('[session] received:', message);
      }
    });

    initiateHandshake();
    const rehandshakeTimer = setInterval(initiateHandshake, 120_000);
    socket.addEventListener('close', () => {
      clearInterval(rehandshakeTimer);
      if (feedTimer) clearInterval(feedTimer);
    });
    return { send, socket };
  });
}

/**
 * Keep the ongoing session alive across phone restarts. The relay closes
 * BOTH peers when one drops (the peer-closed cascade), so a phone
 * force-stop or reload kills this side's session socket too. The real
 * desktop redials its relay transport on every drop and re-initiates the
 * handshake; the stub must do the same or the first phone relaunch (which
 * every Maestro launchApp performs) permanently strands the session.
 * Returns a stable handle whose send() targets the current dial.
 */
function runSessionWithRedial(relayUrl, desktopStatic, phoneStaticPublicKey) {
  let currentSession = null;
  async function dialForever() {
    for (;;) {
      try {
        currentSession = await runSession(relayUrl, desktopStatic, phoneStaticPublicKey);
      } catch (dialError) {
        console.log(`[session] relay dial failed (${dialError.message}); retrying in 1s...`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
        continue;
      }
      await new Promise((resolveClosed) => currentSession.socket.addEventListener('close', resolveClosed));
      console.log('[session] socket closed (phone dropped, or relay park timeout); redialing the session slot...');
      currentSession = null;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  void dialForever();
  return {
    send(message) {
      if (!currentSession) throw new Error('session socket is between dials');
      currentSession.send(message);
    },
  };
}

// `adb shell input text` (the only way to get the pairing link onto an
// emulator without a camera) cannot type base64url's '_'. To keep manual
// emulator pairing frictionless, regenerate the token - and, if a persisted
// key makes it unavoidable, the key - until the QR blob contains no '_'.
// This costs a negligible fraction of a bit of token entropy and is a
// test-harness accommodation only; real pairing scans a QR.
function isEmulatorTypeable(uri) {
  return uri.indexOf('_') === -1;
}

async function main() {
  const { relayUrl, autoConfirm, phoneKeyHex, identityFile, advertiseRelayUrl } = parseArgs(process.argv.slice(2));

  // Already-paired fast path: open the ongoing session directly, no pairing.
  if (phoneKeyHex) {
    const desktopStatic = loadOrCreateDesktopStatic(identityFile);
    const phoneStaticPublicKey = hexToBytes(phoneKeyHex);
    console.log(`Relay: ${relayUrl}`);
    console.log(`Session-only mode: reconnecting to the phone paired at ${bytesToHex(phoneStaticPublicKey)}`);
    const session = runSessionWithRedial(relayUrl, desktopStatic, phoneStaticPublicKey);
    setInterval(() => {
      try {
        session.send({ type: 'heartbeat' });
      } catch {
        // Not established between re-handshakes; skip this heartbeat.
      }
    }, 5_000);
    return;
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  let desktopStatic = loadOrCreateDesktopStatic(identityFile);
  let pairingToken;
  let qrUri;
  let tokenAttempts = 0;
  for (;;) {
    pairingToken = randomBytes(32);
    qrUri = encodePairingQrPayload({
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: advertiseRelayUrl,
      expiresAt,
      protocolVersion: PROTOCOL_VERSION,
    });
    if (isEmulatorTypeable(qrUri)) break;
    tokenAttempts += 1;
    if (tokenAttempts >= 300) {
      // The loaded key forces a '_' no token can avoid; regenerate + re-persist it.
      desktopStatic = generateAndPersistDesktopStatic(identityFile);
      tokenAttempts = 0;
    }
  }

  console.log(`Relay: ${relayUrl}`);
  console.log(`Pairing URI (paste into the app's "paste pairing link" field):\n${qrUri}\n`);
  console.log('Waiting for the phone to connect...');

  const { phoneStaticPublicKey, sas } = await runPairing(relayUrl, desktopStatic, pairingToken);
  console.log(`\nSAS - confirm this matches the phone's screen:`);
  console.log(`  digits: ${sas.digits}`);
  console.log(`  emoji:  ${sas.emoji.join(' ')}`);

  if (autoConfirm) {
    console.log('\n--yes given: auto-confirming the SAS (eyeball it against the phone anyway).');
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nDoes the SAS match? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Not confirmed - exiting.');
      process.exit(1);
    }
  }

  console.log(`\nPaired. Phone static key: ${bytesToHex(phoneStaticPublicKey)}`);
  console.log('Opening the ongoing session and sending a heartbeat every 5s (Ctrl+C to stop)...\n');

  const session = runSessionWithRedial(relayUrl, desktopStatic, phoneStaticPublicKey);
  setInterval(() => {
    try {
      session.send({ type: 'heartbeat' });
      console.log('[session] sent heartbeat');
    } catch (error) {
      console.log(`[session] heartbeat send skipped: ${error.message}`);
    }
  }, 5_000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
