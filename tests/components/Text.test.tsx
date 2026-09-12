/**
 * `colorForTextRole` maps a `TextColorRole` to a theme color token. It is a
 * pure function, but `Text.tsx` imports `react-native` at module scope for
 * the `Text` component it also exports, so importing this module (even for
 * just this one function) pulls in the React Native runtime. Under vitest's
 * bare Node environment that import throws immediately - `react-native`'s
 * shipped `index.js` still carries Flow syntax the vitest/rolldown transform
 * does not strip - so this lives at the Jest component tier instead, which
 * already has the RN/Metro transform this file needs. Verified directly: a
 * throwaway vitest spec importing `colorForTextRole` failed with
 * `RolldownError: Parse failure ... Flow is not supported ... react-native/index.js`
 * before this file was written.
 *
 * The two prChipPresentation.ts test files (tests/unit/prChipPresentation.test.ts,
 * tests/components/TaskCard.test.tsx) each assert their own vocabulary against
 * this function's INPUT (the role string `'conflict'`), and
 * tests/unit/tokensContrast.test.ts asserts the OUTPUT token's identity and
 * contrast (`colors.conflict === brandTokens.rust`). Neither joins role to
 * token: if `colorForTextRole('conflict', ...)` returned `colors.danger`
 * instead, every one of those suites would still pass, because none of them
 * ever calls `colorForTextRole` with `colors` and checks which token comes
 * back. This file is the join.
 */
import { colorForTextRole, type TextColorRole } from '@/components/Text';
import { darkTerminalTheme } from '@/components/theme/tokens';

const { colors } = darkTerminalTheme;

/**
 * A `Record`, not an array, so adding a member to `TextColorRole` without
 * extending this mapping is a `tsc` error, not a silently-incomplete test
 * list - the same drift protection `PR_READINESS_VERDICTS` gives
 * `prChipPresentation.test.ts`.
 */
const expectedTokenByRole: Record<TextColorRole, string> = {
  primary: colors.textPrimary,
  secondary: colors.textSecondary,
  muted: colors.textMuted,
  accent: colors.accent,
  danger: colors.danger,
  warning: colors.warning,
  success: colors.success,
  conflict: colors.conflict,
  info: colors.info,
};

const textColorRoles = Object.keys(expectedTokenByRole) as readonly TextColorRole[];

describe('colorForTextRole', () => {
  it.each(textColorRoles.map((role) => [role, expectedTokenByRole[role]] as const))(
    '%s resolves to its own dedicated color token, not a neighboring semantic role',
    (role, expectedToken) => {
      expect(colorForTextRole(role, colors)).toBe(expectedToken);
    },
  );

  // Named directly, since these are the two roles this change actually added.
  it("resolves 'conflict' to colors.conflict specifically, not colors.danger", () => {
    expect(colorForTextRole('conflict', colors)).toBe(colors.conflict);
    expect(colorForTextRole('conflict', colors)).not.toBe(colors.danger);
  });

  it("resolves 'info' to colors.info specifically, not colors.accent", () => {
    expect(colorForTextRole('info', colors)).toBe(colors.info);
    expect(colorForTextRole('info', colors)).not.toBe(colors.accent);
  });
});
