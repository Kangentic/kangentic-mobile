/**
 * Palette contrast guarantees for the dark terminal theme. These thresholds
 * are the design system's readability contract: if a palette tweak regresses
 * one, this test fails rather than the phone becoming unreadable in the sun.
 * Also locks the two-hue rule (amber = brand/attention, green = positive,
 * warning = true yellow) so the hues cannot silently converge.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHexColor, type RgbColor } from '@/components/theme/color';
import { brandTokens, darkTerminalTheme } from '@/components/theme/tokens';

const { colors, terminalPalette } = darkTerminalTheme;

function mustParse(hex: string): RgbColor {
  const parsed = parseHexColor(hex);
  if (parsed === null) throw new Error(`token is not a plain hex color: ${hex}`);
  return parsed;
}

function ratioBetween(foregroundHex: string, backgroundHex: string): number {
  return contrastRatio(mustParse(foregroundHex), mustParse(backgroundHex));
}

describe('text readability', () => {
  it('textPrimary reads at >= 7 on surface (and every other resting surface)', () => {
    expect(ratioBetween(colors.textPrimary, colors.surface)).toBeGreaterThanOrEqual(7);
    expect(ratioBetween(colors.textPrimary, colors.background)).toBeGreaterThanOrEqual(7);
    expect(ratioBetween(colors.textPrimary, colors.surfaceRaised)).toBeGreaterThanOrEqual(7);
    expect(ratioBetween(colors.textPrimary, colors.surfaceOverlay)).toBeGreaterThanOrEqual(7);
  });

  it('textSecondary reads at >= 4.5 on surface (and the sheet overlay)', () => {
    expect(ratioBetween(colors.textSecondary, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratioBetween(colors.textSecondary, colors.surfaceOverlay)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('accent and semantic colors on the background', () => {
  const semanticTokens: Record<string, string> = {
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
    conflict: colors.conflict,
    info: colors.info,
    statusNeedsYou: colors.statusNeedsYou,
    statusWorking: colors.statusWorking,
    statusIdle: colors.statusIdle,
  };

  for (const [tokenName, tokenValue] of Object.entries(semanticTokens)) {
    it(`${tokenName} reads at >= 3 on the background`, () => {
      expect(ratioBetween(tokenValue, colors.background)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('onAccent', () => {
  it('reads at >= 4.5 on the accent fill', () => {
    expect(ratioBetween(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads at >= 4.5 on the semantic fills that carry onAccent labels (warning, danger)', () => {
    // ConnectionBanner tints with warning/danger and labels with onAccent.
    expect(ratioBetween(colors.onAccent, colors.warning)).toBeGreaterThanOrEqual(4.5);
    expect(ratioBetween(colors.onAccent, colors.danger)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('terminal palette', () => {
  const ansiEntries = Object.entries(terminalPalette).filter(([ansiName]) => ansiName !== 'ansiBlack');

  for (const [ansiName, ansiValue] of ansiEntries) {
    it(`${ansiName} reads at >= 2.5 on the terminal background`, () => {
      expect(ratioBetween(ansiValue, colors.terminalBackground)).toBeGreaterThanOrEqual(2.5);
    });
  }
});

describe('two-hue rule', () => {
  it('keeps accent (brand amber) and warning (true yellow) distinct', () => {
    expect(colors.accent.toLowerCase()).not.toBe(colors.warning.toLowerCase());
  });

  it('routes attention to amber and positive states to green', () => {
    expect(colors.accent).toBe(brandTokens.amber);
    expect(colors.statusNeedsYou).toBe(colors.accent);
    expect(colors.statusWorking).toBe(colors.success);
    expect(terminalPalette.ansiGreen).toBe(colors.success);
  });

  it('frees amber from ansiYellow: the yellow slot carries the warning yellow', () => {
    expect(terminalPalette.ansiYellow).toBe(colors.warning);
    expect(terminalPalette.ansiYellow).not.toBe(brandTokens.amber);
  });

  it('keeps conflict (brand rust) distinct from danger and from amber', () => {
    // A conflicting PR is stuck, not dead. The whole reason this role exists
    // instead of reusing danger is that "conflicts" must not read as "closed"
    // at a glance on a board card; amber is excluded for the usual reason.
    expect(colors.conflict).toBe(brandTokens.rust);
    expect(colors.conflict.toLowerCase()).not.toBe(colors.danger.toLowerCase());
    expect(colors.conflict.toLowerCase()).not.toBe(colors.accent.toLowerCase());
  });

  it('never project-overrides the brand identity tokens', () => {
    expect(darkTerminalTheme.brand).toEqual({
      amber: '#e8a33d',
      rust: '#c0562f',
      cream: '#fdfbf7',
      ink: '#24201b',
    });
  });
});
