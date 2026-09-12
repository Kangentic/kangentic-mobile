import type { TextColorRole } from '../Text';

/**
 * How a task's linked PR renders on the card, and how it reads out loud.
 *
 * Desktop parity, with one deliberate shape change. The desktop card gives the
 * PR its own row and always labels the chip (`open` / `draft` / `merged` /
 * `closed`); the phone has one title row shared with the status icon, the
 * ticket number and (on the Agents feed) the project pill, so a label here is
 * width taken from the title. The chip therefore grows a word only when merge
 * readiness actually says something - `ready`, `blocked`, `conflicts`,
 * `queued`, `running` - and stays the bare glyph it has always been otherwise.
 * `label === null` means "render the glyph alone".
 *
 * The state/readiness mapping itself is the desktop's, from its
 * `renderer/lib/pr-state.ts`:
 *
 * - Readiness is consulted ONLY while the PR is open. A stale verdict on a
 *   merged PR must never show through, which is why the non-open branches
 *   ignore it rather than falling through to a shared lookup.
 * - `ready` keeps the open green: it is the promise "a merge would land now".
 * - `conflicting` renders the word `conflicts` - the label is NOT the wire
 *   value - in rust rather than red, so it never reads as `closed`.
 * - `queued` / `running` mean a blocking check is still in flight, so they take
 *   a hue that is neither a pass nor a fail.
 * - `unknown`, null, and any value this client does not recognise render as
 *   plain open. That last one is the protocol's own instruction, and it is what
 *   keeps a desktop that grows a seventh verdict from blanking the chip here.
 *
 * Both parameters are plain strings because `@kangentic/protocol` exports no
 * readiness union to narrow against (see
 * `.claude/rules/protocol-types-from-package.md`: a local parallel type would
 * drift from the desktop's, which is the failure this module must not have).
 */
export interface PrChipPresentation {
  /** `null` renders the bare glyph; a string renders a labeled pill. */
  label: string | null;
  color: TextColorRole;
}

/** The readiness verdicts that are worth spending title width on. */
const READINESS_PRESENTATION: Record<string, PrChipPresentation> = {
  ready: { label: 'ready', color: 'success' },
  blocked: { label: 'blocked', color: 'warning' },
  conflicting: { label: 'conflicts', color: 'conflict' },
  queued: { label: 'queued', color: 'info' },
  running: { label: 'running', color: 'info' },
};

/** Plain `open`, and the resting appearance for anything without a verdict. */
const PLAIN_OPEN: PrChipPresentation = { label: null, color: 'success' };

export function prChipPresentation(
  prState: string | null,
  prMergeReadiness: string | null,
): PrChipPresentation {
  switch (prState) {
    case 'open':
      if (prMergeReadiness === null) return PLAIN_OPEN;
      return READINESS_PRESENTATION[prMergeReadiness] ?? PLAIN_OPEN;
    case 'merged':
      return { label: null, color: 'info' };
    case 'closed':
      return { label: null, color: 'danger' };
    // `draft`, `null`, and anything unrecognised.
    default:
      return PLAIN_OPEN;
  }
}

/**
 * The PR's state as one always-present word, for surfaces with room to say it
 * even where the chip shows no label: the long-press menu's caption and the
 * chip's accessibility label. Shares `prChipPresentation`'s readiness mapping
 * so the two can never describe the same PR differently.
 */
export function prStateSummary(prState: string | null, prMergeReadiness: string | null): string {
  if (prState === 'open') {
    const readiness = prMergeReadiness === null ? null : (READINESS_PRESENTATION[prMergeReadiness] ?? null);
    return readiness?.label ?? 'open';
  }
  if (prState === 'draft' || prState === 'merged' || prState === 'closed') return prState;
  return 'open';
}

/**
 * What a screen reader says for the chip. The desktop hangs this on a `title`
 * tooltip; touch has no hover and `.claude/rules/ui-conventions.md` bans
 * hover-only affordances, so the accessibility label is the only place the
 * freshness caveat can be stated at all. Accessibility labels are exempt from
 * `.claude/rules/ui-copy-brevity.md`, so this stays fully descriptive.
 *
 * The caveat is not boilerplate: the verdict is only as fresh as the desktop's
 * last PR refresh, and it is resolved from that desktop's own viewpoint, so
 * presenting it as live truth would overpromise.
 */
export function prChipAccessibilityLabel(prState: string | null, prMergeReadiness: string | null): string {
  const asOf = 'as of the last PR refresh';
  if (prState === 'open') {
    switch (prMergeReadiness) {
      case 'ready':
        return `Pull request ready to merge, ${asOf}`;
      case 'blocked':
        return `Pull request merge blocked by reviews, checks, or branch rules, ${asOf}`;
      case 'conflicting':
        return `Pull request has merge conflicts with the base branch, ${asOf}`;
      case 'queued':
        return `Pull request checks or policies are queued, ${asOf}`;
      case 'running':
        return `Pull request checks or policies are running, ${asOf}`;
      default:
        return 'Pull request open';
    }
  }
  if (prState === 'draft') return 'Pull request in draft';
  if (prState === 'merged') return 'Pull request merged';
  if (prState === 'closed') return 'Pull request closed';
  return 'Pull request open';
}
