import React from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import type { TypographyTokens } from './theme/tokens';

export type TextVariant = keyof TypographyTokens;
export type TextColorRole =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'accent'
  | 'danger'
  | 'warning'
  | 'success'
  | 'conflict'
  | 'info';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  color?: TextColorRole;
  children: React.ReactNode;
}

/**
 * `variant` is typed against the theme's fixed typography scale, so a
 * sub-floor font size (below the 12px caption floor) is unrepresentable
 * here - see .claude/rules/ui-conventions.md.
 */
export function Text({ variant = 'body', color = 'primary', style, children, ...rest }: TextProps): React.JSX.Element {
  const theme = useTheme();
  const typographyToken = theme.typography[variant];
  const colorValue = colorForTextRole(color, theme.colors);

  return (
    <RNText
      style={[
        {
          fontSize: typographyToken.fontSize,
          lineHeight: typographyToken.lineHeight,
          fontWeight: typographyToken.fontWeight,
          color: colorValue,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
}

export function colorForTextRole(role: TextColorRole, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (role) {
    case 'primary':
      return colors.textPrimary;
    case 'secondary':
      return colors.textSecondary;
    case 'muted':
      return colors.textMuted;
    case 'accent':
      return colors.accent;
    case 'danger':
      return colors.danger;
    case 'warning':
      return colors.warning;
    case 'success':
      return colors.success;
    case 'conflict':
      return colors.conflict;
    case 'info':
      return colors.info;
  }
}
