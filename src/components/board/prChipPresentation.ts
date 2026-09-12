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

/**
 * The freshness caveat every spoken verdict carries. Exported so the tests
 * assert against the string the module actually ships rather than re-typing
 * it: a copy-edit here must not need a hand-synchronised edit in two test
 * files to stay honest.
 */
export const PR_READINESS_FRESHNESS_CAVEAT = 'as of the last PR refresh';

/** A recognised verdict: one word for the chip, one sentence for a reader. */
interface ReadinessPresentation {
  /**
   * Nested rather than spread alongside `spokenDetail`, so `prChipPresentation`
   * can hand this straight back without widening its documented return shape:
   * the chip contract is exactly `{ label, color }`, and a third key leaking
   * into it would be invisible to `tsc` but visible to every caller.
   */
  chip: PrChipPresentation & { label: string };
  /** The spoken form, minus the caveat, which is appended at the one call site. */
  spokenDetail: string;
}

/**
 * The readiness verdicts that are worth spending title width on, and the ONE
 * table all three exported functions read. A verdict added here gets its chip
 * label, its summary word and its spoken form together or not at all, which is
 * the drift this module cannot afford: a chip that says `blocked` while a
 * screen reader says `open` describes the same PR two ways.
 *
 * A `Map`, deliberately, not an object literal. An object literal inherits
 * `Object.prototype`, so a wire value that happens to name a member of it
 * (`constructor`, `toString`, `valueOf`, `__proto__`) would HIT the lookup and
 * return a function in place of a presentation - the `?? PLAIN_OPEN` fallback
 * never fires, and the card renders a pill with an undefined label and an
 * undefined color. `Map.get` misses cleanly for those keys. This is not
 * hypothetical robustness: the protocol states that a value a client does not
 * know renders as plain open (see `BoardTaskWire.pr_merge_readiness`), and an
 * object literal cannot honour that for every string the wire can carry.
 * `Map.get` also returns `T | undefined`, so the fallback is live code to
 * `tsc` rather than the dead branch an unchecked index signature makes it.
 */
const READINESS_PRESENTATION: ReadonlyMap<string, ReadinessPresentation> = new Map([
  [
    'ready',
    { chip: { label: 'ready', color: 'success' }, spokenDetail: 'Pull request ready to merge' },
  ],
  [
    'blocked',
    {
      chip: { label: 'blocked', color: 'warning' },
      spokenDetail: 'Pull request merge blocked by reviews, checks, or branch rules',
    },
  ],
  [
    'conflicting',
    {
      chip: { label: 'conflicts', color: 'conflict' },
      spokenDetail: 'Pull request has merge conflicts with the base branch',
    },
  ],
  [
    'queued',
    { chip: { label: 'queued', color: 'info' }, spokenDetail: 'Pull request checks or policies are queued' },
  ],
  [
    'running',
    { chip: { label: 'running', color: 'info' }, spokenDetail: 'Pull request checks or policies are running' },
  ],
] satisfies readonly (readonly [string, ReadinessPresentation])[]);

/**
 * Every verdict this client recognises, derived from the table rather than
 * retyped. The tests iterate THIS, so a verdict added to the table above is
 * automatically held to all three functions' contracts instead of passing a
 * suite whose expectations were hand-copied and never extended.
 */
export const PR_READINESS_VERDICTS: readonly string[] = Array.from(READINESS_PRESENTATION.keys());

/** Plain `open`, and the resting appearance for anything without a verdict. */
const PLAIN_OPEN: PrChipPresentation = { label: null, color: 'success' };

/** Hoisted for the same reason `PLAIN_OPEN` is: a recycled board row renders these on every pass. */
const MERGED_PRESENTATION: PrChipPresentation = { label: null, color: 'info' };
const CLOSED_PRESENTATION: PrChipPresentation = { label: null, color: 'danger' };

export function prChipPresentation(
  prState: string | null,
  prMergeReadiness: string | null,
): PrChipPresentation {
  switch (prState) {
    case 'open':
      if (prMergeReadiness === null) return PLAIN_OPEN;
      return READINESS_PRESENTATION.get(prMergeReadiness)?.chip ?? PLAIN_OPEN;
    case 'merged':
      return MERGED_PRESENTATION;
    case 'closed':
      return CLOSED_PRESENTATION;
    // `draft`, `null`, and anything unrecognised.
    default:
      return PLAIN_OPEN;
  }
}

/**
 * The PR's state as one always-present word, for a surface with room to say it
 * even where the chip shows no label. Its one caller today is the long-press
 * menu's caption (`TaskActionsScreen`).
 *
 * Reads `READINESS_PRESENTATION` rather than keeping its own mapping, which is
 * what stops the menu and the card describing the same PR differently.
 * `prChipAccessibilityLabel` reads that same table directly rather than going
 * through here, so the three stay consistent by sharing a source, not by
 * calling each other.
 */
export function prStateSummary(prState: string | null, prMergeReadiness: string | null): string {
  if (prState === 'open') {
    const readiness = prMergeReadiness === null ? undefined : READINESS_PRESENTATION.get(prMergeReadiness);
    return readiness?.chip.label ?? 'open';
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
 *
 * Reads `READINESS_PRESENTATION` rather than keeping a parallel switch, so a
 * verdict added to that table cannot render a visible chip label while falling
 * through to a spoken "open" here.
 */
export function prChipAccessibilityLabel(prState: string | null, prMergeReadiness: string | null): string {
  if (prState === 'open') {
    const readiness = prMergeReadiness === null ? undefined : READINESS_PRESENTATION.get(prMergeReadiness);
    // No verdict, or one this client does not know: there is nothing to be
    // stale about, so the caveat would be a claim rather than a hedge.
    if (readiness === undefined) return 'Pull request open';
    return `${readiness.spokenDetail}, ${PR_READINESS_FRESHNESS_CAVEAT}`;
  }
  if (prState === 'draft') return 'Pull request in draft';
  if (prState === 'merged') return 'Pull request merged';
  if (prState === 'closed') return 'Pull request closed';
  return 'Pull request open';
}
