import React, { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GitPullRequest } from 'lucide-react-native';
import type { BoardTaskWire, SessionUsageWire } from '@kangentic/protocol';
import {
  AgentStatusIcon,
  Badge,
  Card,
  ContextUsageBar,
  MonoText,
  Row,
  Stack,
  Text,
  useTheme,
  colorForTextRole,
  isContextWindowKnown,
  type AgentStatusKind,
} from '@/components';
import { computeVisibleLabelCount } from './labelFit';
import { prChipAccessibilityLabel, prChipPresentation } from './prChipPresentation';

/** Before the labels row's real width is measured (its first layout pass). */
const FALLBACK_LABEL_LIMIT = 3;

export interface TaskCardProps {
  /** Base testID; sub-parts key off it as `${testID}-status`, `-project`, `-display-id`, `-pr`, `-snippet`, `-usage`. */
  testID: string;
  task: BoardTaskWire;
  statusKind: AgentStatusKind | null;
  showTicketNumbers: boolean;
  usage: SessionUsageWire | null;
  /**
   * The card's one body line: the board shows the task's own description
   * preview; the Agents feed shows a live inbox-style snippet (the pending
   * decision, or the agent's last message) instead - same slot, different
   * source, so neither screen loses its own information.
   */
  bodyText: string;
  bodyNumberOfLines?: number;
  /**
   * Fixes the body slot's height so the card NEVER changes size as its text
   * arrives or changes length. Pass the full height you want reserved
   * (typically `lineHeight * bodyNumberOfLines`): a shorter snippet is
   * centered in that box rather than collapsing it, so an async update -
   * or a live snippet growing from one line to two - moves nothing below it.
   */
  bodyMinHeight?: number;
  /**
   * The Agents feed's addition to the title row - the project this task
   * belongs to, as quiet muted text (never a pill: it would compete with
   * the title for width and visual weight). Omitted (or null) on the
   * board, where the project is already established by which board you're
   * viewing. The Agents feed also passes `showTicketNumbers={false}` - a
   * triage feed cares about status/title/last-message/recency, not the
   * ticket ID; the board is the ticket-reference view.
   */
  projectName?: string | null;
  /**
   * Whether to render board/backlog reference chrome: the labels row and
   * the title row's PR-state icon (same category as the ticket number).
   * Defaults true (the board).
   */
  showMetaRow?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  /** Absolutely-positioned content painted over the whole card - the Agents feed's section-change pulse. The board has none. */
  overlay?: React.ReactNode;
}

/**
 * The task card shared by the board and the Agents feed: status icon,
 * title (with a PR-state icon and ticket number sharing its row), a body
 * line, the labels row, and the context-usage bar - the two screens render
 * nearly identical cards; the Agents feed's only addition is the project
 * name sharing the title row.
 */
export function TaskCard({
  testID,
  task,
  statusKind,
  showTicketNumbers,
  usage,
  bodyText,
  bodyNumberOfLines = 2,
  bodyMinHeight,
  projectName,
  showMetaRow = true,
  onPress,
  onLongPress,
  overlay,
}: TaskCardProps): React.JSX.Element {
  const theme = useTheme();
  // The labels row stretches to the card's full content width regardless of
  // how many labels are inside it (a Stack's default cross-axis stretch), so
  // its first onLayout reports the real available width - reused directly
  // to decide how many labels actually fit before falling back to "+N".
  const [labelsRowWidth, setLabelsRowWidth] = useState<number | null>(null);
  const visibleLabelCount =
    labelsRowWidth === null
      ? Math.min(task.labels.length, FALLBACK_LABEL_LIMIT)
      : computeVisibleLabelCount(task.labels, labelsRowWidth);
  const visibleLabels = task.labels.slice(0, visibleLabelCount);
  const hiddenLabelCount = task.labels.length - visibleLabels.length;
  // Existence + state is what matters here (it decides whether the task is
  // ready to move to Done), not the PR number - a bare icon on the title
  // row says that without adding another stacked row of chrome. The number
  // itself is one tap away in the detail view.
  const hasPr = showMetaRow && task.pr_number !== null;
  const prChip = prChipPresentation(task.pr_state, task.pr_merge_readiness);
  const hasMetaRow = showMetaRow && task.labels.length > 0;
  const hasUtilityStrip = isContextWindowKnown(usage);

  return (
    <Card testID={testID} onPress={onPress} onLongPress={onLongPress}>
      {overlay}
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          {statusKind ? <AgentStatusIcon kind={statusKind} testID={`${testID}-status`} /> : null}
          {/* Desktop parity: single-line truncating title, no agent badge
              (the agent shows inside the session, not on the card). */}
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {task.title}
          </Text>
          {/* A muted pill, not plain text: the project is non-standard
              metadata (unlike the title, snippet, or model/time rows), so
              it keeps a contained shape to read as its own kind of thing -
              just with quiet, non-competing color. */}
          {projectName ? (
            <Badge label={projectName} color="muted" shape="pill" outlined={false} testID={`${testID}-project`} />
          ) : null}
          {showTicketNumbers ? (
            <MonoText size="caption" color="muted" testID={`${testID}-display-id`}>
              #{task.display_id}
            </MonoText>
          ) : null}
          {/* The testID goes on a wrapping View, not the lucide glyph: lucide
              forwards `testID` as the web-only `data-testid` prop, which is
              inert in React Native, so neither RNTL nor Maestro can select it.
              AgentStatusIcon needs no wrapper - it draws react-native-svg,
              which forwards testID properly.

              The same wrapper carries the accessibility label, because the
              glyph alone cannot say which state it is in and the merge verdict
              has a freshness caveat that has nowhere else to live on a touch
              surface (no hover, so no tooltip). */}
          {hasPr ? (
            <View
              testID={`${testID}-pr`}
              accessible
              accessibilityLabel={prChipAccessibilityLabel(task.pr_state, task.pr_merge_readiness)}
            >
              {prChip.label === null ? (
                <GitPullRequest size={14} color={colorForTextRole(prChip.color, theme.colors)} />
              ) : (
                // A labeled pill only when readiness has something to say, so
                // the common card spends no title width. `align="center"`
                // because this sits in a Row - see BadgeProps.align.
                <Badge
                  label={prChip.label}
                  color={prChip.color}
                  shape="pill"
                  align="center"
                  icon={<GitPullRequest size={11} color={colorForTextRole(prChip.color, theme.colors)} />}
                />
              )}
            </View>
          ) : null}
        </Row>
        {bodyText.length > 0 || bodyMinHeight !== undefined ? (
          bodyMinHeight !== undefined ? (
            // Fixed slot: the box owns the height and the text is centered
            // inside it, so one-line and two-line snippets occupy exactly
            // the same space and neighbouring cards never shift.
            <View style={{ height: bodyMinHeight, justifyContent: 'center' }}>
              <Text variant="caption" color="muted" numberOfLines={bodyNumberOfLines} testID={`${testID}-snippet`}>
                {bodyText}
              </Text>
            </View>
          ) : (
            <Text variant="caption" color="muted" numberOfLines={bodyNumberOfLines} testID={`${testID}-snippet`}>
              {bodyText}
            </Text>
          )
        ) : null}
        {hasMetaRow ? (
          <Row
            gap="sm"
            style={styles.metaRow}
            onLayout={(event: LayoutChangeEvent) => setLabelsRowWidth(event.nativeEvent.layout.width)}
          >
            {visibleLabels.map((label) => (
              <Badge key={label} label={label} color="secondary" />
            ))}
            {hiddenLabelCount > 0 ? <Badge label={`+${hiddenLabelCount}`} color="secondary" /> : null}
          </Row>
        ) : null}
        {hasUtilityStrip ? (
          <View
            style={[styles.utilityStrip, { borderTopColor: theme.colors.border, marginTop: theme.spacing.xs, paddingTop: theme.spacing.sm }]}
          >
            <ContextUsageBar usage={usage} testID={`${testID}-usage`} />
          </View>
        ) : null}
      </Stack>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  spaceBetween: {
    justifyContent: 'space-between',
  },
  metaRow: {
    alignItems: 'center',
  },
  utilityStrip: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
