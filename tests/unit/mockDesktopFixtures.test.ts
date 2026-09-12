/**
 * Covers the mock desktop's FIXTURE CONTENT, not its wire behaviour.
 *
 * These fixtures are the source for every committed store screenshot
 * (scripts/storeScreenshots.mjs, .maestro/screenshots/store-capture.yaml), so
 * they are published to the App Store, to Play, and to a public repo, captioned
 * as a customer using the product. That makes their text a product claim rather
 * than test data, and it is the one part of this repo where being wrong is
 * invisible to every other check: a frame with the wrong words in it is still
 * the right pixel size, still named correctly, and still verifies.
 *
 * Two things went wrong before these tests existed, both caught only by a human
 * looking at a PNG:
 *
 *  1. Cards describing KANGENTIC'S OWN backlog shipped as the fictional
 *     customer's work - the register-push capability migration, the relay
 *     self-host guide, the terminal font-fit heuristic, and a flaky pairing
 *     flow whose body text read "the QR-scan step races the relay handshake".
 *  2. The terminal frame and the changes frame described DIFFERENT work: the
 *     terminal edited `src/router/index.ts`, which appears in no diff the
 *     Changes lens lists, and reported line counts that did not add up to what
 *     the file list claimed for the file it did edit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BoardTaskWire } from '@kangentic/protocol';

import { PR_READINESS_VERDICTS } from '@/components/board/prChipPresentation';
import {
  MOCK_CONTEXT_WINDOW_FOR_TEST,
  MOCK_CODEX_SESSION_DIFF,
  MOCK_CODEX_STATIC_SESSION,
  MOCK_EXTRA_THINKING_SESSIONS,
  MOCK_GEMINI_STATIC_SESSION,
  MOCK_OPENCODE_STATIC_SESSION,
  MOCK_STATIC_SESSIONS,
  MOCK_STREAM_CEILING_FOR_TEST,
  activeCapture,
  activeGrid,
  archivedTasksFor,
  baseTranscriptForTest,
  codexTuiFrameForTest,
  diffFileContent,
  diffFileList,
  geminiTuiFrameForTest,
  initialTasks,
  initialTasks2,
  streamingUsedTokens,
} from '@/connection/mockDesktop';
import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import { stripAnsiPreservingLayout } from '@/terminal/liveTail';
import { renderCaptureAllRows, renderCaptureRows } from '../helpers/renderCapture';

/**
 * The terminal fixture is now a RECORDED capture of real Claude Code output,
 * so nothing about it can be read off a source array any more. Everything below
 * renders it through a headless xterm at its own grid and asserts on the cells
 * the user would actually see - which is also the only way to be sure, because
 * a TUI's bytes and its screen are not the same thing.
 */
let shotsRows: string[] = [];
/** Every row the capture shows at ANY point, not just on its closing frame. */
let shotsEveryRow: string[] = [];

beforeAll(async () => {
  shotsRows = await renderCaptureRows(CLAUDE_CAPTURE_SHOTS);
  shotsEveryRow = await renderCaptureAllRows(CLAUDE_CAPTURE_SHOTS);
});

/**
 * Vocabulary that only Kangentic's own engineering would use.
 *
 * Deliberately the product's domain nouns rather than a list of the specific
 * sentences that leaked: re-listing those would pass the moment someone writes
 * a NEW card about our own work, which is the actual failure mode.
 */
const KANGENTIC_DOMAIN_TERMS = [
  'relay',
  'pairing',
  'paired',
  'noise',
  'maestro',
  'expo',
  'react native',
  'capability',
  'register-push',
  'push token',
  'push-notification',
  'pty',
  'scrollback',
  'sas',
  'qr',
  // The product's own NAME. scripts/buildTerminalFixture.mjs bans it at
  // capture-build time and its comment says that list is "kept in step" with
  // this one, but this list never carried it - so the single most obvious
  // giveaway in a fixture published to the App Store was the one word the
  // review-time half of the guard did not look for.
  'kangentic',
  // Words that admit the fixture is a fixture. Not Kangentic domain nouns like
  // the rest, but the same failure: "Shipped: the completed mock task" sat on
  // the Done column for months because nothing collected that surface, and
  // since the reviewer/demo pairing shipped that column is one navigation from
  // where an App Store reviewer lands.
  //
  // Kept to these two. 'fixture', 'placeholder' and 'lorem' were tried and
  // reverted: the customer's own prose already says "benchmarking against the
  // 10k-row fixture", which is ordinary engineering English and exactly the
  // kind of true sentence a fictional customer should be able to write. A guard
  // that fires on real copy gets weakened or deleted, so it bans only the words
  // that can only ever mean "this content is not real".
  'mock',
  'demo',
];

/**
 * Prose-bearing keys, harvested recursively from a fixture value.
 *
 * A recursive walk rather than a hand-written traversal of the transcript union
 * because `TranscriptEntryWire` is a wide protocol type whose members carry
 * prose at different depths (assistant blocks, thinking blocks, tool results,
 * system notices), and an enumeration would silently stop covering a member the
 * day the package adds one. Restricted to prose KEYS rather than collecting
 * every string, because ids like `mock-session-1` are not rendered anywhere and
 * would make a ban on the word "mock" fire on scaffolding instead of on copy.
 */
const PROSE_KEYS = new Set(['text', 'title', 'description', 'content', 'note', 'summary', 'label', 'message']);

function collectProse(value: unknown, label: string, into: { label: string; text: string }[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProse(item, label, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string') {
      if (PROSE_KEYS.has(key)) into.push({ label: `${label}.${key}`, text: nested });
      continue;
    }
    collectProse(nested, `${label}.${key}`, into);
  }
}

/** Every string these fixtures put on screen. */
function renderedFixtureText(): { label: string; text: string }[] {
  const collected: { label: string; text: string }[] = [];
  // The whole chat lens. Previously uncollected, which meant every string in
  // the published 03-session-chat shelf was unguarded.
  collectProse(baseTranscriptForTest(), 'transcript', collected);
  // The Done columns and the completed-task screens behind them. Both real
  // project ids, because the two projects carry DISTINCT archived rows now -
  // the previous 'project-1' placeholder only ever exercised the default
  // branch.
  collectProse(archivedTasksFor('mock-project'), 'archived', collected);
  collectProse(archivedTasksFor('mock-project-relay'), 'archived relay', collected);
  for (const task of [...initialTasks(), ...initialTasks2()]) {
    collected.push({ label: `task ${task.id} title`, text: task.title });
    if (task.description) collected.push({ label: `task ${task.id} description`, text: task.description });
    if (task.branch_name) collected.push({ label: `task ${task.id} branch`, text: task.branch_name });
    for (const label of task.labels ?? []) collected.push({ label: `task ${task.id} label`, text: label });
  }
  for (const spec of MOCK_EXTRA_THINKING_SESSIONS) {
    collected.push({ label: `${spec.sessionId} title`, text: spec.title });
  }
  // Every static session's full surface: transcript seed, the canned chat
  // reply, and the terminal seed - all of which render since the demo pairing
  // made these screens reachable by App Review, and none of which the guard
  // collected while they were dev-only.
  for (const spec of MOCK_STATIC_SESSIONS) {
    collected.push({ label: `${spec.sessionId} user`, text: spec.userText });
    collected.push({ label: `${spec.sessionId} assistant`, text: spec.assistantText });
    collected.push({ label: `${spec.sessionId} reply`, text: spec.replyText });
    collected.push({ label: `${spec.sessionId} terminal seed`, text: spec.scrollback });
    if (spec.thinkingText) collected.push({ label: `${spec.sessionId} thinking`, text: spec.thinkingText });
    if (spec.closingText) collected.push({ label: `${spec.sessionId} closing`, text: spec.closingText });
    for (const toolCell of spec.toolCells ?? []) {
      // Inputs render on the tool card (a Write's content in full), results on
      // the result card - both are screen text, both get checked.
      collected.push({ label: `${spec.sessionId} tool input`, text: JSON.stringify(toolCell.input) });
      collected.push({ label: `${spec.sessionId} tool result`, text: toolCell.result });
    }
    // The later turns render the same four surfaces the opening one does.
    for (const [turnIndex, turn] of (spec.followUps ?? []).entries()) {
      const turnLabel = `${spec.sessionId} follow-up ${turnIndex + 2}`;
      collected.push({ label: `${turnLabel} user`, text: turn.userText });
      if (turn.thinkingText) collected.push({ label: `${turnLabel} thinking`, text: turn.thinkingText });
      if (turn.assistantText) collected.push({ label: `${turnLabel} assistant`, text: turn.assistantText });
      if (turn.closingText) collected.push({ label: `${turnLabel} closing`, text: turn.closingText });
      for (const toolCell of turn.toolCells ?? []) {
        collected.push({ label: `${turnLabel} tool input`, text: JSON.stringify(toolCell.input) });
        collected.push({ label: `${turnLabel} tool result`, text: toolCell.result });
      }
    }
    for (const file of spec.diff?.files ?? []) {
      collected.push({ label: `${spec.sessionId} diff path`, text: file.path });
    }
    for (const [diffPath, content] of Object.entries(spec.diff?.contents ?? {})) {
      collected.push({ label: `${spec.sessionId} diff ${diffPath}`, text: `${content.original}\n${content.modified}` });
    }
  }
  // The codex and gemini TUI frames are those sessions' live terminals.
  // Both alternating paints of each, since status lines differ.
  for (const paintTick of [0, 1]) {
    for (const row of codexTuiFrameForTest(paintTick).split('\r\n')) {
      collected.push({ label: `codex frame tick ${paintTick}`, text: row });
    }
    for (const row of geminiTuiFrameForTest(paintTick).split('\r\n')) {
      collected.push({ label: `gemini frame tick ${paintTick}`, text: row });
    }
  }
  // The codex session's Changes lens, which is not a static-session spec.
  for (const file of MOCK_CODEX_SESSION_DIFF.files) {
    collected.push({ label: 'codex diff path', text: file.path });
  }
  for (const [diffPath, content] of Object.entries(MOCK_CODEX_SESSION_DIFF.contents)) {
    collected.push({ label: `codex diff ${diffPath}`, text: `${content.original}\n${content.modified}` });
  }
  // The recorded terminal, as RENDERED. Both captures are checked, not just the
  // one the store capture uses: `dev:mock` is what gets demoed live, and a leak
  // there is a leak in front of whoever is watching.
  for (const row of shotsEveryRow) {
    collected.push({ label: 'terminal row', text: row });
  }
  return collected;
}

describe('the mock fixtures stay inside the customer fiction', () => {
  it('collects a non-trivial amount of text to check', () => {
    // Non-vacuity guard: every assertion below passes trivially against an
    // empty list, so a refactor that stopped collecting would read as a pass.
    const collected = renderedFixtureText();
    expect(collected.length).toBeGreaterThan(30);
    expect(collected.some((entry) => entry.text.includes('sign-in redirect'))).toBe(true);
    // Each surface named individually, because "more than 30 strings" stayed
    // true the whole time the transcript and the Done column were collected by
    // nothing at all. A count cannot tell you WHICH screen went unguarded.
    expect(collected.some((entry) => entry.label.startsWith('transcript.'))).toBe(true);
    expect(collected.some((entry) => entry.label.startsWith('archived.'))).toBe(true);
    expect(collected.some((entry) => entry.text === 'Cache the product-grid query on the storefront home')).toBe(true);
  });

  it.each(KANGENTIC_DOMAIN_TERMS)('never says "%s" in anything it renders', (term) => {
    // Whole words only. A plain substring match reads "exposes" as "expo" and
    // "sassy" as "sas", and a check that cries wolf gets deleted.
    const wordPattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const offenders = renderedFixtureText()
      .filter((entry) => wordPattern.test(entry.text))
      .map((entry) => `${entry.label}: ${entry.text}`);
    expect(offenders).toEqual([]);
  });
});

/**
 * The mock board's PR-bearing cards are curated, per the comments beside them
 * in `initialTasks()`, to demonstrate the full set of readiness outcomes a
 * reviewer or a store screenshot can land on: every recognised verdict, a
 * value this client does not recognise (degrading to plain open), and a
 * stale verdict surviving on a PR that is no longer open. Nothing else in
 * the repo renders these fixtures through the board, so a retune that drops
 * one of those cases - the same way `pr_merge_readiness` itself could be
 * dropped in a merge - is invisible to every other check.
 *
 * Deliberately NOT pinned to which task id carries which verdict: these
 * cards get retuned for design review and the store shelves, so a copy of
 * today's assignment would just be a change-detector. What has to survive a
 * retune is the set of scenarios, so that is what is asserted, mirroring
 * `prChipPresentation.test.ts`'s own `PR_READINESS_VERDICTS` iteration - a
 * verdict added to that table fails HERE until the mock board actually shows
 * it, rather than waiting on a hand-updated list that would not know to
 * extend itself.
 */
describe('the mock board demonstrates every PR readiness verdict', () => {
  function prBearingTasks(): BoardTaskWire[] {
    return [...initialTasks(), ...initialTasks2()].filter((task) => task.pr_state !== null);
  }

  it('carries enough PR-bearing fixtures to demonstrate every scenario below', () => {
    // Not a non-vacuity guard - the `.some(...)` assertions below are already
    // false, not vacuously true, against an empty list. This is a real lower
    // bound: every recognised verdict needs its own open-PR card, plus one
    // unrecognised value and one stale verdict on a non-open PR, so the board
    // cannot satisfy every case below with fewer cards than that. Failing
    // here gives one readable message instead of the same shortfall reported
    // once per missing verdict.
    expect(prBearingTasks().length).toBeGreaterThanOrEqual(PR_READINESS_VERDICTS.length + 2);
  });

  it.each(PR_READINESS_VERDICTS)(
    'demonstrates the %s verdict on an open PR somewhere on the mock board',
    (verdict) => {
      const demonstrated = prBearingTasks().some(
        (task) => task.pr_state === 'open' && task.pr_merge_readiness === verdict,
      );
      expect(demonstrated).toBe(true);
    },
  );

  it('demonstrates a value this client does not recognise, so the bare-glyph degrade path is actually on screen', () => {
    const demonstrated = prBearingTasks().some(
      (task) =>
        task.pr_state === 'open' &&
        task.pr_merge_readiness !== null &&
        !PR_READINESS_VERDICTS.includes(task.pr_merge_readiness),
    );
    expect(demonstrated).toBe(true);
  });

  it('demonstrates a stale verdict surviving on a non-open PR, so the open-only guard has something to prove', () => {
    // If the merged card's stale `ready` ever gets "tidied up" to null, the
    // board silently stops demonstrating that readiness is ignored outside
    // the open branch, and nothing else here would notice.
    const demonstrated = prBearingTasks().some(
      (task) =>
        task.pr_state !== 'open' &&
        task.pr_merge_readiness !== null &&
        PR_READINESS_VERDICTS.includes(task.pr_merge_readiness),
    );
    expect(demonstrated).toBe(true);
  });
});

/**
 * scripts/buildTerminalFixture.mjs runs its OWN copy of this guard at
 * capture-build time (BANNED_TERMS), on the raw capture bytes rather than the
 * rendered fixture text this file checks. Its header says the two lists are
 * "kept in step" - but that was only ever a promise: nothing compared them,
 * and 'kangentic' itself was the one term that drifted, present in the
 * build-time list and missing from KANGENTIC_DOMAIN_TERMS above until it was
 * added a few lines up. Only re-adding it here closed THAT gap; nothing stops
 * the next one opening the same way, in either direction.
 *
 * This does not import buildTerminalFixture.mjs - its top level unconditionally
 * calls parseArgs (which exits the process without --capture) and, once past
 * that, writeFileSync, so importing it as a module is unsafe. Structural
 * source-text extraction instead, same approach as syncBranding.test.ts uses
 * for the same reason.
 */
describe('the two banned-vocabulary lists stay in step', () => {
  const buildScriptSource = readFileSync(
    join(__dirname, '..', '..', 'scripts', 'buildTerminalFixture.mjs'),
    'utf8',
  );

  function buildScriptBannedTerms(): string[] {
    const block = /const BANNED_TERMS = \[([^\]]*)\]/.exec(buildScriptSource);
    if (block === null) return [];
    return [...block[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  }

  it('finds a non-trivial BANNED_TERMS list at all', () => {
    // Non-vacuity guard: an empty extraction would make the equality check
    // below pass only when KANGENTIC_DOMAIN_TERMS is ALSO empty, which it
    // never is - but a regex that stopped matching for an unrelated reason
    // (the const renamed, the array reformatted) should fail loudly here
    // rather than silently validating nothing.
    expect(buildScriptBannedTerms().length).toBeGreaterThan(10);
  });

  it('bans exactly the same words the rendered-fixture check does', () => {
    // Set equality, both directions: a term added to one list and not the
    // other is exactly the drift that shipped 'kangentic' to a store listing
    // once already.
    expect([...buildScriptBannedTerms()].sort()).toEqual([...KANGENTIC_DOMAIN_TERMS].sort());
  });
});

describe('the terminal frame and the changes frame describe one piece of work', () => {
  /**
   * Files the recorded session is seen touching, from its `● Edit(path)` /
   * `● Update(path)` / `● Write(path)` tool bullets.
   *
   * Real Claude Code prints the path with the platform separator, so this
   * normalizes backslashes; the wire paths in diffFileList are POSIX.
   */
  function editedPathsIn(rows: string[]): string[] {
    return rows.flatMap((row) => {
      const match = /[●⏺]\s*(?:Edit|Update|Write)\(([^)]+)\)/.exec(row);
      return match ? [match[1].replace(/\\/g, '/')] : [];
    });
  }

  it('shows the agent editing files, so the check below is not vacuous', () => {
    expect(editedPathsIn(shotsEveryRow).length).toBeGreaterThan(0);
  });

  it('only edits files the Changes lens actually lists', () => {
    // Both frames ship in the same listing, one swipe apart, and a reviewer
    // comparing them is exactly what a screenshot invites. This used to fail
    // in the other direction: the terminal edited a file that appeared in no
    // diff the Changes lens listed.
    const listedPaths = diffFileList().files.map((file) => file.path);
    for (const editedPath of editedPathsIn(shotsEveryRow)) {
      expect(listedPaths).toContain(editedPath);
    }
  });

  it('lists exactly the files the recorded session changed', () => {
    // diffFileList is transcribed from the same session's `git diff --numstat`,
    // so a re-record that forgets to regenerate it shows up here.
    expect(diffFileList().files.map((file) => file.path)).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts',
      'src/components/SignInForm.tsx',
      'src/routes/checkout.tsx',
    ]);
    expect(diffFileList().files.map((file) => [file.insertions, file.deletions])).toEqual([
      [2, 2],
      [10, 2],
      [3, 3],
      [3, 1],
    ]);
  });

  it('totals its own per-file counts', () => {
    const files = diffFileList().files;
    const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    expect(insertions).toBe(diffFileList().totalInsertions);
    expect(deletions).toBe(diffFileList().totalDeletions);
  });
});

/**
 * The THIRD pairing, and the one nothing pinned until now.
 *
 * The terminal-versus-changes checks above exist because those two frames
 * disagreed once. The chat lens is the same hazard with a wider blast radius:
 * `ToolCallCard` renders an Edit's `new_string` and the first 20 lines of a
 * Write's `content` verbatim, so the chat frame puts the edited file on screen
 * in full, one swipe from the Changes frame showing the same file. Both ship in
 * the same store listing.
 *
 * Both directions of this were broken when the check was written: the Edit
 * declared `loginRedirect(path?: string)` where the diff had `path: string`,
 * and the Write named `DEFAULT_DESTINATION` / `isSafeReturnPath` where the diff
 * named `DEFAULT_AFTER_SIGN_IN` / `isInternalPath` - a helper the chat frame
 * called and the diff frame never defined.
 *
 * `diffFileContent` is the anchor, not the transcript: it is transcribed from
 * the recorded session's own `git diff`, and its per-file line counts are
 * checked against `diffFileList` above.
 */
describe('the chat frame and the changes frame describe one edit', () => {
  /** The fictional workspace every tool input is rooted at. */
  const WORKSPACE_ROOT = 'C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\';

  interface FileWritingToolCall {
    readonly uuid: string;
    readonly toolName: string;
    readonly wirePath: string;
    readonly input: Record<string, unknown>;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Every Edit/Write in the transcript, with its absolute path reduced to the wire path. */
  function fileWritingToolCalls(): FileWritingToolCall[] {
    const collected: FileWritingToolCall[] = [];
    for (const entry of baseTranscriptForTest()) {
      if (entry.kind !== 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'Edit' && block.name !== 'Write') continue;
        if (!isRecord(block.input) || typeof block.input.file_path !== 'string') continue;
        collected.push({
          uuid: entry.uuid,
          toolName: block.name,
          wirePath: block.input.file_path.replace(WORKSPACE_ROOT, '').replace(/\\/g, '/'),
          input: block.input,
        });
      }
    }
    return collected;
  }

  it('finds the transcript file-writing calls at all', () => {
    // Non-vacuity guard: every assertion below passes trivially against an
    // empty list, so a transcript that stopped editing files would read as
    // success. Pinned to the exact paths, because a new Edit that no diff
    // backs should fail HERE with a readable message.
    expect(fileWritingToolCalls().map((call) => `${call.toolName} ${call.wirePath}`)).toEqual([
      'Edit src/auth/login.ts',
      'Write src/auth/session.ts',
    ]);
  });

  it('only writes files the Changes lens lists', () => {
    const listedPaths = diffFileList().files.map((file) => file.path);
    for (const call of fileWritingToolCalls()) {
      expect(listedPaths).toContain(call.wirePath);
    }
  });

  it('shows the same AFTER text as the diff frame shows for that file', () => {
    // ASYMMETRIC on purpose, and worth stating so nobody reads more into a
    // green run than it earns. The Edit's `new_string` is a hand-authored
    // literal, so this genuinely cross-checks it. The Write's `content` READS
    // `diffFileContent`, so for that entry the comparison is X.includes(X) and
    // cannot fail - the guarantee there is the derivation in the source, which
    // is stronger than any assertion here. What this still catches is someone
    // re-inlining that literal later, which is exactly how it drifted before.
    const mismatched = fileWritingToolCalls().flatMap((call) => {
      const afterText = call.toolName === 'Write' ? call.input.content : call.input.new_string;
      if (typeof afterText !== 'string') {
        return [`${call.uuid}: ${call.toolName} carries no after text`];
      }
      // `includes` rather than equality: an Edit's new_string is one hunk of
      // the file, a Write's content is the whole of it, and both have to be
      // findable verbatim in what the Changes lens renders.
      return diffFileContent(call.wirePath).modified.includes(afterText)
        ? []
        : [`${call.uuid} (${call.toolName} ${call.wirePath}) is not in the diff's modified text:\n${afterText}`];
    });
    // Named individually: a bare count tells whoever broke it nothing, and the
    // disagreement is invisible in every other check.
    expect(mismatched).toEqual([]);
  });

  it('shows the same BEFORE text as the diff frame shows for that file', () => {
    const mismatched = fileWritingToolCalls().flatMap((call) => {
      if (call.toolName !== 'Edit') return [];
      const beforeText = call.input.old_string;
      if (typeof beforeText !== 'string') return [`${call.uuid}: Edit carries no old_string`];
      return diffFileContent(call.wirePath).original.includes(beforeText)
        ? []
        : [`${call.uuid} (${call.wirePath}) is not in the diff's original text:\n${beforeText}`];
    });
    expect(mismatched).toEqual([]);
  });
});

describe('the recorded terminal is real Claude Code, not an authored script', () => {
  it('renders the chrome the app spends its effort handling', () => {
    // The previous fixture was 20 hand-written "> Reading src/auth/login.ts"
    // lines, which exercised none of this - so the terminal lens, the live-tail
    // cleaner and the store screenshots all previewed against chrome that no
    // agent has ever emitted. Each of these is a distinct thing the app parses.
    // Read across every frame of the replay rather than the closing one, so a
    // future re-record that streams (today's capture is a single settled frame)
    // is still measured on everything that scrolls past.
    const session = shotsEveryRow.join('\n');
    expect(session).toMatch(/[●⏺]/); // tool bullets
    expect(session).toMatch(/[╌─]{8}/); // the rules a dialog frames itself with
    expect(session).toMatch(/Do you want to/); // a live permission dialog
    expect(session).toMatch(/❯\s*1\.\s*Yes/); // its numbered options
    expect(session).toMatch(/Esc to cancel · Tab to amend/); // the dialog footer
    // Deliberately NOT asserting every glyph the cleaner knows about. Which
    // chrome is on screen depends on where the replay window sits, and pinning
    // the full vocabulary here made this test a restatement of the window
    // rather than a check that the fixture is real output. The classifier's own
    // coverage of the rest lives in liveTail.test.ts.
  });

  it('closes every frame inside the grid it was recorded at', () => {
    // A row wider than the grid means the capture and the reported dimensions
    // disagree, which renders as borders sliced mid-glyph on the phone.
    for (const row of shotsRows) expect([...row].length).toBeLessThanOrEqual(CLAUDE_CAPTURE_SHOTS.cols);
  });

  it('ends on the approval request the chat lens shows as a permission card', () => {
    const lastMeaningfulRows = shotsRows.filter((row) => row.trim().length > 0).slice(-12).join('\n');
    expect(lastMeaningfulRows).toMatch(/Do you want to/);
  });

  it('is a SETTLED frame, so no arrival time can catch it mid-paint', () => {
    // TIMING, not decoration. The store flow captures the chat frame first and
    // reaches the terminal shot an unknown 15-30s later, while the replay
    // restarts on every terminal-bearing subscribe - so a capture that animates
    // is a capture whose screenshot depends on when the shutter happens to fall.
    //
    // The fixture answers that by holding still: the seed frame IS the settled
    // dialog and there is nothing after it that repaints. Assert exactly that,
    // because it is the property the store flow depends on. An earlier version
    // of this test compared "the frame by 6s" against "the final frame" without
    // noticing they are the same frame here, so it asserted one thing twice and
    // could not fail.
    expect(CLAUDE_CAPTURE_SHOTS.chunks.length).toBe(1);
    expect(CLAUDE_CAPTURE_SHOTS.chunks[0].offsetMs).toBe(0);

    // Every distinct row seen across the whole replay is a row of the seed
    // frame: nothing new is ever painted. Both directions, so a chunk that
    // added rows AND one that blanked them would both fail.
    const settledRows = shotsRows.filter((row) => row.trim().length > 0);
    expect([...shotsEveryRow].sort()).toEqual([...new Set(settledRows)].sort());

    // And the state it rests in is the dialog, which is what the chat lens
    // shows as a permission card at the same moment.
    expect(settledRows.join('\n')).toMatch(/Do you want to/);
  });
});

describe('every mode reports the grid it actually replays', () => {
  it('announces the capture own dimensions', () => {
    // The failure this guards is silent: announcing one grid while streaming
    // another renders every box border sliced mid-glyph, and it would show up
    // only in a published image. It is cheap now that there is a single
    // recording, and it was a live bug when there were two.
    expect(activeGrid()).toEqual({ cols: activeCapture().cols, rows: activeCapture().rows });
    expect(activeCapture()).toBe(CLAUDE_CAPTURE_SHOTS);
  });
});

describe('authored claude frames fill the grid with the live chrome', () => {
  // Transcribed from a real session's PTY ring (2026-08-27): the input area
  // is rules + ❯ + the amber 'auto mode on' footer, pinned to the bottom of
  // a frame that fills the grid. A bare 20-row scrollback floating in an
  // empty pane is exactly what read as fake next to the recorded session.
  it('pins the input area to the bottom of a full-height frame', () => {
    // Positively derived, not a substring scan of the very text being
    // verified below (that self-referential filter is what let a one-in-one
    // swap - one Claude session losing the chrome while some other session
    // gained a copy of the marker text - cancel out against a bare length
    // check). Exclude the three CLI-flavored static exports by identity, and
    // also anything sharing the codex fixture's model id: MOCK_STATIC_SESSIONS
    // additionally packs one Codex-flavored session INTO the extra-thinking
    // bucket ('mock-session-thinking-5', never exported under its own name),
    // so identity exclusion alone would miss it.
    const codexModelId = MOCK_CODEX_STATIC_SESSION.model.id;
    const framedSpecs = MOCK_STATIC_SESSIONS.filter(
      (spec) =>
        spec !== MOCK_CODEX_STATIC_SESSION &&
        spec !== MOCK_GEMINI_STATIC_SESSION &&
        spec !== MOCK_OPENCODE_STATIC_SESSION &&
        spec.model.id !== codexModelId,
    );
    // The expectation side is a LITERAL set of ids, not the same predicate
    // recomputed - so reflavoring one of these sessions to Codex (or vice
    // versa) changes the selection side without moving the expectation,
    // and the mismatch fails loudly instead of both sides drifting together.
    // 'mock-session-thinking-5' is deliberately absent: it is Codex-flavored
    // (see above) so the filter above excludes it too.
    expect(framedSpecs.map((spec) => spec.sessionId).sort()).toEqual(
      [
        'mock-session-thinking-2',
        'mock-session-thinking-3',
        'mock-session-thinking-4',
        'mock-session-idle',
        'mock-session-paused',
        'mock-project-archived-session-1',
        'mock-project-relay-archived-session-1',
      ].sort(),
    );
    for (const spec of framedSpecs) {
      const rows = spec.scrollback.split('\r\n');
      expect(rows.length, `${spec.sessionId} fills the grid`).toBeGreaterThanOrEqual(activeGrid().rows);
      const bottomRows = rows.slice(-4).join('\n');
      expect(bottomRows, `${spec.sessionId} prompt`).toContain('❯');
      expect(bottomRows, `${spec.sessionId} footer`).toContain('auto mode on');
    }
  });
});

describe('the codex TUI frame stays inside the reported grid', () => {
  // Regression for b5fcd86: codexTuiFrame used to hard-code a 38-glyph border
  // while its two alternating status strings were 35 and 26 columns, so the
  // box was ragged on one paint and over-wide on both against a grid the
  // border never actually measured itself against. Nothing caught it because
  // the column checks only ever looked at the streaming session's fixture,
  // never the codex session's. Every row is padded to activeGrid().cols, not
  // a literal, so a future re-record at a different grid cannot leave this
  // fixture behind.
  const width = activeGrid().cols;

  function boxRows(paintTick: number): string[] {
    // Stripped per row (not whole-frame: the stripper also removes bare CR,
    // which would break the row split). The chrome carries SGR color now,
    // and the column budget is about VISIBLE glyphs.
    return codexTuiFrameForTest(paintTick)
      .split('\r\n')
      .map((row) => stripAnsiPreservingLayout(row))
      .filter((row) => row.length > 0);
  }

  it.each([0, 1])('pads the box border to exactly the grid width on paint tick %i', (paintTick) => {
    const rows = boxRows(paintTick);
    const topBorder = rows.find((row) => row.startsWith('╭'));
    const bottomBorder = rows.find((row) => row.startsWith('╰'));
    const statusRow = rows.find((row) => row.startsWith('│'));
    expect(topBorder).toBeDefined();
    expect(bottomBorder).toBeDefined();
    expect(statusRow).toBeDefined();
    expect([...(topBorder ?? '')].length).toBe(width);
    expect([...(bottomBorder ?? '')].length).toBe(width);
    expect([...(statusRow ?? '')].length).toBe(width);
  });

  it('keeps both alternating status strings inside the same border width', () => {
    // The two ticks alternate BETWEEN two different status strings
    // ('Refactoring src/http/retryPolicy.ts' vs 'Running the affected tests').
    // A fix that only pads one of them would still show ragged on the other.
    const evenBorderWidth = [...(boxRows(0).find((row) => row.startsWith('│')) ?? '')].length;
    const oddBorderWidth = [...(boxRows(1).find((row) => row.startsWith('│')) ?? '')].length;
    expect(evenBorderWidth).toBe(width);
    expect(oddBorderWidth).toBe(width);
  });
});

/**
 * Regression for b4c89f0 ("TWO PLAYBACK LEAKS"): the recorded-terminal replay
 * used to outlive both the /end-session and /respawn magic commands. The
 * respawn case is the worse one - activeSessionId is NOT null there, so a
 * playback left running would emit the dead session's recorded bytes into the
 * SUCCESSOR's terminal.
 *
 * There is no exported seam onto createMockDesktop()'s internal
 * terminalPlayback state (driving it for real needs a full loopback KK
 * handshake, which nothing in this repo does yet for this module - see the
 * fixture-content-only tests elsewhere in this file), so this checks the
 * WIRING structurally instead: both lifecycle functions must call
 * stopTerminalPlayback(). Cheap insurance against reintroduction, same
 * technique tests/unit/xtermPageScripts.test.ts uses to pin refit()'s body.
 */
describe('ending or respawning the streaming session stops its terminal replay', () => {
  const mockDesktopSource = readFileSync(join(__dirname, '..', '..', 'src', 'connection', 'mockDesktop.ts'), 'utf8');

  function functionBody(startMarker: string, endMarker: string): string {
    const start = mockDesktopSource.indexOf(startMarker);
    const end = mockDesktopSource.indexOf(endMarker, start);
    expect(start, `could not find "${startMarker}"`).toBeGreaterThanOrEqual(0);
    expect(end, `could not find "${endMarker}" after "${startMarker}"`).toBeGreaterThan(start);
    return mockDesktopSource.slice(start, end);
  }

  it('stops the replay in endActiveSession (the /end-session command)', () => {
    const body = functionBody('function endActiveSession(): void {', 'function respawnActiveSession(');
    expect(body).toContain('stopTerminalPlayback();');
  });

  it('stops the replay in respawnActiveSession (the /respawn command)', () => {
    const body = functionBody('function respawnActiveSession(): void {', 'function raiseQuestionPrompt(');
    expect(body).toContain('stopTerminalPlayback();');
  });
});

describe('the streaming context bar stays out of alarm red', () => {
  it('clamps however long the capture runs', () => {
    // The capture takes longer than the bar took to fill at the original rate,
    // so the board and feed frames - taken last - showed a maxed-out context
    // window in red. Real state, wrong thing for a listing to assert.
    expect(streamingUsedTokens(1_000_000)).toBe(MOCK_STREAM_CEILING_FOR_TEST);
  });

  it('leaves the ceiling comfortably below the danger threshold', () => {
    const usedFraction = MOCK_STREAM_CEILING_FOR_TEST / MOCK_CONTEXT_WINDOW_FOR_TEST;
    expect(usedFraction).toBeLessThan(0.75);
  });

  it('still visibly advances, which is the whole demo', () => {
    expect(streamingUsedTokens(10)).toBeGreaterThan(streamingUsedTokens(0));
  });
});
