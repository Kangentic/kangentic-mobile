/**
 * The PR chip's state/readiness mapping, ported from the desktop's
 * `renderer/lib/pr-state.ts`. Two properties matter more than the individual
 * rows and are asserted on their own below: readiness is consulted ONLY while
 * the PR is open, and a value this client does not recognise renders as plain
 * open rather than as nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  PR_READINESS_FRESHNESS_CAVEAT,
  PR_READINESS_VERDICTS,
  prChipAccessibilityLabel,
  prChipPresentation,
  prStateSummary,
} from '@/components/board/prChipPresentation';

/**
 * Every member of `Object.prototype`. An object-literal lookup table
 * (`table[key]`) HITS the prototype chain for these and returns a function,
 * silently defeating a `?? PLAIN_OPEN` fallback - the exact bug this module's
 * `Map` shape fixed. `Map.get` misses cleanly for all five instead.
 */
const OBJECT_PROTOTYPE_MEMBER_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'] as const;

describe('prChipPresentation', () => {
  describe('an open PR, where readiness is consulted', () => {
    it.each([
      ['ready', 'ready', 'success'],
      ['blocked', 'blocked', 'warning'],
      ['conflicting', 'conflicts', 'conflict'],
      ['queued', 'queued', 'info'],
      ['running', 'running', 'info'],
    ])('%s renders the label %s in %s', (readiness, label, color) => {
      expect(prChipPresentation('open', readiness)).toEqual({ label, color });
    });

    it('renders conflicting as the word "conflicts", not the wire value', () => {
      // The label is deliberately not the wire string. Porting it verbatim is
      // the easy mistake, and it reads wrong on a card ("conflicting" is a
      // state of being, "conflicts" is what the PR has).
      expect(prChipPresentation('open', 'conflicting').label).toBe('conflicts');
    });

    it('paints conflicts in its own role, never danger - a conflicting PR is stuck, not closed', () => {
      expect(prChipPresentation('open', 'conflicting').color).not.toBe(
        prChipPresentation('closed', null).color,
      );
    });

    it.each([[null], ['unknown']])('%s spends no width: plain open, no label', (readiness) => {
      expect(prChipPresentation('open', readiness)).toEqual({ label: null, color: 'success' });
    });

    it('degrades an unrecognised verdict to plain open, per the protocol instruction', () => {
      // A desktop that grows a seventh verdict must not blank the chip here.
      expect(prChipPresentation('open', 'awaiting-signoff')).toEqual({ label: null, color: 'success' });
    });
  });

  describe('every other state ignores readiness outright', () => {
    // The guard that matters. The desktop stops refreshing a verdict once a PR
    // lands, so a merged row keeps whatever it last said - and a merged PR
    // advertising "ready" would be actively misleading.
    it.each([
      ['draft', 'success'],
      ['merged', 'info'],
      ['closed', 'danger'],
      [null, 'success'],
    ])('%s renders a bare glyph whatever the verdict says', (state, color) => {
      for (const readiness of ['ready', 'blocked', 'conflicting', 'queued', 'running', 'unknown', null]) {
        expect(prChipPresentation(state, readiness)).toEqual({ label: null, color });
      }
    });

    it('an unrecognised state falls back to plain open rather than vanishing', () => {
      expect(prChipPresentation('rebasing', 'ready')).toEqual({ label: null, color: 'success' });
    });
  });
});

describe('a prototype-chain member as the readiness value degrades to plain open', () => {
  // These five strings are not arbitrary "unknown" input - they are the class
  // of input an object-literal lookup table silently accepts and a `Map`
  // rejects. Before the `Map` change, `READINESS_PRESENTATION['constructor']`
  // returned `Object.prototype.constructor` (a function), so `?? PLAIN_OPEN`
  // never fired and every one of these three readers produced garbage
  // (`label: undefined` / `color: undefined`, `undefined?.label`, a crash
  // reading `.spokenDetail` off a function). Verified failing: reverting
  // `READINESS_PRESENTATION` to an object literal and indexing it with
  // `table[prMergeReadiness]` instead of `table.get(prMergeReadiness)` turned
  // every case in this block red.
  it.each(OBJECT_PROTOTYPE_MEMBER_NAMES)(
    '%s renders as plain open across prChipPresentation, prStateSummary and prChipAccessibilityLabel',
    (prototypeMemberName) => {
      expect(prChipPresentation('open', prototypeMemberName)).toEqual({ label: null, color: 'success' });
      expect(prStateSummary('open', prototypeMemberName)).toBe('open');
      expect(prChipAccessibilityLabel('open', prototypeMemberName)).toBe('Pull request open');
    },
  );
});

describe('every recognised verdict is wired into all three functions the same way', () => {
  // Iterates PR_READINESS_VERDICTS rather than a hand-copied list of the
  // current five words. A verdict added to the table without being wired
  // into prChipPresentation, prStateSummary or prChipAccessibilityLabel fails
  // HERE the moment it is added, instead of waiting on a hand-updated test
  // list that would not know to extend itself. Verified failing: adding a
  // sixth table entry (`timed_out`) and special-casing `prStateSummary` to
  // bypass the table for that one key (as a forgotten wiring would look)
  // turned this test red for exactly that verdict, while every hand-copied
  // list elsewhere in this file stayed green because it never saw the new key.
  it.each(PR_READINESS_VERDICTS)(
    '%s has a non-empty chip label that the summary reuses, plus a spoken caveat',
    (verdict) => {
      const presentation = prChipPresentation('open', verdict);
      expect(typeof presentation.label).toBe('string');
      expect(presentation.label).not.toBe('');
      expect(prStateSummary('open', verdict)).toBe(presentation.label);
      expect(prChipAccessibilityLabel('open', verdict)).toContain(PR_READINESS_FRESHNESS_CAVEAT);
    },
  );
});

describe('prStateSummary', () => {
  it('is always populated, including where the chip shows no label', () => {
    expect(prStateSummary('open', null)).toBe('open');
    expect(prStateSummary('open', 'unknown')).toBe('open');
    expect(prStateSummary(null, null)).toBe('open');
    expect(prStateSummary('draft', null)).toBe('draft');
    expect(prStateSummary('merged', null)).toBe('merged');
    expect(prStateSummary('closed', null)).toBe('closed');
  });

  it('reuses the chip vocabulary, so the menu and the card never disagree', () => {
    for (const readiness of ['ready', 'blocked', 'conflicting', 'queued', 'running']) {
      expect(prStateSummary('open', readiness)).toBe(prChipPresentation('open', readiness).label);
    }
  });

  it.each(['draft', 'merged', 'closed'] as const)(
    'does not leak a stale verdict into a %s PR summary',
    (nonOpenState) => {
      // The existing suite only pinned `merged`. `draft` and `closed` go
      // through the same early-return branch in the source, but nothing
      // proved that: a mutation that widened the open-branch condition to
      // also catch `draft` or `closed` would have passed every other test in
      // this file.
      for (const readiness of [...PR_READINESS_VERDICTS, 'unknown']) {
        expect(prStateSummary(nonOpenState, readiness)).toBe(nonOpenState);
      }
    },
  );
});

describe('prChipAccessibilityLabel', () => {
  it('carries the freshness caveat on every verdict, since touch has no tooltip', () => {
    for (const readiness of ['ready', 'blocked', 'conflicting', 'queued', 'running']) {
      expect(prChipAccessibilityLabel('open', readiness)).toContain(PR_READINESS_FRESHNESS_CAVEAT);
    }
  });

  it('does not claim freshness where there is no verdict to be stale about', () => {
    expect(prChipAccessibilityLabel('open', null)).not.toContain(PR_READINESS_FRESHNESS_CAVEAT);
    expect(prChipAccessibilityLabel('merged', 'ready')).not.toContain(PR_READINESS_FRESHNESS_CAVEAT);
  });

  it('degrades a value this client does not recognise to plain open, with no caveat to hedge', () => {
    // Only prChipPresentation and prStateSummary had a degrade-to-plain-open
    // test before this; the accessibility label had none, so a mutation that
    // appended the caveat unconditionally (rather than only when a verdict
    // was actually found) would have shipped silently.
    expect(prChipAccessibilityLabel('open', 'unknown')).toBe('Pull request open');
    expect(prChipAccessibilityLabel('open', 'unknown')).not.toContain(PR_READINESS_FRESHNESS_CAVEAT);
    expect(prChipAccessibilityLabel('open', 'awaiting-signoff')).toBe('Pull request open');
    expect(prChipAccessibilityLabel('open', 'awaiting-signoff')).not.toContain(PR_READINESS_FRESHNESS_CAVEAT);
  });

  it('names the state for a glyph that otherwise says nothing out loud', () => {
    expect(prChipAccessibilityLabel('merged', null)).toBe('Pull request merged');
    expect(prChipAccessibilityLabel('closed', null)).toBe('Pull request closed');
    expect(prChipAccessibilityLabel('draft', null)).toBe('Pull request in draft');
  });
});
