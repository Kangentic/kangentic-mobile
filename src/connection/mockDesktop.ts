import {
  generateX25519KeyPair,
  parseCapabilityRequestPayload,
  type BoardTaskWire,
  type BridgeEvent,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type DiffFileContentWire,
  type DiffFileListWire,
  type JsonValue,
  type ReadBoardView,
  type ReadStreamResponsePayload,
  type SessionUsageWire,
  type TranscriptWindowResponsePayload,
  type Transport,
  type TranscriptEntryWire,
  type TranscriptTurnUsageWire,
  type X25519KeyPair,
} from '@kangentic/protocol';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { isDoneRole } from '@/state/boardStore';
import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import {
  playRecordedTerminal,
  type RecordedTerminalCapture,
  type RecordedTerminalPlayback,
} from '@/devsupport/recordedTerminal';

/**
 * The in-app fake desktop: the real channel stack (KK handshake,
 * secretstream, capability envelopes, feed router) runs against this peer
 * over an in-process loopback transport, so every screen behaves exactly as
 * it does against a real desktop - streaming transcript, terminal ticks,
 * prompt cards, board writes - with no relay, no pairing ceremony, and no
 * dependence on (or pollution of) a live board. Two routes reach it: the dev
 * rig's mock mode (EXPO_PUBLIC_KANGENTIC_MOCK=1, dev builds only), and - in
 * PRODUCTION, by design - the persisted demo trust anchor (src/demo/, the
 * App Review pairing), which means every fixture below is content an App
 * Store reviewer can reach.
 *
 * The scenario mirrors scripts/stubDesktopPeer.mjs's agent-life simulator
 * and adds an AskUserQuestion round after the permission prompt is
 * answered. Data shapes come from @/devsupport/desktopFixtures so the two
 * stay aligned.
 */

export function isMockDesktopEnabled(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_MOCK === '1';
}

export interface MockDesktop {
  identity: X25519KeyPair;
  desktopStaticPublicKey: Uint8Array;
  phoneTransport: Transport;
  /** Call after the phone controller's connect(): brings the desktop end up and initiates the KK handshake (the desktop always initiates). */
  start(): Promise<void>;
  dispose(): void;
}

// `color` exercises the project accent theme (the whole app's active accent
// derives from it while browsing that project) - two distinct hues so
// switching projects visibly re-themes rather than coincidentally matching.
/** Fallback page size when an archived read names no limit; matches actions.ts's ARCHIVED_PAGE_SIZE. */
const ARCHIVED_MOCK_PAGE_SIZE = 25;
// Names are product-plausible rather than "Project 1"/"Project 2" because the
// project pill renders on every TaskCard, and these fixtures are the source
// for the store-listing screenshots (scripts/storeScreenshots.mjs).
//
// EVERY FIXTURE IN THIS FILE IS THE FICTIONAL CUSTOMER'S WORK, NOT OURS.
//
// The screenshots these produce are published to the App Store, to Play, and to
// a public repo, captioned as a customer using the product. Writing a card
// about Kangentic's own backlog therefore publishes our engineering status as
// if it were theirs - and the first pass did exactly that, shipping cards about
// the register-push capability migration, the relay self-host guide, the
// terminal font-fit heuristic, and a flaky pairing flow whose body text read
// "the QR-scan step races the relay handshake". Reviewers read screenshots.
//
// So: no card, transcript, branch, label or terminal line may name Kangentic's
// own domain - no relay, pairing, capability grant, PTY, Noise, push token, or
// Maestro flow. Keep it all inside the storefront/checkout fiction below.
const MOCK_PROJECT = { id: 'mock-project', name: 'storefront-web', color: '#58a6ff' };
/** A second project: exercises the board project switcher and cross-project Home rows. */
const MOCK_PROJECT_2 = { id: 'mock-project-relay', name: 'checkout-api', color: '#3fb950' };
const MOCK_SESSION_ID = 'mock-session-1';
const MOCK_TASK_ID = 'mock-task-1';
/**
 * A second streaming-terminal session (agent: codex). Structured transcript
 * AND a live fullscreen TUI mirror: every desktop adapter parses a transcript
 * these days (Claude, Codex, Gemini, OpenCode, Droid, Grok, Kimi, Qwen,
 * Antigravity all implement parseTranscript), so a steady-state Codex session
 * has a real chat lens, not the reading-view fallback it modelled before.
 */
const MOCK_CODEX_SESSION_ID = 'mock-session-codex';
const MOCK_CODEX_TASK_ID = 'mock-task-codex';
/**
 * A Gemini CLI session (agent: gemini): structured transcript plus a live
 * fullscreen TUI, the third agent flavor. EVERY mock session carries a
 * structured transcript by policy: the demo only shows agents whose
 * transcripts the desktop parses, because the chat reading-view fallback is
 * a degraded transient state and App Review should only ever meet the
 * high-quality lens. (The fallback code path itself stays covered by the
 * Maestro stub rig, not this mock.)
 */
const MOCK_GEMINI_SESSION_ID = 'mock-session-gemini';
const MOCK_GEMINI_TASK_ID = 'mock-task-gemini';
/** An IDLE session in the second project: exercises the Home feed's Idle section. */
const MOCK_IDLE_SESSION_ID = 'mock-session-idle';
const MOCK_IDLE_TASK_ID = 'mock-task-idle';
/**
 * A "paused" session sitting in Executing: the protocol has no paused
 * ActivityStateWire (only 'thinking' | 'idle' | 'permission' - see
 * .claude/rules/protocol-types-from-package.md, no local stand-in types),
 * so this reports 'idle' - the closest real state - and communicates
 * "paused" only through its snippet text, for display/testing purposes.
 */
const MOCK_PAUSED_SESSION_ID = 'mock-session-paused';
const MOCK_PAUSED_TASK_ID = 'mock-task-paused';
const PERMISSION_TOOL_ID = 'mock-tool-2';
const QUESTION_TOOL_ID = 'mock-tool-3';
const PERMISSION_PROMPT_ID = `${MOCK_SESSION_ID}:${PERMISSION_TOOL_ID}`;
const QUESTION_PROMPT_ID = `${MOCK_SESSION_ID}:${QUESTION_TOOL_ID}`;
const MOCK_CONTEXT_WINDOW_SIZE = 200_000;
// Model variety across the mock's sessions - both the Agents feed and the
// board read the SAME activityStore usage data per session, so varying it
// here is automatically consistent across both screens (one source of
// truth, no separate wiring needed).
const MOCK_MODEL_SONNET = { id: 'claude-sonnet-5', displayName: 'Sonnet 5' };
const MOCK_MODEL_OPUS = { id: 'claude-opus-4-8', displayName: 'Opus 4.8' };
const MOCK_MODEL_FABLE = { id: 'claude-fable-5', displayName: 'Fable 5' };
/** Matches the codex session's `agent: 'codex'` - an OpenAI Codex-family model, not a Claude one. */
const MOCK_MODEL_CODEX = { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' };
/** The just-spawned session's model - a Gemini CLI session, agent: 'gemini'. */
const MOCK_MODEL_GEMINI = { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' };
/** After this many tick-driven Bash cells, the mock stops growing the transcript further - see tickEntryCount. */
const MOCK_MAX_TICK_ENTRIES = 20;

/**
 * Where the streaming session's context bar starts, and how fast it climbs.
 *
 * The rate is deliberately gentle and the ceiling deliberately below the point
 * where the bar turns red. At the original 900 tokens per tick the bar hit 100%
 * after about three minutes, and the capture flow takes longer than that - so
 * the board and feed screenshots, taken last, showed a maxed-out context window
 * in alarm red. That is a real product state and worth keeping reachable, but it
 * is not what a store listing should assert about the app.
 *
 * The bar still visibly advances during a session, which is the demo value.
 */
const MOCK_STREAM_TOKENS_AT_START = 42_000;
const MOCK_STREAM_TOKENS_PER_TICK = 300;
/** 60% of the 200k window: comfortably clear of the warning and danger thresholds. */
const MOCK_STREAM_TOKEN_CEILING = 120_000;

export const MOCK_STREAM_CEILING_FOR_TEST = MOCK_STREAM_TOKEN_CEILING;
export const MOCK_CONTEXT_WINDOW_FOR_TEST = MOCK_CONTEXT_WINDOW_SIZE;

export function streamingUsedTokens(tick: number): number {
  return Math.min(
    MOCK_STREAM_TOKENS_AT_START + tick * MOCK_STREAM_TOKENS_PER_TICK,
    MOCK_STREAM_TOKEN_CEILING,
  );
}

/** A plausible, growing usage snapshot - the mock's stand-in for the desktop's real per-turn token accounting. */
function mockUsage(usedTokens: number, model: SessionUsageWire['model']): SessionUsageWire {
  const clampedUsedTokens = Math.min(usedTokens, MOCK_CONTEXT_WINDOW_SIZE);
  return {
    contextWindow: {
      usedPercentage: (clampedUsedTokens / MOCK_CONTEXT_WINDOW_SIZE) * 100,
      usedTokens: clampedUsedTokens,
      cacheTokens: Math.round(clampedUsedTokens * 0.3),
      totalInputTokens: clampedUsedTokens,
      totalOutputTokens: Math.round(clampedUsedTokens * 0.08),
      contextWindowSize: MOCK_CONTEXT_WINDOW_SIZE,
    },
    cost: {
      totalCostUsd: clampedUsedTokens * 0.000003,
      totalDurationMs: clampedUsedTokens * 8,
    },
    model,
  };
}

/** One tool round in a static session's transcript: an assistant tool_use cell plus its result. */
export interface MockStaticSessionToolCell {
  name: string;
  input: JsonValue;
  result: string;
  /** Renders the danger-tinted result card, so failure visuals stay reachable outside the streaming session. */
  isError?: boolean;
}

/** A static session's Changes lens: its file list plus per-file contents, so every session's diff tells ITS story. */
export interface MockStaticSessionDiff {
  files: DiffFileListWire['files'];
  contents: Record<string, DiffFileContentWire>;
}

/**
 * A later conversation turn appended after the spec's opening turn. Real
 * sessions are multi-turn - the user comes back, redirects, asks a follow-up -
 * and a transcript that is always exactly one exchange deep is the tell that
 * flips "quiet agent" to "canned" the moment a reviewer scrolls.
 */
export interface MockStaticSessionTurn {
  userText: string;
  /** Collapsed-by-default thinking cell opening the turn's assistant entry. */
  thinkingText?: string;
  assistantText?: string;
  toolCells?: MockStaticSessionToolCell[];
  closingText?: string;
}

/**
 * A session that never streams on its own but must still ANSWER: snapshot,
 * transcript window, a typed terminal keystroke, a sent chat message. The
 * idle, paused, and extra-thinking sessions all share this shape, and the one
 * registry built from it is what makes every session's terminal and chat live
 * rather than only the streaming one's - which mattered the moment the demo
 * pairing put these screens in front of App Review.
 */
export interface MockStaticSessionSpec {
  sessionId: string;
  taskId: string;
  /**
   * The name the desktop stamps on every assistant entry it serves: the
   * adapter's displayName ('Claude Code', 'Codex CLI', 'Gemini CLI',
   * 'OpenCode', ...), never a bare model name. Omitted, it is inferred from
   * the model (a Codex-family model reports 'Codex CLI', else 'Claude Code').
   */
  agentName?: string;
  userText: string;
  /** Collapsed-by-default thinking cell opening the first assistant entry. */
  thinkingText?: string;
  assistantText: string;
  /**
   * Tool rounds between the opening exchange and the close. This is what
   * gives a static session's CHAT lens real depth - tool cards, results, an
   * error card where isError is set - instead of the two-bubble stub a
   * reviewer would read as an empty product.
   */
  toolCells?: MockStaticSessionToolCell[];
  /** The settled last word; omitted, the transcript ends on the last tool result. */
  closingText?: string;
  /** Later turns after the opening one - the scroll depth of a real session. */
  followUps?: MockStaticSessionTurn[];
  /** Absent means the Changes lens shows an empty file list for this task, not another task's diff. */
  diff?: MockStaticSessionDiff;
  /**
   * The canned assistant reply to a chat message sent INTO this session.
   * Session-specific so a reviewer poking two sessions does not see the same
   * sentence twice, which is the tell that flips "quiet agent" to "canned".
   */
  replyText: string;
  /**
   * Seed terminal content. Lines stay under the active capture's 44-column
   * grid (activeGrid()), because the mirror renders at the desktop's reported
   * grid and a longer line wraps mid-word on the one screen that ships.
   */
  scrollback: string;
  model: SessionUsageWire['model'];
  usedTokens: number;
  activityState: 'thinking' | 'idle';
}

export interface MockExtraThinkingSessionSpec extends MockStaticSessionSpec {
  displayId: number;
  swimlaneId: string;
  title: string;
}

/**
 * Documents that appear in BOTH a chat Write card and that session's Changes
 * lens. One constant each, referenced from both places, for the same reason
 * the streaming session's Write cell reads diffFileContent(): a hand-copied
 * second version drifts, and the two lenses sit one swipe apart.
 */
const SELF_HOST_GUIDE_DOC = [
  '# Self-hosting the storefront',
  '',
  'Run the whole stack on your own hardware: the web app, the checkout',
  'service, and Postgres. Docker Compose is the fast path; bare metal is',
  'documented for teams with their own orchestration.',
  '',
  '## Docker Compose',
  '',
  '```yaml',
  'services:',
  '  web:',
  '    image: storefront/web:2.4',
  '    ports: ["8080:8080"]',
  '    env_file: .env',
  '```',
  '',
  '## Environment variables',
  '',
  '| Name | Purpose |',
  '| --- | --- |',
  '| DATABASE_URL | Postgres connection string |',
  '| CHECKOUT_URL | Internal checkout service address |',
].join('\n');

const LOAD_TEST_SUMMARY_DOC = [
  '# Checkout load-test summary',
  '',
  '50 concurrent carts, 4 regions, 20 minute soak.',
  '',
  '- p50 checkout latency: 0.79ms',
  '- p95 checkout latency: 3.1ms',
  '- errors: 0',
  '',
  'Slowest two cases (cart merge on sign-in, multi-currency totals)',
  'have their own follow-up issues.',
].join('\n');

/**
 * SGR fragments matching the recorded capture's palette (claudeCapture.ts):
 * gray for chrome text, near-black gray for box borders. Built from one ESC
 * constant so the escape appears exactly once in authored source.
 */
const ESC = '\u001b';
const TUI_GRAY = ESC + '[38;2;153;153;153m';
const TUI_DARK = ESC + '[38;2;80;80;80m';
const TUI_RESET = ESC + '[0m';
/**
 * The rest of the live palette, read out of a REAL running session's PTY ring
 * (kangentic devtools terminal forensics, 2026-08-27): the spinner gerund
 * paints coral 215;119;87 with its parenthetical in gray; the input-area
 * rules are gray 136;136;136 with the worktree tag embedded at the right
 * end; the footer chips are amber 255;193;7 (permission mode) and cyan
 * 0;204;204 (background shells).
 */
const TUI_CORAL = ESC + '[38;2;215;119;87m';
const TUI_RULE = ESC + '[38;2;136;136;136m';
const TUI_AMBER = ESC + '[38;2;255;193;7m';
const TUI_CYAN = ESC + '[38;2;0;204;204m';
const TUI_WHITE = ESC + '[38;2;255;255;255m';
/**
 * The bullet prefixes that open the hand-authored content rows below: gray
 * for tool cells, white for assistant text, matching the recorded palette.
 * Named so a palette correction edits these two lines, not every row.
 */
const TUI_TOOL_BULLET = TUI_GRAY + '●' + TUI_RESET + ' ';
const TUI_TEXT_BULLET = TUI_WHITE + '●' + TUI_RESET + ' ';

interface ClaudeTuiFrameOptions {
  /**
   * The task's worktree tag, embedded at the right end of the input rule
   * exactly where the live desktop paints it.
   */
  branchTag: string;
  /**
   * The in-flight status, glyph omitted: 'Measuring… (2m 14s · ↓ 3.1k
   * tokens)'. Rendered coral up to the parenthetical, gray from there, with
   * the Tip rows a live turn keeps beneath it.
   */
  working?: string;
  /** The settled line an idle session rests on: 'Sautéed for 12m 4s · done 4:18 PM'. All gray, like the real one. */
  done?: string;
  /** Footer chip after the permission mode, e.g. '1 shell'. */
  footerExtra?: string;
}

/**
 * Frames authored conversation rows in the chrome a real Claude Code session
 * paints TODAY, transcribed from a live session's PTY ring (devtools
 * terminal forensics, 2026-08-27, a 210x48 desktop-rest grid):
 *
 *   ✢ Fluttering… (10m 49s · ↓ 41.3k tokens · thought for 3s)
 *     ⎿  Tip: Use /btw to ask a quick side question ...
 *   ──────────────────────── mock-desktop-demo-pairing ─
 *   ❯
 *   ─────────────────────────────────────────────────────
 *     ⏵⏵ auto mode on · 1 shell · ← 1 agent
 *
 * - the input area is RULES with the worktree tag at the right end, not the
 *   old bordered box, and the prompt glyph is ❯;
 * - the working line's gerund is coral, its parenthetical gray, and idle
 *   sessions rest on an all-gray 'done' line instead;
 * - the footer chip is amber 'auto mode on' (Kangentic spawns Claude Code
 *   with --permission-mode auto, so this is what a real customer desktop
 *   mirrors), with cyan shell chips when background work exists.
 *
 * The frame is padded so the input area sits at the BOTTOM of the grid.
 * Why all this: the streaming session's terminal is a RECORDED real frame,
 * and next to it a bare scrollback read as obviously fake. (This builder
 * still does not reproduce syntax-highlighted diffs or dialogs; sessions
 * needing that fidelity should be recorded, not authored.)
 */
function claudeTuiFrame(contentRows: string[], options: ClaudeTuiFrameOptions): string {
  const { cols, rows } = activeGrid();
  const bottom: string[] = [];
  if (options.working) {
    const parenIndex = options.working.indexOf('(');
    const gerundPart = parenIndex >= 0 ? options.working.slice(0, parenIndex) : options.working;
    const detailPart = parenIndex >= 0 ? options.working.slice(parenIndex) : '';
    bottom.push(TUI_CORAL + '✻ ' + gerundPart + TUI_GRAY + detailPart + TUI_RESET);
    bottom.push(TUI_GRAY + '  ⎿  Tip: Use /btw to ask a quick side' + TUI_RESET);
    bottom.push(TUI_GRAY + '     question without interrupting' + TUI_RESET);
    bottom.push(TUI_GRAY + "     Claude's current work" + TUI_RESET);
    bottom.push('');
  } else if (options.done) {
    bottom.push(TUI_GRAY + '✻ ' + options.done + TUI_RESET);
    bottom.push('');
  }
  const tagRuleLength = Math.max(1, cols - options.branchTag.length - 4);
  bottom.push(TUI_RULE + '─'.repeat(tagRuleLength) + ' ' + options.branchTag + ' ─' + TUI_RESET);
  bottom.push(TUI_GRAY + '❯ ' + TUI_RESET);
  bottom.push(TUI_RULE + '─'.repeat(cols) + TUI_RESET);
  bottom.push(
    // The real footer glyph is U+23F5 '⏵', which the phone WebView's mono
    // font lacks (it rendered as tofu on device); '▶' is the same arrow in
    // a universally covered block.
    '  ' +
      TUI_AMBER +
      '▶▶ auto mode on' +
      (options.footerExtra ? ' ' + TUI_GRAY + '· ' + TUI_CYAN + options.footerExtra : '') +
      TUI_RESET,
  );
  const frameRows = [...contentRows];
  const fillerCount = Math.max(0, rows - frameRows.length - bottom.length);
  for (let fillerIndex = 0; fillerIndex < fillerCount; fillerIndex += 1) frameRows.push('');
  return [...frameRows, ...bottom].join('\r\n');
}

/**
 * Extra static "thinking" sessions (no ticker, nothing ever streams from
 * them) - purely to give the Agents feed's Thinking section enough volume
 * to feel real scrolling and justify a collapsible-section UI, for
 * display/testing purposes.
 */
export const MOCK_EXTRA_THINKING_SESSIONS: MockExtraThinkingSessionSpec[] = [
  {
    sessionId: 'mock-session-thinking-2',
    taskId: 'mock-task-thinking-2',
    displayId: 6,
    swimlaneId: 'lane-executing',
    title: "Refactor the catalog importer's CSV parser for large feeds",
    userText: 'The importer chokes on feeds over 2000 rows - can you speed up the parser?',
    thinkingText:
      'The importer reads the whole CSV into one string and splits it, so memory and latency both scale with feed size. A streaming parser that yields fixed-size chunks fixes both, but the call sites expect an array - I need to see how the importer consumes the rows before changing the signature.',
    // Deliberately long - a design-review stress test for how the Agents
    // feed's snippet line truncates once the last message runs well past
    // its two-line cap (bodyNumberOfLines on TaskCard).
    assistantText:
      'Swapped the row-by-row parser for a streaming one that processes feeds in fixed-size chunks instead of loading everything into memory at once; benchmarking against the 10k-row fixture next to confirm the P95 import time actually drops below our 200ms target.',
    replyText: 'Noted - folding that into the streaming parser before the benchmark rerun.',
    scrollback: claudeTuiFrame([
      '> Speed up the feed importer - it',
      '  chokes past 2000 rows.',
      '',
      TUI_TOOL_BULLET + 'Read(src/catalog/parseFeed.ts)',
      '  ⎿ 214 lines',
      '',
      TUI_TEXT_BULLET + 'The parser buffers the whole feed',
      '  before the first row parses.',
      '  Streaming it in fixed-size chunks.',
      '',
      TUI_TOOL_BULLET + 'Update(src/catalog/parseFeed.ts)',
      '  ⎿ 41 insertions, 18 deletions',
      '',
      TUI_TOOL_BULLET + 'Bash(npm run bench -- feeds/10k.csv)',
      '  ⎿ p95 412ms -> 187ms over 5 runs',
      '',
      TUI_TEXT_BULLET + 'Benchmarking the 10k-row fixture to',
      '  confirm p95 lands under 200ms.',
      '',
      '> How does memory look on the 10k',
      '  feed now?',
      '',
      TUI_TOOL_BULLET + 'Bash(npm run bench:mem -- 10k.csv)',
      '  ⎿ peak RSS 84MB -> 19MB',
      '',
      TUI_TEXT_BULLET + 'Peak memory drops from 84MB to',
      '  19MB - the parser never holds more',
      '  than 250 rows at once.',
      '',
      '> Add a memory ceiling assert to the',
      '  bench so a regression fails loudly.',
      '',
    ], { branchTag: 'perf/streaming-feed-parser', working: 'Measuring… (2m 14s · ↓ 3.1k tokens)' }),
    model: MOCK_MODEL_SONNET,
    usedTokens: 55_000,
    activityState: 'thinking',
    toolCells: [
      { name: 'Read', input: { file_path: 'src/catalog/parseFeed.ts' }, result: '214 lines' },
      {
        name: 'Bash',
        input: { command: 'npm run bench -- feeds/10k.csv' },
        result: 'p95 412ms -> 187ms over 5 runs',
      },
    ],
    closingText: 'Streaming parser is in and p95 on the 10k-row fixture is 187ms. Wiring a memory ceiling assert into the bench next.',
    followUps: [
      {
        userText: 'How does memory look on the 10k feed now?',
        toolCells: [
          {
            name: 'Bash',
            input: { command: 'npm run bench:mem -- feeds/10k.csv' },
            result: 'peak RSS 84MB -> 19MB over 5 runs',
          },
        ],
        closingText:
          'Peak memory drops from 84MB to 19MB: the streaming parser never holds more than 250 rows in memory at once, so feed size no longer sets the ceiling.',
      },
      {
        // The in-flight ask the Thinking spinner is answering right now.
        userText: 'Add a memory ceiling assert to the bench so a regression fails loudly.',
      },
    ],
    diff: {
      files: [
        { path: 'src/catalog/parseFeed.ts', status: 'M', insertions: 41, deletions: 18, binary: false },
        { path: 'src/catalog/parseFeed.bench.ts', status: 'A', insertions: 12, deletions: 0, binary: false },
      ],
      contents: {
        'src/catalog/parseFeed.ts': {
          original: [
            'export function parseFeed(csv: string): FeedRow[] {',
            '  const rows: FeedRow[] = [];',
            '  for (const line of csv.split("\\n")) {',
            '    rows.push(parseRow(line));',
            '  }',
            '  return rows;',
            '}',
            '',
          ].join('\n'),
          modified: [
            'const CHUNK_ROWS = 250;',
            '',
            'export async function* parseFeed(feed: ReadableStream<string>): AsyncGenerator<FeedRow[]> {',
            '  let chunk: FeedRow[] = [];',
            '  for await (const line of lines(feed)) {',
            '    chunk.push(parseRow(line));',
            '    if (chunk.length === CHUNK_ROWS) {',
            '      yield chunk;',
            '      chunk = [];',
            '    }',
            '  }',
            '  if (chunk.length > 0) yield chunk;',
            '}',
            '',
          ].join('\n'),
          language: 'typescript',
        },
        'src/catalog/parseFeed.bench.ts': {
          original: '',
          modified: [
            'import { bench } from "vitest";',
            'import { parseFeed } from "./parseFeed";',
            '',
            'bench("10k-row feed", async () => {',
            '  for await (const chunk of parseFeed(openFixture("feeds/10k.csv"))) {',
            '    consume(chunk);',
            '  }',
            '});',
            '',
          ].join('\n'),
          language: 'typescript',
        },
      },
    },
  },
  {
    sessionId: 'mock-session-thinking-3',
    taskId: 'mock-task-thinking-3',
    displayId: 7,
    swimlaneId: 'lane-code-review',
    title: 'Investigate the flaky guest-checkout test on CI',
    userText: 'checkout/guest-checkout.spec.ts fails about 1 in 5 runs on CI - can you dig in?',
    assistantText: 'Reproduced it locally - the payment iframe loads after the assert. Adding a settle wait before the submit.',
    replyText: 'Good call - rerunning the spec twenty more times with that in mind.',
    scrollback: claudeTuiFrame([
      '> Dig into the flaky guest-checkout',
      '  spec - 1 in 5 CI runs fail.',
      '',
      TUI_TOOL_BULLET + 'Bash(npx vitest run checkout x20)',
      '  ⎿ 17 passed, 3 failed',
      '',
      TUI_TEXT_BULLET + 'The payment iframe finishes loading',
      '  after the assert runs. A settle',
      '  wait before the submit fixes it.',
      '',
      TUI_TOOL_BULLET + 'Update(guest-checkout.spec.ts)',
      '  ⎿ 6 insertions, 1 deletion',
      '',
      TUI_TOOL_BULLET + 'Bash(npx vitest run checkout x20)',
      '  ⎿ 20 passed, 0 failed',
      '',
      '> Are other specs racing the same',
      '  iframe?',
      '',
      TUI_TOOL_BULLET + 'Grep(paymentFrame, checkout/)',
      '  ⎿ 3 specs reference the iframe',
      '',
      TUI_TEXT_BULLET + 'Two more specs wait on the same',
      '  iframe and both already use the',
      '  settle helper. Only guest checkout',
      '  raced it.',
      '',
      '> Fold the settle wait into the',
      '  shared checkout helper.',
      '',
    ], { branchTag: 'fix/guest-checkout-flake', working: 'Sifting… (4m 2s · ↓ 6.8k tokens · thought for 21s)' }),
    model: MOCK_MODEL_OPUS,
    usedTokens: 88_000,
    activityState: 'thinking',
    toolCells: [
      {
        name: 'Bash',
        input: { command: 'npx vitest run checkout --repeat 20' },
        result: 'Test Files  3 passed (3)\nTests  17 passed, 3 failed (20)\nDuration  84.2s',
        isError: true,
      },
      {
        name: 'Edit',
        input: { file_path: 'checkout/guest-checkout.spec.ts' },
        result: 'The file checkout/guest-checkout.spec.ts has been updated successfully.',
      },
      {
        name: 'Bash',
        input: { command: 'npx vitest run checkout --repeat 20' },
        result: 'Test Files  3 passed (3)\nTests  20 passed (20)\nDuration  86.9s',
      },
    ],
    closingText: 'Twenty clean runs in a row. The settle wait holds the submit until the payment iframe reports ready, which is the race the 1-in-5 failures were losing.',
    followUps: [
      {
        userText: 'Are other specs racing the same iframe?',
        thinkingText:
          'Any spec that fills the card form and submits crosses the same iframe load. A quick sweep for the frame locator will show which ones, and whether they already wait on the ready marker.',
        toolCells: [
          {
            name: 'Grep',
            input: { pattern: 'paymentFrame', path: 'checkout/', output_mode: 'files_with_matches' },
            result: 'checkout/guest-checkout.spec.ts\ncheckout/saved-card.spec.ts\ncheckout/gift-card.spec.ts',
          },
        ],
        closingText:
          'Two more specs reference the same iframe - saved-card and gift-card - and both already wait on the settle helper before submitting. Guest checkout was the only one racing it.',
      },
      {
        // The in-flight ask the Thinking spinner is answering right now.
        userText: 'Fold the settle wait into the shared checkout helper so new specs get it for free.',
      },
    ],
    diff: {
      files: [{ path: 'checkout/guest-checkout.spec.ts', status: 'M', insertions: 6, deletions: 1, binary: false }],
      contents: {
        'checkout/guest-checkout.spec.ts': {
          original: [
            'await page.fill("#card-number", TEST_CARD);',
            'await page.click("#submit-order");',
            'await expect(page.locator("#confirmation")).toBeVisible();',
            '',
          ].join('\n'),
          modified: [
            'await page.fill("#card-number", TEST_CARD);',
            '// The payment iframe loads async; submitting before it settles',
            '// loses the click 1 run in 5 on CI.',
            'await expect(paymentFrame.locator("[data-ready]")).toBeVisible({',
            '  timeout: 10_000,',
            '});',
            'await page.click("#submit-order");',
            'await expect(page.locator("#confirmation")).toBeVisible();',
            '',
          ].join('\n'),
          language: 'typescript',
        },
      },
    },
  },
  {
    sessionId: 'mock-session-thinking-4',
    taskId: 'mock-task-thinking-4',
    displayId: 8,
    swimlaneId: 'lane-testing',
    title: 'Write the storefront self-host deployment guide',
    userText: 'Draft a guide for someone standing up their own storefront - Docker, env vars, the works.',
    assistantText: 'First draft covers Docker Compose and bare-metal; adding the reverse-proxy/TLS section now.',
    replyText: 'Adding that to the deployment guide now.',
    scrollback: claudeTuiFrame([
      '> Draft the self-host guide - Docker,',
      '  env vars, the works.',
      '',
      TUI_TOOL_BULLET + 'Write(docs/self-host-storefront.md)',
      '  ⎿ 182 lines',
      '',
      TUI_TEXT_BULLET + 'First draft covers Docker Compose',
      '  and bare metal. Adding the reverse',
      '  proxy and TLS section now.',
      '',
      TUI_TOOL_BULLET + 'Bash(npx markdownlint docs)',
      '  ⎿ 0 errors',
      '',
    ], { branchTag: 'docs/self-host-guide', working: 'Drafting… (1m 48s · ↓ 5.2k tokens)' }),
    model: MOCK_MODEL_FABLE,
    usedTokens: 33_000,
    activityState: 'thinking',
    toolCells: [
      {
        name: 'Write',
        input: { file_path: 'docs/self-host-storefront.md', content: SELF_HOST_GUIDE_DOC },
        result: 'The file docs/self-host-storefront.md has been created successfully.',
      },
      { name: 'Bash', input: { command: 'npx markdownlint docs' }, result: '0 errors' },
    ],
    closingText: 'First draft is committed: Docker Compose and bare metal are covered. Writing the reverse proxy and TLS section now.',
    diff: {
      files: [{ path: 'docs/self-host-storefront.md', status: 'A', insertions: 182, deletions: 0, binary: false }],
      contents: {
        'docs/self-host-storefront.md': { original: '', modified: SELF_HOST_GUIDE_DOC, language: 'markdown' },
      },
    },
  },
  {
    sessionId: 'mock-session-thinking-5',
    taskId: 'mock-task-thinking-5',
    displayId: 9,
    swimlaneId: 'lane-executing',
    title: 'Tune the product-grid density heuristic for tablet screens',
    userText: 'On a tablet the product grid ends up cramped - can you adjust the density heuristic?',
    assistantText: 'Adding a width-aware floor so a card never drops below 180px regardless of the column count.',
    replyText: 'Applying that to the density heuristic.',
    scrollback: [
      '› Tune the product-grid density',
      '  heuristic for tablet widths.',
      '',
      '* Editing src/grid/density.ts',
      '* Running the affected tests',
      '  12 passed',
      '* A width-aware floor keeps cards at',
      '  180px or wider at any column count.',
      '',
      '› Run the tablet snapshot suite',
      '  before closing this out.',
      '',
      TUI_GRAY + '* Running the tablet snapshots' + TUI_RESET,
      '',
      TUI_DARK + '╭' + '─'.repeat(activeGrid().cols - 2) + '╮' + TUI_RESET,
      TUI_DARK + '│' + TUI_RESET + ' Running the tablet snapshots'.padEnd(activeGrid().cols - 2, ' ') + TUI_DARK + '│' + TUI_RESET,
      TUI_DARK + '╰' + '─'.repeat(activeGrid().cols - 2) + '╯' + TUI_RESET,
      TUI_GRAY + 'Codex CLI · GPT-5 Codex · ↑6.3k ↓318' + TUI_RESET,
    ].join('\r\n'),
    model: MOCK_MODEL_CODEX,
    usedTokens: 12_000,
    activityState: 'thinking',
    // Codex-native tool shapes, not Claude ones: a Codex rollout's
    // function_calls are `shell` (an argv array) and `apply_patch` (the
    // patch envelope), and the desktop parser passes both through verbatim.
    toolCells: [
      {
        name: 'shell',
        input: { command: ['bash', '-lc', 'sed -n "1,20p" src/grid/density.ts'], workdir: '/work/storefront-web' },
        result: 'export function columnsFor(widthPx: number): number {\n  return Math.max(2, Math.floor(widthPx / 150));\n}',
      },
      {
        name: 'apply_patch',
        input: {
          input:
            '*** Begin Patch\n*** Update File: src/grid/density.ts\n@@\n-export function columnsFor(widthPx: number): number {\n-  return Math.max(2, Math.floor(widthPx / 150));\n-}\n+const MIN_CARD_PX = 180;\n+\n+export function columnsFor(widthPx: number): number {\n+  // Fewer, readable columns beat cramped ones on wide screens:\n+  // the card width floors at MIN_CARD_PX and the count follows.\n+  const byDensity = Math.floor(widthPx / 150);\n+  const byFloor = Math.floor(widthPx / MIN_CARD_PX);\n+  return Math.max(2, Math.min(byDensity, byFloor));\n+}\n*** End Patch',
        },
        result: 'Success. Updated the following files:\nM src/grid/density.ts',
      },
      {
        name: 'shell',
        input: { command: ['bash', '-lc', 'npx vitest run grid'], workdir: '/work/storefront-web' },
        result: ' Test Files  1 passed (1)\n      Tests  12 passed (12)\n   Duration  0.84s',
      },
    ],
    closingText: 'Width-aware floor is in: a card clamps at 180px before the column count drops, so tablets get fewer, readable columns.',
    followUps: [
      {
        // The in-flight ask the Thinking spinner is answering right now.
        userText: 'Run the tablet snapshot suite before closing this out.',
      },
    ],
    diff: {
      files: [{ path: 'src/grid/density.ts', status: 'M', insertions: 9, deletions: 3, binary: false }],
      contents: {
        'src/grid/density.ts': {
          original: [
            'export function columnsFor(widthPx: number): number {',
            '  return Math.max(2, Math.floor(widthPx / 150));',
            '}',
            '',
          ].join('\n'),
          modified: [
            'const MIN_CARD_PX = 180;',
            '',
            'export function columnsFor(widthPx: number): number {',
            '  // Fewer, readable columns beat cramped ones on wide screens:',
            '  // the card width floors at MIN_CARD_PX and the count follows.',
            '  const byDensity = Math.floor(widthPx / 150);',
            '  const byFloor = Math.floor(widthPx / MIN_CARD_PX);',
            '  return Math.max(2, Math.min(byDensity, byFloor));',
            '}',
            '',
          ].join('\n'),
          language: 'typescript',
        },
      },
    },
  },
];

/**
 * The idle and paused sessions' static content, previously inlined in the
 * read-stream handler where the fixture-vocabulary guard could not reach it.
 * Hoisted for the same two reasons as archivedTasksFor: the guard must be able
 * to collect every string these render, and the session registry needs one
 * list of everything that answers.
 */
export const MOCK_IDLE_STATIC_SESSION: MockStaticSessionSpec = {
  sessionId: MOCK_IDLE_SESSION_ID,
  taskId: MOCK_IDLE_TASK_ID,
  userText: 'Summarize the checkout load-test results.',
  assistantText: 'Done. p50 checkout latency held at 0.79ms across 50 concurrent carts; summary written to the task notes.',
  replyText: 'Noted - I will pick that up with the follow-ups.',
  scrollback: claudeTuiFrame([
    '> Summarize the checkout load-test',
    '  results.',
    '',
    TUI_TOOL_BULLET + 'Read(perf/load-test-results.json)',
    '  ⎿ 50 carts, 4 regions',
    '',
    TUI_TEXT_BULLET + 'p50 checkout latency held at 0.79ms',
    '  across 50 concurrent carts. Wrote',
    '  the summary to the task notes.',
    '',
    TUI_TOOL_BULLET + 'Bash(git push origin perf/load-test)',
    '  ⎿ pushed',
    '',
    TUI_TEXT_BULLET + 'Done. Session is idle.',
    '',
  ], { branchTag: 'perf/load-test', done: 'Simmered for 9m 12s · done 4:18 PM', footerExtra: '1 shell' }),
  model: MOCK_MODEL_OPUS,
  usedTokens: 28_000,
  activityState: 'idle',
  toolCells: [
    { name: 'Read', input: { file_path: 'perf/load-test-results.json' }, result: '50 carts, 4 regions, 20 minute soak' },
    {
      name: 'Write',
      input: { file_path: 'perf/load-test-summary.md', content: LOAD_TEST_SUMMARY_DOC },
      result: 'The file perf/load-test-summary.md has been created successfully.',
    },
  ],
  closingText: 'Summary written to the task notes, and the two slowest cases have their own follow-up issues. Nothing else outstanding.',
  diff: {
    files: [{ path: 'perf/load-test-summary.md', status: 'A', insertions: 38, deletions: 0, binary: false }],
    contents: {
      'perf/load-test-summary.md': { original: '', modified: LOAD_TEST_SUMMARY_DOC, language: 'markdown' },
    },
  },
};

/**
 * The vault-token module, referenced by BOTH the paused session's Write tool
 * card and its Changes lens - one constant for the same anti-drift reason as
 * SELF_HOST_GUIDE_DOC above.
 */
const VAULT_TOKEN_MODULE = [
  'export interface VaultToken {',
  '  scopedId: string;',
  '  apiVersion: "current" | "legacy";',
  '  legacyCardToken: string;',
  '}',
  '',
  'export async function forCustomer(customerId: string): Promise<VaultToken> {',
  '  return vaultClient.tokenFor(customerId);',
  '}',
  '',
].join('\n');

export const MOCK_PAUSED_STATIC_SESSION: MockStaticSessionSpec = {
  sessionId: MOCK_PAUSED_SESSION_ID,
  taskId: MOCK_PAUSED_TASK_ID,
  userText: 'Migrate card-on-file billing to the vault-scoped payment tokens, keeping the legacy API subscriptions billing through the rollout.',
  thinkingText:
    'The charge path reads the stored card straight from the legacy vault, so the token swap touches every charge call. Safest order: introduce the vault token type, convert chargeStored behind a version check, and only then change the schema - the schema change is the irreversible step.',
  assistantText:
    'Starting with the charge path: converting chargeStored to resolve a vault-scoped token, with a legacy branch so subscriptions on the previous API version keep billing during the rollout.',
  replyText: 'Still paused here. I will fold that in when the migration resumes.',
  scrollback: claudeTuiFrame([
    '> Migrate card-on-file billing to',
    '  vault-scoped payment tokens.',
    '',
    TUI_TOOL_BULLET + 'Read(src/billing/chargeStored.ts)',
    '  ⎿ 41 lines',
    '',
    TUI_TEXT_BULLET + 'Converting the charge path behind',
    '  a version check so legacy',
    '  subscriptions keep billing.',
    '',
    TUI_TOOL_BULLET + 'Write(src/billing/vaultToken.ts)',
    '  ⎿ 28 lines',
    '',
    TUI_TOOL_BULLET + 'Update(src/billing/chargeStored.ts)',
    '  ⎿ 64 insertions, 22 deletions',
    '',
    TUI_TOOL_BULLET + 'Bash(npm run test:unit -- billing)',
    '  ⎿ 38 passed',
    '',
    '> Pause here - I want to review the',
    '  token schema first.',
    '',
    TUI_TEXT_BULLET + 'Paused before the token-schema',
    '  change - resume from the terminal',
    '  when ready.',
    '',
  ], { branchTag: 'feature/vault-token-migration', done: 'Churned for 22m 51s · done 5:03 PM' }),
  model: MOCK_MODEL_FABLE,
  usedTokens: 61_000,
  // The protocol has no paused ActivityStateWire, so this reports 'idle' (the
  // closest real state) and communicates "paused" only through the text.
  activityState: 'idle',
  toolCells: [
    { name: 'Read', input: { file_path: 'src/billing/chargeStored.ts' }, result: '41 lines' },
    {
      name: 'Write',
      input: { file_path: 'src/billing/vaultToken.ts', content: VAULT_TOKEN_MODULE },
      result: 'The file src/billing/vaultToken.ts has been created successfully.',
    },
    {
      name: 'Edit',
      input: { file_path: 'src/billing/chargeStored.ts' },
      result: 'The file src/billing/chargeStored.ts has been updated successfully.',
    },
    { name: 'Bash', input: { command: 'npm run test:unit -- billing' }, result: 'Tests  38 passed (38)' },
  ],
  closingText: 'The charge path and its unit tests are green on the new token shape. The next edit is the token schema itself.',
  followUps: [
    {
      userText: 'Pause here - I want to review the token schema before you continue.',
      assistantText:
        'Paused midway through the migration, right before the token-schema change. The converted charge path is committed and tested; resume from the terminal when you have reviewed the schema.',
    },
  ],
  diff: {
    files: [
      { path: 'src/billing/chargeStored.ts', status: 'M', insertions: 64, deletions: 22, binary: false },
      { path: 'src/billing/vaultToken.ts', status: 'A', insertions: 28, deletions: 0, binary: false },
    ],
    contents: {
      'src/billing/chargeStored.ts': {
        original: [
          'export async function chargeStored(customerId: string, amount: Money): Promise<ChargeResult> {',
          '  const card = await legacyVault.cardFor(customerId);',
          '  return gateway.charge(card.token, amount);',
          '}',
          '',
        ].join('\n'),
        modified: [
          'export async function chargeStored(customerId: string, amount: Money): Promise<ChargeResult> {',
          '  // Vault-scoped tokens replace raw card tokens: one token per',
          '  // (customer, vault) pair, revocable without reissuing the card.',
          '  const token = await vaultToken.forCustomer(customerId);',
          '  if (token.apiVersion === "legacy") {',
          '    // Subscriptions still billing on the previous API version keep',
          '    // working until the rollout completes across both regions.',
          '    return gateway.charge(token.legacyCardToken, amount);',
          '  }',
          '  return gateway.chargeScoped(token.scopedId, amount);',
          '}',
          '',
        ].join('\n'),
        language: 'typescript',
      },
      'src/billing/vaultToken.ts': {
        original: '',
        // The same constant the chat lens's Write card renders, so the two
        // lenses cannot drift.
        modified: VAULT_TOKEN_MODULE,
        language: 'typescript',
      },
    },
  },
};

/**
 * The storefront project's archived session (checkout-api has its own,
 * MOCK_CHECKOUT_ARCHIVED_SESSION below - distinct stories per Done column on
 * purpose). The Done column's completed-task screen anchors its transcript
 * on the ARCHIVED summary's sessionId, and until these existed that read
 * failed "No such session" - a broken screen one tap into the Done column,
 * which a reviewer told to poke every task will take. Settled and idle by
 * definition; the completed screen renders no composer, so replyText is a
 * formality the registry requires.
 */
function archivedStaticSession(projectId: string): MockStaticSessionSpec {
  return {
    sessionId: `${projectId}-archived-session-1`,
    taskId: `${projectId}-archived-1`,
    userText: 'Cache the product-grid query on the home page - it is our hottest read.',
    assistantText: 'Profiling first: the grid query runs on every home hit and never changes between catalog writes, so a write-purged cache should carry almost all of it.',
    replyText: 'This task is finished - open a new one if the cache needs tuning.',
    scrollback: claudeTuiFrame([
      '> Cache the product-grid query on the',
      '  home page.',
      '',
      TUI_TOOL_BULLET + 'Read(src/home/productGrid.ts)',
      '  ⎿ 96 lines',
      '',
      TUI_TOOL_BULLET + 'Update(src/home/productGrid.ts)',
      '  ⎿ 23 insertions, 4 deletions',
      '',
      TUI_TOOL_BULLET + 'Bash(npm run bench -- home-grid)',
      '  ⎿ cold 240ms -> cached 11ms',
      '',
      TUI_TEXT_BULLET + 'Cache is in with a 60s TTL and a',
      '  purge on catalog writes. Shipped.',
      '',
      '> What invalidates it when the',
      '  catalog changes?',
      '',
      TUI_TOOL_BULLET + 'Grep(purgeHomeGrid)',
      '  ⎿ 2 call sites',
      '',
      TUI_TEXT_BULLET + 'Product edits and price changes',
      '  both purge after commit. The TTL',
      '  is only the backstop.',
      '',
    ], { branchTag: 'perf/home-grid-cache', done: 'Percolated for 1h 2m · done 6:02 PM' }),
    model: MOCK_MODEL_SONNET,
    usedTokens: 42_000,
    activityState: 'idle',
    toolCells: [
      { name: 'Read', input: { file_path: 'src/home/productGrid.ts' }, result: '96 lines' },
      {
        name: 'Edit',
        input: { file_path: 'src/home/productGrid.ts' },
        result: 'The file src/home/productGrid.ts has been updated successfully.',
      },
      { name: 'Bash', input: { command: 'npm run bench -- home-grid' }, result: 'cold 240ms -> cached 11ms' },
    ],
    closingText: 'Cache is in with a 60s TTL and a purge on catalog writes. Cold render 240ms, cached 11ms. Shipped.',
    followUps: [
      {
        userText: 'What invalidates the cache when the catalog changes?',
        toolCells: [
          {
            name: 'Grep',
            input: { pattern: 'purgeHomeGrid', output_mode: 'content' },
            result: 'src/catalog/writeProduct.ts:88:  await purgeHomeGrid();\nsrc/catalog/writePrice.ts:41:  await purgeHomeGrid();',
          },
        ],
        closingText:
          'Every catalog write path calls purgeHomeGrid after commit - product edits and price changes both. The 60s TTL is only the backstop for writes that bypass the app, like a manual database fix.',
      },
    ],
  };
}

/**
 * The checkout-api project's OWN archived session. It used to reuse the
 * storefront cache story verbatim, which put an identical task on both Done
 * columns - and a storefront story on the API board - exactly the kind of
 * copy-paste tell a reviewer poking both projects would notice.
 */
const MOCK_CHECKOUT_ARCHIVED_SESSION: MockStaticSessionSpec = {
  sessionId: `${MOCK_PROJECT_2.id}-archived-session-1`,
  taskId: `${MOCK_PROJECT_2.id}-archived-1`,
  userText: 'Checkout totals call the tax service once per line item - batch it.',
  assistantText:
    'Confirming the fan-out first: a 12-item cart makes 12 sequential tax calls, so the win is one batched request per checkout with the per-item breakdown coming back in the response.',
  replyText: 'This task is finished - open a new one if the tax batching needs tuning.',
  scrollback: claudeTuiFrame([
    '> Batch the tax lookup in checkout',
    '  totals.',
    '',
    TUI_TOOL_BULLET + 'Read(src/totals/tax.ts)',
    '  ⎿ 72 lines',
    '',
    TUI_TOOL_BULLET + 'Update(src/totals/tax.ts)',
    '  ⎿ 58 insertions, 19 deletions',
    '',
    TUI_TOOL_BULLET + 'Bash(npm run bench -- totals)',
    '  ⎿ p95 84ms -> 31ms',
    '',
    TUI_TEXT_BULLET + 'One batched tax call per checkout',
    '  now, with the per-item breakdown',
    '  from the response. Shipped.',
    '',
    '> What happens if the batch call',
    '  fails?',
    '',
    TUI_TEXT_BULLET + 'One retry, then it falls back to',
    '  the per-item path so a checkout',
    '  never blocks on the batch.',
    '',
  ], { branchTag: 'perf/tax-lookup-batching', done: 'Brewed for 34m 10s · done 3:34 PM' }),
  model: MOCK_MODEL_FABLE,
  usedTokens: 36_000,
  activityState: 'idle',
  toolCells: [
    { name: 'Read', input: { file_path: 'src/totals/tax.ts' }, result: '72 lines' },
    {
      name: 'Edit',
      input: { file_path: 'src/totals/tax.ts' },
      result: 'The file src/totals/tax.ts has been updated successfully.',
    },
    { name: 'Bash', input: { command: 'npm run bench -- totals' }, result: 'p95 84ms -> 31ms over 5 runs' },
  ],
  closingText:
    'Totals make one batched tax call per checkout now, with the per-item breakdown taken from the batch response. Bench p95 dropped from 84ms to 31ms. Shipped.',
  followUps: [
    {
      userText: 'What happens if the batch call fails?',
      closingText:
        'One retry, then it falls back to the per-item path, so a checkout never blocks on the batch endpoint. The fallback is covered by its own test.',
    },
  ],
};

export const MOCK_ARCHIVED_STATIC_SESSIONS: MockStaticSessionSpec[] = [
  archivedStaticSession(MOCK_PROJECT.id),
  MOCK_CHECKOUT_ARCHIVED_SESSION,
];

/**
 * The codex session's Changes lens, and the anchor its transcript's
 * apply_patch envelopes are BUILT from (codexAddFilePatch below), so the
 * chat's patch cards and the diff lens cannot drift apart.
 */
export const MOCK_CODEX_SESSION_DIFF: MockStaticSessionDiff = {
  files: [
    { path: 'src/http/retryPolicy.ts', status: 'A', insertions: 52, deletions: 0, binary: false },
    { path: 'src/http/client.ts', status: 'M', insertions: 8, deletions: 31, binary: false },
  ],
  contents: {
    'src/http/retryPolicy.ts': {
      original: '',
      modified: [
        'export interface RetryPolicy {',
        '  attempts: number;',
        '  baseDelayMs: number;',
        '  retryOn: (status: number) => boolean;',
        '}',
        '',
        'export const DEFAULT_POLICY: RetryPolicy = {',
        '  attempts: 3,',
        '  baseDelayMs: 200,',
        '  retryOn: (status) => status >= 500 || status === 429,',
        '};',
        '',
        'export async function withRetry<T>(policy: RetryPolicy, run: () => Promise<T>): Promise<T> {',
        '  let lastError: unknown;',
        '  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {',
        '    try {',
        '      return await run();',
        '    } catch (error) {',
        '      lastError = error;',
        '      await delay(policy.baseDelayMs * 2 ** attempt);',
        '    }',
        '  }',
        '  throw lastError;',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
    },
    'src/http/client.ts': {
      original: [
        'async function request(url: string, init: RequestInit): Promise<Response> {',
        '  for (let attempt = 0; attempt < 3; attempt += 1) {',
        '    const response = await fetch(url, init);',
        '    if (response.ok) return response;',
        '  }',
        '  throw new Error("request failed");',
        '}',
        '',
      ].join('\n'),
      modified: [
        'import { DEFAULT_POLICY, withRetry } from "./retryPolicy";',
        '',
        'async function request(url: string, init: RequestInit): Promise<Response> {',
        '  return withRetry(DEFAULT_POLICY, () => fetchOrThrow(url, init));',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
    },
  },
};

/** Codex's apply_patch envelope for a NEW file, built from the same contents the Changes lens serves. */
function codexAddFilePatch(path: string, content: string): string {
  const body = content
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
  return `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch`;
}

/** Codex's apply_patch envelope rewriting an existing file, from the same before/after the Changes lens serves. */
function codexUpdateFilePatch(path: string, original: string, modified: string): string {
  const removed = original
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `-${line}`)
    .join('\n');
  const added = modified
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
  return `*** Begin Patch\n*** Update File: ${path}\n@@\n${removed}\n${added}\n*** End Patch`;
}

/**
 * The codex session's structured transcript. Steady-state Codex parses a
 * transcript like every other adapter, so this session demonstrates the other
 * chat flavor: Codex-native function calls (`shell` argv arrays,
 * `update_plan`, `apply_patch` envelopes) exactly as the desktop's rollout
 * parser passes them through, stamped 'Codex CLI' the way transcript-service
 * stamps every assistant entry with the adapter displayName. No thinking
 * blocks on purpose - real rollouts carry encrypted reasoning with empty
 * summaries, so a parsed Codex transcript almost never shows one.
 *
 * The final turn is a user message ALONE: that is the turn the terminal's
 * working spinner (codexTuiFrame) is streaming right now, so the chat lens
 * ends the way a genuinely in-flight session does - last prompt, then the
 * live tail.
 */
export const MOCK_CODEX_STATIC_SESSION: MockStaticSessionSpec = {
  sessionId: MOCK_CODEX_SESSION_ID,
  taskId: MOCK_CODEX_TASK_ID,
  userText: 'Extract the retry policy out of the HTTP client - three call sites have drifted apart on backoff.',
  assistantText: 'Mapping the drift first: I want all three retry loops side by side before choosing the policy shape.',
  replyText: 'Adding that to the http sweep in this pass.',
  toolCells: [
    {
      name: 'update_plan',
      input: {
        plan: [
          { step: 'Map the three retry loops in src/http', status: 'in_progress' },
          { step: 'Add retryPolicy.ts with one shared backoff', status: 'pending' },
          { step: 'Point request() at withRetry', status: 'pending' },
          { step: 'Run the http suite', status: 'pending' },
        ],
      },
      result: 'Plan updated',
    },
    {
      name: 'shell',
      input: { command: ['bash', '-lc', 'rg -n "attempt" src/http'], workdir: '/work/storefront-web' },
      result:
        'src/http/client.ts:14:  for (let attempt = 0; attempt < 3; attempt += 1) {\nsrc/http/uploads.ts:52:  let attempt = 0; // linear 500ms backoff\nsrc/http/webhooks.ts:31:  let tries = 0; // caps at 5, no backoff',
    },
    {
      name: 'shell',
      input: { command: ['bash', '-lc', 'sed -n "1,20p" src/http/client.ts'], workdir: '/work/storefront-web' },
      result: MOCK_CODEX_SESSION_DIFF.contents['src/http/client.ts'].original,
    },
    {
      name: 'apply_patch',
      input: {
        input: codexAddFilePatch('src/http/retryPolicy.ts', MOCK_CODEX_SESSION_DIFF.contents['src/http/retryPolicy.ts'].modified),
      },
      result: 'Success. Updated the following files:\nA src/http/retryPolicy.ts',
    },
    {
      name: 'apply_patch',
      input: {
        input: codexUpdateFilePatch(
          'src/http/client.ts',
          MOCK_CODEX_SESSION_DIFF.contents['src/http/client.ts'].original,
          MOCK_CODEX_SESSION_DIFF.contents['src/http/client.ts'].modified,
        ),
      },
      result: 'Success. Updated the following files:\nM src/http/client.ts',
    },
    {
      name: 'shell',
      input: { command: ['bash', '-lc', 'npx vitest run http'], workdir: '/work/storefront-web' },
      result: ' Test Files  3 passed (3)\n      Tests  12 passed (12)\n   Duration  1.94s',
    },
  ],
  closingText:
    'The policy object is extracted: DEFAULT_POLICY retries three times with 200ms exponential backoff on 5xx and 429, and request() now delegates to withRetry. All 12 http tests pass.',
  followUps: [
    {
      userText: 'Do the upload and webhook paths use the shared policy now too?',
      toolCells: [
        {
          name: 'shell',
          input: { command: ['bash', '-lc', 'rg -n "withRetry" src/http'], workdir: '/work/storefront-web' },
          result:
            'src/http/client.ts:4:  return withRetry(DEFAULT_POLICY, () => fetchOrThrow(url, init));\nsrc/http/uploads.ts:57:  return withRetry(UPLOAD_POLICY, () => putChunk(chunk));\nsrc/http/webhooks.ts:33:  return withRetry(DEFAULT_POLICY, () => deliver(event));',
        },
      ],
      closingText:
        'Yes - uploads keep their own UPLOAD_POLICY (five attempts, linear 500ms, sized for large bodies) and webhooks share DEFAULT_POLICY. The hand-rolled loops are gone.',
    },
    {
      // The in-flight turn: a prompt with no reply yet, because the reply is
      // what the terminal's spinner is producing as the reviewer watches.
      userText: 'Sweep the rest of src/http for leftover hand-rolled backoff and tidy what you find.',
    },
  ],
  // The terminal never serves this string (the read-stream handler serves the
  // live codexTuiFrame), but if that special case were ever removed the lens
  // would still show the same TUI rather than going blank.
  scrollback: codexTuiFrame(0),
  model: MOCK_MODEL_CODEX,
  usedTokens: 15_000,
  activityState: 'thinking',
  diff: MOCK_CODEX_SESSION_DIFF,
};

/**
 * The idempotency middleware, referenced by BOTH the opencode session's write
 * tool card and its Changes lens - one constant, same anti-drift reasoning as
 * SELF_HOST_GUIDE_DOC.
 */
const IDEMPOTENCY_MODULE = [
  'import type { RequestHandler } from "express";',
  '',
  'import { findByKey, reserveKey } from "../db/idempotency";',
  '',
  '// A retried charge replays the stored result instead of charging again.',
  'export function idempotent(): RequestHandler {',
  '  return async (request, response, next) => {',
  '    const key = request.header("Idempotency-Key");',
  '    if (!key) return next();',
  '    const existing = await findByKey(key);',
  '    if (existing) return response.status(existing.status).json(existing.body);',
  '    await reserveKey(key);',
  '    next();',
  '  };',
  '}',
  '',
].join('\n');

/**
 * A deep OpenCode session on the second project. Agent variety is now
 * legitimate to demonstrate (every adapter parses a transcript), and OpenCode
 * is the flavor whose tool names are lowercase (`read`, `edit`, `write`,
 * `bash`) - a different ToolCallCard rendering path than Claude's capitalized
 * names or Codex's function envelopes.
 */
export const MOCK_OPENCODE_STATIC_SESSION: MockStaticSessionSpec = {
  sessionId: 'mock-session-opencode',
  taskId: 'mock-task-opencode',
  agentName: 'OpenCode',
  userText: 'Make the charge endpoint idempotent - clients that retry on timeout are double charging.',
  replyText: 'Noted - I will fold that into the idempotency pass before it ships.',
  thinkingText:
    'A retried POST /charges is the same request twice, so the fix is a reservation keyed on the Idempotency-Key header: first request reserves the key and charges, the retry finds the reservation and replays the stored result. The insert has to be race-safe, which means a unique index, not a read-then-write.',
  assistantText:
    'Reproducing first: firing the same charge twice with one Idempotency-Key should return one charge, and today it inserts two rows.',
  toolCells: [
    { name: 'read', input: { filePath: 'src/routes/charges.ts' }, result: '88 lines' },
    {
      name: 'bash',
      input: { command: 'rg -n "INSERT INTO charges" src', description: 'Find the charge insert' },
      result: 'src/db/charges.ts:41:    INSERT INTO charges (id, cart_id, amount_cents)',
    },
    {
      name: 'write',
      input: { filePath: 'src/middleware/idempotency.ts', content: IDEMPOTENCY_MODULE },
      result: 'Created src/middleware/idempotency.ts',
    },
    {
      name: 'edit',
      input: {
        filePath: 'src/routes/charges.ts',
        oldString: 'router.post("/charges", createCharge);',
        newString: 'router.post("/charges", idempotent(), createCharge);',
      },
      result: 'Edited src/routes/charges.ts',
    },
    {
      name: 'bash',
      input: { command: 'npm test -- charges', description: 'Run the charge suite' },
      result: '14 passed, 0 failed',
    },
  ],
  closingText:
    'Charges are idempotent: a repeated Idempotency-Key replays the stored result instead of inserting a second charge. The suite covers the replay and the fresh-key path.',
  followUps: [
    {
      userText: 'What happens when two requests race on the same key?',
      toolCells: [
        {
          name: 'bash',
          input: { command: 'npm test -- idempotency.race', description: 'Race two charges on one key' },
          result: '2 passed, 0 failed',
        },
      ],
      closingText:
        'The reservation insert is guarded by the unique index on the key, so the loser of the race gets a conflict and replays the winner once it lands. The race test pins both orderings.',
    },
    {
      // The in-flight ask the working spinner is answering right now.
      userText: 'Write the race behavior into the payments runbook.',
    },
  ],
  scrollback: [
    'opencode 1.4 · checkout-api',
    '',
    '> Make the charge endpoint idempotent',
    '  - retrying clients double charge.',
    '',
    TUI_TOOL_BULLET + 'read src/routes/charges.ts',
    '  88 lines',
    '',
    TUI_TOOL_BULLET + 'bash rg -n "INSERT INTO charges"',
    '  src/db/charges.ts:41',
    '',
    TUI_TEXT_BULLET + 'Reproduced: two identical charges',
    '  insert two rows. Reserving the',
    '  idempotency key before the insert.',
    '',
    TUI_TOOL_BULLET + 'write src/middleware/idempotency.ts',
    '  17 lines',
    '',
    TUI_TOOL_BULLET + 'edit src/routes/charges.ts',
    '  +2 -1',
    '',
    TUI_TOOL_BULLET + 'bash npm test -- charges',
    '  14 passed, 0 failed',
    '',
    '> What happens when two requests race',
    '  on the same key?',
    '',
    TUI_TOOL_BULLET + 'bash npm test -- idempotency.race',
    '  2 passed, 0 failed',
    '',
    TUI_TEXT_BULLET + 'The unique index on key settles',
    '  the race: the loser replays the',
    '  winner once it lands.',
    '',
    '> Write the race behavior into the',
    '  payments runbook.',
    '',
    TUI_GRAY + '∴ working' + TUI_RESET,
    '',
    TUI_DARK + '╭' + '─'.repeat(activeGrid().cols - 2) + '╮' + TUI_RESET,
    TUI_DARK + '│' + TUI_RESET + ' >'.padEnd(activeGrid().cols - 2, ' ') + TUI_DARK + '│' + TUI_RESET,
    TUI_DARK + '╰' + '─'.repeat(activeGrid().cols - 2) + '╯' + TUI_RESET,
    TUI_GRAY + '  opencode 1.4 · sonnet-5 · 47k tokens' + TUI_RESET,
  ].join('\r\n'),
  model: MOCK_MODEL_SONNET,
  usedTokens: 47_000,
  activityState: 'thinking',
  diff: {
    files: [
      { path: 'src/middleware/idempotency.ts', status: 'A', insertions: 17, deletions: 0, binary: false },
      { path: 'src/routes/charges.ts', status: 'M', insertions: 2, deletions: 1, binary: false },
    ],
    contents: {
      'src/middleware/idempotency.ts': { original: '', modified: IDEMPOTENCY_MODULE, language: 'typescript' },
      'src/routes/charges.ts': {
        original: [
          'import { createCharge } from "../billing/createCharge";',
          '',
          'router.post("/charges", createCharge);',
          '',
        ].join('\n'),
        modified: [
          'import { createCharge } from "../billing/createCharge";',
          'import { idempotent } from "../middleware/idempotency";',
          '',
          'router.post("/charges", idempotent(), createCharge);',
          '',
        ].join('\n'),
        language: 'typescript',
      },
    },
  },
};

/**
 * The gemini session's structured transcript: reminder-email dedupe on the
 * storefront. Tool shapes are Gemini-native, exactly as the desktop's parser
 * passes them through from the CLI's message log: snake_case function names
 * (`read_file`, `search_file_content`, `replace`, `run_shell_command`) with
 * their real argument keys, and a thinking block in the parser's
 * `subject: description` shape (Gemini thoughts carry both). The final turn
 * is the in-flight regression-test ask the TUI's spinner is working on.
 */
export const MOCK_GEMINI_STATIC_SESSION: MockStaticSessionSpec = {
  sessionId: MOCK_GEMINI_SESSION_ID,
  taskId: MOCK_GEMINI_TASK_ID,
  agentName: 'Gemini CLI',
  userText: 'Dedupe the abandoned-cart reminder emails - some customers get three copies in one evening.',
  thinkingText:
    'Reminder fan-out: each open cart enqueues its own reminder job, so a customer with three carts gets three emails. The enqueue side is behaving as designed, which means the fix belongs at send time - one send per customer per evening, listing every open cart.',
  assistantText:
    'Mapping where reminder jobs are enqueued before touching the scheduler. If every cart enqueues its own job, the dedupe belongs at send time, not enqueue time.',
  replyText: 'Folding that into the reminder dedupe before it ships.',
  toolCells: [
    {
      name: 'read_file',
      input: { absolute_path: '/work/storefront-web/src/email/reminders.ts' },
      result: '164 lines. sendReminders() drains the queue and sends one email per job with no grouping.',
    },
    {
      name: 'search_file_content',
      input: { pattern: 'enqueueReminder', path: 'src' },
      result: 'src/cart/abandon.ts:71:  enqueueReminder(cart.id);\nsrc/checkout/timeout.ts:39:  enqueueReminder(cart.id);',
    },
    {
      name: 'replace',
      input: {
        file_path: 'src/email/reminders.ts',
        // The same hunk the Changes lens shows for this file, so the chat's
        // tool card and the diff describe one edit.
        old_string: '  for (const job of jobs) {\n    await sendCartReminder(job.cartId);\n  }',
        new_string:
          '  // One email per customer per evening, however many carts are open:\n  // each open cart enqueues its own job, so group before sending.\n  const byCustomer = new Map<string, ReminderJob[]>();\n  for (const job of jobs) {\n    const group = byCustomer.get(job.customerId) ?? [];\n    group.push(job);\n    byCustomer.set(job.customerId, group);\n  }\n  for (const [customerId, group] of byCustomer) {\n    await sendCartReminder(customerId, group.map((job) => job.cartId));\n  }',
      },
      result: 'Successfully modified file: /work/storefront-web/src/email/reminders.ts (1 replacements).',
    },
    {
      name: 'run_shell_command',
      input: { command: 'npx vitest run email', description: 'Run the email suite' },
      result: ' Test Files  2 passed (2)\n      Tests  11 passed (11)\n   Duration  1.12s',
    },
  ],
  closingText:
    'Sends are grouped per customer per evening now: the drain collects every job for a customer and sends one email listing all of their open carts. The email suite passes.',
  followUps: [
    {
      userText: 'How many customers were actually getting duplicates?',
      toolCells: [
        {
          name: 'run_shell_command',
          input: { command: 'node scripts/reminderStats.mjs --since 7d', description: 'Count duplicate reminder sends' },
          result: 'last 7 days: 18,204 reminders · 412 customers received 2+ in one evening (2.3%)',
        },
      ],
      closingText:
        'About 2.3% of reminded customers - 412 in the last week - got two or more in one evening, every one of them with multiple open carts. The grouping removes all of those.',
    },
    {
      // The in-flight turn the TUI's spinner is answering.
      userText: 'Add a regression test that a customer with two carts gets exactly one email.',
    },
  ],
  // The terminal serves the live geminiTuiFrame; this keeps the lens whole if
  // that special case were ever removed, same reasoning as the codex spec.
  scrollback: geminiTuiFrame(0),
  model: MOCK_MODEL_GEMINI,
  usedTokens: 21_000,
  activityState: 'thinking',
  diff: {
    files: [{ path: 'src/email/reminders.ts', status: 'M', insertions: 11, deletions: 3, binary: false }],
    contents: {
      'src/email/reminders.ts': {
        original: [
          'export async function sendReminders(): Promise<void> {',
          '  const jobs = await reminderQueue.drain();',
          '  for (const job of jobs) {',
          '    await sendCartReminder(job.cartId);',
          '  }',
          '}',
          '',
        ].join('\n'),
        modified: [
          'export async function sendReminders(): Promise<void> {',
          '  const jobs = await reminderQueue.drain();',
          '  // One email per customer per evening, however many carts are open:',
          '  // each open cart enqueues its own job, so group before sending.',
          '  const byCustomer = new Map<string, ReminderJob[]>();',
          '  for (const job of jobs) {',
          '    const group = byCustomer.get(job.customerId) ?? [];',
          '    group.push(job);',
          '    byCustomer.set(job.customerId, group);',
          '  }',
          '  for (const [customerId, group] of byCustomer) {',
          '    await sendCartReminder(customerId, group.map((job) => job.cartId));',
          '  }',
          '}',
          '',
        ].join('\n'),
        language: 'typescript',
      },
    },
  },
};

/** Every session that answers from static content: the extras, codex, opencode, gemini, idle, paused, and the archived pair. */
export const MOCK_STATIC_SESSIONS: MockStaticSessionSpec[] = [
  ...MOCK_EXTRA_THINKING_SESSIONS,
  MOCK_CODEX_STATIC_SESSION,
  MOCK_OPENCODE_STATIC_SESSION,
  MOCK_GEMINI_STATIC_SESSION,
  MOCK_IDLE_STATIC_SESSION,
  MOCK_PAUSED_STATIC_SESSION,
  ...MOCK_ARCHIVED_STATIC_SESSIONS,
];

/**
 * The desktop stamps every assistant entry with the adapter's displayName
 * (transcript-service attaches `agentName: adapter.displayName` at serve
 * time), so these are the real strings: 'Codex CLI', never a bare 'Codex'.
 */
function staticSessionAgentName(spec: MockStaticSessionSpec): string {
  if (spec.agentName) return spec.agentName;
  return spec.model === MOCK_MODEL_CODEX ? 'Codex CLI' : 'Claude Code';
}

function staticSessionSnapshot(spec: MockStaticSessionSpec, wantsTerminal: boolean): ReadStreamResponsePayload {
  return {
    scrollback: wantsTerminal ? spec.scrollback : '',
    activity:
      spec.activityState === 'idle' ? { state: 'idle', reason: { kind: 'idle' } } : { state: 'thinking', reason: { kind: 'turn-active' } },
    usage: mockUsage(spec.usedTokens, spec.model),
    awaitedPromptId: null,
    ptyDimensions: activeGrid(),
  };
}

interface MockStaticSessionState {
  spec: MockStaticSessionSpec;
  transcript: TranscriptEntryWire[];
  revision: number;
}

/** The seed a static session's MUTABLE transcript starts from; sent messages append after it. */
function staticSessionSeedTranscript(spec: MockStaticSessionSpec): TranscriptEntryWire[] {
  const agentName = staticSessionAgentName(spec);
  const model = spec.model.displayName;
  // The spec's top-level fields ARE the first turn; followUps continue it.
  const turns: MockStaticSessionTurn[] = [
    {
      userText: spec.userText,
      thinkingText: spec.thinkingText,
      assistantText: spec.assistantText,
      toolCells: spec.toolCells,
      closingText: spec.closingText,
    },
    ...(spec.followUps ?? []),
  ];
  const stepsFor = (turn: MockStaticSessionTurn): number =>
    1 +
    (turn.assistantText || turn.thinkingText ? 1 : 0) +
    (turn.toolCells?.length ?? 0) * 2 +
    (turn.closingText ? 1 : 0);
  // Oldest first, ~30s apart, ending in the recent past - the cadence of a
  // session that worked and settled, not a burst stamped at load time.
  const cells: TranscriptEntryWire[] = [];
  const stepMs = 30_000;
  const totalSteps = turns.reduce((sum, turn) => sum + stepsFor(turn), 0);
  let step = 0;
  const nextTs = (): number => Date.now() - (totalSteps - step++) * stepMs - 120_000;
  turns.forEach((turn, turnIndex) => {
    const turnNumber = turnIndex + 1;
    cells.push({ kind: 'user', uuid: `${spec.sessionId}-user-${turnNumber}`, ts: nextTs(), text: turn.userText });
    if (turn.assistantText || turn.thinkingText) {
      cells.push({
        kind: 'assistant',
        uuid: `${spec.sessionId}-assistant-${turnNumber}`,
        ts: nextTs(),
        agentName,
        model,
        blocks: [
          ...(turn.thinkingText ? [{ type: 'thinking' as const, text: turn.thinkingText }] : []),
          ...(turn.assistantText ? [{ type: 'text' as const, text: turn.assistantText }] : []),
        ],
      });
    }
    (turn.toolCells ?? []).forEach((toolCell, index) => {
      const toolUseId = `${spec.sessionId}-tooluse-${turnNumber}-${index + 1}`;
      cells.push({
        kind: 'assistant',
        uuid: `${spec.sessionId}-tool-${turnNumber}-${index + 1}`,
        ts: nextTs(),
        agentName,
        model,
        blocks: [{ type: 'tool_use', id: toolUseId, name: toolCell.name, input: toolCell.input }],
      });
      cells.push({
        kind: 'tool_result',
        uuid: `${spec.sessionId}-result-${turnNumber}-${index + 1}`,
        ts: nextTs(),
        toolUseId,
        ...(toolCell.isError ? { isError: true } : {}),
        content: toolCell.result,
      });
    });
    if (turn.closingText) {
      cells.push({
        kind: 'assistant',
        uuid: `${spec.sessionId}-closing-${turnNumber}`,
        ts: nextTs(),
        agentName,
        model,
        blocks: [{ type: 'text', text: turn.closingText }],
      });
    }
  });
  return cells;
}

/** The seed builder, for tests that need a session's pre-mutation length or shape. */
export function staticSessionSeedTranscriptForTest(spec: MockStaticSessionSpec): TranscriptEntryWire[] {
  return staticSessionSeedTranscript(spec);
}

/**
 * The grid `dev:shots` reports, and where those numbers come from.
 *
 * The mirror renders the desktop's real grid and pans the overflow, so what is
 * VISIBLE is set by the auto-fitted font - and that font is fitted to the
 * terminal pane's HEIGHT, never its width (scripts/xterm-page/fontGeometry.js):
 *
 *   fontPx      = clamp(6, 20, floor(paneHeight / (rows * 1.2)))
 *   visibleCols = paneWidth / (fontPx * 0.6)
 *
 * So `rows` is a lever on column count, which is not obvious and is the whole
 * reason a wider grid is affordable at all: more rows means a smaller font
 * means more columns fit.
 *
 * MEASURED off the committed store captures rather than derived. On the
 * 6.9-inch iPhone (store/screenshots/ios/iphone-6.9) the cell is 11.8pt wide
 * and 23.9pt tall at rows:30, which pins font 20 and therefore a pane of
 * 440x720pt; on the Android phone shelf the same arithmetic gives 360x440dp.
 * iOS binds at every candidate because its pane is the tallest, so it takes the
 * biggest font and shows the FEWEST columns:
 *
 *   rows | iOS font / cols | Android phone font / cols
 *     30 |   20px  /  36   |      12px  /  50
 *     38 |   15px  /  48   |       9px  /  66
 *     44 |   13px  /  56   |       8px  /  75
 *     48 |   12px  /  61   |       7px  /  85
 *
 * The grid is 44x38: iOS shows 48 columns, so it fits with four spare, and BOTH
 * shelves keep about three quarters of the text size they ship at today. Going
 * wider is tempting and costs exactly that - at 48 rows the Android phone shelf
 * drops to a 7px font, roughly half of what it renders now, because that shelf
 * has the SHORTEST pane and therefore always takes the smallest font. Column
 * count is bound by iOS; legibility is bound by Android; a grid has to answer
 * to both.
 *
 * Overflowing is silent and single-platform: the first iOS capture cut a branch
 * name mid-word to "fix/sign-in-return-" and nothing caught it until a human
 * looked at the image. tests/unit/storeScreenshots.test.ts re-derives this
 * table and fails if the grid stops fitting.
 */
/**
 * ONE recording, replayed by every mode.
 *
 * An earlier revision carried two - a 120x30 capture for `dev:mock` and a
 * narrow one for `dev:shots` - on the argument that the debugging rig should
 * behave like a real wide desktop, pan and all. On a device that reads as a
 * frame clipped down its right edge, which is not what anybody wants to look at
 * while working, and it doubled the ways the reported grid could disagree with
 * the bytes. One grid that renders whole everywhere is worth more than
 * reproducing the awkwardness of a wide desktop.
 */
export function activeCapture(): RecordedTerminalCapture {
  return CLAUDE_CAPTURE_SHOTS;
}

/**
 * The grid EVERY mock session reports.
 *
 * Derived from the capture rather than written down twice, and shared by the
 * static sessions too: they carry plain-text scrollback with no grid of their
 * own, and letting them announce a different one would mean a single mock
 * desktop claiming two pane sizes.
 */
export function activeGrid(): { cols: number; rows: number } {
  const capture = activeCapture();
  return { cols: capture.cols, rows: capture.rows };
}

/**
 * The scrollback a subscriber receives.
 *
 * A single self-contained frame, not a transcript of lines: Claude Code runs
 * full-screen in the alt buffer and repaints incrementally, so there is no
 * "first N lines" to seed. This is the same artifact a real desktop sends (its
 * headless parser serializes the live grid), which is why the lens looks like a
 * session already in progress the instant it mounts rather than filling from
 * empty - a capture taken during the fill showed three lines adrift in black.
 */
function mockTerminalScrollback(): string {
  return activeCapture().seedFrame;
}

/** The real Claude Code permission-dialog trio, as the desktop's PTY probe would publish it. */
const MOCK_PERMISSION_OPTIONS = [
  'Yes',
  "Yes, and don't ask again for this command",
  'No, and tell Claude what to do differently',
];

export function initialTasks(): BoardTaskWire[] {
  const nowIso = new Date().toISOString();
  return [
    boardTaskFixture({
      id: MOCK_TASK_ID,
      display_id: 1,
      // The streaming session: this is the task every session-lens screenshot
      // is taken against, so its title, diff, terminal and prompt card all
      // describe the SAME piece of work.
      title: 'Fix the sign-in redirect dropping the return path',
      // Deliberately long - a design-review stress test for how the body
      // text truncates against the ticket number, project pill, and PR pill
      // sharing its rows.
      description:
        'Signing in always lands on the dashboard instead of the page that was requested, because the redirect helper throws the original path away. Restore it as a next parameter and add a regression test that covers the query-string round trip.',
      swimlane_id: 'lane-executing',
      // Executing scales light -> heavy: Codex refactor (lightest, position
      // 0) first, this one (medium) second, the "full card" (position 2)
      // last.
      position: 1,
      session_id: MOCK_SESSION_ID,
      branch_name: 'fix/sign-in-return-path',
      labels: ['auth', 'wave-4'],
      pr_number: 42,
      pr_state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-2',
      display_id: 2,
      // Dev affordance: this is the card to long-press when trying the move
      // sheet by hand. Kept as a comment rather than as the card's body text,
      // which ships in the store screenshots.
      title: 'Rate-limit the password reset endpoint',
      description: 'Attempts are unbounded today. Cap them per address and per account before the next security review.',
      swimlane_id: 'lane-todo',
      labels: ['chore'],
      attachment_count: 2,
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_CODEX_TASK_ID,
      display_id: 3,
      // Agent 'codex' with a structured transcript AND a live fullscreen TUI:
      // the second agent flavor a reviewer meets, one card over from the
      // streaming Claude session.
      title: 'Extract the retry policy out of the HTTP client',
      description: 'Backoff and retry are tangled into the request path. Pull them into a policy object that can be tested on its own.',
      swimlane_id: 'lane-executing',
      position: 0,
      agent: 'codex',
      session_id: MOCK_CODEX_SESSION_ID,
      branch_name: 'feature/codex-refactor',
      // No labels on this one - exercises the PR pill with nothing else in
      // the meta row (design-review demo: does the pill still read fine
      // alone, not just alongside label tags).
      pr_number: 17,
      pr_state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_PAUSED_TASK_ID,
      display_id: 5,
      // The "full card": every element the card supports, at once - long
      // title AND long description (both truncate), a PR (in a state we
      // haven't shown elsewhere - 'merged', not 'open'), more labels than
      // the 3-visible cap (exercises the "+N" overflow pill), attachments,
      // and a priority (inert on the card today, ready for the future
      // detail-view addition). The single comprehensive stress-test card.
      title: 'Migrate the legacy card-on-file payment pipeline to the new vault-scoped token flow',
      description:
        'Replaces the old stored-card charge path with the new vault-scoped payment token, keeping backward compatibility for subscriptions still billing on the previous API version while the rollout completes across both regions.',
      swimlane_id: 'lane-executing',
      position: 2,
      // A session, not a bodiless board card: Executing implies an agent is
      // always either running or paused there. Fable 5 - a 4th distinct
      // model, rounding out Sonnet/Opus/Codex already in use.
      agent: 'claude',
      session_id: MOCK_PAUSED_SESSION_ID,
      branch_name: 'feature/vault-token-migration',
      labels: ['backend', 'payments', 'migration', 'breaking-change', 'p0'],
      pr_number: 103,
      pr_state: 'merged',
      attachment_count: 3,
      priority: 2,
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_GEMINI_TASK_ID,
      display_id: 10,
      // The Gemini CLI session - the third agent flavor with a structured
      // transcript, see MOCK_GEMINI_STATIC_SESSION.
      title: 'Dedupe the abandoned-cart reminder emails',
      description: 'A customer with two open carts gets a reminder for each. Collapse the sends to one per customer per evening.',
      swimlane_id: 'lane-executing',
      position: 3,
      agent: 'gemini',
      session_id: MOCK_GEMINI_SESSION_ID,
      branch_name: 'fix/reminder-dedupe',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-planning-1',
      display_id: 11,
      // A quiet Planning card: the board reads staged, not empty, without
      // implying an agent is running there.
      title: 'Plan the multi-currency pricing rollout',
      description: 'Sketch how prices, carts and invoices carry currency, and where conversion happens.',
      swimlane_id: 'lane-planning',
      labels: ['pricing'],
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-merge-1',
      display_id: 12,
      // A session-less card waiting in Merge, PR open: fills the one column
      // that otherwise sat empty on the board a reviewer scrolls.
      title: 'Keep the newer item set when carts merge on sign-in',
      description: 'Signing in with a saved cart currently discards whichever cart is older, even when it was edited seconds ago.',
      swimlane_id: 'lane-merge',
      branch_name: 'fix/cart-merge-priority',
      pr_number: 63,
      pr_state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    // Volume for the Thinking section - see MOCK_EXTRA_THINKING_SESSIONS.
    ...MOCK_EXTRA_THINKING_SESSIONS.map((spec) =>
      boardTaskFixture({
        id: spec.taskId,
        display_id: spec.displayId,
        title: spec.title,
        description: spec.assistantText,
        swimlane_id: spec.swimlaneId,
        agent: spec.model === MOCK_MODEL_CODEX ? 'codex' : 'claude',
        session_id: spec.sessionId,
        created_at: nowIso,
        updated_at: nowIso,
      }),
    ),
  ];
}

/**
 * A codex-style fullscreen TUI frame: cursor-home + full rewrite each
 * paint. Chrome mirrors the REAL Codex CLI: a working spinner line and
 * the `Codex CLI · model · effort · token` context bar (format recorded
 * from a live session; the bar is the frame's last readable line, so it
 * is what the Agents feed's terminal-line snippet surfaces).
 */
function codexTuiFrame(paintTick: number): string {
  const spinnerGlyphs = ['|', '/', '-', '\\'];
  const spinner = spinnerGlyphs[paintTick % spinnerGlyphs.length];
  // Names the work the transcript's in-flight turn asked for (the backoff
  // sweep), so the spinner and the chat lens describe the same moment. The
  // bar is the frame's last readable line, so it becomes the card snippet.
  const statusLine = paintTick % 2 === 0 ? 'Scanning src/http for backoff loops' : 'Tidying src/http/uploads.ts';
  const upTokens = (8.2 + paintTick * 0.1).toFixed(1);
  // Every row is padded to the SAME width as the reported grid. The previous
  // frame hardcoded a 38-glyph border while its two status strings were 35 and
  // 26 columns, so the box was ragged on one paint and over-wide on both - and
  // nothing caught it, because the column checks only ever looked at the
  // streaming session's fixture.
  const width = activeGrid().cols;
  const inner = width - 2;
  // Chrome carries the same dark-border/gray-text palette the recorded
  // Claude frame uses; text is sliced to width BEFORE coloring so the
  // escape bytes never count against the column budget.
  const boxed = (text: string): string =>
    TUI_DARK + '│' + TUI_RESET + text.slice(0, inner).padEnd(inner, ' ') + TUI_DARK + '│' + TUI_RESET;
  // The session's work so far, above the working spinner the way the real
  // Codex CLI keeps its transcript. Static across paints (only the spinner,
  // status and token lines move). Tells the same story as this session's
  // structured transcript (MOCK_CODEX_STATIC_SESSION) and its Changes lens
  // (MOCK_CODEX_SESSION_DIFF), one swipe away in either direction - the TUI
  // just shows less of the history than the chat, exactly like a real
  // fullscreen terminal window.
  const historyRows = [
    '› Extract the retry policy out of the',
    '  HTTP client - three call sites have',
    '  drifted apart.',
    '',
    '• Read src/http/client.ts',
    '  3 retry loops, no shared backoff',
    '',
    '• Added src/http/retryPolicy.ts',
    '  DEFAULT_POLICY: 3 attempts, 200ms',
    '  exponential backoff, retry on 5xx',
    '  and 429',
    '',
    '• Edited src/http/client.ts',
    '  request() now delegates to',
    '  withRetry(DEFAULT_POLICY, ...)',
    '',
    '$ npx vitest run http',
    '  12 passed (12)',
    '',
    '› Sweep the rest of src/http for',
    '  leftover hand-rolled backoff.',
    '',
  ]
    .map((row) => row.slice(0, width))
    .join('\r\n');
  return (
    '\x1b[H\x1b[2J' +
    historyRows +
    '\r\n' +
    TUI_GRAY + `${spinner} Working (${paintTick}s · esc to interrupt)`.slice(0, width) + TUI_RESET +
    '\r\n' +
    TUI_DARK + `╭${'─'.repeat(inner)}╮` + TUI_RESET + '\r\n' +
    `${boxed(` ${statusLine}`)}\r\n` +
    TUI_DARK + `╰${'─'.repeat(inner)}╯` + TUI_RESET + '\r\n' +
    TUI_GRAY + `Codex CLI · GPT-5 Codex · ↑${upTokens}k ↓${420 + paintTick}`.slice(0, width) + TUI_RESET +
    '\r\n'
  );
}

/** The frame above, for the fixture-coverage tests. */
export function codexTuiFrameForTest(paintTick: number): string {
  return codexTuiFrame(paintTick);
}

/**
 * The gemini session's fullscreen TUI frame: the session's work so far above
 * a working spinner, the way the real Gemini CLI keeps its transcript on
 * screen (✦ response bullets, ✔ completed tool cards by their display names,
 * the model/context status bar). Static across paints except the spinner,
 * the alternating status line, and the elapsed seconds. Tells the same story
 * as MOCK_GEMINI_STATIC_SESSION's transcript, whose final turn is the
 * regression-test ask this spinner is working on.
 */
function geminiTuiFrame(paintTick: number): string {
  const spinnerGlyphs = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
  const spinner = spinnerGlyphs[paintTick % spinnerGlyphs.length];
  const seconds = 14 + paintTick * 2;
  const statusLine = paintTick % 2 === 0 ? 'Writing the two-cart regression test' : 'Running the email suite';
  const width = activeGrid().cols;
  const rows = [
    'Gemini CLI',
    '',
    '> Dedupe the abandoned-cart reminder',
    '  emails - some customers get three',
    '  copies in one evening.',
    '',
    '✦ Mapping where reminder jobs are',
    '  enqueued before touching the',
    '  scheduler.',
    '',
    '✔ ReadFile src/email/reminders.ts',
    '✔ SearchText enqueueReminder in src',
    '✔ Edit src/email/reminders.ts',
    '✔ Shell npx vitest run email',
    '  11 passed',
    '',
    '✦ Sends are grouped per customer per',
    '  evening now - one email lists every',
    '  open cart.',
    '',
    '> Add a regression test that a',
    '  customer with two carts gets',
    '  exactly one email.',
    '',
    TUI_GRAY + `${spinner} ${statusLine}`.slice(0, width) + TUI_RESET,
    TUI_GRAY + `  (esc to cancel, ${seconds}s)` + TUI_RESET,
    '',
    TUI_GRAY + 'gemini-3-pro · 96% context left' + TUI_RESET,
  ]
    // Colored rows are already width-sliced above; slicing an escape-bearing
    // row here would count SGR bytes against the column budget.
    .map((row) => (row.includes(ESC) ? row : row.slice(0, width)))
    .join('\r\n');
  return '\x1b[H\x1b[2J' + rows + '\r\n';
}

/** The frame above, for the fixture-coverage tests. */
export function geminiTuiFrameForTest(paintTick: number): string {
  return geminiTuiFrame(paintTick);
}

// Mirrors the real Kangentic default board so mock mode exercises the
// chip bar and sectioned scroll at true column scale.
function mockColumns() {
  return [
    // 'To Do' and 'Done' leave `icon` null to exercise the role-default
    // fallback (layers / circle-check-big); the rest carry explicit
    // desktop-picked icons, mirroring a real project's board.
    boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0, color: '#8b949e' }),
    boardColumnFixture({ id: 'lane-planning', name: 'Planning', role: null, position: 1, color: '#8957e5', icon: 'notebook-pen' }),
    boardColumnFixture({ id: 'lane-executing', name: 'Executing', role: null, position: 2, color: '#58a6ff', icon: 'square-code' }),
    boardColumnFixture({ id: 'lane-code-review', name: 'Code Review', role: null, position: 3, color: '#d29922', icon: 'git-pull-request' }),
    boardColumnFixture({ id: 'lane-testing', name: 'Testing', role: null, position: 4, color: '#39c5cf', icon: 'flask-conical' }),
    boardColumnFixture({ id: 'lane-merge', name: 'Merge', role: null, position: 5, color: '#f0883e', icon: 'git-merge' }),
    boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 6, color: '#3fb950' }),
  ];
}

function mockColumns2() {
  return [
    boardColumnFixture({ id: 'lane2-backlog', name: 'Backlog', role: 'todo', position: 0, color: '#58a6ff' }),
    boardColumnFixture({ id: 'lane2-progress', name: 'In Progress', role: null, position: 1, color: '#d29922' }),
    boardColumnFixture({ id: 'lane2-shipped', name: 'Shipped', role: 'done', position: 2, color: '#3fb950' }),
  ];
}

export function initialTasks2(): BoardTaskWire[] {
  const nowIso = new Date().toISOString();
  return [
    boardTaskFixture({
      id: MOCK_IDLE_TASK_ID,
      display_id: 1,
      // An idle agent session: exercises the Home feed's Idle section.
      title: 'Checkout load-test follow-ups',
      description: 'Latency held under a millisecond across fifty concurrent carts. Write up the headroom numbers and open issues for the two slowest cases.',
      swimlane_id: 'lane2-progress',
      session_id: MOCK_IDLE_SESSION_ID,
      branch_name: 'perf/load-test',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_OPENCODE_STATIC_SESSION.taskId,
      display_id: 3,
      // The deep OpenCode session - see MOCK_OPENCODE_STATIC_SESSION.
      title: 'Make the charge endpoint idempotent',
      description: 'Clients that retry a timed-out charge double bill. Reserve an idempotency key before the insert and replay the stored result.',
      swimlane_id: 'lane2-progress',
      position: 1,
      agent: 'opencode',
      session_id: MOCK_OPENCODE_STATIC_SESSION.sessionId,
      branch_name: 'feature/idempotency-keys',
      labels: ['payments'],
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-relay-2',
      display_id: 2,
      // A quiet, session-less second-project card.
      title: 'Document the metrics endpoint',
      description: 'Describe every counter the checkout service exposes, and which ones are safe to scrape from outside the cluster.',
      swimlane_id: 'lane2-backlog',
      created_at: nowIso,
      updated_at: nowIso,
    }),
  ];
}

/** Per-turn token counts, shaped like the desktop parser's extractTurnUsage output. */
function mockTurnUsage(inputTokens: number, outputTokens: number): TranscriptTurnUsageWire {
  return {
    inputTokens,
    outputTokens,
    // A real turn reads almost all of its context from cache and writes a
    // little; a turn reporting only fresh input tokens does not look real.
    cacheCreationInputTokens: Math.round(inputTokens * 0.12),
    cacheReadInputTokens: Math.round(inputTokens * 7.4),
  };
}

/** The transcript below, for the fixture-coverage tests. */
export function baseTranscriptForTest(): TranscriptEntryWire[] {
  return baseTranscript();
}

/**
 * SHAPED from a real Claude Code session's transcript (the App Phase 1
 * overnight run) so mock parity matches genuine session shapes: an Edit with
 * multi-line old/new strings, real command outputs, and real assistant prose
 * lengths. Machine paths are sanitized to C:\Users\dev per the
 * no-personal-info rule.
 *
 * The PROSE is authored, not recorded. It was rewritten off the original
 * CLAUDE.md/EAS-profiles turn so that it describes the same sign-in redirect
 * fix as this session's diff, terminal feed, labels and prompt card - the
 * session-lens screenshots all carry the task title in a shared header, so a
 * transcript about different work would contradict its own header inside a
 * single frame. The recorded command outputs (typecheck, vitest) are real and
 * unchanged.
 */
function baseTranscript(): TranscriptEntryWire[] {
  const now = Date.now();
  return [
    {
      // A slash command is a USER entry carrying the command as typed, not a
      // `system`/`command` divider - that subtype only comes from the desktop's
      // degraded index-fallback path (transcript-service), never from parsing a
      // live Claude session (transcript-parser's parseCommandEntry).
      kind: 'user',
      uuid: 'mock-user-command',
      ts: now - 320000,
      text: '/context',
    },
    {
      kind: 'system',
      uuid: 'mock-system-command-output',
      ts: now - 318000,
      subtype: 'command_output',
      text: 'storefront-web  main  1 file changed\nModel: Sonnet 5  Context: 42k/200k (21%)',
    },
    {
      kind: 'user',
      uuid: 'mock-user-1',
      ts: now - 300000,
      text: 'Signing in always lands on the dashboard instead of the page I asked for. Fix the redirect and verify the suites still pass.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-plan',
      ts: now - 296000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(3120, 410),
      blocks: [
        {
          // Every turn at high effort carries one of these, and the chat lens
          // has a whole collapsed-by-default cell for it that no mock session
          // ever reached.
          type: 'thinking',
          text: 'The redirect helper takes a path argument but never uses it, so the caller-side fix is not enough on its own. Before editing I want the call sites, because if any of them pass nothing the signature has to stay optional. Reading the helper first, then grepping for callers.',
        },
        {
          type: 'tool_use',
          id: 'mock-tool-read',
          name: 'Read',
          input: { file_path: 'C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\login.ts' },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-read',
      ts: now - 294000,
      toolUseId: 'mock-tool-read',
      content:
        '     1\timport { redirect } from "../router";\n     2\t\n     3\texport function loginRedirect(path) {\n     4\t  redirect("/login");\n     5\t  return null;\n     6\t}',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-grep',
      ts: now - 292000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(4210, 180),
      blocks: [{ type: 'tool_use', id: 'mock-tool-grep', name: 'Grep', input: { pattern: 'loginRedirect\\(', output_mode: 'content' } }],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-grep',
      ts: now - 291000,
      toolUseId: 'mock-tool-grep',
      // Only checkout.tsx is missing the path, and only checkout.tsx appears in
      // diffFileList. A call site shown here as broken but absent from the
      // Changes lens reads as work the agent claimed and never did.
      content:
        'src/routes/checkout.tsx:8:    return loginRedirect();\nsrc/routes/account.tsx:12:  return loginRedirect(route.path);\nsrc/auth/guard.ts:21:  return loginRedirect(to.path);',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-todo',
      ts: now - 289000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(5100, 260),
      blocks: [
        {
          type: 'tool_use',
          id: 'mock-tool-todo',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Thread the requested path through loginRedirect', status: 'in_progress', activeForm: 'Threading the path through loginRedirect' },
              { content: 'Reject off-site return paths in afterSignIn', status: 'pending', activeForm: 'Rejecting off-site return paths' },
              { content: 'Update the call sites', status: 'pending', activeForm: 'Updating the call sites' },
            ],
          },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-todo',
      ts: now - 288000,
      toolUseId: 'mock-tool-todo',
      content: 'Todos have been modified successfully.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-1',
      ts: now - 280000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(6480, 720),
      blocks: [
        {
          type: 'text',
          text: 'Found it: `loginRedirect` takes the requested path and then throws it away, so every sign-in ends up at the default route. Threading it through as a **next** parameter.',
        },
        {
          // old_string/new_string are the SAME edit the Changes lens shows for
          // src/auth/login.ts (diffFileContent below), so the chat and diff
          // screenshots describe one piece of work rather than two.
          type: 'tool_use',
          id: 'mock-tool-1',
          name: 'Edit',
          input: {
            replace_all: false,
            file_path: 'C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\login.ts',
            // Byte-for-byte the hunk diffFileContent shows for this file, so
            // the chat frame and the diff frame show one edit rather than two
            // "before" states of the same function, one swipe apart.
            old_string: 'export function loginRedirect(path) {\n  redirect("/login");',
            new_string:
              'export function loginRedirect(path: string) {\n  redirect(path ? `/login?next=${encodeURIComponent(path)}` : "/login");',
          },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-1',
      ts: now - 270000,
      toolUseId: 'mock-tool-1',
      content:
        'The file C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\login.ts has been updated successfully.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-2',
      ts: now - 260000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(7020, 140),
      blocks: [{ type: 'tool_use', id: 'mock-tool-tc', name: 'Bash', input: { command: 'npm run typecheck' } }],
    },
    {
      // A FAILING tool result. Routine in a real session, and until now the mock
      // never produced one, so the whole error visual language - the `✗` glyph
      // on the tool card and the danger-tinted result border - was unreachable.
      kind: 'tool_result',
      uuid: 'mock-result-tc',
      ts: now - 250000,
      toolUseId: 'mock-tool-tc',
      isError: true,
      content:
        '> storefront-web@2.4.0 typecheck\n> tsc --noEmit\n\nsrc/auth/session.ts(4,10): error TS2322: Type "string | null | undefined" is not assignable to type "string".',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-guard',
      ts: now - 248000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(7640, 880),
      blocks: [
        {
          type: 'text',
          text: 'The narrowed return type needs a guard rather than a cast, so `afterSignIn` only accepts a same-site absolute path and falls back to the default otherwise.',
        },
        {
          type: 'tool_use',
          id: 'mock-tool-write',
          name: 'Write',
          input: {
            file_path: 'C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\session.ts',
            // TAKEN from the Changes lens rather than transcribed alongside it.
            // ToolCallCard renders the first 20 lines of a Write verbatim, so
            // this file appears IN FULL in the chat frame, one swipe from the
            // Changes frame showing the same file - and a hand-copied version
            // drifted: it named `DEFAULT_DESTINATION` and called an
            // `isSafeReturnPath` the diff frame never defined. Reading the
            // anchor is the only version that cannot drift again.
            content: diffFileContent('src/auth/session.ts').modified,
          },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-write',
      ts: now - 246000,
      toolUseId: 'mock-tool-write',
      content: 'The file C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\session.ts has been updated successfully.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-3',
      ts: now - 240000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(8310, 210),
      blocks: [{ type: 'tool_use', id: 'mock-tool-vt', name: 'Bash', input: { command: 'npx vitest run tests/unit' } }],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-vt',
      ts: now - 230000,
      toolUseId: 'mock-tool-vt',
      content: ' Test Files  38 passed (38)\n      Tests  305 passed (305)\n   Duration  2.72s',
    },
    {
      // Every long session crosses one of these.
      kind: 'system',
      uuid: 'mock-system-compaction',
      ts: now - 228000,
      subtype: 'compaction',
      text: 'Conversation compacted (auto, 168420 tokens before compaction)',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-subagent',
      ts: now - 226000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(2140, 300),
      blocks: [
        {
          type: 'tool_use',
          id: 'mock-tool-task',
          name: 'Task',
          input: {
            description: 'Audit the remaining call sites',
            subagent_type: 'general-purpose',
            prompt: 'Find every caller of loginRedirect and confirm each one now passes the requested path.',
          },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-task',
      ts: now - 224000,
      toolUseId: 'mock-tool-task',
      content: 'Four call sites. checkout.tsx and account.tsx now pass the current path; guard.ts already did; the test helper is unaffected.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-mcp',
      ts: now - 223000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(9120, 190),
      blocks: [
        {
          // MCP-namespaced tools are everywhere in a real session and the chat
          // lens had never rendered one.
          type: 'tool_use',
          id: 'mock-tool-mcp',
          name: 'mcp__github__list_pull_requests',
          input: { owner: 'storefront', repo: 'storefront-web', state: 'open' },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-mcp',
      ts: now - 222000,
      toolUseId: 'mock-tool-mcp',
      content: '#218 Checkout: keep the cart on session expiry\n#221 Bump the design tokens package',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-4',
      ts: now - 220000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      usage: mockTurnUsage(9880, 640),
      blocks: [
        {
          type: 'text',
          text: 'Typecheck and the unit suite are green, and the redirect now carries the requested path through sign-in. Running the component tier next needs your approval.',
        },
      ],
    },
  ];
}

/**
 * The change set the RECORDED session actually produced.
 *
 * Not authored: these are the four files, and the exact line counts, that the
 * Claude Code session in src/devsupport/claudeCapture.ts changed while fixing
 * the sign-in redirect, taken from `git diff --stat` of the storefront fixture
 * repo it ran against. That is what keeps the Terminal, Chat and Changes lenses
 * describing ONE piece of work: a reviewer comparing 02-session-terminal
 * against 04-session-changes is exactly what a store listing invites, and the
 * previous authored list disagreed with the terminal about which files were
 * touched and by how much.
 *
 * Regenerate both this and diffFileContent from the patch whenever the capture
 * is re-recorded.
 */
export function diffFileList(): DiffFileListWire {
  return {
    files: [
      { path: 'src/auth/login.ts', status: 'M', insertions: 2, deletions: 2, binary: false },
      { path: 'src/auth/session.ts', status: 'M', insertions: 10, deletions: 2, binary: false },
      { path: 'src/components/SignInForm.tsx', status: 'M', insertions: 3, deletions: 3, binary: false },
      { path: 'src/routes/checkout.tsx', status: 'M', insertions: 3, deletions: 1, binary: false },
    ],
    totalInsertions: 18,
    totalDeletions: 8,
  };
}

/**
 * The before/after text of each file the recorded session changed, transcribed
 * from the same `git diff` that produced diffFileList. The app derives the
 * unified diff itself (src/diff), so these are file contents, not patches.
 *
 * These are REAL edits, which means some lines are longer than a phone is wide
 * and the diff rows scroll horizontally. That was previously avoided by keeping
 * authored lines under ~46 columns; it is kept now because the alternative is
 * re-authoring the agent's work, and a review surface that only ever shows
 * short lines misrepresents what reviewing a real diff on a phone is like.
 */
export function diffFileContent(filePath: string): DiffFileContentWire {
  if (filePath === 'src/auth/login.ts') {
    return {
      original: [
        'import { redirect } from "../router";',
        '',
        'export function loginRedirect(path) {',
        '  redirect("/login");',
        '  return null;',
        '}',
        '',
        'export function isProtected(path) {',
        '  return path.startsWith("/account");',
        '}',
        '',
      ].join('\n'),
      modified: [
        'import { redirect } from "../router";',
        '',
        'export function loginRedirect(path: string) {',
        '  redirect(path ? `/login?next=${encodeURIComponent(path)}` : "/login");',
        '  return null;',
        '}',
        '',
        'export function isProtected(path) {',
        '  return path.startsWith("/account");',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
    };
  }
  if (filePath === 'src/auth/session.ts') {
    return {
      original: ['export function afterSignIn() {', '  return "/dashboard";', '}', ''].join('\n'),
      modified: [
        'const DEFAULT_AFTER_SIGN_IN = "/dashboard";',
        '',
        '// Only path-absolute, same-origin targets are safe to navigate to. Rejects',
        '// "//evil.com" and "/\\evil.com", which browsers resolve as protocol-relative URLs.',
        'function isInternalPath(path: string | null | undefined): path is string {',
        '  return !!path && path.startsWith("/") && path[1] !== "/" && path[1] !== "\\\\";',
        '}',
        '',
        'export function afterSignIn(next?: string | null) {',
        '  return isInternalPath(next) ? next : DEFAULT_AFTER_SIGN_IN;',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
    };
  }
  if (filePath === 'src/components/SignInForm.tsx') {
    return {
      original: [
        'import { useNavigate, useSearchParams } from "../router";',
        '',
        'export function SignInForm() {',
        '  const navigate = useNavigate();',
        '  const params = useSearchParams();',
        '',
        '  const onSubmit = async () => {',
        '    await signIn(email, password);',
        '    navigate(afterSignIn());',
        '  };',
        '',
      ].join('\n'),
      modified: [
        'import { useNavigate } from "../router";',
        '',
        'export function SignInForm() {',
        '  const navigate = useNavigate();',
        '',
        '  const onSubmit = async () => {',
        '    await signIn(email, password);',
        '    const next = new URLSearchParams(window.location.search).get("next");',
        '    navigate(afterSignIn(next));',
        '  };',
        '',
      ].join('\n'),
      language: 'typescript',
    };
  }
  if (filePath === 'src/routes/checkout.tsx') {
    return {
      original: 'if (!user) {\n  return loginRedirect();\n}\n',
      modified: [
        'if (!user) {',
        '  // Empty on the server; loginRedirect falls back to a plain /login in that case.',
        '  const { pathname, search, hash } = typeof window === "undefined" ? EMPTY_LOCATION : window.location;',
        '  return loginRedirect(pathname + search + hash);',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
    };
  }
  // Every path diffFileList advertises is handled above. A request for anything
  // else is a bug somewhere, and answering it with the last file's diff - which
  // a fallthrough default would do - shows the wrong file's changes under the
  // right filename. An empty diff is wrong in a way a reader can see.
  return { original: '', modified: '', language: 'typescript' };
}

export interface CreateMockDesktopOptions {
  /**
   * The phone identity and desktop static key this peer should run under.
   *
   * Omitted (the dev rig's mock mode), both are generated per connection and
   * the synthesized anchor simply reports whatever was generated. The demo
   * pairing supplies both, because its anchor is PERSISTED: the session
   * handshake uses the anchor's desktop key as `remoteStatic`, so a peer that
   * generated a fresh key would never authenticate against the key the
   * ceremony pinned. Passing the real device identity also keeps the Devices
   * screen's "This phone" fingerprint agreeing with the session actually
   * running.
   */
  identity?: X25519KeyPair;
  desktopStatic?: X25519KeyPair;
}

/**
 * The Done column's rows for a project.
 *
 * At module scope rather than inside the factory so the fixture-vocabulary
 * guard can reach it. That is not a testability nicety: these two titles render
 * on the Done column, which is one navigation from where a reviewer lands since
 * the demo pairing shipped, and they previously read "Shipped: the completed
 * mock task" and "Closed without an agent" precisely because nothing collected
 * them.
 */
export function archivedTasksFor(projectId: string): BoardTaskWire[] {
  // Distinct rows per project: identical Done columns (and a storefront
  // story on the API board) read as copy-pasted fixtures to anyone who
  // opens both, which since the demo pairing shipped includes App Review.
  if (projectId === MOCK_PROJECT_2.id) {
    return [
      boardTaskFixture({
        id: `${projectId}-archived-1`,
        display_id: 901,
        title: 'Batch the tax lookup in checkout totals',
        swimlane_id: 'lane2-shipped',
        session_id: `${projectId}-archived-session-1`,
        archived_at: '2026-07-22T15:45:00.000Z',
      }),
      boardTaskFixture({
        id: `${projectId}-archived-2`,
        display_id: 902,
        title: 'Rotate the payment-gateway sandbox keys',
        swimlane_id: 'lane2-shipped',
        position: 1,
        session_id: null,
        archived_at: '2026-07-18T10:05:00.000Z',
      }),
    ];
  }
  return [
    boardTaskFixture({
      id: `${projectId}-archived-1`,
      display_id: 901,
      title: 'Cache the product-grid query on the storefront home',
      swimlane_id: 'lane-done',
      session_id: `${projectId}-archived-session-1`,
      archived_at: '2026-07-20T18:30:00.000Z',
    }),
    boardTaskFixture({
      id: `${projectId}-archived-2`,
      display_id: 902,
      title: 'Bump the design tokens package to 4.2',
      swimlane_id: 'lane-done',
      position: 1,
      session_id: null,
      archived_at: '2026-07-19T09:15:00.000Z',
    }),
  ];
}

export function createMockDesktop(options: CreateMockDesktopOptions = {}): MockDesktop {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  const identity = options.identity ?? generateX25519KeyPair();
  const desktopStatic = options.desktopStatic ?? generateX25519KeyPair();
  const peer = new StubSessionInitiator(desktopTransport, {
    desktopStatic,
    phoneStaticPublicKey: identity.publicKey,
  });

  // Mutable scenario state, reset whenever the connection reopens (the
  // module is re-instantiated per openConnection).
  const tasks = initialTasks();
  const tasks2 = initialTasks2();
  let transcript = baseTranscript();
  let transcriptRevision = 1;
  /**
   * Every static session's LIVE state. The transcripts are mutable so a chat
   * message SENT into one of these sessions actually lands and draws a reply,
   * instead of vanishing against a fixed two-entry window - which is exactly
   * what a reviewer poking a second session would hit. Reset per connection
   * with the rest of the scenario.
   */
  const staticSessionStates = new Map<string, MockStaticSessionState>(
    MOCK_STATIC_SESSIONS.map((spec) => [spec.sessionId, { spec, transcript: staticSessionSeedTranscript(spec), revision: 1 }]),
  );
  /**
   * Tasks archived DURING this connection (a move into the done-role column),
   * per project. archivedPage serves these ahead of the fixed fixtures, so an
   * archived card lands in the Done column instead of vanishing entirely.
   */
  const archivedDuringSession = new Map<string, BoardTaskWire[]>();
  /**
   * Whether ANY read-stream subscription is attached. Gates the whole
   * simulated agent: usage growth, transcript entries, the permission prompt.
   *
   * Deliberately NOT the same thing as wanting PTY bytes. The feed subscribes
   * list-only (`terminal: false`), and that is the normal state whenever no
   * session screen is open - so conflating the two left the mock agent inert
   * on the Home feed, which is the screen the mock mostly exists to preview.
   * Whether PTY bytes flow is now carried by terminalPlayback below: it exists
   * only while a subscriber asked for the terminal.
   */
  let streamSubscribed = false;
  let feedTick = 0;
  /**
   * The capture replay, started when a subscriber first asks for PTY bytes and
   * running on the RECORDED timing rather than the 1Hz tick.
   *
   * Two reasons it is not tick-driven. Cadence: Claude Code bursts while a turn
   * streams and goes silent through a tool call, and a fixed rate reads as a
   * script being typed out however real the bytes are. Ordering: the replay must
   * start from its own beginning whenever the lens opens, not from wherever the
   * global ticker happens to be - keyed to the tick, a session opened from the
   * Agents feed began mid-narrative and showed work happening after the step
   * that depended on it.
   */
  let terminalPlayback: RecordedTerminalPlayback | null = null;
  let pendingPromptId: string | null = null;
  let questionRaised = false;
  let entryCounter = 0;
  // Caps the tick-driven Bash cells specifically (below) - separate from
  // entryCounter, which also numbers user-sent messages and created tasks
  // and must keep incrementing for uuid uniqueness regardless of this cap.
  // Without a cap the mock streamed a new cell every 12 ticks forever, so a
  // long-running mock session (e.g. left open through an hours-long design
  // review) grew the transcript - and the Chat lens's rendering work -
  // without bound.
  let tickEntryCount = 0;
  // A tick Bash cell completes with its matching tool_result a few ticks
  // later, mirroring the real bridge (an agent's tool call always ends in a
  // result). Without it every tick cell stayed pending forever, stacking
  // identical "running Bash" cards in the chat lens.
  let pendingTickResult: { toolUseId: string; content: string; dueTick: number } | null = null;
  let feedTimer: ReturnType<typeof setInterval> | null = null;
  // The reported grid must be the grid the REPLAYED CAPTURE was recorded at,
  // never a constant written down separately: the bytes are whatever
  // claudeCapture.ts was recorded at, and announcing anything else has the
  // phone render them into the wrong grid - every box border sliced, on the
  // one build that ships images. Read from the capture so a re-record at a new
  // grid cannot leave this behind.
  let ptyDimensions = activeGrid();
  const oneShotTimers = new Set<ReturnType<typeof setTimeout>>();
  // Session-lifecycle simulation (the /respawn and /end-session magic
  // composer commands): the streaming task's CURRENT session id, mirroring
  // the desktop respawning a task's agent under a fresh id.
  let activeSessionId: string | null = MOCK_SESSION_ID;
  let respawnCounter = 1;
  let codexStreamSubscribed = false;
  let geminiStreamSubscribed = false;

  function emit(event: BridgeEvent): void {
    if (!peer.isEstablished) return;
    peer.emitEvent(event);
  }

  function emitPtyResize(): void {
    if (activeSessionId === null) return;
    emit({ kind: 'terminal-resize', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { ...ptyDimensions } });
  }

  function later(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      oneShotTimers.delete(timer);
      action();
    }, delayMs);
    oneShotTimers.add(timer);
  }

  /** Appends an entry and streams it as a protocol-v2 indexed delta, exactly like the real bridge. */
  function appendTranscriptEntry(entry: TranscriptEntryWire): void {
    if (activeSessionId === null) return;
    transcript.push(entry);
    transcriptRevision += 1;
    emit({
      kind: 'transcript',
      sessionId: activeSessionId,
      taskId: MOCK_TASK_ID,
      payload: {
        mode: 'delta',
        revision: transcriptRevision,
        totalEntries: transcript.length,
        upserts: [{ index: transcript.length - 1, entry }],
      },
    });
  }

  /** appendTranscriptEntry's static-session sibling: same wire shape, that session's ids and revision. */
  function appendStaticSessionEntry(state: MockStaticSessionState, entry: TranscriptEntryWire): void {
    state.transcript.push(entry);
    state.revision += 1;
    emit({
      kind: 'transcript',
      sessionId: state.spec.sessionId,
      taskId: state.spec.taskId,
      payload: {
        mode: 'delta',
        revision: state.revision,
        totalEntries: state.transcript.length,
        upserts: [{ index: state.transcript.length - 1, entry }],
      },
    });
  }

  function emitStaticSessionActivity(spec: MockStaticSessionSpec, state: 'thinking' | 'idle'): void {
    const reason = state === 'idle' ? { kind: 'idle' as const } : { kind: 'turn-active' as const };
    emit({ kind: 'activity', sessionId: spec.sessionId, taskId: spec.taskId, payload: { type: 'activity', state, reason } });
  }

  function emitActivity(state: 'thinking' | 'idle' | 'permission'): void {
    if (activeSessionId === null) return;
    const reason = state === 'permission' ? { kind: 'permission' as const } : state === 'idle' ? { kind: 'idle' as const } : { kind: 'turn-active' as const };
    emit({ kind: 'activity', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { type: 'activity', state, reason } });
  }

  /** Grows with feedTick so the board card's context bar visibly advances during a mock session, like a real one. */
  function emitUsage(): void {
    if (activeSessionId === null) return;
    emit({
      kind: 'activity',
      sessionId: activeSessionId,
      taskId: MOCK_TASK_ID,
      payload: { type: 'usage', usage: mockUsage(streamingUsedTokens(feedTick), MOCK_MODEL_SONNET) },
    });
  }

  function raisePrompt(promptId: string): void {
    if (activeSessionId === null) return;
    pendingPromptId = promptId;
    emit({
      kind: 'activity',
      sessionId: activeSessionId,
      taskId: MOCK_TASK_ID,
      payload: {
        type: 'permission',
        promptId,
        pending: true,
        // The empirical Claude Code permission trio, as the desktop's PTY
        // probe publishes it (protocol 0.6.0): the question prompt keeps
        // its own AskUserQuestion options and gets none here.
        ...(promptId === PERMISSION_PROMPT_ID ? { options: MOCK_PERMISSION_OPTIONS } : {}),
      },
    });
    emitActivity('permission');
  }

  function clearPrompt(promptId: string): void {
    pendingPromptId = null;
    later(50, () => {
      if (activeSessionId === null) return;
      emit({ kind: 'activity', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { type: 'permission', promptId, pending: false } });
      emitActivity('thinking');
    });
  }

  /** Points the streaming task at a session id (or none) and pushes the board change, like the real desktop's lifecycle feed. */
  function setTaskSession(nextSessionId: string | null): void {
    const streamingTask = tasks.find((candidate) => candidate.id === MOCK_TASK_ID);
    if (streamingTask) {
      streamingTask.session_id = nextSessionId;
      streamingTask.updated_at = new Date().toISOString();
    }
    later(50, () => {
      emit({ kind: 'board', projectId: MOCK_PROJECT.id, taskId: MOCK_TASK_ID, payload: { change: 'task-updated', ids: [MOCK_TASK_ID] } });
    });
  }

  /**
   * The /end-session magic command: the desktop stops running a session for
   * the task. Subsequent read-stream subscribes for the dead id fail exactly
   * like the real bridge once the registry entry is gone.
   */
  function endActiveSession(): void {
    pendingPromptId = null;
    pendingTickResult = null;
    const endedSessionId = activeSessionId;
    // The real desktop pushes session-ended immediately before it tears the
    // read-stream subscription down, and since the 0.9.0 board projection that
    // event is the ONLY signal the phone gets: this mock's own boardSnapshot()
    // applies the same `view: 'sessions'` filter, so the ended task leaves the
    // board entirely rather than surviving with a null session_id. Without
    // this the session screen could never reach its ended state under
    // dev:mock, and the input bar stayed live for a task the board had
    // already dropped.
    if (endedSessionId !== null) {
      emit({
        kind: 'activity',
        sessionId: endedSessionId,
        taskId: MOCK_TASK_ID,
        payload: { type: 'session-ended', intentional: true },
      });
    }
    activeSessionId = null;
    streamSubscribed = false;
    // The replay outlives the session unless it is stopped here. Harmless while
    // the capture is a single settled frame, but a streaming re-record would
    // leave a live timer writing the ended session's bytes.
    stopTerminalPlayback();
    setTaskSession(null);
  }

  /**
   * The /respawn magic command: the desktop restarts the task's agent under
   * a FRESH session id (a model switch). The transcript resets (a new
   * process has a new transcript) with a marker entry Maestro can assert on.
   */
  function respawnActiveSession(): void {
    respawnCounter += 1;
    const successorSessionId = `mock-session-${respawnCounter}`;
    pendingPromptId = null;
    pendingTickResult = null;
    activeSessionId = successorSessionId;
    streamSubscribed = false;
    // Worse than the end-session case: activeSessionId is NOT null here, so a
    // playback left running would emit the dead session's recorded bytes into
    // the successor's terminal. The next subscribe restarts it from the top.
    stopTerminalPlayback();
    transcript = [
      {
        kind: 'assistant',
        uuid: `mock-respawn-marker-${respawnCounter}`,
        ts: Date.now(),
        agentName: 'Claude Code',
        model: MOCK_MODEL_SONNET.displayName,
        // The successor's id is deliberately NOT rendered: these fixtures reach
        // published screenshots and, since the demo pairing shipped, an App
        // Review device, and the internal ids read as scaffolding.
        blocks: [{ type: 'text', text: 'Session restarted. Picking up where the previous run left off.' }],
      },
    ];
    transcriptRevision = 1;
    setTaskSession(successorSessionId);
  }

  function raiseQuestionPrompt(): void {
    questionRaised = true;
    appendTranscriptEntry({
      kind: 'assistant',
      uuid: 'mock-assistant-question',
      ts: Date.now(),
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      blocks: [
        { type: 'text', text: 'The fix works. One decision before I write the regression test:' },
        {
          type: 'tool_use',
          id: QUESTION_TOOL_ID,
          name: 'AskUserQuestion',
          input: {
            // Shape mirrored from a REAL Claude Code AskUserQuestion tool_use
            // (session 3f4dd05b, "Auto-approve kill"): questions[] of
            // {question, header, multiSelect, options[{label, description,
            // preview?}]}. Four options exercises the digit-select ceiling;
            // the TUI adds its own implicit fifth "type your own answer".
            questions: [
              {
                question: 'Where should the redirect regression test live?',
                header: 'Test tier',
                multiSelect: false,
                options: [
                  {
                    label: 'Unit (vitest) (recommended)',
                    description: 'Fast, pure redirect-builder coverage; no browser needed.',
                    preview: 'tests/unit/loginRedirect.test.ts\nexpect(buildRedirect(path)).toContain("next=")',
                  },
                  { label: 'Component (RTL)', description: 'Covers the login form wiring too.' },
                  {
                    label: 'Both tiers',
                    description: 'Unit for the builder plus a component test for the form wiring.',
                  },
                  { label: 'E2E only', description: 'One Playwright run through the real login screen.' },
                ],
              },
            ],
          },
        },
      ],
    });
    raisePrompt(QUESTION_PROMPT_ID);
  }

  /** Cancel any running replay. Safe to call when none is running. */
  function stopTerminalPlayback(): void {
    terminalPlayback?.stop();
    terminalPlayback = null;
  }

  /**
   * Start (or restart) the recorded terminal replay for the streaming session.
   *
   * Restarted on every terminal-bearing subscribe rather than started once,
   * because the seed frame the subscriber just received is the state the
   * recording opens at. Leaving an older playback running would stream chunks
   * that assume a screen further along than the one the phone was just handed,
   * and the two would drift apart cell by cell.
   */
  function startTerminalPlayback(wantsTerminal: boolean): void {
    stopTerminalPlayback();
    if (!wantsTerminal) return;
    const capture = activeCapture();
    terminalPlayback = playRecordedTerminal(capture, (data) => {
      if (activeSessionId === null) return;
      emit({ kind: 'terminal', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { data } });
    });
  }

  // The agent-life simulator: the recorded terminal replays on its own timing;
  // every 12 ticks the transcript grows; at tick 20 a permission prompt raises;
  // 10 ticks after it is answered, an AskUserQuestion card raises.
  function startFeed(): void {
    if (feedTimer) return;
    feedTimer = setInterval(() => {
      if (!peer.isEstablished) return;
      feedTick += 1;
      // The codex and gemini sessions repaint their fullscreen TUIs every
      // other tick - live terminals for live agents, alongside their
      // structured transcripts.
      if (codexStreamSubscribed && feedTick % 2 === 0) {
        emit({
          kind: 'terminal',
          sessionId: MOCK_CODEX_SESSION_ID,
          taskId: MOCK_CODEX_TASK_ID,
          payload: { data: codexTuiFrame(feedTick / 2) },
        });
      }
      if (geminiStreamSubscribed && feedTick % 2 === 0) {
        emit({
          kind: 'terminal',
          sessionId: MOCK_GEMINI_SESSION_ID,
          taskId: MOCK_GEMINI_TASK_ID,
          payload: { data: geminiTuiFrame(feedTick / 2) },
        });
      }
      if (!streamSubscribed || activeSessionId === null) return;
      // PTY bytes are the only thing the terminal flag gates. Everything
      // below - usage, transcript growth, the permission prompt - is what a
      // list-only subscriber came for, and gating it on the terminal froze
      // the whole simulated agent whenever no session screen was open.
      // PTY bytes no longer ride this tick at all - the capture replays on its
      // own recorded timing, started by the read-stream subscribe below.
      if (feedTick % 5 === 0) {
        // Grows the board card's context bar over the session, like a real
        // one - not tied to any other cadence, just a steady drip.
        emitUsage();
      }
      // The mid-session resize to 100x28 that used to fire here is GONE, and it
      // cannot come back while the terminal replays a recording. Claude Code
      // reflows to its PTY, so a capture is only coherent at the grid it was
      // recorded at; announcing a different one leaves the phone rendering
      // 120-column bytes into a 100-column grid, which shreds every box border
      // in the frame. The phone's read-only adopt-resize path is still
      // exercised by scripts/stubDesktopPeer.mjs, which emits synthetic lines
      // and can therefore reshape freely.
      if (pendingTickResult !== null && feedTick >= pendingTickResult.dueTick) {
        appendTranscriptEntry({
          kind: 'tool_result',
          uuid: `${pendingTickResult.toolUseId}-result`,
          ts: Date.now(),
          toolUseId: pendingTickResult.toolUseId,
          content: pendingTickResult.content,
        });
        pendingTickResult = null;
      }
      if (feedTick % 12 === 0 && pendingPromptId === null && tickEntryCount < MOCK_MAX_TICK_ENTRIES) {
        tickEntryCount += 1;
        entryCounter += 1;
        // Varied realistic commands (real sessions never repeat one Bash
        // cell verbatim), mirroring the repo's actual verification loop.
        const tickInvocations = [
          { command: 'npm run typecheck', result: '> storefront-web@2.4.0 typecheck\n> tsc --noEmit' },
          { command: 'npm run lint', result: '> storefront-web@2.4.0 lint\n> eslint . --max-warnings 0' },
          {
            command: 'npx vitest run tests/unit',
            result: ' Test Files  38 passed (38)\n      Tests  305 passed (305)\n   Duration  2.72s',
          },
        ];
        const invocation = tickInvocations[entryCounter % tickInvocations.length];
        const toolUseId = `mock-tool-tick-${entryCounter}`;
        appendTranscriptEntry({
          kind: 'assistant',
          uuid: `mock-assistant-tick-${entryCounter}`,
          ts: Date.now(),
          agentName: 'Claude Code',
          model: MOCK_MODEL_SONNET.displayName,
          blocks: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'Bash',
              input: { command: invocation.command },
            },
          ],
        });
        pendingTickResult = { toolUseId, content: invocation.result, dueTick: feedTick + 3 };
      }
      if (feedTick === 20 && pendingPromptId === null && !questionRaised) {
        appendTranscriptEntry({
          kind: 'assistant',
          uuid: 'mock-assistant-permission',
          ts: Date.now(),
          agentName: 'Claude Code',
          model: MOCK_MODEL_SONNET.displayName,
          blocks: [{ type: 'tool_use', id: PERMISSION_TOOL_ID, name: 'Bash', input: { command: 'npx jest tests/components' } }],
        });
        raisePrompt(PERMISSION_PROMPT_ID);
      }
    }, 1000);
  }

  function ok(request: CapabilityRequestMessage, payload?: JsonValue): CapabilityResponseMessage {
    return { type: 'capability-response', requestId: request.requestId, ok: true, ...(payload === undefined ? {} : { payload }) };
  }

  function failWith(request: CapabilityRequestMessage, error: string): CapabilityResponseMessage {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error };
  }

  /**
   * Mirrors the desktop handler: a request that names a `view` gets no
   * backlog, 'sessions' gets only the session-bearing tasks plus whole-column
   * counts, and a request that names none gets the pre-0.9.0 payload.
   */
  function boardSnapshot(projectId: string, view: ReadBoardView | undefined): JsonValue {
    const isSecondProject = projectId === MOCK_PROJECT_2.id;
    const allTasks = isSecondProject ? [...tasks2] : [...tasks];
    const taskCountsByColumnId: Record<string, number> = {};
    for (const task of allTasks) {
      if (task.archived_at !== null) continue;
      taskCountsByColumnId[task.swimlane_id] = (taskCountsByColumnId[task.swimlane_id] ?? 0) + 1;
    }
    return {
      projectId: isSecondProject ? MOCK_PROJECT_2.id : MOCK_PROJECT.id,
      columns: isSecondProject ? mockColumns2() : mockColumns(),
      tasks: view === 'sessions' ? allTasks.filter((task) => task.session_id !== null) : allTasks,
      ...(view === undefined ? { backlog: [] } : {}),
      projectColor: isSecondProject ? MOCK_PROJECT_2.color : MOCK_PROJECT.color,
      // Exercises the desktop's "hide ticket numbers" layout setting - the
      // first project leaves it at the true default, the second turns it off.
      showTicketNumbers: !isSecondProject,
      ...(view !== undefined ? { view } : {}),
      ...(view === 'sessions' ? { taskCountsByColumnId } : {}),
    } as unknown as JsonValue;
  }

  /**
   * The Done column's rows, which live in neither board projection and so have
   * to be paged by their own `archived` action. Without this the mock answers
   * an archived read with an ordinary snapshot, verbClient rejects it as the
   * wrong shape, and mock mode shows a permanently empty Done column and an
   * unreachable completed-task screen.
   */
  function archivedPage(projectId: string, limit: number | undefined, offset: number | undefined): JsonValue {
    // Tasks the reviewer archived just now page ahead of the fixed fixtures,
    // newest first - the same order the desktop serves.
    const archivedTasks = [...(archivedDuringSession.get(projectId) ?? []), ...archivedTasksFor(projectId)];
    const pageOffset = offset ?? 0;
    const pageLimit = limit ?? ARCHIVED_MOCK_PAGE_SIZE;
    return {
      projectId,
      archivedTasks: archivedTasks.slice(pageOffset, pageOffset + pageLimit),
      archivedTotalCount: archivedTasks.length,
      // Only the session-bearing task carries a summary, so the screen's
      // no-summary branch stays reachable in mock mode too. Distinct numbers
      // per project for the same reason the rows differ: two completed-task
      // screens reporting identical cost and duration read as fixtures.
      summariesByTaskId: {
        [`${projectId}-archived-1`]:
          projectId === MOCK_PROJECT_2.id
            ? {
                sessionId: `${projectId}-archived-session-1`,
                totalCostUsd: 0.8712,
                totalInputTokens: 84_000,
                totalOutputTokens: 5_100,
                modelDisplayName: 'Fable 5',
                durationMs: 2_040_000,
                toolCallCount: 23,
                compactionCount: 0,
                linesAdded: 96,
                linesRemoved: 31,
                filesChanged: 3,
                taskCreatedAt: '2026-07-21T09:30:00.000Z',
                startedAt: '2026-07-22T15:00:00.000Z',
                exitedAt: '2026-07-22T15:34:00.000Z',
                exitCode: 0,
              }
            : {
                sessionId: `${projectId}-archived-session-1`,
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
      },
    } as unknown as JsonValue;
  }

  /** Board write verbs address tasks by id only; resolve which project owns one. */
  function locateTask(taskId: string | undefined): { task: BoardTaskWire; taskList: BoardTaskWire[]; projectId: string } | null {
    const inFirst = tasks.find((candidate) => candidate.id === taskId);
    if (inFirst) return { task: inFirst, taskList: tasks, projectId: MOCK_PROJECT.id };
    const inSecond = tasks2.find((candidate) => candidate.id === taskId);
    if (inSecond) return { task: inSecond, taskList: tasks2, projectId: MOCK_PROJECT_2.id };
    return null;
  }

  peer.setRequestHandler((request) => {
    switch (request.verb) {
      case 'read-board': {
        const payload = parseCapabilityRequestPayload('read-board', request.payload);
        if (!payload.projectId) return ok(request, { projects: [MOCK_PROJECT, MOCK_PROJECT_2] });
        if (payload.action === 'unsubscribe') return ok(request);
        if (payload.action === 'archived') return ok(request, archivedPage(payload.projectId, payload.limit, payload.offset));
        return ok(request, boardSnapshot(payload.projectId, payload.view));
      }
      case 'read-stream': {
        const payload = parseCapabilityRequestPayload('read-stream', request.payload);
        if (payload.action === 'unsubscribe') {
          if (payload.sessionId === MOCK_CODEX_SESSION_ID) codexStreamSubscribed = false;
          else if (payload.sessionId === MOCK_GEMINI_SESSION_ID) geminiStreamSubscribed = false;
          else if (!staticSessionStates.has(payload.sessionId)) {
            streamSubscribed = false;
            stopTerminalPlayback();
          }
          return ok(request);
        }
        // Mirrors the desktop: a list-only subscription (`terminal: false`)
        // attaches no PTY tap and returns an empty scrollback. Omitted means
        // true, per the protocol. Without this the mock streamed terminal
        // bytes to every subscriber and no dev run could ever show that a
        // caller had re-armed PTY streaming by accident.
        const wantsTerminal = payload.terminal ?? true;
        // The codex, opencode, gemini, idle, paused, and extra-thinking
        // sessions, all answered from the one registry: snapshot from the
        // spec, transcript from LIVE state (so a message sent into any of
        // them shows up and stays). The codex and gemini TERMINALS are the
        // registry overrides: their scrollbacks are the live fullscreen
        // TUIs, repainted by the tick.
        const staticState = staticSessionStates.get(payload.sessionId);
        if (staticState) {
          if (payload.action === 'transcript-window') {
            return ok(request, {
              revision: staticState.revision,
              totalEntries: staticState.transcript.length,
              startIndex: 0,
              entries: staticState.transcript,
            } as unknown as JsonValue);
          }
          // Assignment, not `= true`: a list-only re-subscribe (the
          // subscription manager re-subscribes rather than unsubscribing when
          // a session screen closes) must also DISARM the repaint, or the 1 Hz
          // feed keeps encrypting TUI frames for a session nobody is viewing.
          if (payload.sessionId === MOCK_CODEX_SESSION_ID) {
            codexStreamSubscribed = wantsTerminal;
            if (wantsTerminal) startFeed();
            const codexSnapshot: ReadStreamResponsePayload = {
              ...staticSessionSnapshot(staticState.spec, wantsTerminal),
              scrollback: wantsTerminal ? codexTuiFrame(0) : '',
            };
            return ok(request, codexSnapshot as unknown as JsonValue);
          }
          if (payload.sessionId === MOCK_GEMINI_SESSION_ID) {
            geminiStreamSubscribed = wantsTerminal;
            if (wantsTerminal) startFeed();
            const geminiSnapshot: ReadStreamResponsePayload = {
              ...staticSessionSnapshot(staticState.spec, wantsTerminal),
              scrollback: wantsTerminal ? geminiTuiFrame(0) : '',
            };
            return ok(request, geminiSnapshot as unknown as JsonValue);
          }
          return ok(request, staticSessionSnapshot(staticState.spec, wantsTerminal) as unknown as JsonValue);
        }
        if (activeSessionId === null || payload.sessionId !== activeSessionId) {
          return failWith(request, `No such session: ${payload.sessionId}`);
        }
        if (payload.action === 'transcript-window') {
          const end = Math.min(payload.beforeIndex ?? transcript.length, transcript.length);
          const start = Math.max(0, end - (payload.limit ?? 60));
          const window: TranscriptWindowResponsePayload = {
            revision: transcriptRevision,
            totalEntries: transcript.length,
            startIndex: start,
            entries: transcript.slice(start, end),
          };
          return ok(request, window as unknown as JsonValue);
        }
        streamSubscribed = true;
        startFeed();
        startTerminalPlayback(wantsTerminal);
        const snapshot: ReadStreamResponsePayload = {
          scrollback: wantsTerminal ? mockTerminalScrollback() : '',
          activity: pendingPromptId ? { state: 'permission', reason: { kind: 'permission' } } : { state: 'thinking', reason: { kind: 'turn-active' } },
          usage: mockUsage(streamingUsedTokens(feedTick), MOCK_MODEL_SONNET),
          awaitedPromptId: pendingPromptId,
          awaitedPromptOptions: pendingPromptId === PERMISSION_PROMPT_ID ? MOCK_PERMISSION_OPTIONS : null,
          ptyDimensions: { ...ptyDimensions },
        };
        return ok(request, snapshot as unknown as JsonValue);
      }
      case 'read-diff': {
        const payload = parseCapabilityRequestPayload('read-diff', request.payload);
        if (payload.action === 'unsubscribe') return ok(request);
        // Routed by the TASK, because a reviewer can open any of them. This
        // used to serve the streaming session's sign-in diff to every task,
        // so seven of eight Changes tabs contradicted their own session's
        // terminal and chat one swipe away.
        if (payload.taskId === MOCK_TASK_ID) {
          if (payload.filePath) return ok(request, diffFileContent(payload.filePath) as unknown as JsonValue);
          return ok(request, diffFileList() as unknown as JsonValue);
        }
        const sessionDiff = MOCK_STATIC_SESSIONS.find((candidate) => candidate.taskId === payload.taskId)?.diff ?? null;
        if (sessionDiff) {
          if (payload.filePath) {
            // The empty-content shape for a path outside the list, matching
            // diffFileContent's own fallthrough reasoning: visibly wrong
            // beats another file's changes under the requested name.
            return ok(request, (sessionDiff.contents[payload.filePath] ?? { original: '', modified: '', language: 'typescript' }) as unknown as JsonValue);
          }
          return ok(request, {
            files: sessionDiff.files,
            totalInsertions: sessionDiff.files.reduce((sum, file) => sum + file.insertions, 0),
            totalDeletions: sessionDiff.files.reduce((sum, file) => sum + file.deletions, 0),
          } as unknown as JsonValue);
        }
        // A task with no diff story (a card the reviewer just created): an
        // EMPTY list, never a borrowed one.
        return ok(request, { files: [], totalInsertions: 0, totalDeletions: 0 } as unknown as JsonValue);
      }
      case 'send-user-message': {
        const payload = parseCapabilityRequestPayload('send-user-message', request.payload);
        // Route by the session the composer actually sent into. Ignoring
        // payload.sessionId and appending to the active transcript - what this
        // handler did before the demo pairing shipped - made chat a dead end
        // in every session but the streaming one: the message went to a feed
        // the sender was not looking at.
        const staticChatState = staticSessionStates.get(payload.sessionId);
        if (staticChatState) {
          entryCounter += 1;
          appendStaticSessionEntry(staticChatState, { kind: 'user', uuid: `${payload.sessionId}-sent-${entryCounter}`, ts: Date.now(), text: payload.text });
          emitStaticSessionActivity(staticChatState.spec, 'thinking');
          const staticReplyCounter = entryCounter;
          later(2500, () => {
            appendStaticSessionEntry(staticChatState, {
              kind: 'assistant',
              uuid: `${payload.sessionId}-reply-${staticReplyCounter}`,
              ts: Date.now(),
              agentName: staticSessionAgentName(staticChatState.spec),
              model: staticChatState.spec.model.displayName,
              blocks: [{ type: 'text', text: staticChatState.spec.replyText }],
            });
            // An idle or paused session settles back to quiet after replying,
            // so its Agents-feed row does not stay "Thinking" forever.
            if (staticChatState.spec.activityState === 'idle') emitStaticSessionActivity(staticChatState.spec, 'idle');
          });
          return ok(request, { delivered: true });
        }
        if (activeSessionId === null || payload.sessionId !== activeSessionId) {
          return failWith(request, `No such session: ${payload.sessionId}`);
        }
        // Magic dev commands for exercising session-lifecycle paths that a
        // real desktop only hits on a model switch or process exit.
        if (payload.text.trim() === '/respawn') {
          respawnActiveSession();
          return ok(request, { delivered: true });
        }
        if (payload.text.trim() === '/end-session') {
          endActiveSession();
          return ok(request, { delivered: true });
        }
        entryCounter += 1;
        appendTranscriptEntry({ kind: 'user', uuid: `mock-user-sent-${entryCounter}`, ts: Date.now(), text: payload.text });
        emitActivity('thinking');
        const replyCounter = entryCounter;
        later(2500, () => {
          appendTranscriptEntry({
            kind: 'assistant',
            uuid: `mock-assistant-reply-${replyCounter}`,
            ts: Date.now(),
            // Without these the badge falls back to a bare "Agent" and the
            // model caption disappears, so sending a message in mock mode
            // visibly changed the turn header mid-session.
            agentName: 'Claude Code',
            model: MOCK_MODEL_SONNET.displayName,
            blocks: [{ type: 'text', text: 'Got it - folding that into the fix.' }],
          });
        });
        return ok(request, { delivered: true });
      }
      case 'move-task': {
        const payload = parseCapabilityRequestPayload('move-task', request.payload);
        const located = locateTask(payload.taskId);
        if (!located) return failWith(request, `No such task: ${payload.taskId}`);
        // A move into the done-role column IS the archive (the phone's
        // archiveTask and the desktop's cross-column move handler both work
        // this way). Mirror the desktop's semantics: the task leaves the board
        // projection and joins the archived page, so the card lands in the
        // Done column instead of vanishing from every screen at once.
        const targetColumns = located.projectId === MOCK_PROJECT_2.id ? mockColumns2() : mockColumns();
        const targetColumn = targetColumns.find((candidate) => candidate.id === payload.targetSwimlaneId);
        if (isDoneRole(targetColumn?.role ?? null)) {
          const taskIndex = located.taskList.findIndex((candidate) => candidate.id === located.task.id);
          if (taskIndex >= 0) located.taskList.splice(taskIndex, 1);
          located.task.swimlane_id = payload.targetSwimlaneId;
          located.task.archived_at = new Date().toISOString();
          located.task.updated_at = located.task.archived_at;
          const archivedList = archivedDuringSession.get(located.projectId) ?? [];
          archivedList.unshift(located.task);
          archivedDuringSession.set(located.projectId, archivedList);
        } else {
          located.task.swimlane_id = payload.targetSwimlaneId;
          located.task.position = payload.targetPosition;
          located.task.updated_at = new Date().toISOString();
        }
        later(50, () => {
          emit({ kind: 'board', projectId: located.projectId, taskId: located.task.id, payload: { change: 'task-updated', ids: [located.task.id] } });
        });
        return ok(request, { ok: true });
      }
      case 'answer-permission-prompt': {
        const payload = parseCapabilityRequestPayload('answer-permission-prompt', request.payload);
        if (pendingPromptId === null || payload.promptId !== pendingPromptId) {
          return failWith(request, 'promptId does not match the currently outstanding prompt (stale or already answered)');
        }
        const answeredPromptId = pendingPromptId;
        clearPrompt(answeredPromptId);
        // The real agent always follows an answered prompt with the awaited
        // tool's result (or a rejection notice); without it the tool_use
        // cell stays pending forever once the card clears.
        if (answeredPromptId === PERMISSION_PROMPT_ID) {
          const denied = payload.keystrokes.startsWith('\u001b');
          later(600, () => {
            appendTranscriptEntry({
              kind: 'tool_result',
              uuid: 'mock-result-permission',
              ts: Date.now(),
              toolUseId: PERMISSION_TOOL_ID,
              content: denied
                ? "The user doesn't want to proceed with this tool use."
                : 'Test Suites: 41 passed, 41 total\nTests:       244 passed, 244 total\nTime:        27.1 s',
            });
          });
        }
        if (answeredPromptId === QUESTION_PROMPT_ID) {
          const selectedDigit = payload.keystrokes.replace(/[^1-9]/g, '').slice(0, 1) || '1';
          later(600, () => {
            appendTranscriptEntry({
              kind: 'tool_result',
              uuid: 'mock-result-question',
              ts: Date.now(),
              toolUseId: QUESTION_TOOL_ID,
              content: `User selected option ${selectedDigit}.`,
            });
          });
        }
        if (answeredPromptId === PERMISSION_PROMPT_ID && !questionRaised) {
          later(10_000, () => {
            if (pendingPromptId === null) raiseQuestionPrompt();
          });
        }
        return ok(request, { answered: true });
      }
      case 'interactive-terminal': {
        const payload = parseCapabilityRequestPayload('interactive-terminal', request.payload);
        // Mirrors the desktop's action union: resize holds the grid until
        // release-size restores the grid the active capture was recorded at
        // (activeGrid()). There is no fixed desktop-default any more - the
        // capture is the only source of a grid this mock reports.
        if (payload.action === 'resize') {
          const colsChanged = payload.dimensions.cols !== ptyDimensions.cols;
          ptyDimensions = { cols: payload.dimensions.cols, rows: payload.dimensions.rows };
          emitPtyResize();
          return ok(request, { resized: true, colsChanged });
        }
        if (payload.action === 'release-size') {
          ptyDimensions = activeGrid();
          emitPtyResize();
          return ok(request, { released: true });
        }
        // Echo into the session the keystrokes were TYPED IN, not blindly into
        // the active one. The pre-demo version emitted to activeSessionId for
        // every write, so typing in any other session's terminal returned
        // `written: true` while the echo landed in a feed the typist could not
        // see - a keyboard that looks simply dead, on the screen App Review is
        // told to try.
        const terminalTarget =
          payload.sessionId === activeSessionId && activeSessionId !== null
            ? { sessionId: activeSessionId, taskId: MOCK_TASK_ID }
            : (() => {
                const targetState = staticSessionStates.get(payload.sessionId);
                return targetState ? { sessionId: targetState.spec.sessionId, taskId: targetState.spec.taskId } : null;
              })();
        if (!terminalTarget) return failWith(request, `No such session: ${payload.sessionId}`);
        emit({
          kind: 'terminal',
          sessionId: terminalTarget.sessionId,
          taskId: terminalTarget.taskId,
          payload: { data: payload.data.replace(/\r/g, '\r\n') },
        });
        return ok(request, { written: true });
      }
      case 'board-tool-read': {
        const payload = parseCapabilityRequestPayload('board-tool-read', request.payload);
        return ok(request, { result: { note: `${payload.tool} completed.` } });
      }
      case 'board-tool-write': {
        const payload = parseCapabilityRequestPayload('board-tool-write', request.payload);
        // Every branch resolves WHICH project's board it is writing, because
        // the app has two. The pre-demo version hardcoded the first: editing
        // or deleting a checkout-api task failed "No such task", and a task
        // created while browsing checkout-api landed on the other board.
        if (payload.tool === 'create_task') {
          const params = (payload.params ?? {}) as { project?: string; title?: string; description?: string; column?: string };
          const isSecondProject = params.project === MOCK_PROJECT_2.id;
          const projectTasks = isSecondProject ? tasks2 : tasks;
          const projectColumns = isSecondProject ? mockColumns2() : mockColumns();
          const column = projectColumns.find((candidate) => candidate.name.toLowerCase() === params.column?.toLowerCase()) ?? projectColumns[0];
          entryCounter += 1;
          const created = boardTaskFixture({
            id: `mock-created-${entryCounter}`,
            display_id: 100 + entryCounter,
            title: params.title ?? 'Untitled task',
            description: params.description ?? '',
            swimlane_id: column.id,
            position: projectTasks.filter((candidate) => candidate.swimlane_id === column.id).length,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          projectTasks.push(created);
          const createdProjectId = isSecondProject ? MOCK_PROJECT_2.id : MOCK_PROJECT.id;
          later(50, () => {
            emit({ kind: 'board', projectId: createdProjectId, taskId: created.id, payload: { change: 'task-created', ids: [created.id] } });
          });
          return ok(request, { result: { created: created.id } });
        }
        if (payload.tool === 'update_task') {
          const params = (payload.params ?? {}) as { taskId?: string; title?: string; description?: string };
          const located = locateTask(params.taskId);
          if (!located) return failWith(request, `No such task: ${params.taskId}`);
          if (typeof params.title === 'string') located.task.title = params.title;
          if (typeof params.description === 'string') located.task.description = params.description;
          located.task.updated_at = new Date().toISOString();
          later(50, () => {
            emit({ kind: 'board', projectId: located.projectId, taskId: located.task.id, payload: { change: 'task-updated', ids: [located.task.id] } });
          });
          return ok(request, { result: { updated: located.task.id } });
        }
        if (payload.tool === 'delete_task') {
          const params = (payload.params ?? {}) as { taskId?: string };
          const located = locateTask(params.taskId);
          if (!located) return failWith(request, `No such task: ${params.taskId}`);
          const taskIndex = located.taskList.findIndex((candidate) => candidate.id === located.task.id);
          const [removed] = located.taskList.splice(taskIndex, 1);
          if (removed.session_id !== null && removed.session_id === activeSessionId) endActiveSession();
          later(50, () => {
            emit({ kind: 'board', projectId: located.projectId, taskId: removed.id, payload: { change: 'task-deleted', ids: [removed.id] } });
          });
          return ok(request, { result: { deleted: removed.id } });
        }
        return ok(request, { result: { note: `${payload.tool} completed.` } });
      }
      case 'register-push': {
        // Nothing to deliver to - there is no push infrastructure behind the
        // in-process peer - but the request must SUCCEED: registration fires
        // on every established handshake, and in a release build a failure
        // here surfaces in Settings as a push-registration error on a screen
        // App Review will read. Acknowledging is also honest: the desktop's
        // answer means "registration recorded", not "a push was proven".
        const payload = parseCapabilityRequestPayload('register-push', request.payload);
        return ok(request, { registered: payload.action === 'register' });
      }
      default:
        return failWith(request, `Mock desktop has no handler for ${request.verb}`);
    }
  });

  return {
    identity,
    desktopStaticPublicKey: desktopStatic.publicKey,
    phoneTransport,
    async start(): Promise<void> {
      await desktopTransport.connect();
      peer.beginHandshake();
    },
    dispose(): void {
      if (feedTimer) clearInterval(feedTimer);
      feedTimer = null;
      stopTerminalPlayback();
      for (const timer of oneShotTimers) clearTimeout(timer);
      oneShotTimers.clear();
      peer.dispose();
      desktopTransport.close();
    },
  };
}
