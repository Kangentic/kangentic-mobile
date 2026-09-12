/**
 * The PR chip's state/readiness mapping, ported from the desktop's
 * `renderer/lib/pr-state.ts`. Two properties matter more than the individual
 * rows and are asserted on their own below: readiness is consulted ONLY while
 * the PR is open, and a value this client does not recognise renders as plain
 * open rather than as nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  prChipAccessibilityLabel,
  prChipPresentation,
  prStateSummary,
} from '@/components/board/prChipPresentation';

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

  it('does not leak a stale verdict into a merged PR summary', () => {
    expect(prStateSummary('merged', 'ready')).toBe('merged');
  });
});

describe('prChipAccessibilityLabel', () => {
  it('carries the freshness caveat on every verdict, since touch has no tooltip', () => {
    for (const readiness of ['ready', 'blocked', 'conflicting', 'queued', 'running']) {
      expect(prChipAccessibilityLabel('open', readiness)).toContain('as of the last PR refresh');
    }
  });

  it('does not claim freshness where there is no verdict to be stale about', () => {
    expect(prChipAccessibilityLabel('open', null)).not.toContain('as of the last PR refresh');
    expect(prChipAccessibilityLabel('merged', 'ready')).not.toContain('as of the last PR refresh');
  });

  it('names the state for a glyph that otherwise says nothing out loud', () => {
    expect(prChipAccessibilityLabel('merged', null)).toBe('Pull request merged');
    expect(prChipAccessibilityLabel('closed', null)).toBe('Pull request closed');
    expect(prChipAccessibilityLabel('draft', null)).toBe('Pull request in draft');
  });
});
