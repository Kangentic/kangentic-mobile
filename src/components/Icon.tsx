import React from 'react';
import {
  Archive,
  ArrowDownToLine,
  ArrowLeftRight,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  GitPullRequest,
  Mic,
  Plus,
  Send,
  Settings,
  ShieldHalf,
  Shrink,
  SquarePen,
  Trash2,
  User,
  type LucideIcon,
} from 'lucide-react-native';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { colorForTextRole, type TextColorRole } from './Text';

/** The closed set of glyphs the app actually uses, backed by lucide. */
export type IconName =
  | 'chevron-forward'
  | 'chevron-back'
  | 'chevron-down'
  | 'settings'
  | 'radio-button-on'
  | 'radio-button-off'
  | 'shield-half'
  | 'swap-horizontal'
  | 'create'
  | 'archive'
  | 'trash'
  | 'mic'
  | 'add'
  | 'send'
  | 'contract'
  | 'to-latest'
  | 'user'
  | 'agent'
  | 'git-pull-request';

const ICON_REGISTRY: Record<IconName, LucideIcon> = {
  'chevron-forward': ChevronRight,
  'chevron-back': ChevronLeft,
  'chevron-down': ChevronDown,
  settings: Settings,
  'radio-button-on': CircleDot,
  'radio-button-off': Circle,
  'shield-half': ShieldHalf,
  'swap-horizontal': ArrowLeftRight,
  create: SquarePen,
  archive: Archive,
  trash: Trash2,
  mic: Mic,
  add: Plus,
  send: Send,
  contract: Shrink,
  'to-latest': ArrowDownToLine,
  user: User,
  agent: Bot,
  'git-pull-request': GitPullRequest,
};

export interface IconProps {
  name: IconName;
  color?: TextColorRole;
  /**
   * A raw theme color that overrides `color`, for the rare glyph outside the
   * semantic role system (e.g. a FAB icon on an accent fill, which needs
   * `theme.colors.onAccent` - the same escape hatch `Button` and
   * `ConnectionBanner` use for onAccent text).
   */
  colorOverride?: string;
  size?: number;
  /** Stroke thickness, matching the direct-lucide call sites' default. */
  strokeWidth?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Icon({
  name,
  color = 'primary',
  colorOverride,
  size = 20,
  strokeWidth = 2,
  testID,
  style,
}: IconProps): React.JSX.Element {
  const theme = useTheme();
  const colorValue = colorOverride ?? colorForTextRole(color, theme.colors);
  const LucideComponent = ICON_REGISTRY[name];
  const glyph = <LucideComponent size={size} color={colorValue} strokeWidth={strokeWidth} style={style} />;
  // lucide forwards `testID` as the web-only `data-testid` prop, which is
  // inert in React Native - passing it straight through leaves a selector
  // neither RNTL nor Maestro can ever match. A wrapping View carries it
  // instead, and only when asked for, so icons without one keep their exact
  // previous layout.
  return testID === undefined ? glyph : <View testID={testID}>{glyph}</View>;
}
